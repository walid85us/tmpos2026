// Phase 1.5 M11.2 — LIVE DEV-only diagnostic for the read-only authorization
// repository + the pure M11 resolver.
//
// WHAT IT DOES: with explicit DEV gates set, it opens ONE read-only DB session,
// reads the seeded DEV durable rows through the read-only repository, derives the
// platform/tenant/store contexts SERVER-SIDE from the durable membership rows,
// feeds the assembled snapshots to the pure resolveAuthorization(), asserts the
// expected allow/deny decisions, and PROVES no mutation occurred (row counts
// unchanged before vs after, including audit_event — whose count may be 0 or
// greater after M11.3, but must not change during this diagnostic).
//
// SAFETY (binding):
//   - Refuses unless NODE_ENV!=production AND every gate below is set.
//   - Reads are wrapped in a `set transaction read only` transaction.
//   - Prints ONLY booleans, counts, decision names, reason codes, role ids, and
//     the entitlement key list. NEVER prints the UID, email, DB URL, project ref,
//     service-role key, anon key, tokens, JWTs, raw SQL, raw rows, or raw DB
//     errors. DB errors are reduced to their error NAME only.
//   - Writes nothing. Applies no migration/seed/rollback. Uses no Supabase MCP.
//     Verifies no token. Imports no Express/frontend/sessionResolve. Wires no route.
//
// Run (owner supplies the DEV UID via env — it is never printed/committed):
//   NODE_ENV=development ALLOW_LIVE_AUTHZ_REPOSITORY_CHECK=true \
//   CONFIRM_SUPABASE_TARGET=tmpos2026-dev \
//   AUTHZ_CHECK_AUTH_PROVIDER=supabase AUTHZ_CHECK_AUTH_PROVIDER_UID=<DEV_UID_REDACTED> \
//   npx tsx scripts/diagnostics-authorization-repository-live-check.ts

import { getDb, closeDb } from '../server/platform-identity/db';
import {
  getMembershipsForUser,
  getIdentityByProviderUid,
  getAppUser,
  countDurableAuthorizationRows,
  buildResolverInputForContext,
  type SqlExecutor,
  type DurableRowCounts,
} from '../server/platform-identity/authorizationRepository';
import {
  resolveAuthorization,
  AUTHORIZATION_RESOLVER_REASON_CODES as RC,
} from '../server/platform-identity/authorizationResolver';
import type { RequestedContext } from '../server/platform-identity/authorizationResolver';

const EXPECTED_TARGET = 'tmpos2026-dev';
const EXPECTED_ENTITLEMENT_KEYS = ['shipping_provider_configuration', 'pickup_requests'];

interface Result { name: string; pass: boolean; detail: string }
const results: Result[] = [];
function check(name: string, pass: boolean, detail = ''): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

/** Reduce any error to a NON-sensitive label (name only — never the message,
 *  which can carry a host/connection string). */
function errName(err: unknown): string {
  return err instanceof Error ? err.name : 'Error';
}

/** Refuse safely (no secret/UID/email/URL) and exit non-zero. */
function refuse(message: string): never {
  console.error(`[authz-repo-live] REFUSED: ${message}`);
  process.exit(1);
}

// =============================================================================
// Gate 1..N — every gate must hold BEFORE any DB connection is created.
// =============================================================================

function assertGates(): { authProvider: string; authProviderUid: string } {
  if (process.env.NODE_ENV === 'production') {
    refuse('NODE_ENV=production — production is hard-blocked. This check is DEV-only.');
  }
  if (process.env.ALLOW_LIVE_AUTHZ_REPOSITORY_CHECK !== 'true') {
    refuse('ALLOW_LIVE_AUTHZ_REPOSITORY_CHECK must equal "true".');
  }
  if (process.env.CONFIRM_SUPABASE_TARGET !== EXPECTED_TARGET) {
    refuse(`CONFIRM_SUPABASE_TARGET must equal the expected DEV target "${EXPECTED_TARGET}".`);
  }
  if (!process.env.SUPABASE_DATABASE_URL) {
    refuse('SUPABASE_DATABASE_URL is not set. Run in the Replit shell where the secret exists.');
  }
  const authProvider = process.env.AUTHZ_CHECK_AUTH_PROVIDER;
  const authProviderUid = process.env.AUTHZ_CHECK_AUTH_PROVIDER_UID;
  if (!authProvider) refuse('AUTHZ_CHECK_AUTH_PROVIDER is required (e.g. "supabase").');
  if (!authProviderUid) refuse('AUTHZ_CHECK_AUTH_PROVIDER_UID is required (owner-supplied DEV UID; never printed).');

  // Optional defense-in-depth: confirm the DB-derived project ref matches the
  // expected ref WITHOUT printing either value (boolean-only).
  const expectedRef = process.env.EXPECTED_DEV_PROJECT_REF;
  if (expectedRef) {
    const derived = deriveProjectRef(process.env.SUPABASE_DATABASE_URL);
    const matched = derived !== null && derived === expectedRef;
    console.log(`[authz-repo-live] expected dev project ref matched: ${matched}`);
    if (!matched) refuse('the project ref derived from SUPABASE_DATABASE_URL does not match EXPECTED_DEV_PROJECT_REF.');
  }

  return { authProvider, authProviderUid };
}

/** Derive a project ref from the DB URL host/username. Never logs the URL/ref. */
function deriveProjectRef(databaseUrl: string): string | null {
  try {
    const u = new URL(databaseUrl);
    const hostM = /^db\.([a-z0-9]+)\.supabase\.(co|com|net)$/i.exec(u.hostname);
    if (hostM) return hostM[1];
    const userM = /^postgres\.([a-z0-9]+)$/i.exec(decodeURIComponent(u.username || ''));
    if (userM) return userM[1];
  } catch {
    /* not a parseable URL — treat as not derivable */
  }
  return null;
}

// =============================================================================
// Main
// =============================================================================

async function main(): Promise<void> {
  const { authProvider, authProviderUid } = assertGates();
  const identityKey = { authProvider, authProviderUid };

  const db = getDb();

  // ---- before-counts (own connection, committed read) ----
  let before: DurableRowCounts;
  try {
    before = await countDurableAuthorizationRows(db);
  } catch (err) {
    refuse(`could not read baseline row counts (${errName(err)}).`);
  }

  // ---- identity presence (fail closed if not found) ----
  // Read identity once up front so a missing DEV identity fails clearly WITHOUT
  // printing the UID/email.
  const identity = await getIdentityByProviderUid(authProvider, authProviderUid, db).catch(() => null);
  check('G1 selected DEV identity resolved', identity !== null, identity ? 'resolved' : 'NOT FOUND for supplied provider key');
  if (!identity) {
    finish();
    return;
  }

  const appUser = await getAppUser(identity.internalUserId, db).catch(() => null);
  check('G2 app_user present and active', appUser !== null && appUser.status === 'active', appUser ? `status=${appUser.status}` : 'missing');

  // ---- derive scope contexts SERVER-SIDE from durable membership rows ----
  const memberships = await getMembershipsForUser(identity.internalUserId, db);
  const platformMs = memberships.find((m) => m.scope_type === 'platform' && m.status === 'active');
  const tenantMs = memberships.find((m) => m.scope_type === 'tenant' && m.status === 'active');
  const storeMs = memberships.find((m) => m.scope_type === 'store' && m.status === 'active');

  check('G3 active platform membership present', !!platformMs, platformMs ? 'yes' : 'no');
  check('G4 active tenant membership present', !!tenantMs, tenantMs ? 'yes' : 'no');
  check('G5 active store membership present', !!storeMs, storeMs ? 'yes' : 'no');
  check(
    'G6 the three seeded memberships are all active',
    !!platformMs && !!tenantMs && !!storeMs,
    `platform=${!!platformMs} tenant=${!!tenantMs} store=${!!storeMs}`,
  );

  const platformCtx: RequestedContext = { scopeType: 'platform' };
  const tenantCtx: RequestedContext | null = tenantMs
    ? { scopeType: 'tenant', tenantId: tenantMs.tenant_id }
    : null;
  const storeCtx: RequestedContext | null = storeMs
    ? { scopeType: 'store', tenantId: storeMs.tenant_id, storeId: storeMs.store_id }
    : null;
  // Negative control: a tenant scope pointing at a tenant id that is NOT seeded
  // (all-zero UUID) ⇒ the tenant row read returns nothing ⇒ resolver denies.
  const negativeCtx: RequestedContext = {
    scopeType: 'tenant',
    tenantId: '00000000-0000-0000-0000-000000000000',
  };

  // ---- run ALL reads inside ONE read-only transaction ----
  try {
    await db.begin(async (tx) => {
      await tx`set transaction read only`;
      const exec = tx as unknown as SqlExecutor;

      // Platform scope
      const platIn = await buildResolverInputForContext(identityKey, platformCtx, exec);
      const platR = platIn ? resolveAuthorization(platIn) : null;
      check(
        'P1 platform scope → allow + system_owner',
        !!platR && platR.decision === 'allow' && platR.authorization !== null &&
          platR.authorization.userType === 'platform' &&
          platR.authorization.scope.scopeType === 'platform' &&
          platR.authorization.roles.platformRoleId === 'system_owner',
        platR ? `${platR.decision}/${platR.authorization?.roles.platformRoleId}` : 'no input',
      );

      // Tenant scope
      if (tenantCtx) {
        const tIn = await buildResolverInputForContext(identityKey, tenantCtx, exec);
        const tR = tIn ? resolveAuthorization(tIn) : null;
        const ent = tR?.authorization?.entitlements ?? {};
        const entKeys = Object.keys(ent);
        check(
          'T1 tenant scope → allow + store_owner',
          !!tR && tR.decision === 'allow' && tR.authorization !== null &&
            tR.authorization.userType === 'tenant' &&
            tR.authorization.scope.scopeType === 'tenant' &&
            tR.authorization.roles.tenantRoleId === 'store_owner',
          tR ? `${tR.decision}/${tR.authorization?.roles.tenantRoleId}` : 'no input',
        );
        check('T2 tenant entitlement count = 2', entKeys.length === 2, `count=${entKeys.length}`);
        check(
          'T3 tenant expected entitlement keys present',
          EXPECTED_ENTITLEMENT_KEYS.every((k) => ent[k] === true),
          entKeys.sort().join(','),
        );
      } else {
        check('T1 tenant scope → allow + store_owner', false, 'no active tenant membership to derive context');
      }

      // Store scope
      if (storeCtx) {
        const sIn = await buildResolverInputForContext(identityKey, storeCtx, exec);
        const sR = sIn ? resolveAuthorization(sIn) : null;
        const ent = sR?.authorization?.entitlements ?? {};
        check(
          'S1 store scope → allow + store_owner',
          !!sR && sR.decision === 'allow' && sR.authorization !== null &&
            sR.authorization.scope.scopeType === 'store' &&
            sR.authorization.roles.tenantRoleId === 'store_owner',
          sR ? `${sR.decision}/${sR.authorization?.roles.tenantRoleId}` : 'no input',
        );
        check('S2 store entitlement count = 2', Object.keys(ent).length === 2, `count=${Object.keys(ent).length}`);
      } else {
        check('S1 store scope → allow + store_owner', false, 'no active store membership to derive context');
      }

      // Negative control
      const negIn = await buildResolverInputForContext(identityKey, negativeCtx, exec);
      const negR = negIn ? resolveAuthorization(negIn) : null;
      check(
        'N1 negative control (unseeded tenant) → deny',
        !!negR && negR.decision === 'deny' && negR.authorization === null &&
          (negR.reasonCode === RC.DENIED_TENANT_MISSING || negR.reasonCode === RC.DENIED_SCOPE_CONTEXT_INVALID),
        negR ? negR.reasonCode : 'no input',
      );
    });
  } catch (err) {
    check('TX read-only transaction completed', false, `transaction error: ${errName(err)}`);
  }

  // ---- after-counts + no-mutation proof ----
  let after: DurableRowCounts;
  try {
    after = await countDurableAuthorizationRows(db);
  } catch (err) {
    refuse(`could not read post-check row counts (${errName(err)}).`);
  }

  const tables: (keyof DurableRowCounts)[] = [
    'app_user', 'tenant', 'store', 'user_membership', 'tenant_feature_entitlement', 'audit_event',
  ];
  const unchanged = tables.every((t) => before[t] === after[t]);
  check(
    'M1 all durable row counts unchanged (before == after)',
    unchanged,
    tables.map((t) => `${t}:${before[t]}->${after[t]}`).join(' '),
  );
  check(
    'M2 audit_event count stable (unchanged during diagnostic)',
    before.audit_event === after.audit_event,
    `before=${before.audit_event} after=${after.audit_event}`,
  );

  finish();
}

function finish(): void {
  const failed = results.filter((r) => !r.pass);
  console.log(`\n[authz-repo-live] ${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error('[authz-repo-live] harness error:', errName(err));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb().catch(() => { /* ignore close errors */ });
  });

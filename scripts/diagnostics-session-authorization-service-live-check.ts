// Phase 1.5 M11.4 — LIVE DEV-only diagnostic for the session authorization service.
//
// WHAT IT DOES: with explicit DEV gates set, it drives the server-only session
// authorization SERVICE against the seeded DEV identity for platform/tenant/store
// contexts, asserts the decisions match the M11.2 live diagnostic, proves the
// service writes EXACTLY one durable audit row per successful evaluation
// (audit_event delta == +3), proves every OTHER durable row count is unchanged,
// and proves the FAIL-CLOSED path: an allow whose audit write fails is downgraded
// to deny/null (and writes no row).
//
// SAFETY (binding):
//   - Refuses unless NODE_ENV!=production AND every gate below is set.
//   - Prints ONLY booleans, counts, deltas, decision names, reason codes, and role
//     ids. NEVER prints the UID, email, DB URL, project ref, service-role key, anon
//     key, tokens, JWTs, raw SQL, raw rows, or raw DB errors (error NAME only).
//   - Writes ONLY durable audit_event rows (through the M11.3 writer, via the
//     service). Applies no migration/seed/rollback. Uses no Supabase MCP. Verifies
//     no token. Imports no Express/frontend/sessionResolve. Wires no route.
//
// Run (owner supplies the DEV UID via env — it is never printed/committed):
//   NODE_ENV=development ALLOW_LIVE_SESSION_AUTHZ_SERVICE_CHECK=true \
//   CONFIRM_SUPABASE_TARGET=tmpos2026-dev \
//   AUTHZ_CHECK_AUTH_PROVIDER=supabase AUTHZ_CHECK_AUTH_PROVIDER_UID=<DEV_UID_REDACTED> \
//   npx tsx scripts/diagnostics-session-authorization-service-live-check.ts

import { getDb, closeDb } from '../server/platform-identity/db';
import {
  countDurableAuthorizationRows,
  getIdentityByProviderUid,
  getMembershipsForUser,
  type IdentityKey,
  type DurableRowCounts,
} from '../server/platform-identity/authorizationRepository';
import type { RequestedContext } from '../server/platform-identity/authorizationResolver';
import {
  resolveSessionAuthorizationForContext,
  SESSION_AUTHZ_DENIED_AUDIT_FAILED,
} from '../server/platform-identity/sessionAuthorizationService';
import type { WrittenAuditEvent } from '../server/platform-identity/auditEventWriter';

const EXPECTED_TARGET = 'tmpos2026-dev';
const EXPECTED_AUDIT_DELTA = 3; // platform + tenant + store successful evaluations

interface Result { name: string; pass: boolean; detail: string }
const results: Result[] = [];
function check(name: string, pass: boolean, detail = ''): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

function errName(err: unknown): string {
  return err instanceof Error ? err.name : 'Error';
}

function refuse(message: string): never {
  console.error(`[session-authz-service-live] REFUSED: ${message}`);
  process.exit(1);
}

function assertGates(): { authProvider: string; authProviderUid: string } {
  if (process.env.NODE_ENV === 'production') {
    refuse('NODE_ENV=production — production is hard-blocked. This check is DEV-only.');
  }
  if (process.env.ALLOW_LIVE_SESSION_AUTHZ_SERVICE_CHECK !== 'true') {
    refuse('ALLOW_LIVE_SESSION_AUTHZ_SERVICE_CHECK must equal "true".');
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
  return { authProvider, authProviderUid };
}

async function main(): Promise<void> {
  const { authProvider, authProviderUid } = assertGates();
  const identityKey: IdentityKey = { authProvider, authProviderUid };
  const db = getDb();

  // ---- before counts ----
  let before: DurableRowCounts;
  try {
    before = await countDurableAuthorizationRows(db);
  } catch (err) {
    refuse(`could not read baseline row counts (${errName(err)}).`);
  }

  // ---- derive scope contexts SERVER-SIDE from durable membership rows ----
  const identity = await getIdentityByProviderUid(authProvider, authProviderUid, db).catch(() => null);
  check('G1 selected DEV identity resolved', identity !== null, identity ? 'resolved' : 'NOT FOUND');
  if (!identity) {
    finish();
    return;
  }
  const memberships = await getMembershipsForUser(identity.internalUserId, db);
  const tenantMs = memberships.find((m) => m.scope_type === 'tenant' && m.status === 'active');
  const storeMs = memberships.find((m) => m.scope_type === 'store' && m.status === 'active');

  const platformCtx: RequestedContext = { scopeType: 'platform' };
  const tenantCtx: RequestedContext | null = tenantMs?.tenant_id
    ? { scopeType: 'tenant', tenantId: tenantMs.tenant_id }
    : null;
  const storeCtx: RequestedContext | null = storeMs?.tenant_id && storeMs?.store_id
    ? { scopeType: 'store', tenantId: storeMs.tenant_id, storeId: storeMs.store_id }
    : null;

  // ---- platform scope (real audit) ----
  const platR = await resolveSessionAuthorizationForContext(identityKey, platformCtx);
  check(
    'P1 platform scope → allow + system_owner + audited',
    platR.decision === 'allow' && platR.audited && !platR.forcedDeny &&
      platR.authorization?.roles.platformRoleId === 'system_owner',
    `${platR.decision}/audited=${platR.audited}/${platR.authorization?.roles.platformRoleId}`,
  );

  // ---- tenant scope (real audit) ----
  if (tenantCtx) {
    const tR = await resolveSessionAuthorizationForContext(identityKey, tenantCtx);
    const entKeys = Object.keys(tR.authorization?.entitlements ?? {});
    check(
      'T1 tenant scope → allow + store_owner + audited',
      tR.decision === 'allow' && tR.audited && !tR.forcedDeny &&
        tR.authorization?.roles.tenantRoleId === 'store_owner',
      `${tR.decision}/audited=${tR.audited}/${tR.authorization?.roles.tenantRoleId}`,
    );
    check('T2 tenant entitlement count = 2', entKeys.length === 2, `count=${entKeys.length}`);
  } else {
    check('T1 tenant scope → allow + store_owner + audited', false, 'no active tenant membership');
  }

  // ---- store scope (real audit) ----
  if (storeCtx) {
    const sR = await resolveSessionAuthorizationForContext(identityKey, storeCtx);
    const entKeys = Object.keys(sR.authorization?.entitlements ?? {});
    check(
      'S1 store scope → allow + store_owner + audited',
      sR.decision === 'allow' && sR.audited && !sR.forcedDeny &&
        sR.authorization?.roles.tenantRoleId === 'store_owner',
      `${sR.decision}/audited=${sR.audited}/${sR.authorization?.roles.tenantRoleId}`,
    );
    check('S2 store entitlement count = 2', entKeys.length === 2, `count=${entKeys.length}`);
  } else {
    check('S1 store scope → allow + store_owner + audited', false, 'no active store membership');
  }

  // ---- FAIL-CLOSED: a real allow whose audit write throws is downgraded to deny ----
  const failWriter = async (): Promise<WrittenAuditEvent> => {
    throw new Error('simulated audit failure');
  };
  const fc = await resolveSessionAuthorizationForContext(identityKey, platformCtx, {
    writeAuditEvent: failWriter,
  });
  check(
    'F1 fail-closed: unauditable allow → deny/null (no row written)',
    fc.decision === 'deny' && fc.forcedDeny === true && fc.authorization === null &&
      fc.auditFailed === true && fc.reasonCode === SESSION_AUTHZ_DENIED_AUDIT_FAILED,
    `${fc.decision}/forcedDeny=${fc.forcedDeny}/${fc.reasonCode}`,
  );

  // ---- after counts + delta proof ----
  let after: DurableRowCounts;
  try {
    after = await countDurableAuthorizationRows(db);
  } catch (err) {
    refuse(`could not read post-check row counts (${errName(err)}).`);
  }

  const auditDelta = after.audit_event - before.audit_event;
  check(
    `A1 audit_event increased by exactly +${EXPECTED_AUDIT_DELTA}`,
    auditDelta === EXPECTED_AUDIT_DELTA,
    `before=${before.audit_event} after=${after.audit_event} delta=${auditDelta}`,
  );

  const otherTables: (keyof DurableRowCounts)[] = [
    'app_user', 'tenant', 'store', 'user_membership', 'tenant_feature_entitlement',
  ];
  const unchanged = otherTables.every((t) => before[t] === after[t]);
  check(
    'A2 all OTHER durable row counts unchanged',
    unchanged,
    otherTables.map((t) => `${t}:${before[t]}->${after[t]}`).join(' '),
  );

  finish();
}

function finish(): void {
  const failed = results.filter((r) => !r.pass);
  console.log(`\n[session-authz-service-live] ${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error('[session-authz-service-live] harness error:', errName(err));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb().catch(() => { /* ignore close errors */ });
  });

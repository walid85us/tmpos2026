// Phase 1.5 M11.5 — LIVE DEV-only diagnostic for /auth/session/resolve live
// authorization wiring.
//
// WHAT IT DOES: with explicit DEV gates set, it drives the REAL session-resolve
// handler in-process through an INJECTED adapter (a fixed verified ActorAssertion
// carrying the seeded DEV uid — NO real JWT needed) and an INJECTED read-only
// identity resolver (no identity upsert). It proves:
//   - flag-disabled route → `authorization: null`, durable audit delta 0,
//   - flag-enabled route  → live platform authorization (system_owner), audit +1,
//   - route fail-closed: an injected allow-not-audited result → `authorization:null`,
//   - all OTHER durable row counts unchanged.
//
// SAFETY (binding):
//   - Refuses unless NODE_ENV!=production AND every gate below is set.
//   - Prints ONLY booleans/counts/deltas/decision/role ids. NEVER prints the UID,
//     email, DB URL, project ref, token, JWT, auth header, cookie, or any secret.
//     The response body (which carries the uid/email) is NEVER printed.
//   - Writes ONLY durable audit_event rows (via the M11.4 service, flag-enabled).
//     No migration/seed/rollback. No Supabase MCP. No real token. No frontend.
//
// Run (owner supplies the DEV UID via env — it is never printed/committed):
//   NODE_ENV=development ENABLE_SUPABASE_PLATFORM_IDENTITY=true \
//   ENABLE_SESSION_RESOLVE=true ENABLE_LIVE_SESSION_AUTHORIZATION=true \
//   ALLOW_LIVE_SESSION_RESOLVE_AUTHZ_ROUTE_CHECK=true \
//   CONFIRM_SUPABASE_TARGET=tmpos2026-dev \
//   AUTHZ_CHECK_AUTH_PROVIDER=supabase AUTHZ_CHECK_AUTH_PROVIDER_UID=<DEV_UID_REDACTED> \
//   npx tsx scripts/diagnostics-session-resolve-live-authorization-route-check.ts

import type { Request, Response } from 'express';
import { getDb, closeDb } from '../server/platform-identity/db';
import {
  countDurableAuthorizationRows,
  getIdentityByProviderUid,
  type DurableRowCounts,
} from '../server/platform-identity/authorizationRepository';
import { createSessionResolveHandler } from '../server/platform-identity/sessionResolve';
import type { SessionAuthorizationResult } from '../server/platform-identity/sessionAuthorizationService';
import type { AuthAdapter } from '../server/platform-identity/authAdapter';
import type { ActorAssertion } from '../server/platform-identity/requestContext';

const EXPECTED_TARGET = 'tmpos2026-dev';
const EXPECTED_ENABLED_DELTA = 1; // one durable audit row for the enabled live evaluation

interface Result { name: string; pass: boolean; detail: string }
const results: Result[] = [];
function check(name: string, pass: boolean, detail = ''): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}
const errName = (err: unknown): string => (err instanceof Error ? err.name : 'Error');
function refuse(message: string): never {
  console.error(`[session-resolve-live-authz-route] REFUSED: ${message}`);
  process.exit(1);
}

function assertGates(): { authProvider: string; authProviderUid: string } {
  if (process.env.NODE_ENV === 'production') refuse('NODE_ENV=production — hard-blocked. DEV-only.');
  if (process.env.ENABLE_SUPABASE_PLATFORM_IDENTITY !== 'true') refuse('ENABLE_SUPABASE_PLATFORM_IDENTITY must equal "true".');
  if (process.env.ENABLE_SESSION_RESOLVE !== 'true') refuse('ENABLE_SESSION_RESOLVE must equal "true".');
  if (process.env.ENABLE_LIVE_SESSION_AUTHORIZATION !== 'true') refuse('ENABLE_LIVE_SESSION_AUTHORIZATION must equal "true".');
  if (process.env.ALLOW_LIVE_SESSION_RESOLVE_AUTHZ_ROUTE_CHECK !== 'true') refuse('ALLOW_LIVE_SESSION_RESOLVE_AUTHZ_ROUTE_CHECK must equal "true".');
  if (process.env.CONFIRM_SUPABASE_TARGET !== EXPECTED_TARGET) refuse(`CONFIRM_SUPABASE_TARGET must equal "${EXPECTED_TARGET}".`);
  if (!process.env.SUPABASE_DATABASE_URL) refuse('SUPABASE_DATABASE_URL is not set.');
  const authProvider = process.env.AUTHZ_CHECK_AUTH_PROVIDER;
  const authProviderUid = process.env.AUTHZ_CHECK_AUTH_PROVIDER_UID;
  if (!authProvider) refuse('AUTHZ_CHECK_AUTH_PROVIDER is required (e.g. "supabase").');
  if (!authProviderUid) refuse('AUTHZ_CHECK_AUTH_PROVIDER_UID is required (owner-supplied DEV UID; never printed).');
  return { authProvider, authProviderUid };
}

function makeRes() {
  const r: Partial<Response> & { statusCode: number; body: any } = { statusCode: 0, body: null };
  r.status = ((c: number) => { r.statusCode = c; return r as Response; }) as Response['status'];
  r.json = ((b: any) => { r.body = b; return r as Response; }) as Response['json'];
  return r;
}

async function main(): Promise<void> {
  const { authProvider, authProviderUid } = assertGates();
  const db = getDb();

  // Read-only identity resolver (NO upsert) so the route writes nothing but audit.
  const readOnlyResolveIdentity = async (a: ActorAssertion): Promise<string | null> => {
    const id = await getIdentityByProviderUid(a.authProvider, a.authProviderUid, db).catch(() => null);
    return id?.internalUserId ?? null;
  };
  const adapter: AuthAdapter = {
    name: 'route-live-check@v0',
    verify: async (): Promise<ActorAssertion> => ({
      authProvider: 'supabase',
      authProviderUid,
      email: null,
      displayName: null,
      actorType: 'platform_user',
      scope: { scopeType: 'none', tenantId: null, storeId: null, platformScope: false },
      permissionSnapshot: null,
      verified: true,
    }),
  };

  let before: DurableRowCounts;
  try {
    before = await countDurableAuthorizationRows(db);
  } catch (err) {
    refuse(`could not read baseline row counts (${errName(err)}).`);
  }

  // ---- A) flag DISABLED → authorization null, audit delta 0 ----
  process.env.ENABLE_LIVE_SESSION_AUTHORIZATION = 'false';
  const disabledHandler = createSessionResolveHandler({ adapter, resolveIdentity: readOnlyResolveIdentity });
  const resA = makeRes();
  await disabledHandler({} as Request, resA as Response);
  const afterDisabled = await countDurableAuthorizationRows(db);
  check(
    'A1 flag-disabled route → authorization null, identity authenticated',
    resA.statusCode === 200 && resA.body?.authState === 'authenticated' && resA.body?.authorization === null,
    `authState=${resA.body?.authState} authz=${resA.body?.authorization}`,
  );
  check(
    'A2 flag-disabled route → audit_event delta 0',
    afterDisabled.audit_event - before.audit_event === 0,
    `delta=${afterDisabled.audit_event - before.audit_event}`,
  );

  // ---- B) flag ENABLED → live platform authorization, audit delta +1 ----
  process.env.ENABLE_LIVE_SESSION_AUTHORIZATION = 'true';
  const enabledHandler = createSessionResolveHandler({ adapter, resolveIdentity: readOnlyResolveIdentity });
  const resB = makeRes();
  await enabledHandler({} as Request, resB as Response);
  check(
    'B1 flag-enabled route → live platform authorization (system_owner)',
    resB.statusCode === 200 &&
      resB.body?.authorization?.scope?.scopeType === 'platform' &&
      resB.body?.authorization?.roles?.platformRoleId === 'system_owner' &&
      resB.body?.authState === 'authenticated',
    `scope=${resB.body?.authorization?.scope?.scopeType} role=${resB.body?.authorization?.roles?.platformRoleId}`,
  );
  const afterEnabled = await countDurableAuthorizationRows(db);
  check(
    `B2 flag-enabled route → audit_event delta +${EXPECTED_ENABLED_DELTA}`,
    afterEnabled.audit_event - afterDisabled.audit_event === EXPECTED_ENABLED_DELTA,
    `delta=${afterEnabled.audit_event - afterDisabled.audit_event}`,
  );

  // ---- C) route fail-closed: injected allow-NOT-audited → authorization null ----
  const allowNotAudited: SessionAuthorizationResult = {
    decision: 'allow', reasonCode: 'resolved', humanReadableReason: 'ok',
    authorization: {
      authorizationVersion: 'authz.v1', userType: 'platform',
      scope: { scopeType: 'platform', tenantId: null, storeId: null },
      roles: { platformRoleId: 'system_owner', tenantRoleId: null },
      status: { user: 'active', tenant: null, store: null },
      entitlements: {}, permissions: {}, subPermissions: {}, derivedBy: 'route_live_check@v0',
    },
    limitation: 'none', audited: false, auditFailed: true, forcedDeny: false,
  };
  const failClosedHandler = createSessionResolveHandler({
    adapter,
    resolveIdentity: readOnlyResolveIdentity,
    resolveSessionAuthorization: async () => allowNotAudited,
  });
  const resC = makeRes();
  await failClosedHandler({} as Request, resC as Response);
  check(
    'C1 fail-closed: injected allow-not-audited → authorization null, identity preserved',
    resC.statusCode === 200 && resC.body?.authorization === null && resC.body?.authState === 'authenticated',
    `authz=${resC.body?.authorization} authState=${resC.body?.authState}`,
  );

  // ---- final: other durable rows unchanged across the whole run ----
  const finalCounts = await countDurableAuthorizationRows(db);
  const otherTables: (keyof DurableRowCounts)[] = [
    'app_user', 'tenant', 'store', 'user_membership', 'tenant_feature_entitlement',
  ];
  const unchanged = otherTables.every((t) => before[t] === finalCounts[t]);
  check(
    'D1 all OTHER durable row counts unchanged',
    unchanged,
    otherTables.map((t) => `${t}:${before[t]}->${finalCounts[t]}`).join(' '),
  );
  check(
    `D2 total audit_event delta = +${EXPECTED_ENABLED_DELTA} (only the enabled call wrote)`,
    finalCounts.audit_event - before.audit_event === EXPECTED_ENABLED_DELTA,
    `before=${before.audit_event} after=${finalCounts.audit_event} delta=${finalCounts.audit_event - before.audit_event}`,
  );

  finish();
}

function finish(): void {
  const failed = results.filter((r) => !r.pass);
  console.log(`\n[session-resolve-live-authz-route] ${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error('[session-resolve-live-authz-route] harness error:', errName(err));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb().catch(() => { /* ignore close errors */ });
  });

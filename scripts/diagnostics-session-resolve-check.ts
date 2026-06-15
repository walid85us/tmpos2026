// Phase 1.5 M7 — hermetic check for the default-off /auth/session/resolve handler.
//
// Pure, offline, secret-free: injects a MOCK auth adapter + MOCK resolver and
// fake req/res objects. No live Supabase, no live DB, no real tokens, no env
// secrets. Proves the feature-flag matrix (default-off + production-force-disable),
// every reason-code row, AppSession mapping, fail-closed identity, ignored client
// authority, secret-free DTO, and advisory audit on every path.
//
// Run:  npx tsx scripts/diagnostics-session-resolve-check.ts

import {
  createSessionResolveHandler,
  type ResolveIdentityFn,
} from '../server/platform-identity/sessionResolve';
import {
  SESSION_RESOLVE_REASON_CODES,
  type SessionResolveResponseDTO,
} from '../server/platform-identity/sessionResolveContract';
import { SupabaseTokenError } from '../server/platform-identity/supabaseAuthAdapter';
import type { AuthAdapter } from '../server/platform-identity/authAdapter';
import type { ActorAssertion } from '../server/platform-identity/requestContext';
import { mapWhoamiToAppSession } from '../src/auth/mapWhoamiToAppSession';

interface Result { name: string; pass: boolean; detail: string }
const results: Result[] = [];
function check(name: string, pass: boolean, detail = ''): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const R = SESSION_RESOLVE_REASON_CODES;

// --- Mock authority inputs (no real tokens) ---------------------------------
const successAssertion: ActorAssertion = {
  authProvider: 'supabase',
  authProviderUid: 'sub-abc',
  email: 'user@example.com',
  displayName: 'Test User',
  actorType: 'platform_user',
  scope: { scopeType: 'none', tenantId: null, storeId: null, platformScope: false },
  permissionSnapshot: null,
  verified: true,
};

const adapterReturning = (a: ActorAssertion | null): AuthAdapter => ({ name: 'mock', verify: async () => a });
const adapterThrowing = (err: unknown): AuthAdapter => ({ name: 'mock', verify: async () => { throw err; } });

const resolverOk: ResolveIdentityFn = async () => 'iuid-123';
const resolverNull: ResolveIdentityFn = async () => null;
const resolverThrows: ResolveIdentityFn = async () => { throw new Error('db down'); };

// --- Fake Express req/res ----------------------------------------------------
function mockReq(opts: { headers?: Record<string, string>; body?: unknown } = {}): any {
  return { headers: opts.headers ?? {}, body: opts.body ?? {} };
}
interface CapturedRes { status: number; json: any }
function mockRes(): { res: any; out: CapturedRes } {
  const out: CapturedRes = { status: 0, json: null };
  const res: any = {
    status(s: number) { out.status = s; return res; },
    json(j: any) { out.json = j; return res; },
  };
  return { res, out };
}

// --- Env helpers (flag matrix) ----------------------------------------------
function setEnv(platform: boolean, session: boolean, production: boolean): void {
  if (platform) process.env.ENABLE_SUPABASE_PLATFORM_IDENTITY = 'true';
  else delete process.env.ENABLE_SUPABASE_PLATFORM_IDENTITY;
  if (session) process.env.ENABLE_SESSION_RESOLVE = 'true';
  else delete process.env.ENABLE_SESSION_RESOLVE;
  if (production) process.env.NODE_ENV = 'production';
  else process.env.NODE_ENV = 'development';
}
// Snapshot + restore so the test never leaks env state.
const ENV_SNAPSHOT = {
  p: process.env.ENABLE_SUPABASE_PLATFORM_IDENTITY,
  s: process.env.ENABLE_SESSION_RESOLVE,
  n: process.env.NODE_ENV,
};
function restoreEnv(): void {
  if (ENV_SNAPSHOT.p === undefined) delete process.env.ENABLE_SUPABASE_PLATFORM_IDENTITY; else process.env.ENABLE_SUPABASE_PLATFORM_IDENTITY = ENV_SNAPSHOT.p;
  if (ENV_SNAPSHOT.s === undefined) delete process.env.ENABLE_SESSION_RESOLVE; else process.env.ENABLE_SESSION_RESOLVE = ENV_SNAPSHOT.s;
  if (ENV_SNAPSHOT.n === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = ENV_SNAPSHOT.n;
}

// --- Console capture (for audit-emission assertions) -------------------------
interface LogEntry { args: unknown[] }
function captureConsole<T>(fn: () => Promise<T>): Promise<{ value: T; logs: LogEntry[] }> {
  const logs: LogEntry[] = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  const grab = (...args: unknown[]) => { logs.push({ args }); };
  console.log = grab as any; console.warn = grab as any; console.error = grab as any;
  return fn().then(
    (value) => { console.log = orig.log; console.warn = orig.warn; console.error = orig.error; return { value, logs }; },
    (err) => { console.log = orig.log; console.warn = orig.warn; console.error = orig.error; throw err; },
  );
}
function auditEntries(logs: LogEntry[]): any[] {
  return logs
    .filter((e) => typeof e.args[0] === 'string' && (e.args[0] as string).includes('audit-decision'))
    .map((e) => e.args[1]);
}

// Run a handler once with given env + mocks, returning the captured response.
async function run(
  env: { platform: boolean; session: boolean; production: boolean },
  adapter: AuthAdapter,
  resolveIdentity: ResolveIdentityFn,
  reqOpts: { headers?: Record<string, string>; body?: unknown } = {},
): Promise<CapturedRes> {
  setEnv(env.platform, env.session, env.production);
  const handler = createSessionResolveHandler({ adapter, resolveIdentity });
  const { res, out } = mockRes();
  await handler(mockReq(reqOpts), res);
  return out;
}

const DEV = { platform: true, session: true, production: false };

async function main(): Promise<void> {
  // ===================== 1) Feature-flag matrix =====================
  {
    const a = adapterReturning(successAssertion);
    const offoff = await run({ platform: false, session: false, production: false }, a, resolverOk);
    check('1a both flags OFF → 404 feature disabled',
      offoff.status === 404 && offoff.json?.error?.code === 'FEATURE_DISABLED',
      `status=${offoff.status} code=${offoff.json?.error?.code}`);

    const platOnly = await run({ platform: true, session: false, production: false }, a, resolverOk);
    check('1b platform flag only → 404 feature disabled',
      platOnly.status === 404 && platOnly.json?.error?.code === 'FEATURE_DISABLED',
      `status=${platOnly.status}`);

    const sessOnly = await run({ platform: false, session: true, production: false }, a, resolverOk);
    check('1c session flag only → 404 feature disabled',
      sessOnly.status === 404 && sessOnly.json?.error?.code === 'FEATURE_DISABLED',
      `status=${sessOnly.status}`);

    const bothNonProd = await run({ platform: true, session: true, production: false }, a, resolverOk);
    check('1d both ON + non-prod → route active (200)',
      bothNonProd.status === 200 && bothNonProd.json?.reasonCode === R.VERIFIED_SUPABASE,
      `status=${bothNonProd.status} reason=${bothNonProd.json?.reasonCode}`);

    const bothProd = await run({ platform: true, session: true, production: true }, a, resolverOk);
    check('1e both ON + production → 404 feature disabled (force-disabled)',
      bothProd.status === 404 && bothProd.json?.error?.code === 'FEATURE_DISABLED',
      `status=${bothProd.status}`);
  }

  // ===================== 2) Missing Authorization =====================
  {
    const out = await run(DEV, adapterReturning(null), resolverOk);
    check('2 missing Authorization → 401 denied_unauthenticated, unauthenticated, authz null',
      out.status === 401 && out.json?.reasonCode === R.DENIED_UNAUTHENTICATED &&
        out.json?.authState === 'unauthenticated' && out.json?.identity === null && out.json?.authorization === null,
      `status=${out.status} reason=${out.json?.reasonCode}`);
  }

  // ===================== 3) Non-Bearer Authorization =====================
  {
    // A non-bearer header is surfaced by the adapter as "no assertion" (null).
    const out = await run(DEV, adapterReturning(null), resolverOk, { headers: { authorization: 'Basic abc' } });
    check('3 non-Bearer Authorization → 401 denied_unauthenticated',
      out.status === 401 && out.json?.reasonCode === R.DENIED_UNAUTHENTICATED && out.json?.authorization === null,
      `status=${out.status} reason=${out.json?.reasonCode}`);
  }

  // ===================== 4-7) Token verification failures (401) =====================
  const tokenFailures: Array<[number, string, any]> = [
    [4, R.SUPABASE_TOKEN_INVALID, new SupabaseTokenError('supabase_token_invalid', 'x')],
    [5, R.SUPABASE_TOKEN_EXPIRED, new SupabaseTokenError('supabase_token_expired', 'x')],
    [6, R.SUPABASE_TOKEN_WRONG_ISSUER, new SupabaseTokenError('supabase_token_wrong_issuer', 'x')],
    [7, R.SUPABASE_TOKEN_WRONG_AUDIENCE, new SupabaseTokenError('supabase_token_wrong_audience', 'x')],
  ];
  for (const [num, reason, err] of tokenFailures) {
    const out = await run(DEV, adapterThrowing(err), resolverOk);
    check(`${num} ${reason} → 401, unauthenticated, authz null`,
      out.status === 401 && out.json?.reasonCode === reason &&
        out.json?.authState === 'unauthenticated' && out.json?.identity === null && out.json?.authorization === null,
      `status=${out.status} reason=${out.json?.reasonCode}`);
  }

  // ===================== 8) JWKS unavailable (503) =====================
  {
    const out = await run(DEV, adapterThrowing(new SupabaseTokenError('jwks_unavailable', 'x')), resolverOk);
    check('8 jwks_unavailable → 503, deferred, unauthenticated, authz null',
      out.status === 503 && out.json?.reasonCode === R.JWKS_UNAVAILABLE &&
        out.json?.decision === 'deferred' && out.json?.authState === 'unauthenticated' && out.json?.authorization === null,
      `status=${out.status} reason=${out.json?.reasonCode}`);
  }

  // ===================== 9) Verified + resolved → 200, maps via M5 =====================
  {
    const out = await run(DEV, adapterReturning(successAssertion), resolverOk);
    const dto = out.json as SessionResolveResponseDTO;
    const s = mapWhoamiToAppSession(dto);
    check('9 verified + resolved → 200 verified_supabase, authenticated, identity populated, authz null, maps via M5',
      out.status === 200 && dto.reasonCode === R.VERIFIED_SUPABASE && dto.authState === 'authenticated' &&
        dto.identity?.internalUserId === 'iuid-123' && dto.authorization === null &&
        s.authState === 'authenticated' && s.identity?.internalUserId === 'iuid-123' && s.authorization === null,
      `status=${out.status} mappedAuthState=${s.authState} mappedAuthz=${s.authorization}`);
  }

  // ===================== 10) Resolver returns null → token-verified =====================
  {
    const out = await run(DEV, adapterReturning(successAssertion), resolverNull);
    const s = mapWhoamiToAppSession(out.json as SessionResolveResponseDTO);
    check('10 verified + resolver null → 503 identity_resolution_error, token-verified, NOT authenticated, authz null',
      out.status === 503 && out.json?.reasonCode === R.IDENTITY_RESOLUTION_ERROR &&
        out.json?.authState === 'token-verified' && out.json?.identity === null && out.json?.authorization === null &&
        s.authState === 'token-verified' && (s.authState as string) !== 'authenticated' && s.authorization === null,
      `status=${out.status} authState=${out.json?.authState} mapped=${s.authState}`);
  }

  // ===================== 11) Resolver throws → token-verified =====================
  {
    const out = await run(DEV, adapterReturning(successAssertion), resolverThrows);
    check('11 verified + resolver throws → 503 identity_resolution_error, token-verified, authz null',
      out.status === 503 && out.json?.reasonCode === R.IDENTITY_RESOLUTION_ERROR &&
        out.json?.authState === 'token-verified' && out.json?.authorization === null,
      `status=${out.status} authState=${out.json?.authState}`);
  }

  // ===================== 12) Unexpected handler error → 500 =====================
  {
    const out = await run(DEV, adapterThrowing(new Error('boom')), resolverOk);
    check('12 unexpected (non-typed) error → 500 session_resolve_error, unauthenticated, authz null',
      out.status === 500 && out.json?.reasonCode === R.SESSION_RESOLVE_ERROR &&
        out.json?.authState === 'unauthenticated' && out.json?.authorization === null,
      `status=${out.status} reason=${out.json?.reasonCode}`);
  }

  // ===================== 13) Forged body authority ignored =====================
  {
    const forgedBody = {
      role: 'system_owner', userType: 'platform', tenantId: 'tenant-evil', storeId: 'store-evil',
      permissions: { all: 'full' }, subPermissions: { everything: true },
      user_metadata: { role: 'system_owner' }, internalUserId: 'iuid-evil',
    };
    // Adapter ignores the body and derives identity ONLY from the (mock) token.
    const out = await run(DEV, adapterReturning(successAssertion), resolverOk, { body: forgedBody });
    const dto = out.json as SessionResolveResponseDTO;
    // identity.internalUserId is the resolver's 'iuid-123' (from the verified
    // token), NOT the forged body 'iuid-evil' — proving body authority is ignored.
    check('13 forged body role/tenant/store/permissions/internalUserId ignored → authz null, identity from token only',
      out.status === 200 && dto.authorization === null &&
        dto.identity?.internalUserId === 'iuid-123',
      `internalUserId=${dto.identity?.internalUserId} (forged 'iuid-evil' ignored) authz=${JSON.stringify(dto.authorization)}`);
  }

  // ===================== 14) No secret/token fields on the DTO =====================
  {
    const forbidden = ['accessToken', 'refreshToken', 'rawJwt', 'jwtPayload', 'jwks', 'serviceRoleKey', 'databaseUrl', 'connectionString'];
    const successOut = await run(DEV, adapterReturning(successAssertion), resolverOk);
    const failOut = await run(DEV, adapterThrowing(new SupabaseTokenError('supabase_token_invalid', 'x')), resolverOk);
    const leaked: string[] = [];
    for (const dto of [successOut.json, failOut.json]) {
      const keys = new Set(Object.keys(dto ?? {}));
      for (const f of forbidden) if (keys.has(f)) leaked.push(f);
    }
    check('14 DTO has no accessToken/refreshToken/rawJwt/jwtPayload/jwks/serviceRoleKey/databaseUrl/connectionString',
      leaked.length === 0, leaked.length ? `LEAKED: ${leaked.join(', ')}` : 'no forbidden fields present');
  }

  // ===================== 15) Advisory audit emitted on all paths =====================
  {
    // success (allow), deny (denied_unauthenticated), deferred (identity_resolution_error), failure (session_resolve_error)
    const paths: Array<{ label: string; adapter: AuthAdapter; resolver: ResolveIdentityFn; expectActor: string | null }> = [
      { label: 'allow', adapter: adapterReturning(successAssertion), resolver: resolverOk, expectActor: 'iuid-123' },
      { label: 'deny', adapter: adapterReturning(null), resolver: resolverOk, expectActor: null },
      { label: 'deferred', adapter: adapterReturning(successAssertion), resolver: resolverNull, expectActor: null },
      { label: 'failure', adapter: adapterThrowing(new Error('boom')), resolver: resolverOk, expectActor: null },
    ];
    let allEmitted = true;
    let actorOk = true;
    let noTokenLeak = true;
    for (const p of paths) {
      const { logs } = await captureConsole(() => run(DEV, p.adapter, p.resolver));
      const audits = auditEntries(logs);
      if (audits.length < 1) { allEmitted = false; continue; }
      const env = audits[audits.length - 1];
      if (env.actorId !== p.expectActor) actorOk = false;
      // No raw token / JWT material anywhere in captured logs.
      const blob = JSON.stringify(logs);
      if (/eyJ[A-Za-z0-9_-]{10,}\./.test(blob) || /Bearer\s+[A-Za-z0-9]/.test(blob)) noTokenLeak = false;
    }
    check('15 advisory audit emitted on allow/deny/deferred/failure; actorId correct; no raw token/JWT in logs',
      allEmitted && actorOk && noTokenLeak,
      `emitted=${allEmitted} actorId=${actorOk} noTokenLeak=${noTokenLeak}`);
  }

  restoreEnv();

  const failed = results.filter((r) => !r.pass);
  console.log(`\n[session-resolve-check] ${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) process.exitCode = 1;
}

main().catch((err) => {
  restoreEnv();
  console.error('[session-resolve-check] harness error:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});

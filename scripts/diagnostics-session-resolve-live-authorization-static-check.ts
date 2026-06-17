// Phase 1.5 M11.5 — STATIC (DB-free) check for /auth/session/resolve live
// authorization wiring.
//
// Proves, WITHOUT any DB connection:
//   - the contract widened to `ServerDerivedAuthorizationV1 | null` (null still valid),
//   - the new DEV-only flag exists, defaults off, and is production-hard-blocked,
//   - the route imports ONLY the M11.4 service (never the repository/writer/resolver),
//   - the route is fail-closed and never trusts the body/user_metadata/Firebase,
//   - and — by running the REAL handler with injected in-memory seams — that the
//     flag-disabled path returns `authorization: null`, the enabled allow+audited
//     path returns live authorization, and every deny / not-audited path returns
//     `authorization: null` while PRESERVING the authenticated identity.
//
// Exits non-zero on any failure. Prints booleans/labels only — never a secret.

import { readFileSync } from 'fs';
import { join } from 'path';
import type { Request, Response } from 'express';
import { createSessionResolveHandler } from '../server/platform-identity/sessionResolve';
import type { SessionAuthorizationResult } from '../server/platform-identity/sessionAuthorizationService';
import type { AuthAdapter } from '../server/platform-identity/authAdapter';
import type { ActorAssertion } from '../server/platform-identity/requestContext';
import type { ServerDerivedAuthorizationV1 } from '../server/platform-identity/authorizationContract';

const ROOT = process.cwd();
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

interface Result { name: string; pass: boolean; detail: string }
const results: Result[] = [];
function check(name: string, pass: boolean, detail = ''): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const contractSrc = read('server/platform-identity/sessionResolveContract.ts');
const configSrc = read('server/platform-identity/config.ts');
const routeSrc = read('server/platform-identity/sessionResolve.ts');
const routeCode = stripComments(routeSrc);
const configCode = stripComments(configSrc);
const mapperSrc = read('src/auth/mapWhoamiToAppSession.ts');

// =============================================================================
// Contract + config
// =============================================================================

check(
  'C1 contract widened to ServerDerivedAuthorizationV1 | null',
  /SessionResolveAuthorization\s*=\s*ServerDerivedAuthorizationV1\s*\|\s*null/.test(contractSrc),
  'nullable live authz type',
);
check('C2 authorization: null remains valid (| null present)', /\|\s*null/.test(contractSrc), 'null union present');
check('C3 config defines ENABLE_LIVE_SESSION_AUTHORIZATION', /ENABLE_LIVE_SESSION_AUTHORIZATION/.test(configSrc), 'flag const present');
check('C4 config exports isLiveSessionAuthorizationEnabled()', /export function isLiveSessionAuthorizationEnabled\(/.test(configSrc), 'helper present');
check('C5 live flag defaults off (exact "true" check)', /ENABLE_LIVE_SESSION_AUTHORIZATION\b[\s\S]{0,160}===\s*'true'/.test(configCode) || /\[LIVE_SESSION_AUTHORIZATION_FLAG\]\s*===\s*'true'/.test(configCode), 'exact-string true');
check(
  'C6 live flag production-hard-blocked',
  /isLiveSessionAuthorizationEnabled\([\s\S]{0,160}NODE_ENV\s*===\s*'production'\s*\)\s*return false/.test(configCode),
  'production returns false',
);

// =============================================================================
// Route isolation — imports ONLY the M11.4 service
// =============================================================================

check('C7 route imports the M11.4 service', /from '\.\/sessionAuthorizationService'/.test(routeCode), 'service imported');
check('C8 route does NOT import the repository directly', !/authorizationRepository/.test(routeCode), 'no repo import');
check('C9 route does NOT import the audit writer directly', !/auditEventWriter/.test(routeCode), 'no writer import');
check('C10 route does NOT import the resolver directly', !/authorizationResolver/.test(routeCode), 'no resolver import');

// =============================================================================
// Route structure — gating, fail-closed, no client trust
// =============================================================================

check('C11s route keeps an authorization:null default before the gate', /authorization:\s*SessionResolveAuthorization\s*=\s*null/.test(routeCode), 'null default');
check('C12s enabled branch gated by isLiveSessionAuthorizationEnabled', /isLiveSessionAuthorizationEnabled\(\)/.test(routeCode), 'flag gate present');
check('C13s enabled branch calls resolveSessionAuthorization (default = service)', /resolveSessionAuthorization\(/.test(routeCode) && /resolveDefaultSessionAuthorization/.test(routeCode), 'service seam present');
check(
  'C14s authz returned ONLY for allow && audited && authorization',
  /decision\s*===\s*'allow'\s*&&\s*authzResult\.audited\s*&&\s*authzResult\.authorization/.test(routeCode),
  'fail-closed guard',
);
check('C26 existing session-resolve gates remain required', /isPlatformIdentityEnabled\(\)/.test(routeCode) && /isSessionResolveEnabled\(\)/.test(routeCode), 'both gates present');
check('C16 route does NOT read request body for authority', !/req\.body/.test(routeCode), 'no req.body');
check('C18 route does NOT trust Supabase user_metadata', !/user_metadata/i.test(routeCode), 'no user_metadata');
check('C19 route has no Firebase fallback', !/firebase/i.test(routeCode), 'no firebase');
check('C20 route logs no token/JWT/auth-header/cookie + no console.*', !/console\./.test(routeCode) && !/cookie/i.test(routeCode) && !/rawJwt|jwtPayload/i.test(routeCode), 'no raw secret logging');
check('C21 route imports no frontend (src/)', !/from '[^']*\/src\//.test(routeCode) && !/from 'src\//.test(routeCode), 'no src import');
check('C23 route references no Supabase MCP', !/\bmcp\b/i.test(routeCode), 'no mcp');
check('C24 route runs no migration/seed/rollback', !/\bmigrate\b|\bseed\b|\brollback\b/i.test(routeCode), 'none');
check('C28 response DTO shape preserved (identity + authorization fields)', /identity:\s*SessionResolveIdentity\s*\|\s*null/.test(contractSrc) && /authorization:\s*SessionResolveAuthorization/.test(contractSrc), 'shape intact');
check('C29 frontend mapper still emits authorization: null (untouched)', /authorization:\s*null/.test(mapperSrc), 'mapper null preserved');

// =============================================================================
// 11–15) Behavioral mock proofs — run the REAL handler with injected seams (DB-free)
// =============================================================================

const FAKE_AUTHZ: ServerDerivedAuthorizationV1 = {
  authorizationVersion: 'authz.v1',
  userType: 'platform',
  scope: { scopeType: 'platform', tenantId: null, storeId: null },
  roles: { platformRoleId: 'system_owner', tenantRoleId: null },
  status: { user: 'active', tenant: null, store: null },
  entitlements: {},
  permissions: {},
  subPermissions: {},
  derivedBy: 'static_check@v0',
};

const mockAssertion: ActorAssertion = {
  authProvider: 'supabase',
  authProviderUid: 'mock-uid',
  email: null,
  displayName: null,
  actorType: 'platform_user',
  scope: { scopeType: 'none', tenantId: null, storeId: null, platformScope: false },
  permissionSnapshot: null,
  verified: true,
};
const mockAdapter: AuthAdapter = { name: 'mock@static', verify: async () => mockAssertion };
const mockResolveIdentity = async (): Promise<string | null> => '11111111-1111-1111-1111-111111111111';

function makeRes() {
  const r: Partial<Response> & { statusCode: number; body: any } = {
    statusCode: 0,
    body: null,
  };
  r.status = ((c: number) => { r.statusCode = c; return r as Response; }) as Response['status'];
  r.json = ((b: any) => { r.body = b; return r as Response; }) as Response['json'];
  return r;
}

const allowAudited: SessionAuthorizationResult = {
  decision: 'allow', reasonCode: 'resolved', humanReadableReason: 'ok',
  authorization: FAKE_AUTHZ, limitation: 'none', audited: true, auditFailed: false, forcedDeny: false,
};
const denyResult: SessionAuthorizationResult = {
  decision: 'deny', reasonCode: 'denied_no_membership', humanReadableReason: 'no',
  authorization: null, limitation: 'none', audited: true, auditFailed: false, forcedDeny: false,
};
// Hypothetical allow that was NOT audited — the route's OWN guard must still null it.
const allowNotAudited: SessionAuthorizationResult = {
  decision: 'allow', reasonCode: 'resolved', humanReadableReason: 'ok',
  authorization: FAKE_AUTHZ, limitation: 'none', audited: false, auditFailed: true, forcedDeny: false,
};

async function callRoute(
  liveFlag: boolean,
  authzSeam: SessionAuthorizationResult,
): Promise<{ status: number; body: any }> {
  process.env.ENABLE_SUPABASE_PLATFORM_IDENTITY = 'true';
  process.env.ENABLE_SESSION_RESOLVE = 'true';
  process.env.ENABLE_LIVE_SESSION_AUTHORIZATION = liveFlag ? 'true' : 'false';
  delete process.env.NODE_ENV; // ensure non-production for the gate
  const handler = createSessionResolveHandler({
    adapter: mockAdapter,
    resolveIdentity: mockResolveIdentity,
    resolveSessionAuthorization: async () => authzSeam,
  });
  const res = makeRes();
  await handler({} as Request, res as Response);
  return { status: res.statusCode, body: res.body };
}

async function run(): Promise<void> {
  // 11) Flag disabled → authorization null, identity authenticated.
  const disabled = await callRoute(false, allowAudited);
  check(
    'M11 flag-disabled → authorization null, identity authenticated',
    disabled.status === 200 && disabled.body?.authState === 'authenticated' && disabled.body?.authorization === null,
    `authState=${disabled.body?.authState} authz=${disabled.body?.authorization}`,
  );

  // 12+13) Flag enabled + allow+audited → live authorization returned.
  const enabled = await callRoute(true, allowAudited);
  check(
    'M12 flag-enabled allow+audited → live authorization returned',
    enabled.status === 200 && enabled.body?.authorization?.roles?.platformRoleId === 'system_owner' &&
      enabled.body?.authState === 'authenticated',
    `authz=${enabled.body?.authorization?.roles?.platformRoleId} authState=${enabled.body?.authState}`,
  );

  // 14) Flag enabled + deny → authorization null, identity preserved.
  const denied = await callRoute(true, denyResult);
  check(
    'M14 flag-enabled deny → authorization null, identity preserved',
    denied.status === 200 && denied.body?.authorization === null && denied.body?.authState === 'authenticated',
    `authz=${denied.body?.authorization} authState=${denied.body?.authState}`,
  );

  // 15) Flag enabled + allow-but-NOT-audited → route guard forces authorization null.
  const notAudited = await callRoute(true, allowNotAudited);
  check(
    'M15 flag-enabled allow-not-audited → authorization null (route fail-closed), identity preserved',
    notAudited.status === 200 && notAudited.body?.authorization === null && notAudited.body?.authState === 'authenticated',
    `authz=${notAudited.body?.authorization} authState=${notAudited.body?.authState}`,
  );

  // No secret in the returned check details (the body's uid/email are never printed).
  finish();
}

function finish(): void {
  const failed = results.filter((r) => !r.pass);
  console.log(`\n[session-resolve-live-authz-static] ${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) process.exitCode = 1;
}

run().catch((err) => {
  console.error('[session-resolve-live-authz-static] harness error:', err instanceof Error ? err.name : 'Error');
  process.exitCode = 1;
});

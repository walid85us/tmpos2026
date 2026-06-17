// Phase 1.5 M11.4 — STATIC (DB-free) check for the session authorization service.
//
// Proves, WITHOUT any DB connection:
//   - the service composes the M11.2 repository + M11 resolver + M11.3 writer,
//   - it imports NO Express/frontend/sessionResolve and registers NO route,
//   - it runs NO direct SQL and prints NO secret,
//   - its FAIL-CLOSED branch downgrades an unauditable allow to deny (proven by
//     running the real service with injected in-memory seams — no DB),
//   - the standing `/auth/session/resolve` + contract null-authorization
//     invariants are intact, and the composed M11/M11.2/M11.3 modules still carry
//     their binding markers.
//
// Exits non-zero on any failure. Prints booleans/labels only — never a secret.

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  resolveSessionAuthorizationForContext,
  deriveDefaultRequestedContextFromMemberships,
  SESSION_AUTHZ_DENIED_AUDIT_FAILED,
  type SessionAuthorizationResult,
} from '../server/platform-identity/sessionAuthorizationService';
import type {
  AuthorizationResolverInput,
  MembershipSnapshot,
  RequestedContext,
} from '../server/platform-identity/authorizationResolver';
import type { IdentityKey } from '../server/platform-identity/authorizationRepository';
import type { WrittenAuditEvent } from '../server/platform-identity/auditEventWriter';

const ROOT = process.cwd();
const SERVICE = 'server/platform-identity/sessionAuthorizationService.ts';

interface Result { name: string; pass: boolean; detail: string }
const results: Result[] = [];
function check(name: string, pass: boolean, detail = ''): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8');
}

/** Strip block + line comments so content scans ignore documentation/safety prose. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

// =============================================================================
// 1) File + import shape
// =============================================================================

const serviceSrc = read(SERVICE);
const serviceCode = stripComments(serviceSrc);

check('C1 service file exists', serviceSrc.length > 0, SERVICE);

check(
  'C2 imports the M11.2 repository',
  /from '\.\/authorizationRepository'/.test(serviceCode),
  'authorizationRepository',
);
check(
  'C2b imports the M11 resolver',
  /from '\.\/authorizationResolver'/.test(serviceCode),
  'authorizationResolver',
);
check(
  'C2c imports the M11.3 audit writer',
  /from '\.\/auditEventWriter'/.test(serviceCode),
  'auditEventWriter',
);

// =============================================================================
// 2) Isolation: no Express / frontend / sessionResolve / route registration
// =============================================================================

check('C3 does NOT import Express', !/from 'express'/.test(serviceCode), 'no express');
check('C3b does NOT import frontend (src/)', !/from '[^']*\/src\//.test(serviceCode) && !/from 'src\//.test(serviceCode), 'no src/');
check('C3c does NOT import sessionResolve', !/sessionResolve/.test(serviceCode), 'no sessionResolve');
check(
  'C3d does NOT import the server/route module',
  !/from '\.\/server'/.test(serviceCode) && !/createPlatformIdentityApp/.test(serviceCode),
  'no server.ts',
);
check(
  'C4 registers NO route',
  !/\bapp\.(get|post|put|patch|delete|use|listen)\s*\(/.test(serviceCode) && !/express\(\)/.test(serviceCode),
  'no route registration',
);

// =============================================================================
// 3) No direct SQL / no sql.unsafe
// =============================================================================

const sqlPatterns =
  /\binsert\s+into\b|\bupdate\s+\w+\s+set\b|\bdelete\s+from\b|\bselect\s+.+\bfrom\b|\b(alter|drop|truncate)\b/i;
check('C5 runs NO direct SQL (reads via repo, writes via writer)', !sqlPatterns.test(serviceCode), 'none');
check('C6 has NO sql.unsafe', !/\.unsafe\b/.test(serviceCode), 'no .unsafe');
check('C6b has NO tagged-template SQL', !/\bsql`/.test(serviceCode) && !/executor`/.test(serviceCode) && !/\btx`/.test(serviceCode), 'none');

// =============================================================================
// 4) Logs nothing (cannot print UID/email/secret)
// =============================================================================

check('C7 prints nothing (no console.*)', !/console\./.test(serviceCode), 'no console output');

// =============================================================================
// 5) Fail-closed branch present + server-derived context selection
// =============================================================================

check(
  'C8 has a fail-closed downgrade reason code',
  /denied_audit_write_failed/.test(serviceCode) && serviceCode.includes(SESSION_AUTHZ_DENIED_AUDIT_FAILED),
  SESSION_AUTHZ_DENIED_AUDIT_FAILED,
);
check(
  'C9 downgrades an unauditable allow (condition over decision+audit)',
  /decision\s*===\s*'allow'\s*&&\s*!audited/.test(serviceCode),
  "allow && !audited → forced deny",
);
check(
  'C10 has server-derived context selection',
  /deriveDefaultRequestedContextFromMemberships/.test(serviceCode),
  'platform-first default resolver present',
);

// =============================================================================
// 6) No MCP / migration / seed / rollback / package.json changes
// =============================================================================

check('C16 no Supabase MCP references', !/\bmcp\b/i.test(serviceCode), 'no mcp');
check(
  'C17 no migration/seed/rollback execution',
  !/\bmigrate\b|\bseed\b|\brollback\b|\b003\b/i.test(serviceCode),
  'none',
);
check(
  'C18 introduces no new external dependency',
  // every import is relative ('./…' or '../…') or the 'crypto' built-in.
  Array.from(serviceCode.matchAll(/from '([^']+)'/g)).every(
    (m) => m[1].startsWith('.') || m[1] === 'crypto',
  ),
  'relative + crypto only',
);

// =============================================================================
// 7) Standing invariants of the (unmodified) neighbouring modules
// =============================================================================

const sessionResolveSrc = read('server/platform-identity/sessionResolve.ts');
const sessionResolveContractSrc = read('server/platform-identity/sessionResolveContract.ts');
const resolverSrc = read('server/platform-identity/authorizationResolver.ts');
const repoSrc = read('server/platform-identity/authorizationRepository.ts');
const writerSrc = read('server/platform-identity/auditEventWriter.ts');

check(
  'C11 /auth/session/resolve still returns authorization: null',
  /authorization:\s*null/.test(sessionResolveSrc),
  'authorization null present',
);
check(
  'C12 sessionResolveContract still pins SessionResolveAuthorization = null',
  /SessionResolveAuthorization\s*=\s*null/.test(sessionResolveContractSrc),
  'null contract present',
);
check(
  'C13 M11 resolver still exposes the pure resolveAuthorization',
  /export function resolveAuthorization\(/.test(resolverSrc),
  'resolveAuthorization present',
);
check(
  'C14 M11.2 repository still exposes the read-only count helper',
  /export async function countDurableAuthorizationRows\(/.test(repoSrc) &&
    /export async function buildResolverInputForContext\(/.test(repoSrc),
  'repository readers present',
);
check(
  'C15 M11.3 writer still INSERT-only into audit_event',
  /insert into audit_event/.test(writerSrc) && !/update audit_event|delete from audit_event/i.test(stripComments(writerSrc)),
  'append-only writer present',
);

// =============================================================================
// 19) In-memory mock proofs (DB-free) — allow/audit, fail-closed, deny
// =============================================================================

const MOCK_UID = '11111111-1111-1111-1111-111111111111';
const identityKey: IdentityKey = { authProvider: 'supabase', authProviderUid: 'mock-uid' };
const platformCtx: RequestedContext = { scopeType: 'platform' };

function platformOwnerInput(): AuthorizationResolverInput {
  return {
    identity: { internalUserId: MOCK_UID, authProvider: 'supabase', authProviderUid: 'mock-uid', email: 'mock@example.test' },
    appUser: { internal_user_id: MOCK_UID, status: 'active', display_name: null },
    memberships: [
      {
        membership_id: '22222222-2222-2222-2222-222222222222',
        internal_user_id: MOCK_UID,
        tenant_id: null,
        store_id: null,
        scope_type: 'platform',
        role_id: 'system_owner',
        status: 'active',
      },
    ],
    tenant: null,
    store: null,
    entitlements: [],
    requestedContext: platformCtx,
  };
}

function noMembershipInput(): AuthorizationResolverInput {
  return { ...platformOwnerInput(), memberships: [] };
}

const okWriter = async (): Promise<WrittenAuditEvent> => ({ eventId: MOCK_UID, requestId: MOCK_UID });
const failWriter = async (): Promise<WrittenAuditEvent> => {
  throw new Error('simulated audit failure');
};

/** Field names that must NEVER appear on a returned result. */
const FORBIDDEN_RESULT_FIELDS = [
  'authProviderUid', 'email', 'token', 'accessToken', 'refreshToken', 'rawJwt',
  'jwtPayload', 'jwks', 'serviceRoleKey', 'databaseUrl', 'connectionString', 'password',
];
function hasNoForbiddenField(r: SessionAuthorizationResult): boolean {
  const keys = Object.keys(r);
  return !FORBIDDEN_RESULT_FIELDS.some((f) => keys.includes(f));
}

async function run(): Promise<void> {
  // M1 — platform allow path IS auditable → allow + audited.
  const allow = await resolveSessionAuthorizationForContext(identityKey, platformCtx, {
    buildResolverInput: async () => platformOwnerInput(),
    writeAuditEvent: okWriter,
  });
  check(
    'M1 platform allow path is audited',
    allow.decision === 'allow' && allow.audited === true && allow.forcedDeny === false &&
      allow.authorization?.roles.platformRoleId === 'system_owner',
    `${allow.decision}/audited=${allow.audited}/${allow.authorization?.roles.platformRoleId}`,
  );
  check('M1b allow result carries no secret field', hasNoForbiddenField(allow), Object.keys(allow).join(','));

  // M2 — audit failure forces deny (unauditable allow → deny/null).
  const forced = await resolveSessionAuthorizationForContext(identityKey, platformCtx, {
    buildResolverInput: async () => platformOwnerInput(),
    writeAuditEvent: failWriter,
  });
  check(
    'M2 audit-write failure downgrades allow to deny',
    forced.decision === 'deny' && forced.forcedDeny === true && forced.authorization === null &&
      forced.reasonCode === SESSION_AUTHZ_DENIED_AUDIT_FAILED,
    `${forced.decision}/forcedDeny=${forced.forcedDeny}/${forced.reasonCode}`,
  );

  // M3 — a resolver DENY stays deny (even with a working writer); not a forced deny.
  const deny = await resolveSessionAuthorizationForContext(identityKey, platformCtx, {
    buildResolverInput: async () => noMembershipInput(),
    writeAuditEvent: okWriter,
  });
  check(
    'M3 resolver deny remains deny',
    deny.decision === 'deny' && deny.forcedDeny === false && deny.authorization === null,
    `${deny.decision}/forcedDeny=${deny.forcedDeny}/${deny.reasonCode}`,
  );

  // M4 — platform-first default context selection (pure).
  const memberships: MembershipSnapshot[] = [
    { membership_id: 'a', internal_user_id: MOCK_UID, tenant_id: 't', store_id: 's', scope_type: 'store', role_id: 'store_owner', status: 'active' },
    { membership_id: 'b', internal_user_id: MOCK_UID, tenant_id: null, store_id: null, scope_type: 'platform', role_id: 'system_owner', status: 'active' },
  ];
  const picked = deriveDefaultRequestedContextFromMemberships(memberships);
  check('M4 default context is platform-first', picked?.scopeType === 'platform', picked?.scopeType ?? 'null');
  const noActive = deriveDefaultRequestedContextFromMemberships([
    { membership_id: 'c', internal_user_id: MOCK_UID, tenant_id: 't', store_id: null, scope_type: 'tenant', role_id: 'store_owner', status: 'invited' },
  ]);
  check('M4b no active membership → null default context', noActive === null, String(noActive));

  finish();
}

function finish(): void {
  const failed = results.filter((r) => !r.pass);
  console.log(`\n[session-authz-service-static] ${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) process.exitCode = 1;
}

run().catch((err) => {
  console.error('[session-authz-service-static] harness error:', err instanceof Error ? err.name : 'Error');
  process.exitCode = 1;
});

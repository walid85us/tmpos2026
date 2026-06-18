// Phase 1.6 M3 — STATIC (offline) server-derived authorization ROUTE-CONTRACT check.
//
// PURE / OFFLINE: no DB, no network, no Supabase, no Firebase, no env secrets, no
// SQL, no migration, no audit write, no Supabase MCP, and NO runtime route call.
// It imports the inert session-resolve + authorization contracts and reads the
// route/contract/config source files as TEXT (read-only) to assert that the
// server-derived authorization wire contract is stable, truthful, and safe for
// future frontend adoption. It never constructs a request, never starts a server.
//
// Run:  npx tsx scripts/diagnostics-session-derived-authorization-contract-check.ts

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  SESSION_RESOLVE_MATRIX,
  SESSION_RESOLVE_REASON_CODES,
  SESSION_RESOLVE_AUTHORIZATION_PRESENCE,
  SESSION_RESOLVE_AUTHORIZATION_PRESENCE_CONDITIONS,
} from '../server/platform-identity/sessionResolveContract';
import { AUTHORIZATION_FORBIDDEN_FIELDS } from '../server/platform-identity/authorizationContract';

const ROOT = process.cwd();
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

interface Result { name: string; pass: boolean; detail: string }
const results: Result[] = [];
function check(name: string, pass: boolean, detail = ''): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const contractSrc = read('server/platform-identity/sessionResolveContract.ts');
const routeSrc = read('server/platform-identity/sessionResolve.ts');
const configSrc = read('server/platform-identity/config.ts');

// =============================================================================
// 1) Stale "authorization is ALWAYS null" invariant has been reconciled
// =============================================================================

const staleInvariant = /`authorization`\s+is\s+ALWAYS\s+`null`|ALWAYS\s+null\s+in\s+this\s+era/i;
check('1a stale "authorization is ALWAYS null" invariant removed from contract', !staleInvariant.test(contractSrc), staleInvariant.test(contractSrc) ? 'STILL PRESENT' : 'reconciled');
// The truthful default-vs-conditional wording is present instead.
check('1b contract documents `null` by DEFAULT + conditional non-null', /null`?\s+by\s+DEFAULT/i.test(contractSrc) && /MAY\s+be\s+(a\s+)?non-null/i.test(contractSrc), 'truthful');

// =============================================================================
// 2) Wire authorization type is ServerDerivedAuthorizationV1 | null
// =============================================================================

check('2a SessionResolveAuthorization = ServerDerivedAuthorizationV1 | null', /export\s+type\s+SessionResolveAuthorization\s*=\s*ServerDerivedAuthorizationV1\s*\|\s*null\s*;/.test(contractSrc), 'typed');
check('2b DTO authorization field typed as SessionResolveAuthorization', /authorization:\s*SessionResolveAuthorization\s*;/.test(contractSrc), 'wired');

// =============================================================================
// 3) Documented non-null PRESENCE conditions match the M11.5 gate structure
// =============================================================================

const cond = SESSION_RESOLVE_AUTHORIZATION_PRESENCE;
const expectedKeys = [
  'platformIdentityEnabled', 'sessionResolveEnabled', 'liveSessionAuthorizationEnabled',
  'nonProduction', 'resolverAllow', 'durableAuditSucceeded',
];
check('3a presence conditions enumerate the full AND-ed gate set (6)', SESSION_RESOLVE_AUTHORIZATION_PRESENCE_CONDITIONS.length === 6 && expectedKeys.every((k) => k in cond), SESSION_RESOLVE_AUTHORIZATION_PRESENCE_CONDITIONS.join(','));
check('3b conditions name the three DEV feature flags', cond.platformIdentityEnabled === 'ENABLE_SUPABASE_PLATFORM_IDENTITY' && cond.sessionResolveEnabled === 'ENABLE_SESSION_RESOLVE' && cond.liveSessionAuthorizationEnabled === 'ENABLE_LIVE_SESSION_AUTHORIZATION', 'flags named');
check('3c conditions include non-production + resolver allow + durable audit', /NODE_ENV!==production/.test(cond.nonProduction) && /allow/.test(cond.resolverAllow) && /audited/.test(cond.durableAuditSucceeded), 'allow+audit+nonprod');

// =============================================================================
// 4) The documented conditions align with the ACTUAL route gating (text)
// =============================================================================

check('4a route gates on all three feature flags', /isPlatformIdentityEnabled\(\)/.test(routeSrc) && /isSessionResolveEnabled\(\)/.test(routeSrc) && /isLiveSessionAuthorizationEnabled\(\)/.test(routeSrc), 'three gates');
check('4b route returns authorization ONLY for allow + audited + present authz', /decision\s*===\s*'allow'\s*&&\s*\w+\.audited\s*&&\s*\w+\.authorization/.test(routeSrc), 'allow+audited+authz');
check('4c config exposes the three non-prod-guarded flag helpers', /isSessionResolveEnabled|ENABLE_SESSION_RESOLVE/.test(configSrc) && /isLiveSessionAuthorizationEnabled|ENABLE_LIVE_SESSION_AUTHORIZATION/.test(configSrc) && /NODE_ENV\s*===\s*'production'/.test(configSrc), 'flags + nonprod');

// =============================================================================
// 5) Disabled / default path is statically null-by-construction
// =============================================================================

// authorization is initialized to null and assigned only inside the live-flag block.
check('5a route initializes authorization to null', /let\s+authorization[^=]*=\s*null\s*;/.test(routeSrc), 'null default');
check('5b authorization assignment is guarded by isLiveSessionAuthorizationEnabled()', /if\s*\(isLiveSessionAuthorizationEnabled\(\)\)\s*\{[\s\S]*?authorization\s*=\s*\w+\.authorization\s*;/.test(routeSrc), 'guarded');

// =============================================================================
// 6) Forbidden-field safety preserved (no token/JWT/key/secret/DB URL fields)
// =============================================================================

check('6a resolver DTO forbidden-field guard is non-empty', AUTHORIZATION_FORBIDDEN_FIELDS.length >= 8 && AUTHORIZATION_FORBIDDEN_FIELDS.includes('serviceRoleKey') && AUTHORIZATION_FORBIDDEN_FIELDS.includes('databaseUrl'), AUTHORIZATION_FORBIDDEN_FIELDS.join(','));
// The SessionResolveForbiddenField guard type still lists the secret/token fields.
check('6b SessionResolveForbiddenField guard type present', /export\s+type\s+SessionResolveForbiddenField/.test(contractSrc) && /serviceRoleKey/.test(contractSrc) && /connectionString/.test(contractSrc), 'guard present');
// None of the forbidden field names is DECLARED as a DTO property in the contract.
const dtoBlock = contractSrc.slice(contractSrc.indexOf('interface SessionResolveResponseDTO'));
const declaredForbidden = ['accessToken', 'refreshToken', 'rawJwt', 'jwtPayload', 'jwks', 'serviceRoleKey', 'databaseUrl', 'connectionString', 'password']
  .filter((f) => new RegExp(`(^|\\n)\\s*${f}\\s*[?:]`).test(dtoBlock));
check('6c no forbidden field is declared on the wire DTO', declaredForbidden.length === 0, declaredForbidden.join(',') || 'none');

// =============================================================================
// 7) The status/decision/authState matrix remains present and authoritative
// =============================================================================

const reasonCodes = Object.values(SESSION_RESOLVE_REASON_CODES);
const everyReasonHasRow = reasonCodes.every((rc) => (SESSION_RESOLVE_MATRIX as Record<string, unknown>)[rc] !== undefined);
check('7a every reason code has a matrix row', everyReasonHasRow, `${reasonCodes.length} codes`);
check('7b verified_supabase → 200/allow/authenticated', (() => { const r = SESSION_RESOLVE_MATRIX.verified_supabase; return r.status === 200 && r.decision === 'allow' && r.authState === 'authenticated'; })(), 'ok');
check('7c identity_resolution_error → token-verified (fail-closed, never authenticated)', SESSION_RESOLVE_MATRIX.identity_resolution_error.authState === 'token-verified', SESSION_RESOLVE_MATRIX.identity_resolution_error.authState);

// =============================================================================
// 8) Wire DTO backward compatibility (no removed field)
// =============================================================================

const requiredFields = ['status', 'requestId', 'authState', 'internalUserId', 'authProvider', 'decision', 'reasonCode', 'identity', 'authorization'];
const missing = requiredFields.filter((f) => !new RegExp(`(^|\\n)\\s*${f}\\??:`).test(dtoBlock));
check('8a wire DTO still declares every prior field (no removal)', missing.length === 0, missing.join(',') || 'all present');

// =============================================================================
// 9) Inertness via import-allowlist (non-circular) + no env / no route call
// =============================================================================

const selfSrc = read('scripts/diagnostics-session-derived-authorization-contract-check.ts');
const selfImports = [...selfSrc.matchAll(/^import[\s\S]*?from '([^']+)'/gm)].map((m) => m[1]);
const allowed = new Set([
  'fs', 'path',
  '../server/platform-identity/sessionResolveContract',
  '../server/platform-identity/authorizationContract',
]);
// fs is imported only for reading: assert the `from 'fs'` binding list ⊆ {readFileSync}.
const fsBindings = ((selfSrc.match(/import\s*\{([^}]*)\}\s*from\s*'fs'/) ?? ['', ''])[1])
  .split(',').map((s) => s.trim()).filter(Boolean);
// Route/DB/transport modules that, if imported, would make this NOT static. The
// import-allowlist already excludes them; this is the explicit non-circular proof.
const routeDbModules = (i: string) => /sessionResolve$|\/db$|express|node-fetch|supertest|http$/.test(i);
check('9a diagnostic imports confined to node fs/path + inert contracts', selfImports.length > 0 && selfImports.every((i) => allowed.has(i)), selfImports.join(', '));
check('9b diagnostic imports no frontend (src/)', !selfImports.some((i) => i.includes('/src/') || i.startsWith('src/')), 'no src import');
check('9c diagnostic accesses no environment variables', !/process\.env/.test(selfSrc), 'no env');
check('9d diagnostic imports no route/db/transport module (no live route call possible)', !selfImports.some(routeDbModules) && fsBindings.every((b) => b === 'readFileSync'), 'inert');

// =============================================================================
// Summary
// =============================================================================

const failed = results.filter((r) => !r.pass);
console.log(`\n[session-derived-authorization-contract-check] ${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length) process.exitCode = 1;

// Phase 1.6 M16.2 — STATIC (offline) SAFE-ERROR-CLASSIFICATION check for the
// session-resolve route + Vite proxy instrumentation.
//
// PURE / OFFLINE: no DB, no network, no Supabase, no Firebase, no env values, no SQL,
// no migration, no audit write, no Supabase MCP, no live/route call, no child process.
// It reads source files as TEXT only (read-only — NEVER imported, NEVER executed) and
// PROVES that the M16.2 observability instrumentation:
//   - adds a handler ENTRY breadcrumb + safe EXIT breadcrumbs (feature-disabled /
//     denied / token-rejected / identity-unresolved / authenticated / unexpected-error)
//     in server/platform-identity/sessionResolve.ts,
//   - the catch-all 500 path is safely attributable (status + reasonCode + sanitized
//     error class/code),
//   - NO breadcrumb / log call carries a token / Authorization header / request
//     headers / request body / raw response body / raw authorization DTO / identity
//     fields / tenant or store id / permission key or level,
//   - vite.config.ts adds SAFE `/__identity` proxy error + response markers that log
//     no headers / Authorization / cookies / body / token / raw URL / query,
//   - the M14 feed + M15 harness remain un-instrumented (no breadcrumb, no console),
//   - the instrumentation invokes NO live route / harness / feed / token bridge and
//     enables NO live authorization, and
//   - this diagnostic is itself self-inert (fs/path only, read-only, no env/network/DB).
//
// Run:  npx tsx scripts/diagnostics-session-resolve-error-classification-static-check.ts

import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

interface Result { name: string; pass: boolean; detail: string }
const results: Result[] = [];
function check(name: string, pass: boolean, detail = ''): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

// Comment-stripped CODE view so documentation prose is never mistaken for behavior.
const stripComments = (s: string): string =>
  s.replace(/(^|[^:])\/\/.*$/gm, '$1').replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * Extract the argument text of every call to a callee. Returns each call's "(...)"
 * substring (balanced parens). Good enough for guarding log call sites in CODE.
 */
function extractCallArgs(src: string, calleeSource: string): string[] {
  const out: string[] = [];
  const re = new RegExp(calleeSource, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    let i = m.index + m[0].length;
    while (i < src.length && src[i] !== '(') i++;
    if (src[i] !== '(') continue;
    let depth = 0;
    const start = i;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === '(') depth++;
      else if (c === ')') { depth--; if (depth === 0) { i++; break; } }
    }
    out.push(src.slice(start, i));
  }
  return out;
}

const ROUTE = 'server/platform-identity/sessionResolve.ts';
const VITE = 'vite.config.ts';
const FEED = 'src/auth/serverAuthzShadowFeed.ts';
const HARNESS = 'src/auth/serverAuthzShadowLiveHarness.ts';
const SELF = 'scripts/diagnostics-session-resolve-error-classification-static-check.ts';

const routeSrc = read(ROUTE);
const routeCode = stripComments(routeSrc);
const viteSrc = read(VITE);
const viteCode = stripComments(viteSrc);
const feedSrc = read(FEED);
const harnessSrc = read(HARNESS);

// =============================================================================
// 1) Server breadcrumb helper exists and is leak-proof by construction
// =============================================================================
check('1 sessionResolve has the safe breadcrumb helper sessionResolveBreadcrumb',
  /function\s+sessionResolveBreadcrumb\s*\(/.test(routeCode), 'helper present');
check('2 breadcrumb helper takes a requestId string (not a Request/assertion/identity)',
  /function\s+sessionResolveBreadcrumb\s*\(\s*[\s\S]*?requestId:\s*string/.test(routeCode)
  && !/function\s+sessionResolveBreadcrumb\s*\([^)]*\breq\b[^)]*\)/.test(routeCode)
  && !/function\s+sessionResolveBreadcrumb\s*\([^)]*\bRequest\b[^)]*\)/.test(routeCode)
  && !/function\s+sessionResolveBreadcrumb\s*\([^)]*assertion[^)]*\)/.test(routeCode),
  'requestId+phase+fields only');
check('3 breadcrumb fields type allow-lists ONLY safe primitive keys',
  /interface\s+SessionResolveBreadcrumbFields\s*\{[\s\S]*?\}/.test(routeCode) && (() => {
    const block = (routeCode.match(/interface\s+SessionResolveBreadcrumbFields\s*\{([\s\S]*?)\}/) ?? ['', ''])[1];
    const keys = [...block.matchAll(/(\w+)\??:/g)].map((m) => m[1]).sort();
    const allowed = ['authorizationPresent', 'errorClass', 'errorCode', 'reasonCode', 'status'].sort();
    return keys.length === allowed.length && keys.every((k, i) => k === allowed[i]);
  })(), 'status/reasonCode/authorizationPresent/errorClass/errorCode only');

// =============================================================================
// 2) Entry + exit breadcrumbs present (attributable execution)
// =============================================================================
check('4 handler ENTRY breadcrumb (received)', /sessionResolveBreadcrumb\(\s*requestId,\s*'received'/.test(routeCode), 'entry marker');
check('5 feature-disabled exit breadcrumb (404)', /'feature_disabled'[\s\S]*?status:\s*404/.test(routeCode), 'feature_disabled 404');
check('6 denied-unauthenticated exit breadcrumb', /'denied_unauthenticated'/.test(routeCode), 'denied exit');
check('7 token-rejected exit breadcrumb (401/503 via reasonCode)', /'token_rejected'/.test(routeCode), 'token exit');
check('8 identity-unresolved exit breadcrumb (503)', /'identity_unresolved'[\s\S]*?IDENTITY_RESOLUTION_ERROR/.test(routeCode), 'identity 503');
check('9 authenticated success breadcrumb with authorizationPresent boolean',
  /'authenticated'[\s\S]*?authorizationPresent:\s*authorization\s*!==\s*null/.test(routeCode), 'success 200 + presence bool');
check('10 catch-all 500 breadcrumb (unexpected_error + session_resolve_error)',
  /'unexpected_error'[\s\S]*?SESSION_RESOLVE_ERROR/.test(routeCode), 'catch-all 500');
check('11 catch-all 500 status bound to the contract matrix (not a stray literal)',
  /'unexpected_error'[\s\S]*?SESSION_RESOLVE_MATRIX\[R\.SESSION_RESOLVE_ERROR\]\.status/.test(routeCode), 'status from matrix');
check('12 catch-all logs sanitized error CLASS + CODE only (no raw error / message / stack)',
  /'unexpected_error'[\s\S]*?errorClass:\s*safe\.name[\s\S]*?errorCode:\s*safe\.code/.test(routeCode)
  && !/'unexpected_error'[\s\S]*?\.stack\b/.test(routeCode),
  'class+code, no stack');

// =============================================================================
// 3) NO log/breadcrumb call in the route leaks a secret or sensitive field
//    (scan the argument text of every logging-style call in CODE)
// =============================================================================
const LOG_CALLEES = ['sessionResolveBreadcrumb', 'safeLog\\.(?:info|warn|error)', 'console\\.(?:log|info|warn|error)'];
const routeLogArgs = LOG_CALLEES.flatMap((c) => extractCallArgs(routeCode, c));
const FORBIDDEN_LOG: Array<[string, RegExp]> = [
  ['bearer', /bearer/i],
  ['access token', /access[_-]?token|accessToken/i],
  ['refresh token', /refresh[_-]?token|refreshToken/i],
  ['raw jwt', /\bjwt\b/i],
  ['request headers', /req\.headers|request\.headers|\.headers\b/i],
  ['request body', /req\.body|request\.body|\brawBody\b/i],
  ['request query', /req\.query/i],
  ['internalUserId', /internalUserId/i],
  ['authProviderUid', /authProviderUid/i],
  ['displayName', /displayName/i],
  ['email', /\bemail\b/i],
  ['tenantId', /tenantId/i],
  ['storeId', /storeId/i],
  ['raw authorization (dotted)', /\.authorization\b/],
  ['raw authorization DTO', /rawAuthorization|ServerDerivedAuthorizationV1|authorizationDto/i],
  ['cookie', /\bcookie/i],
  ['service-role / db url', /SERVICE_ROLE_KEY|serviceRoleKey|DATABASE_URL|connectionString/i],
];
let routeLogClean = true;
for (const [label, re] of FORBIDDEN_LOG) {
  const hit = routeLogArgs.find((a) => re.test(a));
  const pass = !hit;
  routeLogClean = routeLogClean && pass;
  check(`13 route log calls carry NO ${label}`, pass, pass ? 'clean' : `FOUND in: ${hit!.slice(0, 60)}…`);
}
check('14 route logging count is sane (entry + exits all instrumented)', routeLogArgs.length >= 8, `${routeLogArgs.length} log call args scanned`);

// =============================================================================
// 4) Route instrumentation made NO behavioral / live change
// =============================================================================
check('15 feature-disabled paths still return 404', (routeCode.match(/res\.status\(404\)/g) ?? []).length >= 2, '404 gates intact');
check('16 identity-resolution failure still maps to 503 (contract matrix unchanged here)',
  /IDENTITY_RESOLUTION_ERROR/.test(routeCode), 'identity 503 path intact');
check('17 success path still returns 200', /res\.status\(200\)\.json\(dto\)/.test(routeCode), '200 success intact');
check('18 route does NOT call any live shadow/harness/feed/bridge function',
  !/runServerAuthzShadowLiveOneShot|runServerAuthzShadowFeed|withSupabaseAccessToken|runSessionResolveShadowCheck|compareServerAuthzShadow/.test(routeCode),
  'no live shadow calls');
check('19 route makes NO outbound fetch (server handler, observability only)', !/\bfetch\s*\(/.test(routeCode), 'no fetch');
check('20 route does NOT newly ENABLE live authorization (no assignment to the flag)',
  !/ENABLE_LIVE_SESSION_AUTHORIZATION\s*=/.test(routeCode), 'no live-authz enable');
check('21 route adds NO UI / window / global / DOM event', !/\bwindow\b|globalThis|document\.|CustomEvent|dispatchEvent/.test(routeCode), 'server-only, no DOM');

// =============================================================================
// 5) Vite proxy instrumentation — present + safe
// =============================================================================
check('22 vite.config has an /__identity proxy configure hook', /'\/__identity':\s*\{[\s\S]*?configure:/.test(viteCode), 'configure present');
check('23 proxy logs upstream ERROR (proxy.on error)', /proxy\.on\(\s*'error'/.test(viteCode), 'error handler');
check('24 proxy logs upstream RESPONSE status (proxy.on proxyRes)', /proxy\.on\(\s*'proxyRes'/.test(viteCode), 'proxyRes handler');
check('25 proxy error log includes a transport error code', /\.code\b/.test(viteCode) && /ECONNREFUSED|ECONNRESET|ETIMEDOUT|NodeJS\.ErrnoException/.test(viteSrc), 'error code surfaced');
check('26 proxy response log includes the upstream status code', /proxyRes\.statusCode/.test(viteCode), 'status surfaced');

const viteLogArgs = extractCallArgs(viteCode, 'console\\.(?:log|info|warn|error)');
const FORBIDDEN_PROXY: Array<[string, RegExp]> = [
  ['headers', /headers/i],
  ['authorization', /authorization/i],
  ['bearer', /bearer/i],
  ['cookie', /cookie/i],
  ['body', /\bbody\b/i],
  ['token', /token/i],
  ['raw request url', /req\.url|\.url\b/i],
  ['query', /query/i],
];
let proxyLogClean = true;
for (const [label, re] of FORBIDDEN_PROXY) {
  const hit = viteLogArgs.find((a) => re.test(a));
  const pass = !hit;
  proxyLogClean = proxyLogClean && pass;
  check(`27 proxy log calls carry NO ${label}`, pass, pass ? 'clean' : `FOUND in: ${hit!.slice(0, 60)}…`);
}
check('28 proxy logs only the route FAMILY (/__identity/*), never the raw URL', /\/__identity\/\*/.test(viteSrc) && proxyLogClean, 'route family only');

// =============================================================================
// 6) M14 feed + M15 harness remain UN-instrumented (untouched by M16.2)
// =============================================================================
check('29 M14 feed contains NO M16.2 breadcrumb marker', !/sessionResolveBreadcrumb|session-resolve received|vite-proxy:identity-api/.test(feedSrc), 'feed clean');
check('30 M14 feed still has NO console.* logging', !/console\./.test(feedSrc), 'feed no console');
check('31 M14 feed still classifies 5xx as server_error', /'server_error'/.test(feedSrc) && /status\s*>=\s*500/.test(feedSrc), 'feed 5xx mapping intact');
check('32 M15 harness contains NO M16.2 breadcrumb marker', !/sessionResolveBreadcrumb|vite-proxy:identity-api/.test(harnessSrc), 'harness clean');
check('33 M15 harness still has NO console.* logging', !/console\./.test(harnessSrc), 'harness no console');

// =============================================================================
// 7) Self-inertness (read-only fs/path; no env/network/DB/child process)
// =============================================================================
const selfSrc = read(SELF);
const selfImports = [...selfSrc.matchAll(/^import[\s\S]*?from '([^']+)'/gm)].map((m) => m[1]);
const fsBindings = ((selfSrc.match(/import\s*\{([^}]*)\}\s*from\s*'fs'/) ?? ['', ''])[1]).split(',').map((s) => s.trim()).filter(Boolean);
const banned = ['child' + '_process', 'exec' + 'Sync', 'spawn' + '(', 'fetch' + '(', 'create' + 'Client', 'new ' + 'Pool', 'writeFile' + 'Sync'];
const selfBanned = banned.filter((t) => selfSrc.includes(t));
check('34a diagnostic imports confined to node fs/path', selfImports.length > 0 && selfImports.every((i) => i === 'fs' || i === 'path'), selfImports.join(', '));
check('34b diagnostic imports no app/server module (reads files as TEXT only)',
  !selfImports.some((i) => i.includes('/src/') || i.startsWith('src/') || i.includes('platform-identity') || i.includes('server/')), 'text-only');
check('34c diagnostic uses fs read-only (readFileSync only)', fsBindings.length > 0 && fsBindings.every((b) => b === 'readFileSync'), fsBindings.join(','));
check('34d diagnostic accesses no environment variables', !/process\.env/.test(selfSrc), 'no env');
check('34e diagnostic is side-effect-free (no child process / network / DB / file write)', selfBanned.length === 0, selfBanned.join(', ') || 'inert');

// =============================================================================
// Summary
// =============================================================================
const failed = results.filter((r) => !r.pass);
console.log(`\n[session-resolve-error-classification-static-check] ${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length) process.exitCode = 1;

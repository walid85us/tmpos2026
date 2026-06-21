// Phase 1.6 M17.1 — STATIC (offline) DORMANCY + OUTPUT-REDACTION-SAFETY check for the dormant
// SAFE LIVE-AUTHORIZATION OUTPUT REDACTION projection (`src/auth/serverAuthzLiveRedactedSummary.ts`).
//
// PURE / OFFLINE: no DB, no network, no Supabase, no Firebase, no env values, no SQL, no migration,
// no audit write, no Supabase MCP, no live/route call, no token, no child process. It reads the
// frontend (`src/**`) as TEXT only (read-only — NEVER modified) and PROVES the projection is:
// dormant (imported by nothing active, invoked by nothing), pure / synchronous / no-throw,
// DEV+flag-gated (default OFF), caller-input only (no live read / route / token / fetch / DB), and
// OUTPUT-SAFE (counts + booleans only; NO key-name arrays, NO raw authorization DTO, NO
// identity/tenant/store/role/plan, NO token/header/body).
//
// NOTE ON THE RUNTIME SELF-TEST (intentional, security-safe deviation from the text-only pattern):
// the TEST requirements for this milestone are behavioral ("the PROJECTED output contains no
// arrays", "does not mutate input", "is JSON-safe"). Honest evidence requires executing the real
// projection. The diagnostic's STATIC top-level imports remain confined to node `fs`/`path` (it
// still reads `src/**` as text); the projection is exercised ONLY via a single GUARDED, runtime
// `import()` of the pure subject-under-test — which this same diagnostic statically proves imports
// NO feed / harness / comparison / token-bridge / route / DB / network behavior. No LIVE app/server
// module is imported.
//
// Run:  npx tsx scripts/diagnostics-server-authz-live-redacted-summary-dormant-check.ts

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

interface Result { name: string; pass: boolean; detail: string }
const results: Result[] = [];
function check(name: string, pass: boolean, detail = ''): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}
function note(msg: string): void {
  console.log(`NOTE  ${msg}`);
}

function walk(relDir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(join(ROOT, relDir), { withFileTypes: true })) {
    const rel = `${relDir}/${e.name}`;
    if (e.isDirectory()) walk(rel, acc);
    else if (/\.(ts|tsx|js|jsx)$/.test(e.name)) acc.push(rel);
  }
  return acc;
}
const srcFiles = walk('src');
const text = new Map<string, string>(srcFiles.map((f) => [f, read(f)]));

const MODULE = 'src/auth/serverAuthzLiveRedactedSummary.ts';
const TYPES = 'src/auth/serverAuthzLiveRedactedSummaryTypes.ts';
const ENTRYPOINTS = [
  'src/main.tsx',
  'src/App.tsx',
  'src/components/Login.tsx',
  'src/context/AccessContext.tsx',
  'src/components/AccessGuard.tsx',
];
// Existing M11–M16 runtime modules that MUST NOT import the new dormant module (proves no wiring).
const EXISTING_M11_M16 = [
  'src/auth/serverAuthzShadowLiveHarness.ts',
  'src/auth/serverAuthzShadowFeed.ts',
  'src/auth/serverAuthzShadowComparison.ts',
  'src/auth/sessionResolveShadowClient.ts',
  'src/auth/supabaseTokenBridge.ts',
];

const moduleSrc = text.get(MODULE) ?? '';
const typesSrc = text.get(TYPES) ?? '';

// Comment-stripped CODE views — "must-not-appear-in-CODE" checks use these so documentation prose
// is never mistaken for behavior.
const stripComments = (s: string): string =>
  s.replace(/(^|[^:])\/\/.*$/gm, '$1').replace(/\/\*[\s\S]*?\*\//g, '');
const moduleCode = stripComments(moduleSrc);
const typesCode = stripComments(typesSrc);

/** Slice an `interface <name> { ... }` block (brace-balanced) from a source string. */
function interfaceBody(src: string, name: string): string {
  const re = new RegExp(`interface\\s+${name}\\s*\\{`);
  const m = re.exec(src);
  if (!m) return '';
  let i = m.index + m[0].length;
  let depth = 1;
  for (; i < src.length && depth > 0; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') depth -= 1;
  }
  return src.slice(m.index, i);
}

// =============================================================================
// 1) Files exist
// =============================================================================
check('1 redaction module exists', text.has(MODULE), text.has(MODULE) ? MODULE : 'absent');
check('2 redaction types module exists', text.has(TYPES), text.has(TYPES) ? TYPES : 'absent');

// =============================================================================
// 2) Import allowlist — own types ONLY; NO runtime import of live/feed/token behavior
// =============================================================================
const staticImports = [...moduleCode.matchAll(/import[\s\S]*?from '([^']+)'/g)].map((m) => m[1]);
const dynamicImports = [...moduleCode.matchAll(/import\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]);
const allImports = [...staticImports, ...dynamicImports];
check('3 module imports ONLY its own types (import type, erased)', allImports.length === 1 && allImports[0] === './serverAuthzLiveRedactedSummaryTypes', allImports.join(', ') || 'none');
check('4 module type import is type-only (import type ... from ./...Types)', /import\s+type\s*\{[\s\S]*?\}\s*from '\.\/serverAuthzLiveRedactedSummaryTypes'/.test(moduleCode), 'import type');
check('5 module does NOT import the M14 feed', !allImports.some((i) => /serverAuthzShadowFeed/.test(i)), 'no M14 feed');
check('6 module does NOT import the M15 harness', !allImports.some((i) => /serverAuthzShadowLiveHarness/.test(i)), 'no M15 harness');
check('7 module does NOT import the M13 comparison', !allImports.some((i) => /serverAuthzShadowComparison/.test(i)), 'no M13 comparison');
check('8 module does NOT import the M12 shadow client', !allImports.some((i) => /sessionResolveShadowClient/.test(i)), 'no M12 client');
check('9 module does NOT import the M11 token bridge', !allImports.some((i) => /supabaseTokenBridge/.test(i)), 'no M11 bridge');
check('10 module does NOT import the M5/M6/M7 foundation/bootstrap/awareness', !allImports.some((i) => /supabaseAuthFoundation|supabaseSessionBootstrap|supabaseAccessAwareness/.test(i)), 'no M5/M6/M7');
check('11 module does NOT import @supabase/supabase-js', !allImports.some((i) => i === '@supabase/supabase-js'), 'no SDK');
check('12 module does NOT import React/Firebase', !allImports.some((i) => i === 'react' || i === 'react-dom' || /^@?firebase(\/|$)/.test(i)), 'no react/firebase');
check('13 module does NOT import AccessContext/Login/AccessGuard/App/main', !allImports.some((i) => /context\/AccessContext|components\/Login|AccessGuard|(^|\/)App'?$|(^|\/)main(\.tsx)?'?$/.test(i)), 'no entrypoints');
check('14 module does NOT import server/backend modules', !allImports.some((i) => /(^|\/)server(\/|$)|platform-identity/.test(i)), 'no server');
check('15 module does NOT import the pilot', !allImports.some((i) => /pilot\//.test(i)), 'no pilot');

// =============================================================================
// 3) Pure / synchronous / no-throw / no import-time execution
// =============================================================================
check('16 module is synchronous (no async functions)', !/\basync\b/.test(moduleCode), 'no async');
check('17 module has no await anywhere (no top-level await; no async body)', !/\bawait\b/.test(moduleCode), 'no await');
check('18 module is no-throw (no `throw` statement)', !/\bthrow\b/.test(moduleCode), 'no throw');
check('19 module exports the pure projection projectServerAuthzLiveRedactedSummary', /export\s+function\s+projectServerAuthzLiveRedactedSummary\b/.test(moduleCode), 'pure projection exported');
check('20 module exports the enablement helper isServerAuthzLiveRedactedSummaryEnabled', /export\s+function\s+isServerAuthzLiveRedactedSummaryEnabled\b/.test(moduleCode), 'enablement helper');
check('21 no import-time side-effecting call binding (no top-level fetch/feed/harness/compare/import())',
  !/^(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*(?:await\s+)?(?:fetch|runServerAuthzShadowFeed|runServerAuthzShadowLiveOneShot|compareServerAuthzShadow|withSupabaseAccessToken|import)\s*\(/m.test(moduleCode),
  'no import-time call');

// =============================================================================
// 4) No live read / route / token / network / DB / browser-state / console (forbidden strings)
// =============================================================================
const FORBIDDEN_IN_MODULE: Array<[string, RegExp]> = [
  ['fetch(', /\bfetch\s*\(/],
  ['XHR/sendBeacon', /XMLHttpRequest|sendBeacon/],
  ['/auth/session/resolve route', /\/auth\/session\/resolve/],
  ['/__identity route', /\/__identity/],
  ['runServerAuthzShadowFeed', /runServerAuthzShadowFeed/],
  ['runServerAuthzShadowLiveOneShot', /runServerAuthzShadowLiveOneShot/],
  ['withSupabaseAccessToken', /withSupabaseAccessToken/],
  ['compareServerAuthzShadow', /compareServerAuthzShadow/],
  ['createClient', /createClient/],
  ['localStorage', /localStorage/],
  ['sessionStorage', /sessionStorage/],
  ['window.', /\bwindow\./],
  ['document.', /\bdocument\./],
  ['addEventListener', /addEventListener/],
  ['console.log', /console\.log/],
  ['console.error', /console\.error/],
  ['console.* (any)', /console\./],
  ['access/refresh token id', /access_token|refresh_token|accessToken|refreshToken|\bBearer\b/],
  ['privileged secret', /SUPABASE_SERVICE_ROLE_KEY|SERVICE_ROLE_KEY|serviceRoleKey|service_role|SUPABASE_DATABASE_URL|\bDATABASE_URL\b|connectionString|postgres(ql)?:\/\//],
];
// Scanned over the comment-stripped CODE view (per this file's header) so the module's own
// documentation prose ("never fetches / XHRs / sendBeacons", etc.) is not mistaken for behavior.
for (const [label, re] of FORBIDDEN_IN_MODULE) {
  check(`22 module contains NO ${label}`, !re.test(moduleCode), re.test(moduleCode) ? 'FOUND' : 'absent');
}

// =============================================================================
// 5) DEV-flag-gated enablement helper, default OFF; flag hygiene
// =============================================================================
check('23 enablement uses VITE_ENABLE_SERVER_AUTHZ_LIVE_REDACTED_SUMMARY', /VITE_ENABLE_SERVER_AUTHZ_LIVE_REDACTED_SUMMARY/.test(moduleCode), 'own flag');
check('24 enablement is DEV-gated (reads import.meta DEV)', /\.DEV\b/.test(moduleCode), 'DEV gate');
check('25 enablement is AND of DEV and flag === "true" (default OFF)', /DEV === true/.test(moduleCode) && /=== 'true'/.test(moduleCode), 'dev && flag');
check('26 module introduces NO other new VITE_ flag', (() => {
  const names = [...new Set([...moduleSrc.matchAll(/VITE_[A-Z0-9_]+/g)].map((m) => m[0]))];
  return names.length === 1 && names[0] === 'VITE_ENABLE_SERVER_AUTHZ_LIVE_REDACTED_SUMMARY';
})(), 'single flag');
check('27 module does NOT reference upstream M11–M15 flags', !/VITE_ENABLE_SUPABASE_TOKEN_BRIDGE|VITE_ENABLE_SESSION_RESOLVE_SHADOW|VITE_ENABLE_SERVER_AUTHZ_SHADOW\b|VITE_ENABLE_SERVER_AUTHZ_SHADOW_FEED|VITE_ENABLE_SERVER_AUTHZ_LIVE_ONE_SHOT|VITE_CONFIRM_SERVER_AUTHZ_LIVE_ONE_SHOT/.test(moduleSrc), 'no upstream flags');

// =============================================================================
// 6) OUTPUT TYPE SAFETY — counts + booleans only (no arrays/raw/identity/tenant/store/role/plan)
// =============================================================================
const outBody = interfaceBody(typesCode, 'ServerAuthzLiveRedactedSummary');
const ksBody = interfaceBody(typesCode, 'RedactedKeySpaceSummary');
check('28 output interface ServerAuthzLiveRedactedSummary is declared', outBody.length > 0, outBody ? 'found' : 'absent');
check('29 output key-space interface RedactedKeySpaceSummary is declared', ksBody.length > 0, ksBody ? 'found' : 'absent');
const outputTypeText = `${outBody}\n${ksBody}`;
const OUTPUT_TYPE_FORBIDDEN: Array<[string, RegExp]> = [
  ['array field ([])', /\[\s*\]/],
  ['missingFromServerKeys', /missingFromServerKeys/],
  ['unknownToFrontendKeys', /unknownToFrontendKeys/],
  ['raw authorization DTO field', /\bauthorization\b|ServerDerivedAuthorizationV1|rawAuthorization|derivedBy/i],
  ['identity field', /internalUserId|authProviderUid|authProvider|displayName|\bemail\b|\bidentity\b/i],
  ['tenant/store id', /tenantId|storeId/],
  ['role field', /platformRoleId|tenantRoleId|\brole\b/i],
  ['plan field', /\bplan\b/i],
  ['permission-LEVEL field', /PermissionLevel|\blevel\b/i],
  ['token/header/body field', /\btoken\b|\bheader\b|\bcookie\b|\bbody\b/i],
];
for (const [label, re] of OUTPUT_TYPE_FORBIDDEN) {
  check(`30 output types define NO ${label}`, !re.test(outputTypeText), re.test(outputTypeText) ? 'FOUND' : 'none');
}
check('31 output key-space summary defines safe count fields only', /frontendCount/.test(ksBody) && /serverCount/.test(ksBody) && /matchedCount/.test(ksBody) && /missingCount/.test(ksBody) && /unknownCount/.test(ksBody) && /isExactMatch/.test(ksBody), 'counts + isExactMatch');
check('32 output summary defines safe structural fields (summaryPhase/ok/status/serverAuthzPresent/parity/message)',
  /summaryPhase/.test(outBody) && /\bok\b/.test(outBody) && /\bstatus\b/.test(outBody) && /serverAuthzPresent/.test(outBody) && /permissionParity/.test(outBody) && /\bmessage\b/.test(outBody), 'safe fields');

// =============================================================================
// 7) Module DROPS the mismatch arrays (reads only `.length`; never emits the names)
// =============================================================================
check('33 module references missing/unknown arrays ONLY as reads, never as emitted keys',
  !/missingFromServerKeys\s*:/.test(moduleCode) && !/unknownToFrontendKeys\s*:/.test(moduleCode), 'no emitted key');
check('34 module converts the dropped arrays to counts via a length read',
  /\.missingFromServerKeys/.test(moduleCode) && /\.unknownToFrontendKeys/.test(moduleCode) && /\blengthOf\s*\(/.test(moduleCode), 'length-only');
check('35 module reads NO identity/tenant/store/role/plan/level/scope value',
  !/internalUserId|authProviderUid|authProvider|displayName|\bemail\b|tenantId|storeId|platformRoleId|tenantRoleId|\.roles\b|\.scope\b|userType|\.identity\b|PermissionLevel|getPermissionLevel/.test(moduleCode), 'no sensitive reads');

// =============================================================================
// 8) Dormancy — imported by NOTHING in src/**; no active call site
// =============================================================================
const refsModule = (s: string) => /(?:from|import)\s*\(?\s*'[^']*\/serverAuthzLiveRedactedSummary'/.test(s);
const importers = srcFiles.filter((f) => f !== MODULE && f !== TYPES && refsModule(text.get(f)!));
check('36 module imported by NO active app entrypoint (Login/AccessContext/AccessGuard/App/main)', importers.filter((f) => ENTRYPOINTS.includes(f)).length === 0, importers.filter((f) => ENTRYPOINTS.includes(f)).join(', ') || 'dormant');
check('37 module NOT imported by the pilot', importers.filter((f) => f.startsWith('src/pilot/')).length === 0, importers.filter((f) => f.startsWith('src/pilot/')).join(', ') || 'pilot clean');
check('38 module imported NOWHERE in src/** (invoked by nothing in M17.1)', importers.length === 0, importers.join(', ') || 'no importers');
const externalCallers = srcFiles
  .filter((f) => f !== MODULE && f !== TYPES)
  .filter((f) => /projectServerAuthzLiveRedactedSummary\s*\(|isServerAuthzLiveRedactedSummaryEnabled\s*\(/.test(stripComments(text.get(f)!)));
check('39 module has NO active call site anywhere in src/**', externalCallers.length === 0, externalCallers.join(', ') || 'no callers');
const projectSelfCalls = (moduleCode.match(/projectServerAuthzLiveRedactedSummary\s*\(/g) ?? []).length;
check('40 projection is declared once and never self-invoked at module scope', /function\s+projectServerAuthzLiveRedactedSummary\s*\(/.test(moduleCode) && projectSelfCalls === 1, `self-occurrences=${projectSelfCalls}`);
check('41 existing M11–M16 modules do NOT import the new module (no wiring)', EXISTING_M11_M16.every((f) => !refsModule(text.get(f) ?? '')), 'M11–M16 clean');
check('42 no src/auth/index.ts barrel exists', !srcFiles.includes('src/auth/index.ts'), 'no barrel');

// =============================================================================
// 9) Bundle absence (dist/**) — proves it is NOT in the production bundle unless explicitly imported
// =============================================================================
const DIST = 'dist';
if (existsSync(join(ROOT, DIST))) {
  const distFiles: string[] = [];
  (function walkDist(rel: string): void {
    for (const e of readdirSync(join(ROOT, rel), { withFileTypes: true })) {
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) walkDist(r);
      else if (/\.(js|mjs|cjs|css|html|json)$/.test(e.name)) distFiles.push(r);
    }
  })(DIST);
  const re = /serverAuthzLiveRedactedSummary|projectServerAuthzLiveRedactedSummary|VITE_ENABLE_SERVER_AUTHZ_LIVE_REDACTED_SUMMARY/;
  const hits = distFiles.filter((f) => re.test(readFileSync(join(ROOT, f), 'utf8')));
  check('43 M17.1 identifiers + flag absent from emitted bundle (tree-shaken / dormant)', hits.length === 0, hits.length === 0 ? `scanned ${distFiles.length} artifact(s); absent` : `present in: ${hits.join(', ')}`);
} else {
  note('No dist/** present — M17.1 bundle-absence check DEFERRED (run an offline `npm run build` first).');
}

// =============================================================================
// 10) Self-inertness (static imports confined to node fs/path; read-only; no env)
// =============================================================================
const SELF = 'scripts/diagnostics-server-authz-live-redacted-summary-dormant-check.ts';
const selfSrc = read(SELF);
const selfStaticImports = [...selfSrc.matchAll(/^import[\s\S]*?from '([^']+)'/gm)].map((m) => m[1]);
check('44a diagnostic STATIC imports confined to node fs/path', selfStaticImports.length > 0 && selfStaticImports.every((i) => i === 'fs' || i === 'path'), selfStaticImports.join(', '));
check('44b diagnostic static-imports no frontend/server module (reads src/ as TEXT only)', !selfStaticImports.some((i) => i.includes('/src/') || i.startsWith('src/') || i.includes('platform-identity')), 'text-only statics');
check('44c diagnostic accesses no environment variables', !/process\.env/.test(selfSrc), 'no env');
// Self-inertness is proven STRUCTURALLY rather than by substring (this diagnostic legitimately
// contains forbidden-pattern strings like "createClient" as scan targets): with static imports
// confined to fs/path (44a) there is no way to reach child_process/pg/@supabase, and the ONLY
// runtime `import()` must target the pure subject-under-test.
const selfDynImports = [...selfSrc.matchAll(/(?<!\\)\bimport\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]);
check('44d diagnostic performs exactly ONE dynamic import, targeting only the pure subject module',
  selfDynImports.length === 1 && selfDynImports[0] === '../src/auth/serverAuthzLiveRedactedSummary',
  selfDynImports.join(', ') || 'none');

// =============================================================================
// 11) RUNTIME SELF-TESTS — execute the REAL pure projection on SYNTHETIC input (guarded import)
//     Synthetic placeholder key NAMES are generic/fake and are NEVER printed.
// =============================================================================

/** Deep-collect: any Array present anywhere, and the set of object keys used anywhere. */
function deepScan(value: unknown, arrays: string[], keys: Set<string>, path = '$'): void {
  if (Array.isArray(value)) { arrays.push(path); return; }
  if (value && typeof value === 'object') {
    for (const k of Object.keys(value as Record<string, unknown>)) {
      keys.add(k);
      deepScan((value as Record<string, unknown>)[k], arrays, keys, `${path}.${k}`);
    }
  }
}

async function runtimeSelfTests(): Promise<void> {
  let mod: { projectServerAuthzLiveRedactedSummary?: unknown };
  try {
    mod = (await import('../src/auth/serverAuthzLiveRedactedSummary')) as {
      projectServerAuthzLiveRedactedSummary?: unknown;
    };
  } catch (e) {
    check('45 redaction module dynamically importable for runtime self-test', false, String((e as Error)?.message ?? e));
    return;
  }
  const projectUnknown = mod.projectServerAuthzLiveRedactedSummary;
  check('45 redaction module dynamically importable for runtime self-test', typeof projectUnknown === 'function', typeof projectUnknown);
  if (typeof projectUnknown !== 'function') return;
  const project = projectUnknown as (input: unknown) => Record<string, unknown>;

  // --- Synthetic NON-NULL comparison input with placeholder key-name arrays (never printed) ---
  const synthetic = {
    ok: true,
    status: 200,
    phase: 'compared',
    serverAuthzPresent: true,
    message: 'SHOULD_NOT_BE_ECHOED',
    comparison: {
      phase: 'compared',
      serverAuthzPresent: true,
      overallParity: false,
      permissionKeyParity: false,
      subPermissionKeyParity: true,
      entitlementKeyParity: true,
      permissionKeySpace: {
        parity: false,
        frontendKeyCount: 5,
        serverKeyCount: 3,
        matchedKeyCount: 2,
        missingFromServerKeys: ['placeholder_perm_a', 'placeholder_perm_b', 'placeholder_perm_c'],
        unknownToFrontendKeys: ['placeholder_unknown_x'],
      },
      subPermissionKeySpace: {
        parity: true,
        frontendKeyCount: 4,
        serverKeyCount: 4,
        matchedKeyCount: 4,
        missingFromServerKeys: [],
        unknownToFrontendKeys: [],
      },
      entitlementKeySpace: {
        parity: true,
        frontendKeyCount: 2,
        serverKeyCount: 2,
        matchedKeyCount: 2,
        missingFromServerKeys: [],
        unknownToFrontendKeys: [],
      },
    },
  };
  const before = JSON.stringify(synthetic);
  const out = project(synthetic);
  const after = JSON.stringify(synthetic);

  const arrays: string[] = [];
  const keys = new Set<string>();
  deepScan(out, arrays, keys);

  check('46 non-null projection output contains NO arrays anywhere', arrays.length === 0, arrays.length === 0 ? 'array-free' : `arrays at: ${arrays.join(', ')}`);
  check('47 output contains NO key named missingFromServerKeys', !keys.has('missingFromServerKeys'), 'absent');
  check('48 output contains NO key named unknownToFrontendKeys', !keys.has('unknownToFrontendKeys'), 'absent');
  check('49 output contains NO raw authorization / comparison / DTO key', !keys.has('authorization') && !keys.has('comparison') && !keys.has('permissions') && !keys.has('subPermissions') && !keys.has('entitlements'), 'no raw objects');
  check('50 output does NOT echo the input message', out.message !== 'SHOULD_NOT_BE_ECHOED' && typeof out.message === 'string' && out.message.length > 0, 'fixed message');
  check('51 output summaryPhase is "summarized" for non-null authz', out.summaryPhase === 'summarized', String(out.summaryPhase));

  // Counts preserved (read counts WITHOUT printing key names).
  const perm = out.permission as Record<string, unknown> | null;
  const countsOk = !!perm && perm.frontendCount === 5 && perm.serverCount === 3 && perm.matchedCount === 2 && perm.missingCount === 3 && perm.unknownCount === 1 && perm.hasComparison === true && perm.isExactMatch === false;
  check('52 safe counts preserved (frontend/server/matched/missing/unknown) and isExactMatch derived', countsOk, countsOk ? 'counts ok' : `perm=${JSON.stringify(perm)}`);

  // Parity booleans preserved.
  const parityOk = out.permissionParity === false && out.subPermissionParity === true && out.entitlementParity === true && out.overallParity === false;
  check('53 parity booleans preserved', parityOk, parityOk ? 'parity ok' : `perm=${out.permissionParity} sub=${out.subPermissionParity} ent=${out.entitlementParity} overall=${out.overallParity}`);

  // JSON-safe.
  let jsonSafe = true;
  try { JSON.parse(JSON.stringify(out)); } catch { jsonSafe = false; }
  check('54 output is JSON-safe (round-trips)', jsonSafe, jsonSafe ? 'json-safe' : 'NOT json-safe');

  // Does not mutate input.
  check('55 projection does NOT mutate input', before === after, before === after ? 'input unchanged' : 'INPUT MUTATED');

  // --- Null input fails closed to a safe empty summary ---
  const nullOut = project(null);
  const nullArrays: string[] = [];
  const nullKeys = new Set<string>();
  deepScan(nullOut, nullArrays, nullKeys);
  check('56 null input fails closed to summaryPhase "malformed"', nullOut.summaryPhase === 'malformed', String(nullOut.summaryPhase));
  check('57 malformed output is array-free and carries no key-space detail', nullArrays.length === 0 && nullOut.permission === null && nullOut.serverAuthzPresent === false, 'safe empty');

  // --- Null-authz (200, serverAuthzPresent=false) preserves only safe status/phase ---
  const unavailOut = project({ ok: true, status: 200, phase: 'server_authz_unavailable', serverAuthzPresent: false, comparison: null });
  const unavailArrays: string[] = [];
  const unavailKeys = new Set<string>();
  deepScan(unavailOut, unavailArrays, unavailKeys);
  check('58 null-authz input summarized as "unavailable" with no key-space detail', unavailOut.summaryPhase === 'unavailable' && unavailOut.permission === null && unavailArrays.length === 0, `phase=${unavailOut.summaryPhase}`);
  check('59 unavailable output preserves safe transport status + phase', unavailOut.status === 200 && unavailOut.phase === 'server_authz_unavailable', `status=${unavailOut.status} phase=${unavailOut.phase}`);

  // --- Arbitrary/unknown phase string is NOT echoed (allow-list only) ---
  const arbitraryOut = project({ ok: false, status: 0, phase: 'totally-made-up-phase', serverAuthzPresent: false });
  check('60 unknown phase strings are NOT echoed (allow-listed to null)', arbitraryOut.phase === null, String(arbitraryOut.phase));
}

// =============================================================================
// Summary (after async runtime self-tests)
// =============================================================================
async function main(): Promise<void> {
  await runtimeSelfTests();
  const failed = results.filter((r) => !r.pass);
  console.log(`\n[server-authz-live-redacted-summary-dormant-check] ${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) process.exitCode = 1;
}

void main();

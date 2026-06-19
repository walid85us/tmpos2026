// Phase 1.6 M13 — STATIC (offline) DORMANCY + STRUCTURAL-COMPARISON-SAFETY check for the
// dormant SERVER-AUTHZ SHADOW COMPARISON helper (`src/auth/serverAuthzShadowComparison.ts`).
//
// PURE / OFFLINE: no DB, no network, no Supabase, no Firebase, no env values, no SQL, no
// migration, no audit write, no Supabase MCP, no live/route call, no child process. It reads
// the frontend (`src/**`) as TEXT only (read-only — NEVER imported, NEVER modified) and PROVES
// the comparison helper is: dormant (imported by nothing active, invoked by nothing), pure /
// synchronous / no-throw, DEV+flag-gated (default OFF), SYNTHETIC-input only (no live read, no
// route, no token, no fetch), confined to the FRONTEND permission vocabulary (+ its own types),
// STRUCTURAL (key-space) only (no level/role/tenant/store/plan/identity/allow-deny comparison,
// no AccessContext function calls), and RESULT-SAFE (no token / identity / raw DTO).
//
// NOTE: this diagnostic scopes every assertion to the comparison helper + its import/call
// graph. It does NOT add broad bans that would false-positive on existing contract/pilot code.
//
// Run:  npx tsx scripts/diagnostics-server-authz-shadow-comparison-dormant-check.ts

import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

interface Result { name: string; pass: boolean; detail: string }
const results: Result[] = [];
function check(name: string, pass: boolean, detail = ''): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
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

const HELPER = 'src/auth/serverAuthzShadowComparison.ts';
const HELPER_TYPES = 'src/auth/serverAuthzShadowComparisonTypes.ts';
const ENTRYPOINTS = [
  'src/main.tsx',
  'src/App.tsx',
  'src/components/Login.tsx',
  'src/context/AccessContext.tsx',
  'src/components/AccessGuard.tsx',
];

const helper = text.get(HELPER) ?? '';
const types = text.get(HELPER_TYPES) ?? '';

// Comment-stripped CODE views (line comments FIRST). "Must-not-appear-in-CODE" checks use these
// so documentation is never mistaken for behavior. A string-stripped view is ALSO used for
// identifier scans that could otherwise collide with PHASE_MESSAGE prose (e.g. "not deny").
const stripComments = (s: string): string =>
  s.replace(/(^|[^:])\/\/.*$/gm, '$1').replace(/\/\*[\s\S]*?\*\//g, '');
const stripStrings = (s: string): string =>
  s
    .replace(/`(?:\\.|[^`\\])*`/g, '``')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""');
const helperCode = stripComments(helper);
const helperCodeNoStr = stripStrings(helperCode);
const typesCode = stripComments(types);

// =============================================================================
// 1) Files exist
// =============================================================================
check('1 comparison helper module exists', text.has(HELPER), text.has(HELPER) ? HELPER : 'absent');
check('2 comparison helper types module exists', text.has(HELPER_TYPES), text.has(HELPER_TYPES) ? HELPER_TYPES : 'absent');

// =============================================================================
// 2) Import allowlist — frontend permission vocabulary + own types ONLY
// =============================================================================
const staticImports = [...helperCode.matchAll(/import[\s\S]*?from '([^']+)'/g)].map((m) => m[1]);
const dynamicImports = [...helperCode.matchAll(/import\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]);
const allImports = [...staticImports, ...dynamicImports];
const ALLOWED = [
  '../context/accessConfig',
  '../owner/platformPermissionsConfig',
  './serverAuthzShadowComparisonTypes',
];
const disallowed = allImports.filter((i) => !ALLOWED.includes(i));
check('3 helper imports the frontend permission vocabulary (accessConfig + platformPermissionsConfig)',
  allImports.includes('../context/accessConfig') && allImports.includes('../owner/platformPermissionsConfig'),
  'frontend vocabulary imported');
check('4 helper imports its own types', allImports.includes('./serverAuthzShadowComparisonTypes'), 'own types');
check('5 helper imports confined to the frontend vocabulary + its own types', allImports.length > 0 && disallowed.length === 0, disallowed.join(', ') || allImports.join(' + '));
check('6 helper does NOT import AccessContext', !allImports.some((i) => /context\/AccessContext/.test(i)), 'no AccessContext');
check('7 helper does NOT import Login', !allImports.some((i) => /components\/Login/.test(i)), 'no Login');
check('8 helper does NOT import AccessGuard', !allImports.some((i) => /AccessGuard/.test(i)), 'no AccessGuard');
check('9 helper does NOT import App routing', !allImports.some((i) => /(^|\/)App'?$/.test(i)), 'no App');
check('10 helper does NOT import src/main', !allImports.some((i) => /(^|\/)main(\.tsx)?'?$/.test(i)), 'no main');
check('11 helper does NOT import pilot modules', !allImports.some((i) => /pilot\//.test(i)), 'no pilot');
check('12 helper does NOT import server/backend modules', !allImports.some((i) => /(^|\/)server(\/|$)|platform-identity/.test(i)), 'no server');
check('13 helper does NOT import the server permission catalog / authorization contract', !allImports.some((i) => /permissionCatalog|authorizationContract|authorizationConstants|authorizationResolver/.test(i)), 'no server catalog');
check('14 helper does NOT import @supabase/supabase-js', !allImports.some((i) => i === '@supabase/supabase-js'), 'no SDK');
check('15 helper does NOT import React', !allImports.some((i) => i === 'react' || i === 'react-dom'), 'no react');
check('16 helper does NOT import Firebase', !allImports.some((i) => /^@?firebase(\/|$)/.test(i)), 'no firebase');
check('17 helper does NOT import the M12 session-resolve shadow client', !allImports.some((i) => /sessionResolveShadowClient/.test(i)), 'no M12 client');
check('18 helper does NOT import the M11 token bridge', !allImports.some((i) => /supabaseTokenBridge/.test(i)), 'no M11 bridge');
check('19 helper does NOT import the M5 foundation / M6 bootstrap / M7 awareness', !allImports.some((i) => /supabaseAuthFoundation|supabaseSessionBootstrap|supabaseAccessAwareness/.test(i)), 'no M5/M6/M7');

// =============================================================================
// 3) Pure / synchronous / no-throw / no import-time execution / no top-level await
// =============================================================================
check('20 helper is synchronous (no async functions)', !/\basync\b/.test(helperCode), 'no async');
check('21 helper has no await anywhere (no top-level await; no async body)', !/\bawait\b/.test(helperCode), 'no await');
check('22 no import-time side-effecting execution (no top-level fetch/route/compare call binding)',
  !/^(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*(?:await\s+)?(?:fetch|compareServerAuthzShadow|runSessionResolveShadowCheck|withSupabaseAccessToken)\s*\(/m.test(helperCode),
  'no import-time call');
check('23 helper is no-throw (no `throw` statement)', !/\bthrow\b/.test(helperCode), 'no throw');
check('24 helper exports the pure comparison function compareServerAuthzShadow', /export\s+function\s+compareServerAuthzShadow\b/.test(helperCode), 'pure exported helper');
check('25 helper exports the optional enablement helper isServerAuthzShadowEnabled', /export\s+function\s+isServerAuthzShadowEnabled\b/.test(helperCode), 'enablement helper');

// =============================================================================
// 4) Synthetic-input only — no live read, no route, no token, no network
// =============================================================================
check('26 helper does NOT fetch', !/\bfetch\s*\(/.test(helperCode), 'no fetch');
check('27 helper does NOT use XHR / sendBeacon', !/XMLHttpRequest|sendBeacon/.test(helperCode), 'no XHR/beacon');
check('28 helper does NOT call /auth/session/resolve', !/\/auth\/session\/resolve/.test(helper), 'no route');
check('29 helper does NOT call the M12 shadow client (runSessionResolveShadowCheck)', !/runSessionResolveShadowCheck\s*\(/.test(helperCode), 'no M12 invocation');
check('30 helper does NOT call the pilot runSessionResolve()', !/\brunSessionResolve\s*\(/.test(helperCode), 'no pilot route');
check('31 helper does NOT use the M11 token bridge (withSupabaseAccessToken)', !/withSupabaseAccessToken\s*\(/.test(helperCode), 'no token bridge');
check('32 helper uses NO access/refresh token identifiers', !/access_token|refresh_token|accessToken|refreshToken|\bBearer\b/.test(helperCodeNoStr), 'token-free');
check('33 helper reads SYNTHETIC caller input (compareServerAuthzShadow takes a DTO|null arg)', /compareServerAuthzShadow\s*\(\s*\n?\s*input\s*:\s*ServerDerivedAuthorizationLike\s*\|\s*null\s*\)/.test(helperCode) || /input\s*:\s*ServerDerivedAuthorizationLike\s*\|\s*null/.test(helperCode), 'synthetic input arg');

// =============================================================================
// 5) DEV-flag-gated, default OFF; flag hygiene
// =============================================================================
check('34 helper uses VITE_ENABLE_SERVER_AUTHZ_SHADOW', /VITE_ENABLE_SERVER_AUTHZ_SHADOW/.test(helperCode), 'own flag');
check('35 helper is DEV-gated (reads import.meta DEV)', /\.DEV\b/.test(helperCode), 'DEV gate');
check('36 enablement is AND of DEV and flag === "true" (default OFF)', /DEV === true/.test(helperCode) && /=== 'true'/.test(helperCode), 'dev && flag');
check('37 helper does NOT reference VITE_ENABLE_SESSION_RESOLVE_SHADOW (M12 flag)', !/VITE_ENABLE_SESSION_RESOLVE_SHADOW/.test(helper), 'no M12 flag');
check('38 helper does NOT reference VITE_ENABLE_SUPABASE_TOKEN_BRIDGE (M11 flag)', !/VITE_ENABLE_SUPABASE_TOKEN_BRIDGE/.test(helper), 'no M11 flag');
check('39 helper does NOT reference VITE_ENABLE_SESSION_RESOLVE_ROUTE_HELPER', !/VITE_ENABLE_SESSION_RESOLVE_ROUTE_HELPER/.test(helper), 'no route-helper flag');
check('40 helper introduces NO other new VITE_ flag (only VITE_ENABLE_SERVER_AUTHZ_SHADOW + read VITE_ names)', (() => {
  const names = [...new Set([...helper.matchAll(/VITE_[A-Z0-9_]+/g)].map((m) => m[0]))];
  // The comparison helper does NO network/config read: it should reference ONLY its own flag.
  return names.length === 1 && names[0] === 'VITE_ENABLE_SERVER_AUTHZ_SHADOW';
})(), 'single flag');

// =============================================================================
// 6) Frontend permission vocabulary only (no server catalog); key-space comparison
// =============================================================================
check('41 helper derives frontend vocabulary from accessConfig (PERMISSION_DOMAINS/SUB_PERMISSIONS/planFeatures)',
  /PERMISSION_DOMAINS/.test(helperCode) && /SUB_PERMISSIONS/.test(helperCode) && /planFeatures/.test(helperCode), 'tenant vocabulary');
check('42 helper derives frontend vocabulary from platformPermissionsConfig (PLATFORM_FEATURE_GROUPS)',
  /PLATFORM_FEATURE_GROUPS/.test(helperCode), 'platform vocabulary');
check('43 helper builds three frozen key-sets (permission/subPermission/entitlement)',
  /FRONTEND_PERMISSION_KEYS/.test(helperCode) && /FRONTEND_SUBPERMISSION_KEYS/.test(helperCode) && /FRONTEND_ENTITLEMENT_KEYS/.test(helperCode), 'frozen key-sets');
check('44 helper imports NO server permission catalog identifier', !/\bPERMISSION_CATALOG\b|permissionCatalog|ServerDerivedAuthorizationV1|AUTHORIZATION_CONTRACT_VERSION/.test(helperCode), 'no server catalog');
check('45 helper compares permissions key-space', /permissionKeySpace/.test(helperCode), 'permissions');
check('46 helper compares subPermissions key-space', /subPermissionKeySpace/.test(helperCode), 'subPermissions');
check('47 helper compares entitlements key-space', /entitlementKeySpace/.test(helperCode), 'entitlements');
check('48 helper reads ONLY object KEYS (Object.keys), never values', /Object\.keys\s*\(/.test(helperCode), 'keys-only');

// =============================================================================
// 7) Entitlement alias normalization: supply_chain -> supply-chain
// =============================================================================
check('49 helper normalizes the entitlement alias supply_chain -> supply-chain',
  /normalizeEntitlementKey/.test(helperCode) && /'supply_chain'/.test(helper) && /'supply-chain'/.test(helper), 'alias normalized');

// =============================================================================
// 8) STRICT comparison boundary — no value/level/role/tenant/store/plan/identity/allow-deny
// =============================================================================
// The helper reads ONLY these three properties off the synthetic input.
const inputProps = [...new Set([...helperCodeNoStr.matchAll(/\binput\.(\w+)/g)].map((m) => m[1]))];
const ALLOWED_INPUT_PROPS = ['permissions', 'subPermissions', 'entitlements'];
const unexpectedInputProps = inputProps.filter((p) => !ALLOWED_INPUT_PROPS.includes(p));
check('50 helper reads ONLY input.permissions/subPermissions/entitlements (no scope/roles/status/userType)', unexpectedInputProps.length === 0, unexpectedInputProps.join(', ') || `[${inputProps.join(', ')}]`);
check('51 helper does NOT compare permission-LEVEL values (no level helpers/hierarchy)',
  !/meetsPermissionLevel|getPermissionLevel|platformPermissionMeets|PERMISSION_HIERARCHY|LEVEL_RANK|PermissionLevel/.test(helperCode), 'no level comparison');
check('52 helper does NOT read behavioral allow/deny (no .decision/.allowed/allow|deny literals)',
  !/\.decision\b|\.allowed\b|===\s*'allow'|===\s*'deny'|explainAccessDecision/.test(helperCodeNoStr), 'no allow/deny');
check('53 helper does NOT compare role values (no platformRoleId/tenantRoleId/.roles)',
  !/platformRoleId|tenantRoleId|\.roles\b/.test(helperCodeNoStr), 'no roles');
check('54 helper does NOT compare tenant/store ids (no tenantId/storeId/.scope)',
  !/tenantId|storeId|\.scope\b/.test(helperCodeNoStr), 'no tenant/store');
check('55 helper does NOT compare plan values (no plan read off input/scope)',
  !/\binput\.plan\b|\.status\b|userType/.test(helperCodeNoStr), 'no plan/status/userType');
check('56 helper does NOT compare identity values (no internalUserId/authProvider/email/displayName/identity)',
  !/internalUserId|authProviderUid|authProvider|displayName|\bemail\b|\.identity\b/.test(helperCodeNoStr), 'no identity');
const ACCESS_FNS = ['hasPermission', 'checkSubPermission', 'canAccess', 'getPermissionLevel', 'isStoreActivated', 'resolveLandingRoute'];
const calledAccessFns = ACCESS_FNS.filter((fn) => new RegExp(`\\b${fn}\\s*\\(`).test(helperCodeNoStr));
check('57 helper invokes NO AccessContext permission functions (hasPermission/checkSubPermission/canAccess/getPermissionLevel/isStoreActivated/resolveLandingRoute)', calledAccessFns.length === 0, calledAccessFns.join(', ') || 'none');

// =============================================================================
// 9) Null / non-null semantics
// =============================================================================
check('58 helper treats null input as server-authz-unavailable (not deny / not fail-open)',
  /input === null/.test(helperCode) && /'server_authz_unavailable'/.test(helper), 'null = unavailable');
check('59 helper treats non-null input as comparable (phase compared)', /'compared'/.test(helper), 'non-null = compared');
check('60 helper has a disabled (default-OFF) phase', /'disabled'/.test(helper), 'default-OFF phase');

// =============================================================================
// 10) Result safety — NON-SECRET type (no token/identity/tenant/store/role/plan/level/raw DTO)
// =============================================================================
const RESULT_FORBIDDEN: Array<[string, RegExp]> = [
  ['access/refresh token', /access_token|refresh_token|accessToken|refreshToken|\btoken\b/i],
  ['raw JWT / provider token', /\bjwt\b|rawJwt|provider_token|providerToken/i],
  ['identity field', /internalUserId|authProviderUid|authProvider|displayName|\bemail\b|\bidentity\b/i],
  ['tenant/store id', /tenantId|storeId/],
  ['role value field', /platformRoleId|tenantRoleId|\brole\b/i],
  ['plan value field', /\bplan\b/i],
  ['permission-level value field', /PermissionLevel|\blevel\b/i],
  ['raw authorization DTO field', /ServerDerivedAuthorizationV1|rawAuthorization|authorizationDto|\bderivedBy\b/i],
];
for (const [label, re] of RESULT_FORBIDDEN) {
  check(`61 result type carries NO ${label}`, !re.test(typesCode), re.test(typesCode) ? 'FOUND' : 'none');
}
check('62 result type includes safe structural fields (phase/serverAuthzPresent/overallParity/counts/message)',
  /\bphase\b/.test(typesCode) && /serverAuthzPresent/.test(typesCode) && /overallParity/.test(typesCode) && /\bcounts\b/.test(typesCode) && /\bmessage\b/.test(typesCode), 'safe fields');
check('63 result type includes safe mismatch key NAMES (missingFromServerKeys/unknownToFrontendKeys)',
  /missingFromServerKeys/.test(typesCode) && /unknownToFrontendKeys/.test(typesCode), 'safe mismatch names');

// =============================================================================
// 11) No UI / context API / provider / window / DOM event / console / persistence / network
// =============================================================================
check('64 no UI (.ts module; no createElement/JSX)', HELPER.endsWith('.ts') && !/createElement/.test(helperCode), 'no UI');
check('65 no React state/context (no useState/useRef/useContext/useReducer/Provider)', !/\buseState\b|\buseRef\b|\buseContext\b|\buseReducer\b|\bProvider\b/.test(helperCode), 'no react state/context');
check('66 no public context API (no useAccess/AccessContextType)', !/useAccess\s*\(|AccessContextType/.test(helperCode), 'no context API');
check('67 no window/globalThis exposure', !/\b(window|globalThis)\b/.test(helperCode), 'no global object');
check('68 no DOM event (no CustomEvent/dispatchEvent)', !/CustomEvent|dispatchEvent/.test(helperCode), 'no DOM event');
check('69 no console logging', !/console\./.test(helper), 'no console');
check('70 no persistence (no localStorage/sessionStorage/IndexedDB)', !/localStorage|sessionStorage|indexedDB/.test(helperCode), 'no persistence');
check('71 no network (no fetch/XHR/sendBeacon/@supabase SDK/pg/Pool)', !/\bfetch\s*\(|XMLHttpRequest|sendBeacon|@supabase\/supabase-js|from 'pg'|new\s+Pool\b/.test(helperCode), 'no network/DB');
check('72 no privileged secret reference (service-role / DB URL / connection string)', !/SUPABASE_SERVICE_ROLE_KEY|SERVICE_ROLE_KEY|serviceRoleKey|service_role|SUPABASE_DATABASE_URL|\bDATABASE_URL\b|connectionString|postgres(ql)?:\/\//.test(`${helper}\n${types}`), 'no secrets');

// =============================================================================
// 12) Dormancy — imported by NOTHING active; no active call site
// =============================================================================
const refsHelper = (s: string) => /(?:from|import)\s*\(?\s*'[^']*\/serverAuthzShadowComparison'/.test(s);
const importers = srcFiles.filter((f) => f !== HELPER && f !== HELPER_TYPES && refsHelper(text.get(f)!));
check('73 helper imported by NO active app entrypoint (Login/AccessContext/AccessGuard/App/main)', importers.filter((f) => ENTRYPOINTS.includes(f)).length === 0, importers.filter((f) => ENTRYPOINTS.includes(f)).join(', ') || 'dormant');
check('74 helper NOT imported by AccessContext', !refsHelper(text.get('src/context/AccessContext.tsx') ?? ''), 'AccessContext clean');
check('75 helper NOT imported by Login', !refsHelper(text.get('src/components/Login.tsx') ?? ''), 'Login clean');
check('76 helper NOT imported by AccessGuard', !refsHelper(text.get('src/components/AccessGuard.tsx') ?? ''), 'AccessGuard clean');
check('77 helper NOT imported by App routing', !refsHelper(text.get('src/App.tsx') ?? ''), 'App clean');
check('78 helper NOT imported by src/main.tsx', !refsHelper(text.get('src/main.tsx') ?? ''), 'main clean');
const pilotImporters = importers.filter((f) => f.startsWith('src/pilot/'));
check('79 helper NOT imported by pilot', pilotImporters.length === 0, pilotImporters.join(', ') || 'pilot clean');
check('80 helper imported NOWHERE active in src/** (no M13 call site added)', importers.length === 0, importers.join(', ') || 'no importers');
// No active call site for the exported helpers anywhere outside their own declaration.
const externalCallers = srcFiles
  .filter((f) => f !== HELPER && f !== HELPER_TYPES)
  .filter((f) => /compareServerAuthzShadow\s*\(|isServerAuthzShadowEnabled\s*\(/.test(stripComments(text.get(f)!)));
const compareSelfCalls = (helperCode.match(/compareServerAuthzShadow\s*\(/g) ?? []).length;
const declaredOnce = /function\s+compareServerAuthzShadow\s*\(/.test(helperCode) && compareSelfCalls === 1;
check('81 helper has NO active call site (declared once, never self-invoked, never called elsewhere)', externalCallers.length === 0 && declaredOnce, externalCallers.join(', ') || 'invoked by nothing');

// =============================================================================
// 13) No barrel export
// =============================================================================
check('82 no src/auth/index.ts barrel exists', !srcFiles.includes('src/auth/index.ts'), 'no barrel');

// =============================================================================
// 14) Self-inertness (non-circular allowlist + read-only fs + no env/side effects)
// =============================================================================
const selfSrc = read('scripts/diagnostics-server-authz-shadow-comparison-dormant-check.ts');
const selfImports = [...selfSrc.matchAll(/^import[\s\S]*?from '([^']+)'/gm)].map((m) => m[1]);
const fsBindings = ((selfSrc.match(/import\s*\{([^}]*)\}\s*from\s*'fs'/) ?? ['', ''])[1]).split(',').map((s) => s.trim()).filter(Boolean);
const banned = ['child' + '_process', 'exec' + 'Sync', 'spawn' + '(', 'fetch' + '(', 'create' + 'Client', 'new ' + 'Pool'];
const selfBanned = banned.filter((t) => selfSrc.includes(t));
check('83a diagnostic imports confined to node fs/path', selfImports.length > 0 && selfImports.every((i) => i === 'fs' || i === 'path'), selfImports.join(', '));
check('83b diagnostic imports no frontend/server module (reads src/ as TEXT only)', !selfImports.some((i) => i.includes('/src/') || i.startsWith('src/') || i.includes('platform-identity')), 'text-only');
check('83c diagnostic uses fs read-only (readFileSync/readdirSync)', fsBindings.length > 0 && fsBindings.every((b) => b === 'readFileSync' || b === 'readdirSync'), fsBindings.join(','));
check('83d diagnostic accesses no environment variables', !/process\.env/.test(selfSrc), 'no env');
check('83e diagnostic is side-effect-free (no child process / network / DB)', selfBanned.length === 0, selfBanned.join(', ') || 'inert');

// =============================================================================
// Summary
// =============================================================================
const failed = results.filter((r) => !r.pass);
console.log(`\n[server-authz-shadow-comparison-dormant-check] ${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length) process.exitCode = 1;

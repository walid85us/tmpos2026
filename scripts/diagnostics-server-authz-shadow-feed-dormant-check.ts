// Phase 1.6 M14 — STATIC (offline) DORMANCY + ROUTE/TOKEN/AUTHORIZATION/RESULT-SAFETY check for the
// dormant SERVER-AUTHZ SHADOW FEED helper (`src/auth/serverAuthzShadowFeed.ts`).
//
// PURE / OFFLINE: no DB, no network, no Supabase, no Firebase, no env values, no SQL, no migration,
// no audit write, no Supabase MCP, no live/route call, no child process. It reads the frontend
// (`src/**`) as TEXT only (read-only — NEVER imported, NEVER modified) and PROVES the feed helper is:
// dormant (imported by nothing active, invoked by nothing), lazy (no import-time call, no top-level
// await), no-throw, FOUR-flag DEV-gated (default OFF), confined to the M11 token bridge + M13
// comparison helper (+ M13/own types), token-safe (Bearer-only), authorization-extraction-only
// (reads ONLY the response `authorization` object, never identity/scope/roles/status/userType), and
// RESULT-SAFE (no token / raw body / raw authorization DTO / identity / tenant / store / role / plan
// / level).
//
// NOTE: this diagnostic does NOT ban `/auth/session/resolve` / `Bearer` repo-wide (the pilot, M12,
// and this feed legitimately reference the route). It scopes every assertion to the feed helper +
// its import/call graph.
//
// Run:  npx tsx scripts/diagnostics-server-authz-shadow-feed-dormant-check.ts

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

const FEED = 'src/auth/serverAuthzShadowFeed.ts';
const FEED_TYPES = 'src/auth/serverAuthzShadowFeedTypes.ts';
const ENTRYPOINTS = [
  'src/main.tsx',
  'src/App.tsx',
  'src/components/Login.tsx',
  'src/context/AccessContext.tsx',
  'src/components/AccessGuard.tsx',
];

const feed = text.get(FEED) ?? '';
const types = text.get(FEED_TYPES) ?? '';

// Comment-stripped CODE views (line comments FIRST). "Must-not-appear-in-CODE" checks use these so
// documentation is never mistaken for behavior. A string-stripped view is ALSO used for identifier
// scans that could otherwise collide with PHASE_MESSAGE prose.
const stripComments = (s: string): string =>
  s.replace(/(^|[^:])\/\/.*$/gm, '$1').replace(/\/\*[\s\S]*?\*\//g, '');
const stripStrings = (s: string): string =>
  s
    .replace(/`(?:\\.|[^`\\])*`/g, '``')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""');
const feedCode = stripComments(feed);
const feedCodeNoStr = stripStrings(feedCode);
const typesCode = stripComments(types);

// =============================================================================
// 1) Files exist
// =============================================================================
check('1 feed helper module exists', text.has(FEED), text.has(FEED) ? FEED : 'absent');
check('2 feed helper types module exists', text.has(FEED_TYPES), text.has(FEED_TYPES) ? FEED_TYPES : 'absent');

// =============================================================================
// 2) Import allowlist — M11 bridge + M13 comparison helper (+ M13/own types) ONLY
// =============================================================================
const staticImports = [...feedCode.matchAll(/import[\s\S]*?from '([^']+)'/g)].map((m) => m[1]);
const dynamicImports = [...feedCode.matchAll(/import\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]);
const allImports = [...staticImports, ...dynamicImports];
const ALLOWED = [
  './supabaseTokenBridge',
  './serverAuthzShadowComparison',
  './serverAuthzShadowComparisonTypes',
  './serverAuthzShadowFeedTypes',
];
const disallowed = allImports.filter((i) => !ALLOWED.includes(i));
check('3 feed imports the M11 token bridge', allImports.includes('./supabaseTokenBridge'), 'token bridge imported');
check('4 feed imports the M13 comparison helper', allImports.includes('./serverAuthzShadowComparison'), 'comparison helper imported');
check('5 feed imports confined to the M11 bridge + M13 helper + M13/own types', allImports.length > 0 && disallowed.length === 0, disallowed.join(', ') || allImports.join(' + '));
check('6 feed does NOT import the M12 shadow client', !allImports.some((i) => /sessionResolveShadowClient/.test(i)), 'no M12 import');
check('7 feed does NOT import AccessContext', !allImports.some((i) => /context\/AccessContext/.test(i)), 'no AccessContext');
check('8 feed does NOT import Login', !allImports.some((i) => /components\/Login/.test(i)), 'no Login');
check('9 feed does NOT import AccessGuard', !allImports.some((i) => /AccessGuard/.test(i)), 'no AccessGuard');
check('10 feed does NOT import App routing', !allImports.some((i) => /(^|\/)App'?$/.test(i)), 'no App');
check('11 feed does NOT import src/main', !allImports.some((i) => /(^|\/)main(\.tsx)?'?$/.test(i)), 'no main');
check('12 feed does NOT import pilot modules', !allImports.some((i) => /pilot\//.test(i)), 'no pilot');
check('13 feed does NOT import server/backend modules', !allImports.some((i) => /(^|\/)server(\/|$)|platform-identity/.test(i)), 'no server');
check('14 feed does NOT import @supabase/supabase-js', !allImports.some((i) => i === '@supabase/supabase-js'), 'no direct SDK');
check('15 feed does NOT import React', !allImports.some((i) => i === 'react' || i === 'react-dom'), 'no react');
check('16 feed does NOT import Firebase', !allImports.some((i) => /^@?firebase(\/|$)/.test(i)), 'no firebase');
check('17 feed does NOT import the M5 foundation directly / M6 bootstrap / M7 awareness', !allImports.some((i) => /supabaseAuthFoundation|supabaseSessionBootstrap|supabaseAccessAwareness/.test(i)), 'token only via M11 bridge');
check('18 feed imports NO pilot env/helper (no pilotEnv / sessionResolvePilotClient)', !/pilotEnv|sessionResolvePilotClient/.test(feedCode), 'no pilot env/helper');

// =============================================================================
// 3) No import-time side effects; lazy; no top-level await
// =============================================================================
check('19 no top-level await (await only inside async functions)', !/^await\b/m.test(feedCode), 'no top-level await');
check('20 no import-time route/token-bridge/compare call (no top-level binding to a call)',
  !/^(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*(?:await\s+)?(?:withSupabaseAccessToken|fetch|callRouteAndCompare|compareServerAuthzShadow|runServerAuthzShadowFeed)\s*\(/m.test(feedCode),
  'lazy');
check('21 feed exports the lazy helper runServerAuthzShadowFeed', /export\s+async\s+function\s+runServerAuthzShadowFeed\b/.test(feedCode), 'lazy exported helper');
check('22 feed exports the enablement helper isServerAuthzShadowFeedEnabled', /export\s+function\s+isServerAuthzShadowFeedEnabled\b/.test(feedCode), 'enablement helper');
check('23 feed is no-throw (no `throw` statement)', !/\bthrow\b/.test(feedCode), 'no throw');

// =============================================================================
// 4) Dormancy — imported by NOTHING active; no active call site
// =============================================================================
const refsFeed = (s: string) => /(?:from|import)\s*\(?\s*'[^']*\/serverAuthzShadowFeed'/.test(s);
const importers = srcFiles.filter((f) => f !== FEED && f !== FEED_TYPES && refsFeed(text.get(f)!));
check('24 feed imported by NO active app entrypoint (Login/AccessContext/AccessGuard/App/main)', importers.filter((f) => ENTRYPOINTS.includes(f)).length === 0, importers.filter((f) => ENTRYPOINTS.includes(f)).join(', ') || 'dormant');
check('25 feed NOT imported by AccessContext', !refsFeed(text.get('src/context/AccessContext.tsx') ?? ''), 'AccessContext clean');
check('26 feed NOT imported by Login', !refsFeed(text.get('src/components/Login.tsx') ?? ''), 'Login clean');
check('27 feed NOT imported by AccessGuard', !refsFeed(text.get('src/components/AccessGuard.tsx') ?? ''), 'AccessGuard clean');
check('28 feed NOT imported by App routing', !refsFeed(text.get('src/App.tsx') ?? ''), 'App clean');
check('29 feed NOT imported by src/main.tsx', !refsFeed(text.get('src/main.tsx') ?? ''), 'main clean');
const pilotImporters = importers.filter((f) => f.startsWith('src/pilot/'));
check('30 feed NOT imported by pilot', pilotImporters.length === 0, pilotImporters.join(', ') || 'pilot clean');
check('31 feed imported NOWHERE active in src/** (no M14 call site added)', importers.length === 0, importers.join(', ') || 'no importers');
// No active call site for the exported helpers anywhere outside their own declaration.
const externalCallers = srcFiles
  .filter((f) => f !== FEED && f !== FEED_TYPES)
  .filter((f) => /runServerAuthzShadowFeed\s*\(|isServerAuthzShadowFeedEnabled\s*\(/.test(stripComments(text.get(f)!)));
const selfRunCalls = (feedCode.match(/runServerAuthzShadowFeed\s*\(/g) ?? []).length;
const declaresOnce = /function\s+runServerAuthzShadowFeed\s*\(/.test(feedCode) && selfRunCalls === 1;
check('32 feed has NO active call site (declared once, never self-invoked, never called elsewhere)', externalCallers.length === 0 && declaresOnce, externalCallers.join(', ') || 'invoked by nothing');

// =============================================================================
// 5) FOUR-flag DEV-gating, default OFF; flag hygiene
// =============================================================================
check('33 feed uses the new dedicated flag VITE_ENABLE_SERVER_AUTHZ_SHADOW_FEED', /VITE_ENABLE_SERVER_AUTHZ_SHADOW_FEED/.test(feedCode), 'feed flag');
check('34 feed is DEV-gated (reads import.meta DEV)', /\.DEV\b/.test(feedCode), 'DEV gate');
check('35 feed requires the M11 token bridge enablement (isSupabaseTokenBridgeEnabled)', /isSupabaseTokenBridgeEnabled\s*\(/.test(feedCode), 'token-bridge gate');
check('36 feed requires the M12 session-resolve-shadow flag VITE_ENABLE_SESSION_RESOLVE_SHADOW', /VITE_ENABLE_SESSION_RESOLVE_SHADOW/.test(feedCode), 'route-shadow gate');
check('37 feed requires the M13 server-authz-shadow comparison enablement (isServerAuthzShadowEnabled)', /isServerAuthzShadowEnabled\s*\(/.test(feedCode), 'comparison gate');
check('38 enablement is AND of DEV + feed flag === "true" (default OFF)', /DEV === true/.test(feedCode) && /=== 'true'/.test(feedCode), 'dev && flag');
check('39 no single flag implies feed behavior (isServerAuthzShadowFeedEnabled ANDs DEV + bridge + route-shadow + comparison + feed flag)',
  /isServerAuthzShadowFeedEnabled\s*\(\s*\)\s*:\s*boolean/.test(feedCode) &&
  /isSupabaseTokenBridgeEnabled\s*\(\s*\)\s*&&/.test(feedCode) &&
  /isServerAuthzShadowEnabled\s*\(\s*\)\s*&&/.test(feedCode), 'five-way AND gate');
check('40 feed introduces NO unexpected VITE_ name in CODE (only session-resolve-shadow + feed flag + identity base)', (() => {
  const names = [...new Set([...feedCode.matchAll(/VITE_[A-Z0-9_]+/g)].map((m) => m[0]))].sort();
  const expected = ['VITE_ENABLE_SERVER_AUTHZ_SHADOW_FEED', 'VITE_ENABLE_SESSION_RESOLVE_SHADOW', 'VITE_IDENTITY_API_BASE'].sort();
  return names.length === expected.length && names.every((n, i) => n === expected[i]);
})(), 'expected VITE_ names only');
// The token-bridge + server-authz-shadow flags must come via the imported enable-checks, NOT a
// duplicated literal IN CODE (defense against a single flag implying everything). Comment prose may
// name them for documentation; these checks scan comment-stripped CODE.
check('41 feed CODE does NOT duplicate the M11 token-bridge flag literal (uses isSupabaseTokenBridgeEnabled)', !/VITE_ENABLE_SUPABASE_TOKEN_BRIDGE/.test(feedCode), 'bridge flag via import');
check('42 feed CODE does NOT duplicate the M13 comparison flag literal (uses isServerAuthzShadowEnabled)', !/VITE_ENABLE_SERVER_AUTHZ_SHADOW\b/.test(feedCode), 'comparison flag via import');

// =============================================================================
// 6) Token discipline + route call shape (Bearer header, exact `{}` body, content-type, base URL)
// =============================================================================
check('43 feed uses withSupabaseAccessToken (token via the M11 bridge callback)', /withSupabaseAccessToken\s*</.test(feedCode) || /withSupabaseAccessToken\s*\(/.test(feedCode), 'bridge callback');
check('44 feed sends the token ONLY as an Authorization: Bearer header', /authorization:\s*`Bearer \$\{accessToken\}`/.test(feed), 'Bearer header');
check('45 feed body is EXACTLY an empty object `{}`', /body:\s*'\{\}'/.test(feed), 'empty {} body');
check('46 feed sets content-type application/json', /'content-type':\s*'application\/json'/.test(feed), 'json content-type');
check('47 feed reads the route base from VITE_IDENTITY_API_BASE (default /__identity)', /VITE_IDENTITY_API_BASE\s*\|\|\s*'\/__identity'/.test(feed), 'identity base');
check('48 feed does NOT place the token in the body', !/body:[^\n]*accessToken/.test(feedCode), 'no token in body');
check('49 feed does NOT place the token in the URL/query string', !/[?&][^\n]*accessToken/.test(feedCode) && !/`\$\{[^}]*accessToken[^}]*\}`[^\n]*\/auth/.test(feedCode), 'no token in URL');
check('50 feed does NOT log the token / request body / response body (no console.*)', !/console\./.test(feed), 'no console logging');
check('51 feed does NOT persist (no localStorage/sessionStorage/IndexedDB)', !/localStorage|sessionStorage|indexedDB/.test(feedCode), 'no persistence');
check('52 feed never returns/stores the raw token (token only used as the Bearer header value)',
  !/\breturn\b[^\n;]*accessToken/.test(feedCode) &&        // not in any return statement
  !/\b\w+\s*=\s*accessToken\b/.test(feedCode),             // not assigned to a var/field
  'token never returned/stored');

// =============================================================================
// 7) Authorization-extraction-only — reads ONLY the response `authorization` object
// =============================================================================
check('53 feed extracts the response `authorization` object', /\.authorization\b/.test(feedCodeNoStr), 'authorization read');
check('54 feed does NOT extract identity fields (internalUserId/authProvider/authProviderUid/email/displayName/identity)',
  !/internalUserId|authProviderUid|authProvider|displayName|\bemail\b|\.identity\b/.test(feedCodeNoStr), 'no identity');
check('55 feed does NOT extract scope/tenant/store fields (.scope/tenantId/storeId)',
  !/\.scope\b|tenantId|storeId/.test(feedCodeNoStr), 'no scope/tenant/store');
check('56 feed does NOT extract roles (.roles/platformRoleId/tenantRoleId)',
  !/\.roles\b|platformRoleId|tenantRoleId/.test(feedCodeNoStr), 'no roles');
check('57 feed does NOT extract the authorization-DTO status (.status read off the body authorization)',
  !/authorization\.status|\.authorization\)[^\n]*\.status/.test(feedCodeNoStr), 'no authz status');
check('58 feed does NOT extract userType as behavior', !/userType/.test(feedCodeNoStr), 'no userType');
check('59 feed passes authorization ONLY to compareServerAuthzShadow', /compareServerAuthzShadow\s*\(/.test(feedCode), 'authz → M13 only');
check('60 feed does NOT read permission-LEVEL values (no level helpers/hierarchy)',
  !/meetsPermissionLevel|getPermissionLevel|PERMISSION_HIERARCHY|PermissionLevel/.test(feedCode), 'no level read');
check('61 feed does NOT compare behavioral allow/deny (no .decision/.allowed/allow|deny literals)',
  !/\.decision\b|\.allowed\b|===\s*'allow'|===\s*'deny'|explainAccessDecision/.test(feedCodeNoStr), 'no allow/deny');
const ACCESS_FNS = ['hasPermission', 'checkSubPermission', 'canAccess', 'getPermissionLevel', 'isStoreActivated', 'resolveLandingRoute'];
const calledAccessFns = ACCESS_FNS.filter((fn) => new RegExp(`\\b${fn}\\s*\\(`).test(feedCodeNoStr));
check('62 feed invokes NO AccessContext permission functions', calledAccessFns.length === 0, calledAccessFns.join(', ') || 'none');

// =============================================================================
// 8) Null / non-null authorization semantics
// =============================================================================
check('63 feed treats null authorization as server_authz_unavailable (not deny / not fail-open)', /'server_authz_unavailable'/.test(feed), 'null = unavailable');
check('64 feed treats non-null authorization as comparable (phase compared)', /'compared'/.test(feed), 'non-null = compared');
check('65 feed has a disabled (default-OFF) phase', /'disabled'/.test(feed), 'default-OFF phase');

// =============================================================================
// 9) Result safety — NON-SECRET type (no token/identity/tenant/store/role/plan/level/raw body/DTO)
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
  ['raw response body field', /rawBody|responseBody|\bbody\b/i],
];
for (const [label, re] of RESULT_FORBIDDEN) {
  check(`66 feed result type carries NO ${label}`, !re.test(typesCode), re.test(typesCode) ? 'FOUND' : 'none');
}
check('67 feed result type includes safe structural fields (ok/status/phase/serverAuthzPresent/comparison/message)',
  /\bok\b/.test(typesCode) && /\bstatus\b/.test(typesCode) && /\bphase\b/.test(typesCode) && /serverAuthzPresent/.test(typesCode) && /\bcomparison\b/.test(typesCode) && /\bmessage\b/.test(typesCode), 'safe fields');
check('68 feed result `comparison` is the M13 NON-SECRET comparison result (or null), never the raw DTO',
  /comparison:\s*ServerAuthzShadowComparisonResult\s*\|\s*null/.test(types), 'comparison = M13 result|null');

// =============================================================================
// 10) No UI / context API / provider / window / DOM event / persistence / enforcement
// =============================================================================
check('69 no UI (.ts module; no createElement/JSX)', FEED.endsWith('.ts') && !/createElement/.test(feedCode), 'no UI');
check('70 no React state/context (no useState/useRef/useContext/Provider)', !/\buseState\b|\buseRef\b|\buseContext\b|\buseReducer\b|\bProvider\b/.test(feedCode), 'no react state/context');
check('71 no public context API (no useAccess/AccessContextType)', !/useAccess\s*\(|AccessContextType/.test(feedCode), 'no context API');
check('72 no window/globalThis exposure', !/\b(window|globalThis)\b/.test(feedCode), 'no global object');
check('73 no DOM event (no CustomEvent/dispatchEvent)', !/CustomEvent|dispatchEvent/.test(feedCode), 'no DOM event');
check('74 no privileged secret reference (service-role / DB URL / connection string)', !/SUPABASE_SERVICE_ROLE_KEY|SERVICE_ROLE_KEY|serviceRoleKey|service_role|SUPABASE_DATABASE_URL|\bDATABASE_URL\b|connectionString|postgres(ql)?:\/\//.test(`${feed}\n${types}`), 'no secrets');
check('75 no browser→DB access (no @supabase SDK / pg / Pool)', !/@supabase\/supabase-js|from 'pg'|new\s+Pool\b/.test(feedCode), 'no DB access');

// =============================================================================
// 11) No barrel export
// =============================================================================
check('76 no src/auth/index.ts barrel exists', !srcFiles.includes('src/auth/index.ts'), 'no barrel');

// =============================================================================
// 12) Self-inertness (non-circular allowlist + read-only fs + no env/side effects)
// =============================================================================
const selfSrc = read('scripts/diagnostics-server-authz-shadow-feed-dormant-check.ts');
const selfImports = [...selfSrc.matchAll(/^import[\s\S]*?from '([^']+)'/gm)].map((m) => m[1]);
const fsBindings = ((selfSrc.match(/import\s*\{([^}]*)\}\s*from\s*'fs'/) ?? ['', ''])[1]).split(',').map((s) => s.trim()).filter(Boolean);
const banned = ['child' + '_process', 'exec' + 'Sync', 'spawn' + '(', 'fetch' + '(', 'create' + 'Client', 'new ' + 'Pool'];
const selfBanned = banned.filter((t) => selfSrc.includes(t));
check('77a diagnostic imports confined to node fs/path', selfImports.length > 0 && selfImports.every((i) => i === 'fs' || i === 'path'), selfImports.join(', '));
check('77b diagnostic imports no frontend/server module (reads src/ as TEXT only)', !selfImports.some((i) => i.includes('/src/') || i.startsWith('src/') || i.includes('platform-identity')), 'text-only');
check('77c diagnostic uses fs read-only (readFileSync/readdirSync)', fsBindings.length > 0 && fsBindings.every((b) => b === 'readFileSync' || b === 'readdirSync'), fsBindings.join(','));
check('77d diagnostic accesses no environment variables', !/process\.env/.test(selfSrc), 'no env');
check('77e diagnostic is side-effect-free (no child process / network / DB)', selfBanned.length === 0, selfBanned.join(', ') || 'inert');

// =============================================================================
// Summary
// =============================================================================
const failed = results.filter((r) => !r.pass);
console.log(`\n[server-authz-shadow-feed-dormant-check] ${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length) process.exitCode = 1;

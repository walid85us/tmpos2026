// Phase 1.6 M12 — STATIC (offline) DORMANCY + ROUTE/TOKEN/RESPONSE-SAFETY check for the
// dormant SESSION-RESOLVE SHADOW route-call helper (`src/auth/sessionResolveShadowClient.ts`).
//
// PURE / OFFLINE: no DB, no network, no Supabase, no Firebase, no env values, no SQL, no
// migration, no audit write, no Supabase MCP, no live/route call. It reads the frontend
// (`src/**`) as TEXT only (read-only — NEVER imported, NEVER modified) and PROVES the shadow
// client is dormant (imported by nothing active, invoked by nothing), DEV+flag-gated, token-bridge
// only, lazy, cancellation-safe, no-throw, and TOKEN/RESPONSE-SAFE: the token is used ONLY as the
// outgoing Bearer header (never body/URL/log/store/return), and the result carries ONLY safe shape
// fields (NO token, NO response body, NO server `authorization`, NO identity fields).
//
// NOTE: this diagnostic does NOT ban `/auth/session/resolve` or `Bearer` repo-wide (the pilot
// legitimately uses them, and the shadow helper legitimately references the route path). It scopes
// every assertion to the shadow client + its import/call graph.
//
// Run:  npx tsx scripts/diagnostics-session-resolve-shadow-client-dormant-check.ts

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

const SHADOW = 'src/auth/sessionResolveShadowClient.ts';
const SHADOW_TYPES = 'src/auth/sessionResolveShadowClientTypes.ts';
const ENTRYPOINTS = [
  'src/main.tsx',
  'src/App.tsx',
  'src/components/Login.tsx',
  'src/context/AccessContext.tsx',
  'src/components/AccessGuard.tsx',
];

const client = text.get(SHADOW) ?? '';
const types = text.get(SHADOW_TYPES) ?? '';

// Comment-stripped CODE views (line comments FIRST). "Must-not-appear-in-CODE" checks use these so
// documentation is never mistaken for behavior. Identifier scans may use FULL text where noted.
const stripComments = (s: string): string =>
  s.replace(/(^|[^:])\/\/.*$/gm, '$1').replace(/\/\*[\s\S]*?\*\//g, '');
const clientCode = stripComments(client);
const typesCode = stripComments(types);
const lines = (s: string): string[] => s.split('\n');

// =============================================================================
// 1) Files exist
// =============================================================================
check('1 shadow client module exists', text.has(SHADOW), text.has(SHADOW) ? SHADOW : 'absent');
check('2 shadow client types module exists', text.has(SHADOW_TYPES), text.has(SHADOW_TYPES) ? SHADOW_TYPES : 'absent');

// =============================================================================
// 2) Import allowlist — token bridge + own types ONLY
// =============================================================================
const staticImports = [...clientCode.matchAll(/import[\s\S]*?from '([^']+)'/g)].map((m) => m[1]);
const dynamicImports = [...clientCode.matchAll(/import\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]);
const allImports = [...staticImports, ...dynamicImports];
const ALLOWED = ['./supabaseTokenBridge', './sessionResolveShadowClientTypes'];
const disallowed = allImports.filter((i) => !ALLOWED.includes(i));
check('3 shadow client imports the M11 token bridge', allImports.includes('./supabaseTokenBridge'), 'token bridge imported');
check('4 shadow client does NOT import AccessContext', !allImports.some((i) => /AccessContext/.test(i)), 'no AccessContext');
check('5 shadow client does NOT import Login', !allImports.some((i) => /components\/Login/.test(i)), 'no Login');
check('6 shadow client does NOT import AccessGuard', !allImports.some((i) => /AccessGuard/.test(i)), 'no AccessGuard');
check('7 shadow client does NOT import App routing', !allImports.some((i) => /(^|\/)App'?$/.test(i)), 'no App');
check('8 shadow client does NOT import src/main', !allImports.some((i) => /(^|\/)main(\.tsx)?'?$/.test(i)), 'no main');
check('9 shadow client does NOT import pilot modules', !allImports.some((i) => /pilot\//.test(i)), 'no pilot');
check('10 shadow client does NOT import server/backend modules', !allImports.some((i) => /(^|\/)server(\/|$)|platform-identity/.test(i)), 'no server');
check('11 shadow client does NOT import @supabase/supabase-js', !allImports.some((i) => i === '@supabase/supabase-js'), 'no direct SDK');
check('12 shadow client does NOT import React', !allImports.some((i) => i === 'react' || i === 'react-dom'), 'no react');
check('13 shadow client does NOT import Firebase', !allImports.some((i) => /^@?firebase(\/|$)/.test(i)), 'no firebase');
check('14 shadow client does NOT import the M5 foundation directly', !allImports.some((i) => /supabaseAuthFoundation/.test(i)), 'foundation only via bridge');
check('15 shadow client does NOT import the M6 bootstrap', !allImports.some((i) => /supabaseSessionBootstrap/.test(i)), 'no bootstrap');
check('16 shadow client does NOT import the M7 awareness helper', !allImports.some((i) => /supabaseAccessAwareness/.test(i)), 'no awareness');
check('17 shadow client imports confined to the token bridge + its own types', allImports.length > 0 && disallowed.length === 0, disallowed.join(', ') || allImports.join(' + '));
check('18 shadow client imports NO pilot env/helper (no pilotEnv / sessionResolvePilotClient)', !/pilotEnv|sessionResolvePilotClient/.test(clientCode), 'no pilot env/helper');

// =============================================================================
// 3) No import-time side effects; lazy; no top-level await
// =============================================================================
check('19 no top-level await (await only inside async functions)', !/^await\b/m.test(clientCode), 'no top-level await');
check('20 no import-time route call / token-bridge call (no top-level binding to a call)',
  !/^(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*(?:await\s+)?(?:withSupabaseAccessToken|fetch|callSessionResolveRoute|runSessionResolveShadowCheck)\s*\(/m.test(clientCode),
  'lazy');
check('21 exports the lazy helper runSessionResolveShadowCheck', /export\s+async\s+function\s+runSessionResolveShadowCheck\b/.test(clientCode), 'lazy exported helper');

// =============================================================================
// 4) Dormancy — imported by NOTHING active; no active call site
// =============================================================================
const refsShadow = (s: string) => /(?:from|import)\s*\(?\s*'[^']*\/sessionResolveShadowClient'/.test(s);
const importers = srcFiles.filter((f) => f !== SHADOW && f !== SHADOW_TYPES && refsShadow(text.get(f)!));
check('22 shadow client imported by NO active app entrypoint (Login/AccessContext/AccessGuard/App/main)', importers.filter((f) => ENTRYPOINTS.includes(f)).length === 0, importers.filter((f) => ENTRYPOINTS.includes(f)).join(', ') || 'dormant');
check('23 shadow client NOT imported by AccessContext', !refsShadow(text.get('src/context/AccessContext.tsx') ?? ''), 'AccessContext clean');
check('24 shadow client NOT imported by Login', !refsShadow(text.get('src/components/Login.tsx') ?? ''), 'Login clean');
check('25 shadow client NOT imported by AccessGuard', !refsShadow(text.get('src/components/AccessGuard.tsx') ?? ''), 'AccessGuard clean');
check('26 shadow client NOT imported by App routing', !refsShadow(text.get('src/App.tsx') ?? ''), 'App clean');
check('27 shadow client NOT imported by src/main.tsx', !refsShadow(text.get('src/main.tsx') ?? ''), 'main clean');
const pilotImporters = importers.filter((f) => f.startsWith('src/pilot/'));
check('28 shadow client NOT imported by pilot', pilotImporters.length === 0, pilotImporters.join(', ') || 'pilot clean');
check('29 shadow client imported NOWHERE active in src/** (no M12 call site added)', importers.length === 0, importers.join(', ') || 'no importers');
// No active call site for the exported helper anywhere outside its own declaration.
const externalCallers = srcFiles
  .filter((f) => f !== SHADOW && f !== SHADOW_TYPES)
  .filter((f) => /runSessionResolveShadowCheck\s*\(/.test(stripComments(text.get(f)!)));
const selfCalls = (clientCode.match(/runSessionResolveShadowCheck\s*\(/g) ?? []).length;
const declaresOnce = /function\s+runSessionResolveShadowCheck\s*\(/.test(clientCode) && selfCalls === 1;
check('30 shadow client has NO active call site (declared once, never self-invoked, never called elsewhere)', externalCallers.length === 0 && declaresOnce, externalCallers.join(', ') || 'invoked by nothing');

// =============================================================================
// 5) DEV-flag-gated, default OFF, requires token bridge; flag hygiene
// =============================================================================
check('31 shadow client uses VITE_ENABLE_SESSION_RESOLVE_SHADOW', /VITE_ENABLE_SESSION_RESOLVE_SHADOW/.test(clientCode), 'own flag');
check('32 shadow client is DEV-gated (reads import.meta DEV)', /\.DEV\b/.test(clientCode), 'DEV gate');
check('33 enablement is AND of DEV and flag === "true" (default OFF)', /DEV === true/.test(clientCode) && /=== 'true'/.test(clientCode), 'dev && flag');
check('34 shadow client requires the M11 token bridge enablement', /isSupabaseTokenBridgeEnabled\s*\(/.test(clientCode), 'requires token bridge');
check('35 shadow client uses withSupabaseAccessToken', /withSupabaseAccessToken\s*(?:<[^>]*>)?\s*\(/.test(clientCode), 'token bridge callback');
check('36 shadow client does NOT introduce VITE_ENABLE_SESSION_RESOLVE_ROUTE_HELPER', !/VITE_ENABLE_SESSION_RESOLVE_ROUTE_HELPER/.test(client), 'no redundant flag');
check('37 shadow client does NOT reference VITE_ENABLE_SERVER_AUTHZ_SHADOW (M13)', !/VITE_ENABLE_SERVER_AUTHZ_SHADOW/.test(client), 'no server-authz-shadow flag');
check('38 shadow client does NOT reference foundation/bootstrap/awareness flags', !/VITE_ENABLE_SUPABASE_AUTH_FOUNDATION|VITE_ENABLE_SUPABASE_SESSION_BOOTSTRAP|VITE_ENABLE_ACCESSCONTEXT_SUPABASE_AWARENESS/.test(clientCode), 'separate flag');

// =============================================================================
// 6) Bearer header + empty {} body + content-type; base URL from VITE_IDENTITY_API_BASE
// =============================================================================
check('39 shadow client targets the explicit /auth/session/resolve route', /\/auth\/session\/resolve/.test(client), 'explicit route literal');
check('40 shadow client sends the token as an Authorization Bearer header', /authorization:\s*`Bearer \$\{accessToken\}`/.test(clientCode), 'Bearer header');
check('41 shadow client body is exactly {} ', /body:\s*'\{\}'/.test(clientCode), "body: '{}'");
check('42 shadow client sets content-type application/json', /'content-type'\s*:\s*'application\/json'/.test(clientCode), 'json content-type');
check('43 shadow client reads base URL locally from VITE_IDENTITY_API_BASE', /VITE_IDENTITY_API_BASE/.test(clientCode), 'local env read');
check('44 shadow client default base follows /__identity discipline', /\/__identity/.test(clientCode), '/__identity default');
check('45 shadow client does NOT call the pilot runSessionResolve()', !/\brunSessionResolve\s*\(/.test(clientCode), 'no pilot route client');
check('46 shadow client makes a fetch ONLY (no XHR/sendBeacon)', /\bfetch\s*\(/.test(clientCode) && !/XMLHttpRequest|sendBeacon/.test(clientCode), 'fetch only');

// =============================================================================
// 7) Token safety — token only as Bearer; never body/URL/log/store/return
// =============================================================================
const tokenInterpolations = lines(clientCode).filter((l) => /\$\{\s*accessToken\s*\}/.test(l));
check('47 the token is string-interpolated ONLY into the Bearer header (never elsewhere)', tokenInterpolations.length > 0 && tokenInterpolations.every((l) => /Bearer/.test(l)), tokenInterpolations.length ? 'Bearer-only' : 'no interpolation found');
check('48 token never sent in the request body', !/body\s*:[^\n]*accessToken/.test(clientCode), 'token-free body');
check('49 token never placed in the URL/query string', !/url[^\n]*accessToken/i.test(clientCode) && !/[?&][^`'"\n]*\$\{\s*accessToken/.test(clientCode), 'token-free URL');
check('50 token never returned (no return of accessToken)', !/return\s+accessToken\b/.test(clientCode) && !/return[^;\n]*\baccessToken\b/.test(clientCode), 'no token return');
check('51 shadow client does NOT log (no console.*)', !/console\./.test(client), 'no console');
check('52 token never in a message/error interpolation', !/\$\{[^}]*[Aa]ccess[_]?[Tt]oken[^}]*\}/.test(client.replace(/`Bearer \$\{accessToken\}`/g, '')), 'no token in messages');

// =============================================================================
// 8) Response safety — safe shape fields only; NO authorization / identity / body
// =============================================================================
const authzLines = lines(clientCode).filter((l) => /authorization/i.test(l));
check('53 `authorization` appears ONLY as the outgoing Bearer header (no server-authz read)', authzLines.length > 0 && authzLines.every((l) => /Bearer/.test(l)), authzLines.length ? 'header-only' : 'none');
check('54 shadow client does NOT read the server `authorization` field (no .authorization / json.authorization)', !/\.authorization\b|\[\s*['"]authorization['"]\s*\]/i.test(clientCode), 'no authz read');
check('55 result/status type carries NO authorization/permissions/token field', !/\bauthorization\b|\bpermissions\b|\bsubPermissions\b|access_token|refresh_token|provider_token|\bjwt\b/i.test(typesCode), 'non-secret status type');
const IDENTITY_FIELDS = ['internalUserId', 'authProviderUid', 'authProvider', 'displayName', 'email'];
const leakedIdentity = IDENTITY_FIELDS.filter((f) => new RegExp(`\\b${f}\\b`).test(clientCode));
check('56 shadow client reads NO identity fields into the result (internalUserId/authProvider[Uid]/email/displayName)', leakedIdentity.length === 0, leakedIdentity.join(', ') || 'none');
check('57 shadow client reads NO identity object (no .identity / identity:)', !/\.identity\b|\bidentity\s*:/.test(clientCode), 'no identity object');
check('58 shadow client returns ONLY safe shape fields (requestId/authState/decision/reasonCode/sourceOfTruth)', /requestId/.test(clientCode) && /authState/.test(clientCode) && /decision/.test(clientCode) && /reasonCode/.test(clientCode) && /sourceOfTruth/.test(clientCode), 'safe fields');
check('59 status messages are PHASE-DERIVED (a PHASE_MESSAGE map exists; no server echo)', /PHASE_MESSAGE\s*:/.test(clientCode) && /message:\s*PHASE_MESSAGE\[/.test(clientCode), 'phase-derived messages');

// =============================================================================
// 9) No storage / persistence / state / UI / window / DOM event / browser→DB
// =============================================================================
check('60 no token/response stored in module scope (no top-level binding from a call/json)',
  !/^(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*(?:await\s+)?(?:withSupabaseAccessToken|fetch|callSessionResolveRoute)\s*\(/m.test(clientCode),
  'function-local only');
check('61 no React state/ref (no useState/useRef/useContext/useReducer)', !/\buseState\b|\buseRef\b|\buseContext\b|\buseReducer\b/.test(clientCode), 'no react state');
check('62 no context/provider exposure (no useAccess/AccessContext/Provider)', !/useAccess\s*\(|AccessContext|\bProvider\b/.test(clientCode), 'no context');
check('63 no web storage (localStorage/sessionStorage/IndexedDB)', !/localStorage|sessionStorage|indexedDB/.test(clientCode), 'no web storage');
check('64 no window/globalThis exposure', !/\b(window|globalThis)\b/.test(clientCode), 'no global object');
check('65 no DOM event (no CustomEvent/dispatchEvent)', !/CustomEvent|dispatchEvent/.test(clientCode), 'no DOM event');
check('66 no UI (.ts module; no createElement/JSX-producing API)', SHADOW.endsWith('.ts') && !/createElement/.test(clientCode), 'no UI');
check('67 no browser→database access (no @supabase SDK / pg / Pool)', !/@supabase\/supabase-js/.test(clientCode) && !/from 'pg'|new\s+Pool\b/.test(clientCode), 'no DB access');
const forbiddenSecret: Array<[string, RegExp]> = [
  ['SUPABASE_SERVICE_ROLE_KEY', /SUPABASE_SERVICE_ROLE_KEY/],
  ['service-role key identifier', /SERVICE_ROLE_KEY|serviceRoleKey|service_role/],
  ['SUPABASE_DATABASE_URL', /SUPABASE_DATABASE_URL/],
  ['DB URL / connection string', /\bDATABASE_URL\b|connectionString|postgres(ql)?:\/\//],
];
for (const [label, re] of forbiddenSecret) {
  check(`68 no ${label} reference in the shadow client`, !re.test(`${client}\n${types}`), re.test(`${client}\n${types}`) ? 'FOUND' : 'none');
}
check('69 shadow client reads NO public VITE Supabase config directly (URL/anon via the bridge/foundation)', !/VITE_SUPABASE_URL|VITE_SUPABASE_ANON_KEY/.test(clientCode), 'bridge-mediated config');

// =============================================================================
// 10) Cancellation + no-throw + phase coverage
// =============================================================================
check('70 cancellation-safe (honors AbortSignal/aborted)', /signal/.test(clientCode) && /aborted/.test(clientCode), 'cancellation-safe');
check('71 AbortSignal forwarded to the token bridge and the fetch', /\{\s*signal\s*\}/.test(clientCode) && /signal,/.test(clientCode), 'signal forwarded');
check('72 no-throw: converts errors to safe results (try/catch present)', /try\s*\{/.test(clientCode) && /catch/.test(clientCode), 'no-throw');
for (const s of ['disabled', 'token_bridge_disabled', 'no_session', 'no_token', 'cancelled', 'route_disabled', 'denied', 'resolved', 'unreachable', 'server_error', 'malformed']) {
  check(`72-phase shadow client classifies the '${s}' phase`, clientCode.includes(`'${s}'`), s);
}

// =============================================================================
// 11) No barrel export
// =============================================================================
check('73 no src/auth/index.ts barrel exists', !srcFiles.includes('src/auth/index.ts'), 'no barrel');

// =============================================================================
// 12) Self-inertness (non-circular allowlist + read-only fs + no env/side effects)
// =============================================================================
const selfSrc = read('scripts/diagnostics-session-resolve-shadow-client-dormant-check.ts');
const selfImports = [...selfSrc.matchAll(/^import[\s\S]*?from '([^']+)'/gm)].map((m) => m[1]);
const fsBindings = ((selfSrc.match(/import\s*\{([^}]*)\}\s*from\s*'fs'/) ?? ['', ''])[1]).split(',').map((s) => s.trim()).filter(Boolean);
const banned = ['child' + '_process', 'exec' + 'Sync', 'spawn' + '(', 'fetch' + '(', 'create' + 'Client', 'new ' + 'Pool'];
const selfBanned = banned.filter((t) => selfSrc.includes(t));
check('74a diagnostic imports confined to node fs/path', selfImports.length > 0 && selfImports.every((i) => i === 'fs' || i === 'path'), selfImports.join(', '));
check('74b diagnostic imports no frontend/server module (reads src/ as TEXT only)', !selfImports.some((i) => i.includes('/src/') || i.startsWith('src/') || i.includes('platform-identity')), 'text-only');
check('74c diagnostic uses fs read-only (readFileSync/readdirSync)', fsBindings.length > 0 && fsBindings.every((b) => b === 'readFileSync' || b === 'readdirSync'), fsBindings.join(','));
check('74d diagnostic accesses no environment variables', !/process\.env/.test(selfSrc), 'no env');
check('74e diagnostic is side-effect-free (no child process / network / DB)', selfBanned.length === 0, selfBanned.join(', ') || 'inert');

// =============================================================================
// Summary
// =============================================================================
const failed = results.filter((r) => !r.pass);
console.log(`\n[session-resolve-shadow-client-dormant-check] ${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length) process.exitCode = 1;

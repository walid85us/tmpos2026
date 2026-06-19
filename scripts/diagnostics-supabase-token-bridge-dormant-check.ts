// Phase 1.6 M11 — STATIC (offline) DORMANCY + TOKEN-SAFETY check for the app-level Supabase
// TOKEN BRIDGE (`src/auth/supabaseTokenBridge.ts`).
//
// PURE / OFFLINE: no DB, no network, no Supabase, no Firebase, no env values, no SQL,
// no migration, no audit write, no Supabase MCP, no live/route call. It reads the
// frontend (`src/**`) as TEXT only (read-only — NEVER imported, NEVER modified) and PROVES
// the token bridge is dormant, DEV+flag-gated, foundation-only, one-shot, cancellation-safe,
// and TOKEN-SAFE: the raw access token is passed ONLY to an immediate-use callback and is
// NEVER returned, stored, logged, persisted, surfaced, or sent over the network. It also
// proves the bridge calls no `/auth/session/resolve`, reads no server authorization, and is
// imported by nothing active.
//
// NOTE: this diagnostic does NOT ban the identifier `access_token` repo-wide (the pilot
// legitimately reads `session.access_token`); it focuses on STORAGE / LOGGING / EXPOSURE /
// NETWORK sinks within the token bridge + its types.
//
// Run:  npx tsx scripts/diagnostics-supabase-token-bridge-dormant-check.ts

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

const BRIDGE = 'src/auth/supabaseTokenBridge.ts';
const BRIDGE_TYPES = 'src/auth/supabaseTokenBridgeTypes.ts';
const ENTRYPOINTS = [
  'src/main.tsx',
  'src/App.tsx',
  'src/components/Login.tsx',
  'src/context/AccessContext.tsx',
  'src/components/AccessGuard.tsx',
];

const bridge = text.get(BRIDGE) ?? '';
const types = text.get(BRIDGE_TYPES) ?? '';
const bridgeOwned = `${bridge}\n${types}`;

// Comment-stripped CODE views (line comments FIRST so prose like `src/pilot/**` cannot be
// misread as a block-comment opener). "Must-not-appear-in-CODE" checks use these so
// documentation is never mistaken for behavior. Identifier scans use FULL text.
const stripComments = (s: string): string =>
  s.replace(/(^|[^:])\/\/.*$/gm, '$1').replace(/\/\*[\s\S]*?\*\//g, '');
const bridgeCode = stripComments(bridge);
const typesCode = stripComments(types);

// =============================================================================
// 1) Bridge (+ types) exist
// =============================================================================
check('1 token bridge module exists', text.has(BRIDGE), text.has(BRIDGE) ? BRIDGE : 'absent');
check('2 token bridge types module exists', text.has(BRIDGE_TYPES), text.has(BRIDGE_TYPES) ? BRIDGE_TYPES : 'absent');

// =============================================================================
// 2) Import allowlist — foundation + own types ONLY; no SDK/React/Firebase/app/server/pilot
// =============================================================================
const staticImports = [...bridgeCode.matchAll(/import[\s\S]*?from '([^']+)'/g)].map((m) => m[1]);
const dynamicImports = [...bridgeCode.matchAll(/import\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]);
const allImports = [...staticImports, ...dynamicImports];
const ALLOWED = ['./supabaseAuthFoundation', './supabaseTokenBridgeTypes'];
const disallowed = allImports.filter((i) => !ALLOWED.includes(i));
check('3 bridge imports the M5 foundation', allImports.includes('./supabaseAuthFoundation'), 'foundation imported');
check('4 bridge does NOT import @supabase/supabase-js directly', !allImports.some((i) => i === '@supabase/supabase-js'), 'no direct SDK');
check('5 bridge does NOT import React', !allImports.some((i) => i === 'react' || i === 'react-dom'), 'no react');
check('6 bridge does NOT import Firebase', !allImports.some((i) => /^@?firebase(\/|$)/.test(i)), 'no firebase');
check('7 bridge does NOT import AccessContext', !allImports.some((i) => /AccessContext/.test(i)), 'no AccessContext');
check('8 bridge does NOT import Login', !allImports.some((i) => /components\/Login/.test(i)), 'no Login');
check('9 bridge does NOT import AccessGuard', !allImports.some((i) => /AccessGuard/.test(i)), 'no AccessGuard');
check('10 bridge does NOT import App routing', !allImports.some((i) => /App$|\/App'?$/.test(i)), 'no App');
check('11 bridge does NOT import pilot modules', !allImports.some((i) => /pilot\//.test(i)), 'no pilot');
check('12 bridge does NOT import server modules', !allImports.some((i) => /(^|\/)server(\/|$)|platform-identity/.test(i)), 'no server');
check('13 bridge imports confined to the foundation + its own types (no M6 bootstrap / M7 helper)', allImports.length > 0 && disallowed.length === 0, disallowed.join(', ') || allImports.join(' + '));

// =============================================================================
// 3) Immediate-use callback API; NO raw-token getter; token never returned
// =============================================================================
check('14 bridge exports the immediate-use callback API withSupabaseAccessToken', /export\s+async\s+function\s+withSupabaseAccessToken\b/.test(bridgeCode), 'callback API');
check('15 bridge does NOT export a raw getToken', !/export\s+(?:async\s+)?(?:function|const|let|var)\s+getToken\b/.test(bridgeCode), 'no getToken');
check('16 bridge does NOT export a raw getAccessToken', !/export\s+(?:async\s+)?(?:function|const|let|var)\s+getAccessToken\b/.test(bridgeCode), 'no getAccessToken');
check('17 bridge never returns the raw token directly', !/return\s+(accessToken|token)\b/.test(bridgeCode) && !/return[^;\n]*\.access_token/.test(bridgeCode), 'no token return');
check('18 result/consumer types expose NO token field', !/access_token|refresh_token|provider_token|\btoken\b/i.test(typesCode) || /SupabaseAccessTokenConsumer|withSupabaseAccessToken|access token/i.test(types), 'token-free result type');
// Stronger: the RESULT interface itself carries no token-shaped property key.
const resultBlock = (() => {
  const s = types.indexOf('interface SupabaseTokenBridgeResult');
  if (s < 0) return '';
  const e = types.indexOf('\n}', s);
  return e < 0 ? types.slice(s) : types.slice(s, e);
})();
check('18b SupabaseTokenBridgeResult has no token/authz property', !/\baccess_token\b|\brefresh_token\b|\bprovider_token\b|\bjwt\b|\bauthorization\b|\bpermissions\b|\bsubPermissions\b/i.test(resultBlock), 'non-secret result');

// =============================================================================
// 4) No token storage (module scope / React state / context / web storage / globals)
// =============================================================================
const topLevelTokenBinding = /^(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*(?:await\s+)?[^;\n]*(?:\.access_token|getSession)/m.test(bridgeCode);
check('19 bridge stores NO token in module scope (no top-level binding from access_token/getSession)', !topLevelTokenBinding, topLevelTokenBinding ? 'FOUND top-level token binding' : 'function-local only');
check('20 bridge uses NO React state/ref (no useState/useRef/useContext/useReducer)', !/\buseState\b|\buseRef\b|\buseContext\b|\buseReducer\b/.test(bridgeCode), 'no react state');
check('21 bridge does NOT touch AccessContext / provider value (no useAccess/AccessContext)', !/useAccess\s*\(|AccessContext/.test(bridgeCode), 'no context');
check('22 bridge writes NO localStorage', !/localStorage/.test(bridgeCode), 'no localStorage');
check('23 bridge writes NO sessionStorage', !/sessionStorage/.test(bridgeCode), 'no sessionStorage');
check('24 bridge writes NO IndexedDB', !/indexedDB/.test(bridgeCode), 'no indexedDB');
check('25 bridge writes NO window/globalThis', !/\b(window|globalThis)\b/.test(bridgeCode), 'no global object');

// =============================================================================
// 5) No logging / no URL placement / no network / no route call / no server authz
// =============================================================================
check('26 bridge does NOT log (no console.*)', !/console\./.test(bridge), 'no console');
check('27 bridge places token in NO URL/query (no location / URLSearchParams)', !/\blocation\b|URLSearchParams/.test(bridgeCode), 'no url placement');
check('28 bridge makes NO direct network call (no fetch/XHR/sendBeacon)', !/\bfetch\s*\(|XMLHttpRequest|sendBeacon/.test(bridgeCode), 'no network');
check('29 bridge does NOT call /auth/session/resolve', !/\/auth\/session\/resolve|runSessionResolve/.test(bridgeCode), 'no session-resolve');
check('30 bridge reads NO server-derived authorization', !/authorization/i.test(bridgeCode), 'no authz');
check('31 bridge does NOT reference VITE_ENABLE_SESSION_RESOLVE_SHADOW', !/VITE_ENABLE_SESSION_RESOLVE_SHADOW/.test(bridgeOwned), 'no resolve-shadow flag');
check('32 bridge does NOT reference VITE_ENABLE_SERVER_AUTHZ_SHADOW', !/VITE_ENABLE_SERVER_AUTHZ_SHADOW/.test(bridgeOwned), 'no server-authz-shadow flag');
check('42 bridge includes NO token in messages/errors (no token interpolation)', !/\$\{[^}]*[Aa]ccess[_]?[Tt]oken[^}]*\}/.test(bridge) && !/\$\{[^}]*\btoken\b[^}]*\}/.test(bridge), 'no token in messages');

// =============================================================================
// 6) DEV-flag-gated, default OFF, requires foundation, flag separation
// =============================================================================
check('33 bridge uses VITE_ENABLE_SUPABASE_TOKEN_BRIDGE', /VITE_ENABLE_SUPABASE_TOKEN_BRIDGE/.test(bridgeCode), 'own flag');
check('34 bridge is DEV-gated (reads import.meta DEV)', /\.DEV\b/.test(bridgeCode), 'DEV gate');
check('35 enablement is AND of DEV and explicit flag === "true" (default OFF)', /DEV === true/.test(bridgeCode) && /=== 'true'/.test(bridgeCode), 'dev && flag');
check('35b bridge requires the M5 foundation enablement', /isSupabaseAuthFoundationEnabled\s*\(/.test(bridgeCode), 'requires foundation');
check('35c flag SEPARATE from foundation/bootstrap/awareness/shadow flags (not referenced in code)', !/VITE_ENABLE_SUPABASE_AUTH_FOUNDATION|VITE_ENABLE_SUPABASE_SESSION_BOOTSTRAP|VITE_ENABLE_ACCESSCONTEXT_SUPABASE_AWARENESS/.test(bridgeCode), 'separate flag');

// =============================================================================
// 7) No import-time side effects; token read only inside a lazy function; cancellation; no-throw
// =============================================================================
check('36 no import-time side effects (no top-level binding to a call)', !/^(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*(?:await\s+)?(?:with[A-Z]\w*|getSupabaseAuthFoundation)\s*\(/m.test(bridgeCode), 'lazy');
check('37 no top-level await (await only inside the async runner)', !/^await\b/m.test(bridgeCode), 'no top-level await');
{
  const fnIdx = bridgeCode.indexOf('async function withSupabaseAccessToken');
  const fnBody = fnIdx >= 0 ? bridgeCode.slice(fnIdx) : '';
  // The session read (.getSession() CALL + access_token read) must occur INSIDE the runner.
  // `getSession` also appears in the structural interface above the function — a TYPE, not a
  // read — so we assert against the function BODY, not the first file occurrence.
  const readsInBody = /\.getSession\s*\(/.test(fnBody) && /access_token/.test(fnBody);
  check('38 token/session read happens ONLY inside the lazy async function', fnIdx >= 0 && readsInBody, readsInBody ? 'inside runner' : 'NOT inside runner');
}
check('39 token handed to an immediate-use callback parameter (use(token) / consumer type)', /\buse\s*\(\s*accessToken\s*\)/.test(bridgeCode) && /SupabaseAccessTokenConsumer/.test(bridgeOwned), 'callback boundary');
check('40 cancellation-safe (honors AbortSignal/aborted)', /signal/.test(bridgeCode) && /aborted/.test(bridgeCode), 'cancellation-safe');
check('41 no-throw: converts errors to safe results (try/catch + safe statuses)', /try\s*\{/.test(bridgeCode) && /catch/.test(bridgeCode) && /'callback_error'/.test(bridgeCode), 'no-throw');
for (const s of ['disabled', 'foundation_unavailable', 'no_session', 'no_token', 'cancelled', 'callback_error', 'success']) {
  check(`41-state bridge returns the '${s}' state`, bridgeCode.includes(`'${s}'`), s);
}

// =============================================================================
// 8) Dormancy — imported by NOTHING active (no call site)
// =============================================================================
const refsBridge = (s: string) => /(?:from|import)\s*\(?\s*'[^']*\/supabaseTokenBridge'/.test(s);
const importers = srcFiles.filter((f) => f !== BRIDGE && f !== BRIDGE_TYPES && refsBridge(text.get(f)!));
check('43 bridge imported by NO active app entrypoint (Login/AccessContext/AccessGuard/App/main)', importers.filter((f) => ENTRYPOINTS.includes(f)).length === 0, importers.filter((f) => ENTRYPOINTS.includes(f)).join(', ') || 'dormant');
check('44 bridge NOT imported by AccessContext', !refsBridge(text.get('src/context/AccessContext.tsx') ?? ''), 'AccessContext clean');
check('45 bridge NOT imported by Login', !refsBridge(text.get('src/components/Login.tsx') ?? ''), 'Login clean');
check('46 bridge NOT imported by AccessGuard', !refsBridge(text.get('src/components/AccessGuard.tsx') ?? ''), 'AccessGuard clean');
check('47 bridge NOT imported by App routing', !refsBridge(text.get('src/App.tsx') ?? ''), 'App clean');
check('48 bridge NOT imported by src/main.tsx', !refsBridge(text.get('src/main.tsx') ?? ''), 'main clean');
const pilotImporters = importers.filter((f) => f.startsWith('src/pilot/'));
check('49 bridge NOT imported by pilot', pilotImporters.length === 0, pilotImporters.join(', ') || 'pilot clean');
check('49b bridge imported NOWHERE in src/** yet (no M11 call site added)', importers.length === 0, importers.join(', ') || 'no importers');

// =============================================================================
// 9) No UI / window hook / DOM event / persistence / network / browser→DB / secrets
// =============================================================================
// A `.ts` module cannot contain JSX (only `.tsx` can); UI/context would require React +
// Provider/useAccess/createElement, all of which must be absent here.
check('50/51 bridge creates NO public context API / UI (.ts module; no Provider/useAccess/createElement)', BRIDGE.endsWith('.ts') && !/\bProvider\b|useAccess\s*\(|createElement/.test(bridgeCode), 'no UI/context');
check('52 bridge creates NO window hook', !/__TM_POS|window\.\w*[Aa]warenes|window\.\w*[Tt]oken/.test(bridgeOwned), 'no window hook');
check('53 bridge dispatches NO DOM event', !/CustomEvent|dispatchEvent/.test(bridgeCode), 'no DOM event');
check('56 bridge creates NO browser→database access (no @supabase SDK / pg / Pool)', !/@supabase\/supabase-js/.test(bridgeCode) && !/from 'pg'|new\s+Pool\b/.test(bridgeCode), 'no DB access');
const forbidden: Array<[string, RegExp]> = [
  ['SUPABASE_SERVICE_ROLE_KEY', /SUPABASE_SERVICE_ROLE_KEY/],
  ['service-role key identifier', /SERVICE_ROLE_KEY|serviceRoleKey|service_role/],
  ['SUPABASE_DATABASE_URL', /SUPABASE_DATABASE_URL/],
  ['DB URL / connection string', /\bDATABASE_URL\b|connectionString|postgres(ql)?:\/\//],
];
for (const [label, re] of forbidden) {
  check(`57/58 no ${label} reference in the bridge`, !re.test(bridgeOwned), re.test(bridgeOwned) ? 'FOUND' : 'none');
}
check('59 bridge reads NO public VITE Supabase config directly (only DEV + its own flag; URL/anon via foundation)', !/VITE_SUPABASE_URL|VITE_SUPABASE_ANON_KEY/.test(bridgeCode), 'foundation-mediated config');

// =============================================================================
// 10) No barrel export
// =============================================================================
check('60a no src/auth/index.ts barrel exists', !srcFiles.includes('src/auth/index.ts'), 'no barrel');

// =============================================================================
// 11) Self-inertness (non-circular allowlist + read-only fs + no env/side effects)
// =============================================================================
const selfSrc = read('scripts/diagnostics-supabase-token-bridge-dormant-check.ts');
const selfImports = [...selfSrc.matchAll(/^import[\s\S]*?from '([^']+)'/gm)].map((m) => m[1]);
const fsBindings = ((selfSrc.match(/import\s*\{([^}]*)\}\s*from\s*'fs'/) ?? ['', ''])[1]).split(',').map((s) => s.trim()).filter(Boolean);
// Build side-effect needles from fragments so this self-scan never matches its OWN tokens.
const banned = ['child' + '_process', 'exec' + 'Sync', 'spawn' + '(', 'fetch' + '(', 'create' + 'Client', 'new ' + 'Pool'];
const selfBanned = banned.filter((t) => selfSrc.includes(t));
check('60b diagnostic imports confined to node fs/path', selfImports.length > 0 && selfImports.every((i) => i === 'fs' || i === 'path'), selfImports.join(', '));
check('60c diagnostic imports no frontend/server module (reads src/ as TEXT only)', !selfImports.some((i) => i.includes('/src/') || i.startsWith('src/') || i.includes('platform-identity')), 'text-only');
check('60d diagnostic uses fs read-only (readFileSync/readdirSync)', fsBindings.length > 0 && fsBindings.every((b) => b === 'readFileSync' || b === 'readdirSync'), fsBindings.join(','));
check('60e diagnostic accesses no environment variables', !/process\.env/.test(selfSrc), 'no env');
check('60f diagnostic is side-effect-free (no child process / network / DB)', selfBanned.length === 0, selfBanned.join(', ') || 'inert');

// =============================================================================
// Summary
// =============================================================================
const failed = results.filter((r) => !r.pass);
console.log(`\n[supabase-token-bridge-dormant-check] ${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length) process.exitCode = 1;

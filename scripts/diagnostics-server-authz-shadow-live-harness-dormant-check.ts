// Phase 1.6 M15 — STATIC (offline) DORMANCY + GATING / ONE-SHOT / RESULT-SAFETY check for the dormant
// GUARDED LIVE ONE-SHOT HARNESS (`src/auth/serverAuthzShadowLiveHarness.ts`).
//
// PURE / OFFLINE: no DB, no network, no Supabase, no Firebase, no env values, no SQL, no migration,
// no audit write, no Supabase MCP, no live/route call, no child process. It reads the frontend
// (`src/**`) as TEXT only (read-only — NEVER imported, NEVER modified) and PROVES the harness is:
// dormant (imported by nothing active, invoked by nothing), lazy (no import-time call, no top-level
// await), no-throw, confined to the M14 feed (+ own/shared types), FOUR-condition DEV-gated (DEV +
// feed-enabled + arming flag + EXACT owner confirmation; default OFF), owner-confirmation-safe (the
// phrase is compared by equality and NEVER printed/logged/returned — only booleans), one-shot
// (in-memory module-scoped guard only; no persisted marker), feed-invocation-confined (calls
// runServerAuthzShadowFeed ONLY inside the lazy exported one-shot fn), and RESULT-SAFE (no token /
// raw body / raw authorization DTO / identity / tenant / store / role / plan / level / confirmation
// phrase value).
//
// NOTE: this diagnostic scopes every assertion to the harness + its import/call graph. It does NOT
// add broad bans that would false-positive on existing pilot/M12/M13/M14 code.
//
// Run:  npx tsx scripts/diagnostics-server-authz-shadow-live-harness-dormant-check.ts

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

const HARNESS = 'src/auth/serverAuthzShadowLiveHarness.ts';
const HARNESS_TYPES = 'src/auth/serverAuthzShadowLiveHarnessTypes.ts';
const CONFIRMATION_PHRASE = 'I_APPROVE_M15_ONE_SHOT_SERVER_AUTHZ_SHADOW_FEED_DEV_ONLY';
const ENTRYPOINTS = [
  'src/main.tsx',
  'src/App.tsx',
  'src/components/Login.tsx',
  'src/context/AccessContext.tsx',
  'src/components/AccessGuard.tsx',
];

const harness = text.get(HARNESS) ?? '';
const types = text.get(HARNESS_TYPES) ?? '';

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
const harnessCode = stripComments(harness);
const harnessCodeNoStr = stripStrings(harnessCode);
const typesCode = stripComments(types);

// =============================================================================
// 1) Files exist
// =============================================================================
check('1 live harness module exists', text.has(HARNESS), text.has(HARNESS) ? HARNESS : 'absent');
check('2 live harness types module exists', text.has(HARNESS_TYPES), text.has(HARNESS_TYPES) ? HARNESS_TYPES : 'absent');

// =============================================================================
// 2) Import allowlist — the M14 feed + own/shared types ONLY
// =============================================================================
const staticImports = [...harnessCode.matchAll(/import[\s\S]*?from '([^']+)'/g)].map((m) => m[1]);
const dynamicImports = [...harnessCode.matchAll(/import\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]);
const allImports = [...staticImports, ...dynamicImports];
const ALLOWED = ['./serverAuthzShadowFeed', './serverAuthzShadowLiveHarnessTypes'];
const disallowed = allImports.filter((i) => !ALLOWED.includes(i));
check('3 harness imports the M14 feed helper', allImports.includes('./serverAuthzShadowFeed'), 'feed imported');
check('4 harness imports confined to the M14 feed + its own/shared types', allImports.length > 0 && disallowed.length === 0, disallowed.join(', ') || allImports.join(' + '));
check('5 harness does NOT import the M11 token bridge directly', !allImports.some((i) => /supabaseTokenBridge/.test(i)), 'no M11 direct');
check('6 harness does NOT import the M12 shadow client directly', !allImports.some((i) => /sessionResolveShadowClient/.test(i)), 'no M12 direct');
check('7 harness does NOT import the M13 comparison helper directly', !allImports.some((i) => /serverAuthzShadowComparison/.test(i)), 'no M13 direct');
check('8 harness does NOT import @supabase/supabase-js', !allImports.some((i) => i === '@supabase/supabase-js'), 'no SDK');
check('9 harness does NOT import React', !allImports.some((i) => i === 'react' || i === 'react-dom'), 'no react');
check('10 harness does NOT import Firebase', !allImports.some((i) => /^@?firebase(\/|$)/.test(i)), 'no firebase');
check('11 harness does NOT import server/backend modules', !allImports.some((i) => /(^|\/)server(\/|$)|platform-identity/.test(i)), 'no server');
check('12 harness does NOT import AccessContext', !allImports.some((i) => /context\/AccessContext/.test(i)), 'no AccessContext');
check('13 harness does NOT import Login', !allImports.some((i) => /components\/Login/.test(i)), 'no Login');
check('14 harness does NOT import AccessGuard', !allImports.some((i) => /AccessGuard/.test(i)), 'no AccessGuard');
check('15 harness does NOT import App routing', !allImports.some((i) => /(^|\/)App'?$/.test(i)), 'no App');
check('16 harness does NOT import src/main', !allImports.some((i) => /(^|\/)main(\.tsx)?'?$/.test(i)), 'no main');
check('17 harness does NOT import pilot modules', !allImports.some((i) => /pilot\//.test(i)), 'no pilot');
check('18 harness does NOT import the M5 foundation / M6 bootstrap / M7 awareness', !allImports.some((i) => /supabaseAuthFoundation|supabaseSessionBootstrap|supabaseAccessAwareness/.test(i)), 'feed-only reach');

// =============================================================================
// 3) No import-time side effects; lazy; no top-level await; no-throw
// =============================================================================
check('19 no top-level await (await only inside the async one-shot fn)', !/^await\b/m.test(harnessCode), 'no top-level await');
check('20 no import-time feed/arming call (no top-level binding to a call)',
  !/^(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*(?:await\s+)?(?:runServerAuthzShadowFeed|runServerAuthzShadowLiveOneShot|isServerAuthzShadowFeedEnabled|isServerAuthzShadowLiveOneShotArmed|evaluateArming|fetch)\s*\(/m.test(harnessCode),
  'lazy');
check('21 harness exports the lazy one-shot runServerAuthzShadowLiveOneShot', /export\s+async\s+function\s+runServerAuthzShadowLiveOneShot\b/.test(harnessCode), 'lazy exported one-shot');
check('22 harness exports the armed-check isServerAuthzShadowLiveOneShotArmed', /export\s+function\s+isServerAuthzShadowLiveOneShotArmed\b/.test(harnessCode), 'armed check');
check('23 harness is no-throw (no `throw` statement)', !/\bthrow\b/.test(harnessCode), 'no throw');

// =============================================================================
// 4) Dormancy — imported by NOTHING active; no active call site
// =============================================================================
const refsHarness = (s: string) => /(?:from|import)\s*\(?\s*'[^']*\/serverAuthzShadowLiveHarness'/.test(s);
const importers = srcFiles.filter((f) => f !== HARNESS && f !== HARNESS_TYPES && refsHarness(text.get(f)!));
check('24 harness imported by NO active app entrypoint (Login/AccessContext/AccessGuard/App/main)', importers.filter((f) => ENTRYPOINTS.includes(f)).length === 0, importers.filter((f) => ENTRYPOINTS.includes(f)).join(', ') || 'dormant');
check('25 harness NOT imported by AccessContext', !refsHarness(text.get('src/context/AccessContext.tsx') ?? ''), 'AccessContext clean');
check('26 harness NOT imported by Login', !refsHarness(text.get('src/components/Login.tsx') ?? ''), 'Login clean');
check('27 harness NOT imported by AccessGuard', !refsHarness(text.get('src/components/AccessGuard.tsx') ?? ''), 'AccessGuard clean');
check('28 harness NOT imported by App routing', !refsHarness(text.get('src/App.tsx') ?? ''), 'App clean');
check('29 harness NOT imported by src/main.tsx', !refsHarness(text.get('src/main.tsx') ?? ''), 'main clean');
const pilotImporters = importers.filter((f) => f.startsWith('src/pilot/'));
check('30 harness NOT imported by pilot', pilotImporters.length === 0, pilotImporters.join(', ') || 'pilot clean');
check('31 harness imported NOWHERE active in src/** (no M15 call site added)', importers.length === 0, importers.join(', ') || 'no importers');
const externalCallers = srcFiles
  .filter((f) => f !== HARNESS && f !== HARNESS_TYPES)
  .filter((f) => /runServerAuthzShadowLiveOneShot\s*\(|isServerAuthzShadowLiveOneShotArmed\s*\(/.test(stripComments(text.get(f)!)));
const selfRunCalls = (harnessCode.match(/runServerAuthzShadowLiveOneShot\s*\(/g) ?? []).length;
const declaresOnce = /function\s+runServerAuthzShadowLiveOneShot\s*\(/.test(harnessCode) && selfRunCalls === 1;
check('32 harness has NO active call site (declared once, never self-invoked, never called elsewhere)', externalCallers.length === 0 && declaresOnce, externalCallers.join(', ') || 'invoked by nothing');

// =============================================================================
// 5) Gating — DEV + feed-enabled + arming flag + EXACT owner confirmation; flag hygiene
// =============================================================================
check('33 harness uses the dedicated arming flag VITE_ENABLE_SERVER_AUTHZ_LIVE_ONE_SHOT', /VITE_ENABLE_SERVER_AUTHZ_LIVE_ONE_SHOT/.test(harnessCode), 'arming flag');
check('34 harness uses the owner confirmation env VITE_CONFIRM_SERVER_AUTHZ_LIVE_ONE_SHOT', /VITE_CONFIRM_SERVER_AUTHZ_LIVE_ONE_SHOT/.test(harnessCode), 'confirmation env');
check('35 harness is DEV-gated (reads import.meta DEV)', /import\.meta/.test(harnessCode) && /\.DEV\b/.test(harnessCode), 'DEV gate');
check('36 harness depends on the M14 feed enablement (isServerAuthzShadowFeedEnabled)', /isServerAuthzShadowFeedEnabled\s*\(/.test(harnessCode), 'feed-enabled gate');
check('37 arming flag is gated by === "true" (default OFF)', /VITE_ENABLE_SERVER_AUTHZ_LIVE_ONE_SHOT\s*===\s*'true'/.test(harnessCode), 'flag === true');
check('38 harness introduces NO unexpected VITE_ name in CODE (only the two M15 flags)', (() => {
  const names = [...new Set([...harnessCode.matchAll(/VITE_[A-Z0-9_]+/g)].map((m) => m[0]))].sort();
  const expected = ['VITE_CONFIRM_SERVER_AUTHZ_LIVE_ONE_SHOT', 'VITE_ENABLE_SERVER_AUTHZ_LIVE_ONE_SHOT'].sort();
  return names.length === expected.length && names.every((n, i) => n === expected[i]);
})(), 'two M15 flags only');

// =============================================================================
// 6) Owner-confirmation safety — exact phrase present; never printed/logged/returned; booleans only
// =============================================================================
check('39 harness contains the exact owner confirmation phrase', harness.includes(CONFIRMATION_PHRASE), 'phrase present');
check('40 harness compares the confirmation by EXACT equality (=== CONFIRMATION_PHRASE)', /===\s*CONFIRMATION_PHRASE/.test(harnessCode), 'exact equality');
check('41 the confirmation phrase literal appears EXACTLY once (the const; never duplicated/echoed)',
  (harness.match(new RegExp(CONFIRMATION_PHRASE, 'g')) ?? []).length === 1, 'single literal');
check('42 harness logs NOTHING (no console.*) — confirmation value cannot be printed', !/console\./.test(harness), 'no console');
{
  // The phrase const may appear ONLY in (a) its own declaration and (b) equality comparisons
  // (=== / !==). Any other use (e.g. returning/interpolating the phrase VALUE) is forbidden. This
  // correctly allows `matches: value === CONFIRMATION_PHRASE` (returns a BOOLEAN, not the phrase).
  const phraseUsages = (harnessCode.match(/CONFIRMATION_PHRASE/g) ?? []).length;
  const allowedUsages = (harnessCode.match(/const\s+CONFIRMATION_PHRASE\s*=|[!=]==\s*CONFIRMATION_PHRASE/g) ?? []).length;
  check('43 confirmation phrase const used ONLY for its declaration + equality compare (never returned/echoed)', phraseUsages > 0 && phraseUsages === allowedUsages, `${allowedUsages}/${phraseUsages} usages are declaration/equality`);
}
check('44 harness never returns the raw confirmation env value', !/\breturn\b[^;\n]*VITE_CONFIRM_SERVER_AUTHZ_LIVE_ONE_SHOT/.test(harnessCode), 'raw value not returned');
check('45 harness reports confirmation presence + match as BOOLEANS (confirmationPresent/confirmationMatches)',
  /confirmationPresent/.test(harnessCode) && /confirmationMatches/.test(harnessCode), 'boolean-only confirmation');

// =============================================================================
// 7) One-shot limiter — in-memory module-scoped guard ONLY; no persisted marker
// =============================================================================
check('46 harness has an in-memory one-shot guard (module-scoped `let hasRun`)', /let\s+hasRun\s*=\s*false/.test(harnessCode) && /\bhasRun\s*=\s*true\b/.test(harnessCode), 'in-memory guard');
check('47 harness returns an `already_ran` result on re-entry (no second feed call)', /'already_ran'/.test(harness), 'already_ran phase');
check('48 harness does NOT persist the one-shot marker (no localStorage/sessionStorage/IndexedDB)', !/localStorage|sessionStorage|indexedDB/.test(harnessCode), 'no web storage');
check('49 harness uses NO cookie marker', !/document\.cookie|\bcookie\b/i.test(harnessCode), 'no cookie');
check('50 harness uses NO file/DB marker (no fs/pg/Pool/getDb)', !/readFileSync|writeFileSync|from 'fs'|from 'pg'|new\s+Pool\b|getDb\s*\(/.test(harnessCode), 'no file/db marker');
check('51 harness uses NO window/globalThis marker', !/\b(window|globalThis)\b/.test(harnessCode), 'no global marker');

// =============================================================================
// 8) Feed-invocation confinement — feed called ONLY inside the lazy one-shot fn
// =============================================================================
{
  const fnIdx = harnessCode.indexOf('async function runServerAuthzShadowLiveOneShot');
  const fnBody = fnIdx >= 0 ? harnessCode.slice(fnIdx) : '';
  const feedCallsTotal = (harnessCode.match(/runServerAuthzShadowFeed\s*\(/g) ?? []).length;
  const feedCallsInFn = (fnBody.match(/runServerAuthzShadowFeed\s*\(/g) ?? []).length;
  check('52 harness invokes runServerAuthzShadowFeed EXACTLY once, ONLY inside the lazy one-shot fn',
    fnIdx >= 0 && feedCallsTotal === 1 && feedCallsInFn === 1,
    feedCallsTotal === 1 ? 'single confined call' : `${feedCallsTotal} call(s)`);
}
check('53 harness does NOT self-invoke the one-shot at module scope', !/^(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*(?:await\s+)?runServerAuthzShadowLiveOneShot\s*\(/m.test(harnessCode), 'no self-invoke');

// =============================================================================
// 9) No raw token / route / response / identity read (the harness only forwards a signal)
// =============================================================================
check('54 harness reads NO raw token (no access_token/refresh_token/accessToken/Bearer)',
  !/access_token|refresh_token|accessToken|refreshToken|\bBearer\b/.test(harnessCodeNoStr), 'token-free');
check('55 harness makes NO direct route call (no fetch/XHR/sendBeacon; reaches route only via the feed)',
  !/\bfetch\s*\(|XMLHttpRequest|sendBeacon/.test(harnessCode), 'no direct route');
check('56 harness does NOT extract identity fields (internalUserId/authProvider/authProviderUid/email/displayName/identity)',
  !/internalUserId|authProviderUid|authProvider|displayName|\bemail\b|\.identity\b/.test(harnessCodeNoStr), 'no identity');
check('57 harness does NOT read scope/tenant/store/roles (.scope/tenantId/storeId/.roles)',
  !/\.scope\b|tenantId|storeId|\.roles\b/.test(harnessCodeNoStr), 'no scope/tenant/store/roles');

// =============================================================================
// 10) Result safety — NON-SECRET type (no token/identity/tenant/store/role/plan/level/raw DTO/body/phrase)
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
  ['owner confirmation phrase value', new RegExp(CONFIRMATION_PHRASE)],
];
for (const [label, re] of RESULT_FORBIDDEN) {
  check(`58 harness result type carries NO ${label}`, !re.test(typesCode), re.test(typesCode) ? 'FOUND' : 'none');
}
check('59 harness result type includes safe structural fields (ok/phase/armed/alreadyRan/confirmationPresent/confirmationMatches/message/feed)',
  /\bok\b/.test(typesCode) && /\bphase\b/.test(typesCode) && /\barmed\b/.test(typesCode) && /alreadyRan/.test(typesCode) && /confirmationPresent/.test(typesCode) && /confirmationMatches/.test(typesCode) && /\bmessage\b/.test(typesCode) && /\bfeed\b/.test(typesCode), 'safe fields');
check('60 harness result `feed` is the M14 NON-SECRET feed result (or null), never a raw DTO',
  /feed:\s*ServerAuthzShadowFeedResult\s*\|\s*null/.test(types), 'feed = M14 result|null');

// =============================================================================
// 11) No UI / context API / provider / window / DOM event / persistence / enforcement
// =============================================================================
check('61 no UI (.ts module; no createElement/JSX)', HARNESS.endsWith('.ts') && !/createElement/.test(harnessCode), 'no UI');
check('62 no React state/context (no useState/useRef/useContext/useReducer/Provider)', !/\buseState\b|\buseRef\b|\buseContext\b|\buseReducer\b|\bProvider\b/.test(harnessCode), 'no react state/context');
check('63 no public context API (no useAccess/AccessContextType)', !/useAccess\s*\(|AccessContextType/.test(harnessCode), 'no context API');
check('64 no DOM event (no CustomEvent/dispatchEvent)', !/CustomEvent|dispatchEvent/.test(harnessCode), 'no DOM event');
check('65 no enforcement (no .decision/.allowed/allow|deny literals; no AccessContext permission fns)',
  !/\.decision\b|\.allowed\b|===\s*'allow'|===\s*'deny'|hasPermission\s*\(|checkSubPermission\s*\(|canAccess\s*\(|getPermissionLevel\s*\(/.test(harnessCodeNoStr), 'no enforcement');
check('66 no privileged secret reference (service-role / DB URL / connection string)', !/SUPABASE_SERVICE_ROLE_KEY|SERVICE_ROLE_KEY|serviceRoleKey|service_role|SUPABASE_DATABASE_URL|\bDATABASE_URL\b|connectionString|postgres(ql)?:\/\//.test(`${harness}\n${types}`), 'no secrets');
check('67 no browser→DB access (no @supabase SDK / pg / Pool)', !/@supabase\/supabase-js|from 'pg'|new\s+Pool\b/.test(harnessCode), 'no DB access');

// =============================================================================
// 12) No barrel export
// =============================================================================
check('68 no src/auth/index.ts barrel exists', !srcFiles.includes('src/auth/index.ts'), 'no barrel');

// =============================================================================
// 13) Self-inertness (non-circular allowlist + read-only fs + no env/side effects)
// =============================================================================
const selfSrc = read('scripts/diagnostics-server-authz-shadow-live-harness-dormant-check.ts');
const selfImports = [...selfSrc.matchAll(/^import[\s\S]*?from '([^']+)'/gm)].map((m) => m[1]);
const fsBindings = ((selfSrc.match(/import\s*\{([^}]*)\}\s*from\s*'fs'/) ?? ['', ''])[1]).split(',').map((s) => s.trim()).filter(Boolean);
const banned = ['child' + '_process', 'exec' + 'Sync', 'spawn' + '(', 'fetch' + '(', 'create' + 'Client', 'new ' + 'Pool'];
const selfBanned = banned.filter((t) => selfSrc.includes(t));
check('69a diagnostic imports confined to node fs/path', selfImports.length > 0 && selfImports.every((i) => i === 'fs' || i === 'path'), selfImports.join(', '));
check('69b diagnostic imports no frontend/server module (reads src/ as TEXT only)', !selfImports.some((i) => i.includes('/src/') || i.startsWith('src/') || i.includes('platform-identity')), 'text-only');
check('69c diagnostic uses fs read-only (readFileSync/readdirSync)', fsBindings.length > 0 && fsBindings.every((b) => b === 'readFileSync' || b === 'readdirSync'), fsBindings.join(','));
check('69d diagnostic accesses no environment variables', !/process\.env/.test(selfSrc), 'no env');
check('69e diagnostic is side-effect-free (no child process / network / DB)', selfBanned.length === 0, selfBanned.join(', ') || 'inert');

// =============================================================================
// Summary
// =============================================================================
const failed = results.filter((r) => !r.pass);
console.log(`\n[server-authz-shadow-live-harness-dormant-check] ${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length) process.exitCode = 1;

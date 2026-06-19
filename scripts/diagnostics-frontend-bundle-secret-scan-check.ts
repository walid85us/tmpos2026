// Phase 1.6 M5 — STATIC (offline) build-ARTIFACT secret scan for the emitted
// frontend bundle (`dist/**`).
//
// PURE / OFFLINE: no DB, no network, no Supabase, no Firebase, no env values, no SQL,
// no migration, no audit write, no Supabase MCP, no live/route call, and it NEVER
// runs a build itself. It inspects ONLY an EXISTING local build output (`dist/**`),
// reading emitted text artifacts to assert that NO privileged Supabase/DB secret
// pattern reached the browser bundle — the emitted-artifact complement to the M4
// SOURCE secret-safety diagnostic.
//
// SAFETY: prints ONLY pattern labels, counts, and filenames — NEVER the matched
// secret-like content. If `dist/**` is absent, it reports the bundle scan DEFERRED
// (exit 0) rather than failing — a missing build is not an M5 failure.
//
// Run:  npx tsx scripts/diagnostics-frontend-bundle-secret-scan-check.ts
//       (optionally after an offline `npm run build`)

import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();
const DIST = 'dist';

interface Result { name: string; pass: boolean; detail: string }
const results: Result[] = [];
function check(name: string, pass: boolean, detail = ''): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}
function note(msg: string): void {
  console.log(`NOTE  ${msg}`);
}

// -----------------------------------------------------------------------------
// Deferral: if there is no local build output, do not fail M5 — report and exit 0.
// -----------------------------------------------------------------------------
if (!existsSync(join(ROOT, DIST))) {
  note('No dist/** build output present — bundle-artifact secret scan DEFERRED.');
  note('Reason: this diagnostic never builds; run an offline `npm run build` first to enable it.');
  note('Source-level secret-safety remains covered by diagnostics-frontend-supabase-auth-readiness-check.ts.');
  console.log('\n[frontend-bundle-secret-scan-check] DEFERRED (no dist/); 0 checks failed.');
  process.exit(0);
}

// ---- collect emitted TEXT artifacts (skip binaries / large maps) -------------
const TEXT_EXT = /\.(js|mjs|cjs|css|html|json)$/;
function walk(relDir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(join(ROOT, relDir), { withFileTypes: true })) {
    const rel = `${relDir}/${e.name}`;
    if (e.isDirectory()) walk(rel, acc);
    else if (TEXT_EXT.test(e.name)) acc.push(rel);
  }
  return acc;
}
const distFiles = walk(DIST);
const distText = new Map<string, string>(distFiles.map((f) => [f, readFileSync(join(ROOT, f), 'utf8')]));
const totalBytes = distFiles.reduce((n, f) => n + statSync(join(ROOT, f)).size, 0);
note(`Scanning ${distFiles.length} emitted text artifact(s) under dist/ (${totalBytes} bytes).`);

/** Count matches across all artifacts; return [total, filenames] — NEVER content. */
function scan(re: RegExp): [number, string[]] {
  let total = 0;
  const where: string[] = [];
  for (const f of distFiles) {
    const m = distText.get(f)!.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'));
    if (m && m.length) { total += m.length; where.push(f); }
  }
  return [total, where];
}

// =============================================================================
// 1) No privileged Supabase / DB secret pattern in the emitted bundle
// =============================================================================
const forbidden: Array<[string, RegExp]> = [
  ['SUPABASE_SERVICE_ROLE_KEY name', /SUPABASE_SERVICE_ROLE_KEY/],
  ['service-role identifier', /service_role|serviceRoleKey|SERVICE_ROLE_KEY/],
  ['SUPABASE_DATABASE_URL name', /SUPABASE_DATABASE_URL/],
  ['DB URL / connection string', /\bDATABASE_URL\b|connectionString/],
  ['postgres connection URI', /postgres(ql)?:\/\//],
  ['server-only (non-VITE_) Supabase env name', /(?<!VITE_)SUPABASE_(URL|ANON_KEY|SERVICE_ROLE_KEY|DATABASE_URL|JWT_SECRET)/],
];
for (const [label, re] of forbidden) {
  const [count, where] = scan(re);
  check(`1 no ${label} in emitted bundle`, count === 0, count === 0 ? 'none' : `${count} match(es) in: ${where.join(', ')}`);
}

// =============================================================================
// 2) The dormant M5 foundation must NOT appear in the emitted bundle (tree-shaken)
// =============================================================================
const [foundCount, foundWhere] = scan(/supabaseAuthFoundation|getSupabaseAuthFoundation/);
check('2a dormant M5 foundation identifiers absent from emitted bundle (not reachable / tree-shaken)', foundCount === 0, foundCount === 0 ? 'absent' : `${foundCount} ref(s) in: ${foundWhere.join(', ')}`);

// Phase 1.6 M6 — the dormant session bootstrap (and its flag) must also be absent from
// the emitted bundle: nothing imports it, so it (and the foundation it imports) is
// tree-shaken out of production.
const [bootCount, bootWhere] = scan(/supabaseSessionBootstrap|VITE_ENABLE_SUPABASE_SESSION_BOOTSTRAP/);
check('2b dormant M6 session-bootstrap identifiers absent from emitted bundle (not reachable / tree-shaken)', bootCount === 0, bootCount === 0 ? 'absent' : `${bootCount} ref(s) in: ${bootWhere.join(', ')}`);

// Phase 1.6 M8 — the AccessContext awareness helper (and its flag) is now imported by
// AccessContext, but ONLY via a DEV+flag-gated DYNAMIC import. In a production build Vite
// folds `import.meta.env.DEV` to `false`, so the guarded branch (and its dynamic import) is
// dead-code-eliminated and the helper — plus the bootstrap/foundation it reaches and the
// awareness flag name — is tree-shaken OUT of the emitted bundle. This is the HARD M8 gate:
// the identifiers MUST be absent from production output even though AccessContext references
// the helper in DEV-only source.
const [awareCount, awareWhere] = scan(/supabaseAccessAwareness|VITE_ENABLE_ACCESSCONTEXT_SUPABASE_AWARENESS/);
check('2c M8 AccessContext awareness identifiers absent from emitted bundle (DEV-only dynamic import; production-excluded / tree-shaken)', awareCount === 0, awareCount === 0 ? 'absent' : `${awareCount} ref(s) in: ${awareWhere.join(', ')}`);

// Phase 1.6 M9 — additive future-proofing: the reserved (documented-only, NOT wired)
// diagnostic-surface flag and any DEV-only observer `window` hook must NEVER reach production.
// M9 wires neither, so both must be absent today; this check stays a guard if surfacing is
// ever (separately) approved behind the reserved flag.
const [surfCount, surfWhere] = scan(/VITE_ENABLE_ACCESSCONTEXT_SUPABASE_DIAGNOSTIC_SURFACE|__TM_POS_SUPABASE_AWARENESS__/);
check('2d M9 reserved diagnostic-surface flag + observer window-hook absent from emitted bundle', surfCount === 0, surfCount === 0 ? 'absent' : `${surfCount} ref(s) in: ${surfWhere.join(', ')}`);

// Phase 1.6 M11 — the dormant token bridge (and its flag) must also be absent from the
// emitted bundle: nothing active imports it, so it (and the foundation it reaches) is
// tree-shaken out of production. Identifiers checked: the module name, its callback API, and
// the DEV-only flag. (We deliberately do NOT ban `access_token` here — the pilot legitimately
// reads `session.access_token`; the token bridge's token-safety is proven statically by
// scripts/diagnostics-supabase-token-bridge-dormant-check.ts.)
const [bridgeCount, bridgeWhere] = scan(/supabaseTokenBridge|withSupabaseAccessToken|VITE_ENABLE_SUPABASE_TOKEN_BRIDGE/);
check('2e M11 dormant token-bridge identifiers + flag absent from emitted bundle (not reachable / tree-shaken)', bridgeCount === 0, bridgeCount === 0 ? 'absent' : `${bridgeCount} ref(s) in: ${bridgeWhere.join(', ')}`);

// Phase 1.6 M12 — the dormant session-resolve SHADOW client (and its flag) must also be absent
// from the emitted bundle: nothing active imports it, so it (and the token bridge + foundation it
// reaches) is tree-shaken out of production. Identifiers checked: the module name, its exported
// helper, and the DEV-only flag. (We deliberately do NOT ban `/auth/session/resolve`, `Authorization`,
// or `Bearer` here — the pilot legitimately uses them; the shadow client's route/token/response
// safety is proven statically by scripts/diagnostics-session-resolve-shadow-client-dormant-check.ts.)
const [shadowCount, shadowWhere] = scan(/sessionResolveShadowClient|runSessionResolveShadowCheck|VITE_ENABLE_SESSION_RESOLVE_SHADOW/);
check('2f M12 dormant session-resolve shadow-client identifiers + flag absent from emitted bundle (not reachable / tree-shaken)', shadowCount === 0, shadowCount === 0 ? 'absent' : `${shadowCount} ref(s) in: ${shadowWhere.join(', ')}`);

// =============================================================================
// 3) Out-of-scope NOTE: the pre-existing GEMINI_API_KEY Vite `define` (not an M5
//    concern). Report if its NAME survives; never print any value.
// =============================================================================
const [gemCount, gemWhere] = scan(/GEMINI_API_KEY/);
if (gemCount > 0) {
  note(`Pre-existing (out-of-scope) GEMINI_API_KEY name appears in: ${gemWhere.join(', ')} — see vite.config.ts \`define\`. Not an M5 item.`);
} else {
  note('No GEMINI_API_KEY name found in emitted bundle (out-of-scope check; informational only).');
}

// =============================================================================
// Summary
// =============================================================================
const failed = results.filter((r) => !r.pass);
console.log(`\n[frontend-bundle-secret-scan-check] ${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length) process.exitCode = 1;

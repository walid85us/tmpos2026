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

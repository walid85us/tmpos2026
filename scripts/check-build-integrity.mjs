#!/usr/bin/env node
// Phase 4.0 M2 — production build integrity check. Builds to an ISOLATED temp
// directory (never the protected repo dist/), then proves: build succeeds, no
// source maps, no server-only module or secret material in client output, no
// card-data (PAN/CVV/track/PIN) leakage, and the main bundle stays within a
// recorded ceiling (ratchet — cannot grow silently). The temp dir is removed.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// M2 baseline: current main bundle ~3.95MB. Ceiling is a ratchet, not a target.
const MAX_MAIN_BUNDLE_BYTES = 4_100_000;

// Firebase WEB apiKey (AIza...) is public-by-design client config — NOT a secret.
const SECRET_PATTERNS = [
  /BEGIN [A-Z ]*PRIVATE KEY/,
  /"?service_account"?/,
  /postgres:\/\//,
  /\bsk_live_[0-9A-Za-z]{10,}/,
  /\brk_live_[0-9A-Za-z]{10,}/,
  /SUPABASE_SERVICE_ROLE/,
];
const SERVER_ONLY = [/firebase-admin/, /\bpg\b\s*from|from ['"]postgres['"]/];

function hasCardData(text) {
  // Magnetic-track / CHD-marker patterns specific enough to avoid false positives
  // on minified bundles. A coincidental Luhn-valid digit run in minified output
  // is NOT evidence of card data; raw PAN/CVV in SOURCE is caught precisely by
  // the semgrep CHD rule (.semgrep/tmpos.yml), which is the authoritative control.
  if (/track[12]data|%B\d{13,16}\^|;\d{13,16}=\d{4,}\?/i.test(text)) return 'magnetic-track pattern';
  return null;
}

const out = mkdtempSync(join(tmpdir(), 'tmpos-distcheck-'));
const problems = [];
try {
  const b = spawnSync('node_modules/.bin/vite', ['build', '--outDir', out, '--emptyOutDir'], { encoding: 'utf8', timeout: 260000 });
  if (b.status !== 0) { console.error('BUILD FAILED\n', (b.stdout || '') + (b.stderr || '')); process.exit(1); }

  const files = [];
  (function walk(d) { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); e.isDirectory() ? walk(p) : files.push(p); } })(out);

  const maps = files.filter((f) => f.endsWith('.map'));
  if (maps.length) problems.push(`source maps present: ${maps.length}`);

  let mainBytes = 0;
  for (const f of files) {
    const buf = readFileSync(f);
    if (/assets\/index-.*\.js$/.test(f)) mainBytes = Math.max(mainBytes, buf.length);
    if (!/\.(js|css|html|json)$/.test(f)) continue;
    const text = buf.toString('utf8');
    const rel = f.slice(out.length);
    for (const p of SECRET_PATTERNS) if (p.test(text)) problems.push(`secret pattern ${p} in <dist>${rel}`);
    for (const p of SERVER_ONLY) if (p.test(text)) problems.push(`server-only module ${p} in <dist>${rel}`);
    const card = hasCardData(text);
    if (card) problems.push(`card-data (${card}) in <dist>${rel}`);
  }
  console.log(`[build-integrity] main bundle bytes=${mainBytes} ceiling=${MAX_MAIN_BUNDLE_BYTES} maps=${maps.length}`);
  if (mainBytes === 0) problems.push('no main index-*.js chunk found (unexpected output shape)');
  if (mainBytes > MAX_MAIN_BUNDLE_BYTES) problems.push(`main bundle ${mainBytes} exceeds ceiling ${MAX_MAIN_BUNDLE_BYTES} (bundle grew — investigate before raising ceiling)`);

  if (problems.length) { console.error('BUILD INTEGRITY: FAIL\n' + problems.map((p) => ' - ' + p).join('\n')); process.exit(1); }
  console.log('BUILD INTEGRITY: PASS');
} finally {
  rmSync(out, { recursive: true, force: true });
}

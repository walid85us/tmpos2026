#!/usr/bin/env node
// Phase 4.0 M2 — deterministic, non-watch runner for the existing tsx/node:test
// suites (BCP corpus, platform-identity, Firestore STATIC guard). Explicit
// discovery roots; excludes node_modules/dist/.git/agency-agents and the
// Firestore *emulator* suite (that runs separately via `firebase emulators:exec`).
// Fail-fast disabled (reports every failure); non-zero exit on any failure.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOTS = ['server', 'src', 'tests/firestore', 'tests/quality'];
const EXCLUDE_DIR = new Set(['node_modules', 'dist', '.git', 'agency-agents', '.cache']);
const isTest = (f) =>
  (f.endsWith('.test.ts') || f.endsWith('.test.mjs')) &&
  !f.endsWith('.emulator.test.mjs');

function walk(dir, acc) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    if (e.isDirectory()) { if (!EXCLUDE_DIR.has(e.name)) walk(join(dir, e.name), acc); }
    else if (isTest(e.name)) acc.push(join(dir, e.name));
  }
  return acc;
}

const files = ROOTS.flatMap((r) => walk(r, [])).sort();
let pass = 0, fail = 0;
const failed = [];
for (const f of files) {
  const r = spawnSync('node_modules/.bin/tsx', [f], { encoding: 'utf8', timeout: 90000 });
  if (r.status === 0) { pass++; }
  else {
    fail++; failed.push(f);
    process.stdout.write(`\nFAIL ${f}\n${((r.stdout || '') + (r.stderr || '')).slice(-1200)}\n`);
  }
}
console.log(`\n[run-tests] suites=${files.length} pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);

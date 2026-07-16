#!/usr/bin/env node
// Phase 4.0 M2 — forbidden-artifact guard. Fails if protected/generated files
// ever become git-tracked, or if .gitattributes appears. Runs in CI and locally.
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const problems = [];
if (existsSync('.gitattributes')) problems.push('.gitattributes must remain absent');

let tracked = [];
try { tracked = execSync('git ls-files', { encoding: 'utf8' }).split('\n').filter(Boolean); } catch { /* not a repo */ }

const FORBIDDEN = [
  /^agency-agents\//,
  /^goose-.*\.tar\.bz2$/,
  /^dist\//,
  /(^|\/)firebase-debug\.log$/,
  /(^|\/)firestore-debug\.log$/,
  /(^|\/)ui-debug\.log$/,
  /(^|\/)\.firebaserc$/,
  /(^|\/)coverage\//,
];
for (const t of tracked) for (const p of FORBIDDEN) if (p.test(t)) problems.push(`forbidden tracked file: ${t}`);

if (problems.length) { console.error('FORBIDDEN ARTIFACT CHECK: FAIL\n' + problems.map((p) => ' - ' + p).join('\n')); process.exit(1); }
console.log(`[forbidden-artifacts] tracked=${tracked.length} — PASS`);

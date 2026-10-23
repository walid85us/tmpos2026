// QA-INTERACTIVE containment: static proof that tests/qa/interactive/ cannot reach the production artifacts
// (src/, server/, the normal build configs, the production entry) or become production-eligible. Files are only read
// or imported; no server, build, database or browser starts. Config values are compared in-process, never printed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const QA = path.join(ROOT, 'tests/qa/interactive');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const json = (...p) => JSON.parse(read(...p));
const SOURCE = /\.(ts|tsx|js|mjs|cjs|jsx)$/;

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (SOURCE.test(e.name)) out.push(full);
  }
  return out;
}
const QA_REFS = ['tests/qa', 'qaFirebase', 'vite.qa.config', 'qa-firebase-config'];
const QA_ENV = ['QA_PUBLIC_ORIGIN', 'QA_PROJECT_ID', 'QA_RUN_ID'];
const offenders = (files, needles) =>
  files.filter((f) => { const t = fs.readFileSync(f, 'utf8'); return needles.some((n) => t.includes(n)); })
    .map((f) => path.relative(ROOT, f));

test('application source under src/ and server/ never imports or names the QA tooling', () => {
  const files = [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'server'))];
  assert.ok(files.length > 100, 'the scan must actually cover the source trees');
  assert.deepEqual(offenders(files, QA_REFS), []);
});

test('the normal build and test configs do not reach the QA files or tests/', () => {
  for (const f of ['vite.config.ts', 'vitest.config.ts', 'tsconfig.server.json', 'tsconfig.server.tenant.json']) {
    assert.deepEqual(QA_REFS.filter((n) => read(f).includes(n)), [], `${f} names a QA file`);
  }
  for (const f of ['tsconfig.server.json', 'tsconfig.server.tenant.json']) {
    const c = json(f);
    const entries = [...(c.files ?? []), ...(c.include ?? [])];
    assert.ok(entries.length > 0, `${f} lists its entry files`);
    assert.ok(entries.every((e) => e.startsWith('server/') && !e.includes('tests')), `${f} reaches outside server/`);
  }
  assert.deepEqual(json('tsconfig.server.json').exclude ?? [], []);
});

test('the production construction carries no token verifier and the QA verifier is unreachable from server/', async () => {
  const { PRODUCTION_CONSTRUCTION } = await import('../../server/entry/entryStartup.ts');
  assert.equal(Object.isFrozen(PRODUCTION_CONSTRUCTION), true);
  assert.equal('tokenVerifier' in PRODUCTION_CONSTRUCTION, false);
  assert.equal(PRODUCTION_CONSTRUCTION.tokenVerifier, undefined);
  assert.deepEqual(offenders(walk(path.join(ROOT, 'server')), ['createQaVerifier', ...QA_ENV]), []);
  assert.ok(fs.readFileSync(path.join(QA, 'verifier.mjs'), 'utf8').includes('createQaVerifier'), 'the guarded name still exists');
});

test('the development server keeps the API path guard and no longer allows every host', () => {
  const v = read('vite.config.ts');
  assert.ok(v.includes('tmpos-api-path-guard') && v.includes('createApiPathGuard'));
  assert.doesNotMatch(v, /allowedHosts\s*:\s*true/);
});

test('the QA bundle config swaps exactly two modules, reads no .env file, and uses demo-only config values', () => {
  const c = read('tests/qa/interactive/vite.qa.config.ts');
  const swapBlock = c.slice(c.indexOf('new Map(['), c.indexOf(']);', c.indexOf('new Map([')));
  assert.equal((swapBlock.match(/path\.join\(ROOT,/g) ?? []).length, 2);
  assert.ok(swapBlock.includes("'src/firebase.ts'") && swapBlock.includes("'firebase-applet-config.json'"));
  assert.match(c, /envDir:\s*HERE\b/);
  assert.deepEqual(fs.readdirSync(QA).filter((n) => n.startsWith('.env')), []);

  const qa = json('tests/qa/interactive/qa-firebase-config.json');
  const prod = json('firebase-applet-config.json');
  assert.deepEqual(Object.keys(qa).sort(), Object.keys(prod).sort());
  assert.match(String(qa.projectId), /^demo-/);
  const prodValues = new Set(Object.values(prod).filter((x) => x !== '' && x != null));
  const shared = Object.keys(qa).filter((k) => prodValues.has(qa[k]));
  assert.deepEqual(shared, [], 'a QA config value equals a production config value (keys listed, values withheld)');
});

test('the QA emulator config binds every emulator to loopback and disables the UI', () => {
  const { emulators } = json('tests/qa/interactive/firebase.qa.json');
  assert.equal(emulators.ui.enabled, false);
  const bound = Object.entries(emulators).filter(([, v]) => v && typeof v === 'object' && !('enabled' in v));
  assert.ok(bound.length >= 2, 'auth and firestore are configured');
  for (const [name, v] of bound) assert.equal(v.host, '127.0.0.1', `${name} is not bound to loopback`);
});

test('the QA emulator config names exactly the auth and firestore emulators', () => {
  const { emulators } = json('tests/qa/interactive/firebase.qa.json');
  // hub, logging and ui are the suite's own infrastructure, not emulators; singleProjectMode is a flag.
  const named = Object.keys(emulators).filter((k) => !['hub', 'logging', 'ui', 'singleProjectMode'].includes(k)).sort();
  assert.deepEqual(named, ['auth', 'firestore']);
});

test('neither .replit nor the CI workflow mentions the QA tooling', () => {
  for (const f of ['.replit', '.github/workflows/ci.yml']) {
    const t = read(f); // read only
    assert.deepEqual(['tests/qa', 'qa:interactive'].filter((n) => t.includes(n)), [], `${f} names the QA tooling`);
  }
});

test('only the qa:interactive script runs the QA tooling, and it runs only the CLI', () => {
  const { scripts } = json('package.json');
  assert.equal(scripts['qa:interactive'], 'node tests/qa/interactive/cli.mjs');
  const others = Object.entries(scripts).filter(([k, v]) => k !== 'qa:interactive' && v.includes('tests/qa'));
  assert.deepEqual(others.map(([k]) => k), []);
});

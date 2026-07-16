// Phase 4.0 M2 — tests for the typecheck contract checker.
//
// The checker exists to stop the typecheck ratchet from silently degrading, so these
// tests assert the two degradation modes actually fail closed (missing React types,
// a config outside the repository) and that neither a nested working directory nor an
// unrelated strict parent tsconfig can change which config is selected.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  REPO_ROOT,
  isInsideRepo,
  inspectTypecheckContract,
  formatSummary,
} from '../../scripts/check-typecheck-contract.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const CHECKER = join(REPO, 'scripts', 'check-typecheck-contract.mjs');
const created = [];

/** A minimal stand-in repository: real tsconfig + real typescript, React types optional. */
function makeFixture({ react = true, reactDom = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tc-contract-'));
  created.push(dir);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', private: true }));
  copyFileSync(join(REPO, 'tsconfig.json'), join(dir, 'tsconfig.json'));
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  symlinkSync(join(REPO, 'node_modules', 'typescript'), join(dir, 'node_modules', 'typescript'), 'dir');
  const types = join(dir, 'node_modules', '@types');
  if (react) {
    mkdirSync(join(types, 'react'), { recursive: true });
    writeFileSync(join(types, 'react', 'index.d.ts'), 'export {};\n');
  }
  if (reactDom) {
    mkdirSync(join(types, 'react-dom'), { recursive: true });
    writeFileSync(join(types, 'react-dom', 'index.d.ts'), 'export {};\n');
  }
  return dir;
}

test.after(() => {
  for (const d of created) rmSync(d, { recursive: true, force: true });
});

test('selects the repository tsconfig and resolves both React type packages', () => {
  const { ok, problems, summary } = inspectTypecheckContract(REPO_ROOT);
  assert.equal(problems.length, 0, `unexpected problems: ${problems.join('; ')}`);
  assert.equal(ok, true);
  assert.equal(summary.selectedConfig, 'tsconfig.json');
  assert.equal(summary.reactTypesPresent, true);
  assert.equal(summary.reactDomTypesPresent, true);
  assert.equal(summary.moduleResolution, 'Bundler');
  assert.equal(summary.jsx, 'ReactJSX');
});

test('fails closed when @types/react is missing', () => {
  const { ok, problems } = inspectTypecheckContract(makeFixture({ react: false }));
  assert.equal(ok, false);
  assert.ok(problems.some((p) => p.includes('@types/react is not installed')));
});

test('fails closed when @types/react-dom is missing', () => {
  const { ok, problems } = inspectTypecheckContract(makeFixture({ reactDom: false }));
  assert.equal(ok, false);
  assert.ok(problems.some((p) => p.includes('@types/react-dom is not installed')));
});

test('rejects a configuration that escapes the repository', () => {
  assert.equal(isInsideRepo(REPO_ROOT, join(REPO_ROOT, 'tsconfig.json')), true);
  assert.equal(isInsideRepo(REPO_ROOT, resolve(REPO_ROOT, '..', 'tsconfig.json')), false);
  assert.equal(isInsideRepo(REPO_ROOT, '/etc/tsconfig.json'), false);
  assert.equal(isInsideRepo(REPO_ROOT, REPO_ROOT), false);
});

test('selection is unaffected by a nested working directory', () => {
  const nested = join(REPO, 'src', 'components');
  const r = spawnSync(process.execPath, [CHECKER], { cwd: nested, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /selected config\s+tsconfig\.json/);
  assert.match(r.stdout, /typecheck-contract: OK/);
});

test('an unrelated strict parent tsconfig cannot hijack the selected config', () => {
  const parent = mkdtempSync(join(tmpdir(), 'tc-parent-'));
  created.push(parent);
  writeFileSync(join(parent, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true } }));
  const nested = join(parent, 'nested');
  mkdirSync(nested, { recursive: true });
  const r = spawnSync(process.execPath, [CHECKER], { cwd: nested, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /selected config\s+tsconfig\.json/);
  // The repository posture is non-strict; the strict parent must not leak in.
  assert.match(r.stdout, /strict\s+false/);
});

test('output is bounded: no absolute paths, no file list, no environment', () => {
  const { summary } = inspectTypecheckContract(REPO_ROOT);
  const out = formatSummary(summary);
  assert.ok(!out.includes(REPO_ROOT), 'must not leak the absolute repository path');
  assert.ok(!out.includes('/home/'), 'must not leak absolute paths');
  assert.ok(!out.includes('node_modules'), 'must not leak dependency paths');
  assert.ok(!/\.tsx\b/.test(out), 'must not print the TypeScript file list');
  assert.ok(out.split('\n').length <= 12, 'summary must stay bounded');
});

test('reports the committed non-strict posture honestly rather than failing on it', () => {
  const { ok, summary } = inspectTypecheckContract(REPO_ROOT);
  assert.equal(ok, true, 'strict:false must not fail the contract');
  assert.equal(typeof summary.strict, 'boolean');
  assert.equal(summary.strict, false);
  assert.equal(summary.noImplicitAny, false);
  assert.equal(summary.strictNullChecks, false);
});

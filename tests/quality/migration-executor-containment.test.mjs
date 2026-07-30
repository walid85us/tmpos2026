// Phase 4.0 M3 S1b — trusted-executor containment.
//
// The migration executor is the ONE module that opens a database connection and runs migration
// SQL. It is a short-lived OPERATOR capability, not an application capability, so the production
// application server must not be able to reach it — not by import, not by bundling, not by a
// transitive edge through a shared helper.
//
// This suite walks the real static import graph from the production server entrypoint and proves
// the executor (and the database driver it uses) is unreachable, that the compiled server build
// cannot contain it, and that the public S1 entry point stays fail-closed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');

const EXECUTOR = 'server/platform-identity/migrationExecutor.ts';
/** The compiled production API runtime: everything tsconfig.server.json emits. */
const PRODUCTION_ROOT = 'server/runtime';
/** The production server's entrypoint, where the import-graph walk starts. */
const PRODUCTION_ENTRY = 'server/runtime/server.ts';

const read = (p) => readFileSync(join(REPO, p), 'utf8');

/** Drop comments so a denylist never trips on prose that merely NAMES the contained module. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

/** Static AND dynamic import/require specifiers referenced by a source file. */
function importSpecifiers(source) {
  const specs = [];
  const re = /\bfrom\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]|\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(source)) !== null) specs.push(m[1] || m[2] || m[3]);
  return specs;
}

/** Tracked source files under the given prefixes, via git so node_modules is never walked. */
function trackedSources(...prefixes) {
  const out = execFileSync('git', ['ls-files', '-z', ...prefixes], { cwd: REPO, encoding: 'utf8' });
  return out
    .split('\0')
    .filter((p) => /\.(ts|tsx|mjs|cjs|js|jsx)$/.test(p))
    .filter((p) => existsSync(join(REPO, p)));
}

/** Files present on disk under the given prefixes, tracked or not — an untracked module must not
 *  be able to slip past the containment check merely by not being committed yet. */
function localSources(...prefixes) {
  const tracked = new Set(trackedSources(...prefixes));
  const out = execFileSync('git', ['ls-files', '-z', '--others', '--exclude-standard', ...prefixes], {
    cwd: REPO,
    encoding: 'utf8',
  });
  for (const p of out.split('\0')) {
    if (/\.(ts|tsx|mjs|cjs|js|jsx)$/.test(p) && existsSync(join(REPO, p))) tracked.add(p);
  }
  return [...tracked];
}

const isFile = (abs) => {
  try {
    return statSync(abs).isFile();
  } catch {
    return false;
  }
};

/** Resolve a relative specifier to a repo-relative file path, trying the usual extensions. */
function resolveLocal(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(join(REPO, fromFile)), spec);
  // A NodeNext source imports './config.js' from './config.ts'; without this the walk stops at
  // the entrypoint and the containment assertion becomes vacuously true.
  const tsTwin = base.replace(/\.(js|mjs|cjs)$/, '.ts');
  for (const cand of [base, tsTwin, `${base}.ts`, `${base}.tsx`, `${base}.mjs`, `${base}.js`, join(base, 'index.ts')]) {
    if (isFile(cand)) return cand.slice(REPO.length + 1);
  }
  return null;
}

/** Every repo file transitively reachable from `entry` through local imports. */
function reachableFrom(entry) {
  const seen = new Set();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    let src;
    try {
      src = stripComments(read(file));
    } catch {
      continue;
    }
    for (const spec of importSpecifiers(src)) {
      const local = resolveLocal(file, spec);
      if (local !== null && !seen.has(local)) queue.push(local);
    }
  }
  return seen;
}

test('the executor exists and is the module under containment', () => {
  assert.ok(existsSync(join(REPO, EXECUTOR)), `${EXECUTOR} must exist`);
  assert.ok(existsSync(join(REPO, PRODUCTION_ENTRY)), `${PRODUCTION_ENTRY} must exist`);
});

test('S1b-25: the production application-server import graph cannot reach migrationExecutor', () => {
  const reachable = reachableFrom(PRODUCTION_ENTRY);
  assert.ok(reachable.size > 1, 'the graph walk must actually traverse imports');
  assert.equal(
    reachable.has(EXECUTOR),
    false,
    `the production server graph reached the executor via: ${[...reachable].join(', ')}`,
  );
});

test('S1b-25: no production runtime or frontend source names the executor at all', () => {
  const offenders = [];
  for (const file of localSources(PRODUCTION_ROOT, 'src')) {
    const src = stripComments(read(file));
    if (src.includes('migrationExecutor')) offenders.push(file);
  }
  assert.deepEqual(offenders, [], 'production runtime/frontend code must not reference the executor');
});

test('S1b-25: the PostgreSQL driver has a declared, unchanged set of importers', () => {
  // The application's own data layer legitimately holds a runtime client; that is a DIFFERENT
  // principal from the migrator and is out of S1b scope. What must not happen is a NEW driver
  // importer appearing unnoticed — especially one inside the production runtime graph. So the
  // inventory is asserted exactly, and each entry is named with the reason it is allowed.
  const APPLICATION_RUNTIME_CLIENTS = [
    'server/platform-identity/authorizationRepository.ts', // request-time authorization reads
    'server/platform-identity/db.ts',                      // application runtime connection pool
  ];
  const importers = [];
  for (const file of localSources('server')) {
    const src = stripComments(read(file));
    for (const spec of importSpecifiers(src)) {
      if (spec === 'postgres' || spec === 'pg') { importers.push(file); break; }
    }
  }
  assert.deepEqual(
    importers.sort(),
    [...APPLICATION_RUNTIME_CLIENTS, EXECUTOR].sort(),
    'a new PostgreSQL driver importer appeared under server/ and must be reviewed',
  );
  assert.ok(importers.includes(EXECUTOR), 'the executor is the migrator-side driver importer');

  // The decisive property: NOTHING in the compiled production runtime graph imports a driver
  // through the executor. The application clients above are not reachable from it either.
  const reachable = reachableFrom(PRODUCTION_ENTRY);
  for (const client of [...APPLICATION_RUNTIME_CLIENTS, EXECUTOR]) {
    assert.equal(reachable.has(client), false, `${client} must not be reachable from the production entrypoint`);
  }
});

test('S1b-25: the compiled production build cannot contain the executor', () => {
  const cfg = JSON.parse(read('tsconfig.server.json'));
  assert.equal(cfg.compilerOptions.rootDir, PRODUCTION_ROOT, 'the emitting build is rooted at the runtime only');
  assert.deepEqual(cfg.include, [`${PRODUCTION_ROOT}/**/*.ts`], 'the build includes only the production runtime');
  assert.ok(
    !EXECUTOR.startsWith(`${PRODUCTION_ROOT}/`),
    'the executor lives outside the emitting root, so tsc cannot emit it',
  );
});

test('S1b-25: only the operator CLI and the test suites may import the executor', () => {
  const importers = [];
  for (const file of localSources('server', 'src', 'scripts', 'tests')) {
    if (file === EXECUTOR) continue;
    const src = stripComments(read(file));
    for (const spec of importSpecifiers(src)) {
      if (spec.includes('migrationExecutor')) { importers.push(file); break; }
    }
  }
  const allowed = new Set([
    'scripts/supabase-migrate.ts',
    'server/platform-identity/migrationExecutor.test.ts',
    'tests/db/migrationEngine.integration.test.mjs',
  ]);
  const unexpected = importers.filter((f) => !allowed.has(f));
  assert.deepEqual(unexpected, [], `unexpected importer(s) of the executor: ${unexpected.join(', ')}`);
});

test('S1b-26: the public S1 runMigrations entry point is still an unconditional refusal', () => {
  const engine = read('server/platform-identity/migrationEngine.ts');
  assert.match(
    engine,
    /export async function runMigrations\([\s\S]{0,2000}?throw engineError\(ENGINE_CODES\.MIGRATION_EXECUTION_UNAVAILABLE\)/,
    'runMigrations must still throw before reading any argument',
  );
  // The kernel must stay database-free: no driver import, no connection string, no SQL execution.
  const code = stripComments(engine);
  for (const forbidden of ["from 'postgres'", "require('postgres')", '.unsafe(', 'DATABASE_URL']) {
    assert.ok(!code.includes(forbidden), `the pure kernel must not contain ${forbidden}`);
  }
});

test('S1b: the executor never reads an ambient application DSN', () => {
  const code = stripComments(read(EXECUTOR));
  for (const forbidden of ['SUPABASE_DATABASE_URL', 'APP_DATABASE_URL']) {
    assert.ok(!code.includes(forbidden), `the executor must never name ${forbidden}`);
  }
  // `DATABASE_URL` may appear only as the tail of the one variable it is allowed to read.
  const dsnReads = code.match(/[A-Z_]*DATABASE_URL/g) ?? [];
  assert.deepEqual([...new Set(dsnReads)], ['TM_POS_TEST_DATABASE_URL'], 'exactly one DSN variable may be named');
});

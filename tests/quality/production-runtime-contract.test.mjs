// Phase 4.0 M3 - production runtime contract test (deterministic, gate suite).
//
// Proves the secure deployable skeleton's PRODUCTION contract without a network
// or provider: (1) a compiled Node start contract (node against emitted JS, no
// tsx/vite/watch); (2) an emitting server tsconfig that excludes tests; (3) the
// runtime source imports no legacy sidecar / provider / business module; (4) the
// compiled artifact emits runnable JS, no test files, and no forbidden import;
// (5) generated output is gitignored so it can never be staged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const RUNTIME_DIR = join(REPO, 'server', 'runtime');

// Legacy sidecars, providers, and business modules that must NEVER reach the
// compiled production runtime.
const FORBIDDEN = [
  'credential-store', 'event-processor', 'safe-log', 'platform-identity',
  'bcp-pilot', 'firebase-admin', 'firebase', 'postgres', '@supabase', 'supabase',
  '/index',
];

function runtimeSourceFiles() {
  const out = [];
  (function walk(d) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) out.push(p);
    }
  })(RUNTIME_DIR);
  return out;
}

/** Import/export specifiers referenced by a source file, static AND dynamic. */
function importSpecifiers(source) {
  const specs = [];
  const re = /\bfrom\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]|\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(source)) !== null) specs.push(m[1] || m[2] || m[3]);
  return specs;
}

test('package.json defines a compiled production build + node start contract', () => {
  const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
  const build = pkg.scripts['build:server'];
  const start = pkg.scripts['start'];
  assert.ok(build, 'build:server script must exist');
  assert.match(build, /tsc\b[^&|]*tsconfig\.server\.json/, 'build:server must compile tsconfig.server.json');
  assert.doesNotMatch(build, /\b(tsx|ts-node|vite|vitest)\b|--watch/, 'build must not use a dev runner/watcher');
  assert.ok(start, 'start script must exist');
  assert.match(start, /\bnode\b/, 'start must run node');
  assert.match(start, /dist-server\//, 'start must run the emitted entry');
  assert.doesNotMatch(start, /\b(tsx|ts-node|vite|vitest|nodemon)\b|--watch/, 'start must not use a dev runner/watcher');
});

test('tsconfig.server.json emits JS, excludes tests, targets the runtime only', () => {
  const cfg = JSON.parse(readFileSync(join(REPO, 'tsconfig.server.json'), 'utf8'));
  const co = cfg.compilerOptions || {};
  assert.notEqual(co.noEmit, true, 'server config must emit');
  assert.ok(co.outDir, 'server config must set an outDir');
  assert.ok((cfg.include || []).some((p) => p.includes('server/runtime')), 'must include server/runtime');
  assert.ok((cfg.exclude || []).some((p) => /test/.test(p)), 'tests must be excluded from the artifact');
});

test('runtime source imports no legacy sidecar, provider, or business module', () => {
  const files = runtimeSourceFiles();
  assert.ok(files.length >= 5, 'expected the runtime module set');
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    for (const spec of importSpecifiers(src)) {
      // The forbidden-name check applies to EVERY specifier, relative or bare
      // (a same-directory ./credential-store.js must fail too).
      for (const bad of FORBIDDEN) assert.ok(!spec.includes(bad), `${f}: forbidden import ${spec}`);
      if (spec.startsWith('.')) {
        assert.ok(!spec.includes('..'), `${f}: relative import escapes server/runtime: ${spec}`);
        continue;
      }
      const allowed = spec.startsWith('node:') || spec === 'express';
      assert.ok(allowed, `${f}: non-allowlisted bare import: ${spec}`);
    }
  }
});

test('the compiled artifact emits runnable JS, excludes tests, and has no forbidden import', () => {
  const out = mkdtempSync(join(tmpdir(), 'tmpos-runtime-build-'));
  try {
    const r = spawnSync('node_modules/.bin/tsc', ['-p', 'tsconfig.server.json', '--outDir', out], {
      cwd: REPO, encoding: 'utf8', timeout: 120000,
    });
    assert.equal(r.status, 0, `server build must succeed:\n${(r.stdout || '') + (r.stderr || '')}`);

    const emitted = [];
    (function walk(d) {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p); else emitted.push(p);
      }
    })(out);

    const js = emitted.filter((f) => f.endsWith('.js'));
    assert.ok(js.length > 0, 'server build must emit JavaScript');
    assert.ok(js.some((f) => /(^|\/)server\.js$/.test(f)), 'the production entry server.js must be emitted');
    assert.ok(!emitted.some((f) => /\.test\.js$/.test(f)), 'test files must not be compiled into the artifact');

    for (const f of js) {
      const src = readFileSync(f, 'utf8');
      for (const bad of FORBIDDEN) assert.ok(!src.includes(bad), `${f}: emitted artifact references forbidden ${bad}`);
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('the compiled entry actually runs under node and fails closed on missing config', () => {
  // Build to the in-repo outDir so the emitted ESM can resolve `express` from
  // node_modules, then execute it under plain node (not tsx) with NO classification:
  // it must fail closed (exit 1) and emit the sanitized config-invalid event.
  const build = spawnSync('node_modules/.bin/tsc', ['-p', 'tsconfig.server.json'], { cwd: REPO, encoding: 'utf8', timeout: 120000 });
  try {
    assert.equal(build.status, 0, `server build must succeed:\n${(build.stdout || '') + (build.stderr || '')}`);
    const entry = join(REPO, 'dist-server', 'server.js');
    assert.ok(existsSync(entry), 'dist-server/server.js must exist');
    const env = { ...process.env };
    delete env.NODE_ENV;
    delete env.PORT;
    const run = spawnSync('node', [entry], { cwd: REPO, encoding: 'utf8', timeout: 20000, env });
    assert.equal(run.status, 1, `missing-config start must exit 1:\n${run.stdout}\n${run.stderr}`);
    const out = (run.stdout || '') + (run.stderr || '');
    assert.match(out, /startup_config_invalid/, 'must emit the sanitized config-invalid event');
    assert.doesNotMatch(out, /at Object|node_modules\/|SyntaxError/, 'must not leak a stack trace');
  } finally {
    rmSync(join(REPO, 'dist-server'), { recursive: true, force: true });
  }
});

test('generated server output is gitignored so it can never be staged', () => {
  const gi = readFileSync(join(REPO, '.gitignore'), 'utf8');
  assert.match(gi, /^dist-server\/?\s*$/m, 'dist-server must be gitignored');
  assert.ok(existsSync(join(REPO, 'tsconfig.server.json')), 'server build config must exist');
});

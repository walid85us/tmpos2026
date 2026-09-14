// Phase 4.0 M3 - production runtime contract test (deterministic, gate suite).
//
// Proves the secure deployable skeleton's PRODUCTION contract without a network
// or provider: (1) a compiled Node start contract (node against emitted JS, no
// tsx/vite/watch); (2) an emitting server tsconfig that excludes tests; (3) the
// runtime source imports no legacy sidecar / provider / business module; (4) the
// compiled artifact emits runnable JS, no test files, and no forbidden import;
// (5) generated output is gitignored so it can never be staged; (6) routes reach
// the runtime only through the central route table and the shared enforcement
// chain, and that chain ships in the artifact; (7) request bodies reach handlers
// only through the per-route body policy (no body parser, no parsed-body property);
// (8) the production entry composes no session boundary, store or DEV adapter, and a
// session identifier is read from the Cookie header only; (9) the in-memory session
// store is test support that never ships in the artifact and is unreachable from the
// provider-aware production composition root.
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
      assert.ok(f.endsWith('.testkit.ts') || !spec.includes('.testkit'), `${f}: a production module imports test support: ${spec}`);
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
    for (const mod of ['app.js', 'routes.js', 'access.js', 'requestSecurity.js', 'rateLimit.js', 'clientAddress.js', 'securityHeaders.js', 'sessions.js', 'deadline.js', 'idempotency.js', 'keyMaterial.js', 'commandTransaction.js', 'outbox.js']) {
      assert.ok(js.some((f) => f.endsWith(`/${mod}`)), `the shared enforcement chain must ship in the artifact: ${mod}`);
    }
    assert.ok(!emitted.some((f) => /\.test\.js$/.test(f)), 'test files must not be compiled into the artifact');
    assert.ok(!emitted.some((f) => /\.testkit\.js$/.test(f)), 'test support (the in-memory session store and rate limiter) must not be compiled into the artifact');

    for (const f of js) {
      const src = readFileSync(f, 'utf8');
      for (const bad of FORBIDDEN) assert.ok(!src.includes(bad), `${f}: emitted artifact references forbidden ${bad}`);
      assert.ok(!src.includes('createMemorySessionStore'), `${f}: the artifact carries no in-memory session store`);
      assert.ok(!/createMemoryRateLimiter|assertRateLimiterContract/.test(src), `${f}: the artifact carries no per-process rate limiter`);
      assert.ok(!/createMemoryIdempotencyStore|assertIdempotencyStoreContract/.test(src), `${f}: the artifact carries no per-process idempotency store`);
      assert.ok(!/createMemoryCommandTransaction|createMemoryOutboxDeliveryStore|assertCommandTransactionContract|assertOutboxDeliveryContract/.test(src),
        `${f}: the artifact carries no per-process transaction port or outbox`);
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

test('routes reach the runtime only through the central route table and shared chain', () => {
  // Static half of the route inventory (the behavioural half lives in
  // server/runtime/enforcement.test.ts): no runtime source registers an Express route,
  // a Router, or a path-mounted middleware — each would sit outside the enforced chain.
  const REGISTRATION = /\b(?:app|router)\s*\.\s*(?:get|post|put|patch|delete|all|options|head|route)\s*\(\s*['"`]\/|\bRouter\s*\(|\.use\s*\(\s*['"`]\//;
  for (const f of runtimeSourceFiles()) {
    assert.doesNotMatch(readFileSync(f, 'utf8'), REGISTRATION, `${f}: routes may only be declared through defineRoutes`);
  }
  assert.match(readFileSync(join(RUNTIME_DIR, 'app.ts'), 'utf8'), /\bdefineRoutes\(/, 'app.ts must build its surface from the central route table');
});

test('request bodies reach handlers only through the per-route body policy', () => {
  // No body parser and no parsed-body property anywhere in the runtime: a JSON body is
  // read only by the bounded, post-authorization reader in the shared chain.
  const PARSER = /\bexpress\s*\.\s*(?:json|raw|text|urlencoded)\b|\bbody-?parser\b|\breq\s*\.\s*body\b/i;
  for (const f of runtimeSourceFiles()) {
    assert.doesNotMatch(readFileSync(f, 'utf8'), PARSER, `${f}: bodies may only be read through the per-route policy`);
  }
  assert.match(readFileSync(join(RUNTIME_DIR, 'app.ts'), 'utf8'), /\breadBoundedBody\(/, 'app.ts must read bodies through the bounded reader');
});

test('the production entry composes no session boundary, store or DEV adapter', () => {
  // The provider-free entry serves the operational routes only; the provider-aware composition
  // root (server/composition) is the one production path to a session boundary (next test).
  const entry = readFileSync(join(RUNTIME_DIR, 'server.ts'), 'utf8');
  assert.doesNotMatch(entry, /\bsessions\s*:|createMemorySessionStore|DevDiagnostic|devActor|stubFirebase/,
    'server.ts must compose no session boundary, session store or DEV adapter');
  // A session identifier is read from the Cookie header only — never a URL, parameter or body.
  const sessions = readFileSync(join(RUNTIME_DIR, 'sessions.ts'), 'utf8');
  assert.doesNotMatch(sessions, /\breq(?:uest)?\s*\.\s*(?:query|params|url|originalUrl|body)\b/, 'sessions.ts must read identifiers from the Cookie header only');
});

test('the provider-aware production composition root reaches no test module, testkit or in-memory store', () => {
  // Static proof, not an identity check: walk every relative import from the composition root
  // and require that no test file, test support module or test double is reachable from it.
  const COMPOSITION_DIR = join(REPO, 'server', 'composition');
  const roots = readdirSync(COMPOSITION_DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts')).map((f) => join(COMPOSITION_DIR, f));
  assert.ok(roots.length >= 1, 'the production composition root exists');
  const graph = new Set();
  const pending = [...roots];
  while (pending.length > 0) {
    const file = pending.pop();
    if (graph.has(file)) continue;
    graph.add(file);
    assert.doesNotMatch(file, /\.test\.[cm]?[jt]s$|\.testkit\.ts$/, `${file}: a test module in the production graph`);
    const src = readFileSync(file, 'utf8');
    assert.doesNotMatch(src, /createMemorySessionStore|createMemoryRateLimiter|createMemoryIdempotencyStore|createMemoryCommandTransaction|createMemoryOutboxDeliveryStore|devDiagnosticAuthAdapter|stubFirebaseAuthAdapter/, `${file}: a test or DEV double in the production graph`);
    for (const spec of importSpecifiers(src)) {
      if (!spec.startsWith('.')) continue;
      const base = resolve(dirname(file), spec);
      const target = [base.replace(/\.js$/, '.ts'), `${base}.ts`].find((p) => existsSync(p));
      assert.ok(target, `${file}: unresolved import ${spec}`);
      pending.push(target);
    }
  }
  const reached = [...graph].map((f) => f.slice(REPO.length + 1));
  assert.ok(reached.includes('server/runtime/sessions.ts'), 'the root composes through the runtime session ports');
  assert.ok(reached.includes('server/platform-identity/firebaseAdminAuthAdapter.ts'), 'the root composes the existing identity-provider adapter');
});

test('the in-memory session store is imported by test files only, anywhere in the server tree', () => {
  // Covers any future entry outside server/composition that might hand the test store to assembleSessions.
  const offenders = [];
  (function walk(d) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); continue; }
      if (!/\.[cm]?[jt]s$/.test(p) || /\.test\.[cm]?[jt]s$/.test(p) || p.endsWith('.testkit.ts')) continue;
      if (importSpecifiers(readFileSync(p, 'utf8')).some((s) => ['memorySessionStore.testkit', 'rateLimiter.testkit', 'idempotencyStore.testkit', 'transactionalOutbox.testkit'].some((kit) => s.includes(kit)))) offenders.push(p);
    }
  })(join(REPO, 'server'));
  assert.deepEqual(offenders, [], 'only test files may import the in-memory session store or rate limiter');
});

test('no per-process limiter, fallback or second proxy contract exists in the production runtime or composition', () => {
  // M6-RATE-P1: the distributed limiter port is the only way the runtime counts requests, and the
  // trusted-proxy contract (clientAddress.ts) is the only reader of forwarding headers.
  const production = [...runtimeSourceFiles().filter((f) => !f.endsWith('.testkit.ts')),
    ...readdirSync(join(REPO, 'server', 'composition')).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts')).map((f) => join(REPO, 'server', 'composition', f))];
  for (const f of production) {
    const src = readFileSync(f, 'utf8');
    assert.doesNotMatch(src, /createMemoryRateLimiter|\bclientKeyOf\b|\bloginClientLimiter\b|\bloginAccountLimiter\b/, `${f}: a per-process or per-boundary limiter`);
    assert.doesNotMatch(src, /\breq(?:uest)?\s*\.\s*ips?\b/, `${f}: req.ip follows Express trust-proxy, never the contract`);
    if (!/[\\/](?:app|clientAddress)\.ts$/.test(f)) {
      assert.doesNotMatch(src, /['"`](?:x-forwarded-for|forwarded|x-real-ip)['"`]/i, `${f}: forwarding headers are read by the trusted-proxy contract alone`);
    }
  }
  const app = readFileSync(join(RUNTIME_DIR, 'app.ts'), 'utf8');
  assert.deepEqual([...app.matchAll(/\bset\(\s*'trust proxy'\s*,\s*([^)]*)\)/g)].map((m) => m[1].trim()), ['false'], 'Express trust proxy is off, unconditionally');
  // Only the composition root hands the runtime its limiter: nothing else assembles production parts.
  const assemblers = [];
  (function walk(d) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); continue; }
      if (/\.[cm]?[jt]s$/.test(p) && !/\.test\.[cm]?[jt]s$/.test(p) && /\bassembleSessions\s*\(/.test(readFileSync(p, 'utf8'))) assemblers.push(p.slice(REPO.length + 1));
    }
  })(join(REPO, 'server'));
  assert.deepEqual(assemblers, ['server/composition/productionSessions.ts'], 'assembleSessions is called by the composition root alone');
});

test('durable idempotency has no production store, no production route that requires it, and no database or provider adapter', () => {
  // M6-IDEMPOT-P2: the port is provider-independent; its only store is test support, the composition
  // root binds none, and nothing in the production graph registers a route that requires one.
  const production = [...runtimeSourceFiles().filter((f) => !f.endsWith('.testkit.ts')),
    ...readdirSync(join(REPO, 'server', 'composition')).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts')).map((f) => join(REPO, 'server', 'composition', f))];
  // A registration, never the type that names the value or a comment that explains it.
  const REQUIRED_ROUTE = /(?<!readonly )\bidempotency\s*:\s*['"`]required['"`]/;
  for (const sample of ["{ idempotency: 'required', perform }", 'idempotency:"required"']) assert.match(sample, REQUIRED_ROUTE, `the scan must catch: ${sample}`);
  for (const f of production) {
    const code = readFileSync(f, 'utf8').replace(/\/\/.*$/gm, ''); // code only: a comment may name what it explains
    assert.doesNotMatch(code, /createMemoryIdempotencyStore|assertIdempotencyStoreContract|idempotencyStore\.testkit/, `${f}: a per-process idempotency store in production`);
    assert.doesNotMatch(code, REQUIRED_ROUTE, `${f}: a production route requires idempotency`);
  }
  const root = readFileSync(join(REPO, 'server', 'composition', 'productionSessions.ts'), 'utf8');
  assert.match(root, /\bidempotencyStore:\s*null,/, 'the approved-adapter table binds no idempotency store');
  const port = readFileSync(join(RUNTIME_DIR, 'idempotency.ts'), 'utf8');
  assert.deepEqual(importSpecifiers(port).filter((s) => !s.startsWith('node:')).sort(), ['./deadline.js', './keyMaterial.js', './routes.js', './routes.js'],
    'the idempotency port imports node built-ins and the runtime only: no database, migration or provider adapter');
  const entry = readFileSync(join(RUNTIME_DIR, 'server.ts'), 'utf8');
  assert.doesNotMatch(entry, /\bidempotency\b|\btransactions\b|\bevents\s*:|\broutes\s*:/,
    'the production entry composes no idempotency, transaction port, event contract or further route: the probes and the bounded fallback only');
});

test('the transactional outbox has no production adapter, worker, database, network client or SQL, and the adapter table stays closed', () => {
  // M6-OUTBOX-P3: the transaction and delivery ports are provider-independent; their only adapters are test
  // support; the composition root binds neither; no production module names a delivery entry point or holds an
  // interval timer (a self-rescheduling setTimeout is left to review); and a command route — which must declare
  // idempotency: 'required' — is already refused by the scan above.
  // Every production source file under server/, recursively — the runtime, the composition root and every other tree —
  // tests and testkits aside, so a new module anywhere is scanned too.
  const production = [];
  (function walk(d) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.[cm]?[jt]s$/.test(p) && !/\.(test|testkit)\.[cm]?[jt]s$/.test(p)) production.push(p);
    }
  })(join(REPO, 'server'));
  assert.ok(production.includes(join(RUNTIME_DIR, 'outbox.ts')) && production.includes(join(REPO, 'server', 'composition', 'productionSessions.ts')),
    'the scan reaches the runtime and the composition root');
  const codeOf = (file) => readFileSync(file, 'utf8').replace(/\/\/.*$/gm, ''); // code only: a comment may name what it explains
  const DOUBLES = /createMemoryCommandTransaction|createMemoryOutboxDeliveryStore|createMemoryTransactionalHarness|assertCommandTransactionContract|assertOutboxDeliveryContract|transactionalOutbox\.testkit/;
  const WORKER = /\b(?:deliverOutboxBatch|claimOutbox|acknowledgeOutbox|retryOutbox|deadLetterOutbox|createOutboxDelivery)\b/;
  const TIMER = /\bsetInterval\b/;
  const SQL = /\binsert\s+into\b|\bdelete\s+from\b|\bupdate\s+\w+\s+set\b|\bselect\s+[\w*,\s]+\bfrom\b|\bsql\s*`|\.unsafe\s*\(/i;
  for (const sample of ['deliverOutboxBatch(delivery, publish)', "import { deliverOutboxBatch as pass } from './outbox.js'", 'claimOutbox(delivery, request, 1000)',
    "const endpoint = 'https://broker'; deliverOutboxBatch(delivery, publish);"]) {
    assert.match(sample, WORKER, `the scan must catch: ${sample}`);
  }
  for (const sample of ['setInterval(tick, 1000)', 'const every = setInterval;', "import { setInterval as every } from 'node:timers/promises'"]) {
    assert.match(sample, TIMER, `the scan must catch: ${sample}`);
  }
  for (const sample of ['INSERT INTO outbox', 'update item set name = $1', 'select id, name from item', 'sql`select 1`', 'db.unsafe(query)']) assert.match(sample, SQL, `the scan must catch: ${sample}`);
  for (const f of production) {
    const code = codeOf(f);
    assert.doesNotMatch(code, DOUBLES, `${f}: an in-memory transaction port or outbox in production`);
    // outbox.ts defines the delivery entry points; no other production module names one (an aliased import included),
    // and no production module, outbox.ts included, holds an interval timer. Both scans read the whole source — comments
    // and strings included, since stripping `//` would also strip a URL's tail — and no production file names either.
    const source = readFileSync(f, 'utf8');
    if (f !== join(RUNTIME_DIR, 'outbox.ts')) assert.doesNotMatch(source, WORKER, `${f}: a delivery pass in production`);
    assert.doesNotMatch(source, TIMER, `${f}: an interval timer in production`);
  }
  // The two contracts import node built-ins and the runtime only — no database, network or provider client — and hold no SQL.
  const imports = (name) => importSpecifiers(readFileSync(join(RUNTIME_DIR, name), 'utf8')).sort();
  assert.deepEqual(imports('outbox.ts'), ['./deadline.js', './routes.js', 'node:crypto']);
  assert.deepEqual(imports('commandTransaction.ts'), ['./deadline.js', './idempotency.js', './idempotency.js', './outbox.js', './outbox.js', './routes.js', './routes.js', 'node:crypto', 'node:util']);
  for (const name of ['outbox.ts', 'commandTransaction.ts']) assert.doesNotMatch(codeOf(join(RUNTIME_DIR, name)), SQL, `${name}: SQL text in a provider-independent contract`);
  // The approved-adapter table stays closed: no transaction port or outbox slot, nothing bound, nothing composed.
  const root = readFileSync(join(REPO, 'server', 'composition', 'productionSessions.ts'), 'utf8');
  const table = /const PRODUCTION_ADAPTERS[^=]*=\s*Object\.freeze\(\{([\s\S]*?)\n\}\);/.exec(root);
  assert.ok(table, 'the approved-adapter table exists');
  assert.deepEqual([...table[1].matchAll(/^\s*(\w+):/gm)].map((m) => m[1]), ['store', 'admission', 'authorizer', 'limiter', 'idempotencyStore'],
    'the approved-adapter table holds no transaction or outbox adapter');
  assert.match(table[1], /\blimiter:\s*null,\s*idempotencyStore:\s*null,/, 'and binds no limiter or idempotency store');
  for (const f of readdirSync(join(REPO, 'server', 'composition')).filter((n) => /\.[cm]?[jt]s$/.test(n) && !/\.test\./.test(n))) {
    assert.doesNotMatch(codeOf(join(REPO, 'server', 'composition', f)), /commandTransaction|outbox|transactions\s*:|events\s*:/i,
      `${f}: no composition file composes a transaction port, outbox or event contract`);
  }
});

test('the production entry and composition root compose no Command Center route or reader', () => {
  // The Command Center read model stays uncomposed until an authoritative reader exists and the
  // admin boundary has its production adapters (durable store, admission, authorizer, and the
  // store compare-and-set that closes the admission-revalidation race): only tests build it.
  // Every relative import is followed, so a transitive import fails too; a computed specifier
  // would hide from the walk, so the production graph may hold none.
  const roots = [join(RUNTIME_DIR, 'server.ts')];
  (function walk(d) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.[cm]?[jt]s$/.test(p) && !/\.test\.[cm]?[jt]s$/.test(p)) roots.push(p);
    }
  })(join(REPO, 'server', 'composition'));
  assert.ok(roots.length >= 2, 'the production entry and the composition root exist');
  const COMMAND_CENTER = /command[-_]?center/i;
  const COMPUTED = /\b(?:import|require)\s*\(\s*[^'"\s)]/;
  const reached = new Set();
  const pending = [...roots];
  while (pending.length > 0) {
    const file = pending.pop();
    if (reached.has(file)) continue;
    reached.add(file);
    assert.doesNotMatch(file, COMMAND_CENTER, `${file}: the Command Center is in the production graph`);
    const src = readFileSync(file, 'utf8');
    assert.doesNotMatch(src, COMPUTED, `${file}: a computed import could hide a module from this walk`);
    for (const spec of importSpecifiers(src)) {
      assert.doesNotMatch(spec, COMMAND_CENTER, `${file} must not import the Command Center read model`);
      if (!spec.startsWith('.')) continue;
      const base = resolve(dirname(file), spec);
      const target = [base.replace(/\.js$/, '.ts'), `${base}.ts`].find((p) => existsSync(p));
      assert.ok(target, `${file}: unresolved import ${spec}`);
      pending.push(target);
    }
  }
  assert.ok(reached.has(join(RUNTIME_DIR, 'app.ts')), 'the walk reaches the runtime it guards');
});

test('the admin console and admin web server write no HTML string into the page and evaluate no strings', () => {
  // G-WEBHARDEN (M4-ADMIN-UI-P2): React renders every value as text, and nothing on the admin
  // surface may bypass that. A positive control runs first, so a broken pattern cannot pass.
  const SINKS = [
    /dangerouslySetInnerHTML/, /\b(?:inner|outer)HTML\b/, /\binsertAdjacentHTML\b/, /\bdocument\.write(?:ln)?\b/,
    /\bcreateContextualFragment\b/, /\bsrcdoc\b/i, /\beval\s*\(/, /\bFunction\s*\(/, /\bset(?:Timeout|Interval)\s*\(\s*['"`]/,
    /javascript:/i,
  ];
  const control = [
    '<div dangerouslySetInnerHTML={x} />', 'el.innerHTML = x', "el['innerHTML'] = x", 'el.outerHTML = x',
    "el.insertAdjacentHTML('beforeend', x)", 'document.write(x)', 'range.createContextualFragment(x)',
    '<iframe srcdoc={x} />', '<iframe srcDoc={x} />', 'eval(x)', "new Function('return 1')", "Function('return 1')()",
    "setTimeout('run()', 10)", 'setInterval(`tick()`, 10)', '<a href="javascript:void 0">',
  ];
  for (const sample of control) assert.ok(SINKS.some((re) => re.test(sample)), `the scan must catch: ${sample}`);
  const consoleDir = join(REPO, 'src', 'backend-control-plane', 'console');
  const files = [
    join(REPO, 'src', 'main.tsx'),
    ...['adminWeb.ts', 'adminWebServer.ts', 'commandCenter.ts'].map((f) => join(RUNTIME_DIR, f)),
    ...readdirSync(consoleDir, { recursive: true }).filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f)).map((f) => join(consoleDir, f)),
  ];
  assert.ok(files.some((f) => f.endsWith('CommandCenterPage.tsx')) && files.some((f) => f.endsWith('SignInScreen.tsx')), 'the console sources are scanned');
  const hits = files.flatMap((f) => {
    const src = readFileSync(f, 'utf8');
    return SINKS.filter((re) => re.test(src)).map((re) => `${f.slice(REPO.length + 1)}: ${re}`);
  });
  assert.deepEqual(hits, [], 'no unsafe-HTML sink or string evaluation on the admin surface');
});

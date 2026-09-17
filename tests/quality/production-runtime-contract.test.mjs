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
// provider-aware production composition root; (10) the M6 PostgreSQL store is composed by the
// transaction root alone, for a route that requires idempotency (none yet), over a kernel only
// the database-client boundary builds, with no migration authority and nothing in the artifact.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';

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

test('durable idempotency is composed only by the transaction root, for a route that requires it: no production route requires one, and its port imports no database or provider adapter', () => {
  // M6-IDEMPOT-P2, M6-PG-P7-R1: the port is provider-independent; the transaction root (productionTransactions.ts) is the one
  // production authority for it, composing the approved PostgreSQL store only for a route in its inventory that requires
  // idempotency — and nothing in the production graph registers such a route yet.
  const COMPOSITION_DIR = join(REPO, 'server', 'composition');
  const production = [...runtimeSourceFiles().filter((f) => !f.endsWith('.testkit.ts')),
    ...readdirSync(COMPOSITION_DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts')).map((f) => join(COMPOSITION_DIR, f))];
  // A registration, never the type that names the value or a comment that explains it.
  const REQUIRED_ROUTE = /(?<!readonly )\bidempotency\s*:\s*['"`]required['"`]/;
  for (const sample of ["{ idempotency: 'required', perform }", 'idempotency:"required"']) assert.match(sample, REQUIRED_ROUTE, `the scan must catch: ${sample}`);
  for (const f of production) {
    const code = readFileSync(f, 'utf8').replace(/\/\/.*$/gm, ''); // code only: a comment may name what it explains
    assert.doesNotMatch(code, /createMemoryIdempotencyStore|assertIdempotencyStoreContract|idempotencyStore\.testkit/, `${f}: a per-process idempotency store in production`);
    assert.doesNotMatch(code, REQUIRED_ROUTE, `${f}: a production route requires idempotency`);
  }
  const INVENTORY = /^export const PRODUCTION_INVENTORY: TransactionInventory = Object\.freeze\(\{ routes: Object\.freeze\(\[\]\), mutators: Object\.freeze\(\[\]\) \}\);$/m;
  assert.doesNotMatch("export const PRODUCTION_INVENTORY: TransactionInventory = Object.freeze({ routes: Object.freeze([ORDERS]), mutators: Object.freeze([]) });", INVENTORY,
    'the scan must catch a route added to the inventory');
  assert.match(readFileSync(join(COMPOSITION_DIR, 'productionTransactions.ts'), 'utf8'), INVENTORY, 'the production inventory holds no route and no mutator yet');
  // IDEMPOTENCY_KEY and APP_DATABASE_URL belong to the transaction root alone in the composition layer.
  const OWNED = /\bIDEMPOTENCY_KEY\b|\bAPP_DATABASE_URL(?:_VAR)?\b|\bidempotencyStore\b|\bIdempotencyDeps\b/;
  for (const sample of ['env.IDEMPOTENCY_KEY', 'env[APP_DATABASE_URL_VAR]', 'idempotencyStore: null,']) assert.match(sample, OWNED, `the scan must catch: ${sample}`);
  for (const f of readdirSync(COMPOSITION_DIR).filter((n) => n.endsWith('.ts') && !n.endsWith('.test.ts') && n !== 'productionTransactions.ts')) {
    assert.doesNotMatch(readFileSync(join(COMPOSITION_DIR, f), 'utf8').replace(/\/\/.*$/gm, ''), OWNED, `${f}: only the transaction root composes idempotency or reads its configuration`);
  }
  const port = readFileSync(join(RUNTIME_DIR, 'idempotency.ts'), 'utf8');
  assert.deepEqual(importSpecifiers(port).filter((s) => !s.startsWith('node:')).sort(), ['./deadline.js', './keyMaterial.js', './routes.js', './routes.js'],
    'the idempotency port imports node built-ins and the runtime only: no database, migration or provider adapter');
  const entry = readFileSync(join(RUNTIME_DIR, 'server.ts'), 'utf8');
  assert.doesNotMatch(entry, /\bidempotency\b|\btransactions\b|\bevents\s*:|\broutes\s*:/,
    'the production entry composes no idempotency, transaction port, event contract or further route: the probes and the bounded fallback only');
});

test('the transactional outbox has no bound production adapter and no worker, its contracts hold no database, network client or SQL, and the adapter table stays closed', () => {
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
  // M5-ID-P1: the command contract now carries a trusted scope, so it imports the principals module —
  // types plus the one guard that refuses a scope server-derived selection could not have produced.
  assert.deepEqual(imports('commandTransaction.ts'), ['./deadline.js', './idempotency.js', './idempotency.js', './outbox.js', './outbox.js', './principals.js', './principals.js', './routes.js', './routes.js', 'node:crypto', 'node:util']);
  for (const name of ['outbox.ts', 'commandTransaction.ts']) assert.doesNotMatch(codeOf(join(RUNTIME_DIR, name)), SQL, `${name}: SQL text in a provider-independent contract`);
  // The sessions root's approved-adapter table stays closed: no idempotency, transaction or outbox slot, and nothing bound.
  const root = readFileSync(join(REPO, 'server', 'composition', 'productionSessions.ts'), 'utf8');
  const table = /const PRODUCTION_ADAPTERS[^=]*=\s*Object\.freeze\(\{([\s\S]*?)\n\}\);/.exec(root);
  assert.ok(table, 'the approved-adapter table exists');
  assert.deepEqual([...table[1].matchAll(/^\s*(\w+):/gm)].map((m) => m[1]), ['store', 'admission', 'authorizer', 'limiter'],
    'the approved-adapter table holds no idempotency, transaction or outbox adapter');
  assert.match(table[1], /\blimiter:\s*null,\s*$/, 'and binds no limiter');
  // Only the transaction root composes a transaction port, and it composes no outbox delivery store, event contract or worker (M8).
  const TRANSACTION_PORT = /commandTransaction|outbox|transactions\s*:|events\s*:/i;
  const OUTBOX = /outbox|events\s*:|\.delivery\b|\bdelivery\s*:|worker/i;
  for (const sample of ['transactions: { port }', "from '../runtime/outbox.js'", 'events: TEST_EVENTS']) assert.match(sample, TRANSACTION_PORT, `the scan must catch: ${sample}`);
  for (const sample of ['store.delivery', 'delivery: store.delivery', 'createOutboxWorker']) assert.match(sample, OUTBOX, `the scan must catch: ${sample}`);
  const compositionFiles = readdirSync(join(REPO, 'server', 'composition')).filter((n) => /\.[cm]?[jt]s$/.test(n) && !/\.test\./.test(n));
  assert.ok(compositionFiles.includes('productionTransactions.ts'), 'the scan reaches the transaction root');
  for (const f of compositionFiles) {
    const code = codeOf(join(REPO, 'server', 'composition', f));
    if (f === 'productionTransactions.ts') assert.doesNotMatch(code, OUTBOX, `${f}: the transaction root composes no outbox delivery store, event contract or worker`);
    else assert.doesNotMatch(code, TRANSACTION_PORT, `${f}: only the transaction root composes a transaction port; no composition file composes an outbox or event contract`);
  }
});

test('the PostgreSQL transactional store is composed by the transaction root alone: outside the artifact, unreachable from the deployable entry, with no migration authority, and it builds no client', () => {
  // M6-PG-P4 built the adapter for the three M6 ports; M6-PG-P7-R1 makes it composition-ready. Exactly one production module
  // composes the store (server/composition/productionTransactions.ts), exactly one builds the kernel under it over the driver
  // (server/platform-identity/db.ts), the deployable entry reaches neither, and the emitted artifact carries neither.
  const PERSISTENCE = join(REPO, 'server', 'persistence');
  const cfg = JSON.parse(readFileSync(join(REPO, 'tsconfig.server.json'), 'utf8'));
  assert.ok(!(cfg.include || []).some((p) => p.includes('persistence') || p.includes('composition') || p.includes('platform-identity')),
    'the emitted server artifact contains neither the store, the composition nor the database-client boundary');
  const graphOf = (roots) => {
    const reached = new Set();
    const pending = [...roots];
    while (pending.length > 0) {
      const file = pending.pop();
      if (reached.has(file)) continue;
      reached.add(file);
      for (const spec of importSpecifiers(readFileSync(file, 'utf8'))) {
        if (!spec.startsWith('.')) continue;
        const base = resolve(dirname(file), spec);
        const target = [base.replace(/\.js$/, '.ts'), `${base}.ts`].find((p) => existsSync(p));
        if (target) pending.push(target);
      }
    }
    return reached;
  };
  const entry = graphOf([join(RUNTIME_DIR, 'server.ts')]);
  assert.ok(entry.has(join(RUNTIME_DIR, 'app.ts')), 'the walk reaches the runtime it guards');
  assert.ok([...entry].every((f) => f.startsWith(RUNTIME_DIR)), 'the deployable entry reaches the runtime only: no store, kernel, composition or database client');
  // Production sources — tests and testkits aside — that import the persistence layer, each for one reason. Every root that
  // can ship or run against a real endpoint (db-client-containment PRODUCTION_ROOTS), so an operator script is read too.
  const production = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); continue; }
      if (/\.[cm]?[jt]sx?$/.test(p) && !/\.(test|testkit)\.[cm]?[jt]sx?$/.test(p)) production.push(p);
    }
  };
  for (const root of ['server', 'scripts', 'src']) walk(join(REPO, root));
  assert.ok(production.includes(join(REPO, 'scripts', 'run-tests.mjs')) && production.includes(join(REPO, 'src', 'main.tsx')), 'the walk reads scripts and src');
  const rel = (p) => p.slice(REPO.length + 1);
  const importers = production.filter((p) => !p.startsWith(PERSISTENCE) && importSpecifiers(readFileSync(p, 'utf8')).some((s) => s.includes('persistence/'))).map(rel).sort();
  assert.deepEqual(importers, ['server/composition/productionTransactions.ts', 'server/platform-identity/db.ts'],
    'only the transaction root (the store) and the database-client boundary (the kernel) import the persistence layer');
  // Who names each constructor outside its own module, read from the syntax tree so comments and prose never count: an
  // identifier anywhere (an import, aliased or not, a call, a value or member reference) or a string equal to the name (a
  // computed member such as m['name']) does.
  const syntax = (source, file = 'sample.ts') => ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true,
    /\.tsx$/.test(file) ? ts.ScriptKind.TSX : /\.jsx$/.test(file) ? ts.ScriptKind.JSX : /\.[cm]?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS);
  const trees = new Map(production.map((p) => [p, syntax(readFileSync(p, 'utf8'), p)]));
  const mentions = (sourceFile, name) => {
    let found = false;
    const visit = (node) => {
      if (found) return;
      if ((ts.isIdentifier(node) || ts.isStringLiteralLike(node)) && node.text === name) found = true;
      else ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return found;
  };
  const names = (name, sample) => {
    for (const use of [sample, `import { ${name} as renamed } from './x.js';`, `const c = m[${JSON.stringify(name)}];`]) {
      assert.ok(mentions(syntax(use), name), `the scan must catch: ${use}`);
    }
    assert.ok(!mentions(syntax(`// ${name}\nconst note = 'calls ${name} later';`), name), 'a comment or a sentence naming it is not a use');
    return production.filter((p) => mentions(trees.get(p), name)).map(rel).sort();
  };
  assert.deepEqual(names('createPostgresTransactionalStore', 'store: createPostgresTransactionalStore'),
    ['server/composition/productionTransactions.ts', 'server/persistence/postgresTransactionalStore.ts'], 'the store is composed by the transaction root alone');
  assert.deepEqual(names('createSupervisedPgClient', 'createSupervisedPgClient(postgres, url, options)'),
    ['server/persistence/supervisedPgClient.ts', 'server/platform-identity/db.ts'], 'the kernel is built over the driver by the database-client boundary alone');
  assert.deepEqual(names('createRuntimeStoreClient', 'client: createRuntimeStoreClient'),
    ['server/composition/productionTransactions.ts', 'server/platform-identity/db.ts'], 'the store client is asked for by the transaction root alone');
  assert.deepEqual(names('sealedRuntimeTarget', 'sealedRuntimeTarget(endpoint)'),
    ['server/platform-identity/databaseEndpoint.ts', 'server/platform-identity/db.ts'], 'the sealed endpoint is read by the database-client boundary alone');
  assert.deepEqual(names('assembleTransactions', 'assembleTransactions(inventory, env, factories)'),
    ['server/composition/productionTransactions.ts'], 'the transaction boundary is assembled by its root alone');
  // A census of names cannot follow a capability re-exported under another name, so the modules allowed to hold one export an
  // exact value surface, read from the syntax tree: a new export (an alias, a wrapper, a re-export list, a default) fails here
  // until it is reviewed into the list. Interfaces and type aliases carry no capability and are not listed.
  const surfaceOf = (sourceFile) => {
    const values = new Set();
    for (const statement of sourceFile.statements) {
      if (ts.isExportDeclaration(statement) || ts.isExportAssignment(statement)) { values.add(`<${statement.getText(sourceFile)}>`); continue; }
      const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) ?? [] : [];
      if (!modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
      if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) continue;
      if (ts.isVariableStatement(statement)) { for (const d of statement.declarationList.declarations) values.add(d.name.getText(sourceFile)); continue; }
      const name = statement.name?.getText(sourceFile) ?? '(anonymous)';
      values.add(modifiers.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword) ? `default:${name}` : name); // a default import takes any name
    }
    return [...values].sort();
  };
  for (const [sample, expected] of [
    ['export const runtimeClientFactory = createRuntimeStoreClient;', ['runtimeClientFactory']],
    ['  export { createRuntimeStoreClient as clientFactory };', ['<export { createRuntimeStoreClient as clientFactory };>']],
    ['export default createRuntimeStoreClient;', ['<export default createRuntimeStoreClient;>']],
    ['export default function createRuntimeStoreClient() {}\nexport default class {}', ['default:(anonymous)', 'default:createRuntimeStoreClient']],
    ['export enum Kind { A }\nexport abstract class Holder {}\nexport async function *each() {}\nexport namespace N { export const x = 1; }', ['Holder', 'Kind', 'N', 'each']],
    ['namespace M { export const v = 1; }\nexport import alias = M.v;', ['alias']],
    ['export function f(): void;\nexport function f(x?: number): void {}\nexport interface I {}\nexport type T = 1;', ['f']],
  ]) assert.deepEqual(surfaceOf(syntax(sample)), expected, `the surface scan must read: ${sample}`);
  const surfaces = {
    'server/platform-identity/db.ts': ['CONTEXT_SETTINGS', 'DB_SESSION_BOUNDS', 'DRIVER_TLS_ENV_VAR', 'DatabaseTlsRefusal', 'assertTenantContext', 'closeDb', 'closeRuntimeDb',
      'createRuntimeStoreClient', 'discardNotice', 'getDb', 'getRuntimeDb', 'readTenantContext', 'resolveDatabaseTls', 'runtimeClientOptions', 'withTenantContext'],
    'server/platform-identity/databaseEndpoint.ts': ['ENDPOINT_GRAMMAR', 'classifyRuntimeDatabaseUrl', 'sealedRuntimeTarget'],
    'server/composition/productionTransactions.ts': ['PRODUCTION_INVENTORY', 'TransactionCompositionError', 'assembleTransactions', 'composeProductionTransactions', 'uncataloguedRoutePermissions'],
  };
  for (const [file, expected] of Object.entries(surfaces)) {
    assert.deepEqual(surfaceOf(trees.get(join(REPO, file))), [...expected].sort(), `${file}: exact value export surface`);
  }
  // Runtime composition never reaches migration authority: no executor, engine, applier CLI or managed launcher in its graph.
  const MIGRATION_AUTHORITY = /migrationExecutor|migrationEngine|supabase-migrate|managed-.*launcher/;
  assert.match('server/platform-identity/migrationExecutor.ts', MIGRATION_AUTHORITY, 'the scan must catch the executor');
  const composition = graphOf([join(REPO, 'server', 'composition', 'productionTransactions.ts')]);
  assert.ok(composition.has(join(PERSISTENCE, 'supervisedPgClient.ts')) && composition.has(join(REPO, 'server', 'platform-identity', 'databaseEndpoint.ts')),
    'the walk reaches the kernel and the classifier');
  for (const f of composition) assert.doesNotMatch(f, MIGRATION_AUTHORITY, `${rel(f)}: migration authority in the runtime composition graph`);
  const code = (p) => readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
  assert.doesNotMatch(code(join(REPO, 'server', 'composition', 'productionTransactions.ts')), /SUPABASE_DATABASE_URL|\bgetDb\b|\bgetRuntimeDb\b/,
    'the transaction root reads no migration or owner credential and uses no other client');
  const store = readFileSync(join(PERSISTENCE, 'postgresTransactionalStore.ts'), 'utf8');
  assert.doesNotMatch(store, /\bpostgres\s*\(|from\s+['"]postgres['"]|\bgetRuntimeDb\b|\bgetDb\b|process\.env/,
    'the store builds or looks up no client and reads no environment: the caller hands it one');
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

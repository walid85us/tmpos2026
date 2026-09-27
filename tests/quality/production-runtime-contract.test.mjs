// Phase 4.0 M3 - production runtime contract test (deterministic, gate suite).
//
// Proves the secure deployable skeleton's PRODUCTION contract without a network
// or provider: (1) a compiled Node start contract (node against emitted JS, no
// tsx/vite/watch); (2) an emitting server tsconfig that compiles the executable
// (server/entry/main.ts) and its import closure only; (3) the runtime source imports
// no legacy sidecar / provider / business module; (4) the compiled artifact is exactly
// the executable's closure, emits no test files, imports exactly five bare packages
// (each from one module) and carries no forbidden name;
// (5) generated output is gitignored so it can never be staged; (6) routes reach
// the runtime only through the central route table and the shared enforcement
// chain, and that chain ships in the artifact; (7) request bodies reach handlers
// only through the per-route body policy (no body parser, no parsed-body property);
// (8) the production entry composes the administrative session boundary alone and no
// in-memory store or DEV adapter, and a session identifier is read from the Cookie header
// only; (9) the in-memory session store is test support that never ships in the artifact
// and is unreachable from the provider-aware production composition root; (10) the M6
// PostgreSQL store is composed by the transaction root alone, over a kernel only the
// database-client boundary builds; the entry reaches both only through that root, imports
// the persistence layer type-only, and its import graph holds no migration authority.
// M7A-CUSTOMERS-P2: the tenant executable (server/entry/tenantMain.ts) is held to the same contract through its own
// build (tsconfig.server.tenant.json): an exact artifact carrying the customer route and its production adapter and no
// administrative route, mutator, entry, test kit or fake store; the tenant boundary alone, on one host; the compiled
// route declaration and the compiled executable's refusal read from the emitted bytes. The administrative artifact's
// compiled route declarations and shipping inventory are pinned the same way.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';

// The harness-only tenant admission witness (M5-GIAM-D1-P2-R1 §E, Option 1). Importing it here is
// what makes the containment assertions below name the REAL declaration rather than a copy of its
// text that could drift away from it. The module declares route values and runs nothing.
import {
  STORE_WITNESS_PATH, WITNESS_PATH, WITNESS_PERMISSION, WITNESS_ROUTES,
} from '../db/tenantAdmissionWitness.harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const RUNTIME_DIR = join(REPO, 'server', 'runtime');

// Legacy sidecars, providers, and business modules that must NEVER reach the
// compiled production artifact: no emitted file may even name one.
const ARTIFACT_FORBIDDEN = [
  'credential-store', 'event-processor', 'safe-log',
  'platform-identity/server', 'identityLink', 'supabaseAuthAdapter',
  'bcp-pilot', '@supabase',
  '/index', 'migrationEngine', 'migrationExecutor', 'authorizationRepository',
  // The Firebase client SDK (firebase/*, @firebase/*) and any loader that could reach a package
  // outside the static census below (createRequire, getBuiltinModule).
  'firebase/', 'createRequire', 'getBuiltinModule',
];
// The runtime tree (server/runtime) stays provider-free: beyond the above it imports no
// identity or database module at all. The entry reaches the driver and the identity
// provider only through server/platform-identity, pinned exactly by ARTIFACT_BARE_IMPORTS.
const FORBIDDEN = [...ARTIFACT_FORBIDDEN, 'platform-identity', 'firebase-admin', 'firebase', 'postgres', 'supabase'];

// M6-ENTRY-P1: the compiled artifact, exactly — the executable and its import closure, nothing more. M7A-CUSTOMERS-P2 adds
// the modules both entries share (transactionKernel.js, entryStartup.js), moved out of the administrative root and entry.
const ARTIFACT = [
  ...['platformAuthorization', 'productionSessions', 'productionTransactions', 'tenantAuthorization', 'transactionKernel'].map((m) => `server/composition/${m}.js`),
  ...['entryStartup', 'main', 'productionEntry'].map((m) => `server/entry/${m}.js`),
  ...['postgresPlatformAdmission', 'postgresPrincipalResolver', 'postgresRateLimiter', 'postgresSessionStore', 'postgresStartupPreflight',
    'postgresTenantAdmission', 'postgresTenantDirectory', 'postgresTransactionalStore', 'supervisedPgClient', 'tenantDisplayNameMutator',
    'tenantStatusMutator'].map((m) => `server/persistence/${m}.js`),
  ...['auditEventContract', 'auditEventWriter', 'authorizationConstants', 'authorizationContract', 'config', 'databaseEndpoint', 'db',
    'firebaseAdminAuthAdapter', 'm5CanonicalPermissions', 'permissionCatalog'].map((m) => `server/platform-identity/${m}.js`),
  ...['access', 'app', 'clientAddress', 'commandTransaction', 'config', 'correlation', 'deadline', 'idempotency', 'keyMaterial', 'lifecycle',
    'logging', 'outbox', 'principals', 'rateLimit', 'requestSecurity', 'routes', 'securityHeaders', 'sessions', 'tenantDirectory',
    'tenantDisplayName', 'tenantState', 'tenantStatus'].map((m) => `server/runtime/${m}.js`),
  'src/authorization/moneyCapabilities.js', 'src/authorization/permissionFamilies.js', 'src/types.js',
].sort();
// M7A-CUSTOMERS-P2: the tenant executable's compiled artifact, exactly — the customer route and its production adapter over
// the shared kernel and chain; no administrative route, mutator, entry or transaction root, and no command store or
// platform admission adapter.
const TENANT_ARTIFACT = [
  ...['platformAuthorization', 'productionSessions', 'tenantAuthorization', 'tenantTransactions', 'transactionKernel'].map((m) => `server/composition/${m}.js`),
  ...['entryStartup', 'tenantEntry', 'tenantMain'].map((m) => `server/entry/${m}.js`),
  ...['postgresCustomerDirectory', 'postgresRateLimiter', 'postgresSessionStore', 'postgresStartupPreflight', 'postgresTenantAdmission',
    'supervisedPgClient'].map((m) => `server/persistence/${m}.js`),
  ...['auditEventContract', 'auditEventWriter', 'authorizationConstants', 'authorizationContract', 'config', 'databaseEndpoint', 'db',
    'firebaseAdminAuthAdapter', 'm5CanonicalPermissions', 'permissionCatalog'].map((m) => `server/platform-identity/${m}.js`),
  ...['access', 'app', 'clientAddress', 'commandTransaction', 'config', 'correlation', 'customerDirectory', 'deadline', 'idempotency', 'keyMaterial',
    'lifecycle', 'logging', 'outbox', 'principals', 'rateLimit', 'requestSecurity', 'routes', 'securityHeaders', 'sessions', 'tenantState']
    .map((m) => `server/runtime/${m}.js`),
  'src/authorization/moneyCapabilities.js', 'src/authorization/permissionFamilies.js', 'src/types.js',
].sort();
// A module that declares a servable route: a `create…Route` factory or a `…_ROUTE` constant. Each artifact ships exactly
// its own: the tenant's the customer directory, the administrative one its three tenant-management routes.
const ROUTE_DEFINITION = /^export (?:async )?function create\w*Route\(|^export const [A-Z0-9_]*_ROUTE\b/m;
const TENANT_ROUTE_MODULES = ['server/runtime/customerDirectory.js'];
const ADMIN_ROUTE_MODULES = ['server/runtime/tenantDirectory.js', 'server/runtime/tenantDisplayName.js', 'server/runtime/tenantStatus.js'];
// Its only bare (package) imports, each from exactly one module: the web framework, the database driver, the identity
// provider's admin SDK and one built-in. Any other — the Firebase client SDK, @supabase, pg — fails.
const ARTIFACT_BARE_IMPORTS = [
  'crypto <= server/platform-identity/auditEventWriter.js',
  'express <= server/runtime/app.js',
  'firebase-admin/app <= server/platform-identity/firebaseAdminAuthAdapter.js',
  'firebase-admin/auth <= server/platform-identity/firebaseAdminAuthAdapter.js',
  'postgres <= server/platform-identity/db.js',
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
  // M7A-CUSTOMERS-P2: the tenant executable has its own compiled build and node start; the administrative start is unchanged.
  const tenantBuild = pkg.scripts['build:server:tenant'];
  assert.match(tenantBuild ?? '', /tsc\b[^&|]*tsconfig\.server\.tenant\.json/, 'build:server:tenant must compile tsconfig.server.tenant.json');
  assert.doesNotMatch(tenantBuild, /\b(tsx|ts-node|vite|vitest)\b|--watch/, 'the tenant build must not use a dev runner/watcher');
  assert.equal(pkg.scripts['start:tenant'], 'node dist-server-tenant/server/entry/tenantMain.js', 'start:tenant runs the emitted tenant executable under node');
  assert.equal(start, 'node dist-server/server/entry/main.js', 'start still runs the administrative executable');
});

test('tsconfig.server.tenant.json emits the tenant executable and its import closure only, with every other option the server build\'s', () => {
  const cfg = JSON.parse(readFileSync(join(REPO, 'tsconfig.server.tenant.json'), 'utf8'));
  assert.equal(cfg.extends, './tsconfig.server.json', 'every compiler option is inherited, so the two builds cannot drift');
  assert.deepEqual(cfg.files, ['server/entry/tenantMain.ts'], 'the build compiles the tenant executable alone, following its imports');
  assert.equal(cfg.include, undefined, 'no include glob can add a module outside that closure');
  assert.deepEqual(cfg.compilerOptions, { outDir: 'dist-server-tenant' }, 'only the output directory differs');
});

test('tsconfig.server.json emits JS for the executable and its import closure only', () => {
  const cfg = JSON.parse(readFileSync(join(REPO, 'tsconfig.server.json'), 'utf8'));
  const co = cfg.compilerOptions || {};
  assert.notEqual(co.noEmit, true, 'server config must emit');
  assert.ok(co.outDir, 'server config must set an outDir');
  // A test is emitted only if the executable imports one, which the exact artifact check below refuses.
  assert.deepEqual(cfg.files, ['server/entry/main.ts'], 'the build compiles the executable alone, following its imports');
  assert.equal(cfg.include, undefined, 'no include glob can add a module outside that closure');
  assert.equal(co.rootDir, '.', 'the closure spans server/ and src/, so paths are kept from the repository root');
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

/** Every file a build emitted under `out`, relative to it, sorted. */
function emittedUnder(out) {
  const emitted = [];
  (function walk(d) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p); else emitted.push(p.slice(out.length + 1));
    }
  })(out);
  return emitted.sort();
}

/**
 * The per-file checks every compiled artifact passes — no computed import, no forbidden name, no in-memory store, harness
 * witness or per-process port — answering the bare packages its files import, each as `package <= file`, sorted.
 */
function scanArtifact(out, emitted) {
  const bare = [];
  for (const rel of emitted.filter((f) => f.endsWith('.js'))) {
    const f = join(out, rel);
    const src = readFileSync(f, 'utf8');
    // A computed specifier (anything but one complete string literal) would hide a package from the census below.
    assert.doesNotMatch(src, /\b(?:import|require)\s*\((?!\s*(['"])[^'"]*\1\s*\))/, `${f}: a computed import in the artifact`);
    for (const spec of importSpecifiers(src)) if (!spec.startsWith('.') && !spec.startsWith('node:')) bare.push(`${spec} <= ${rel}`);
    for (const bad of ARTIFACT_FORBIDDEN) assert.ok(!src.includes(bad), `${f}: emitted artifact references forbidden ${bad}`);
    assert.ok(!src.includes('createMemorySessionStore'), `${f}: the artifact carries no in-memory session store`);
    for (const harnessOnly of [WITNESS_PATH, STORE_WITNESS_PATH, 'tenantAdmissionWitness']) {
      assert.ok(!src.includes(harnessOnly), `${f}: the artifact carries the harness-only admission witness ${harnessOnly}`);
    }
    assert.ok(!/createMemoryRateLimiter|assertRateLimiterContract/.test(src), `${f}: the artifact carries no per-process rate limiter`);
    assert.ok(!/createMemoryIdempotencyStore|assertIdempotencyStoreContract/.test(src), `${f}: the artifact carries no per-process idempotency store`);
    assert.ok(!/createMemoryCommandTransaction|createMemoryOutboxDeliveryStore|assertCommandTransactionContract|assertOutboxDeliveryContract/.test(src),
      `${f}: the artifact carries no per-process transaction port or outbox`);
  }
  return bare.sort();
}

/** The emitted modules that declare a servable route (ROUTE_DEFINITION), read from the compiled bytes. */
const routeModulesOf = (out, emitted) => emitted.filter((f) => f.endsWith('.js') && ROUTE_DEFINITION.test(readFileSync(join(out, f), 'utf8')));

test('the compiled artifact emits runnable JS, excludes tests, and has no forbidden import', () => {
  const out = mkdtempSync(join(tmpdir(), 'tmpos-runtime-build-'));
  try {
    const r = spawnSync('node_modules/.bin/tsc', ['-p', 'tsconfig.server.json', '--outDir', out], {
      cwd: REPO, encoding: 'utf8', timeout: 120000,
    });
    assert.equal(r.status, 0, `server build must succeed:\n${(r.stdout || '') + (r.stderr || '')}`);

    const emitted = emittedUnder(out);
    assert.deepEqual(emitted, ARTIFACT, 'the artifact is exactly the executable\'s import closure');
    const js = emitted.filter((f) => f.endsWith('.js'));
    assert.ok(js.length > 0, 'server build must emit JavaScript');
    assert.ok(js.some((f) => /entry\/main\.js$/.test(f)), 'the production entry server/entry/main.js must be emitted');
    for (const mod of ['app.js', 'routes.js', 'access.js', 'requestSecurity.js', 'rateLimit.js', 'clientAddress.js', 'securityHeaders.js', 'sessions.js', 'deadline.js', 'idempotency.js', 'keyMaterial.js', 'commandTransaction.js', 'outbox.js']) {
      assert.ok(js.some((f) => f.endsWith(`/${mod}`)), `the shared enforcement chain must ship in the artifact: ${mod}`);
    }
    assert.ok(!emitted.some((f) => /\.test\.js$/.test(f)), 'test files must not be compiled into the artifact');
    assert.ok(!emitted.some((f) => /\.testkit\.js$/.test(f)), 'test support (the in-memory session store and rate limiter) must not be compiled into the artifact');
    assert.deepEqual(scanArtifact(out, emitted), ARTIFACT_BARE_IMPORTS, 'the artifact imports exactly these packages, each from exactly one module');
    // M7A-CUSTOMERS-P2: the administrative artifact declares its three tenant-management routes and no other — no customer route.
    for (const sample of ['export function createTenantDirectoryRoute(ports) {', 'export const TENANT_STATUS_ROUTE = Object.freeze({']) {
      assert.match(sample, ROUTE_DEFINITION, `the route scan must catch: ${sample}`);
    }
    assert.deepEqual(routeModulesOf(out, emitted), ADMIN_ROUTE_MODULES, 'the administrative artifact declares exactly its own routes');

    // M6-ADMIN-AUDIT-P1 (M6AA-15): the built session store writes its records through the built audit writer, and the built
    // administrative boundary issues and ends a session only through the store's audited pair, refusing at startup a store
    // without it. The exact ARTIFACT list and the checks above already keep every testkit and migration module out of it.
    const built = (m) => readFileSync(join(out, m), 'utf8');
    const store = built('server/persistence/postgresSessionStore.js');
    assert.ok(importSpecifiers(store).includes('../platform-identity/auditEventWriter.js'), 'the built session store imports the audit writer');
    assert.match(store, /\bwriteAuditEvent\(/, 'and writes its records through it');
    const boundary = built('server/runtime/sessions.js');
    for (const [pattern, part] of [[/\bsessions\.establish\(/, 'establish'], [/\bsessions\.end\(/, 'end'], [/'session_store_audit_required'/, 'the setup refusal']]) {
      assert.match(boundary, pattern, `the built administrative boundary's audited path: ${part}`);
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('the compiled tenant artifact is exactly its executable\'s closure: the customer route and its production adapter, and no administrative route, mutator, entry, test kit or fake store', () => {
  // M7A-CUSTOMERS-P2 (acceptance 4, read literally): the tenant build emits the intended route and adapter and nothing
  // unintended. The exact list is the proof; the named checks below say what it excludes.
  const out = mkdtempSync(join(tmpdir(), 'tmpos-tenant-build-'));
  try {
    const r = spawnSync('node_modules/.bin/tsc', ['-p', 'tsconfig.server.tenant.json', '--outDir', out], { cwd: REPO, encoding: 'utf8', timeout: 120000 });
    assert.equal(r.status, 0, `tenant build must succeed:\n${(r.stdout || '') + (r.stderr || '')}`);
    const emitted = emittedUnder(out);
    assert.deepEqual(emitted, TENANT_ARTIFACT, 'the tenant artifact is exactly the tenant executable\'s import closure');
    for (const m of ['server/entry/tenantMain.js', 'server/composition/tenantTransactions.js', 'server/runtime/customerDirectory.js',
      'server/persistence/postgresCustomerDirectory.js']) {
      assert.ok(emitted.includes(m), `the tenant artifact ships ${m}`);
    }
    for (const m of [...ADMIN_ROUTE_MODULES, 'server/persistence/tenantDisplayNameMutator.js', 'server/persistence/tenantStatusMutator.js',
      'server/persistence/postgresTenantDirectory.js', 'server/persistence/postgresTransactionalStore.js', 'server/persistence/postgresPlatformAdmission.js',
      'server/composition/productionTransactions.js', 'server/entry/productionEntry.js', 'server/entry/main.js']) {
      assert.ok(!emitted.includes(m), `${m}: an administrative module in the tenant artifact`);
    }
    assert.ok(!emitted.some((f) => /\.test\.js$|\.testkit\.js$/.test(f)), 'no test or test support module is compiled into the tenant artifact');
    assert.deepEqual(scanArtifact(out, emitted), ARTIFACT_BARE_IMPORTS, 'the tenant artifact imports exactly the administrative artifact\'s packages');
    assert.deepEqual(routeModulesOf(out, emitted), TENANT_ROUTE_MODULES, 'the tenant artifact declares exactly one route module: the customer directory');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('the compiled entry actually runs under node and fails closed on missing config', () => {
  // Build to the in-repo outDir so the emitted ESM can resolve its packages from
  // node_modules, then execute it under plain node (not tsx) with an empty configuration
  // (PATH only, never the parent environment): it must refuse before composing anything
  // (exit 1) and emit the sanitized startup_refused event for invalid configuration.
  const build = spawnSync('node_modules/.bin/tsc', ['-p', 'tsconfig.server.json'], { cwd: REPO, encoding: 'utf8', timeout: 120000 });
  try {
    assert.equal(build.status, 0, `server build must succeed:\n${(build.stdout || '') + (build.stderr || '')}`);
    const entry = join(REPO, 'dist-server', 'server', 'entry', 'main.js');
    assert.ok(existsSync(entry), 'dist-server/server/entry/main.js must exist');
    const run = spawnSync('node', [entry], { cwd: REPO, encoding: 'utf8', timeout: 20000, env: { PATH: process.env.PATH ?? '' } });
    assert.equal(run.status, 1, `missing-config start must exit 1:\n${run.stdout}\n${run.stderr}`);
    const out = (run.stdout || '') + (run.stderr || '');
    assert.match(out, /startup_refused/, 'must emit the sanitized startup_refused event');
    assert.match(out, /config_invalid/, 'and refuse on the configuration, before any database or provider is composed');
    assert.doesNotMatch(out, /at Object|node_modules\/|SyntaxError/, 'must not leak a stack trace');

    // M7A-CUSTOMERS-P2 (CX-T1), mirroring the tenant check below: the administrative route declarations and the shipping
    // inventory, read from the COMPILED modules under plain node, are exactly the pinned tuples — method, path, access,
    // audience, scope, permission, session binding, trusted context, recent authentication, body and idempotency. No
    // administrative route declares a session binding (null).
    const url = (m) => JSON.stringify(pathToFileURL(join(REPO, 'dist-server', m)).href);
    const read = spawnSync('node', ['--input-type=module', '-e', `
      const { productionRouteDeclarations } = await import(${url('server/composition/productionTransactions.js')});
      const { SHIPPING_ROUTES } = await import(${url('server/entry/productionEntry.js')});
      process.stdout.write(JSON.stringify({
        declarations: productionRouteDeclarations().map((r) => [r.method, r.path, r.policy.access, r.policy.audience,
          r.policy.authorization.scope, r.policy.authorization.permission, r.sessionBinding ?? null, r.trustedContext, r.recentAuth,
          r.body.kind, r.idempotency]),
        shipping: SHIPPING_ROUTES.map((r) => [r.method, r.path, r.access, r.body, r.idempotency, Object.keys(r).length]),
      }));`], { cwd: REPO, encoding: 'utf8', timeout: 20000, env: { PATH: process.env.PATH ?? '' } });
    assert.equal(read.status, 0, `the compiled modules import under node:\n${read.stderr}`);
    const compiled = JSON.parse(read.stdout);
    assert.deepEqual(compiled.declarations, [
      ['PATCH', '/admin/v1/tenants/display-name', 'session', 'admin', 'platform', 'edit_tenant_profile', null, 'required', 'none', 'json', 'required'],
      ['PATCH', '/admin/v1/tenants/status', 'session', 'admin', 'platform', 'change_tenant_status', null, 'required', 'required', 'json', 'required'],
      ['GET', '/admin/v1/tenants', 'session', 'admin', 'platform', 'view_tenants', null, 'required', 'none', 'none', 'none'],
    ], 'the compiled administrative routes are exactly the pinned declarations');
    assert.deepEqual(compiled.shipping, [
      ['GET', '/health', 'public', 'none', 'none', 5],
      ['GET', '/readiness', 'public', 'none', 'none', 5],
      ['POST', '/admin/v1/session/login', 'login', 'none', 'none', 5],
      ['GET', '/admin/v1/session', 'session', 'none', 'none', 5],
      ['POST', '/admin/v1/session/logout', 'session', 'none', 'none', 5],
      ['GET', '/admin/v1/tenants', 'session', 'none', 'none', 5],
      ['PATCH', '/admin/v1/tenants/display-name', 'session', 'json', 'required', 5],
      ['PATCH', '/admin/v1/tenants/status', 'session', 'json', 'required', 5],
    ], 'the compiled administrative inventory is exactly the pinned eight routes');
  } finally {
    rmSync(join(REPO, 'dist-server'), { recursive: true, force: true });
  }
});

test('the compiled tenant executable runs under node and fails closed on missing config; its compiled route and inventory are the pinned ones', async () => {
  // The in-repo outDir, so the emitted ESM resolves its packages; plain node, PATH only, as the administrative mirror above.
  const dist = join(REPO, 'dist-server-tenant');
  const build = spawnSync('node_modules/.bin/tsc', ['-p', 'tsconfig.server.tenant.json'], { cwd: REPO, encoding: 'utf8', timeout: 120000 });
  try {
    assert.equal(build.status, 0, `tenant build must succeed:\n${(build.stdout || '') + (build.stderr || '')}`);
    const entry = join(dist, 'server', 'entry', 'tenantMain.js');
    assert.ok(existsSync(entry), 'dist-server-tenant/server/entry/tenantMain.js must exist');
    const env = { PATH: process.env.PATH ?? '' };
    const run = spawnSync('node', [entry], { cwd: REPO, encoding: 'utf8', timeout: 20000, env });
    assert.equal(run.status, 1, `missing-config start must exit 1:\n${run.stdout}\n${run.stderr}`);
    const out = (run.stdout || '') + (run.stderr || '');
    assert.match(out, /startup_refused/, 'must emit the sanitized startup_refused event');
    assert.match(out, /config_invalid/, 'and refuse on the configuration, before any database or provider is composed');
    assert.doesNotMatch(out, /at Object|node_modules\/|SyntaxError/, 'must not leak a stack trace');

    // The customer route's whole declaration and the shipping inventory, read from the COMPILED modules under plain node
    // (critic A7(b)): method, path, access, audience, scope, permission, session binding, trusted context, recent
    // authentication, body and idempotency.
    const url = (m) => JSON.stringify(pathToFileURL(join(dist, m)).href);
    const read = spawnSync('node', ['--input-type=module', '-e', `
      const { tenantRouteDeclarations } = await import(${url('server/composition/tenantTransactions.js')});
      const { TENANT_SHIPPING_ROUTES } = await import(${url('server/entry/tenantEntry.js')});
      process.stdout.write(JSON.stringify({
        declarations: tenantRouteDeclarations().map((r) => [r.method, r.path, r.policy.access, r.policy.audience,
          r.policy.authorization.scope, r.policy.authorization.permission, r.sessionBinding, r.trustedContext, r.recentAuth,
          r.body.kind, r.idempotency]),
        shipping: TENANT_SHIPPING_ROUTES,
      }));`], { cwd: REPO, encoding: 'utf8', timeout: 20000, env });
    assert.equal(read.status, 0, `the compiled modules import under node:\n${read.stderr}`);
    const compiled = JSON.parse(read.stdout);
    assert.deepEqual(compiled.declarations,
      [['GET', '/api/v1/customers', 'session', 'tenant', 'tenant', 'view_customers', 'required', 'required', 'none', 'none', 'none']],
      'the compiled customer route is exactly the pinned declaration');
    const { TENANT_SHIPPING_ROUTES } = await import('../../server/entry/tenantEntry.ts');
    assert.deepEqual(compiled.shipping, JSON.parse(JSON.stringify(TENANT_SHIPPING_ROUTES)), 'the compiled inventory is the source literal');
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
});

test('generated server output is gitignored so it can never be staged', () => {
  const gi = readFileSync(join(REPO, '.gitignore'), 'utf8');
  assert.match(gi, /^dist-server\/?\s*$/m, 'dist-server must be gitignored');
  assert.match(gi, /^dist-server-tenant\/?\s*$/m, 'dist-server-tenant must be gitignored');
  assert.ok(existsSync(join(REPO, 'tsconfig.server.tenant.json')), 'tenant build config must exist');
  // And the forbidden-artifact scan refuses either output should one ever be tracked.
  const guard = readFileSync(join(REPO, 'scripts', 'check-forbidden-artifacts.mjs'), 'utf8');
  for (const dir of ['dist-server', 'dist-server-tenant']) assert.ok(guard.includes(`  /^${dir}\\//,\n`), `the forbidden-artifact scan names ${dir}/`);
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

test('each entry composes its own session boundary alone, and no in-memory store or DEV adapter', () => {
  // M6-ENTRY-P1: the executable composes the admin boundary over the durable stores the transaction root builds; the
  // tenant boundary stays uncomposed (its origins are never read), and no test double or DEV adapter is named.
  // M7A-CUSTOMERS-P2: the tenant executable's entry composes the tenant boundary alone, and neither entry the other's.
  const ENTRY_AUDIENCE = { 'productionEntry.ts': 'admin', 'tenantEntry.ts': 'tenant' };
  const entryDir = readdirSync(join(REPO, 'server', 'entry')).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts')).sort();
  for (const f of ['main.ts', 'productionEntry.ts', 'tenantMain.ts', 'tenantEntry.ts']) assert.ok(entryDir.includes(f), `server/entry/${f} exists and is read`);
  for (const f of entryDir) {
    assert.doesNotMatch(readFileSync(join(REPO, 'server', 'entry', f), 'utf8'), /createMemory\w+|DevDiagnostic|devDiagnostic|devActor|stubFirebase/,
      `server/entry/${f} must compose no in-memory store, test double or DEV adapter`);
  }
  for (const [f, audience] of Object.entries(ENTRY_AUDIENCE)) {
    const source = readFileSync(join(REPO, 'server', 'entry', f), 'utf8');
    assert.deepEqual([...source.matchAll(/\baudiences:\s*(\[[^\]]*\])/g)].map((m) => m[1]), [`['${audience}']`], `${f} composes the ${audience} boundary alone`);
  }
  const entry = readFileSync(join(REPO, 'server', 'entry', 'productionEntry.ts'), 'utf8');
  assert.doesNotMatch(entry, /SESSION_TENANT_ORIGINS/, 'and never reads the tenant boundary\'s configuration');
  // The census behind that literal, from the syntax tree of every entry source: exactly one call of the session root,
  // its options an object literal whose `audiences` is the literal ['admin'] — no spread and no variable in that position,
  // no alias of the root — and no other session-boundary constructor named at all. A second boundary built through a
  // variable (`{ audiences: both }`, `const opts = …`, a second call) passes the text check above but not this one. A
  // namespace import or a dynamic import() would let a string-keyed member (`root['composeProductionSessions'](…)`) slip
  // past an identifier census, so neither form is allowed and a string equal to a constructor name counts as naming it.
  // A re-export (`export * as m from …`, `export { … } from …`) would hand the same namespace to a sibling, so none is allowed.
  const ROOT = 'composeProductionSessions';
  const OTHER_CONSTRUCTORS = /^(?:(?:compose|assemble|create)\w*Session\w*|createBoundary|durableSessionAdapters)$/;
  const census = (f, source) => {
    const found = [];
    const visit = (n) => {
      if (ts.isNamespaceImport(n)) assert.fail(`server/entry/${f} imports a module namespace: ${n.parent.parent.getText()}`);
      if (ts.isExportDeclaration(n) && n.moduleSpecifier !== undefined) assert.fail(`server/entry/${f} re-exports from another module: ${n.getText()}`);
      if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) assert.fail(`server/entry/${f} imports a module dynamically: ${n.getText()}`);
      if (ts.isIdentifier(n) || ts.isStringLiteralLike(n)) {
        if (n.text !== ROOT) {
          assert.doesNotMatch(n.text, OTHER_CONSTRUCTORS, `server/entry/${f} names another session-boundary constructor: ${n.text}`);
        } else {
          const p = n.parent;
          const imported = ts.isIdentifier(n) && ts.isImportSpecifier(p) && p.propertyName === undefined;
          const called = ts.isIdentifier(n) && ts.isCallExpression(p) && p.expression === n;
          assert.ok(imported || called, `server/entry/${f}: ${ROOT} is imported under its own name and called directly, never aliased, passed or string-keyed`);
          if (called) found.push([f, p]);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(ts.createSourceFile(f, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS));
    return found;
  };
  for (const bypass of [
    `import * as root from '../composition/productionSessions.js';\nroot['${ROOT}'](env, deps, { audiences: ['admin', 'tenant'] });`,
    `const root = await import('../composition/productionSessions.js');\nroot.${ROOT}(env, deps, opts);`,
    `import { ${ROOT} as build } from '../composition/productionSessions.js';`,
    `declare const m: Record<string, Function>;\nm['assembleSessions'](inventory);`,
    `export * as sessionModule from '../composition/productionSessions.js';`,
    `export { ${ROOT} } from '../composition/productionSessions.js';`,
  ]) assert.throws(() => census('sample.ts', bypass), assert.AssertionError, `the census must catch: ${bypass}`);
  const calls = entryDir.flatMap((f) => census(f, readFileSync(join(REPO, 'server', 'entry', f), 'utf8')));
  assert.deepEqual(calls.map(([f]) => f).sort(), Object.keys(ENTRY_AUDIENCE).sort(), `exactly one ${ROOT} call in each entry, none in an executable`);
  for (const [f, call] of calls) {
    const options = call.arguments[2];
    assert.ok(options !== undefined && ts.isObjectLiteralExpression(options), `${f}: the options argument is an object literal, not a variable`);
    assert.ok(options.properties.every((p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)), `${f}: no spread, shorthand or computed key in the options`);
    const audiences = options.properties.filter((p) => p.name.text === 'audiences');
    assert.equal(audiences.length, 1, `${f}: the options name the composed boundaries exactly once`);
    const list = audiences[0].initializer;
    assert.ok(ts.isArrayLiteralExpression(list) && list.elements.length === 1 && ts.isStringLiteral(list.elements[0]) && list.elements[0].text === ENTRY_AUDIENCE[f],
      `${f}: audiences is the literal ['${ENTRY_AUDIENCE[f]}'], not ${list.getText()}`);
  }
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

test('the tenant-admission witness is harness-only: no production source declares it, the administrative inventory carries no tenant route, and the tenant inventory exactly the customer route', async () => {
  // 1. IT IS A REAL ROUTE. Without this the rest of the test would pass vacuously.
  assert.equal(WITNESS_ROUTES.length, 2, 'a tenant-scope witness and a store-scope one');
  assert.deepEqual(WITNESS_ROUTES.map((r) => [r.method, r.path, r.policy.access, r.policy.audience, r.policy.authorization.scope]), [
    ['GET', WITNESS_PATH, 'session', 'tenant', 'tenant'],
    ['GET', STORE_WITNESS_PATH, 'session', 'tenant', 'store'],
  ]);
  assert.ok(WITNESS_ROUTES.every((r) => r.policy.authorization.permission === WITNESS_PERMISSION && r.trustedContext === 'required'));

  // 2. NO PRODUCTION SOURCE DECLARES IT. Neither path, nor the permission on a shipping route, nor an
  // import of the harness module, appears anywhere outside test files in the server and client trees.
  const offenders = [];
  const scanned = [];
  for (const root of ['server', 'src']) {
    (function walk(d) {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); continue; }
        if (!/\.[cm]?[jt]sx?$/.test(p) || /\.test\.[cm]?[jt]sx?$/.test(p) || p.endsWith('.testkit.ts')) continue;
        scanned.push(p.slice(REPO.length + 1));
        const src = readFileSync(p, 'utf8');
        for (const marker of [WITNESS_PATH, STORE_WITNESS_PATH, 'tenantAdmissionWitness']) {
          if (src.includes(marker)) offenders.push(`${p.slice(REPO.length + 1)}: ${marker}`);
        }
      }
    })(join(REPO, root));
  }
  // NON-VACUITY: the walk really did read the production source, including the files that would
  // carry a shipped tenant route if one existed.
  assert.ok(scanned.includes('server/runtime/app.ts') && scanned.includes('server/composition/productionTransactions.ts'),
    `the scan covered the production tree (${scanned.length} files)`);
  assert.deepEqual(offenders, [], 'the witness route exists only in the integration harness');

  // 3. THE ADMINISTRATIVE INVENTORY DOES NOT CARRY IT: it declares no tenant or store requirement at all and nothing on the
  // tenant boundary. (A tenant business route ships since M7A-CUSTOMERS-P2 — GET /api/v1/customers, owner decision D1 —
  // in the tenant executable's own inventory alone, pinned in step 4.)
  const { productionRouteDeclarations } = await import('../../server/composition/productionTransactions.ts');
  // Every route the inventory would serve, its read routes included (M5-GIAM-D1-P3), built over ports that answer nothing.
  const served = productionRouteDeclarations();
  const paths = served.map((r) => r.path);
  assert.equal(paths.includes(WITNESS_PATH) || paths.includes(STORE_WITNESS_PATH), false, 'neither witness is registered');
  const tenantScoped = served
    .filter((r) => (r.policy.authorization ?? null) !== null && r.policy.authorization.scope !== 'platform')
    .map((r) => `${r.method} ${r.path}`);
  assert.deepEqual(tenantScoped, [], 'no administrative route declares a tenant or store authorization requirement');
  assert.equal(paths.some((p) => p.startsWith('/api/v1/')), false, 'and no administrative route sits on the tenant boundary');

  // 4. THE TENANT INVENTORY (M7A-CUSTOMERS-P2) is exactly one route: the customer list, a tenant-scope view_customers read
  // bound to the presenting session — no store scope, no witness, nothing administrative.
  const { tenantRouteDeclarations } = await import('../../server/composition/tenantTransactions.ts');
  assert.deepEqual(tenantRouteDeclarations().map((r) => [r.method, r.path, r.policy.access, r.policy.audience, r.policy.authorization.scope,
    r.policy.authorization.permission, r.sessionBinding]),
  [['GET', '/api/v1/customers', 'session', 'tenant', 'tenant', 'view_customers', 'required']], 'the tenant inventory is the customer route alone');
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

test('durable idempotency is composed only by the transaction root, for a route that requires it: only the two tenant commands require one, and its port imports no database or provider adapter', () => {
  // M6-IDEMPOT-P2, M6-PG-P7-R1: the port is provider-independent; the transaction root (productionTransactions.ts) is the one
  // production authority for it, composing the approved PostgreSQL store only for a route in its inventory that requires
  // idempotency — and nothing in the production graph registers such a route yet.
  const COMPOSITION_DIR = join(REPO, 'server', 'composition');
  const production = [...runtimeSourceFiles().filter((f) => !f.endsWith('.testkit.ts')),
    ...readdirSync(COMPOSITION_DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts')).map((f) => join(COMPOSITION_DIR, f))];
  // A registration, never the type that names the value or a comment that explains it.
  const REQUIRED_ROUTE = /(?<!readonly )\bidempotency\s*:\s*['"`]required['"`]/;
  for (const sample of ["{ idempotency: 'required', perform }", 'idempotency:"required"']) assert.match(sample, REQUIRED_ROUTE, `the scan must catch: ${sample}`);
  // M5-GIAM-D1-P1 (owner decision D1) and M5-GIAM-D1-P2: the production routes that require idempotency are the tenant
  // display-name command and the tenant status command, each declared in its own runtime module. Any other production file
  // that registers one fails.
  const REQUIRED_ROUTE_FILES = [join(RUNTIME_DIR, 'tenantDisplayName.ts'), join(RUNTIME_DIR, 'tenantStatus.ts')];
  const registering = [];
  for (const f of production) {
    const code = readFileSync(f, 'utf8').replace(/\/\/.*$/gm, ''); // code only: a comment may name what it explains
    assert.doesNotMatch(code, /createMemoryIdempotencyStore|assertIdempotencyStoreContract|idempotencyStore\.testkit/, `${f}: a per-process idempotency store in production`);
    if (REQUIRED_ROUTE.test(code)) registering.push(f);
  }
  assert.deepEqual(registering.sort(), [...REQUIRED_ROUTE_FILES].sort(), 'only the two tenant commands register a route that requires idempotency');
  // M5-GIAM-D1-P3: and exactly one read route factory, the platform tenant directory (GET /admin/v1/tenants), which requires no key.
  const INVENTORY = /^export const PRODUCTION_INVENTORY: TransactionInventory = Object\.freeze\(\{\n {2}routes: Object\.freeze\(\[TENANT_DISPLAY_NAME_ROUTE, TENANT_STATUS_ROUTE\]\),\n {2}mutators: Object\.freeze\(\[TENANT_DISPLAY_NAME_MUTATOR, TENANT_STATUS_MUTATOR\]\),\n {2}reads: Object\.freeze\(\[createTenantDirectoryRoute\]\),\n\}\);$/m;
  assert.doesNotMatch("export const PRODUCTION_INVENTORY: TransactionInventory = Object.freeze({\n  routes: Object.freeze([TENANT_DISPLAY_NAME_ROUTE, TENANT_STATUS_ROUTE, ORDERS]),\n  mutators: Object.freeze([TENANT_DISPLAY_NAME_MUTATOR, TENANT_STATUS_MUTATOR]),\n  reads: Object.freeze([createTenantDirectoryRoute]),\n});", INVENTORY,
    'the scan must catch a route added to the inventory');
  assert.doesNotMatch("export const PRODUCTION_INVENTORY: TransactionInventory = Object.freeze({\n  routes: Object.freeze([TENANT_DISPLAY_NAME_ROUTE, TENANT_STATUS_ROUTE]),\n  mutators: Object.freeze([TENANT_DISPLAY_NAME_MUTATOR, TENANT_STATUS_MUTATOR]),\n  reads: Object.freeze([createTenantDirectoryRoute, createOrdersRoute]),\n});", INVENTORY,
    'the scan must catch a read route added to the inventory');
  assert.match(readFileSync(join(COMPOSITION_DIR, 'productionTransactions.ts'), 'utf8'), INVENTORY, 'the production inventory holds exactly the two tenant commands, their mutators and the tenant directory read');
  // IDEMPOTENCY_KEY belongs to the transaction root alone in the composition layer, and APP_DATABASE_URL to the transaction
  // kernel both roots share (M7A-CUSTOMERS-P2): one reader each.
  const OWNED = [
    [/\bIDEMPOTENCY_KEY\b|\bidempotencyStore\b|\bIdempotencyDeps\b/, 'productionTransactions.ts', ['env.IDEMPOTENCY_KEY', 'idempotencyStore: null,']],
    [/\bAPP_DATABASE_URL(?:_VAR)?\b/, 'transactionKernel.ts', ['env[APP_DATABASE_URL_VAR]', 'APP_DATABASE_URL']],
  ];
  for (const [pattern, owner, samples] of OWNED) {
    for (const sample of samples) assert.match(sample, pattern, `the scan must catch: ${sample}`);
    assert.match(readFileSync(join(COMPOSITION_DIR, owner), 'utf8'), pattern, `${owner} is the one reader`);
    for (const f of readdirSync(COMPOSITION_DIR).filter((n) => n.endsWith('.ts') && !n.endsWith('.test.ts') && n !== owner)) {
      assert.doesNotMatch(readFileSync(join(COMPOSITION_DIR, f), 'utf8').replace(/\/\/.*$/gm, ''), pattern, `${f}: only ${owner} names ${pattern}`);
    }
  }
  const port = readFileSync(join(RUNTIME_DIR, 'idempotency.ts'), 'utf8');
  assert.deepEqual(importSpecifiers(port).filter((s) => !s.startsWith('node:')).sort(), ['./deadline.js', './keyMaterial.js', './routes.js', './routes.js'],
    'the idempotency port imports node built-ins and the runtime only: no database, migration or provider adapter');
  // M6-ENTRY-P1: the deployable entry composes idempotency and the transaction port through the transaction root alone: it
  // imports neither port module (nor the outbox), and hands the runtime exactly what composeProductionTransactions returned.
  for (const f of ['main.ts', 'productionEntry.ts', 'entryStartup.ts', 'tenantMain.ts', 'tenantEntry.ts']) {
    for (const spec of importSpecifiers(readFileSync(join(REPO, 'server', 'entry', f), 'utf8'))) {
      assert.doesNotMatch(spec, /\/(?:idempotency|commandTransaction|outbox)\.js$/, `server/entry/${f} imports a port module directly: ${spec}`);
    }
  }
  const entry = readFileSync(join(REPO, 'server', 'entry', 'productionEntry.ts'), 'utf8');
  assert.deepEqual([...entry.matchAll(/\bcomposeProductionTransactions\([^)]*\)/g)].map((m) => m[0]), ['composeProductionTransactions(env, construction.databaseClient)'],
    'the entry composes the transaction root once, over its configuration and its database client');
  const appOptions = [...entry.matchAll(/\bcreateApp\(\{([^}]*)\}\)/g)].map((m) => m[1]);
  assert.equal(appOptions.length, 1, 'the entry builds the runtime once');
  for (const field of ['routes', 'idempotency', 'transactions']) {
    assert.match(appOptions[0], new RegExp(`\\b${field}: tx\\.${field},`), `the runtime's ${field} is the transaction root's`);
  }
  assert.match(entry, /\bconst tx = transactions;/, 'tx is the transaction root\'s result');
  assert.deepEqual([...entry.matchAll(/^.*\btransactions\s*(?::[^=\n]*)?=(?!=).*$/gm)].map((m) => m[0].trim()),
    ['let transactions: ProductionTransactions | null = null;', 'transactions = composeProductionTransactions(env, construction.databaseClient);'],
    'transactions is assigned only its null initialiser and the transaction root\'s return value');
  assert.doesNotMatch(entry, /\b(?:transactions|tx)\b(?:\??\.\w+|\[[^\]]*\])+\s*(?:[-+*/%&|^]|\?\?|\|\||&&)?=(?!=)/,
    'the entry never rewrites a member of the transaction root\'s result');
  assert.doesNotMatch(entry, /\bObject\.(?:assign|defineProperty|defineProperties|setPrototypeOf)\(\s*(?:transactions|tx)\b/,
    'the entry never rewrites a member of the transaction root\'s result');

  // M7A-CUSTOMERS-P2: the tenant entry composes the tenant transaction root once and hands the runtime what it returned, on
  // one host with HSTS, through the same session root and listener as the administrative entry — no command port at all.
  const tenant = readFileSync(join(REPO, 'server', 'entry', 'tenantEntry.ts'), 'utf8');
  assert.deepEqual([...tenant.matchAll(/\bcomposeTenantTransactions\([^)]*\)/g)].map((m) => m[0]), ['composeTenantTransactions(env, construction.databaseClient)'],
    'the tenant entry composes the tenant transaction root once, over its configuration and its database client');
  const tenantApp = [...tenant.matchAll(/\bcreateApp\(\{([^}]*)\}\)/g)].map((m) => m[1]);
  assert.equal(tenantApp.length, 1, 'the tenant entry builds the runtime once');
  for (const field of ['routes: tx\\.routes', 'limits: sessions\\.limits', 'sessions: sessions\\.sessions', 'hsts: true', 'hosts: \\[tenantHost\\]']) {
    assert.match(tenantApp[0], new RegExp(`(?:^|\\s)${field},`), `the tenant runtime's ${field.replace(/\\/g, '')}`);
  }
  assert.doesNotMatch(tenantApp[0], /\b(?:idempotency|transactions|events)\s*:/, 'the tenant runtime composes no idempotency, transaction port or event contract');
  assert.deepEqual([...tenant.matchAll(/\bcreateBoundedServer\([^)]*\)/g)].map((m) => m[0]), ['createBoundedServer(app, { hsts: true })'],
    'the tenant entry binds one listener, with HSTS');
  assert.deepEqual([...tenant.matchAll(/^.*\btenantHost\s*(?::[^=\n]*)?=(?!=).*$/gm)].map((m) => m[0].trim()),
    ['const tenantHost = new URL(env.SESSION_TENANT_ORIGINS as string).host;'], 'the served host is SESSION_TENANT_ORIGINS\'s own, assigned once');
  assert.match(tenant, /\bconst tx = transactions;/, 'tx is the tenant transaction root\'s result');
  assert.deepEqual([...tenant.matchAll(/^.*\btransactions\s*(?::[^=\n]*)?=(?!=).*$/gm)].map((m) => m[0].trim()),
    ['let transactions: ReadTransactions | null = null;', 'transactions = composeTenantTransactions(env, construction.databaseClient);'],
    'transactions is assigned only its null initialiser and the tenant transaction root\'s return value');
  assert.doesNotMatch(tenant, /\b(?:transactions|tx)\b(?:\??\.\w+|\[[^\]]*\])+\s*(?:[-+*/%&|^]|\?\?|\|\||&&)?=(?!=)/,
    'the tenant entry never rewrites a member of the tenant transaction root\'s result');
  assert.doesNotMatch(tenant, /\bObject\.(?:assign|defineProperty|defineProperties|setPrototypeOf)\(\s*(?:transactions|tx)\b/,
    'the tenant entry never rewrites a member of the tenant transaction root\'s result');
  // A9: the tenant executable passes the one production construction, exactly as the administrative executable does.
  const executableCall = (f, starter) => {
    const calls = [];
    const visit = (n) => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === starter) calls.push(n);
      ts.forEachChild(n, visit);
    };
    const source = readFileSync(join(REPO, 'server', 'entry', f), 'utf8');
    visit(ts.createSourceFile(f, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS));
    assert.equal(calls.length, 1, `${f} calls ${starter} exactly once`);
    const [options] = calls[0].arguments;
    assert.ok(options !== undefined && ts.isObjectLiteralExpression(options), `${f}: ${starter}'s options are an object literal`);
    return [options.properties.map((p) => p.getText()).join('\n'), importSpecifiers(source)];
  };
  const [adminOptions, adminImports] = executableCall('main.ts', 'startProductionEntry');
  const [tenantOptions, tenantImports] = executableCall('tenantMain.ts', 'startTenantEntry');
  assert.equal(tenantOptions, adminOptions, 'the tenant executable\'s options are the administrative executable\'s, text for text');
  assert.equal(tenantOptions.split('\n').slice(0, 3).join('\n'), 'env: process.env\nconstruction: PRODUCTION_CONSTRUCTION\nproc: process',
    'the process environment, PRODUCTION_CONSTRUCTION and the process');
  assert.match(tenantOptions.split('\n')[3] ?? '', /^exit: \(code\) => \{ process\.exit\(code\); \}$/, 'and process.exit');
  assert.equal(tenantOptions.split('\n').length, 4, 'and nothing else');
  assert.deepEqual(tenantImports, adminImports.map((spec) => (spec === './productionEntry.js' ? './tenantEntry.js' : spec)),
    'the same import specifiers, the tenant entry in place of the administrative one');
  assert.match(readFileSync(join(REPO, 'server', 'entry', 'tenantMain.ts'), 'utf8'), /^import \{ PRODUCTION_CONSTRUCTION \} from '\.\/entryStartup\.js';$/m,
    'PRODUCTION_CONSTRUCTION by that name, from its one defining module');
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
  assert.match(table[1], /\blimiter:\s*null,\s*$/, 'and, with no durable bundle, binds no limiter: only the transaction root\'s binding fills that slot (M6-RATE-P2)');
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

test('the PostgreSQL transactional store is composed by the transaction root alone, over a kernel only the database boundary builds: the entry reaches both through that root, with no migration authority in its graph, and the store builds no client', () => {
  // M6-PG-P4 built the adapter for the three M6 ports; M6-PG-P7-R1 makes it composition-ready. Exactly one production module
  // composes the store (server/composition/productionTransactions.ts), exactly one builds the kernel under it over the driver
  // (server/platform-identity/db.ts). M6-ENTRY-P1: the deployable executable (server/entry/main.ts) ships both, reaching them
  // only through the transaction root; its import graph is exactly the compiled artifact and holds no migration authority.
  // M7A-CUSTOMERS-P2: the tenant executable (server/entry/tenantMain.ts) likewise, through the tenant transaction root; both
  // roots compose over the one transaction kernel (transactionKernel.ts), and both entries share entryStartup.ts.
  const PERSISTENCE = join(REPO, 'server', 'persistence');
  const rel = (p) => p.slice(REPO.length + 1);
  const cfg = JSON.parse(readFileSync(join(REPO, 'tsconfig.server.json'), 'utf8'));
  assert.deepEqual(cfg.files, ['server/entry/main.ts'], 'the emitted server artifact is the executable\'s import closure');
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
  const tenantCfg = JSON.parse(readFileSync(join(REPO, 'tsconfig.server.tenant.json'), 'utf8'));
  assert.deepEqual(tenantCfg.files, ['server/entry/tenantMain.ts'], 'the emitted tenant artifact is the tenant executable\'s import closure');
  const ENTRY_SOURCES = ['main.ts', 'productionEntry.ts', 'entryStartup.ts', 'tenantMain.ts', 'tenantEntry.ts'].map((f) => join(REPO, 'server', 'entry', f));
  const entry = graphOf([ENTRY_SOURCES[0]]);
  const tenantEntry = graphOf([ENTRY_SOURCES[3]]);
  for (const [graph, artifact, label] of [[entry, ARTIFACT, 'administrative'], [tenantEntry, TENANT_ARTIFACT, 'tenant']]) {
    assert.ok(graph.has(join(RUNTIME_DIR, 'app.ts')), `the ${label} walk reaches the runtime it guards`);
    assert.deepEqual([...graph].map((f) => rel(f).replace(/\.ts$/, '.js')).sort(), artifact,
      `the ${label} executable's static import graph is exactly its compiled artifact: no store, kernel, client or module beyond what ships`);
    for (const f of graph) {
      assert.doesNotMatch(rel(f), /migrationExecutor|migrationEngine|^scripts\/|\.testkit\.|\.test\./, `${rel(f)}: migration authority, an operator script or test code in the ${label} entry's graph`);
    }
  }
  // The entries' one edge into the persistence layer is type-only (the kernel's type, for the construction seam they share):
  // erased at compile time, so every store, kernel and preflight they run is a transaction root's.
  assert.deepEqual(ENTRY_SOURCES.flatMap((f) => importSpecifiers(readFileSync(f, 'utf8')).filter((spec) => spec.includes('persistence/'))),
    ['../persistence/supervisedPgClient.js'], 'the entries have one edge into the persistence layer');
  assert.match(readFileSync(ENTRY_SOURCES[2], 'utf8'), /^import type \{ SupervisedPgClient \} from '\.\.\/persistence\/supervisedPgClient\.js';$/m,
    'and that edge is `import type`');
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
  const importers = production.filter((p) => !p.startsWith(PERSISTENCE) && importSpecifiers(readFileSync(p, 'utf8')).some((s) => s.includes('persistence/'))).map(rel).sort();
  assert.deepEqual(importers, ['server/composition/productionTransactions.ts', 'server/composition/tenantTransactions.ts',
    'server/composition/transactionKernel.ts', 'server/entry/entryStartup.ts', 'server/platform-identity/db.ts'],
    'the transaction roots (the command store; the customer directory), the kernel both share (the session store, the admission, the rate limiter and the startup preflight), the entries (type-only: the kernel\'s type) and the database-client boundary (the kernel) import the persistence layer');
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
  // M6-RATE-P2: the PostgreSQL rate limiter likewise, over that root's one kernel — the session root receives only its binding.
  assert.deepEqual(names('createPostgresRateLimiter', 'rateLimiter: createPostgresRateLimiter'),
    ['server/composition/transactionKernel.ts', 'server/persistence/postgresRateLimiter.ts'], 'the rate limiter is composed by the transaction kernel alone');
  assert.deepEqual(names('createSupervisedPgClient', 'createSupervisedPgClient(postgres, url, options)'),
    ['server/persistence/supervisedPgClient.ts', 'server/platform-identity/db.ts'], 'the kernel is built over the driver by the database-client boundary alone');
  assert.deepEqual(names('createRuntimeStoreClient', 'client: createRuntimeStoreClient'),
    ['server/composition/transactionKernel.ts', 'server/entry/entryStartup.ts', 'server/platform-identity/db.ts'],
    'the store client is defined by the database-client boundary and named as the production construction by the entries\' shared module and, as its default, by the transaction kernel');
  assert.deepEqual(names('sealedRuntimeTarget', 'sealedRuntimeTarget(endpoint)'),
    ['server/platform-identity/databaseEndpoint.ts', 'server/platform-identity/db.ts'], 'the sealed endpoint is read by the database-client boundary alone');
  assert.deepEqual(names('assembleTransactions', 'assembleTransactions(inventory, env, factories)'),
    ['server/composition/productionTransactions.ts'], 'the transaction boundary is assembled by its root alone');
  // M7A-CUSTOMERS-P2 (critic A5): the read-only seam has one caller, the tenant root has one caller, the issuer key one
  // parser and one configuration judge, and the customer directory's production adapter is bound by the tenant root alone.
  assert.deepEqual(names('composeReadTransactions', 'composeReadTransactions(inventory, env, client)'),
    ['server/composition/tenantTransactions.ts', 'server/composition/transactionKernel.ts'], 'the read-only composition is called by the tenant root alone');
  assert.deepEqual(names('composeTenantTransactions', 'composeTenantTransactions(env, client)'),
    ['server/composition/tenantTransactions.ts', 'server/entry/tenantEntry.ts'], 'the tenant root is composed by the tenant entry alone');
  assert.deepEqual(names('parseTenantIssuerKey', 'parseTenantIssuerKey(env)'),
    ['server/composition/transactionKernel.ts', 'server/entry/tenantEntry.ts'], 'the issuer key is parsed by the kernel and judged by the tenant entry alone');
  for (const name of ['createPostgresCustomerDirectory', 'probeCustomerDirectory']) {
    assert.deepEqual(names(name, `ports: ${name}`), ['server/composition/tenantTransactions.ts', 'server/persistence/postgresCustomerDirectory.ts'],
      `${name} is bound by the tenant root alone`);
  }
  // The tenant inventory, exactly (as PRODUCTION_INVENTORY is pinned above): the customer route over its production adapter
  // and probe. A route added, or the adapter or probe swapped for another, fails here.
  const TENANT_INVENTORY = /^export const TENANT_INVENTORY: ReadInventory<CustomerDirectoryPorts> = Object\.freeze\(\{\n {2}reads: Object\.freeze\(\[createCustomerDirectoryRoute\]\),\n {2}ports: \(client: SupervisedPgClient\) => Object\.freeze\(\{ customers: createPostgresCustomerDirectory\(\{ client \}\) \}\),\n {2}inert: INERT,\n {2}probe: probeCustomerDirectory,\n\}\);$/m;
  const tenantInventory = (reads, adapter) => `export const TENANT_INVENTORY: ReadInventory<CustomerDirectoryPorts> = Object.freeze({\n  reads: Object.freeze([${reads}]),\n  ports: (client: SupervisedPgClient) => Object.freeze({ customers: ${adapter}({ client }) }),\n  inert: INERT,\n  probe: probeCustomerDirectory,\n});`;
  assert.match(tenantInventory('createCustomerDirectoryRoute', 'createPostgresCustomerDirectory'), TENANT_INVENTORY, 'the pin reads the real shape');
  assert.doesNotMatch(tenantInventory('createCustomerDirectoryRoute, createOrdersRoute', 'createPostgresCustomerDirectory'), TENANT_INVENTORY, 'the scan must catch a route added');
  assert.doesNotMatch(tenantInventory('createCustomerDirectoryRoute', 'createMemoryCustomerDirectory'), TENANT_INVENTORY, 'the scan must catch a swapped adapter');
  assert.match(readFileSync(join(REPO, 'server', 'composition', 'tenantTransactions.ts'), 'utf8'), TENANT_INVENTORY,
    'the tenant inventory is exactly the customer route over the production customer directory');
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
    'server/platform-identity/db.ts': ['CONTEXT_SETTINGS', 'DB_SESSION_BOUNDS', 'DRIVER_TLS_ENV_VAR', 'DatabaseTlsRefusal', 'assertCaCertificates', 'assertTenantContext', 'closeDb', 'closeRuntimeDb',
      'createRuntimeStoreClient', 'discardNotice', 'getDb', 'getRuntimeDb', 'readTenantContext', 'resolveDatabaseTls', 'runtimeClientOptions', 'withTenantContext'],
    'server/platform-identity/databaseEndpoint.ts': ['ENDPOINT_GRAMMAR', 'classifyRuntimeDatabaseUrl', 'sealedRuntimeTarget'],
    'server/composition/productionTransactions.ts': ['<export { TransactionCompositionError, uncataloguedRoutePermissions } from \'./transactionKernel.js\';>',
      'PRODUCTION_INVENTORY', 'assembleTransactions', 'composeProductionTransactions', 'productionRouteDeclarations'],
    'server/composition/transactionKernel.ts': ['KERNEL_FACTORIES', 'TransactionCompositionError', 'composeReadTransactions', 'kernelOver',
      'parseTenantIssuerKey', 'runtimeEndpoint', 'uncataloguedRoutePermissions'],
    'server/composition/tenantTransactions.ts': ['TENANT_INVENTORY', 'composeTenantTransactions', 'tenantRouteDeclarations'],
  };
  for (const [file, expected] of Object.entries(surfaces)) {
    assert.deepEqual(surfaceOf(trees.get(join(REPO, file))), [...expected].sort(), `${file}: exact value export surface`);
  }
  // M6-ENTRY-P1: the entry names no store, kernel or port constructor — every create* the persistence layer and the three
  // command ports export, read from their syntax trees so a new one is covered — nor the transaction assembler.
  const constructors = [...production.filter((p) => p.startsWith(PERSISTENCE)), ...['idempotency.ts', 'commandTransaction.ts', 'outbox.ts'].map((f) => join(RUNTIME_DIR, f))]
    .flatMap((p) => surfaceOf(trees.get(p))).filter((n) => /^create[A-Z]/.test(n));
  for (const name of ['createPostgresTransactionalStore', 'createSupervisedPgClient', 'createIdempotency', 'createCommandTransactions', 'createOutboxDelivery']) {
    assert.ok(constructors.includes(name), `the constructor census reads ${name}`);
  }
  for (const f of ENTRY_SOURCES) {
    for (const name of [...constructors, 'assembleTransactions', 'composeReadTransactions', 'KERNEL_FACTORIES']) {
      assert.ok(!mentions(trees.get(f), name), `${rel(f)} names ${name}: only a transaction root composes it`);
    }
  }
  // db.ts still ships its DEV-only owner and runtime client factories, uncalled by anything that ships: no module of the
  // executable's import graph but db.ts itself names either one (an identifier or a string; a comment does not count), and
  // none takes db.ts as a namespace (`import * as`, `export * from`, `import()`), through which a computed key would reach either.
  const DB_BOUNDARY = join(REPO, 'server', 'platform-identity', 'db.ts');
  assert.ok(entry.has(DB_BOUNDARY) && tenantEntry.has(DB_BOUNDARY), 'both walks reach the database-client boundary');
  for (const f of new Set([...entry, ...tenantEntry])) {
    if (f === DB_BOUNDARY) continue;
    for (const name of ['getDb', 'getRuntimeDb']) assert.ok(!mentions(trees.get(f), name), `${rel(f)} names ${name}: the DEV-only client factories stay uncalled in the shipped artifact`);
    const wholeModule = (n) => ((ts.isImportDeclaration(n) && ts.isNamespaceImport(n.importClause?.namedBindings ?? n))
      || (ts.isExportDeclaration(n) && (n.exportClause === undefined || ts.isNamespaceExport(n.exportClause))))
      && n.moduleSpecifier !== undefined && ts.isStringLiteral(n.moduleSpecifier) && /(?:^|\/)db\.js$/.test(n.moduleSpecifier.text);
    assert.ok(!trees.get(f).statements.some(wholeModule), `${rel(f)} takes db.ts as a whole namespace`);
    const dynamicDb = (n) => (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword
      && !(n.arguments.length === 1 && ts.isStringLiteralLike(n.arguments[0]) && !/(?:^|\/)db\.js$/.test(n.arguments[0].text))) || (ts.forEachChild(n, dynamicDb) ?? false);
    assert.ok(!dynamicDb(trees.get(f)), `${rel(f)} imports db.ts (or an unnamed module) dynamically`);
  }
  // Runtime composition never reaches migration authority: no executor, engine, applier CLI or managed launcher in its graph.
  const MIGRATION_AUTHORITY = /migrationExecutor|migrationEngine|supabase-migrate|managed-.*launcher/;
  assert.match('server/platform-identity/migrationExecutor.ts', MIGRATION_AUTHORITY, 'the scan must catch the executor');
  const composition = graphOf(['productionTransactions.ts', 'tenantTransactions.ts'].map((f) => join(REPO, 'server', 'composition', f)));
  assert.ok(composition.has(join(PERSISTENCE, 'supervisedPgClient.ts')) && composition.has(join(REPO, 'server', 'platform-identity', 'databaseEndpoint.ts')),
    'the walk reaches the kernel and the classifier');
  for (const f of composition) assert.doesNotMatch(f, MIGRATION_AUTHORITY, `${rel(f)}: migration authority in the runtime composition graph`);
  const code = (p) => readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
  for (const f of ['productionTransactions.ts', 'tenantTransactions.ts', 'transactionKernel.ts']) {
    assert.doesNotMatch(code(join(REPO, 'server', 'composition', f)), /SUPABASE_DATABASE_URL|\bgetDb\b|\bgetRuntimeDb\b/,
      `${f}: a transaction root reads no migration or owner credential and uses no other client`);
  }
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
  const roots = [join(REPO, 'server', 'entry', 'main.ts'), join(REPO, 'server', 'entry', 'tenantMain.ts')];
  (function walk(d) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.[cm]?[jt]s$/.test(p) && !/\.test\.[cm]?[jt]s$/.test(p)) roots.push(p);
    }
  })(join(REPO, 'server', 'composition'));
  assert.ok(roots.length >= 2, 'the production entry and the composition root exist');
  const COMMAND_CENTER = /command[-_]?center/i;
  const COMPUTED = /\b(?:import|require)\s*\((?!\s*(['"])[^'"]*\1\s*\))/;
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

// QA-INTERACTIVE-P1 — the one long-lived owner of an interactive QA session, started detached by `cli.mjs start` under
// tsx and alive after that terminal ends. It owns, in this order: the QA front on :5000 (claimed first, so nothing else
// can take the Preview port), its private control socket (0600, never reachable over HTTP), the Firebase emulators, one
// disposable PostgreSQL cluster from the test harness (migrations 001–035 through the same trusted-apply path every
// DB suite uses), the real tenant runtime (startTenantEntry with the QA verifier as its only substitute), and the
// seeded synthetic world. A failed part leaves the session honestly unavailable; nothing falls back to a real service.
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import tls from 'node:tls';
import { EventEmitter } from 'node:events';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { appendFileSync, chmodSync, copyFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { installTestIssuerKey, resolveDisposableTarget, testClient, testDriver } from '../../db/localPostgres.harness.mjs';
import { assertDisposableTestDsn, createPostgresExecutor, runTrustedApply } from '../../../server/platform-identity/migrationExecutor.ts';
import { createNodeFsPort } from '../../../server/platform-identity/migrationEngine.ts';
import { runtimeClientOptions } from '../../../server/platform-identity/db.ts';
import { createSupervisedPgClient, MAX_POOLS } from '../../../server/persistence/supervisedPgClient.ts';
import { rateLimitKeyFingerprint } from '../../../server/persistence/postgresRateLimiter.ts';
import { startTenantEntry, TENANT_SHIPPING_ROUTES } from '../../../server/entry/tenantEntry.ts';
import { createFaults, createQaFront } from './front.mjs';
import {
  AUTH, FIRESTORE, JVM_MARK, clearEmulators, emulatorsDown, jvmOwned, loadFirestoreRules, signalJvm, startEmulators, stopEmulators, waitEmulatorsReady,
} from './emulators.mjs';
import { createTokenLedger } from './tokens.mjs';
import { createQaVerifier } from './verifier.mjs';
import { accountUids, runProbes, runtimeClient, seedWorld } from './fixtures.mjs';
import { collectEvidence } from './evidence.mjs';
import {
  QA_PORT, REPO_ROOT, STATE_DIR, controlSocketOf, findDescendant, postgresOn, processRecord, readPostmasterPid, removeManifest, removeOwnedDir, stillOwned,
  writeManifest,
} from './ownership.mjs';

const runDir = process.argv[2];
const launch = JSON.parse(readFileSync(join(runDir, 'launch.json'), 'utf8'));
const { runId, publicHost, publicOrigin, projectId, javaBin } = launch;
const API_KEY = JSON.parse(readFileSync(join(REPO_ROOT, 'tests/qa/interactive/qa-firebase-config.json'), 'utf8')).apiKey;
const MIG_REL = 'server/platform-identity/migrations';
const RUNTIME_LOGIN = 'tmpos_qa_runtime';
const POOLS = Math.min(5, MAX_POOLS);
const SUPERVISOR_LOG = join(runDir, 'supervisor.log');
const log = (line) => appendFileSync(SUPERVISOR_LOG, `${new Date().toISOString()} ${line}\n`);

let state = 'starting';
let generation = 0;
let accepted = new Set();
let world = null; // { target, owner, entry, registry }
let emulators = null;
let stopping = null;
let startFailed = false;
let fault = null; // the first reason the session became unavailable: sticky until stop + start
let leftovers = false; // a process of this run could not be proved stopped: the record is kept for cleanup
let resetQueued = false;
let jvmPoll = null; // the Firestore JVM's recording poll (startEverything); stopAll clears it
const faults = createFaults();
// Every ID token the Auth emulator issued in this generation (via the front or the seed/probe sign-ins); nothing else verifies.
const tokens = createTokenLedger();
const qaVerifier = createQaVerifier({ projectId, apiKey: API_KEY, accepts: (uid) => accepted.has(uid), tokens });
const recordSignIn = (idToken) => tokens.record(idToken);

function markUnavailable(why) {
  log(`${why}; the session is unavailable`);
  fault ??= why;
  if (state !== 'stopping' && state !== 'failed') state = 'unavailable';
}

// A stray rejection or exception must not take the session down silently: it is logged and the session says so.
for (const ev of ['unhandledRejection', 'uncaughtException']) {
  process.on(ev, (err) => markUnavailable(`${ev}: ${err?.stack ?? err}`));
}

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().once('error', reject).listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});
const ENTRY_PORT = await freePort();

// ---- the front: claimed before anything else ----------------------------------------------------------------------
const front = createQaFront({
  publicHost,
  staticDir: join(runDir, 'web'),
  apiRoutes: TENANT_SHIPPING_ROUTES,
  targets: { api: { host: '127.0.0.1', port: ENTRY_PORT }, auth: { ...AUTH }, firestore: { ...FIRESTORE } },
  firestoreDatabase: `projects/${projectId}/databases/(default)`,
  faults,
  tokens,
  isReady: () => (state === 'ready' ? true : state),
  log: (line) => appendFileSync(join(runDir, 'front.log'), `${new Date().toISOString()} ${line}\n`),
});
await new Promise((resolve, reject) => {
  front.once('error', reject); // EADDRINUSE: refuse; never another port
  front.listen(QA_PORT, '0.0.0.0', resolve);
}).catch((err) => {
  log(`front could not listen on :${QA_PORT} (${err.code ?? err.message}); refusing`);
  process.exit(3);
});
front.on('error', (err) => markUnavailable(`front error: ${err?.message ?? err}`));
log(`front listening on 0.0.0.0:${QA_PORT} for ${publicHost}`);

// ---- the private control channel ----------------------------------------------------------------------------------
const controlPath = controlSocketOf(runId);
rmSync(controlPath, { force: true });
let queue = Promise.resolve();
const serial = (fn) => {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
};
const control = net.createServer((socket) => {
  let buf = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buf += chunk;
    if (buf.length > 16_384) return socket.destroy();
    const nl = buf.indexOf('\n');
    if (nl === -1) return;
    let req;
    try { req = JSON.parse(buf.slice(0, nl)); } catch { return socket.end(`${JSON.stringify({ ok: false, error: 'bad request' })}\n`); }
    handleCommand(req).then(
      (result) => socket.end(`${JSON.stringify({ ok: true, result })}\n`),
      (err) => socket.end(`${JSON.stringify({ ok: false, error: String(err?.message ?? err) })}\n`),
    );
  });
  socket.on('error', () => {});
});
await new Promise((resolve, reject) => {
  control.once('error', reject);
  control.listen(controlPath, resolve);
}).catch((err) => {
  log(`control socket could not listen (${err.code ?? err.message}); refusing`);
  process.exit(3);
});
control.on('error', (err) => log(`control socket error: ${err?.message ?? err}`));
chmodSync(controlPath, 0o600);

const manifest = {
  runId, publicOrigin, port: QA_PORT, startedAt: new Date().toISOString(), runDir,
  supervisor: processRecord(process.pid), emulators: null, clusterRoot: null,
};
writeManifest(manifest);
const ownExitHook = () => {
  // Last resort on an abrupt exit: the emulators' process group must not outlive its owner.
  if (emulators && emulators.exitCode === null && emulators.signalCode === null) {
    try { process.kill(-emulators.pid, 'SIGTERM'); } catch { /* gone */ }
  }
  signalJvm(manifest.firestoreJvm, 'SIGTERM');
};
process.on('exit', ownExitHook);
const ownSignalHandlers = new Map();
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  const handler = () => { log(`signal ${sig}`); stopAll(); };
  ownSignalHandlers.set(sig, handler);
  process.on(sig, handler);
}
// The harness adds a signal listener per cluster that exits at once; only ours may run, so a signal stops gracefully
// (its 'exit' hook stays) and resets do not pile listeners up.
function dropForeignSignalListeners() {
  for (const [sig, own] of ownSignalHandlers) {
    for (const l of process.listeners(sig)) if (l !== own) process.removeListener(sig, l);
  }
}

// ---- the database, the runtime and the world ----------------------------------------------------------------------
function driverDsn(raw, user) {
  const url = new URL(raw);
  url.search = '';
  url.username = user;
  url.password = '';
  return url.toString();
}

async function setupDatabase(target, owner) {
  await owner.unsafe(`do $$ begin
    if not exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then create role anon nologin; end if;
    if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  end $$;`);
  await owner.unsafe(`revoke create on database "${target.database}" from public`);
  await owner.unsafe(`revoke temporary on database "${target.database}" from public`);
  const handle = await createPostgresExecutor(assertDisposableTestDsn(target.dsn));
  try {
    const report = await runTrustedApply({
      fsPort: createNodeFsPort(join(REPO_ROOT, MIG_REL), MIG_REL), adapter: handle.adapter, ledger: handle.ledger, connectionMode: 'session',
      credential: { purpose: 'migration', migratorRef: 'qa-interactive-migrator', runtimeRef: 'qa-interactive-runtime' },
      lockKey: 528_590, now: () => new Date().toISOString(), deadlineMs: 300_000,
    });
    if (report.outcome !== 'complete') throw new Error(`migrations did not complete: ${String(report.outcome)}`);
  } finally {
    await handle.dispose();
  }
  await owner.unsafe(`create role ${RUNTIME_LOGIN} login nosuperuser nocreatedb nocreaterole noreplication nobypassrls inherit`);
  await owner.unsafe(`grant tmpos_app to ${RUNTIME_LOGIN}`);
  await owner.unsafe(`grant tmpos_audit_writer to ${RUNTIME_LOGIN}`);
  await owner.unsafe(`grant select on public.schema_migrations to ${RUNTIME_LOGIN}`);
}

/** The cluster's postmaster, recorded so a later cleanup can prove it is still ours. */
function postmasterRecord(root) {
  const pid = readPostmasterPid(join(root, 'data'));
  return typeof pid === 'number' ? processRecord(pid) : null;
}

// The 'exit' hooks each cluster's harness registers (they delete its directory), by cluster root.
const harnessExitHooks = new Map();

async function bringUp(gen) {
  const exitBefore = new Set(process.listeners('exit'));
  const target = resolveDisposableTarget(`QA ${runId}`);
  harnessExitHooks.set(target.cluster.root, process.listeners('exit').filter((l) => !exitBefore.has(l)));
  dropForeignSignalListeners();
  if (target.source !== 'harness') throw new Error('QA runs only on a cluster it started itself');
  manifest.clusterRoot = target.cluster.root;
  manifest.postmaster = postmasterRecord(target.cluster.root);
  if (!manifest.postmaster) log(`generation ${gen}: the database server's pid could not be read; only its data directory is recorded`);
  writeManifest(manifest);
  const owner = testClient(target, { max: 3, onnotice: () => {} });
  world = { target, owner, entry: null, registry: null };
  log(`generation ${gen}: cluster up (${target.database}); applying migrations`);
  await setupDatabase(target, owner);

  // Fresh, local, synthetic keys for this generation only: a reset invalidates every earlier session and key.
  const rateKey = randomBytes(32);
  const issuerKey = randomBytes(32);
  const idempotencyKey = randomBytes(32);
  await owner.begin(async (sql) => {
    await sql`delete from tmpos_rate_limit.key_fingerprint`;
    await sql`insert into tmpos_rate_limit.key_fingerprint (singleton, fingerprint) values (true, ${rateLimitKeyFingerprint(rateKey)})`;
  });
  await installTestIssuerKey(owner, issuerKey);
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const env = Object.freeze({
    NODE_ENV: 'production',
    PORT: String(ENTRY_PORT),
    // Required by the entry's preflight in its shipped shape; never dialed (the database client below is injected).
    APP_DATABASE_URL: 'postgres://tmpos_runtime:synthetic-pw@db.abcdefghijklmnop.supabase.co:5432/postgres',
    DATABASE_CA_CERT: tls.rootCertificates[0],
    RATE_LIMIT_KEY: rateKey.toString('base64url'),
    // No proxy is trusted (nothing connects from 127.0.0.2): the front's loopback peer is the client address.
    TRUSTED_PROXY_CIDRS: '127.0.0.2/32',
    SESSION_ADMIN_ORIGINS: 'https://admin.tmpos-qa.test',
    SESSION_TENANT_ORIGINS: publicOrigin,
    TENANT_SESSION_ISSUER_KEY: issuerKey.toString('base64url'),
    IDEMPOTENCY_KEY: idempotencyKey.toString('base64url'),
    FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON: JSON.stringify({
      type: 'service_account', project_id: projectId, client_email: `qa-runtime@${projectId}.iam.gserviceaccount.com`, private_key: privateKey,
    }),
  });
  accepted = accountUids(gen);
  const cap = { codes: [], proc: new EventEmitter(), intended: false };
  const result = await startTenantEntry({
    env,
    construction: {
      databaseClient: () => createSupervisedPgClient(testDriver(target), driverDsn(target.dsn, RUNTIME_LOGIN), {
        ...runtimeClientOptions(target.dsn), ssl: false, max: POOLS, idle_timeout: 0, user: RUNTIME_LOGIN,
      }),
      tokenVerifier: qaVerifier.verifier,
      listen: () => ({ port: ENTRY_PORT, host: '127.0.0.1' }),
    },
    proc: cap.proc,
    exit: (code) => {
      cap.codes.push(code);
      if (!cap.intended) markUnavailable(`the tenant runtime exited unexpectedly (code ${code})`);
    },
    log: { log: (line) => appendFileSync(join(runDir, 'entry.log'), `${line}\n`) },
  });
  if (result.outcome !== 'listening') throw new Error(`the tenant runtime did not start: ${result.outcome} ${(result.reasons ?? []).join(',')}`);
  world.entry = cap;
  log(`generation ${gen}: tenant runtime listening on 127.0.0.1:${ENTRY_PORT}; seeding`);
  world.registry = await seedWorld({
    owner, client: runtimeClient({ port: ENTRY_PORT, publicHost, publicOrigin }), projectId, apiKey: API_KEY, generation: gen, onSignedIn: recordSignIn,
  });
  log(`generation ${gen}: seeded`);
}

async function bringDown() {
  if (!world) return;
  const { entry, owner, target } = world;
  world = null;
  if (entry) {
    entry.intended = true;
    entry.proc.emit('SIGTERM');
    for (const until = Date.now() + 15_000; entry.codes.length === 0 && Date.now() < until;) await new Promise((r) => setTimeout(r, 50));
  }
  await owner.end({ timeout: 5 }).catch(() => {});
  const owned = () => stillOwned(manifest.postmaster, ['postgres']);
  // This cluster's harness 'exit' hook would delete the directory on exit: removed, so cleanupStale finds it intact.
  const keepDirectory = () => { for (const l of harnessExitHooks.get(target.cluster.root) ?? []) process.removeListener('exit', l); };
  // pg_ctl signals whatever pid postmaster.pid names: only a plain pid of a live postgres on exactly this directory (the
  // recorded one, when there is a record), or no live process at all.
  const dataDir = join(target.cluster.root, 'data');
  const filePid = readPostmasterPid(dataDir);
  const fileLive = typeof filePid === 'number' && processRecord(filePid).start !== null;
  const foreign = filePid === undefined
    || (fileLive && !postgresOn(filePid, dataDir))
    || (Boolean(manifest.postmaster) && typeof filePid === 'number' && (filePid !== manifest.postmaster.pid || (!owned() && fileLive)));
  if (foreign) {
    // Not the server we recorded: neither pg_ctl nor the harness may act on it.
    leftovers = true;
    keepDirectory();
    log(`LEFTOVER: an unknown process is named by our data directory's postmaster.pid (pid ${filePid}, recorded pid ${manifest.postmaster?.pid ?? 'none'}, ${target.cluster.root}); pg_ctl was not run; its directory and the record are kept for cleanup`);
    return;
  }
  // Our own stop first: the harness's stop() always deletes the directory, even under a server that would not stop.
  const ours = spawnSync('pg_ctl', ['--pgdata', join(target.cluster.root, 'data'), '--timeout', '60', '-w', '-m', 'fast', 'stop'], {
    env: { PATH: process.env.PATH }, stdio: 'ignore', timeout: 120_000,
  });
  // pg_ctl -w returns once the pid file is gone; the process itself may need a moment more to leave /proc.
  if (manifest.postmaster && ours.status === 0) {
    for (const until = Date.now() + 5000; owned() && Date.now() < until;) await new Promise((r) => setTimeout(r, 100));
  }
  const up = manifest.postmaster ? owned() : ours.status !== 0;
  if (up) {
    leftovers = true;
    keepDirectory();
    log(`LEFTOVER: the disposable database server (pid ${manifest.postmaster?.pid ?? 'unknown'}, ${target.cluster.root}) did not stop (pg_ctl ${ours.status ?? ours.signal ?? ours.error?.code}); its directory and the record are kept for cleanup`);
    return;
  }
  // Stopped: the harness only removes its directory now (its own `stopped` is false when the server was already down).
  const removed = target.cluster.stop();
  log(`cluster stopped (pg_ctl ${ours.status ?? ours.signal ?? ours.error?.code}) removed=${removed.removed}`);
}

async function startEverything() {
  emulators = startEmulators({
    projectId, javaBin, homeDir: join(STATE_DIR, 'home'), cacheDir: join(STATE_DIR, 'firebase-emulators'), logFile: join(runDir, 'emulators.log'),
    workDir: runDir,
  });
  manifest.emulators = processRecord(emulators.pid);
  writeManifest(manifest);
  emulators.once('exit', (code, signal) => {
    if (state !== 'stopping') markUnavailable(`the emulators exited unexpectedly (${code ?? signal})`);
  });
  // The JVM is recorded as soon as it exists, so a supervisor that dies during the (long) first start leaves it findable.
  jvmPoll = setInterval(() => { if (recordJvm()) clearInterval(jvmPoll); }, 1000).unref();
  await waitEmulatorsReady(emulators, 8 * 60_000);
  if (!recordJvm()) log('the Firestore JVM was not found among the emulators\' processes; only the CLI\'s group can be stopped');
  await loadFirestoreRules(projectId);
  log('emulators ready; firestore.rules loaded');
  generation = 1;
  await bringUp(generation);
  state = fault ? 'unavailable' : 'ready';
  log(state);
}

/** Records the Firestore JVM once it is among the emulators' descendants; true when recorded (or nothing is left to do). */
function recordJvm(force = false) {
  if (manifest.firestoreJvm || !emulators || (stopping && !force)) return true;
  const pid = findDescendant(emulators.pid, JVM_MARK);
  if (!pid) return false;
  manifest.firestoreJvm = processRecord(pid);
  writeManifest(manifest);
  log(`the Firestore JVM is pid ${pid}`);
  return true;
}

// Liveness: while ready, status must never say ready over a dead emulator, tenant runtime or database.
const tcpUp = (port) => new Promise((resolve, reject) => {
  const s = net.connect(port, '127.0.0.1');
  const timer = setTimeout(() => { s.destroy(); reject(new Error('no connection in 3 s')); }, 3000);
  s.once('connect', () => { clearTimeout(timer); s.destroy(); resolve(); });
  s.once('error', (err) => { clearTimeout(timer); reject(err); });
});
let checking = false;
const LIVENESS_MISSES = 3;
let missedChecks = 0;
setInterval(async () => {
  const w = world;
  if (state !== 'ready' || checking || !w) return;
  checking = true;
  const gen = generation;
  let why = null;
  try {
    why = await emulatorsDown();
    if (!why) await tcpUp(ENTRY_PORT).catch((err) => { why = `tenant runtime: ${err?.code ?? err?.message ?? err}`; });
    if (!why) {
      await Promise.race([w.owner`select 1`, new Promise((_, rej) => setTimeout(rej, 5000, new Error('no answer in 5 s')).unref())]);
    }
  } catch (err) {
    why = `database: ${err?.message ?? err}`;
  }
  checking = false;
  if (state !== 'ready' || generation !== gen) return;
  // One slow answer under this VM's memory pressure is not a dead part: three misses in a row (about 30 s) are.
  missedChecks = why ? missedChecks + 1 : 0;
  if (why) log(`liveness check missed (${why}); ${missedChecks} of ${LIVENESS_MISSES}`);
  if (missedChecks >= LIVENESS_MISSES) markUnavailable(`liveness check failed ${LIVENESS_MISSES} times in a row (${why})`);
}, 10_000).unref();

// ---- commands -----------------------------------------------------------------------------------------------------
function statusOf() {
  const reg = world?.registry ?? null;
  return {
    runId, state, fault, generation, publicOrigin,
    ports: { front: QA_PORT, runtime: ENTRY_PORT, authEmulator: AUTH.port, firestoreEmulator: FIRESTORE.port },
    processes: { supervisor: process.pid, emulators: emulators?.pid ?? null },
    faults: faults.snapshot(),
    agedSignInPending: qaVerifier.agedPending(),
    accounts: reg ? Object.fromEntries(Object.entries(reg.accounts).map(([k, a]) => [k, {
      email: a.email, password: a.password, role: a.role, tenant: a.tenant, stores: a.stores,
    }])) : null,
    fixtures: reg ? {
      tenants: reg.tenants,
      stores: Object.fromEntries(Object.entries(reg.stores).map(([k, s]) => [k, { id: s.id, tenant: s.tenant, name: s.name }])),
      customers: reg.customers, drafts: reg.drafts, invoices: reg.invoices,
    } : null,
  };
}

const requireReady = () => {
  if (state !== 'ready') throw new Error(`the session is ${state}`);
  return world.registry;
};

async function scenario({ name, target }) {
  const reg = requireReady();
  if (name === 'normal') {
    qaVerifier.clearAged();
    return { disarmed: true, released: await faults.disarm() };
  }
  if (name === 'held-void') {
    const label = target ?? 'inv-held';
    const inv = reg.invoices[label];
    if (!inv) throw new Error(`unknown invoice fixture: ${label}`);
    return faults.arm({ kind: 'held-void', storeId: reg.stores[inv.store].id, invoiceId: inv.id, label });
  }
  if (name === 'stalled-reauth' || name === 'aged-sign-in') {
    const label = target ?? 'owner-a';
    const account = reg.accounts[label];
    if (!account) throw new Error(`unknown account fixture: ${label}`);
    if (name === 'aged-sign-in') {
      qaVerifier.ageNextLogin(account.uid);
      return { armed: 'aged-sign-in', account: label };
    }
    return faults.arm({ kind: 'stalled-reauth', email: account.email, label });
  }
  throw new Error(`unknown scenario: ${name}`);
}

async function reset() {
  try {
    requireReady();
    state = 'resetting';
    missedChecks = 0; // misses before the reset say nothing about the next generation
    log(`reset from generation ${generation}`);
    await faults.disarm();
    qaVerifier.clearAged();
    tokens.clear(); // the previous generation's tokens name accounts that no longer exist
    try {
      await bringDown();
      // Never a second cluster beside one that would not stop: the session ends unavailable instead.
      if (leftovers) throw new Error('the previous generation\'s database server did not stop');
      await clearEmulators(projectId);
      generation += 1;
      // A stop that arrived during this reset wins: no new cluster after it.
      if (stopping) throw new Error('a stop arrived during the reset');
      await bringUp(generation);
      if (!stopping) state = fault ? 'unavailable' : 'ready';
    } catch (err) {
      markUnavailable(`reset failed: ${err?.message ?? err}`);
      throw err;
    }
    return { generation };
  } finally {
    resetQueued = false;
  }
}

function stopAll() {
  if (stopping) return stopping;
  stopping = (async () => {
    state = 'stopping';
    log('stopping');
    // A reset (or other command) under way finishes first, so its cluster is not torn down beneath it; bounded.
    const settled = await Promise.race([queue.then(() => true), new Promise((r) => setTimeout(r, 120_000, false).unref())]);
    if (!settled) log('the running command did not finish in 120 s; stopping anyway');
    await faults.disarm().catch(() => {});
    front.closeAllConnections?.();
    await new Promise((r) => front.close(() => r()));
    await bringDown().catch((err) => { leftovers = true; log(`bring-down: ${err?.message ?? err}`); });
    clearInterval(jvmPoll);
    recordJvm(true); // the last look before the stop, so stopEmulators and keepRecord see a JVM the poll had not yet found
    await stopEmulators(emulators, undefined, manifest.firestoreJvm);
    const cliUp = Boolean(emulators) && emulators.exitCode === null && emulators.signalCode === null;
    // A process this run could not prove stopped keeps the record, so `start`/`stop` can find and clean it later.
    const keepRecord = leftovers || cliUp || jvmOwned(manifest.firestoreJvm) || stillOwned(manifest.postmaster, ['postgres']);
    log(keepRecord ? 'leftover processes; the record is kept for cleanup' : 'stopped');
    // The emulators' log can hold synthetic tokens: it is kept only when it explains a failed start.
    const keep = [[SUPERVISOR_LOG, 'last-run.log'], ...(startFailed ? [[join(runDir, 'emulators.log'), 'last-emulators.log']] : [])];
    for (const [from, to] of keep) {
      try { copyFileSync(from, join(STATE_DIR, to)); } catch { /* best effort */ }
    }
    control.close();
    // A kept record keeps its run directory too (the logs explain the leftovers; cleanupStale removes both).
    if (!keepRecord) {
      removeManifest(runId);
      removeOwnedDir(runDir);
    }
    setTimeout(() => process.exit(0), 50);
  })();
  return stopping;
}

async function handleCommand(req) {
  // Judged at arrival: nothing but status/stop is accepted (or queued behind a reset) unless the session is ready.
  if (req?.cmd !== 'status' && req?.cmd !== 'stop') {
    if (resetQueued) throw new Error('the session is resetting');
    if (state !== 'ready') throw new Error(`the session is ${state}`);
  }
  switch (req?.cmd) {
    case 'status': return statusOf();
    case 'scenario': return serial(() => scenario(req));
    case 'release': return serial(() => { requireReady(); return faults.release(); });
    case 'evidence': return serial(() => collectEvidence(world.owner, requireReady(), { targets: req.targets ?? [], recent: req.recent === true }));
    case 'probe': return serial(() => {
      const reg = requireReady();
      // The probes sign owner-a and tech-a in and void inv-probe: an armed fault or a pending aged sign-in would be consumed.
      const f = faults.snapshot();
      if (f.armed || f.held || qaVerifier.agedPending().length > 0) throw new Error('a fault is armed or pending; run `scenario normal` first');
      return runProbes({ front: runtimeClient({ port: QA_PORT, publicHost, publicOrigin }), reg, apiKey: API_KEY, positive: req.positive === true, onSignedIn: recordSignIn });
    });
    case 'reset': resetQueued = true; return serial(reset);
    case 'stop': stopAll(); return { stopping: true };
    default: throw new Error('unknown command');
  }
}

try {
  await startEverything();
} catch (err) {
  state = 'failed';
  startFailed = true;
  log(`start failed: ${err?.stack ?? err}`);
  await stopAll(); // its forced last look records a JVM the poll had not seen yet
}

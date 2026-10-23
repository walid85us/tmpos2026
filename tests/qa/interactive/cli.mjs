// QA-INTERACTIVE-P1 — the operator interface: `npm run qa:interactive -- <command>` (see `help`). Runs in the owner's
// shell; everything it starts runs in a scoped environment (no ambient database, credential or Firebase settings).
// The only thing that ever receives a signal from here is a process the ownership manifest proves is ours.
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { chmodSync, copyFileSync, existsSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { QaRefusal, assertMemoryHeadroom, findLiveConfigLeaks, javaMajor, resolveLaunchConfig } from './config.mjs';
import { jvmOwned, signalJvm } from './emulators.mjs';
import {
  QA_PORT, REPO_ROOT, STATE_DIR, bootId, cmdline, controlSocketOf, ensureDir, insideStateDir, postgresOn, procStart, readManifest,
  readPostmasterPid, removeManifest, removeOwnedDir, runDirOf, stillOwned,
} from './ownership.mjs';

const HELP = `QA-INTERACTIVE-P1 — isolated interactive QA of the tenant runtime (synthetic data only)

  npm run qa:interactive -- start [--origin https://<host>] [--project demo-<id>]
  npm run qa:interactive -- status
  npm run qa:interactive -- scenario normal
  npm run qa:interactive -- scenario held-void [invoice label, default inv-held]
  npm run qa:interactive -- scenario aged-sign-in [account label, default owner-a]
  npm run qa:interactive -- scenario stalled-reauth [account label, default owner-a]
  npm run qa:interactive -- release
  npm run qa:interactive -- evidence [label|id ...] | evidence --recent
  npm run qa:interactive -- probe [--positive]
  npm run qa:interactive -- reset
  npm run qa:interactive -- stop
`;
const SUPERVISOR = join(REPO_ROOT, 'tests/qa/interactive/supervisor.mjs');
const LAST_LOG = join(STATE_DIR, 'last-run.log');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function control(runId, request, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(controlSocketOf(runId));
    let buf = '';
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('the session did not answer in time')); }, timeoutMs);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('data', (c) => { buf += c; });
    socket.on('error', (e) => { clearTimeout(timer); reject(e); });
    socket.on('end', () => {
      clearTimeout(timer);
      try {
        const reply = JSON.parse(buf);
        if (reply.ok) resolve(reply.result);
        else reject(new Error(reply.error));
      } catch {
        reject(new Error('unreadable answer from the session'));
      }
    });
  });
}

/** The live session from the manifest, or { stale } / null. Liveness = pid + start time + boot id + command line. */
function current() {
  const m = readManifest();
  if (m === null) return null;
  if (m.corrupt || typeof m.runId !== 'string') return { stale: m };
  return stillOwned(m.supervisor, ['supervisor.mjs', m.runDir]) ? { live: m } : { stale: m };
}

/** The stale cluster's postmaster pid only while it provably is that server (same boot, alive, postgres on that data dir). */
function livePostmaster(m, dataDir) {
  if (m.supervisor?.bootId !== bootId()) return null; // after a reboot the recorded pid may be recycled
  const pid = readPostmasterPid(dataDir);
  if (typeof pid !== 'number' || procStart(pid) === null) return null;
  // With a record, only the very process it names (same pid, start time and boot) counts as the stale server.
  if (m.postmaster && !(pid === m.postmaster.pid && stillOwned(m.postmaster, ['postgres']))) return null;
  return postgresOn(pid, dataDir) ? pid : null;
}

/** Every live process whose command line names `path` (a /proc scan): a server the record may not know, e.g. after a reboot. */
function processesNaming(path) {
  return readdirSync('/proc').filter((n) => /^\d+$/.test(n) && Number(n) !== process.pid && cmdline(n).includes(path)).map(Number);
}

/** True once `owned()` turns false within `ms`. */
async function goneWithin(owned, ms) {
  for (const until = Date.now() + ms; Date.now() < until && owned();) await sleep(200);
  return !owned();
}

// A recorded process that survives every signal: nothing is deleted under it, the record stays for the next attempt.
const stillRunning = (what, pid) => new QaRefusal('stale_process_running', `the previous run's ${what} (pid ${pid}) did not stop; its record and directories are kept. End that process yourself (check with \`ps -p ${pid}\`) and run this again`);

async function cleanupStale(m) {
  const notes = [];
  const emulatorsOwned = () => m.emulators && stillOwned(m.emulators, ['emulators:start', 'firebase.qa.json']);
  if (emulatorsOwned()) {
    // A supervisor killed outright leaves them holding their ports; the next run's emulators would not start.
    try { process.kill(-m.emulators.pid, 'SIGTERM'); } catch { /* gone */ }
    if (!(await goneWithin(emulatorsOwned, 10_000))) {
      try { process.kill(-m.emulators.pid, 'SIGKILL'); } catch { /* gone */ }
      if (!(await goneWithin(emulatorsOwned, 5_000))) throw stillRunning('emulators', m.emulators.pid);
    }
    notes.push(`stopped the previous run's emulators (pid ${m.emulators.pid})`);
  }
  const jvmUp = () => jvmOwned(m.firestoreJvm);
  if (m.firestoreJvm && jvmUp()) {
    signalJvm(m.firestoreJvm, 'SIGTERM');
    if (!(await goneWithin(jvmUp, 10_000))) {
      signalJvm(m.firestoreJvm, 'SIGKILL');
      if (!(await goneWithin(jvmUp, 5_000))) throw stillRunning('Firestore emulator JVM', m.firestoreJvm.pid);
    }
    notes.push(`stopped the previous run's Firestore emulator JVM (pid ${m.firestoreJvm.pid})`);
  }
  const dataDir = insideStateDir(m.clusterRoot) ? join(resolve(m.clusterRoot), 'data') : null;
  const pgPid = dataDir && livePostmaster(m, dataDir);
  if (pgPid) {
    const pg = { env: { PATH: process.env.PATH }, stdio: 'ignore', timeout: 60_000 };
    if (spawnSync('pg_ctl', ['--pgdata', dataDir, '-m', 'fast', '-w', 'stop'], pg).status !== 0) {
      // Gone only when proved: no live postmaster on that directory AND pg_ctl says not running (3) or no data dir (4).
      // Still running (or unknown): deleting its directory under it would lose the evidence and leave a server nobody can stop by path.
      const status = spawnSync('pg_ctl', ['--pgdata', dataDir, 'status'], pg).status;
      if (livePostmaster(m, dataDir) !== null || (status !== 3 && status !== 4)) {
        throw new QaRefusal('stale_cluster_running', `the previous run's database server (data ${dataDir}, pid ${pgPid}) did not stop; its directories and record are kept. Stop it (\`pg_ctl --pgdata ${dataDir} -m fast stop\`) and run this again`);
      }
    }
    notes.push('stopped the previous run\'s database cluster');
  }
  const postmasterUp = () => stillOwned(m.postmaster, ['postgres']);
  if (postmasterUp()) {
    // Still ours after the above (typically its data directory is gone, so pg_ctl cannot act): SIGINT is a fast
    // shutdown, SIGQUIT an immediate one.
    try { process.kill(m.postmaster.pid, 'SIGINT'); } catch { /* gone */ }
    if (!(await goneWithin(postmasterUp, 10_000))) {
      try { process.kill(m.postmaster.pid, 'SIGQUIT'); } catch { /* gone */ }
      if (!(await goneWithin(postmasterUp, 5_000))) throw stillRunning('database server', m.postmaster.pid);
    }
    notes.push(`stopped the previous run's database server (pid ${m.postmaster.pid})`);
  }
  const naming = dataDir ? processesNaming(dataDir) : [];
  if (naming.length > 0) {
    // Never delete a directory a live process names: that server keeps running on it whatever the record says.
    throw new QaRefusal('stale_cluster_running', `a live process (pid ${naming.join(', ')}) still names the previous run's database directory (data ${dataDir}); its directories and record are kept. Stop it (\`pg_ctl --pgdata ${dataDir} -m fast stop\`) and run this again`);
  }
  if (typeof m.clusterRoot === 'string' && removeOwnedDir(m.clusterRoot)) notes.push('removed its cluster directory');
  if (typeof m.runDir === 'string' && removeOwnedDir(m.runDir)) notes.push('removed its run directory');
  removeManifest(m.runId);
  if (m.corrupt || typeof m.runId !== 'string') notes.push('the session record was unreadable and has been removed; check for leftover QA processes (ps) before starting');
  return notes;
}

function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer().once('error', () => resolve(false)).listen(port, '0.0.0.0', () => s.close(() => resolve(true)));
  });
}

function findJava() {
  const onPath = spawnSync('sh', ['-c', 'command -v java'], { encoding: 'utf8' }).stdout.trim();
  // shortcut: the newest openjdk-21 already in the Nix store when java is not on PATH; put another java on PATH to use it.
  const java = onPath || (readdirSync('/nix/store').filter((n) => /^[a-z0-9]{32}-openjdk-21[^/]*$/.test(n) && !n.endsWith('.drv'))
    .sort().map((n) => `/nix/store/${n}/bin/java`).filter((p) => existsSync(p)).pop() ?? '');
  const probe = java ? spawnSync(java, ['-version'], { encoding: 'utf8' }) : null;
  const major = javaMajor(probe?.stderr ?? ''); // null when unreadable: refused below
  if (!java || probe.status !== 0 || !(major >= 21)) {
    throw new QaRefusal('java_missing', 'the Firestore emulator needs Java 21 or newer: put java on PATH (e.g. `nix shell nixpkgs#jdk21_headless`) and run start again');
  }
  return java;
}

function printSummary(s) {
  const lines = [`QA session ${s.state} — run ${s.runId}, generation ${s.generation}`, `Preview: ${s.publicOrigin}/  (the corner label reads "QA ONLY · synthetic data · run ${s.runId}")`];
  if (s.fault) lines.push(`Fault: ${s.fault}`);
  if (s.accounts) {
    lines.push('', 'Accounts (fictional; sign in at /login with these):');
    for (const [label, a] of Object.entries(s.accounts)) {
      lines.push(`  ${label.padEnd(10)} ${a.email.padEnd(24)} ${a.password.padEnd(20)} ${a.role.padEnd(12)} ${a.tenant}  stores: ${a.stores.join(', ')}`);
    }
  }
  if (s.fixtures) {
    lines.push('', 'Fixtures (label → id):');
    for (const group of ['tenants', 'stores', 'customers', 'drafts', 'invoices']) {
      for (const [label, v] of Object.entries(s.fixtures[group])) lines.push(`  ${group.padEnd(9)} ${label.padEnd(15)} ${typeof v === 'string' ? v : `${v.id}${v.name ? `  ${v.name}` : ''}${v.store ? `  @${v.store}` : ''}`}`);
    }
  }
  const f = s.faults;
  lines.push('', `Faults: armed=${f.armed ? `${f.armed.kind} ${f.armed.label}` : 'none'} held=${f.held ? `${f.held.label} since ${f.held.heldAt}` : 'none'} aged-sign-in pending=${s.agedSignInPending.length}`);
  for (const e of f.entries.slice(-5)) lines.push(`  fault record: ${JSON.stringify(e)}`);
  lines.push(`Processes: supervisor ${s.processes.supervisor}, emulators ${s.processes.emulators}; ports: front ${s.ports.front} (public), runtime ${s.ports.runtime}, auth emulator ${s.ports.authEmulator}, firestore emulator ${s.ports.firestoreEmulator} (loopback)`);
  console.log(lines.join('\n'));
}

async function start(args) {
  const found = current(); // before the options: a second start only ever reports the live session
  if (found?.live) {
    console.log(`A QA session is already running (run ${found.live.runId}); nothing new was started and no other port is used.`);
    printSummary(await control(found.live.runId, { cmd: 'status' }));
    return;
  }
  const config = resolveLaunchConfig({ env: process.env, args });
  if (found?.stale) for (const note of await cleanupStale(found.stale)) console.log(`(previous run) ${note}`);
  assertMemoryHeadroom(readFileSync('/proc/meminfo', 'utf8'));
  if (!(await portFree(QA_PORT))) {
    throw new QaRefusal('port_busy', `something already listens on :${QA_PORT} (usually the dev server: Replit's Run/Stop button or \`npm run dev\`). Stop it, then start again; QA never moves to another port`);
  }
  const javaBin = findJava();
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13).toLowerCase();
  const runId = `qa-${stamp}-${Math.random().toString(16).slice(2, 6)}`;
  const runDir = ensureDir(runDirOf(runId));
  ensureDir(join(STATE_DIR, 'tmp'));
  const home = ensureDir(join(STATE_DIR, 'home'));

  console.log(`Building the QA bundle (run ${runId}) …`);
  const buildLog = openSync(join(runDir, 'build.log'), 'a', 0o600);
  const build = spawnSync(join(REPO_ROOT, 'node_modules/.bin/vite'), ['build', '--config', 'tests/qa/interactive/vite.qa.config.ts', '--logLevel', 'warn'], {
    cwd: REPO_ROOT, timeout: 600_000, stdio: ['ignore', buildLog, buildLog],
    env: {
      PATH: process.env.PATH, HOME: home, LANG: process.env.LANG ?? 'C.UTF-8',
      QA_PUBLIC_ORIGIN: config.publicOrigin, QA_PROJECT_ID: config.projectId, QA_RUN_ID: runId,
      QA_OUT_DIR: join(runDir, 'web'), QA_CACHE_DIR: join(STATE_DIR, 'vite-cache'),
    },
  });
  if (build.status !== 0) {
    const keptLog = join(STATE_DIR, 'last-build.log');
    let kept = true;
    try { copyFileSync(join(runDir, 'build.log'), keptLog); chmodSync(keptLog, 0o600); } catch { kept = false; }
    removeOwnedDir(runDir);
    throw new QaRefusal('build_failed', `the QA bundle did not build (exit ${build.status ?? build.signal})${kept ? `; its log is kept at ${keptLog}` : ''}`);
  }
  const live = Object.values(JSON.parse(readFileSync(join(REPO_ROOT, 'firebase-applet-config.json'), 'utf8'))).filter((v) => typeof v === 'string');
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
  const leaks = findLiveConfigLeaks(walk(join(runDir, 'web')).map((f) => ({ name: relative(runDir, f), text: readFileSync(f, 'utf8') })), live);
  if (leaks.length > 0) {
    removeOwnedDir(runDir);
    throw new QaRefusal('live_config_in_bundle', `the QA bundle contains live Firebase configuration (${leaks.join(', ')}); refusing to serve it`);
  }
  if (!(await portFree(QA_PORT))) {
    removeOwnedDir(runDir);
    throw new QaRefusal('port_busy', `:${QA_PORT} was taken while the bundle was building (Replit restarts the dev server when the port is free). Stop it and start again`);
  }
  writeFileSync(join(runDir, 'launch.json'), JSON.stringify({ runId, ...config, javaBin }), { mode: 0o600 });
  const out = openSync(join(runDir, 'supervisor.out'), 'a', 0o600);
  const child = spawn(join(REPO_ROOT, 'node_modules/.bin/tsx'), [SUPERVISOR, runDir], {
    cwd: REPO_ROOT, detached: true, stdio: ['ignore', out, out],
    env: { PATH: process.env.PATH, HOME: home, TMPDIR: join(STATE_DIR, 'tmp'), LANG: process.env.LANG ?? 'C.UTF-8' },
  });
  child.unref();
  console.log('Starting the emulators, the disposable database and the tenant runtime (the first start downloads the Firestore emulator) …');
  let last = '';
  let brokeOn = null;
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  for (const until = Date.now() + 12 * 60_000; Date.now() < until;) {
    await sleep(2000);
    const now = current();
    if (now?.live && now.live.runId !== runId) {
      console.log(`another start won (run ${now.live.runId})`); // that run is left alone
      // Our own supervisor still reads its run directory until it has given up on the port.
      for (const end = Date.now() + 30_000; Date.now() < end && !exited();) await sleep(200);
      if (exited()) removeOwnedDir(runDir);
      process.exitCode = 1;
      return;
    }
    if (!now?.live) {
      if (child.exitCode !== null || !existsSync(runDir)) break;
      continue;
    }
    let s;
    try { s = await control(runId, { cmd: 'status' }, 10_000); } catch { continue; }
    if (s.state !== last) { console.log(`  … ${s.state}`); last = s.state; }
    if (s.state === 'ready') { printSummary(s); return; }
    if (s.state === 'failed' || s.state === 'unavailable') { brokeOn = s.state; break; }
  }
  if (brokeOn) {
    // A start that failed stops itself at once (failed → stopping → exit): wait for that before calling it still running.
    // 'unavailable' too: an emulator exit during the first start shows it moments before the start fails and tears down.
    for (const until = Date.now() + 30_000; Date.now() < until && current()?.live?.runId === runId;) {
      const st = await control(runId, { cmd: 'status' }, 5_000).then((r) => r.state, () => 'stopping'); // no answer: closing
      if (st !== 'stopping' && st !== 'failed' && st !== 'unavailable') break;
      await sleep(500);
    }
  }
  const earlier = [LAST_LOG, join(STATE_DIR, 'last-emulators.log')]; // written only when a run finishes
  const tailOf = (file) => {
    const text = existsSync(file) ? readFileSync(file, 'utf8').trim() : '';
    if (!text) return '';
    const mark = earlier.includes(file) ? ' (from an earlier run unless this run has finished)' : '';
    return `--- ${relative(REPO_ROOT, file)}${mark}\n${text.split('\n').slice(-12).join('\n')}`;
  };
  const tail = [join(runDir, 'supervisor.out'), join(runDir, 'supervisor.log'), join(runDir, 'emulators.log'), ...earlier]
    .map(tailOf).filter(Boolean).join('\n') || '(no log)';
  const after = current();
  if (after?.live?.runId === runId) {
    // Unavailable, failed (still stopping) or timed out: that supervisor owns its processes and directory until `stop`.
    const s = await control(runId, { cmd: 'status' }, 10_000).then((r) => r.state, () => last || 'unknown');
    throw new QaRefusal('start_failed', `the QA session did not become ready: the session (run ${runId}) is still running in state ${s}; run \`stop\` before starting again. Last log lines:\n${tail}`);
  }
  if (after?.stale?.runId === runId) {
    // Our supervisor died and left its record: clean what it owned now (the tail is captured first).
    try {
      for (const note of await cleanupStale(after.stale)) console.log(`(this run) ${note}`);
    } catch (err) {
      if (err instanceof QaRefusal) throw new QaRefusal(err.code, `${err.message}\nLast log lines:\n${tail}`);
      throw err;
    }
  }
  removeOwnedDir(runDir); // the tail is captured; a failed run leaves no directory behind
  throw new QaRefusal('start_failed', `the QA session did not become ready. Last log lines:\n${tail}`);
}

async function stop() {
  const found = current();
  if (found === null) { console.log('No QA session is running.'); return; }
  if (found.stale) {
    for (const note of await cleanupStale(found.stale)) console.log(note);
    console.log('The recorded session was no longer running (e.g. after a reboot); its leftovers are cleaned.');
    return;
  }
  const m = found.live;
  await control(m.runId, { cmd: 'stop' }).catch(() => {});
  // 240 s: the supervisor may first wait up to 120 s for an accepted reset, then its teardown takes up to ~110 s.
  for (const until = Date.now() + 240_000; Date.now() < until && stillOwned(m.supervisor, ['supervisor.mjs', m.runDir]);) await sleep(500);
  if (stillOwned(m.supervisor, ['supervisor.mjs', m.runDir])) {
    process.kill(m.supervisor.pid, 'SIGTERM');
    for (const until = Date.now() + 30_000; Date.now() < until && stillOwned(m.supervisor, ['supervisor.mjs', m.runDir]);) await sleep(500);
    if (stillOwned(m.supervisor, ['supervisor.mjs', m.runDir])) {
      console.log(`Run ${m.runId} is still running (supervisor pid ${m.supervisor.pid}) after SIGTERM; nothing was cleaned. Run stop again, or end that process yourself.`);
      process.exitCode = 1;
      return;
    }
  }
  const left = readManifest();
  if (left && !left.corrupt && left.runId === m.runId) for (const note of await cleanupStale(left)) console.log(note);
  console.log(`Stopped run ${m.runId}: the front, the tenant runtime, the emulators and the disposable database are closed; synthetic data discarded. Restore the ordinary Preview with Replit's Run button or \`npm run dev\`.`);
}

async function main() {
  const [cmd = 'help', ...args] = process.argv.slice(2);
  if (cmd === 'start') return start(args);
  if (cmd === 'stop') return stop();
  if (cmd === 'help' || cmd === '--help') { console.log(HELP); return; }
  const found = current();
  if (!found?.live) {
    if (cmd === 'status') {
      console.log(found?.stale ? 'No QA session is running (a stale record remains; `start` or `stop` cleans it).' : 'No QA session is running.');
      return;
    }
    throw new QaRefusal('not_running', 'no QA session is running; start one first');
  }
  const runId = found.live.runId;
  const show = (r) => console.log(JSON.stringify(r, null, 2));
  if (cmd === 'status') return printSummary(await control(runId, { cmd: 'status' }));
  if (cmd === 'scenario') return show(await control(runId, { cmd: 'scenario', name: args[0], target: args[1] }));
  if (cmd === 'release') return show(await control(runId, { cmd: 'release' }));
  if (cmd === 'evidence') return show(await control(runId, { cmd: 'evidence', recent: args.includes('--recent'), targets: args.filter((a) => a !== '--recent') }));
  if (cmd === 'probe') return show(await control(runId, { cmd: 'probe', positive: args.includes('--positive') }, 120_000));
  if (cmd === 'reset') {
    console.log('Resetting: every synthetic record and session of this run is discarded …');
    await control(runId, { cmd: 'reset' }, 10 * 60_000);
    return printSummary(await control(runId, { cmd: 'status' }));
  }
  throw new QaRefusal('unknown_command', `unknown command "${cmd}"\n\n${HELP}`);
}

main().catch((err) => {
  if (err instanceof QaRefusal) console.error(`Refused (${err.code}): ${err.message}`);
  else console.error(`Failed: ${err?.message ?? err}`);
  process.exitCode = err instanceof QaRefusal ? 2 : 1;
});

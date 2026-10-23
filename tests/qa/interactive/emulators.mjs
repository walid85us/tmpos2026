// QA-INTERACTIVE-P1 — the Firebase Auth and Firestore emulators for one QA run: loopback only, a demo- project, the
// repository's own Firestore rules, and a scoped environment (its own HOME, so no ambient Firebase login or analytics
// consent is read; the update check off; the CLI's message-of-the-day fetch pointed at a closed loopback port).
import { spawn } from 'node:child_process';
import { openSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { REPO_ROOT, ensureDir, stillOwned } from './ownership.mjs';

const CONFIG = join(REPO_ROOT, 'tests/qa/interactive/firebase.qa.json');
const PORTS = JSON.parse(readFileSync(CONFIG, 'utf8')).emulators;
export const AUTH = Object.freeze({ host: PORTS.auth.host, port: PORTS.auth.port });
export const FIRESTORE = Object.freeze({ host: PORTS.firestore.host, port: PORTS.firestore.port });
const HUB = `http://${PORTS.hub.host}:${PORTS.hub.port}`;
const authUrl = (p) => `http://${AUTH.host}:${AUTH.port}${p}`;
const firestoreUrl = (p) => `http://${FIRESTORE.host}:${FIRESTORE.port}${p}`;
// The emulators' admin credential: a literal the emulator suite defines, valid only against the emulators.
const ADMIN = { authorization: 'Bearer owner' };

export function startEmulators({ projectId, javaBin, homeDir, cacheDir, logFile, workDir }) {
  const out = openSync(logFile, 'a', 0o600);
  const child = spawn(join(REPO_ROOT, 'node_modules/.bin/firebase'),
    ['emulators:start', '--only', 'auth,firestore', '--project', projectId, '--config', CONFIG], {
      cwd: workDir, // the CLI and the JVM write their *-debug.log files here: the run directory, never the repository

      detached: true, // its own process group: the JVM and the CLI stop together
      stdio: ['ignore', out, out],
      env: {
        PATH: `${dirname(javaBin)}:${process.env.PATH}`,
        HOME: ensureDir(homeDir),
        LANG: process.env.LANG ?? 'C.UTF-8',
        FIREBASE_EMULATORS_PATH: ensureDir(cacheDir),
        NO_UPDATE_NOTIFIER: '1',
        FIREBASE_REALTIME_URL: 'http://127.0.0.1:9',
        JAVA_TOOL_OPTIONS: '-Xmx512m',
      },
    });
  return child;
}

/** Waits until the hub lists both emulators; rejects early if the CLI exits. */
export async function waitEmulatorsReady(child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`the emulators exited (${child.exitCode ?? child.signalCode})`);
    try {
      const res = await fetch(`${HUB}/emulators`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        const listed = await res.json();
        if (listed.auth && listed.firestore) return;
      }
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('the emulators did not become ready in time');
}

// firebase-tools starts the Firestore JVM detached (its own process group), so the CLI's group does not cover it.
export const JVM_MARK = 'cloud-firestore-emulator';
export const jvmOwned = (rec) => stillOwned(rec, [JVM_MARK]);

/** Signals the recorded Firestore JVM's group (its pid if it leads none), only while the record still proves it is ours. */
export function signalJvm(rec, sig) {
  if (!jvmOwned(rec)) return;
  try { process.kill(-rec.pid, sig); } catch { try { process.kill(rec.pid, sig); } catch { /* gone */ } }
}

/** Stops the emulators' process group and the recorded JVM: SIGTERM, then SIGKILL after the grace period. */
export async function stopEmulators(child, graceMs = 20_000, jvm = null) {
  const cliUp = () => Boolean(child) && child.exitCode === null && child.signalCode === null;
  const up = () => cliUp() || jvmOwned(jvm);
  const signal = (sig) => {
    if (cliUp()) { try { process.kill(-child.pid, sig); } catch { /* gone */ } }
    signalJvm(jvm, sig);
  };
  signal('SIGTERM');
  for (const until = Date.now() + graceMs; up() && Date.now() < until;) await new Promise((r) => setTimeout(r, 200));
  if (!up()) return;
  signal('SIGKILL');
  for (const until = Date.now() + 5000; up() && Date.now() < until;) await new Promise((r) => setTimeout(r, 100));
}

/** Why an emulator is not answering, or null: any HTTP answer on its port counts as up (the liveness check). */
export async function emulatorsDown() {
  for (const [name, url] of [['auth', authUrl('/')], ['firestore', firestoreUrl('/')]]) {
    try {
      await (await fetch(url, { signal: AbortSignal.timeout(3000) })).arrayBuffer();
    } catch (err) {
      return `${name} emulator: ${err?.cause?.code ?? err?.name ?? err}`;
    }
  }
  return null;
}

async function admin(url, init, label) {
  const res = await fetch(url, { ...init, headers: { ...ADMIN, 'content-type': 'application/json', ...init.headers }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`${label}: emulator answered ${res.status}`);
  return res.status === 204 ? null : res.json().catch(() => null);
}

/**
 * The repository's own firestore.rules, loaded into the emulator for this project (as the browser suite loads them):
 * firebase-tools refuses a rules path outside the config file's directory.
 */
export async function loadFirestoreRules(projectId) {
  const res = await fetch(firestoreUrl(`/emulator/v1/projects/${projectId}:securityRules`), {
    method: 'PUT', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({ rules: { files: [{ content: readFileSync(join(REPO_ROOT, 'firestore.rules'), 'utf8') }] } }),
  });
  if (!res.ok) throw new Error(`loading firestore.rules: emulator answered ${res.status}`);
}

/** Every account and every document of the project: gone (a reset's emulator half). */
export async function clearEmulators(projectId) {
  await admin(authUrl(`/emulator/v1/projects/${projectId}/accounts`), { method: 'DELETE' }, 'clear accounts');
  await admin(firestoreUrl(`/emulator/v1/projects/${projectId}/databases/(default)/documents`), { method: 'DELETE' }, 'clear documents');
}

export async function createAccount(projectId, { uid, email, password, displayName }) {
  await admin(authUrl(`/identitytoolkit.googleapis.com/v1/projects/${projectId}/accounts`), {
    method: 'POST', body: JSON.stringify({ localId: uid, email, password, displayName, emailVerified: true }),
  }, `create account ${uid}`);
}

/** The users/{uid} document the application reads its role and name from (written past the rules, as the server would). */
export async function seedUserDoc(projectId, uid, role, name) {
  await admin(firestoreUrl(`/v1/projects/${projectId}/databases/(default)/documents/users/${encodeURIComponent(uid)}`), {
    method: 'PATCH', body: JSON.stringify({ fields: { role: { stringValue: role }, name: { stringValue: name } } }),
  }, `seed users/${uid}`);
}

/** A real emulator sign-in (the same REST call the browser SDK makes): the ID token, for the seeding sessions. */
export async function signIn(apiKey, email, password) {
  const res = await fetch(authUrl(`/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(apiKey)}`), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true }), signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`emulator sign-in answered ${res.status}`);
  return (await res.json()).idToken;
}

/** The emulator's own judgement of an ID token: the account it names, or null; an answer >= 500 is an outage (throws). */
export async function lookupToken(apiKey, idToken) {
  const res = await fetch(authUrl(`/identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(apiKey)}`), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idToken }), signal: AbortSignal.timeout(5000),
  });
  if (res.status >= 500) throw new Error(`accounts:lookup: emulator answered ${res.status}`);
  if (res.status !== 200) return null;
  const user = (await res.json()).users?.[0];
  return user && !user.disabled ? user.localId : null;
}

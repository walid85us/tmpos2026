// QA-INTERACTIVE-P1 — what the interactive QA session owns, and the proof a process is still that owner.
// State lives on the workspace disk (/tmp and ~ are RAM-backed on this VM) under .cache/, which git, Tailwind's source
// scan and Vite's watcher already ignore. A PID alone is never trusted: its /proc start time, the boot id and its command
// line must all still match the manifest before anything signals it.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const STATE_DIR = join(REPO_ROOT, '.cache', 'tmpos-qa');
export const RUNS_DIR = join(STATE_DIR, 'runs');
export const MANIFEST = join(STATE_DIR, 'current.json');
export const QA_PORT = 5000;

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export const bootId = () => readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();

/** The process's start time in clock ticks since boot (/proc/<pid>/stat field 22), or null when it is gone. */
export function procStart(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null;
  } catch {
    return null;
  }
}

export function cmdline(pid) {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ');
  } catch {
    return '';
  }
}

/** A process the manifest recorded is still that process (same boot, same start, expected command). */
export function stillOwned(rec, mustContain) {
  if (!rec || !Number.isInteger(rec.pid) || rec.pid <= 1) return false;
  if (rec.bootId !== bootId()) return false;
  const start = procStart(rec.pid);
  return start !== null && start === rec.start && mustContain.every((s) => cmdline(rec.pid).includes(s));
}

export const processRecord = (pid) => ({ pid, start: procStart(pid), bootId: bootId() });

/** `<dataDir>/postmaster.pid`'s first line: a pid, null when the file does not exist, undefined when it cannot be read or
 *  is not a plain decimal pid within Linux's pid range (pg_ctl reads a numeric prefix into a C long, so such a file must
 *  never reach it). */
export function readPostmasterPid(dataDir) {
  let text;
  try { text = readFileSync(join(dataDir, 'postmaster.pid'), 'utf8'); } catch (err) { return err?.code === 'ENOENT' ? null : undefined; }
  const first = text.split('\n')[0].trim();
  return /^\d{1,7}$/.test(first) && Number(first) > 1 && Number(first) <= 4_194_304 ? Number(first) : undefined;
}

/** The process is a postgres server whose only data-directory argument is `-D` followed by exactly `dataDir` (argv
 *  compared whole, never as a substring). */
export function postgresOn(pid, dataDir) {
  let args;
  try { args = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0'); } catch { return false; }
  const dirArgs = args.filter((a) => a.startsWith('-D') || a.startsWith('--pgdata') || a.includes('data_directory'));
  const d = args.indexOf('-D');
  return /(^|\/)postgres$/.test(args[0]) && dirArgs.length === 1 && d > 0 && args[d + 1] === dataDir;
}

/** The first descendant of rootPid whose command line contains `needle`, or null (a /proc scan by parent pid). */
export function findDescendant(rootPid, needle) {
  const parentOf = new Map();
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
      parentOf.set(Number(name), Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]));
    } catch { /* gone meanwhile */ }
  }
  for (const pid of parentOf.keys()) {
    for (let p = parentOf.get(pid), hops = 0; p > 1 && hops < 64; p = parentOf.get(p), hops += 1) {
      if (p === rootPid) {
        if (cmdline(pid).includes(needle)) return pid;
        break;
      }
    }
  }
  return null;
}

export function readManifest() {
  if (!existsSync(MANIFEST)) return null;
  try {
    return JSON.parse(readFileSync(MANIFEST, 'utf8'));
  } catch {
    return { corrupt: true };
  }
}

export function writeManifest(obj) {
  ensureDir(STATE_DIR);
  const tmp = `${MANIFEST}.${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(obj, null, 1)}\n`, { mode: 0o600 });
  renameSync(tmp, MANIFEST);
}

export function removeManifest(runId) {
  const m = readManifest();
  if (m && !m.corrupt && runId !== undefined && m.runId !== runId) return false; // another run's manifest: not ours
  rmSync(MANIFEST, { force: true });
  return true;
}

/** A path strictly inside the QA state directory (resolved first, so `..` cannot climb out). */
export function insideStateDir(path) {
  if (typeof path !== 'string') return false;
  const abs = resolve(path);
  return abs.startsWith(STATE_DIR + sep) && abs !== STATE_DIR;
}

/** Deletes a directory only when it is strictly inside the QA state directory (never a path from elsewhere). */
export function removeOwnedDir(dir) {
  if (!insideStateDir(dir)) return false;
  rmSync(resolve(dir), { recursive: true, force: true });
  return true;
}

export const runDirOf = (runId) => join(RUNS_DIR, runId);
export const controlSocketOf = (runId) => join(runDirOf(runId), 'control.sock');

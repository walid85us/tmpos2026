/**
 * C2B-M005-P0 — the managed parent for the fixed READ-ONLY default-ACL diagnostic.
 *
 * ONE ACTION, ONE CHILD. `--inspect-default-acls` spawns exactly
 * `scripts/managed-default-acl-preflight.ts` through the repository-local tsx CLI, with a FROZEN
 * argv that carries no script name, no SQL, no target, no role, no schema and no extra flag from
 * the caller. There is no path from this file to `scripts/supabase-migrate.ts`, to the historical
 * baseline launcher, or to the migration-005 launcher entry point.
 *
 * WHY IT EXISTS SEPARATELY FROM THE OTHER TWO LAUNCHERS. Their whole purpose is to apply something;
 * this one's whole purpose is to read. Sharing an entry point would mean one flag stood between a
 * diagnostic and a migration, and a copy-pasted command line naming the wrong script would be
 * accepted by whichever file it reached. A distinct flag on a distinct file makes that a refusal.
 *
 * CONTAINMENT AND REDACTION ARE REUSED, NOT REIMPLEMENTED. The process-containment primitives come
 * from the accepted baseline launcher and the CORRECTED typed redaction from the migration-005
 * launcher — importing that module for its exports runs nothing, because its entry guard is an
 * exact-path identity test. The superseded value-list redactor is deliberately not used.
 *
 * NOTHING HERE CONTACTS A DATABASE OR READS A SECRET VALUE OUT. Importing this module spawns
 * nothing and reads no file; only the entry guard at the foot starts a run.
 */

import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CHILD_ENV_KEYS,
  CLEANUP_STATUSES,
  CONFIG_KEYS,
  GATE_VALUES,
  LAUNCHER_CODES,
  LauncherRefusal,
  MIGRATE_SCRIPT,
  NODE_BIN,
  OUTPUT_LIMIT_BYTES,
  REPO_ROOT,
  STARTUP_SENSITIVE,
  TIMEOUT_MS,
  TSX_CLI,
  UNOBSERVED,
  assertChildEnv,
  assertContainmentPreconditions,
  assertStartupSensitiveAbsent,
  buildChildEnv,
  enterContainmentHold,
  groupIsEmpty,
  normalCompletion,
  outcomeCode,
  readExecEnvironment,
  runChild,
} from './managed-baseline-launcher.mjs';

import {
  CHILD_BLOCK_SENTINEL,
  classifySecrets,
  renderPreflightTranscript,
  safeLineText,
  terminalCompletion,
} from './managed-m005-launcher.mjs';

// ---- identity of this launcher ----------------------------------------------

/** The single literal parent argument. Owned by no other launcher in this repository. */
export const PARENT_FLAG = '--inspect-default-acls';

/** The one child this parent may ever start. Repository-local, absolute at run time. */
export const PREFLIGHT_SCRIPT = join(REPO_ROOT, 'scripts', 'managed-default-acl-preflight.ts');

/**
 * The frozen child argv tail: EMPTY.
 *
 * The child takes no arguments at all and refuses any, so there is nothing for a caller to steer
 * and nothing for this parent to pass through. An empty tail is the strongest form of the fixed
 * command contract, and it is asserted rather than merely intended.
 */
export const PREFLIGHT_FLAGS = Object.freeze([]);

/**
 * Tokens whose presence in the child argv would mean this launcher had grown a second purpose.
 *
 * The migrate script itself is on this list, not only its flags: the failure this guards against is
 * a future edit that points the fixed child at the migration CLI while leaving the flag list empty.
 */
export const FORBIDDEN_CHILD_TOKENS = Object.freeze([
  MIGRATE_SCRIPT,
  'supabase-migrate.ts',
  'managed-baseline-launcher.mjs',
  'managed-m005-launcher.mjs',
  'supabase-owner-provision.ts',
  '--apply',
  '--managed-dev',
  '--confirm-dev',
  '--baseline',
  '--baseline-versions',
  '--status',
  '--down',
  '--allow-down',
  '--direction',
  '--migration',
  '--resolve-dirty',
  '--dry-run',
  '--plan',
  '--list',
  '--execute',
  '--execute-m005',
]);

export const PREFLIGHT_LAUNCHER_CODES = Object.freeze({
  OK: 'acl_preflight_launcher_ok',
  BAD_INVOCATION: 'acl_preflight_launcher_bad_invocation',
  ARGV_CONTRACT_VIOLATED: 'acl_preflight_launcher_argv_contract_violated',
  // Nothing established that the child finished rather than being destroyed. A Linux realtime
  // signal reaches this launcher as `exit=0 signal=null`, so the child's own terminal record is the
  // only thing that distinguishes a completed diagnostic from a killed one.
  TERMINAL_EVIDENCE_INCOMPLETE: 'acl_preflight_launcher_terminal_evidence_incomplete',
});

/** The child tag whose terminal record this launcher requires. */
export const ACL_PREFLIGHT_TAG = 'acl-preflight';

/** Terminal completion evidence, from the SEALED stdout capture only. */
export function terminalEvidenceFor(result) {
  return terminalCompletion(
    result?.capture?.streamText?.('stdout'),
    ACL_PREFLIGHT_TAG,
    result?.streamsClosed === true,
  );
}

/**
 * THE ONE DISPOSITION, used by the record AND by the exit code.
 *
 * These were two expressions saying the same thing, and a mutation could drop the terminal conjunct
 * from the exit code while the record still reported it — a run that PRINTED
 * `terminal_evidence_incomplete` and exited 0. Deriving both from one function removes the
 * possibility instead of testing for it twice.
 */
export function dispositionFor(result) {
  const terminal = terminalEvidenceFor(result);
  const derived = outcomeCode(result);
  const code = derived === LAUNCHER_CODES.OK && !terminal.ok
    ? PREFLIGHT_LAUNCHER_CODES.TERMINAL_EVIDENCE_INCOMPLETE
    : derived;
  // `&& terminal.ok` STOOD HERE AND WAS REDUNDANT: `code` is only OK when the terminal evidence is
  // complete, by the line above. Two expressions of one requirement mask each other — dropping
  // either left every test green — so the requirement is now stated once, where a mutation to it
  // actually changes an outcome.
  const ok = code === LAUNCHER_CODES.OK && normalCompletion(result);
  return Object.freeze({ terminal, code, exitCode: ok ? 0 : 2 });
}

/**
 * Prove the child argv is exactly the fixed command, before anything is spawned.
 *
 * Checked at RUN TIME as well as in the suite, so the file refuses rather than merely failing a
 * test that someone might not have run.
 */
export function assertChildArgvContract(args) {
  const bad = [];
  if (!Array.isArray(args) || args.length !== 2) bad.push('length');
  if (!Array.isArray(args) || args[0] !== TSX_CLI) bad.push('loader');
  if (!Array.isArray(args) || args[1] !== PREFLIGHT_SCRIPT) bad.push('child');
  for (const a of Array.isArray(args) ? args : []) {
    for (const t of FORBIDDEN_CHILD_TOKENS) {
      if (typeof a === 'string' && typeof t === 'string' && t !== '' && a.includes(t)) bad.push(t);
    }
  }
  if (bad.length > 0) {
    throw new LauncherRefusal(PREFLIGHT_LAUNCHER_CODES.ARGV_CONTRACT_VIOLATED, [...new Set(bad)]);
  }
  return true;
}

/** Bounded field formatting, so no report field can carry child-controlled text unredacted. */
const FIELD = Object.freeze({
  bool: (v) => (v === true ? 'true' : v === false ? 'false' : 'unknown'),
  // NO DOTS, NO COLONS, NO HYPHENS, AND BOUNDED AT 64. The looser class accepted
  // `db.<ref>.supabase.co` and `203.0.113.7` — a hostname and an address are exactly the shapes a
  // status field must never be able to carry. Every legitimate producer (launcher codes, cleanup
  // statuses, lifecycle statuses, `SIGTERM`/`SIGKILL`/`none`) satisfies this.
  code: (v) => (typeof v === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(v) ? v : 'unreportable'),
  num: (v) => (Number.isSafeInteger(v) ? String(v) : 'unknown'),
});

/**
 * The bounded operator record.
 *
 * The child's own transcript is included as ONE redacted block behind a sentinel, and is marked
 * UNVERIFIED: every claim inside it is the child's, not this launcher's. On overflow the transcript
 * is not printed at all — not truncated, not measured, not hashed.
 */
export function renderPreflightReport(result) {
  const lines = [];
  lines.push('[acl-preflight-launcher] fixed read-only default-ACL diagnostic');
  lines.push(`[acl-preflight-launcher] spawned=${FIELD.bool(result.spawned)} status=${FIELD.code(result.status)}`);
  lines.push(`[acl-preflight-launcher] exit=${FIELD.num(result.exitCode)} signal=${FIELD.code(result.signal ?? 'none')}`);

  const group = result.group ?? UNOBSERVED;
  lines.push(`[acl-preflight-launcher] group empty=${FIELD.bool(groupIsEmpty(group))}`
    + ` observationLost=${FIELD.bool(result.observationLost === true)}`);
  if (result.cleanup !== undefined && result.cleanup !== null) {
    lines.push(`[acl-preflight-launcher] cleanup complete=${FIELD.bool(result.cleanup.complete)}`);
  }

  if (result.capture !== undefined && result.capture !== null) {
    // FAIL-CLOSED ON THE FLAG ITSELF: anything that is not exactly `false` is treated as overflow.
    if (result.capture.overflowed !== false) {
      lines.push(`[acl-preflight-launcher] ${LAUNCHER_CODES.OUTPUT_LIMIT_EXCEEDED} — the captured output `
        + 'exceeded the aggregate ceiling and was discarded unread; no part of it is reported');
    } else {
      lines.push('[acl-preflight-launcher] captured child output follows; it is UNVERIFIED');
      lines.push(CHILD_BLOCK_SENTINEL);
      lines.push("[acl-preflight-launcher] every claim in the captured output above is the CHILD's own");
    }
  }

  const { terminal, code } = dispositionFor(result);
  lines.push(`[acl-preflight-launcher] terminalEvidence=${FIELD.code(terminal.reason)}`);
  lines.push(`[acl-preflight-launcher] outcome=${FIELD.code(code === LAUNCHER_CODES.OK ? PREFLIGHT_LAUNCHER_CODES.OK : code)}`);
  // SAID BY THE PARENT TOO, not only by the child: an operator reading this record must not be able
  // to take a clean diagnostic as permission to migrate.
  lines.push('[acl-preflight-launcher] this diagnostic authorizes no migration and no live write');
  return lines;
}

/**
 * Enter the referenced containment hold when the run did not prove terminal cleanup.
 *
 * Identical in contract to the accepted baseline and migration-005 holds: no handle release, no
 * `process.exit`, a REFERENCED interval so the event loop cannot drain while a managed process may
 * still be alive, and exactly one bounded notice.
 */
export function enterHoldIfRequiredPreflight(result, sink, deps = {}) {
  const settled =
    normalCompletion(result)
    || (CLEANUP_STATUSES.has(result.status) && result.cleanup?.complete === true
      && result.observationLost !== true && groupIsEmpty(result.group ?? UNOBSERVED));
  if (result.spawned !== true || settled) return null;
  const enter = deps.enterHold ?? enterContainmentHold;
  return enter({
    emit: (line) => sink(line),
    ...(deps.holdObserve ? { observe: deps.holdObserve } : {}),
    ...(deps.holdPollMs !== undefined ? { pollMs: deps.holdPollMs } : {}),
    ...(deps.setIntervalFn ? { setIntervalFn: deps.setIntervalFn } : {}),
    ...(deps.clearIntervalFn ? { clearIntervalFn: deps.clearIntervalFn } : {}),
  });
}

export async function main(argv = process.argv.slice(2), source = process.env, deps = {}) {
  const emit = deps.out ?? ((line) => console.log(line));
  const emitErr = deps.err ?? ((line) => console.error(line));

  // Exactly one literal argument. An ignored extra argument is how a launcher grows an escape
  // hatch, so a second one is a refusal rather than a warning.
  if (argv.length !== 1 || argv[0] !== PARENT_FLAG) {
    emitErr(`[acl-preflight-launcher] REFUSED: ${PREFLIGHT_LAUNCHER_CODES.BAD_INVOCATION}`);
    return 2;
  }

  let env;
  let sink;
  try {
    if (deps.assertContainment) deps.assertContainment();
    else assertContainmentPreconditions();
    assertStartupSensitiveAbsent(deps.readExecEnv ? deps.readExecEnv() : readExecEnvironment());
    env = buildChildEnv(source);
    // CALLED FOR ITS REFUSAL ONLY; the result is deliberately discarded. An unparsable
    // configuration must still refuse here, but no redactor is built from it, because no redactor
    // touches the child path any more: the transcript is re-rendered from a closed grammar, and a
    // redactor on that path would reintroduce the credential as an input to the output.
    classifySecrets(env);
    sink = (line) => emit(safeLineText(line));
    // FINAL exact-set assertion, immediately before anything else is built from the environment.
    assertChildEnv(env);
  } catch (e) {
    const code = e instanceof LauncherRefusal ? e.code : PREFLIGHT_LAUNCHER_CODES.BAD_INVOCATION;
    const names = e instanceof LauncherRefusal ? e.names : [];
    // The refusal path necessarily predates the sink — the redactor may be the thing that failed —
    // so it emits NAMES and a code only, never a value and never the Error's own message.
    emitErr(safeLineText(`[acl-preflight-launcher] REFUSED: ${code}${names.length > 0 ? ` names=${names.join(',')}` : ''}`));
    return 2;
  }

  const args = Object.freeze([TSX_CLI, PREFLIGHT_SCRIPT, ...PREFLIGHT_FLAGS]);
  try {
    assertChildArgvContract(args);
  } catch (e) {
    const names = e instanceof LauncherRefusal ? e.names : [];
    emitErr(safeLineText(
      `[acl-preflight-launcher] REFUSED: ${PREFLIGHT_LAUNCHER_CODES.ARGV_CONTRACT_VIOLATED} names=${names.join(',')}`,
    ));
    return 2;
  }

  const result = await runChild({
    command: NODE_BIN,
    args,
    env,
    limit: OUTPUT_LIMIT_BYTES,
    timeoutMs: deps.timeoutMs ?? TIMEOUT_MS,
    ...(deps.spawn ? { spawn: deps.spawn } : {}),
    ...(deps.scan ? { scan: deps.scan } : {}),
    ...(deps.identify ? { identify: deps.identify } : {}),
    ...(deps.selfIdentity ? { selfIdentity: deps.selfIdentity } : {}),
    ...(deps.killGroup ? { killGroup: deps.killGroup } : {}),
    ...(deps.cleanupGraceMs !== undefined ? { cleanupGraceMs: deps.cleanupGraceMs } : {}),
    ...(deps.groupPollMs !== undefined ? { groupPollMs: deps.groupPollMs } : {}),
  });

  // REPORTING IS WRAPPED so a failure while writing the record cannot skip the hold.
  try {
    for (const line of renderPreflightReport(result)) {
      if (line !== CHILD_BLOCK_SENTINEL) { sink(line); continue; }
      // THE TWO STREAMS ARE READ APART AND NEITHER IS FORWARDED. The previous call read
      // `capture.text()` — the ARRIVAL-ORDERED interleave of both pipes — and spliced `[REDACTED]`
      // into published template text. That made a credential split across stdout and stderr
      // contiguous in one buffer, and made the marker's position inside a known template a
      // known-plaintext oracle. `streamText` yields nothing until `runChild` has sealed the capture
      // on proved closure, and the third argument is that same proof, passed explicitly.
      for (const rendered of renderPreflightTranscript(
        result.capture?.streamText?.('stdout'),
        result.capture?.streamText?.('stderr'),
        result.streamsClosed === true,
      )) sink(rendered);
    }
  } finally {
    enterHoldIfRequiredPreflight(result, sink, deps);
  }

  return dispositionFor(result).exitCode;
}

// Entry guard: importing this module must spawn nothing and read no file.
//
// EXACT PATH IDENTITY, not a suffix test — a suffix test is satisfied by ANY entry script whose
// name merely ends in this one, which would import this module for its exports and start a real
// run as a side effect.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().then(
    (c) => {
      // process.exitCode, never process.exit(): stdout is a pipe here, and an explicit exit can
      // truncate the record that has just been written to it.
      process.exitCode = c;
    },
    () => {
      process.exitCode = 2;
    },
  );
}

/** Re-exported so the deterministic suite can assert the sealed set without a second source. */
export { CHILD_ENV_KEYS, CONFIG_KEYS, GATE_VALUES, STARTUP_SENSITIVE };

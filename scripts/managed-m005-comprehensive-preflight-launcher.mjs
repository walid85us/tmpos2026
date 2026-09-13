/**
 * C2B-M005-P2-B0 — the managed parent for the fixed READ-ONLY comprehensive migration-005 preflight.
 *
 * ONE ACTION, ONE CHILD. `--inspect-m005-preconditions` spawns exactly
 * `scripts/managed-m005-comprehensive-preflight.ts` through the repository-local tsx CLI, with a
 * FROZEN argv that carries no script name, no SQL, no target, no role, no schema, no migration
 * version and no extra flag from the caller. There is no path from this file to
 * `scripts/supabase-migrate.ts`, to the historical-baseline launcher, to the migration-005 apply
 * launcher, or to the owner-provision script.
 *
 * WHY IT EXISTS SEPARATELY FROM EVERY OTHER LAUNCHER. The other three exist to APPLY something;
 * this one exists to READ. Sharing an entry point would mean one flag stood between a diagnostic and
 * a migration, and a copy-pasted command line naming the wrong script would be accepted by whichever
 * file it reached. A distinct flag on a distinct file makes that a refusal.
 *
 * THE CHILD ENVIRONMENT IS NARROWER THAN EVERY OTHER LAUNCHER'S, AND THAT IS THE POINT.
 * `ALLOW_SUPABASE_MIGRATION_APPLY` is NOT passed. The apply launchers seal it because
 * `assertOperatorGates` in `scripts/supabase-migrate.ts` requires it; this child never imports that
 * module and never reaches that function, so passing it would arm a write gate in an environment
 * whose entire purpose is that nothing may write. The sealed set here is derived from what this
 * child actually consumes, not inherited from a launcher that needed more.
 *
 * CONTAINMENT AND REDACTION ARE REUSED, NOT REIMPLEMENTED. The process-containment primitives come
 * from the accepted baseline launcher and the corrected typed redaction from the migration-005
 * launcher — importing either module for its exports runs nothing, because each entry guard is an
 * exact-path identity test.
 *
 * NOTHING HERE CONTACTS A DATABASE OR READS A SECRET VALUE OUT. Importing this module spawns
 * nothing and reads no file; only the entry guard at the foot starts a run.
 */

import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CLEANUP_STATUSES,
  LAUNCHER_CODES,
  LauncherRefusal,
  MIGRATE_SCRIPT,
  NODE_BIN,
  OUTPUT_LIMIT_BYTES,
  REPO_ROOT,
  STARTUP_SENSITIVE,
  TSX_CLI,
  UNOBSERVED,
  assertContainmentPreconditions,
  assertStartupSensitiveAbsent,
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

/**
 * The single literal parent argument. Owned by no other launcher in this repository.
 *
 * RENAMED FROM THE RETIRED SPELLING, and the rename is the enforcement: the check below is
 * an EXACT equality against this constant, so the retired flag is refused with
 * `BAD_INVOCATION` by construction rather than by a separate deny-list that could drift. The retired
 * literal appears nowhere in this boundary — the test that proves the refusal assembles it from
 * fragments at run time, so a source scan for the old vocabulary finds nothing to excuse.
 *
 * The flag names an OBSERVATION, not a permission question, because observation is all the child does.
 */
export const PARENT_FLAG = '--inspect-m005-preconditions';

/** The one child this parent may ever start. Repository-local, absolute at run time. */
export const PREFLIGHT_SCRIPT = join(REPO_ROOT, 'scripts', 'managed-m005-comprehensive-preflight.ts');

/**
 * The frozen child argv tail: EMPTY.
 *
 * The child takes no arguments at all and refuses any, so there is nothing for a caller to steer and
 * nothing for this parent to pass through. An empty tail is the strongest form of the fixed command
 * contract, and it is asserted at run time rather than merely intended.
 */
export const PREFLIGHT_FLAGS = Object.freeze([]);

/**
 * DERIVED FROM THE CHILD'S OWN BUDGET, not chosen.
 *
 * A bound picked for feeling right is how a slow-but-SUCCESSFUL preflight gets killed by the group
 * cleanup path and reported as a containment outcome with no verdict — the operator learns nothing
 * about the database and is told the diagnostic misbehaved. The child bounds each of its bracket
 * statements at `TX_TIMEOUT_MS` and issues at most `BRACKET_STATEMENT_BUDGET` of them, plus one
 * bounded connect; the parent must outlast that worst case, with margin for process start and the
 * bounded output drain.
 *
 * THE CHILD'S CONSTANTS ARE MIRRORED, NOT IMPORTED, and the mirror is deliberate: this launcher is a
 * `.mjs` started by bare `node`, so importing the `.ts` child for two numbers would make the parent
 * unable to start at all — a containment regression traded for a tidier constant. The deterministic
 * suite compares the mirrored values against the child's own exports, so a change to either side
 * fails a test rather than silently breaking the derivation.
 */
export const CHILD_TX_TIMEOUT_MS = 10_000;
export const CHILD_STATEMENT_BUDGET = 40;
export const CHILD_CONNECT_BUDGET_MS = 15_000;
export const PARENT_OVERHEAD_MS = 25_000;
export const TIMEOUT_MS =
  CHILD_TX_TIMEOUT_MS * CHILD_STATEMENT_BUDGET + CHILD_CONNECT_BUDGET_MS + PARENT_OVERHEAD_MS;

/**
 * The EXACT child environment key set for THIS child, derived from what it consumes:
 *   SUPABASE_DATABASE_URL   — assertManagedDevDsn() argument 1
 *   SUPABASE_URL            — assertManagedDevDsn() argument 2, the independent corroborator
 *   DATABASE_CA_CERT        — the pinned CA, via resolveDatabaseTls()
 *   CONFIRM_SUPABASE_TARGET — development-target confirmation, must equal the DEV label
 *   NODE_ENV                — must be 'development'
 *
 * `ALLOW_SUPABASE_MIGRATION_APPLY` is DELIBERATELY ABSENT — see the module header. `--confirm-dev`
 * is an apply-path flag and is absent from the frozen argv for the same reason.
 */
export const INSPECT_CONFIG_KEYS = Object.freeze(['SUPABASE_DATABASE_URL', 'SUPABASE_URL', 'DATABASE_CA_CERT']);
export const INSPECT_GATE_VALUES = Object.freeze({
  CONFIRM_SUPABASE_TARGET: 'tmpos2026-dev',
  NODE_ENV: 'development',
});
export const INSPECT_CHILD_ENV_KEYS = Object.freeze([
  ...INSPECT_CONFIG_KEYS, ...Object.keys(INSPECT_GATE_VALUES),
]);

/**
 * Tokens whose presence anywhere in the child argv would mean this launcher had grown a second
 * purpose. The migrate script itself is on the list, not only its flags: the failure this guards
 * against is a future edit that points the fixed child at the migration CLI while leaving the flag
 * list empty.
 */
export const FORBIDDEN_CHILD_TOKENS = Object.freeze([
  MIGRATE_SCRIPT,
  'supabase-migrate.ts',
  'managed-baseline-launcher.mjs',
  'managed-m005-launcher.mjs',
  'managed-default-acl-preflight',
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
  '--inspect-default-acls',
]);

/**
 * The exact outer command line, as a CONSTANT rather than prose.
 *
 * The removal of the startup-sensitive variables must happen at the SHELL/EXEC boundary: by the time
 * this module executes, NODE_OPTIONS has already been applied, NODE_EXTRA_CA_CERTS has already
 * widened the trust store and OPENSSL_CONF has already been read, so an in-process check is
 * DETECTION and not prevention. `assertStartupSensitiveAbsent` below exists to prove the removal
 * happened; this constant is the removal itself, and a test compares the two so the documented
 * command can never drift from the list the assertion enforces.
 */
export const OUTER_INVOCATION = [
  'env',
  ...STARTUP_SENSITIVE.map((n) => `-u ${n}`),
  NODE_BIN,
  join(REPO_ROOT, 'scripts', 'managed-m005-comprehensive-preflight-launcher.mjs'),
  PARENT_FLAG,
].join(' ');

export const INSPECT_LAUNCHER_CODES = Object.freeze({
  OK: 'm005_preflight_launcher_ok',
  BAD_INVOCATION: 'm005_preflight_launcher_bad_invocation',
  ARGV_CONTRACT_VIOLATED: 'm005_preflight_launcher_argv_contract_violated',
  CONFIG_MISSING: 'm005_preflight_launcher_config_missing',
  CHILD_ENV_INVALID: 'm005_preflight_launcher_child_env_invalid',
  // The child did not deliver exactly one valid terminal completion record, so nothing establishes
  // that it finished rather than being destroyed. A realtime signal reaches the launcher as
  // `exit=0 signal=null`, so this is the ONLY thing standing between that run and an OK.
  TERMINAL_EVIDENCE_INCOMPLETE: 'm005_preflight_launcher_terminal_evidence_incomplete',
});

/** The child tag whose terminal record this launcher requires. */
export const PREFLIGHT_TAG = 'm005-preflight';

/**
 * The terminal completion evidence for a run, computed from the SEALED stdout capture only.
 *
 * One function so the rendered record and the exit code cannot disagree: a report that says the
 * evidence is complete while the exit code says otherwise would be worse than either alone.
 */
export function terminalEvidenceFor(result) {
  return terminalCompletion(
    result?.capture?.streamText?.('stdout'),
    PREFLIGHT_TAG,
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
    ? INSPECT_LAUNCHER_CODES.TERMINAL_EVIDENCE_INCOMPLETE
    : derived;
  // `&& terminal.ok` STOOD HERE AND WAS REDUNDANT: `code` is only OK when the terminal evidence is
  // complete, by the line above. Two expressions of one requirement mask each other — dropping
  // either left every test green — so the requirement is now stated once, where a mutation to it
  // actually changes an outcome.
  const ok = code === LAUNCHER_CODES.OK && normalCompletion(result);
  return Object.freeze({ terminal, code, exitCode: ok ? 0 : 2 });
}

/**
 * Build the child environment from an EMPTY object.
 *
 * `Object.create(null)` has no prototype, so no inherited key can appear through `for...in`, which
 * is how Node enumerates `options.env`. Node REPLACES rather than merges `options.env`, so what is
 * returned here is the child's COMPLETE environment — PATH, HOME and npm configuration included,
 * i.e. absent.
 *
 * NAMES ONLY ON THE REFUSAL PATH. A missing configuration reports the NAME that was missing and
 * never a value, and an EMPTY string counts as missing so a blank secret cannot become a silently
 * accepted one.
 */
export function buildInspectChildEnv(source) {
  const missing = INSPECT_CONFIG_KEYS.filter((k) => {
    const v = source?.[k];
    return typeof v !== 'string' || v.trim() === '';
  });
  if (missing.length > 0) throw new LauncherRefusal(INSPECT_LAUNCHER_CODES.CONFIG_MISSING, missing);

  const env = Object.create(null);
  for (const k of INSPECT_CONFIG_KEYS) env[k] = source[k];
  for (const [k, v] of Object.entries(INSPECT_GATE_VALUES)) env[k] = v;
  assertInspectChildEnv(env);
  return env;
}

/**
 * Prove the constructed environment is EXACTLY the allowlist, with none of the forbidden shapes.
 *
 * `ALLOW_SUPABASE_MIGRATION_APPLY` is refused BY NAME as well as omitted — and the by-name branch is
 * a FUTURE-EDIT BACKSTOP, not a live control, which is worth stating rather than leaving to be
 * discovered. Called through `buildInspectChildEnv` it is unreachable: the key-set equality check
 * above fires first, and the builder only ever writes the five allowlisted keys. It earns its place
 * because omission is a property of one function and could be undone by an edit there, while the
 * refusal is a property of the contract and would fail the run wherever the key came from.
 */
export function assertInspectChildEnv(env) {
  const keys = Object.keys(env).sort();
  const want = [...INSPECT_CHILD_ENV_KEYS].sort();
  const problems = [];
  if (keys.join(',') !== want.join(',')) problems.push('key_set_mismatch');
  for (const k of keys) {
    if (/^PG/.test(k)) problems.push(k);
    if (STARTUP_SENSITIVE.includes(k)) problems.push(k);
    if (k === 'PATH' || k === 'HOME') problems.push(k);
    if (/^(npm_|NPM_)/.test(k)) problems.push(k);
    if (k === 'ALLOW_SUPABASE_MIGRATION_APPLY') problems.push(k);
  }
  if (problems.length > 0) throw new LauncherRefusal(INSPECT_LAUNCHER_CODES.CHILD_ENV_INVALID, problems);
  return true;
}

/**
 * Prove the FULL child argv is exactly the fixed command, before anything is spawned.
 *
 * The full argv is asserted, command included, so `[NODE_BIN, TSX_CLI, PREFLIGHT_SCRIPT]` is checked
 * as the three-element sequence the contract names rather than as a tail whose head is assumed.
 * Checked at RUN TIME as well as in the suite, so the file refuses rather than merely failing a test
 * that someone might not have run.
 */
export function assertChildArgvContract(fullArgv) {
  const bad = [];
  const a = Array.isArray(fullArgv) ? fullArgv : [];
  if (a.length !== 3) bad.push('length');
  if (a[0] !== NODE_BIN) bad.push('node');
  if (a[1] !== TSX_CLI) bad.push('loader');
  if (a[2] !== PREFLIGHT_SCRIPT) bad.push('child');
  for (const arg of a) {
    if (typeof arg !== 'string') { bad.push('nonstring'); continue; }
    for (const t of FORBIDDEN_CHILD_TOKENS) {
      if (typeof t === 'string' && t !== '' && arg.includes(t)) bad.push(t);
    }
  }
  if (bad.length > 0) {
    throw new LauncherRefusal(INSPECT_LAUNCHER_CODES.ARGV_CONTRACT_VIOLATED, [...new Set(bad)]);
  }
  return true;
}

/** Bounded field formatting, so no report field can carry child-controlled text unredacted. */
const FIELD = Object.freeze({
  bool: (v) => (v === true ? 'true' : v === false ? 'false' : 'unknown'),
  // NO DOT, COLON OR HYPHEN. The old class admitted `db.<ref>.supabase.co` and `203.0.113.7`, which
  // was defence in depth while a redactor still sat downstream — and became the ONLY defence the
  // moment the redactor came off this path. Only lifecycle constants (`closed`, `spawn_failed`,
  // `SIGTERM`, `m005_preflight_launcher_ok`) feed it, and none of them needs punctuation.
  code: (v) => (typeof v === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(v) ? v : 'unreportable'),
  num: (v) => (Number.isSafeInteger(v) ? String(v) : 'unknown'),
});

/**
 * The bounded operator record.
 *
 * The child's own transcript is included as ONE redacted block behind a sentinel and is marked
 * UNVERIFIED: every claim inside it is the child's, not this launcher's. On overflow the transcript
 * is not printed at all — not truncated, not measured, not hashed.
 */
export function renderPreflightReport(result) {
  const lines = [];
  lines.push('[m005-preflight-launcher] fixed read-only comprehensive migration-005 preflight');
  lines.push(`[m005-preflight-launcher] spawned=${FIELD.bool(result.spawned)} status=${FIELD.code(result.status)}`);
  lines.push(`[m005-preflight-launcher] exit=${FIELD.num(result.exitCode)} signal=${FIELD.code(result.signal ?? 'none')}`);

  const group = result.group ?? UNOBSERVED;
  lines.push(`[m005-preflight-launcher] group empty=${FIELD.bool(groupIsEmpty(group))}`
    + ` observationLost=${FIELD.bool(result.observationLost === true)}`);
  if (result.cleanup !== undefined && result.cleanup !== null) {
    lines.push(`[m005-preflight-launcher] cleanup complete=${FIELD.bool(result.cleanup.complete)}`);
  }

  if (result.capture !== undefined && result.capture !== null) {
    // FAIL-CLOSED ON THE FLAG ITSELF: anything that is not exactly `false` is treated as overflow.
    if (result.capture.overflowed !== false) {
      lines.push(`[m005-preflight-launcher] ${LAUNCHER_CODES.OUTPUT_LIMIT_EXCEEDED} — the captured output `
        + 'exceeded the aggregate ceiling and was discarded unread; no part of it is reported');
    } else {
      lines.push('[m005-preflight-launcher] captured child output follows; it is UNVERIFIED');
      lines.push(CHILD_BLOCK_SENTINEL);
      lines.push("[m005-preflight-launcher] every claim in the captured output above is the CHILD's own");
    }
  }

  // TERMINAL EVIDENCE IS PART OF THE OUTCOME, not a footnote beside it. A child killed by a Linux
  // realtime signal arrives here as `exit=0 signal=null`, which every negative test below accepts;
  // only the presence of the child's own final record distinguishes it from a clean run.
  const { terminal, code } = dispositionFor(result);
  lines.push(`[m005-preflight-launcher] terminalEvidence=${FIELD.code(terminal.reason)}`);
  lines.push(`[m005-preflight-launcher] outcome=${FIELD.code(code === LAUNCHER_CODES.OK ? INSPECT_LAUNCHER_CODES.OK : code)}`);
  // SAID BY THE PARENT TOO, not only by the child: an operator reading this record must not be able
  // to take a clean preflight as permission to migrate, and must not read it as a lasting guarantee.
  lines.push('[m005-preflight-launcher] this preflight authorizes no migration and no live write');
  lines.push('[m005-preflight-launcher] it is a SNAPSHOT: the apply path must revalidate under its own advisory lock and pre-commit gate');
  lines.push('[m005-preflight-launcher] no dirty-marker resolution is authorized or implemented');
  return lines;
}

/**
 * Enter the referenced containment hold when the run did not prove terminal cleanup.
 *
 * Identical in contract to the accepted baseline, migration-005 and default-ACL holds: no handle
 * release, no `process.exit`, a REFERENCED interval so the event loop cannot drain while a managed
 * process may still be alive, and exactly one bounded notice.
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

  // Exactly one literal argument. An ignored extra argument is how a launcher grows an escape hatch,
  // so a second one is a refusal rather than a warning.
  if (argv.length !== 1 || argv[0] !== PARENT_FLAG) {
    emitErr(`[m005-preflight-launcher] REFUSED: ${INSPECT_LAUNCHER_CODES.BAD_INVOCATION}`);
    return 2;
  }

  let env;
  let sink;
  try {
    if (deps.assertContainment) deps.assertContainment();
    else assertContainmentPreconditions();
    // The EXEC-TIME environment is asserted again here. The removal itself must happen at the
    // shell/exec boundary — by the time this module runs, NODE_OPTIONS has already been applied and
    // NODE_EXTRA_CA_CERTS has already widened the trust store — so this proves the removal happened
    // rather than substituting for it.
    assertStartupSensitiveAbsent(deps.readExecEnv ? deps.readExecEnv() : readExecEnvironment());
    env = buildInspectChildEnv(source);
    // CALLED INSIDE THE GUARDED BLOCK, AND CALLED FOR ITS REFUSAL. An unparsable configuration must
    // fail here rather than produce a silently incomplete classification that is then trusted for
    // the whole run; that refusal is the entire reason this call remains.
    //
    // ITS RESULT IS DELIBERATELY NOT PLACED ON THE OUTPUT PATH — C2B-M005-LRLS-L3-R3.
    // A redactor is a function of the CREDENTIAL, so anything it touches becomes a channel from the
    // credential to the operator's terminal: splicing a marker into a published template leaks the
    // matched span by differencing, and replacing a matched line wholesale leaks it through line
    // presence. Both were live here. Every byte this launcher now emits is either a literal in this
    // file or a token that `FIELD.*` / `renderPreflightTranscript` has parsed into a bounded type
    // and re-rendered, so there is no unbounded material left for a redactor to protect and nothing
    // it could do but reintroduce the dependence. Redaction is not weakened; its input is gone.
    classifySecrets(env);
    // The single bounded emitter. Control characters are still normalised and lines still bounded —
    // a fixed transformation of already-bounded text, with no secret in it.
    sink = (line) => emit(safeLineText(line));
    // FINAL exact-set assertion, immediately before anything else is built from the environment.
    assertInspectChildEnv(env);
  } catch (e) {
    const code = e instanceof LauncherRefusal ? e.code : INSPECT_LAUNCHER_CODES.BAD_INVOCATION;
    const names = e instanceof LauncherRefusal ? e.names : [];
    // The refusal path necessarily predates the sink — the redactor may be the thing that failed —
    // so it emits NAMES and a code only, never a value and never the Error's own message.
    emitErr(safeLineText(`[m005-preflight-launcher] REFUSED: ${code}${names.length > 0 ? ` names=${names.join(',')}` : ''}`));
    return 2;
  }

  const fullArgv = Object.freeze([NODE_BIN, TSX_CLI, PREFLIGHT_SCRIPT, ...PREFLIGHT_FLAGS]);
  try {
    assertChildArgvContract(fullArgv);
  } catch (e) {
    const names = e instanceof LauncherRefusal ? e.names : [];
    emitErr(safeLineText(
      `[m005-preflight-launcher] REFUSED: ${INSPECT_LAUNCHER_CODES.ARGV_CONTRACT_VIOLATED} names=${names.join(',')}`,
    ));
    return 2;
  }

  const result = await runChild({
    command: fullArgv[0],
    args: fullArgv.slice(1),
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
      // THE TWO STREAMS ARE READ APART AND NEITHER IS FORWARDED. `streamText` yields nothing until
      // `runChild` has sealed the capture on proved closure, so a run whose pipes may still be
      // delivering — a timeout, a killed group, a late write after exit — produces the fixed
      // withheld token instead of a partial transcript. The third argument is the same proof the
      // seal was taken from, passed explicitly so this call site cannot read a capture the
      // lifecycle never certified.
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
// EXACT PATH IDENTITY, not a suffix test — a suffix test is satisfied by ANY entry script whose name
// merely ends in this one, which would import this module for its exports and start a real run as a
// side effect.
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
export { NODE_BIN, STARTUP_SENSITIVE, TSX_CLI };

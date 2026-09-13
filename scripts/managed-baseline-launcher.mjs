#!/usr/bin/env node
// Phase 4.0 M3 S4.1b — STAGE C2B-R3B-B0.
//
// SINGLE-PURPOSE parent launcher for the MANAGED HISTORICAL BASELINE (001,002,003,004).
//
// WHAT THIS FILE IS FOR
//   The managed historical baseline is executed by `scripts/supabase-migrate.ts --managed-dev
//   --baseline`. That CLI is correct, but the PARENT that invokes it is where the previous stage
//   failed: the C2B-OWNERACL-R1 launcher forwarded the child's stdout and stderr VERBATIM, so any
//   byte the child chose to print — including a DSN inside an uncaught driver error — would have
//   reached the operator record unredacted. Nothing leaked, but only because nothing printed one.
//   This launcher removes that window by construction.
//
// WHAT IT CANNOT DO — by construction, not by convention
//   * It cannot execute migration 005: the child argv is a frozen literal with no `--apply`, and
//     the launcher accepts no caller-supplied flags that could add one.
//   * It cannot adopt any other version set: `--baseline-versions=001,002,003,004` is frozen, and
//     the CLI independently refuses any allowlist that is not exactly that prefix.
//   * It cannot run an arbitrary command or script: the interpreter, the tsx CLI and the script
//     path are absolute constants derived from this file's own location.
//   * It cannot be pointed at another database: it passes no target argument at all. Routing comes
//     only from the child environment, which the child then corroborates against SUPABASE_URL and a
//     live fingerprint before it mutates anything.
//   * It cannot report success while any part of the managed process tree is still alive: OK
//     requires `close` AND an empty managed process GROUP AND an empty managed SESSION. Every
//     INDETERMINATE outcome — timeout, stream failure, unverified group, residual member — carries
//     DATABASE OUTCOME UNKNOWN and is structurally incapable of becoming OK. A determined failure
//     (a nonzero exit, a signalled exit, an output overflow) deliberately does NOT carry that line:
//     the child closed and reported, so the outcome is known to be a failure rather than unknown.
//   * It cannot ABANDON a managed process. When cleanup cannot establish that the managed group and
//     session are empty, this launcher does not release the child handle and does not exit: it
//     enters a REFERENCED CONTAINMENT HOLD, emits exactly one bounded code, and stays alive holding
//     supervision until an operator or the platform intervenes. See CONTAINMENT HOLD below. There is
//     no handle-releasing call anywhere in this file, and a test asserts that by source scan.
//
// THE PROCESS TOPOLOGY THIS LAUNCHER ACTUALLY DRIVES — measured, not assumed
//   `node <tsx>/dist/cli.mjs <script> <flags>` does NOT run the script. Measured on the installed
//   tsx 4.21.0, the tree is at least three deep:
//     layer 1  the DIRECT HANDLE: the tsx CLI shim. It creates a LISTENING unix-domain socket at
//              /tmp/tsx-<uid>/<pid>.pipe and then spawns layer 2. It never imports the script.
//     layer 2  `node --require <tsx>/dist/preflight.cjs --import file://<tsx>/dist/loader.mjs
//              <script> <flags>` — a GRANDCHILD. THIS is the process that imports and executes
//              supabase-migrate.ts, so this is the process that would construct the postgres client
//              and own its TCP socket and its session-scoped advisory lock.
//     layer 3  @esbuild/<platform>/bin/esbuild, spawned SYNCHRONOUSLY by layer 2 (esbuild's
//              transformSync uses execFileSync) to transform TypeScript. Transient, no service.
//   Both layers 1 and 2 inherit the exact child environment below — measured, key-for-key.
//
//   WHY THAT SINKS DIRECT-HANDLE-ONLY TERMINATION. On Linux, terminating a parent does not
//   terminate its descendants. Measured against this exact topology: SIGKILL to layer 1 left
//   layer 2 RUNNING and REPARENTED TO PID 1, still holding the environment and, in a real run,
//   the database session. A post-close scan for processes claiming the child as their PARENT
//   cannot see it — its ppid is now 1 — so the previous stage's evidence could not have detected
//   the orphan it was claiming did not exist. Its PGID and SID, by contrast, were unchanged.
//
//   WHY THE CLI IS RETAINED RATHER THAN REPLACED BY A SAME-PROCESS LOADER. A `node --import`
//   loader would remove layer 2, but not layer 3: esbuild still spawns a real binary child, so a
//   descendant remains possible and process-group containment is required either way. Given that,
//   replacing the child command would buy no containment while re-opening the one property that is
//   currently proved byte-for-byte — the frozen argv that makes migration 005 unreachable. The
//   containment is therefore added to the launcher and the invocation is left exactly as proved.
//
// SECURITY POSTURE
//   * Raw child output is NEVER forwarded. Every byte is captured, size-bounded, and redacted
//     before a single character is written to the operator record.
//   * The managed child runs in its OWN process group and session (`detached: true`; the parent
//     NEVER releases the handle), so containment targets a VERIFIED isolated group rather than one
//     handle, and a reparented descendant stays discoverable by PGID/SID after its ppid becomes 1.
//
// CONTAINMENT HOLD — why abandonment is not an available outcome
//   The previous stage classified an unfinishable cleanup honestly, as CLEANUP_INCOMPLETE, and then
//   released the child handle so this parent could exit anyway. The classification was accurate and
//   the behaviour was still abandonment: a descendant that survived TERM and KILL, or one whose group
//   could no longer be enumerated, was left running against the managed database with nothing
//   supervising it. An accurate label on an abandoned process is a better record, not a contained
//   process. So the release is gone. When the terminal evidence is incomplete this launcher holds:
//   it keeps a REFERENCED supervisor alive, keeps the child handle, emits one bounded code saying
//   intervention is required, and never reports a pass. It does not retry, reconnect or compensate.
//   * The child environment is built from an EMPTY object and carries exactly the allowlist below —
//     no PATH, no HOME, no npm configuration, no PG*, no Node TLS or OpenSSL override.
//   * Secrets travel only through that environment: never argv, never inline source, never a
//     temporary file, never shell-expanded text, never output.
//   * Nothing captured is written to disk, and no secret length, hash or derived fingerprint is
//     ever emitted — those are themselves disclosures.
//
// IMPORTING THIS MODULE SPAWNS NOTHING. The entry point below runs only when this file is the
// process entry AND the single literal argument `--execute` is present.

import { spawn as nodeSpawn } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..');

/** Bounded outcome codes. Nothing else ever crosses into the operator record. */
export const LAUNCHER_CODES = Object.freeze({
  OK: 'baseline_launcher_ok',
  BAD_INVOCATION: 'baseline_launcher_bad_invocation',
  EXEC_ENV_UNAVAILABLE: 'baseline_launcher_exec_environment_unavailable',
  STARTUP_SENSITIVE_PRESENT: 'baseline_launcher_startup_sensitive_present',
  CONFIG_MISSING: 'baseline_launcher_required_configuration_missing',
  CONFIG_UNPARSABLE: 'baseline_launcher_configuration_unparsable',
  STREAM_FAILED: 'baseline_launcher_output_stream_failed',
  CHILD_ENV_INVALID: 'baseline_launcher_child_environment_invalid',
  SPAWN_FAILED: 'baseline_launcher_spawn_failed',
  TIMEOUT: 'baseline_launcher_timeout',
  CLEANUP_INCOMPLETE: 'baseline_launcher_cleanup_incomplete',
  CONTAINMENT_HOLD: 'baseline_launcher_containment_hold',
  PLATFORM_UNSUPPORTED: 'baseline_launcher_platform_unsupported',
  PROCFS_UNAVAILABLE: 'baseline_launcher_procfs_unavailable',
  GROUP_UNVERIFIED: 'baseline_launcher_group_identity_unverified',
  GROUP_RESIDUAL: 'baseline_launcher_managed_group_residual',
  OUTPUT_LIMIT_EXCEEDED: 'baseline_launcher_output_limit_exceeded',
  CHILD_NONZERO_EXIT: 'baseline_launcher_child_nonzero_exit',
  CHILD_SIGNALLED: 'baseline_launcher_child_signalled',
  // The child did not deliver exactly one valid POST-CLEANUP terminal record, so nothing establishes
  // that it finished rather than being destroyed. Linux realtime signals 34, 40 and 64 reach this
  // launcher as `exitCode=0 signal=null` — byte-identical to a clean success — so neither
  // `result.signal` nor `result.exitCode` can separate the two. This is the only thing that can.
  TERMINAL_EVIDENCE_INCOMPLETE: 'baseline_launcher_terminal_evidence_incomplete',
});

/**
 * The sentence a timeout or a forced termination ALWAYS carries.
 *
 * A timeout says nothing about the transaction. The child may have committed the adoption, may have
 * rolled it back, and may have been terminated between the COMMIT statement and its acknowledgement
 * — three states this parent cannot distinguish from outside. The dangerous rendering is the tidy
 * one: `status=timeout` alone reads as "nothing happened", and that reading is what invites a re-run
 * against a ledger that may already hold the prefix. So the unknown is stated in operational terms,
 * on its own line, for EVERY timeout or forced-termination outcome.
 */
export const DATABASE_OUTCOME_UNKNOWN = 'DATABASE OUTCOME UNKNOWN — DO NOT RE-RUN';

/**
 * INDETERMINATE statuses: the database outcome cannot be established, so containment cleanup runs
 * and the record says so.
 *
 * Not all of them are reached with the direct child still running — `group_residual` is entered
 * AFTER its `close`, precisely because a descendant outlived it. What they share is that some part
 * of the managed tree was, or may still be, alive with an unresolved transaction behind it.
 *
 * A spawn failure is deliberately absent: the child never started, so nothing happened and saying
 * "unknown" would be false. A clean `close` with an empty group is absent for the opposite reason —
 * the exit code is the answer.
 */
export const CLEANUP_STATUSES = Object.freeze(new Set(['timeout', 'stream_failed', 'group_unverified', 'group_residual']));

/**
 * The code a cleanup status carries when the cleanup COMPLETED. An incomplete cleanup overrides all
 * of these with CLEANUP_INCOMPLETE; none of them is, or can become, OK.
 *
 * `group_unverified` and `group_residual` are new in this stage and both describe a child that was
 * started and whose containment could not be taken for granted: the first could not be proved to own
 * an isolated group, the second exited while some member of its group or session did not.
 */
export const CLEANUP_BASE_CODES = Object.freeze({
  timeout: LAUNCHER_CODES.TIMEOUT,
  stream_failed: LAUNCHER_CODES.STREAM_FAILED,
  group_unverified: LAUNCHER_CODES.GROUP_UNVERIFIED,
  group_residual: LAUNCHER_CODES.GROUP_RESIDUAL,
});

/**
 * Variables that change how Node behaves BEFORE the first line of JavaScript runs.
 *
 * A check inside an already-running Node parent is DETECTION, not prevention: by the time this
 * module executes, NODE_OPTIONS has already been applied, NODE_EXTRA_CA_CERTS has already widened
 * the trust store, and OPENSSL_CONF has already been read. The removal must therefore happen at the
 * shell/exec boundary — see OUTER_INVOCATION — and the in-process assertion below exists to prove
 * that the removal actually happened, not to substitute for it.
 */
export const STARTUP_SENSITIVE = Object.freeze([
  'NODE_OPTIONS',
  'NODE_EXTRA_CA_CERTS',
  'NODE_TLS_REJECT_UNAUTHORIZED',
  'OPENSSL_CONF',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
]);

/**
 * The EXACT child environment key set, derived from source rather than guessed:
 *   SUPABASE_DATABASE_URL          — assertManagedDevDsn() argument 1 (scripts/supabase-migrate.ts)
 *   SUPABASE_URL                   — assertManagedDevDsn() argument 2, the independent corroborator
 *   DATABASE_CA_CERT               — getDatabaseCaConfig() -> resolveDatabaseTls() (platform-identity/config.ts)
 *   ALLOW_SUPABASE_MIGRATION_APPLY — operator gate, must equal '1'   (assertOperatorGates)
 *   CONFIRM_SUPABASE_TARGET        — operator gate, must equal the DEV label (assertOperatorGates)
 *   NODE_ENV                       — must not be 'production'        (assertOperatorGates)
 *
 * `--confirm-dev` is the third operator gate and is a FLAG, not a variable, so it is in the frozen
 * argv below and deliberately not here.
 */
export const CONFIG_KEYS = Object.freeze(['SUPABASE_DATABASE_URL', 'SUPABASE_URL', 'DATABASE_CA_CERT']);
export const GATE_VALUES = Object.freeze({
  ALLOW_SUPABASE_MIGRATION_APPLY: '1',
  CONFIRM_SUPABASE_TARGET: 'tmpos2026-dev',
  NODE_ENV: 'development',
});
export const CHILD_ENV_KEYS = Object.freeze([...CONFIG_KEYS, ...Object.keys(GATE_VALUES)]);

/** The frozen child argv tail. No apply flag, no version freedom, no caller input. */
export const BASELINE_FLAGS = Object.freeze([
  '--managed-dev',
  '--baseline',
  '--confirm-dev',
  '--baseline-versions=001,002,003,004',
]);

export const NODE_BIN = process.execPath;
export const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
export const MIGRATE_SCRIPT = join(REPO_ROOT, 'scripts', 'supabase-migrate.ts');

/** 64 KiB. The baseline prints a fixed handful of bounded lines; anything larger is anomalous. */
export const OUTPUT_LIMIT_BYTES = 64 * 1024;
/** Connect + fingerprint + lock + verify + write + read-back, each bounded at 30s by the CLI. */
export const TIMEOUT_MS = 120_000;

/**
 * The FUTURE outer invocation. `env -u` removes each startup-sensitive variable at the exec
 * boundary, so the parent Node process never starts with one in scope. This string is the
 * definition of that design and is asserted by the deterministic tests; it is NOT executed here.
 */
export const OUTER_INVOCATION = [
  'env',
  ...STARTUP_SENSITIVE.map((n) => `-u ${n}`),
  NODE_BIN,
  join(REPO_ROOT, 'scripts', 'managed-baseline-launcher.mjs'),
  '--execute',
].join(' ');

/**
 * How often the CONTAINMENT HOLD re-observes the managed group. Low frequency on purpose: the hold
 * is a supervision posture, not a monitor, and a fast poll would burn CPU indefinitely for a state
 * that only an operator can resolve.
 */
export const CONTAINMENT_HOLD_POLL_MS = 30_000;

/**
 * Enter the REFERENCED CONTAINMENT HOLD.
 *
 * WHAT THIS REPLACES, AND WHY. The previous stage, on an unfinishable cleanup, released the child
 * handle so this parent could exit. The outcome code was honest — CLEANUP_INCOMPLETE, never OK — and
 * the behaviour was still abandonment: a descendant that survived SIGTERM and SIGKILL, or one whose
 * group could no longer be enumerated, kept running against the managed database with nothing
 * supervising it. Classification is not containment. So the release is gone, and this is what stands
 * in its place.
 *
 * THE CONTRACT, each clause load-bearing:
 *   * no handle release, and no `process.exit` — either one is the abandonment this exists to stop;
 *   * the interval below is REFERENCED (never detached from the event loop), so the launcher cannot
 *     reach natural event-loop exit while a managed process may still be alive. A detached timer
 *     would satisfy the letter of "a timer exists" and none of its purpose;
 *   * EXACTLY ONE bounded code is emitted, at entry. The poll emits nothing at all — an unbounded
 *     stream of hold notices is how an operator record becomes unreadable in the one run that
 *     matters, and the poll's observation is for the hold's own state, not for the record;
 *   * the database outcome stays UNKNOWN and nothing is retried, reconnected or compensated;
 *   * this is never a pass. `outcomeCode` cannot return OK for any status that reaches here.
 *
 * `setIntervalFn` / `clearIntervalFn` / `observe` are seams so the deterministic suite can drive the
 * hold without a real timer and without a real process — the suite must never hang, and must never
 * be the thing that abandons a child.
 */
export function enterContainmentHold({
  emit,
  observe = () => null,
  pollMs = CONTAINMENT_HOLD_POLL_MS,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  let polls = 0;
  const timer = setIntervalFn(() => {
    polls += 1;
    try {
      // Observed, never printed. The hold's job is to stay alive holding supervision; narrating it
      // once per interval would be the unbounded output this contract forbids.
      observe();
    } catch {
      // An observation that fails changes nothing: the hold is already the most conservative state
      // this launcher has, and there is no weaker one to fall back to.
    }
  }, pollMs);
  if (typeof emit === 'function') {
    emit(
      `[baseline-launcher] ${LAUNCHER_CODES.CONTAINMENT_HOLD} — the managed process group could not be ` +
        'proved empty; this launcher is HOLDING supervision and will not exit. OPERATOR OR PLATFORM ' +
        'INTERVENTION IS REQUIRED. Do not re-run the baseline.',
    );
  }
  return {
    timer,
    /** Present so a test can end the hold deterministically. The live launcher never calls it. */
    release: () => clearIntervalFn(timer),
    get polls() {
      return polls;
    },
  };
}

/** A bounded launcher failure. Carries a code and variable NAMES — never a value. */
export class LauncherRefusal extends Error {
  constructor(code, names = []) {
    super(names.length > 0 ? `${code}: ${names.join(',')}` : code);
    this.name = 'LauncherRefusal';
    this.code = code;
    this.names = names;
  }
}

// ---- exec-time environment (the only pre-import ground truth) ---------------

/** Parse a NUL-separated `/proc/<pid>/environ` payload into a name -> value Map. */
export function parseEnviron(raw) {
  const map = new Map();
  for (const entry of String(raw).split('\0')) {
    if (entry === '') continue;
    const eq = entry.indexOf('=');
    if (eq <= 0) continue;
    map.set(entry.slice(0, eq), entry.slice(eq + 1));
  }
  return map;
}

/**
 * Read the EXEC-TIME environment of this process.
 *
 * `process.env` is mutable by any import in the graph; `/proc/self/environ` is the environment the
 * kernel recorded at exec and no in-process assignment can change it. That is precisely why the
 * startup-sensitive proof is taken from here and not from `process.env`.
 *
 * If it cannot be read, the live action is REFUSED. Falling back to `process.env` would silently
 * downgrade the proof to the weaker source this function exists to avoid.
 */
export function readExecEnvironment(readFile = readFileSync) {
  let raw;
  try {
    raw = readFile('/proc/self/environ', 'utf8');
  } catch {
    throw new LauncherRefusal(LAUNCHER_CODES.EXEC_ENV_UNAVAILABLE);
  }
  return parseEnviron(raw);
}

/** Refuse when any startup-sensitive variable survived into the parent's exec-time environment. */
export function assertStartupSensitiveAbsent(execEnv) {
  const present = STARTUP_SENSITIVE.filter((n) => execEnv.has(n));
  if (present.length > 0) throw new LauncherRefusal(LAUNCHER_CODES.STARTUP_SENSITIVE_PRESENT, present);
}

// ---- child environment ------------------------------------------------------

/**
 * Build the child environment from an EMPTY object.
 *
 * `Object.create(null)` has no prototype, so no inherited key can appear through `for...in`, which
 * is how Node enumerates `options.env`. Node REPLACES rather than merges `options.env`, so what is
 * returned here is the child's complete environment — PATH, HOME and npm configuration included,
 * i.e. absent.
 */
export function buildChildEnv(source) {
  const missing = CONFIG_KEYS.filter((k) => {
    const v = source?.[k];
    return typeof v !== 'string' || v.trim() === '';
  });
  if (missing.length > 0) throw new LauncherRefusal(LAUNCHER_CODES.CONFIG_MISSING, missing);

  const env = Object.create(null);
  for (const k of CONFIG_KEYS) env[k] = source[k];
  for (const [k, v] of Object.entries(GATE_VALUES)) env[k] = v;
  assertChildEnv(env);
  return env;
}

/** Prove the constructed environment is exactly the allowlist, with none of the forbidden shapes. */
export function assertChildEnv(env) {
  const keys = Object.keys(env).sort();
  const want = [...CHILD_ENV_KEYS].sort();
  const problems = [];
  if (keys.join(',') !== want.join(',')) problems.push('key_set_mismatch');
  for (const k of keys) {
    if (/^PG/.test(k)) problems.push(k);
    if (STARTUP_SENSITIVE.includes(k)) problems.push(k);
    if (k === 'PATH' || k === 'HOME') problems.push(k);
    if (/^(npm_|NPM_)/.test(k)) problems.push(k);
  }
  if (problems.length > 0) throw new LauncherRefusal(LAUNCHER_CODES.CHILD_ENV_INVALID, problems);
}

// ---- redaction ---------------------------------------------------------------

/**
 * Every literal whose appearance in output would be a disclosure.
 *
 * Derived from the child environment itself, so the redactor can never drift out of step with what
 * was actually handed to the child. Both the DECODED and the PERCENT-ENCODED forms of the
 * credential are included: `new URL()` exposes the raw (still-encoded) userinfo, while a driver
 * error may quote either form.
 */
export function secretValuesFrom(env) {
  const out = [];
  /** Derived, low-entropy material: a floor stops a 1-2 character token shredding the record. */
  const add = (v) => {
    if (typeof v === 'string' && v.trim().length >= 3) out.push(v.trim());
  };
  /**
   * CREDENTIAL material: NO floor.
   *
   * The floor above is a legibility guard, and applying it to a credential trades a disclosure for
   * readability — the wrong way round. A one-character password redacts every occurrence of that
   * character, which produces an obviously unusable record; a leaked one-character password
   * produces a usable-looking record that has disclosed the secret. The self-announcing failure is
   * the safe one.
   */
  const addCredential = (v) => {
    if (typeof v === 'string' && v !== '') out.push(v);
  };
  const decode = (v) => {
    try {
      return decodeURIComponent(v);
    } catch {
      return v;
    }
  };

  for (const [name, raw] of [
    ['SUPABASE_DATABASE_URL', env.SUPABASE_DATABASE_URL],
    ['SUPABASE_URL', env.SUPABASE_URL],
  ]) {
    if (typeof raw !== 'string' || raw === '') continue;
    add(raw);
    let url;
    try {
      url = new URL(raw);
    } catch {
      // FAIL CLOSED, do not degrade. Continuing here would leave the whole-string literal as the
      // ONLY redaction target: no host, no user, no credential, no project ref. The child would
      // then be free to print any of those in a form that matches nothing, and the operator would
      // have no signal that redaction coverage had collapsed. A launcher whose premise is that the
      // redactor cannot drift out of step with the child environment must refuse instead.
      throw new LauncherRefusal(LAUNCHER_CODES.CONFIG_UNPARSABLE, [name]);
    }
    // LOWERCASED TOO. `postgresql:` is not a WHATWG "special" scheme, so its host goes through the
    // opaque-host parser, which does NOT ASCII-lowercase — measured: `DB.Ref.Supabase.CO` survives
    // verbatim. DNS, getaddrinfo and TLS error text routinely report the lowercased name, so a
    // case-preserving literal alone would miss the echo that matters.
    for (const host of new Set([url.hostname, url.hostname.toLowerCase()])) {
      add(host);
      // An IPv6 literal is exposed WITH its brackets (measured: `[2a05:d012::1]`), while driver
      // errors print the address bare (`connect ETIMEDOUT 2a05:d012::1:5432`). Both forms are
      // needed; the bracketed one alone would never match.
      if (host.startsWith('[') && host.endsWith(']')) add(host.slice(1, -1));
      // Project-identifying URL components: the labels of the hostname. A Supabase project ref is a
      // hostname label in BOTH shapes (`db.<ref>.supabase.co` and `<ref>.supabase.co`), so
      // redacting every sufficiently long label covers the ref without knowing which shape this is.
      for (const label of host.split('.')) add(label);
    }
    add(url.host);
    // Non-special schemes have an OPAQUE origin, serialised as the literal string "null" (measured).
    // Adding it would contribute zero coverage for the DSN and would rewrite every `null` in the
    // child's output to `[REDACTED]` — corrupting the record in a way that reads like a redaction
    // hit, in exactly the run where the record matters.
    if (url.origin !== 'null') add(url.origin);
    for (const part of [url.username, url.password]) {
      if (part === '') continue;
      addCredential(part);
      addCredential(decode(part));
      addCredential(encodeURIComponent(decode(part)));
    }
  }

  const ca = env.DATABASE_CA_CERT;
  if (typeof ca === 'string' && ca !== '') {
    add(ca);
    // Individual SIGNIFICANT lines too: a wrapped certificate quoted back one line at a time would
    // never match the whole-blob literal, and the whole-blob literal is line-ending sensitive, so a
    // child that normalises CRLF to LF defeats it as well.
    //
    // Boundary markers are excluded STRUCTURALLY, not by length. The previous 24-character floor
    // claimed to exclude them and did not: `-----BEGIN CERTIFICATE-----` is 27 characters and
    // `-----END CERTIFICATE-----` is 25, so both cleared it and were redacted, while a certificate
    // wrapped narrower than 24 columns lost all per-line coverage. Naming the markers directly
    // fixes both halves of that.
    for (const line of ca.split(/\r?\n/)) {
      const t = line.trim();
      if (t !== '' && !/^-{5}(BEGIN|END)\b/.test(t) && t.length >= 8) add(t);
    }
  }
  return [...new Set(out)];
}

/**
 * STRUCTURAL patterns, as sources so a fresh `RegExp` is built per call.
 *
 * Both catch material that no literal derived from the environment can match: a certificate the
 * child re-wrapped or re-encoded, and a RESOLVED address, which exists nowhere in the child
 * environment and is therefore un-derivable by construction. Driver errors print resolved addresses
 * routinely (`connect ETIMEDOUT <ip>:6543`), and that is a routing disclosure even though it is not
 * a credential one.
 *
 * A shared `/g` RegExp object carries `lastIndex` across calls, so a second redaction of a shorter
 * text would silently start scanning from the middle. Rebuilding per call removes that state.
 */
const STRUCTURAL_PATTERNS = Object.freeze([
  ['\\b\\d{1,3}(?:\\.\\d{1,3}){3}\\b', '[REDACTED-ADDR]'],
  ['\\b(?:[0-9a-fA-F]{1,4}:){2,7}(?::|[0-9a-fA-F]{1,4})\\b', '[REDACTED-ADDR]'],
]);

/**
 * PEM blocks, found by PAIRING bounded markers rather than by one lazy span.
 *
 * The obvious pattern is `-----BEGIN X-----[\s\S]*?-----END X-----`. It is correct and it is
 * QUADRATIC: every unmatched BEGIN makes the lazy middle scan to end-of-input before failing, so a
 * capture of nothing but BEGIN markers costs O(k·n) — measured at roughly a second of synchronous
 * CPU at the 64 KiB ceiling, and four times that at 128 KiB. The ceiling bounds it, but a redactor
 * whose cost an adversarial child can choose is not "safe by construction".
 *
 * Both marker patterns below are bounded (no unbounded quantifier), so each scan is linear; pairing
 * them is a single forward walk. Same spans, no backtracking.
 */
function pemRanges(src) {
  const begin = /-{5}BEGIN [A-Z0-9 ]+-{5}/g;
  const end = /-{5}END [A-Z0-9 ]+-{5}/g;
  const ends = [];
  for (let m = end.exec(src); m !== null; m = end.exec(src)) ends.push({ start: m.index, end: m.index + m[0].length });
  const out = [];
  let cursor = 0; // index into `ends`; both lists are already in ascending order
  for (let m = begin.exec(src); m !== null; m = begin.exec(src)) {
    if (m.index < cursor) continue;
    while (cursor < ends.length && ends[cursor].start < m.index) cursor += 1;
    if (cursor >= ends.length) break; // a BEGIN with no END after it: nothing to pair
    out.push({ start: m.index, end: ends[cursor].end, label: '[REDACTED-PEM]' });
    // Never pair this END again, and never start a block inside the one just taken.
    begin.lastIndex = ends[cursor].end;
    cursor += 1;
  }
  return out;
}

/**
 * A redactor that is safe by CONSTRUCTION for overlapping secrets.
 *
 * THE DEFECT THIS REPLACES. The previous implementation applied sequential `split/join` passes in
 * descending length order. Longest-first happens to be correct when one value strictly CONTAINS
 * another — a hostname inside its DSN — because the containing value is replaced first and the
 * contained one no longer occurs. It is not correct in general, and the property it relied on was a
 * fact about one particular value set rather than an invariant of the algorithm. Two values that
 * merely OVERLAP (`…user:pass@host` and `pass@host:6543/db`) have no containment relation at all:
 * the first pass rewrites its span, the second pass then fails to match a literal whose leading
 * characters the first pass consumed, and the tail of the second secret survives in the record. The
 * old code was "safe for the current value set by accident", and the accident was load-bearing.
 *
 * THE ALGORITHM. No sequential replacement, and no dependence on any relationship between values:
 *   1. every structural and literal match is computed against the ORIGINAL captured text, so no
 *      match position is ever influenced by an earlier replacement;
 *   2. each match is recorded as a half-open [start, end) character range;
 *   3. all ranges are sorted and merged whenever they overlap or touch;
 *   4. each merged range is replaced EXACTLY once, in a single left-to-right rebuild.
 * Overlap is therefore resolved by union rather than by ordering, and the union of two overlapping
 * secret spans is itself entirely secret — so nothing between the first start and the last end can
 * survive, whatever the values happen to be.
 *
 * A merged range spanning two different labels degrades to the generic `[REDACTED]`: a span that is
 * part certificate and part credential is not honestly describable as either.
 *
 * Indices are UTF-16 code units into the already-decoded string. Multi-byte reassembly happens in
 * `createCapture().text()` (`Buffer.concat` before `toString`), so a code point split across two
 * stream chunks is whole before any index here is taken.
 */
export function buildRedactor(values) {
  const literals = [...new Set(values)].filter((v) => v !== '');
  return (text) => {
    const src = String(text);
    const ranges = [];

    ranges.push(...pemRanges(src));

    for (const [source, label] of STRUCTURAL_PATTERNS) {
      const re = new RegExp(source, 'g');
      for (let m = re.exec(src); m !== null; m = re.exec(src)) {
        if (m[0] === '') {
          re.lastIndex += 1; // a zero-width match would otherwise spin forever
          continue;
        }
        ranges.push({ start: m.index, end: m.index + m[0].length, label });
      }
    }

    // `indexOf`, not RegExp: a certificate or a DSN contains regex metacharacters, and building a
    // pattern out of operator-supplied material is its own defect class. The cursor advances by ONE
    // character, not by the match length, so a value that overlaps ITSELF (`abab` inside `ababab`)
    // contributes both occurrences — they merge into one range immediately afterwards.
    for (const v of literals) {
      for (let i = src.indexOf(v); i !== -1; i = src.indexOf(v, i + 1)) {
        ranges.push({ start: i, end: i + v.length, label: '[REDACTED]' });
      }
    }

    if (ranges.length === 0) return src;

    ranges.sort((a, b) => a.start - b.start || b.end - a.end);
    const merged = [];
    for (const r of ranges) {
      const last = merged[merged.length - 1];
      // `<=` merges TOUCHING ranges too. Two secrets that abut leave no legible text between them,
      // and emitting `[REDACTED][REDACTED]` would disclose where the boundary fell.
      if (last !== undefined && r.start <= last.end) {
        if (r.end > last.end) last.end = r.end;
        if (last.label !== r.label) last.label = '[REDACTED]';
      } else {
        merged.push({ start: r.start, end: r.end, label: r.label });
      }
    }

    let out = '';
    let cursor = 0;
    for (const r of merged) {
      out += src.slice(cursor, r.start) + r.label;
      cursor = r.end;
    }
    return out + src.slice(cursor);
  };
}

// ---- bounded capture ---------------------------------------------------------

/**
 * Size-bounded capture of a child stream pair.
 *
 * BUFFER, then redact — never redact per chunk. A secret can be split across chunk boundaries at
 * any byte, so a per-chunk redactor would pass both halves through untouched. Buffering to a hard
 * ceiling and redacting the assembled text makes the chunk boundary irrelevant, which is why the
 * ceiling exists: it is what keeps "buffer everything" bounded.
 */
export function createCapture(limit = OUTPUT_LIMIT_BYTES) {
  const chunks = [];
  /**
   * C2B-M005-LRLS-L3-R3 — THE SAME BYTES, ALSO KEPT PER STREAM.
   *
   * `chunks` above is the arrival-ordered interleave of both pipes, and interleaving is a defect
   * for a PARSING consumer: a secret whose first half is written to stdout and whose second half is
   * written to stderr becomes CONTIGUOUS in that one buffer, so a consumer that scans it can be
   * handed a reassembled credential the child never printed to either stream whole. Keeping the two
   * apart costs one extra reference per chunk and removes the reassembly entirely.
   *
   * `text()` deliberately keeps reading the interleave, byte-for-byte as before, because the
   * historical baseline record is defined in terms of it. `streamText()` is the parsing entry point.
   */
  const perStream = { stdout: [], stderr: [] };
  let total = 0;
  let overflowed = false;
  let sealed = false;
  return {
    /**
     * `stream` NAMES THE PIPE, and an unrecognised name is folded into stdout rather than dropped:
     * losing a chunk silently would understate `byteLength` and could let an overflowing child slip
     * under the ceiling.
     */
    push(chunk, stream = 'stdout') {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      total += buf.length;
      if (total > limit) {
        // FAIL CLOSED. Past the ceiling the captured text is discarded outright rather than
        // truncated: a truncation point can fall in the middle of a secret, and half a DSN in the
        // operator record is still a disclosure.
        overflowed = true;
        chunks.length = 0;
        perStream.stdout.length = 0;
        perStream.stderr.length = 0;
        return;
      }
      chunks.push(buf);
      (stream === 'stderr' ? perStream.stderr : perStream.stdout).push(buf);
    },
    /**
     * Mark both pipes terminal. Until this is called `streamText()` yields nothing.
     *
     * The gate lives on the OBJECT rather than at the call sites because §4 forbids inspecting a
     * capture before closure is proved, and a rule enforced at each call site is a rule the next
     * call site can forget. `text()` keeps its old ungated contract so the historical baseline
     * record is unchanged; every new consumer goes through the sealed accessor.
     */
    seal() {
      sealed = true;
    },
    get sealed() {
      return sealed;
    },
    get overflowed() {
      return overflowed;
    },
    get byteLength() {
      return total;
    },
    /**
     * One stream's bytes, decoded only once the pair is sealed.
     *
     * `Buffer.concat` BEFORE `toString` for the same reason as `text()`: a multi-byte code point
     * split across two chunk boundaries is whole again before any character index is taken.
     */
    streamText(stream) {
      if (!sealed || overflowed) return '';
      return Buffer.concat(stream === 'stderr' ? perStream.stderr : perStream.stdout).toString('utf8');
    },
    text() {
      return overflowed ? '' : Buffer.concat(chunks).toString('utf8');
    },
  };
}

// ---- process-level evidence --------------------------------------------------

/** The empty observation. Every `/proc` reader degrades to exactly this shape, never to a guess. */
export const UNOBSERVED = Object.freeze({
  available: false,
  pidPresent: null,
  leaderIdentityMatches: null,
  groupMembers: null,
  sessionMembers: null,
});

/**
 * Parse one `/proc/<pid>/stat` line into the identity fields this launcher signals on.
 *
 * Field 2 (`comm`) is parenthesised and may itself contain spaces AND parentheses, so every offset
 * is taken after the LAST ')' — a process that renames itself `x) 1 1 1` cannot shift the fields.
 * After that slice, `tail[0]` is field 3, so:
 *   tail[0]  state       tail[1]  ppid       tail[2]  pgrp
 *   tail[3]  session     tail[19] starttime  (field 22)
 *
 * `starttime` is kept because it is the ONLY cheap discriminator against PID recycling: a pid alone
 * identifies a slot, a pid plus its start time identifies an incarnation.
 */
export function parseProcStat(pid, raw) {
  const text = String(raw);
  const close = text.lastIndexOf(')');
  if (close < 0) return null;
  const tail = text.slice(close + 1).trim().split(/\s+/);
  const num = (i) => {
    const n = Number(tail[i]);
    return Number.isInteger(n) ? n : null;
  };
  const pgid = num(2);
  const sid = num(3);
  if (pgid === null || sid === null) return null;
  // VALIDATED, not merely read. `starttime` is the recycling discriminator, and a discriminator that
  // can silently be an empty string or `undefined` is one that stops discriminating without saying
  // so — see the null-handling in `scanGroup` below, which now refuses to treat it as a match.
  const rawStart = tail[19];
  const starttime = typeof rawStart === 'string' && /^\d+$/.test(rawStart) ? rawStart : null;
  return { pid, state: tail[0] ?? null, ppid: num(1), pgid, sid, starttime };
}

/**
 * Read one process's identity.
 *
 * `null` means EXITED, and nothing else. An `ENOENT` is the ordinary "it left between the readdir
 * and the read"; any other read failure, or a stat line that cannot be understood, is a FAILURE TO
 * OBSERVE and is raised — because reporting it as absence is how a live member becomes an empty
 * group, and an empty group is what authorises OK.
 */
export function readProcIdentity(pid, readFile = readFileSync) {
  let raw;
  try {
    raw = readFile(`/proc/${pid}/stat`, 'utf8');
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return null;
    throw new LauncherRefusal(LAUNCHER_CODES.PROCFS_UNAVAILABLE, ['stat_unreadable']);
  }
  const parsed = parseProcStat(pid, raw);
  if (parsed === null) throw new LauncherRefusal(LAUNCHER_CODES.PROCFS_UNAVAILABLE, ['stat_unparsable']);
  return parsed;
}

/**
 * Prove the spawned child owns an ISOLATED process group and session, or refuse.
 *
 * `detached: true` asks Node for `setsid()`, which makes the child leader of a NEW session and a
 * NEW group. This function does not take that on trust — it reads the result back out of the kernel
 * and requires all of:
 *   * pid === pgid === sid — the child is BOTH group leader and session leader, so the group is
 *     exactly the subtree it will create and contains nothing that predates it;
 *   * pgid > 1 — never 0 (which means "the caller's group" to kill(2)) and never 1;
 *   * pgid differs from the parent's pid, pgid AND sid — the single check that makes a group signal
 *     structurally incapable of reaching this launcher, its shell, or its siblings.
 *
 * Inability to establish this is a REFUSAL, never a downgrade to direct-handle signalling: a
 * launcher that quietly falls back to the weaker mechanism when the stronger one cannot be proved
 * has the weaker mechanism, and an operator who was told otherwise.
 */
export function assertIsolatedGroup(childIdentity, parentIdentity) {
  const problems = [];
  if (childIdentity === null || childIdentity === undefined) {
    problems.push('child_identity_unreadable');
    throw new LauncherRefusal(LAUNCHER_CODES.GROUP_UNVERIFIED, problems);
  }
  const { pid, pgid, sid } = childIdentity;
  if (!Number.isInteger(pid) || pid <= 1) problems.push('invalid_child_pid');
  if (!Number.isInteger(pgid) || pgid <= 1) problems.push('invalid_group_id');
  if (!Number.isInteger(sid) || sid <= 1) problems.push('invalid_session_id');
  if (pgid !== pid) problems.push('not_group_leader');
  if (sid !== pid) problems.push('not_session_leader');
  // The recycling discriminator must EXIST before the run is accepted. Establishing it here, once,
  // means every later comparison has something real to compare against — and a `/proc` that cannot
  // supply it is refused up front rather than mid-cleanup, when the alternative is signalling.
  if (typeof childIdentity.starttime !== 'string' || !/^\d+$/.test(childIdentity.starttime)) {
    problems.push('starttime_unavailable');
  }
  if (parentIdentity === null || parentIdentity === undefined) {
    problems.push('parent_identity_unreadable');
  } else {
    if (pgid === parentIdentity.pid) problems.push('group_is_parent_pid');
    if (pgid === parentIdentity.pgid) problems.push('shares_parent_group');
    if (sid === parentIdentity.sid) problems.push('shares_parent_session');
  }
  if (problems.length > 0) throw new LauncherRefusal(LAUNCHER_CODES.GROUP_UNVERIFIED, [...new Set(problems)]);
  return Object.freeze({ pid, pgid, sid, starttime: childIdentity.starttime ?? null });
}

/**
 * Enumerate the managed group and session by PGID/SID — NOT by PPID ancestry.
 *
 * This is the correction that matters. A descendant whose parent dies is reparented to PID 1, so a
 * ppid-based scan loses it at exactly the moment it becomes an orphan — the moment the scan exists
 * to detect. PGID and SID are inherited across `fork` and survive reparenting untouched, so the same
 * process that a ppid scan can no longer see remains a first-class member here.
 *
 * `groupMembers` and `sessionMembers` are disjoint: a member that called `setpgid()` into a new
 * group inside the managed session appears in `sessionMembers`, and §6 refuses to pass while either
 * list is non-empty.
 *
 * `leaderIdentityMatches` compares the leader's pgid, sid and START TIME against what was recorded
 * at spawn. It is the recycling guard: `false` means the pid slot is now some other incarnation, and
 * the caller must not signal that group.
 */
export function scanGroup(identity, readDir = readdirSync, readFile = readFileSync) {
  if (identity === null || identity === undefined) return { ...UNOBSERVED };
  let entries;
  try {
    entries = readDir('/proc');
  } catch {
    return { ...UNOBSERVED };
  }
  let pidPresent = false;
  let leaderIdentityMatches = null;
  const groupMembers = [];
  const sessionMembers = [];
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    let st;
    try {
      st = readProcIdentity(pid, readFile);
    } catch {
      // A process that could not be UNDERSTOOD is not a process that is gone. Silently skipping it
      // would under-count the group and could report empty while a member is alive, so the whole
      // observation degrades to unavailable — missing evidence, never evidence of absence.
      return { ...UNOBSERVED };
    }
    if (st === null) continue; // exited between readdir and read — not an error
    if (pid === identity.pid) {
      pidPresent = true;
      // FAIL CLOSED on a missing start time. Treating "cannot tell" as "same incarnation" is the
      // wrong default for a recycling guard: it turns the discriminator off at exactly the moment
      // it would have mattered. `assertIsolatedGroup` guarantees `identity.starttime` is present.
      leaderIdentityMatches =
        st.pgid === identity.pgid &&
        st.sid === identity.sid &&
        typeof st.starttime === 'string' &&
        st.starttime === identity.starttime;
    }
    // A ZOMBIE is not a survivor. It holds no resources, cannot execute, cannot hold a database
    // session, and is waiting only to be reaped by the parent that is about to call done(). Counting
    // it as a residual member would make every ordinary run report CLEANUP_INCOMPLETE, which trains
    // an operator to ignore the one signal this stage adds.
    //
    // The consequence is stated rather than hidden: `groupMembers` is "live, non-zombie members of
    // the managed group", not "every task the kernel still lists". The invariant this file enforces
    // is that nothing can still EXECUTE or hold a session — which is the property that matters for a
    // database — and it is deliberately not the stronger claim that the pid table is literally clear.
    if (st.state === 'Z') continue;
    if (st.pgid === identity.pgid) groupMembers.push(pid);
    else if (st.sid === identity.sid) sessionMembers.push(pid);
  }
  return { available: true, pidPresent, leaderIdentityMatches, groupMembers, sessionMembers };
}

/** True when the observation is complete AND shows no live member of the group or the session. */
export function groupIsEmpty(observed) {
  return (
    observed.available === true &&
    Array.isArray(observed.groupMembers) &&
    Array.isArray(observed.sessionMembers) &&
    observed.groupMembers.length === 0 &&
    observed.sessionMembers.length === 0
  );
}

/**
 * Preconditions that must hold BEFORE anything is spawned.
 *
 * Both are refusals rather than degradations. Process groups and `/proc` are the two mechanisms the
 * whole containment rests on; without either, this launcher cannot make the claim it is here to
 * make, and running anyway would produce a report whose containment section is fiction.
 */
export function assertContainmentPreconditions(platform = process.platform, readFile = readFileSync) {
  if (platform !== 'linux') throw new LauncherRefusal(LAUNCHER_CODES.PLATFORM_UNSUPPORTED, [String(platform)]);
  try {
    readFile('/proc/self/stat', 'utf8');
  } catch {
    throw new LauncherRefusal(LAUNCHER_CODES.PROCFS_UNAVAILABLE);
  }
}

// ---- spawn + lifecycle -------------------------------------------------------

/**
 * Run exactly one child and resolve ONCE with a bounded result.
 *
 * Lifecycle contract:
 *   * the `error` listener is attached IMMEDIATELY after spawn, before any await, so a spawn
 *     failure cannot be missed in the gap;
 *   * a spawn failure and a nonzero exit are DIFFERENT results, never collapsed;
 *   * completion waits for `close` (both pipes ended), not `exit` — `exit` can fire while output is
 *     still buffered, and reporting then would truncate the record;
 *   * a single `settled` latch, plus a `terminalStarted` latch taken before the first await on every
 *     terminal path, makes double completion impossible when `error`, `close` and the deadline
 *     interact;
 *   * a timeout can never produce OK, always carries DATABASE OUTCOME UNKNOWN, and runs a bounded
 *     cleanup against the VERIFIED ISOLATED GROUP — see the cleanup handler for why the previous
 *     "detach and report" design was not fail-closed, and why signalling one handle was not either;
 *   * a zero exit is NOT sufficient for OK. `close` establishes that this handle's pipes ended; it
 *     says nothing about a grandchild that closed its inherited stdio and kept running. OK requires
 *     `close` AND an empty managed group AND an empty managed session.
 */
/**
 * The errno LABEL of a failure, or null.
 *
 * A missing Node binary, a missing tsx CLI, a permissions refusal and an fd exhaustion are four
 * different operational problems that otherwise collapse into one indistinguishable code. `ENOENT`
 * carries no path, no argv and no value, so surfacing it discloses nothing — but only after the
 * shape is proved, because `err.code` is an arbitrary property on an arbitrary thrown object and a
 * driver error can put a whole connection string there.
 */
export function errnoCode(err) {
  const code = err === null || typeof err !== 'object' ? undefined : err.code;
  return typeof code === 'string' && /^E[A-Z0-9]{1,15}$/.test(code) ? code : null;
}

/**
 * How long each cleanup stage waits for `close` after a signal.
 *
 * Bounded on purpose: an unbounded wait for a child that will never close turns a fail-closed
 * timeout back into a hang, which is the failure this whole path exists to avoid.
 */
export const CLEANUP_GRACE_MS = 5_000;

/**
 * Did the bounded cleanup actually establish that nothing of the managed tree is left?
 *
 * SIX conjuncts, and every one is load-bearing:
 *   closeObserved    — without `close` the child's own report never finished arriving.
 *   !signalFailed    — a signal this launcher could not deliver is a containment action that did
 *                      not happen, whatever the group looked like afterwards.
 *   groupVerified    — an unverifiable containment must never report as a verified one.
 *   groupEmpty       — dropping this restores the exact claim the previous stage was blocked for:
 *                      "the handle closed, therefore nothing is running".
 *   !handleOnly      — a direct-handle signal reaches the tsx CLI shim; the measured topology puts
 *                      the process owning the database session one level BELOW it, and killing the
 *                      shim demonstrably leaves that grandchild alive and reparented to PID 1. So a
 *                      run that fell back to the handle has contained nothing, whatever the
 *                      surrounding counts say.
 *   !observationLost — an unavailable enumeration produces no members to count, so a predicate
 *                      written only over counts reads "nothing found" as "nothing there".
 *
 * EXTRACTED AND EXPORTED rather than left inline, because a conjunct that cannot be removed without
 * some OTHER conjunct also failing is a conjunct no test can prove is load-bearing. Measured: with
 * the predicate inline, deleting `!handleOnly` changed no test result at all — every handle-only
 * path in the lifecycle also loses `groupVerified` or `observationLost`, so the term was redundant
 * in practice and its red/green verification was vacuous. As a pure function each term can be
 * failed in isolation, which is what makes the guarantee checkable rather than merely asserted.
 */
export function cleanupComplete(cleanup) {
  return (
    cleanup.closeObserved === true &&
    cleanup.signalFailed !== true &&
    cleanup.groupVerified === true &&
    cleanup.groupEmpty === true &&
    cleanup.handleOnly !== true &&
    cleanup.observationLost !== true
  );
}

/**
 * How often the managed group is re-enumerated while waiting for it to drain.
 *
 * Group emptiness has no event: the kernel does not notify a process when some OTHER process's
 * group becomes empty, so the only way to observe it is to look. Polling is bounded by the same
 * grace interval as every other wait, so an undrainable group ends as CLEANUP_INCOMPLETE and never
 * as a hang.
 */
export const GROUP_POLL_MS = 100;

export function runChild({
  spawn = nodeSpawn,
  command = NODE_BIN,
  args,
  env,
  timeoutMs = TIMEOUT_MS,
  limit = OUTPUT_LIMIT_BYTES,
  cleanupGraceMs = CLEANUP_GRACE_MS,
  groupPollMs = GROUP_POLL_MS,
  scan = scanGroup,
  identify = (pid) => readProcIdentity(pid),
  selfIdentity = () => readProcIdentity(process.pid),
  killGroup = (pgid, sig) => {
    process.kill(-pgid, sig);
    return true;
  },
} = {}) {
  return new Promise((settle) => {
    const capture = createCapture(limit);
    let settled = false;
    let timer = null;
    /** The verified isolated group, or null while it is not yet established / could not be. */
    let identity = null;
    /** True once a real child process exists. A fork failure never sets it. */
    let spawned = false;
    /**
     * `close` observed, and the number of child pipes not yet closed.
     *
     * Both are declared HERE rather than with the rest of the lifecycle state below because `done`
     * reads them and `done` is reachable from the synchronous spawn-failure path, which runs before
     * the later block. A `let` read before its declaration is a temporal-dead-zone throw, and that
     * throw would land inside the promise executor — losing the outcome entirely.
     */
    let closed = false;
    let openStreams = 0;
    /**
     * True once an observation the cleanup DEPENDED ON came back unavailable.
     *
     * Tracked separately from `groupEmpty` because the two failures are different and only one of
     * them is visible in a membership count: an unavailable scan has no members to report, so a
     * predicate written only over counts would read "nothing found" as "nothing there". §4 requires
     * observation loss to be its own disqualifier, and this is it.
     */
    let observationLost = false;

    /** Enumerate the managed group, degrading to UNOBSERVED rather than throwing. */
    const observeGroup = () => {
      if (identity === null) return { ...UNOBSERVED };
      try {
        return scan(identity);
      } catch {
        return { ...UNOBSERVED };
      }
    };

    const done = (result) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      // The terminal group observation is taken HERE, so every outcome carries it — a timeout most
      // of all. It is an INDEPENDENT observation of the process table, by PGID and SID, which is the
      // only view that still sees a descendant after reparenting to PID 1.
      //
      // GUARDED, because `done` is reached from inside EventEmitter listeners. `settled` is latched
      // above, so a throw here would leave the promise permanently unresolved — the launcher would
      // hang with no report at all. An unavailable scan is a missing observation, never a reason to
      // lose the outcome.
      const group = observeGroup();
      // The TERMINAL observation counts too. A run whose final scan is unavailable has not shown an
      // empty group; it has shown nothing, and §4 forbids returning terminally on that evidence.
      if (spawned && group.available !== true) observationLost = true;
      // SEALED HERE AND ONLY HERE — the single point at which the terminal stream state is known.
      // A capture that never reaches this line yields nothing from `streamText()`, so no consumer
      // can read a transcript out of a run whose pipes may still be delivering. Computing the
      // predicate once and using it for both the seal and the reported field keeps the gate and the
      // record from ever disagreeing.
      const streamsClosed = openStreams === 0 && closed;
      if (streamsClosed) capture.seal();
      const out = {
        capture,
        group,
        identity,
        spawned,
        closeObserved: closed,
        // EITHER source of the same fact, and the disjunction is deliberate rather than sloppy.
        // Node documents the subprocess `close` event as firing only after the stdio streams have
        // closed, so `closed === true` is itself evidence for this conjunct; the per-stream counter
        // is what makes it observable BEFORE that, during a cleanup wait, and on a harness whose
        // fake child never emits a subprocess `close` at all. Stated plainly: on a real child this
        // BOTH, not either. Node closes the stdio streams BEFORE emitting the subprocess `close`,
        // so on a real child the two coincide — which is exactly why the disjunction this replaces
        // was unfalsifiable: `|| closed` satisfied the conjunct by itself, and no synthetic run ever
        // reached `openStreams === 0`, so a term the hold decision now depends on could not fail.
        // Requiring both makes the counter load-bearing and costs nothing on a real child.
        streamsClosed,
        observationLost,
        ...result,
      };
      // THE HOLD DECISION IS MADE HERE, and here only, because this is the last point at which all
      // the evidence exists.
      //
      // TWO DEFECTS THIS CLOSES, both found by tracing rather than by a failing test:
      //
      //   1. `beginCleanup` decided the hold from the evidence it had at the time. The TERMINAL scan
      //      above happens LATER, so a run whose drain scan succeeded and whose terminal scan came
      //      back unavailable was settled with `containmentHold` false — and the launcher exited
      //      with a managed group it could no longer observe. §4 forbids exactly that: an
      //      observation required for cleanup became unavailable, so the run may not return.
      //
      //   2. Nothing required a child to have EXISTED. A spawn failure that somehow reached a
      //      cleanup path would have held forever over a process that was never created. §4 scopes
      //      the hold to "after a child has spawned", and so does this.
      //
      // The permitted terminal returns are exactly two: a NORMAL COMPLETION, or a cleanup status
      // whose own cleanup completed (the group was proved empty, so there is nothing to hold for).
      // Everything else, for a child that started, holds.
      // ASSIGNED, not OR-ed. An earlier version only ever ADDED a hold, leaving `beginCleanup`'s own
      // unconditional `containmentHold = !complete` able to hold forever over a child that never
      // existed — a fake fork failure that reaches the deadline has `spawned === false` and still
      // entered a cleanup. Deciding it once, here, from the evidence, is what makes the scope claim
      // above true rather than aspirational.
      //
      // Gated on `spawned` ALONE, never on a status label. A previous form exempted `spawn_failed`
      // by name, which would have let a live, group-verified child that emitted an asynchronous
      // `error` exit with a member still in its group — the label said "nothing started", the
      // evidence said otherwise, and the evidence is what governs.
      // The cleanup-completed exemption is re-checked against the TERMINAL observation, not granted
      // on the strength of `cleanup.complete` alone. That flag is FROZEN at the moment the cleanup
      // finished; the scan a few lines above is newer. Without the two extra conjuncts a group that
      // drained and then acquired a member again — or whose final look failed — was exempted by a
      // stale success, and the launcher exited on evidence it no longer had.
      const cleanupSettled =
        CLEANUP_STATUSES.has(out.status) &&
        out.cleanup?.complete === true &&
        out.observationLost !== true &&
        groupIsEmpty(out.group ?? UNOBSERVED);
      out.containmentHold = out.spawned === true && !normalCompletion(out) && !cleanupSettled;
      settle(out);
    };

    /**
     * STRUCTURAL BACKSTOP for the fire-and-forget terminal paths.
     *
     * `beginCleanup` and `finishClosed` are invoked as `void f()` / `f().catch(...)` — nothing
     * awaits them. Every fallible call inside them is individually guarded today, so no live path
     * reaches here; that is precisely the problem it exists for. A discarded rejected promise means
     * `done()` is never called and THIS promise never settles: a silent hang, no report, no
     * DATABASE OUTCOME UNKNOWN line, for a run that may have signalled a child mid-COMMIT. One
     * future unguarded throw is all it would take. `done` latches `settled`, so if the path had
     * already settled before throwing, this is a no-op.
     */
    const onTerminalThrow = () => {
      done({
        status: 'group_unverified',
        code: LAUNCHER_CODES.CLEANUP_INCOMPLETE,
        detail: null,
        pid: child?.pid ?? null,
        exitCode: null,
        signal: null,
        // A terminal path that threw established NOTHING about the managed tree, so this is exactly
        // the state §4 reserves the hold for: the launcher must not exit on it.
        containmentHold: true,
        cleanup: {
          term: 'unknown',
          kill: 'unknown',
          closeObserved: false,
          signalErrno: null,
          reason: 'terminal_path_threw',
          names: null,
          groupVerified: identity !== null,
          groupEmpty: false,
          members: null,
          sessionMembers: null,
          handleOnly: false,
          signalFailed: false,
          observationLost: true,
          complete: false,
          containmentHold: true,
        },
      });
    };

    let child;
    try {
      // `detached: true` is present for EXACTLY one reason: it makes Node call setsid() in the
      // child, so the child becomes leader of a new session and a new process group and every
      // descendant it forks inherits that group. It is NOT a request to outlive this parent — the
      // handle is never released, so the parent keeps waiting on it and keeps owning the pipes for
      // the whole life of the run, including a containment hold. `stdio` stays piped (raw output
      // must never reach a terminal unredacted) and there is no `shell`, so argv remains the frozen
      // array with no interpretation layer.
      child = spawn(command, args, {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: REPO_ROOT,
        detached: true,
        shell: false,
      });
    } catch (err) {
      // The Error's MESSAGE and STACK are discarded unread: Node's spawn Error stringifies the whole
      // argv and its stack names absolute paths. Only `errnoCode` survives — see below.
      done({
        status: 'spawn_failed',
        code: LAUNCHER_CODES.SPAWN_FAILED,
        detail: errnoCode(err),
        pid: null,
        exitCode: null,
        signal: null,
      });
      return;
    }

    // ---- isolated-group identity, established SYNCHRONOUSLY after the fork -----
    //
    // Read IMMEDIATELY, before any listener can run and before the first tick. At this instant the
    // child has been forked, so `/proc/<pid>/stat` exists — and it still exists even if the child
    // has already exited, because a zombie keeps its stat file until it is reaped. Deferring this
    // read to a later tick is precisely what would make a fast, successful child indistinguishable
    // from an unverifiable one, and would turn every quick run into a false containment failure.
    //
    // The dispatch on failure happens at the BOTTOM of this executor, not here: `beginCleanup` is a
    // `const` declared below, so calling it from this point would be a temporal-dead-zone throw.
    let identityProblem = null;
    const spawnedPid = child.pid;
    if (!Number.isInteger(spawnedPid) || spawnedPid <= 1) {
      // Node leaves `pid` UNDEFINED when the fork itself failed. There is then no process to
      // contain, and the asynchronous `error` event is the authoritative report. Calling this a
      // containment failure would mislabel a plain spawn failure as a surviving-process risk — and
      // would send the operator to look for an orphan that was never created.
      identity = null;
    } else {
      spawned = true;
      try {
        identity = assertIsolatedGroup(identify(spawnedPid), selfIdentity());
      } catch (e) {
        identity = null;
        identityProblem = e instanceof LauncherRefusal && e.names.length > 0 ? e.names : ['group_identity_error'];
      }
    }

    // ---- lifecycle state, declared BEFORE any listener that reads it -----------
    let exitCode = null;
    let signal = null;
    let sawExit = false;
    let cleaningUp = false;
    /**
     * Latched by the FIRST terminal path, before its first `await`.
     *
     * `settled` alone is not enough any more: the clean-close path now awaits a bounded group drain
     * before it can settle, and during that await the deadline could fire and start a second
     * terminal path against the same child. This latch closes that window.
     */
    let terminalStarted = false;
    /** An errno observed asynchronously DURING cleanup, folded into the timeout result. */
    let cleanupErrno = null;
    /** Resolvers waiting on `close` during cleanup. Never more than one is outstanding. */
    const closeWaiters = [];

    child.on('error', (err) => {
      // DURING CLEANUP this is not a spawn failure. Node emits `error` on the subprocess when a
      // signal could not be delivered, so after SIGTERM/SIGKILL this event is about the cleanup —
      // and letting it settle as `spawn_failed` would both mislabel it and, far worse, discard the
      // timeout: the record would lose the mandated DATABASE OUTCOME UNKNOWN line for a child that
      // may be mid-COMMIT. The cleanup path owns the settlement; only the errno is kept.
      //
      // `terminalStarted`, `sawExit` and `closed` join `cleaningUp` here because the clean-close
      // path now AWAITS a bounded group drain before it settles. During that await an `error` is by
      // definition not a spawn failure — the child demonstrably ran — and settling as one would
      // discard the completed run and report a fiction.
      if (cleaningUp || terminalStarted || sawExit || closed) {
        cleanupErrno = cleanupErrno ?? errnoCode(err);
        return;
      }
      // Asynchronous spawn failure (ENOENT, EACCES). Same rule as above: code only, never message.
      done({
        status: 'spawn_failed',
        code: LAUNCHER_CODES.SPAWN_FAILED,
        detail: errnoCode(err),
        pid: child.pid ?? null,
        exitCode: null,
        signal: null,
      });
    });

    // A pipe that emits 'error' (EPIPE, ECONNRESET) with NO listener is an uncaught exception: Node
    // prints the error and its stack and kills the process BEFORE renderReport runs. That is the
    // one path by which text could reach the operator's terminal without passing through the
    // redactor, so the listeners exist to close it, not to diagnose the stream.
    for (const [streamName, stream] of [['stdout', child.stdout], ['stderr', child.stderr]]) {
      if (!stream) continue;
      // COUNTED, so "stdout and stderr closed" is an observation rather than an inference from the
      // subprocess `close` event. The two normally coincide — Node documents `close` as firing after
      // the stdio streams have closed — but §4 lists them as separate conjuncts of a normal
      // completion, and a conjunct that is only ever inferred is one that cannot fail independently.
      openStreams += 1;
      stream.on('close', () => {
        if (openStreams > 0) openStreams -= 1;
      });
      // TAGGED WITH ITS OWN PIPE. Both streams still share one byte ceiling — the limit is on what
      // the child may make this process hold, not on either pipe individually — but a parsing
      // consumer reads them apart, so a secret split across the two is never rejoined for it.
      stream.on('data', (c) => capture.push(c, streamName));
      stream.on('error', () => {
        // Same reasoning as the `error` handler above: terminating a child routinely breaks its
        // pipes (EPIPE), so a stream error during cleanup is an EXPECTED consequence of the cleanup
        // and must not replace the outcome that already owns the settlement.
        if (cleaningUp) return;
        // A STREAM FAILURE IS NOT A TERMINAL EVENT FOR THE CHILD. Settling immediately here — which
        // is what this handler used to do — cleared the deadline timer and returned while the child
        // was still running: an uncontrolled orphan holding a session-scoped advisory lock, able to
        // commit AFTER the launcher had already reported and exited, with nothing in the record
        // saying the outcome was unknown. Losing the pipe means losing the evidence, not the child,
        // so it takes the SAME bounded cleanup as a timeout.
        void beginCleanup('stream_failed').catch(onTerminalThrow);
      });
    }

    child.on('exit', (c, s) => {
      sawExit = true;
      exitCode = c;
      signal = s;
    });

    child.on('close', (c, s) => {
      closed = true;
      // `close` carries the exit state too, but `exit` is authoritative when it already fired.
      if (!sawExit) {
        exitCode = c;
        signal = s;
      }
      while (closeWaiters.length > 0) closeWaiters.pop()();
      // During cleanup the CLEANUP path owns the settlement: a close that arrives because the child
      // was signalled is not a clean completion and must never be reported as `status=closed`.
      if (cleaningUp) return;
      // NOT `done(...)` directly. `close` proves THIS handle's pipes ended; it proves nothing about
      // a grandchild that closed its inherited stdio and kept running. The group has to be checked
      // before a clean completion can be claimed, and that check is asynchronous.
      void finishClosed().catch(onTerminalThrow);
    });

    /** Wait a BOUNDED time for `close`. Resolves true if it arrived, false on expiry. */
    const waitForClose = (ms) =>
      new Promise((res) => {
        if (closed) {
          res(true);
          return;
        }
        let fired = false;
        const t = setTimeout(() => {
          if (fired) return;
          fired = true;
          res(false);
        }, ms);
        closeWaiters.push(() => {
          if (fired) return;
          fired = true;
          clearTimeout(t);
          res(true);
        });
      });

    /**
     * Deliver one signal to the VERIFIED ISOLATED GROUP — never to a bare pid, never to a group
     * that has not been re-proved at the moment of delivery.
     *
     * Every refusal below is a case in which signalling would be worse than not signalling:
     *   `no_identity`         the group was never verified, so `-pgid` names an unknown group;
     *   `unsafe_target`       the pgid is <= 1, or equals this launcher's own pid, group or session
     *                         — the four values for which a group signal could come back at us;
     *   `procfs_unavailable`  the group cannot be observed, so its membership cannot be attested;
     *   `identity_mismatch`   the leader pid is occupied by a DIFFERENT incarnation (pgid, sid or
     *                         start time changed) — the pid slot was recycled;
     *   `group_empty`         nothing live is in the group or session. This is the recycling guard
     *                         that matters: the kernel pins a pid while it is still in use as an
     *                         active PGID, so a pgid whose group is non-empty CANNOT have been
     *                         reassigned; once the group empties, that guarantee lapses and the
     *                         pgid becomes reusable by an unrelated process.
     *
     * `kill(2)` is asked for a NEGATIVE pid, which is the group form. It is never called with 0
     * (the caller's own group) and the guard above makes 0 unreachable regardless.
     */
    /** Set when the self-identity recheck could not be performed, so the record can say so. */
    let selfRecheckSkipped = false;
    const signalManagedGroup = (sig) => {
      if (identity === null) return { sent: false, errno: null, reason: 'no_identity', observed: { ...UNOBSERVED } };
      const self = (() => {
        try {
          return selfIdentity();
        } catch {
          // The spawn-time proof in `assertIsolatedGroup` already established disjointness against
          // these exact values, and a process's own pid, pgid and sid cannot change underneath it,
          // so the guarantee stands. What is lost is the REDUNDANT recheck — and losing a check
          // silently is how a report comes to describe a check that did not run.
          selfRecheckSkipped = true;
          return null;
        }
      })();
      const unsafe =
        !Number.isInteger(identity.pgid) ||
        identity.pgid <= 1 ||
        (self !== null && (identity.pgid === self.pid || identity.pgid === self.pgid || identity.sid === self.sid));
      if (unsafe) return { sent: false, errno: null, reason: 'unsafe_target', observed: { ...UNOBSERVED } };

      const observed = observeGroup();
      if (observed.available !== true) {
        observationLost = true;
        return { sent: false, errno: null, reason: 'procfs_unavailable', observed };
      }
      if (observed.leaderIdentityMatches === false) {
        return { sent: false, errno: null, reason: 'identity_mismatch', observed };
      }
      // THE PIN COMES FROM GROUP MEMBERSHIP, NOT SESSION MEMBERSHIP. The kernel keeps a pid number
      // reserved while it is still in use as an active PGID; a process that called `setpgid()` out
      // of the managed group is in the SESSION but no longer in that group, so it neither pins the
      // pgid nor could be reached by `kill(-pgid)`. Signalling on a session-only residual would
      // therefore target a pgid that is free to have been reassigned, in order to reach a process
      // that is not in it — the worst of both. It is reported instead, and `groupEmpty` (which
      // requires BOTH lists empty) keeps the outcome at CLEANUP_INCOMPLETE.
      if (observed.groupMembers.length === 0) {
        const reason = observed.sessionMembers.length > 0 ? 'session_only_residual' : 'group_empty';
        return { sent: false, errno: null, reason, observed };
      }
      try {
        killGroup(identity.pgid, sig);
        return { sent: true, errno: null, reason: null, observed };
      } catch (err) {
        // Same rule as everywhere else: the errno LABEL only, never the message or the stack.
        return { sent: false, errno: errnoCode(err), reason: 'delivery_failed', observed };
      }
    };

    /**
     * Last-resort containment when the GROUP could not be verified or observed. Never a success.
     *
     * REFUSED once the child has exited. Node's open handle is the only thing pinning that pid; once
     * the child has been reaped the number is free, and `child.kill()` degrades into a bare
     * `kill(pid)` against a slot that may already hold a stranger. There is also nothing to contain
     * at that point — the process is gone — so the refusal costs nothing.
     */
    const signalHandleOnly = (sig) => {
      if (sawExit || closed) return { sent: false, errno: null, reason: 'already_exited' };
      try {
        return { sent: child.kill(sig) === true, errno: null };
      } catch (err) {
        return { sent: false, errno: errnoCode(err) };
      }
    };

    /**
     * Poll until the managed group AND session hold no live member, or the budget expires.
     *
     * There is no kernel event for "some other process's group became empty", so observation is the
     * only mechanism. The budget makes an undrainable group end as CLEANUP_INCOMPLETE, never a hang.
     */
    const awaitGroupEmpty = async (budgetMs) => {
      // A MONOTONIC budget, and every sleep clamped to what is left of it. `Date.now()` is wall
      // time and can step backwards, and an unclamped sleep of `groupPollMs` can overshoot the
      // budget outright — either would let a "bounded" wait exceed the bound it advertises.
      const started = process.hrtime.bigint();
      const budgetNs = BigInt(Math.max(0, Math.trunc(budgetMs))) * 1_000_000n;
      const remainingMs = () => Number((budgetNs - (process.hrtime.bigint() - started)) / 1_000_000n);
      // LATCHED AT EVERY OBSERVATION, not merely at the last one.
      //
      // The earlier version checked availability only after the loop, which forgave any number of
      // unavailable polls as long as the FINAL one succeeded — and an unavailable observation is
      // never `groupIsEmpty`, so the loop keeps going and the last look is the one most likely to
      // succeed. The window in which the group could not be seen is exactly the window in which a
      // member could have left it unobserved, so a later good scan does not retire it. Concretely:
      // `scanGroup` degrades the WHOLE observation to unavailable if any single `/proc` entry on the
      // box is unreadable for a non-ENOENT reason, so one transient read failure during the drain
      // would otherwise have bought an OK — the one code that tells an operator nothing is running.
      const look = () => {
        const o = observeGroup();
        if (o.available !== true) observationLost = true;
        return o;
      };
      let observed = look();
      while (!groupIsEmpty(observed) && remainingMs() > 0) {
        const step = Math.max(1, Math.min(groupPollMs, remainingMs()));
        await new Promise((res) => setTimeout(res, step));
        observed = look();
      }
      return { empty: groupIsEmpty(observed), observed };
    };

    /**
     * The CLEAN-COMPLETION path: `close` arrived without any cleanup having been started.
     *
     * `close` is necessary and NOT sufficient. It establishes that this handle's stdout and stderr
     * ended, which a grandchild can bring about simply by closing its inherited descriptors while
     * continuing to run — and continuing to hold a database session. So a clean completion also
     * requires the managed group and the managed session to be empty. When they are not, this is not
     * a completion at all: it hands over to the same bounded cleanup a timeout would take, and the
     * outcome becomes `group_residual`, which carries DATABASE OUTCOME UNKNOWN and can never be OK.
     */
    const finishClosed = async () => {
      if (settled || terminalStarted) return;
      terminalStarted = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      const drained = await awaitGroupEmpty(cleanupGraceMs);
      if (drained.empty && !observationLost) {
        done({
          status: 'closed',
          code: null,
          detail: null,
          pid: child.pid ?? null,
          exitCode,
          signal,
          containmentHold: false,
        });
        return;
      }
      // Hand the terminal path over to cleanup. Releasing the latch is safe: `settled` is still
      // false and this is the only executing path, so nothing else can claim it in between.
      terminalStarted = false;
      await beginCleanup('group_residual');
    };

    /**
     * BOUNDED CLEANUP — entered by a TIMEOUT or by a STREAM FAILURE, never a detach and never a
     * manufactured PASS.
     *
     * BOTH entry reasons leave a child that is still running and an outcome this parent cannot
     * determine, so both take the same path. A stream failure used to settle instantly instead: it
     * cleared the deadline and returned while the child kept running, which is the same orphan the
     * timeout path was rewritten to prevent.
     *
     * WHAT THE PREVIOUS TIMEOUT DESIGN GOT WRONG. It refused to kill on the reasoning that ending a
     * possibly-mid-COMMIT child manufactures a PASS. The refusal was right about PASS and wrong
     * about the child: it released the child handle and reported, which does not stop the child
     * either. The parent then exited while a process holding a session-scoped advisory lock was
     * still running against the managed database, unobserved, with the operator told only
     * `status=timeout` — an orphan the launcher had neither ended nor accounted for. Reporting is
     * not containment, and neither is an accurate label on an abandoned process: when the evidence
     * is incomplete this path now hands over to a REFERENCED CONTAINMENT HOLD instead of exiting.
     *
     * WHAT THIS DOES INSTEAD. Terminating the child does not decide the transaction's fate, and this
     * path never claims it does: the outcome is TIMEOUT (or CLEANUP_INCOMPLETE), the record always
     * carries DATABASE OUTCOME UNKNOWN, and nothing is retried, reconnected or compensated. The kill
     * exists solely to prevent an uncontrolled orphan — that is a containment action, and it is kept
     * strictly separate from the reported outcome, which stays unknown either way.
     *
     * Cleanup targets the VERIFIED ISOLATED GROUP and nothing else. `signalManagedGroup` re-proves
     * the group at the moment of delivery and refuses on every shape that could reach a process this
     * launcher did not start. When the group could never be verified, only the direct handle can be
     * signalled — and that result is FORCED to CLEANUP_INCOMPLETE rather than dressed up as success,
     * because containing one handle is exactly the mechanism this stage exists to stop trusting.
     *
     * WHAT "COMPLETE" MEANS HERE, AND WHAT IT DELIBERATELY DOES NOT. Complete requires all of:
     * `close` observed, no signal-delivery failure, the group verified, and the managed group AND
     * session observed EMPTY. It does NOT mean the transaction was resolved. Ending a child says
     * nothing about whether its COMMIT landed, and no branch here claims otherwise: the outcome stays
     * a cleanup status, the record always carries DATABASE OUTCOME UNKNOWN, and nothing is retried,
     * reconnected or compensated. Nor is any driver-side `end()`/`dispose()` result treated as an
     * observed graceful socket close — this parent never observes that, and asserts it nowhere.
     */
    const beginCleanup = async (status, names = null) => {
      if (settled || terminalStarted) return;
      terminalStarted = true;
      cleaningUp = true;
      // Disarm the deadline HERE, symmetrically with `finishClosed`. Cleanup can run for several
      // grace intervals; leaving the original timer armed meant a stream-failure cleanup could be
      // re-entered by its own deadline. The latch above absorbs that call harmlessly, but a timer
      // that fires for a run already ending is a handle held for no reason and a second entry that
      // has to be reasoned about at every future edit.
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      const groupPath = identity !== null;
      const cleanup = {
        term: 'not_attempted',
        kill: 'not_attempted',
        closeObserved: closed,
        signalErrno: null,
        reason: null,
        names,
        groupVerified: groupPath,
        groupEmpty: false,
        members: null,
        sessionMembers: null,
        /**
         * True once any signal went to the DIRECT HANDLE instead of the group.
         *
         * Recorded so the report can say it in words. A handle-only signal is best-effort damage
         * reduction against ONE process; the measured tsx topology puts the database-owning process
         * one level below that, so it is never containment, never closes CLEANUP_INCOMPLETE, and
         * never supports a claim that no descendant remains.
         */
        handleOnly: false,
      };

      const send = (sig) => {
        if (groupPath) {
          const r = signalManagedGroup(sig);
          cleanup.reason = cleanup.reason ?? r.reason;
          if (r.sent || r.reason !== 'procfs_unavailable') return r;
          // THE GROUP CANNOT BE OBSERVED, so it cannot be safely signalled: an unobservable pgid may
          // since have been reassigned, and `kill(-pgid)` would then reach a stranger. The DIRECT
          // HANDLE is still exact and still safe — Node holds the child, so the kernel cannot recycle
          // its pid while this handle is open. Contain what can provably be contained, and let the
          // outcome carry the shortfall: `groupVerified && groupEmpty` still fails below, so this
          // branch can never read as a successful containment.
          const h = signalHandleOnly(sig);
          cleanup.handleOnly = true;
          return { ...h, reason: 'group_unobservable_handle_only' };
        }
        const r = signalHandleOnly(sig);
        cleanup.handleOnly = true;
        cleanup.reason = cleanup.reason ?? 'group_unverified_handle_only';
        return r;
      };
      const noGroup = () => ({ empty: false, observed: { ...UNOBSERVED } });

      // STAGE 1 — SIGTERM to the group. A group that is ALREADY empty is not signalled: its pgid is
      // free to be reused the instant the last member leaves, so signalling it is the one way this
      // cleanup could reach a stranger.
      const early = groupPath ? await awaitGroupEmpty(0) : noGroup();
      if (early.empty && closed) {
        cleanup.term = 'not_required';
      } else {
        const term = send('SIGTERM');
        cleanup.signalErrno = term.errno;
        cleanup.term = term.sent ? 'sent' : term.reason === 'group_empty' ? 'not_required' : 'delivery_failed';
        // Output keeps DRAINING throughout: the `data` listeners are untouched and `close` is what
        // ends the wait, so a final line flushed while terminating is still captured and redacted.
        //
        // `not_required` waits too. A group that is ALREADY empty while `close` has not yet arrived
        // is the ordinary "child exited, pipe still draining" race — the evidence is seconds away,
        // and refusing to wait for it would report CLEANUP_INCOMPLETE for a run that terminated
        // perfectly well.
        if (term.sent || cleanup.term === 'not_required') {
          cleanup.closeObserved = (await waitForClose(cleanupGraceMs)) || cleanup.closeObserved;
        }
      }

      // STAGE 2 — escalate to SIGKILL only while a member is still OBSERVED, and only to prevent an
      // uncontrolled orphan. Never to manufacture a PASS: no branch below can produce OK.
      let drained = groupPath ? await awaitGroupEmpty(cleanupGraceMs) : noGroup();
      if (!drained.empty) {
        if (groupPath && drained.observed.available === true && drained.observed.leaderIdentityMatches === false) {
          // The leader pid slot holds a DIFFERENT incarnation. Escalating would signal a stranger,
          // so the residual is reported instead of acted on.
          cleanup.kill = 'refused_identity_mismatch';
        } else {
          const kill = send('SIGKILL');
          cleanup.signalErrno = cleanup.signalErrno ?? kill.errno;
          cleanup.kill = kill.sent ? 'sent' : kill.reason === 'group_empty' ? 'not_required' : 'delivery_failed';
          if (kill.sent) {
            cleanup.closeObserved = (await waitForClose(cleanupGraceMs)) || cleanup.closeObserved;
            if (groupPath) drained = await awaitGroupEmpty(cleanupGraceMs);
          }
        }
      }
      cleanup.groupEmpty = drained.empty;
      cleanup.members = Array.isArray(drained.observed.groupMembers) ? drained.observed.groupMembers.length : null;
      cleanup.sessionMembers = Array.isArray(drained.observed.sessionMembers)
        ? drained.observed.sessionMembers.length
        : null;

      // An errno that arrived ASYNCHRONOUSLY on the child's `error` event is a signal-delivery
      // failure too: a kill can be accepted and Node then report the undeliverable signal
      // separately. Treating only the synchronous throw would let that half pass as a clean cleanup.
      if (cleanupErrno !== null) {
        cleanup.signalErrno = cleanup.signalErrno ?? cleanupErrno;
        if (cleanup.kill === 'sent') cleanup.kill = 'delivery_failed';
        else if (cleanup.term === 'sent') cleanup.term = 'delivery_failed';
      }
      cleanup.signalFailed = cleanup.term === 'delivery_failed' || cleanup.kill === 'delivery_failed';
      cleanup.observationLost = observationLost;
      const complete = cleanupComplete(cleanup);
      // RECORDED on the transcript, so the operator-facing classification in `renderReport` is
      // derived from the same four conjuncts as the outcome code instead of recomputing a subset of
      // them. The earlier report line omitted `signalFailed`, and could therefore print
      // "VERIFIED TERMINAL CLEANUP" on a run whose outcome was CLEANUP_INCOMPLETE.
      cleanup.complete = complete;
      if (selfRecheckSkipped) cleanup.selfRecheckSkipped = true;
      // THE HANDLE IS NOT RELEASED HERE, AND NOTHING ELSE IS DONE TO LET THIS PROCESS EXIT.
      //
      // The previous stage released the child handle and both pipes on this branch, reasoning that
      // an open pipe would otherwise hold the launcher open past its own reported deadline "with no
      // stated reason". The outcome code it emitted was accurate — CLEANUP_INCOMPLETE, never OK —
      // and the behaviour was still abandonment: a descendant that survived SIGTERM and SIGKILL, or
      // one whose group could no longer be enumerated, kept running against the managed database
      // with nothing supervising it. An accurate label on an abandoned process is a better record,
      // not a contained process.
      //
      // So the reason is now stated instead of the handle being dropped. `containmentHold` travels
      // out with the result, `main()` emits ONE bounded code naming the state, and the launcher
      // holds a REFERENCED supervisor rather than exiting. Nothing here calls `process.exit`, and
      // nothing destroys a supervision pipe to bring about the same effect by another route.
      cleanup.containmentHold = !complete;
      done({
        status,
        containmentHold: !complete,
        code: complete ? (CLEANUP_BASE_CODES[status] ?? LAUNCHER_CODES.CLEANUP_INCOMPLETE) : LAUNCHER_CODES.CLEANUP_INCOMPLETE,
        detail: cleanup.signalErrno,
        pid: child.pid ?? null,
        // Reported ONLY when `close` was actually observed. A fabricated exit code for a child whose
        // termination was never confirmed is precisely the tidy-looking lie this stage removes.
        exitCode: cleanup.closeObserved ? exitCode : null,
        signal: cleanup.closeObserved ? signal : null,
        cleanup,
      });
    };

    if (identityProblem !== null) {
      // The child is RUNNING and its containment could NOT be proved. Contain what can be contained,
      // and say so out loud. The deadline is deliberately not armed: proceeding for two minutes as
      // though the group were known is the opposite of a pre-execution refusal.
      void beginCleanup('group_unverified', identityProblem).catch(onTerminalThrow);
      return;
    }

    timer = setTimeout(() => {
      void beginCleanup('timeout').catch(onTerminalThrow);
    }, timeoutMs);
  });
}

/** Turn a bounded result into the operator record. Redacted text only, codes only, no stacks. */
export function renderReport(result, redact, disposition = dispositionFor(result)) {
  const lines = [];
  lines.push(`[baseline-launcher] status=${result.status}${result.detail ? ` errno=${result.detail}` : ''}`);
  if (result.status === 'closed') {
    lines.push(`[baseline-launcher] exitCode=${result.exitCode ?? 'none'} signal=${result.signal ?? 'none'}`);
    // STATED IMMEDIATELY BESIDE THE TWO FIELDS THAT CANNOT ESTABLISH IT. `exitCode=0 signal=none` is
    // exactly what a child destroyed by realtime signal 34, 40 or 64 reports, so the line above is
    // not evidence of completion and must not be read as any. This one is the positive evidence, or
    // the named reason there is none.
    lines.push(
      `[baseline-launcher] terminalEvidence=${disposition.terminal.ok ? 'complete' : 'incomplete'} `
        + `reason=${terminalReasonText(disposition.terminal.reason)}`,
    );
  }
  // The MANAGED GROUP identity, on every outcome. Without it an operator reading a cleanup
  // transcript has no way to tell which group was signalled, or whether one was verified at all.
  const id = result.identity ?? null;
  lines.push(
    `[baseline-launcher] managedGroup ${
      id === null ? 'verified=false' : `verified=true pid=${id.pid} pgid=${id.pgid} sid=${id.sid}`
    }`,
  );

  // A HELD RUN COUNTS AS CLEANED-UP FOR REPORTING, whatever its status says.
  //
  // Keying these lines on the status alone was correct only while a hold implied a cleanup status.
  // It no longer does: a child can close cleanly and the TERMINAL observation still be lost, which
  // holds under a `closed` status. Without this clause that record ended on the child's own
  // `commit=committed` line, with no DATABASE OUTCOME UNKNOWN and no UNVERIFIED label — reopening
  // the exact defect the ordering rule at the bottom of this function exists to prevent.
  const cleanedUp = CLEANUP_STATUSES.has(result.status) || result.containmentHold === true;
  if (cleanedUp) {
    const c = result.cleanup ?? { term: 'unknown', kill: 'unknown', closeObserved: false };
    // The cleanup TRANSCRIPT, not a verdict. Which signals were delivered, whether `close` was
    // observed, and whether the GROUP and SESSION actually emptied is what an operator needs to
    // judge the residual risk; it is deliberately not summed into a single reassuring word.
    lines.push(
      `[baseline-launcher] cleanup sigterm=${c.term} sigkill=${c.kill} closeObserved=${c.closeObserved} ` +
        `exitCode=${result.exitCode ?? 'unobserved'} signal=${result.signal ?? 'unobserved'}`,
    );
    lines.push(
      `[baseline-launcher] cleanup groupVerified=${c.groupVerified ?? 'unknown'} ` +
        `groupEmpty=${c.groupEmpty ?? 'unknown'} residualGroupMembers=${c.members ?? 'unknown'} ` +
        `residualSessionMembers=${c.sessionMembers ?? 'unknown'}` +
        `${c.reason ? ` reason=${c.reason}` : ''}${c.names ? ` names=${c.names.join(',')}` : ''}`,
    );
    // STATED IN WORDS, on its own line, because the distinction is the whole point of this stage.
    // A direct-handle signal reaches the tsx CLI shim; the measured topology puts the process that
    // owns the database session one level BELOW that, and killing the shim demonstrably leaves the
    // grandchild running and reparented to PID 1. So the fallback is recorded as what it is.
    lines.push(
      `[baseline-launcher] handleOnlySignal=${c.handleOnly === true} signalFailed=${c.signalFailed === true} ` +
        `observationLost=${c.observationLost === true} — a direct-handle signal is BEST-EFFORT DAMAGE ` +
        'REDUCTION ONLY, is NEVER credited as group containment, and never closes CLEANUP INCOMPLETE',
    );
  }

  // The THREE-WAY containment classification, kept deliberately separate from the database outcome.
  //   VERIFIED TERMINAL CLEANUP  close received, streams closed, isolated group AND session empty.
  //   CLEANUP INCOMPLETE         any required termination evidence is missing.
  //   CONTAINMENT HOLD           the launcher is still holding supervision; nothing is contained,
  //                              nothing was abandoned, and an operator has to act.
  // None of the three says anything about the transaction; that stays on its own mandated line.
  const g = result.group ?? UNOBSERVED;
  // Derived from the SAME predicate as the outcome code — `normalCompletion` — rather than from a
  // subset recomputed here. The previous stage recomputed a subset and could print VERIFIED on a run
  // whose outcome code was CLEANUP_INCOMPLETE. A cleanup path reports verified only when
  // `beginCleanup` itself concluded `complete`, which already folds in signal-delivery failure,
  // handle-only fallback and observation loss.
  const terminalVerified =
    normalCompletion(result) || (id !== null && groupIsEmpty(g) && result.cleanup?.complete === true);
  const held = result.containmentHold === true;
  lines.push(
    `[baseline-launcher] containment=${
      held
        ? 'CONTAINMENT HOLD — NOT CONTAINED, SUPERVISION RETAINED'
        : terminalVerified
          ? 'VERIFIED TERMINAL CLEANUP'
          : 'CLEANUP INCOMPLETE'
    } ` +
      `groupObserved=${g.available} residualGroupMembers=${g.groupMembers === null ? 'unknown' : g.groupMembers.length} ` +
      `residualSessionMembers=${g.sessionMembers === null ? 'unknown' : g.sessionMembers.length}`,
  );
  // SCOPED, not universal. Group/session containment is closed FOR THE MEASURED TSX TOPOLOGY and only
  // when a verified terminal cleanup passes; a descendant that successfully calls setsid() leaves
  // both the managed group and the managed session and is not observable here, and the scan that
  // precedes a group signal is not atomic with it. Both remain open at low severity and are named
  // rather than absorbed into the word "closed".
  lines.push(
    '[baseline-launcher] containment scope: PGID/SID observation covers descendants that REMAIN in the ' +
      'managed group or session; a descendant that calls setsid() escapes both (OPEN/LOW), and ' +
      'scan-to-signal is not atomic (OPEN/LOW)',
  );
  // STATED, not implied. The launcher observes PROCESS termination; it does not and cannot observe
  // the managed database socket being closed gracefully, and a driver's own end()/dispose() result
  // is not that evidence. Leaving this unsaid is how "the group is empty" quietly becomes "the
  // connection was shut down cleanly", which is a different and unproven claim.
  lines.push(
    '[baseline-launcher] graceful database-socket close observability: NOT OBSERVED by this launcher (OPEN/LOW)',
  );

  if (result.capture.overflowed) {
    lines.push(`[baseline-launcher] ${LAUNCHER_CODES.OUTPUT_LIMIT_EXCEEDED} — captured output was discarded unread`);
  } else {
    // THE CHILD'S TRANSCRIPT IS RE-RENDERED, NEVER FORWARDED.
    //
    // This line read `redact(result.capture.text())` and pushed the result as its own array element.
    // Three separate defects sat in that one expression. `text()` is the ARRIVAL-ORDERED INTERLEAVE
    // of both pipes, so a secret split across stdout and stderr became contiguous in the buffer the
    // operator was shown. `text()` is not gated on the seal, so a capture whose closure was never
    // proved could still be printed. And redaction was the ONLY barrier: the migration child's
    // `REFUSED:`, `ERROR:` and `FATAL:` lines interpolate raw messages, so a driver string or an
    // Error reached the record whenever it happened not to contain a configured secret.
    //
    // The two streams are now read APART, only after `runChild` has sealed them, and every line is
    // rebuilt from a closed grammar or discarded and counted. The unbounded surfaces in that child
    // live in a frozen path and cannot be fixed at the source from here — but nothing obliges this
    // launcher to repeat them, and it no longer does.
    const rendered = renderMigrateTranscript(
      result.capture?.streamText?.('stdout'),
      result.capture?.streamText?.('stderr'),
      result.streamsClosed === true,
    );
    if (cleanedUp) lines.push('[baseline-launcher] --- captured child output (UNVERIFIED, may be incomplete) ---');
    for (const line of rendered) lines.push(line);
  }

  // MANDATORY, and LAST. Placed after the captured body on purpose: whatever the child claimed
  // about its own transaction, the final words in the record are that the outcome is unknown. The
  // earlier ordering put these lines above the capture, so a child's `committed` was the last thing
  // an operator read.
  if (cleanedUp) {
    lines.push(`[baseline-launcher] ${DATABASE_OUTCOME_UNKNOWN}`);
    lines.push(
      '[baseline-launcher] the baseline is NOT reported as committed and NOT reported as rolled back; ' +
        'any commit claim in the captured output above is the CHILD\'s and is UNVERIFIED',
    );
  }
  return lines.join('\n');
}

/**
 * THE NORMAL-COMPLETION PREDICATE — the complete list of conjuncts under which this launcher is
 * permitted to return a terminal result for a child that actually started.
 *
 * Written once, exported, and consumed by BOTH `outcomeCode` and `renderReport`, so the operator's
 * containment line and the machine-readable outcome cannot disagree about what was established. The
 * previous stage recomputed a subset in the renderer and printed "VERIFIED TERMINAL CLEANUP" on a
 * run whose outcome code was CLEANUP_INCOMPLETE.
 *
 * Every conjunct, and the failure each one alone would let through:
 *   spawned              — a fork failure has no managed tree at all; "no residual" is vacuous there
 *                          and must not be dressed up as containment.
 *   status === 'closed'  — a cleanup status is a run whose child was signalled; it is never normal.
 *   identity !== null    — an unverified group means `-pgid` named nothing provable, so no scan of
 *                          it means anything either.
 *   closeObserved        — without `close`, the child's own report never finished arriving.
 *   streamsClosed        — stdout and stderr both ended; a still-open pipe means output is in flight
 *                          and the captured record is not yet whole.
 *   group + session empty — via `groupIsEmpty`, which itself requires `available === true`. This is
 *                          the conjunct that survives reparenting: the descendant a ppid scan loses
 *                          the instant it is orphaned is still counted here.
 *   !observationLost     — an enumeration that came back unavailable at ANY point cleanup depended
 *                          on it. Unavailable produces zero members, so a count-only predicate reads
 *                          "nothing found" as "nothing there" — the exact substitution this rules out.
 *   !signalFailed        — a signal this launcher could not deliver is a containment action that did
 *                          not happen, whatever the group looked like afterwards.
 */
export function normalCompletion(result) {
  return (
    result.spawned === true &&
    result.status === 'closed' &&
    result.identity !== null &&
    result.identity !== undefined &&
    result.closeObserved === true &&
    result.streamsClosed === true &&
    groupIsEmpty(result.group ?? UNOBSERVED) &&
    result.observationLost !== true &&
    result.cleanup?.signalFailed !== true &&
    // CONSISTENT WITH `cleanupComplete`, which already disqualifies a handle-only fallback. Omitting
    // it here left the two exported predicates disagreeing: a result carrying a handle-only cleanup
    // transcript under a non-cleanup status would have passed this one. No lifecycle path produces
    // that shape today — which is precisely why the inconsistency would have survived unnoticed.
    result.cleanup?.handleOnly !== true
  );
}

/** The outcome code for a completed run — derived, never assumed. */
export function outcomeCode(result) {
  if (result.status === 'spawn_failed') return LAUNCHER_CODES.SPAWN_FAILED;
  // A cleaned-up outcome carries its OWN code so an incomplete cleanup is never flattened into a
  // plain timeout or stream failure. No value here can be OK: there is no path from a cleanup
  // status to a pass.
  if (CLEANUP_STATUSES.has(result.status)) {
    const code = result.code ?? CLEANUP_BASE_CODES[result.status] ?? LAUNCHER_CODES.CLEANUP_INCOMPLETE;
    // STRUCTURALLY incapable of returning OK, rather than incapable by inspection of the producer.
    // `result.code` is set by `beginCleanup` and never to OK today; asserting it here means a future
    // producer cannot make a cleanup status pass, which is the property the comment above claims.
    return code === LAUNCHER_CODES.OK ? LAUNCHER_CODES.CLEANUP_INCOMPLETE : code;
  }
  if (result.capture.overflowed) return LAUNCHER_CODES.OUTPUT_LIMIT_EXCEEDED;
  if (result.signal) return LAUNCHER_CODES.CHILD_SIGNALLED;
  if (result.exitCode !== 0) return LAUNCHER_CODES.CHILD_NONZERO_EXIT;
  // DEFENCE IN DEPTH, deliberately duplicating the lifecycle gate. `finishClosed` already refuses to
  // report `status=closed` while a group or session member is alive, so these two branches should be
  // unreachable — and that is exactly why they are here. OK is the single value in this file that
  // authorises the operator to believe nothing is still running; it must not be derivable from the
  // exit code alone at ANY point in the code, including a future edit that changes the lifecycle.
  //
  // An UNOBSERVABLE group fails this test too. "The process table could not be read" is missing
  // termination evidence, not evidence of termination.
  // THE HOLD IS REPORTED FIRST, above the more specific shortfalls below.
  //
  // Ordered the other way round, this branch was dead: every run that holds also fails one of the
  // group checks, so the machine-readable outcome would have said `managed_group_residual` and the
  // hold would have appeared only in prose. The state an operator has to act on is that this
  // process is still supervising; which conjunct was missing is on the transcript lines.
  if (result.containmentHold === true) return LAUNCHER_CODES.CONTAINMENT_HOLD;
  if (result.identity === null || result.identity === undefined) return LAUNCHER_CODES.GROUP_UNVERIFIED;
  if (!groupIsEmpty(result.group ?? UNOBSERVED)) return LAUNCHER_CODES.GROUP_RESIDUAL;
  // THE SINGLE GATE ON OK. Every conjunct of a normal completion, checked in one place, rather than
  // the exit code plus whichever subset a future edit remembers to keep. The branches above remain
  // as defence in depth: they name the specific shortfall an operator would otherwise have to infer
  // from a bare CLEANUP_INCOMPLETE.
  if (!normalCompletion(result)) return LAUNCHER_CODES.CLEANUP_INCOMPLETE;
  return LAUNCHER_CODES.OK;
}

/** The child tag whose POST-CLEANUP terminal record this launcher requires. */
export const MIGRATE_TAG = 'migrate';

/**
 * The terminal completion evidence for a run, computed from the SEALED stdout capture only.
 *
 * stdout and NOT the interleave: the child's `REFUSED:` and `FATAL:` lines go to stderr and are the
 * only writes that can follow the teardown record, so reading the merged buffer would make a
 * legitimate refusal look like output arriving after the cleanup boundary.
 */
export function terminalEvidenceFor(result) {
  // `?.()` GUARDS NULL, NOT TYPE. A capture whose `streamText` exists but is not callable made this
  // THROW rather than refuse — and a throw is not a refusal: in this launcher the disposition is
  // computed before the reporting try, so an exception here would have skipped the containment hold
  // entirely. A malformed capture is now the same fail-closed answer as an absent one.
  // EVERY ACCESS IS INSIDE THE GUARD, not just the call.
  //
  // Three separate ways this could raise, and the first two sat OUTSIDE an earlier version of this
  // try: `?.` guards a null `capture` but not a THROWING GETTER for `capture` or for `streamText`,
  // and the `streamsClosed` read happened after the guarded region entirely. A reader that cannot be
  // reached, a reader that raises when invoked, and a flag that raises when read are all the same
  // fact — the stream could not be read — and an exception is not a refusal, so all three must
  // produce the identical fail-closed answer instead of escaping into the caller.
  // THE SEAL IS READ FIRST, deliberately. Both reads are guarded, but order decides which reason a
  // failure carries: reading the text first meant a throwing reader also left `closed` false, so the
  // refusal came back as `streams_not_proved_closed` — true, but naming the wrong cause. Read the
  // cheap independent flag first and each failure reports the fact that actually failed.
  let text;
  let closed = false;
  try {
    closed = result?.streamsClosed === true;
    // NO SEPARATE CALLABILITY GUARD. A `typeof read === 'function'` test stood here and was proven
    // REDUNDANT by mutation: dropping it changed no outcome, because a non-callable reader raises
    // and the catch below already turns that into the same refusal. Two expressions of one
    // requirement mask each other — which is the exact defect this stage removed twice elsewhere —
    // so the requirement is stated once, where a mutation to it actually changes an answer.
    text = result.capture.streamText.call(result.capture, 'stdout');
  } catch {
    text = undefined;
  }
  return MIGRATE_GRAMMAR.labelledTerminal(text, MIGRATE_TAG, closed);
}

/**
 * THE ONE DISPOSITION, used by the printed record AND by the process exit code.
 *
 * Two expressions of one requirement mask each other: a mutation could drop the terminal conjunct
 * from the exit code while the record still reported it, producing a run that PRINTS
 * `terminal_evidence_incomplete` and exits 0. Deriving both from one function removes the
 * possibility rather than testing for it twice.
 *
 * An OVERFLOWED capture never reaches the terminal check as a pass: `outcomeCode` returns
 * `OUTPUT_LIMIT_EXCEEDED` before this, so `derived` is not OK and the record is not consulted for a
 * verdict it could not support — the bytes it would have been read from were discarded unread.
 */
export function dispositionFor(result) {
  const terminal = terminalEvidenceFor(result);
  const derived = outcomeCode(result);
  const code = derived === LAUNCHER_CODES.OK && !terminal.ok
    ? LAUNCHER_CODES.TERMINAL_EVIDENCE_INCOMPLETE
    : derived;
  return Object.freeze({ terminal, code, exitCode: code === LAUNCHER_CODES.OK ? 0 : 1 });
}

// ---- entry point -------------------------------------------------------------

/**
 * `deps` exists ONLY so the deterministic suite can inspect the exact spawn program, argv, cwd,
 * stdio and environment without a real process, and can drive the lifecycle paths. Every default is
 * the real implementation, and the entry guard below calls `main()` with no arguments at all — so
 * nothing an operator can type reaches any of these seams.
 *
 * `enterHold` is the most important of them: the live hold never exits, so the deterministic suite
 * MUST be able to substitute it. A suite that entered the real hold would hang, and a suite that
 * "fixed" the hang by letting the launcher exit would be testing the abandonment this stage removed.
 */
export async function main(argv = process.argv.slice(2), source = process.env, deps = {}) {
  const out = deps.out ?? ((line) => console.log(line));
  const err = deps.err ?? ((line) => console.error(line));
  // No caller-supplied flags. Exactly one literal argument, and nothing else is tolerated: an
  // ignored extra argument is how a launcher grows an escape hatch.
  if (argv.length !== 1 || argv[0] !== '--execute') {
    err(`[baseline-launcher] REFUSED: ${LAUNCHER_CODES.BAD_INVOCATION}`);
    return 2;
  }
  let env;
  let redact;
  try {
    // BEFORE anything is spawned. Process groups and a readable `/proc` are the two mechanisms the
    // entire containment rests on; without either, the containment section of the report would be a
    // claim this launcher cannot support, so it refuses instead of running and asserting it anyway.
    if (deps.assertContainment) deps.assertContainment();
    else assertContainmentPreconditions();
    assertStartupSensitiveAbsent(deps.readExecEnv ? deps.readExecEnv() : readExecEnvironment());
    env = buildChildEnv(source);
    // Built INSIDE the guarded block: an unparsable DSN refuses here rather than producing a
    // silently incomplete redactor that would then be trusted for the whole run.
    redact = buildRedactor(secretValuesFrom(env));
  } catch (e) {
    const code = e instanceof LauncherRefusal ? e.code : LAUNCHER_CODES.BAD_INVOCATION;
    const names = e instanceof LauncherRefusal ? e.names : [];
    err(`[baseline-launcher] REFUSED: ${code}${names.length > 0 ? ` names=${names.join(',')}` : ''}`);
    return 2;
  }

  // FROZEN, and assembled here from constants only. There is no expression in this array that any
  // caller argument, environment value or configuration key can influence.
  const args = Object.freeze([TSX_CLI, MIGRATE_SCRIPT, ...BASELINE_FLAGS]);
  const result = await runChild({
    args,
    env,
    ...(deps.spawn ? { spawn: deps.spawn } : {}),
    ...(deps.scan ? { scan: deps.scan } : {}),
    ...(deps.identify ? { identify: deps.identify } : {}),
    ...(deps.selfIdentity ? { selfIdentity: deps.selfIdentity } : {}),
    ...(deps.killGroup ? { killGroup: deps.killGroup } : {}),
    ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
    ...(deps.cleanupGraceMs !== undefined ? { cleanupGraceMs: deps.cleanupGraceMs } : {}),
    ...(deps.groupPollMs !== undefined ? { groupPollMs: deps.groupPollMs } : {}),
  });

  // THE REPORTING IS WRAPPED so the hold cannot be skipped by a failure while writing the record.
  //
  // Reporting runs first on purpose — the operator should have the whole transcript before this
  // process stops making progress — but "first" must not mean "and only if it succeeds". If
  // `renderReport`, the redactor or the output sink throws, `main()` rejects, the entry guard prints
  // its bounded failure line, and WITHOUT this `finally` no supervisor would ever be installed: for
  // a residual-descendant run the pipes are already closed, so the launcher would exit and abandon
  // exactly the process the hold exists for.
  // ONE CALL. The record, the printed outcome and the process exit code are three consumers of a
  // single `dispositionFor` result, so `terminal_evidence_incomplete` cannot coexist with exit 0.
  let disposition = Object.freeze({
    terminal: Object.freeze({ ok: false, reason: 'not_computed', code: null }),
    code: LAUNCHER_CODES.CLEANUP_INCOMPLETE,
    exitCode: 1,
  });
  try {
    disposition = dispositionFor(result);
    out(renderReport(result, redact, disposition));
    out(`[baseline-launcher] outcome=${disposition.code}`);

    // The terminal GROUP scan, by PGID and SID. This replaces the previous ppid-descendant line,
    // which could not have detected the failure it was presented as evidence against: a descendant
    // whose parent has been killed is reparented to PID 1, so it stops being a ppid-descendant at
    // exactly the moment it becomes an orphan. Its PGID and SID do not change.
    const g = result.group ?? UNOBSERVED;
    out(
      `[baseline-launcher] groupScan available=${g.available} leaderPresent=${g.pidPresent ?? 'unknown'} ` +
        `leaderIdentityMatches=${g.leaderIdentityMatches ?? 'unknown'} ` +
        `groupMembers=${g.groupMembers === null ? 'unknown' : g.groupMembers.length} ` +
        `sessionMembers=${g.sessionMembers === null ? 'unknown' : g.sessionMembers.length}`,
    );
  } finally {
    enterHoldIfRequired(result, out, redact, deps);
  }
  return disposition.exitCode;
}

/**
 * Install the hold when the result demands it. Extracted so `main()` can run it from a `finally`.
 *
 * Entered LAST — after the record is complete, so the operator has the full transcript before the
 * process stops making progress. From here the launcher does not exit: the interval inside
 * `enterContainmentHold` is referenced, so the event loop stays alive with the child handle and both
 * pipes still held. `process.exitCode` is set by the entry guard and will be honoured only if an
 * operator ends this process, which is the intended way out of the hold.
 *
 * Exactly ONE further line is emitted (the hold code itself); the periodic re-observation prints
 * nothing. Nothing is retried, reconnected or compensated, and no branch here can produce OK.
 */
export function enterHoldIfRequired(result, out, redact, deps = {}) {
  if (result.containmentHold === true) {
    const hold = deps.enterHold ?? enterContainmentHold;
    hold({
      // REDACTED like every other sink, even though today's message is a frozen literal with no
      // interpolation. The redactor is applied at the call site everywhere else in this file; an
      // exception here would mean a future edit that interpolates any observed state into the hold
      // message bypasses redaction by construction, and would do so silently.
      emit: (line) => out(redact(line)),
      observe: () => (result.identity === null || result.identity === undefined ? null : scanGroup(result.identity)),
      ...(deps.holdPollMs !== undefined ? { pollMs: deps.holdPollMs } : {}),
    });
  }
}

/**
 * THE CANONICAL CHILD TRANSCRIPT — generic machinery.
 *
 * WHY IT IS TABLE-DRIVEN. Redaction cannot make a child transcript safe: a redactor is a function of
 * the credential, so every byte it touches varies with the credential. Splicing a marker into a
 * published template leaks the matched span by differencing; replacing the whole line turns it into
 * a line-presence oracle. The only safe transcript is one the launcher REBUILDS from its own
 * constants, discarding whatever it cannot rebuild.
 *
 * The rebuilding rules are identical for every child. The VOCABULARY is not, and one child's
 * vocabulary must not leak into a launcher that is forbidden to name it — this file may not name the
 * single-purpose migration at all. So the rules live here and each launcher supplies its own tables.
 */

/** Hard ceilings on OUTPUT LENGTH. What bounds the INPUT is `OUTPUT_LIMIT_BYTES`, upstream. */
export const MAX_TRANSCRIPT_LINES = 400;
export const MAX_LINE_ITEMS = 32;
export const MAX_ITEM_SEGMENTS = 16;

const TAGGED_LINE = /^\[([a-z0-9-]{1,40})\] (.{1,1200})$/;

/**
 * Keys that NAME a credential or an endpoint, refused whatever their value shape.
 *
 * Defence in depth: an undeclared key is already refused by the table lookup, so this can only fire
 * if a future table declares one of these by mistake — which is exactly when it is wanted.
 */
const CREDENTIAL_KEYS = Object.freeze([
  'password', 'passwd', 'pwd', 'user', 'username', 'host', 'hostname', 'port', 'dbname',
  'dsn', 'uri', 'url', 'token', 'secret', 'key', 'credential', 'credentials', 'conninfo',
  'sslcert', 'sslkey', 'sslrootcert', 'passfile', 'service',
]);

/** The one line shape that legitimately carries no `key=value`. */
const REFUSAL_LABEL = 'REFUSED:';

/**
 * Domain descriptors. Each carries a FINITE set, a bounded integer, or a bounded ratio.
 *
 * A value is authorised by MEMBERSHIP, never by shape. The previous grammar accepted any uppercase
 * run as an "enum" and any lowercase run as a "code", which is a character class rather than a
 * confidentiality boundary: a lowercase password, a lowercase hexadecimal key, a project reference
 * and a single-case username all satisfy it.
 */
export const B = Object.freeze({ k: 'bool' });
export const I = (max) => Object.freeze({ k: 'int', max });
export const IU = (max) => Object.freeze({ k: 'intU', max });
export const SIU = (max) => Object.freeze({ k: 'sintU', max });
export const RAT = (den) => Object.freeze({ k: 'ratio', den });
export const S = (...v) => Object.freeze({ k: 'set', v: Object.freeze(v) });
export const LIST = (...v) => Object.freeze({ k: 'list', v: Object.freeze(v) });
export const U = (...d) => Object.freeze({ k: 'union', d: Object.freeze(d) });
/**
 * A zero-padded migration version: exactly three digits, re-rendered from the parse WITH its
 * padding intact. An ordinary integer domain would re-render `005` as `5` and change the child's
 * meaning; a set would have to name the versions, which this file must not do.
 */
export const VER3 = Object.freeze({ k: 'ver3' });
/** A comma list whose members are all the SAME scalar domain, rather than a fixed vocabulary. */
export const REP = (d) => Object.freeze({ k: 'rep', d });

/** No semantic ceiling exists for a live catalog row count; the child's format bound applies. */
export const COUNT_MAX = 999999999999;

/**
 * EVERY reason a terminal check can return — the unlabelled matcher's and the labelled one's.
 *
 * This list said "every" while describing only the unlabelled matcher's seven, and the labelled
 * matcher then added three more. A totality claim that is not enforced decays into a false one, so
 * the list is no longer documentation: `terminalReasonText` renders through it, and the suites
 * derive the reason set from the matchers' ACTUAL behaviour and require it to equal this array.
 */
export const TERMINAL_EVIDENCE_REASONS = Object.freeze([
  'complete', 'streams_not_proved_closed', 'stream_text_unavailable', 'unknown_tag',
  'missing', 'duplicated', 'not_final',
  // The labelled matcher's structural failures: an exact-shape failure, and a whole record the
  // child cannot emit.
  'malformed', 'contradictory',
  // C2B-M005-LRLS-L3-R4-R2 — the PAIR's three. `cleanup_mismatch` is the post-decision record and
  // the post-cleanup record disagreeing about one teardown; the other two are valid post-decision
  // records reporting that the child itself refused or failed. `teardown_failed` was RETIRED with
  // them: a failed teardown is no longer a verdict of its own, it is one half of a pair whose other
  // half already says whether the run refused or failed, and the bounded code travels alongside.
  'cleanup_mismatch', 'child_refused', 'child_failed',
]);

/** What a reason outside the declared set renders as. Never a member; a member would be circular. */
export const UNRECOGNIZED_TERMINAL_REASON = 'unrecognized_reason';

/**
 * Render a terminal reason, refusing anything undeclared.
 *
 * Used by BOTH launchers' report lines. They previously differed — one validated the value, the
 * other interpolated it bare — and an asymmetry between two renderings of one field is where a
 * future change quietly lands on the unguarded side. The value space is closed by construction
 * today; this makes that closure load-bearing rather than merely true.
 */
export function terminalReasonText(reason) {
  return TERMINAL_EVIDENCE_REASONS.includes(reason) ? reason : UNRECOGNIZED_TERMINAL_REASON;
}

/** The key whose line terminates a child transcript. */
export const TERMINAL_OUTCOME_KEY = 'outcome';

/** Re-render one integer from its parse, refusing anything outside the declared ceiling. */
const intIn = (t, max, signed) => {
  if (!(signed ? /^-?\d{1,12}$/ : /^\d{1,12}$/).test(t)) return null;
  const n = Number(t);
  if (!Number.isSafeInteger(n)) return null;
  if (n > max || n < (signed ? -max : 0)) return null;
  return String(n);
};

/**
 * Canonicalise ONE value against ITS OWN key's declared domain.
 *
 * Every return is rebuilt: a set member is re-emitted from the pinned constant rather than from the
 * child's slice, an integer from `Number`, a ratio from its two parsed sides. Nothing passes through.
 */
function canonicalValue(domain, v) {
  if (domain === undefined || domain === null) return null;
  switch (domain.k) {
    case 'bool':
      return v === 'true' ? 'true' : v === 'false' ? 'false' : null;
    case 'int':
      return intIn(v, domain.max, false);
    case 'intU':
      return v === 'UNREADABLE' ? 'UNREADABLE' : intIn(v, domain.max, false);
    case 'sintU':
      return v === 'UNREADABLE' ? 'UNREADABLE' : intIn(v, domain.max, true);
    case 'ratio': {
      const slash = v.indexOf('/');
      if (slash === -1) return null;
      if (v.slice(slash + 1) !== String(domain.den)) return null;
      const left = v.slice(0, slash);
      const num = left === 'UNREADABLE' ? 'UNREADABLE' : intIn(left, domain.den, false);
      return num === null ? null : `${num}/${domain.den}`;
    }
    case 'ver3':
      return /^\d{3}$/.test(v) ? v : null;
    case 'rep':
      return canonicalValue(domain.d, v);
    case 'set':
    case 'list': {
      const at = domain.v.indexOf(v);
      return at === -1 ? null : domain.v[at];
    }
    case 'union': {
      for (const d of domain.d) {
        const got = canonicalValue(d, v);
        if (got !== null) return got;
      }
      return null;
    }
    default:
      return null;
  }
}

/** The list-member domain of a key, for a bare token continuing a comma list. */
const memberDomain = (domain) => {
  if (domain === undefined || domain === null) return null;
  if (domain.k === 'list') return domain;
  if (domain.k === 'rep') return domain.d;
  if (domain.k === 'union') {
    for (const d of domain.d) {
      const got = memberDomain(d);
      if (got !== null) return got;
    }
  }
  return null;
};

/**
 * Build a transcript grammar from one launcher's tables.
 *
 * `spec` carries: `tags`, `labels`, `positional`, `domains`, `constants`, `proseTails`,
 * `spaceTails`, `terminalVocabulary` and `noticePrefix`. Every one is a table of CONSTANTS the
 * launcher publishes; none of them is derived from the child at run time.
 */
export function createTranscriptGrammar(spec) {
  const tags = spec.tags;
  const LINE_LABELS = spec.labels;
  const POSITIONAL_VALUES = spec.positional;
  const FIELD_DOMAINS = spec.domains;
  const CONSTANT_LINES = spec.constants;
  const PROSE_TAILS = spec.proseTails;
  const SPACE_TAILS = spec.spaceTails;
  const TERMINAL_VOCABULARY = spec.terminalVocabulary;
  // OPTIONAL, and absent for a launcher whose child emits an UNLABELLED terminal record.
  // A spec that declares nothing here gets `unknown_tag` from the labelled matcher, which is a
  // refusal — never a pass — so omitting the table cannot weaken a gate.
  const LABELLED_TERMINAL = spec.labelledTerminal ?? Object.freeze({});
  const notice = spec.noticePrefix;

  const DISCARDED_TOKEN = `${notice} child-output-discarded`;
  const UNAVAILABLE_TOKEN = `${notice} child-output-withheld code=streams_not_proved_closed`;
  const STREAMS_UNREADABLE_TOKEN = `${notice} child-output-withheld code=stream_text_unavailable`;

  /**
   * Canonicalise one space-separated item against the tag's domain table.
   *
   * `lastKey` carries the owning key across the comma boundary, so a list member is validated
   * against ITS OWN vocabulary rather than against "any uppercase word".
   */
  function canonicalItem(item, tag, positionalOwner, isLabel) {
    const table = FIELD_DOMAINS[tag];
    const labels = LINE_LABELS[tag];
    const segments = item.split(',');
    if (segments.length > MAX_ITEM_SEGMENTS) return null;
    const out = [];
    let lastKey = null;
    for (const segment of segments) {
      if (segment === '') return null;
      const eq = segment.indexOf('=');
      if (eq === -1) {
        if (isLabel === true && segments.length === 1) {
          const at = labels.indexOf(segment);
          if (at === -1) return null;
          out.push(labels[at]);
          continue;
        }
        if (segment === REFUSAL_LABEL && segments.length === 1) {
          out.push(REFUSAL_LABEL);
          continue;
        }
        if (positionalOwner === REFUSAL_LABEL && segments.length === 1) {
          const codes = TERMINAL_VOCABULARY[tag];
          const at = codes === undefined ? -1 : codes.indexOf(segment);
          if (at === -1) return null;
          out.push(codes[at]);
          continue;
        }
        const owner = lastKey !== null
          ? memberDomain(table[lastKey])
          : (positionalOwner !== null ? (POSITIONAL_VALUES[tag][positionalOwner] ?? null) : null);
        const value = canonicalValue(owner, segment);
        if (value === null) return null;
        out.push(value);
        continue;
      }
      const key = segment.slice(0, eq);
      const value = segment.slice(eq + 1);
      const dot = key.indexOf('.');
      for (const part of dot === -1 ? [key] : [key, key.slice(dot + 1)]) {
        if (CREDENTIAL_KEYS.includes(part.toLowerCase())) return null;
      }
      if (!Object.prototype.hasOwnProperty.call(table, key)) return null;
      const canonical = canonicalValue(table[key], value);
      if (canonical === null) return null;
      out.push(`${key}=${canonical}`);
      lastKey = key;
    }
    return out.join(',');
  }

  /**
   * Canonicalise one child line, or return null to discard it.
   *
   * REBUILT from a constant or a parse: the tag, whole-line constants, prose tails, labels, every
   * set member, and every integer and ratio. VALIDATED-AND-PASSED-THROUGH: the key name alone, and
   * only when the tag's table already declares it.
   */
  function canonicalLine(raw) {
    if (typeof raw !== 'string') return null;
    const matched = TAGGED_LINE.exec(raw);
    if (matched === null) return null;
    const tagIndex = tags.indexOf(matched[1]);
    if (tagIndex === -1) return null;
    const tag = tags[tagIndex];
    // A WHOLE-LINE CONSTANT, matched by equality and re-emitted from the table. Checked first:
    // these lines carry no field, so every rule below would refuse them, and relaxing those rules
    // to admit them would readmit raw prose at the same time.
    const constants = CONSTANT_LINES[tag];
    const constantIndex = constants === undefined ? -1 : constants.indexOf(matched[2]);
    if (constantIndex !== -1) return `[${tag}] ${constants[constantIndex]}`;
    let body = matched[2];
    let tail = '';
    const semicolon = body.indexOf('; ');
    if (semicolon !== -1) {
      const proseIndex = PROSE_TAILS.indexOf(body.slice(semicolon + 2));
      if (proseIndex === -1) return null;
      tail = `; ${PROSE_TAILS[proseIndex]}`;
      body = body.slice(0, semicolon);
    }
    for (const [spaceIndex, candidate] of SPACE_TAILS.entries()) {
      if (body.length > candidate.length + 1 && body.endsWith(` ${candidate}`)) {
        tail = ` ${SPACE_TAILS[spaceIndex]}${tail}`;
        body = body.slice(0, body.length - candidate.length - 1);
        break;
      }
    }
    const items = body.split(' ');
    if (items.length > MAX_LINE_ITEMS) return null;
    // A DIAGNOSTIC LINE STATES A FIELD. Without this, a line of bare lowercase words satisfied the
    // value grammar word by word, so a raw driver message rendered verbatim under the child's tag.
    const isRefusal = items[0] === REFUSAL_LABEL && items.length === 2;
    if (!isRefusal && !items.some((i) => i.includes('='))) return null;
    // THE LEADING LABEL RUN. One child labels a line with its operation AND a section word, so the
    // label is not always a single token. Every token in the run must be a pinned label; the run
    // stops at the first token that is not, and the LAST label owns any positional value after it.
    const labels = LINE_LABELS[tag];
    let labelRun = 0;
    while (labelRun < items.length && !items[labelRun].includes('=') && labels.includes(items[labelRun])) {
      labelRun += 1;
    }
    const positionalOwner = labelRun > 0
      ? items[labelRun - 1]
      : (items[0] !== undefined && !items[0].includes('=') ? items[0] : null);
    const rendered = [];
    for (const [index, item] of items.entries()) {
      const canonical = canonicalItem(item, tag, positionalOwner, index < labelRun);
      if (canonical === null) return null;
      rendered.push(canonical);
    }
    return `[${tag}] ${rendered.join(' ')}${tail}`;
  }

  /**
   * Render a child's transcript as bounded, already-safe operator lines.
   *
   * `streamsClosed` is REQUIRED rather than an optional convenience: a capture must not be inspected
   * before both streams have reached their terminal state, and a parameter that defaults to
   * permissive is a gate a call site can forget.
   *
   * The two streams are rendered from SEPARATE texts and never concatenated before parsing, so a
   * secret split across stdout and stderr cannot be rejoined here.
   */
  function renderTranscript(stdoutText, stderrText, streamsClosed) {
    if (streamsClosed !== true) return [UNAVAILABLE_TOKEN];
    // A NON-STRING STREAM IS AN ABSENT CAPTURE, NOT AN EMPTY ONE. Coercing it to `''` produced the
    // all-zero notice, which an operator reads as "the child was silent".
    if (typeof stdoutText !== 'string' || typeof stderrText !== 'string') {
      return [STREAMS_UNREADABLE_TOKEN];
    }
    const out = [];
    const unparsable = { stdout: 0, stderr: 0 };
    let overCap = 0;
    for (const [stream, text] of [['stdout', stdoutText], ['stderr', stderrText]]) {
      for (const line of text.split(/\r?\n/)) {
        if (line === '') continue;
        // CANONICALISE FIRST, THEN CAP. The reverse order booked every line past the ceiling as a
        // truncation whatever it was. Only a line that WOULD have rendered can count as truncated.
        const canonical = canonicalLine(line);
        if (canonical === null) { unparsable[stream] += 1; continue; }
        if (out.length >= MAX_TRANSCRIPT_LINES) { overCap += 1; continue; }
        out.push(`  | ${canonical}`);
      }
    }
    // ALWAYS EMITTED, INCLUDING WHEN EVERY COUNT IS ZERO, and split by STREAM and by CAUSE. One
    // number could not carry this: a crashed child's stack goes to stderr and is always unparsable,
    // so a single count made that byte-identical to benign warnings on stdout.
    out.push(`${DISCARDED_TOKEN} stdoutUnparsable=${unparsable.stdout}`
      + ` stderrUnparsable=${unparsable.stderr} overCap=${overCap}`
      + ` truncated=${overCap > 0 ? 'true' : 'false'}`);
    return out;
  }

  /**
   * Decide whether the child delivered exactly one valid terminal completion record.
   *
   * WHY A RECORD AND NOT A SIGNAL TEST. Node reports a child killed by a Linux REALTIME signal (34,
   * 40, 64) as `exitCode === 0, signalCode === null` — byte-identical to a clean success. Measured,
   * not assumed. So `if (result.signal)` is false and `if (result.exitCode !== 0)` is false, and a
   * child destroyed mid-run falls straight through to OK. The gate is therefore POSITIVE: a run may
   * only be OK when the child's own final record is present, singular and last, which a child that
   * died cannot produce however it died.
   *
   * STDOUT ONLY. The record is something the child chose to write on its own success path; stderr
   * carries whatever the runtime wrote as it died, and admitting it would let a crash contribute the
   * very evidence that is supposed to prove the crash did not happen.
   */
  function terminalCompletionOf(stdoutText, tag, streamsClosed) {
    const fail = (reason) => Object.freeze({ ok: false, reason, code: null });
    if (streamsClosed !== true) return fail('streams_not_proved_closed');
    if (typeof stdoutText !== 'string') return fail('stream_text_unavailable');
    const vocabulary = Object.prototype.hasOwnProperty.call(TERMINAL_VOCABULARY, tag)
      ? TERMINAL_VOCABULARY[tag]
      : null;
    if (vocabulary === null) return fail('unknown_tag');
    const prefix = `[${tag}] ${TERMINAL_OUTCOME_KEY}=`;
    const found = [];
    let index = -1;
    let lastCanonical = -1;
    for (const line of stdoutText.split(/\r?\n/)) {
      if (line === '') continue;
      // THE SAME GRAMMAR THE TRANSCRIPT USES. A record that would not survive canonicalisation is
      // not evidence of anything, so it cannot establish completion either.
      const canonical = canonicalLine(line);
      if (canonical === null) continue;
      index += 1;
      lastCanonical = index;
      if (canonical.startsWith(prefix)) found.push({ code: canonical.slice(prefix.length), at: index });
    }
    if (found.length === 0) return fail('missing');
    if (found.length > 1) return fail('duplicated');
    const record = found[0];
    // NO MEMBERSHIP TEST HERE, deliberately: the grammar's `outcome` domain and this vocabulary are
    // the same pinned array, so a code outside it never becomes a canonical line and the branch
    // could not fail. The equality that makes it unnecessary is asserted directly in the suites.
    //
    // LAST, which is how "after the child's own cleanup boundary" is enforced without knowing what
    // that boundary contains: any line the child emits after its outcome would displace it.
    if (record.at !== lastCanonical) return fail('not_final');
    return Object.freeze({ ok: true, reason: 'complete', code: record.code });
  }

  /**
   * TERMINAL COMPLETION FOR A CHILD WHOSE RECORD CARRIES AN OPERATION LABEL.
   *
   * `terminalCompletionOf` above looks for `[tag] outcome=<code>`. The migration child does not emit
   * that shape: its post-cleanup record is `[migrate] <op> teardown: <fields>`, where `<op>` is the
   * dispatch's own literal. The unlabelled prefix can never match it, so for that tag the positive
   * gate was not merely weak — it could not fire at all, and a child destroyed by a Linux realtime
   * signal (34, 40, 64 arrive as `exit=0 signal=null`) fell straight through to OK.
   *
   * IT TAKES A CONSISTENT PAIR, not one record. The post-cleanup `teardown:` record proves only
   * that disposal was reached; the child's verdict, its refusal and its exit classification all
   * happen after it, so a realtime signal in that window left a valid teardown record behind and
   * the run still reported `exit=0 signal=null`. The `terminal:` record is emitted after ALL of
   * them and is the last thing the child writes, so it — and only it — can establish completion.
   * The teardown record is now corroboration: each terminal record pins the teardown tuple it must
   * stand beside, and a verdict whose own account of the cleanup disagrees with the cleanup record
   * fails closed.
   *
   * The terminal record must be the LAST non-empty line: that is how "after everything the child
   * had left to decide or say" is enforced without this launcher knowing what that was.
   */
  /**
   * Locate the SINGLE canonical `[tag] <operation> <label> <fields>` record among numbered lines.
   *
   * Returns `{ state }` for every way the search can fail and `{ state: 'found', tuple, at }` when
   * exactly one well-formed record was seen. Shared by both records so their shape rules cannot
   * drift apart: one of them decides completion and the other corroborates it, and a matcher that
   * was strict for one and lax for the other would put the whole pair check on the lax side.
   */
  function recordOf(lines, tag, operation, spec) {
    const head = `[${tag}] `;
    const marker = ` ${spec.label} `;
    const found = [];
    for (const line of lines) {
      // THE SAME GRAMMAR THE TRANSCRIPT USES. A record that would not survive canonicalisation is
      // not evidence, so it cannot establish completion either — and because the op label must be a
      // member of the pinned label table, an invented label never reaches this matcher at all.
      const canonical = canonicalLine(line.text);
      if (canonical === null) continue;
      if (!canonical.startsWith(head)) continue;
      const at = canonical.indexOf(marker);
      if (at === -1) continue;
      // THE OPERATION IS PART OF THE RECORD, and is matched EXACTLY.
      //
      // The child interpolates its own dispatch literal — `[migrate] apply(up) teardown: …` for an
      // apply, `[migrate] baseline teardown: …` for a baseline — and each launcher requests exactly
      // one of them. Anchoring only on the tag and the label left everything between them unchecked,
      // so the baseline launcher accepted an APPLY's completion record, and `[migrate] teardown: …`
      // with no operation at all was accepted too (`teardown:` is itself a declared label, so that
      // line canonicalises). Both are records this launcher's child cannot emit, and reading one as
      // proof that child completed is the favourable-interpretation failure the gate exists to
      // refuse. The slice below is empty for the unlabelled form and unequal for a foreign
      // operation, so one exact comparison closes both.
      if (canonical.slice(head.length, at) !== operation) continue;
      found.push({ body: canonical.slice(at + marker.length), at: line.at });
    }
    if (found.length === 0) return { state: 'missing', tuple: null, at: -1 };
    if (found.length > 1) return { state: 'duplicated', tuple: null, at: -1 };
    // EXACT FIELD NAMES IN EXACT ORDER. A reordered or renamed record is malformed, not tolerated.
    const parts = found[0].body.split(' ');
    if (parts.length !== spec.fields.length) return { state: 'malformed', tuple: null, at: -1 };
    const values = [];
    for (let i = 0; i < spec.fields.length; i += 1) {
      const eq = parts[i].indexOf('=');
      if (eq === -1) return { state: 'malformed', tuple: null, at: -1 };
      if (parts[i].slice(0, eq) !== spec.fields[i]) return { state: 'malformed', tuple: null, at: -1 };
      values.push(parts[i].slice(eq + 1));
    }
    return { state: 'found', tuple: values.join(' '), at: found[0].at };
  }

  function labelledTerminalOf(stdoutText, tag, streamsClosed) {
    const fail = (reason) => Object.freeze({ ok: false, reason, code: null });
    // THE SEAL FIRST. A capture whose closure was never proved is not evidence of anything.
    if (streamsClosed !== true) return fail('streams_not_proved_closed');
    if (typeof stdoutText !== 'string') return fail('stream_text_unavailable');
    // THE TAG IS TYPE-CHECKED BEFORE IT IS USED AS A KEY. A property lookup COERCES its key, so an
    // object with a throwing `Symbol.toPrimitive` escaped as an exception rather than a refusal —
    // and a stateful `toString` could answer `migrate` to the `hasOwnProperty` probe and something
    // else to the read that follows, making the `table.op` access throw on an undefined table.
    // Both are unreachable through this launcher, which passes a module constant; neither is
    // unreachable through the exported grammar, and this function's whole contract is that it is
    // TOTAL. A non-string tag names no declared table, which is what `unknown_tag` says.
    if (typeof tag !== 'string') return fail('unknown_tag');
    const table = Object.prototype.hasOwnProperty.call(LABELLED_TERMINAL, tag)
      ? LABELLED_TERMINAL[tag]
      : null;
    if (table === null) return fail('unknown_tag');
    // A table that declares no operation cannot identify its own records, so it is not usable.
    const operation = table.op;
    if (typeof operation !== 'string' || operation === '') return fail('unknown_tag');
    // POSITION IS COUNTED OVER EVERY NON-EMPTY LINE, NOT ONLY THE CANONICAL ONES.
    //
    // Counting canonical lines alone would let output this launcher could not parse sit AFTER the
    // terminal record without displacing it — a partial line from a child destroyed mid-write, or
    // any unknown migration-specific text, silently discarded and the record still called final.
    // That is interpreting the unknown favourably, which is exactly the reading a positive gate
    // exists to refuse. The child writes NOTHING to stdout after this record; anything that appears
    // there is unexplained, and unexplained is not `complete`.
    const lines = [];
    let index = -1;
    for (const text of stdoutText.split(/\r?\n/)) {
      if (text === '') continue;
      index += 1;
      lines.push({ text, at: index });
    }
    const lastNonEmpty = index;

    // THE POST-DECISION RECORD DECIDES, and it must be the last thing the child said.
    const terminal = recordOf(lines, tag, operation, table.terminal);
    if (terminal.state !== 'found') return fail(terminal.state);
    if (terminal.at !== lastNonEmpty) return fail('not_final');
    let match = null;
    for (const c of table.terminal.records) if (c.tuple === terminal.tuple) { match = c; break; }
    // WHY A TUPLE TABLE AND NOT A FIELD CHECK. Every field is already domain-validated by
    // `canonicalLine`, but the domains are per-key and independent: `decision=success` beside
    // `exit=failure` canonicalises perfectly while asserting two contradictory things. The child can
    // only ever produce a fixed, tiny set of whole records, so the whole record is what is matched.
    if (match === null) return fail('contradictory');

    // THE PAIR. The cleanup record no longer establishes completion on its own — it corroborates
    // the verdict, and a verdict whose own account of the teardown disagrees with the teardown
    // record is not corroborated by it. `missing` is a legitimate observation here (the throw that
    // never reached a client emits none), so it is compared rather than refused outright; every
    // other failure state is a malformed or duplicated record and is refused as itself.
    const cleanup = recordOf(lines, tag, operation, table.cleanup);
    if (cleanup.state !== 'found' && cleanup.state !== 'missing') return fail(cleanup.state);
    if (cleanup.tuple !== match.cleanupTuple) return fail('cleanup_mismatch');
    return Object.freeze({ ok: match.ok, reason: match.reason, code: match.code });
  }

  return Object.freeze({
    tags,
    fieldKeys: Object.freeze(Object.fromEntries(
      tags.map((tag) => [tag, Object.freeze(Object.keys(FIELD_DOMAINS[tag]))]),
    )),
    canonicalLine,
    renderTranscript,
    terminalCompletion: terminalCompletionOf,
    labelledTerminal: labelledTerminalOf,
    discardedToken: DISCARDED_TOKEN,
    unavailableToken: UNAVAILABLE_TOKEN,
    streamsUnreadableToken: STREAMS_UNREADABLE_TOKEN,
  });
}

// ---- this launcher's own child: the migration CLI ----------------------------

/**
 * The migration CLI's bounded outcome codes.
 *
 * 70 of the 71 codes the executor and engine publish. The one that is omitted names the
 * single-purpose migration this launcher is forbidden to reference at all, so a line carrying it is
 * discarded and COUNTED rather than rendered. That is a real, bounded evidence loss on exactly one
 * baseline condition, recorded here rather than worked around: splitting the literal to slip it
 * past the containment test would defeat the test instead of respecting it.
 */
const MIGRATE_CODE_VOCABULARY = S(
    'backend_identity_changed', 'baseline_commit_unknown', 'baseline_entry_state_rejected',
    'baseline_partial_observed', 'baseline_postcondition_failed', 'baseline_precondition_failed',
    'baseline_readback_mismatch', 'checksum_mismatch', 'client_teardown_failed',
    'containment_violation', 'credential_equality_rejected', 'credential_purpose_rejected',
    'duplicate_version_direction', 'execution_policy_unevaluated', 'execution_step_timeout',
    'executor_artifact_binding_mismatch', 'executor_disposal_failed',
    'executor_forbidden_mode_multi_statement', 'executor_port_failed',
    'executor_unsupported_effect', 'invalid_backend_identity', 'invalid_credential_ref',
    'invalid_encoding', 'invalid_execution_event', 'invalid_filename', 'invalid_history',
    'invalid_ledger_field', 'invalid_lock_key', 'invalid_transaction_mode',
    'ledger_dirty_state_invalid', 'ledger_shape_rejected', 'managed_apply_commit_unknown',
    'managed_apply_identity_drift', 'managed_apply_plan_rejected',
    'managed_apply_postcondition_failed', 'managed_apply_readback_mismatch',
    'managed_direction_rejected', 'managed_dsn_database_mismatch',
    'managed_dsn_endpoint_family_rejected', 'managed_dsn_invalid', 'managed_dsn_not_remote',
    'managed_dsn_project_mismatch', 'managed_fingerprint_rejected', 'managed_plan_drift',
    'managed_precommit_backend_identity_changed', 'managed_precommit_blocker_present',
    'managed_precommit_evidence_unreadable', 'managed_precommit_not_transactional',
    'managed_precommit_policy_missing', 'managed_precommit_unevaluated',
    'migration_execution_unavailable', 'migrator_connection_mode_rejected', 'missing_pair',
    'none', 'nonregular_migration_entry', 'owner_acl_verify_failed', 'owner_authority_missing',
    'pair_mismatch', 'path_traversal', 'port_operation_failed', 'run_lock_unavailable',
    'run_unlock_failed', 'runtime_credential_rejected', 'test_dsn_database_not_disposable',
    'test_dsn_host_not_local', 'test_dsn_invalid', 'test_dsn_missing',
    'test_dsn_pool_mode_rejected', 'unknown_ledger_version', 'unresolved_dirty_attempt',
);

/**
 * The migration child's transcript grammar.
 *
 * SIX SURFACES IN THAT CHILD ARE UNBOUNDED and are deliberately NOT declared, so the lines carrying
 * them fail the grammar and are counted as discards rather than forwarded: the raw `REFUSED:`,
 * `ERROR:` and `FATAL:` messages, the disposable database suffix, the unvalidated version token from
 * argv, and the `detail` continuation lines. Those live in a frozen path and cannot be fixed at the
 * source from here — but nothing obliges this launcher to repeat them, and it no longer does.
 */
export const MIGRATE_SPEC = Object.freeze({
  tags: Object.freeze(['migrate']),
  noticePrefix: '[baseline-launcher]',
  proseTails: Object.freeze([]),
  spaceTails: Object.freeze([]),
  terminalVocabulary: Object.freeze({ migrate: Object.freeze([]) }),
  /**
   * THE TWO RECORDS AN OK RESULT REQUIRES, and the COMPLETE set the child can emit.
   *
   * MEASURED IN THE FROZEN CHILD, not assumed.
   *
   * `cleanup` is the POST-CLEANUP record: `runThroughManagedExecutor` emits it inside its `finally`,
   * on the statement after `await handle.dispose()` resolves, guarded by `handle !== null`. Its
   * tuples are the executor's three `TeardownResult` return sites collapsed to their two distinct
   * records — `requested` is typed `true` and can never be false, `gracefulSocketClose` is
   * permanently `not_observed`, and `completed` and `code` move together.
   *
   * `terminal` is the POST-DECISION record, and it is the one that decides. The cleanup record
   * proves only that disposal was reached; every act that settles whether the run SUCCEEDED — the
   * verdict, the refusal, the exit classification — happened after it, so a realtime signal in that
   * window destroyed the child while leaving a valid-looking cleanup record and `exit=0 signal=null`
   * behind. The child now speaks its verdict LAST, after the refusal has been applied and the exit
   * code assigned, and writes nothing to either stream afterwards. That is why this record — and
   * not the cleanup one — must be the final non-empty line.
   *
   * WHY EACH TERMINAL RECORD PINS ITS OWN CLEANUP TUPLE. The two records restate one teardown from
   * two places in the child. Checking them independently would accept a `cleanup=completed` verdict
   * standing beside a `completed=false` teardown — two lines contradicting each other, each
   * individually well-formed. `cleanupTuple` makes the PAIR the unit of evidence; `null` names the
   * one shape that has no cleanup record at all, a throw before the client ever existed.
   */
  labelledTerminal: Object.freeze({
    migrate: Object.freeze({
      // THIS launcher's child argv is `--managed-dev --baseline`, so `runThroughManagedExecutor` is
      // entered with op 'baseline' and can interpolate no other operation into either record. The
      // 005 launcher requests a different operation and overrides this when it extends the spec.
      op: 'baseline',
      // NO `records` TABLE HERE, deliberately. A cleanup tuple outside the child's two is already
      // rejected: it can equal no terminal record's `cleanupTuple`, so it fails the pair check. A
      // second list would be a second expression of one requirement, and those mask each other.
      cleanup: Object.freeze({
        label: 'teardown:',
        fields: Object.freeze(['requested', 'completed', 'gracefulSocketClose', 'code']),
      }),
      terminal: Object.freeze({
        label: 'terminal:',
        fields: Object.freeze(['decision', 'cleanup', 'exit', 'code']),
        records: Object.freeze([
          // THE ONLY RECORD THAT ESTABLISHES COMPLETION. A clean verdict, a completed teardown and
          // an exit class of success — all three, from one child, in one line.
          Object.freeze({
            tuple: 'success completed success none',
            cleanupTuple: 'true true not_observed none',
            ok: true,
            reason: 'complete',
            code: 'terminal_completed',
          }),
          Object.freeze({
            tuple: 'refused completed failure none',
            cleanupTuple: 'true true not_observed none',
            ok: false,
            reason: 'child_refused',
            code: null,
          }),
          Object.freeze({
            tuple: 'refused failed failure client_teardown_failed',
            cleanupTuple: 'true false not_observed client_teardown_failed',
            ok: false,
            reason: 'child_refused',
            code: 'client_teardown_failed',
          }),
          Object.freeze({
            tuple: 'failed completed failure none',
            cleanupTuple: 'true true not_observed none',
            ok: false,
            reason: 'child_failed',
            code: null,
          }),
          Object.freeze({
            tuple: 'failed failed failure client_teardown_failed',
            cleanupTuple: 'true false not_observed client_teardown_failed',
            ok: false,
            reason: 'child_failed',
            code: 'client_teardown_failed',
          }),
          // A THROW BEFORE THE CLIENT EXISTED. `handle` is still null, so the child's `finally`
          // emits no cleanup record at all and the terminal record reports the cleanup as never
          // attempted rather than as completed. Pinned to `null` so that absence is REQUIRED here
          // and refused everywhere else: any other record standing alone is a MISSING cleanup
          // record, not a permitted one.
          Object.freeze({
            tuple: 'failed not_attempted failure none',
            cleanupTuple: null,
            ok: false,
            reason: 'child_failed',
            code: null,
          }),
        ]),
      }),
    }),
  }),
  constants: Object.freeze({
    migrate: Object.freeze([
      'managed target: live DEV fingerprint OK',
      'list mode: no database connection, no SQL executed.',
      'file-side plan (no database connection, no ledger read):',
      'plan mode is file-only. A live status/apply requires S1b (fail-closed in S1).',
      'dry-run (no database connection, no SQL executed):',
      'dry-run OK. Apply is fail-closed in S1 (requires S1b real-PostgreSQL proof).',
      'ERROR: --direction must be "up" or "down".',
      'FATAL: migration_managed_run_failed',
    ]),
  }),
  labels: Object.freeze({
    migrate: Object.freeze([
      'apply(up):', 'apply(down):', 'status:', 'baseline:', 'resolve-dirty:',
      'apply(up)', 'apply(down)', 'status', 'baseline',
      'mutation:', 'ledger:', 'evidence:', 'teardown:', 'plan:',
      // The POST-DECISION record's label. Distinct from `teardown:` on purpose: the two records
      // answer different questions, and one label for both would let either satisfy a check meant
      // for the other.
      'terminal:',
    ]),
  }),
  positional: Object.freeze({
    migrate: Object.freeze({
      'mutation:': S('pre_commit_refusal_connection_disposal_resolved',
        'pre_commit_refusal_connection_disposal_unverified', 'commit_not_attempted',
        'commit_failed_or_unknown', 'post_commit_verification_failed_may_have_committed',
        'success_commit_and_read_back_verified'),
    }),
  }),
  domains: Object.freeze({
    migrate: Object.freeze({
      host: S('unix_socket', 'loopback'),
      outcome: S('complete', 'failed', 'in_progress', 'refused'),
      rows: I(999999),
      disposal: S('none', 'closed', 'terminated'),
      finalized: I(999),
      commit: S('not_submitted', 'resolved', 'unknown', 'not_committed', 'committed'),
      readBack: B,
      submitted: B,
      resolved: B,
      acknowledged: S('unavailable', 'observed'),
      lockRelease: S('not_acquired', 'verified', 'unverified'),
      requested: B,
      completed: B,
      gracefulSocketClose: S('not_observed'),
      // THE POST-DECISION RECORD'S THREE KEYS. Each is a closed set decided in the child, and each
      // is a DIFFERENT question: what the run concluded, what its disposal did, and which exit class
      // was assigned. `cleanup` carries `not_attempted` because a throw before the client existed
      // has no disposal to report, and reporting that as `completed` would be a lie the pair check
      // could not catch.
      decision: S('success', 'refused', 'failed'),
      cleanup: S('completed', 'failed', 'not_attempted'),
      exit: S('success', 'failure'),
      commit_attempted: B,
      // THE MUTATION LINE'S SECOND FLAG IS NOT DECLARED HERE. Its key names a compensating action
      // this launcher's containment tests forbid it to mention at all, and slipping the literal past
      // a substring scan would defeat the scan rather than respect it. That line is emitted only on
      // an APPLY, which this launcher never performs; the launcher that does declares the key by
      // extending this spec, where naming it is permitted.
      version: VER3,
      versions: U(S('none'), REP(VER3)),
      adopted: U(S('none'), REP(VER3)),
      marker: S('not_written', 'durable_dirty', 'clean_verified', 'unknown'),
      markerWrite: S('not_attempted', 'succeeded', 'unknown'),
      cleanVerified: B,
      ddlMayHaveCommitted: B,
      endpointFamily: S('session'),
      database: S('postgres'),
      audit: S('record_baseline'),
      status: S('resolved_failed', 'resolved_superseded'),
      code: MIGRATE_CODE_VOCABULARY,
    }),
  }),
});

const MIGRATE_GRAMMAR = createTranscriptGrammar(MIGRATE_SPEC);

/** Canonicalise the migration child's transcript. Nothing raw is ever forwarded. */
export function renderMigrateTranscript(stdoutText, stderrText, streamsClosed) {
  return MIGRATE_GRAMMAR.renderTranscript(stdoutText, stderrText, streamsClosed);
}

/** Exported for the deterministic suite: the declared key set of the migration grammar. */
export const MIGRATE_FIELD_KEYS = MIGRATE_GRAMMAR.fieldKeys.migrate;

/** Exported for the deterministic suite: one line at a time. */
export function canonicalMigrateLine(raw) {
  return MIGRATE_GRAMMAR.canonicalLine(raw);
}

// Entry guard: importing this module must spawn nothing.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().then(
    (c) => {
      // process.exitCode, never process.exit(): stdout is a pipe here, and an explicit exit can
      // truncate a report that has not finished flushing.
      process.exitCode = c;
    },
    () => {
      console.error('[baseline-launcher] REFUSED: unexpected launcher failure');
      process.exitCode = 2;
    },
  );
}

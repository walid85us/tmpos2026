// Phase 4.0 M3 S4.1b — STAGE C2B-R3B-B0.
//
// Deterministic guard for scripts/managed-baseline-launcher.mjs.
//
// EVERY value here is SYNTHETIC. The DSN and API host use the RFC 2606 reserved `.invalid` TLD, so
// no name in this file can resolve, and the certificate body is literal filler. No real
// configuration is read: the launcher's `main()` and `buildChildEnv()` both take their source as a
// parameter, and every test passes the synthetic fixture. Nothing here performs DNS, opens a
// socket, or contacts PostgreSQL — the only child processes are local `node -e` one-liners that
// print and exit.

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

import {
  BASELINE_FLAGS,
  CHILD_ENV_KEYS,
  CLEANUP_STATUSES,
  CONFIG_KEYS,
  CONTAINMENT_HOLD_POLL_MS,
  DATABASE_OUTCOME_UNKNOWN,
  GATE_VALUES,
  LAUNCHER_CODES,
  LauncherRefusal,
  MIGRATE_FIELD_KEYS,
  MIGRATE_SCRIPT,
  NODE_BIN,
  OUTER_INVOCATION,
  REPO_ROOT,
  STARTUP_SENSITIVE,
  TSX_CLI,
  assertChildEnv,
  assertContainmentPreconditions,
  assertIsolatedGroup,
  assertStartupSensitiveAbsent,
  buildChildEnv,
  buildRedactor,
  MIGRATE_SPEC,
  MIGRATE_TAG,
  canonicalMigrateLine,
  createTranscriptGrammar,
  dispositionFor,
  terminalEvidenceFor,
  cleanupComplete,
  createCapture,
  enterContainmentHold,
  enterHoldIfRequired,
  errnoCode,
  groupIsEmpty,
  main,
  normalCompletion,
  outcomeCode,
  parseEnviron,
  readExecEnvironment,
  readProcIdentity,
  renderMigrateTranscript,
  renderReport,
  runChild,
  scanGroup,
  secretValuesFrom,
} from '../../scripts/managed-baseline-launcher.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const LAUNCHER_PATH = resolve(HERE, '..', '..', 'scripts', 'managed-baseline-launcher.mjs');
const LAUNCHER_SRC = readFileSync(LAUNCHER_PATH, 'utf8');

/**
 * Source with comments removed, mirroring the executor containment suite.
 *
 * Every source-level assertion below runs against THIS, not the raw file. The launcher documents
 * the constructs it deliberately does not use — `process.kill(pid, 0)`, stdio inheritance, raw
 * stream forwarding — so a raw scan would match the prose that forbids a construct and report the
 * absence of that construct as its presence.
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}
const LAUNCHER_CODE = stripComments(LAUNCHER_SRC);

// ---- synthetic fixture -------------------------------------------------------

const SYNTH_PASSWORD_DECODED = 'S3cr3t/Pass#word';
const SYNTH_PASSWORD_ENCODED = 'S3cr3t%2FPass%23word';
const SYNTH_USER = 'postgres.synthref00000';
const SYNTH_DB_HOST = 'aws-0-eu-north-1.pooler.supabase.invalid';
const SYNTH_DSN = `postgresql://${SYNTH_USER}:${SYNTH_PASSWORD_ENCODED}@${SYNTH_DB_HOST}:6543/postgres`;
const SYNTH_API_URL = 'https://synthref00000.supabase.invalid';
const SYNTH_CA_LINE_A = 'SYNTHETICLINEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const SYNTH_CA_LINE_B = 'SYNTHETICLINEBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const SYNTH_CA = `-----BEGIN CERTIFICATE-----\n${SYNTH_CA_LINE_A}\n${SYNTH_CA_LINE_B}\n-----END CERTIFICATE-----`;

const SYNTH_SOURCE = Object.freeze({
  SUPABASE_DATABASE_URL: SYNTH_DSN,
  SUPABASE_URL: SYNTH_API_URL,
  DATABASE_CA_CERT: SYNTH_CA,
});

const synthEnv = () => buildChildEnv(SYNTH_SOURCE);
const synthRedact = () => buildRedactor(secretValuesFrom(synthEnv()));

/** Everything that must never survive into an operator record. */
const FORBIDDEN_LITERALS = [
  SYNTH_DSN,
  SYNTH_USER,
  SYNTH_PASSWORD_DECODED,
  SYNTH_PASSWORD_ENCODED,
  SYNTH_DB_HOST,
  SYNTH_API_URL,
  'synthref00000',
  SYNTH_CA,
  SYNTH_CA_LINE_A,
  SYNTH_CA_LINE_B,
];

function assertClean(text, label) {
  for (const secret of FORBIDDEN_LITERALS) {
    assert.ok(!text.includes(secret), `${label}: a synthetic secret survived redaction`);
  }
}

/**
 * A minimal fake child process, so lifecycle paths are testable without a real process.
 *
 * `signals` records every delivery attempt in order, which is what the cleanup assertions below are
 * actually about: a SIGKILL that arrives without a preceding SIGTERM, or a second SIGTERM, is a
 * contract violation that no outcome code would reveal.
 */
function fakeChild(overrides = {}) {
  const child = new EventEmitter();
  child.pid = 424242;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  // Kept as no-ops so a REGRESSION that reintroduces a handle release still runs here rather than
  // throwing — the source invariant is what forbids it, and a test that crashed instead of failing
  // would report the wrong thing.
  child.unref = () => {};
  child.stdout.unref = () => {};
  child.stderr.unref = () => {};
  // Node closes the stdio streams BEFORE emitting the subprocess 'close'. A fake child that skipped
  // that step let the `streamsClosed` conjunct pass on `|| closed` alone, which is how a term the
  // hold decision now depends on came to be unfalsifiable in every synthetic run.
  const rawEmit = child.emit.bind(child);
  child.emit = (event, ...rest) => {
    if (event === 'close') {
      child.stdout?.emit?.('close');
      child.stderr?.emit?.('close');
    }
    return rawEmit(event, ...rest);
  };
  child.signals = [];
  child.kill = (sig) => {
    child.signals.push(sig);
    return true;
  };
  return Object.assign(child, overrides);
}

// ---- R2 containment fixtures --------------------------------------------------
//
// Every identity below is synthetic and no test signals a real process: `killGroup` is injected and
// only ever records what WOULD have been sent. The one exception is the real-descendant section at
// the end of this file, which deliberately creates and contains genuine local processes.

const CHILD_PID = 424242;
/** The launcher's own identity. Distinct from the managed group on pid, pgid AND sid. */
const PARENT_ID = Object.freeze({ pid: 1000, ppid: 999, pgid: 1000, sid: 900, state: 'S', starttime: '111' });
/** What a correctly detached child reports back: pid === pgid === sid, all unlike the parent's. */
const CHILD_ID = Object.freeze({
  pid: CHILD_PID,
  ppid: PARENT_ID.pid,
  pgid: CHILD_PID,
  sid: CHILD_PID,
  state: 'S',
  starttime: '222',
});

const identifyOk = () => ({ ...CHILD_ID });
const selfOk = () => ({ ...PARENT_ID });

const observation = (over = {}) => ({
  available: true,
  pidPresent: false,
  leaderIdentityMatches: null,
  groupMembers: [],
  sessionMembers: [],
  ...over,
});

/** An EMPTY managed group and session — the ordinary terminal observation. */
const groupEmpty = () => observation();
/** The leader alive and alone in its own group. */
const groupLeaderAlive = () => observation({ pidPresent: true, leaderIdentityMatches: true, groupMembers: [CHILD_PID] });
/**
 * The REPARENTED-ORPHAN shape: the leader is gone, a descendant is not.
 *
 * This is the exact state a ppid-descendant scan cannot see — measured on the installed tsx: after
 * the direct handle is killed, the grandchild's ppid becomes 1 while its PGID and SID are unchanged.
 */
const groupOrphan = () => observation({ groupMembers: [CHILD_PID + 1] });
/** A member that called setpgid() out of the group but stayed in the managed SESSION. */
const sessionOnly = () => observation({ sessionMembers: [CHILD_PID + 2] });
/**
 * The leader pid slot RECYCLED while a member is still listed.
 *
 * This state is not reachable on a healthy Linux kernel — a pid is pinned while it is still in use
 * as an active PGID — which is exactly why the guard is tested here rather than assumed away. The
 * member is what makes the guard REACHABLE: with an empty group the launcher has nothing to signal
 * and never consults the identity at all, so a member-less fixture would test nothing.
 */
const groupRecycled = () => observation({ pidPresent: true, leaderIdentityMatches: false, groupMembers: [CHILD_PID + 1] });
/** `/proc` unreadable — a MISSING observation, never evidence of termination. */
const groupUnavailable = () => ({
  available: false,
  pidPresent: null,
  leaderIdentityMatches: null,
  groupMembers: null,
  sessionMembers: null,
});

/**
 * The FULLY EVIDENCED terminal result — every conjunct of the R3 normal-completion predicate present.
 *
 * Built as one helper rather than repeated literals so the tests that probe `outcomeCode` and
 * `renderReport` directly all start from the SAME complete shape. Each of them then removes exactly
 * one conjunct and asserts the pass disappears; a hand-rolled literal per test would let a conjunct
 * be silently absent everywhere, which is how a predicate grows a term no test actually exercises.
 */
const evidenced = (over = {}) => ({
  status: 'closed',
  code: null,
  detail: null,
  pid: CHILD_PID,
  exitCode: 0,
  signal: null,
  capture: createCapture(),
  identity: { ...CHILD_ID },
  group: groupEmpty(),
  spawned: true,
  closeObserved: true,
  streamsClosed: true,
  observationLost: false,
  containmentHold: false,
  ...over,
});

/** A scan yielding a SEQUENCE of observations, repeating the last one once exhausted. */
function scanSeq(...states) {
  let i = 0;
  return () => {
    const state = states[Math.min(i, states.length - 1)];
    i += 1;
    return state();
  };
}

/** Records group signals as `<pgid>/<SIG>` so a test can prove WHICH group was targeted. */
function groupKiller(sink, behaviour = () => true) {
  return (pgid, sig) => {
    sink.push(`${pgid}/${sig}`);
    return behaviour(pgid, sig);
  };
}

/**
 * Tiny windows plus a VERIFIABLE isolated group — the standard lifecycle harness.
 *
 * The real 120s/5s values would make the suite unusable, and the identity seams are folded in here
 * rather than opted into per test, so a test that says nothing about containment still runs against
 * a fully specified, containment-correct baseline. `killGroup` is injected everywhere: no test in
 * this file may signal a real process group.
 */
const FAST = {
  timeoutMs: 20,
  cleanupGraceMs: 20,
  groupPollMs: 1,
  identify: identifyOk,
  selfIdentity: selfOk,
  killGroup: () => true,
};

// ---- 1. single purpose: migration 005 is unreachable -------------------------

test('C2B-R3B-B0: the child argv is frozen to the 001-004 historical baseline', () => {
  assert.deepEqual([...BASELINE_FLAGS], [
    '--managed-dev',
    '--baseline',
    '--confirm-dev',
    '--baseline-versions=001,002,003,004',
  ]);
  assert.ok(Object.isFrozen(BASELINE_FLAGS), 'the flag list must be frozen');
});

test('C2B-R3B-B0: migration 005 is unreachable from the launcher', () => {
  const argv = [TSX_CLI, MIGRATE_SCRIPT, ...BASELINE_FLAGS].join(' ');
  // The CLI executes a migration ONLY under --apply; the launcher never emits it, and it emits no
  // version token other than the authorized prefix.
  assert.ok(!argv.includes('--apply'), 'the launcher must never emit --apply');
  assert.ok(!/\b005\b/.test(argv), 'the launcher must never name version 005');
  assert.ok(!argv.includes('--allow-down') && !argv.includes('--direction'), 'no direction control');
  // And the source itself contains no apply spelling that a future edit could reach by accident.
  assert.ok(!/'--apply'|"--apply"/.test(LAUNCHER_CODE), 'no --apply literal anywhere in the launcher');
});

test('C2B-R3B-B0: the launcher accepts no caller-supplied flags', async () => {
  // Every rejected invocation returns BEFORE any spawn: main() validates argv first.
  for (const argv of [[], ['--apply'], ['--execute', '--apply'], ['--execute', 'extra'], ['-execute']]) {
    assert.equal(await main(argv, SYNTH_SOURCE), 2, `argv ${JSON.stringify(argv)} must be refused`);
  }
});

test('C2B-R3B-B0: the child command is fixed absolute repository paths', () => {
  assert.equal(NODE_BIN, process.execPath, 'the interpreter is the absolute current Node');
  assert.equal(TSX_CLI, resolve(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs'), 'repository-local tsx CLI by exact path');
  assert.equal(MIGRATE_SCRIPT, resolve(REPO_ROOT, 'scripts/supabase-migrate.ts'), 'exact baseline script');
  assert.ok(!/\bnpx\b|\bnpm run\b|shell: *true/.test(LAUNCHER_CODE), 'no shell, no npx, no npm indirection');
});

// ---- 2. child-environment containment ----------------------------------------

test('C2B-R3B-B0: the child environment is EXACTLY the derived allowlist', () => {
  const env = synthEnv();
  assert.deepEqual(Object.keys(env).sort(), [...CHILD_ENV_KEYS].sort());
  assert.equal(Object.keys(env).length, 6);
  assert.equal(Object.getPrototypeOf(env), null, 'built from an empty object, no inherited keys');
  assert.equal(env.ALLOW_SUPABASE_MIGRATION_APPLY, '1');
  assert.equal(env.CONFIRM_SUPABASE_TARGET, GATE_VALUES.CONFIRM_SUPABASE_TARGET);
  assert.equal(env.NODE_ENV, 'development');
});

test('C2B-R3B-B0: no PG*, PATH, HOME, npm, Node TLS or OpenSSL key reaches the child', () => {
  const env = synthEnv();
  for (const k of Object.keys(env)) {
    assert.ok(!/^PG/.test(k), `PG-prefixed key reached the child: ${k}`);
    assert.ok(!/^(npm_|NPM_)/.test(k), `npm configuration reached the child: ${k}`);
    assert.ok(!STARTUP_SENSITIVE.includes(k), `startup-sensitive key reached the child: ${k}`);
  }
  assert.ok(!('PATH' in env) && !('HOME' in env), 'PATH and HOME must not be inherited');
  // The assertion is a real gate, not decoration: it rejects each forbidden shape it names.
  for (const bad of ['PGPASSWORD', 'PGSSLMODE', 'PATH', 'HOME', 'npm_config_registry', 'NODE_OPTIONS']) {
    const poisoned = Object.assign(Object.create(null), synthEnv(), { [bad]: 'x' });
    assert.throws(() => assertChildEnv(poisoned), (e) => e.code === LAUNCHER_CODES.CHILD_ENV_INVALID, bad);
  }
});

test('C2B-R3B-B0: missing configuration is refused by NAME, never by value', () => {
  for (const key of CONFIG_KEYS) {
    const partial = { ...SYNTH_SOURCE, [key]: '' };
    assert.throws(
      () => buildChildEnv(partial),
      (e) => {
        assert.ok(e instanceof LauncherRefusal);
        assert.equal(e.code, LAUNCHER_CODES.CONFIG_MISSING);
        assert.deepEqual(e.names, [key]);
        assertClean(e.message, 'CONFIG_MISSING message');
        return true;
      },
    );
  }
});

test('C2B-R3B-B0: secrets are passed ONLY through the child environment', () => {
  // Not argv, not inline source, not a temp file, not shell text.
  const argv = [TSX_CLI, MIGRATE_SCRIPT, ...BASELINE_FLAGS].join(' ');
  assertClean(argv, 'child argv');
  assert.ok(!/writeFileSync|appendFileSync|createWriteStream|mkdtemp|tmpdir/.test(LAUNCHER_CODE), 'no disk write path');
  // DECIDED AT THE IMPORT, not by a substring scan. A bare `exec(` test is a false positive on
  // `RegExp.prototype.exec`, which the range-based redactor uses to find structural matches; what
  // actually matters is that no shell-invoking primitive is in scope at all.
  assert.match(
    LAUNCHER_CODE,
    /import \{ spawn as nodeSpawn \} from 'node:child_process';/,
    'only spawn is imported from child_process — no exec, execSync or spawn-with-shell',
  );
  assert.ok(!/\bexecSync\b|\bexecFileSync\b|\bchildProcess\.exec\b/.test(LAUNCHER_CODE), 'no shell-execution primitive');
  assert.ok(!/shell:\s*true/.test(LAUNCHER_CODE), 'the child is never spawned through a shell');
});

// ---- 3. startup-sensitive variables -------------------------------------------

test('C2B-R3B-B0: the outer invocation removes startup-sensitive variables BEFORE Node starts', () => {
  for (const name of STARTUP_SENSITIVE) {
    assert.ok(OUTER_INVOCATION.includes(`-u ${name}`), `${name} must be removed at the exec boundary`);
  }
  assert.ok(OUTER_INVOCATION.startsWith('env '), 'removal happens in exec, not inside Node');
  assert.ok(OUTER_INVOCATION.endsWith('--execute'), 'the outer invocation names the single literal argument');
  assertClean(OUTER_INVOCATION, 'outer invocation');
});

test('C2B-R3B-B0: the in-process assertion reads the EXEC-TIME environment, not process.env', () => {
  // /proc/self/environ is fixed at exec, so no import can repopulate what this check reads.
  assert.ok(LAUNCHER_CODE.includes('/proc/self/environ'), 'the proof source is the exec-time environment');
  const env = parseEnviron('A=1\0NODE_OPTIONS=--max-old-space-size=64\0B=2\0');
  assert.equal(env.get('NODE_OPTIONS'), '--max-old-space-size=64');
  assert.throws(
    () => assertStartupSensitiveAbsent(env),
    (e) => e.code === LAUNCHER_CODES.STARTUP_SENSITIVE_PRESENT && e.names.includes('NODE_OPTIONS'),
  );
  assert.doesNotThrow(() => assertStartupSensitiveAbsent(parseEnviron('A=1\0B=2\0')));
});

test('C2B-R3B-B0: an unreadable exec environment REFUSES rather than weakening the proof', () => {
  assert.throws(
    () => readExecEnvironment(() => { throw new Error('ENOENT'); }),
    (e) => e.code === LAUNCHER_CODES.EXEC_ENV_UNAVAILABLE,
    'no silent fallback to process.env is permitted',
  );
});

test('C2B-R3B-B0: the CLI seals the environment immediately BEFORE managed-client construction', () => {
  // The parent seal covers exec only. `process.env` stays mutable, so the last word on routing,
  // credential and TLS material must be spoken at the client-construction seam — not earlier, and
  // not by the launcher, which cannot see what the child's own import graph does.
  const cli = stripComments(readFileSync(resolve(REPO_ROOT, 'scripts/supabase-migrate.ts'), 'utf8'));
  assert.match(
    cli,
    /assertSealedManagedEnvironment\(op\);\s*\n\s*return createManagedDevExecutor\(dsn\);/,
    'the seal assertion must be the statement immediately preceding managed-client construction',
  );
  // It must compare against the EXEC-TIME environment; comparing process.env with itself is an
  // assertion that cannot fail.
  assert.ok(cli.includes("readFileSync('/proc/self/environ'"), 'the seal reads the exec-time environment');
  assert.ok(/ENV_SEAL_BROKEN/.test(cli), 'a bounded refusal code exists for a broken seal');
  // A PG name appearing after the seal can still redirect the driver through its env fallbacks.
  assert.ok(/name\.startsWith\('PG'\)/.test(cli), 'the seal sweeps PG-prefixed names');
  // BOTH sources. Sweeping only process.env lets a later `delete process.env.NODE_OPTIONS` erase
  // the evidence of a startup-sensitive variable that had ALREADY taken effect at exec — the seal
  // would then pass vacuously, in exactly the case it exists to catch.
  assert.ok(
    /\[\.\.\.execEnv\.keys\(\), \.\.\.Object\.keys\(liveEnv\)\]/.test(cli),
    'the forbidden-name sweep must cover the exec-time environment as well as the live one',
  );
  // The decision is a PURE function of the two environments, and the live one it is actually given
  // is `process.env` — not a copy taken earlier, which would reintroduce the staleness the seal exists
  // to catch.
  assert.ok(/const broken = sealBreakage\(op, execEnv, process\.env\);/.test(cli), 'the seal decides against the LIVE object');
});

// ---- 4. redaction matrix (adversarial, synthetic) -----------------------------

test('redaction: a secret wholly inside one stdout chunk', () => {
  const cap = createCapture();
  cap.push(Buffer.from(`[migrate] connecting to ${SYNTH_DSN} now\n`, 'utf8'));
  const out = synthRedact()(cap.text());
  assertClean(out, 'single-chunk stdout');
  assert.ok(out.includes('[REDACTED]'));
});

test('redaction: a secret divided across multiple stream chunks', () => {
  const cap = createCapture();
  // Split mid-credential at three arbitrary byte offsets — a per-chunk redactor passes all three.
  const payload = `error: ${SYNTH_DSN} refused\n`;
  for (const piece of [payload.slice(0, 17), payload.slice(17, 34), payload.slice(34, 51), payload.slice(51)]) {
    cap.push(Buffer.from(piece, 'utf8'));
  }
  const out = synthRedact()(cap.text());
  assertClean(out, 'chunk-split');
  assert.ok(out.includes('[REDACTED]'));
});

test('redaction: a secret arriving on stderr', () => {
  const cap = createCapture();
  cap.push(Buffer.from('[migrate] ok\n', 'utf8'));
  cap.push(Buffer.from(`FATAL ${SYNTH_API_URL} unreachable\n`, 'utf8'));
  const out = synthRedact()(cap.text());
  assertClean(out, 'stderr');
});

test('redaction: URL-encoded AND decoded credential forms', () => {
  const redact = synthRedact();
  const encoded = redact(`password=${SYNTH_PASSWORD_ENCODED}`);
  const decoded = redact(`password=${SYNTH_PASSWORD_DECODED}`);
  assertClean(encoded, 'encoded credential');
  assertClean(decoded, 'decoded credential');
  assert.ok(encoded.includes('[REDACTED]') && decoded.includes('[REDACTED]'));
});

test('redaction: a multiline synthetic certificate, whole and line-by-line', () => {
  const redact = synthRedact();
  assertClean(redact(`ca=\n${SYNTH_CA}\n`), 'whole certificate');
  // Quoted back one line at a time, the whole-blob literal never matches — significant lines must
  // be redaction targets in their own right.
  assertClean(redact(`unexpected token on line: ${SYNTH_CA_LINE_B}`), 'single certificate line');
});

test('redaction: a containing value is never fragmented, whatever order the inputs arrive in', () => {
  const redact = synthRedact();
  const out = redact(`dsn=${SYNTH_DSN}`);
  assertClean(out, 'containment');
  // One replacement for the whole DSN, not a hostname replacement that leaves the credential behind.
  assert.equal(out, 'dsn=[REDACTED]');

  // INPUT ORDER MUST NOT MATTER. Fed shortest-first, an insertion-order sequential redactor replaces
  // the hostname first, destroying the longer literal and leaving the credential standing in the
  // wreckage. Range-merging removes the dependency on order entirely rather than repairing it.
  const adversarial = buildRedactor([SYNTH_DB_HOST, 'postgres', SYNTH_API_URL, SYNTH_DSN]);
  const hard = adversarial(`dsn=${SYNTH_DSN}`);
  assertClean(hard, 'adversarially ordered redaction inputs');
  assert.equal(hard, 'dsn=[REDACTED]', 'the containing value must win regardless of input order');
});

test('redaction: derived values cover host, user, project ref and API origin', () => {
  const values = secretValuesFrom(synthEnv());
  for (const expected of [SYNTH_DSN, SYNTH_DB_HOST, SYNTH_USER, SYNTH_API_URL, 'synthref00000', SYNTH_CA_LINE_A]) {
    assert.ok(values.includes(expected), `redaction target missing: ${expected.slice(0, 12)}…`);
  }
});

// ---- 4b. redaction defects found by independent review ------------------------

test('redaction: an IPv6 database host is covered in its BARE form, not only bracketed', () => {
  // `new URL()` exposes an IPv6 host WITH brackets (measured: "[2a05:d012::1]"), while driver
  // errors print it bare ("connect ETIMEDOUT 2a05:d012::1:6543"). The bracketed literal alone
  // would never match the form that actually reaches the record.
  const env = buildChildEnv({
    ...SYNTH_SOURCE,
    SUPABASE_DATABASE_URL: 'postgresql://pguser:pgpass@[2a05:d012::1]:6543/postgres',
  });
  // Asserted on the derived VALUE SET, not on rendered output: the structural address sweep would
  // also catch this form, so testing the output alone would pass even if the literal were absent
  // and would not pin the derivation this test exists to hold.
  const values = secretValuesFrom(env);
  assert.ok(values.includes('2a05:d012::1'), 'the bare IPv6 host must be a derived literal');
  assert.ok(values.includes('[2a05:d012::1]'), 'the bracketed form must be kept as well');
  assert.ok(!buildRedactor(values)('connect ETIMEDOUT 2a05:d012::1:6543').includes('2a05:d012::1'));
});

test('redaction: a hostname echoed in a different case is still covered', () => {
  // `postgresql:` is not a WHATWG "special" scheme, so its host is NOT ASCII-lowercased by the
  // parser (measured). DNS and TLS error text reports the lowercased name.
  // The DSN host carries a ref the API URL does NOT, so the lowercase coverage asserted here can
  // only have come from lowercasing the DSN host — not from the already-lowercase SUPABASE_URL.
  const env = buildChildEnv({
    ...SYNTH_SOURCE,
    SUPABASE_DATABASE_URL: 'postgresql://u:p@DB.CaseRef11111.Supabase.Invalid:6543/postgres',
  });
  const out = buildRedactor(secretValuesFrom(env))('getaddrinfo ENOTFOUND db.caseref11111.supabase.invalid');
  assert.ok(!out.includes('db.caseref11111.supabase.invalid'), 'the lowercased hostname survived');
  assert.ok(!out.includes('caseref11111'), 'the project ref survived in lowercase');
});

test('redaction: the opaque origin literal "null" is NOT a redaction target', () => {
  // A non-special scheme serialises its origin as the string "null" (measured). Adding it would
  // rewrite every `null` in the record to [REDACTED] — corrupting the operator record in a way
  // that reads like a genuine redaction hit — while contributing zero DSN coverage.
  assert.ok(!secretValuesFrom(synthEnv()).includes('null'), '"null" must never enter the value set');
  assert.equal(synthRedact()('exitCode=null signal=null'), 'exitCode=null signal=null');
});

test('redaction: credential material has NO length floor', () => {
  // The floor is a legibility guard for low-entropy derived tokens. Applied to a credential it
  // trades a disclosure for readability, which is the wrong way round.
  const env = buildChildEnv({
    ...SYNTH_SOURCE,
    SUPABASE_DATABASE_URL: 'postgresql://ab:xy@aws-0-eu-north-1.pooler.supabase.invalid:6543/postgres',
  });
  const out = buildRedactor(secretValuesFrom(env))('password authentication failed for user "ab" using xy');
  assert.ok(!/"ab"/.test(out), 'a two-character username survived redaction');
  assert.ok(!/\bxy\b/.test(out), 'a two-character password survived redaction');
});

test('redaction: an UNPARSABLE configuration value FAILS CLOSED instead of degrading', () => {
  // A libpq keyword/value DSN parses as nothing useful. Continuing would leave the whole string as
  // the only literal — no host, no user, no credential, no ref — with no signal that coverage
  // collapsed.
  for (const [key, value] of [
    ['SUPABASE_DATABASE_URL', 'host=db.synthref00000.supabase.invalid user=postgres password=pw'],
    ['SUPABASE_URL', 'not a url at all'],
  ]) {
    assert.throws(
      () => secretValuesFrom(buildChildEnv({ ...SYNTH_SOURCE, [key]: value })),
      (e) => {
        assert.equal(e.code, LAUNCHER_CODES.CONFIG_UNPARSABLE);
        assert.deepEqual(e.names, [key]);
        assertClean(e.message, 'CONFIG_UNPARSABLE message');
        return true;
      },
      key,
    );
  }
});

test('redaction: an unparsable configuration value refuses the whole run', async () => {
  const rc = await main(['--execute'], { ...SYNTH_SOURCE, SUPABASE_URL: 'not a url at all' });
  assert.equal(rc, 2, 'the run must refuse before any child is spawned');
});

test('redaction: PEM boundary markers are excluded STRUCTURALLY, short body lines are covered', () => {
  // The previous 24-character floor claimed to exclude the markers and did not: "-----BEGIN
  // CERTIFICATE-----" is 27 characters and "-----END CERTIFICATE-----" is 25, so both cleared it,
  // while a certificate wrapped narrower than 24 columns lost all per-line coverage.
  const shortWrapped = '-----BEGIN CERTIFICATE-----\nSHORTLINEAAAA\nSHORTLINEBBBB\n-----END CERTIFICATE-----';
  const values = secretValuesFrom(buildChildEnv({ ...SYNTH_SOURCE, DATABASE_CA_CERT: shortWrapped }));
  assert.ok(!values.includes('-----BEGIN CERTIFICATE-----'), 'the BEGIN marker must not be a literal');
  assert.ok(!values.includes('-----END CERTIFICATE-----'), 'the END marker must not be a literal');
  assert.ok(values.includes('SHORTLINEAAAA'), 'a narrowly wrapped body line must be covered');
});

test('redaction: a structural PEM sweep covers a certificate the child re-wrapped', () => {
  // Re-wrapped or re-encoded, no literal derived from the environment can match it — but its
  // structure is invariant.
  const rewrapped = '-----BEGIN CERTIFICATE-----\nZZZZ\nYYYY\n-----END CERTIFICATE-----';
  const out = synthRedact()(`trust anchor rejected:\n${rewrapped}\n`);
  assert.ok(out.includes('[REDACTED-PEM]'), 'the PEM block must be redacted structurally');
  assert.ok(!out.includes('ZZZZ') && !out.includes('YYYY'), 'certificate body survived');
});

test('redaction: a RESOLVED address is swept structurally (it is not derivable from the env)', () => {
  const out = synthRedact()('connect ETIMEDOUT 203.0.113.42:6543 / 2001:db8:3333:4444:5555:6666:7777:8888');
  assert.ok(!out.includes('203.0.113.42'), 'the resolved IPv4 address survived');
  assert.ok(!out.includes('2001:db8:3333:4444:5555:6666:7777:8888'), 'the resolved IPv6 address survived');
});

// ---- 5. output size behaviour --------------------------------------------------

test('output limit: overflow FAILS CLOSED and discards the captured text', () => {
  const cap = createCapture(64);
  cap.push(Buffer.from(`head ${SYNTH_DSN}`, 'utf8'));
  cap.push(Buffer.from('x'.repeat(4096), 'utf8'));
  assert.equal(cap.overflowed, true);
  assert.equal(cap.text(), '', 'the buffer is discarded, not truncated mid-secret');
  const report = renderReport({ status: 'closed', exitCode: 0, signal: null, capture: cap }, synthRedact());
  assert.ok(report.includes(LAUNCHER_CODES.OUTPUT_LIMIT_EXCEEDED));
  assertClean(report, 'overflow report');
  assert.equal(
    outcomeCode({ status: 'closed', exitCode: 0, signal: null, capture: cap }),
    LAUNCHER_CODES.OUTPUT_LIMIT_EXCEEDED,
  );
});

test('output limit: a run inside the ceiling is reported normally', () => {
  // THE TRANSCRIPT IS NOW SEALED-GATED AND RE-RENDERED. The child's bytes are no longer forwarded,
  // so a fixture must seal the capture and state that closure was proved — the same two facts the
  // lifecycle establishes on a real run — and what comes back is the line REBUILT from the grammar.
  const cap = createCapture(4096);
  cap.push(Buffer.from('[migrate] baseline: outcome=complete\n', 'utf8'), 'stdout');
  assert.equal(cap.overflowed, false);
  cap.seal();
  const report = renderReport(
    { status: 'closed', exitCode: 0, signal: null, streamsClosed: true, capture: cap }, synthRedact());
  assert.ok(report.includes('outcome=complete'), 'the bounded line survives canonicalisation');
  assert.ok(report.includes('stdoutUnparsable=0'), 'and nothing was discarded');
  // AND WITHOUT THE SEAL nothing is shown at all, whatever the capture holds.
  const unsealed = createCapture(4096);
  unsealed.push(Buffer.from('[migrate] baseline: outcome=complete\n', 'utf8'), 'stdout');
  const withheld = renderReport(
    { status: 'closed', exitCode: 0, signal: null, capture: unsealed }, synthRedact());
  assert.ok(!withheld.includes('outcome=complete'), 'an unsealed capture is never inspected');
});

test('the operator record never carries a length, hash or derived fingerprint', () => {
  assert.ok(!/createHash|digest\(/.test(LAUNCHER_CODE), 'no derived secret material');
  const cap = createCapture();
  cap.push(Buffer.from(SYNTH_DSN, 'utf8'));
  const report = renderReport({ status: 'closed', exitCode: 0, signal: null, capture: cap }, synthRedact());
  assert.ok(!report.includes(String(SYNTH_DSN.length)), 'the secret length must not appear');
});

// ---- 6. spawn and process lifecycle -------------------------------------------

test('lifecycle: raw child output is NEVER forwarded', () => {
  assert.ok(!/pipe\(process\.stdout\)|pipe\(process\.stderr\)/.test(LAUNCHER_CODE), 'no stream piping to the parent');
  assert.ok(!/'inherit'|"inherit"/.test(LAUNCHER_CODE), 'stdio must never be inherited');
  assert.ok(LAUNCHER_CODE.includes("stdio: ['ignore', 'pipe', 'pipe']"), 'stdin ignored, both outputs captured');
});

test('lifecycle: a SYNCHRONOUS spawn throw is a spawn failure, not a child exit', async () => {
  const r = await runChild({
    spawn: () => { throw new Error(`spawn ENOENT ${SYNTH_DSN}`); },
    args: [],
    env: synthEnv(),
  });
  assert.equal(r.status, 'spawn_failed');
  assert.equal(outcomeCode(r), LAUNCHER_CODES.SPAWN_FAILED);
  assertClean(renderReport(r, synthRedact()), 'sync spawn failure report');
});

test('lifecycle: an ASYNCHRONOUS spawn error is a spawn failure, and never printed raw', async () => {
  const r = await runChild({
    spawn: () => {
      const c = fakeChild();
      setImmediate(() => c.emit('error', new Error(`spawn EACCES ${SYNTH_DSN}`)));
      return c;
    },
    args: [],
    env: synthEnv(),
    scan: groupEmpty,
    ...FAST,
  });
  assert.equal(r.status, 'spawn_failed');
  const report = renderReport(r, synthRedact());
  assertClean(report, 'async spawn failure report');
  assert.ok(!report.includes('EACCES'), 'no raw Error message');
  assert.ok(!/\n\s+at /.test(report), 'no stack frame');
});

test('lifecycle: error followed by close settles exactly once', async () => {
  let settlements = 0;
  const r = await runChild({
    spawn: () => {
      const c = fakeChild();
      setImmediate(() => {
        c.emit('error', new Error('boom'));
        c.emit('exit', 1, null);
        c.emit('close', 1, null);
      });
      return c;
    },
    args: [],
    env: synthEnv(),
    scan: groupEmpty,
    ...FAST,
  }).then((v) => { settlements += 1; return v; });
  assert.equal(settlements, 1);
  assert.equal(r.status, 'spawn_failed', 'the first terminal event wins; it is not overwritten by close');
});

test('lifecycle: completion waits for CLOSE, not exit, so no output is truncated', async () => {
  const r = await runChild({
    spawn: () => {
      const c = fakeChild();
      setImmediate(() => {
        c.emit('exit', 0, null);
        // Output still arriving after `exit` — reporting at `exit` would have lost this line.
        c.stdout.emit('data', Buffer.from('[migrate] baseline: outcome=complete\n', 'utf8'));
        c.emit('close', 0, null);
      });
      return c;
    },
    args: [],
    env: synthEnv(),
    scan: groupEmpty,
    ...FAST,
  });
  assert.equal(r.status, 'closed');
  assert.equal(r.exitCode, 0);
  assert.ok(r.capture.text().includes('outcome=complete'), 'post-exit output was captured');
});

test('lifecycle: a timeout that ends on SIGTERM completes cleanup and never reports PASS', async () => {
  const c = fakeChild();
  const sent = [];
  const r = await runChild({
    spawn: () => c,
    args: [],
    env: synthEnv(),
    ...FAST, // spread FIRST: FAST carries a default killGroup that would otherwise win
    // Alive at the deadline, alive when SIGTERM is decided, empty once it has landed.
    scan: scanSeq(groupLeaderAlive, groupLeaderAlive, groupEmpty),
    killGroup: groupKiller(sent, () => {
      setImmediate(() => {
        c.emit('exit', null, 'SIGTERM');
        c.emit('close', null, 'SIGTERM');
      });
      return true;
    }),
  });
  assert.equal(r.status, 'timeout');
  assert.deepEqual(sent, [`${CHILD_PID}/SIGTERM`], 'one SIGTERM, to the GROUP, no escalation once it worked');
  // R2: the direct handle is NOT the containment mechanism any more, and must not be signalled
  // alongside the group — a second delivery path is a second thing that can be got wrong.
  assert.deepEqual(c.signals, [], 'the direct handle is never signalled once a group is verified');
  assert.equal(r.cleanup.closeObserved, true, 'close is the load-bearing termination evidence');
  assert.equal(r.cleanup.groupEmpty, true, 'and the group must be observed empty as well');
  assert.equal(outcomeCode(r), LAUNCHER_CODES.TIMEOUT);
  assert.notEqual(outcomeCode(r), LAUNCHER_CODES.OK, 'a timeout can never produce PASS');
});

test('lifecycle: a stdio stream error is a BOUNDED outcome, not an uncaught exception', async () => {
  // A pipe that emits 'error' with no listener kills the process before renderReport runs — the
  // one path by which text could reach the terminal without passing through the redactor.
  const run = (emit) => {
    const c = fakeChild();
    return runChild({
      spawn: () => {
        setImmediate(() => emit(c));
        return c;
      },
      args: [],
      env: synthEnv(),
      ...FAST, // spread FIRST: FAST carries a default killGroup that would otherwise win
      scan: scanSeq(groupLeaderAlive, groupLeaderAlive, groupEmpty),
      killGroup: () => {
        setImmediate(() => {
          c.emit('exit', null, 'SIGTERM');
          c.emit('close', null, 'SIGTERM');
        });
        return true;
      },
    });
  };
  const r = await run((c) => c.stdout.emit('error', new Error(`EPIPE ${SYNTH_DSN}`)));
  assert.equal(r.status, 'stream_failed');
  assert.equal(outcomeCode(r), LAUNCHER_CODES.STREAM_FAILED);
  assertClean(renderReport(r, synthRedact()), 'stream failure report');
  // Both streams must be guarded, not just stdout.
  const e = await run((c) => c.stderr.emit('error', new Error('EPIPE')));
  assert.equal(e.status, 'stream_failed');
});

test('lifecycle: only a whitelisted errno LABEL escapes a failure object', () => {
  assert.equal(errnoCode({ code: 'ENOENT' }), 'ENOENT');
  assert.equal(errnoCode({ code: 'EACCES' }), 'EACCES');
  // `code` is an arbitrary property on an arbitrary thrown object; a driver error can put a whole
  // connection string there, so the SHAPE is proved before anything is surfaced.
  assert.equal(errnoCode({ code: SYNTH_DSN }), null);
  assert.equal(errnoCode({ code: 'not an errno' }), null);
  assert.equal(errnoCode(new Error('boom')), null);
  assert.equal(errnoCode(null), null);
  assert.equal(errnoCode('ENOENT'), null);
});

test('lifecycle: a real ENOENT surfaces its errno without surfacing argv', async () => {
  const r = await runChild({
    command: resolve(REPO_ROOT, 'no', 'such', 'binary-c2b-r3b-b0'),
    args: [],
    env: synthEnv(),
    timeoutMs: 20_000,
  });
  assert.equal(r.detail, 'ENOENT');
  const report = renderReport(r, synthRedact());
  assert.ok(report.includes('errno=ENOENT'), 'the errno label is the diagnostic that survives');
  assert.ok(!report.includes('binary-c2b-r3b-b0'), 'argv must not appear in the record');
});

test('lifecycle: exit-state evidence is close + exit code, never kill(pid, 0)', () => {
  assert.ok(!/kill\([^)]*,\s*0\)/.test(LAUNCHER_CODE), 'kill(pid, 0) must not be used as exit evidence');
  assert.ok(LAUNCHER_CODE.includes("'/proc'"), 'an independent process-table scan supplies the process-level check');
});

// ---- 7. real local child processes (no network, no database) -------------------

const nodeEval = (code) => ['-e', code];

test('real child: an UNCAUGHT exception carrying a DSN is redacted before disclosure', async () => {
  const env = synthEnv();
  const r = await runChild({
    args: nodeEval("throw new Error('connection refused for ' + process.env.SUPABASE_DATABASE_URL)"),
    env,
    timeoutMs: 20_000,
  });
  assert.equal(r.status, 'closed');
  assert.notEqual(r.exitCode, 0);
  assert.ok(r.capture.text().includes(SYNTH_DSN), 'the child really did print the DSN (the test is not vacuous)');
  const report = renderReport(r, buildRedactor(secretValuesFrom(env)));
  assertClean(report, 'uncaught child exception');
  // THE CLAIM THIS TEST MAKES HAS CHANGED, AND STRENGTHENED. It used to require the disclosure to be
  // REDACTED — present in the record with a marker where the secret had been. That is the weaker of
  // the two outcomes: a marker spliced into a line whose surrounding text is a published constant
  // leaks the matched span by differencing. The line now fails the grammar outright and is discarded
  // unread, so there is nothing to redact and nothing to difference against.
  assert.ok(!report.includes('[REDACTED]'),
    'nothing should need redacting: the raw line must not reach the record at all');
  assert.ok(/stderrUnparsable=[1-9]/.test(report) || /stdoutUnparsable=[1-9]/.test(report),
    'and the discard must be COUNTED, so the loss is stated rather than silent');
});

test('real child: a NONZERO exit is distinct from a spawn failure', async () => {
  const r = await runChild({ args: nodeEval('process.exitCode = 7'), env: synthEnv(), timeoutMs: 20_000 });
  assert.equal(r.status, 'closed');
  assert.equal(r.exitCode, 7);
  assert.equal(outcomeCode(r), LAUNCHER_CODES.CHILD_NONZERO_EXIT);
  assert.notEqual(outcomeCode(r), LAUNCHER_CODES.SPAWN_FAILED);
});

test('real child: a clean exit reports OK', async () => {
  const r = await runChild({
    args: nodeEval("process.stdout.write('[migrate] ok\\n')"),
    env: synthEnv(),
    timeoutMs: 20_000,
  });
  assert.equal(outcomeCode(r), LAUNCHER_CODES.OK);
  assert.equal(r.signal, null);
});

test('real child: a real ENOENT command is a spawn failure', async () => {
  const r = await runChild({
    command: resolve(REPO_ROOT, 'no', 'such', 'binary-c2b-r3b-b0'),
    args: [],
    env: synthEnv(),
    timeoutMs: 20_000,
  });
  assert.equal(r.status, 'spawn_failed');
  assert.equal(outcomeCode(r), LAUNCHER_CODES.SPAWN_FAILED);
});

test('real child: overflow fails closed against a genuinely oversized stream', async () => {
  const r = await runChild({
    args: nodeEval("process.stdout.write('x'.repeat(200000))"),
    env: synthEnv(),
    timeoutMs: 20_000,
    limit: 1024,
  });
  assert.equal(r.capture.overflowed, true);
  assert.equal(r.capture.text(), '');
  assert.equal(outcomeCode(r), LAUNCHER_CODES.OUTPUT_LIMIT_EXCEEDED);
});

test('real child: the spawned child receives EXACTLY the six allowlisted keys', async () => {
  const r = await runChild({
    // The child prints only KEY NAMES, sorted — never a value.
    args: nodeEval('process.stdout.write(Object.keys(process.env).sort().join(","))'),
    env: synthEnv(),
    timeoutMs: 20_000,
  });
  assert.equal(r.status, 'closed');
  assert.equal(r.capture.text(), [...CHILD_ENV_KEYS].sort().join(','));
});

// ============================================================================
// C2B-R3B-B0-R1 — corrections to the B0 launcher.
//
// Everything below is SYNTHETIC and in-process or a local `node -e` child. No DNS, no socket, no
// TLS, no database. The seal cases import a PURE function from the CLI rather than running the CLI
// against a manipulated environment, because a RED mutation of that test would otherwise proceed
// past the seal to `createManagedDevExecutor` and perform a DNS lookup for the configured host.
// ============================================================================

import { sealBreakage } from '../../scripts/supabase-migrate.ts';

const MIGRATE_PATH = resolve(HERE, '..', '..', 'scripts', 'supabase-migrate.ts');
const MIGRATE_CODE = stripComments(readFileSync(MIGRATE_PATH, 'utf8'));

// ---- R1/§3 — the launcher and argument boundary ------------------------------

/** Drive `main()` with an injected spawn, capturing exactly what would have been executed. */
/**
 * THE MIGRATION CHILD'S POST-CLEANUP RECORD, exactly as `runThroughManagedExecutor` writes it:
 * inside its `finally`, on the statement after `await handle.dispose()` resolves. This launcher
 * drives the `baseline` op, so that is the label the child interpolates.
 */
const MIGRATE_TEARDOWN_OK =
  '[migrate] baseline teardown: requested=true completed=true gracefulSocketClose=not_observed code=none';

/**
 * THE POST-DECISION RECORD — the child's last word, and the only line that establishes completion.
 *
 * The teardown record above proves disposal was reached and nothing more: the verdict, the refusal
 * and the exit classification all happen after it, so a realtime signal in that window left it
 * intact while destroying everything it appeared to vouch for. This one is emitted after all of
 * them and is the last thing the child writes to either stream.
 */
const MIGRATE_POST_DECISION_OK =
  '[migrate] baseline terminal: decision=success cleanup=completed exit=success code=none';

/**
 * THE COMPLETE EVIDENCE A CLEAN RUN LEAVES, in the order the child writes it.
 *
 * A synthetic clean run must emit BOTH, because `exitCode=0 signal=null` establishes nothing on its
 * own — that is precisely what a child destroyed by realtime signal 34, 40 or 64 reports — and
 * because neither record alone is now sufficient: the pair is the unit of evidence.
 */
const MIGRATE_TERMINAL_OK = `${MIGRATE_TEARDOWN_OK}\n${MIGRATE_POST_DECISION_OK}`;

/** A fake child that completes the way the real one does: the record pair, then exit + close. */
function completingChild(line = MIGRATE_TERMINAL_OK, exitCode = 0, signal = null) {
  const c = fakeChild();
  setImmediate(() => {
    if (line !== null) c.stdout.emit('data', Buffer.from(`${line}\n`, 'utf8'));
    c.emit('exit', exitCode, signal);
    c.emit('close', exitCode, signal);
  });
  return c;
}

async function captureSpawn(argv = ['--execute'], source = SYNTH_SOURCE) {
  const seen = [];
  const out = [];
  const err = [];
  const status = await main(argv, source, {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    readExecEnv: () => new Map(),
    // The containment seams are injected too: `main()` must never read the real `/proc` for a fake
    // pid, and no test may signal a real process group.
    assertContainment: () => {},
    identify: identifyOk,
    selfIdentity: selfOk,
    killGroup: () => true,
    groupPollMs: 1,
    scan: groupEmpty,
    spawn: (command, args, options) => {
      seen.push({ command, args, options });
      return completingChild();
    },
  });
  return { seen, out, err, status };
}

test('R1/§3: the spawned program, argv, cwd, stdio and environment are exactly the frozen set', async () => {
  const { seen, status } = await captureSpawn();
  assert.equal(seen.length, 1, 'exactly one child is ever spawned');
  const [call] = seen;
  assert.equal(call.command, NODE_BIN, 'the interpreter is the CURRENT absolute Node executable');
  assert.deepEqual(
    call.args,
    [TSX_CLI, MIGRATE_SCRIPT, '--managed-dev', '--baseline', '--confirm-dev', '--baseline-versions=001,002,003,004'],
    'the child argv is exactly the frozen literal — no apply, no version freedom, no caller input',
  );
  assert.equal(call.options.cwd, REPO_ROOT);
  assert.deepEqual(call.options.stdio, ['ignore', 'pipe', 'pipe'], 'stdin ignored; both pipes captured, never inherited');
  assert.deepEqual(Object.keys(call.options.env).sort(), [...CHILD_ENV_KEYS].sort());
  // R2 §4: detached SOLELY to create an isolated group and session. Never a shell, and the pipes
  // stay piped — `detached` must not be allowed to drift into "and also inherit stdio".
  assert.equal(call.options.detached, true, 'the managed child leads its own process group and session');
  assert.equal(call.options.shell, false, 'never a shell: argv must reach exec() uninterpreted');
  assert.equal(status, 0);
});

test('R3/§3: the launcher contains ZERO handle-releasing calls, anywhere, in any spelling', () => {
  // THE SOURCE-LEVEL INVARIANT REQUIRED BY §3, and deliberately the strictest form of it: not "one
  // permitted site", not "not in the hot path" — zero occurrences of the token, in the RAW file,
  // comments included.
  //
  // Scanning the raw source rather than the comment-stripped copy is the point. Every other source
  // assertion in this file runs against LAUNCHER_CODE precisely because the launcher documents
  // constructs it does not use, and a raw scan would read that prose as the construct. Here the
  // opposite is wanted: a comment that still spells the token is a comment describing a mechanism
  // this file must no longer have any relationship with, and leaving one is how the mechanism comes
  // back. The launcher's header states the rule without using the word — which is the only way the
  // rule and this assertion can both hold.
  assert.equal(
    (LAUNCHER_SRC.match(/unref/gi) ?? []).length,
    0,
    'the production launcher must contain no unref token at all — not a call, not a comment',
  );
  // The spellings §3 names, plus the substitutes it forbids in the same breath: a process.exit, a
  // destroyed supervision pipe, or any other route to the same abandonment.
  for (const forbidden of [/\.unref\s*\(/, /child\.unref/, /subprocess\.unref/, /process\.exit\s*\(/, /\.destroy\s*\(/]) {
    assert.ok(!forbidden.test(LAUNCHER_CODE), `forbidden escape construct present: ${forbidden}`);
  }
  // The REPLACEMENT must actually be present. Absence of a release is not containment on its own —
  // §3 explicitly forbids swapping it for an unreferenced timer, so the hold has to be a real,
  // named, referenced mechanism.
  assert.ok(/export function enterContainmentHold/.test(LAUNCHER_CODE), 'the hold is a named exported seam');
  assert.ok(/setIntervalFn\(/.test(LAUNCHER_CODE), 'the hold installs an interval');
});

test('R1/§3: every non-canonical invocation is REFUSED and spawns nothing', async () => {
  const rejected = [
    [],                                        // missing --execute
    ['--execute', '--execute'],                // duplicated
    ['--execute', '--apply'],                  // an extra flag
    ['--execute', '--baseline-versions=005'],  // an alternate baseline list
    ['--execute', 'positional'],               // a positional argument
    ['--apply'],                               // apply mode
    ['--migration', '005'],                    // migration 005
    ['--execute', '--owner-acl'],              // owner ACL mode
    ['--execute', '--production'],             // production mode
    ['--execute', '--script', '/tmp/other.ts'],// an alternate script
    ['--EXECUTE'],                             // case is not a near-miss that passes
    [' --execute'],                            // whitespace is not trimmed into a match
  ];
  for (const argv of rejected) {
    const { seen, err, status } = await captureSpawn(argv);
    assert.equal(seen.length, 0, `spawned a child for: ${JSON.stringify(argv)}`);
    assert.equal(status, 2, `did not refuse: ${JSON.stringify(argv)}`);
    assert.ok(err.join('\n').includes(LAUNCHER_CODES.BAD_INVOCATION), `wrong refusal for ${JSON.stringify(argv)}`);
  }
});

test('R1/§8: neither argv nor the environment can steer the child argv', async () => {
  // A source object carrying migration-related names must change nothing: the child environment is
  // an allowlist and the child argv is a frozen literal, so neither has an input to steer.
  const hostile = {
    ...SYNTH_SOURCE,
    MIGRATION: '005',
    BASELINE_VERSIONS: '001,002,003,004,005',
    SUPABASE_MIGRATION_APPLY: '1',
    npm_config_argv: '--apply',
  };
  const { seen } = await captureSpawn(['--execute'], hostile);
  assert.deepEqual(seen[0].args.slice(2), [...BASELINE_FLAGS]);
  assert.deepEqual(Object.keys(seen[0].options.env).sort(), [...CHILD_ENV_KEYS].sort());
});

test('R1/§8: the CLI dispatch reached by the frozen argv is baseline, and only baseline', () => {
  // The child sees `process.argv.slice(2)` === BASELINE_FLAGS (measured: under both
  // `node tsx/dist/cli.mjs <script>` and `node_modules/.bin/tsx <script>`, argv[1] IS the script).
  const childArgv = [...BASELINE_FLAGS];
  const hasFlag = (f) => childArgv.includes(f);
  const getOpt = (name) => {
    const eq = childArgv.find((a) => a.startsWith(`${name}=`));
    if (eq) return eq.slice(name.length + 1);
    const i = childArgv.indexOf(name);
    if (i >= 0 && i + 1 < childArgv.length && !childArgv[i + 1].startsWith('--')) return childArgv[i + 1];
    return undefined;
  };
  // The CLI's own dispatch order: apply, then baseline, then status.
  assert.equal(hasFlag('--managed-dev'), true, 'the managed route is selected');
  assert.equal(hasFlag('--apply'), false, 'apply is unreachable — the first dispatch branch cannot fire');
  assert.equal(hasFlag('--baseline'), true);
  assert.equal(hasFlag('--status'), false);
  assert.equal(hasFlag('--down'), false);
  assert.equal(hasFlag('--allow-down'), false);
  assert.equal(hasFlag('--resolve-dirty'), false);
  assert.equal(getOpt('--direction'), undefined, 'no direction token exists to resolve');
  assert.equal(getOpt('--migration'), undefined, 'no migration may be named');
  assert.equal(getOpt('--baseline-versions'), '001,002,003,004');

  // ... and the CLI independently refuses any other allowlist on this path.
  assert.match(
    MIGRATE_CODE,
    /const AUTHORIZED_BASELINE_PREFIX = \['001', '002', '003', '004'\] as const;/,
    'the authorized prefix is a frozen literal in the CLI',
  );
  assert.match(
    MIGRATE_CODE,
    /allowlist\.join\(','\) !== AUTHORIZED_BASELINE_PREFIX\.join\(','\)/,
    'the CLI requires EQUALITY with the authorized prefix, not a prefix relation',
  );
  assert.match(MIGRATE_CODE, /if \(wantBaseline\) return runThroughManagedExecutor\('baseline', PRODUCTION_MANAGED_PORTS\);/);
  assert.match(MIGRATE_CODE, /runTrustedHistoricalBaseline\(\{/, 'baseline adopts through the trusted runner');
});

test('R1/§8: the launcher source holds no apply, 005 or owner-ACL construct at all', () => {
  for (const forbidden of ['--apply', '005', 'owner-acl', 'ownerAcl', '--allow-down', '--resolve-dirty']) {
    assert.ok(!LAUNCHER_CODE.includes(forbidden), `the launcher must not contain ${forbidden}`);
  }
  assert.ok(Object.isFrozen(BASELINE_FLAGS), 'the child argv tail is frozen');
});

// ---- R1/§4 — fail-closed process lifecycle -----------------------------------

/**
 * A managed group whose liveness the TEST controls.
 *
 * `alive()` decides what the next scan reports, so a test can make the group empty exactly when its
 * injected signal lands — which is what "SIGKILL actually worked" means in observable terms.
 */
function liveGroup() {
  const state = { alive: true };
  return { state, scan: () => (state.alive ? groupLeaderAlive() : groupEmpty()) };
}

test('R2/§5: a group that IGNORES SIGTERM is escalated to a group-wide SIGKILL, once', async () => {
  const c = fakeChild();
  const g = liveGroup();
  const sent = [];
  const r = await runChild({
    spawn: () => c,
    args: [],
    env: synthEnv(),
    ...FAST,
    scan: g.scan,
    killGroup: groupKiller(sent, (_pgid, sig) => {
      if (sig === 'SIGKILL') {
        g.state.alive = false; // the group actually emptied — the only evidence that counts
        setImmediate(() => {
          c.emit('exit', null, 'SIGKILL');
          c.emit('close', null, 'SIGKILL');
        });
      }
      return true; // SIGTERM is delivered and simply ignored
    }),
  });
  assert.deepEqual(
    sent,
    [`${CHILD_PID}/SIGTERM`, `${CHILD_PID}/SIGKILL`],
    'SIGTERM to the group first, exactly once, then exactly one group SIGKILL',
  );
  assert.deepEqual(c.signals, [], 'the direct handle is never signalled while a group is verified');
  assert.equal(r.status, 'timeout');
  assert.equal(r.cleanup.closeObserved, true);
  assert.equal(r.cleanup.groupEmpty, true);
  assert.equal(outcomeCode(r), LAUNCHER_CODES.TIMEOUT);
  assert.notEqual(outcomeCode(r), LAUNCHER_CODES.OK);
});

test('R2/§5: a GROUP SIGNAL-DELIVERY failure is CLEANUP_INCOMPLETE, never a plain timeout', async () => {
  const r = await runChild({
    spawn: () => fakeChild(),
    args: [],
    env: synthEnv(),
    ...FAST,
    scan: groupLeaderAlive,
    killGroup: () => {
      const e = new Error('no such process');
      e.code = 'ESRCH';
      throw e;
    },
  });
  assert.equal(r.status, 'timeout');
  assert.equal(outcomeCode(r), LAUNCHER_CODES.CLEANUP_INCOMPLETE);
  assert.equal(r.detail, 'ESRCH', 'the errno LABEL survives; the message and stack do not');
  assert.equal(r.cleanup.term, 'delivery_failed');
});

test('R2/§5: no CLOSE after group cleanup is CLEANUP_INCOMPLETE, and claims no exit state', async () => {
  const c = fakeChild(); // accepts every signal, never closes; the group never empties
  const sent = [];
  const r = await runChild({
    spawn: () => c,
    args: [],
    env: synthEnv(),
    ...FAST,
    scan: groupLeaderAlive,
    killGroup: groupKiller(sent),
  });
  assert.deepEqual(sent, [`${CHILD_PID}/SIGTERM`, `${CHILD_PID}/SIGKILL`]);
  assert.equal(r.cleanup.closeObserved, false);
  assert.equal(r.cleanup.groupEmpty, false, 'a surviving member is reported, not rounded away');
  assert.equal(outcomeCode(r), LAUNCHER_CODES.CLEANUP_INCOMPLETE);
  assert.equal(r.exitCode, null, 'an unobserved exit code is never fabricated');
  assert.equal(r.signal, null);
});

test('R2/§5: an EMPTY group is never signalled, but a lagging close is still awaited', async () => {
  const c = fakeChild();
  const sent = [];
  const r = await runChild({
    spawn: () => {
      // `exit` fires, `close` lags behind a stuck pipe, then arrives.
      setImmediate(() => c.emit('exit', 0, null));
      setTimeout(() => c.emit('close', 0, null), 30);
      return c;
    },
    args: [],
    env: synthEnv(),
    ...FAST,
    scan: groupEmpty,
    killGroup: groupKiller(sent),
    timeoutMs: 10,
    cleanupGraceMs: 200,
  });
  // The pgid of an EMPTY group is free for the kernel to reassign the instant the last member
  // leaves, so signalling it is the one way this cleanup could reach a process it never started.
  assert.deepEqual(sent, [], 'an empty group is never signalled');
  assert.equal(r.cleanup.term, 'not_required');
  assert.equal(r.cleanup.closeObserved, true, 'the lagging close is still awaited and observed');
  assert.equal(outcomeCode(r), LAUNCHER_CODES.TIMEOUT, 'it is still a timeout, never a clean close');
});

test('R2/§5: an empty group with no close at all is CLEANUP_INCOMPLETE, not a pass', async () => {
  const c = fakeChild();
  const sent = [];
  const r = await runChild({
    spawn: () => c, // never closes
    args: [],
    env: synthEnv(),
    ...FAST,
    scan: groupEmpty, // ... and nothing is in the group
    killGroup: groupKiller(sent),
  });
  assert.deepEqual(sent, [], 'nothing to signal');
  assert.equal(r.cleanup.kill, 'not_attempted');
  assert.equal(outcomeCode(r), LAUNCHER_CODES.CLEANUP_INCOMPLETE, 'closure was still never established');
});

test('R2/§5: output emitted while terminating is still captured and redacted', async () => {
  const c = fakeChild();
  const g = liveGroup();
  const r = await runChild({
    spawn: () => c,
    args: [],
    env: synthEnv(),
    ...FAST,
    scan: g.scan,
    killGroup: (_pgid, sig) => {
      g.state.alive = false;
      setImmediate(() => {
        c.stdout.emit('data', Buffer.from(`dying with ${SYNTH_DSN}\n`, 'utf8'));
        c.emit('exit', null, sig);
        c.emit('close', null, sig);
      });
      return true;
    },
  });
  assert.ok(r.capture.text().includes(SYNTH_DSN), 'draining continued through cleanup (the test is not vacuous)');
  assertClean(renderReport(r, synthRedact()), 'output captured during cleanup');
});

test('R1/§4: EVERY timeout states DATABASE OUTCOME UNKNOWN and claims neither commit nor rollback', async () => {
  for (const [label, scan, kill] of [
    ['cleanup completed', groupEmpty, undefined],
    ['cleanup incomplete', groupLeaderAlive, undefined],
  ]) {
    const c = fakeChild(kill ? { kill } : {});
    const r = await runChild({ spawn: () => c, args: [], env: synthEnv(), scan, ...FAST });
    const report = renderReport(r, synthRedact());
    assert.ok(report.includes('DATABASE OUTCOME UNKNOWN — DO NOT RE-RUN'), `${label}: mandated line missing`);
    assert.ok(report.includes('NOT reported as committed and NOT reported as rolled back'), `${label}: fate was implied`);
    assert.ok(!/committed\b(?!\s+and)/.test(report.replace('NOT reported as committed and NOT reported as rolled back', '')),
      `${label}: the record must not assert a commit`);
    assert.notEqual(outcomeCode(r), LAUNCHER_CODES.OK, `${label}: a timeout produced PASS`);
    assertClean(report, `${label} report`);
  }
});

test('R2/§5: cleanup targets the VERIFIED ISOLATED GROUP — and exactly one kill site exists', () => {
  // The R1 assertion here was the exact inverse of this one: it required signalling to reach ONLY
  // the direct handle. That is precisely the mechanism the blocking finding rejected — on Linux,
  // ending a parent does not end its descendants — so the assertion is inverted, deliberately.
  //
  // What has NOT changed is the safety property underneath it: exactly one place in this launcher
  // may deliver a signal, and it must be the group form. A second delivery site, a name match, or a
  // pid lifted out of a scan would each be able to reach a process the launcher never started.
  const killSites = LAUNCHER_CODE.match(/process\.kill\([^)]*\)/g) ?? [];
  assert.deepEqual(killSites, ['process.kill(-pgid, sig)'], 'exactly one process.kill, and it is the group form');
  assert.ok(!/kill\([^)]*,\s*0\)/.test(LAUNCHER_CODE), 'kill(pid, 0) is still not used as evidence');
  // Named CONSTRUCTS, not a bare /exec\w*\(/ — that pattern matches `re.exec(src)` in the redactor
  // and would report the regex engine as a shell-out.
  assert.ok(!/pkill|killall|execSync|execFileSync|spawnSync|shell: *true/.test(LAUNCHER_CODE),
    'no name-matched or shelled-out killing');
  assert.match(LAUNCHER_CODE, /send\('SIGTERM'\)/, 'SIGTERM is issued through the guarded sender');
  assert.match(LAUNCHER_CODE, /send\('SIGKILL'\)/, 'and so is the escalation');
  // Only `spawn` is imported from node:child_process — no exec, execFile, fork or spawnSync.
  assert.match(LAUNCHER_CODE, /import \{ spawn as nodeSpawn \} from 'node:child_process';/);
});

test('R2/§4: the parent group is structurally excluded from every signal target', async () => {
  // Each of these makes the managed group collide with one of the launcher's OWN identities. Every
  // one must refuse BEFORE the child is accepted; a group signal that can reach the parent's group
  // is a launcher that can kill its own shell.
  const collisions = [
    ['group_is_parent_pid', { pid: 1000, ppid: 7, pgid: 1000, sid: 1000, starttime: '5' }, { pid: 1000, ppid: 9, pgid: 4, sid: 3 }],
    ['shares_parent_group', { pid: 55, ppid: 7, pgid: 55, sid: 55, starttime: '5' }, { pid: 9, ppid: 8, pgid: 55, sid: 3 }],
    ['shares_parent_session', { pid: 55, ppid: 7, pgid: 55, sid: 55, starttime: '5' }, { pid: 9, ppid: 8, pgid: 4, sid: 55 }],
  ];
  for (const [label, childId, parentId] of collisions) {
    const sent = [];
    const r = await runChild({
      spawn: () => fakeChild({ pid: childId.pid }),
      args: [],
      env: synthEnv(),
      ...FAST,
      identify: () => ({ ...childId }),
      selfIdentity: () => ({ ...parentId }),
      scan: groupLeaderAlive,
      killGroup: groupKiller(sent),
    });
    assert.equal(r.status, 'group_unverified', `${label}: the run must be refused`);
    assert.ok(r.cleanup.names.includes(label), `${label}: the exact collision is named`);
    assert.deepEqual(sent, [], `${label}: no group signal may be issued at all`);
    assert.notEqual(outcomeCode(r), LAUNCHER_CODES.OK, `${label}: never a pass`);
    assert.ok(renderReport(r, synthRedact()).includes(DATABASE_OUTCOME_UNKNOWN), `${label}: outcome stated unknown`);
  }
});

test('R2/§4: a PID or PGID of 0 or 1 is refused outright', async () => {
  for (const bad of [0, 1]) {
    const r = await runChild({
      spawn: () => fakeChild({ pid: bad }),
      args: [],
      env: synthEnv(),
      ...FAST,
      identify: () => ({ pid: bad, ppid: 7, pgid: bad, sid: bad, starttime: '5' }),
      scan: groupLeaderAlive,
    });
    // pid 0/1 never reaches identity verification at all: Node reports an unusable pid only when the
    // fork failed, so this is a spawn failure, not a containment claim. Either way it is not OK, and
    // `kill(-0)` — which means "every process in MY group" — is unreachable.
    assert.notEqual(outcomeCode(r), LAUNCHER_CODES.OK, `pid ${bad} must never pass`);
  }
  assert.ok(!/kill\(\s*-?0\b/.test(LAUNCHER_CODE), 'a literal group id of 0 appears nowhere');
});

test('R2/§5: a RECYCLED leader pid is never escalated against', async () => {
  const sent = [];
  const r = await runChild({
    spawn: () => fakeChild(), // never closes
    args: [],
    env: synthEnv(),
    ...FAST,
    // Alive for the first look, then the pid slot holds a DIFFERENT incarnation.
    scan: scanSeq(groupLeaderAlive, groupLeaderAlive, groupRecycled),
    killGroup: groupKiller(sent),
  });
  assert.deepEqual(sent, [`${CHILD_PID}/SIGTERM`], 'SIGTERM went out while the identity still matched');
  assert.equal(r.cleanup.kill, 'refused_identity_mismatch', 'and escalation stopped once it did not');
  assert.equal(outcomeCode(r), LAUNCHER_CODES.CLEANUP_INCOMPLETE);
  assert.ok(renderReport(r, synthRedact()).includes(DATABASE_OUTCOME_UNKNOWN));
});

test('R1/§4: a signal EXIT is a distinct outcome from a nonzero exit', async () => {
  const r = await runChild({
    spawn: () => {
      const c = fakeChild();
      setImmediate(() => {
        c.emit('exit', null, 'SIGSEGV');
        c.emit('close', null, 'SIGSEGV');
      });
      return c;
    },
    args: [],
    env: synthEnv(),
    ...FAST,
    scan: groupEmpty,
  });
  assert.equal(r.status, 'closed');
  assert.equal(r.signal, 'SIGSEGV');
  assert.equal(outcomeCode(r), LAUNCHER_CODES.CHILD_SIGNALLED);
});

test('R2/§4: a REAL child runs in its own verified group and leaves it empty', async () => {
  // FULLY UN-INJECTED: real spawn, real setsid() via `detached`, real `/proc`, real group scan.
  // Every other lifecycle test in this file stubs those seams; this one proves the defaults work.
  const r = await runChild({
    args: nodeEval("process.stdout.write('ok')"),
    env: synthEnv(),
    timeoutMs: 20_000,
  });
  assert.equal(r.status, 'closed');
  assert.notEqual(r.identity, null, 'the isolated group was READ BACK from the kernel, never assumed');
  assert.equal(r.identity.pid, r.identity.pgid, 'the child leads its own process group');
  assert.equal(r.identity.pid, r.identity.sid, 'and its own session');
  const self = readProcIdentity(process.pid);
  assert.notEqual(r.identity.pgid, self.pid, 'the managed group is not the launcher itself');
  assert.notEqual(r.identity.pgid, self.pgid, 'nor the launcher\'s group — a group signal cannot come back at us');
  assert.notEqual(r.identity.sid, self.sid, 'nor the launcher\'s session');
  assert.equal(r.group.available, true, '/proc was readable, so the observation is real evidence');
  assert.deepEqual(r.group.groupMembers, [], 'no member of the managed group remains');
  assert.deepEqual(r.group.sessionMembers, [], 'and no member of the managed session remains');
  assert.equal(outcomeCode(r), LAUNCHER_CODES.OK);
});

test('R1/§4: the launcher never retries, reconnects or compensates', () => {
  for (const forbidden of ['retry', 'reconnect', 'rollback', 'compensat']) {
    assert.ok(!new RegExp(forbidden, 'i').test(LAUNCHER_CODE), `the launcher must hold no ${forbidden} path`);
  }
  // Exactly one spawn call site.
  assert.equal((LAUNCHER_CODE.match(/spawn\(command, args,/g) ?? []).length, 1);
});

// ---- R1/§7 — overlapping-secret redaction ------------------------------------

const overlapCases = [
  ['one secret wholly INSIDE another', ['abcdefghij', 'cdefgh'], 'x abcdefghij y', 'x [REDACTED] y'],
  ['two secrets sharing a PREFIX', ['commonTAIL1', 'commonTAIL2'], 'a commonTAIL1 b commonTAIL2 c', 'a [REDACTED] b [REDACTED] c'],
  ['two secrets sharing a SUFFIX', ['ONEshared', 'TWOshared'], 'a ONEshared b TWOshared c', 'a [REDACTED] b [REDACTED] c'],
  ['two secrets PARTIALLY overlapping', ['abcdef', 'cdefgh'], 'x abcdefgh y', 'x [REDACTED] y'],
  ['three secrets chained by overlap', ['abcd', 'cdef', 'efgh'], 'x abcdefgh y', 'x [REDACTED] y'],
  ['two ADJACENT secrets merge into one span', ['LEFTX', 'RIGHTY'], 'a LEFTXRIGHTY b', 'a [REDACTED] b'],
  ['a secret CONTAINING the replacement marker', ['pre[REDACTED]post'], 'v=pre[REDACTED]post.', 'v=[REDACTED].'],
  ['a secret that overlaps ITSELF', ['abab'], 'x ababab y', 'x [REDACTED] y'],
];

for (const [label, values, input, expected] of overlapCases) {
  test(`R1/§7 overlap: ${label}`, () => {
    const redact = buildRedactor(values);
    assert.equal(redact(input), expected);
    for (const v of values) assert.ok(!redact(input).includes(v), `${label}: a secret survived`);
    // ORDER-INDEPENDENT by construction: the reversed input set must give the identical result.
    assert.equal(buildRedactor([...values].reverse())(input), expected, `${label}: result depended on input order`);
  });
}

test('R1/§7: an overlapping pair split across stdout CHUNKS is still fully redacted', async () => {
  const r = await runChild({
    spawn: () => {
      const c = fakeChild();
      setImmediate(() => {
        // The overlap point falls INSIDE the chunk boundary, the worst case for a per-chunk redactor.
        c.stdout.emit('data', Buffer.from('head abcd', 'utf8'));
        c.stdout.emit('data', Buffer.from('efgh tail', 'utf8'));
        c.emit('exit', 0, null);
        c.emit('close', 0, null);
      });
      return c;
    },
    args: [],
    env: synthEnv(),
    scan: groupEmpty,
  });
  const redact = buildRedactor(['abcdef', 'cdefgh']);
  assert.equal(redact(r.capture.text()), 'head [REDACTED] tail');
});

test('R1/§7: an overlapping pair arriving on STDERR is fully redacted', async () => {
  const r = await runChild({
    spawn: () => {
      const c = fakeChild();
      setImmediate(() => {
        c.stderr.emit('data', Buffer.from('err abcd', 'utf8'));
        c.stderr.emit('data', Buffer.from('efgh done', 'utf8'));
        c.emit('exit', 1, null);
        c.emit('close', 1, null);
      });
      return c;
    },
    args: [],
    env: synthEnv(),
    scan: groupEmpty,
  });
  assert.equal(buildRedactor(['abcdef', 'cdefgh'])(r.capture.text()), 'err [REDACTED] done');
});

test('R1/§7: a MULTIBYTE code point split across chunks is reassembled before redaction', async () => {
  const secret = 'ключ-тайна';                       // multi-byte throughout
  const bytes = Buffer.from(`v=${secret}!`, 'utf8');
  const cut = 5;                                     // lands mid code point
  const r = await runChild({
    spawn: () => {
      const c = fakeChild();
      setImmediate(() => {
        c.stdout.emit('data', bytes.subarray(0, cut));
        c.stdout.emit('data', bytes.subarray(cut));
        c.emit('exit', 0, null);
        c.emit('close', 0, null);
      });
      return c;
    },
    args: [],
    env: synthEnv(),
    scan: groupEmpty,
  });
  assert.equal(r.capture.text(), `v=${secret}!`, 'Buffer.concat before toString reassembles the split');
  assert.equal(buildRedactor([secret])(r.capture.text()), 'v=[REDACTED]!');
});

test('R1/§7: the structural and literal passes MERGE rather than fight', () => {
  // A certificate whose body is ALSO a derived literal: the PEM range and the line range overlap,
  // and the merged span must be replaced exactly once rather than nested or double-marked.
  const redact = buildRedactor([SYNTH_CA_LINE_A, SYNTH_CA]);
  const out = redact(`ca=${SYNTH_CA}\n`);
  assertClean(out, 'merged structural/literal span');
  assert.equal((out.match(/\[REDACTED/g) ?? []).length, 1, 'one span, one marker');
});

test('R1/§7: redaction is computed against the ORIGINAL text, never against its own output', () => {
  assert.ok(!/out = out\.replace/.test(LAUNCHER_CODE), 'no sequential self-referential replacement');
  assert.ok(!/out\.split\(v\)\.join/.test(LAUNCHER_CODE), 'no sequential split/join passes');
  assert.match(LAUNCHER_CODE, /ranges\.sort/, 'ranges are sorted');
  assert.match(LAUNCHER_CODE, /r\.start <= last\.end/, 'overlapping and adjacent ranges are merged');
});

// ---- R1/§5 — the EXACT historical-baseline environment seal -------------------

const SEALED_SIX = {
  SUPABASE_DATABASE_URL: SYNTH_DSN,
  SUPABASE_URL: SYNTH_API_URL,
  DATABASE_CA_CERT: SYNTH_CA,
  ALLOW_SUPABASE_MIGRATION_APPLY: '1',
  CONFIRM_SUPABASE_TARGET: 'tmpos2026-dev',
  NODE_ENV: 'development',
};
const sealedMap = (extra = {}) => new Map(Object.entries({ ...SEALED_SIX, ...extra }));
const SEALED_BASELINE_NAMES = Object.keys(SEALED_SIX);

test('R1/§5: the exact six-key environment is the ONLY baseline environment that passes', () => {
  assert.deepEqual(sealBreakage('baseline', sealedMap(), { ...SEALED_SIX }), []);
});

const sealCases = [
  ['one extra ordinary variable', { EDITOR: 'vi' }],
  ['PATH', { PATH: '/usr/bin' }],
  ['HOME', { HOME: '/home/runner' }],
  ['a lowercase npm variable', { npm_config_registry: 'https://example.invalid' }],
  ['an uppercase NPM variable', { NPM_CONFIG_LOGLEVEL: 'silly' }],
  ['npm_lifecycle_event', { npm_lifecycle_event: 'identity:migrate' }],
  ['PGHOST', { PGHOST: 'elsewhere.invalid' }],
  ['PGPORT', { PGPORT: '5432' }],
  ['PGUSER', { PGUSER: 'other' }],
  ['PGPASSWORD', { PGPASSWORD: 'x' }],
  ['PGDATABASE', { PGDATABASE: 'other' }],
  ['PGSSLMODE', { PGSSLMODE: 'disable' }],
  ['PGSERVICEFILE', { PGSERVICEFILE: '/tmp/svc' }],
  ['NODE_OPTIONS', { NODE_OPTIONS: '--require ./x' }],
  ['NODE_EXTRA_CA_CERTS', { NODE_EXTRA_CA_CERTS: '/tmp/ca.pem' }],
  ['NODE_TLS_REJECT_UNAUTHORIZED', { NODE_TLS_REJECT_UNAUTHORIZED: '0' }],
  ['OPENSSL_CONF', { OPENSSL_CONF: '/tmp/openssl.cnf' }],
  ['SSL_CERT_FILE', { SSL_CERT_FILE: '/tmp/certs.pem' }],
  ['SSL_CERT_DIR', { SSL_CERT_DIR: '/tmp/certs' }],
];

for (const [label, extra] of sealCases) {
  test(`R1/§5 baseline seal refuses ${label} — on EITHER side`, () => {
    const [name] = Object.keys(extra);
    // Present at EXEC time only (the live object was sanitised afterwards).
    const execSide = sealBreakage('baseline', sealedMap(extra), { ...SEALED_SIX });
    assert.ok(execSide.length > 0, `${label}: an exec-time addition passed`);
    assert.ok(execSide.some((n) => n.includes(name)), `${label}: exec-side divergence not named`);
    // Added AFTER exec (the driver would still read it).
    const liveSide = sealBreakage('baseline', sealedMap(), { ...SEALED_SIX, ...extra });
    assert.ok(liveSide.length > 0, `${label}: a post-exec addition passed`);
    assert.ok(liveSide.some((n) => n.includes(name)), `${label}: live-side divergence not named`);
  });
}

test('R1/§5: a MISSING authorized name is refused too, and named with its direction', () => {
  const { NODE_ENV, ...five } = SEALED_SIX;
  const broken = sealBreakage('baseline', new Map(Object.entries(five)), { ...five });
  assert.ok(broken.includes('exec:-NODE_ENV'), 'the absent name is reported as absent');
  assert.ok(broken.includes('live:-NODE_ENV'));
});

const valueCases = [
  ['the DSN', 'SUPABASE_DATABASE_URL', 'postgresql://other:pw@elsewhere.invalid:6543/postgres'],
  ['the API URL', 'SUPABASE_URL', 'https://otherref.supabase.invalid'],
  ['the CA certificate', 'DATABASE_CA_CERT', '-----BEGIN CERTIFICATE-----\nOTHER\n-----END CERTIFICATE-----'],
  ['the apply gate', 'ALLOW_SUPABASE_MIGRATION_APPLY', '0'],
  ['the target confirmation', 'CONFIRM_SUPABASE_TARGET', 'tmpos2026-prod'],
  ['NODE_ENV', 'NODE_ENV', 'production'],
];

for (const [label, name, mutated] of valueCases) {
  test(`R1/§5 baseline seal refuses a post-exec change to ${label}`, () => {
    const broken = sealBreakage('baseline', sealedMap(), { ...SEALED_SIX, [name]: mutated });
    assert.ok(broken.length > 0, `${label}: a rewritten value passed`);
    assert.ok(broken.some((n) => n.includes(name)), `${label}: the diverged name was not reported`);
    // NAMES ONLY — neither the sealed value nor the mutation may appear.
    for (const n of broken) {
      assert.ok(!n.includes(mutated), `${label}: the mutated VALUE leaked into the refusal`);
      assert.ok(!n.includes(SEALED_SIX[name]), `${label}: the sealed VALUE leaked into the refusal`);
    }
  });
}

test('R1/§5: the NON-baseline managed modes are NOT broadened by the exact-set seal', () => {
  // The very environment the baseline refuses must still pass for status and apply, whose
  // authorization this stage did not touch. Their previous contract is value-stability plus the
  // forbidden-name sweep — nothing more, and nothing less.
  const ambient = { ...SEALED_SIX, PATH: '/usr/bin', HOME: '/home/runner', LANG: 'C.UTF-8' };
  const ambientMap = new Map(Object.entries(ambient));
  assert.ok(sealBreakage('baseline', ambientMap, ambient).length > 0, 'baseline must refuse an ambient shell');
  assert.deepEqual(sealBreakage('status', ambientMap, ambient), [], 'status is unchanged');
  assert.deepEqual(sealBreakage('apply(up)', ambientMap, ambient), [], 'apply is unchanged');
  // ... but the forbidden-name sweep still applies to them, exactly as before.
  const withPg = { ...ambient, PGHOST: 'x.invalid' };
  assert.ok(sealBreakage('status', new Map(Object.entries(withPg)), withPg).includes('PGHOST'));
  assert.ok(sealBreakage('apply(up)', new Map(Object.entries(withPg)), withPg).includes('PGHOST'));
});

test('R1/§5: an unreadable /proc/self/environ REFUSES before any client is constructed', () => {
  assert.match(
    MIGRATE_CODE,
    /readFileSync\('\/proc\/self\/environ', 'utf8'\);\s*\}\s*catch\s*\{\s*refuse\(/,
    'an unreadable exec environment must refuse, never fall back to process.env',
  );
  assert.match(
    MIGRATE_CODE,
    /assertSealedManagedEnvironment\(op\);[\s\S]{0,200}?createManagedDevExecutor/,
    'the seal is the LAST assertion before the managed client exists',
  );
  assert.ok(
    !/sealBreakage\([^)]*\)\s*\?\?/.test(MIGRATE_CODE),
    'the seal result is never defaulted away',
  );
});

// ---- R1/§6 — managed child error containment ---------------------------------

test('R1/§6: the managed-baseline FATAL handler emits ONE fixed code, never err.message', () => {
  const fatal = MIGRATE_CODE.match(/main\(\)\.catch\(\(err\) => \{[\s\S]*?\n\}\);/);
  assert.ok(fatal, 'the top-level handler must exist');
  const body = fatal[0];
  assert.match(body, /if \(managedRun\) \{/, 'the managed path is branched first');
  const baselineBranch = body.slice(body.indexOf('if (managedRun)'), body.indexOf('return;'));
  assert.match(baselineBranch, /MANAGED_RUN_FAILURE/, 'a fixed bounded code');
  assert.ok(!/err\.message/.test(baselineBranch), 'no raw message');
  assert.ok(!/err\.stack/.test(baselineBranch), 'no stack');
  assert.ok(!/String\(err\)|JSON\.stringify\(err\)|\$\{err\}/.test(baselineBranch), 'no serialized Error');
  assert.ok(!/process\.argv|process\.env/.test(baselineBranch), 'no argv and no environment value');
  assert.match(MIGRATE_CODE, /const MANAGED_RUN_FAILURE = 'migration_managed_run_failed';/);
  // WIDER than the baseline on purpose: status and apply construct a client against the SAME managed
  // DSN, so the identical driver-error leak is reachable from them.
  assert.match(MIGRATE_CODE, /const managedRun = wantManagedDev;/);
});

test('R1/§6: the managed runner maps every escaping failure to a bounded code', () => {
  // Inside the managed runner, the only thing that crosses the catch boundary is an executor code
  // or the stable fail-closed reason — never a driver message.
  //
  // R4-R2 — THE THROW LATCH IS PINNED HERE TOO, in the same expression. It is what lets the
  // post-decision record say `decision=failed` rather than `refused`, and it is a bare boolean: it
  // carries no part of `err`, so admitting it into this pattern widens nothing.
  assert.match(
    MIGRATE_CODE,
    /catch \(err\) \{\s*threw = true;\s*const code = err instanceof MigrationExecutorError \? err\.code : PG_VALIDATION_REQUIRED;\s*refusal = `\$\{op\} refused before completion: \$\{code\}\.`;/,
    'the managed runner surfaces a code and nothing else',
  );
});

test('R1/§6: a child-side failure carrying EVERY secret shape reaches the record redacted', async () => {
  const env = synthEnv();
  // One child, one throw, carrying: the complete DSN, the encoded and decoded credential, the
  // hostname, the API URL and the multiline certificate.
  const r = await runChild({
    args: nodeEval(
      'const e = process.env;' +
        "throw new Error('managed failure ' + e.SUPABASE_DATABASE_URL + ' | ' + " +
        "new URL(e.SUPABASE_DATABASE_URL).password + ' | ' + " +
        "decodeURIComponent(new URL(e.SUPABASE_DATABASE_URL).password) + ' | ' + " +
        "new URL(e.SUPABASE_DATABASE_URL).hostname + ' | ' + e.SUPABASE_URL + ' | ' + e.DATABASE_CA_CERT)",
    ),
    env,
    timeoutMs: 20_000,
  });
  assert.equal(r.status, 'closed');
  assert.notEqual(r.exitCode, 0);
  const raw = r.capture.text();
  // NOT VACUOUS: the child really did print every shape.
  for (const shape of [SYNTH_DSN, SYNTH_PASSWORD_ENCODED, SYNTH_PASSWORD_DECODED, SYNTH_DB_HOST, SYNTH_API_URL, SYNTH_CA_LINE_A]) {
    assert.ok(raw.includes(shape), `the child did not actually emit ${shape.slice(0, 14)}…`);
  }
  const report = renderReport(r, buildRedactor(secretValuesFrom(env)));
  assertClean(report, 'managed child failure report');
  assert.ok(!report.includes('-----BEGIN'), 'the certificate body is structurally swept as well');
});

// ---- R1 review findings: cleanup must own the settlement --------------------

test('R1/§4: a STREAM error during cleanup does not replace the timeout outcome', async () => {
  // Terminating a child routinely breaks its pipes. If EPIPE settled as `stream_failed`, the record
  // would lose DATABASE OUTCOME UNKNOWN for a child that may have been mid-COMMIT.
  const c = fakeChild();
  const r = await runChild({
    spawn: () => {
      c.kill = (sig) => {
        c.signals.push(sig);
        setImmediate(() => c.stdout.emit('error', new Error(`EPIPE ${SYNTH_DSN}`)));
        return true;
      };
      return c;
    },
    args: [],
    env: synthEnv(),
    scan: groupLeaderAlive,
    ...FAST,
  });
  assert.equal(r.status, 'timeout', 'a broken pipe caused by our own SIGTERM is not a stream failure');
  assert.equal(outcomeCode(r), LAUNCHER_CODES.CLEANUP_INCOMPLETE);
  const report = renderReport(r, synthRedact());
  assert.ok(report.includes('DATABASE OUTCOME UNKNOWN — DO NOT RE-RUN'), 'the mandated line survived');
  assertClean(report, 'stream error during cleanup');
});

test('R1/§4: an async signal-delivery error during cleanup is CLEANUP_INCOMPLETE, not a spawn failure', async () => {
  const c = fakeChild();
  const r = await runChild({
    spawn: () => c,
    args: [],
    env: synthEnv(),
    ...FAST,
    scan: groupLeaderAlive,
    killGroup: () => {
      // Node reports an undeliverable signal on the subprocess's own `error` event, AFTER the kill
      // call has already returned successfully.
      setImmediate(() => {
        const e = new Error('kill EPERM');
        e.code = 'EPERM';
        c.emit('error', e);
      });
      return true;
    },
  });
  assert.equal(r.status, 'timeout', 'never mislabelled as a spawn failure');
  assert.equal(outcomeCode(r), LAUNCHER_CODES.CLEANUP_INCOMPLETE);
  assert.equal(r.detail, 'EPERM', 'the errno label is folded into the timeout result');
  assert.ok(renderReport(r, synthRedact()).includes('DATABASE OUTCOME UNKNOWN — DO NOT RE-RUN'));
});

test('R1/§4: a throwing process scan cannot hang the launcher or escape as a stack', async () => {
  // `done()` latches `settled` before resolving, so an unguarded throw from the scan would leave the
  // promise permanently unresolved — a hang with no report at all — and print a stack from inside an
  // EventEmitter listener.
  const r = await runChild({
    spawn: () => {
      const c = fakeChild();
      setImmediate(() => {
        c.emit('exit', 0, null);
        c.emit('close', 0, null);
      });
      return c;
    },
    args: [],
    env: synthEnv(),
    ...FAST,
    scan: () => {
      throw new Error(`/proc exploded ${SYNTH_DSN}`);
    },
  });
  // The outcome SURVIVES — the launcher neither hangs nor lets a stack escape — but it is not OK.
  // An unobservable group is missing termination evidence, never evidence of termination, so a clean
  // `close` with a zero exit is deliberately not enough: it hands over to bounded cleanup instead.
  assert.equal(r.status, 'group_residual', 'the outcome is still reported, and reported honestly');
  assert.deepEqual(
    r.group,
    { available: false, pidPresent: null, leaderIdentityMatches: null, groupMembers: null, sessionMembers: null },
    'an unavailable scan is a missing observation, not a lost outcome',
  );
  assert.equal(outcomeCode(r), LAUNCHER_CODES.CLEANUP_INCOMPLETE, 'an unobservable group cannot pass');
  const report = renderReport(r, synthRedact());
  assert.ok(report.includes(DATABASE_OUTCOME_UNKNOWN), 'and the mandated line is present');
  assert.ok(!/\n\s+at /.test(report), 'no stack frame escaped the throwing scan');
  assertClean(report, 'report after a throwing scan');
});

test('R1/§4: a throwing scan during timeout CLEANUP still settles, and still says UNKNOWN', async () => {
  // `handleTimeout` runs as `void handleTimeout()` — nothing awaits it. An unguarded throw at the
  // escalation decision would therefore never reach `done()`: the promise would never settle, the
  // launcher would hang, and the mandated line would be lost for a child that may be mid-COMMIT.
  const c = fakeChild();
  const r = await runChild({
    spawn: () => c, // never closes; accepts every signal
    args: [],
    env: synthEnv(),
    scan: () => {
      throw new Error(`/proc exploded ${SYNTH_DSN}`);
    },
    ...FAST,
  });
  assert.equal(r.status, 'timeout');
  assert.deepEqual(c.signals, ['SIGTERM', 'SIGKILL'], 'an unreadable process table escalates anyway — the fail-closed direction');
  assert.equal(outcomeCode(r), LAUNCHER_CODES.CLEANUP_INCOMPLETE);
  const report = renderReport(r, synthRedact());
  assert.ok(report.includes('DATABASE OUTCOME UNKNOWN — DO NOT RE-RUN'));
  assertClean(report, 'throwing scan during cleanup');
});

// ---- R1 cross-model findings ------------------------------------------------

test('R1/§4: a stream failure with a LIVE child runs cleanup and states the outcome is unknown', async () => {
  // The defect this closes: settling instantly on a broken pipe cleared the deadline and returned
  // while the child was still running — an orphan holding a session-scoped advisory lock, free to
  // commit AFTER the launcher had reported and exited, with nothing saying the outcome was unknown.
  const c = fakeChild();
  const sent = [];
  const r = await runChild({
    spawn: () => {
      setImmediate(() => c.stdout.emit('error', new Error('EPIPE')));
      return c; // never closes on its own, and ignores signals
    },
    args: [],
    env: synthEnv(),
    ...FAST,
    scan: groupLeaderAlive,
    killGroup: groupKiller(sent),
  });
  assert.equal(r.status, 'stream_failed', 'the reason is preserved');
  assert.deepEqual(
    sent,
    [`${CHILD_PID}/SIGTERM`, `${CHILD_PID}/SIGKILL`],
    'the live GROUP was terminated, not abandoned — losing the pipe loses the evidence, not the child',
  );
  assert.equal(outcomeCode(r), LAUNCHER_CODES.CLEANUP_INCOMPLETE);
  const report = renderReport(r, synthRedact());
  assert.ok(report.includes(DATABASE_OUTCOME_UNKNOWN), 'a live-child stream failure is an unknown outcome');
});

test("R1/§4: the record's LAST word is the unknown outcome, not the child's commit claim", async () => {
  const c = fakeChild();
  const r = await runChild({
    spawn: () => {
      c.kill = (sig) => {
        c.signals.push(sig);
        setImmediate(() => {
          c.emit('exit', null, sig);
          c.emit('close', null, sig);
        });
        return true;
      };
      setImmediate(() => c.stdout.emit('data', Buffer.from('[migrate] baseline: commit=committed\n', 'utf8')));
      return c;
    },
    args: [],
    env: synthEnv(),
    scan: groupEmpty,
    ...FAST,
  });
  const lines = renderReport(r, synthRedact()).split('\n');
  // THIS RUN'S CLOSURE WAS NEVER PROVED — the child was signalled and its pipes never ended — so the
  // transcript is WITHHELD rather than shown. That is the stronger outcome and the one the ordering
  // property was standing in for: a claim the parent cannot confirm is not printed at all.
  assert.ok(!lines.some((l) => l.includes('commit=committed')),
    'an unproved capture must not surface the child\'s commit claim');
  assert.ok(lines.some((l) => l.includes('child-output-withheld')), 'and says so in fixed words');
  assert.ok(lines[lines.length - 1].includes('UNVERIFIED'), 'the final line disclaims the commit claim');

  // AND WHERE CLOSURE *IS* PROVED, the ordering property still holds: the claim renders, and the
  // unknown-outcome line follows it. Driven separately so neither half can pass for the other.
  const sealed = createCapture();
  sealed.push(Buffer.from('[migrate] baseline: commit=committed\n', 'utf8'), 'stdout');
  sealed.seal();
  const ordered = renderReport(
    { ...r, status: 'closed', streamsClosed: true, capture: sealed }, synthRedact()).split('\n');
  const claim = ordered.findIndex((l) => l.includes('commit=committed'));
  const unknown = ordered.findIndex((l) => l.includes(DATABASE_OUTCOME_UNKNOWN));
  assert.ok(claim >= 0, 'the child really did claim a commit (the test is not vacuous)');
  assert.ok(unknown > claim, "the unknown-outcome line must follow the child's claim, never precede it");
  assert.ok(ordered[lines.length - 1] !== undefined);
});

test('R1/§7: the PEM sweep is LINEAR — unmatched BEGIN markers cannot amplify cost', () => {
  // The lazy-span pattern this replaces cost ~1s of synchronous CPU at the 64 KiB ceiling on an
  // input of nothing but BEGIN markers, and ~4x that at double the size: quadratic, and chosen by
  // whatever the child prints.
  const redact = buildRedactor([]);
  const hostile = '-----BEGIN CERTIFICATE-----'.repeat(2400); // ~64 KiB, no END anywhere
  const started = Date.now();
  const out = redact(hostile);
  const elapsed = Date.now() - started;
  assert.equal(out, hostile, 'an unpaired BEGIN marker is not a PEM block and is left alone');
  assert.ok(elapsed < 750, `the sweep must stay linear; took ${elapsed}ms`);
  // Doubling the input must not quadruple the cost.
  const started2 = Date.now();
  redact(hostile + hostile);
  assert.ok(Date.now() - started2 < 1500, 'cost must scale linearly with input size');
});

test('R1/§7: a well-formed PEM block is still swept, and only to its own END marker', () => {
  const redact = buildRedactor([]);
  const two = `a${SYNTH_CA}b${SYNTH_CA}c`;
  const out = redact(two);
  assert.equal(out, 'a[REDACTED-PEM]b[REDACTED-PEM]c', 'each block is paired with its OWN end marker');
  assertClean(out, 'paired PEM blocks');
});

test('R1/§3: the child argv array is FROZEN, so a spawn implementation cannot extend it', async () => {
  let threw = null;
  const { seen } = await captureSpawn(['--execute'], SYNTH_SOURCE);
  assert.ok(Object.isFrozen(seen[0].args), 'the argv handed to spawn is frozen');
  try {
    seen[0].args.push('--apply');
  } catch (e) {
    threw = e;
  }
  assert.ok(threw instanceof TypeError, 'appending --apply must throw, not silently succeed');
  assert.deepEqual(seen[0].args.slice(2), [...BASELINE_FLAGS]);
});

test('R1/§5: the exact-set seal compares SETS, not joined strings', () => {
  // `['A','B,C'].join(',')` equals `['A','B','C'].join(',')`, and an environment NAME may contain a
  // comma — the kernel forbids only '=' and NUL. A joined comparison can be satisfied by a set that
  // is not the authorized one.
  // A SINGLE key whose name is the six authorized names joined by commas. Under a joined-string
  // comparison its sorted join is byte-identical to the authorized one, so the set check passes —
  // and because none of the six then exists, every value comparison is undefined === undefined and
  // passes too. The seal would report an environment holding ONE arbitrary variable as intact.
  const joined = [...SEALED_BASELINE_NAMES].sort().join(',');
  const collided = { [joined]: 'x' };
  const broken = sealBreakage('baseline', new Map(Object.entries(collided)), collided);
  assert.ok(broken.length > 0, 'a comma-bearing name must not satisfy the exact-set check');
  assert.ok(broken.some((n) => n.includes(`+${joined}`)), 'the colliding name is reported');
  assert.ok(broken.some((n) => n === 'exec:-NODE_ENV'), 'and the genuinely absent names are reported too');
});

// ---- R2/§8 — process-group containment, synthetic and real -------------------
//
// The synthetic cases below drive the lifecycle through injected seams. The REAL cases at the end
// create genuine local processes — a grandchild that outlives its parent — because a fake
// ChildProcess object cannot demonstrate reparenting, and reparenting is the whole finding.

test('R2/§8: a child whose GRANDCHILD also exits normally reports OK', async () => {
  // Both members gone by the terminal observation: this is the ordinary successful run, and it must
  // stay ordinary — a containment check that flags every healthy run teaches operators to ignore it.
  const c = fakeChild();
  const r = await runChild({
    spawn: () => {
      setImmediate(() => {
        c.emit('exit', 0, null);
        c.emit('close', 0, null);
      });
      return c;
    },
    args: [],
    env: synthEnv(),
    ...FAST,
    // Two members while running, empty once both have exited.
    scan: scanSeq(() => observation({ groupMembers: [CHILD_PID, CHILD_PID + 1] }), groupEmpty),
  });
  assert.equal(r.status, 'closed');
  assert.equal(outcomeCode(r), LAUNCHER_CODES.OK);
});

test('R2/§8: a GRANDCHILD that ignores SIGTERM is reached by the group-wide SIGKILL', async () => {
  const c = fakeChild();
  const sent = [];
  let survivors = [CHILD_PID, CHILD_PID + 1];
  const r = await runChild({
    spawn: () => c,
    args: [],
    env: synthEnv(),
    ...FAST,
    scan: () => observation({ groupMembers: [...survivors], pidPresent: survivors.includes(CHILD_PID), leaderIdentityMatches: survivors.includes(CHILD_PID) ? true : null }),
    killGroup: groupKiller(sent, (_pgid, sig) => {
      // SIGTERM ends the direct child; the GRANDCHILD ignores it entirely. Only the group-wide
      // SIGKILL reaches the grandchild — a signal to the direct handle never could have.
      if (sig === 'SIGTERM') survivors = [CHILD_PID + 1];
      if (sig === 'SIGKILL') {
        survivors = [];
        setImmediate(() => {
          c.emit('exit', null, 'SIGTERM');
          c.emit('close', null, 'SIGTERM');
        });
      }
      return true;
    }),
  });
  assert.deepEqual(sent, [`${CHILD_PID}/SIGTERM`, `${CHILD_PID}/SIGKILL`]);
  assert.equal(r.cleanup.groupEmpty, true, 'the grandchild was reached, not merely the parent');
  assert.equal(outcomeCode(r), LAUNCHER_CODES.TIMEOUT);
  assert.notEqual(outcomeCode(r), LAUNCHER_CODES.OK);
});

test('R2/§6: a zero exit CANNOT pass while a GROUP member survives', async () => {
  // The precise failure the blocking finding named: a grandchild that closes its inherited stdio
  // and keeps running makes `close` arrive with a perfect exit code while the process is still
  // there. `close` is necessary and not sufficient.
  const c = fakeChild();
  const sent = [];
  const r = await runChild({
    spawn: () => {
      setImmediate(() => {
        c.emit('exit', 0, null);
        c.emit('close', 0, null); // stdio closed — the child looks finished
      });
      return c;
    },
    args: [],
    env: synthEnv(),
    ...FAST,
    scan: groupOrphan, // ... but a descendant is still in the group
    killGroup: groupKiller(sent),
  });
  assert.equal(r.status, 'group_residual', 'a surviving member is not a clean close');
  assert.notEqual(outcomeCode(r), LAUNCHER_CODES.OK, 'and it can never be OK');
  assert.equal(outcomeCode(r), LAUNCHER_CODES.CLEANUP_INCOMPLETE);
  assert.deepEqual(sent, [`${CHILD_PID}/SIGTERM`, `${CHILD_PID}/SIGKILL`], 'bounded group cleanup still ran');
  assert.ok(renderReport(r, synthRedact()).includes(DATABASE_OUTCOME_UNKNOWN));
});

test('R2/§6: a zero exit CANNOT pass while a SESSION member survives', async () => {
  // A member that called setpgid() out of the managed group is still inside the managed SESSION,
  // and a group-only check would declare the run clean.
  const c = fakeChild();
  const r = await runChild({
    spawn: () => {
      setImmediate(() => {
        c.emit('exit', 0, null);
        c.emit('close', 0, null);
      });
      return c;
    },
    args: [],
    env: synthEnv(),
    ...FAST,
    scan: sessionOnly,
  });
  assert.equal(r.status, 'group_residual');
  assert.notEqual(outcomeCode(r), LAUNCHER_CODES.OK);
  assert.equal(r.cleanup.sessionMembers, 1, 'the session residual is reported, not rounded away');
  assert.ok(renderReport(r, synthRedact()).includes(DATABASE_OUTCOME_UNKNOWN));
});

test('R2/§4: an unreadable /proc BEFORE the spawn refuses the whole run', async () => {
  const seen = [];
  const err = [];
  const status = await main(['--execute'], SYNTH_SOURCE, {
    out: () => {},
    err: (l) => err.push(l),
    readExecEnv: () => new Map(),
    assertContainment: () => {
      throw new LauncherRefusal(LAUNCHER_CODES.PROCFS_UNAVAILABLE);
    },
    spawn: (...a) => {
      seen.push(a);
      return fakeChild();
    },
  });
  assert.equal(status, 2, 'a pre-execution refusal, not a run');
  assert.deepEqual(seen, [], 'nothing is spawned when the containment mechanism is unavailable');
  assert.ok(err.join('\n').includes(LAUNCHER_CODES.PROCFS_UNAVAILABLE));
});

test('R2/§4: a non-Linux platform is refused before any spawn', () => {
  assert.throws(
    () => assertContainmentPreconditions('darwin', () => ''),
    (e) => e instanceof LauncherRefusal && e.code === LAUNCHER_CODES.PLATFORM_UNSUPPORTED,
    'process groups and /proc are Linux mechanisms; elsewhere the claim cannot be supported',
  );
  assert.throws(
    () => assertContainmentPreconditions('linux', () => {
      throw new Error('ENOENT');
    }),
    (e) => e instanceof LauncherRefusal && e.code === LAUNCHER_CODES.PROCFS_UNAVAILABLE,
  );
  // And the happy path does not throw.
  assertContainmentPreconditions('linux', () => '1 (node) S 0 1 1 0');
});

test('R2/§8: EVERY incomplete result ends with DATABASE OUTCOME UNKNOWN', async () => {
  // Enumerated from the source rather than hand-listed, so a status added later without the
  // mandated line fails here instead of shipping quietly.
  for (const status of CLEANUP_STATUSES) {
    const result = {
      status,
      code: LAUNCHER_CODES.CLEANUP_INCOMPLETE,
      detail: null,
      pid: CHILD_PID,
      exitCode: null,
      signal: null,
      capture: createCapture(),
      group: groupOrphan(),
      identity: { ...CHILD_ID },
      cleanup: { term: 'sent', kill: 'sent', closeObserved: false, groupVerified: true, groupEmpty: false, members: 1, sessionMembers: 0 },
    };
    const lines = renderReport(result, synthRedact()).split('\n');
    assert.ok(lines.at(-1).includes('UNVERIFIED'), `${status}: the last line must be the unverified caveat`);
    assert.ok(lines.some((l) => l.includes(DATABASE_OUTCOME_UNKNOWN)), `${status}: mandated line missing`);
    assert.notEqual(outcomeCode(result), LAUNCHER_CODES.OK, `${status}: must never be OK`);
  }
});

test('R2/§9: the report never claims an observed graceful database-socket close', () => {
  const result = evidenced();
  const report = renderReport(result, synthRedact());
  assert.ok(report.includes('VERIFIED TERMINAL CLEANUP'), 'a fully evidenced run is classified as such');
  assert.ok(
    report.includes('graceful database-socket close observability: NOT OBSERVED by this launcher (OPEN/LOW)'),
    'and the residual is stated, never left to be inferred from an empty group',
  );
  // The incomplete classification is the other side of the same line.
  const partial = renderReport({ ...result, group: groupOrphan() }, synthRedact());
  assert.ok(partial.includes('CLEANUP INCOMPLETE'), 'a residual member is never classified as verified');
});

// ---- R2/§8 — REAL descendant processes ---------------------------------------
//
// Everything above drives injected seams. These two do not: they create genuine local Node
// processes, one of which spawns a grandchild, and they observe the real kernel process table.
// A fake ChildProcess object cannot be reparented, and reparenting is the entire finding — measured
// on the installed tsx, killing the direct handle left the grandchild alive with ppid 1 and its
// PGID and SID untouched.
//
// Harmless by construction: `node -e` only, no network, no database, no filesystem writes. Both
// tests clean up their own processes and assert that nothing of theirs survives.

/**
 * A parent that spawns a long-lived grandchild, waits for it to be READY, then reports its pid.
 *
 * The readiness handshake is load-bearing, not decoration. The grandchild ignores SIGTERM, and its
 * handler is only installed once its JavaScript runs — several milliseconds after `spawn()` returns
 * in the parent. Announcing the pid at spawn time made the SIGTERM race the handler registration,
 * so the grandchild sometimes died to SIGTERM and the escalation assertion below became vacuous
 * exactly when it mattered. The pid is now published only after the grandchild says it is armed.
 */
const GRANDCHILD_PARENT = [
  "const { spawn } = require('node:child_process');",
  "const kid = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); process.stdout.write('READY'); setInterval(() => {}, 1000)\"], { stdio: ['ignore', 'pipe', 'ignore'] });",
  "kid.stdout.on('data', (d) => { if (String(d).includes('READY')) process.stdout.write('KID=' + kid.pid + '\\n'); });",
  'setInterval(() => {}, 1000);',
].join(' ');

const liveOf = (pid) => readProcIdentity(pid) !== null;
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

test('R2/§8 REAL: direct-handle-only termination does NOT contain a real grandchild (RED)', async () => {
  const { spawn } = await import('node:child_process');
  const parent = spawn(process.execPath, ['-e', GRANDCHILD_PARENT], {
    stdio: ['ignore', 'pipe', 'ignore'],
    detached: true, // its own group, so this test can clean up after itself no matter what
  });
  let kidPid = null;
  try {
    let buf = '';
    for (let i = 0; i < 200 && kidPid === null; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(25);
      buf += parent.stdout.read() ?? '';
      const m = /KID=(\d+)/.exec(buf);
      if (m) kidPid = Number(m[1]);
    }
    assert.notEqual(kidPid, null, 'the real grandchild was created');
    const before = readProcIdentity(kidPid);
    assert.notEqual(before, null, 'and is alive');
    assert.equal(before.ppid, parent.pid, 'it really is a child of the direct handle');

    // Signal ONLY the direct handle — exactly what the pre-correction launcher did.
    parent.kill('SIGKILL');
    await sleep(600);

    assert.equal(liveOf(parent.pid), false, 'the direct handle is gone');
    assert.equal(liveOf(kidPid), true, 'RED: the grandchild SURVIVED direct-handle-only termination');
    const after = readProcIdentity(kidPid);
    assert.notEqual(after.ppid, parent.pid, 'and it was REPARENTED away from the dead parent');
    // The decisive point: a PPID scan has now lost it, while PGID/SID still hold it.
    assert.equal(after.pgid, before.pgid, 'its PGID is unchanged by reparenting');
    assert.equal(after.sid, before.sid, 'and so is its SID — which is why the group is the right handle');
    const observed = scanGroup({ pid: parent.pid, pgid: parent.pid, sid: parent.pid, starttime: null });
    assert.ok(observed.groupMembers.includes(kidPid), 'a PGID/SID scan still sees the orphan a PPID scan cannot');
  } finally {
    try { process.kill(-parent.pid, 'SIGKILL'); } catch { /* already gone */ }
    await sleep(300);
    if (kidPid !== null && liveOf(kidPid)) {
      try { process.kill(kidPid, 'SIGKILL'); } catch { /* already gone */ }
      await sleep(200);
    }
    assert.equal(kidPid === null ? false : liveOf(kidPid), false, 'the test leaves no process behind');
  }
});

test('R2/§8 REAL: group-wide containment removes the same grandchild (GREEN)', async () => {
  const { spawn } = await import('node:child_process');
  const parent = spawn(process.execPath, ['-e', GRANDCHILD_PARENT], {
    stdio: ['ignore', 'pipe', 'ignore'],
    detached: true, // exactly what the launcher now does: setsid(), never unref()
  });
  let kidPid = null;
  try {
    let buf = '';
    for (let i = 0; i < 200 && kidPid === null; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(25);
      buf += parent.stdout.read() ?? '';
      const m = /KID=(\d+)/.exec(buf);
      if (m) kidPid = Number(m[1]);
    }
    assert.notEqual(kidPid, null, 'the real grandchild was created');

    // The isolated-group contract, proved against the real kernel rather than assumed.
    const self = readProcIdentity(process.pid);
    const identity = assertIsolatedGroup(readProcIdentity(parent.pid), self);
    assert.equal(identity.pid, identity.pgid, 'pid === pgid');
    assert.equal(identity.pid, identity.sid, 'pid === sid');
    assert.notEqual(identity.pgid, self.pgid, 'and the group is not the launcher\'s own');

    const populated = scanGroup(identity);
    assert.ok(populated.groupMembers.includes(parent.pid), 'the leader is enumerated by PGID');
    assert.ok(populated.groupMembers.includes(kidPid), 'and so is the grandchild');

    // SIGTERM first — the grandchild ignores it, which is why escalation exists.
    process.kill(-identity.pgid, 'SIGTERM');
    await sleep(500);
    assert.equal(liveOf(kidPid), true, 'the grandchild genuinely ignores SIGTERM (the test is not vacuous)');

    process.kill(-identity.pgid, 'SIGKILL');
    await sleep(600);

    assert.equal(liveOf(parent.pid), false, 'GREEN: the direct handle is gone');
    assert.equal(liveOf(kidPid), false, 'GREEN: and so is the grandchild');
    const drained = scanGroup(identity);
    assert.deepEqual(drained.groupMembers, [], 'the managed group is empty');
    assert.deepEqual(drained.sessionMembers, [], 'and so is the managed session');
  } finally {
    try { process.kill(-parent.pid, 'SIGKILL'); } catch { /* already gone */ }
    if (kidPid !== null) {
      try { process.kill(kidPid, 'SIGKILL'); } catch { /* already gone */ }
    }
    await sleep(200);
    assert.equal(kidPid === null ? false : liveOf(kidPid), false, 'the test leaves no process behind');
  }
});

test('R2/§5: an UNAVAILABLE /proc during cleanup contains the handle but never claims the group', async () => {
  // Distinct from the THROWING scan above: here `/proc` is readable enough not to throw and still
  // yields no observation. An unobservable pgid may since have been reassigned, so the GROUP is not
  // signalled — but the direct handle still can be, because Node holds the child and the kernel
  // cannot recycle its pid while that handle is open. Contain what is provably safe; claim nothing.
  const c = fakeChild();
  const sent = [];
  const r = await runChild({
    spawn: () => c, // never closes
    args: [],
    env: synthEnv(),
    ...FAST,
    scan: groupUnavailable,
    killGroup: groupKiller(sent),
  });
  assert.equal(r.status, 'timeout');
  assert.deepEqual(sent, [], 'an unobservable group is never signalled — it may have been reassigned');
  assert.deepEqual(c.signals, ['SIGTERM', 'SIGKILL'], 'but the exact handle, which cannot be recycled, is');
  assert.equal(r.cleanup.reason, 'procfs_unavailable', 'and the shortfall is named in the transcript');
  assert.equal(r.cleanup.groupEmpty, false, 'emptiness was never established');
  assert.equal(outcomeCode(r), LAUNCHER_CODES.CLEANUP_INCOMPLETE, 'so it can never be OK');
  assert.ok(renderReport(r, synthRedact()).includes(DATABASE_OUTCOME_UNKNOWN));
});

test('R2/§6: outcomeCode itself refuses OK for a residual or unverified group', () => {
  // DEFENCE IN DEPTH, tested directly. The lifecycle already converts a residual close into
  // `group_residual`, so these branches are unreachable through `runChild` — which is exactly why
  // they need a direct test: an unreachable guard that no test exercises is a guard that a future
  // lifecycle change can silently delete.
  const base = evidenced();
  assert.equal(outcomeCode(base), LAUNCHER_CODES.OK, 'the fully evidenced shape is the ONLY OK');
  assert.equal(
    outcomeCode({ ...base, group: groupOrphan() }),
    LAUNCHER_CODES.GROUP_RESIDUAL,
    'a surviving group member forbids OK even on a clean zero exit',
  );
  assert.equal(
    outcomeCode({ ...base, group: sessionOnly() }),
    LAUNCHER_CODES.GROUP_RESIDUAL,
    'and so does a surviving session member',
  );
  assert.equal(
    outcomeCode({ ...base, group: groupUnavailable() }),
    LAUNCHER_CODES.GROUP_RESIDUAL,
    'an unobservable group is missing evidence, not evidence of termination',
  );
  assert.equal(
    outcomeCode({ ...base, identity: null }),
    LAUNCHER_CODES.GROUP_UNVERIFIED,
    'and an unverified group can never pass either',
  );
});

test('R2/§4: a child that is NOT its own group or session leader is refused', () => {
  const parent = { pid: 1000, ppid: 999, pgid: 1000, sid: 900 };
  // setsid() silently not taking effect is the failure this catches: the pid is fine, the pgid is
  // some OTHER group, and signalling it would reach processes the launcher never started.
  assert.throws(
    () => assertIsolatedGroup({ pid: 55, ppid: 1000, pgid: 77, sid: 55, starttime: '5' }, parent),
    (e) => e instanceof LauncherRefusal && e.code === LAUNCHER_CODES.GROUP_UNVERIFIED && e.names.includes('not_group_leader'),
    'pgid must equal pid',
  );
  assert.throws(
    () => assertIsolatedGroup({ pid: 55, ppid: 1000, pgid: 55, sid: 88, starttime: '5' }, parent),
    (e) => e instanceof LauncherRefusal && e.names.includes('not_session_leader'),
    'sid must equal pid',
  );
  assert.throws(
    () => assertIsolatedGroup(null, parent),
    (e) => e instanceof LauncherRefusal && e.names.includes('child_identity_unreadable'),
    'an unreadable identity is a refusal, never an assumption',
  );
  assert.throws(
    () => assertIsolatedGroup({ pid: 55, ppid: 1000, pgid: 55, sid: 55, starttime: '5' }, null),
    (e) => e instanceof LauncherRefusal && e.names.includes('parent_identity_unreadable'),
    'without the parent identity the exclusion cannot be proved, so it is refused',
  );
  // The one shape that passes.
  const ok = assertIsolatedGroup({ pid: 55, ppid: 1000, pgid: 55, sid: 55, starttime: '5' }, parent);
  assert.deepEqual({ ...ok }, { pid: 55, pgid: 55, sid: 55, starttime: '5' });
  assert.ok(Object.isFrozen(ok), 'the verified identity is frozen — it is signalling evidence');
});

test('R2/§8: the frozen BASELINE_FLAGS constant itself cannot name 005', () => {
  // Asserted against the CONSTANT, not against a rendered argv string. The launcher header quotes
  // the authorized version list in prose, so a source-text search proves nothing about the value
  // that is actually spawned.
  const versionFlags = BASELINE_FLAGS.filter((f) => f.startsWith('--baseline-versions='));
  assert.equal(versionFlags.length, 1, 'exactly one version list');
  assert.equal(versionFlags[0], '--baseline-versions=001,002,003,004');
  const versions = versionFlags[0].split('=')[1].split(',');
  assert.deepEqual(versions, ['001', '002', '003', '004'], 'exactly the historical baseline');
  assert.ok(!versions.includes('005'), 'migration 005 is not in the authorized list');
  for (const f of BASELINE_FLAGS) assert.ok(!/005/.test(f), `no flag may contain 005: ${f}`);
});

// ---- R2 review findings: the containment guards must fail CLOSED ---------------

test('R2/review: a missing start time is NOT treated as a matching incarnation', () => {
  const stat = (pid, pgid, sid, start) =>
    `${pid} (node) S 1 ${pgid} ${sid} 0 -1 4194304 0 0 0 0 0 0 0 0 20 0 11 0 ${start}`;
  const identity = { pid: 55, pgid: 55, sid: 55, starttime: '987654' };
  const dir = () => ['55'];

  // Same pgid/sid AND same start time: the same incarnation.
  const same = scanGroup(identity, dir, () => stat(55, 55, 55, '987654'));
  assert.equal(same.leaderIdentityMatches, true);

  // A DIFFERENT start time at the same pid is a different incarnation — the recycling case.
  const recycled = scanGroup(identity, dir, () => stat(55, 55, 55, '111111'));
  assert.equal(recycled.leaderIdentityMatches, false);

  // And an ABSENT start time must not default to "matches". A discriminator that fails open is one
  // that switches itself off at the moment it would have mattered. The line below still yields a
  // pgid and a sid, so MEMBERSHIP remains knowable — it is only the identity claim that fails closed.
  const truncated = scanGroup(identity, dir, () => '55 (node) S 1 55 55 0 -1');
  assert.equal(truncated.available, true, 'pgid and sid are still readable, so membership is known');
  assert.deepEqual(truncated.groupMembers, [55], 'and the member is still counted');
  assert.equal(truncated.leaderIdentityMatches, false, 'but an absent start time never counts as a match');
});

test('R2/review: the start time must EXIST before a group is accepted', () => {
  const parent = { pid: 1000, ppid: 999, pgid: 1000, sid: 900 };
  assert.throws(
    () => assertIsolatedGroup({ pid: 55, ppid: 1000, pgid: 55, sid: 55, starttime: null }, parent),
    (e) => e instanceof LauncherRefusal && e.names.includes('starttime_unavailable'),
    'without a recycling discriminator the run is refused up front, not mid-cleanup',
  );
  assert.throws(
    () => assertIsolatedGroup({ pid: 55, ppid: 1000, pgid: 55, sid: 55, starttime: 'not-a-number' }, parent),
    (e) => e instanceof LauncherRefusal && e.names.includes('starttime_unavailable'),
  );
});

test('R2/review: an unreadable process is distinguished from an EXITED one', () => {
  const enoent = () => {
    const e = new Error('no such file');
    e.code = 'ENOENT';
    throw e;
  };
  assert.equal(readProcIdentity(9, enoent), null, 'ENOENT is the ordinary "it exited" case');
  assert.throws(
    () => readProcIdentity(9, () => {
      const e = new Error('permission denied');
      e.code = 'EACCES';
      throw e;
    }),
    (e) => e instanceof LauncherRefusal && e.code === LAUNCHER_CODES.PROCFS_UNAVAILABLE,
    'any OTHER read failure is a failure to observe, never proof of absence',
  );
  assert.throws(
    () => readProcIdentity(9, () => 'garbage with no parenthesis'),
    (e) => e instanceof LauncherRefusal && e.code === LAUNCHER_CODES.PROCFS_UNAVAILABLE,
  );
  // A live member that cannot be understood must NOT be silently dropped from the group.
  const identity = { pid: 55, pgid: 55, sid: 55, starttime: '1' };
  const scan = scanGroup(identity, () => ['55', '56'], (p) => {
    if (String(p).includes('/56/')) return 'unparseable';
    return '55 (node) S 1 55 55 0 -1 0 0 0 0 0 0 0 0 0 20 0 11 0 1';
  });
  assert.equal(scan.available, false, 'an unreadable member makes the observation unavailable, not empty');
  assert.equal(groupIsEmpty(scan), false, 'and an unavailable observation is never "empty"');
});

test('R2/review: the direct handle is never signalled after the child has exited', async () => {
  const c = fakeChild();
  const r = await runChild({
    spawn: () => {
      // Exits, but `close` never arrives (a descendant holds the inherited pipe open).
      setImmediate(() => c.emit('exit', 0, null));
      return c;
    },
    args: [],
    env: synthEnv(),
    ...FAST,
    scan: groupUnavailable, // forces the handle-only fallback
    killGroup: () => true,
  });
  // Once the child is reaped its pid is free; `child.kill()` would degrade to a bare kill(pid) at a
  // slot that may already hold a stranger, and there is nothing left to contain in any case.
  assert.deepEqual(c.signals, [], 'no signal is delivered to a handle whose child has exited');
  assert.notEqual(outcomeCode(r), LAUNCHER_CODES.OK);
});

test('R2/review: the containment line never contradicts the outcome code', async () => {
  // A group that drains on its own AFTER a failed signal delivery: `groupEmpty` and `closeObserved`
  // are both true, but the run is CLEANUP_INCOMPLETE. The report must not print VERIFIED.
  const c = fakeChild();
  const g = liveGroup();
  const r = await runChild({
    spawn: () => c,
    args: [],
    env: synthEnv(),
    ...FAST,
    scan: g.scan,
    killGroup: () => {
      g.state.alive = false; // the group drains anyway
      setImmediate(() => {
        c.emit('exit', null, 'SIGTERM');
        c.emit('close', null, 'SIGTERM');
      });
      const e = new Error('kill EPERM');
      e.code = 'EPERM';
      throw e; // ... but delivery FAILED
    },
  });
  assert.equal(outcomeCode(r), LAUNCHER_CODES.CLEANUP_INCOMPLETE, 'a delivery failure is never complete');
  assert.equal(r.cleanup.complete, false);
  const report = renderReport(r, synthRedact());
  // R3: an incomplete cleanup is now a CONTAINMENT HOLD rather than a bare classification, because
  // the launcher no longer exits on it. Either wording is a non-verdict; what must never appear is
  // the verified one.
  assert.equal(r.containmentHold, true, 'an incomplete cleanup holds rather than abandoning');
  assert.ok(report.includes('containment=CONTAINMENT HOLD'), 'and the operator line agrees with it');
  assert.ok(!report.includes('VERIFIED TERMINAL CLEANUP'), 'no contradictory verdict anywhere in the record');
});

test('R2/review: outcomeCode cannot return OK for any cleanup status', () => {
  for (const status of CLEANUP_STATUSES) {
    const forged = {
      status,
      code: LAUNCHER_CODES.OK, // a producer that wrongly claims success
      detail: null,
      pid: CHILD_PID,
      exitCode: 0,
      signal: null,
      capture: createCapture(),
      identity: { ...CHILD_ID },
      group: groupEmpty(),
    };
    assert.equal(
      outcomeCode(forged),
      LAUNCHER_CODES.CLEANUP_INCOMPLETE,
      `${status}: OK must be structurally unreachable, not merely unproduced`,
    );
  }
});

test('R2/review: a terminal path that throws still settles, with the mandated line', async () => {
  // The backstop, exercised directly: a scan that throws on EVERY call, including the one inside
  // `done()`. Without the catch on the fire-and-forget terminal path this would hang forever.
  let calls = 0;
  const r = await runChild({
    spawn: () => {
      const c = fakeChild();
      setImmediate(() => {
        c.emit('exit', 0, null);
        c.emit('close', 0, null);
      });
      return c;
    },
    args: [],
    env: synthEnv(),
    ...FAST,
    scan: () => {
      calls += 1;
      throw new Error(`boom ${SYNTH_DSN}`);
    },
  });
  assert.ok(calls > 0, 'the throwing scan really was reached');
  assert.notEqual(outcomeCode(r), LAUNCHER_CODES.OK, 'and the run never passes');
  const report = renderReport(r, synthRedact());
  assert.ok(report.includes(DATABASE_OUTCOME_UNKNOWN), 'the mandated line survives a throwing terminal path');
  assertClean(report, 'throwing terminal path');
});

test('R2/review: a SESSION-ONLY residual is reported but never group-signalled', async () => {
  // The pgid pin comes from GROUP membership. A member that called setpgid() out of the group is in
  // the session but not the group: it neither keeps the pgid reserved nor could be reached by
  // kill(-pgid). Signalling would aim a possibly-reassigned pgid at a process that is not in it.
  const c = fakeChild();
  const sent = [];
  const r = await runChild({
    spawn: () => c, // never closes
    args: [],
    env: synthEnv(),
    ...FAST,
    scan: sessionOnly,
    killGroup: groupKiller(sent),
  });
  assert.deepEqual(sent, [], 'no group signal is issued for a session-only residual');
  assert.equal(r.cleanup.reason, 'session_only_residual', 'and the record names exactly why');
  assert.equal(r.cleanup.groupEmpty, false, 'the residual still blocks completion');
  assert.equal(outcomeCode(r), LAUNCHER_CODES.CLEANUP_INCOMPLETE);
  assert.ok(renderReport(r, synthRedact()).includes(DATABASE_OUTCOME_UNKNOWN));
});

test('R2/review: OK requires the CLOSED status by name, not merely an unrecognised one', () => {
  const base = evidenced();
  assert.equal(outcomeCode(base), LAUNCHER_CODES.OK);
  // A status no branch recognises must not fall through to a pass.
  assert.equal(outcomeCode({ ...base, status: 'some_future_status' }), LAUNCHER_CODES.CLEANUP_INCOMPLETE);
  // R3: and neither may a run that is still holding supervision, whatever else it evidenced.
  assert.equal(outcomeCode({ ...base, containmentHold: true }), LAUNCHER_CODES.CONTAINMENT_HOLD);
});

test('R2/review: a DETERMINED failure does not carry the unknown-outcome line', () => {
  // The distinction the header now states: a child that closed and reported a nonzero exit has a
  // KNOWN outcome — a failure. Printing DATABASE OUTCOME UNKNOWN there would be false, and would
  // devalue the line on the runs where it is true.
  const determined = {
    status: 'closed',
    code: null,
    detail: null,
    pid: CHILD_PID,
    exitCode: 7,
    signal: null,
    capture: createCapture(),
    identity: { ...CHILD_ID },
    group: groupEmpty(),
  };
  const report = renderReport(determined, synthRedact());
  assert.ok(!report.includes(DATABASE_OUTCOME_UNKNOWN), 'a determined failure is not an unknown outcome');
  assert.equal(outcomeCode(determined), LAUNCHER_CODES.CHILD_NONZERO_EXIT);
  // ... whereas every indeterminate status does carry it (asserted exhaustively elsewhere).
  assert.ok(CLEANUP_STATUSES.size >= 4, 'the indeterminate set is non-trivial');
});

// ============================================================================
// C2B-R3B-B0-R3 — NO-UNREF SUPERVISION AND CONTAINMENT HOLD.
//
// The R2 launcher classified an unfinishable cleanup honestly and then released the child handle so
// the parent could exit anyway. Accurate label, abandoned process. Everything below is about the
// replacement: when the terminal evidence is incomplete the launcher HOLDS.
//
// Every case here drives injected lifecycle seams — a fake child, an injected scan, an injected
// group signal, and an injected hold. That is not convenience. The live hold never exits by design,
// so a suite that entered the real one would hang forever, and a suite that "fixed" the hang by
// letting the launcher exit would be asserting exactly the abandonment this stage removed. No test
// below signals a real process or a real process group.
// ============================================================================

/** Observation whose SESSION list could not be established, though the group list could. */
const sessionUnobserved = () => observation({ sessionMembers: null });
/** A group that never drains, however it is signalled. */
const groupNeverDrains = () => groupLeaderAlive();

/** Run one fake-child lifecycle with the fast harness. Returns the result and the fake child. */
async function holdRun(over = {}) {
  const c = fakeChild();
  const sent = [];
  const r = await runChild({
    spawn: () => c,
    args: [],
    env: synthEnv(),
    ...FAST,
    killGroup: groupKiller(sent),
    ...over,
  });
  return { r, c, sent };
}

/** Every assertion that must hold for ANY containment hold, so no case can quietly omit one. */
function assertHeld(r, label) {
  assert.equal(r.containmentHold, true, `${label}: the run must HOLD, not return terminally`);
  assert.equal(r.cleanup.containmentHold, true, `${label}: and the transcript must say so`);
  assert.equal(r.cleanup.complete, false, `${label}: a held run is never a complete cleanup`);
  assert.notEqual(outcomeCode(r), LAUNCHER_CODES.OK, `${label}: and can never be OK`);
  assert.equal(normalCompletion(r), false, `${label}: nor a normal completion`);
  const report = renderReport(r, synthRedact());
  assert.ok(report.includes('containment=CONTAINMENT HOLD'), `${label}: the operator line names the hold`);
  assert.ok(!report.includes('VERIFIED TERMINAL CLEANUP'), `${label}: and never contradicts it`);
  assert.ok(report.includes(DATABASE_OUTCOME_UNKNOWN), `${label}: the database outcome stays unknown`);
  assertClean(report, `${label}: hold report`);
  return report;
}

// ---- §8.2 — the normal completion, stated as a predicate ---------------------

test('R3/§8.2: a zero exit with an EMPTY group and session completes normally', async () => {
  const c = fakeChild();
  const r = await runChild({
    spawn: () => {
      setImmediate(() => {
        c.emit('exit', 0, null);
        c.emit('close', 0, null);
      });
      return c;
    },
    args: [],
    env: synthEnv(),
    ...FAST,
    scan: groupEmpty,
  });
  assert.equal(r.status, 'closed');
  assert.equal(r.containmentHold, false, 'a fully evidenced run does not hold');
  assert.equal(normalCompletion(r), true, 'every conjunct of the normal-completion predicate holds');
  assert.equal(outcomeCode(r), LAUNCHER_CODES.OK);
  const report = renderReport(r, synthRedact());
  assert.ok(report.includes('VERIFIED TERMINAL CLEANUP'));
  assert.ok(!report.includes(DATABASE_OUTCOME_UNKNOWN), 'a determined success is not an unknown outcome');
});

test('R3/§8.2: EVERY conjunct of normalCompletion is load-bearing', () => {
  // Each removal is a state a future edit could produce; the predicate has to fail on every one of
  // them individually, or the conjunct it names is decoration.
  assert.equal(normalCompletion(evidenced()), true, 'the complete shape passes');
  const removals = {
    spawned: false,
    closeObserved: false,
    streamsClosed: false,
    observationLost: true,
  };
  for (const [field, value] of Object.entries(removals)) {
    assert.equal(normalCompletion(evidenced({ [field]: value })), false, `${field} must be load-bearing`);
    assert.notEqual(outcomeCode(evidenced({ [field]: value })), LAUNCHER_CODES.OK, `${field} must forbid OK`);
  }
  assert.equal(normalCompletion(evidenced({ identity: null })), false, 'an unverified group cannot complete');
  assert.equal(normalCompletion(evidenced({ status: 'timeout' })), false, 'a cleanup status is never normal');
  assert.equal(normalCompletion(evidenced({ group: groupOrphan() })), false, 'a group member forbids completion');
  assert.equal(normalCompletion(evidenced({ group: sessionOnly() })), false, 'so does a session member');
  assert.equal(normalCompletion(evidenced({ group: groupUnavailable() })), false, 'so does an unobservable group');
  assert.equal(
    normalCompletion(evidenced({ cleanup: { signalFailed: true } })),
    false,
    'a signal this launcher could not deliver is a containment action that did not happen',
  );
});

// ---- §8.5-§8.9 — the five conditions that MUST enter the hold ----------------

test('R3/§8.5: LOSS of group observation enters a CONTAINMENT HOLD', async () => {
  const { r, sent } = await holdRun({ scan: groupUnavailable });
  assert.equal(r.observationLost, true, 'an unavailable enumeration is recorded as observation loss');
  assert.equal(r.cleanup.observationLost, true);
  assert.deepEqual(sent, [], 'an unobservable group is never group-signalled');
  const report = assertHeld(r, 'group-observation loss');
  assert.ok(report.includes('observationLost=true'), 'and the transcript says which evidence went missing');
});

test('R3/§8.6: LOSS of session observation enters a CONTAINMENT HOLD', async () => {
  // A DIFFERENT failure from the one above, and deliberately tested apart from it: the group list
  // was established and is empty, and only the SESSION list is missing. A predicate written over
  // member counts alone would read this as "nothing found" and pass it.
  const { r } = await holdRun({ scan: sessionUnobserved });
  assert.equal(r.group.available, true, 'the enumeration itself succeeded');
  assert.deepEqual(r.group.groupMembers, [], 'and the group is empty');
  assert.equal(r.group.sessionMembers, null, 'but the session membership was never established');
  assert.equal(groupIsEmpty(r.group), false, 'so the managed tree is NOT proved empty');
  assertHeld(r, 'session-observation loss');
});

test('R3/§8.7: an IDENTITY MISMATCH enters a CONTAINMENT HOLD and escalates against nobody', async () => {
  const { r, sent } = await holdRun({ scan: groupRecycled });
  assert.equal(r.cleanup.kill, 'refused_identity_mismatch', 'a recycled leader is never escalated against');
  assert.deepEqual(sent, [], 'and no signal reaches the reused pid slot');
  assertHeld(r, 'identity mismatch');
});

test('R3/§8.8: a SIGNAL FAILURE enters a CONTAINMENT HOLD', async () => {
  const { r } = await holdRun({
    scan: groupNeverDrains,
    killGroup: () => {
      const e = new Error('kill EPERM');
      e.code = 'EPERM';
      throw e;
    },
  });
  assert.equal(r.cleanup.signalFailed, true, 'the undelivered signal is recorded as a failure');
  assert.equal(r.detail, 'EPERM', 'and only the errno LABEL escapes');
  assertHeld(r, 'signal failure');
});

test('R3/§8.9: a PERSISTENT RESIDUAL enters a CONTAINMENT HOLD after SIGTERM and SIGKILL', async () => {
  const { r, sent } = await holdRun({ scan: groupNeverDrains });
  assert.deepEqual(sent, [`${CHILD_PID}/SIGTERM`, `${CHILD_PID}/SIGKILL`], 'both stages ran, against the group');
  assert.equal(r.cleanup.groupEmpty, false, 'and the group still holds a live member');
  assert.equal(r.cleanup.members, 1);
  assertHeld(r, 'persistent residual');
});

// ---- §8.10-§8.11 — what the hold itself is -----------------------------------

test('R3/§8.10: the CONTAINMENT HOLD retains a REFERENCED supervisor', () => {
  // The distinction §3 draws in so many words: an UNREFERENCED timer is a forbidden substitute for
  // the release, because it does not keep the process alive. This asserts the real thing on a real
  // Node timer, then clears it so the suite itself cannot be held open.
  const emitted = [];
  const hold = enterContainmentHold({ emit: (l) => emitted.push(l), pollMs: 3_600_000 });
  try {
    assert.equal(typeof hold.timer.hasRef, 'function', 'a genuine Node timer, not a stub');
    assert.equal(hold.timer.hasRef(), true, 'REFERENCED: the event loop cannot drain while it lives');
  } finally {
    hold.release();
  }
  // BEHAVIOURAL, not a mirror of the constant. Asserting `CONTAINMENT_HOLD_POLL_MS === 30_000` on
  // its own restates the source and proves nothing; what matters is that the default is the interval
  // actually installed, and that it is bounded and low-frequency rather than a busy loop.
  const intervals = [];
  enterContainmentHold({ setIntervalFn: (_cb, ms) => intervals.push(ms), clearIntervalFn: () => {} }).release();
  assert.deepEqual(intervals, [CONTAINMENT_HOLD_POLL_MS], 'the default poll interval is the one installed');
  assert.ok(CONTAINMENT_HOLD_POLL_MS >= 1_000, 'and it is low-frequency, not a spin');
  // `release()` exists ONLY so this suite can end its own hold; the live launcher never calls it.
  // Asserted on an injected pair rather than by re-reading `hasRef()`, which stays true after
  // `clearInterval` — it reports the REF state, not whether the timer is still scheduled, and
  // asserting otherwise would have been a test that passed for the wrong reason.
  const cleared = [];
  const fake = { fake: true };
  const injected = enterContainmentHold({
    setIntervalFn: () => fake,
    clearIntervalFn: (t) => cleared.push(t),
  });
  injected.release();
  assert.deepEqual(cleared, [fake], 'release clears exactly the timer the hold installed');
  assert.ok(
    !/\brelease\(\)/.test(LAUNCHER_CODE.slice(LAUNCHER_CODE.indexOf('export async function main'))),
    'and main() never releases the hold it entered',
  );
});

test('R3/§8.11: the CONTAINMENT HOLD emits exactly ONE bounded code and the poll emits nothing', async () => {
  const emitted = [];
  let observed = 0;
  let fn = null;
  const hold = enterContainmentHold({
    emit: (l) => emitted.push(l),
    observe: () => {
      observed += 1;
      if (observed === 3) throw new Error(`observer exploded ${SYNTH_DSN}`);
      return groupLeaderAlive();
    },
    setIntervalFn: (cb) => {
      fn = cb;
      return { fake: true };
    },
    clearIntervalFn: () => {},
  });
  assert.equal(emitted.length, 1, 'exactly one line at entry');
  assert.ok(emitted[0].includes(LAUNCHER_CODES.CONTAINMENT_HOLD), 'and it carries the bounded code');
  assert.ok(/INTERVENTION IS REQUIRED/.test(emitted[0]), 'it says an operator has to act');
  assert.ok(/Do not re-run/.test(emitted[0]), 'and that the baseline must not be re-run');
  assertClean(emitted[0], 'hold code line');
  // A hundred intervals later the record has not grown by a single line, and a THROWING observation
  // — the shape most likely to appear in the failure this hold exists for — neither escapes nor
  // stops the hold.
  for (let i = 0; i < 100; i += 1) fn();
  assert.equal(emitted.length, 1, 'the poll must never generate unbounded output');
  assert.equal(hold.polls, 100, 'though it did keep running');
  assert.equal(observed, 100, 'and kept observing');
});

// ---- §8.12-§8.13 — what the hold and the handle fallback can NEVER become ----

test('R3/§8.12: a CONTAINMENT HOLD can never map to OK, on any status', () => {
  assert.equal(outcomeCode(evidenced({ containmentHold: true })), LAUNCHER_CODES.CONTAINMENT_HOLD);
  for (const status of CLEANUP_STATUSES) {
    for (const forgedCode of [LAUNCHER_CODES.OK, null, undefined]) {
      const forged = evidenced({
        status,
        code: forgedCode,
        containmentHold: true,
        cleanup: { complete: true, containmentHold: true, groupVerified: true, groupEmpty: true },
      });
      assert.notEqual(outcomeCode(forged), LAUNCHER_CODES.OK, `${status}/${forgedCode}: must never pass`);
      const report = renderReport(forged, synthRedact());
      assert.ok(report.includes('containment=CONTAINMENT HOLD'), `${status}: held runs are labelled held`);
      assert.ok(!report.includes('VERIFIED TERMINAL CLEANUP'), `${status}: and never verified`);
    }
  }
});

test('R3/§8.13: a HANDLE-ONLY signal is never credited as containment', async () => {
  // The unverified-group path: `identify` throws, so no group was ever proved and the only thing
  // this launcher can signal is the direct handle. On the measured tsx topology that handle is the
  // CLI shim; the process owning the database session is one level below it. So the signal goes out
  // as best-effort damage reduction and is recorded as NOT containment.
  const { r, c, sent } = await holdRun({
    identify: () => {
      throw new LauncherRefusal(LAUNCHER_CODES.GROUP_UNVERIFIED, ['not_group_leader']);
    },
  });
  assert.equal(r.status, 'group_unverified');
  assert.equal(r.identity, null, 'no group was ever verified');
  assert.equal(r.cleanup.handleOnly, true, 'so the fallback was used');
  assert.equal(r.cleanup.groupVerified, false, 'and it is NOT credited as a verified group');
  assert.ok(c.signals.length > 0, 'the handle really was signalled — damage reduction is still done');
  assert.deepEqual(sent, [], 'but no group signal was ever issued');
  const report = assertHeld(r, 'handle-only fallback');
  assert.ok(report.includes('handleOnlySignal=true'), 'the record names the fallback');
  assert.ok(
    /NEVER credited as group containment/.test(report),
    'and states in words that it does not support a no-descendant claim',
  );
});

test('R3/§8.13: an UNOBSERVABLE group falls back to the handle and still holds', async () => {
  const { r, c } = await holdRun({ scan: groupUnavailable });
  assert.equal(r.cleanup.handleOnly, true, 'the group could not be observed, so it could not be signalled');
  assert.ok(c.signals.length > 0, 'the exact handle Node still pins was signalled instead');
  assert.equal(r.cleanup.groupEmpty, false, 'and nothing about the group was established');
  assertHeld(r, 'unobservable group');
});

// ---- §4 — main() enters the hold instead of exiting --------------------------

test('R3/§4: main() enters the containment hold on an incomplete cleanup, and only then', async () => {
  const entered = [];
  const out = [];
  const runMain = (over) =>
    main(['--execute'], SYNTH_SOURCE, {
      out: (l) => out.push(l),
      err: (l) => out.push(l),
      readExecEnv: () => new Map(),
      assertContainment: () => {},
      identify: identifyOk,
      selfIdentity: selfOk,
      killGroup: () => true,
      timeoutMs: 20,
      cleanupGraceMs: 20,
      groupPollMs: 1,
      // INJECTED. The live hold never returns, so entering it here would hang the suite; asserting
      // on the injected seam is the only way to test a state whose whole purpose is not to end.
      enterHold: (opts) => {
        entered.push(opts);
        return { timer: null, release: () => {}, polls: 0 };
      },
      ...over,
    });

  // 1. An incomplete cleanup HOLDS.
  const held = await runMain({
    scan: groupUnavailable,
    spawn: () => fakeChild(),
  });
  assert.equal(entered.length, 1, 'main() entered the hold exactly once');
  assert.equal(typeof entered[0].emit, 'function', 'and handed it the redacted output sink');
  assert.equal(typeof entered[0].observe, 'function', 'and a bounded observation');
  assert.notEqual(held, 0, 'a held run never reports success to the shell');
  assert.ok(out.some((l) => l.includes('containment=CONTAINMENT HOLD')), 'the record names the hold');
  assert.ok(out.some((l) => l.includes(DATABASE_OUTCOME_UNKNOWN)), 'and the outcome stays unknown');
  for (const line of out) assertClean(line, 'held main() record');

  // 2. A fully evidenced run does NOT hold.
  entered.length = 0;
  out.length = 0;
  const clean = await runMain({
    scan: groupEmpty,
    spawn: () => completingChild(),
  });
  assert.equal(clean, 0, 'a fully evidenced run reports success');
  assert.deepEqual(entered, [], 'and never enters the hold');
});

test('R3/§8.13: EVERY conjunct of cleanupComplete is INDEPENDENTLY load-bearing', () => {
  // WHY THIS TEST EXISTS, stated plainly: with the predicate inline, deleting `!handleOnly` from it
  // changed no test result whatsoever. Every handle-only path in the lifecycle ALSO loses
  // `groupVerified` or `observationLost`, so the term was redundant in practice and the red/green
  // check for "handle-only is never credited as containment" was passing vacuously — the guarantee
  // rested on two neighbouring terms rather than on the one that names it.
  //
  // As a pure function each term can be failed on its own, which is the only way the claim becomes
  // checkable. `handleOnly` in particular now has a case where it is the SOLE disqualifier.
  const complete = Object.freeze({
    closeObserved: true,
    signalFailed: false,
    groupVerified: true,
    groupEmpty: true,
    handleOnly: false,
    observationLost: false,
  });
  assert.equal(cleanupComplete(complete), true, 'the fully evidenced cleanup is complete');
  const breaks = {
    closeObserved: false,
    signalFailed: true,
    groupVerified: false,
    groupEmpty: false,
    handleOnly: true,
    observationLost: true,
  };
  for (const [field, value] of Object.entries(breaks)) {
    assert.equal(
      cleanupComplete({ ...complete, [field]: value }),
      false,
      `${field} alone must be enough to deny a complete cleanup`,
    );
  }
  // ASYMMETRIC BY DESIGN, and asserted so rather than left to be inferred. The three POSITIVE terms
  // are evidence that must be present: a missing one is missing evidence and denies completion. The
  // three NEGATIVE terms are failures that must not have been recorded: their absence means no such
  // failure occurred, which is the correct reading of a transcript that never set them.
  for (const field of ['closeObserved', 'groupVerified', 'groupEmpty']) {
    const partial = { ...complete };
    delete partial[field];
    assert.equal(cleanupComplete(partial), false, `${field}: missing evidence is never satisfied evidence`);
  }
  for (const field of ['signalFailed', 'handleOnly', 'observationLost']) {
    const partial = { ...complete };
    delete partial[field];
    assert.equal(cleanupComplete(partial), true, `${field}: an unrecorded failure is not a failure`);
  }
});

test('R3/§4: a TERMINAL scan that goes unavailable after a clean drain still HOLDS', async () => {
  // FOUND BY TRACING, not by a failing test, and it is the sharpest case in this file.
  //
  // `beginCleanup` decided the hold from the evidence it had AT THAT MOMENT. The terminal group
  // observation is taken later, inside `done()`. So a run whose drain scan saw an empty group and
  // whose terminal scan then came back UNAVAILABLE was settled with containmentHold=false — and the
  // launcher exited while holding no observation at all of a group it had just been supervising.
  // The outcome code was not OK, which is why no existing assertion caught it; but "not OK" and
  // "did not abandon" are different guarantees, and §4 requires the second one.
  const c = fakeChild();
  const r = await runChild({
    spawn: () => {
      setImmediate(() => {
        c.emit('exit', 0, null);
        c.emit('close', 0, null);
      });
      return c;
    },
    args: [],
    env: synthEnv(),
    ...FAST,
    scan: scanSeq(groupEmpty, groupUnavailable), // drain succeeds, the terminal look does not
  });
  assert.equal(r.status, 'closed', 'the child really did close cleanly');
  assert.equal(r.observationLost, true, 'and the terminal observation was lost');
  assert.equal(normalCompletion(r), false, 'so this is not a normal completion');
  assert.equal(r.containmentHold, true, 'and the launcher must HOLD rather than exit');
  assert.notEqual(outcomeCode(r), LAUNCHER_CODES.OK);
  const report = renderReport(r, synthRedact());
  assert.ok(report.includes('containment=CONTAINMENT HOLD'));
  assertClean(report, 'terminal-scan-loss hold');
});

test('R3/§4: a SPAWN FAILURE never holds — there is no process to supervise', async () => {
  // The other half of the same rule. §4 scopes the hold to "after a child has spawned"; holding
  // forever over a process that was never created would be a hang dressed up as containment.
  for (const mode of ['sync', 'async']) {
    const r = await runChild({
      spawn: () => {
        if (mode === 'sync') {
          const e = new Error('spawn ENOENT');
          e.code = 'ENOENT';
          throw e;
        }
        const c = fakeChild({ pid: undefined, stdout: null, stderr: null });
        setImmediate(() => {
          const e = new Error('spawn EACCES');
          e.code = 'EACCES';
          c.emit('error', e);
        });
        return c;
      },
      args: [],
      env: synthEnv(),
      ...FAST,
      scan: groupEmpty,
    });
    assert.equal(r.status, 'spawn_failed', `${mode}: a failed fork is a spawn failure`);
    assert.equal(r.spawned, false, `${mode}: and nothing was spawned`);
    assert.notEqual(r.containmentHold, true, `${mode}: so the launcher must NOT hold`);
    assert.equal(outcomeCode(r), LAUNCHER_CODES.SPAWN_FAILED, `${mode}: and reports the spawn failure`);
    const report = renderReport(r, synthRedact());
    assert.ok(!report.includes('containment=CONTAINMENT HOLD'), `${mode}: no hold in the record`);
    assertClean(report, `${mode}: spawn-failure record`);
  }
});

// ---- R3 independent-review corrections ---------------------------------------
//
// Every case below is a defect an independent pass found in the R3 launcher after the suite above
// was already green. Each one is recorded as its own test rather than folded into an existing one,
// so the specific mistake cannot come back unnoticed.

test('R3/review: an observation lost MID-DRAIN still holds, even if the last look succeeds', async () => {
  // The drain loop originally checked availability only AFTER the loop, so any number of
  // unavailable polls were forgiven as long as the final one succeeded — and an unavailable
  // observation is never "empty", so the loop keeps going and the last look is the one most likely
  // to succeed. `scanGroup` degrades the WHOLE observation to unavailable when any single /proc
  // entry is unreadable, so one transient read failure anywhere on the box bought an OK.
  const c = fakeChild();
  const r = await runChild({
    spawn: () => {
      setImmediate(() => {
        c.emit('exit', 0, null);
        c.emit('close', 0, null);
      });
      return c;
    },
    args: [],
    env: synthEnv(),
    ...FAST,
    scan: scanSeq(groupUnavailable, groupEmpty, groupEmpty),
  });
  assert.equal(r.observationLost, true, 'the lost window is latched, not retired by a later scan');
  assert.equal(r.containmentHold, true, 'so the run holds');
  assert.notEqual(outcomeCode(r), LAUNCHER_CODES.OK, 'and a transient read failure can never buy OK');
});

test('R3/review: a HELD run with a clean CLOSED status still carries the mandated lines', async () => {
  // The unknown-outcome lines were keyed on the cleanup STATUS, which was correct only while a hold
  // implied one. A child can now close cleanly with the terminal observation lost — and that record
  // used to end on the child's own commit claim, with no DATABASE OUTCOME UNKNOWN at all.
  const c = fakeChild();
  const r = await runChild({
    spawn: () => {
      setImmediate(() => {
        c.stdout.emit('data', Buffer.from('[migrate] baseline: commit=committed\n'));
        c.emit('exit', 0, null);
        c.emit('close', 0, null);
      });
      return c;
    },
    args: [],
    env: synthEnv(),
    ...FAST,
    scan: scanSeq(groupEmpty, groupUnavailable),
  });
  assert.equal(r.status, 'closed');
  assert.equal(r.containmentHold, true);
  const report = renderReport(r, synthRedact());
  const lines = report.split('\n');
  assert.ok(report.includes(DATABASE_OUTCOME_UNKNOWN), 'the mandated line is present on a held close');
  assert.ok(report.includes('(UNVERIFIED, may be incomplete)'), 'and the captured output is labelled');
  assert.ok(/UNVERIFIED$/.test(lines[lines.length - 1]), 'the LAST word is not the child commit claim');
  assert.ok(!/commit=committed$/.test(lines[lines.length - 1]));
});

test('R3/review: the hold is ASSIGNED from the evidence, not merely added to', async () => {
  // A fake fork failure that emits NO error event reaches the deadline and enters cleanup with
  // `spawned === false`. `beginCleanup` sets containmentHold unconditionally, so an OR-ing done()
  // would have held forever over a process that never existed.
  const r = await runChild({
    spawn: () => fakeChild({ pid: undefined, stdout: null, stderr: null }),
    args: [],
    env: synthEnv(),
    ...FAST,
    scan: groupEmpty,
  });
  assert.equal(r.spawned, false, 'no child was ever created');
  assert.equal(r.status, 'timeout', 'and the run reached its deadline');
  assert.equal(r.cleanup.containmentHold, true, "the cleanup's own view still says hold");
  assert.equal(r.containmentHold, false, 'but the authoritative decision overrides it');
});

test('R3/review: a LIVE child reported as spawn_failed still holds — evidence over label', async () => {
  // The hold gate must not exempt a STATUS by name. A group-verified child that emits an async
  // `error` before any terminal latch settles as `spawn_failed`, and the terminal scan can still
  // show a live member; exempting the label would exit with that member running.
  const c = fakeChild();
  const r = await runChild({
    spawn: () => {
      setImmediate(() => c.emit('error', Object.assign(new Error('late'), { code: 'EPERM' })));
      return c;
    },
    args: [],
    env: synthEnv(),
    ...FAST,
    scan: groupLeaderAlive,
  });
  assert.equal(r.status, 'spawn_failed', 'the label says nothing started');
  assert.equal(r.spawned, true, 'but a child really was forked');
  assert.equal(r.containmentHold, true, 'so the evidence wins and the launcher holds');
});

test('R3/review: streamsClosed is FALSIFIABLE — an open pipe blocks completion', async () => {
  // `openStreams === 0 || closed` was satisfied by `closed` alone, so no synthetic run ever
  // exercised the counter and a term the hold decision depends on could not fail. With `&&` it can.
  const c = fakeChild();
  const rawEmit = c.emit;
  c.emit = (event, ...rest) => EventEmitter.prototype.emit.call(c, event, ...rest); // skip stream closes
  void rawEmit;
  const r = await runChild({
    spawn: () => {
      setImmediate(() => {
        c.emit('exit', 0, null);
        c.emit('close', 0, null);
      });
      return c;
    },
    args: [],
    env: synthEnv(),
    ...FAST,
    scan: groupEmpty,
  });
  assert.equal(r.closeObserved, true, 'the subprocess close arrived');
  assert.equal(r.streamsClosed, false, 'but its pipes never did');
  assert.equal(normalCompletion(r), false, 'so this is not a normal completion');
  assert.equal(r.containmentHold, true, 'and the launcher holds');
});

test('R3/review: a THROWING report sink still installs the hold', async () => {
  // Reporting runs before the hold so the operator gets the transcript first. "First" must not mean
  // "and only if it succeeds": without a finally, a throwing renderer would abandon the child.
  const entered = [];
  await assert.rejects(
    main(['--execute'], SYNTH_SOURCE, {
      out: () => {
        throw new Error('sink exploded');
      },
      err: () => {},
      readExecEnv: () => new Map(),
      assertContainment: () => {},
      identify: identifyOk,
      selfIdentity: selfOk,
      killGroup: () => true,
      timeoutMs: 20,
      cleanupGraceMs: 20,
      groupPollMs: 1,
      scan: groupUnavailable,
      spawn: () => fakeChild(),
      enterHold: (o) => {
        entered.push(o);
        return { timer: null, release: () => {}, polls: 0 };
      },
    }),
  );
  assert.equal(entered.length, 1, 'the hold was installed despite the failure');
});

test('R3/review: the machine-readable outcome NAMES the hold', async () => {
  // Ordered below the group checks, the CONTAINMENT_HOLD code was dead: every held run also fails a
  // group check, so `outcome=` said `managed_group_residual` and only prose mentioned the hold.
  const c = fakeChild();
  const r = await runChild({
    spawn: () => {
      setImmediate(() => {
        c.emit('exit', 0, null);
        c.emit('close', 0, null);
      });
      return c;
    },
    args: [],
    env: synthEnv(),
    ...FAST,
    scan: scanSeq(groupEmpty, groupUnavailable),
  });
  assert.equal(r.containmentHold, true);
  assert.equal(outcomeCode(r), LAUNCHER_CODES.CONTAINMENT_HOLD, 'the code names the state to act on');
});

test('R3/review: the hold line goes through the redactor like every other sink', () => {
  // Today's message is a frozen literal, so redaction is invisible — which is exactly why this is
  // asserted structurally. A future edit that interpolates observed state into the hold message must
  // not bypass redaction by construction.
  const seen = [];
  enterHoldIfRequired(
    { containmentHold: true, identity: null },
    (line) => seen.push(line),
    (text) => `REDACTED<${text}>`,
    {
      enterHold: ({ emit }) => {
        emit('carrier');
        return { timer: null, release: () => {}, polls: 0 };
      },
    },
  );
  assert.deepEqual(seen, ['REDACTED<carrier>'], 'the hold emits through the redactor, not around it');
  // And a result that does not hold installs nothing.
  const none = [];
  enterHoldIfRequired({ containmentHold: false }, (l) => none.push(l), (t) => t, {
    enterHold: () => {
      throw new Error('must not be entered');
    },
  });
  assert.deepEqual(none, []);
});

test('R3/review: a STALE cleanup success cannot exempt a run whose terminal scan disagrees', async () => {
  // `cleanup.complete` is frozen when the cleanup finishes; the terminal scan in done() is newer.
  // Granting the exemption on the frozen flag alone let a group that drained and then reacquired a
  // member — or whose final look failed — exit on evidence the launcher no longer had.
  const c = fakeChild();
  const r = await runChild({
    spawn: () => c,
    args: [],
    env: synthEnv(),
    ...FAST,
    // Scan order: the early look and the SIGTERM look both see the leader (so a signal really is
    // delivered), the drain then reports empty (so the cleanup COMPLETES), and the terminal look in
    // done() finds a member again.
    scan: scanSeq(groupLeaderAlive, groupLeaderAlive, groupEmpty, groupOrphan),
    killGroup: groupKiller([], () => {
      setImmediate(() => {
        c.emit('exit', null, 'SIGTERM');
        c.emit('close', null, 'SIGTERM');
      });
      return true;
    }),
  });
  assert.equal(r.cleanup.complete, true, 'the cleanup itself concluded successfully');
  assert.equal(groupIsEmpty(r.group), false, 'but the terminal observation disagrees');
  assert.equal(r.containmentHold, true, 'so the newer evidence wins and the launcher holds');
  assert.notEqual(outcomeCode(r), LAUNCHER_CODES.OK);
});

test('R3/review: normalCompletion and cleanupComplete AGREE about a handle-only fallback', () => {
  // The two exported predicates are the only two gates on "nothing is still running". Letting one
  // disqualify a handle-only fallback and the other ignore it is an inconsistency that no lifecycle
  // path exercises today — which is exactly how it would have survived.
  const withHandleOnly = evidenced({ cleanup: { handleOnly: true } });
  assert.equal(cleanupComplete({ closeObserved: true, groupVerified: true, groupEmpty: true, handleOnly: true }), false);
  assert.equal(normalCompletion(withHandleOnly), false, 'and the completion predicate agrees');
  assert.notEqual(outcomeCode(withHandleOnly), LAUNCHER_CODES.OK, 'so no forged shape can pass');
});

/**
 * THE MIGRATION TRANSCRIPT'S DRIFT GUARD.
 *
 * This launcher's child is the migration CLI, and its transcript is the last one that was still
 * being forwarded raw. Six of its surfaces are UNBOUNDED — three raw message interpolations, a
 * disposable database suffix, an unvalidated version token from argv, and the detail continuation
 * lines — and they live in a frozen path, so they cannot be fixed at the source from here. What can
 * be fixed is whether this launcher repeats them, and it no longer does.
 *
 * The guard therefore has two halves, and both matter: the bounded families must SURVIVE, and every
 * unbounded surface must be DISCARDED. A grammar that dropped everything would pass the second half
 * alone, and one that forwarded everything would pass the first.
 */
test('C2B-M005-LRLS-L4: the migration transcript keeps bounded evidence and discards the rest', () => {
  const survives = [
    '[migrate] status: outcome=complete rows=3 disposal=closed code=none',
    '[migrate] baseline: outcome=refused adopted=none commit=not_committed disposal=closed code=baseline_partial_observed',
    '[migrate] baseline plan: versions=001,002,003,004 audit=record_baseline',
    '[migrate] apply(up) ledger: version=005 marker=clean_verified markerWrite=succeeded cleanVerified=true ddlMayHaveCommitted=false',
    '[migrate] apply(up) evidence: commit=resolved submitted=true resolved=true acknowledged=observed readBack=true lockRelease=verified',
    '[migrate] apply(up) teardown: requested=true completed=true gracefulSocketClose=not_observed code=none',
    '[migrate] apply(up) mutation: commit_not_attempted commit_attempted=false',
    '[migrate] managed target: live DEV fingerprint OK',
    '[migrate] dry-run OK. Apply is fail-closed in S1 (requires S1b real-PostgreSQL proof).',
  ];
  for (const line of survives) {
    assert.equal(canonicalMigrateLine(line), line, `bounded evidence must survive: ${line}`);
  }

  const discarded = [
    // The three raw message interpolations — a driver string, an Error, a caught throw.
    '[migrate] REFUSED: connection terminated unexpectedly',
    '[migrate] ERROR: no migration found for "../../etc/passwd" under server/platform-identity/migrations/',
    '[migrate] FATAL: connect ECONNREFUSED 203.0.113.7:5432',
    // The disposable database suffix: operator-supplied DSN text behind a fixed prefix.
    '[migrate] status: disposable target host=unix_socket database=tmpos_s1b_deadbeefcafebabe',
    // The unvalidated version token from argv.
    '[migrate] resolve-dirty plan: version=../../secret status=resolved_failed',
    // The unprefixed detail continuation lines, which carry no tag at all.
    '  - residue observed: tmpos_s1b_deadbeef',
    // And ordinary hostile shapes.
    '[migrate] status: outcome=postgresql://u:p@h.example.com:5432/postgres',
    '[migrate] password=hunter2',
    '[migrate] status: outcome=hunter2',
  ];
  for (const line of discarded) {
    assert.equal(canonicalMigrateLine(line), null, `must be discarded: ${line}`);
  }

  // AND THE DISCARDS ARE COUNTED rather than silent, split by the stream they arrived on.
  const rendered = renderMigrateTranscript(survives.join('\n'), discarded.slice(0, 3).join('\n'), true);
  const notice = rendered[rendered.length - 1];
  assert.match(notice, /stdoutUnparsable=0 stderrUnparsable=3 overCap=0 truncated=false$/);
  assert.equal(rendered.length, survives.length + 1, 'every bounded line rendered, plus one notice');

  // THE KEY SET IS DECLARED, not open: an undeclared key cannot be emitted at all.
  assert.ok(MIGRATE_FIELD_KEYS.length >= 20, `the migrate table must be populated: ${MIGRATE_FIELD_KEYS.length}`);
  assert.ok(!MIGRATE_FIELD_KEYS.includes('message'), 'there is no raw-message field to forward');
});

// =============================================================================
// C2B-M005-LRLS-L3-R4-R1 — MIGRATION TERMINAL-EVIDENCE CLOSURE
//
// The same defect as the m005 launcher, in the same child: `runThroughManagedExecutor` emits its
// post-cleanup record as `[migrate] <op> teardown: …`, and the unlabelled `[migrate] outcome=`
// matcher could never reach it — `terminalVocabulary.migrate` was an empty array, so the positive
// gate could not fire at all and a child destroyed by a Linux realtime signal (34, 40, 64 arrive as
// `exitCode=0 signal=null`) fell straight through to OK.
//
// This launcher drives the `baseline` op, so that is the label its child interpolates.
// =============================================================================

/** A capture whose stdout and stderr are supplied verbatim, sealed unless told otherwise. */
const capturedStreams = (stdout, stderr = '', over = {}) => ({
  overflowed: false,
  byteLength: Buffer.byteLength(stdout) + Buffer.byteLength(stderr),
  text: () => `${stdout}${stderr}`,
  streamText: (s) => (s === 'stdout' ? stdout : stderr),
  ...over,
});


// =============================================================================
// C2B-M005-LRLS-L3-R4-R2 — POST-DECISION TERMINAL RECORD
//
// R4-R1 closed every kill up to the cleanup boundary and left one window open: a signal delivered
// AFTER the teardown record but BEFORE the child applied its refusal still produced a valid-looking
// post-cleanup record and `exit=0 signal=null`, and the launcher called it OK. The child now emits
// a second record — its verdict, its cleanup outcome and its exit class — after all of them, and
// writes nothing to either stream afterwards. An OK result requires the consistent PAIR.
// =============================================================================

const B_TEARDOWN_OK = MIGRATE_TEARDOWN_OK;
const B_TERMINAL_OK = MIGRATE_POST_DECISION_OK;
/** Both records, in the order the child writes them: the complete evidence of a clean run. */
const B_PAIR_OK = MIGRATE_TERMINAL_OK;
const B_TEARDOWN_FAILED =
  '[migrate] baseline teardown: requested=true completed=false gracefulSocketClose=not_observed code=client_teardown_failed';
const B_TERMINAL_REFUSED =
  '[migrate] baseline terminal: decision=refused cleanup=completed exit=failure code=none';
const B_TERMINAL_REFUSED_UNCLEAN =
  '[migrate] baseline terminal: decision=refused cleanup=failed exit=failure code=client_teardown_failed';
const B_TERMINAL_THREW =
  '[migrate] baseline terminal: decision=failed cleanup=completed exit=failure code=none';
const B_TERMINAL_NO_CLIENT =
  '[migrate] baseline terminal: decision=failed cleanup=not_attempted exit=failure code=none';
const B_PRE_CLEANUP = '[migrate] baseline: outcome=complete rows=0 disposal=closed code=none';

const bEvidence = (stdout, stderr = '') =>
  terminalEvidenceFor(evidenced({ capture: capturedStreams(stdout, stderr) }));

test('R4-R2/§4: an OK result requires the PAIR — the teardown record alone no longer suffices', () => {
  const clean = bEvidence([B_PRE_CLEANUP, B_PAIR_OK].join('\n'));
  assert.equal(clean.ok, true);
  assert.equal(clean.reason, 'complete');
  assert.equal(clean.code, 'terminal_completed');

  // THE R4-R1 RESIDUAL, CLOSED. This is exactly what a child destroyed between its teardown record
  // and its refusal leaves behind, and R4-R1 read it as proof of completion.
  const teardownOnly = bEvidence([B_PRE_CLEANUP, B_TEARDOWN_OK].join('\n'));
  assert.equal(teardownOnly.ok, false, 'the cleanup record alone must not establish completion');
  assert.equal(teardownOnly.reason, 'missing');

  // AND THE CONVERSE. A post-decision record with no cleanup record behind it is not a clean run
  // either: the success tuple pins the teardown it must stand beside, and there is none.
  assert.equal(bEvidence(B_TERMINAL_OK).reason, 'cleanup_mismatch');

  // §5 missing · duplicated · not final (canonical AND unparsable trailing output)
  assert.equal(bEvidence(B_PRE_CLEANUP).reason, 'missing');
  assert.equal(bEvidence('').reason, 'missing');
  assert.equal(bEvidence([B_TEARDOWN_OK, B_TERMINAL_OK, B_TERMINAL_OK].join('\n')).reason, 'duplicated');
  assert.equal(bEvidence([B_TEARDOWN_OK, B_TEARDOWN_OK, B_TERMINAL_OK].join('\n')).reason, 'duplicated');
  assert.equal(bEvidence([B_PAIR_OK, B_PRE_CLEANUP].join('\n')).reason, 'not_final');
  assert.equal(bEvidence([B_PAIR_OK, '!! partial garbage'].join('\n')).reason, 'not_final');
  assert.equal(bEvidence([B_PAIR_OK, B_TEARDOWN_OK].join('\n')).reason, 'not_final');

  // §5 wrong label / wrong field order / unknown value / truncated — each on the record that decides
  assert.equal(bEvidence([B_TEARDOWN_OK, B_TERMINAL_OK.replace(' terminal:', ' evidence:')].join('\n')).reason, 'missing');
  assert.equal(
    bEvidence([B_TEARDOWN_OK, '[migrate] baseline terminal: cleanup=completed decision=success exit=success code=none'].join('\n')).reason,
    'malformed',
  );
  assert.equal(
    bEvidence([B_TEARDOWN_OK, '[migrate] baseline terminal: decision=maybe cleanup=completed exit=success code=none'].join('\n')).reason,
    'missing',
  );
  assert.equal(bEvidence([B_TEARDOWN_OK, '[migrate] baseline terminal: decision=success cleanup'].join('\n')).reason, 'missing');

  // CONTRADICTORY WHOLE RECORDS. Every field canonicalises against its own domain, so a success
  // decision beside a failure exit class passes the grammar while asserting two incompatible things.
  for (const bad of [
    '[migrate] baseline terminal: decision=success cleanup=completed exit=failure code=none',
    '[migrate] baseline terminal: decision=failed cleanup=completed exit=success code=none',
    '[migrate] baseline terminal: decision=success cleanup=failed exit=success code=client_teardown_failed',
    '[migrate] baseline terminal: decision=success cleanup=completed exit=success code=checksum_mismatch',
  ]) assert.equal(bEvidence([B_TEARDOWN_OK, bad].join('\n')).reason, 'contradictory', bad);

  // CONTRADICTORY PAIR. Each record is individually well-formed and they disagree about one
  // teardown — the failure a per-record check cannot see and a pair check cannot miss.
  assert.equal(bEvidence([B_TEARDOWN_FAILED, B_TERMINAL_OK].join('\n')).reason, 'cleanup_mismatch');
  assert.equal(bEvidence([B_TEARDOWN_OK, B_TERMINAL_REFUSED_UNCLEAN].join('\n')).reason, 'cleanup_mismatch');
  assert.equal(bEvidence([B_TEARDOWN_OK, B_TERMINAL_NO_CLIENT].join('\n')).reason, 'cleanup_mismatch');
  // A teardown tuple the child cannot emit fails the pair too, without a second table to say so.
  assert.equal(
    bEvidence([
      '[migrate] baseline teardown: requested=true completed=true gracefulSocketClose=not_observed code=checksum_mismatch',
      B_TERMINAL_OK,
    ].join('\n')).reason,
    'cleanup_mismatch',
  );
  // A DUPLICATED or MALFORMED cleanup record is refused as itself, not silently treated as absent.
  assert.equal(bEvidence([B_TEARDOWN_OK, B_TEARDOWN_OK, B_TERMINAL_NO_CLIENT].join('\n')).reason, 'duplicated');

  // GENUINE ADVERSE RECORDS: present, valid, consistent — and still not OK.
  for (const [name, stdout, reason, code] of [
    ['refusal', [B_TEARDOWN_OK, B_TERMINAL_REFUSED].join('\n'), 'child_refused', null],
    ['refusal + failed teardown', [B_TEARDOWN_FAILED, B_TERMINAL_REFUSED_UNCLEAN].join('\n'), 'child_refused', 'client_teardown_failed'],
    ['thrown failure', [B_TEARDOWN_OK, B_TERMINAL_THREW].join('\n'), 'child_failed', null],
    ['throw before the client existed', B_TERMINAL_NO_CLIENT, 'child_failed', null],
  ]) {
    const r = bEvidence(stdout);
    assert.equal(r.ok, false, `${name}: never OK`);
    assert.equal(r.reason, reason, name);
    assert.equal(r.code, code, name);
  }

  // THE SEAL. The same bytes with closure unproved establish nothing.
  const sealed = evidenced({ capture: capturedStreams(B_PAIR_OK) });
  assert.equal(terminalEvidenceFor({ ...sealed, streamsClosed: false }).reason, 'streams_not_proved_closed');
  assert.equal(terminalEvidenceFor({ ...sealed, capture: {} }).reason, 'stream_text_unavailable');
  assert.equal(MIGRATE_TAG, 'migrate');
});

test('R4-R2/§4: a successful terminal token can never RESCUE an adverse disposition', () => {
  for (const [name, over] of [
    ['nonzero exit', { exitCode: 1 }],
    ['signalled', { signal: 'SIGKILL', exitCode: null }],
    ['residual group', { group: groupOrphan(), status: 'group_residual' }],
    ['containment hold', { containmentHold: true }],
    ['overflow', { capture: capturedStreams(B_PAIR_OK, '', { overflowed: true }) }],
  ]) {
    const result = evidenced({ capture: capturedStreams(B_PAIR_OK), ...over });
    const d = dispositionFor(result);
    assert.notEqual(d.code, LAUNCHER_CODES.OK, `${name}: not OK`);
    assert.notEqual(d.exitCode, 0, `${name}: never exits 0`);
  }
  // A FAILURE RECORD PAIRED WITH EXIT ZERO. The child says it refused; the process exited 0 anyway.
  // Only the record can see that, and it must refuse rather than believe the exit code.
  for (const adverse of [B_TERMINAL_REFUSED, B_TERMINAL_THREW]) {
    const r = evidenced({ capture: capturedStreams([B_TEARDOWN_OK, adverse].join('\n')), exitCode: 0, signal: null });
    const d = dispositionFor(r);
    assert.equal(d.code, LAUNCHER_CODES.TERMINAL_EVIDENCE_INCOMPLETE, adverse);
    assert.notEqual(d.exitCode, 0, adverse);
  }
  // §5.11 — an OVERFLOWED capture is refused for the reason that is TRUE (the bytes were discarded
  // unread), not for a missing record it had no chance to contain.
  const over = evidenced({ capture: capturedStreams(B_PAIR_OK, '', { overflowed: true }) });
  assert.equal(dispositionFor(over).code, LAUNCHER_CODES.OUTPUT_LIMIT_EXCEEDED);
});

test('R4-R2/§4: the printed record and the exit code state ONE disposition, not two', () => {
  const noEvidence = evidenced({ capture: capturedStreams(B_TEARDOWN_OK) });
  const d = dispositionFor(noEvidence);
  assert.equal(d.code, LAUNCHER_CODES.TERMINAL_EVIDENCE_INCOMPLETE);
  assert.equal(d.exitCode, 1);
  const text = renderReport(noEvidence, buildRedactor([]), d);
  assert.ok(text.includes('terminalEvidence=incomplete reason=missing'), 'the record states the cause');

  // NON-VACUITY: OK is genuinely reachable.
  const good = evidenced({ capture: capturedStreams([B_PRE_CLEANUP, B_PAIR_OK].join('\n')) });
  const gd = dispositionFor(good);
  assert.equal(gd.code, LAUNCHER_CODES.OK);
  assert.equal(gd.exitCode, 0);
  assert.ok(renderReport(good, buildRedactor([]), gd).includes('terminalEvidence=complete reason=complete'));

  // The record is derived from the SAME call for every shape, so the two cannot disagree.
  for (const stdout of [
    '', B_PRE_CLEANUP, B_TEARDOWN_OK, B_TERMINAL_OK, B_PAIR_OK,
    [B_TEARDOWN_OK, B_TERMINAL_OK, B_TERMINAL_OK].join('\n'),
    [B_TEARDOWN_FAILED, B_TERMINAL_REFUSED_UNCLEAN].join('\n'),
  ]) {
    const r = evidenced({ capture: capturedStreams(stdout) });
    const dd = dispositionFor(r);
    assert.ok(renderReport(r, buildRedactor([]), dd).includes(`terminalEvidence=${dd.terminal.ok ? 'complete' : 'incomplete'}`));
    assert.equal(dd.exitCode === 0, dd.code === LAUNCHER_CODES.OK, 'exit 0 iff the disposition is OK');
  }
});

test('R4-R2/§5.16: no raw migration message, error or driver text escapes the record', () => {
  const hostile = [
    B_PRE_CLEANUP,
    '[migrate] REFUSED: postgres://user:hunter2@db.example.com:5432/postgres',
    '[migrate] FATAL: Error: connect ECONNREFUSED 10.0.0.1:5432',
    B_TEARDOWN_OK,
    B_TERMINAL_OK,
  ].join('\n');
  const stderrText = 'raw stderr: SUPERSECRET_HUNTER2';
  const r = evidenced({ capture: capturedStreams(hostile, stderrText) });
  assert.equal(terminalEvidenceFor(r).ok, true, 'the record still stands among discarded lines');
  const text = renderReport(r, buildRedactor([]), dispositionFor(r));
  for (const leak of ['hunter2', 'SUPERSECRET_HUNTER2', 'ECONNREFUSED', '10.0.0.1', 'db.example.com', 'user:']) {
    assert.ok(!text.includes(leak), `raw child text must not reach the record: ${leak}`);
  }
  assert.ok(text.includes(B_TERMINAL_OK), 'the canonical record itself is reported');
  assertClean(text, 'hostile migration transcript');
});

test('R4-R2/§5: realtime signals 34, 40 and 64 in EVERY window, against REAL subprocesses', async () => {
  const run = (script) => runChild({
    command: process.execPath,
    args: ['-e', script],
    env: { PATH: process.env.PATH ?? '' },
    limit: 65536,
    timeoutMs: 20000,
  });
  const say = (line) => `console.log(${JSON.stringify(line)});`;
  /** A line the child was cut off mid-write: non-empty, non-canonical, and never discardable. */
  const partial = (line) => `process.stdout.write(${JSON.stringify(line.slice(0, 30))});`;
  const cry = (line) => `console.error(${JSON.stringify(line)});`;

  // THE SIX WINDOWS OF §5, each a deterministic barrier expressed as what the child had written
  // when the signal arrived. Windows 3 and 4 leave the SAME stdout — the refusal is applied on
  // stderr — which is the point: nothing on stdout distinguishes "about to refuse" from "about to
  // succeed", so only a record written after the refusal can.
  const WINDOWS = [
    ['1 before teardown', say(B_PRE_CLEANUP), 'missing'],
    ['2 during cleanup', say(B_PRE_CLEANUP) + partial(B_TEARDOWN_OK), 'missing'],
    ['3 after teardown, before the decision', say(B_PRE_CLEANUP) + say(B_TEARDOWN_OK), 'missing'],
    ['4 after the decision, before the record',
      say(B_PRE_CLEANUP) + say(B_TEARDOWN_OK) + cry('[migrate] REFUSED: baseline refused before completion: checksum_mismatch.'),
      'missing'],
    ['5 after a non-final record', say(B_PRE_CLEANUP) + say(B_TEARDOWN_OK) + say(B_TERMINAL_OK) + say(B_PRE_CLEANUP), 'not_final'],
    ['5b after a FORGED record with no cleanup behind it', say(B_TERMINAL_OK), 'cleanup_mismatch'],
  ];

  for (const signal of [34, 40, 64]) {
    for (const [name, script, reason] of WINDOWS) {
      const killed = await run(`${script}process.kill(process.pid,${signal});`);
      assert.equal(killed.exitCode, 0, `${name}: signal ${signal} must arrive as exit 0`);
      assert.equal(killed.signal ?? null, null, `${name}: signal ${signal} must arrive as no signal at all`);
      assert.equal(terminalEvidenceFor(killed).reason, reason, `${name} @ ${signal}`);
      const d = dispositionFor(killed);
      assert.equal(d.code, LAUNCHER_CODES.TERMINAL_EVIDENCE_INCOMPLETE, `${name} @ ${signal}: must not reach OK`);
      assert.notEqual(d.exitCode, 0, `${name} @ ${signal}`);
    }

    // WINDOW 6 — the signal arrives after the genuine final record. It may remain OK, and only
    // because the child's source ordering (pinned below) proves there was nothing left to do:
    // cleanup completed, the decision and exit class fixed, the record written, no further write.
    const after = await run(say(B_PRE_CLEANUP) + say(B_PAIR_OK) + `process.kill(process.pid,${signal});`);
    assert.equal(after.exitCode, 0);
    assert.equal(terminalEvidenceFor(after).ok, true, `window 6 @ ${signal}`);
    assert.equal(dispositionFor(after).exitCode, 0, `window 6 @ ${signal}: nothing was left unfinished`);
  }

  // §5.1 — THE CONTROL, so none of the above passes merely because nothing can reach OK.
  const clean = await run(say(B_PRE_CLEANUP) + say(B_PAIR_OK));
  assert.equal(terminalEvidenceFor(clean).ok, true);
  assert.equal(dispositionFor(clean).exitCode, 0);

  // §5.9 — the record split across writes is still one record.
  const split = await run(
    say(B_PRE_CLEANUP) + say(B_TEARDOWN_OK)
    + `process.stdout.write(${JSON.stringify(B_TERMINAL_OK.slice(0, 18))});`
    + `process.stdout.write(${JSON.stringify(B_TERMINAL_OK.slice(18) + '\n')});`,
  );
  assert.equal(terminalEvidenceFor(split).ok, true);

  // §5.10 — non-empty unexpected stderr neither supplies nor destroys the record, and never reaches
  // the operator's record raw.
  const noisy = await run(
    say(B_PRE_CLEANUP) + say(B_PAIR_OK)
    + cry('[migrate] REFUSED: postgres://u:hunter2@h/postgres'),
  );
  assert.equal(terminalEvidenceFor(noisy).ok, true);
  assert.ok(!renderReport(noisy, buildRedactor([]), dispositionFor(noisy)).includes('hunter2'));
});

test('R4-R2/§5: controlled success, refusal, teardown failure, throw, missing and contradiction', async () => {
  const run = (script, code = 0) => runChild({
    command: process.execPath,
    args: ['-e', script],
    env: { PATH: process.env.PATH ?? '' },
    limit: 65536,
    timeoutMs: 20000,
  });
  const emit = (lines, exit) =>
    `${lines.map((l) => `console.log(${JSON.stringify(l)});`).join('')}process.exitCode=${exit};`;

  for (const [name, lines, exit, ok, reason] of [
    ['controlled success', [B_PRE_CLEANUP, B_TEARDOWN_OK, B_TERMINAL_OK], 0, true, 'complete'],
    ['controlled refusal', [B_TEARDOWN_OK, B_TERMINAL_REFUSED], 2, false, 'child_refused'],
    ['teardown failure', [B_TEARDOWN_FAILED, B_TERMINAL_REFUSED_UNCLEAN], 2, false, 'child_refused'],
    ['thrown failure', [B_TEARDOWN_OK, B_TERMINAL_THREW], 2, false, 'child_failed'],
    ['throw before the client existed', [B_TERMINAL_NO_CLIENT], 2, false, 'child_failed'],
    ['missing evidence', [B_PRE_CLEANUP], 0, false, 'missing'],
    ['contradictory evidence', [B_TEARDOWN_FAILED, B_TERMINAL_OK], 0, false, 'cleanup_mismatch'],
  ]) {
    const r = await run(emit(lines, exit));
    assert.equal(r.exitCode, exit, `${name}: the child's own exit code`);
    const t = terminalEvidenceFor(r);
    assert.equal(t.ok, ok, name);
    assert.equal(t.reason, reason, name);
    const d = dispositionFor(r);
    assert.equal(d.exitCode === 0, ok && exit === 0, `${name}: exit 0 only for a clean pair on a clean exit`);
  }
});

test('R4-R2/§3+§9: the child emits its record LAST, and nothing follows it', () => {
  // THE ORDERING IS THE CONTRACT, and it is decided in the child. A launcher-side check can only
  // observe that a record arrived last on stdout; that the child had nothing left to DO when it
  // wrote it is a property of this source and is asserted here.
  const fn = MIGRATE_CODE.indexOf('async function runThroughManagedExecutor');
  assert.ok(fn > 0, 'the managed entry point must exist');
  const end = MIGRATE_CODE.indexOf('\n}\n', fn);
  assert.ok(end > fn, 'the managed entry point must close');
  const body = MIGRATE_CODE.slice(fn, end);
  const iRecord = body.indexOf('`[migrate] ${op} terminal:');
  assert.ok(iRecord > 0, 'the post-decision record must exist');
  assert.equal((MIGRATE_CODE.match(/terminal: decision=/g) ?? []).length, 1, 'exactly one such record in the CLI');

  // EMITTED ONLY AFTER all five preconditions §3 names.
  for (const [what, marker] of [
    ['the bounded outcome', '} catch (err) {'],
    ['handle disposal', 'const teardown = await handle.dispose()'],
    ['the cleanup record', '${op} teardown: requested='],
    ['the final verdict', 'refusal = classifyManagedApplyRefusal(op, {'],
    ['the refusal application', 'console.error(`[migrate] REFUSED: ${refusal}`)'],
    ['the exit classification', 'process.exitCode = exitCode'],
  ]) {
    const at = body.indexOf(marker);
    assert.ok(at > 0, `${what} must be present: ${marker}`);
    assert.ok(at < iRecord, `${what} must precede the terminal record`);
  }

  // AND NOTHING FOLLOWS IT. The record's own write is the LAST write of any kind in the function.
  assert.equal(body.lastIndexOf('console.'), body.lastIndexOf('console.', iRecord),
    'no console write may follow the terminal record');
  assert.equal((body.match(/process\.stdout\.write\(/g) ?? []).length, 1,
    'exactly one direct stdout write — the record itself');
  const tail = body.slice(iRecord);
  for (const forbidden of ['await', 'refuse(', 'refusal =', 'console.', 'dispose(', 'classify', 'return']) {
    assert.ok(!tail.includes(forbidden), `nothing may follow the terminal record: ${forbidden}`);
  }

  // THE ONE THING THAT MAY REMAIN IS THE PROCESS COMPLETING, and it is a completion CALLBACK on the
  // record's own write — so the record is flushed to the pipe before the process ends. `process.exit`
  // could not stand before the record (that is the window this record closes) and could not stand
  // after it unflushed (an explicit exit truncates a pending pipe write); this is the one placement
  // that is neither.
  assert.match(tail, /\(\) => \{ if \(exitCode !== 0\) process\.exit\(exitCode\); \}/,
    'the only act after the record is the process ending');
  assert.equal((body.match(/process\.exit\(/g) ?? []).length, 1,
    'exactly one process exit in this function, in that callback');
  assert.ok(tail.length < 330, `the tail must be the record and its completion callback only: ${tail.length}`);

  // THE REFUSAL IS APPLIED INLINE, not through `refuse()` — which ends the process from inside
  // itself and would leave the record no place after it.
  assert.ok(!body.includes('refuse('), 'the managed path must not exit from inside a helper');

  // EVERY FIELD COMES FROM A CLOSED SET decided in this file, and nothing else is interpolated.
  const recordSrc = body.slice(iRecord, body.indexOf('\\n`,', body.indexOf('code=${cleanupCode}')));
  assert.deepEqual(recordSrc.match(/\$\{[^}]*\}/g) ?? [],
    ['${op}', '${decision}', '${cleanup}', '${exitClass}', '${cleanupCode}'],
    'no unbounded value may be interpolated into the record');
  assert.match(body, /const decision = threw \? 'failed' : refusal === null \? 'success' : 'refused';/,
    'the decision must be derived from the throw latch and the refusal, in that order');
  // THE EXIT CLASS AND THE EXIT CODE BOTH DERIVE FROM `decision`. Deriving either of them from
  // `refusal` separately made `decision=failed exit=success` expressible — a record the child's own
  // table calls impossible, prevented only by where one assignment happens to sit.
  assert.match(body, /const exitClass = decision === 'success' \? 'success' : 'failure';/,
    'the exit class must derive from the decision, not from the refusal');
  assert.match(body, /const exitCode = decision === 'success' \? 0 : PG_VALIDATION_EXIT;/,
    'the exit code must derive from the decision, not from the refusal');
  assert.match(body, /cleanup = teardown\.completed \? 'completed' : 'failed';/,
    'the cleanup field must be derived from the teardown, not recomputed');
  assert.match(body, /let cleanup: 'completed' \| 'failed' \| 'not_attempted' = 'not_attempted';/,
    'the cleanup field must be typed as its closed set, defaulting to not-attempted');
  // AND THE TEARDOWN CODE IS BOUNDED AT THIS BOUNDARY. `TeardownResult.code` is typed `string |
  // null`, so the record's finite-vocabulary claim rests on this check, not on that type.
  assert.match(body, /const observed = teardown\.code \?\? 'none';/,
    'the teardown code must be read once into a local before it is bounded');
  assert.match(
    body,
    /cleanupCode = observed === 'none' \|\| observed === 'client_teardown_failed'\s*\?\s*observed\s*:\s*'teardown_code_unrecognized';/,
    'an unrecognized teardown code must be refused, never forwarded',
  );
  // The substituted token is OUTSIDE the launcher's declared code domain, so such a record cannot
  // canonicalise at all and the run reports no completion evidence — verified, not assumed.
  assert.equal(
    canonicalMigrateLine('[migrate] baseline teardown: requested=true completed=false '
      + 'gracefulSocketClose=not_observed code=teardown_code_unrecognized'),
    null,
    'the refusal token must not be a member of the code vocabulary',
  );
});

test('R4-R2/§6: the child change touches OUTPUT EVIDENCE only', () => {
  const fn = MIGRATE_CODE.indexOf('async function runThroughManagedExecutor');
  const body = MIGRATE_CODE.slice(fn, MIGRATE_CODE.indexOf('\n}\n', fn));
  const iRecord = body.indexOf('`[migrate] ${op} terminal:');
  // Everything the stage forbids changing is still where it was, and all of it precedes the record.
  for (const marker of [
    'handle = await openManagedExecutor(op);',
    'verifyManagedDevFingerprint(',
    'assertExactManagedApplyPlan(planned, AUTHORIZED_APPLY_VERSION)',
    'runTrustedApply({',
    'runTrustedHistoricalBaseline({',
    'lockKey: RUN_LOCK_KEY',
    'createManagedM005Policy({',
    'planApply(pairs, read.rows)',
    'planBaseline(pairs, read.rows, allowlist)',
  ]) {
    const at = body.indexOf(marker);
    assert.ok(at > 0, `unchanged surface must still be present: ${marker}`);
    assert.ok(at < iRecord, `${marker} must precede the record — no work may follow it`);
  }
  // V2 — THE GATES MOVED WITH THE CONSTRUCTION, NOT AWAY FROM IT. The operator gates, the managed DSN
  // validation and the environment seal sit in the one production open, in their original order and
  // ahead of the single construction, so the runner reaches a client only through all three.
  const openAt = MIGRATE_CODE.indexOf('async function openManagedExecutor(');
  assert.ok(openAt > 0, 'the production open must exist');
  const open = MIGRATE_CODE.slice(openAt, MIGRATE_CODE.indexOf('\n}\n', openAt));
  let last = -1;
  for (const marker of [
    'assertOperatorGates(op, true)',
    'assertManagedDevDsn(process.env.SUPABASE_DATABASE_URL',
    'assertSealedManagedEnvironment(op);',
    'return createManagedDevExecutor(dsn);',
  ]) {
    const at = open.indexOf(marker);
    assert.ok(at > last, `the production open keeps the gate order: ${marker}`);
    last = at;
  }
  // EXACTLY ONE client is ever constructed on this path, and the record adds none.
  assert.equal((MIGRATE_CODE.match(/createManagedDevExecutor\(/g) ?? []).length, 1,
    'the single construction — the record opens no connection');
  // NO SQL, no query construction and no lock call was added anywhere near the record.
  const tail = body.slice(iRecord);
  for (const forbidden of ['select ', 'pg_', 'sql', 'lock', 'adapter', 'ledger', 'catalog']) {
    assert.ok(!tail.toLowerCase().includes(forbidden), `no database surface may follow the record: ${forbidden}`);
  }
});

// ---- V2 — the production entry point, run -------------------------------------
//
// The in-process harness in managed-m005-launcher.test.mjs proves what `runThroughManagedExecutor`
// does with any sealed port set. These local children prove the other half: that the CLI still
// reaches that same function, exactly once, with the PRODUCTION set. Both are contact-free by
// construction — the child environment is explicit (nothing is inherited) and carries no DSN, so the
// production open refuses at DSN validation, after the operator gates and before any client exists.

async function runMigrateCli(args, env) {
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(NODE_BIN, [TSX_CLI, MIGRATE_SCRIPT, ...args], { cwd: REPO_ROOT, env, encoding: 'utf8', timeout: 60_000 });
  return { status: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr };
}

test('V2: the production CLI runs main() exactly once, through its one guarded call site', async () => {
  const r = await runMigrateCli(['--list'], {});
  assert.equal(r.status, 0, r.stderr);
  assert.equal((r.stdout.match(/^\[migrate\] discovered migrations under /gm) ?? []).length, 1, 'one run of main()');
  assert.equal((r.stdout.match(/^\[migrate\] list mode: no database connection, no SQL executed\.$/gm) ?? []).length, 1);
  // The one call site is the guarded one, so importing the module (as this file and the harness do)
  // runs nothing.
  assert.deepEqual(MIGRATE_CODE.match(/(?<!function )\bmain\(\)[^;\n]*/g), ['main().catch((err) => {']);
  assert.match(MIGRATE_CODE, /\nif \(IS_CLI_ENTRY\) main\(\)\.catch\(/);
});

test('V2: the production dispatch reaches runThroughManagedExecutor through the production ports, gates first', async () => {
  // Only `runThroughManagedExecutor` writes this record, and only the PRODUCTION open refuses like
  // this: the operator gates pass, the DSN is absent, so the run ends in the catch with no handle.
  const gated = { ALLOW_SUPABASE_MIGRATION_APPLY: '1', CONFIRM_SUPABASE_TARGET: 'tmpos2026-dev' };
  const r = await runMigrateCli(['--managed-dev', '--baseline', '--confirm-dev'], gated);
  assert.equal(r.stdout, '[migrate] baseline terminal: decision=failed cleanup=not_attempted exit=failure code=none\n');
  assert.equal(r.stderr, '[migrate] REFUSED: baseline refused before completion: managed_dsn_invalid.\n');
  assert.equal(r.status, 2);

  // AND THE GATES ARE FIRST. Without the acknowledgement the same command is refused by the gate
  // inside the production open, before the runner can write anything at all.
  const ungated = await runMigrateCli(['--managed-dev', '--baseline', '--confirm-dev'], {});
  assert.equal(ungated.stdout, '');
  assert.equal(
    ungated.stderr,
    '[migrate] REFUSED: migration_operator_gate_unsatisfied — "baseline" requires: ALLOW_SUPABASE_MIGRATION_APPLY=1, '
      + 'CONFIRM_SUPABASE_TARGET=<dev target label>. No database connection was attempted.\n',
  );
  assert.equal(ungated.status, 2);
});

test('V2-R2: the production dispatch routes --status to the managed runner as status, through the production ports, gates first', async () => {
  // `--managed-dev --status` must reach `runThroughManagedExecutor('status', PRODUCTION_MANAGED_PORTS)`: the record
  // names status, and only the production open refuses like this — gates satisfied, no DSN, no handle.
  const gated = { ALLOW_SUPABASE_MIGRATION_APPLY: '1', CONFIRM_SUPABASE_TARGET: 'tmpos2026-dev' };
  const r = await runMigrateCli(['--managed-dev', '--status', '--confirm-dev'], gated);
  assert.equal(r.stdout, '[migrate] status terminal: decision=failed cleanup=not_attempted exit=failure code=none\n');
  assert.equal(r.stderr, '[migrate] REFUSED: status refused before completion: managed_dsn_invalid.\n');
  assert.equal(r.status, 2);
  // The gates hold for status as for the mutating operations: the production open refuses first.
  const ungated = await runMigrateCli(['--managed-dev', '--status', '--confirm-dev'], {});
  assert.equal(ungated.stdout, '');
  assert.equal(
    ungated.stderr,
    '[migrate] REFUSED: migration_operator_gate_unsatisfied — "status" requires: ALLOW_SUPABASE_MIGRATION_APPLY=1, '
      + 'CONFIRM_SUPABASE_TARGET=<dev target label>. No database connection was attempted.\n',
  );
  assert.equal(ungated.status, 2);
});

test('R4-R2/§5.18: the command, environment and containment boundaries are unchanged', async () => {
  const { seen, status } = await captureSpawn();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].command, NODE_BIN);
  assert.deepEqual(seen[0].args, [TSX_CLI, MIGRATE_SCRIPT, ...BASELINE_FLAGS]);
  assert.equal(seen[0].options.shell, false);
  assert.equal(seen[0].options.detached, true);
  assert.equal(seen[0].options.cwd, REPO_ROOT);
  assert.deepEqual(seen[0].options.stdio, ['ignore', 'pipe', 'pipe']);
  assert.deepEqual(Object.keys(seen[0].options.env).sort(), [...CHILD_ENV_KEYS].sort());
  assert.equal(status, 0);
});

test('R4-R2: a canonical record with the wrong FIELD COUNT is malformed, not truncated-to-fit', () => {
  const short = '[migrate] baseline terminal: decision=success cleanup=completed exit=success';
  const long = `${B_TERMINAL_OK} rows=0`;
  assert.notEqual(canonicalMigrateLine(short), null, 'the short form really is canonical');
  assert.notEqual(canonicalMigrateLine(long), null, 'the long form really is canonical');
  assert.equal(bEvidence([B_TEARDOWN_OK, short].join('\n')).reason, 'malformed', 'too few fields');
  assert.equal(bEvidence([B_TEARDOWN_OK, long].join('\n')).reason, 'malformed', 'too many fields — extras are not ignored');
  // The SAME rule on the cleanup half of the pair, which is matched by the same helper.
  const shortCleanup = '[migrate] baseline teardown: requested=true completed=true gracefulSocketClose=not_observed';
  assert.notEqual(canonicalMigrateLine(shortCleanup), null);
  assert.equal(bEvidence([shortCleanup, B_TERMINAL_OK].join('\n')).reason, 'malformed');
});

/** One post-decision record, with any field overridden — for probing the declared domains. */
const termLine = (o = {}) => {
  const f = { decision: 'success', cleanup: 'completed', exit: 'success', code: 'none', ...o };
  return `[migrate] baseline terminal: decision=${f.decision} cleanup=${f.cleanup} exit=${f.exit} code=${f.code}`;
};

test('R4-R2: the post-decision record\'s keys admit EXACTLY the values the child can emit', () => {
  // THE DOMAIN IS THE FIRST GATE, and it is separate from the whole-tuple table behind it. A value
  // the child cannot produce must fail to canonicalise at all, so it is DISCARDED rather than
  // carried into the matcher — where it would be refused, but as `contradictory` instead of as the
  // unparsable line it actually is. Widening a domain by one word costs nothing visible until the
  // day the record it admits is the one an operator reads, so the sets are pinned in both
  // directions: every declared value canonicalises, and nothing else does.
  const DOMAINS = [
    ['decision', ['success', 'refused', 'failed']],
    ['cleanup', ['completed', 'failed', 'not_attempted']],
    ['exit', ['success', 'failure']],
  ];
  // THE FORBIDDEN SET INCLUDES EVERY OTHER KEY'S VALUES, which is the mistake this actually guards
  // against: three sibling domains edited by copy-paste leak each other's words, and `cleanup=success`
  // or `decision=completed` reads plausibly enough to survive review. Cross-key leakage is tested
  // explicitly rather than left to a hand-picked list of implausible strings.
  const CROSS_KEY = DOMAINS.flatMap(([, vs]) => vs);
  for (const [key, allowed] of DOMAINS) {
    for (const v of allowed) {
      assert.notEqual(canonicalMigrateLine(termLine({ [key]: v })), null, `${key}=${v} must canonicalise`);
    }
    for (const v of [...CROSS_KEY, 'assumed', 'unknown', 'ok', 'true', 'none', 'complete', 'partial', '', 'SUCCESS']) {
      if (allowed.includes(v)) continue;
      assert.equal(canonicalMigrateLine(termLine({ [key]: v })), null, `${key}=${v} must not canonicalise`);
    }
  }
  // The declared key set really does carry all four, so the loop above is not testing a subset.
  for (const k of ['decision', 'cleanup', 'exit', 'code']) {
    assert.ok(MIGRATE_FIELD_KEYS.includes(k), `the migrate table must declare ${k}`);
  }
});

test('R4-R2: an UNKNOWN tag refuses rather than establishing completion', () => {
  const grammar = createTranscriptGrammar(MIGRATE_SPEC);
  for (const tag of ['m005-preflight', 'not-a-tag', '']) {
    const r = grammar.labelledTerminal(B_PAIR_OK, tag, true);
    assert.equal(r.ok, false, `tag ${tag} must not establish completion`);
    assert.equal(r.reason, 'unknown_tag');
  }
  assert.equal(grammar.labelledTerminal(B_PAIR_OK, 'migrate', true).ok, true);
  // A NON-STRING TAG IS A REFUSAL, NOT AN EXCEPTION. A property lookup coerces its key, so an
  // object with a throwing `Symbol.toPrimitive` escaped as an exception — and a stateful `toString`
  // could answer `migrate` to the `hasOwnProperty` probe and something else to the read after it,
  // leaving `table` undefined and the `.op` access to throw. Neither is reachable through this
  // launcher, which passes a module constant; both are reachable through the exported grammar, and
  // this matcher's contract is that it is TOTAL — an escaping exception is not a refusal.
  let coercions = 0;
  for (const hostile of [
    { [Symbol.toPrimitive]() { throw new Error('coerced'); } },
    { toString() { coercions += 1; return coercions === 1 ? 'migrate' : 'nope'; } },
    undefined, null, 42, Symbol('migrate'), ['migrate'], () => 'migrate',
  ]) {
    let r;
    assert.doesNotThrow(() => { r = grammar.labelledTerminal(B_PAIR_OK, hostile, true); },
      `a non-string tag must refuse, not throw: ${String(typeof hostile)}`);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'unknown_tag');
  }
  // A spec that declares NO operation cannot identify either of its records.
  const opless = createTranscriptGrammar({
    ...MIGRATE_SPEC,
    labelledTerminal: Object.freeze({ migrate: Object.freeze({ ...MIGRATE_SPEC.labelledTerminal.migrate, op: '' }) }),
  });
  assert.equal(opless.labelledTerminal(B_PAIR_OK, 'migrate', true).reason, 'unknown_tag');
});

test('R4-R2: main() END-TO-END refuses a cleanly-exiting child that wrote no post-decision record', async () => {
  // A child that exits 0 with an empty process group and only its teardown record — exactly the
  // shape a realtime-signal kill in the post-cleanup window produces. main() must return non-zero.
  const runWith = async (child) => {
    const out = [];
    const status = await main(['--execute'], SYNTH_SOURCE, {
      out: (l) => out.push(l),
      err: (l) => out.push(l),
      readExecEnv: () => new Map(),
      assertContainment: () => {},
      identify: identifyOk,
      selfIdentity: selfOk,
      killGroup: () => true,
      groupPollMs: 1,
      scan: groupEmpty,
      spawn: () => child(),
      enterHold: () => ({ timer: null, release: () => {}, polls: 0 }),
    });
    return { status, text: out.join('\n') };
  };

  for (const [name, line, reason] of [
    ['no output at all', null, 'missing'],
    ['the teardown record alone', B_TEARDOWN_OK, 'missing'],
    ['a forged post-decision record with no cleanup behind it', B_TERMINAL_OK, 'cleanup_mismatch'],
  ]) {
    const r = await runWith(() => completingChild(line));
    assert.notEqual(r.status, 0, `${name}: no pair, no success`);
    assert.ok(r.text.includes(`outcome=${LAUNCHER_CODES.TERMINAL_EVIDENCE_INCOMPLETE}`), `${name}: the record names it`);
    assert.ok(r.text.includes(`terminalEvidence=incomplete reason=${reason}`), `${name}: ${reason}`);
  }

  // THE CONTROL: the identical run WITH the pair exits 0. The only variable is the record.
  const witnessed = await runWith(() => completingChild());
  assert.equal(witnessed.status, 0);
  assert.ok(witnessed.text.includes(`outcome=${LAUNCHER_CODES.OK}`));
  assert.ok(witnessed.text.includes('terminalEvidence=complete reason=complete'));
});

test('R4-R2: both records must name THIS launcher\'s own operation', () => {
  // This launcher's child argv is `--managed-dev --baseline`, so the only records its child can
  // produce name `baseline`. Anchoring only on the tag and the label left the operation unchecked,
  // and a perfectly-formed APPLY record was accepted here — evidence about a run this launcher
  // never requested, vouching for one it did.
  const bare = '[migrate] terminal: decision=success cleanup=completed exit=success code=none';
  assert.notEqual(canonicalMigrateLine(bare), null, 'the unlabelled form really is canonical');
  assert.equal(bEvidence([B_TEARDOWN_OK, bare].join('\n')).reason, 'missing', 'and establishes nothing');
  for (const foreign of ['apply(up)', 'apply(down)', 'status']) {
    const pair = [
      `[migrate] ${foreign} teardown: requested=true completed=true gracefulSocketClose=not_observed code=none`,
      `[migrate] ${foreign} terminal: decision=success cleanup=completed exit=success code=none`,
    ].join('\n');
    assert.equal(bEvidence(pair).reason, 'missing', `operation ${foreign} must not establish this launcher's completion`);
    // AND HALF-FOREIGN: this launcher's own cleanup record beneath a foreign verdict, and vice versa.
    assert.equal(bEvidence([B_TEARDOWN_OK, pair.split('\n')[1]].join('\n')).reason, 'missing', foreign);
    assert.equal(bEvidence([pair.split('\n')[0], B_TERMINAL_OK].join('\n')).reason, 'cleanup_mismatch', foreign);
  }
  assert.equal(bEvidence(B_PAIR_OK).ok, true, 'the launcher\'s own operation still works');
});

test('R4-R2: a MALFORMED capture fails closed rather than throwing', () => {
  for (const streamText of ['a string', { stdout: 'x' }, 42, null, undefined, {}]) {
    const result = evidenced({ capture: { overflowed: false, streamText } });
    const r = terminalEvidenceFor(result);
    assert.equal(r.ok, false, `streamText=${typeof streamText} must not establish completion`);
    assert.equal(r.reason, 'stream_text_unavailable');
    assert.notEqual(dispositionFor(result).exitCode, 0);
  }
  // A CALLABLE THAT THROWS is the same fact as a non-callable one — the stream could not be read —
  // and must produce the same refusal. The type guard alone does not cover it, and an exception here
  // is not a refusal: it escapes the disposition entirely.
  for (const thrower of [
    () => { throw new Error('boom'); },
    () => { throw new TypeError('decode failed'); },
    () => { throw 'not even an Error'; },
  ]) {
    const result = evidenced({ capture: { overflowed: false, streamText: thrower } });
    assert.equal(terminalEvidenceFor(result).reason, 'stream_text_unavailable',
      'a reader that raises establishes nothing');
    assert.notEqual(dispositionFor(result).exitCode, 0);
  }
  // THROWING GETTERS, not just throwing calls. `?.` guards a null field; it does not guard a getter
  // that raises. All three access points must be inside the guard, or the refusal escapes as an
  // exception — which is not a refusal.
  const raise = (what) => { throw new Error(`${what} getter`); };
  for (const [name, result] of [
    ['capture getter', { streamsClosed: true, get capture() { return raise('capture'); } }],
    ['streamText getter', { streamsClosed: true, capture: { get streamText() { return raise('streamText'); } } }],
    ['streamsClosed getter', { capture: { streamText: () => 'x' }, get streamsClosed() { return raise('closed'); } }],
  ]) {
    const r = terminalEvidenceFor(result);
    assert.equal(r.ok, false, `${name}: must not establish completion`);
    assert.ok(['stream_text_unavailable', 'streams_not_proved_closed'].includes(r.reason), `${name}: ${r.reason}`);
  }
  assert.equal(terminalEvidenceFor({ streamsClosed: true }).reason, 'stream_text_unavailable');
  assert.equal(terminalEvidenceFor(evidenced({ capture: capturedStreams(B_PAIR_OK) })).ok, true);
});

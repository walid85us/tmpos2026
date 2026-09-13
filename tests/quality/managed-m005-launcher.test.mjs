// Phase 4.0 M3 S4.1b — STAGE C2B-M005-B0.
//
// Deterministic guard for scripts/managed-m005-launcher.mjs.
//
// EVERY value here is SYNTHETIC. The DSN and API host cannot resolve, and the certificate body is
// literal filler. No real configuration is read: `main()`, `classifySecrets()` and `buildChildEnv()`
// all take their source as a parameter, and every test passes the synthetic fixture. Nothing here
// performs DNS, opens a socket, contacts PostgreSQL, or runs a migration — no test spawns a real
// process at all; every child is an EventEmitter fake.

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname, join } from 'node:path';

import {
  CHILD_BLOCK_SENTINEL,
  CHILD_ENV_KEYS,
  CONFIG_KEYS,
  FORBIDDEN_CHILD_TOKENS,
  GATE_VALUES,
  M005_ARTIFACTS,
  M005_CODES,
  M005_FLAGS,
  MAX_LINE_CHARS,
  MAX_TRANSCRIPT_LINES,
  PARENT_FLAG,
  PREFLIGHT_FIELD_KEYS,
  PREFLIGHT_PROSE_TAILS,
  PREFLIGHT_TRANSCRIPT_TAGS,
  PROTECTED_VOCABULARY,
  STARTUP_SENSITIVE,
  TRANSCRIPT_DISCARDED_TOKEN,
  TRANSCRIPT_STREAMS_UNREADABLE_TOKEN,
  TRANSCRIPT_UNAVAILABLE_TOKEN,
  ZERO_ENTROPY_LABELS,
  assertChildArgvContract,
  assertM005Artifacts,
  buildTypedRedactor,
  canonicalPreflightLine,
  classifySecrets,
  createSafeSink,
  enterHoldIfRequiredM005,
  main,
  renderM005MigrateTranscript,
  renderM005Report,
  renderPreflightTranscript,
  safeLineText,
  MIGRATE_TAG,
  dispositionFor,
  terminalEvidenceFor,
  terminalCompletion,
  PREFLIGHT_TRANSCRIPT_TAGS as PREFLIGHT_TAGS,
} from '../../scripts/managed-m005-launcher.mjs';

import {
  LAUNCHER_CODES,
  assertStartupSensitiveAbsent,
  MIGRATE_SCRIPT,
  NODE_BIN,
  REPO_ROOT,
  TSX_CLI,
  createCapture,
  normalCompletion,
  runChild,
  MIGRATE_SPEC,
  canonicalMigrateLine,
  TERMINAL_EVIDENCE_REASONS,
  UNRECOGNIZED_TERMINAL_REASON,
  createTranscriptGrammar,
  terminalReasonText,
  outcomeCode,
  OUTPUT_LIMIT_BYTES,
  CLEANUP_STATUSES,
} from '../../scripts/managed-baseline-launcher.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const LAUNCHER_PATH = resolve(HERE, '..', '..', 'scripts', 'managed-m005-launcher.mjs');
const LAUNCHER_SRC = readFileSync(LAUNCHER_PATH, 'utf8');

/**
 * Executable source only. Block and line comments are removed so a token-reachability assertion
 * tests what CODE can reach rather than what the header is allowed to explain.
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

// ---- synthetic configuration -------------------------------------------------
//
// The host deliberately ends in a PUBLIC-SUFFIX-shaped label and carries a project-reference-shaped
// label, because the whole redaction correction turns on telling those two apart.

const SYNTH = Object.freeze({
  SUPABASE_DATABASE_URL: 'postgresql://postgres.abcdefghijklmnop:pw-Str0ng%21@aws-0-eu-x.pooler.supabase.com/postgres',
  SUPABASE_URL: 'https://abcdefghijklmnop.supabase.com',
  DATABASE_CA_CERT: '-----BEGIN CERTIFICATE-----\nQUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=\n-----END CERTIFICATE-----',
});

/**
 * A second fixture whose host carries `status` — a PROTECTED_VOCABULARY collision that is NOT a
 * public suffix. Without it the two drop lists were only JOINTLY bound, on the single label `com`
 * which appears in both: deleting either list alone changed no test result.
 */
const SYNTH_VOCAB = Object.freeze({
  SUPABASE_DATABASE_URL: 'postgresql://postgres.qrstuvwxyzabcdef:pw2@status.pooler.supabase.com/postgres',
  SUPABASE_URL: 'https://qrstuvwxyzabcdef.supabase.com',
  DATABASE_CA_CERT: SYNTH.DATABASE_CA_CERT,
});

const CHILD_PID = 515151;
const PARENT_ID = Object.freeze({ pid: 1000, ppid: 999, pgid: 1000, sid: 900, state: 'S', starttime: '111' });
const CHILD_ID = Object.freeze({
  pid: CHILD_PID, ppid: PARENT_ID.pid, pgid: CHILD_PID, sid: CHILD_PID, state: 'S', starttime: '222',
});

const observation = (over = {}) => ({
  available: true, pidPresent: false, leaderIdentityMatches: null, groupMembers: [], sessionMembers: [], ...over,
});
const groupEmpty = () => observation();
const groupOrphan = () => observation({ groupMembers: [CHILD_PID + 1] });
const groupUnavailable = () => ({
  available: false, pidPresent: null, leaderIdentityMatches: null, groupMembers: null, sessionMembers: null,
});

/** The FULLY EVIDENCED terminal result — every conjunct of the normal-completion predicate present. */
const evidenced = (over = {}) => ({
  status: 'closed', code: null, detail: null, pid: CHILD_PID, exitCode: 0, signal: null,
  capture: createCapture(), identity: { ...CHILD_ID }, group: groupEmpty(),
  spawned: true, closeObserved: true, streamsClosed: true, observationLost: false, containmentHold: false,
  ...over,
});

function fakeChild(overrides = {}) {
  const child = new EventEmitter();
  child.pid = CHILD_PID;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.unref = () => {};
  child.stdout.unref = () => {};
  child.stderr.unref = () => {};
  // Node closes the stdio streams BEFORE emitting the subprocess 'close'; a fake that skipped this
  // would leave `streamsClosed` unfalsifiable in every synthetic run.
  const rawEmit = child.emit.bind(child);
  child.emit = (event, ...rest) => {
    if (event === 'close') {
      child.stdout?.emit?.('close');
      child.stderr?.emit?.('close');
    }
    return rawEmit(event, ...rest);
  };
  child.signals = [];
  child.kill = (sig) => { child.signals.push(sig); return true; };
  return Object.assign(child, overrides);
}

/**
 * THE MIGRATION CHILD'S POST-CLEANUP RECORD, exactly as `runThroughManagedExecutor` writes it:
 * inside its `finally`, on the statement after `await handle.dispose()` resolves.
 */
const MIGRATE_TEARDOWN_OK =
  '[migrate] apply(up) teardown: requested=true completed=true gracefulSocketClose=not_observed code=none';

/**
 * THE POST-DECISION RECORD — the child's last word, and the only line that establishes completion.
 *
 * The teardown record above proves disposal was reached and nothing more: the verdict, the refusal
 * and the exit classification all happen after it, so a realtime signal in that window left it
 * intact while destroying everything it appeared to vouch for. This one is emitted after all of
 * them and is the last thing the child writes to either stream.
 */
const MIGRATE_POST_DECISION_OK =
  '[migrate] apply(up) terminal: decision=success cleanup=completed exit=success code=none';

/**
 * THE COMPLETE EVIDENCE A CLEAN RUN LEAVES, in the order the child writes it.
 *
 * A synthetic clean run must emit BOTH, because `exitCode=0 signal=null` establishes nothing on its
 * own — that is precisely what a child destroyed by realtime signal 34, 40 or 64 reports — and
 * because neither record alone is now sufficient: the pair is the unit of evidence.
 */
const MIGRATE_TERMINAL_OK = `${MIGRATE_TEARDOWN_OK}\n${MIGRATE_POST_DECISION_OK}`;

/** A fake child that completes the way the real one does: the record pair, then close. */
function completingChild(line = MIGRATE_TERMINAL_OK, exitCode = 0, signal = null) {
  const child = fakeChild();
  queueMicrotask(() => {
    if (line !== null) child.stdout.emit('data', Buffer.from(`${line}\n`, 'utf8'));
    child.emit('close', exitCode, signal);
  });
  return child;
}

/** Read the real governed artifact bytes through the injected seam. */
const realArtifactReader = () => (abs) => readFileSync(abs);

/** The standard deps bundle: verifiable containment, tiny windows, nothing real signalled. */
function deps(over = {}) {
  const lines = [];
  const errs = [];
  return {
    sink: lines,
    errSink: errs,
    deps: {
      out: (l) => lines.push(l),
      err: (l) => errs.push(l),
      assertContainment: () => {},
      readExecEnv: () => new Map(),
      readFile: realArtifactReader(),
      identify: () => ({ ...CHILD_ID }),
      selfIdentity: () => ({ ...PARENT_ID }),
      scan: () => groupEmpty(),
      killGroup: () => true,
      timeoutMs: 50,
      cleanupGraceMs: 20,
      groupPollMs: 5,
      // FAKE TIMER SEAMS, injected by default. The containment hold is REFERENCED by design and
      // never exits, so a suite that entered the real one would hang forever - and "fixing" that by
      // letting the launcher exit would be testing the abandonment this design removed.
      setIntervalFn: (fn, ms) => ({ fn, ms, ref: true }),
      clearIntervalFn: (t) => { if (t) t.ref = false; },
      ...over,
    },
  };
}

// =============================================================================
// §4 — the launcher can invoke ONLY managed forward migration 005
// =============================================================================

test('the frozen child flags are exactly the managed forward-apply set', () => {
  assert.deepEqual([...M005_FLAGS], ['--managed-dev', '--apply', '--confirm-dev']);
  assert.ok(Object.isFrozen(M005_FLAGS));
});

test('no baseline, status, direction or down token is reachable from launcher CODE', () => {
  // SOURCE-LEVEL, not just argv-level: a token in executable code is a token a future edit can
  // reach for. COMMENTS ARE STRIPPED FIRST, deliberately — the header explains at length which
  // modes this launcher deliberately cannot reach, and naming them there is the documentation a
  // reviewer needs; forbidding the words outright would buy nothing and cost the explanation.
  // The needles are built from runtime fragments so this assertion cannot trip over its own text,
  // and the FORBIDDEN_CHILD_TOKENS declaration — the one place they legitimately appear in code —
  // is removed before the scan.
  const withoutDeclaration = stripComments(LAUNCHER_SRC).replace(
    /export const FORBIDDEN_CHILD_TOKENS = Object\.freeze\(\[[\s\S]*?\]\);/,
    '',
  );
  for (const token of [
    ['--', 'baseline'].join(''),
    ['--', 'status'].join(''),
    ['--', 'down'].join(''),
    ['--', 'allow-down'].join(''),
    ['--', 'resolve-dirty'].join(''),
  ]) {
    assert.ok(!withoutDeclaration.includes(token), `launcher source must not contain ${token}`);
  }
});

test('the argv contract accepts only the single-purpose array', () => {
  assert.doesNotThrow(() => assertChildArgvContract(Object.freeze([TSX_CLI, MIGRATE_SCRIPT, ...M005_FLAGS])));
});

test('the argv contract refuses every redirection shape', () => {
  const cases = [
    [TSX_CLI, MIGRATE_SCRIPT, ...M005_FLAGS, `${['--', 'migration'].join('')}=001`],
    [TSX_CLI, MIGRATE_SCRIPT, ...M005_FLAGS, `${['--', 'direction'].join('')}=down`],
    [TSX_CLI, MIGRATE_SCRIPT, ...M005_FLAGS, ['--', 'baseline'].join('')],
    [TSX_CLI, MIGRATE_SCRIPT, ...M005_FLAGS, ['--', 'status'].join('')],
    [TSX_CLI, '/tmp/other-script.ts', ...M005_FLAGS],
    ['/tmp/other-cli.mjs', MIGRATE_SCRIPT, ...M005_FLAGS],
    [TSX_CLI, MIGRATE_SCRIPT, '--managed-dev', '--apply'],
  ];
  for (const argv of cases) {
    assert.throws(
      () => assertChildArgvContract(Object.freeze(argv)),
      (e) => e.code === M005_CODES.ARGV_CONTRACT_VIOLATED,
      `must refuse ${JSON.stringify(argv.slice(2))}`,
    );
  }
});

test('an unfrozen argv array is refused even when its contents are correct', () => {
  assert.throws(
    () => assertChildArgvContract([TSX_CLI, MIGRATE_SCRIPT, ...M005_FLAGS]),
    (e) => e.code === M005_CODES.ARGV_CONTRACT_VIOLATED && e.names.includes('argv_not_frozen'),
  );
});

test('every forbidden child token is actually detected by the contract', () => {
  for (const token of FORBIDDEN_CHILD_TOKENS) {
    const argv = Object.freeze([TSX_CLI, MIGRATE_SCRIPT, ...M005_FLAGS, token]);
    assert.throws(() => assertChildArgvContract(argv), (e) => e.names.includes(token), token);
  }
});

test('main refuses every parent argv except the one literal flag', async () => {
  for (const argv of [[], ['--execute'], [PARENT_FLAG, 'extra'], ['--execute-m005=1'], ['-x']]) {
    const d = deps();
    const code = await main(argv, SYNTH, d.deps);
    assert.equal(code, 2, JSON.stringify(argv));
    assert.match(d.errSink.join('\n'), new RegExp(M005_CODES.BAD_INVOCATION));
  }
});

test('main spawns the exact absolute executables and the frozen argv', async () => {
  let seen = null;
  const d = deps({
    spawn: (command, args, options) => {
      seen = { command, args: [...args], options };
      return completingChild();
    },
  });
  assert.equal(await main([PARENT_FLAG], SYNTH, d.deps), 0);
  assert.equal(seen.command, NODE_BIN);
  assert.deepEqual(seen.args, [TSX_CLI, MIGRATE_SCRIPT, ...M005_FLAGS]);
  // §5 — containment properties preserved from the accepted parent.
  assert.equal(seen.options.detached, true);
  assert.equal(seen.options.shell, false);
  assert.equal(seen.options.cwd, REPO_ROOT);
  assert.deepEqual(seen.options.stdio, ['ignore', 'pipe', 'pipe']);
});

// =============================================================================
// §5 — the sealed child environment
// =============================================================================

test('the child environment is exactly the six sealed names with the frozen gate values', async () => {
  let seenEnv = null;
  const d = deps({
    spawn: (_c, _a, options) => {
      seenEnv = options.env;
      const child = fakeChild();
      queueMicrotask(() => child.emit('close', 0, null));
      return child;
    },
  });
  await main(
    [PARENT_FLAG],
    { ...SYNTH, PATH: '/usr/bin', HOME: '/home/x', PGHOST: 'x', npm_config_x: '1', NODE_OPTIONS: '--x' },
    d.deps,
  );
  assert.deepEqual(Object.keys(seenEnv).sort(), [...CHILD_ENV_KEYS].sort());
  for (const [k, v] of Object.entries(GATE_VALUES)) assert.equal(seenEnv[k], v);
  for (const k of Object.keys(seenEnv)) {
    assert.ok(!/^PG/.test(k), k);
    assert.ok(!/^(npm_|NPM_)/.test(k), k);
    assert.ok(!STARTUP_SENSITIVE.includes(k), k);
    assert.ok(k !== 'PATH' && k !== 'HOME', k);
  }
});

test('a missing configuration name refuses before anything is spawned', async () => {
  for (const missing of CONFIG_KEYS) {
    const source = { ...SYNTH };
    delete source[missing];
    let spawned = false;
    const d = deps({ spawn: () => { spawned = true; return fakeChild(); } });
    assert.equal(await main([PARENT_FLAG], source, d.deps), 2, missing);
    assert.equal(spawned, false, missing);
    assert.match(d.errSink.join('\n'), new RegExp(LAUNCHER_CODES.CONFIG_MISSING));
  }
});

test('an unparsable DSN refuses rather than degrading redaction coverage', async () => {
  let spawned = false;
  const d = deps({ spawn: () => { spawned = true; return fakeChild(); } });
  assert.equal(await main([PARENT_FLAG], { ...SYNTH, SUPABASE_DATABASE_URL: 'not a url' }, d.deps), 2);
  assert.equal(spawned, false);
  assert.match(d.errSink.join('\n'), new RegExp(LAUNCHER_CODES.CONFIG_UNPARSABLE));
});

// =============================================================================
// §4 + §8 — the artifact identity gate
// =============================================================================

test('the governed artifact digests match the files on disk', async () => {
  for (const a of M005_ARTIFACTS) {
    const digest = createHash('sha256').update(readFileSync(join(REPO_ROOT, a.rel))).digest('hex');
    assert.equal(digest, a.sha256, a.rel);
  }
  await assert.doesNotReject(() => assertM005Artifacts(realArtifactReader()));
});

test('a single changed byte in either artifact refuses before any spawn', async () => {
  for (const target of M005_ARTIFACTS) {
    const basename = target.rel.split('/').pop();
    let spawned = false;
    const d = deps({
      readFile: (abs) => (String(abs).endsWith(basename)
        ? Buffer.concat([readFileSync(abs), Buffer.from('\n')])
        : readFileSync(abs)),
      spawn: () => { spawned = true; return fakeChild(); },
    });
    assert.equal(await main([PARENT_FLAG], SYNTH, d.deps), 2, target.rel);
    assert.equal(spawned, false, target.rel);
    assert.match(d.errSink.join('\n'), new RegExp(M005_CODES.ARTIFACT_IDENTITY_REJECTED));
  }
});

test('an unreadable artifact is a refusal, never a pass', async () => {
  const d = deps({ readFile: () => { throw new Error('ENOENT'); }, spawn: () => fakeChild() });
  assert.equal(await main([PARENT_FLAG], SYNTH, d.deps), 2);
  assert.match(d.errSink.join('\n'), new RegExp(M005_CODES.ARTIFACT_IDENTITY_REJECTED));
});

// =============================================================================
// §6 — the redaction correction
// =============================================================================

test('hostname labels are typed: the project reference is RAW, the public suffix is dropped', () => {
  const { raw, tokens } = classifySecrets(SYNTH);
  // PROMOTED TO RAW. A label at or above the promotion length cannot collide with the protected
  // vocabulary, so anchoring it would only cost coverage: an identifier embedding the reference
  // inside a longer alphanumeric run (`slot_<ref>2`) would go unredacted. The provider's
  // project-reference grammar is 16+ characters, so it is always on the RAW side.
  assert.ok(raw.includes('abcdefghijklmnop'), 'the project reference must be an unrestricted literal');
  assert.ok(!tokens.includes('abcdefghijklmnop'));
  assert.ok(!tokens.some((t) => ZERO_ENTROPY_LABELS.includes(t.toLowerCase())), 'no zero-entropy label may be a literal');
  assert.ok(!tokens.some((t) => PROTECTED_VOCABULARY.includes(t.toLowerCase())), 'no vocabulary collision may be a literal');
  // The COMPLETE host and the complete DSN stay raw, so dropping a short label loses no coverage.
  assert.ok(raw.includes('aws-0-eu-x.pooler.supabase.com'));
  assert.ok(raw.includes(SYNTH.SUPABASE_DATABASE_URL));
});

test('no literal that could IDENTIFY the project is droppable — a length proof, not a promise', () => {
  // THE RISK THE CORRECTION INTRODUCES. Dropping a token literal is only safe if nothing
  // identifying can land in the drop set. The provider's project-reference grammar is
  // `[a-z0-9]{16,}` (migrationExecutor.ts), and every droppable literal here is far shorter — so
  // the two sets cannot intersect, whatever either list grows to later, unless someone adds a
  // 16-character word to the vocabulary. This asserts that gap rather than trusting it.
  const droppable = [...ZERO_ENTROPY_LABELS, ...PROTECTED_VOCABULARY];
  const longest = droppable.reduce((a, b) => (b.length > a.length ? b : a), '');
  assert.ok(longest.length < 16, `a droppable literal reached project-reference length: ${longest}`);
  assert.ok(!droppable.some((d) => /^[a-z0-9]{16,}$/.test(d)), 'no droppable literal matches the project-ref grammar');
});

test('the baseline parent cannot be started as a side effect of importing its primitives', () => {
  // DECISION UNDER DOUBT: the containment machinery is REUSED by import rather than re-derived.
  // That is only safe if importing the accepted parent cannot run it. Its entry guard keys on the
  // process entry path, and the two filenames cannot satisfy each other's suffix test.
  assert.ok(!'scripts/managed-m005-launcher.mjs'.endsWith('managed-baseline-launcher.mjs'));
  assert.ok(!'scripts/managed-baseline-launcher.mjs'.endsWith('managed-m005-launcher.mjs'));
  const baselineSrc = readFileSync(resolve(HERE, '..', '..', 'scripts', 'managed-baseline-launcher.mjs'), 'utf8');
  // BOTH parents use EXACT PATH IDENTITY rather than a suffix test. A suffix test is satisfied by
  // any entry script whose name merely ends in the launcher's, which would start a real run as a
  // side effect of importing the module for its exports.
  const guard = /resolve\(process\.argv\[1\]\) === resolve\(fileURLToPath\(import\.meta\.url\)\)/;
  assert.match(stripComments(baselineSrc), guard, 'the baseline parent guards on exact path identity');
  assert.match(stripComments(LAUNCHER_SRC), guard, 'the 005 parent must guard the same way');
  assert.ok(!/argv\[1\]\.endsWith\(/.test(stripComments(LAUNCHER_SRC)), 'no suffix-based entry guard');
});

test('every synthetic secret representation is removed from a hostile line', () => {
  const redact = buildTypedRedactor(classifySecrets(SYNTH));
  const hostile = [
    SYNTH.SUPABASE_DATABASE_URL,
    SYNTH.SUPABASE_URL,
    SYNTH.DATABASE_CA_CERT,
    'aws-0-eu-x.pooler.supabase.com',
    'abcdefghijklmnop',
    'postgres.abcdefghijklmnop',
    'pw-Str0ng!',
    'pw-Str0ng%21',
    'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=',
  ];
  for (const secret of hostile) {
    const out = redact(`driver said: ${secret} <-`);
    assert.ok(!out.includes(secret), `must redact ${secret.slice(0, 24)}`);
  }
});

test('fixed operational vocabulary survives redaction byte-identically', () => {
  const redact = buildTypedRedactor(classifySecrets(SYNTH));
  const templates = [
    // C2B-M005-B1-R2 — the headline the CLI actually emits. It said `applied=` until this stage;
    // the field counts ledger FINALIZES, which for a tx-scoped migration run inside the still-open
    // bracket, so a refused commit left it counting a version that never became durable.
    '[migrate] apply(up): outcome=complete finalized=1 disposal=closed code=none',
    '[migrate] apply(up) mutation: success_commit_and_read_back_verified commit_attempted=true rollback_observed=false',
    '[migrate] apply(up) evidence: commit=resolved submitted=true resolved=true acknowledged=unavailable readBack=true lockRelease=verified',
    '[migrate] apply(up) teardown: requested=true completed=true gracefulSocketClose=not_observed code=none',
    '[m005-launcher] containmentHold=false',
    '[m005-launcher] status=closed',
    'the connection to the account was committed and the containment is complete',
  ];
  for (const t of templates) assert.equal(redact(t), t, t);
});

test('output-differencing cannot recover a redacted short hostname label from a fixed template', () => {
  // THE REGRESSION THIS STAGE EXISTS FOR. Previously the public-suffix label was applied as an
  // unrestricted substring, so `outcome=complete ... commit=committed` rendered with four holes and
  // the damaged template could be differenced against its source literal to recover the label
  // exactly. With the correction there is no hole at all, so there is nothing to difference.
  const redact = buildTypedRedactor(classifySecrets(SYNTH));
  const template = '[migrate] baseline: outcome=complete adopted=001,002,003,004 commit=committed disposal=closed code=none';
  const rendered = redact(template);
  assert.equal(rendered, template);
  assert.ok(!rendered.includes('[REDACTED]'), 'a fixed template must produce no redaction marker at all');
  // ...and the label is genuinely one that WOULD have collided.
  assert.ok(ZERO_ENTROPY_LABELS.includes('com'));
  assert.ok('outcome'.includes('com') && 'commit'.includes('com'));
});

test('C2B-M005-B1-R3: PROTECTED_VOCABULARY covers every key the managed record emits', () => {
  // THE R2 RESIDUAL, CLOSED AND INVERTED. R2 renamed the operator's words and left this list
  // where it was; the pin that recorded the gap is replaced by the contract that prevents it.
  // The set is DERIVED from the two sources that actually emit the record, so a future line with
  // a new key fails here instead of being silently shreddable by a colliding hostname label.
  // C2B-M005-LRLS-L3-R3 — THE DERIVATION IS TOKENIZED, NOT REGEXED.
  //
  // This scan used to strip comments and then pair backticks with /`[^`]*`/g. That is only correct
  // while every backtick in the file opens or closes a template literal, and it silently is not:
  // a backtick inside a quoted string or a surviving comment shifts the pairing, and from that
  // point on every "template" the scan believes it found is the text BETWEEN two real literals.
  // Measured on this repository the regex found 30 spans and derived 5 keys from this launcher,
  // while reporting keys that live in single-quoted strings and missing most of the real ones —
  // it was both over- and under-reporting, and the assertion below was passing on the migrate
  // file's contribution alone. A one-pass tokenizer that tracks which quote it is inside cannot
  // mispair, so the coverage contract is now enforced over the keys the record actually emits.
  const templateRuns = (src) => {
    const found = new Set();
    let i = 0;
    let quote = null;
    let buf = '';
    const flush = () => {
      if (quote === '`') {
        for (const key of buf.match(/([A-Za-z][A-Za-z0-9_]*)=(?![=>])/g) ?? []) {
          for (const run of key.slice(0, -1).match(/[A-Za-z]+/g) ?? []) found.add(run.toLowerCase());
        }
      }
      buf = '';
    };
    while (i < src.length) {
      const c = src[i];
      if (quote === null) {
        if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e === -1 ? src.length : e + 2; continue; }
        if (c === '/' && src[i + 1] === '/') { const e = src.indexOf('\n', i); i = e === -1 ? src.length : e; continue; }
        if (c === "'" || c === '"' || c === '`') { quote = c; i += 1; continue; }
        i += 1;
        continue;
      }
      // An escape consumes its next character, so an escaped quote never ends the literal.
      if (c === '\\') { buf += src.slice(i, i + 2); i += 2; continue; }
      if (c === quote) { flush(); quote = null; i += 1; continue; }
      buf += c;
      i += 1;
    }
    return found;
  };
  const runs = new Set();
  for (const rel of ['scripts/supabase-migrate.ts', 'scripts/managed-m005-launcher.mjs']) {
    for (const run of templateRuns(readFileSync(join(REPO_ROOT, rel), 'utf8'))) runs.add(run);
  }
  // FLOOR RAISED FROM 25 TO 50. The old floor was satisfied by the migrate file alone, so the
  // launcher contributing almost nothing could not fail it — which is why the mispairing survived.
  assert.ok(runs.size > 50, `the emitted key set must be derived, not empty: ${runs.size}`);
  for (const w of ['pgid', 'exitcode', 'overflowed']) {
    assert.ok(runs.has(w), `the corrected derivation must reach the containment record's keys: ${w}`);
  }
  assert.ok(runs.has('finalized') && runs.has('marker') && runs.has('ledger'),
    'the derivation must reach the renamed and new keys');

  // COVERAGE IS BOUNDED BY THE PROMOTION LENGTH, and that bound is the security property. At or
  // above TOKEN_RAW_PROMOTION_CHARS a label is RAW and never consults this list, so protecting a
  // longer word could not help and would only remove it from redaction.
  const missing = [...runs].filter((r) => r.length >= 3 && r.length < 12 && !PROTECTED_VOCABULARY.includes(r));
  assert.deepEqual(missing, [], `emitted keys the record cannot protect: ${missing.join(',')}`);
  const overlong = PROTECTED_VOCABULARY.filter((v) => v.length >= 12);
  assert.deepEqual(overlong, [], `a raw-promoted word must not be droppable: ${overlong.join(',')}`);

  // AND THE DEAD ENTRY IS GONE. 'applied' is emitted nowhere — not as a key, and not inside any
  // bounded code — so keeping it would exempt a word from redaction for nothing.
  assert.ok(!runs.has('applied'), 'the derivation confirms "applied" is not an emitted key');
  assert.ok(!PROTECTED_VOCABULARY.includes('applied'), 'so it must not still be protected');
});

test('C2B-M005-B1-R3: a credential equal to an operational word is still redacted', () => {
  // §7 — the vocabulary protects RECORD WORDS, never secret VALUES. Credentials are RAW with no
  // length floor and no vocabulary consultation, so a password that happens to equal a protected
  // word is still replaced everywhere. The record is over-redacted as a result, and that is the
  // safe direction: an unreadable record is recoverable, a leaked credential is not.
  const collide = Object.freeze({
    SUPABASE_DATABASE_URL: 'postgresql://postgres.qrstuvwxyzabcdef:ledger@ledger.pooler.supabase.com/postgres',
    SUPABASE_URL: 'https://qrstuvwxyzabcdef.supabase.com',
    DATABASE_CA_CERT: SYNTH.DATABASE_CA_CERT,
  });
  const { raw, tokens } = classifySecrets(collide);
  assert.ok(raw.includes('ledger'), 'the credential is an unrestricted literal despite the collision');
  assert.ok(!tokens.includes('ledger'), 'and the colliding HOST LABEL is dropped, not tokenized');
  const redact = buildTypedRedactor(classifySecrets(collide));
  const out = redact('[migrate] apply(up) ledger: version=005 marker=durable_dirty');
  assert.ok(!/(^|[^A-Za-z])ledger([^A-Za-z]|$)/.test(out.replace(/\[REDACTED\]/g, '')),
    `the credential value must not survive anywhere: ${out}`);
  assert.ok(out.includes('[REDACTED]'), 'and the replacement is visible rather than silent');
});

test('the PROTECTED_VOCABULARY list is bound on its own, not jointly with the suffix list', () => {
  // `status` is a vocabulary collision that is NOT a public suffix, so ONLY the vocabulary guard can
  // drop it. Without this fixture both lists were satisfied by the single label `com`, which is in
  // both — and deleting either one alone changed no test result.
  const { raw, tokens } = classifySecrets(SYNTH_VOCAB);
  assert.ok(!tokens.includes('status'), 'a vocabulary collision must never become a literal');
  assert.ok(!ZERO_ENTROPY_LABELS.includes('status'), 'and it must not be droppable as a public suffix');
  assert.ok(PROTECTED_VOCABULARY.includes('status'));
  assert.ok(raw.includes('qrstuvwxyzabcdef'), 'the identifying label is still fully covered');
  const redact = buildTypedRedactor(classifySecrets(SYNTH_VOCAB));
  const template = '[migrate] apply(up): outcome=complete status=closed lockRelease=verified';
  assert.equal(redact(template), template);
});

test('the ZERO_ENTROPY list is bound on its own, not jointly with the vocabulary list', () => {
  // MIRROR IMAGE, and it needs its own fixture. `com` is in BOTH lists, so a host ending in `.com`
  // leaves either guard able to satisfy the other's obligation — deleting the suffix list alone
  // changed no result. This host carries three public suffixes that are NOT vocabulary.
  const suffixHost = {
    ...SYNTH,
    SUPABASE_DATABASE_URL: 'postgresql://u:pw3@mnopqrstuvwxyzab.dev.app.net/postgres',
    SUPABASE_URL: 'https://mnopqrstuvwxyzab.supabase.co',
  };
  const { raw, tokens } = classifySecrets(suffixHost);
  for (const suffix of ['dev', 'app', 'net']) {
    assert.ok(!PROTECTED_VOCABULARY.includes(suffix), `${suffix} must not be vocabulary`);
    assert.ok(ZERO_ENTROPY_LABELS.includes(suffix));
    assert.ok(!tokens.includes(suffix), `only the suffix guard can drop ${suffix}`);
  }
  // The identifying label is unaffected, and so is the whole host.
  assert.ok(raw.includes('mnopqrstuvwxyzab'));
  assert.ok(raw.includes('mnopqrstuvwxyzab.dev.app.net'));
  // `pooler` is in neither list and must still be redacted, so the guards are not blanket drops.
  assert.ok(!buildTypedRedactor(classifySecrets(SYNTH_VOCAB))('resolving pooler now').includes('pooler'));
  for (const suffix of ZERO_ENTROPY_LABELS) assert.ok(suffix.length <= 4, `must stay short: ${suffix}`);
});

test('a hostname label is still redacted where it stands as a whole token', () => {
  // The boundary rule must not become a licence to skip real matches. `pooler` is a genuine label
  // of the synthetic host and is neither zero-entropy nor protected vocabulary.
  const redact = buildTypedRedactor(classifySecrets(SYNTH));
  assert.ok(!redact('resolving pooler now').includes('pooler'));
  assert.ok(!redact('host=pooler.supabase.com').includes('pooler'));
  // ...and must NOT reach inside a longer word.
  assert.equal(redact('the poolers were fine'), 'the poolers were fine');
});

test('credential literals keep NO length floor', () => {
  const redact = buildTypedRedactor(classifySecrets({
    ...SYNTH,
    SUPABASE_DATABASE_URL: 'postgresql://u:a@aws-0-eu-x.pooler.supabase.com/postgres',
  }));
  // A one-character password redacts every occurrence of that character. The record becomes
  // obviously unusable, which is the safe failure — a usable-looking record would have leaked it.
  assert.ok(!redact('password is a here').includes(' a '));
});

test('C2B-M005-LRLS-L3-R4: a raw Error message or stack can never reach the RECORD at all', () => {
  // THE CLAIM HAS STRENGTHENED. It used to be that a raw Error reached the sink and was REDACTED —
  // present in the record with a marker where the secret had been. Redaction was the only barrier,
  // and it is a function of the credential, so the marker's position inside published template text
  // was a known-plaintext oracle. The child path no longer has a redactor on it: an Error line does
  // not satisfy the grammar, so it is discarded unread and counted.
  const rendered = renderPreflightTranscript(
    '', `Error: connect ECONNREFUSED ${SYNTH.SUPABASE_DATABASE_URL}\n    at Socket.<anonymous>`, true);
  const all = rendered.join('\n');
  assert.ok(!all.includes(SYNTH.SUPABASE_DATABASE_URL), 'the DSN must not appear');
  assert.ok(!all.includes('ECONNREFUSED'), 'nor any part of the driver text');
  assert.ok(!all.includes('[REDACTED]'), 'and nothing should need redacting');
  assert.ok(all.includes('stderrUnparsable=2'), 'the discard is COUNTED, so the loss is stated');
});

test('a launcher-authored line that matches anything is replaced WHOLE — no differencing oracle', () => {
  // THE ORACLE THIS CLOSES. Launcher lines are compile-time constants published in the source file,
  // so a partial redaction inside one is known-plaintext: the marker's position and the surviving
  // text on either side identify the exact span, and differencing against the source recovers the
  // literal. A short credential is precisely the class that occurs inside English prose.
  const shortPw = { ...SYNTH, SUPABASE_DATABASE_URL: 'postgresql://u:an@aws-0-eu-x.pooler.supabase.com/postgres' };
  const sink2 = createSafeSink(buildTypedRedactor(classifySecrets(shortPw)), (l) => emitted2.push(l));
  const emitted2 = [];
  sink2('[m005-launcher] scan-to-signal is not atomic and the managed group is empty');
  assert.equal(emitted2.length, 1);
  assert.match(emitted2[0], /REDACTED LINE/);
  // No residue at all: not the surrounding words, not the position, not the length.
  assert.ok(!emitted2[0].includes('signal'));
});

test('a launcher-authored line that matches nothing is emitted verbatim', () => {
  const out = [];
  const sink = createSafeSink(buildTypedRedactor(classifySecrets(SYNTH)), (l) => out.push(l));
  const clean = '[m005-launcher] outcome=m005_launcher_ok containmentHold=false';
  sink(clean);
  assert.equal(out[0], clean);
});

test('a resolved IP address is redacted structurally — no derived literal can ever match one', () => {
  // A RESOLVED address appears nowhere in the child environment, so literal-derived coverage cannot
  // reach it. The governing rule names IP addresses explicitly, which makes this structural.
  const redact2 = buildTypedRedactor(classifySecrets(SYNTH));
  for (const addr of ['203.0.113.7', '2001:0db8:85a3:0000:0000:8a2e:0370:7334', '2001:db8::8a2e:370:7334']) {
    assert.ok(!redact2(`connect ETIMEDOUT ${addr}:5432`).includes(addr), `must redact ${addr}`);
  }
});

test('a certificate is redacted across lines, and a re-wrapped one still is', () => {
  // Per-line redaction can never see a PEM block, which is multi-line by definition. The block
  // entry point redacts the transcript as ONE string, so the marker pairing can pair.
  const redact2 = buildTypedRedactor(classifySecrets(SYNTH));
  const rewrapped = '-----BEGIN CERTIFICATE-----\nQUJDR\nEVGR0h\nJSktMTU5PUFFSU1RVVldYWVo=\n-----END CERTIFICATE-----';
  const out = redact2(`driver said:\n${rewrapped}\ndone`);
  assert.ok(!out.includes('QUJDR'), 'a re-wrapped certificate body must not survive');
  assert.ok(out.includes('[REDACTED]'));
});

test('a self-overlapping credential is redacted completely, tail included', () => {
  // `from = i + match.length` skipped past the first hit and left the tail of the second exposed.
  // Credentials have no length floor, so a short periodic password is the reachable case.
  const redact2 = buildTypedRedactor(classifySecrets({
    ...SYNTH,
    SUPABASE_DATABASE_URL: 'postgresql://u:abab@aws-0-eu-x.pooler.supabase.com/postgres',
  }));
  const out = redact2('echoed ababab here');
  assert.ok(!/ab/.test(out.replace(/\[REDACTED\]/g, '')), `tail survived: ${out}`);
});

test('C2B-M005-LRLS-L3-R4: a secret straddling the line cap cannot leak its prefix', () => {
  // The launcher-authored path still redacts BEFORE truncating: the reverse order cut the secret, so
  // the prefix no longer matched the literal and was emitted verbatim.
  const out = [];
  const sink = createSafeSink(buildTypedRedactor(classifySecrets(SYNTH)), (l) => out.push(l));
  sink('x'.repeat(MAX_LINE_CHARS - 5) + SYNTH.SUPABASE_DATABASE_URL);
  assert.ok(!out.join('\n').includes('postgresql://postgres.'), 'no prefix of the DSN may survive truncation');
  // AND ON THE CHILD PATH the question does not arise: the line carries no declared field, so it is
  // discarded whole rather than truncated at all.
  const rendered = renderPreflightTranscript(
    'x'.repeat(MAX_LINE_CHARS - 5) + SYNTH.SUPABASE_DATABASE_URL, '', true).join('\n');
  assert.ok(!rendered.includes('postgresql://postgres.'));
  assert.ok(rendered.includes('stdoutUnparsable=1'));
});

test('the sink normalises control characters and bounds the line', () => {
  assert.equal(safeLineText('a[2Kb\rc\n'), 'a [2Kb c ');
  // C1: an 8-bit-capable terminal reads U+009B as a CSI introducer, so stopping at U+007F left the
  // exact bypass this function exists to close. U+2028/U+2029 split one record into two.
  assert.equal(safeLineText('a\u009bb\u2028c'), 'a b c');
  // Truncation is ANNOUNCED. An unmarked cut is the same class of problem as an ambiguous record.
  assert.ok(safeLineText('x'.repeat(MAX_LINE_CHARS + 500)).endsWith('…[TRUNCATED]'));
  assert.equal(safeLineText(undefined), '');
});

// =============================================================================
// §6 — one bounded safe output boundary
// =============================================================================

test('C2B-M005-LRLS-L4: launcher lines share one sink; the child transcript shares none of it', () => {
  // THE TWO PATHS ARE NOW DIFFERENT ON PURPOSE, and that is the correction. Launcher-authored lines
  // are compile-time constants this file chose, so redacting them is defence in depth. The child's
  // transcript is not: it is re-rendered from a closed grammar, with NO redactor anywhere on the
  // path, because a redactor is a function of the credential and would make the output vary with it.
  const redact = buildTypedRedactor(classifySecrets(SYNTH));
  const emitted = [];
  const sink = createSafeSink(redact, (l) => emitted.push(l));
  const capture = createCapture();
  capture.push(Buffer.from(`[migrate] failed: ${SYNTH.SUPABASE_DATABASE_URL}\n`), 'stdout');
  capture.seal();
  for (const line of renderM005Report(evidenced({ capture }))) {
    if (line !== CHILD_BLOCK_SENTINEL) { sink(line); continue; }
    for (const rendered of renderM005MigrateTranscript(
      capture.streamText('stdout'), capture.streamText('stderr'), true)) sink(rendered);
  }
  const all = emitted.join('\n');
  assert.ok(!all.includes(SYNTH.SUPABASE_DATABASE_URL), 'the DSN must not survive');
  assert.ok(all.includes('[m005-launcher] status='), 'launcher-authored lines share the same sink');
  assert.ok(!all.includes('[REDACTED]'), 'and nothing on the child path should need redacting');
  assert.ok(all.includes('stdoutUnparsable=1'), 'the discard is counted');
});

test('a child that prints the DSN cannot leak it through a real run', async () => {
  const d = deps({
    spawn: () => {
      const child = fakeChild();
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from(`[migrate] failed: ${SYNTH.SUPABASE_DATABASE_URL}\n`));
        child.emit('close', 0, null);
      });
      return child;
    },
  });
  await main([PARENT_FLAG], SYNTH, d.deps);
  const all = d.sink.join('\n');
  assert.ok(!all.includes(SYNTH.SUPABASE_DATABASE_URL));
  assert.ok(all.includes('[m005-launcher] status='));
});

test('the report emits only bounded fields; an unbounded value is rejected, not printed', () => {
  const hostile = evidenced({
    exitCode: 'rm -rf /; DSN=postgres://u:p@h/db',
    identity: { pid: 'not-an-int', pgid: 1, sid: 1 },
  });
  const lines = renderM005Report(hostile).join('\n');
  assert.ok(!lines.includes('rm -rf'), 'a hostile exit code must never be interpolated');
  // FIELD.code and FIELD.bool were never exercised on hostile input, so four of six validators had
  // no coverage: a raw signal or cleanup label would have been interpolated unchecked.
  const codeHostile = renderM005Report(evidenced({
    status: 'group_residual',
    signal: 'SIG; DROP TABLE x',
    containmentHold: true,
    cleanup: { term: 'pw=hunter2', kill: 'postgres://u:p@h/db', closeObserved: 'yes' },
  })).join('\n');
  assert.ok(!codeHostile.includes('DROP TABLE'));
  assert.ok(!codeHostile.includes('hunter2'));
  assert.ok(!codeHostile.includes('postgres://'));
  assert.ok(codeHostile.includes(M005_CODES.REPORT_FIELD_REJECTED));
  // TARGETED per validator, so one rejection marker cannot stand in for all of them. `FIELD.bool`
  // had no binding at all: `String(v)` rendered a hostile value verbatim and the shared assertion
  // above still passed on FIELD.code's marker.
  assert.match(codeHostile, new RegExp(`closeObserved=${M005_CODES.REPORT_FIELD_REJECTED}`));
  assert.match(codeHostile, new RegExp(`sigterm=${M005_CODES.REPORT_FIELD_REJECTED}`));
  assert.ok(!/closeObserved=yes/.test(codeHostile));
  assert.ok(!lines.includes('postgres://'), 'a hostile exit code must never be interpolated');
  assert.ok(lines.includes(M005_CODES.REPORT_FIELD_REJECTED));
});

test('the report always states the inherited containment residuals', () => {
  const lines = renderM005Report(evidenced()).join('\n');
  assert.match(lines, /setsid\(\) escapes both \(OPEN\/LOW\)/);
  assert.match(lines, /scan-to-signal is not atomic \(OPEN\/LOW\)/);
  assert.match(lines, /graceful database-socket close observability: NOT OBSERVED/);
});

test("the report labels the child's transcript as the child's own unverified claim", () => {
  const capture = createCapture();
  capture.push(Buffer.from('[migrate] apply(up): outcome=complete\n'));
  const rendered = renderM005Report(evidenced({ capture }));
  assert.match(rendered.join('\n'), /is the CHILD's own and is NOT independently established/);
  // The caveat itself must survive the redactor intact — the collision that made the old
  // launcher's equivalent line unfixable without this correction.
  const redact = buildTypedRedactor(classifySecrets(SYNTH));
  for (const line of rendered) {
    if (line === CHILD_BLOCK_SENTINEL) continue;
    assert.equal(redact(line), line, line);
  }
});

// =============================================================================
// §5 — containment: success mapping, hold mapping
// =============================================================================

test('a fully evidenced terminal result is the only shape that exits 0', async () => {
  const d = deps({ spawn: () => completingChild() });
  assert.equal(await main([PARENT_FLAG], SYNTH, d.deps), 0);
  assert.match(d.sink.join('\n'), new RegExp(`outcome=${M005_CODES.OK}`));
  assert.match(d.sink.join('\n'), /normalCompletion=true/);
  assert.match(d.sink.join('\n'), /terminalEvidence=complete reason=complete/);
});

test('a nonzero child exit is never a launcher success', async () => {
  const d = deps({
    spawn: () => {
      const child = fakeChild();
      queueMicrotask(() => child.emit('close', 1, null));
      return child;
    },
  });
  assert.equal(await main([PARENT_FLAG], SYNTH, d.deps), 2);
  assert.match(d.sink.join('\n'), new RegExp(LAUNCHER_CODES.CHILD_NONZERO_EXIT));
});

test('a residual managed group is never a launcher success', async () => {
  const d = deps({
    scan: () => groupOrphan(),
    killGroup: () => true,
    spawn: () => {
      const child = fakeChild();
      queueMicrotask(() => child.emit('close', 0, null));
      return child;
    },
  });
  assert.equal(await main([PARENT_FLAG], SYNTH, d.deps), 2);
  assert.ok(!d.sink.join('\n').includes(`outcome=${M005_CODES.OK}`));
});

test('a lost observation is never a launcher success', async () => {
  const d = deps({
    scan: () => groupUnavailable(),
    spawn: () => {
      const child = fakeChild();
      queueMicrotask(() => child.emit('close', 0, null));
      return child;
    },
  });
  assert.equal(await main([PARENT_FLAG], SYNTH, d.deps), 2);
});

test('containment hold is entered when cleanup is unsettled, and never maps to success', () => {
  const emitted = [];
  const sink = createSafeSink(buildTypedRedactor(classifySecrets(SYNTH)), (l) => emitted.push(l));
  let interval = null;
  const held = enterHoldIfRequiredM005(
    evidenced({ status: 'group_residual', group: groupOrphan(), containmentHold: true, cleanup: { complete: false } }),
    sink,
    {
      setIntervalFn: (fn, ms) => { interval = { fn, ms, ref: true }; return interval; },
      clearIntervalFn: (t) => { if (t) t.ref = false; },
    },
  );
  assert.notEqual(held, null, 'an unsettled cleanup must hold');
  assert.equal(interval.ref, true, 'the hold interval must stay referenced');
  assert.match(emitted.join('\n'), /HOLDING supervision/);
});

test('a settled normal completion does not hold', () => {
  const emitted = [];
  const sink = createSafeSink((s) => s, (l) => emitted.push(l));
  assert.equal(enterHoldIfRequiredM005(evidenced(), sink, {}), null);
  assert.equal(emitted.length, 0);
});

test('a run that never spawned does not hold', () => {
  const emitted = [];
  const sink = createSafeSink((s) => s, (l) => emitted.push(l));
  const result = evidenced({ status: 'spawn_failed', spawned: false, identity: null, group: groupUnavailable() });
  assert.equal(enterHoldIfRequiredM005(result, sink, {}), null);
});

// =============================================================================
// source-level invariants
// =============================================================================

test('the launcher contains no handle-unreferencing or process-exit call', () => {
  const code = stripComments(LAUNCHER_SRC);
  for (const forbidden of [/\.unref\s*\(/, /child\.unref/, /subprocess\.unref/, /process\.exit\s*\(/]) {
    assert.ok(!forbidden.test(code), `forbidden construct ${forbidden}`);
  }
  // `process.exitCode` is the permitted form and must still be present in the entry guard.
  assert.ok(/process\.exitCode\s*=/.test(code));
});

test('the launcher does not import or reference the baseline flag constant', () => {
  // Again comment-stripped: the header states in prose that BASELINE_FLAGS is deliberately not
  // imported, and that sentence is the point of the file's separation from the baseline parent.
  assert.ok(!/BASELINE_FLAGS/.test(stripComments(LAUNCHER_SRC)), 'the baseline argv must be unreachable from here');
});

test('the module body performs no filesystem or process work at import time', async () => {
  // The previous version asserted only that `main` was a function and the export count was large —
  // neither of which observes filesystem or process activity, so the claim in its own name was
  // entirely unchecked. This looks at the module BODY: every side-effecting call must sit inside a
  // function, and the only top-level statement that may act is the entry guard.
  const code = stripComments(LAUNCHER_SRC);
  for (const line of code.split('\n').filter((l) => l !== '' && !/^[\s})\],;]/.test(l))) {
    assert.ok(!/readFileSync|writeFileSync|spawn\(|execSync/.test(line), `top-level side effect: ${line}`);
  }
  const mod = await import(`../../scripts/managed-m005-launcher.mjs?probe=${Date.now()}`);
  assert.equal(typeof mod.main, 'function');
});

test('there is no second path to the operator: emit is reachable only through the sink', () => {
  // The header claims the single sink is a PROPERTY rather than a convention. Measured, it was not:
  // adding one extra `emit(...)` after the sink loop bypassed everything and no test noticed.
  const code = stripComments(LAUNCHER_SRC);
  for (const line of code.split('\n').filter((l) => /\bemit\(/.test(l) && !/const emit|emit =/.test(l))) {
    assert.ok(
      /emit\(redacted|emit\(`  \| \$\{safeLineText/.test(line),
      `emit must not be called outside the sink: ${line.trim()}`,
    );
  }
  // The refusal path uses emitErr, which is bounded to a code and variable NAMES only.
  for (const line of code.split('\n').filter((l) => /\bemitErr\(/.test(l) && !/const emitErr/.test(l))) {
    assert.match(line, /REFUSED/, `emitErr must only carry a refusal code: ${line.trim()}`);
  }
});

test('a startup-sensitive variable surviving to exec refuses before anything is spawned', () => {
  // EVERY test here injects an empty exec environment, which made the startup-packet guard
  // structurally unreachable: deleting its call changed no result.
  for (const name of STARTUP_SENSITIVE) {
    assert.throws(() => assertStartupSensitiveAbsent(new Map([[name, 'x']])), (e) => e.names.includes(name), name);
  }
  assert.doesNotThrow(() => assertStartupSensitiveAbsent(new Map()));
});

test('normalCompletion is the single success predicate the launcher defers to', () => {
  // Not re-implemented here: the launcher imports the accepted predicate, so a future change to it
  // governs this launcher too rather than leaving two definitions to drift apart.
  assert.equal(normalCompletion(evidenced()), true);
  assert.equal(normalCompletion(evidenced({ streamsClosed: false })), false);
  assert.equal(normalCompletion(evidenced({ observationLost: true })), false);
  assert.equal(normalCompletion(evidenced({ cleanup: { handleOnly: true } })), false);
});

// =============================================================================
// C2B-M005-B0-R1 §4 — raw-output memory and the overflow bound
//
// The cap is on RETAINED RAW BYTES, before redaction, and it is ONE aggregate budget shared by
// stdout and stderr — a single capture object receives both streams, so neither can be quiet while
// the other spends the whole allowance. Everything below is behavioral: no test inspects the
// capture's internals, and each one is written so removing the bound makes it fail.
// =============================================================================

/** Render the capture section of the report — the only place a transcript could escape. */
const captureLines = (capture, over = {}) => renderM005Report(evidenced({ capture, ...over }));

/** The whole record as the operator would read it, transcript included. */
function renderWithTranscript(capture, over = {}) {
  const out = [];
  for (const line of captureLines(capture, over)) {
    if (line === CHILD_BLOCK_SENTINEL) out.push(...String(capture.text() ?? '').split('\n').filter((l) => l !== ''));
    else out.push(line);
  }
  return out.join('\n');
}

test('§4: the retained-byte ceiling is one aggregate budget shared by stdout and stderr', () => {
  assert.equal(OUTPUT_LIMIT_BYTES, 64 * 1024);
  // AGGREGATE, not per stream. Each half is comfortably under the cap on its own; together they
  // cross it. A per-stream budget would retain both.
  const capture = createCapture();
  capture.push(Buffer.alloc(40 * 1024, 0x61)); // "stdout"
  capture.push(Buffer.alloc(40 * 1024, 0x62)); // "stderr"
  assert.equal(capture.overflowed, true);
  assert.equal(capture.text(), '');
});

test('§4: below the cap, at the cap, and one byte over', () => {
  const below = createCapture();
  below.push(Buffer.alloc(OUTPUT_LIMIT_BYTES - 1, 0x61));
  assert.equal(below.overflowed, false);
  assert.equal(below.text().length, OUTPUT_LIMIT_BYTES - 1);

  const exact = createCapture();
  exact.push(Buffer.alloc(OUTPUT_LIMIT_BYTES, 0x61));
  assert.equal(exact.overflowed, false, 'the cap itself is retained; the bound is exclusive above it');
  assert.equal(exact.text().length, OUTPUT_LIMIT_BYTES);

  const over = createCapture();
  over.push(Buffer.alloc(OUTPUT_LIMIT_BYTES + 1, 0x61));
  assert.equal(over.overflowed, true);
  assert.equal(over.text(), '');
});

test('§4: one oversized chunk is discarded whole — never sliced to fit', () => {
  const capture = createCapture();
  capture.push(Buffer.alloc(OUTPUT_LIMIT_BYTES * 8, 0x61));
  assert.equal(capture.overflowed, true);
  // A slice-to-fit design would keep the first 64 KiB, and the cut can fall inside a credential.
  assert.equal(capture.text(), '');
});

test('§4: crossing the cap discards ALREADY-BUFFERED bytes and the flag is sticky', () => {
  const capture = createCapture();
  capture.push(Buffer.from('[migrate] connecting\n'));
  capture.push(Buffer.alloc(OUTPUT_LIMIT_BYTES, 0x61));
  assert.equal(capture.overflowed, true);
  assert.equal(capture.text(), '', 'the bytes retained before the crossing are discarded too');
  // Draining continues; nothing further is retained, and no later small write can clear the flag.
  capture.push(Buffer.from('[migrate] done\n'));
  assert.equal(capture.overflowed, true);
  assert.equal(capture.text(), '');
});

test('§4: a secret that begins before the cap and ends after it does not survive in any part', () => {
  const capture = createCapture();
  const secret = SYNTH.SUPABASE_DATABASE_URL;
  // Positioned so the DSN straddles the ceiling: its head is inside the retained region and its
  // tail is past it. Truncation-then-redaction would emit the head verbatim.
  capture.push(Buffer.alloc(OUTPUT_LIMIT_BYTES - Math.floor(secret.length / 2), 0x61));
  capture.push(Buffer.from(`${secret}\n`));
  assert.equal(capture.overflowed, true);
  const record = renderWithTranscript(capture);
  assert.equal(record.includes(secret), false);
  for (let i = 8; i <= secret.length; i += 1) {
    assert.equal(record.includes(secret.slice(0, i)), false, `no prefix of the secret may survive (${i})`);
  }
  assert.equal(/a{16,}/.test(record), false, 'no part of the buffered filler may survive either');
});

test('§4: overflow emits ONE fixed code and no header, block, disclaimer, byte count or position', () => {
  const capture = createCapture();
  capture.push(Buffer.alloc(OUTPUT_LIMIT_BYTES + 1, 0x61));
  const lines = captureLines(capture);
  assert.ok(lines.includes(`[m005-launcher] ${LAUNCHER_CODES.OUTPUT_LIMIT_EXCEEDED} — the captured output exceeded the aggregate ceiling and was discarded unread; no part of it is reported`));
  assert.equal(lines.includes(CHILD_BLOCK_SENTINEL), false, 'no transcript block on the overflow path');
  const joined = lines.join('\n');
  assert.equal(/captured child output follows/.test(joined), false);
  assert.equal(/is the CHILD's own and is NOT independently established/.test(joined), false);
  assert.equal(/truncat/i.test(joined), false, 'the design discards; it must not claim truncation');
  // NO SECRET-DERIVED LENGTH. `capture.byteLength` counts the bytes the child produced, which is a
  // measurement of the material the discard exists to destroy.
  assert.equal(joined.includes(String(capture.byteLength)), false);
  assert.equal(joined.includes(String(OUTPUT_LIMIT_BYTES)), false);
});

test('§4: a malformed overflow flag is treated as overflow, never as a clean transcript', () => {
  for (const overflowed of [undefined, null, 'false', 0, {}]) {
    const capture = { overflowed, byteLength: 0, text: () => 'postgres://u:p@h/db' };
    const lines = captureLines(capture);
    assert.equal(lines.includes(CHILD_BLOCK_SENTINEL), false, String(overflowed));
    assert.ok(lines.some((l) => l.includes(LAUNCHER_CODES.OUTPUT_LIMIT_EXCEEDED)), String(overflowed));
  }
});

test('§4: a child that exits ZERO cannot override overflow', () => {
  const capture = createCapture();
  capture.push(Buffer.alloc(OUTPUT_LIMIT_BYTES + 1, 0x61));
  const clean = evidenced({ capture, exitCode: 0, signal: null });
  // The verdict, not merely the prose: `normalCompletion` may hold and the exit code may be 0, and
  // the outcome is still the overflow code — so the launcher's exit is 2.
  assert.equal(outcomeCode(clean), LAUNCHER_CODES.OUTPUT_LIMIT_EXCEEDED);
  assert.notEqual(outcomeCode(clean), LAUNCHER_CODES.OK);
  assert.match(renderM005Report(clean).join('\n'), /outcome=baseline_launcher_output_limit_exceeded/);
});

test('§4: overflow with a NONZERO exit still reports the overflow, and the transcript stays gone', () => {
  const capture = createCapture();
  capture.push(Buffer.alloc(OUTPUT_LIMIT_BYTES + 1, 0x61));
  const failed = evidenced({ capture, exitCode: 1 });
  // Overflow outranks the nonzero exit: the exit code is a claim the discarded transcript would
  // have explained, so the record must say the explanation is gone rather than lead with the code.
  assert.equal(outcomeCode(failed), LAUNCHER_CODES.OUTPUT_LIMIT_EXCEEDED);
  const lines = renderM005Report(failed);
  assert.equal(lines.includes(CHILD_BLOCK_SENTINEL), false);
});

test('§4: overflow does not suspend the cleanup and containment obligations', () => {
  const capture = createCapture();
  capture.push(Buffer.alloc(OUTPUT_LIMIT_BYTES + 1, 0x61));
  for (const status of CLEANUP_STATUSES) {
    const dirty = evidenced({
      capture, status, exitCode: 0,
      code: LAUNCHER_CODES.CLEANUP_INCOMPLETE,
      cleanup: { term: 'sent', kill: 'sent', complete: false, closeObserved: false, handleOnly: true, signalFailed: true },
      group: groupOrphan(),
    });
    const code = outcomeCode(dirty);
    // The CLEANUP verdict wins — a live managed process is the thing an operator must act on
    // first — and it can never be OK. The transcript is still gone.
    assert.notEqual(code, LAUNCHER_CODES.OK, status);
    assert.equal(code, LAUNCHER_CODES.CLEANUP_INCOMPLETE, status);
    const lines = renderM005Report(dirty);
    assert.equal(lines.includes(CHILD_BLOCK_SENTINEL), false, status);
    assert.ok(lines.some((l) => l.includes(LAUNCHER_CODES.OUTPUT_LIMIT_EXCEEDED)), status);
    assert.ok(lines.some((l) => l.startsWith('[m005-launcher] cleanup ')), status);
  }
});

test('§4: a run under the cap still reports the transcript, so the bound is not vacuous', () => {
  const capture = createCapture();
  capture.push(Buffer.from('[migrate] apply(up): outcome=complete\n'));
  const lines = captureLines(capture);
  assert.ok(lines.includes(CHILD_BLOCK_SENTINEL));
  assert.ok(lines.some((l) => /captured child output follows/.test(l)));
  assert.equal(lines.some((l) => l.includes(LAUNCHER_CODES.OUTPUT_LIMIT_EXCEEDED)), false);
});

test('§4: the launcher hands runChild the same aggregate ceiling it asserts here', () => {
  // The limit reaching `runChild` is the module constant, not a launcher-local number that could
  // drift from the one every assertion above is written against.
  const src = stripComments(LAUNCHER_SRC);
  assert.match(src, /limit:\s*OUTPUT_LIMIT_BYTES/);
  assert.equal(/limit:\s*\d/.test(src), false, 'the ceiling must never be a literal at the call site');
});

// =============================================================================
// C2B-M005-B0-R1 §3 — this suite is a NON-OPTIONAL release gate
// =============================================================================

test('§3: this suite is a required sentinel and the ratchet equals the discovered count', async () => {
  // WITHOUT THIS ENTRY the file could be deleted and the release suite would still go green, so
  // every guarantee proved above — the redaction correction, the single sink, the artifact gate,
  // the output bound — would be unenforced. The numeric minimum alone is not that guarantee: with
  // slack over the floor a deletion is a silent pass, which is why the sentinel is checked too.
  const { REQUIRED_SENTINELS, MIN_SUITES, discover, validateDiscovery } =
    await import('../../scripts/run-tests.mjs');
  const self = 'tests/quality/managed-m005-launcher.test.mjs';
  assert.ok(REQUIRED_SENTINELS.includes(self), 'this suite must be an exact REQUIRED_SENTINELS entry');
  const files = discover();
  assert.equal(MIN_SUITES, files.length, 'the ratchet must equal the complete current suite count');
  assert.equal(validateDiscovery({ files }).ok, true);
  // The sentinel must refuse ON ITS OWN, with the numeric minimum deliberately satisfied.
  const without = files.filter((f) => f !== self);
  const v = validateDiscovery({ files: without, minSuites: without.length });
  assert.equal(v.ok, false);
  assert.deepEqual(v.problems, [`required sentinel suite is missing, empty, or uncollected: ${self}`]);
});

test('§4: end to end, an overflowing child that exits ZERO makes the launcher exit 2', async () => {
  // THE WHOLE PATH, not the classifier alone: spawn, drain, render, verdict, exit code. A child
  // that floods its output and then exits cleanly is exactly the shape that would otherwise be
  // read as a successful managed apply whose record happens to be missing.
  const d = deps({
    spawn: () => {
      const child = fakeChild();
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.alloc(OUTPUT_LIMIT_BYTES, 0x61));
        child.stderr.emit('data', Buffer.from(`[migrate] ${SYNTH.SUPABASE_DATABASE_URL}\n`));
        child.emit('close', 0, null);
      });
      return child;
    },
  });
  assert.equal(await main([PARENT_FLAG], SYNTH, d.deps), 2);
  const record = d.sink.join('\n');
  assert.match(record, new RegExp(LAUNCHER_CODES.OUTPUT_LIMIT_EXCEEDED));
  assert.match(record, /outcome=baseline_launcher_output_limit_exceeded/);
  assert.equal(/captured child output follows/.test(record), false);
  assert.equal(record.includes(SYNTH.SUPABASE_DATABASE_URL), false);
  assert.equal(/a{16,}/.test(record), false);
});

// ---- C2B-M005-LRLS-L3-R3: output noninterference ------------------------------
//
// Every fixture below is SYNTHETIC. Nothing here reads process.env, opens a socket, resolves a
// name, or touches a database — the whole matrix is strings in and strings out.

/** The child transcript these tests hold FIXED while the credential underneath it varies. */
const CHILD_TRANSCRIPT = [
  '[m005-preflight] target endpointFamily=session database=EXPECTED',
  '[m005-preflight] governedSource=MATCH',
  '[m005-preflight] transaction readOnly=true isolation=repeatable_read',
  '[m005-preflight] objects tables=6/6 authoritative=6/6 columns=13/13 sequences=0',
  '[m005-preflight] ledgerDisableRlsExposure incrementalExposure=NONE_DETECTED newlyExposedRoles=0',
  '[m005-preflight] ledgerNonOwnerPrivilegeCounts SELECT=0,INSERT=0,UPDATE=0',
  '[m005-preflight] ledgerPolicies readable=true total=0 commands=NONE',
  '[m005-preflight] cleanup rollback=completed gracefulSocketClose=not_observed',
  '[m005-preflight] migration005=UNAUTHORIZED; a separate authorization is required to execute it',
  '[m005-preflight] REFUSED: m005_preflight_ledger_inconsistent',
  '[acl-preflight] globalBase.tables=BUILTIN_RETAINED',
].join('\n');

/**
 * Credentials chosen to OVERLAP the fixed vocabulary, which is the whole point of the matrix.
 *
 * Under the retired inline-splice path each of these produced a DIFFERENT record, and each
 * difference recovered the credential exactly by differencing against the published template.
 */
const OVERLAP_CREDENTIALS = Object.freeze([
  'EXPECTED', 'PRESENT', 'NONE_DETECTED', 'NONE_DET', 'ECT', 'TRUE', 'true', 'false',
  'session', 'postgres', 'MATCH', 'SELECT', 'repeatable_read', 'completed', 'NONE',
  '6', '0', 'not_observed', 'BUILTIN_RETAINED', 'zzzzzzzzzzzz',
]);

const credentialEnv = (password) => Object.freeze({
  SUPABASE_DATABASE_URL: `postgresql://postgres.abcdefghijklmnop:${encodeURIComponent(password)}@aws-0-eu-x.pooler.supabase.com/postgres`,
  SUPABASE_URL: 'https://abcdefghijklmnop.supabase.com',
  DATABASE_CA_CERT: SYNTH.DATABASE_CA_CERT,
});

test('C2B-M005-LRLS-L4: the retired block path leaked by differencing, and the primitive is gone', () => {
  // THE TEST IS NOT VACUOUS. Before asserting the correction, prove the defect it corrects was real
  // and EXACTLY recoverable — not merely "some marker appeared somewhere". The primitive that
  // enabled it has been deleted, so the retired behaviour is reconstructed here, from the same two
  // exported pieces it was built from, purely to demonstrate what it did.
  const retiredBlock = (redact, emit) => (text) => {
    for (const l of redact(String(text ?? '')).split(/\r?\n/)) {
      if (l !== '') emit(`  | ${safeLineText(l)}`);
    }
  };
  const leak = (password) => {
    const out = [];
    const block = retiredBlock(buildTypedRedactor(classifySecrets(credentialEnv(password))), (l) => out.push(l));
    block('[m005-preflight] target endpointFamily=session database=EXPECTED');
    return out.join('\n');
  };
  // `EXPECTED` minus the rendered remainder `EXP…ED` is precisely the credential `ECT`.
  assert.match(leak('ECT'), /database=EXP\[REDACTED\]ED$/);
  assert.match(leak('session'), /endpointFamily=\[REDACTED\] /);
  // And a non-overlapping credential left the line untouched, so the marker's PRESENCE and POSITION
  // were both functions of the secret — a known-plaintext oracle over a published template.
  assert.match(leak('zzzzzzzzzzzz'), /endpointFamily=session database=EXPECTED$/);
  assert.notEqual(leak('ECT'), leak('zzzzzzzzzzzz'));

  // AND THE SAME LINE, THROUGH THE PATH THAT REPLACED IT, IS INVARIANT.
  const rendered = (password) => renderPreflightTranscript(
    '[m005-preflight] target endpointFamily=session database=EXPECTED', '', true).join('\n');
  assert.equal(new Set(['ECT', 'session', 'EXPECTED', 'zzzzzzzzzzzz'].map(rendered)).size, 1,
    'one rendering for every credential');

  // THE PRIMITIVE ITSELF IS GONE, so no call site can reintroduce the class in one line.
  const sink = createSafeSink((x) => x, () => {});
  assert.equal(typeof sink, 'function', 'the line sink remains');
  assert.equal(sink.block, undefined, 'the splicing entry point must not exist');
  const src = readFileSync(LAUNCHER_PATH, 'utf8');
  assert.ok(!/line\.block\s*=/.test(src), 'and the source must not define it');
});

test('C2B-M005-LRLS-L3-R3: one fixed child outcome renders identically for every credential', () => {
  // §3 — THE SECURITY PROPERTY ITSELF. The renderer takes no credential, so the proof is that the
  // whole composition the launcher performs is invariant under the credential.
  const renderings = new Set();
  for (const password of OVERLAP_CREDENTIALS) {
    // The environment is built and classified exactly as the launcher builds it, so a future edit
    // that reintroduced the redactor on this path would make these renderings diverge.
    classifySecrets(credentialEnv(password));
    renderings.add(JSON.stringify(renderPreflightTranscript(CHILD_TRANSCRIPT, '', true)));
  }
  assert.equal(renderings.size, 1, `the transcript varied with the credential: ${renderings.size} distinct renderings`);
  // AND THE SINGLE RENDERING IS THE FULL RECORD, not an empty one that would satisfy equality
  // vacuously — every grammar-valid line survived.
  const rendered = renderPreflightTranscript(CHILD_TRANSCRIPT, '', true);
  // 11 transcript lines plus the always-present accounting notice.
  assert.equal(rendered.length, 12, rendered.join('\n'));
  assert.ok(rendered.slice(0, 11).every((l) => l.startsWith('  | ')), rendered.join('\n'));
  assert.equal(rendered[11],
    `${TRANSCRIPT_DISCARDED_TOKEN} stdoutUnparsable=0 stderrUnparsable=0 overCap=0 truncated=false`);
  assert.ok(!rendered.some((l) => l.includes('[REDACTED]')), 'no marker may be spliced into a known template');
});

test('C2B-M005-LRLS-L3-R4: the canonical line is rebuilt from parsed values, not passed through', () => {
  // Re-rendering from the PARSE is what makes the output independent of the child's byte layout.
  // `007/6` was the old fixture and asserted a count of SEVEN OF SIX. The numerator is now bounded
  // by its own denominator, so that line is refused outright and the leading-zero re-render is
  // proved on a count the child could actually produce.
  assert.equal(canonicalPreflightLine('[m005-preflight] objects tables=002/6'), '[m005-preflight] objects tables=2/6');
  assert.equal(canonicalPreflightLine('[m005-preflight] objects tables=007/6'), null, 'seven of six is not a count');
  assert.equal(canonicalPreflightLine('[m005-preflight] findingCount=0009'), '[m005-preflight] findingCount=9');
  // EACH KEY IS NOW PINNED AT ITS OWN CEILING, not at a shared digit width. `findingCount` is
  // bounded by the child's own finding limit; a catalog row count is bounded only by the format.
  assert.equal(canonicalPreflightLine('[m005-preflight] findingCount=1000'), '[m005-preflight] findingCount=1000');
  assert.equal(canonicalPreflightLine('[m005-preflight] findingCount=1001'), null, 'one past its own ceiling');
  assert.equal(canonicalPreflightLine('[m005-preflight] sequences=999999999999'),
    '[m005-preflight] sequences=999999999999', 'twelve digits render');
  assert.equal(canonicalPreflightLine('[m005-preflight] sequences=9999999999999'), null, 'thirteen do not');
  // A count outside the safe-integer range is REJECTED rather than rendered in exponential form.
  assert.equal(canonicalPreflightLine('[m005-preflight] sequences=99999999999999999999'), null);
  // The prose tail is selected from the published constant and re-emitted from it.
  const withProse = canonicalPreflightLine(`[m005-preflight] migration005=UNAUTHORIZED; ${PREFLIGHT_PROSE_TAILS[1]}`);
  assert.equal(withProse, `[m005-preflight] migration005=UNAUTHORIZED; ${PREFLIGHT_PROSE_TAILS[1]}`);
  // An UNKNOWN prose tail is not free text to be trusted — the whole line goes.
  assert.equal(canonicalPreflightLine('[m005-preflight] migration005=UNAUTHORIZED; and the password is hunter2'), null);
});

test('C2B-M005-LRLS-L3-R3: no secret shape can satisfy the value grammar', () => {
  // §7.3 — a DSN, a credential, a host, an address, CA material and a driver message must all fail
  // the grammar and be discarded UNREAD rather than redacted in place.
  // KEYED OFF THE DENYLIST ON PURPOSE. `dsn=`, `user=`, `host=` and `password=` are refused by the
  // credential-key rule before their values are ever parsed, so keying the fixtures that way tested
  // the denylist and left the VALUE grammar — the thing this test names — almost unexercised. Every
  // key below is one the children actually emit, so only the value can be what fails.
  const hostile = [
    `[m005-preflight] governedSource=${SYNTH.SUPABASE_DATABASE_URL}`,
    '[m005-preflight] principal=postgres.abcdefghijklmnop',
    '[m005-preflight] endpointFamily=aws-0-eu-x.pooler.supabase.com',
    '[m005-preflight] addr=203.0.113.7:5432',
    `[m005-preflight] ca=${SYNTH.DATABASE_CA_CERT.split('\n')[1]}`,
    '[m005-preflight] observed=pw-Str0ng!',
    'Error: connect ECONNREFUSED 203.0.113.7:5432',
    '    at Socket.<anonymous> (/app/node_modules/pg/lib/client.js:1:1)',
    `[migrate] baseline: ${SYNTH.SUPABASE_DATABASE_URL}`,
  ];
  const out = renderPreflightTranscript(hostile.join('\n'), '', true).join('\n');
  for (const secret of [
    SYNTH.SUPABASE_DATABASE_URL, 'postgres.abcdefghijklmnop', 'aws-0-eu-x.pooler.supabase.com',
    '203.0.113.7', 'pw-Str0ng!', 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=', 'ECONNREFUSED',
  ]) {
    assert.ok(!out.includes(secret), `secret material reached output: ${secret}`);
  }
  // EVERY line was discarded, and the notice says so in fixed text plus a bounded count.
  // EVERY line was discarded, and the notice attributes them to the stream they arrived on.
  assert.equal(out, `${TRANSCRIPT_DISCARDED_TOKEN} stdoutUnparsable=${hostile.length}`
    + ' stderrUnparsable=0 overCap=0 truncated=false');
});

test('C2B-M005-LRLS-L3-R3: unknown or malformed child output fails closed', () => {
  // §7.5. Each of these differs from a valid line in exactly one way.
  for (const bad of [
    '[unknown-tag] governedSource=MATCH',          // tag not in the allowlist
    'governedSource=MATCH',                        // no tag at all
    '[m005-preflight]',                            // tag with no body
    '[m005-preflight] governedSource=Mixed_Case',  // value is neither an enum nor a code
    '[m005-preflight] governedSource=has.dot',     // a dot can carry a hostname
    '[m005-preflight] governedSource=a/b/c',       // a slash outside a ratio can carry a path
    '[m005-preflight] 9bad=1',                     // key does not start with a letter
    '[m005-preflight]  doubleSpace=1',             // an empty item is not silently dropped
  ]) {
    assert.equal(canonicalPreflightLine(bad), null, `must fail closed: ${bad}`);
  }
  assert.equal(canonicalPreflightLine(undefined), null);
  assert.equal(canonicalPreflightLine(42), null);
});

test('C2B-M005-LRLS-L3-R3: a capture is never read before closure is proved', () => {
  // §4 — anything but exactly `true` withholds the WHOLE transcript, and the withheld token carries
  // no count, no length and no fragment of what was withheld.
  for (const notClosed of [false, undefined, null, 'true', 1]) {
    const out = renderPreflightTranscript(CHILD_TRANSCRIPT, 'Error: ' + SYNTH.SUPABASE_DATABASE_URL, notClosed);
    assert.deepEqual(out, [TRANSCRIPT_UNAVAILABLE_TOKEN], `closure gate opened for ${String(notClosed)}`);
  }
  // The gate is on the CAPTURE too, not only on this argument: an unsealed capture yields nothing.
  const capture = createCapture();
  capture.push(Buffer.from('[m005-preflight] governedSource=MATCH\n', 'utf8'), 'stdout');
  assert.equal(capture.sealed, false);
  assert.equal(capture.streamText('stdout'), '');
  capture.seal();
  assert.equal(capture.streamText('stdout'), '[m005-preflight] governedSource=MATCH\n');
});

test('C2B-M005-LRLS-L3-R3: fragmentation cannot reassemble a secret, within or across streams', () => {
  // §4 — SAME-STREAM first: the two halves arrive in separate chunks on one pipe.
  const dsn = SYNTH.SUPABASE_DATABASE_URL;
  const half = Math.floor(dsn.length / 2);
  const same = createCapture();
  same.push(Buffer.from(`[m005-preflight] dsn=${dsn.slice(0, half)}`, 'utf8'), 'stdout');
  same.push(Buffer.from(`${dsn.slice(half)}\n`, 'utf8'), 'stdout');
  same.seal();
  assert.ok(same.streamText('stdout').includes(dsn), 'the capture really did reassemble it (not vacuous)');
  assert.ok(!renderPreflightTranscript(same.streamText('stdout'), same.streamText('stderr'), true).join('\n').includes(dsn));

  // CROSS-STREAM, in BOTH orders. The halves must not be adjacent in either stream's text, and
  // neither half may reach output for an operator to rejoin by hand.
  for (const [first, second] of [['stdout', 'stderr'], ['stderr', 'stdout']]) {
    const split = createCapture();
    split.push(Buffer.from(dsn.slice(0, half), 'utf8'), first);
    split.push(Buffer.from(dsn.slice(half), 'utf8'), second);
    split.seal();
    assert.ok(!split.streamText('stdout').includes(dsn), `${first}->${second}: stdout must not hold the whole secret`);
    assert.ok(!split.streamText('stderr').includes(dsn), `${first}->${second}: stderr must not hold the whole secret`);
    const out = renderPreflightTranscript(split.streamText('stdout'), split.streamText('stderr'), true).join('\n');
    assert.ok(!out.includes(dsn.slice(0, half)), `${first}->${second}: a half escaped`);
    assert.ok(!out.includes(dsn.slice(half)), `${first}->${second}: a half escaped`);
  }

  // ARBITRARY STDERR INTERLEAVED BETWEEN STDOUT CHUNKS must not corrupt either stream's parse.
  const interleaved = createCapture();
  interleaved.push(Buffer.from('[m005-preflight] governed', 'utf8'), 'stdout');
  interleaved.push(Buffer.from('noise', 'utf8'), 'stderr');
  interleaved.push(Buffer.from('Source=MATCH\n', 'utf8'), 'stdout');
  interleaved.seal();
  assert.equal(interleaved.streamText('stdout'), '[m005-preflight] governedSource=MATCH\n');
  assert.equal(interleaved.streamText('stderr'), 'noise');

  // A MULTI-BYTE CODE POINT SPLIT ACROSS CHUNKS is whole before any index is taken.
  const wide = Buffer.from('[m005-preflight] governedSource=MATCH ✓\n', 'utf8');
  const cut = wide.indexOf(0xe2) + 1; // mid-sequence of U+2713
  const mb = createCapture();
  mb.push(wide.subarray(0, cut), 'stdout');
  mb.push(wide.subarray(cut), 'stdout');
  mb.seal();
  assert.equal(mb.streamText('stdout'), '[m005-preflight] governedSource=MATCH ✓\n');
  assert.ok(!mb.streamText('stdout').includes('�'), 'no replacement character from a split code point');
});

test('C2B-M005-LRLS-L3-R4: the transcript is bounded in lines, items and segments', () => {
  // §7.6 — an adversarial child chooses neither the cost nor the length of this record.
  const many = Array.from({ length: MAX_TRANSCRIPT_LINES + 25 }, () => '[m005-preflight] governedSource=MATCH').join('\n');
  const out = renderPreflightTranscript(many, '', true);
  assert.equal(out.length, MAX_TRANSCRIPT_LINES + 1, 'the ceiling plus exactly one notice');
  assert.equal(out[out.length - 1],
    `${TRANSCRIPT_DISCARDED_TOKEN} stdoutUnparsable=0 stderrUnparsable=0 overCap=25 truncated=true`);
  // TRUNCATION MEANS EVIDENCE WAS LOST, and nothing else. Junk beyond the ceiling is unparsable,
  // not truncated: the ceiling used to be tested before the grammar, so 400 valid lines followed by
  // two junk ones claimed a truncation that never happened.
  const mixed = Array.from({ length: MAX_TRANSCRIPT_LINES }, () => '[m005-preflight] governedSource=MATCH')
    .concat(['junk one', 'junk two']).join('\n');
  assert.equal(renderPreflightTranscript(mixed, '', true).pop(),
    `${TRANSCRIPT_DISCARDED_TOKEN} stdoutUnparsable=2 stderrUnparsable=0 overCap=0 truncated=false`);
  // A CRASHED CHILD IS DISTINGUISHABLE FROM BENIGN NOISE. Its stack goes to stderr, which is always
  // unparsable; one undivided count made that byte-identical to five warnings on stdout.
  const valid = '[m005-preflight] governedSource=MATCH';
  assert.equal(renderPreflightTranscript(valid, 'Error: x\n at a\n at b', true).pop(),
    `${TRANSCRIPT_DISCARDED_TOKEN} stdoutUnparsable=0 stderrUnparsable=3 overCap=0 truncated=false`);
  assert.equal(renderPreflightTranscript(`${valid}\nn1\nn2\nn3`, '', true).pop(),
    `${TRANSCRIPT_DISCARDED_TOKEN} stdoutUnparsable=3 stderrUnparsable=0 overCap=0 truncated=false`);
  // Item and segment ceilings, driven with keys and members that are individually LEGAL, so the
  // ceiling is what refuses them rather than the domain lookup.
  assert.equal(canonicalPreflightLine(`[m005-preflight] ${Array.from({ length: 40 }, () => 'total=1').join(' ')}`), null);
  assert.equal(canonicalPreflightLine(`[m005-preflight] commands=${Array.from({ length: 20 }, () => 'ALL').join(',')}`), null);
  assert.equal(canonicalPreflightLine(`[m005-preflight] commands=${Array.from({ length: 16 }, () => 'ALL').join(',')}`),
    `[m005-preflight] commands=${Array.from({ length: 16 }, () => 'ALL').join(',')}`, 'exactly at the segment ceiling');
  // The published tag list is what the renderer actually consults, and each tag has its OWN
  // terminal vocabulary — a code from one tag is not a code for the other.
  // THE MIGRATION TAG IS NOT HERE. Its vocabulary names constructs the generic launcher is
  // forbidden to mention, so that grammar is built there from its own tables; these two are built
  // here from these.
  assert.deepEqual([...PREFLIGHT_TRANSCRIPT_TAGS], ['m005-preflight', 'acl-preflight']);
  assert.equal(canonicalPreflightLine('[m005-preflight] outcome=m005_preflight_port_failed'),
    '[m005-preflight] outcome=m005_preflight_port_failed');
  assert.equal(canonicalPreflightLine('[acl-preflight] outcome=default_acl_preflight_port_failed'),
    '[acl-preflight] outcome=default_acl_preflight_port_failed');
  assert.equal(canonicalPreflightLine('[acl-preflight] outcome=m005_preflight_port_failed'), null,
    "one child's code is not a code for the other");
});

test('C2B-M005-LRLS-L3-R3: runChild tags every chunk with the pipe it arrived on', async () => {
  // §4 — THE CONTRACT, ASSERTED DIRECTLY. Dropping the stream name in the data handler leaves the
  // rendered record unchanged for a well-formed child, so nothing downstream can catch it; the
  // separation has to be pinned where it is established. Without this the `push(c, streamName)`
  // argument was removable with every suite still green.
  const child = fakeChild();
  setImmediate(() => {
    child.stdout.emit('data', Buffer.from('[m005-preflight] governedSource=MATCH\n', 'utf8'));
    child.stderr.emit('data', Buffer.from('a driver message\n', 'utf8'));
    child.emit('exit', 0, null);
    child.emit('close', 0, null);
  });
  const result = await runChild({
    command: 'node',
    args: ['-e', ''],
    env: {},
    spawn: () => child,
    identify: () => null,
    selfIdentity: () => null,
    scan: () => ({ available: true, pidPresent: false, leaderIdentityMatches: null, groupMembers: [], sessionMembers: [] }),
    killGroup: () => true,
  });
  assert.equal(result.streamsClosed, true, 'the fake must reach the terminal stream state');
  assert.equal(result.capture.sealed, true, 'a closed run must seal its capture');
  assert.equal(result.capture.streamText('stdout'), '[m005-preflight] governedSource=MATCH\n');
  assert.equal(result.capture.streamText('stderr'), 'a driver message\n');
  // The interleave is still available unchanged for the historical baseline record.
  assert.equal(result.capture.text(), '[m005-preflight] governedSource=MATCH\na driver message\n');
});

test('C2B-M005-LRLS-L3-R3: the prose tail is selected from the constant, never copied from the child', () => {
  // R3-M8 IS AN EQUIVALENT MUTANT AND IS RECORDED AS ONE. Replacing the constant lookup with the
  // child's own slice cannot change any output, because the slice reached that line only by being
  // EXACTLY EQUAL to a published constant — `indexOf` already proved the equality. No behavioural
  // test can distinguish the two, so the contract is pinned in the source instead: what makes the
  // constant load-bearing is that a future edit cannot widen it into free text.
  // THE GRAMMAR NOW LIVES IN THE BASELINE LAUNCHER, beside the capture whose per-stream accessor it
  // reads — and because the baseline launcher's own report needs it too, which an import in the
  // other direction could not provide without making the base depend on a specialisation.
  const src = readFileSync(resolve(HERE, '..', '..', 'scripts', 'managed-baseline-launcher.mjs'), 'utf8');
  const fn = src.slice(src.indexOf('  function canonicalLine(raw) {'));
  const body = fn.slice(0, fn.indexOf('\n  }\n') + 4);
  assert.ok(body.includes('PROSE_TAILS[proseIndex]'), 'the tail must be read from the constant list');
  assert.ok(body.includes('if (proseIndex === -1) return null;'), 'an unknown tail must fail closed');
  // And equality really is what the lookup establishes, so the two forms agree by construction.
  for (const tail of PREFLIGHT_PROSE_TAILS) {
    assert.equal(PREFLIGHT_PROSE_TAILS[PREFLIGHT_PROSE_TAILS.indexOf(tail)], tail);
  }
});

test('C2B-M005-LRLS-L3-R4: the value grammar is anchored, so no value is silently truncated', () => {
  // A ratio must match WHOLLY: an unanchored pattern would render `6/6x` as `6/6` and quietly
  // report a count the child never printed. The DENOMINATOR is pinned per key too, so a ratio
  // against the wrong total cannot render at all.
  assert.equal(canonicalPreflightLine('[m005-preflight] tables=6/6x'), null);
  assert.equal(canonicalPreflightLine('[m005-preflight] tables=x6/6'), null);
  assert.equal(canonicalPreflightLine('[m005-preflight] tables=6/13'), null, 'the wrong denominator');
  assert.equal(canonicalPreflightLine('[m005-preflight] tables=7/6'), null, 'a numerator past its own total');
  assert.equal(canonicalPreflightLine('[m005-preflight] tables=UNREADABLE/6'),
    '[m005-preflight] tables=UNREADABLE/6', 'an unread count still renders');
  // A LEADING BARE TOKEN MUST BE A PINNED LABEL. The previous rule accepted any camelCase word,
  // so a mixed-case run — the shape of an ordinary password — rendered verbatim in position 0.
  assert.equal(canonicalPreflightLine('[m005-preflight] 9word total=1'), null);
  assert.equal(canonicalPreflightLine('[m005-preflight] word total=1'), null, 'not a pinned label');
  assert.equal(canonicalPreflightLine('[m005-preflight] objects total=1'), '[m005-preflight] objects total=1');
  // The line-length ceiling is real, not decorative, and is reached with items that are each
  // individually legal so the ceiling is what refuses the line.
  const item = 'aclNote=A_MET_IS_NOT_REQUIRED_MIGRATION_005_CHANGES_THE_POSTURE';
  const wide = Array.from({ length: 30 }, () => item).join(' ');
  assert.ok(wide.length > 1200, `fixture must exceed the ceiling: ${wide.length}`);
  assert.equal(canonicalPreflightLine(`[m005-preflight] ${wide}`), null);
  const narrow = Array.from({ length: 18 }, () => item).join(' ');
  assert.ok(narrow.length < 1200, `fixture must sit under the ceiling: ${narrow.length}`);
  assert.equal(canonicalPreflightLine(`[m005-preflight] ${narrow}`), `[m005-preflight] ${narrow}`);
  // An empty comma segment must fail the item rather than be skipped: skipping would render
  // `ALL,,SELECT` as `ALL,SELECT`, changing the child's meaning without saying so.
  assert.equal(canonicalPreflightLine('[m005-preflight] commands=ALL,,SELECT'), null);
  // A non-string that can STRINGIFY into a valid line must still be refused — the type check is the
  // gate, not the coercion that would otherwise happen inside the regex.
  assert.equal(canonicalPreflightLine({ toString: () => '[m005-preflight] governedSource=MATCH' }), null);
});

test('C2B-M005-LRLS-L3-R3: an untagged chunk defaults to stdout, never to stderr', () => {
  // SWEEP B27. Every production call passes the pipe name explicitly, so the DEFAULT is reachable
  // only from a direct caller — which is exactly why nothing pinned it. Defaulting to stderr would
  // silently move a historical caller's bytes into the wrong stream.
  const capture = createCapture();
  capture.push(Buffer.from('untagged', 'utf8'));
  capture.seal();
  assert.equal(capture.streamText('stdout'), 'untagged');
  assert.equal(capture.streamText('stderr'), '');
  // An unrecognised name is folded into stdout rather than dropped, so the byte ceiling still sees it.
  const odd = createCapture();
  odd.push(Buffer.from('xy', 'utf8'), 'not-a-pipe');
  odd.seal();
  assert.equal(odd.streamText('stdout'), 'xy');
  assert.equal(odd.byteLength, 2, 'an unrecognised pipe name must not lose the bytes');
});

test('C2B-M005-LRLS-L3-R3: streamsClosed needs BOTH conjuncts, not either one', () => {
  // SWEEP B29. On a real child the two coincide, so `&&` and `||` agree in every ordinary run and
  // the conjunction is unfalsifiable without a child that separates them. This is that child: the
  // subprocess `close` fires while a pipe is still open, which is precisely the late-write window
  // in which a capture must NOT be treated as terminal.
  const child = new EventEmitter();
  child.pid = CHILD_PID;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.unref = () => {};
  child.stdout.unref = () => {};
  child.stderr.unref = () => {};
  child.kill = () => true;
  setImmediate(() => {
    child.stdout.emit('data', Buffer.from('[m005-preflight] governedSource=MATCH\n', 'utf8'));
    child.stdout.emit('close');           // ONE pipe closes...
    child.emit('exit', 0, null);
    child.emit('close', 0, null);         // ...and the subprocess closes with stderr still open.
  });
  return runChild({
    command: 'node',
    args: ['-e', ''],
    env: {},
    spawn: () => child,
    identify: () => null,
    selfIdentity: () => null,
    scan: () => ({ available: true, pidPresent: false, leaderIdentityMatches: null, groupMembers: [], sessionMembers: [] }),
    killGroup: () => true,
  }).then((result) => {
    assert.equal(result.closeObserved, true, 'the subprocess close really did fire (not vacuous)');
    assert.equal(result.streamsClosed, false, 'one open pipe must deny the terminal stream state');
    assert.equal(result.capture.sealed, false, 'an unproved closure must not seal the capture');
    assert.equal(result.capture.streamText('stdout'), '', 'and an unsealed capture yields nothing');
  });
});

test('C2B-M005-LRLS-L3-R3: an overflowed capture yields nothing from either stream', () => {
  // SWEEP B25/B26 ARE A REDUNDANT PAIR. Clearing the per-stream buffers on overflow and refusing to
  // decode while overflowed each make the other unobservable, so NEITHER can be killed alone — and
  // the existing overflow tests all read `text()`, which left the per-stream accessor uncovered by
  // both. Together the two removals hand back the very bytes the ceiling exists to discard.
  // THE FIXTURE MATTERS. Chunks must land BELOW the ceiling first and only then overflow: a capture
  // that overflows on its very first push has nothing buffered to leak, so it would report a pass
  // for either implementation and prove nothing.
  const capture = createCapture(64);
  capture.push(Buffer.from('[m005-preflight] a=1\n', 'utf8'), 'stdout');
  capture.push(Buffer.from('[m005-preflight] b=2\n', 'utf8'), 'stderr');
  assert.equal(capture.overflowed, false, 'the first two chunks must fit (the fixture is staged)');
  capture.push(Buffer.from(`Error: ${SYNTH.SUPABASE_DATABASE_URL}\n`, 'utf8'), 'stderr');
  capture.seal();
  assert.equal(capture.overflowed, true, 'the fixture must actually overflow (not vacuous)');
  assert.equal(capture.streamText('stdout'), '', 'an overflowed stdout must decode to nothing');
  assert.equal(capture.streamText('stderr'), '', 'an overflowed stderr must decode to nothing');
  assert.equal(capture.text(), '', 'and the historical interleave is discarded too');
  // End to end: the renderer over an overflowed capture emits no transcript line at all.
  // AN EMPTY TRANSCRIPT IS STATED, NOT IMPLIED. Returning nothing made "the child printed nothing",
  // "the capture was absent" and "everything rendered" indistinguishable inside the report's
  // captured-output block; an explicit all-zero notice separates them.
  assert.deepEqual(
    renderPreflightTranscript(capture.streamText('stdout'), capture.streamText('stderr'), true),
    [`${TRANSCRIPT_DISCARDED_TOKEN} stdoutUnparsable=0 stderrUnparsable=0 overCap=0 truncated=false`],
  );
});

test('C2B-M005-LRLS-L3-R4: the leading item must be a PINNED label, not merely label-shaped', () => {
  // THE POSITION RULE WAS NOT ENOUGH ON ITS OWN. It confined a mixed-case run to position 0, but
  // any camelCase token was admitted there — so a 40-character password placed first still
  // rendered verbatim. The label is now selected from a pinned list by index, which closes the
  // last position in which the child chose the characters.
  assert.equal(canonicalPreflightLine('[m005-preflight] CamelCaseThing total=1'), null, 'not a pinned label');
  assert.equal(canonicalPreflightLine('[m005-preflight] MyP4ssw0rdIsHere total=1'), null);
  assert.equal(canonicalPreflightLine('[m005-preflight] total=1 MixedCasePassword'), null, 'nor anywhere else');
  assert.equal(canonicalPreflightLine('[m005-preflight] objects total=1'), '[m005-preflight] objects total=1');
  // A POSITIONAL VALUE is admitted only after the label that owns it, and only from that label's
  // own vocabulary — a bare token has no key of its own to be checked against otherwise.
  assert.equal(
    canonicalPreflightLine('[m005-preflight] ledgerNonOwnerPrivilegeCounts SELECT=0,INSERT=0'),
    '[m005-preflight] ledgerNonOwnerPrivilegeCounts SELECT=0,INSERT=0',
  );
  assert.equal(canonicalPreflightLine('[m005-preflight] ledgerColumnPrivilegeContribution NONE total=1'),
    '[m005-preflight] ledgerColumnPrivilegeContribution NONE total=1');
  assert.equal(canonicalPreflightLine('[m005-preflight] objects NONE total=1'), null,
    'a label that owns no positional value admits no bare token');
  assert.equal(canonicalPreflightLine('[m005-preflight] REFUSED: m005_preflight_port_failed'),
    '[m005-preflight] REFUSED: m005_preflight_port_failed');
  assert.equal(canonicalPreflightLine('[m005-preflight] REFUSED: m005_preflight_not_a_code'), null,
    'a refusal names a code from the pinned vocabulary, not an arbitrary token');
  // And the real space-separated prose run still survives, because the tail is pinned as a whole.
  const scope = '[m005-preflight] ledgerDisableRlsExposureScope=NONE_DETECTED describes what was observed'
    + ' now and proves nothing about a later grant';
  assert.equal(canonicalPreflightLine(scope), scope);
  // A label may not hide inside a comma list either.
  assert.equal(canonicalPreflightLine('[m005-preflight] target,CamelCase total=1'), null);
});

test('C2B-M005-LRLS-L3-R4: a label is a pinned member, so punctuation and length cannot reach it', () => {
  // The label used to be the ONE position accepting mixed case, so its CHARACTER SET was all that
  // kept a hostname out of it — a dot, an internal colon or a hyphen each had to be excluded by
  // hand, and a 40-character ceiling had to be held by hand as well. Membership retires all of it:
  // a token that is not on the list cannot appear whatever characters or length it has.
  for (const bad of [
    '[m005-preflight] db.abcdefghijklmnop total=1',
    '[m005-preflight] host:5432 total=1',
    '[m005-preflight] aws-0-eu-x total=1',
    '[m005-preflight] a.b total=1',
    `[m005-preflight] a${'B'.repeat(39)} total=1`,
    `[m005-preflight] a${'B'.repeat(40)} total=1`,
  ]) {
    assert.equal(canonicalPreflightLine(bad), null, `must fail closed: ${bad}`);
  }
  // The shapes the children really emit are still accepted.
  assert.equal(canonicalPreflightLine('[m005-preflight] REFUSED: m005_preflight_port_failed'),
    '[m005-preflight] REFUSED: m005_preflight_port_failed');
  assert.equal(canonicalPreflightLine('[m005-preflight] ledgerRlsAuthority ownsLedger=TRUE'),
    '[m005-preflight] ledgerRlsAuthority ownsLedger=TRUE');
  // A DOTTED KEY renders only when the tag's table declares that exact key.
  assert.equal(canonicalPreflightLine('[acl-preflight] globalBase.tables=BUILTIN_RETAINED'),
    '[acl-preflight] globalBase.tables=BUILTIN_RETAINED');
  assert.equal(canonicalPreflightLine('[m005-preflight] globalBase.tables=BUILTIN_RETAINED'), null,
    "a key declared for one tag is not declared for the other");
});

test('C2B-M005-LRLS-L3-R4: a line that is nothing but a bare label is refused', () => {
  // A LABEL MUST LABEL SOMETHING. Neither child emits a label-only line — every real line carries a
  // field after its label, or is a `key=value` with no label at all — so refusing it costs nothing.
  assert.equal(canonicalPreflightLine('[m005-preflight] MyP4ssw0rdIsHere'), null);
  assert.equal(canonicalPreflightLine('[m005-preflight] ledgerRlsAuthority'), null);
  // Both real shapes still render: a label WITH a field, and a bare `key=value`.
  assert.equal(canonicalPreflightLine('[m005-preflight] ledgerRlsAuthority ownsLedger=TRUE'),
    '[m005-preflight] ledgerRlsAuthority ownsLedger=TRUE');
  assert.equal(canonicalPreflightLine('[m005-preflight] disposition=m005_preflight_residue_present'),
    '[m005-preflight] disposition=m005_preflight_residue_present');
  assert.equal(canonicalPreflightLine('[m005-preflight] REFUSED: m005_preflight_port_failed'),
    '[m005-preflight] REFUSED: m005_preflight_port_failed');
});

test('C2B-M005-LRLS-L3-R4: the single-case-secret residual is CLOSED by per-field domains', () => {
  // THIS TEST RECORDED THE RESIDUAL; IT NOW RECORDS ITS CLOSURE.
  //
  // The lexical grammar blocked every value that carried STRUCTURE — a DSN, a host, an address, a
  // PEM body, a path, a URI — and could not block a secret that was itself a bare single-case
  // alphanumeric run, because such a run is indistinguishable from the codes and enums the children
  // legitimately emit. That was true for as long as a value was authorised by its SHAPE.
  //
  // It is no longer how a value is authorised. A value is emitted only if it is a member of its own
  // key's pinned set, so a lowercase hexadecimal key and an uppercase password are refused for the
  // same reason a hostname is: they are not in the set, and no shape can put them there.
  for (const structured of [
    'postgresql://u:p@h.example.com:5432/postgres', 'db.abcdefghijklmnopqrst.supabase.co',
    '203.0.113.7', '2001:db8::1', 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=',
    '/app/node_modules/pg/lib/client.js', 'eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.sig',
    '123e4567-e89b-12d3-a456-426614174000', 'MyP4ssw0rdIsHere',
  ]) {
    assert.equal(canonicalPreflightLine(`[m005-preflight] governedSource=${structured}`), null,
      `must block: ${structured}`);
  }
  // THE FORMER RESIDUAL, now refused in a field that legitimately carries lowercase codes and one
  // that legitimately carries uppercase enums.
  for (const bare of ['abcdefghijklmnopqrst', 'postgres', 'deadbeefcafebabe0123456789abcdef',
    'SUPERSECRET_HUNTER2', 'hunter2', 'u', 'A', 'projectref']) {
    assert.equal(canonicalPreflightLine(`[m005-preflight] governedSource=${bare}`), null,
      `an uppercase-enum field must not accept: ${bare}`);
    assert.equal(canonicalPreflightLine(`[m005-preflight] outcome=${bare}`), null,
      `a lowercase-code field must not accept: ${bare}`);
  }
  // AND EVERY DECLARED FIELD, not just two. A secret-shaped value is injected into each key of each
  // tag and must be refused unless it happens to BE that key's pinned value.
  const HOSTILE = ['hunter2', 'SUPERSECRET_HUNTER2', 'deadbeefcafebabe0123456789abcdef',
    'db.abcdefghijklmnopqrst.supabase.co', 'u', 'postgres.abcdefghijklmnop', '203.0.113.7'];
  let checked = 0;
  for (const tag of PREFLIGHT_TRANSCRIPT_TAGS) {
    for (const key of PREFLIGHT_FIELD_KEYS[tag]) {
      for (const value of HOSTILE) {
        const line = `[${tag}] ${key}=${value}`;
        const got = canonicalPreflightLine(line);
        // `database=postgres` on the ACL tag is the one collision: `postgres` IS that field's single
        // pinned value, so it renders — and renders IDENTICALLY for every credential, which is the
        // permitted vocabulary overlap rather than a disclosure.
        if (got !== null) {
          assert.equal(got, line, `only an exact pinned value may render: ${line}`);
          assert.ok(tag === 'acl-preflight' && key === 'database' && value === 'postgres',
            `unexpected acceptance of a secret-shaped value: ${line}`);
        }
        checked += 1;
      }
    }
  }
  assert.ok(checked >= 900, `every declared field must be driven: ${checked}`);
});

test('C2B-M005-LRLS-L3-R3: a dot in a key is allowed only behind a published head', () => {
  // A KEY IS THE ONE TOKEN A DOT MAY STILL APPEAR IN, so its shape has to be an allowlist rather
  // than a character class. On shape alone a TWO-LABEL hostname passed — `example.com=true`
  // rendered. A four-label provider host was already refused by the single-dot rule, but relying on
  // how many labels a host happens to have is not a barrier; the head allowlist is.
  for (const bad of [
    '[m005-preflight] example.com=true',
    '[m005-preflight] db.internal=true',
    '[m005-preflight] postgres.abcdefghijklmnopqrst=1',
    '[m005-preflight] a.b=1',
  ]) {
    assert.equal(canonicalPreflightLine(bad), null, `must fail closed: ${bad}`);
  }
  // The three heads both children actually emit still render.
  for (const good of [
    '[acl-preflight] globalBase.tables=BUILTIN_RETAINED',
    '[m005-preflight] A.currentPosture=MET',
    '[m005-preflight] B.blockerSurvivesCurrentM005=NO',
  ]) {
    assert.equal(canonicalPreflightLine(good), good, `must render: ${good}`);
  }
  // A second dot is refused whatever the head.
  assert.equal(canonicalPreflightLine('[m005-preflight] globalBase.a.b=1'), null);
});

test('C2B-M005-LRLS-L3-R3: a keyword/value connection string cannot render, key by key', () => {
  // THE SHAPE GRAMMAR ALONE LET A WHOLE libpq DSN THROUGH: every token in
  // `host=… port=… dbname=… user=… password=…` is individually legal — lowercase codes, a count,
  // ordinary keys. A driver that echoes its conninfo would have had it rendered verbatim under the
  // child's own tag. The key denylist sits ON TOP of the shapes and refuses a key that NAMES a
  // credential or an endpoint, whatever its value.
  assert.equal(
    canonicalPreflightLine('[m005-preflight] host=localhost port=5432 dbname=app user=alice password=secret'),
    null,
  );
  for (const k of ['password', 'user', 'host', 'port', 'dbname', 'dsn', 'uri', 'url', 'token', 'secret', 'conninfo']) {
    assert.equal(canonicalPreflightLine(`[m005-preflight] ${k}=abc`), null, `key must be refused: ${k}`);
    assert.equal(canonicalPreflightLine(`[m005-preflight] ${k.toUpperCase()}=abc`), null, `case-insensitively: ${k}`);
  }
  // The children's own keys are unaffected — none of them names a credential.
  assert.equal(canonicalPreflightLine('[m005-preflight] database=EXPECTED'), '[m005-preflight] database=EXPECTED');
  assert.equal(canonicalPreflightLine('[m005-preflight] name=CONFIRM_SUPABASE_TARGET'),
    '[m005-preflight] name=CONFIRM_SUPABASE_TARGET');
});

test('C2B-M005-LRLS-L3-R3: a line of bare prose is not a diagnostic and does not render', () => {
  // RAW DRIVER TEXT WAS RENDERING. A line of lowercase words satisfied the value grammar word by
  // word, so `connection terminated unexpectedly` came out verbatim under the child's tag — exactly
  // the raw error text the contract forbids. A diagnostic line states a FIELD; prose is only ever a
  // tail following one.
  for (const prose of [
    '[m005-preflight] connection terminated unexpectedly',
    '[m005-preflight] password authentication failed for user',
    '[m005-preflight] terminating connection due to administrator command',
    '[m005-preflight] QUJD',
    '[m005-preflight] 1/2',
  ]) {
    assert.equal(canonicalPreflightLine(prose), null, `must not render: ${prose}`);
  }
  // THE ONE EXCEPTION, and it is bounded: a refusal is a label plus exactly one code.
  assert.equal(canonicalPreflightLine('[m005-preflight] REFUSED: m005_preflight_port_failed'),
    '[m005-preflight] REFUSED: m005_preflight_port_failed');
  assert.equal(canonicalPreflightLine('[m005-preflight] REFUSED: a b'), null, 'and only one code');
  assert.equal(canonicalPreflightLine('[m005-preflight] ACCEPTED: m005_x'), null, 'and only that label');
});

test('C2B-M005-LRLS-L3-R4: a dotted key renders only where its own tag declares it', () => {
  // TWO WEAKER FORMS LEAKED BEFORE THIS ONE. Shape alone admitted `example.com`; a head allowlist
  // plus a public-suffix TAIL check still admitted `A.xyz`, `A.internal`, `B.local` and
  // `globalBase.corp` — a fourteen-entry suffix denylist cannot bound the open set of hostnames.
  // The declared key set is closed, so membership decides, and it is now decided PER TAG.
  for (const host of ['A.com', 'B.io', 'globalBase.net', 'A.www', 'B.co', 'A.dev',
    'A.xyz', 'A.internal', 'B.local', 'globalBase.corp', 'example.com', 'A.password']) {
    assert.equal(canonicalPreflightLine(`[m005-preflight] ${host}=true`), null, `must fail closed: ${host}`);
    assert.equal(canonicalPreflightLine(`[acl-preflight] ${host}=true`), null, `must fail closed: ${host}`);
  }
  // Each real dotted key, on its OWN tag, with a value from its OWN domain.
  const real = [
    ['m005-preflight', 'A.currentPosture', 'MET'],
    ['m005-preflight', 'B.blockerSurvivesCurrentM005', 'YES'],
    ['acl-preflight', 'globalBase.tables', 'BUILTIN_RETAINED'],
    ['acl-preflight', 'globalBase.sequences', 'GLOBAL_OVERRIDE'],
    ['acl-preflight', 'globalBase.functions', 'UNREADABLE'],
    ['acl-preflight', 'A.currentDefaultAclPostcondition', 'MET'],
    ['acl-preflight', 'B.blockerSurvivesCurrentM005', 'NO'],
  ];
  for (const [tag, key, value] of real) {
    assert.equal(canonicalPreflightLine(`[${tag}] ${key}=${value}`), `[${tag}] ${key}=${value}`,
      `must render: ${tag} ${key}`);
  }
  // AND A VALUE FROM THE WRONG DOMAIN IS REFUSED even on the right key and the right tag.
  assert.equal(canonicalPreflightLine('[m005-preflight] B.blockerSurvivesCurrentM005=MET'), null);
  assert.equal(canonicalPreflightLine('[acl-preflight] globalBase.tables=MET'), null);
});

test('C2B-M005-LRLS-L3-R3: the transcript accounting conserves every non-empty line', () => {
  // THE CONTRACT, AS A PROPERTY RATHER THAN AS EXAMPLES.
  //   rendered + stdoutUnparsable + stderrUnparsable + overCap === non-empty input lines
  // A line that is neither rendered nor counted is evidence that vanished without a trace, and a
  // line counted twice inflates the loss. Example-based tests cannot cover that: they check the
  // cases the author thought of, and this is the class where the missed case is the point.
  //
  // `truncated` is asserted as an IFF against overCap, not merely as a flag, because its whole
  // purpose is to tell an operator whether evidence — not junk — was dropped for the ceiling.
  const POOL = [
    '[m005-preflight] governedSource=MATCH',
    '[m005-preflight] objects tables=6/6 columns=13/13',
    '[m005-preflight] REFUSED: m005_preflight_x',
    'junk', 'Error: connect ECONNREFUSED 203.0.113.7:5432', '   ', 'a b c',
    '[bad-tag] k=1', '[m005-preflight] password=x',
  ];
  const noticeOf = (out) => {
    const m = /stdoutUnparsable=(\d+) stderrUnparsable=(\d+) overCap=(\d+) truncated=(true|false)$/
      .exec(out[out.length - 1]);
    assert.notEqual(m, null, `the notice must always be last and well formed: ${out[out.length - 1]}`);
    return { so: Number(m[1]), se: Number(m[2]), cap: Number(m[3]), trunc: m[4] === 'true' };
  };
  // Deterministic pseudo-random walk — a fixed seed, so a failure is reproducible.
  let seed = 20260909;
  const next = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  for (let t = 0; t < 600; t += 1) {
    const pick = (n) => Array.from({ length: n }, () => POOL[next(POOL.length)]);
    const so = pick(next(12)).join('\n') + (next(2) === 0 ? '\n' : '');
    const se = pick(next(12)).join('\r\n');
    const out = renderPreflightTranscript(so, se, true);
    const n = noticeOf(out);
    const rendered = out.length - 1;
    const nonEmpty = [...so.split(/\r?\n/), ...se.split(/\r?\n/)].filter((l) => l !== '').length;
    assert.equal(rendered + n.so + n.se + n.cap, nonEmpty,
      `conservation broken for ${JSON.stringify({ so, se })}`);
    assert.ok(rendered <= MAX_TRANSCRIPT_LINES, `ceiling exceeded: ${rendered}`);
    assert.equal(n.trunc, n.cap > 0, 'truncated must hold exactly when a renderable line was dropped');
    assert.equal(out.filter((l) => l.startsWith(TRANSCRIPT_DISCARDED_TOKEN)).length, 1, 'exactly one notice');
  }
  // THE CEILING BOUNDARY, EXACTLY: MAX renders with no spill; MAX+1 spills exactly one.
  const valid = '[m005-preflight] governedSource=MATCH';
  for (const [k, expectCap] of [[MAX_TRANSCRIPT_LINES - 1, 0], [MAX_TRANSCRIPT_LINES, 0], [MAX_TRANSCRIPT_LINES + 1, 1]]) {
    const out = renderPreflightTranscript(Array.from({ length: k }, () => valid).join('\n'), '', true);
    assert.equal(out.length - 1, Math.min(k, MAX_TRANSCRIPT_LINES), `rendered count at k=${k}`);
    assert.equal(noticeOf(out).cap, expectCap, `overCap at k=${k}`);
  }
  // A NON-STRING STREAM IS AN ABSENT CAPTURE, NOT AN EMPTY ONE, and it gets its OWN token.
  // Coercing it to '' produced the all-zero notice, which reads as "the child was silent" — the
  // call site fetches through `capture?.streamText?.(…)`, so a capture missing that API would have
  // reported a confident, well-formed, wrong zero.
  for (const v of [undefined, null, 42, {}, []]) {
    assert.deepEqual(renderPreflightTranscript(v, v, true), [TRANSCRIPT_STREAMS_UNREADABLE_TOKEN],
      `a non-string stream must fail closed: ${String(v)}`);
    assert.deepEqual(renderPreflightTranscript('', v, true), [TRANSCRIPT_STREAMS_UNREADABLE_TOKEN],
      `either stream alone is enough: ${String(v)}`);
  }
  // AND THE GENUINELY EMPTY CASE KEEPS THE ALL-ZERO NOTICE, so the two are distinguishable.
  assert.deepEqual(renderPreflightTranscript('', '', true),
    [`${TRANSCRIPT_DISCARDED_TOKEN} stdoutUnparsable=0 stderrUnparsable=0 overCap=0 truncated=false`]);
  assert.notEqual(TRANSCRIPT_STREAMS_UNREADABLE_TOKEN, TRANSCRIPT_UNAVAILABLE_TOKEN);
  // THE GATE PATH IS THE ONE PLACE CONSERVATION DOES NOT APPLY, deliberately: an unproved closure
  // states nothing at all about the input, not even how much of it there was.
  for (const gate of [false, undefined, null, 'true', 1, 0]) {
    assert.deepEqual(renderPreflightTranscript(valid, valid, gate), [TRANSCRIPT_UNAVAILABLE_TOKEN],
      `the gate must withhold everything for ${String(gate)}`);
  }
});

test('C2B-M005-LRLS-L3-R4: the credential denylist is not bypassed by a dotted key', () => {
  // THE HOLE IN THE LAYER THAT COVERED THE RESIDUAL. The denylist tested the WHOLE key, so every
  // published dotted head was a bypass: `password=hunter2` was refused while `A.password=hunter2`
  // rendered. It is kept as defence in depth even though an undeclared key is now refused outright,
  // because it is the rule that stays correct if a future table ever declares such a key by mistake.
  for (const head of ['A', 'B', 'globalBase']) {
    for (const k of ['password', 'user', 'host', 'token', 'dsn', 'secret', 'uri']) {
      for (const tag of PREFLIGHT_TRANSCRIPT_TAGS) {
        assert.equal(canonicalPreflightLine(`[${tag}] ${head}.${k}=abc`), null, `dotted bypass: ${head}.${k}`);
        assert.equal(canonicalPreflightLine(`[${tag}] ${head}.${k.toUpperCase()}=abc`), null,
          `and case-insensitively: ${head}.${k}`);
      }
    }
  }
  // THE DENYLIST IS REACHED BEFORE THE TABLE LOOKUP, so it is not vacuous: a credential-named key
  // is refused even when this test pretends the table declares it.
  assert.ok(PREFLIGHT_FIELD_KEYS['m005-preflight'].every((k) => !/password|secret|token|dsn/i.test(k)),
    'no declared key may name a credential');
});

test('C2B-M005-LRLS-L3-R4: every ceiling is pinned at its own boundary, per key', () => {
  // THE CEILINGS ARE NO LONGER SHARED. A single 64-character enum ceiling applied to every field
  // alike; each key now carries its own bound, so a widening has to be made key by key and each is
  // pinned on both sides. Two of these were RAISED after they silently discarded real evidence.
  // A count bounded by the child's own limit.
  assert.equal(canonicalPreflightLine('[m005-preflight] total=50'), '[m005-preflight] total=50');
  assert.equal(canonicalPreflightLine('[m005-preflight] total=51'), null, 'one past the policy limit');
  assert.equal(canonicalPreflightLine('[m005-preflight] presentlyReachableRoles=200'),
    '[m005-preflight] presentlyReachableRoles=200');
  assert.equal(canonicalPreflightLine('[m005-preflight] presentlyReachableRoles=201'), null, 'one past the role limit');
  // A live catalog count has no semantic ceiling, so the format bound is the one that applies.
  assert.equal(canonicalPreflightLine('[m005-preflight] incompatibleRows=999999999999'),
    '[m005-preflight] incompatibleRows=999999999999');
  assert.equal(canonicalPreflightLine('[m005-preflight] incompatibleRows=1000000000000'), null, 'thirteen digits');
  // The ONE count that is an arithmetic difference may legitimately be negative; no other may.
  assert.equal(canonicalPreflightLine('[m005-preflight] foreignOnGovernedTables=-1'),
    '[m005-preflight] foreignOnGovernedTables=-1');
  assert.equal(canonicalPreflightLine('[m005-preflight] total=-1'), null, 'no other count may be negative');
  // And the widest value the children publish still renders, from its own key's set.
  const widest = 'A_MET_IS_NOT_REQUIRED_MIGRATION_005_CHANGES_THE_POSTURE';
  assert.equal(canonicalPreflightLine(`[m005-preflight] aclNote=${widest}`),
    `[m005-preflight] aclNote=${widest}`);
  assert.equal(widest.length, 55, 'the widest published value');
  // A 49-character KEY is real and must still be declared, not merely shape-legal.
  assert.ok(PREFLIGHT_FIELD_KEYS['m005-preflight'].includes('reachabilityIncludesDatabaseConnectAndSchemaUsage'));
});

test('C2B-M005-LRLS-L4: a stderr line is RE-RENDERED, not echoed, on the one path that could echo it', () => {
  // R4-M7 SURVIVED THE FIRST SWEEP and this is why it now dies. Forwarding stderr raw is invisible
  // for a line the grammar would reject — that line is discarded either way — and invisible for a
  // line whose canonical form equals its input. It is visible only where canonicalisation
  // NORMALISES, so the fixture is chosen to normalise: a leading-zero count.
  const rendered = renderPreflightTranscript('', '[m005-preflight] objects tables=002/6', true);
  assert.ok(rendered.some((l) => l.includes('tables=2/6')), 'the count is re-rendered from its parse');
  assert.ok(!rendered.some((l) => l.includes('tables=002/6')), 'the child\'s own bytes are not echoed');
  // And the same holds on stdout, so neither stream is the special case.
  const onStdout = renderPreflightTranscript('[m005-preflight] objects tables=002/6', '', true);
  assert.ok(onStdout.some((l) => l.includes('tables=2/6')));
  assert.ok(!onStdout.some((l) => l.includes('tables=002/6')));
});

test('C2B-M005-LRLS-L4: an overflowed capture is unreadable even after it is sealed', () => {
  // R4-M23 SURVIVED THE FIRST SWEEP. Overflow means the capture exceeded the aggregate ceiling and
  // must be discarded UNREAD; the seal proves closure, which is a different fact. A guard that
  // tested only the seal would hand back a partial buffer whose contents nobody bounded.
  const cap = createCapture(64);
  // Staged BELOW the ceiling first, so something is actually buffered before the overflow lands —
  // a fixture that overflows on its first push never buffers anything and passes for free.
  cap.push(Buffer.from('[m005-preflight] governedSource=MATCH\n', 'utf8'), 'stdout');
  assert.equal(cap.overflowed, false, 'the fixture must buffer before it overflows');
  cap.push(Buffer.from('x'.repeat(200), 'utf8'), 'stderr');
  assert.equal(cap.overflowed, true);
  cap.seal();
  assert.equal(cap.streamText('stdout'), '', 'an overflowed capture yields nothing, sealed or not');
  assert.equal(cap.streamText('stderr'), '');
  assert.equal(cap.text(), '');
  // And the renderer reports the withheld state rather than an all-zero notice.
  const rendered = renderPreflightTranscript(cap.streamText('stdout'), cap.streamText('stderr'), true);
  assert.ok(!rendered.some((l) => l.includes('governedSource')), 'no buffered line may survive overflow');
});

// =============================================================================
// C2B-M005-LRLS-L3-R4-R1 — MIGRATION TERMINAL-EVIDENCE CLOSURE
//
// L3-R4 closed the realtime-signal channel for the two PREFLIGHT launchers and left it OPEN here:
// the migration child's terminal record is LABELLED (`[migrate] <op> teardown: …`), and the
// unlabelled `[migrate] outcome=` matcher could never reach it. `terminalVocabulary.migrate` was an
// empty array, so the positive gate did not merely run weakly — it could not fire at all.
//
// PROVENANCE, READ OUT OF THE FROZEN CHILD (scripts/supabase-migrate.ts, unchanged):
//   • `runThroughManagedExecutor` emits this line INSIDE its `finally`, on the statement after
//     `await handle.dispose()` resolves — the first write after the cleanup boundary.
//   • It is guarded by `handle !== null`, so it appears exactly once on every path where a client
//     was created, which includes every success path.
//   • It goes to STDOUT. The only writes that can follow it are `REFUSED:` and `FATAL:`, both on
//     STDERR — so nothing may follow it on stdout, and the record must be the final stdout line.
//   • Both launchers pass `--managed-dev`, so both drive this function: the m005 launcher with op
//     `apply(up)` and the baseline launcher with op `baseline`.
// =============================================================================

/** A capture whose stdout and stderr are supplied verbatim, sealed unless told otherwise. */
const captured = (stdout, stderr = '', over = {}) => ({
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
//
// This launcher's child argv is `--managed-dev --apply`, so both records name `apply(up)`.
// =============================================================================

const TEARDOWN_OK = MIGRATE_TEARDOWN_OK;
const TERMINAL_OK = MIGRATE_POST_DECISION_OK;
/** Both records, in the order the child writes them: the complete evidence of a clean run. */
const PAIR_OK = MIGRATE_TERMINAL_OK;
const TEARDOWN_FAILED =
  '[migrate] apply(up) teardown: requested=true completed=false gracefulSocketClose=not_observed code=client_teardown_failed';
const TERMINAL_REFUSED =
  '[migrate] apply(up) terminal: decision=refused cleanup=completed exit=failure code=none';
const TERMINAL_REFUSED_UNCLEAN =
  '[migrate] apply(up) terminal: decision=refused cleanup=failed exit=failure code=client_teardown_failed';
const TERMINAL_THREW =
  '[migrate] apply(up) terminal: decision=failed cleanup=completed exit=failure code=none';
const TERMINAL_NO_CLIENT =
  '[migrate] apply(up) terminal: decision=failed cleanup=not_attempted exit=failure code=none';
const PRE_CLEANUP = '[migrate] apply(up): outcome=complete finalized=1 disposal=closed code=none';

const evidence = (stdout, stderr = '') => terminalEvidenceFor(evidenced({ capture: captured(stdout, stderr) }));

test('R4-R2/§4: an OK result requires the PAIR — the teardown record alone no longer suffices', () => {
  // 1. CLEAN COMPLETION: one valid cleanup record and one valid post-decision record, last.
  const clean = evidence([PRE_CLEANUP, PAIR_OK].join('\n'));
  assert.equal(clean.ok, true);
  assert.equal(clean.reason, 'complete');
  assert.equal(clean.code, 'terminal_completed');

  // THE R4-R1 RESIDUAL, CLOSED. This is exactly what a child destroyed between its teardown record
  // and its refusal leaves behind, and R4-R1 read it as proof of completion.
  const teardownOnly = evidence([PRE_CLEANUP, TEARDOWN_OK].join('\n'));
  assert.equal(teardownOnly.ok, false, 'the cleanup record alone must not establish completion');
  assert.equal(teardownOnly.reason, 'missing');

  // AND THE CONVERSE. A post-decision record with no cleanup record behind it is not a clean run
  // either: the success tuple pins the teardown it must stand beside, and there is none.
  assert.equal(evidence(TERMINAL_OK).reason, 'cleanup_mismatch');

  // 2. MISSING · 3. DUPLICATED · 4. NOT FINAL (canonical AND unparsable trailing output)
  assert.equal(evidence(PRE_CLEANUP).reason, 'missing');
  assert.equal(evidence('').reason, 'missing');
  assert.equal(evidence([TEARDOWN_OK, TERMINAL_OK, TERMINAL_OK].join('\n')).reason, 'duplicated');
  assert.equal(evidence([TEARDOWN_OK, TEARDOWN_OK, TERMINAL_OK].join('\n')).reason, 'duplicated');
  assert.equal(evidence([PAIR_OK, PRE_CLEANUP].join('\n')).reason, 'not_final');
  assert.equal(evidence([PAIR_OK, '!! partial garbage'].join('\n')).reason, 'not_final');
  assert.equal(evidence([PAIR_OK, TEARDOWN_OK].join('\n')).reason, 'not_final');

  // 5. WRONG LABEL / WRONG FIELD ORDER · 6. UNKNOWN VALUE · 8. TRUNCATED — on the record that decides
  assert.equal(evidence([TEARDOWN_OK, TERMINAL_OK.replace(' terminal:', ' evidence:')].join('\n')).reason, 'missing');
  assert.equal(
    evidence([TEARDOWN_OK, '[migrate] apply(up) terminal: cleanup=completed decision=success exit=success code=none'].join('\n')).reason,
    'malformed',
  );
  assert.equal(
    evidence([TEARDOWN_OK, '[migrate] apply(up) terminal: decision=maybe cleanup=completed exit=success code=none'].join('\n')).reason,
    'missing',
  );
  assert.equal(evidence([TEARDOWN_OK, '[migrate] apply(up) terminal: decision=success clea'].join('\n')).reason, 'missing');

  // CONTRADICTORY WHOLE RECORDS. Every field canonicalises against its own domain, so a success
  // decision beside a failure exit class passes the grammar while asserting two incompatible things.
  for (const bad of [
    '[migrate] apply(up) terminal: decision=success cleanup=completed exit=failure code=none',
    '[migrate] apply(up) terminal: decision=failed cleanup=completed exit=success code=none',
    '[migrate] apply(up) terminal: decision=success cleanup=failed exit=success code=client_teardown_failed',
    '[migrate] apply(up) terminal: decision=success cleanup=completed exit=success code=checksum_mismatch',
  ]) assert.equal(evidence([TEARDOWN_OK, bad].join('\n')).reason, 'contradictory', bad);

  // CONTRADICTORY PAIR. Each record is individually well-formed and they disagree about one
  // teardown — the failure a per-record check cannot see and a pair check cannot miss.
  assert.equal(evidence([TEARDOWN_FAILED, TERMINAL_OK].join('\n')).reason, 'cleanup_mismatch');
  assert.equal(evidence([TEARDOWN_OK, TERMINAL_REFUSED_UNCLEAN].join('\n')).reason, 'cleanup_mismatch');
  assert.equal(evidence([TEARDOWN_OK, TERMINAL_NO_CLIENT].join('\n')).reason, 'cleanup_mismatch');
  // A teardown tuple the child cannot emit fails the pair too, without a second table to say so.
  assert.equal(
    evidence([
      '[migrate] apply(up) teardown: requested=true completed=true gracefulSocketClose=not_observed code=checksum_mismatch',
      TERMINAL_OK,
    ].join('\n')).reason,
    'cleanup_mismatch',
  );
  // A DUPLICATED cleanup record is refused as itself, not silently treated as absent.
  assert.equal(evidence([TEARDOWN_OK, TEARDOWN_OK, TERMINAL_NO_CLIENT].join('\n')).reason, 'duplicated');

  // GENUINE ADVERSE RECORDS: present, valid, consistent — and still not OK.
  for (const [name, stdout, reason, code] of [
    ['refusal', [TEARDOWN_OK, TERMINAL_REFUSED].join('\n'), 'child_refused', null],
    ['refusal + failed teardown', [TEARDOWN_FAILED, TERMINAL_REFUSED_UNCLEAN].join('\n'), 'child_refused', 'client_teardown_failed'],
    ['thrown failure', [TEARDOWN_OK, TERMINAL_THREW].join('\n'), 'child_failed', null],
    ['thrown failure + failed teardown', [TEARDOWN_FAILED, '[migrate] apply(up) terminal: decision=failed cleanup=failed exit=failure code=client_teardown_failed'].join('\n'), 'child_failed', 'client_teardown_failed'],
    ['throw before the client existed', TERMINAL_NO_CLIENT, 'child_failed', null],
  ]) {
    const r = evidence(stdout);
    assert.equal(r.ok, false, `${name}: never OK`);
    assert.equal(r.reason, reason, name);
    assert.equal(r.code, code, name);
  }
});

test('R4-R2/§4: the capture must be SEALED before the record is read', () => {
  const sealed = evidenced({ capture: captured(PAIR_OK) });
  assert.equal(terminalEvidenceFor(sealed).ok, true);
  // The same bytes, with closure unproved, establish nothing: output may still be in flight, so the
  // record cannot yet be known to be the last one.
  assert.equal(terminalEvidenceFor({ ...sealed, streamsClosed: false }).reason, 'streams_not_proved_closed');
  assert.equal(terminalEvidenceFor({ ...sealed, streamsClosed: undefined }).reason, 'streams_not_proved_closed');
  // An unreadable capture is named as such rather than silently treated as empty.
  assert.equal(terminalEvidenceFor({ ...sealed, capture: {} }).reason, 'stream_text_unavailable');
  assert.equal(terminalEvidenceFor(undefined).reason, 'streams_not_proved_closed');
});

test('R4-R2/§5.11: an OVERFLOWED capture never reaches the terminal check as a pass', () => {
  // The bytes the record would have been read from were DISCARDED UNREAD, so there is nothing to
  // read. `outcomeCode` returns the overflow code first, and the disposition keeps it — the run is
  // refused for the reason that is actually true rather than for a missing record.
  const over = evidenced({ capture: captured(PAIR_OK, '', { overflowed: true }) });
  const d = dispositionFor(over);
  assert.equal(d.code, LAUNCHER_CODES.OUTPUT_LIMIT_EXCEEDED);
  assert.equal(d.exitCode, 2, 'and it is never a success');
});

test('R4-R2/§4: a successful terminal token can never RESCUE an adverse disposition', () => {
  // The record is allowed to DOWNGRADE a disposition and never to upgrade one: a child that wrote a
  // perfect pair and then left a residual process group, or exited non-zero, or was signalled, is
  // not rescued by the records it managed to write.
  for (const [name, over] of [
    ['nonzero exit', { exitCode: 1 }],
    ['signalled', { signal: 'SIGKILL', exitCode: null }],
    ['residual group', { group: groupOrphan(), status: 'group_residual' }],
    ['lost observation', { group: groupUnavailable(), observationLost: true }],
    ['containment hold', { containmentHold: true }],
  ]) {
    const result = evidenced({ capture: captured(PAIR_OK), ...over });
    assert.equal(terminalEvidenceFor(result).ok, true, `${name}: the record itself is valid`);
    const d = dispositionFor(result);
    assert.notEqual(d.code, LAUNCHER_CODES.OK, `${name}: and yet the run is not OK`);
    assert.equal(d.exitCode, 2, `${name}: and never exits 0`);
  }
  // A FAILURE RECORD PAIRED WITH EXIT ZERO. The child says it refused; the process exited 0 anyway.
  // Only the record can see that, and it must refuse rather than believe the exit code.
  for (const adverse of [TERMINAL_REFUSED, TERMINAL_THREW]) {
    const r = evidenced({ capture: captured([TEARDOWN_OK, adverse].join('\n')), exitCode: 0, signal: null });
    const d = dispositionFor(r);
    assert.equal(d.code, M005_CODES.TERMINAL_EVIDENCE_INCOMPLETE, adverse);
    assert.equal(d.exitCode, 2, adverse);
  }
});

test('R4-R2/§4: the printed record and the exit code state ONE disposition, not two', () => {
  // A run that PRINTS `terminal_evidence_incomplete` and exits 0 is worse than either alone, because
  // a human reads the record and a CI step reads the status. Both now come from one call.
  const noEvidence = evidenced({ capture: captured(TEARDOWN_OK) });
  const d = dispositionFor(noEvidence);
  assert.equal(d.code, M005_CODES.TERMINAL_EVIDENCE_INCOMPLETE);
  assert.equal(d.exitCode, 2);
  const text = renderM005Report(noEvidence, d).join('\n');
  assert.ok(text.includes(`outcome=${M005_CODES.TERMINAL_EVIDENCE_INCOMPLETE}`), 'the record names it');
  assert.ok(text.includes('terminalEvidence=incomplete reason=missing'), 'and states the cause');
  assert.ok(!text.includes(`outcome=${M005_CODES.OK}`));

  // NON-VACUITY: the favourable disposition really is reachable.
  const good = evidenced({ capture: captured([PRE_CLEANUP, PAIR_OK].join('\n')) });
  const gd = dispositionFor(good);
  assert.equal(gd.code, LAUNCHER_CODES.OK);
  assert.equal(gd.exitCode, 0);
  assert.ok(renderM005Report(good, gd).join('\n').includes(`outcome=${M005_CODES.OK}`));

  // AND THE RECORD IS DERIVED FROM THE SAME CALL for every shape, so they cannot disagree.
  for (const stdout of [
    '', PRE_CLEANUP, TEARDOWN_OK, TERMINAL_OK, PAIR_OK,
    [TEARDOWN_OK, TERMINAL_OK, TERMINAL_OK].join('\n'),
    [TEARDOWN_FAILED, TERMINAL_REFUSED_UNCLEAN].join('\n'),
  ]) {
    const r = evidenced({ capture: captured(stdout) });
    const dd = dispositionFor(r);
    const rendered = renderM005Report(r, dd).join('\n');
    const shown = dd.code === LAUNCHER_CODES.OK ? M005_CODES.OK : dd.code;
    assert.ok(rendered.includes(`outcome=${shown}`), `record must name the disposition for ${JSON.stringify(stdout)}`);
    assert.equal(dd.exitCode === 0, dd.code === LAUNCHER_CODES.OK, 'exit 0 iff the disposition is OK');
  }
});

test('R4-R2/§5.16: no raw migration message, error or driver text escapes the record', () => {
  // The child's `REFUSED:`, `ERROR:` and `FATAL:` lines interpolate raw strings in a FROZEN path.
  // Nothing obliges this launcher to repeat them, and it does not: they fail the grammar and are
  // counted as discards. The record pair is unaffected by them.
  const hostile = [
    PRE_CLEANUP,
    '[migrate] REFUSED: postgres://user:hunter2@db.example.com:5432/postgres',
    '[migrate] FATAL: Error: connect ECONNREFUSED 10.0.0.1:5432',
    TEARDOWN_OK,
    TERMINAL_OK,
  ].join('\n');
  const stderrText = 'raw stderr: SUPERSECRET_HUNTER2';
  const r = evidenced({ capture: captured(hostile, stderrText) });
  assert.equal(terminalEvidenceFor(r).ok, true, 'the record still stands among discarded lines');
  // BOTH SURFACES. `renderM005Report` emits a SENTINEL where the child transcript goes, so a test
  // that read only the report would not be looking at the child text at all.
  const transcript = renderM005MigrateTranscript(hostile, stderrText, true).join('\n');
  const text = `${renderM005Report(r, dispositionFor(r)).join('\n')}\n${transcript}`;
  for (const leak of ['hunter2', 'SUPERSECRET_HUNTER2', 'ECONNREFUSED', '10.0.0.1', 'db.example.com', 'user:']) {
    assert.ok(!text.includes(leak), `raw child text must not reach the record: ${leak}`);
  }
  assert.ok(transcript.includes(TRANSCRIPT_DISCARDED_TOKEN),
    'the unrenderable lines are counted, not dropped silently');
  // AND THE LINES THAT DO SURVIVE ARE THE CANONICAL ONES, re-rendered from constants.
  assert.ok(transcript.includes(TERMINAL_OK), 'the post-decision record itself is reported');
  assert.ok(transcript.includes(TEARDOWN_OK), 'and so is the cleanup record it stands on');
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
    ['1 before teardown', say(PRE_CLEANUP), 'missing'],
    ['2 during cleanup', say(PRE_CLEANUP) + partial(TEARDOWN_OK), 'missing'],
    ['3 after teardown, before the decision', say(PRE_CLEANUP) + say(TEARDOWN_OK), 'missing'],
    ['4 after the decision, before the record',
      say(PRE_CLEANUP) + say(TEARDOWN_OK) + cry('[migrate] REFUSED: apply(up) refused before completion: checksum_mismatch.'),
      'missing'],
    ['5 after a non-final record', say(PRE_CLEANUP) + say(TEARDOWN_OK) + say(TERMINAL_OK) + say(PRE_CLEANUP), 'not_final'],
    ['5b after a FORGED record with no cleanup behind it', say(TERMINAL_OK), 'cleanup_mismatch'],
  ];

  for (const signal of [34, 40, 64]) {
    for (const [name, script, reason] of WINDOWS) {
      const killed = await run(`${script}process.kill(process.pid,${signal});`);
      // THE HAZARD, MEASURED RATHER THAN ASSUMED: the kernel destroyed this child and Node reports
      // a clean zero exit with no signal, byte-identical to a success.
      assert.equal(killed.exitCode, 0, `${name}: signal ${signal} must arrive as exit 0`);
      assert.equal(killed.signal ?? null, null, `${name}: signal ${signal} must arrive as no signal at all`);
      assert.equal(terminalEvidenceFor(killed).reason, reason, `${name} @ ${signal}`);
      const d = dispositionFor(killed);
      assert.equal(d.code, M005_CODES.TERMINAL_EVIDENCE_INCOMPLETE, `${name} @ ${signal}: must not reach OK`);
      assert.equal(d.exitCode, 2, `${name} @ ${signal}`);
    }

    // WINDOW 6 — the signal arrives after the genuine final record. It may remain OK, and only
    // because the child's source ordering (pinned in the baseline suite, over the same frozen file)
    // proves there was nothing left to do: cleanup completed, the decision and exit class fixed, the
    // record written, and no semantic action or output remaining.
    const after = await run(say(PRE_CLEANUP) + say(PAIR_OK) + `process.kill(process.pid,${signal});`);
    assert.equal(after.exitCode, 0);
    assert.equal(terminalEvidenceFor(after).ok, true, `window 6 @ ${signal}`);
    assert.equal(dispositionFor(after).exitCode, 0, `window 6 @ ${signal}: nothing was left unfinished`);
  }

  // §5.1 — THE CONTROL. The same machinery must ACCEPT a child that completes, or every assertion
  // above would pass merely because nothing can ever reach OK.
  const clean = await run(say(PRE_CLEANUP) + say(PAIR_OK));
  assert.equal(clean.exitCode, 0);
  assert.equal(terminalEvidenceFor(clean).ok, true, 'a child that completes must establish completion');
  assert.equal(dispositionFor(clean).exitCode, 0);

  // §5.9 — THE RECORD SPLIT ACROSS WRITES. Pipe chunk boundaries are not line boundaries; a record
  // delivered in three writes is the same record and must be reassembled before it is matched.
  const split = await run(
    say(PRE_CLEANUP) + say(TEARDOWN_OK)
    + `process.stdout.write(${JSON.stringify(TERMINAL_OK.slice(0, 20))});`
    + `process.stdout.write(${JSON.stringify(TERMINAL_OK.slice(20, 55))});`
    + `process.stdout.write(${JSON.stringify(TERMINAL_OK.slice(55) + '\n')});`,
  );
  assert.equal(terminalEvidenceFor(split).ok, true, 'a chunk-split record is still one record');

  // §5.10 — NON-EMPTY UNEXPECTED STDERR. The records live on stdout, so stderr cannot supply them
  // and cannot destroy them; what stderr must never do is reach the operator's record raw.
  const noisy = await run(say(PRE_CLEANUP) + say(PAIR_OK) + cry('[migrate] REFUSED: postgres://u:hunter2@h/postgres'));
  assert.equal(terminalEvidenceFor(noisy).ok, true, 'stderr does not carry the terminal record');
  assert.ok(!renderM005Report(noisy, dispositionFor(noisy)).join('\n').includes('hunter2'),
    'and its raw text never reaches the record');
});

test('R4-R2/§5: controlled success, refusal, teardown failure, throw, missing and contradiction', async () => {
  const run = (script) => runChild({
    command: process.execPath,
    args: ['-e', script],
    env: { PATH: process.env.PATH ?? '' },
    limit: 65536,
    timeoutMs: 20000,
  });
  const emit = (lines, exit) =>
    `${lines.map((l) => `console.log(${JSON.stringify(l)});`).join('')}process.exitCode=${exit};`;

  for (const [name, lines, exit, ok, reason] of [
    ['controlled success', [PRE_CLEANUP, TEARDOWN_OK, TERMINAL_OK], 0, true, 'complete'],
    ['controlled refusal', [TEARDOWN_OK, TERMINAL_REFUSED], 2, false, 'child_refused'],
    ['teardown failure', [TEARDOWN_FAILED, TERMINAL_REFUSED_UNCLEAN], 2, false, 'child_refused'],
    ['thrown failure', [TEARDOWN_OK, TERMINAL_THREW], 2, false, 'child_failed'],
    ['throw before the client existed', [TERMINAL_NO_CLIENT], 2, false, 'child_failed'],
    ['missing evidence', [PRE_CLEANUP], 0, false, 'missing'],
    ['contradictory evidence', [TEARDOWN_FAILED, TERMINAL_OK], 0, false, 'cleanup_mismatch'],
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

test('R4-R2/§5.18: the command, environment and containment boundaries are unchanged', async () => {
  // The output-boundary work must not have loosened anything upstream of it. Re-asserted here
  // rather than assumed from the fact that the older tests still pass.
  let seen = null;
  const d = deps({
    spawn: (command, args, options) => { seen = { command, args: [...args], options }; return completingChild(); },
  });
  assert.equal(await main([PARENT_FLAG], SYNTH, d.deps), 0);
  assert.equal(seen.command, NODE_BIN);
  assert.deepEqual(seen.args, [TSX_CLI, MIGRATE_SCRIPT, ...M005_FLAGS]);
  assert.equal(seen.options.shell, false);
  assert.equal(seen.options.detached, true);
  assert.equal(seen.options.cwd, REPO_ROOT);
  assert.deepEqual(seen.options.stdio, ['ignore', 'pipe', 'pipe']);
  assert.deepEqual(Object.keys(seen.options.env).sort(), [...CHILD_ENV_KEYS].sort());
  // The tag this launcher requires is the migration child's, not a preflight tag.
  assert.equal(MIGRATE_TAG, 'migrate');
});

test('R4-R2/§5.17: the PREFLIGHT terminal-evidence contract is unchanged by the labelled matcher', () => {
  // The preflight children emit an UNLABELLED record — `[tag] outcome=<code>` — and their launchers
  // declare no labelled table at all. Neither the pair rule nor the new record touches them.
  const OK_CODE = 'm005_preflight_observed_preconditions_met';
  const rec = `[m005-preflight] outcome=${OK_CODE}`;
  const other = '[m005-preflight] governedSource=MATCH';

  const complete = terminalCompletion([other, rec].join('\n'), 'm005-preflight', true);
  assert.equal(complete.ok, true);
  assert.equal(complete.code, OK_CODE);
  assert.equal(terminalCompletion(other, 'm005-preflight', true).reason, 'missing');
  assert.equal(terminalCompletion([rec, rec].join('\n'), 'm005-preflight', true).reason, 'duplicated');
  assert.equal(terminalCompletion([rec, other].join('\n'), 'm005-preflight', true).reason, 'not_final');
  assert.equal(terminalCompletion(rec, 'm005-preflight', false).reason, 'streams_not_proved_closed');
  assert.equal(terminalCompletion(undefined, 'm005-preflight', true).reason, 'stream_text_unavailable');
  assert.equal(terminalCompletion(rec, 'migrate', true).reason, 'unknown_tag',
    'the unlabelled matcher still knows nothing about the migration tag');
  assert.deepEqual([...PREFLIGHT_TAGS].sort(), ['acl-preflight', 'm005-preflight'],
    'the tag set, not its declaration order — reordering the frozen array changes no behaviour');

  // THE ASYMMETRY, RECORDED RATHER THAN SILENTLY INTRODUCED. The unlabelled matcher counts position
  // over CANONICAL lines only, so unparsable output after a preflight terminal record does NOT
  // displace it. The labelled matcher counts every NON-EMPTY line and does displace it. Changing the
  // unlabelled one would change preflight behaviour, which this stage is not authorized to do; the
  // difference is therefore measured and reported, not quietly left for someone to discover.
  assert.equal(terminalCompletion([rec, '!! partial garbage'].join('\n'), 'm005-preflight', true).ok, true,
    'preflight: unparsable trailing output does not displace the record (unchanged behaviour)');
  const migrateAfter = evidenced({ capture: captured([PAIR_OK, '!! partial garbage'].join('\n')) });
  assert.equal(terminalEvidenceFor(migrateAfter).reason, 'not_final',
    'migrate: unparsable trailing output DOES displace the record (the stricter rule)');
  // AND THE PREFLIGHT RECORD IS STILL A SINGLE UNLABELLED LINE — it owes no pair and gains none.
  assert.equal(terminalCompletion(rec, 'm005-preflight', true).ok, true,
    'one preflight record, standing alone, still establishes preflight completion');
});

/** MIGRATE_SPEC declares the BASELINE operation, so a grammar built straight from it wants that pair. */
const SPEC_TEARDOWN_OK =
  '[migrate] baseline teardown: requested=true completed=true gracefulSocketClose=not_observed code=none';
const SPEC_POST_DECISION_OK =
  '[migrate] baseline terminal: decision=success cleanup=completed exit=success code=none';
const SPEC_TERMINAL_OK = `${SPEC_TEARDOWN_OK}\n${SPEC_POST_DECISION_OK}`;

test('R4-R2: TERMINAL_EVIDENCE_REASONS is TOTAL over what the matchers actually return', () => {
  // THE LIST MUST NOT DRIFT FROM THE MATCHERS. It is DERIVED from their real behaviour and required
  // to equal the declaration exactly — in BOTH directions, so a future reason cannot be added
  // without declaring it and a declared reason cannot rot into one nothing can produce. R4-R2
  // retired `teardown_failed` and added `cleanup_mismatch`, `child_refused` and `child_failed`;
  // this is what forces the declaration to keep up.
  const grammar = createTranscriptGrammar(MIGRATE_SPEC);
  const T = SPEC_TERMINAL_OK;
  const produced = new Set();

  // The LABELLED matcher, driven over every branch it has.
  for (const [stdout, closed, tag] of [
    [T, true, 'migrate'],                                              // complete
    [T, false, 'migrate'],                                             // streams_not_proved_closed
    [undefined, true, 'migrate'],                                      // stream_text_unavailable
    [T, true, 'm005-preflight'],                                       // unknown_tag
    ['[migrate] baseline: outcome=complete rows=0 disposal=closed code=none', true, 'migrate'], // missing
    [[SPEC_TEARDOWN_OK, SPEC_POST_DECISION_OK, SPEC_POST_DECISION_OK].join('\n'), true, 'migrate'], // duplicated
    [[T, 'trailing noise'].join('\n'), true, 'migrate'],               // not_final
    [[SPEC_TEARDOWN_OK, '[migrate] baseline terminal: cleanup=completed decision=success exit=success code=none'].join('\n'),
      true, 'migrate'],                                                // malformed
    [[SPEC_TEARDOWN_OK, '[migrate] baseline terminal: decision=success cleanup=completed exit=failure code=none'].join('\n'),
      true, 'migrate'],                                                // contradictory
    [SPEC_POST_DECISION_OK, true, 'migrate'],                          // cleanup_mismatch
    [[SPEC_TEARDOWN_OK, '[migrate] baseline terminal: decision=refused cleanup=completed exit=failure code=none'].join('\n'),
      true, 'migrate'],                                                // child_refused
    [[SPEC_TEARDOWN_OK, '[migrate] baseline terminal: decision=failed cleanup=completed exit=failure code=none'].join('\n'),
      true, 'migrate'],                                                // child_failed
  ]) produced.add(grammar.labelledTerminal(stdout, tag, closed).reason);

  // The UNLABELLED matcher, over every branch IT has.
  const rec = '[m005-preflight] outcome=m005_preflight_observed_preconditions_met';
  for (const [stdout, closed, tag] of [
    [rec, true, 'm005-preflight'],
    [rec, false, 'm005-preflight'],
    [undefined, true, 'm005-preflight'],
    [rec, true, 'migrate'],
    ['[m005-preflight] governedSource=MATCH', true, 'm005-preflight'],
    [[rec, rec].join('\n'), true, 'm005-preflight'],
    [[rec, '[m005-preflight] governedSource=MATCH'].join('\n'), true, 'm005-preflight'],
  ]) produced.add(terminalCompletion(stdout, tag, closed));
  // `terminalCompletion` returns the object, not the reason — normalise.
  const reasons = new Set([...produced].map((r) => (typeof r === 'string' ? r : r.reason)));

  assert.deepEqual([...reasons].sort(), [...TERMINAL_EVIDENCE_REASONS].sort(),
    'the declared reasons and the producible reasons must be the same set');
  assert.ok(!TERMINAL_EVIDENCE_REASONS.includes('teardown_failed'),
    'the retired reason must not linger as a declaration nothing can produce');

  // AND THE RENDERER REFUSES ANYTHING UNDECLARED, symmetrically in both launchers.
  for (const r of TERMINAL_EVIDENCE_REASONS) assert.equal(terminalReasonText(r), r);
  for (const bogus of ['', 'complete ', 'CoMpLeTe', 'postgres://u:p@h/db', undefined, null, 42]) {
    assert.equal(terminalReasonText(bogus), UNRECOGNIZED_TERMINAL_REASON, `undeclared reason: ${String(bogus)}`);
  }
});

test('R4-R2: a canonical record with the wrong FIELD COUNT is malformed, not truncated-to-fit', () => {
  // A record can canonicalise perfectly and still not be THIS record. Every field below is a
  // declared key with a value in its own domain, so the grammar admits the line — only the arity
  // check separates it from the real thing. Without it the short form throws on an absent field and
  // the long form is silently accepted by matching its first four.
  const short = '[migrate] apply(up) terminal: decision=success cleanup=completed exit=success';
  const long = `${TERMINAL_OK} rows=0`;
  assert.notEqual(canonicalMigrateLine(short), null, 'the short form really is canonical');
  assert.notEqual(canonicalMigrateLine(long), null, 'the long form really is canonical');
  assert.equal(evidence([TEARDOWN_OK, short].join('\n')).reason, 'malformed', 'too few fields');
  assert.equal(evidence([TEARDOWN_OK, long].join('\n')).reason, 'malformed', 'too many fields — extras are not ignored');
  // The SAME rule on the cleanup half of the pair, which is matched by the same helper.
  const shortCleanup = '[migrate] apply(up) teardown: requested=true completed=true gracefulSocketClose=not_observed';
  assert.notEqual(canonicalMigrateLine(shortCleanup), null);
  assert.equal(evidence([shortCleanup, TERMINAL_OK].join('\n')).reason, 'malformed');
});

test('R4-R2: an UNKNOWN tag refuses rather than establishing completion', () => {
  // Fail-closed on the table lookup itself: a launcher that declares no terminal record for a tag
  // must get a refusal, never a free pass.
  const grammar = createTranscriptGrammar(MIGRATE_SPEC);
  for (const tag of ['m005-preflight', 'acl-preflight', 'not-a-tag', '']) {
    const r = grammar.labelledTerminal(SPEC_TERMINAL_OK, tag, true);
    assert.equal(r.ok, false, `tag ${tag} must not establish completion`);
    assert.equal(r.reason, 'unknown_tag');
  }
  assert.equal(grammar.labelledTerminal(SPEC_TERMINAL_OK, 'migrate', true).ok, true, 'the real tag still works');
  // A table that declares no operation cannot identify either of its records.
  const opless = createTranscriptGrammar({
    ...MIGRATE_SPEC,
    labelledTerminal: Object.freeze({ migrate: Object.freeze({ ...MIGRATE_SPEC.labelledTerminal.migrate, op: '' }) }),
  });
  assert.equal(opless.labelledTerminal(SPEC_TERMINAL_OK, 'migrate', true).reason, 'unknown_tag');
});

test('R4-R2: main() END-TO-END refuses a cleanly-exiting child that wrote no post-decision record', async () => {
  // THE INTEGRATION CASE, and the one that matters most: a child that exits 0 with an empty process
  // group — every containment conjunct satisfied — and no complete evidence pair. That is exactly
  // the shape a realtime-signal kill produces. `main()` must return non-zero, and the record it
  // printed must say why.
  for (const [name, line, reason] of [
    ['no output at all', null, 'missing'],
    ['the teardown record alone', TEARDOWN_OK, 'missing'],
    ['a forged post-decision record with no cleanup behind it', TERMINAL_OK, 'cleanup_mismatch'],
  ]) {
    const d = deps({ spawn: () => completingChild(line) });
    assert.equal(await main([PARENT_FLAG], SYNTH, d.deps), 2, `${name}: no pair, no success`);
    const text = d.sink.join('\n');
    assert.ok(text.includes(`outcome=${M005_CODES.TERMINAL_EVIDENCE_INCOMPLETE}`), `${name}: the record names it`);
    assert.ok(text.includes(`terminalEvidence=incomplete reason=${reason}`), `${name}: ${reason}`);
    assert.ok(!text.includes(`outcome=${M005_CODES.OK}`), name);
  }

  // THE CONTROL: the identical run WITH the pair exits 0. The only variable is the record.
  const ok = deps({ spawn: () => completingChild() });
  assert.equal(await main([PARENT_FLAG], SYNTH, ok.deps), 0);
  assert.ok(ok.sink.join('\n').includes(`outcome=${M005_CODES.OK}`));
});

test('R4-R2: both records must name THIS launcher\'s own operation', () => {
  // `terminal:` is itself a declared label, so `[migrate] terminal: …` canonicalises. The child
  // always interpolates its dispatch literal, so that shape is one it CANNOT emit; accepting it
  // would read a record the child never wrote as proof the child completed.
  const bare = '[migrate] terminal: decision=success cleanup=completed exit=success code=none';
  assert.notEqual(canonicalMigrateLine(bare), null, 'the bare form really is canonical — the grammar admits it');
  assert.equal(evidence([TEARDOWN_OK, bare].join('\n')).reason, 'missing', 'and yet it establishes nothing');

  // AND THE OPERATION MUST BE THIS LAUNCHER'S OWN. Its child argv is `--managed-dev --apply`, so the
  // only records it can produce name `apply(up)`. A perfectly-formed pair for the BASELINE
  // operation is evidence about a run this launcher never requested.
  assert.equal(evidence(SPEC_TERMINAL_OK).reason, 'missing', 'a foreign operation is not this run');
  for (const foreign of ['status', 'baseline', 'apply(down)']) {
    const pair = [
      `[migrate] ${foreign} teardown: requested=true completed=true gracefulSocketClose=not_observed code=none`,
      `[migrate] ${foreign} terminal: decision=success cleanup=completed exit=success code=none`,
    ].join('\n');
    assert.equal(evidence(pair).reason, 'missing', `operation ${foreign} must not establish this launcher's completion`);
    // AND HALF-FOREIGN: this launcher's own cleanup record beneath a foreign verdict, and vice versa.
    assert.equal(evidence([TEARDOWN_OK, pair.split('\n')[1]].join('\n')).reason, 'missing', foreign);
    assert.equal(evidence([pair.split('\n')[0], TERMINAL_OK].join('\n')).reason, 'cleanup_mismatch', foreign);
  }
  // The launcher's own operation still works — this is not a blanket refusal.
  assert.equal(evidence(PAIR_OK).ok, true);
});

test('R4-R2: a MALFORMED capture fails closed rather than throwing', () => {
  // A capture whose `streamText` is present-but-not-callable must REFUSE, not throw: a throw is not
  // a refusal, and an exception escaping here would leave the disposition uncomputed.
  for (const streamText of ['a string', { stdout: 'x' }, 42, null, undefined, {}]) {
    const result = evidenced({ capture: { overflowed: false, streamText } });
    const r = terminalEvidenceFor(result);
    assert.equal(r.ok, false, `streamText=${typeof streamText} must not establish completion`);
    assert.equal(r.reason, 'stream_text_unavailable');
    // And the disposition — the value main() returns — is computable without throwing.
    assert.equal(dispositionFor(result).exitCode, 2);
  }
  // A CALLABLE THAT THROWS is the same fact as a non-callable one — the stream could not be read —
  // and must produce the same refusal.
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
  assert.equal(terminalEvidenceFor({}).reason, 'streams_not_proved_closed');
  // NON-VACUITY: a well-formed capture still works.
  assert.equal(terminalEvidenceFor(evidenced({ capture: captured(PAIR_OK) })).ok, true);
});


test('R4-R1: a failure inside the reporting region cannot skip the containment hold', async () => {
  // THE REGRESSION THIS PINS. The disposition was briefly computed ABOVE the reporting try, which put
  // one expression outside the only guard that guarantees the hold runs — and `outcomeCode` reads
  // `result.capture.overflowed` unguarded, so a malformed result threw there and the supervisor for a
  // possibly-live descendant was never installed. The exit code was still non-zero, which is what
  // makes that shape dangerous rather than merely wrong: the status certified a containment that
  // never engaged. Everything that can throw now sits inside the region the `finally` guards.
  const entered = [];
  const d = deps({
    // An unsettled run, so the hold is genuinely REQUIRED rather than skipped as unnecessary.
    scan: () => groupUnavailable(),
    enterHold: (o) => { entered.push(o); return { timer: null, release: () => {}, polls: 0 }; },
    spawn: () => completingChild(),
  });
  d.deps.out = () => { throw new Error('the record could not be written'); };

  await assert.rejects(
    () => main([PARENT_FLAG], SYNTH, d.deps),
    /the record could not be written/,
    'the failure is surfaced, not swallowed',
  );
  assert.equal(entered.length, 1, 'and the hold ran anyway — a reporting failure never abandons a child');

  // THE SECOND RUN IS A BASELINE, NOT A NON-VACUITY CONTROL, and is labelled as one: it varies only
  // the sink and shows the same unsettled run reaches the hold by the ordinary route. What makes the
  // assertion above non-vacuous is the `finally` itself — remove it and the throwing run enters the
  // hold zero times. This run does NOT distinguish where the disposition is computed; the structural
  // test below is what covers that, because no reachable input makes `dispositionFor` throw.
  const ok = deps({
    scan: () => groupUnavailable(),
    enterHold: (o) => { entered.push(o); return { timer: null, release: () => {}, polls: 0 }; },
    spawn: () => completingChild(),
  });
  assert.notEqual(await main([PARENT_FLAG], SYNTH, ok.deps), 0, 'an unsettled run is never a success');
  assert.equal(entered.length, 2);
});

test('R4-R1: the disposition is computed INSIDE the region the containment hold guards', () => {
  // A STRUCTURAL INVARIANT WITH NO BEHAVIOURAL PROXY, so it is asserted structurally — the same way
  // this launcher's other ordering guarantees are.
  //
  // `outcomeCode` reads `result.capture.overflowed` unguarded, so `dispositionFor` CAN throw. Through
  // `main()` it cannot, because `runChild` always yields a well-formed capture — which is exactly why
  // no behavioural test can distinguish the two placements. What the placement decides is what
  // happens if that ever stops being true: computed above the try, a throw skips
  // `enterHoldIfRequiredM005` and abandons a possibly-live descendant while the exit code still
  // reports failure — a status certifying a containment that never engaged.
  // MATCHED ON TOKEN ORDER, NOT ON FORMATTING. An earlier form of this test pinned an exact indented
  // multi-line literal, which any reformat would have broken with a message about the containment
  // hold — a failure that names the wrong cause. Only the relative order of three tokens matters.
  const src = readFileSync(LAUNCHER_PATH, 'utf8');
  const main = src.slice(src.indexOf('async function main('));

  const holdAt = main.indexOf('enterHoldIfRequiredM005(result, sink, deps)');
  assert.notEqual(holdAt, -1, 'the hold must run in the reporting block\'s finally');
  // The `try` that opens the block whose `finally` runs the hold: the last one before it.
  const guardAt = main.lastIndexOf('try {', holdAt);
  assert.notEqual(guardAt, -1, 'the reporting region must be guarded by a try');

  const computedAt = main.indexOf('dispositionFor(result)');
  assert.notEqual(computedAt, -1, 'the disposition must be computed somewhere in main()');
  assert.ok(
    computedAt > guardAt && computedAt < holdAt,
    'the disposition must be computed INSIDE the guarded region, not before it',
  );
});

// ============================================================================
// C2B-M005-LRLS-L3-R4-R2-V2 — THE MANAGED CHILD, RUN IN-PROCESS.
//
// Every test above observes the migration child through the record it writes. The tests below run
// the child's own `runThroughManagedExecutor` — the function `main()` dispatches every managed
// operation to — with each of its effects replaced by a synthetic, process-local port. No
// environment is read, no DSN exists, no client is constructed, no SQL reaches a server, no lock is
// taken and no process is spawned. The verdict and the terminal record are NOT replaced: they are the
// function's own statements, the ones production runs with its production ports.
//
// Every port call lands in one ordered trace and each test compares the WHOLE trace, so "nothing
// follows the record" is proved by where the trace ends, not by searching for a forbidden token. This
// section lives in a different file from the source-order test in managed-baseline-launcher.test.mjs
// on purpose: either can be removed without removing the other's witness.
// ============================================================================

import * as MIGRATE_CLI from '../../scripts/supabase-migrate.ts';
import { createNodeFsPort, discoverMigrations, pairMigrations } from '../../server/platform-identity/migrationEngine.ts';

const { runThroughManagedExecutor } = MIGRATE_CLI;
const V2_MIGRATIONS_REL = 'server/platform-identity/migrations';
const V2_PAIRS = pairMigrations(discoverMigrations(createNodeFsPort(join(REPO_ROOT, V2_MIGRATIONS_REL), V2_MIGRATIONS_REL)));
/** What a managed apply expects to find: 001-004 recorded clean, under the checksums on disk. */
const V2_LEDGER_001_004 = Object.freeze(
  V2_PAIRS.slice(0, 4).map((p) => Object.freeze({ version: p.version, checksum: p.up.checksum, dirty: false })),
);

const V2_BASELINE_ARGV = Object.freeze(['--managed-dev', '--baseline', '--confirm-dev', '--baseline-versions=001,002,003,004']);
const V2_APPLY_ARGV = Object.freeze(['--managed-dev', '--apply', '--confirm-dev']);
const V2_TEARDOWN_OK = Object.freeze({ requested: true, completed: true, gracefulSocketClose: 'not_observed', code: null });
const V2_TEARDOWN_FAILED = Object.freeze({
  requested: true, completed: false, gracefulSocketClose: 'not_observed', code: 'client_teardown_failed',
});

const V2_BASELINE_OK = Object.freeze({
  outcome: 'complete', code: null, adopted: Object.freeze(['001', '002', '003', '004']), detail: Object.freeze([]),
  disposal: 'closed', commit: 'committed',
});
const V2_BASELINE_COMMIT_UNKNOWN = Object.freeze({
  outcome: 'failed', code: 'execution_step_timeout', adopted: Object.freeze([]),
  detail: Object.freeze(['commit outcome not established']), disposal: 'terminated', commit: 'unknown',
});
const V2_APPLY_OK = Object.freeze({
  outcome: 'complete', code: null, disposition: 'none', ownershipUncertain: false,
  applied: Object.freeze(['005']), executedChecksums: Object.freeze([]), disposal: 'closed',
  lateSettlementDisposed: false, steps: 1,
  commit: Object.freeze({ submitted: true, resolved: true, acknowledged: 'unavailable', readBackVerified: true }),
  lockRelease: 'verified', preCommitVerified: true, dirtyMarkerWrite: 'succeeded',
});
/** An apply that stopped before COMMIT was ever submitted: a bounded, in-band refusal. */
const V2_APPLY_TIMED_OUT = Object.freeze({
  ...V2_APPLY_OK, outcome: 'failed', code: 'execution_step_timeout', applied: Object.freeze([]), disposal: 'terminated',
  commit: Object.freeze({ submitted: false, resolved: false, acknowledged: 'unavailable', readBackVerified: false }),
  lockRelease: 'not_acquired', preCommitVerified: false, dirtyMarkerWrite: 'not_attempted',
});

/**
 * One synthetic managed world. Every member records itself in `trace`. The members this path must
 * never touch on its own — every session operation that can lock or execute SQL, the ledger writes,
 * the baseline write port, and the ACL, owner and diagnostic brackets — record FORBIDDEN and throw.
 */
function v2World({ argv = [], ledger = [], fingerprint = 'match', liveFails = false, run, teardown = V2_TEARDOWN_OK, open, writeError } = {}) {
  const trace = [];
  const calls = [];
  const at = (...event) => { trace.push(event); };
  const tick = () => new Promise((r) => setImmediate(r));
  const forbidden = (name) => () => { at('FORBIDDEN', name); throw new Error(`forbidden port: ${name}`); };
  const session = Object.freeze({
    confirmLive: async () => { at('session.confirmLive'); if (liveFails) throw new Error('synthetic: session not live'); },
    close: async () => { at('session.close'); },
    terminate: async () => { at('session.terminate'); },
    backendIdentity: forbidden('session.backendIdentity'),
    acquireRunLock: forbidden('session.acquireRunLock'),
    releaseRunLock: forbidden('session.releaseRunLock'),
    beginTx: forbidden('session.beginTx'),
    commitTx: forbidden('session.commitTx'),
    executeSql: forbidden('session.executeSql'),
  });
  const handle = Object.freeze({
    adapter: Object.freeze({ reserve: async (mode) => { at('adapter.reserve', mode); return session; } }),
    ledger: Object.freeze({
      readLedger: async () => { at('ledger.read'); return ledger.map((r) => ({ ...r })); },
      insertDirtyAttempt: forbidden('ledger.insertDirtyAttempt'),
      finalizeApplied: forbidden('ledger.finalizeApplied'),
    }),
    catalog: Object.freeze({
      // ONLY the two fixed fingerprint statements are answered; any other statement is one this path
      // has no business issuing before the trusted runner, and it fails loudly.
      query: async (text) => {
        if (text.includes('from public.audit_event group by action_id')) {
          at('catalog.audit');
          return [
            { action_id: 'bcp.platform.system_owner_provisioning', n: '1' },
            { action_id: 'bcp.platform.system_owner_provisioning_compensation', n: '1' },
          ];
        }
        if (text.includes('from public.user_membership')) {
          at('catalog.membership');
          return fingerprint === 'match' ? [{ status: 'active', n: 2 }, { status: 'suspended', n: 1 }] : [{ status: 'active', n: 3 }];
        }
        at('catalog.UNEXPECTED');
        throw new Error('unexpected catalog statement');
      },
    }),
    write: Object.freeze({ writeAdoptedPrefix: forbidden('write.writeAdoptedPrefix') }),
    readOnlyTx: Object.freeze({ begin: forbidden('readOnlyTx.begin') }),
    snapshotTx: Object.freeze({ begin: forbidden('snapshotTx.begin') }),
    ownerAcl: Object.freeze({ revokeTemporaryFromPublic: forbidden('ownerAcl.revokeTemporaryFromPublic') }),
    dispose: async () => { at('dispose.requested'); await tick(); at('dispose.settled', teardown.completed); return teardown; },
  });
  const runner = (name) => async (deps) => {
    calls.push([name, deps]);
    at(`run.${name}`);
    await tick();
    if (run instanceof Error) { at('run.settled', 'threw'); throw run; }
    at('run.settled', 'returned');
    return run;
  };
  const ports = Object.freeze({
    openManagedExecutor: async (op) => {
      at('open', op);
      await tick();
      if (open instanceof Error) { at('open.threw'); throw open; }
      return handle;
    },
    runTrustedHistoricalBaseline: runner('baseline'),
    runTrustedApply: runner('apply'),
    console: Object.freeze({ log: (line) => at('stdout', line), error: (line) => at('stderr', line) }),
    process: Object.freeze({
      argv: Object.freeze([process.execPath, 'scripts/supabase-migrate.ts', ...argv]),
      get exitCode() { return undefined; },
      set exitCode(code) { at('exitCode', code); },
      stdout: Object.freeze({
        write: (text, callback) => {
          at('stdout.write', text);
          // Asynchronous, as a pipe write's completion is.
          setImmediate(() => {
            if (typeof callback !== 'function') { at('write.callback', 'absent'); return; }
            at('write.callback', writeError === undefined ? 'ok' : 'error');
            callback(writeError);
          });
          return true;
        },
      }),
      exit: (code) => at('exit', code),
    }),
  });
  return { ports, trace, calls, handle };
}

/** Run the REAL managed runner against a world, then let its completion callback land. */
async function v2Run(op, world) {
  await runThroughManagedExecutor(op, world.ports);
  world.trace.push(['returned']);
  // The record's completion is asynchronous; give it — and anything that could follow it — time.
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
  return world.trace;
}

const V2_BASELINE_PREFIX = Object.freeze([
  ['open', 'baseline'],
  ['adapter.reserve', 'session'],
  ['catalog.audit'],
  ['catalog.membership'],
  ['stdout', '[migrate] managed target: live DEV fingerprint OK'],
  ['adapter.reserve', 'session'],
  ['session.confirmLive'],
  ['ledger.read'],
  ['session.close'],
]);
const V2_BASELINE_OK_EXECUTION = Object.freeze([
  ['run.baseline'],
  ['run.settled', 'returned'],
  ['stdout', '[migrate] baseline: outcome=complete adopted=001,002,003,004 commit=committed disposal=closed code=none'],
]);
const V2_APPLY_PREFIX = Object.freeze([
  ['open', 'apply(up)'],
  ['adapter.reserve', 'session'],
  ['catalog.audit'],
  ['catalog.membership'],
  ['stdout', '[migrate] managed target: live DEV fingerprint OK'],
  ['adapter.reserve', 'session'],
  ['session.confirmLive'],
  ['ledger.read'],
  ['session.close'],
  ['stdout', '[migrate] managed apply preflight (advisory): plan is exactly [005]'],
]);
const V2_APPLY_OK_EXECUTION = Object.freeze([
  ['run.apply'],
  ['run.settled', 'returned'],
  ['stdout', '[migrate] apply(up): outcome=complete finalized=1 disposal=closed code=none'],
  ['stdout', '[migrate] apply(up) mutation: success_commit_and_read_back_verified commit_attempted=true rollback_observed=false'],
  ['stdout', '[migrate] apply(up) ledger: version=005 marker=clean_verified markerWrite=succeeded cleanVerified=true ddlMayHaveCommitted=true'],
  ['stdout', '[migrate] apply(up) evidence: commit=resolved submitted=true resolved=true acknowledged=unavailable readBack=true lockRelease=verified'],
]);
const V2_TEARDOWN_TEAR_REFUSAL =
  'client teardown NOT ESTABLISHED (client_teardown_failed) — the managed connection was not proved shut '
  + 'down; nothing is retried and no second connection is opened automatically.';

// ---- V2/§4 — required behavioural evidence ----------------------------------

test('V2/§4: a successful baseline — the whole ordered trace, open to completion', async () => {
  const trace = await v2Run('baseline', v2World({ argv: V2_BASELINE_ARGV, run: V2_BASELINE_OK }));
  assert.deepEqual(trace, [
    ...V2_BASELINE_PREFIX,
    ...V2_BASELINE_OK_EXECUTION,
    ['dispose.requested'],
    ['dispose.settled', true],
    ['stdout', '[migrate] baseline teardown: requested=true completed=true gracefulSocketClose=not_observed code=none'],
    ['exitCode', 0],
    ['stdout.write', '[migrate] baseline terminal: decision=success cleanup=completed exit=success code=none\n'],
    ['returned'],
    ['write.callback', 'ok'],
  ]);
});

test('V2/§4: a successful apply(up) — the whole ordered trace, open to completion', async () => {
  assert.deepEqual(V2_PAIRS.map((p) => p.version), ['001', '002', '003', '004', '005'], 'the fixture ledger is 001-004 of this tree');
  const trace = await v2Run('apply(up)', v2World({ argv: V2_APPLY_ARGV, ledger: V2_LEDGER_001_004, run: V2_APPLY_OK }));
  assert.deepEqual(trace, [
    ...V2_APPLY_PREFIX,
    ...V2_APPLY_OK_EXECUTION,
    ['dispose.requested'],
    ['dispose.settled', true],
    ['stdout', '[migrate] apply(up) teardown: requested=true completed=true gracefulSocketClose=not_observed code=none'],
    ['exitCode', 0],
    ['stdout.write', '[migrate] apply(up) terminal: decision=success cleanup=completed exit=success code=none\n'],
    ['returned'],
    ['write.callback', 'ok'],
  ]);
});

test('V2/§4: a controlled refusal — the ten ordering points, in order, and nothing after them', async () => {
  const trace = await v2Run('apply(up)', v2World({ argv: V2_APPLY_ARGV, ledger: V2_LEDGER_001_004, run: V2_APPLY_TIMED_OUT }));
  assert.deepEqual(trace, [
    ...V2_APPLY_PREFIX,
    ['run.apply'],
    ['run.settled', 'returned'], //                                                  1. the execution outcome settles
    ['stdout', '[migrate] apply(up): outcome=failed finalized=0 disposal=terminated code=execution_step_timeout'],
    ['stdout', '[migrate] apply(up) mutation: commit_not_attempted commit_attempted=false rollback_observed=false'],
    ['stdout', '[migrate] apply(up) ledger: version=005 marker=not_written markerWrite=not_attempted cleanVerified=false ddlMayHaveCommitted=false'],
    ['stdout', '[migrate] apply(up) evidence: commit=not_submitted submitted=false resolved=false acknowledged=unavailable readBack=false lockRelease=not_acquired'],
    ['dispose.requested'], //                                                        2. disposal is requested
    ['dispose.settled', true], //                                                    3. and completes
    ['stdout', '[migrate] apply(up) teardown: requested=true completed=true gracefulSocketClose=not_observed code=none'], // 4.
    // 5. the verdict is computed here, from everything above; nothing observable happens in between.
    ['stderr', '[migrate] REFUSED: apply(up) did not complete: execution_step_timeout'], // 6. the refusal
    ['exitCode', 2], //                                                              7. the exit classification
    ['stdout.write', '[migrate] apply(up) terminal: decision=refused cleanup=completed exit=failure code=none\n'], // 8.
    ['returned'],
    ['write.callback', 'ok'], //                                                     9. its completion callback
    ['exit', 2], //                                               …ends the process, and 10. nothing follows it
  ]);
});

test('V2/§4: controlled refusals on the baseline path — an UNKNOWN commit, and a live-fingerprint mismatch', async () => {
  assert.deepEqual(await v2Run('baseline', v2World({ argv: V2_BASELINE_ARGV, run: V2_BASELINE_COMMIT_UNKNOWN })), [
    ...V2_BASELINE_PREFIX,
    ['run.baseline'],
    ['run.settled', 'returned'],
    ['stdout', '[migrate] baseline: outcome=failed adopted=none commit=unknown disposal=terminated code=execution_step_timeout'],
    ['stderr', '  - commit outcome not established'],
    ['dispose.requested'],
    ['dispose.settled', true],
    ['stdout', '[migrate] baseline teardown: requested=true completed=true gracefulSocketClose=not_observed code=none'],
    ['stderr', '[migrate] REFUSED: baseline COMMIT OUTCOME IS UNKNOWN — the transaction may or may not have committed. '
      + 'Do NOT re-run baseline. Do NOT run apply/migration 005. Verify the authoritative ledger state before any continuation'],
    ['exitCode', 2],
    ['stdout.write', '[migrate] baseline terminal: decision=refused cleanup=completed exit=failure code=none\n'],
    ['returned'],
    ['write.callback', 'ok'],
    ['exit', 2],
  ]);
  // Refused BEFORE any ledger read or runner: the live database is not the expected target.
  const mismatch = v2World({ argv: V2_BASELINE_ARGV, fingerprint: 'mismatch', run: V2_BASELINE_OK });
  assert.deepEqual(await v2Run('baseline', mismatch), [
    ['open', 'baseline'],
    ['adapter.reserve', 'session'],
    ['catalog.audit'],
    ['catalog.membership'],
    ['stderr', '[migrate] managed fingerprint failures: 2'],
    ['dispose.requested'],
    ['dispose.settled', true],
    ['stdout', '[migrate] baseline teardown: requested=true completed=true gracefulSocketClose=not_observed code=none'],
    ['stderr', '[migrate] REFUSED: baseline refused: the live database is not the expected DEV target. NOTHING was mutated.'],
    ['exitCode', 2],
    ['stdout.write', '[migrate] baseline terminal: decision=refused cleanup=completed exit=failure code=none\n'],
    ['returned'],
    ['write.callback', 'ok'],
    ['exit', 2],
  ]);
  assert.equal(mismatch.calls.length, 0, 'no runner was reached');
});

test('V2/§4: a THROWN execution failure is decision=failed, and its message reaches no stream', async () => {
  const thrown = v2World({ argv: V2_APPLY_ARGV, ledger: V2_LEDGER_001_004, run: new Error('synthetic runner failure host=db.example') });
  const trace = await v2Run('apply(up)', thrown);
  assert.deepEqual(trace, [
    ...V2_APPLY_PREFIX,
    ['run.apply'],
    ['run.settled', 'threw'],
    ['dispose.requested'],
    ['dispose.settled', true],
    ['stdout', '[migrate] apply(up) teardown: requested=true completed=true gracefulSocketClose=not_observed code=none'],
    ['stderr', '[migrate] REFUSED: apply(up) refused before completion: migration_engine_pg_validation_required.'],
    ['exitCode', 2],
    ['stdout.write', '[migrate] apply(up) terminal: decision=failed cleanup=completed exit=failure code=none\n'],
    ['returned'],
    ['write.callback', 'ok'],
    ['exit', 2],
  ]);
  assert.ok(!JSON.stringify(trace).includes('synthetic runner failure'), 'no error message crosses the catch');

  // A bounded code thrown by the runner's OWN preconditions keeps its code: the ledger could not be
  // read, which on the baseline path is thrown rather than planned on.
  assert.deepEqual(await v2Run('baseline', v2World({ argv: V2_BASELINE_ARGV, liveFails: true, run: V2_BASELINE_OK })), [
    ['open', 'baseline'],
    ['adapter.reserve', 'session'],
    ['catalog.audit'],
    ['catalog.membership'],
    ['stdout', '[migrate] managed target: live DEV fingerprint OK'],
    ['adapter.reserve', 'session'],
    ['session.confirmLive'],
    ['session.terminate'],
    ['dispose.requested'],
    ['dispose.settled', true],
    ['stdout', '[migrate] baseline teardown: requested=true completed=true gracefulSocketClose=not_observed code=none'],
    ['stderr', '[migrate] REFUSED: baseline refused before completion: port_operation_failed.'],
    ['exitCode', 2],
    ['stdout.write', '[migrate] baseline terminal: decision=failed cleanup=completed exit=failure code=none\n'],
    ['returned'],
    ['write.callback', 'ok'],
    ['exit', 2],
  ]);
});

test('V2/§4: a throw BEFORE the client exists — no disposal, no teardown record, cleanup=not_attempted', async () => {
  const w = v2World({ argv: V2_APPLY_ARGV, open: new Error('synthetic: dsn rejected'), run: V2_APPLY_OK });
  assert.deepEqual(await v2Run('apply(up)', w), [
    ['open', 'apply(up)'],
    ['open.threw'],
    ['stderr', '[migrate] REFUSED: apply(up) refused before completion: migration_engine_pg_validation_required.'],
    ['exitCode', 2],
    ['stdout.write', '[migrate] apply(up) terminal: decision=failed cleanup=not_attempted exit=failure code=none\n'],
    ['returned'],
    ['write.callback', 'ok'],
    ['exit', 2],
  ]);
  assert.equal(w.calls.length, 0);
});

test('V2/§4: a FAILED teardown refuses an otherwise clean run, on both the baseline and the apply verdicts', async () => {
  assert.deepEqual(await v2Run('baseline', v2World({ argv: V2_BASELINE_ARGV, run: V2_BASELINE_OK, teardown: V2_TEARDOWN_FAILED })), [
    ...V2_BASELINE_PREFIX,
    ...V2_BASELINE_OK_EXECUTION,
    ['dispose.requested'],
    ['dispose.settled', false],
    ['stdout', '[migrate] baseline teardown: requested=true completed=false gracefulSocketClose=not_observed code=client_teardown_failed'],
    ['stderr', `[migrate] REFUSED: baseline: ${V2_TEARDOWN_TEAR_REFUSAL}`],
    ['exitCode', 2],
    ['stdout.write', '[migrate] baseline terminal: decision=refused cleanup=failed exit=failure code=client_teardown_failed\n'],
    ['returned'],
    ['write.callback', 'ok'],
    ['exit', 2],
  ]);
  const apply = v2World({ argv: V2_APPLY_ARGV, ledger: V2_LEDGER_001_004, run: V2_APPLY_OK, teardown: V2_TEARDOWN_FAILED });
  assert.deepEqual(await v2Run('apply(up)', apply), [
    ...V2_APPLY_PREFIX,
    ...V2_APPLY_OK_EXECUTION,
    ['dispose.requested'],
    ['dispose.settled', false],
    ['stdout', '[migrate] apply(up) teardown: requested=true completed=false gracefulSocketClose=not_observed code=client_teardown_failed'],
    ['stderr', `[migrate] REFUSED: apply(up): ${V2_TEARDOWN_TEAR_REFUSAL}`],
    ['exitCode', 2],
    ['stdout.write', '[migrate] apply(up) terminal: decision=refused cleanup=failed exit=failure code=client_teardown_failed\n'],
    ['returned'],
    ['write.callback', 'ok'],
    ['exit', 2],
  ]);
});

test('V2/§4: an UNEXPECTED teardown code is bounded in the terminal record, never forwarded into it', async () => {
  const odd = Object.freeze({ requested: true, completed: false, gracefulSocketClose: 'not_observed', code: 'socket_hangup' });
  assert.deepEqual(await v2Run('baseline', v2World({ argv: V2_BASELINE_ARGV, run: V2_BASELINE_OK, teardown: odd })), [
    ...V2_BASELINE_PREFIX,
    ...V2_BASELINE_OK_EXECUTION,
    ['dispose.requested'],
    ['dispose.settled', false],
    // The cleanup record carries the raw token, so the launcher's grammar refuses the pair; the terminal
    // record carries only the bounded substitute.
    ['stdout', '[migrate] baseline teardown: requested=true completed=false gracefulSocketClose=not_observed code=socket_hangup'],
    ['stderr', '[migrate] REFUSED: baseline: client teardown NOT ESTABLISHED (socket_hangup) — the managed connection was not '
      + 'proved shut down; nothing is retried and no second connection is opened automatically.'],
    ['exitCode', 2],
    ['stdout.write', '[migrate] baseline terminal: decision=refused cleanup=failed exit=failure code=teardown_code_unrecognized\n'],
    ['returned'],
    ['write.callback', 'ok'],
    ['exit', 2],
  ]);
});

test('V2/§4: a FAILED record write still ends a refused run with its code, and never fails a successful one', async () => {
  const broken = Object.assign(new Error('EPIPE'), { code: 'EPIPE' });
  assert.deepEqual(await v2Run('apply(up)', v2World({ argv: V2_APPLY_ARGV, open: new Error('synthetic'), writeError: broken })), [
    ['open', 'apply(up)'],
    ['open.threw'],
    ['stderr', '[migrate] REFUSED: apply(up) refused before completion: migration_engine_pg_validation_required.'],
    ['exitCode', 2],
    ['stdout.write', '[migrate] apply(up) terminal: decision=failed cleanup=not_attempted exit=failure code=none\n'],
    ['returned'],
    ['write.callback', 'error'],
    ['exit', 2],
  ]);
  assert.deepEqual(await v2Run('baseline', v2World({ argv: V2_BASELINE_ARGV, run: V2_BASELINE_OK, writeError: broken })), [
    ...V2_BASELINE_PREFIX,
    ...V2_BASELINE_OK_EXECUTION,
    ['dispose.requested'],
    ['dispose.settled', true],
    ['stdout', '[migrate] baseline teardown: requested=true completed=true gracefulSocketClose=not_observed code=none'],
    ['exitCode', 0],
    ['stdout.write', '[migrate] baseline terminal: decision=success cleanup=completed exit=success code=none\n'],
    ['returned'],
    ['write.callback', 'error'],
  ]);
});

// ---- V2/§6 — the seam's containment -----------------------------------------

test('V2/§6: the seam accepts only the three dispatch literals, refused before any port is touched', async () => {
  for (const op of ['apply(down)', 'apply', 'resolve-dirty', 'status;', 'BASELINE', 'baseline ', '', '005', 'constructor', null, undefined, 42]) {
    const w = v2World({ argv: V2_APPLY_ARGV, ledger: V2_LEDGER_001_004, run: V2_APPLY_OK });
    await assert.rejects(runThroughManagedExecutor(op, w.ports), /^TypeError: managed run refused: unsupported operation or port set$/, String(op));
    assert.deepEqual(w.trace, [], `${String(op)}: no port was touched`);
  }
});

test('V2/§6: the seam accepts only a SEALED port set of exactly its five members', async () => {
  const w = v2World({ argv: V2_BASELINE_ARGV, run: V2_BASELINE_OK });
  const { openManagedExecutor, runTrustedApply, runTrustedHistoricalBaseline, console: con } = w.ports;
  for (const [what, ports] of [
    ['an unfrozen copy', { ...w.ports }],
    ['an extra SQL-bearing member', Object.freeze({ ...w.ports, executeSql: () => {} })],
    ['an extra symbol member', Object.freeze({ ...w.ports, [Symbol('sql')]: 'select 1' })],
    ['a missing member', Object.freeze({ openManagedExecutor, runTrustedApply, runTrustedHistoricalBaseline, console: con })],
    ['no port set', undefined],
    ['null', null],
  ]) {
    await assert.rejects(runThroughManagedExecutor('baseline', ports), /managed run refused/, what);
  }
  assert.deepEqual(w.trace, [], 'no port was touched');
  // The SAME world, sealed, runs to completion — so every refusal above was about the set, not the world.
  assert.deepEqual((await v2Run('baseline', w)).at(-1), ['write.callback', 'ok']);
});

test('V2/§6: no migration version can be widened through the seam — baseline allowlist and apply plan', async () => {
  for (const argv of [
    ['--managed-dev', '--baseline', '--confirm-dev', '--baseline-versions=001,002,003,004,005'],
    ['--managed-dev', '--baseline', '--confirm-dev', '--baseline-versions=001,002,003'],
    ['--managed-dev', '--baseline', '--confirm-dev'],
  ]) {
    const w = v2World({ argv, run: V2_BASELINE_OK });
    assert.deepEqual(await v2Run('baseline', w), [
      ['open', 'baseline'],
      ['adapter.reserve', 'session'],
      ['catalog.audit'],
      ['catalog.membership'],
      ['stdout', '[migrate] managed target: live DEV fingerprint OK'],
      ['dispose.requested'],
      ['dispose.settled', true],
      ['stdout', '[migrate] baseline teardown: requested=true completed=true gracefulSocketClose=not_observed code=none'],
      ['stderr', '[migrate] REFUSED: baseline on the managed recovery path requires --baseline-versions=001,002,003,004 exactly '
        + '(005 is PENDING and must be executed, never adopted)'],
      ['exitCode', 2],
      ['stdout.write', '[migrate] baseline terminal: decision=refused cleanup=completed exit=failure code=none\n'],
      ['returned'],
      ['write.callback', 'ok'],
      ['exit', 2],
    ], argv.join(' '));
    assert.equal(w.calls.length, 0, `${argv.join(' ')}: no runner was reached`);
  }
  // The apply set is re-derived from discovery and the ledger, never supplied: a ledger that would plan
  // [004,005] is refused before the runner, whatever the operation label says.
  const w = v2World({ argv: V2_APPLY_ARGV, ledger: V2_LEDGER_001_004.slice(0, 3), run: V2_APPLY_OK });
  assert.deepEqual(await v2Run('apply(up)', w), [
    ...V2_APPLY_PREFIX.slice(0, 9),
    ['dispose.requested'],
    ['dispose.settled', true],
    ['stdout', '[migrate] apply(up) teardown: requested=true completed=true gracefulSocketClose=not_observed code=none'],
    ['stderr', '[migrate] REFUSED: apply(up) refused before completion: managed_apply_plan_rejected.'],
    ['exitCode', 2],
    ['stdout.write', '[migrate] apply(up) terminal: decision=failed cleanup=completed exit=failure code=none\n'],
    ['returned'],
    ['write.callback', 'ok'],
    ['exit', 2],
  ]);
  assert.equal(w.calls.length, 0, 'no runner was reached');
});

test('V2/§6: the runner opens one client, locks nothing, runs no SQL, and reaches apply or baseline only through its runners', async () => {
  const apply = v2World({ argv: V2_APPLY_ARGV, ledger: V2_LEDGER_001_004, run: V2_APPLY_OK });
  const baseline = v2World({ argv: V2_BASELINE_ARGV, run: V2_BASELINE_OK });
  for (const [op, w] of [['apply(up)', apply], ['baseline', baseline]]) {
    const kinds = (await v2Run(op, w)).map(([k]) => k);
    assert.equal(kinds.filter((k) => k === 'open').length, 1, `${op}: one client, opened once`);
    assert.equal(kinds.filter((k) => k === 'dispose.requested').length, 1, `${op}: disposed once`);
    assert.deepEqual(kinds.filter((k) => k.startsWith('catalog.')), ['catalog.audit', 'catalog.membership'],
      `${op}: the only statements are the two fixed fingerprint reads`);
    assert.ok(!kinds.includes('FORBIDDEN'), `${op}: no lock, SQL, ledger write, adoption write, ACL, owner or diagnostic port`);
    assert.equal(w.calls.length, 1, `${op}: exactly one trusted-runner call`);
  }
  // The lock and every migration statement belong to the runner, and the runner is reached with the
  // fixed key, the fixed credential references and ALL THREE 005 gates.
  const [[applyName, applyDeps]] = apply.calls;
  assert.equal(applyName, 'apply');
  assert.equal(applyDeps.lockKey, 720100301);
  assert.equal(applyDeps.connectionMode, 'session');
  assert.deepEqual(applyDeps.credential, { purpose: 'migration', migratorRef: 'tmpos-migrator', runtimeRef: 'tmpos-runtime' });
  for (const gate of ['executionPolicy', 'preCommitPolicy', 'postCommitPolicy']) {
    assert.equal(typeof applyDeps[gate], 'function', `the 005 path still hands the runner its ${gate}`);
  }
  assert.equal(applyDeps.adapter, apply.handle.adapter);
  assert.equal(applyDeps.ledger, apply.handle.ledger);
  const [[baselineName, baselineDeps]] = baseline.calls;
  assert.equal(baselineName, 'baseline');
  assert.equal(baselineDeps.lockKey, 720100301);
  assert.equal(baselineDeps.write, baseline.handle.write, 'the adoption write is the runner\'s, never the seam\'s');
  assert.deepEqual(
    baselineDeps.plan.versions.map((v) => ({ ...v })),
    V2_LEDGER_001_004.map(({ version, checksum }) => ({ version, checksum })),
    'exactly 001-004, under the checksums on disk',
  );
});

test('V2/§6: the seam adds no export, route, flag or environment key — the production set is main()\'s alone', () => {
  assert.deepEqual(Object.keys(MIGRATE_CLI).sort(), ['runThroughManagedExecutor', 'sealBreakage'],
    'neither the gated open nor the production port set is exported');
  const code = stripComments(readFileSync(join(REPO_ROOT, 'scripts/supabase-migrate.ts'), 'utf8'));
  assert.deepEqual((code.match(/.*PRODUCTION_MANAGED_PORTS.*/g) ?? []).map((l) => l.trim()), [
    'const PRODUCTION_MANAGED_PORTS: ManagedRunPorts = Object.freeze({',
    'if (wantApply) return runThroughManagedExecutor(`apply(${managedApplyDirectionOrRefuse()})`, PRODUCTION_MANAGED_PORTS);',
    "if (wantBaseline) return runThroughManagedExecutor('baseline', PRODUCTION_MANAGED_PORTS);",
    "if (wantStatus) return runThroughManagedExecutor('status', PRODUCTION_MANAGED_PORTS);",
  ], 'one definition and the three managed dispatch lines — nothing else holds the real effects');
  assert.match(code,
    /const PRODUCTION_MANAGED_PORTS: ManagedRunPorts = Object\.freeze\(\{\s*openManagedExecutor,\s*runTrustedHistoricalBaseline,\s*runTrustedApply,\s*console,\s*process,\s*\}\);/,
    'and it binds the real gated open, the real runners and the real streams');
  // ONE implementation: one runner, one verdict, one record template.
  assert.equal((code.match(/async function runThroughManagedExecutor\(/g) ?? []).length, 1);
  assert.equal((code.match(/const decision = /g) ?? []).length, 1);
  assert.equal((code.match(/terminal: decision=/g) ?? []).length, 1);
  // Flags and environment names: exactly the sets that existed before the seam.
  const flags = [...new Set([...code.matchAll(/(?:hasFlag|getOpt)\('(--[a-z-]+)'/g)].map((m) => m[1]))].sort();
  assert.deepEqual(flags, [
    '--allow-down', '--apply', '--baseline', '--baseline-versions', '--confirm-dev', '--corrective-ref', '--direction',
    '--down', '--dry-run', '--list', '--managed-dev', '--migration', '--plan', '--reason-category', '--resolve-dirty', '--status',
  ]);
  const envNames = [...new Set([...code.matchAll(/process\.env\.([A-Z_]+)/g)].map((m) => m[1]))].sort();
  assert.deepEqual(envNames, ['ALLOW_SUPABASE_MIGRATION_APPLY', 'CONFIRM_SUPABASE_TARGET', 'NODE_ENV', 'SUPABASE_DATABASE_URL', 'SUPABASE_URL']);
  assert.equal((code.match(/process\.env\)/g) ?? []).length, 2,
    'the whole environment reaches only the disposable DSN resolver and the seal, as before');
});

// ============================================================================
// C2B-M005-LRLS-L3-R4-R2-V2-R2 — THE STATUS OPERATION, RUN IN-PROCESS.
//
// `main()` routes `--managed-dev --status` to `runThroughManagedExecutor('status', PRODUCTION_MANAGED_PORTS)`;
// the local-child test in managed-baseline-launcher.test.mjs proves that routing. The tests below run the
// same exported function against the V2 synthetic world, so status is witnessed by what it DOES — one open,
// the fingerprint, ONE trusted ledger read, its report, the disposal, the verdict and the record — and by
// what it never reaches: neither trusted runner, no second client, no lock, no write, no ACL port and no
// statement beyond the two fingerprint reads. Every trace is compared whole.
// ============================================================================

const V2R2_STATUS_ARGV = Object.freeze(['--managed-dev', '--status', '--confirm-dev']);
const V2R2_STATUS_PREFIX = Object.freeze([
  ['open', 'status'],
  ['adapter.reserve', 'session'],
  ['catalog.audit'],
  ['catalog.membership'],
  ['stdout', '[migrate] managed target: live DEV fingerprint OK'],
  // The trusted READ: reserve, confirm, read, close — no lock, no transaction, no statement of its own.
  ['adapter.reserve', 'session'],
  ['session.confirmLive'],
  ['ledger.read'],
  ['session.close'],
]);
/** Status over 001-004 recorded clean under the checksums on disk, with 005 absent. */
const V2R2_STATUS_REPORT_001_004 = Object.freeze([
  ['stdout', '  version=001  state=applied  ledger=recorded'],
  ['stdout', '  version=002  state=applied  ledger=recorded'],
  ['stdout', '  version=003  state=applied  ledger=recorded'],
  ['stdout', '  version=004  state=applied  ledger=recorded'],
  ['stdout', '  version=005  state=unapplied  ledger=none'],
]);
const V2R2_STATUS_DISPOSED = Object.freeze([
  ['dispose.requested'],
  ['dispose.settled', true],
  ['stdout', '[migrate] status teardown: requested=true completed=true gracefulSocketClose=not_observed code=none'],
]);
const V2R2_STATUS_SUCCESS_TAIL = Object.freeze([
  ['exitCode', 0],
  ['stdout.write', '[migrate] status terminal: decision=success cleanup=completed exit=success code=none\n'],
  ['returned'],
  ['write.callback', 'ok'],
]);

/**
 * The world's five ports as ACCESSORS on a frozen object, behind a Proxy that records every operation
 * on the set — a property get, a key listing, a descriptor read, an extensibility check. An empty
 * record therefore means the set was not so much as inspected.
 */
function v2r2TrappedPorts(world) {
  const touched = [];
  const target = {};
  for (const name of Object.keys(world.ports)) {
    Object.defineProperty(target, name, { enumerable: true, get: () => { touched.push(['getter', name]); return world.ports[name]; } });
  }
  Object.freeze(target);
  const handler = {};
  for (const trap of ['get', 'set', 'has', 'ownKeys', 'getOwnPropertyDescriptor', 'defineProperty', 'deleteProperty',
    'isExtensible', 'preventExtensions', 'getPrototypeOf', 'setPrototypeOf']) {
    handler[trap] = (...args) => { touched.push(['trap', trap]); return Reflect[trap](...args); };
  }
  return { ports: new Proxy(target, handler), touched };
}

test('V2-R2/status: a successful status — the whole ordered trace, open to completion, exit 0 without forced termination', async () => {
  assert.deepEqual(V2_PAIRS.map((p) => p.version), ['001', '002', '003', '004', '005'], 'the fixture ledger is 001-004 of this tree');
  const w = v2World({ argv: V2R2_STATUS_ARGV, ledger: V2_LEDGER_001_004 });
  assert.deepEqual(await v2Run('status', w), [
    ...V2R2_STATUS_PREFIX,
    ...V2R2_STATUS_REPORT_001_004,
    ...V2R2_STATUS_DISPOSED, // disposal settles and is reported BEFORE the verdict and the record
    ...V2R2_STATUS_SUCCESS_TAIL, // exit ASSIGNED 0, one record, its callback — and no `exit` after it
  ]);
  assert.equal(w.calls.length, 0, 'neither trusted runner was reached');
});

test('V2-R2/status: status selects only its trusted read — one client, no runner, no 005, no lock, write, repair, ACL or SQL', async () => {
  // A ledger that INVITES a repair: 005 recorded dirty under its own checksum, and a runner that would
  // report a clean apply if it were ever called. Status reports the row and reaches nothing else.
  const dirty005 = Object.freeze({ version: '005', checksum: V2_PAIRS[4].up.checksum, dirty: true });
  const w = v2World({ argv: V2R2_STATUS_ARGV, ledger: [...V2_LEDGER_001_004, dirty005], run: V2_APPLY_OK });
  const trace = await v2Run('status', w);
  assert.deepEqual(trace, [
    ...V2R2_STATUS_PREFIX,
    ...V2R2_STATUS_REPORT_001_004.slice(0, 4),
    ['stdout', '  version=005  state=dirty_unresolved  ledger=recorded'],
    ...V2R2_STATUS_DISPOSED,
    ...V2R2_STATUS_SUCCESS_TAIL,
  ]);
  const kinds = trace.map(([k]) => k);
  const count = (k) => kinds.filter((x) => x === k).length;
  assert.equal(count('open'), 1, 'one client, opened once');
  assert.equal(count('dispose.requested'), 1, 'disposed once');
  assert.equal(count('ledger.read'), 1, 'the status read ran exactly once');
  assert.deepEqual(kinds.filter((k) => k.startsWith('catalog.')), ['catalog.audit', 'catalog.membership'],
    'the only statements are the two fixed fingerprint reads');
  assert.ok(!kinds.includes('FORBIDDEN'), 'no lock, transaction, SQL, ledger write, adoption write, ACL, owner or diagnostic port');
  assert.ok(!kinds.some((k) => k.startsWith('run.')), 'neither trusted runner: no baseline, no apply, no 005');
  assert.equal(w.calls.length, 0);
});

test('V2-R2/status: an unreadable ledger is refused in band, never reported as an empty ledger', async () => {
  const w = v2World({ argv: V2R2_STATUS_ARGV, ledger: V2_LEDGER_001_004, liveFails: true });
  assert.deepEqual(await v2Run('status', w), [
    ...V2R2_STATUS_PREFIX.slice(0, 7),
    ['session.terminate'],
    ...V2R2_STATUS_DISPOSED,
    ['stderr', '[migrate] REFUSED: status could not read the ledger: port_operation_failed'],
    ['exitCode', 2],
    ['stdout.write', '[migrate] status terminal: decision=refused cleanup=completed exit=failure code=none\n'],
    ['returned'],
    ['write.callback', 'ok'],
    ['exit', 2],
  ]);
  assert.equal(w.calls.length, 0);
});

test('V2-R2/status: a THROWN status operation fails closed — bounded output, disposal first, decision=failed, exit 2', async () => {
  // An orphan ledger row whose version is not a version label: the status classifier refuses it by
  // THROWING, inside the status branch, after the read — with a client open that must still be disposed.
  const corrupt = [...V2_LEDGER_001_004, Object.freeze({ version: '005; host=db.example', checksum: 'x', dirty: false })];
  const w = v2World({ argv: V2R2_STATUS_ARGV, ledger: corrupt });
  const trace = await v2Run('status', w);
  assert.deepEqual(trace, [
    ...V2R2_STATUS_PREFIX,
    ...V2R2_STATUS_DISPOSED,
    ['stderr', '[migrate] REFUSED: status refused before completion: migration_engine_pg_validation_required.'],
    ['exitCode', 2],
    ['stdout.write', '[migrate] status terminal: decision=failed cleanup=completed exit=failure code=none\n'],
    ['returned'],
    ['write.callback', 'ok'],
    ['exit', 2],
  ]);
  assert.ok(!JSON.stringify(trace).includes('db.example'), 'nothing from the corrupt row reaches a stream');
  assert.equal(w.calls.length, 0);
  // And before the client exists: the open throws, so there is nothing to dispose and no teardown record.
  const early = v2World({ argv: V2R2_STATUS_ARGV, ledger: V2_LEDGER_001_004, open: new Error('synthetic: dsn rejected host=db.example') });
  const earlyTrace = await v2Run('status', early);
  assert.deepEqual(earlyTrace, [
    ['open', 'status'],
    ['open.threw'],
    ['stderr', '[migrate] REFUSED: status refused before completion: migration_engine_pg_validation_required.'],
    ['exitCode', 2],
    ['stdout.write', '[migrate] status terminal: decision=failed cleanup=not_attempted exit=failure code=none\n'],
    ['returned'],
    ['write.callback', 'ok'],
    ['exit', 2],
  ]);
  assert.ok(!JSON.stringify(earlyTrace).includes('db.example'), 'no error message crosses the catch');
});

test('V2-R2/status: a FAILED teardown overrides an otherwise successful status', async () => {
  const w = v2World({ argv: V2R2_STATUS_ARGV, ledger: V2_LEDGER_001_004, teardown: V2_TEARDOWN_FAILED });
  assert.deepEqual(await v2Run('status', w), [
    ...V2R2_STATUS_PREFIX,
    ...V2R2_STATUS_REPORT_001_004,
    ['dispose.requested'],
    ['dispose.settled', false],
    ['stdout', '[migrate] status teardown: requested=true completed=false gracefulSocketClose=not_observed code=client_teardown_failed'],
    ['stderr', `[migrate] REFUSED: status: ${V2_TEARDOWN_TEAR_REFUSAL}`],
    ['exitCode', 2],
    ['stdout.write', '[migrate] status terminal: decision=refused cleanup=failed exit=failure code=client_teardown_failed\n'],
    ['returned'],
    ['write.callback', 'ok'],
    ['exit', 2],
  ]);
});

test('V2-R2/status: an invalid operation is rejected before any port or port getter is touched', async () => {
  const lookalikes = ['Status', 'STATUS', ' status', 'status ', 'status;', 'status\u0000', 'statu', 'status(up)', 'apply(down)',
    'apply', 'resolve-dirty', '005', '', 'toString', '__proto__', null, undefined, 0, true, Symbol('status'),
    new String('status'), { toString: () => 'status' }, ['status']];
  for (const op of lookalikes) {
    const w = v2World({ argv: V2R2_STATUS_ARGV, ledger: V2_LEDGER_001_004 });
    const t = v2r2TrappedPorts(w);
    await assert.rejects(runThroughManagedExecutor(op, t.ports),
      /^TypeError: managed run refused: unsupported operation or port set$/, String(op));
    assert.deepEqual(t.touched, [], `${String(op)}: no port, getter or property of the set was touched`);
    assert.deepEqual(w.trace, [], `${String(op)}: no port ran`);
  }
  // NON-VACUITY: the same trapped set with the one valid literal IS inspected — and runs status to completion.
  const w = v2World({ argv: V2R2_STATUS_ARGV, ledger: V2_LEDGER_001_004 });
  const t = v2r2TrappedPorts(w);
  await runThroughManagedExecutor('status', t.ports);
  w.trace.push(['returned']);
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
  assert.ok(t.touched.some(([k]) => k === 'trap'), 'the Proxy traps are live');
  assert.ok(t.touched.some(([k, n]) => k === 'getter' && n === 'openManagedExecutor'), 'the port getters are live');
  assert.deepEqual(w.trace, [...V2R2_STATUS_PREFIX, ...V2R2_STATUS_REPORT_001_004, ...V2R2_STATUS_DISPOSED, ...V2R2_STATUS_SUCCESS_TAIL]);
});

// Phase 4.0 M3 S4.1b — C2B-M005-B0
// THE SINGLE-PURPOSE MIGRATION-005 LAUNCHER.
//
// WHAT THIS IS FOR, AND WHY IT IS A SEPARATE FILE.
//   `scripts/managed-baseline-launcher.mjs` is the accepted parent for the historical BASELINE, and
//   its frozen argv is what makes migration 005 unreachable from it. The forward application of 005
//   needs the mirror-image property — a parent whose frozen argv makes 001-004, 006, `--baseline`,
//   `--status` and every reverse direction unreachable — and one launcher cannot hold both frozen
//   argvs without becoming a launcher with a mode selector. A mode selector is exactly the escape
//   hatch both files exist to remove, so this is a second file rather than a second branch.
//
//   The baseline launcher is NOT modified by this stage and is not imported for its flags. What IS
//   imported from it is the process-containment machinery that C2B-R3B-B0-R3 established and an
//   independent review accepted: `runChild` and the identity/scan/hold primitives it drives.
//   Re-deriving the most safety-critical code in the repository from scratch would add risk and no
//   property, and the stage brief permits reuse for that reason. `BASELINE_FLAGS` is deliberately
//   NOT among the imports.
//
// WHAT IT CANNOT DO, by construction rather than by check:
//   * it cannot select another version — the child argv carries no `--migration`, and the managed
//     apply path takes its version from `AUTHORIZED_APPLY_VERSION` in the CLI, not from argv;
//   * it cannot run backwards — no `--direction`, no `--down`, no `--allow-down`;
//   * it cannot run the baseline or a status — neither flag is in the frozen array;
//   * it cannot run another script — the script path is a module constant;
//   * it cannot reach production — `NODE_ENV=development` is a frozen gate value, and the CLI hard-
//     blocks production before anything else;
//   * it cannot be redirected by an operator argument — exactly one literal parent flag is accepted
//     and every other argv shape is refused before an environment is even read.
//
// THE OUTPUT BOUNDARY (§6).
//   Everything an operator sees leaves through ONE function. The baseline launcher redacts the
//   child's captured text and writes its own report lines directly; that is safe there only by the
//   convention that every one of its line producers interpolates a bounded value. Here the sink is
//   the property instead of the convention: launcher-authored lines and child-derived lines both go
//   through `safeLine`, and the report is built from an explicit field allowlist with a validator
//   per field, so a future edit that interpolates an observed string produces a rejected field
//   rather than a silent bypass.
//
// THE REDACTION CORRECTION (§6).
//   The baseline launcher applies every derived literal as an unrestricted substring replacement
//   with a >= 3 character floor. That floor sits BELOW the length at which a hostname label stops
//   being a common English substring, so a public-suffix label shredded the fixed vocabulary of the
//   one line the record exists to preserve — and the damaged template could then be differenced
//   against the source to recover the label exactly. Both halves are corrected here, and neither
//   correction weakens credential coverage:
//
//     * literals are TYPED. A raw literal (the DSN, the URL, the whole host, the project reference,
//       the certificate and its body lines, and every credential form) is still an unrestricted
//       substring replacement, with NO length floor for credentials. A token literal (an individual
//       hostname label) is replaced only where it stands as a whole token.
//     * a token literal that is a zero-entropy public suffix, or that collides with the protected
//       operational vocabulary, is DROPPED rather than anchored. Dropping discloses nothing: the
//       whole host, the whole DSN and the project reference remain raw literals, so the only thing
//       lost is a redundant partial match on material that is not secret.
//
// NOTHING HERE CONTACTS A DATABASE, READS A SECRET VALUE OUT, OR RUNS A MIGRATION. Importing this
// module spawns nothing and reads no file; only the entry guard at the foot starts a run.

import { createHash } from 'node:crypto';
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
  terminalReasonText,
  readExecEnvironment,
  runChild,
} from './managed-baseline-launcher.mjs';

// ---- identity of this launcher ----------------------------------------------

/**
 * The single literal parent argument. DELIBERATELY NOT `--execute`: the baseline launcher already
 * owns that token, and a copy-pasted command line naming the wrong script would otherwise be
 * accepted by whichever file it reached. A distinct flag makes that mistake a refusal.
 */
export const PARENT_FLAG = '--execute-m005';

/** The frozen child argv tail. No version, no direction, no mode, no caller input. */
export const M005_FLAGS = Object.freeze([
  '--managed-dev',
  '--apply',
  '--confirm-dev',
]);

/**
 * Tokens whose presence in the child argv would mean this launcher had grown a second purpose.
 * Asserted at run time as well as in the suite, so the file refuses rather than merely failing a
 * test someone might not have run.
 */
export const FORBIDDEN_CHILD_TOKENS = Object.freeze([
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
]);

export const M005_CODES = Object.freeze({
  OK: 'm005_launcher_ok',
  BAD_INVOCATION: 'm005_launcher_bad_invocation',
  ARGV_CONTRACT_VIOLATED: 'm005_launcher_argv_contract_violated',
  ARTIFACT_IDENTITY_REJECTED: 'm005_launcher_artifact_identity_rejected',
  REPORT_FIELD_REJECTED: 'm005_launcher_report_field_rejected',
  // The child did not deliver exactly one valid POST-CLEANUP terminal record, so nothing establishes
  // that it finished rather than being destroyed. Linux realtime signals 34, 40 and 64 reach this
  // launcher as `exitCode=0 signal=null` — byte-identical to a clean success — so neither
  // `result.signal` nor `result.exitCode` can separate the two. This is the only thing that can.
  TERMINAL_EVIDENCE_INCOMPLETE: 'm005_launcher_terminal_evidence_incomplete',
});

/**
 * The governed migration-005 artifacts and their SHA-256.
 *
 * The launcher neither executes nor interprets these; it verifies them so that a parent whose whole
 * purpose is "apply exactly 005" refuses before spawning when the 005 on disk is not the 005 that
 * was reviewed. The executor repeats the check UNDER THE ADVISORY LOCK, which is where it is
 * authoritative — this one closes the window between an operator reading the file and the run
 * starting, and it costs one hash of a 469-line file.
 */
export const M005_ARTIFACTS = Object.freeze([
  Object.freeze({
    rel: 'server/platform-identity/migrations/005_principal_separation_rls_foundation.up.sql',
    sha256: 'a4a61385beedf98194fb427bcd528704b068d7ca2947a9713d7a1a1c87157bda',
  }),
  Object.freeze({
    rel: 'server/platform-identity/migrations/005_principal_separation_rls_foundation.down.sql',
    sha256: 'c198c0fa9c481cb2fe99c7f841aba4023bfbbef06663e2948755abca1d74db64',
  }),
]);

// ---- the redaction correction -----------------------------------------------

/**
 * Fixed operational vocabulary a redaction literal may never damage.
 *
 * These are the words an operator reads to decide whether a migration committed, whether a lock is
 * held, and whether anything is still running. A record in which they are ambiguous is worse than
 * no record, because it still reads as a record. Entries are lowercase and matching is
 * case-insensitive, so the uppercase forms this launcher emits are covered by the same entries.
 */
export const PROTECTED_VOCABULARY = Object.freeze([
  'outcome', 'commit', 'committed', 'commits', 'connection', 'containment', 'account',
  'complete', 'incomplete', 'unknown', 'verified', 'unverified', 'closed', 'close',
  'code', 'status', 'group', 'session', 'cleanup', 'hold', 'lock', 'release', 'teardown',
  'migrate', 'migration', 'apply', 'evidence', 'readback', 'exit', 'signal',
  'true', 'false', 'none', 'com',
  // C2B-M005-B1-R3 — synchronized with the record the managed CLI actually emits. The rename to
  // `finalized=` and the new `ledger:` line moved the operator's words while this list stayed
  // where it was, so the words an operator reads to decide whether a durable ledger mutation
  // remains were unprotected — the exact hole this list exists to close.
  //
  // 'applied' was REMOVED, not merely left: it is emitted nowhere. It is not a key in any output
  // template and appears in no bounded executor, engine or launcher code value. A dead entry is
  // not free — every entry is a word that will never be redacted.
  //
  // WHY NOTHING HERE REACHES 12 CHARACTERS. At `TOKEN_RAW_PROMOTION_CHARS` a label is promoted to
  // RAW and never consults this list, so a longer entry could not protect anything and would only
  // remove a word from redaction. `acknowledged`, `cleanVerified`, `ddlMayHaveCommitted`,
  // `endpointFamily` and `gracefulSocketClose` are emitted and deliberately absent for that reason.
  // 'reason' joins the list with the terminal-evidence line: it names WHY completion could not be
  // established, and a colliding label that shredded that word would leave the operator with an
  // incomplete verdict and no stated cause.
  'reason',
  'adopted', 'attempt', 'attempted', 'audit', 'basename', 'clean', 'completed', 'database',
  'dirty', 'disposal', 'down', 'durable', 'env', 'finalized', 'host', 'ledger', 'lockrelease',
  'marker', 'markerwrite', 'mutation', 'names', 'node', 'not', 'observed', 'requested',
  'resolved', 'rollback', 'rows', 'sha', 'state', 'submitted', 'succeeded', 'unresolved',
  'version', 'versions', 'written',
  // C2B-M005-LRLS-L3-R3 — ELEVEN WORDS THE RECORD ALREADY EMITTED AND THIS LIST DID NOT COVER.
  //
  // Nine of them (`exitcode` … `sigterm`) are PRE-EXISTING and were hidden by a defect in the guard
  // that derives this coverage: it paired backticks with a regex across the whole file, so a single
  // unbalanced backtick shifted every span and most template literals were never scanned at all.
  // With the derivation corrected the guard sees 59 emitted keys where it used to see about 30, and
  // these nine were among the ones it had been missing — every one of them a word an operator reads
  // out of the containment record, and every one short enough to be shredded by a colliding
  // hostname label, which is the exact failure this list exists to prevent.
  //
  // `lines` and `truncated` are new here, from the discarded-transcript notice.
  //
  // NONE OF THE ELEVEN COSTS REAL COVERAGE. A protected word is one a hostname label may no longer
  // redact, so the question for each is what it would identify as a label — and the answer is
  // nothing: all eleven are generic process or output vocabulary, while the provider's project
  // reference is `[a-z0-9]{16,}` by grammar and is promoted to RAW well above this list's reach.
  'exitcode', 'handleonly', 'lines', 'members', 'overflowed', 'pgid', 'pid', 'sid',
  'sigkill', 'sigterm', 'truncated',
  // `overcap` joined them when the discard notice split one count into four. It was caught by the
  // corrected coverage guard rather than by review, which is the guard working as intended.
  'overcap',
  // C2B-M005-LRLS-L3-R4-R2 — THE POST-DECISION RECORD'S OWN WORDS.
  //
  // `decision` is the only one the derived coverage guard can demand: it is the sole new `key=` in
  // a scanned template literal. The other five are the record's LABEL and its VALUES, and they are
  // here for the same reason `observed`, `succeeded` and `written` already are — this list protects
  // the words an operator reads out of the record, not merely the keys it is indexed by. Losing
  // `failed` to a colliding hostname label would leave a verdict that says the run neither
  // succeeded nor did anything else nameable, which is worse than a redaction that never fired.
  'decision', 'terminal', 'success', 'refused', 'failed', 'failure',
]);

/**
 * Zero-entropy hostname labels. A public suffix identifies no project and protects nothing, and it
 * sits at exactly the length where a label collides with ordinary words.
 *
 * `com` also appears in PROTECTED_VOCABULARY. That is not redundancy for its own sake: the two
 * lists answer different questions ("is this worth redacting?" and "would redacting this destroy
 * meaning?"), and removing an entry from one should not silently change behaviour through the other.
 */
export const ZERO_ENTROPY_LABELS = Object.freeze([
  'com', 'net', 'org', 'io', 'co', 'dev', 'app', 'ai', 'sh', 'gov', 'edu', 'info', 'db', 'www',
]);

/**
 * A character that may sit next to a hostname label without the label being part of a longer word.
 *
 * LETTERS ONLY. A digit was originally treated as a non-boundary too, which left a numeric-suffixed
 * identifier (`slot_<ref>2`) uncovered for no benefit: the word-shredding this rule exists to stop
 * comes from letters, never from digits.
 */
const TOKEN_BOUNDARY = /[^A-Za-z]/;

/**
 * At and above this length a hostname label cannot collide with the protected vocabulary (whose
 * longest entry is 11 characters), so anchoring buys nothing and costs coverage: an identifier that
 * embeds the label inside a longer alphanumeric run would go unredacted. Long labels are therefore
 * promoted to RAW and matched without a boundary rule. The provider's project reference is
 * `[a-z0-9]{16,}` by grammar, so it is always on the RAW side of this line.
 */
const TOKEN_RAW_PROMOTION_CHARS = 12;

/**
 * Split the child environment into RAW and TOKEN redaction literals.
 *
 * RAW  — replaced anywhere they occur, no boundary rule, and NO length floor for credentials. A
 *        one-character password redacts every occurrence of that character and produces an
 *        obviously unusable record; a leaked one-character password produces a usable-looking one.
 *        The self-announcing failure is the safe one, and that reasoning is unchanged from the
 *        accepted baseline launcher.
 * TOKEN — hostname labels, replaced only where they stand as a whole token, and dropped entirely
 *         when zero-entropy or when they collide with the protected vocabulary.
 *
 * FAIL-CLOSED on an unparsable URL, for the same reason the baseline launcher refuses: continuing
 * would leave the whole-string literal as the only target, silently collapsing coverage of the
 * host, the user, the credential and the project reference with no signal that it had happened.
 */
export function classifySecrets(env) {
  const raw = [];
  const tokens = [];
  const addRaw = (v) => {
    if (typeof v !== 'string') return;
    const t = v.trim();
    if (t.length >= 3) raw.push(t);
  };
  const addCredential = (v) => { if (typeof v === 'string' && v !== '') raw.push(v); };
  const addToken = (v) => {
    if (typeof v !== 'string') return;
    const t = v.trim();
    const lower = t.toLowerCase();
    if (lower.length < 3) return;
    if (ZERO_ENTROPY_LABELS.includes(lower)) return;
    if (PROTECTED_VOCABULARY.includes(lower)) return;
    // A label long enough to be unambiguous keeps the OLD unrestricted coverage. Only short labels
    // — the ones that collide with ordinary words — pay the boundary rule.
    if (t.length >= TOKEN_RAW_PROMOTION_CHARS) { raw.push(t); return; }
    tokens.push(t);
  };
  const decode = (v) => {
    try {
      return decodeURIComponent(v);
    } catch {
      return v;
    }
  };

  for (const [name, value] of [
    ['SUPABASE_DATABASE_URL', env.SUPABASE_DATABASE_URL],
    ['SUPABASE_URL', env.SUPABASE_URL],
  ]) {
    if (typeof value !== 'string' || value === '') continue;
    addRaw(value);
    let url;
    try {
      url = new URL(value);
    } catch {
      throw new LauncherRefusal(LAUNCHER_CODES.CONFIG_UNPARSABLE, [name]);
    }
    // Lowercased too: `postgresql:` is not a WHATWG special scheme, so its host is not ASCII-
    // lowercased by the parser, while DNS and TLS error text report the lowercased name.
    for (const host of new Set([url.hostname, url.hostname.toLowerCase()])) {
      // The WHOLE host stays RAW — it is the complete hostname the governing rule protects, and it
      // is long enough that an unrestricted substring replacement damages nothing.
      addRaw(host);
      if (host.startsWith('[') && host.endsWith(']')) addRaw(host.slice(1, -1));
      // Labels are TOKEN class. The project reference is a label in both documented host shapes and
      // is at least 16 characters by its own grammar, so it survives every filter above and keeps
      // full coverage; what the filters remove is only the short, public, meaningless tail.
      for (const label of host.split('.')) addToken(label);
    }
    addRaw(url.host);
    if (url.origin !== 'null') addRaw(url.origin);
    for (const part of [url.username, url.password]) {
      if (part === '') continue;
      addCredential(part);
      addCredential(decode(part));
      addCredential(encodeURIComponent(decode(part)));
    }
  }

  const ca = env.DATABASE_CA_CERT;
  if (typeof ca === 'string' && ca !== '') {
    addRaw(ca);
    for (const line of ca.split(/\r?\n/)) {
      const t = line.trim();
      if (t !== '' && !/^-{5}(BEGIN|END)\b/.test(t) && t.length >= 8) addRaw(t);
    }
  }
  return Object.freeze({
    raw: Object.freeze([...new Set(raw)]),
    tokens: Object.freeze([...new Set(tokens)]),
  });
}

/**
 * Structural patterns for material NO environment-derived literal can match.
 *
 * The two address forms are the load-bearing ones and were missing from the first revision of this
 * file: a RESOLVED address appears nowhere in the child environment, so no derived literal can ever
 * cover it, and `connect ETIMEDOUT 203.0.113.7:5432` would have been emitted verbatim. The rule
 * names IP addresses explicitly, so this is a structural obligation rather than a nicety.
 */
const STRUCTURAL_SOURCES = Object.freeze([
  // A connection URI in any echoed form, credentials included.
  'postgres(?:ql)?:\\/\\/[^\\s"\'`]+',
  // IPv4, and an IPv6 run long enough not to match ordinary colon-separated text.
  '\\b\\d{1,3}(?:\\.\\d{1,3}){3}\\b',
  '\\b(?:[0-9a-fA-F]{1,4}:){2,7}(?::|[0-9a-fA-F]{1,4})\\b',
]);

/**
 * PEM blocks, found by PAIRING bounded markers rather than by one lazy span.
 *
 * `-----BEGIN X-----[\s\S]*?-----END X-----` is correct and QUADRATIC: every unmatched BEGIN makes
 * the lazy middle scan to end-of-input before failing, so a capture of nothing but BEGIN markers
 * costs O(k*n). The 64 KiB ceiling bounds it, but a redactor whose cost an adversarial child can
 * choose is not safe by construction. Both patterns below are bounded, so each scan is linear.
 *
 * This runs over the WHOLE captured block rather than per line — a certificate is multi-line by
 * definition, so a per-line scan can never see one.
 */
function pemRanges(src) {
  const begin = /-{5}BEGIN [A-Z0-9 ]+-{5}/g;
  const end = /-{5}END [A-Z0-9 ]+-{5}/g;
  const ends = [];
  for (let m = end.exec(src); m !== null; m = end.exec(src)) ends.push({ start: m.index, end: m.index + m[0].length });
  const out = [];
  let cursor = 0;
  for (let m = begin.exec(src); m !== null; m = begin.exec(src)) {
    if (m.index < cursor) continue;
    while (cursor < ends.length && ends[cursor].start < m.index) cursor += 1;
    if (cursor >= ends.length) break;
    out.push([m.index, ends[cursor].end]);
    begin.lastIndex = ends[cursor].end;
    cursor += 1;
  }
  return out;
}

/**
 * Build the typed redactor.
 *
 * Longest-first for the raw literals so a containing value is consumed before one of its own
 * substrings can split it; ranges are merged so two abutting hits render as one marker rather than
 * exposing their boundary.
 */
export function buildTypedRedactor({ raw, tokens }) {
  const rawSorted = [...raw].sort((a, b) => b.length - a.length);
  const tokenSorted = [...tokens].sort((a, b) => b.length - a.length);
  return (text) => {
    if (typeof text !== 'string' || text === '') return '';
    const ranges = [];
    const push = (start, end) => { if (end > start) ranges.push([start, end]); };

    for (const src of STRUCTURAL_SOURCES) {
      const re = new RegExp(src, 'gi');
      for (let m = re.exec(text); m !== null; m = re.exec(text)) {
        push(m.index, m.index + m[0].length);
        if (m[0].length === 0) re.lastIndex += 1;
      }
    }
    for (const [s, e] of pemRanges(text)) push(s, e);
    for (const lit of rawSorted) {
      let from = 0;
      for (let i = text.indexOf(lit, from); i !== -1; i = text.indexOf(lit, from)) {
        push(i, i + lit.length);
        // ADVANCE BY ONE, not by the match length: a value that overlaps ITSELF (`abab` inside
        // `ababab`) contributes both occurrences, and skipping past the first left the tail of the
        // second unredacted. Credentials have no length floor, so short periodic passwords are
        // exactly the reachable case.
        from = i + 1;
      }
    }
    // TOKEN class: the same scan plus the boundary test that IS the correction. A label is replaced
    // only where neither neighbour is an ASCII letter or digit, so it can never reach inside a
    // longer word — which is what turned `outcome=` into `out[REDACTED]e=`.
    const lower = text.toLowerCase();
    for (const lit of tokenSorted) {
      const needle = lit.toLowerCase();
      let from = 0;
      for (let i = lower.indexOf(needle, from); i !== -1; i = lower.indexOf(needle, from)) {
        const before = i === 0 ? '' : text[i - 1];
        const after = i + needle.length >= text.length ? '' : text[i + needle.length];
        if ((before === '' || TOKEN_BOUNDARY.test(before)) && (after === '' || TOKEN_BOUNDARY.test(after))) {
          push(i, i + needle.length);
        }
        from = i + needle.length;
      }
    }

    if (ranges.length === 0) return text;
    ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const merged = [];
    for (const r of ranges) {
      const last = merged[merged.length - 1];
      if (last !== undefined && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
      else merged.push([r[0], r[1]]);
    }
    let out = '';
    let cursor = 0;
    for (const [s, e] of merged) {
      out += text.slice(cursor, s) + '[REDACTED]';
      cursor = e;
    }
    return out + text.slice(cursor);
  };
}

// ---- the single bounded output boundary -------------------------------------

/** Hard ceiling on ONE emitted line. The 64 KiB capture ceiling is separate and unchanged. */
export const MAX_LINE_CHARS = 4096;

/**
 * Normalise a line before it is redacted and emitted.
 *
 * Control characters are replaced rather than escaped: a record read in a terminal must not be able
 * to carry cursor movement, a colour reset, or a carriage return that overwrites the line above —
 * all three are ways for child-derived text to rewrite what an operator sees the launcher say.
 */
export function safeLineText(value) {
  const s = typeof value === 'string' ? value : String(value ?? '');
  let out = '';
  let n = 0;
  for (const ch of s) {
    if (n >= MAX_LINE_CHARS) return `${out}…[TRUNCATED]`;
    const c = ch.codePointAt(0);
    // C0 **and C1**: an 8-bit-capable terminal treats U+009B as a CSI introducer, so stopping at
    // U+007F left the exact bypass this function exists to close. U+2028/U+2029 are line
    // terminators to a JavaScript consumer and would split one record into two.
    const unsafe = c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029;
    out += unsafe ? ' ' : ch;
    n += 1;
  }
  return out;
}

/**
 * THE operator-visible boundary. Two typed entry points over ONE redactor, because launcher-authored
 * text and child-derived text need opposite treatments and a single function cannot give both.
 *
 * ORDER: REDACT FIRST, then normalise and truncate. The reverse — which this file did originally —
 * truncates a secret that straddles the cap, leaving a prefix that no longer matches the literal and
 * is therefore emitted verbatim.
 *
 * `line` — a LAUNCHER-AUTHORED line, built from bounded fields and published verbatim in this
 *   source file. That publication makes any partial redaction inside it a KNOWN-PLAINTEXT ORACLE:
 *   the marker's position and the surviving text on either side identify the exact span, and
 *   differencing against the source recovers the literal. So a launcher line that matches ANYTHING
 *   is replaced whole, leaving no positional or length residue. This is the same defect class the
 *   token typing above fixes, on the surface the single-sink design newly exposed.
 *
 * `block` — the child's captured transcript, redacted as ONE multi-line string before it is split.
 *   Per-line redaction can never see a certificate, which is multi-line by definition, and it
 *   re-ran the whole redactor once per line at a cost the child chooses.
 */
export function createSafeSink(redact, emit) {
  const line = (text) => {
    const raw = typeof text === 'string' ? text : String(text ?? '');
    const redacted = redact(raw);
    emit(redacted === raw ? safeLineText(raw) : '[m005-launcher] [REDACTED LINE — a launcher-authored line matched protected material]');
  };
  // THE `block` ENTRY POINT IS GONE, AND ITS ABSENCE IS THE POINT.
  //
  // It existed to emit a child's transcript as one redacted unit, splicing `[REDACTED]` in place.
  // Every token those children emit is a compile-time constant published in this repository, so the
  // marker's POSITION inside a known template was a known-plaintext oracle: five synthetic passwords
  // produced five distinct records, each recovering its password exactly. No redactor can close
  // that, because a redactor is a function of the credential and everything it touches varies with
  // it. Every child transcript is now REBUILT from a closed grammar instead.
  //
  // Deleting the primitive rather than leaving it unused is deliberate: while it exists, a future
  // call site can reintroduce the whole class in one line. What remains redacts only
  // LAUNCHER-AUTHORED text, where the launcher chose every character.
  return line;
}

// ---- the canonical child transcript ------------------------------------------
//
// THE RULES LIVE IN THE BASELINE LAUNCHER; THE VOCABULARY LIVES HERE.
//
// Rebuilding a child's transcript from constants is identical work for every child, so the machinery
// is shared. The tables are not shared: this launcher's children speak a vocabulary the generic
// launcher is forbidden even to name, and a table that travelled with the machinery would carry that
// vocabulary into a file whose containment tests exist to keep it out.

import {
  B, COUNT_MAX, I, IU, LIST, MIGRATE_SPEC, RAT, S, SIU, U, createTranscriptGrammar,
} from './managed-baseline-launcher.mjs';

export const PREFLIGHT_TRANSCRIPT_TAGS = Object.freeze(['m005-preflight', 'acl-preflight']);

/** Value sets shared by several keys. Each is exact and finite; none is a shape test. */
const MATCH3 = S('MATCH', 'MISMATCH', 'UNREADABLE');
const TRI = S('ABSENT', 'PRESENT', 'UNREADABLE');
const BOOL3 = S('TRUE', 'FALSE', 'UNREADABLE');
const BOOLU = S('true', 'false', 'UNREADABLE');
const EXPOSURE = S('NONE_DETECTED', 'PRESENT', 'UNREADABLE');
const BASE_CATEGORY = S('GLOBAL_OVERRIDE', 'BUILTIN_RETAINED', 'UNREADABLE');

export const M005_PREFLIGHT_CODES_PINNED = Object.freeze([
  'm005_preflight_already_applied', 'm005_preflight_argv_rejected',
  'm005_preflight_backend_identity_changed', 'm005_preflight_checksum_mismatch',
  'm005_preflight_dirty_ledger', 'm005_preflight_evidence_unreadable',
  'm005_preflight_fingerprint_mismatch', 'm005_preflight_identity_unconfirmed',
  'm005_preflight_isolation_lost', 'm005_preflight_isolation_not_established',
  'm005_preflight_ledger_inconsistent', 'm005_preflight_observed_preconditions_met',
  'm005_preflight_observed_preconditions_not_met', 'm005_preflight_port_failed',
  'm005_preflight_production_forbidden', 'm005_preflight_read_only_lost',
  'm005_preflight_read_only_not_established', 'm005_preflight_residue_present',
  'm005_preflight_rollback_failed', 'm005_preflight_source_drift',
  'm005_preflight_target_invalid', 'm005_preflight_target_unconfirmed',
  'm005_preflight_teardown_failed',
]);

export const ACL_PREFLIGHT_CODES_PINNED = Object.freeze([
  'default_acl_preflight_argv_rejected', 'default_acl_preflight_backend_identity_changed',
  'default_acl_preflight_evidence_unreadable', 'default_acl_preflight_fingerprint_mismatch',
  'default_acl_preflight_identity_unconfirmed', 'default_acl_preflight_port_failed',
  'default_acl_preflight_posture_inconsistent', 'default_acl_preflight_posture_met',
  'default_acl_preflight_posture_unmet', 'default_acl_preflight_production_forbidden',
  'default_acl_preflight_read_only_lost', 'default_acl_preflight_read_only_not_established',
  'default_acl_preflight_rollback_failed', 'default_acl_preflight_surviving_blocker',
  'default_acl_preflight_target_invalid', 'default_acl_preflight_target_unconfirmed',
  'default_acl_preflight_teardown_failed',
]);

const PRIVILEGE_NAMES = Object.freeze([
  'SEL' + 'ECT', 'INS' + 'ERT', 'UPD' + 'ATE', 'DEL' + 'ETE', 'TRUN' + 'CATE',
  'REFER' + 'ENCES', 'TRIG' + 'GER',
]);

export const PREFLIGHT_PROSE_TAILS = Object.freeze([
  'B=NO is not authorization to migrate',
  'a separate authorization is required to execute it',
  'no repository source enables or forces RLS on the ledger relation and this run attributes the live state to no actor',
  'nothing is cleared, nothing is retried, no second connection is opened, and no resolution command is authorized or implemented',
  'the apply path must revalidate under its own advisory lock and pre-commit gate',
  'the constraint addition takes ACCESS EXCLUSIVE on its table at apply time residual=OPEN',
  'this preflight observes posture only and implements no repair',
]);

export const PREFLIGHT_SPACE_TAILS = Object.freeze([
  'describes what was observed now and proves nothing about a later grant',
]);

const TRANSCRIPT_CONSTANT_LINES = Object.freeze({
  'm005-preflight': Object.freeze([]),
  'acl-preflight': Object.freeze([]),
});

const LINE_LABELS = Object.freeze({
  'm005-preflight': Object.freeze([
    'acl', 'cleanup', 'constraint', 'database', 'ledgerColumnPrivilegeContribution',
    'ledgerDisableRlsExposure', 'ledgerEventTriggerMetadata', 'ledgerEventTriggerRelevance',
    'ledgerNonOwnerPrivilegeCounts', 'ledgerPolicies', 'ledgerPolicyTargets', 'ledgerRls',
    'ledgerRlsAuthority', 'ledgerStandardPrivileges', 'objects', 'policies', 'principal',
    'provider', 'resolution', 'rls', 'roles', 'target', 'transaction',
  ]),
  'acl-preflight': Object.freeze([
    'cleanup', 'database', 'principal', 'rowsBounded', 'target', 'transaction',
  ]),
});

const POSITIONAL_VALUES = Object.freeze({
  'm005-preflight': Object.freeze({
    ledgerNonOwnerPrivilegeCounts: S('UNREADABLE'),
    // ALL SEVEN, not the four the producer's filter emits today. `renderLedgerRepairSafety` is
    // exported and its list is not re-filtered at the render boundary, so the widest legitimate
    // output is the full privilege vocabulary. Seven exact members is still an exact set.
    ledgerColumnPrivilegeContribution: U(S('NONE'), LIST(...PRIVILEGE_NAMES)),
  }),
  'acl-preflight': Object.freeze({}),
});

const FIELD_DOMAINS = Object.freeze({
  'm005-preflight': Object.freeze({
    name: S('CONFIRM_SUPABASE_TARGET'),
    governedSource: MATCH3,
    outcome: S(...M005_PREFLIGHT_CODES_PINNED),
    disposition: S(...M005_PREFLIGHT_CODES_PINNED),
    endpointFamily: S('session', 'unrecognized'),
    database: S('EXPECTED'),
    readOnly: S('true'),
    isolation: S('repeatable_read'),
    currentMatchesSession: B,
    targetAgreement: B,
    applicationFingerprint: MATCH3,
    backendContinuity: S('AGREED', 'BROKEN', 'UNREADABLE'),
    dirtyMarker: TRI,
    rollback: S('not_required', 'completed', 'failed'),
    disposalRequested: B,
    disposalCompleted: B,
    gracefulSocketClose: S('not_observed', 'unknown'),
    // `enabled` is a Bool3 on the RLS line and a bounded count on the event-trigger line. The union
    // of two exact sets is still exact; it admits no value either line could not produce.
    enabled: U(BOOL3, I(50)),
    force: BOOL3,
    applicability: S('BYPASS_SUPERUSER_OR_BYPASSRLS', 'BYPASS_TABLE_OWNER', 'SUBJECT_TO_POLICIES', 'UNREADABLE'),
    activeForCurrent: BOOL3,
    currentIsSessionPrincipal: BOOL3,
    ownsLedger: BOOL3,
    ownerIsDatabaseOwner: BOOL3,
    superuser: BOOL3,
    bypassRls: BOOL3,
    readable: B,
    total: I(50),
    permissive: I(50),
    restrictive: I(50),
    commands: U(S('NONE'), LIST('ALL', 'SELECT', 'INSERT', 'UPDATE', 'DELETE')),
    // BOOL on the policy-targets line; a privilege list on the standard-privileges line.
    public: U(B, S('NONE'), LIST('SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER')),
    appliesToCurrent: B,
    onlyOtherRoles: B,
    withUsing: I(50),
    withCheck: I(50),
    standardPrivilegePosture: S('OWNER_ONLY', 'NON_OWNER_PRIVILEGE_PRESENT', 'UNREADABLE'),
    anyNonOwner: B,
    roleSetOverflowed: B,
    SELECT: I(200),
    INSERT: I(200),
    UPDATE: I(200),
    DELETE: I(200),
    TRUNCATE: I(200),
    REFERENCES: I(200),
    TRIGGER: I(200),
    bypassRlsRolesIncluded: B,
    superusersExcluded: B,
    presentlyReachableRoles: I(200),
    reachabilityIncludesDatabaseConnectAndSchemaUsage: B,
    incrementalExposure: EXPOSURE,
    newlyExposedRoles: I(200),
    newlyExposedReachable: I(200),
    publicGrantContributes: B,
    ledgerDisableRlsExposureScope: EXPOSURE,
    population: S('ALL_ENABLED', 'EVENT_COULD_FIRE'),
    wildcardTagged: I(50),
    alterTableTagged: I(50),
    extensionOwned: I(50),
    ownershipNotEstablished: I(50),
    potentiallyRelevant: I(50),
    relevantWildcardTagged: I(50),
    relevantAlterTableOnlyTagged: I(50),
    partitionReconciles: B,
    repairEventTriggerEffect: S('NONE_CATALOG_RELEVANT', 'UNRESOLVED'),
    ledgerRlsRepair: S('UNAUTHORIZED'),
    ledgerRlsEnablementProvenance: S('UNKNOWN'),
    preflightCompletion: S('DISTINCT_FROM_MIGRATION_AUTHORIZATION'),
    eventTriggerEffectOnM005: S('OPEN'),
    applySessionSearchPathContinuity: S('UNPROVEN'),
    providerManagedCompatibility: S('OPEN_MEDIUM'),
    lockAvailability: S('UNOBSERVED'),
    residual: S('OPEN'),
    migration005: S('UNAUTHORIZED', 'ABSENT', 'VALID', 'CHECKSUM_MISMATCH', 'DIRTY', 'DUPLICATE', 'UNREADABLE'),
    snapshotScope: S('ONE_INSTANT_ONLY'),
    publicCreate: BOOLU,
    publicTemporary: BOOLU,
    canCreateRole: BOOLU,
    schemaPublicPresent: BOOLU,
    schemaPublicAuthority: BOOLU,
    created: RAT(2),
    commentResidue: TRI,
    prerequisites: TRI,
    createdRolePrivilege: S('PREDICTED_FROM_SOURCE_AND_PUBLIC_PATHS'),
    notLiveTested: B,
    tables: RAT(6),
    authoritative: RAT(6),
    columns: RAT(13),
    sequences: IU(COUNT_MAX),
    enabledTables: RAT(6),
    enabledByM005: B,
    governedPresent: RAT(5),
    // AN ARITHMETIC DIFFERENCE, so it is the one count that can legitimately be negative.
    foreignOnGovernedTables: SIU(COUNT_MAX),
    policyFunction: BOOLU,
    governedNamesShadowedOutsidePublic: IU(COUNT_MAX),
    plpgsql: BOOLU,
    eventTriggersEnabled: IU(COUNT_MAX),
    present: TRI,
    incompatibleRows: IU(COUNT_MAX),
    compatible: BOOLU,
    ledgerShape: MATCH3,
    ledgerShapeCategories: U(S('NONE', 'UNREADABLE'), LIST(
      'RELATION_ABSENT', 'RELATION_KIND', 'ROW_LEVEL_SECURITY', 'COLUMN_MISSING', 'COLUMN_TYPE',
      'COLUMN_GENERATED_OR_IDENTITY', 'COLUMN_NULLABILITY', 'COLUMN_DEFAULT',
      'EXTRA_REQUIRED_COLUMN', 'UNDECLARED_CHECK', 'PRIMARY_KEY')),
    prefix001To004: MATCH3,
    checksums001To004: MATCH3,
    unknownOrOutOfOrder: TRI,
    overflowed: B,
    ledgerImpliedPlan: S('EXACT_005', 'NOT_EXACT_005', 'UNREADABLE'),
    informationalOnly: B,
    notARecommendation: B,
    globalTables: BASE_CATEGORY,
    globalSequences: BASE_CATEGORY,
    globalFunctions: BASE_CATEGORY,
    'A.currentPosture': S('MET', 'UNMET', 'UNREADABLE'),
    'B.blockerSurvivesCurrentM005': S('YES', 'NO', 'UNREADABLE'),
    findingCount: I(1000),
    aclNote: S('A_MET_IS_NOT_REQUIRED_MIGRATION_005_CHANGES_THE_POSTURE'),
    B: S('NO'),
    routinesOutsidePublic: IU(COUNT_MAX),
    creatableNonPublicSchemas: IU(COUNT_MAX),
    typesAndSchemasClasses: S('OUTSIDE_THIS_CONTRACT'),
    residue: S('CLEAN', 'PARTIAL_RESIDUE', 'ALREADY_APPLIED', 'INCONSISTENT', 'UNREADABLE'),
  }),
  // ---- the migration child -----------------------------------------------------------------
  //
  'acl-preflight': Object.freeze({
    name: S('CONFIRM_SUPABASE_TARGET'),
    endpointFamily: S('session'),
    database: S('postgres'),
    readOnly: S('true'),
    currentMatchesSession: B,
    targetAgreement: B,
    applicationFingerprint: S('MATCH', 'MISMATCH'),
    backendContinuity: S('AGREED', 'BROKEN'),
    limit: I(200),
    overflowed: B,
    principalAgreement: S('AGREED', 'MISMATCH', 'UNREADABLE'),
    'globalBase.tables': BASE_CATEGORY,
    'globalBase.sequences': BASE_CATEGORY,
    'globalBase.functions': BASE_CATEGORY,
    schemaGrantsToCoveredGrantees: S('PRESENT', 'NONE', 'UNREADABLE'),
    'A.currentDefaultAclPostcondition': S('MET', 'UNMET', 'UNREADABLE'),
    'B.blockerSurvivesCurrentM005': S('YES', 'NO', 'UNREADABLE'),
    findingCount: I(201),
    diagnosticCompletion: S('DISTINCT_FROM_MIGRATION_READINESS'),
    disposition: S(...ACL_PREFLIGHT_CODES_PINNED),
    outcome: S(...ACL_PREFLIGHT_CODES_PINNED),
    rollback: S('not_required', 'completed', 'failed'),
    disposalRequested: B,
    disposalCompleted: B,
    gracefulSocketClose: S('not_observed', 'unknown'),
  }),
});

/** Exact terminal vocabularies, pinned independently of the children. */
export const TERMINAL_OUTCOME_VOCABULARY = Object.freeze({
  'm005-preflight': M005_PREFLIGHT_CODES_PINNED,
  'acl-preflight': ACL_PREFLIGHT_CODES_PINNED,
});

const PREFLIGHT_GRAMMAR = createTranscriptGrammar({
  tags: PREFLIGHT_TRANSCRIPT_TAGS,
  noticePrefix: '[m005-launcher]',
  labels: LINE_LABELS,
  positional: POSITIONAL_VALUES,
  domains: FIELD_DOMAINS,
  constants: TRANSCRIPT_CONSTANT_LINES,
  proseTails: PREFLIGHT_PROSE_TAILS,
  spaceTails: PREFLIGHT_SPACE_TAILS,
  terminalVocabulary: TERMINAL_OUTCOME_VOCABULARY,
});

/** The declared key set per tag, exported so a test can drive EVERY field with hostile values. */
export const PREFLIGHT_FIELD_KEYS = PREFLIGHT_GRAMMAR.fieldKeys;

/** The one notice that stands in for everything discarded. Fixed text; only bounded counts vary. */
export const TRANSCRIPT_DISCARDED_TOKEN = PREFLIGHT_GRAMMAR.discardedToken;
/** Emitted instead of a transcript when stream closure was not proved. */
export const TRANSCRIPT_UNAVAILABLE_TOKEN = PREFLIGHT_GRAMMAR.unavailableToken;
/** Emitted when the capture itself could not be read, which is not the same as a silent child. */
export const TRANSCRIPT_STREAMS_UNREADABLE_TOKEN = PREFLIGHT_GRAMMAR.streamsUnreadableToken;

/**
 * The migration child's grammar, EXTENDED for the launcher that is allowed to name both constructs.
 *
 * The generic launcher builds the same grammar from the same spec, minus two entries it may not
 * mention: the mutation line's compensating-action flag, and the one executor code that names this
 * migration. Declaring them here loses nothing there and recovers both lines on the path that
 * actually emits them — an apply.
 */
const M005_MIGRATE_GRAMMAR = createTranscriptGrammar({
  ...MIGRATE_SPEC,
  noticePrefix: '[m005-launcher]',
  // THIS launcher's child argv is `--managed-dev --apply`, and the managed direction resolver can
  // only ever return 'up', so its child enters `runThroughManagedExecutor` with op `apply(up)`. The
  // generic spec declares the BASELINE operation; requiring the right one here is what stops a
  // completion record for an operation this launcher never requested from being read as its own.
  labelledTerminal: Object.freeze({
    migrate: Object.freeze({ ...MIGRATE_SPEC.labelledTerminal.migrate, op: 'apply(up)' }),
  }),
  domains: Object.freeze({
    migrate: Object.freeze({
      ...MIGRATE_SPEC.domains.migrate,
      rollback_observed: B,
      code: U(MIGRATE_SPEC.domains.migrate.code, S('baseline_pre005_residue')),
    }),
  }),
});

/** Render the migration child's transcript. Nothing raw is ever forwarded. */
export function renderM005MigrateTranscript(stdoutText, stderrText, streamsClosed) {
  return M005_MIGRATE_GRAMMAR.renderTranscript(stdoutText, stderrText, streamsClosed);
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
  return M005_MIGRATE_GRAMMAR.labelledTerminal(text, MIGRATE_TAG, closed);
}

/**
 * THE ONE DISPOSITION, used by the printed record AND by the process exit code.
 *
 * These were two expressions saying the same thing, and a mutation could drop a conjunct from one
 * while the other still reported it — a run that PRINTS `terminal_evidence_incomplete` and exits 0.
 *
 * `&& normalCompletion(result)` USED TO STAND IN THE EXIT EXPRESSION AND WAS REDUNDANT: `outcomeCode`
 * returns OK only after `normalCompletion` has already passed, so the conjunct could never be the
 * thing that failed. Two expressions of one requirement mask each other — dropping either leaves
 * every test green — so the requirement is stated once, where a mutation to it changes an outcome.
 */
export function dispositionFor(result) {
  const terminal = terminalEvidenceFor(result);
  const derived = outcomeCode(result);
  const code = derived === LAUNCHER_CODES.OK && !terminal.ok
    ? M005_CODES.TERMINAL_EVIDENCE_INCOMPLETE
    : derived;
  return Object.freeze({ terminal, code, exitCode: code === LAUNCHER_CODES.OK ? 0 : 2 });
}

/** Exported for the deterministic suite. */
export function canonicalM005MigrateLine(raw) {
  return M005_MIGRATE_GRAMMAR.canonicalLine(raw);
}

/** Canonicalise one child line, or return null to discard it. */
export function canonicalPreflightLine(raw) {
  return PREFLIGHT_GRAMMAR.canonicalLine(raw);
}

/** Render a preflight child's transcript as bounded, already-safe operator lines. */
export function renderPreflightTranscript(stdoutText, stderrText, streamsClosed) {
  return PREFLIGHT_GRAMMAR.renderTranscript(stdoutText, stderrText, streamsClosed);
}

/** Decide whether the child delivered exactly one valid terminal completion record. */
export function terminalCompletion(stdoutText, tag, streamsClosed) {
  return PREFLIGHT_GRAMMAR.terminalCompletion(stdoutText, tag, streamsClosed);
}

export {
  MAX_ITEM_SEGMENTS, MAX_LINE_ITEMS, MAX_TRANSCRIPT_LINES,
  TERMINAL_EVIDENCE_REASONS, TERMINAL_OUTCOME_KEY, UNRECOGNIZED_TERMINAL_REASON,
} from './managed-baseline-launcher.mjs';

// ---- the bounded report ------------------------------------------------------

/** Marks where the child's transcript belongs, so the sink can treat it as one redacted block. */
export const CHILD_BLOCK_SENTINEL = '\u0000m005-child-transcript\u0000';

/** Field validators. A field that fails its validator is REPLACED, never emitted unchecked. */
const FIELD = Object.freeze({
  /**
   * A boolean, VALIDATED rather than coerced.
   *
   * Every call site used to read `FIELD.bool(x === true)`, so this validator only ever saw an
   * already-computed boolean and could never reject anything: a malformed observed flag rendered as
   * `false` — a FABRICATED observation, and one that reads as "close was not observed". An ABSENT
   * optional flag is genuinely false (the lifecycle sets these only when true), so the undefined
   * case is normalised here rather than at each call site.
   */
  bool: (v) => (v === undefined || v === false ? 'false' : v === true ? 'true' : M005_CODES.REPORT_FIELD_REJECTED),
  int: (v) => (Number.isSafeInteger(v) && v >= 0 && v <= 4294967295 ? String(v) : M005_CODES.REPORT_FIELD_REJECTED),
  /** A bounded enumerated code: a lowercase identifier shape, and nothing else. */
  code: (v) => (typeof v === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(v) ? v : M005_CODES.REPORT_FIELD_REJECTED),
  intOrNone: (v) => (v === null || v === undefined ? 'none' : FIELD.int(v)),
});

/**
 * Build the operator record from BOUNDED FIELDS ONLY.
 *
 * Nothing observed is interpolated as a bare string: every value goes through a validator that
 * either returns a canonical rendering or a rejection marker. That is what makes the sink's
 * guarantee a property of this function rather than a convention its callers must remember — an
 * edit that adds `${someDriverString}` produces a rejected field, not a leak.
 */
export function renderM005Report(result, disposition = dispositionFor(result)) {
  const lines = [];
  const id = result.identity ?? null;
  const g = result.group ?? UNOBSERVED;
  const c = result.cleanup ?? {};

  lines.push(`[m005-launcher] status=${FIELD.code(result.status)}`);
  lines.push(
    `[m005-launcher] exitCode=${FIELD.intOrNone(result.exitCode)} ` +
      `signal=${result.signal ? FIELD.code(String(result.signal).toLowerCase()) : 'none'}`,
  );
  lines.push(
    id === null || id === undefined
      ? '[m005-launcher] managedGroup verified=false'
      : `[m005-launcher] managedGroup verified=true pid=${FIELD.int(id.pid)} pgid=${FIELD.int(id.pgid)} sid=${FIELD.int(id.sid)}`,
  );
  lines.push(
    `[m005-launcher] group observed=${FIELD.bool(g.available)} ` +
      `members=${FIELD.intOrNone(g.groupMembers)} sessionMembers=${FIELD.intOrNone(g.sessionMembers)} ` +
      `observationLost=${FIELD.bool(result.observationLost)}`,
  );
  if (CLEANUP_STATUSES.has(result.status) || result.containmentHold === true) {
    lines.push(
      `[m005-launcher] cleanup sigterm=${FIELD.code(String(c.term ?? 'unknown'))} ` +
        `sigkill=${FIELD.code(String(c.kill ?? 'unknown'))} ` +
        `closeObserved=${FIELD.bool(c.closeObserved)} ` +
        `handleOnly=${FIELD.bool(c.handleOnly)} ` +
        `signalFailed=${FIELD.bool(c.signalFailed)}`,
    );
  }
  lines.push(`[m005-launcher] normalCompletion=${FIELD.bool(normalCompletion(result))}`);
  // STATED IMMEDIATELY BESIDE THE FIELDS THAT CANNOT ESTABLISH IT. `exitCode=0 signal=none` is
  // exactly what a child destroyed by realtime signal 34, 40 or 64 reports, so those fields are not
  // evidence of completion. This line is the positive evidence, or the named reason there is none.
  lines.push(
    `[m005-launcher] terminalEvidence=${FIELD.code(disposition.terminal.ok ? 'complete' : 'incomplete')} `
      + `reason=${FIELD.code(terminalReasonText(disposition.terminal.reason))}`,
  );
  lines.push(`[m005-launcher] containmentHold=${FIELD.bool(result.containmentHold)}`);
  // The residuals this launcher inherits and does not close. Stated on EVERY run, because a
  // containment claim without its scope is the part an operator would otherwise have to remember.
  lines.push(
    '[m005-launcher] containment scope: PGID/SID observation covers descendants that REMAIN in the '
      + 'managed group or session; a descendant that calls setsid() escapes both (OPEN/LOW), and '
      + 'scan-to-signal is not atomic (OPEN/LOW)',
  );
  lines.push(
    '[m005-launcher] graceful database-socket close observability: NOT OBSERVED by this launcher (OPEN/LOW)',
  );
  if (result.capture !== undefined && result.capture !== null) {
    // OVERFLOW IS A SEPARATE BRANCH, NOT A FLAG ON THE TRANSCRIPT HEADER.
    //
    // The capture discards outright past its ceiling; it never truncates. The previous header said
    // "may be truncated", which named a mechanism this design deliberately does not have, and it
    // was emitted on the overflow path together with an empty block and a trailing disclaimer —
    // three lines about a transcript that does not exist. On overflow the record must carry ONE
    // fixed compile-time code and nothing else: no header, no block sentinel, no disclaimer, and
    // above all no byte count. `capture.byteLength` is the number of bytes the child produced,
    // which is derived from the material that was discarded, so printing it would reintroduce a
    // measurement of the secret the discard exists to destroy.
    //
    // FAIL-CLOSED ON THE FLAG ITSELF: anything that is not exactly `false` is treated as overflow,
    // so a malformed or absent flag suppresses the transcript rather than releasing it.
    if (result.capture.overflowed !== false) {
      lines.push(
        `[m005-launcher] ${LAUNCHER_CODES.OUTPUT_LIMIT_EXCEEDED} — the captured output exceeded the `
          + 'aggregate ceiling and was discarded unread; no part of it is reported',
      );
    } else {
      lines.push(
        '[m005-launcher] captured child output follows; it is UNVERIFIED. '
          + `overflowed=${FIELD.bool(result.capture.overflowed)}`,
      );
      // A SENTINEL, not the text. The transcript is child-derived and must be redacted as one
      // multi-line block by the sink; splicing it into this array would make it indistinguishable
      // from the launcher's own lines, which are treated the opposite way.
      lines.push(CHILD_BLOCK_SENTINEL);
      // The child's own claims are the child's. Stated AFTER the transcript so it is the last thing
      // read, and worded so no redaction literal can collide with it (see PROTECTED_VOCABULARY).
      lines.push(
        "[m005-launcher] every claim in the captured output above is the CHILD's own and is NOT "
          + 'independently established by this launcher',
      );
    }
  }
  lines.push(
    `[m005-launcher] outcome=${FIELD.code(
      disposition.code === LAUNCHER_CODES.OK ? M005_CODES.OK : disposition.code,
    )}`,
  );
  return lines;
}

// ---- argv / artifact preflight ----------------------------------------------

/** Prove the frozen child argv is the single-purpose one. Throws rather than returning a flag. */
export function assertChildArgvContract(args) {
  const problems = [];
  if (!Object.isFrozen(args)) problems.push('argv_not_frozen');
  if (args[0] !== TSX_CLI) problems.push('tsx_cli');
  if (args[1] !== MIGRATE_SCRIPT) problems.push('migrate_script');
  const tail = args.slice(2);
  if (tail.length !== M005_FLAGS.length || tail.some((t, i) => t !== M005_FLAGS[i])) problems.push('flags');
  for (const token of FORBIDDEN_CHILD_TOKENS) {
    if (args.some((a) => a === token || String(a).startsWith(`${token}=`))) problems.push(token);
  }
  if (problems.length > 0) throw new LauncherRefusal(M005_CODES.ARGV_CONTRACT_VIOLATED, problems);
}

/**
 * Prove the governed 005 artifacts are byte-identical to the reviewed ones, BEFORE spawning.
 *
 * `readFileSync` is resolved lazily so that importing this module performs no filesystem work at
 * all — the entry-guard property the deterministic suite asserts.
 */
export async function assertM005Artifacts(readFile) {
  const read = readFile ?? (await import('node:fs')).readFileSync;
  const bad = [];
  for (const a of M005_ARTIFACTS) {
    let digest;
    try {
      digest = createHash('sha256').update(read(join(REPO_ROOT, a.rel))).digest('hex');
    } catch {
      bad.push(a.rel);
      continue;
    }
    if (digest !== a.sha256) bad.push(a.rel);
  }
  if (bad.length > 0) throw new LauncherRefusal(M005_CODES.ARTIFACT_IDENTITY_REJECTED, bad);
}

// ---- entry point -------------------------------------------------------------

/**
 * `deps` exists ONLY so the deterministic suite can drive every path without a real process, a real
 * timer or a real filesystem. The entry guard calls `main()` with no arguments, so nothing an
 * operator can type reaches any seam.
 */
export async function main(argv = process.argv.slice(2), source = process.env, deps = {}) {
  const emit = deps.out ?? ((line) => console.log(line));
  const emitErr = deps.err ?? ((line) => console.error(line));

  // Exactly one literal argument. An ignored extra argument is how a launcher grows an escape
  // hatch, so a second one is a refusal rather than a warning.
  if (argv.length !== 1 || argv[0] !== PARENT_FLAG) {
    emitErr(`[m005-launcher] REFUSED: ${M005_CODES.BAD_INVOCATION}`);
    return 2;
  }

  let env;
  let sink;
  try {
    if (deps.assertContainment) deps.assertContainment();
    else assertContainmentPreconditions();
    assertStartupSensitiveAbsent(deps.readExecEnv ? deps.readExecEnv() : readExecEnvironment());
    env = buildChildEnv(source);
    // Built INSIDE the guarded block: an unparsable DSN refuses here rather than producing a
    // silently incomplete redactor that would then be trusted for the whole run.
    sink = createSafeSink(buildTypedRedactor(classifySecrets(env)), emit);
    // FINAL exact-set assertion, immediately before anything else is built from the environment.
    assertChildEnv(env);
    await assertM005Artifacts(deps.readFile);
  } catch (e) {
    const code = e instanceof LauncherRefusal ? e.code : M005_CODES.BAD_INVOCATION;
    const names = e instanceof LauncherRefusal ? e.names : [];
    // The refusal path necessarily predates the sink — the redactor may be the thing that failed —
    // so it emits NAMES and a code only, never a value and never the Error's own message.
    emitErr(safeLineText(`[m005-launcher] REFUSED: ${code}${names.length > 0 ? ` names=${names.join(',')}` : ''}`));
    return 2;
  }

  const args = Object.freeze([TSX_CLI, MIGRATE_SCRIPT, ...M005_FLAGS]);
  try {
    assertChildArgvContract(args);
  } catch (e) {
    const names = e instanceof LauncherRefusal ? e.names : [];
    emitErr(safeLineText(`[m005-launcher] REFUSED: ${M005_CODES.ARGV_CONTRACT_VIOLATED} names=${names.join(',')}`));
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

  // ONE CALL. The record, the printed outcome and the process exit code are three consumers of a
  // single `dispositionFor` result, so `terminal_evidence_incomplete` cannot coexist with exit 0.
  //
  // INSIDE THE TRY, not before it. Computing it above this block put one expression outside the only
  // guard that guarantees the containment hold runs: `outcomeCode` reads `result.capture.overflowed`
  // unguarded, so a malformed result threw there and `enterHoldIfRequiredM005` — the supervisor for a
  // descendant that may still be alive — was never installed. The exit code was still non-zero, which
  // is exactly what makes it dangerous: the status certified a containment that never engaged.
  let disposition = Object.freeze({
    terminal: Object.freeze({ ok: false, reason: 'not_computed', code: null }),
    code: M005_CODES.TERMINAL_EVIDENCE_INCOMPLETE,
    exitCode: 2,
  });

  // REPORTING IS WRAPPED so a failure while writing the record cannot skip the hold.
  try {
    disposition = dispositionFor(result);
    for (const line of renderM005Report(result, disposition)) {
      if (line !== CHILD_BLOCK_SENTINEL) { sink(line); continue; }
      // THE LAST REDACTOR-BACKED CHILD PATH, CLOSED. This read `capture.text()` — the arrival-ordered
      // INTERLEAVE of both pipes, ungated by the seal — and handed it to `sink.block`, which splices
      // `[REDACTED]` into published template text. The migration child interpolates raw messages into
      // three of its lines, so a driver string or an Error reached the record whenever it happened
      // not to contain a configured secret. The two streams are now read apart, only after closure is
      // proved, and every line is rebuilt from a closed grammar or discarded and counted.
      for (const rendered of renderM005MigrateTranscript(
        result.capture?.streamText?.('stdout'),
        result.capture?.streamText?.('stderr'),
        result.streamsClosed === true,
      )) sink(rendered);
      continue;
    }
  } finally {
    enterHoldIfRequiredM005(result, sink, deps);
  }

  return disposition.exitCode;
}

/**
 * Enter the referenced containment hold when the run did not prove terminal cleanup.
 *
 * Identical in contract to the accepted baseline hold: no handle release, no `process.exit`, a
 * REFERENCED interval so the event loop cannot drain while a managed process may still be alive,
 * and exactly one bounded notice. It is a separate function here only because the message and the
 * sink are this launcher's own.
 */
export function enterHoldIfRequiredM005(result, sink, deps = {}) {
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

// Entry guard: importing this module must spawn nothing and read no file.
//
// EXACT PATH IDENTITY, not a suffix test. A suffix test is satisfied by ANY entry script whose name
// merely ends in this one — `x-managed-m005-launcher.mjs` would import this module for its exports
// and start a real managed apply as a side effect. The accepted baseline parent already uses this
// stronger form; matching it is what makes "importing this module spawns nothing" true for every
// entry point rather than for the expected one.
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

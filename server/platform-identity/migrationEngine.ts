// Phase 4.0 M3 S1/S1.1 — Deterministic, database-FREE migration-engine contract.
//
// SCOPE / TRUTH (binding):
//   - This module contains NO database import. It never opens a connection, reads a
//     connection string, imports a provider SDK, or executes SQL. Every operation that
//     would touch a database is expressed as an INJECTED PORT (ReservedSessionAdapter,
//     MigrationLedgerPort); S1b supplies the real, disposable-PostgreSQL implementations.
//   - Discovery, checksums, descriptor validation, state modelling, and plan/status/
//     baseline/dirty-resolution planning are PURE. The choreography executor operates
//     only through the injected ports, so the whole engine is exercised with fakes.
//   - Migration APPLY is fail-closed at the CLI (scripts/supabase-migrate.ts) until S1b's
//     real-PostgreSQL and CI proof lands. This module models the choreography so the
//     contract is tested; it does not by itself run schema SQL.
//   - Historical migration bytes are never mutated. Checksums are SHA-256 over the EXACT
//     file bytes with NO newline normalization. Production migrations are forward-only
//     (D1): a committed migration is never edited; recovery is a new forward migration.
//   - FILESYSTEM INTEGRITY (S1.1): only REGULAR files are accepted — symlinks,
//     directories, FIFOs, sockets, and devices are rejected (lstat / O_NOFOLLOW, never
//     following a link). The migration root is canonicalized once and every entry is
//     containment-checked against it with a path-separator boundary (no prefix
//     confusion). Bytes are read ONCE into an immutable MigrationArtifact; the checksum
//     is computed over those exact bytes; execution receives that same artifact and
//     NEVER reopens the path — a file mutated after discovery cannot change what runs.
//     UTF-8 decoding is strict (fatal) and deterministic; invalid encoding fails closed.
//
// SECURITY: bounded, secret-safe errors only — a MigrationEngineError carries a stable
// code and a message referencing version/direction/basename, never SQL text, file
// contents, an absolute path, a credential value, a connection string, or a provider
// identifier. Errors thrown by injected ports are converted at the boundary to a bounded
// `port_operation_failed` code so a schema or driver message can never leak through.
// SQL text lives ONLY on the execution artifact — status output, plans' printable
// fields, ledger records, and errors never carry it. This module logs NOTHING.

import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import {
  readdirSync,
  readFileSync,
  lstatSync,
  openSync,
  closeSync,
  fstatSync,
  realpathSync,
  Stats,
  constants as fsConstants,
} from 'node:fs';

// ---------------------------------------------------------------------------
// INTRINSICS RESOLVED AND BOUND AT MODULE LOAD, before any caller code in this realm can run.
//
// Every operation below sits on a validation, isolation, freezing, sanitization, or
// exception-containment path, and every one is a MUTABLE global. Reading a mutable global at call
// time IS a hidden-state read, so binding them is what makes this module a function of its inputs.
// None is a provenance, origin, or authority mechanism: they are pure operations, resolved once.
//
// Binding a METHOD is only sound when the method does not itself re-dispatch through the receiver.
// `RegExp.prototype.test` DOES — it performs Get(regexp, 'exec') and calls it — so binding `test`
// binds nothing that matters, and re-pointing `RegExp.prototype.exec` would make every character-
// domain check accept. Regex is therefore NOT used for any canonical domain check; the validators
// below are explicit character loops over bound `charCodeAt`, which re-dispatches through nothing.
//
// Residual, deliberately out of scope: an attacker who patches an intrinsic BEFORE this module is
// imported already owns the realm.
// ---------------------------------------------------------------------------
const ownKeysOf = Reflect.ownKeys;
const descriptorOf = Object.getOwnPropertyDescriptor;
const defineProp = Object.defineProperty;
const freeze = Object.freeze;
const keysOf = Object.keys;
const objectCreate = Object.create;
const isArray = Array.isArray;
const isSafeInteger = Number.isSafeInteger;
const hasOwn = Function.prototype.call.bind(Object.prototype.hasOwnProperty) as (o: object, k: string) => boolean;
const charAt = Function.prototype.call.bind(String.prototype.charCodeAt) as (s: string, i: number) => number;
const fromChar = String.fromCharCode;
const utf8Encode = Function.prototype.call.bind(TextEncoder.prototype.encode) as (e: TextEncoder, s: string) => Uint8Array;
// CONSTRUCTORS captured by REFERENCE (S1.7F). The global `Array` / `Set` / `Uint8Array` lookups are
// LIVE GLOBAL LOOKUPS, and `new F(x)` where F returns an object yields THAT object — so re-pointing
// the global handed the engine an attacker-owned container to write its results into. A module-local
// const cannot be re-pointed. Array LITERALS resolve %Array% directly and need no binding, so they
// replace `new Array(n)` everywhere below.
const SetCtor = Set;
const MapCtor = Map;
const U8 = Uint8Array;
// PROTOTYPE METHODS bound once. Each decides a security outcome — set membership decides duplicate
// rejection and known-version admission; map lookup decides pairing; sort decides apply ORDER — and
// each is an overridable prototype property, so a call-time lookup is a hidden-state read. None of
// them re-dispatches through the receiver (they act on internal slots, or on plain elements), so
// binding them binds what actually runs.
const setAdd = Function.prototype.call.bind(Set.prototype.add) as (s: Set<never>, v: unknown) => unknown;
const setHas = Function.prototype.call.bind(Set.prototype.has) as (s: Set<never>, v: unknown) => boolean;
const mapGet = Function.prototype.call.bind(Map.prototype.get) as (m: Map<never, never>, k: unknown) => unknown;
const mapSet = Function.prototype.call.bind(Map.prototype.set) as (m: Map<never, never>, k: unknown, v: unknown) => unknown;
const mapHas = Function.prototype.call.bind(Map.prototype.has) as (m: Map<never, never>, k: unknown) => boolean;
const arraySort = Function.prototype.call.bind(Array.prototype.sort) as <T>(a: T[], cmp: (x: T, y: T) => number) => T[];
// SHA-256 is the sole arbiter of the sql-to-checksum binding, and `createHash(x).update(y).digest(z)`
// resolves BOTH methods on Hash.prototype at CALL time. Patching `digest` after import therefore
// turned canonicalSql into a no-op: arbitrary SQL could be paired with an attacker-chosen checksum.
// The factory is captured by value and both methods are bound at load, so the call site dispatches
// through nothing a caller can re-point. Neither method re-dispatches through the receiver.
const makeHash = createHash;
const HASH_PROTO = Object.getPrototypeOf(makeHash('sha256')) as { update: unknown; digest: unknown };
const hashUpdate = Function.prototype.call.bind(HASH_PROTO.update as (this: object, d: Uint8Array) => unknown) as (h: object, d: Uint8Array) => unknown;
const hashDigest = Function.prototype.call.bind(HASH_PROTO.digest as (this: object, e: string) => string) as (h: object, e: string) => string;
const utf8Decode = Function.prototype.call.bind(TextDecoder.prototype.decode) as (d: TextDecoder, b: Uint8Array) => string;
const strSlice = Function.prototype.call.bind(String.prototype.slice) as (s: string, a: number, b?: number) => string;
// `fs.Stats.prototype.isFile/isDirectory/isSymbolicLink` are writable AND configurable, and they are
// the module's own "only REGULAR files are accepted" control. Left as live dispatch, patching them
// made a directory, FIFO, socket, or device classify as a regular file — and the same patch also
// neutralised the second gate on the OPENED descriptor. O_NOFOLLOW still stops a symlink at open,
// but a FIFO opened under O_NONBLOCK is not covered by that residual, so the predicates are bound.
const statIsFile = Function.prototype.call.bind(Stats.prototype.isFile) as (s: object) => boolean;
const statIsDirectory = Function.prototype.call.bind(Stats.prototype.isDirectory) as (s: object) => boolean;
const statIsSymbolicLink = Function.prototype.call.bind(Stats.prototype.isSymbolicLink) as (s: object) => boolean;
/** Hard CEILING on any caller-declared collection length at an exported boundary. A safe integer is
 *  not by itself a bounded amount of work: without this, a declared length of 5,000,000 made the
 *  engine walk an attacker-chosen number of iterations. Far above any real migration history. */
const MAX_BOUNDED_LENGTH = 65536;

/** Membership by a PLAIN LOOP and `===`, never `Array.prototype.includes/indexOf`: those are mutable
 *  intrinsics and every use here is a domain check, so re-pointing one would make it accept. */
function containsValue(values: readonly string[], value: string): boolean {
  for (let i = 0; i < values.length; i += 1) if (values[i] === value) return true;
  return false;
}

/** Bounded, non-empty decimal-digit string — the canonical version grammar, without regex. */
function isDigitString(s: unknown, max: number): s is string {
  if (typeof s !== 'string' || s.length === 0 || s.length > max) return false;
  for (let i = 0; i < s.length; i += 1) { const c = charAt(s, i); if (c < 48 || c > 57) return false; }
  return true;
}

/** EXACTLY `len` lowercase hex digits — the full SHA-256 output shape, without regex. */
function isLowerHex(s: unknown, len: number): s is string {
  if (typeof s !== 'string' || s.length !== len) return false;
  for (let i = 0; i < len; i += 1) {
    const c = charAt(s, i);
    if (!((c >= 48 && c <= 57) || (c >= 97 && c <= 102))) return false;
  }
  return true;
}

/** 1..max LOWERCASE HEX digits — the SHORT form a ledger row or a test value may carry. */
function isLowerHexBounded(s: unknown, max: number): s is string {
  if (typeof s !== 'string' || s.length === 0 || s.length > max) return false;
  for (let i = 0; i < s.length; i += 1) {
    const c = charAt(s, i);
    if (!((c >= 48 && c <= 57) || (c >= 97 && c <= 102))) return false;
  }
  return true;
}

/** Every character is printable ASCII (0x20..0x7e). */
function isPrintableAscii(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) { const c = charAt(s, i); if (c < 0x20 || c > 0x7e) return false; }
  return true;
}

/** Bounded path-shaped label: `A-Z a-z 0-9 . _ - /`. */
function isRelDirString(s: unknown, max: number): s is string {
  if (typeof s !== 'string' || s.length === 0 || s.length > max) return false;
  for (let i = 0; i < s.length; i += 1) {
    const c = charAt(s, i);
    const ok = (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57)
      || c === 46 || c === 95 || c === 45 || c === 47;                       // . _ - /
    if (!ok) return false;
  }
  return true;
}

/** Bounded canonical time literal: `0-9 T Z : . + -` and space. */
function isTimeLiteral(s: unknown, max: number): s is string {
  if (typeof s !== 'string' || s.length === 0 || s.length > max) return false;
  for (let i = 0; i < s.length; i += 1) {
    const c = charAt(s, i);
    const ok = (c >= 48 && c <= 57) || c === 84 || c === 90 || c === 58 || c === 46 || c === 43 || c === 45 || c === 32;
    if (!ok) return false;
  }
  return true;
}

/** Printable-ASCII sanitization with a hard cap, built character by character through bound
 *  intrinsics. The cap is applied FIRST so the work is bounded by the OUTPUT size even when a
 *  caller passes a 50 MB string to the exported error class. */
function sanitizeBounded(value: unknown, cap: number): string {
  if (typeof value !== 'string') return '';
  const n = value.length < cap ? value.length : cap;
  let out = '';
  for (let i = 0; i < n; i += 1) {
    const c = charAt(value, i);
    out += c >= 0x20 && c <= 0x7e ? fromChar(c) : '?';
  }
  return out;
}

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export type Direction = 'up' | 'down';

/** Whether a migration file may run inside an explicit transaction. */
export type TransactionMode = 'required' | 'forbidden';

/** Purpose a credential is classified for. Only 'migration' may drive an apply; 'test'
 *  names S1b's future disposable-PostgreSQL harness classification and fails closed in S1
 *  (no caller-suppliable enabling input exists); 'runtime' is never valid. */
export type CredentialPurpose = 'migration' | 'runtime' | 'test';

/**
 * Declared connection mode. Never inferred from hostname/port — S1b must prove real
 * session continuity before apply is enabled (D5). 'transaction' is refused for the
 * migrator because a pooled backend cannot hold a session advisory lock across commits.
 */
export type ConnectionMode = 'direct' | 'session' | 'transaction' | 'unknown';

/** lstat-classified entry type — 'other' covers FIFO, socket, and device files. */
export type FsEntryType = 'file' | 'symlink' | 'directory' | 'other';

/** Stable, bounded reason codes. The message never carries SQL or a secret value. */
export const ENGINE_CODES = {
  INVALID_FILENAME: 'invalid_filename',
  PATH_TRAVERSAL: 'path_traversal',
  NONREGULAR_MIGRATION_ENTRY: 'nonregular_migration_entry',
  CONTAINMENT_VIOLATION: 'containment_violation',
  INVALID_ENCODING: 'invalid_encoding',
  DUPLICATE_VERSION_DIRECTION: 'duplicate_version_direction',
  MISSING_PAIR: 'missing_pair',
  PAIR_MISMATCH: 'pair_mismatch',
  CHECKSUM_MISMATCH: 'checksum_mismatch',
  UNRESOLVED_DIRTY_ATTEMPT: 'unresolved_dirty_attempt',
  INVALID_HISTORY: 'invalid_history',
  UNKNOWN_LEDGER_VERSION: 'unknown_ledger_version',
  BASELINE_PRECONDITION_FAILED: 'baseline_precondition_failed',
  RUNTIME_CREDENTIAL_REJECTED: 'runtime_credential_rejected',
  CREDENTIAL_EQUALITY_REJECTED: 'credential_equality_rejected',
  CREDENTIAL_PURPOSE_REJECTED: 'credential_purpose_rejected',
  BACKEND_IDENTITY_CHANGED: 'backend_identity_changed',
  MIGRATOR_CONNECTION_MODE_REJECTED: 'migrator_connection_mode_rejected',
  RUN_LOCK_UNAVAILABLE: 'run_lock_unavailable',
  RUN_UNLOCK_FAILED: 'run_unlock_failed',
  PORT_OPERATION_FAILED: 'port_operation_failed',
  // Exported-boundary runtime-shape rejections: every value the execution boundary trusts
  // must be a canonical primitive, validated at RUNTIME (TypeScript is erased). A forged
  // transaction mode, advisory-lock key, backend token, credential ref, or ledger-derived
  // string is refused with a bounded code carrying no forged content.
  INVALID_TRANSACTION_MODE: 'invalid_transaction_mode',
  INVALID_LOCK_KEY: 'invalid_lock_key',
  INVALID_BACKEND_IDENTITY: 'invalid_backend_identity',
  INVALID_CREDENTIAL_REF: 'invalid_credential_ref',
  INVALID_LEDGER_FIELD: 'invalid_ledger_field',
  // S1.7B: the exported execution entry point is an unconditional fail-closed shim; the live
  // effect interpreter is an S1b obligation. The pure decision kernel models a timeout as an
  // event and refuses unknown/out-of-order/contradictory events fail-closed.
  MIGRATION_EXECUTION_UNAVAILABLE: 'migration_execution_unavailable',
  EXECUTION_STEP_TIMEOUT: 'execution_step_timeout',
  INVALID_EXECUTION_EVENT: 'invalid_execution_event',
} as const;

export type EngineCode = (typeof ENGINE_CODES)[keyof typeof ENGINE_CODES];

/** A bounded, secret-safe engine error. `message` references code/version/basename only.
 *  The subject is SANITIZED at construction — printable ASCII, hard length cap — so even a
 *  port that (wrongly) wraps a driver message or a hostile filename with control/ANSI
 *  bytes cannot smuggle unbounded or non-printable content across the error boundary. */
export class MigrationEngineError extends Error {
  readonly code: EngineCode;
  constructor(code: EngineCode, subject = '') {
    // RUNTIME type check first: `subject: string` is ERASED, so a caller (or a hostile value
    // reaching a throw site, e.g. a rejected connection mode or ledger version) can supply an
    // object whose own replace()/slice() return attacker-chosen content — which would become
    // this error's message and defeat both the printable-ASCII filter and the length cap.
    // Only a genuine primitive string is sanitized; anything else contributes no subject.
    // Sanitization runs through BOUND intrinsics and caps BEFORE scanning, so neither a re-pointed
    // `String.prototype.replace`/`slice` nor a 50 MB argument (this class is EXPORTED) can defeat
    // the printable-ASCII filter or the hard length cap that the boundary guarantees.
    const safe = sanitizeBounded(subject, 120);
    // The CODE is sanitized on the same terms: this class is EXPORTED, so a caller may
    // construct one with an oversized or non-printable "code" that would otherwise be
    // interpolated into the message verbatim, defeating the bound the class guarantees.
    const safeCode = sanitizeBounded(code, 64);
    super(safe ? `migration engine refused (${safeCode}): ${safe}` : `migration engine refused (${safeCode})`);
    this.name = 'MigrationEngineError';
    // The SANITIZED code is what the property carries too: a reader that prints `err.code`
    // (rather than `err.message`) must not receive unbounded or non-printable content. Every
    // real ENGINE_CODES value is short printable ASCII, so this is identity for them.
    this.code = safeCode as EngineCode;
    // `message` and `code` would otherwise be ordinary WRITABLE properties, and a hostile port that
    // catches a genuine engine error can rewrite them and re-throw it. Sealing both as non-writable,
    // non-configurable OWN properties means the sanitized values are the only values any instance of
    // this class can ever carry — including one a caller constructed. That is a structural bound,
    // not a provenance claim: it holds no matter WHO built the object.
    defineProp(this, 'message', { value: this.message, writable: false, enumerable: false, configurable: false });
    defineProp(this, 'code', { value: safeCode, writable: false, enumerable: true, configurable: false });
  }
}

/**
 * The CLOSED domain of engine reason codes, snapshotted at module load from the (now runtime-frozen)
 * ENGINE_CODES table.
 *
 * WHAT THIS IS NOT (S1.7D). It is not a provenance registry, an origin brand, or an identity list:
 * it records no object, no construction origin, and no membership decided by identity. It is a
 * bounded VALUE domain — the string counterpart of FILENAME_RE — frozen at load so nothing can be
 * added to it afterwards, and membership is decided purely by the VALUE of a string that any caller
 * is equally free to write out. Two structurally equal inputs therefore always classify the same
 * way, which is precisely the determinism property a WeakSet brand could not provide.
 */
const ENGINE_CODE_VALUES: readonly string[] = freeze(Object.values(freeze(ENGINE_CODES)));

function isEngineCode(value: unknown): value is EngineCode {
  return typeof value === 'string' && containsValue(ENGINE_CODE_VALUES, value);
}

/** Construct a bounded MigrationEngineError. All internal throws use this. */
function engineError(code: EngineCode, subject = ''): MigrationEngineError {
  return new MigrationEngineError(code, subject);
}

/**
 * Rebuild a caught throw as a bounded, ENGINE-ALLOCATED error — structurally, never by provenance.
 *
 * The removed origin brand answered "did the engine raise this?". This answers a different and
 * purely structural question: "what bounded description can be recovered from it?". Exactly ONE
 * value is read — `code`, accepted only if it lies in the closed engine-code domain — and a NEW
 * error is constructed from it with NO subject at all. Consequences, all independent of who threw:
 *   - No caught object EVER crosses the boundary by identity, so a raw driver error, a faked
 *     prototype chain, or a caller-mutated instance cannot carry its own message, stack, or any
 *     caller-controlled text out. The rebuilt message is exactly `migration engine refused (code)`.
 *   - Dropping the subject costs nothing: no engine throw that can pass through this guard carries
 *     a meaningful subject (the credential and connection-mode guards deliberately carry none),
 *     while KEEPING it would hand a hostile port a 120-character channel into an operator's log.
 *   - Code preservation is REQUIRED, not incidental: a credential refusal raised inside a guarded
 *     call must still report its own bounded reason rather than a generic port failure.
 *   - What a hostile port CAN therefore influence is which of the 29 bounded codes is reported.
 *     That is an accepted, documented residual, not an escalation: every code selects a REFUSAL,
 *     none selects a success path or a disposition, so the choice changes the reported reason and
 *     nothing else. The alternative — trusting object identity — is exactly the hidden-state
 *     dependency S1.7D removes.
 */
function boundedError(e: unknown): MigrationEngineError {
  let rawCode: unknown;
  try { rawCode = e == null ? undefined : (e as { code?: unknown }).code; } catch { rawCode = undefined; }
  return new MigrationEngineError(isEngineCode(rawCode) ? rawCode : ENGINE_CODES.PORT_OPERATION_FAILED);
}

/** Synchronous guard for the filesystem port and scalar dependency reads: a foreign throw from an
 *  injected list/entryType/readBytes or a throwing dependency getter (which could carry an absolute
 *  path, file content, provider detail, or a caller-constructed MigrationEngineError) is rebuilt as
 *  a bounded engine-allocated error carrying only validated primitives. */
function guardPortSync<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    throw boundedError(e);
  }
}

/**
 * Filename grammar `NNN_snake_name.(up|down).sql` — three digits, lower snake_case, direction —
 * parsed by BOUNDED CHARACTER LOOP, never regex. `re.exec(s)` is a patchable prototype method, and
 * this parse decides whether an arbitrary file is admitted into migration history at all: a
 * re-pointed `exec` returning a fabricated match made `not a migration.txt` a legitimate migration.
 * Returns null for anything outside the grammar.
 */
function parseMigrationFilename(basename: string): { version: string; name: string; direction: Direction } | null {
  const n = basename.length;
  if (n < 12 || n > 255) return null;                        // '001_a.up.sql' is the shortest legal name
  for (let i = 0; i < 3; i += 1) { const c = charAt(basename, i); if (c < 48 || c > 57) return null; }
  if (charAt(basename, 3) !== 95) return null;               // '_'
  const endsWith = (suffix: string): boolean => {
    const off = n - suffix.length;
    if (off <= 4) return false;                              // the snake name must be non-empty
    for (let i = 0; i < suffix.length; i += 1) if (charAt(basename, off + i) !== charAt(suffix, i)) return false;
    return true;
  };
  let direction: Direction;
  let suffixLen: number;
  if (endsWith('.up.sql')) { direction = 'up'; suffixLen = 7; }
  else if (endsWith('.down.sql')) { direction = 'down'; suffixLen = 9; }
  else return null;
  const nameEnd = n - suffixLen;
  for (let i = 4; i < nameEnd; i += 1) {
    const c = charAt(basename, i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95)) return null;   // [a-z0-9_]
  }
  return { version: strSlice(basename, 0, 3), name: strSlice(basename, 4, nameEnd), direction };
}

/**
 * Emit a version into an error SUBJECT only when it is the canonical numeric form. A
 * caller-supplied version is otherwise arbitrary text, and printable-ASCII sanitization alone
 * would still let a connection string, a credential, or a SQL fragment be echoed straight back
 * out of the error boundary. A non-canonical value contributes no subject at all — the stable
 * code still identifies the refusal.
 */
function safeVersionSubject(value: unknown): string {
  return isDigitString(value, 64) ? value : '';
}

/**
 * The repository-relative label a filesystem port supplies for printable identifiers. It is
 * caller-controlled on an injected port, so it is read ONCE and constrained to a bounded,
 * path-shaped, printable value — otherwise a hostile port places arbitrary text (including a
 * connection string) into every descriptor's `relPath`, the field documented as safe to print.
 */
function assertRelDir(value: unknown): string {
  if (!isRelDirString(value, 200)) {
    throw engineError(ENGINE_CODES.INVALID_LEDGER_FIELD, 'rel_dir');
  }
  return value;
}

// ---------------------------------------------------------------------------
// Checksums + strict decoding — exact bytes, no normalization
// ---------------------------------------------------------------------------

/** SHA-256 (hex) over the EXACT bytes. No newline normalization, no trimming. */
export function sha256Hex(bytes: Uint8Array): string {
  const h = makeHash('sha256');
  hashUpdate(h, bytes);
  const digest = hashDigest(h, 'hex');
  // Bounded, NON-REGEX shape validation of the final digest: exactly 64 lowercase hex characters.
  // `RegExp.prototype.exec` is itself patchable, so the guard on the hash may not depend on it.
  if (!isLowerHex(digest, 64)) throw engineError(ENGINE_CODES.CHECKSUM_MISMATCH, 'digest_shape');
  return digest;
}

// Strict, deterministic UTF-8: `fatal` throws on ANY invalid sequence (no U+FFFD
// substitution); `ignoreBOM` keeps a BOM in the text so decode(bytes) re-encodes to the
// EXACT checksummed bytes — the sql string and the hashed bytes can never diverge.
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const UTF8_ENCODER = new TextEncoder();

function decodeUtf8Strict(bytes: Uint8Array, subject: string): string {
  try {
    return utf8Decode(STRICT_UTF8, bytes);
  } catch {
    // The invalid bytes are never echoed — only the safe basename subject.
    throw engineError(ENGINE_CODES.INVALID_ENCODING, subject);
  }
}

// ---------------------------------------------------------------------------
// Artifacts, descriptors + discovery
// ---------------------------------------------------------------------------

/**
 * The immutable checksum-to-execution binding. Built from ONE read at discovery:
 * `checksum` is SHA-256 over `bytes`, and `sql` is the strict UTF-8 decode of those same
 * bytes. Execution ports receive THIS object — never a path — so a file mutated after
 * discovery cannot change what would run (no TOCTOU window). Frozen; `bytes` is a
 * private copy decoupled from any pooled fs buffer.
 *
 * CONTAINS SQL: never print, log, serialize, or place an artifact in status output,
 * ledger rows, or error messages. The printable identifiers live on the descriptor.
 */
export interface MigrationArtifact {
  readonly version: string;
  readonly direction: Direction;
  /** SHA-256 (hex) over `bytes` — the exact bytes read once at discovery. */
  readonly checksum: string;
  /** The exact file bytes from the single discovery read. */
  readonly bytes: Uint8Array;
  /** Strict UTF-8 decode of `bytes` — the ONLY text execution may run. */
  readonly sql: string;
}

export interface MigrationDescriptor {
  version: string;         // '001'
  name: string;            // 'platform_identity'
  direction: Direction;    // 'up' | 'down'
  checksum: string;        // sha256 of exact bytes (=== artifact.checksum)
  relPath: string;         // repository-relative identifier, safe to print
  transactionMode: TransactionMode;
  /** The checksum-bound execution artifact (carries SQL — not printable). */
  artifact: MigrationArtifact;
}

/**
 * Filesystem port. `list()` returns basenames only; `entryType(basename)` classifies the
 * entry WITHOUT following symlinks (lstat semantics); `readBytes(basename)` returns the
 * exact bytes of a REGULAR file via a no-follow read. The Node adapter
 * (createNodeFsPort) enforces canonical containment and O_NOFOLLOW; a fake port drives
 * the pure tests. The engine never touches the real filesystem except through a port.
 */
export interface MigrationFsPort {
  list(): string[];
  entryType(basename: string): FsEntryType;
  readBytes(basename: string): Uint8Array;
  /** Repository-relative directory for safe, non-leaking identifiers (e.g. printing). */
  readonly relDir: string;
}

export interface DiscoverOptions {
  /** Per-version transaction-mode contract. Absent versions default to 'required'. */
  transactionModeByVersion?: Readonly<Record<string, TransactionMode>>;
}

/**
 * Capture a filesystem port's listing as bounded, own-DATA-only values (S1.7F §E). The port call and
 * the whole capture sit inside ONE guard, so a port throw, a descriptor trap, an enumeration trap, or
 * a Proxy trap all become a stable bounded code carrying no caller text. The container must be a
 * genuine Array whose own keys are EXACTLY its indices plus `length`, so an array-like, an extra own
 * property, an overridden own method (`list().map = ...`), or a symbol key (a planted
 * `Symbol.iterator`) is not a listing. Entry VALUES stay `unknown` — `assertSafeBasename` is the one
 * place that decides basename shape, and it neither coerces nor invokes anything.
 */
function captureListing(fs: MigrationFsPort): unknown[] {
  return guardPortSync(() => {
    const raw: unknown = fs.list();
    if (!isArray(raw)) throw engineError(ENGINE_CODES.PORT_OPERATION_FAILED, 'fs_list');
    const lenDesc = descriptorOf(raw as object, 'length');
    if (lenDesc === undefined || lenDesc.get !== undefined || lenDesc.set !== undefined) {
      throw engineError(ENGINE_CODES.PORT_OPERATION_FAILED, 'fs_list');
    }
    const n = lenDesc.value;
    if (typeof n !== 'number' || !isSafeInteger(n) || n < 0 || n > MAX_BOUNDED_LENGTH) {
      throw engineError(ENGINE_CODES.INVALID_LEDGER_FIELD, 'fs_list_length');
    }
    if (ownKeysOf(raw as object).length !== n + 1) throw engineError(ENGINE_CODES.PORT_OPERATION_FAILED, 'fs_list');
    const out: unknown[] = [];
    for (let i = 0; i < n; i += 1) {
      const d = descriptorOf(raw as object, `${i}`);
      if (d === undefined || d.get !== undefined || d.set !== undefined) {
        throw engineError(ENGINE_CODES.PORT_OPERATION_FAILED, 'fs_list');
      }
      out[i] = d.value;
    }
    return out;
  });
}

/**
 * Read ONE OWN DATA property of a caller-supplied object, or `undefined` (S1.7F).
 *
 * Two things a plain `obj.prop` cannot do. (1) An INHERITED property is invisible: `Object.prototype`
 * is a prototype like any other, and polluting it must never supply a value the caller did not
 * declare — otherwise `{purpose:'migration'}` inherits a migratorRef/runtimeRef pair and self-asserts
 * a migration credential, and an inherited version key flips a migration's declared transaction mode.
 * (2) An ACCESSOR is not invoked: it yields `undefined` rather than running caller code inside the
 * engine, so a throwing getter cannot escape as a raw exception carrying caller text.
 */
function ownValue(source: unknown, key: string): unknown {
  if (source === null || typeof source !== 'object') return undefined;
  const d = descriptorOf(source as object, key);
  return d === undefined || d.get !== undefined || d.set !== undefined ? undefined : d.value;
}

/** Reject anything that is not a bare, grammar-valid basename before it is read. */
function assertSafeBasename(basename: unknown): asserts basename is string {
  // `String.prototype.includes` is a patchable prototype method and this is a CONTAINMENT check, so
  // the scan is a bounded character loop. The value is NEVER coerced with `String(...)`: on a hostile
  // port a non-string basename would otherwise run the caller's own `toString` inside the engine, and
  // that throw carried raw text (a connection string) straight out of the bounded error boundary.
  let bad = typeof basename !== 'string' || basename.length === 0 || basename.length > 255;
  if (!bad) {
    const s = basename as string;
    for (let i = 0; i < s.length; i += 1) {
      const c = charAt(s, i);
      if (c === 47 || c === 92) { bad = true; break; }                                  // '/' or '\'
      if (c === 46 && i + 1 < s.length && charAt(s, i + 1) === 46) { bad = true; break; } // '..'
    }
    if (!bad && isAbsolute(s)) bad = true;
  }
  if (bad) throw engineError(ENGINE_CODES.PATH_TRAVERSAL, typeof basename === 'string' ? basename : '');
}

/**
 * Rebuild a caller-supplied descriptor as a NEWLY ALLOCATED, DEEPLY FROZEN canonical snapshot
 * (S1.7G §B). Every field — including the SQL-bearing artifact — is read EXACTLY ONCE inside a
 * guard and re-emitted as a bounded canonical PRIMITIVE, and the bytes are copied into storage
 * PRIVATE to this closure. Nothing the caller still holds is reachable from the result.
 *
 * WHY. Returning the caller's own descriptor made a returned pair or plan a LIVE VIEW of caller
 * memory: rewriting `artifact.sql` after `pairMigrations`/`planApply` had already returned replaced
 * the returned migration's SQL with arbitrary text, and any accessor or Proxy trap left in that
 * graph would fire LATER, inside an executor that merely logs or serializes the plan. Revalidating
 * downstream does not fix that — the plan itself must be inert.
 *
 * WHAT THIS IS NOT. A structural snapshot, not an integrity proof. The checksum-to-bytes-to-sql
 * binding is verified where it must be: `canonicalizeArtifact`, unconditionally, at execution.
 */
function canonicalDescriptor(source: unknown, subject: string): MigrationDescriptor {
  let version: unknown;
  let name: unknown;
  let direction: unknown;
  let checksum: unknown;
  let relPath: unknown;
  let transactionMode: unknown;
  let artifact: unknown;
  try {
    if (source === null || typeof source !== 'object') throw new Error('not a descriptor');
    const d = source as MigrationDescriptor;
    version = d.version;
    name = d.name;
    direction = d.direction;
    checksum = d.checksum;
    relPath = d.relPath;
    transactionMode = d.transactionMode;
    artifact = d.artifact;
  } catch {
    throw engineError(ENGINE_CODES.INVALID_LEDGER_FIELD, subject);
  }
  if (direction !== 'up' && direction !== 'down') throw engineError(ENGINE_CODES.INVALID_LEDGER_FIELD, subject);
  if (transactionMode !== 'required' && transactionMode !== 'forbidden') {
    throw engineError(ENGINE_CODES.INVALID_TRANSACTION_MODE, safeVersionSubject(version));
  }
  const v = assertVersionLabel(version, subject);
  const ck = assertChecksumHex(checksum, subject);
  const nm = assertLedgerLabel(name, 255, subject);
  // `relPath` is a print-only identifier the engine itself never reads after discovery, and a
  // hand-built pair (as at the exported planning boundary) need not carry one. So it is validated
  // only when PRESENT — canonicalize what exists rather than newly refuse inputs planning accepted
  // — and when present it is emitted as a bounded printable primitive, never a caller reference.
  const rp = relPath === undefined ? undefined : assertLedgerLabel(relPath, 1024, subject);

  // An ABSENT artifact is NOT refused here. `artifact` is deliberately non-enumerable, so a spread
  // copy of a descriptor legitimately loses it, and the module's documented disposition for that is
  // to fail closed AT EXECUTION — `canonicalizeArtifact` refuses a missing, throwing, tampered, or
  // lost artifact unconditionally, with `checksum_mismatch`. Planning must not pre-empt that gate:
  // doing so would refuse a spread-copied pair before the pairing checks that diagnose it, turning
  // a precise `pair_mismatch` into a generic one. What is PRESENT is snapshotted into engine-owned
  // storage; what is absent stays absent, and the execution gate still closes on it.
  let canonicalArtifact: MigrationArtifact | undefined;
  if (artifact !== null && typeof artifact === 'object') {
    let aVersion: unknown;
    let aDirection: unknown;
    let aChecksum: unknown;
    let aSql: unknown;
    let priv = new U8();
    try {
      const a = artifact as MigrationArtifact;
      aVersion = a.version;
      aDirection = a.direction;
      aChecksum = a.checksum;
      aSql = a.sql;
      // INSIDE the guard: `%Uint8Array%` over a non-typed-array value runs caller code
      // (GetMethod(@@iterator) or Get('length') plus index gets), which must not escape raw.
      priv = new U8(a.bytes);
    } catch {
      throw engineError(ENGINE_CODES.CHECKSUM_MISMATCH, safeVersionSubject(version));
    }
    // Artifact-shape failures all report the ARTIFACT gate's own code, `checksum_mismatch` — the
    // same code `canonicalizeArtifact` uses for a missing, throwing, tampered, or lost artifact —
    // so a snapshot taken during planning can never turn an execution-time verdict into a
    // different one. No SIZE bound is imposed here: `MAX_SQL_LENGTH` is a PRODUCING-side bound that
    // `buildProgram` enforces with `invalid_ledger_field`, and re-checking it here would refuse an
    // oversized migration earlier under the wrong code. (The copy is already materialized by then,
    // so a bound at this point would not prevent the allocation either.)
    if (
      typeof aSql !== 'string' ||
      (aDirection !== 'up' && aDirection !== 'down') ||
      !isDigitString(aVersion, 64) ||
      !isLowerHexBounded(aChecksum, 64)
    ) {
      throw engineError(ENGINE_CODES.CHECKSUM_MISMATCH, safeVersionSubject(version));
    }
    const bytes = priv;
    canonicalArtifact = freeze({
      version: aVersion,
      direction: aDirection as Direction,
      checksum: aChecksum,
      // A fresh defensive copy per access: `freeze` is shallow and cannot freeze typed-array elements.
      get bytes(): Uint8Array {
        return new U8(bytes);
      },
      sql: aSql,
    });
  }
  const out = {
    version: v,
    name: nm,
    direction: direction as Direction,
    checksum: ck,
    relPath: rp as string,
    transactionMode: transactionMode as TransactionMode,
  } as MigrationDescriptor;
  // BOUND `defineProp`: the SQL-bearing artifact stays NON-ENUMERABLE, so a serialized descriptor,
  // pair, or plan is structurally SQL-free even if the live `Object.defineProperty` is re-pointed.
  defineProp(out, 'artifact', {
    value: canonicalArtifact as MigrationArtifact,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return freeze(out);
}

/**
 * Deterministic discovery: parse, containment-check, type-check, single-read, checksum,
 * decode, dedupe, and order. Fails closed with a bounded code on any malformed name,
 * traversal attempt, NONREGULAR entry (symlink/directory/FIFO/socket/device), invalid
 * UTF-8, or duplicate (version, direction). Each file is read EXACTLY ONCE; the checksum
 * and the execution artifact are built from that same read, so the hash always covers
 * the bytes execution would run. Returns descriptors sorted by (version asc, up first).
 */
export function discoverMigrations(
  fs: MigrationFsPort,
  options: DiscoverOptions = {},
): MigrationDescriptor[] {
  // OWN-only, accessor-free reads: an inherited `transactionModeByVersion`, or a throwing getter on
  // the caller's options object, must neither supply a value nor escape as a raw exception.
  const overrides = ownValue(options, 'transactionModeByVersion');
  // Read ONCE and validate: a per-read relDir getter could label descriptors inconsistently.
  const relDir = assertRelDir(guardPortSync(() => fs.relDir));
  const seen = new SetCtor<string>();
  const out: MigrationDescriptor[] = [];
  let emitted = 0;

  // The listing is UNKNOWN caller data, captured ONCE, by DESCRIPTOR, inside the port guard. An index
  // READ would be a property GET — running an accessor the caller planted and letting its throw
  // escape raw with a connection string in it — so every entry comes from its own descriptor and an
  // accessor is rejected WITHOUT being invoked. `for…of` is likewise never used: the array iterator
  // is an overridable prototype property, so it could decide which migrations the engine ever sees.
  const listed = captureListing(fs);
  const listCount = listed.length;
  for (let li = 0; li < listCount; li += 1) {
    const basename = listed[li];
    assertSafeBasename(basename);
    const m = parseMigrationFilename(basename);
    if (!m) throw engineError(ENGINE_CODES.INVALID_FILENAME, basename);
    const { version, name, direction } = m;

    const key = `${version}.${direction}`;
    if (setHas(seen as never, key)) throw engineError(ENGINE_CODES.DUPLICATE_VERSION_DIRECTION, key);
    setAdd(seen as never, key);

    // OWN key only: `Object.prototype['001'] = 'forbidden'` must not flip a migration's declared
    // transaction mode and drop its DDL out of the atomic bracket.
    const mode = ownValue(overrides, version) ?? 'required';
    if (mode !== 'required' && mode !== 'forbidden') {
      throw engineError(ENGINE_CODES.INVALID_HISTORY, `${version}:transaction_mode`);
    }

    // Only REGULAR files may be migrations — a symlink (wherever it points), directory,
    // FIFO, socket, or device is corrupt/hostile history, never silently read.
    if (guardPortSync(() => fs.entryType(basename)) !== 'file') {
      throw engineError(ENGINE_CODES.NONREGULAR_MIGRATION_ENTRY, basename);
    }

    // THE single read: checksum and execution artifact come from these same bytes. The
    // copy is PRIVATE to the closure below — `artifact.bytes` returns a fresh defensive
    // copy on every access, so no holder of the artifact can mutate the checksummed
    // content (Object.freeze is shallow and cannot freeze typed-array elements).
    // The Uint8Array construction is INSIDE the guard: `%Uint8Array%` over a non-typed-array return
    // performs GetMethod(@@iterator) or Get('length') + index gets — all caller code — so guarding
    // only the port CALL left a hostile `readBytes` result able to throw raw out of discovery.
    const priv = guardPortSync(() => new U8(fs.readBytes(basename)));
    const checksum = sha256Hex(priv);
    const sql = decodeUtf8Strict(priv, basename);
    // BOUND `freeze`, never the live `Object.freeze`: this is the immutability guarantee itself, and
    // a re-pointed global would return an unfrozen, caller-mutable artifact.
    const artifact: MigrationArtifact = freeze({
      version,
      direction: direction as Direction,
      checksum,
      get bytes(): Uint8Array {
        return new U8(priv);
      },
      sql,
    });

    const descriptor: MigrationDescriptor = {
      version,
      name,
      direction: direction as Direction,
      checksum,
      relPath: `${relDir}/${basename}`,
      transactionMode: mode,
      artifact,
    };
    // The SQL-bearing artifact is NON-ENUMERABLE: JSON.stringify / spread of a
    // descriptor, pair, or plan is structurally SQL-free. (A spread copy therefore
    // LOSES the artifact — execution re-verifies integrity and fails closed on that.)
    // BOUND `defineProp`: a re-pointed `Object.defineProperty` would leave the SQL-bearing artifact
    // ENUMERABLE, so JSON.stringify of a descriptor/pair/plan would serialize migration SQL — the
    // exact property this line exists to guarantee.
    defineProp(descriptor, 'artifact', {
      value: artifact,
      enumerable: false,
      writable: false,
      configurable: false,
    });
    // S1.7G §B: a returned descriptor is INERT. It was previously mutable, so a holder could rewrite
    // `checksum` or `transactionMode` on the engine's own discovery output and hand it on.
    freeze(descriptor);
    // Indexed append, never `Array.prototype.push`: `push` is an overridable prototype property, and
    // a re-pointed one could drop discovered migrations or append a forged descriptor.
    out[emitted] = descriptor;
    emitted += 1;
  }

  // Codepoint comparison (versions are fixed-width ASCII digits): fully deterministic,
  // never locale/ICU-dependent. Sorting goes through the BOUND `sort` — apply ORDER is a security
  // property, and a re-pointed `Array.prototype.sort` could leave history unordered.
  arraySort(out, (a, b) =>
    a.version === b.version
      ? (a.direction === b.direction ? 0 : a.direction === 'up' ? -1 : 1)
      : (a.version < b.version ? -1 : 1),
  );
  // Frozen AFTER the sort (sorting a frozen array throws): the returned list itself is inert, so a
  // holder can neither reorder discovered history nor splice a forged descriptor into it.
  return freeze(out) as MigrationDescriptor[];
}

/** Group descriptors into per-version pairs and verify up/down pairing is complete. */
export interface MigrationPair {
  version: string;
  name: string;
  up: MigrationDescriptor;
  down: MigrationDescriptor;
  transactionMode: TransactionMode;
}

/**
 * Pair up/down descriptors by version. Both members must share the SAME name and the SAME
 * transaction mode — a `001_alpha.up.sql` paired with a `001_beta.down.sql` (or a mode
 * mismatch) is corrupt history and is rejected, never silently adopted.
 */
export function pairMigrations(descriptors: readonly MigrationDescriptor[]): MigrationPair[] {
  type Slot = { up?: MigrationDescriptor; down?: MigrationDescriptor };
  const byVersion = new MapCtor<string, Slot>();
  const versions: string[] = [];
  let vCount = 0;
  // INDEX loop over caller-supplied data with GUARDED field reads, never `for…of`: `descriptors` is a
  // plain exported-boundary array whose iterator is an overridable prototype property and whose
  // elements may be accessor-backed. Map membership goes through the BOUND get/set, because a
  // re-pointed `Map.prototype.get` could merge two distinct versions into one pair.
  const n = boundedLength(descriptors, 'descriptors_length');
  for (let i = 0; i < n; i += 1) {
    let d: MigrationDescriptor | undefined;
    let version: unknown;
    let direction: unknown;
    try {
      d = descriptors[i];
      version = d == null ? undefined : d.version;
      direction = d == null ? undefined : d.direction;
    } catch {
      throw engineError(ENGINE_CODES.INVALID_LEDGER_FIELD, 'descriptor_field');
    }
    if (d == null || typeof version !== 'string' || (direction !== 'up' && direction !== 'down')) {
      throw engineError(ENGINE_CODES.INVALID_LEDGER_FIELD, 'descriptor_field');
    }
    let cur = mapGet(byVersion as never, version) as Slot | undefined;
    if (cur === undefined) {
      // NULL-PROTOTYPE slot: an object literal inherits Object.prototype, so
      // `Object.prototype.down = {...}` used to complete a pair that has no down migration file and
      // slip corrupt history past the MISSING_PAIR gate.
      cur = objectCreate(null) as Slot;
      mapSet(byVersion as never, version, cur);
      versions[vCount] = version;
      vCount += 1;
    }
    if (direction === 'up') cur.up = d;
    else cur.down = d;
  }
  // ONE ordering for the whole module: the kernel's numeric comparator, never string `<`/`>`. The two
  // agree only for the fixed 3-digit versions the filename grammar produces, and this boundary admits
  // 1..64 digits — so lexicographic ordering put '10' before '9'.
  arraySort(versions, (a, b) => (versionPrecedes(a, b) ? -1 : versionPrecedes(b, a) ? 1 : 0));
  const pairs: MigrationPair[] = [];
  let pCount = 0;
  for (let i = 0; i < vCount; i += 1) {
    const version = versions[i];
    const v = mapGet(byVersion as never, version) as Slot;
    if (!v.up || !v.down) throw engineError(ENGINE_CODES.MISSING_PAIR, safeVersionSubject(version));
    // CANONICALIZE FIRST, then compare the SNAPSHOTS (S1.7G §B). Each descriptor is read exactly
    // ONCE, into engine-owned storage; the comparison and the emission then both read that one
    // snapshot. Comparing the caller's live objects and afterwards emitting them let an accessor
    // return one value to the check and another to the pair — and left the caller's descriptor,
    // artifact, and every trap on it reachable from the returned pair. `canonicalDescriptor` also
    // subsumes the old string/enum checks, so they are gone rather than left unreachable.
    const upSnap = canonicalDescriptor(v.up, 'descriptor_field');
    const downSnap = canonicalDescriptor(v.down, 'descriptor_field');
    if (upSnap.name !== downSnap.name) throw engineError(ENGINE_CODES.PAIR_MISMATCH, `${safeVersionSubject(version)}:name`);
    if (upSnap.transactionMode !== downSnap.transactionMode) {
      throw engineError(ENGINE_CODES.PAIR_MISMATCH, `${safeVersionSubject(version)}:transaction_mode`);
    }
    pairs[pCount] = freeze({
      version,
      name: upSnap.name,
      up: upSnap,
      down: downSnap,
      transactionMode: upSnap.transactionMode,
    });
    pCount += 1;
  }
  return freeze(pairs) as MigrationPair[];
}

// ---------------------------------------------------------------------------
// Ledger snapshot + engine state model
// ---------------------------------------------------------------------------

/** A ledger row as read by S1b's real ledger. Modelled here for pure planning. */
export interface LedgerRow {
  version: string;
  checksum: string;
  dirty: boolean;
  /** Present only when a failed/superseded attempt has been explicitly resolved. */
  resolution?: LedgerResolution | null;
}

export interface LedgerResolution {
  status: 'resolved_failed' | 'resolved_superseded';
  at: string;
  reasonCategory: string;
  /** Version of the corrective forward migration, or an operator-action label. */
  correctiveRef: string;
}

export type MigrationState =
  | 'unapplied'
  | 'applied'
  | 'dirty_unresolved'
  | 'failed_resolved'
  | 'checksum_mismatch'
  | 'invalid_history';

export interface VersionStatus {
  version: string;
  fileChecksum: string;
  ledgerChecksum: string | null;
  state: MigrationState;
}

/** A ledger-derived checksum echoed into status output must be lowercase hex (a real sha256,
 *  or a short test value) — never SQL, a path, a credential, control characters, or an
 *  oversized string. A non-conforming value is NULLED on output (never echoed), so a hostile
 *  or corrupt ledger can never place raw content into a serialized status result. */
function safeLedgerChecksum(value: unknown): string | null {
  return isLowerHexBounded(value, 64) ? value : null;
}

/** Validate a ledger/operator-supplied label copied into a plan or status output: it must be a
 *  bounded, printable-ASCII primitive string. SQL, absolute paths, credentials, control
 *  characters, and oversized strings are refused with a bounded code carrying no content. */
function assertLedgerLabel(value: unknown, maxLen: number, subject: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLen || !isPrintableAscii(value)) {
    throw engineError(ENGINE_CODES.INVALID_LEDGER_FIELD, subject);
  }
  return value;
}

/** A checksum echoed into status output must be CANONICAL lowercase hex. Unlike the ledger
 *  side (whose value is nulled), a non-conforming FILE checksum means the caller-supplied pair
 *  itself is corrupt, so it is refused with a bounded code rather than silently emptied. */
function assertChecksumHex(value: unknown, subject: string): string {
  if (!isLowerHexBounded(value, 64)) {
    throw engineError(ENGINE_CODES.INVALID_LEDGER_FIELD, subject);
  }
  return value;
}

/** A version echoed into status output must be the CANONICAL numeric form the filename grammar
 *  produces. Printable ASCII alone is too weak a filter — it still admits SQL-like text into
 *  output this module documents as SQL-free. */
function assertVersionLabel(value: unknown, subject: string): string {
  if (!isDigitString(value, 64)) {
    throw engineError(ENGINE_CODES.INVALID_LEDGER_FIELD, subject);
  }
  return value;
}

/** A timestamp copied into a DURABLE ledger row must be a bounded, canonical time literal —
 *  printable ASCII alone would still admit SQL-like text into a recorded migration attempt. */
function assertTimestampLabel(value: unknown, subject: string): string {
  if (!isTimeLiteral(value, 64)) {
    throw engineError(ENGINE_CODES.INVALID_LEDGER_FIELD, subject);
  }
  return value;
}

/** Read a caller-supplied array's length ONCE as a safe integer. `map`, `filter`, and `reduce`
 *  are OVERRIDABLE own properties on a caller-supplied array — a hostile caller can replace
 *  them to hide ledger rows or widen a returned plan — so every boundary walk is an index loop
 *  over this length rather than a prototype method the caller controls. */
function boundedLength(value: { length?: unknown } | null | undefined, subject: string): number {
  // The `length` read is itself guarded: on a Proxy or accessor-backed array-like it is a
  // caller-controlled getter, and a throw from it would otherwise escape as a raw Error.
  let n: unknown;
  try {
    n = value == null ? undefined : value.length;
  } catch {
    throw engineError(ENGINE_CODES.INVALID_LEDGER_FIELD, subject);
  }
  // `isSafeInteger` is the BOUND intrinsic — `Number.isSafeInteger` is a live global read, and a
  // re-pointed one would let an unbounded or fractional length through this very guard. The MAXIMUM
  // is enforced here too: a safe integer is not by itself a bounded amount of work.
  if (typeof n !== 'number' || !isSafeInteger(n) || n < 0 || n > MAX_BOUNDED_LENGTH) {
    throw engineError(ENGINE_CODES.INVALID_LEDGER_FIELD, subject);
  }
  return n;
}

/**
 * Pure state model over a discovered plan and a ledger SNAPSHOT (already read by a port).
 * No database access. Checksum immutability is checked FIRST — an altered historical
 * migration is the most severe divergence, so a checksum mismatch outranks dirty/resolved
 * classification and always blocks apply. Two ledger rows for one version is corrupt.
 * (Baseline candidacy is the whole-history predicate `isBaselineCandidate`, not a
 * per-version state — see the baseline section.)
 */
export function computeStatus(
  pairs: readonly MigrationPair[],
  ledger: readonly LedgerRow[],
): VersionStatus[] {
  // Snapshot each ledger row's fields EXACTLY ONCE (F8): a hostile or S1b ledger row could be
  // getter-backed, returning one value to a check and another to the output. Everything
  // downstream reads the snapshot, never the live row.
  // The walk is an INDEX LOOP (a caller-supplied array's `map` is an overridable own property
  // that could hide rows) and every field read is GUARDED (a throwing getter must become a
  // bounded code, never a raw Error message carrying SQL, a path, or a credential).
  const ledgerCount = boundedLength(ledger, 'ledger_length');
  const snaps: Array<{ version: unknown; checksum: unknown; dirty: unknown; resolution: unknown }> = [];
  for (let i = 0; i < ledgerCount; i += 1) {
    try {
      const row = ledger[i];
      snaps[i] = {
        version: row == null ? undefined : row.version,
        checksum: row == null ? undefined : row.checksum,
        dirty: row == null ? undefined : row.dirty,
        resolution: row == null ? undefined : row.resolution,
      };
    } catch {
      throw engineError(ENGINE_CODES.INVALID_LEDGER_FIELD, 'ledger_row');
    }
  }
  const byVersion = new MapCtor<unknown, (typeof snaps)[number]>();
  const duplicated = new SetCtor<unknown>();
  for (let i = 0; i < ledgerCount; i += 1) {
    const row = snaps[i];
    if (mapHas(byVersion as never, row.version)) setAdd(duplicated as never, row.version);
    mapSet(byVersion as never, row.version, row);
  }
  // Snapshot and VALIDATE each pair's printable identifiers ONCE (D3): `pairs` is a plain,
  // caller-controlled structure at the exported boundary, so the version and file checksum
  // echoed into status output must be bounded, printable, canonical values. Without this a
  // caller-built pair places raw content (SQL, a path, a credential, control characters, an
  // oversized string) into output this module documents as SQL-free — and a getter-backed
  // pair could present one version to the known-set and another to the classified row.
  const pairCount = boundedLength(pairs, 'pairs_length');
  const pairSnaps: Array<{ version: string; fileChecksum: string }> = [];
  for (let i = 0; i < pairCount; i += 1) {
    let version: unknown;
    let fileChecksum: unknown;
    try {
      const p = pairs[i];
      const up = p == null ? undefined : p.up; // ONE read of the up slot, then one of its field
      version = p == null ? undefined : p.version;
      fileChecksum = up == null ? undefined : up.checksum;
    } catch {
      throw engineError(ENGINE_CODES.INVALID_LEDGER_FIELD, 'pair_field');
    }
    pairSnaps[i] = {
      version: assertVersionLabel(version, 'pair_version'),
      fileChecksum: assertChecksumHex(fileChecksum, 'pair_checksum'),
    };
  }
  // The classification body is unchanged; only its DRIVER changed, from `Array.prototype.map` (an
  // overridable prototype property that could return a fabricated status list) to an index loop.
  const classify = (p: { version: string; fileChecksum: string }): VersionStatus => {
    const row = mapGet(byVersion as never, p.version) as (typeof snaps)[number] | undefined;
    const fileChecksum = p.fileChecksum;
    // ledgerChecksum is sanitized on EVERY output path (F8): a non-hex value (SQL, a path, a
    // credential, control chars, or an oversized string) is nulled, never echoed.
    const ledgerChecksum = row ? safeLedgerChecksum(row.checksum) : null;
    // S1.7G §B: every status object is FROZEN before it leaves. A status was previously mutable, so
    // a holder could flip `state` to 'applied' on the engine's own classification and pass it on.
    if (setHas(duplicated as never, p.version)) {
      return freeze({ version: p.version, fileChecksum, ledgerChecksum, state: 'invalid_history' as const });
    }
    if (!row) return freeze({ version: p.version, fileChecksum, ledgerChecksum: null, state: 'unapplied' as const });
    // Checksum immutability first: a drifted historical migration blocks regardless of
    // dirty/resolution, so an altered file can never masquerade as applied or resolved.
    if (row.checksum !== fileChecksum) {
      return freeze({ version: p.version, fileChecksum, ledgerChecksum, state: 'checksum_mismatch' as const });
    }
    if (row.dirty && !row.resolution) {
      return freeze({ version: p.version, fileChecksum, ledgerChecksum, state: 'dirty_unresolved' as const });
    }
    if (row.dirty && row.resolution) {
      return freeze({ version: p.version, fileChecksum, ledgerChecksum, state: 'failed_resolved' as const });
    }
    // A resolution on a NON-dirty row is contradictory: resolutions exist only for dirty
    // attempts, so a clean row carrying one is corrupt history — never 'applied'.
    if (row.resolution) {
      return freeze({ version: p.version, fileChecksum, ledgerChecksum, state: 'invalid_history' as const });
    }
    return freeze({ version: p.version, fileChecksum, ledgerChecksum, state: 'applied' as const });
  };
  const statuses: VersionStatus[] = [];
  let sCount = 0;
  for (let i = 0; i < pairCount; i += 1) {
    statuses[sCount] = classify(pairSnaps[i]);
    sCount += 1;
  }
  // Ledger rows whose version has NO discovered file are SURFACED, never silently
  // omitted: an orphan row is a files/history conflict, so a status reader can never
  // render all-green over a ledger that references a missing migration. (planApply
  // independently refuses these first with UNKNOWN_LEDGER_VERSION.)
  // `new Set(iterable)` would itself perform Get(set,'add') and call it, so the set is filled through
  // the BOUND add instead — and its source is an index loop, not `pairSnaps.map`.
  const known = new SetCtor<unknown>();
  for (let i = 0; i < pairCount; i += 1) setAdd(known as never, pairSnaps[i].version);
  const orphanSeen = new SetCtor<unknown>();
  for (let i = 0; i < ledgerCount; i += 1) {
    const row = snaps[i];
    if (!setHas(known as never, row.version) && !setHas(orphanSeen as never, row.version)) {
      setAdd(orphanSeen as never, row.version);
      statuses[sCount] = freeze({
        version: assertVersionLabel(row.version, 'ledger_version'),
        fileChecksum: '',
        ledgerChecksum: safeLedgerChecksum(row.checksum),
        state: 'invalid_history' as const,
      });
      sCount += 1;
    }
  }
  return freeze(statuses) as VersionStatus[];
}

// ---------------------------------------------------------------------------
// Apply / baseline / dirty-resolution PLANNING (pure; refuses fail-closed)
// ---------------------------------------------------------------------------

export interface ApplyPlan {
  pending: MigrationPair[];
}

/**
 * Compute the ordered pending up-migrations. Fails closed (never returns a plan) if the
 * ledger references an UNKNOWN version (not in the discovered set), or any version is
 * dirty_unresolved, checksum_mismatch, or invalid_history — the operator must resolve
 * first. Forward-only: down migrations are never part of an apply plan. Pure planning
 * takes NO credential and NO session — it cannot reach a database.
 */
export function planApply(
  pairs: readonly MigrationPair[],
  ledger: readonly LedgerRow[],
): ApplyPlan {
  // Snapshot every ledger row AND every pair identifier ONCE (D2): planApply reads each row
  // three times — the unknown-version check, status classification, and the forward-only head
  // — so a getter-backed row could report the applied head to the first two reads and an empty
  // value to the third, emptying the head and slipping an out-of-order backfill past the guard
  // that the forward-only contract depends on. Everything below reads only the snapshot.
  const ledgerCount = boundedLength(ledger, 'ledger_length');
  const rows: LedgerRow[] = [];
  for (let i = 0; i < ledgerCount; i += 1) {
    try {
      const row = ledger[i];
      rows[i] = {
        version: row == null ? undefined : row.version,
        checksum: row == null ? undefined : row.checksum,
        dirty: row == null ? undefined : row.dirty,
        resolution: row == null ? undefined : row.resolution,
      } as unknown as LedgerRow;
    } catch {
      throw engineError(ENGINE_CODES.INVALID_LEDGER_FIELD, 'ledger_row');
    }
  }
  const pairCount = boundedLength(pairs, 'pairs_length');
  const pairSnap: MigrationPair[] = [];
  // EVERY field of the pair is captured in the SAME single guarded read as its identifiers — the
  // up and down descriptor references included. The returned plan is built from THESE captures and
  // never from a re-read: re-reading `pairs[i]` (or `pairs[i].up`) afterwards lets an accessor or
  // Proxy substitute a different descriptor, and therefore different SQL, into a plan that
  // classification authorized for another version.
  const upRefs: unknown[] = [];
  const downRefs: unknown[] = [];
  const nameRefs: unknown[] = [];
  const modeRefs: unknown[] = [];
  for (let i = 0; i < pairCount; i += 1) {
    try {
      const p = pairs[i];
      const up = p == null ? undefined : p.up;
      upRefs[i] = up;
      downRefs[i] = p == null ? undefined : p.down;
      nameRefs[i] = p == null ? undefined : p.name;
      modeRefs[i] = p == null ? undefined : p.transactionMode;
      pairSnap[i] = {
        version: p == null ? undefined : p.version,
        up: { checksum: up == null ? undefined : up.checksum },
      } as unknown as MigrationPair;
    } catch {
      throw engineError(ENGINE_CODES.INVALID_LEDGER_FIELD, 'pair_field');
    }
  }
  // Every walk below is an INDEX loop and every set operation goes through a BOUND method: the array
  // iterator, `filter`, `map`, and `Set.prototype.has/add` are all overridable prototype properties,
  // and each of these loops decides admission, refusal, or ordering.
  const known = new SetCtor<unknown>();
  for (let i = 0; i < pairCount; i += 1) setAdd(known as never, pairSnap[i].version);
  for (let i = 0; i < ledgerCount; i += 1) {
    const row = rows[i];
    if (!setHas(known as never, row.version)) throw engineError(ENGINE_CODES.UNKNOWN_LEDGER_VERSION, safeVersionSubject(row.version));
  }
  const status = computeStatus(pairSnap, rows);
  const statusCount = boundedLength(status, 'status_length');
  for (let i = 0; i < statusCount; i += 1) {
    const s = status[i];
    if (s.state === 'dirty_unresolved') throw engineError(ENGINE_CODES.UNRESOLVED_DIRTY_ATTEMPT, s.version);
    if (s.state === 'checksum_mismatch') throw engineError(ENGINE_CODES.CHECKSUM_MISMATCH, s.version);
    if (s.state === 'invalid_history') throw engineError(ENGINE_CODES.INVALID_HISTORY, s.version);
  }
  const pendingVersions = new SetCtor<string>();
  const pendingList: string[] = [];
  let pendingCount = 0;
  for (let i = 0; i < statusCount; i += 1) {
    const s = status[i];
    if (s.state !== 'unapplied' || setHas(pendingVersions as never, s.version)) continue;
    setAdd(pendingVersions as never, s.version);
    pendingList[pendingCount] = s.version;
    pendingCount += 1;
  }
  // Forward-only ordering: an UNAPPLIED version BELOW any already-recorded version is a
  // retroactive backfill (history rewritten under an applied head) — refused, never
  // silently scheduled out of order.
  // NUMERIC ordering, through the kernel's own comparator. String `<`/`>` ordered '10' before '9', so
  // at this boundary — which admits 1..64-digit versions — a retroactive backfill under an applied
  // head was ACCEPTED and a legitimate forward migration was REFUSED. Every version reaching here has
  // already been proven a canonical digit string by computeStatus.
  let maxRecorded: string | null = null;
  for (let i = 0; i < ledgerCount; i += 1) {
    const v = rows[i].version;
    if (typeof v !== 'string') continue;
    if (maxRecorded === null || versionPrecedes(maxRecorded, v)) maxRecorded = v;
  }
  if (maxRecorded !== null) {
    for (let i = 0; i < pendingCount; i += 1) {
      const v = pendingList[i];
      if (versionPrecedes(v, maxRecorded)) throw engineError(ENGINE_CODES.INVALID_HISTORY, `${v}:out_of_order_backfill`);
    }
  }
  // A CANONICAL SNAPSHOT of each authorized pair is returned, selected BY INDEX against the
  // validated snapshot. The selection is an index loop, not `pairs.filter(...)`: `filter` is an
  // overridable own property on a caller-supplied array, so a hostile caller could otherwise
  // return a pending set that classification never authorized.
  //
  // S1.7G §B: the plan carries ENGINE-OWNED descriptors built from the single capture above, never
  // the caller's own objects. A plan is handed to an executor and may be logged, serialized, or
  // held across an await; returning live caller memory made it a mutable view — rewriting
  // `up.artifact.sql` after this function returned changed the plan's SQL — and left every caller
  // accessor and Proxy trap in it armed to fire inside the executor.
  const pending: MigrationPair[] = [];
  let emitted = 0;
  for (let i = 0; i < pairCount; i += 1) {
    if (setHas(pendingVersions as never, pairSnap[i].version)) {
      const mode = modeRefs[i];
      if (mode !== 'required' && mode !== 'forbidden') {
        throw engineError(ENGINE_CODES.INVALID_TRANSACTION_MODE, safeVersionSubject(pairSnap[i].version));
      }
      pending[emitted] = freeze({
        version: assertVersionLabel(pairSnap[i].version, 'pair_version'),
        name: assertLedgerLabel(nameRefs[i], 255, 'pair_field'),
        up: canonicalDescriptor(upRefs[i], 'pair_field'),
        down: canonicalDescriptor(downRefs[i], 'pair_field'),
        transactionMode: mode,
      });
      emitted += 1;
    }
  }
  return freeze({ pending: freeze(pending) as MigrationPair[] });
}

/**
 * Baseline candidacy is an EXPLICIT pure state: the ledger is empty AND the discovered
 * versions exactly equal the operator allowlist. Anything else is not a candidate.
 */
export function isBaselineCandidate(
  pairs: readonly MigrationPair[],
  ledger: readonly LedgerRow[],
  allowlist: readonly string[],
): boolean {
  // Index loops with guarded reads, never `map`/`every`: those are overridable OWN properties on a
  // caller-supplied array, so `pairs.map = () => ['001','002']` on an EMPTY array used to make an
  // empty history satisfy a two-version allowlist — the exact precondition this predicate exists to
  // enforce. An unexpected own property is IGNORED here (never consulted), so it grants nothing.
  if (boundedLength(ledger, 'ledger_length') !== 0) return false;
  const n = boundedLength(pairs, 'pairs_length');
  if (n !== boundedLength(allowlist, 'allowlist_length')) return false;
  for (let i = 0; i < n; i += 1) {
    let v: unknown;
    let a: unknown;
    try {
      const p = pairs[i];
      v = p == null ? undefined : p.version;
      a = allowlist[i];
    } catch {
      throw engineError(ENGINE_CODES.INVALID_LEDGER_FIELD, 'baseline_field');
    }
    if (typeof v !== 'string' || v !== a) return false;
  }
  return true;
}

export interface BaselinePlan {
  versions: { version: string; checksum: string }[];
  /** Postconditions a live baseline MUST verify before recording (schema, not execute). */
  requiredPostconditions: string[];
  /**
   * Append-preserving planned operator/audit record: a live baseline APPENDS this record
   * alongside the ledger rows. It never deletes or overwrites historical evidence.
   */
  plannedAudit: {
    action: 'record_baseline';
    appendOnly: true;
    versions: string[];
  };
}

/**
 * Plan a one-time baseline. Refuses unless `isBaselineCandidate` holds: the ledger is
 * empty AND the discovered versions exactly equal the caller's allowlist. Baseline
 * RECORDS checksums plus an append-only operator/audit record; it never executes SQL,
 * never infers success from table existence, and never deletes or overwrites history.
 * Live baseline additionally requires separate owner authorization and verified schema
 * postconditions (S1b/operator).
 */
export function planBaseline(
  pairs: readonly MigrationPair[],
  ledger: readonly LedgerRow[],
  allowlist: readonly string[],
): BaselinePlan {
  if (boundedLength(ledger, 'ledger_length') !== 0) throw engineError(ENGINE_CODES.BASELINE_PRECONDITION_FAILED, 'ledger_not_empty');
  if (!isBaselineCandidate(pairs, ledger, allowlist)) {
    throw engineError(ENGINE_CODES.BASELINE_PRECONDITION_FAILED, 'version_allowlist_mismatch');
  }
  // ONE canonical snapshot, read by index under guards and validated to bounded canonical primitives.
  // All three outputs are built from THAT snapshot — never from a fresh walk of the caller's array,
  // whose `map` is an overridable own property that could widen or fabricate a recorded baseline.
  const n = boundedLength(pairs, 'pairs_length');
  const snap: { version: string; checksum: string }[] = [];
  for (let i = 0; i < n; i += 1) {
    let version: unknown;
    let checksum: unknown;
    try {
      const p = pairs[i];
      const up = p == null ? undefined : p.up;
      version = p == null ? undefined : p.version;
      checksum = up == null ? undefined : up.checksum;
    } catch {
      throw engineError(ENGINE_CODES.INVALID_LEDGER_FIELD, 'pair_field');
    }
    snap[i] = {
      version: assertVersionLabel(version, 'pair_version'),
      checksum: assertChecksumHex(checksum, 'pair_checksum'),
    };
  }
  const versions: { version: string; checksum: string }[] = [];
  const requiredPostconditions: string[] = [];
  const auditVersions: string[] = [];
  for (let i = 0; i < n; i += 1) {
    versions[i] = freeze({ version: snap[i].version, checksum: snap[i].checksum });
    requiredPostconditions[i] = `verify_schema_postcondition:${snap[i].version}`;
    auditVersions[i] = snap[i].version;
  }
  // S1.7G §B: DEEP freeze. The wrapper, both arrays, every version record, the planned audit and
  // its own version list all leave inert — `plannedAudit.appendOnly` in particular is the
  // history-preservation promise itself and was previously a writable property.
  return freeze({
    versions: freeze(versions) as { version: string; checksum: string }[],
    requiredPostconditions: freeze(requiredPostconditions) as string[],
    plannedAudit: freeze({
      action: 'record_baseline' as const,
      appendOnly: true as const,
      versions: freeze(auditVersions) as string[],
    }),
  });
}

/**
 * Plan an explicit dirty-attempt resolution. History-preserving: it produces a NEW
 * resolution record; it never deletes the failed attempt and never silently clears dirty.
 * A resolution must link to a corrective forward migration or an operator action — never
 * to an edit of an already-applied migration.
 */
export function planDirtyResolution(input: {
  version: string;
  reasonCategory: string;
  correctiveRef: string;
  at: string;
  status?: LedgerResolution['status'];
}): LedgerResolution {
  // OWN, accessor-free reads: an INHERITED `status` must not rewrite a durable resolution record
  // from 'resolved_failed' to 'resolved_superseded' for an input that declares no status.
  const version: unknown = ownValue(input, 'version');
  const reasonCategory: unknown = ownValue(input, 'reasonCategory');
  const correctiveRef: unknown = ownValue(input, 'correctiveRef');
  const at: unknown = ownValue(input, 'at');
  const status: unknown = ownValue(input, 'status');
  if (!version || !reasonCategory || !correctiveRef || !at) {
    throw engineError(ENGINE_CODES.INVALID_HISTORY, 'incomplete_resolution');
  }
  // F8: the status must be one of the two canonical values, and every ledger/operator string
  // copied into the resolution record is validated to a bounded, printable-ASCII primitive —
  // SQL, absolute paths, credentials, control characters, and oversized strings are refused,
  // so a resolution record can never carry raw content into serialized output.
  let resolvedStatus: LedgerResolution['status'];
  if (status === undefined || status === 'resolved_failed') resolvedStatus = 'resolved_failed';
  else if (status === 'resolved_superseded') resolvedStatus = 'resolved_superseded';
  else throw engineError(ENGINE_CODES.INVALID_LEDGER_FIELD, 'resolution_status');
  // S1.7G §B: the resolution record is a DURABLE-ledger candidate, so it leaves frozen — a holder
  // cannot rewrite `status` from 'resolved_failed' to 'resolved_superseded' after it was built.
  return freeze({
    status: resolvedStatus,
    at: assertLedgerLabel(at, 64, 'resolution_at'),
    reasonCategory: assertLedgerLabel(reasonCategory, 200, 'reason_category'),
    correctiveRef: assertLedgerLabel(correctiveRef, 200, 'corrective_ref'),
  });
}

// ---------------------------------------------------------------------------
// Credential boundary (values never inspected/logged)
// ---------------------------------------------------------------------------

export interface CredentialClassification {
  purpose: CredentialPurpose;
  migratorRef?: string;
  runtimeRef?: string;
}

/**
 * Assert a credential may drive a migration run. S1 accepts ONLY a 'migration'-classified
 * credential: 'runtime' is ALWAYS rejected, and 'test' — the future S1b disposable-
 * PostgreSQL harness classification — ALSO fails closed in S1. There is deliberately NO
 * caller-suppliable enabling input: the former `allowTestCredential` Boolean was removed
 * because any generic JavaScript/TypeScript caller could set it, which is a forgeable
 * capability, not a boundary. S1b may widen this only through a dedicated disposable-test
 * entry point once local-host, throwaway-database, and harness-safety validation exists.
 * A migrator whose value equals the runtime value is rejected. Comparison is by injected
 * opaque strings ONLY — neither value is logged, returned, or included in an error
 * message.
 */
export function assertMigratorCredential(input: CredentialClassification): void {
  // Snapshot every field ONCE. A caller-supplied classification whose `purpose` (or a ref)
  // is a getter returning different values per read must not satisfy one guard on one read
  // and dodge the next on another — the value that clears a guard is the value the next
  // guard, and the run, then sees. S1 admits ONLY a stable literal 'migration'.
  // OWN, accessor-free reads. A plain `input.migratorRef` walks the prototype chain, so
  // `Object.prototype.migratorRef='m'; Object.prototype.runtimeRef='r'` let a bare
  // `{purpose:'migration'}` satisfy BOTH the primitive-shape guard and the distinctness guard — the
  // exact self-assertion this function exists to refuse.
  const purpose: unknown = ownValue(input, 'purpose');
  const migratorRef: unknown = ownValue(input, 'migratorRef');
  const runtimeRef: unknown = ownValue(input, 'runtimeRef');
  if (purpose === 'runtime') {
    throw engineError(ENGINE_CODES.RUNTIME_CREDENTIAL_REJECTED);
  }
  if (purpose !== 'migration') {
    throw engineError(ENGINE_CODES.CREDENTIAL_PURPOSE_REJECTED);
  }
  // F3: a migration classification is not self-assertable by purpose alone. It MUST declare a
  // migrator reference AND a runtime reference, each a NON-EMPTY PRIMITIVE STRING — a boxed
  // String object, a getter returning an object, or any other coercible/non-primitive value is
  // refused. This closes the reference-equality bypass where two distinct String('x') wrappers
  // (=== is false) would slip the same underlying credential value past the equality check.
  // Binding these references to the LIVE database credential is the S1b driver obligation; S1
  // enforces only their canonical primitive shape and distinctness.
  if (
    typeof migratorRef !== 'string' || migratorRef.length === 0 ||
    typeof runtimeRef !== 'string' || runtimeRef.length === 0
  ) {
    throw engineError(ENGINE_CODES.INVALID_CREDENTIAL_REF);
  }
  if (migratorRef === runtimeRef) {
    throw engineError(ENGINE_CODES.CREDENTIAL_EQUALITY_REJECTED);
  }
}

/** Refuse a migrator connection mode that cannot hold a session advisory lock. */
export function assertMigratorConnectionMode(mode: ConnectionMode): void {
  if (mode !== 'direct' && mode !== 'session') {
    // The REJECTED value is never echoed. `connectionMode` is the one dependency whose
    // real-world value derives from connection configuration, so echoing it back is precisely
    // how a connection string or credential reaches an error message — and by definition the
    // value at this throw site is not one of the two accepted literals. The stable code alone
    // identifies the refusal, matching assertMigratorCredential, which also carries no subject.
    throw engineError(ENGINE_CODES.MIGRATOR_CONNECTION_MODE_REJECTED);
  }
}

// ---------------------------------------------------------------------------
// Reserved-session + ledger PORTS (S1b implements; S1 tests with fakes)
// ---------------------------------------------------------------------------

/** Opaque backend identity (e.g. pg_backend_pid). Compared by `token` only. */
export interface BackendIdentity {
  token: string;
}

/** A schema transaction, running on the ONE reserved session. */
export interface SchemaTx {
  backendIdentity(): Promise<BackendIdentity>;
  /**
   * Execute the checksum-bound artifact's SQL in S1b. Receives the IMMUTABLE artifact
   * from discovery — never a path — so it cannot reread a file changed after checksum
   * validation. Never called with real SQL in S1.
   */
  execute(artifact: MigrationArtifact): Promise<void>;
}

/**
 * One reserved physical session held for the WHOLE run (lock + ledger + every tx).
 *
 * S1.1 CLEANUP CONTRACT (binding on the S1b adapter): PostgreSQL session advisory locks
 * survive until explicitly unlocked or the PHYSICAL session ends. A generic pool release
 * (e.g. Postgres.js `reserved.release()`) returns the connection to the pool WITHOUT
 * ending the backend — a still-held lock would poison the pool. The engine therefore
 * distinguishes a clean `close()` from a destroying `terminate()` and only ever pools a
 * session whose unlock was VERIFIED successful on a stable backend identity.
 */
export interface ReservedSession {
  backendIdentity(): Promise<BackendIdentity>;
  /**
   * BOUNDED acquisition of the run's session-scoped advisory lock: a non-blocking try
   * (pg_try_advisory_lock) or a bounded-timeout acquire. NEVER an unbounded
   * pg_advisory_lock wait. Returns false when the lock was not acquired within the bound.
   */
  acquireRunLock(key: number): Promise<boolean>;
  /**
   * Explicit unlock with a VERIFIED result (pg_advisory_unlock): true only when THIS
   * session held and released the lock. false (or a throw) means lock ownership is
   * uncertain — the engine then terminates the session instead of pooling it.
   */
  releaseRunLock(key: number): Promise<boolean>;
  begin<T>(fn: (tx: SchemaTx) => Promise<T>): Promise<T>;
  /** Non-transactional execution path for `transaction: forbidden` migrations. */
  executeNonTransactional(artifact: MigrationArtifact): Promise<void>;
  /**
   * CLEAN release of the reserved session (S1b: e.g. return the reserved connection to
   * its pool). The engine calls this ONLY on the fully verified path: every migration
   * finalized, backend identity stable throughout, and releaseRunLock returned true.
   */
  close(): Promise<void>;
  /**
   * DESTROY the physical connection/backend (S1b: end/destroy the socket — NOT a pool
   * release) so PostgreSQL session-end semantics drop any advisory lock and abort any
   * open transaction. Called on EVERY uncertain path: a failure after the lock may have
   * been acquired, an unverified/failed unlock, or a changed backend identity. A
   * potentially locked session must never reach a reusable pool.
   */
  terminate(): Promise<void>;
}

export interface ReservedSessionAdapter {
  reserve(mode: ConnectionMode): Promise<ReservedSession>;
}

/**
 * Ledger port. Every operation runs on the SAME reserved session so the dirty marker and
 * the finalize share the run's single backend. `insertDirtyAttempt` commits in its own
 * transaction on that session (so it survives a rolled-back schema transaction);
 * `finalizeApplied` runs inside the schema transaction (SchemaTx) for a 'required'
 * migration, or on the session for a 'forbidden' one. Rows carry version/checksum/
 * timestamps ONLY — never SQL text.
 */
export interface MigrationLedgerPort {
  insertDirtyAttempt(session: ReservedSession, row: { version: string; checksum: string; startedAt: string }): Promise<void>;
  finalizeApplied(handle: SchemaTx | ReservedSession, row: { version: string; checksum: string; finishedAt: string }): Promise<void>;
}

/**
 * Read + validate a backend identity token as a bounded runtime STRING PRIMITIVE (F6/F7). The
 * identity object is caller-supplied and reached THROUGH an execution event, so `.token` is taken
 * from its property DESCRIPTOR (S1.7E): an ACCESSOR-backed token is refused WITHOUT BEING INVOKED,
 * rather than being called inside a try/catch. Bounding a getter's throw was never the same as not
 * running it — a `token` getter that RETURNED a value used to supply the very identity the kernel
 * captures. A missing, accessor-backed, non-string, empty, or oversized token is refused with the
 * one bounded code. The result is a primitive string, so an adapter that reuses and mutates one
 * identity object across a real backend switch cannot keep the captured value equal. Engine-branded
 * so it survives a guarded callback (e.g. begin) rather than being downgraded to a port failure.
 */
function readBackendToken(identity: BackendIdentity): string {
  if (identity === null || typeof identity !== 'object') throw engineError(ENGINE_CODES.INVALID_BACKEND_IDENTITY);
  const desc = descriptorOf(identity as object, 'token');
  if (desc === undefined || desc.get !== undefined || desc.set !== undefined) {
    throw engineError(ENGINE_CODES.INVALID_BACKEND_IDENTITY);
  }
  const token: unknown = desc.value;
  if (typeof token !== 'string' || token.length === 0 || token.length > 256) {
    throw engineError(ENGINE_CODES.INVALID_BACKEND_IDENTITY);
  }
  return token;
}

/**
 * Execute-time CANONICALIZATION + integrity of the checksum-to-execution binding. Descriptors
 * and plans are plain, caller-controlled structures — an exported-boundary caller may hand a
 * Proxy, a getter-backed object, or a mutable object whose `sql`/`bytes` differ between the
 * integrity read and the execution read (a time-of-check/time-of-use substitution). So every
 * field is read EXACTLY ONCE into a private snapshot; the snapshot is verified — declared
 * checksum, re-hashed bytes, AND re-encoded sql must all equal the expected checksum, and the
 * declared direction/version must be canonical primitives — and a NEW FROZEN artifact built
 * from those snapshots is returned. Execution runs ONLY this canonical snapshot, so a later
 * re-read of the (possibly hostile) source cannot substitute different SQL. A missing,
 * throwing, tampered, or lost artifact fails closed as a checksum mismatch.
 */
function canonicalizeArtifact(
  artifact: MigrationArtifact | undefined,
  expectedChecksum: string,
  version: string,
): MigrationArtifact {
  let declaredChecksum: unknown;
  let declaredDirection: unknown;
  let declaredVersion: unknown;
  let sqlSnap: unknown;
  let bytesSnap = new U8();
  try {
    if (!artifact || typeof artifact !== 'object') throw new Error('no artifact');
    // Each read triggers any getter/Proxy exactly ONCE; the values captured here are the
    // only values validated and executed.
    declaredChecksum = artifact.checksum;
    declaredDirection = artifact.direction;
    declaredVersion = artifact.version;
    sqlSnap = artifact.sql;
    bytesSnap = new U8(artifact.bytes);
  } catch {
    throw engineError(ENGINE_CODES.CHECKSUM_MISMATCH, safeVersionSubject(version));
  }
  if (
    typeof declaredChecksum !== 'string' ||
    typeof sqlSnap !== 'string' ||
    typeof declaredVersion !== 'string' ||
    (declaredDirection !== 'up' && declaredDirection !== 'down') ||
    declaredChecksum !== expectedChecksum ||
    sha256Hex(bytesSnap) !== expectedChecksum ||
    sha256Hex(utf8Encode(UTF8_ENCODER, sqlSnap)) !== expectedChecksum
  ) {
    throw engineError(ENGINE_CODES.CHECKSUM_MISMATCH, safeVersionSubject(version));
  }
  return freeze({
    version: declaredVersion as string,
    direction: declaredDirection as Direction,
    checksum: declaredChecksum as string,
    get bytes(): Uint8Array {
      return new U8(bytesSnap);
    },
    sql: sqlSnap as string,
  });
}

export interface RunDeps {
  adapter: ReservedSessionAdapter;
  ledger: MigrationLedgerPort;
  connectionMode: ConnectionMode;
  /**
   * Mandatory at the execution boundary; a runtime credential is refused (D5/D6) and a
   * 'test' credential fails closed in S1 — there is no caller-suppliable enabling field.
   */
  credential: CredentialClassification;
  lockKey: number;
  now: () => string;
}

/**
 * Choreograph the apply of an ordered plan through the injected ports on ONE reserved
 * session. Credential purpose (S1: migration-classified only — runtime AND test fail
 * closed, with no caller-suppliable bypass) and connection mode are validated first. Backend identity is verified after reservation, after lock
 * acquisition, as the first act inside each schema transaction (before schema SQL),
 * after each transaction, and before unlock — a changed backend fails closed before any
 * further schema statement. Execution receives each migration's checksum-bound ARTIFACT
 * (bytes read once at discovery), never a path.
 *
 * 'required': commit a dirty marker first (own tx on the session), then apply schema +
 * finalize inside one transaction (both roll back together on failure while the marker
 * survives). 'forbidden': mark dirty before any statement, execute non-transactionally
 * (partial execution is potentially irreversible), and finalize only after full success.
 *
 * CLEANUP INVARIANT: `close()` (pool-safe) runs ONLY on the single fully verified path —
 * run complete, identity stable, and releaseRunLock() VERIFIED true. Every other path —
 * lock unavailable, any port/schema failure, identity change, unlock false or thrown —
 * TERMINATES the physical session (session-end drops the advisory lock), so an uncertain
 * or potentially locked backend never returns to a reusable pool. A close() failure on
 * the clean path stays visible as a bounded failure and escalates to termination; the
 * terminate() itself is best-effort so it can never mask the primary error.
 *
 * S1 never provides a real adapter (apply is fail-closed at the CLI); tests inject fakes.
 */
export async function runMigrations(_plan: ApplyPlan, _deps: RunDeps): Promise<void> {
  // FAIL-CLOSED COMPATIBILITY SHIM. The provider-independent apply choreography now lives in the
  // PURE decision kernel (startMigrationExecution / stepMigrationExecution); the LIVE effect
  // interpreter that turns kernel effects into real port calls, together with the migrator
  // credential, the reserved PostgreSQL session, deadlines, cancellation, and physical disposal,
  // is an S1b executor/adapter obligation — NOT this module.
  //
  // This exported entry point refuses UNCONDITIONALLY with one stable bounded code BEFORE it reads
  // any argument property, evaluates any getter, triggers any Proxy trap, validates any credential,
  // reads any port or dependency, reserves a session, accesses the ledger, acquires a lock, starts a
  // transaction, executes schema behaviour, or releases/terminates anything. No caller-supplied deps
  // — however well-formed — can drive execution through it. The parameters are deliberately UNREAD
  // (prefixed `_`), and the error carries no caller-controlled data.
  throw engineError(ENGINE_CODES.MIGRATION_EXECUTION_UNAVAILABLE);
}

// ---------------------------------------------------------------------------
// PURE execution decision kernel (S1.7B) — port-FREE choreography model.
//
// The exported runMigrations is a fail-closed compatibility shim; the LIVE effect
// interpreter — the code that turns these inert effects into real port calls — is an S1b
// obligation, NOT this module. This kernel is the provider-independent decision core:
// startMigrationExecution() validates the plan + scalar deps and returns the FIRST inert
// effect; stepMigrationExecution() consumes the executor's report of an effect's result
// (an inert event) and returns the NEXT effect or a terminal verdict. It NEVER holds or
// invokes a session, ledger, adapter, clock, promise, or database client; performs no
// filesystem/network/timer/process/SQL work; and reads no env or global.
//
// S1.7D — STRUCTURAL DETERMINISM. The kernel is a function of the DATA it is given and of nothing
// else. It holds no WeakSet, WeakMap, Map, Set, registry, module cache, brand, symbol, or
// construction-origin check, so no hidden state and no object identity can influence a transition.
// Both public inputs — the state and the event — are treated as UNKNOWN and passed through a
// bounded CANONICAL CAPTURE before any transition logic runs: exact own-key sets, closed
// discriminant and primitive domains, hard size bounds, a re-verified sql↔checksum binding, and a
// full choreography-grammar check on the program. Every value the kernel returns is then NEWLY
// ALLOCATED and deeply frozen from that canonical snapshot, so no caller-owned reference — and no
// caller-owned mutation — can reach or later influence a result. Equivalent canonical data
// therefore produces an equivalent bounded decision whether it was built internally, by a test, by
// a caller, by deserialization, or through a behaviorally transparent wrapper.
//
// WHY THAT IS SAFE. A structurally valid caller-built snapshot can run an inert SIMULATION, and
// that grants nothing: the kernel holds no port, mints no capability, stamps no trust marker, and
// every effect it returns is frozen primitive DATA that cannot execute SQL or reach a port by
// itself. The future S1b executor MUST build its own canonical program through its own trusted
// validation boundary and must never treat a caller-supplied state, event, KernelResult, or effect
// as authorization to execute anything. Timeouts are modeled as EVENTS: the kernel decides the
// outcome AFTER a timeout (destroy a CONFIRMED live session; direct explicit cancellation AND
// disposal when a reservation never settled) but implements no real time limit, cancellation,
// late-settlement suppression, or physical disposal — those are S1b executor/adapter duties.
// ---------------------------------------------------------------------------

/** Scalar deps the kernel validates — NO ports, NO clock, NO adapter/ledger/database client. */
export interface ExecutionDeps {
  connectionMode: ConnectionMode;
  credential: CredentialClassification;
  lockKey: number;
}

/** One inert, frozen, primitive-only operation description for the future S1b executor.
 *  Execution effects carry the canonical artifact's verified PRIMITIVE fields (sql/checksum/
 *  version/direction) — never the artifact object or its bytes getter. */
export type ExecutionEffect =
  | { readonly kind: 'reserve'; readonly connectionMode: ConnectionMode }
  | { readonly kind: 'capture_identity' }
  | { readonly kind: 'acquire_lock'; readonly lockKey: number }
  | { readonly kind: 'verify_identity' }
  /** `txMode` is the migration artifact's DECLARED transaction mode, bound into canonical data beside
   *  the version and checksum it belongs to. It DRIVES the choreography parse rather than being
   *  inferred from it, so one canonical snapshot cannot declare `required` while carrying
   *  forbidden-mode choreography, or declare `forbidden` while carrying a transaction bracket. */
  | { readonly kind: 'insert_dirty'; readonly version: string; readonly checksum: string; readonly txMode: TransactionMode }
  | { readonly kind: 'open_tx' }
  | { readonly kind: 'execute'; readonly txScoped: boolean; readonly version: string; readonly direction: Direction; readonly checksum: string; readonly sql: string }
  | { readonly kind: 'finalize'; readonly txScoped: boolean; readonly version: string; readonly checksum: string }
  | { readonly kind: 'commit_tx' }
  | { readonly kind: 'release_lock'; readonly lockKey: number }
  | { readonly kind: 'close' };

/** The executor's inert report of the result of the last emitted effect. `identity` carries the
 *  BackendIdentity the executor read; the kernel validates it to a bounded primitive token and
 *  compares against the t0 snapshot (an adapter that reuses+mutates one object cannot fool it).
 *  `port_failed`/`timeout` model a thrown or non-settling port operation. */
export type ExecutionEvent =
  | { readonly type: 'reserved' }
  | { readonly type: 'identity'; readonly identity: BackendIdentity }
  | { readonly type: 'lock'; readonly acquired: unknown }
  | { readonly type: 'unlock'; readonly released: unknown }
  | { readonly type: 'ok' }
  | { readonly type: 'port_failed' }
  | { readonly type: 'timeout' };

export type ExecutionOutcome = 'in_progress' | 'complete' | 'refused' | 'failed';
/**
 * The cleanup obligation a verdict places on the future S1b executor/adapter. These are DIRECTIVES
 * expressed as inert data; the kernel holds no handle, no deadline, and no cancellation primitive,
 * so it performs none of them itself.
 *
 *   'none'               Nothing outstanding and nothing held. Either a clean completion (the one
 *                        pool-eligible path), a refusal raised before anything was attempted, or a
 *                        reservation that SETTLED as a failure — the attempt is over, so there is
 *                        nothing to cancel and no resource to dispose of.
 *   'terminate'          A session handle is CONFIRMED held and its state is uncertain: DESTROY the
 *                        physical connection (session end drops the advisory lock and aborts any
 *                        open transaction). Never return it to a reusable pool.
 *   'cancel_and_dispose' Ownership is UNKNOWN to the kernel, so it names BOTH halves of the cleanup
 *                        it cannot perform: CANCEL the outstanding acquisition attempt, and DISPOSE
 *                        of any session that is already held OR that SETTLES LATE — after this
 *                        verdict was returned. Emitted for a reservation TIMEOUT (the attempt never
 *                        settled, so a backend may still be created afterwards) and for any state
 *                        the kernel did not build (it can confirm nothing about what the caller
 *                        holds). This is deliberately NOT 'none': "nothing to do" would be wrong on
 *                        precisely the path where a resource may still come into existence. It is
 *                        also deliberately NOT 'terminate': the kernel never claims it can destroy a
 *                        physical resource for which it never received a handle.
 */
export type ExecutionDisposition = 'none' | 'terminate' | 'cancel_and_dispose';

export interface ExecutionState {
  readonly outcome: ExecutionOutcome;
  readonly disposition: ExecutionDisposition;
  readonly code: EngineCode | null;
  /** True whenever the kernel cannot establish what physical resource (if any) this run owns: a
   *  reservation that TIMED OUT before a confirmed handle, or a state the kernel did not build.
   *  INVARIANT: `ownershipUncertain === true` ALWAYS carries `disposition: 'cancel_and_dispose'`,
   *  so uncertainty is never reported as "nothing to do" — the executor must cancel the outstanding
   *  attempt and dispose of anything already held or settling late. Normalized in terminalResult(),
   *  not at the call sites, so the two fields cannot drift apart. */
  readonly ownershipUncertain: boolean;
  readonly program: readonly ExecutionEffect[];
  readonly cursor: number;
  readonly expectedToken: string | null;
  readonly sessionLive: boolean;
}

export interface KernelResult {
  readonly state: ExecutionState;
  readonly effects: readonly ExecutionEffect[];
}

const NO_EFFECTS: readonly ExecutionEffect[] = Object.freeze([]);

// ---------------------------------------------------------------------------
// CANONICAL INPUT CAPTURE (S1.7D) — the kernel's only contact with caller structure.
//
// `ExecutionState` and `ExecutionEvent` are plain EXPORTED interfaces, so a generic JavaScript
// caller can hand-build, clone, deserialize, mutate, or wrap one. S1.7C answered that with a
// module-private origin registry, which made a result depend on hidden state and construction
// IDENTITY — structurally equal inputs got different answers. S1.7D answers it with STRUCTURE
// instead: every caller-supplied value is captured into a bounded canonical snapshot before any
// transition logic runs, and only that snapshot is used.
//
// The capture is deliberately narrow and finite. It descends a FIXED shape — state → program →
// effect → primitives, and event → identity → token — and never recurses on an unknown field, so a
// cyclic input is structurally impossible to follow rather than merely detected. It performs no
// property GET on caller-supplied state: values are taken from property DESCRIPTORS, so an accessor
// is rejected WITHOUT being invoked and a hostile `get` trap is never reached. Exceptions from the
// traps it does touch (ownKeys, getOwnPropertyDescriptor) are caught and converted to a stable
// bounded verdict with zero effects; no trap output, exception name, message, or stack escapes.
//
// HONEST LIMIT — PROXIES. JavaScript offers NO general mechanism that detects every behaviorally
// transparent Proxy, and this module does not claim one. The contract is therefore not detection:
// a wrapper that exposes the same bounded primitive data canonicalizes to the same snapshot and
// receives the SAME result, while sharing no reference with anything returned; a wrapper whose trap
// throws, whose values violate the bounded schema, or whose shape is contradictory produces zero
// effects and a stable bounded failure. Wrapper identity grants and removes nothing either way.
// ---------------------------------------------------------------------------

/**
 * INTRINSICS RESOLVED AND BOUND AT MODULE LOAD, before any caller code in this realm can run.
 * Capture and result construction go through these bound references instead of live global lookups,
 * because every one of them sits on a validation or isolation path and every one is a MUTABLE
 * global. Re-pointing `Reflect.ownKeys` makes two structurally identical states decide differently
 * (breaking determinism); re-pointing `Array.prototype.push` makes the rebuild store the CALLER's
 * own objects (breaking reference isolation); re-pointing `Object.freeze` turns a bounded refusal
 * into an escaping raw exception; re-pointing `Array.prototype.indexOf` makes a closed domain accept
 * anything. Reading a mutable global at call time IS a hidden-state read, so binding these is what
 * MAKES this kernel a function of its inputs. None of them is a provenance, origin, or authority
 * mechanism: they are pure operations, resolved once.
 *
 * Residual, deliberately out of scope and unchanged: an attacker who patches an intrinsic BEFORE
 * this module is imported already owns the realm.
 */
/** Hard structural bounds. Anything beyond them is unbounded caller input, not a choreography this
 *  kernel models. All are far above what buildProgram() can produce from a real migration set, so an
 *  engine-built program always satisfies the very same capture a caller-built one must. */
const MAX_PROGRAM_EFFECTS = 4096;
/** Bounds `plan.pending` BEFORE buildProgram hashes anything. Without it a caller-supplied plan with
 *  500,000 entries would run two SHA-256 passes per entry and only then be refused by the program
 *  cap below — the bound must come first, not after the work. 512 pairs × 7 effects + 8 < 4096. */
const MAX_PENDING_PAIRS = 512;
const MAX_SQL_LENGTH = 4 * 1024 * 1024;
/** Aggregate SQL across a whole program. `stepMigrationExecution` re-canonicalizes — and therefore
 *  re-hashes — the ENTIRE program on EVERY step, which is exactly the property that lets it trust
 *  nothing between calls. That makes total work Θ(steps × program SQL), so the per-migration cap
 *  alone is not enough: this bounds the per-step cost, and hence the whole run. Enforced on both
 *  the producing and the capture side with the same value, so neither can reject what the other
 *  accepts. */
const MAX_PROGRAM_SQL_LENGTH = 8 * 1024 * 1024;
const MAX_TOKEN_LENGTH = 256;

/** The EXACT own-key set each variant may carry. A missing key, an extra key, a symbol key, or an
 *  accessor is not a canonical value. These are frozen SHAPE tables — schemas keyed by a
 *  discriminant string — not registries: they hold no object and record no origin. */
const EFFECT_SHAPE: Readonly<Record<string, readonly string[]>> = freeze({
  reserve: freeze(['kind', 'connectionMode']),
  capture_identity: freeze(['kind']),
  acquire_lock: freeze(['kind', 'lockKey']),
  verify_identity: freeze(['kind']),
  insert_dirty: freeze(['kind', 'version', 'checksum', 'txMode']),
  open_tx: freeze(['kind']),
  execute: freeze(['kind', 'txScoped', 'version', 'direction', 'checksum', 'sql']),
  finalize: freeze(['kind', 'txScoped', 'version', 'checksum']),
  commit_tx: freeze(['kind']),
  release_lock: freeze(['kind', 'lockKey']),
  close: freeze(['kind']),
});

const EVENT_SHAPE: Readonly<Record<string, readonly string[]>> = freeze({
  reserved: freeze(['type']),
  identity: freeze(['type', 'identity']),
  lock: freeze(['type', 'acquired']),
  unlock: freeze(['type', 'released']),
  ok: freeze(['type']),
  port_failed: freeze(['type']),
  timeout: freeze(['type']),
});

const STATE_KEYS: readonly string[] = freeze([
  'outcome', 'disposition', 'code', 'ownershipUncertain', 'program', 'cursor', 'expectedToken', 'sessionLive',
]);

/** Every canonical-capture rejection is the same stable bounded refusal: the input is not a kernel
 *  value, and nothing about it — not even its shape — is reported back. */
function invalidInput(subject: string): MigrationEngineError {
  return engineError(ENGINE_CODES.INVALID_EXECUTION_EVENT, subject);
}

/**
 * Read the own DATA properties of a caller-supplied object EXACTLY ONCE into a new null-prototype
 * record. This is the ONLY place caller structure is inspected:
 *   - ONE `Reflect.ownKeys` enumeration, so a hostile ownKeys trap fires once and nowhere else;
 *   - a SYMBOL key or a duplicate key is a rejection outright (no canonical value carries one);
 *   - each value is taken from the property DESCRIPTOR, so an ACCESSOR is detected and rejected
 *     WITHOUT BEING INVOKED — on every key, with no exemption (S1.7E). S1.7D exempted three event
 *     slots and read them through a property GET "under a guard", but a guard bounds the THROW, it
 *     does not stop the CALL: caller code ran inside the kernel and could CHOOSE the transition (a
 *     `true`-returning `acquired` getter acquired the lock), so structurally identical input
 *     decided differently depending on how its value was BACKED. Canonical data is data;
 *   - the source object is never consulted again, and no reference to it is retained.
 *
 * A hostile ownKeys/getOwnPropertyDescriptor trap MAY throw out of this function, and that is
 * deliberate: every path into it already sits inside a total catch that converts ANY throw into the
 * same bounded verdict with zero effects. Catching here as well would add an unreachable duplicate
 * handler — untestable code masquerading as defence in depth — instead of a second real barrier.
 * The single conversion point is directly exercised by the trap-throwing wrapper tests.
 */
function captureOwnData(source: unknown, subject: string): Record<string, unknown> {
  if (source === null || typeof source !== 'object') throw invalidInput(subject);
  const own = ownKeysOf(source as object);
  const out: Record<string, unknown> = objectCreate(null) as Record<string, unknown>;
  for (let i = 0; i < own.length; i += 1) {
    const key = own[i];
    if (typeof key !== 'string' || hasOwn(out, key)) throw invalidInput(subject);
    const desc = descriptorOf(source as object, key);
    if (desc === undefined || desc.get !== undefined || desc.set !== undefined) throw invalidInput(subject);
    out[key] = desc.value;
  }
  return out;
}

/** Require an EXACT key set — no extra field, no missing field, no renamed field. */
function requireExactKeys(data: Record<string, unknown>, keys: readonly string[], subject: string): void {
  if (keysOf(data).length !== keys.length) throw invalidInput(subject);
  for (let i = 0; i < keys.length; i += 1) if (!hasOwn(data, keys[i])) throw invalidInput(subject);
}

/**
 * Capture a caller-supplied array by DESCRIPTOR, bounded, read-once, without a single property get.
 * The container must be a genuine Array whose own keys are EXACTLY its indices plus `length`: an
 * array-like object, an extra own property (`program.smuggled = {...}`), or a symbol key is not a
 * canonical program. `isArray` sees THROUGH a Proxy, so a transparent wrapper over a real array is
 * still accepted — the check constrains the shape, never the wrapper.
 */
function captureArray(source: unknown, subject: string, max: number): unknown[] {
  if (!isArray(source)) throw invalidInput(subject);
  const lenDesc = descriptorOf(source as object, 'length');
  if (lenDesc === undefined || lenDesc.get !== undefined || lenDesc.set !== undefined) throw invalidInput(subject);
  const n = lenDesc.value;
  if (typeof n !== 'number' || !isSafeInteger(n) || n < 0 || n > max) throw invalidInput(subject);
  if (ownKeysOf(source as object).length !== n + 1) throw invalidInput(subject);
  // An array LITERAL, never `new Array(n)`: the latter is a live global lookup, and a constructor
  // that RETURNS an object yields that object — a re-pointed `globalThis.Array` would otherwise hand
  // the kernel an attacker-owned, accessor-backed container to write the canonical program into.
  const out: unknown[] = [];
  for (let i = 0; i < n; i += 1) {
    const d = descriptorOf(source as object, `${i}`);
    if (d === undefined || d.get !== undefined || d.set !== undefined) throw invalidInput(subject);
    out[i] = d.value;
  }
  return out;
}

const canonicalVersion = (v: unknown): string => {
  if (!isDigitString(v, 64)) throw invalidInput('effect_version');
  return v;
};
const canonicalChecksum = (v: unknown): string => {
  if (!isLowerHex(v, 64)) throw invalidInput('effect_checksum');
  return v;
};
const canonicalLockKey = (v: unknown): number => {
  if (typeof v !== 'number' || !isSafeInteger(v)) throw invalidInput('effect_lock_key');
  return v;
};
const canonicalBool = (v: unknown, subject: string): boolean => {
  if (typeof v !== 'boolean') throw invalidInput(subject);
  return v;
};
/** The artifact's DECLARED transaction mode — a closed two-value domain, required on every block. */
const canonicalTxMode = (v: unknown): TransactionMode => {
  if (v !== 'required' && v !== 'forbidden') throw invalidInput('effect_tx_mode');
  return v;
};
const canonicalReserveMode = (v: unknown): ConnectionMode => {
  // The SAME two literals assertMigratorConnectionMode accepts — a pooled 'transaction' backend
  // cannot hold a session advisory lock across commits, and 'unknown' was never validated.
  if (v !== 'direct' && v !== 'session') throw invalidInput('effect_connection_mode');
  return v;
};
/** F2 on the effect path: the SQL a program carries must re-hash to the checksum bound beside it,
 *  so a caller cannot pair arbitrary SQL with an unrelated checksum inside a canonical program. */
const canonicalSql = (v: unknown, checksum: string): string => {
  if (typeof v !== 'string' || v.length > MAX_SQL_LENGTH) throw invalidInput('effect_sql');
  if (sha256Hex(utf8Encode(UTF8_ENCODER, v)) !== checksum) throw invalidInput('effect_sql_checksum');
  return v;
};

/** Rebuild ONE effect as a frozen, primitive-only, engine-allocated value. */
function canonicalEffect(raw: unknown): ExecutionEffect {
  const d = captureOwnData(raw, 'execution_effect');
  const kind = d.kind;
  if (typeof kind !== 'string' || !hasOwn(EFFECT_SHAPE, kind)) throw invalidInput('effect_kind');
  requireExactKeys(d, EFFECT_SHAPE[kind], 'execution_effect');
  switch (kind) {
    case 'reserve': return freeze({ kind: 'reserve' as const, connectionMode: canonicalReserveMode(d.connectionMode) });
    case 'capture_identity': return freeze({ kind: 'capture_identity' as const });
    case 'acquire_lock': return freeze({ kind: 'acquire_lock' as const, lockKey: canonicalLockKey(d.lockKey) });
    case 'verify_identity': return freeze({ kind: 'verify_identity' as const });
    case 'insert_dirty': return freeze({
      kind: 'insert_dirty' as const,
      version: canonicalVersion(d.version),
      checksum: canonicalChecksum(d.checksum),
      txMode: canonicalTxMode(d.txMode),
    });
    case 'open_tx': return freeze({ kind: 'open_tx' as const });
    case 'execute': {
      const checksum = canonicalChecksum(d.checksum);
      // F1 on the effect path: an apply program executes UP migrations only, never rollback SQL.
      if (d.direction !== 'up') throw invalidInput('effect_direction');
      return freeze({
        kind: 'execute' as const,
        txScoped: canonicalBool(d.txScoped, 'effect_tx_scoped'),
        version: canonicalVersion(d.version),
        direction: 'up' as const,
        checksum,
        sql: canonicalSql(d.sql, checksum),
      });
    }
    case 'finalize': return freeze({
      kind: 'finalize' as const,
      txScoped: canonicalBool(d.txScoped, 'effect_tx_scoped'),
      version: canonicalVersion(d.version),
      checksum: canonicalChecksum(d.checksum),
    });
    case 'commit_tx': return freeze({ kind: 'commit_tx' as const });
    case 'release_lock': return freeze({ kind: 'release_lock' as const, lockKey: canonicalLockKey(d.lockKey) });
    default: return freeze({ kind: 'close' as const });
  }
}

/** Strict numeric order over canonical digit strings, without Number() (which loses precision past
 *  2^53 and would make two distinct 64-digit versions compare equal). Leading zeros are
 *  insignificant, so `'001'` and `'1'` are the SAME version and neither precedes the other. */
function versionPrecedes(a: string, b: string): boolean {
  // Index arithmetic over BOUND character reads — no String method is dispatched. `replace` (and the
  // `RegExp.prototype[Symbol.replace]`/`exec` behind it) are mutable intrinsics, and this comparison
  // decides whether a descending or duplicated program is accepted, so a re-pointed `replace` could
  // otherwise reverse exactly the ordering rule this function exists to enforce.
  const significantStart = (s: string): number => {
    let i = 0;
    while (i < s.length - 1 && charAt(s, i) === 48) i += 1;   // 48 = '0'; a lone '0' keeps one digit
    return i;
  };
  const ia = significantStart(a);
  const ib = significantStart(b);
  const la = a.length - ia;
  const lb = b.length - ib;
  if (la !== lb) return la < lb;
  for (let k = 0; k < la; k += 1) {
    const ca = charAt(a, ia + k);
    const cb = charAt(b, ib + k);
    if (ca !== cb) return ca < cb;
  }
  return false;
}

/**
 * Verify the canonical program is a WELL-FORMED CHOREOGRAPHY, not merely a list of well-formed
 * effects. This is what makes the S1 migration-safety ordering STRUCTURAL rather than a property of
 * who built the array: an out-of-order, truncated, or hand-authored program that skips the dirty
 * marker, the lock, an identity re-verification, the transaction bracket, the finalize, the unlock,
 * or the close does not parse and is refused before it can emit anything. The grammar is exactly the
 * one buildProgram() emits:
 *
 *   reserve · capture_identity · acquire_lock · verify_identity
 *   ( insert_dirty ·
 *       ( open_tx · verify_identity · execute(tx) · finalize(tx) · commit_tx · verify_identity   // required
 *       | verify_identity · execute · verify_identity · finalize · verify_identity )             // forbidden
 *   )*
 *   verify_identity · release_lock · verify_identity · close
 */
function assertChoreography(p: readonly ExecutionEffect[]): void {
  let i = 0;
  const take = <K extends ExecutionEffect['kind']>(kind: K): Extract<ExecutionEffect, { kind: K }> => {
    const e = p[i];
    if (e === undefined || e.kind !== kind) throw invalidInput('execution_program');
    i += 1;
    return e as Extract<ExecutionEffect, { kind: K }>;
  };
  const peek = (): string | undefined => (p[i] === undefined ? undefined : p[i].kind);

  take('reserve');
  take('capture_identity');
  const acquired = take('acquire_lock');
  take('verify_identity');

  let previousVersion: string | null = null;
  while (peek() === 'insert_dirty') {
    const dirty = take('insert_dirty');
    // FORWARD-ONLY ORDERING, enforced ACROSS blocks and not merely within one. planApply refuses a
    // retroactive backfill, but startMigrationExecution accepts any ApplyPlan-shaped object, so
    // without this a plan whose `pending` lists 002 before 001 — or lists 001 twice — would build
    // and run a program that applies migrations out of order or twice. Versions are canonical digit
    // strings, so they are ordered by significant length first and lexicographically within a
    // length; requiring STRICTLY less also makes duplicates impossible.
    if (previousVersion !== null && !versionPrecedes(previousVersion, dirty.version)) {
      throw invalidInput('execution_program');
    }
    previousVersion = dirty.version;
    // The DECLARED mode DRIVES the parse; it is never inferred from the shape it exists to constrain.
    // Before S1.7F this read `peek() === 'open_tx'`, so the program described its own bracketing and
    // was only checked for self-consistency — a migration declared `required` could be represented
    // with the unbracketed forbidden choreography and run its DDL and ledger finalize with no
    // atomicity. A block that declares `required` MUST carry the bracket and one that declares
    // `forbidden` MUST NOT, so a contradiction simply does not parse and emits nothing.
    const txRequired = dirty.txMode === 'required';
    let executed: Extract<ExecutionEffect, { kind: 'execute' }>;
    let finalized: Extract<ExecutionEffect, { kind: 'finalize' }>;
    if (txRequired) {
      take('open_tx');
      take('verify_identity');
      executed = take('execute');
      finalized = take('finalize');
      take('commit_tx');
      take('verify_identity');
    } else {
      take('verify_identity');
      executed = take('execute');
      take('verify_identity');
      finalized = take('finalize');
      take('verify_identity');
    }
    // One migration per block: the dirty marker, the schema statement, and the finalize must all
    // name the SAME version and the SAME checksum, and the transaction scoping must be consistent.
    if (executed.version !== dirty.version || finalized.version !== dirty.version) throw invalidInput('execution_program');
    if (executed.checksum !== dirty.checksum || finalized.checksum !== dirty.checksum) throw invalidInput('execution_program');
    if (executed.txScoped !== txRequired || finalized.txScoped !== txRequired) throw invalidInput('execution_program');
  }

  take('verify_identity');
  const released = take('release_lock');
  take('verify_identity');
  take('close');
  if (i !== p.length) throw invalidInput('execution_program');
  // F5: ONE advisory-lock key for the whole run — the lock released is the lock acquired.
  if (released.lockKey !== acquired.lockKey) throw invalidInput('execution_program');
}

function canonicalProgram(raw: unknown): readonly ExecutionEffect[] {
  const items = captureArray(raw, 'execution_program', MAX_PROGRAM_EFFECTS);
  // Index assignment, NOT `push`: `Array.prototype.push` is a mutable intrinsic, and re-pointing it
  // would let the rebuild silently store the caller's ORIGINAL effect objects instead of the
  // canonical copies — reference isolation lost through a method lookup.
  const rebuilt: ExecutionEffect[] = [];
  let programSqlLength = 0;
  for (let i = 0; i < items.length; i += 1) {
    const effect = canonicalEffect(items[i]);
    if (effect.kind === 'execute') {
      programSqlLength += effect.sql.length;
      if (programSqlLength > MAX_PROGRAM_SQL_LENGTH) throw invalidInput('execution_program');
    }
    rebuilt[i] = effect;
  }
  assertChoreography(rebuilt);
  return freeze(rebuilt);
}

/**
 * Rebuild a caller-supplied state as a bounded canonical snapshot, or refuse. Beyond field domains
 * this rejects CONTRADICTORY states — combinations the machine can never actually be in:
 *   - `ownershipUncertain` must hold exactly when `disposition` is 'cancel_and_dispose';
 *   - a TERMINAL verdict is fully described by (outcome, disposition, code): empty program, cursor
 *     0, no token, not live — and 'complete' alone carries no code and disposition 'none';
 *   - an IN-PROGRESS state carries no code, disposition 'none', a grammar-valid program, and a
 *     cursor that is IN RANGE (an exhausted cursor has no current effect and is not a state);
 *   - liveness and the captured identity token follow the trajectory exactly — the session becomes
 *     live only after the `reserve` step, and the token exists only after `capture_identity` — so a
 *     caller cannot present a mid-run position it could not have reached step by step.
 */
function canonicalExecutionState(raw: unknown): ExecutionState {
  const d = captureOwnData(raw, 'execution_state');
  requireExactKeys(d, STATE_KEYS, 'execution_state');

  const outcome = d.outcome;
  if (outcome !== 'in_progress' && outcome !== 'complete' && outcome !== 'refused' && outcome !== 'failed') {
    throw invalidInput('state_outcome');
  }
  const disposition = d.disposition;
  if (disposition !== 'none' && disposition !== 'terminate' && disposition !== 'cancel_and_dispose') {
    throw invalidInput('state_disposition');
  }
  const rawCode = d.code;
  if (rawCode !== null && !isEngineCode(rawCode)) throw invalidInput('state_code');
  const code = rawCode as EngineCode | null;
  const ownershipUncertain = canonicalBool(d.ownershipUncertain, 'state_ownership');
  if (ownershipUncertain !== (disposition === 'cancel_and_dispose')) throw invalidInput('state_ownership');
  const sessionLive = canonicalBool(d.sessionLive, 'state_session_live');
  const cursor = d.cursor;
  if (typeof cursor !== 'number' || !isSafeInteger(cursor) || cursor < 0) throw invalidInput('state_cursor');
  const rawToken = d.expectedToken;
  if (rawToken !== null && (typeof rawToken !== 'string' || rawToken.length === 0 || rawToken.length > MAX_TOKEN_LENGTH)) {
    throw invalidInput('state_expected_token');
  }
  const expectedToken = rawToken as string | null;

  if (outcome !== 'in_progress') {
    if (captureArray(d.program, 'execution_program', MAX_PROGRAM_EFFECTS).length !== 0) throw invalidInput('state_program');
    if (cursor !== 0 || expectedToken !== null || sessionLive) throw invalidInput('state_terminal_shape');
    if (outcome === 'complete' ? (code !== null || disposition !== 'none') : code === null) throw invalidInput('state_terminal_shape');
    return freeze({
      outcome, disposition, code, ownershipUncertain,
      program: NO_EFFECTS, cursor: 0, expectedToken: null, sessionLive: false,
    });
  }

  if (code !== null || disposition !== 'none' || ownershipUncertain) throw invalidInput('state_in_progress_shape');
  const program = canonicalProgram(d.program);
  if (cursor >= program.length) throw invalidInput('state_cursor');
  if (sessionLive !== (cursor >= 1)) throw invalidInput('state_session_live');
  if ((expectedToken !== null) !== (cursor >= 2)) throw invalidInput('state_expected_token');
  return freeze({
    outcome, disposition: 'none' as const, code: null, ownershipUncertain: false,
    program, cursor, expectedToken, sessionLive,
  });
}

/** The canonical distillation of an executor's report: strict primitives only, no caller reference
 *  retained. `null` means the event is not a kernel event at all. A `null` identity token means the
 *  identity slot was unreadable or out of domain — a distinct, contract-bearing refusal. */
type CanonicalEvent =
  | { readonly type: 'reserved' | 'ok' | 'port_failed' | 'timeout' }
  | { readonly type: 'identity'; readonly token: string | null }
  | { readonly type: 'lock'; readonly acquired: boolean }
  | { readonly type: 'unlock'; readonly released: boolean };

function canonicalEvent(raw: unknown): CanonicalEvent | null {
  let d: Record<string, unknown>;
  try {
    d = captureOwnData(raw, 'execution_event');
    const type = d.type;
    if (typeof type !== 'string' || !hasOwn(EVENT_SHAPE, type)) return null;
    requireExactKeys(d, EVENT_SHAPE[type], 'execution_event');
    switch (type) {
      case 'identity': {
        let token: string | null;
        // A missing, non-string, empty, oversized, or unreadable token is not an identity.
        try { token = readBackendToken(d.identity as BackendIdentity); } catch { token = null; }
        return freeze({ type: 'identity' as const, token });
      }
      // STRICT literal-true: a truthy non-boolean (e.g. an accidental query-row object) is not an
      // acquired lock or a verified unlock, and an unreadable slot is not one either.
      case 'lock': return freeze({ type: 'lock' as const, acquired: d.acquired === true });
      case 'unlock': return freeze({ type: 'unlock' as const, released: d.released === true });
      default: return freeze({ type } as { readonly type: 'reserved' | 'ok' | 'port_failed' | 'timeout' });
    }
  } catch {
    return null;
  }
}

function codeFromError(e: unknown): EngineCode {
  let code: unknown;
  try { code = e == null ? undefined : (e as { code?: unknown }).code; } catch { code = undefined; }
  return isEngineCode(code) ? code : ENGINE_CODES.PORT_OPERATION_FAILED;
}

function terminalResult(
  outcome: 'complete' | 'refused' | 'failed',
  disposition: ExecutionDisposition,
  code: EngineCode | null,
  ownershipUncertain = false,
): KernelResult {
  // INVARIANT (S1.7C), enforced in BOTH directions so the two fields can never disagree:
  //     ownershipUncertain === true   <=>   disposition === 'cancel_and_dispose'
  // Enforced HERE rather than at each call site, so no future edit can reintroduce the "uncertain
  // but disposition: none" mismatch that read as "nothing to do" on exactly the path where an
  // acquisition attempt may still settle into a real backend — nor its mirror image, an explicit
  // cancel-and-dispose order that fails to declare the ownership uncertainty that justifies it.
  // FULL RECONSTRUCTION rather than call-site discipline (S1.7F item 10). Every field is DERIVED
  // here from (outcome, disposition, code) and BOTH cross-field invariants are enforced in both
  // directions, so no present or future call site can construct a verdict that canonical capture
  // would reject, or one that reports a contradiction:
  //   (1) ownershipUncertain === true  <=>  disposition === 'cancel_and_dispose'
  //   (2) outcome === 'complete'       <=>  code === null AND disposition === 'none'
  // A non-complete verdict therefore always carries a bounded code: a null one degrades to the
  // generic port failure rather than silently producing a verdict shaped exactly like success.
  const complete = outcome === 'complete';
  const uncertain = !complete && (ownershipUncertain || disposition === 'cancel_and_dispose');
  return freeze({
    state: freeze({
      outcome,
      disposition: complete ? 'none' : (uncertain ? 'cancel_and_dispose' : disposition),
      code: complete ? null : (code ?? ENGINE_CODES.PORT_OPERATION_FAILED),
      ownershipUncertain: uncertain,
      program: NO_EFFECTS, cursor: 0, expectedToken: null, sessionLive: false,
    }),
    effects: NO_EFFECTS,
  });
}

/**
 * Build the full ordered inert program from a validated plan. PURE: reads every caller-supplied
 * field ONCE under guards (a throwing getter becomes a bounded code, never a raw leak), canon-
 * icalizes each artifact (F2: re-hash bytes AND sql), and binds direction/version (F1). The
 * per-pair sub-program preserves the legacy choreography verbatim: dirty BEFORE any schema
 * effect; for 'required', finalize rides the same open_tx/commit_tx bracket as execute with an
 * in-tx identity re-verify; for 'forbidden', an identity re-verify sits BETWEEN the irreversible
 * execute and the finalize. Throws a bounded engine error on any invalid input.
 */
function buildProgram(plan: ApplyPlan, connectionMode: ConnectionMode, lockKey: number): ExecutionEffect[] {
  const program: ExecutionEffect[] = [];
  // Append through a local index, NEVER `Array.prototype.push`. This is the ORIGINATING array, so a
  // re-pointed `push` here would be strictly worse than at the rebuild site: instead of leaking a
  // reference it could APPEND a complete, grammar-valid attacker block (its own version, checksum
  // and SQL) into an engine-allocated program, which canonical capture would then certify.
  let emitted = 0;
  const emit = (effect: ExecutionEffect): void => { program[emitted] = effect; emitted += 1; };
  let programSqlLength = 0;
  emit(freeze({ kind: 'reserve', connectionMode }));
  emit(freeze({ kind: 'capture_identity' }));
  emit(freeze({ kind: 'acquire_lock', lockKey }));
  emit(freeze({ kind: 'verify_identity' }));

  // `plan.pending` is caller-controlled: its length is read ONCE as a safe integer and it is
  // walked by INDEX (a caller array's map/filter are overridable own properties).
  const pending = guardPortSync(() => (plan == null ? undefined : plan.pending)) as MigrationPair[] | undefined;
  const count = boundedLength(pending, 'pending_length');
  // Bound the plan BEFORE hashing anything. `boundedLength` only rejects a non-safe-integer length,
  // so without this a caller-supplied plan with 500,000 entries would run two SHA-256 passes per
  // entry and only then be refused by the program cap. The bound must precede the work.
  if (count > MAX_PENDING_PAIRS) throw engineError(ENGINE_CODES.INVALID_LEDGER_FIELD, 'pending_length');
  for (let i = 0; i < count; i += 1) {
    let up: MigrationDescriptor | undefined;
    let pairVersion: unknown;
    try {
      const pair = (pending as MigrationPair[])[i];
      up = pair == null ? undefined : pair.up;
      pairVersion = pair == null ? undefined : pair.version;
    } catch {
      throw engineError(ENGINE_CODES.PORT_OPERATION_FAILED);
    }
    // Snapshot the up-descriptor fields ONCE (the value validated is the value emitted).
    let artifact: MigrationArtifact | undefined;
    let checksum: unknown;
    let version: unknown;
    let direction: unknown;
    let transactionMode: unknown;
    try {
      artifact = up == null ? undefined : up.artifact;
      checksum = up == null ? undefined : up.checksum;
      version = up == null ? undefined : up.version;
      direction = up == null ? undefined : up.direction;
      transactionMode = up == null ? undefined : up.transactionMode;
    } catch {
      throw engineError(ENGINE_CODES.PORT_OPERATION_FAILED);
    }
    if (transactionMode !== 'required' && transactionMode !== 'forbidden') {
      throw engineError(ENGINE_CODES.INVALID_TRANSACTION_MODE, safeVersionSubject(version));
    }
    if (direction !== 'up' || typeof version !== 'string' || version !== pairVersion) {
      throw engineError(ENGINE_CODES.PAIR_MISMATCH, safeVersionSubject(version));
    }
    const canonical = canonicalizeArtifact(artifact, checksum as string, version);
    if (canonical.direction !== 'up' || canonical.version !== version) {
      throw engineError(ENGINE_CODES.PAIR_MISMATCH, safeVersionSubject(version));
    }
    // Only the canonical artifact's VERIFIED PRIMITIVES enter the inert effects. `version` is
    // copied VERBATIM into the ledger-bound effects (insert_dirty / execute / finalize) that an
    // S1b executor turns into DURABLE rows, so it must satisfy the SAME canonical filename
    // grammar every sibling ledger/status path enforces: `typeof === 'string'` alone would admit
    // unbounded, non-printable, SQL-shaped text into a recorded migration attempt via a
    // hand-built or Proxy-backed plan (F9/D4 — the version counterpart of assertLedgerTimestamp).
    const ver = assertVersionLabel(canonical.version, 'effect_version');
    const ck = canonical.checksum;
    const sql = canonical.sql;
    // Bound the SQL on the PRODUCING side, with the same limits canonical capture applies. Without
    // this a legitimately discovered migration larger than the capture ceiling would build here and
    // then be refused by the round-trip as `invalid_execution_event` — a false rejection reported
    // with a code that says the CALLER's event was malformed. Enforcing it here keeps the refusal
    // honest and keeps "capture never rejects an engine-built program" true.
    programSqlLength += sql.length;
    if (sql.length > MAX_SQL_LENGTH || programSqlLength > MAX_PROGRAM_SQL_LENGTH) {
      throw engineError(ENGINE_CODES.INVALID_LEDGER_FIELD, 'effect_sql');
    }
    emit(freeze({ kind: 'insert_dirty', version: ver, checksum: ck, txMode: transactionMode }));
    if (transactionMode === 'required') {
      emit(freeze({ kind: 'open_tx' }));
      emit(freeze({ kind: 'verify_identity' }));
      emit(freeze({ kind: 'execute', txScoped: true, version: ver, direction: 'up', checksum: ck, sql }));
      emit(freeze({ kind: 'finalize', txScoped: true, version: ver, checksum: ck }));
      emit(freeze({ kind: 'commit_tx' }));
      emit(freeze({ kind: 'verify_identity' }));
    } else {
      emit(freeze({ kind: 'verify_identity' }));
      emit(freeze({ kind: 'execute', txScoped: false, version: ver, direction: 'up', checksum: ck, sql }));
      emit(freeze({ kind: 'verify_identity' }));
      emit(freeze({ kind: 'finalize', txScoped: false, version: ver, checksum: ck }));
      emit(freeze({ kind: 'verify_identity' }));
    }
  }
  emit(freeze({ kind: 'verify_identity' }));
  emit(freeze({ kind: 'release_lock', lockKey }));
  emit(freeze({ kind: 'verify_identity' }));
  emit(freeze({ kind: 'close' }));
  return program;
}

/**
 * Begin an execution run. PURE and port-free. Validates the scalar deps (lock key, credential,
 * connection mode) and the whole plan (bounded pending count, transaction mode, F1 direction/
 * version, F2 canonical artifact) up front, then canonicalizes the result — which additionally
 * enforces the choreography grammar, the single lock key, and strictly ascending distinct versions
 * across the plan — and returns the FIRST inert effect (a `reserve`) plus an in-progress state.
 * NOTE: `plan` is a plain exported interface, so a caller need not have obtained it from
 * planApply(); the ordering and uniqueness guarantees above are the ones enforced HERE. Any validation failure returns a
 * terminal `refused` verdict with a bounded code and NO effects — nothing was reserved, so
 * there is nothing to dispose. This grants no authority: the returned effect is inert data.
 */
export function startMigrationExecution(plan: ApplyPlan, deps: ExecutionDeps): KernelResult {
  let connectionMode: ConnectionMode;
  let credential: CredentialClassification;
  let lockKey: number;
  try {
    connectionMode = guardPortSync(() => deps.connectionMode);
    lockKey = guardPortSync(() => deps.lockKey);
    credential = guardPortSync(() => deps.credential);
  } catch (e) {
    return terminalResult('refused', 'none', codeFromError(e));
  }
  if (!isSafeInteger(lockKey)) return terminalResult('refused', 'none', ENGINE_CODES.INVALID_LOCK_KEY);
  try {
    guardPortSync(() => assertMigratorCredential(credential));
    assertMigratorConnectionMode(connectionMode);
  } catch (e) {
    return terminalResult('refused', 'none', codeFromError(e));
  }
  let program: ExecutionEffect[];
  try {
    program = buildProgram(plan, connectionMode, lockKey);
  } catch (e) {
    return terminalResult('refused', 'none', codeFromError(e));
  }
  // The engine's OWN output passes through the very same canonical capture a caller-supplied state
  // must pass. That is not ceremony: it is what guarantees there is ONE canonical domain rather than
  // an engine dialect and a caller dialect, so an engine-built state and an equivalent caller-built
  // one are literally indistinguishable to every later transition.
  let state: ExecutionState;
  try {
    state = canonicalExecutionState({
      outcome: 'in_progress',
      disposition: 'none',
      code: null,
      ownershipUncertain: false,
      program: freeze(program),
      cursor: 0,
      expectedToken: null,
      sessionLive: false,
    });
  } catch (e) {
    return terminalResult('refused', 'none', codeFromError(e));
  }
  // The KernelResult WRAPPER is frozen too, not just its contents: the whole return value is inert
  // data, so a holder cannot swap `state` or `effects` on a result and hand it on as if the kernel
  // had produced the substitution.
  return freeze({ state, effects: freeze([state.program[0]]) });
}

/**
 * Advance the machine by consuming the executor's inert report of the last effect's result.
 * PURE and port-free. Returns the NEXT effect (in-progress) or a terminal verdict:
 *   - `complete` (disposition 'none') only after the FULLY verified success path (verified
 *     unlock, stable identity, clean close).
 *   - `failed` disposition 'terminate' — every uncertain outcome once a session is CONFIRMED
 *     live: identity drift, lock not literal-true, unlock not literal-true, a port failure, a
 *     step timeout, or an unknown/out-of-order/contradictory event.
 *   - `failed` disposition 'none' — a reservation that SETTLED as a failure before any handle
 *     existed: nothing outstanding, nothing held, nothing to clean up.
 *   - `failed` disposition 'cancel_and_dispose' with ownershipUncertain — a reservation TIMEOUT
 *     (settled nothing; a backend may still appear after this verdict) or any state the kernel
 *     did not build. The S1b executor MUST cancel the outstanding attempt and dispose of
 *     anything already held or settling late.
 * Terminal states ABSORB every further event (duplicate/late/out-of-order after completion),
 * returning the same verdict with no effects.
 *
 * CANONICAL CAPTURE (S1.7D): the state and the event are treated as UNKNOWN and rebuilt as bounded
 * canonical snapshots BEFORE any transition logic runs. A malformed, contradictory, unbounded,
 * exhausted, invalidly ordered, mutated, or trap-throwing input yields ZERO effects and a stable
 * bounded verdict — never a caller-owned object returned by identity, never a value echoed out of a
 * forged input, and never a raw exception from a getter or Proxy trap. A STRUCTURALLY VALID input
 * is simulated, whoever built it, and receives newly allocated frozen effects that share no
 * reference with it. What NO caller can do is manufacture authority: the kernel holds no port,
 * mints no capability, and stamps no trust marker. Capture certifies STRUCTURE, not AUTHORIZATION —
 * effects necessarily carry the plan's own SQL and checksum — so an S1b executor MUST derive its
 * own program from a plan IT validated and must never treat a caller-supplied state, event, or
 * KernelResult as evidence that anything was authorized.
 *
 * LINEAGE DISCIPLINE (an S1b obligation the kernel cannot discharge). States are VALUES the caller
 * retains, so a caller holding an EARLIER in-progress state can step it again after a terminal
 * verdict and drive that lineage to `complete`. The kernel keeps no run registry — by design, since
 * that is exactly the hidden state S1.7D removes — and therefore cannot poison a lineage: "no clean
 * close after an uncertain outcome" is guaranteed WITHIN a lineage only. An S1b executor MUST
 * discard the state after ANY terminal verdict, exactly as it must derive its own program.
 */
export function stepMigrationExecution(state: ExecutionState, event: ExecutionEvent): KernelResult {
  // CANONICAL CAPTURE — the FIRST act. Nothing below ever touches the caller's objects again.
  let snapshot: ExecutionState;
  try {
    snapshot = canonicalExecutionState(state);
  } catch {
    // The input is not a canonical kernel state, so NOTHING about it is known — including whether
    // the caller holds a physical session. Zero effects, a stable bounded verdict, and the explicit
    // cancel-and-dispose obligation that unknown ownership demands. No shape detail, trap output,
    // exception text, or caller-authored value is reported back.
    return terminalResult('failed', 'cancel_and_dispose', ENGINE_CODES.INVALID_EXECUTION_EVENT, true);
  }
  if (snapshot.outcome !== 'in_progress') {
    // A TERMINAL verdict ABSORBS every further event (duplicate, late, or out-of-order after a
    // verdict), returning the canonical verdict unchanged and no effects. The state handed back is
    // the ENGINE-ALLOCATED snapshot, never the caller's own object.
    return freeze({ state: snapshot, effects: NO_EFFECTS });
  }
  const program = snapshot.program;
  const cursor = snapshot.cursor;
  const live = snapshot.sessionLive;
  const expectedToken = snapshot.expectedToken;
  const current = program[cursor];
  // An event that is not a kernel event at all canonicalizes to null; no case below matches
  // `undefined`, so it fails closed exactly as any other unexpected event does.
  const ev = canonicalEvent(event);
  const evType = ev === null ? undefined : ev.type;

  // A thrown or non-settling port operation. A CONFIRMED live session is DESTROYED. Before a handle
  // exists the two pre-reservation paths are NOT the same and must not collapse into one verdict.
  if (evType === 'port_failed' || evType === 'timeout') {
    const code = evType === 'timeout' ? ENGINE_CODES.EXECUTION_STEP_TIMEOUT : ENGINE_CODES.PORT_OPERATION_FAILED;
    if (current.kind === 'reserve') {
      // BOTH pre-reservation failures leave ownership UNCERTAIN, and for the SAME reason: the
      // adapter contract is `reserve(mode): Promise<ReservedSession>` and nothing more. It does
      // not state — and the kernel cannot enforce — that a reserve which rejects, throws, or never
      // settles allocated NOTHING. A driver that opens a socket, starts a backend, and only then
      // fails its handshake satisfies that signature exactly.
      //   timeout     — the attempt never settled; a backend may still appear AFTER this verdict.
      //   port_failed — the attempt settled as a failure, but a physical backend may already have
      //                 been created before the rejection. 'none' would read as "nothing to do" on
      //                 precisely the path where a resource may exist and be unreachable — a leaked
      //                 backend still holding the run's advisory lock. Only an ENFORCED atomic
      //                 no-allocation-on-failure contract could justify 'none' here; there is none.
      // 'terminate' is equally wrong for both: it would claim the kernel can destroy a handle it
      // never received. The verdict therefore prescribes DISPOSITION only — cancel the outstanding
      // attempt and dispose of anything held or settling late — and never claims the cancellation
      // or disposal physically occurred. Both are S1b obligations.
      return terminalResult('failed', 'cancel_and_dispose', code, true);
    }
    return terminalResult('failed', 'terminate', code);
  }

  const advance = (patch: { expectedToken?: string; sessionLive?: boolean } = {}): KernelResult => {
    const next = cursor + 1;
    // `program` is the ENGINE-ALLOCATED canonical array built during capture, and the choreography
    // grammar guarantees that `close` — the one effect that ends the run rather than advancing — is
    // its last element. Every other effect therefore has a successor, and every index below is in
    // range by construction rather than by a guard that no input could reach.
    const nextEffect = program[next];
    const nextState: ExecutionState = freeze({
      outcome: 'in_progress' as const,
      disposition: 'none' as const,
      code: null,
      ownershipUncertain: false,
      program,
      cursor: next,
      expectedToken: patch.expectedToken !== undefined ? patch.expectedToken : expectedToken,
      sessionLive: patch.sessionLive !== undefined ? patch.sessionLive : live,
    });
    return freeze({ state: nextState, effects: freeze([nextEffect]) });
  };
  // An uninterpretable event BEFORE a session is confirmed live can only occur at the `reserve` step,
  // where the kernel has emitted the reservation and knows NOTHING about what the executor holds.
  // Reporting 'none' there claimed "nothing outstanding and nothing held" on exactly the path where a
  // live reserved backend may already exist and merely have been reported in a non-canonical shape.
  // Ownership is therefore UNCERTAIN: cancel the outstanding attempt and dispose of anything held or
  // settling late. A reservation that SETTLED as a failure (`port_failed`) is handled earlier and
  // correctly keeps 'none' — that attempt is genuinely over.
  const fail = (code: EngineCode): KernelResult =>
    live
      ? terminalResult('failed', 'terminate', code)
      : terminalResult('failed', 'cancel_and_dispose', code, true);

  switch (current.kind) {
    case 'reserve':
      if (evType !== 'reserved') return fail(ENGINE_CODES.INVALID_EXECUTION_EVENT);
      return advance({ sessionLive: true });
    case 'capture_identity': {
      if (ev === null || ev.type !== 'identity') return fail(ENGINE_CODES.INVALID_EXECUTION_EVENT);
      // A missing, non-string, empty, oversized, or unreadable token is not an identity.
      if (ev.token === null) return fail(ENGINE_CODES.INVALID_BACKEND_IDENTITY);
      return advance({ expectedToken: ev.token });
    }
    case 'verify_identity': {
      if (ev === null || ev.type !== 'identity') return fail(ENGINE_CODES.INVALID_EXECUTION_EVENT);
      if (ev.token === null) return fail(ENGINE_CODES.INVALID_BACKEND_IDENTITY);
      // Tokens are compared as captured PRIMITIVES, so an adapter that reuses and mutates one
      // identity object across a real backend switch cannot keep the captured value equal.
      if (ev.token !== expectedToken) return fail(ENGINE_CODES.BACKEND_IDENTITY_CHANGED);
      return advance();
    }
    case 'acquire_lock': {
      if (ev === null || ev.type !== 'lock') return fail(ENGINE_CODES.INVALID_EXECUTION_EVENT);
      // STRICT literal-true (normalized during capture): a truthy non-boolean — e.g. an accidental
      // query-row object — is not an acquired lock, and neither is an unreadable slot.
      if (!ev.acquired) return fail(ENGINE_CODES.RUN_LOCK_UNAVAILABLE);
      return advance();
    }
    case 'release_lock': {
      if (ev === null || ev.type !== 'unlock') return fail(ENGINE_CODES.INVALID_EXECUTION_EVENT);
      if (!ev.released) return fail(ENGINE_CODES.RUN_UNLOCK_FAILED);
      return advance();
    }
    case 'insert_dirty':
    case 'open_tx':
    case 'execute':
    case 'finalize':
    case 'commit_tx':
      if (evType !== 'ok') return fail(ENGINE_CODES.INVALID_EXECUTION_EVENT);
      return advance();
    case 'close':
      if (evType !== 'ok') return fail(ENGINE_CODES.INVALID_EXECUTION_EVENT);
      // The ONLY path to a pool-eligible clean completion.
      return terminalResult('complete', 'none', null);
    default:
      return fail(ENGINE_CODES.INVALID_EXECUTION_EVENT);
  }
}

/**
 * PUBLIC ledger-timestamp validator (pure; reaches no port). A timestamp copied into a durable
 * ledger row must be a bounded, canonical time literal — printable-ASCII alone would admit
 * SQL-like text into a recorded migration attempt. The kernel never stamps (it holds no clock);
 * the S1b executor MUST validate its own now() through this before writing a ledger row (D4/R5).
 */
export function assertLedgerTimestamp(value: unknown, subject = 'ledger_timestamp'): string {
  return assertTimestampLabel(value, subject);
}

// ---------------------------------------------------------------------------
// Node filesystem adapter (thin; used by the CLI + the migration-files contract test).
// Imports only node:fs — never a database. Enforces canonical containment and
// no-follow regular-file reads on every access.
// ---------------------------------------------------------------------------

/** True only when an ABSOLUTE `candidate` resolves INSIDE `canonicalRoot`
 *  (separator-boundary safe: a sibling like `<root>-evil` shares the text prefix but is
 *  NOT contained). Fail-closed: a relative candidate is never judged against the CWD —
 *  it is simply not contained. */
export function isContained(canonicalRoot: string, candidate: string): boolean {
  if (!isAbsolute(candidate)) return false;
  const rel = relative(canonicalRoot, resolve(candidate));
  // Bounded character comparison rather than `String.prototype.startsWith`: this is the escape check
  // itself, and `startsWith` is a patchable prototype method.
  const prefix = `..${sep}`;
  let escapes = rel.length >= prefix.length;
  for (let i = 0; escapes && i < prefix.length; i += 1) if (charAt(rel, i) !== charAt(prefix, i)) escapes = false;
  return rel !== '' && rel !== '..' && !escapes && !isAbsolute(rel);
}

/**
 * Build a MigrationFsPort over a real directory. `relDir` is the repository-relative
 * label used for safe identifiers. Uses node:fs only (never a database); callers that
 * inject their own port never touch the filesystem at all.
 *
 * Integrity: the root is canonicalized ONCE (realpath); every basename is grammar-checked
 * and containment-checked against that root with a separator boundary; `entryType` uses
 * lstat (never follows a symlink); `readBytes` opens with O_NOFOLLOW (+O_NONBLOCK so a
 * FIFO cannot block; POSIX-only flags — Linux is the deployment target) and verifies via
 * fstat that the OPENED descriptor is a regular file before reading. Raw fs errors are
 * converted to bounded engine codes carrying only the basename — never an absolute path
 * or file contents.
 *
 * TRUST BOUNDARY: a post-construction swap of an ANCESTOR directory into a symlink is
 * out of scope — that requires the same local write access as editing the migration SQL
 * itself, and is defended by the pinned byte-fingerprints plus the checksum ledger (the
 * bytes actually read are the bytes hashed and recorded, wherever the open landed).
 */
export function createNodeFsPort(absDir: string, relDir: string): MigrationFsPort {
  let root: string;
  try {
    root = realpathSync(absDir);
  } catch {
    throw engineError(ENGINE_CODES.PORT_OPERATION_FAILED, relDir);
  }

  const entryPath = (basename: string): string => {
    assertSafeBasename(basename);
    const p = `${root}${sep}${basename}`;
    if (!isContained(root, p)) throw engineError(ENGINE_CODES.CONTAINMENT_VIOLATION, basename);
    return p;
  };

  return {
    relDir,
    list: () => {
      try {
        return readdirSync(root);
      } catch {
        throw engineError(ENGINE_CODES.PORT_OPERATION_FAILED, relDir);
      }
    },
    entryType: (basename: string): FsEntryType => {
      const p = entryPath(basename);
      try {
        const st = lstatSync(p); // lstat: classifies the entry itself, never the target
        if (statIsSymbolicLink(st)) return 'symlink';
        if (statIsDirectory(st)) return 'directory';
        return statIsFile(st) ? 'file' : 'other'; // FIFO / socket / device → 'other'
      } catch {
        throw engineError(ENGINE_CODES.PORT_OPERATION_FAILED, basename);
      }
    },
    readBytes: (basename: string): Uint8Array => {
      const p = entryPath(basename);
      let fd: number;
      try {
        // O_NOFOLLOW: the open itself fails (ELOOP) if the final component is a symlink.
        // O_NONBLOCK: an unexpected FIFO cannot block the open; fstat rejects it below.
        fd = openSync(p, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
      } catch (e) {
        // ELOOP = symlink under O_NOFOLLOW; ENXIO = socket (or FIFO edge) — both are
        // nonregular entries; anything else is a bounded generic port failure.
        const code = (e as NodeJS.ErrnoException).code;
        throw engineError(
          code === 'ELOOP' || code === 'ENXIO' ? ENGINE_CODES.NONREGULAR_MIGRATION_ENTRY : ENGINE_CODES.PORT_OPERATION_FAILED,
          basename,
        );
      }
      try {
        // Each fallible syscall carries its OWN bounded catch, so the engine's own refusal is never
        // routed through a test of where an exception came from. It previously was — a single
        // catch used `e instanceof MigrationEngineError` to re-throw its own error — and
        // `instanceof` consults `MigrationEngineError[Symbol.hasInstance]`, an own property any
        // caller may install because the class is EXPORTED. One that answers `false` downgraded a
        // precise `nonregular_migration_entry` verdict to a generic `port_operation_failed`.
        // Structuring the control flow so no provenance question is ever asked removes the surface
        // outright, rather than replacing it with a different brand check.
        let st: ReturnType<typeof fstatSync>;
        try {
          st = fstatSync(fd);
        } catch {
          throw engineError(ENGINE_CODES.PORT_OPERATION_FAILED, basename);
        }
        // The check is on the OPENED descriptor, so it cannot be raced by a path swap.
        if (!statIsFile(st)) {
          throw engineError(ENGINE_CODES.NONREGULAR_MIGRATION_ENTRY, basename);
        }
        try {
          return readFileSync(fd);
        } catch {
          throw engineError(ENGINE_CODES.PORT_OPERATION_FAILED, basename);
        }
      } finally {
        // A close failure must never replace the bounded result/error with a raw errno.
        try {
          closeSync(fd);
        } catch {
          /* swallowed: the descriptor is spent; the primary outcome stands */
        }
      }
    },
  };
}

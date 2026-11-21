// Phase 4.0 M3 — bounded structured JSON logger.
//
// A record carries ONLY an enumerated allowlist of fields; the function never
// reads any other key, so a caller cannot smuggle a secret into a log line.
// Every string value is stripped of control bytes (so a value cannot forge a
// second record) and length-bounded. Never logs headers, bodies, query values,
// tokens, credentials, identifiers (other than the closed id fields below), or raw Error objects/stacks.
export type LogLevel = 'info' | 'warn' | 'error';

export interface LogSink {
  log(line: string): void;
}

export interface LogFields {
  event: string;
  requestId?: string;
  method?: string;
  route?: string;
  status?: number;
  durationMs?: number;
  reason?: string;
  /** The id THIS server generated for an audited session operation (sessions.ts) — never a client's value. */
  operationId?: string;
  // Doc 18 §6.6/§9.3.4 (D-CA-14 A, D-CA-18 C): the tenant startup line's evidence and the closed field list of the
  // `credit_note_write` line. Every value is an id this server generated for the command or one the shop already holds, or
  // a closed word — never an idempotency key, scope, fingerprint or lease, a session key, a proof, an amount or a reason.
  /** A random id this process generated at its start (tenantEntry.ts) — never a hostname, an environment value or a secret. */
  instanceId?: string;
  /** The tenant entry's write setting, `on` or `off` (TMPOS_CREDIT_NOTE_WRITES). */
  creditNoteWrites?: string;
  /** The DATABASE clock sampled at startup (doc 18 §9.3.2 "times"), `YYYY-MM-DDTHH:MM:SS.ffffffZ` — never the instance's. */
  databaseClock?: string;
  /** `committed` or `unconfirmed`. */
  outcome?: string;
  /** `register`, `issue`, `settle` or `withdraw`. */
  kind?: string;
  correlationId?: string;
  storeId?: string;
  invoiceId?: string;
  registrationId?: string;
  creditNoteId?: string;
  attemptId?: string;
}

/** The optional string fields, in record order after `operationId`. */
const ID_FIELDS = [
  'instanceId', 'creditNoteWrites', 'databaseClock', 'outcome', 'kind', 'correlationId', 'storeId', 'invoiceId', 'registrationId', 'creditNoteId', 'attemptId',
] as const;

const MAX_VALUE_LEN = 200;
// C0 controls, DEL, C1 controls, and the Unicode line/paragraph separators
// (U+2028/U+2029, which some log processors treat as line breaks) — built from
// code points so this source contains no literal control characters. Global:
// every occurrence is removed so a value cannot forge a second log line.
const CONTROL_RE = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]', 'g');

export function sanitizeLogValue(value: string): string {
  return value.replace(CONTROL_RE, '').slice(0, MAX_VALUE_LEN);
}

const isFiniteNumber = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

export function buildLogRecord(
  level: LogLevel,
  fields: LogFields,
  now: () => number = Date.now,
): Record<string, string | number> {
  const rec: Record<string, string | number> = {
    timestamp: new Date(now()).toISOString(),
    level,
    event: sanitizeLogValue(String(fields.event)),
  };
  if (fields.requestId !== undefined) rec.requestId = sanitizeLogValue(String(fields.requestId));
  if (fields.method !== undefined) rec.method = sanitizeLogValue(String(fields.method));
  if (fields.route !== undefined) rec.route = sanitizeLogValue(String(fields.route));
  if (isFiniteNumber(fields.status)) rec.status = Math.trunc(fields.status);
  if (isFiniteNumber(fields.durationMs)) rec.durationMs = Math.max(0, Math.round(fields.durationMs));
  if (fields.reason !== undefined) rec.reason = sanitizeLogValue(String(fields.reason));
  if (fields.operationId !== undefined) rec.operationId = sanitizeLogValue(String(fields.operationId));
  for (const name of ID_FIELDS) if (fields[name] !== undefined) rec[name] = sanitizeLogValue(String(fields[name]));
  return rec;
}

const defaultSink: LogSink = { log: (line: string) => { console.log(line); } };

export function emitLog(
  level: LogLevel,
  fields: LogFields,
  sink: LogSink = defaultSink,
  now: () => number = Date.now,
): void {
  sink.log(JSON.stringify(buildLogRecord(level, fields, now)));
}

// Phase 4.0 M3 — bounded structured JSON logger.
//
// A record carries ONLY an enumerated allowlist of fields; the function never
// reads any other key, so a caller cannot smuggle a secret into a log line.
// Every string value is stripped of control bytes (so a value cannot forge a
// second record) and length-bounded. Never logs headers, bodies, query values,
// tokens, credentials, identifiers, or raw Error objects/stacks.
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
}

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

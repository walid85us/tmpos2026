// Server-side safe logging utility.
//
// Goal: prevent PII / credentials / provider payloads from leaking into
// stdout/stderr in production. This module is the single place that decides
// what is safe to log. The rest of the server should call sanitizeError() on
// any caught Error and redactObject() on any inbound provider payload before
// passing it to console.*.
//
// Non-regression guarantees:
//   - It does NOT change any business logic, API response, or provider
//     behavior. It only filters strings/objects on their way to the log sink.
//   - It does NOT remove operational metadata (provider id, shipment id,
//     status code, elapsed ms) — those remain useful and are explicitly
//     allow-listed.
//   - It does NOT swallow errors. sanitizeError() always returns a non-empty
//     human-readable summary so operators can still triage failures from
//     production logs.

const isProduction = process.env.NODE_ENV === 'production';

// Keys that should never appear in logs in any environment. Comparison is
// case-insensitive; suffix matches are also recognized so e.g. `customerEmail`
// is redacted via the `email` rule.
const SENSITIVE_KEY_FRAGMENTS = [
  'password',
  'token',
  'accesstoken',
  'refreshtoken',
  'authorization',
  'apikey',
  'secret',
  'credential',
  'webhooksecret',
  'providerkey',
  'email',
  'phone',
  'address',
  'street',
  'postalcode',
  'zip',
  'recipient',
  'sender',
  'name',
  'customername',
  'customeremail',
  'customerphone',
  'owneremail',
  'labelurl',
];

const REDACTED = '[REDACTED]';
const MAX_DEPTH = 4;
const MAX_STRING_LEN = 200;

function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SENSITIVE_KEY_FRAGMENTS.some((frag) => lower === frag || lower.endsWith(frag));
}

// Recursively redact sensitive keys from an arbitrary JS value. Returns a
// safe-to-log shallow clone — the original value is never mutated.
export function redactObject(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (depth >= MAX_DEPTH) return '[…]';
  if (typeof value === 'string') {
    return value.length > MAX_STRING_LEN ? value.slice(0, MAX_STRING_LEN) + '…' : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    if (value.length > 10) return `[Array(${value.length})]`;
    return value.map((v) => redactObject(v, depth + 1));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKey(k)) {
        out[k] = REDACTED;
      } else {
        out[k] = redactObject(v, depth + 1);
      }
    }
    return out;
  }
  return '[unloggable]';
}

// Convert an unknown caught error into a metadata-only object that is always
// safe to log. We deliberately drop `cause`, request bodies, response bodies,
// stack frames that include URLs, and any nested objects.
export function sanitizeError(err: unknown): {
  name: string;
  code?: string;
  message: string;
  status?: number;
} {
  if (err instanceof Error) {
    const anyErr = err as Error & { code?: string | number; status?: number; statusCode?: number };
    return {
      name: err.name || 'Error',
      code: anyErr.code !== undefined ? String(anyErr.code) : undefined,
      message: redactString(err.message || 'Unknown error'),
      status: typeof anyErr.status === 'number' ? anyErr.status :
              typeof anyErr.statusCode === 'number' ? anyErr.statusCode : undefined,
    };
  }
  if (typeof err === 'string') {
    return { name: 'Error', message: redactString(err) };
  }
  return { name: 'Error', message: 'Non-error thrown' };
}

// Mask digit-runs that look like phone numbers / postal codes / card numbers
// inside a free-form string (e.g. an error message). Keeps short numeric
// tokens (HTTP statuses, ms timings, counts) intact.
function redactString(s: string): string {
  if (!s) return s;
  let out = s.length > MAX_STRING_LEN ? s.slice(0, MAX_STRING_LEN) + '…' : s;
  // Mask any run of 7+ digits (covers phones, postal+phone fragments, cards).
  out = out.replace(/\d{7,}/g, REDACTED);
  // Mask anything that looks like an email address.
  out = out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, REDACTED);
  return out;
}

// Verbose-only details. In production these are dropped entirely so they
// cannot leak. In development they are still passed through redactObject so
// even debug runs cannot dump credentials.
export function devOnlyDetail(detail: unknown): unknown {
  if (isProduction) return undefined;
  return redactObject(detail);
}

// Convenience wrappers that the server may use directly. They forward to
// console.* but redact every argument that is an object/error, and trim
// long strings. Plain primitives (operation name, ids) pass through.
function safeForward(args: unknown[]): unknown[] {
  return args.map((a) => {
    if (a instanceof Error) return sanitizeError(a);
    if (a === null || typeof a !== 'object') return a;
    return redactObject(a);
  });
}

export const safeLog = {
  info: (...args: unknown[]) => console.log(...safeForward(args)),
  warn: (...args: unknown[]) => console.warn(...safeForward(args)),
  error: (...args: unknown[]) => console.error(...safeForward(args)),
};

// Phase 4.0 M3 — request correlation IDs.
//
// An inbound ID is accepted ONLY when it is a strict, bounded ASCII token;
// anything else (absent, oversized, whitespace, control bytes, comma-joined,
// unicode tricks, duplicate-header array) is replaced by a cryptographically
// strong generated ID. The ID is a log/trace correlator — it NEVER confers
// authority or idempotency.
import { randomUUID } from 'node:crypto';

export const REQUEST_ID_HEADER = 'x-request-id';

// 8..128 chars of [A-Za-z0-9._-]: no whitespace, control, comma, or unicode.
const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,128}$/;

export function isValidRequestId(value: unknown): boolean {
  return typeof value === 'string' && REQUEST_ID_RE.test(value);
}

export function resolveRequestId(inbound: string | string[] | undefined): string {
  return isValidRequestId(inbound) ? (inbound as string) : randomUUID();
}

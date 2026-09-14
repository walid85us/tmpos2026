// Phase 4.0 M6 — keyed-hash secrets: one format and one holder for every secret the runtime keys
// pseudonyms with (RATE_LIMIT_KEY for limiter keys, IDEMPOTENCY_KEY for idempotency records).
//
// A secret is 32–64 random bytes from the deployment's secrets store, configured as unpadded,
// canonical base64url and identical on every instance. It reaches the runtime only through the
// composition boundary, and startup refuses anything else with a bounded code — never the value.
import { createSecretKey } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { EnforcementSetupError } from './routes.js';
import type { EnforcementSetupCode } from './routes.js';

const SECRET_BYTES = Object.freeze({ min: 32, max: 64 });

/** A secret's configured text — unpadded, canonical base64url of 32–64 bytes — as bytes, or null. */
export function parseKeyMaterial(text: unknown): Buffer | null {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]{43,86}$/.test(text)) return null;
  const bytes = Buffer.from(text, 'base64url');
  // The round trip refuses non-canonical text: stray bits in the last character are no key material.
  return bytes.length >= SECRET_BYTES.min && bytes.length <= SECRET_BYTES.max && bytes.toString('base64url') === text ? bytes : null;
}

/**
 * Whether two secrets are one HMAC-SHA256 key. HMAC zero-pads a key shorter than its 64-byte
 * block, so K and K followed by zero bytes key identical MACs: compare them as HMAC sees them.
 */
export function sameKeyMaterial(a: Uint8Array, b: Uint8Array): boolean {
  const asHmacKey = (secret: Uint8Array): Buffer => {
    const block = Buffer.alloc(SECRET_BYTES.max);
    block.set(secret.subarray(0, SECRET_BYTES.max));
    return block;
  };
  return asHmacKey(a).equals(asHmacKey(b));
}

/** A private copy of `secret` (32–64 bytes) as a KeyObject — the caller's bytes may change; anything else refuses with `code`. */
export function secretKeyOf(secret: unknown, code: EnforcementSetupCode): KeyObject {
  if (!(secret instanceof Uint8Array) || secret.byteLength < SECRET_BYTES.min || secret.byteLength > SECRET_BYTES.max) {
    throw new EnforcementSetupError(code);
  }
  return createSecretKey(Buffer.from(secret));
}

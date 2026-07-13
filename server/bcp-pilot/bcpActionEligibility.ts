// Phase 3.0 M3 — DEV-only, READ-ONLY controlled-action ELIGIBILITY probe (pure parts).
//
// PURPOSE: answer the single question "would the controlled action's authorization guard ALLOW this
// server-derived principal right now?" — WITHOUT executing the action. It reuses the EXACT server-authoritative
// chain (Firebase verify → identity lookup → canonical authorization → BCP principal translation → BCP action
// guard) via the express adapter, and returns a BOUNDED { eligible, status } body that leaks NOTHING about role,
// permission level, parity reason, cap state, identity, membership, claims, token, or the denial stage.
//
// This module holds the PURE parts: a same-origin/CSRF security evaluation for a bodyless authenticated POST probe
// (POST solely so the browser attaches its protected `Origin` header — same-origin GETs omit it) with a DEDICATED
// eligibility intent header value (distinct from the action's), and the bounded decision mapping. It performs NO
// network, auth, DB, or side effect. It NEVER imports the action handler, the advisory audit sink, or the
// idempotency store — the read probe cannot execute the action, emit a marker, or consume idempotency state.
//
// Server-side only. Never imported by the client bundle.

import type { TrustedOriginResolution } from './bcpActionRequestSecurityGuard';
import type { LivePrincipalResolution } from './bcpActionLivePrincipalResolver';

/** Shared lowercase intent header name; DEDICATED value that is DISTINCT from the action's intent value. */
export const BCP_ELIGIBILITY_INTENT_HEADER = 'x-bcp-action-intent';
export const BCP_ELIGIBILITY_INTENT_VALUE = 'acknowledge-readiness-review-eligibility';

/** The DEV-only, READ-ONLY eligibility route (a bodyless-POST sub-path of the action route). NOT an execution route. */
export const BCP_ELIGIBILITY_ROUTE_PATH = '/dev/bcp/actions/acknowledge-readiness-review/eligibility';
/** Same-origin frontend proxy path used by the browser client (covered by the existing `/__identity` proxy). */
export const BCP_ELIGIBILITY_PROXY_PATH = `/__identity${BCP_ELIGIBILITY_ROUTE_PATH}`;

export type EligibilityDenyCode =
  | 'method_not_allowed'
  | 'cross_site'
  | 'origin_missing'
  | 'malformed_origin'
  | 'origin_mismatch'
  | 'trusted_origin_unavailable'
  | 'missing_action_intent'
  | 'invalid_action_intent';

/** Authority-neutral, single-string view of the security-relevant request headers (no body — GET). */
export interface EligibilitySecurityInput {
  method: string;
  origin: string | undefined;
  secFetchSite: string | undefined;
  actionIntent: string | undefined;
}

/** Single-interface (optional `code`) form — non-strict TS boolean-discriminant narrowing is lossy. */
export type EligibilitySecurityResult = { ok: boolean; code?: EligibilityDenyCode };

/**
 * Strict request-Origin normalization: returns the canonical origin ONLY when the raw Origin header IS its own
 * exact canonical origin (round-trip). Mirrors the frozen request-security guard's private normalizer (duplicated
 * here — an ~8-line pure function — to avoid modifying the frozen guard for a different intent value + GET method).
 */
function normalizeRequestOrigin(origin: string): string | null {
  let u: URL;
  try { u = new URL(origin); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username !== '' || u.password !== '') return null;
  if (u.pathname !== '/' && u.pathname !== '') return null;
  if (u.search !== '' || u.hash !== '') return null;
  return u.origin === origin ? u.origin : null;
}

/**
 * Fail-closed request-security evaluation for the READ probe, with EXACT trusted-origin enforcement. POST-only:
 * a bodyless authenticated RPC-style probe (still strictly read-only) — POST is used SOLELY so the browser reliably
 * attaches its protected `Origin` header, which same-origin GETs omit. No body ⇒ no content-type check. Requires the
 * browser Origin to EXACTLY equal the one trusted origin, rejects `Sec-Fetch-Site: cross-site`, and requires the
 * DEDICATED eligibility intent header. `trusted` is injected (resolved by the caller from REPLIT_DEV_DOMAIN). No leak.
 */
export function evaluateEligibilitySecurity(input: EligibilitySecurityInput, trusted: TrustedOriginResolution): EligibilitySecurityResult {
  if (input.method !== 'POST') return { ok: false, code: 'method_not_allowed' };

  // Fetch Metadata: reject the definitively-cross-origin case (browser-set; JS cannot forge).
  if (input.secFetchSite === 'cross-site') return { ok: false, code: 'cross_site' };

  // Trusted origin must be resolvable — else fail closed BEFORE any origin comparison (server misconfig).
  if (!trusted.ok) return { ok: false, code: 'trusted_origin_unavailable' };

  // The request Origin header is REQUIRED, must be a clean absolute origin, and must EXACTLY equal the trusted
  // origin. No suffix/substring/prefix/endsWith; never reflected; never wildcard.
  if (input.origin === undefined) return { ok: false, code: 'origin_missing' };
  const requestOrigin = normalizeRequestOrigin(input.origin);
  if (requestOrigin === null) return { ok: false, code: 'malformed_origin' };
  if (requestOrigin !== trusted.origin) return { ok: false, code: 'origin_mismatch' };

  // The DEDICATED eligibility intent header — the CSRF linchpin. Exact match; no trimming.
  if (input.actionIntent === undefined) return { ok: false, code: 'missing_action_intent' };
  if (input.actionIntent !== BCP_ELIGIBILITY_INTENT_VALUE) return { ok: false, code: 'invalid_action_intent' };

  return { ok: true };
}

/** Only a single string header value is trusted; arrays/duplicates normalize to undefined (fail closed). */
function single(v: string | string[] | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** Extract the normalized security view from an Express-style (lowercased) headers object. */
export function readEligibilitySecurityInput(
  headers: Record<string, string | string[] | undefined>,
  method: string,
): EligibilitySecurityInput {
  return {
    method,
    origin: single(headers['origin']),
    secFetchSite: single(headers['sec-fetch-site']),
    actionIntent: single(headers[BCP_ELIGIBILITY_INTENT_HEADER]),
  };
}

/** The ONLY body shape ever returned — a bounded, sanitized eligibility answer. */
export type EligibilityStatus =
  | 'eligible'
  | 'not_authorized'
  | 'authentication_required'
  | 'authentication_invalid'
  | 'unavailable'
  | 'request_denied' // adapter-level: security/body rejection (bounded; not produced by eligibilityDecision)
  | 'rate_limited';  // adapter-level: separate bounded read limiter
export interface EligibilityResponse { httpStatus: number; body: { eligible: boolean; status: EligibilityStatus }; }

const RESP = (httpStatus: number, status: EligibilityStatus, eligible: boolean): EligibilityResponse =>
  ({ httpStatus, body: { eligible, status } });

/**
 * Map the (already-run) live-principal resolution + the pure guard decision to the BOUNDED eligibility response.
 * `guardAllow` is the result of the EXISTING BCP action guard on the resolved principal (only meaningful when the
 * outcome is 'authenticated'). Every branch fails closed and reveals nothing beyond { eligible, status }.
 *
 * NOTE: the "missing Bearer ⇒ 401 authentication_required" case is decided by the adapter BEFORE resolution (a
 * present-but-invalid credential reaches here as 'auth_failed' ⇒ authentication_invalid).
 */
export function eligibilityDecision(resolution: LivePrincipalResolution, guardAllow: boolean | null): EligibilityResponse {
  switch (resolution.outcome) {
    case 'authenticated':
      return guardAllow ? RESP(200, 'eligible', true) : RESP(200, 'not_authorized', false);
    case 'unmapped': // token verified, but no durable/authorized identity ⇒ insufficient
      return RESP(200, 'not_authorized', false);
    case 'auth_failed':
      // A missing credential is handled earlier as authentication_required; here the credential was present.
      return resolution.authCode === 'authentication_unavailable'
        ? RESP(503, 'unavailable', false)         // provider/service failure ⇒ sanitized fail closed
        : RESP(401, 'authentication_invalid', false);
    case 'resolver_error':
    default:
      return RESP(503, 'unavailable', false);      // sanitized fail closed; no authorization details
  }
}

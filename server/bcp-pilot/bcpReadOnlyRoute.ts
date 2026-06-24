// Phase 2.0 M7E — BCP DEV-only read-only pilot: INERT route boundary handler.
//
// WHAT THIS IS: a PURE, transport-agnostic, NO-THROW route-boundary handler that wires the M7C
// pure modules (flag → guard → synthetic mapper) into a single request→response shape. It is the
// thin HTTP boundary layer ONLY: it adds NO business or redaction logic of its own.
//
// INERT (binding): this handler is NOT registered with any live express app or server startup in
// M7E. It is imported only by its test. A later, separately-approved milestone may adapt it to the
// isolated DEV API; full express registration is DEFERRED here to avoid any runtime/route exposure.
//
// SAFETY (binding):
//   - DEV-only + default-off run FIRST, for EVERY method: production or flag-off ⇒ a uniform
//     'unavailable' response (no data, no method/existence disclosure) regardless of HTTP method.
//   - The contract is PINNED to 'C-01' server-side; it is NEVER taken from the request, so no
//     request field can influence the authorization decision.
//   - Authorization is decided ONLY by the M7C guard from a server-side principal; client UID /
//     email / body / query / frontend labels are NEVER authority.
//   - GET-only: once enabled+DEV, OPTIONS advertises GET (no body), HEAD mirrors GET status with no
//     body, and any other method is rejected (405) with no side effect.
//   - Synthetic-only: the response body is ONLY the already-redacted synthetic C-01 envelope; the
//     handler reads NOTHING live (no DB, Supabase, provider, fetch, process.env).
//   - Safe errors: any failure yields a generic 'error' shape — no stack traces, SQL, internals,
//     auth-claim dumps, existence hints, or identifiers.
//
// Server-side only. Never imported by src/ (the client bundle).

import { authorizeBcpRead } from './bcpAuthorizationGuard';
import type { SyntheticServerPrincipal, NonAuthorityHints } from './bcpAuthorizationGuard';
import {
  buildReadinessSummaryEnvelope,
  type BcpReadinessSummaryEnvelope,
  type SyntheticReadinessSource,
  type EnvLabel,
} from './bcpReadinessSummaryHarness';

/** The ONLY contract this inert route serves. Pinned server-side; never request-controlled. */
const PINNED_CONTRACT_ID = 'C-01';
/** Safe synthetic timestamp default (no real/sensitive server timing in M7E). */
const SYNTHETIC_GENERATED_AT = '2026-01-01T00:00:00.000Z';

export type BcpRouteCategory =
  | 'feature_disabled'
  | 'dev_only'
  | 'method_not_allowed'
  | 'not_authorized'
  | 'parity_blocked'
  | 'synthetic_success'
  | 'no_content'
  | 'safe_error';

/** Minimal, transport-agnostic request descriptor. Authority is NEVER taken from request fields. */
export interface BcpRouteRequest {
  /** HTTP method (case-insensitive). Only GET returns a body. */
  method: string;
  /** False in production. The isolated DEV API is non-production by deployment. */
  isDevEnvironment: boolean;
  /** Resolved from isBcpDevReadonlyPilotEnabled() by the caller (already production-aware). */
  featureEnabled: boolean;
  /** Server-derived (synthetic in M7E) principal, or null. The ONLY authority input. */
  principal: SyntheticServerPrincipal | null;
  /** Ignored for authority; present only so tests can prove it is ignored. */
  hints?: NonAuthorityHints;
  // FORWARD-GUARD: the three fields below are SYNTHETIC/test-only inputs that shape the success
  // envelope. A future LIVE adapter MUST NOT map them from untrusted HTTP query/body/client input
  // (that would be a content-injection/leakage path); they must be server-controlled. They are safe
  // here because this boundary is inert and the mapper independently validates them (ISO-checked
  // timestamp, forbidden-field stripping + label sanitization, typed environment label).
  /** SYNTHETIC posture source (test-only). Never a live read model. */
  syntheticSource?: SyntheticReadinessSource;
  generatedAt?: string;
  environment?: EnvLabel;
}

export interface BcpRouteResponse {
  httpStatus: number;
  category: BcpRouteCategory;
  /** Optional safe response headers (e.g. Allow). */
  headers?: Record<string, string>;
  /** Safe body: a redacted envelope, a safe status object, or null (no-body methods). */
  body: BcpReadinessSummaryEnvelope | { status: string; reason?: string } | null;
}

/**
 * Handle one inert BCP readiness-summary request. PURE + FAIL-CLOSED + NO-THROW.
 * Never reads anything live; never promotes a request field to authority.
 */
export function handleBcpReadinessSummaryRequest(req: BcpRouteRequest): BcpRouteResponse {
  try {
    const method = (req.method || '').toUpperCase();
    const isHead = method === 'HEAD';
    const body = (b: BcpRouteResponse['body']): BcpRouteResponse['body'] => (isHead ? null : b);

    // 1. DEV-only gate — FIRST, for every method, so production never discloses route/method existence.
    if (!req.isDevEnvironment) {
      return { httpStatus: 404, category: 'dev_only', body: body({ status: 'unavailable', reason: 'dev_only' }) };
    }
    // 2. Default-off gate — flag off ⇒ uniformly unavailable, for every method.
    if (!req.featureEnabled) {
      return { httpStatus: 404, category: 'feature_disabled', body: body({ status: 'unavailable', reason: 'feature_disabled' }) };
    }

    // 3. OPTIONS (only reachable when enabled+DEV): advertise GET; never a body or side effect.
    if (method === 'OPTIONS') {
      return { httpStatus: 204, category: 'no_content', headers: { Allow: 'GET' }, body: null };
    }
    // 4. Method gate: GET/HEAD only. Mutations are rejected with no side effect.
    if (method !== 'GET' && !isHead) {
      return { httpStatus: 405, category: 'method_not_allowed', headers: { Allow: 'GET' }, body: { status: 'method_not_allowed' } };
    }

    // 5. Authorization — decided ONLY by the guard; contract pinned server-side to C-01.
    const guard = authorizeBcpRead({
      contractId: PINNED_CONTRACT_ID,
      featureEnabled: true, // gate already enforced above
      principal: req.principal,
      hints: req.hints, // passed through but never used as authority by the guard
    });

    if (guard.decision === 'blocked') {
      return { httpStatus: 409, category: 'parity_blocked', body: body({ status: 'parity_blocked' }) };
    }
    if (guard.decision !== 'allow') {
      // All denials collapse to a single uniform shape (no leak of which check failed).
      return { httpStatus: 403, category: 'not_authorized', body: body({ status: 'not_authorized' }) };
    }

    // 6. HEAD short-circuit: allowed, but a HEAD carries no body — skip building the envelope.
    if (isHead) {
      return { httpStatus: 200, category: 'synthetic_success', body: null };
    }

    // 7. Allowed GET: build ONLY the already-redacted synthetic envelope.
    // The cast is load-bearing: a null principal can never reach here because the guard returns a
    // non-'allow' decision for it at step 5, which is handled above. Keep this invariant if reordering.
    const principal = req.principal as SyntheticServerPrincipal;
    const envelope = buildReadinessSummaryEnvelope(
      guard,
      req.syntheticSource ?? { categories: [] },
      {
        visibilityClass: principal.visibilityClass,
        scopeType: principal.scopeType,
        parityState: principal.parityState,
      },
      req.generatedAt ?? SYNTHETIC_GENERATED_AT,
      req.environment ?? 'DEV',
    );
    return { httpStatus: 200, category: 'synthetic_success', body: envelope };
  } catch {
    // Safe error: never expose the exception, stack, or any internal detail.
    return { httpStatus: 500, category: 'safe_error', body: { status: 'error' } };
  }
}

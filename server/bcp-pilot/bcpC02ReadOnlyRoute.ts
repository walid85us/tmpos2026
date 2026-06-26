// Phase 2.0 M8D — C-02 Backend CP Route / Module Registry Readiness Lens: INERT route boundary handler.
//
// WHAT THIS IS: a PURE, transport-agnostic, NO-THROW route-boundary handler that wires the accepted
// M8C C-02 read model (flag → guard → registry DTO builder) into a single request→response shape. It
// is the thin HTTP boundary ONLY; it adds NO business/redaction logic of its own (the M8C builder
// already emits a safe, bounded, redacted DTO).
//
// INERT (binding): this handler is NOT registered with any live Express app or server startup in M8D.
// It is imported only by its test (and, later, by the M8E isolated-API registration milestone). Full
// registration is DEFERRED here to avoid any runtime/route exposure.
//
// SAFETY (binding):
//   - DEV-only + default-off run FIRST, for EVERY method: production or flag-off ⇒ a uniform
//     'unavailable' response (no data, no method/existence disclosure) regardless of HTTP method.
//   - The contract is PINNED to 'C-02' server-side; it is NEVER taken from the request.
//   - Authorization is decided ONLY by the existing M7C guard from a server-side principal; client
//     UID / email / body / query / frontend labels are NEVER authority.
//   - GET-only: OPTIONS advertises GET (no body), HEAD mirrors GET status with no body, any other
//     method is rejected (405) with no side effect.
//   - Code/config-only: the response body is ONLY the M8C C-02 registry DTO, built from a
//     server-supplied module registry (id/name/status). Reads NOTHING live: no DB, Supabase, provider,
//     fetch, getDb. The module source is sanitized by the M8C builder (every value → safe label/enum).
//   - Safe errors: any failure yields a generic 'error' shape — no stack traces, internals, auth-claim
//     dumps, existence hints, or identifiers.
//
// Server-side only. Never imported by src/ (the client bundle).

import { authorizeBcpRead } from './bcpAuthorizationGuard';
import type { SyntheticServerPrincipal, NonAuthorityHints } from './bcpAuthorizationGuard';
import {
  buildC02RegistryReadinessEnvelope,
  type C02RegistryReadinessEnvelope,
  type C02RegistryModuleInput,
  type C02SourceMode,
} from './bcpC02RegistryReadModel';

/** The ONLY contract this inert route serves. Pinned server-side; never request-controlled. */
const PINNED_CONTRACT_ID = 'C-02';

export type BcpC02RouteCategory =
  | 'feature_disabled'
  | 'dev_only'
  | 'method_not_allowed'
  | 'not_authorized'
  | 'parity_blocked'
  | 'success'
  | 'no_content'
  | 'safe_error';

/** Minimal, transport-agnostic request descriptor. Authority is NEVER taken from request fields. */
export interface BcpC02RouteRequest {
  /** HTTP method (case-insensitive). Only GET returns a body. */
  method: string;
  /** False in production. The isolated DEV API is non-production by deployment. */
  isDevEnvironment: boolean;
  /** Resolved from the C-02 feature flag by the caller (already production-aware, default-off). */
  featureEnabled: boolean;
  /** Server-derived (synthetic in M8D) principal, or null. The ONLY authority input. */
  principal: SyntheticServerPrincipal | null;
  /** Ignored for authority; present only so tests can prove it is ignored. */
  hints?: NonAuthorityHints;
  // FORWARD-GUARD: the two fields below are SERVER-CONTROLLED inputs that shape the success envelope.
  // A future LIVE adapter MUST NOT map them from untrusted HTTP query/body/client input — they must be
  // server-supplied. They are safe here because this boundary is inert and the M8C builder
  // independently sanitizes every module value to a bounded safe label/enum.
  /** Server-supplied code/config module registry (id/name/status shape). Never a live read. */
  modules?: readonly C02RegistryModuleInput[];
  /** Server-supplied DTO mode (defaults to code_config in the builder). */
  mode?: C02SourceMode;
}

export interface BcpC02RouteResponse {
  httpStatus: number;
  category: BcpC02RouteCategory;
  /** Optional safe response headers (e.g. Allow). */
  headers?: Record<string, string>;
  /** Safe body: the C-02 registry DTO, a safe status object, or null (no-body methods). */
  body: C02RegistryReadinessEnvelope | { status: string; reason?: string } | null;
}

/**
 * Handle one inert C-02 registry-readiness request. PURE + FAIL-CLOSED + NO-THROW.
 * Never reads anything live; never promotes a request field to authority.
 */
export function handleBcpC02RegistryReadinessRequest(req: BcpC02RouteRequest): BcpC02RouteResponse {
  try {
    const method = (req.method || '').toUpperCase();
    const isHead = method === 'HEAD';
    const body = (b: BcpC02RouteResponse['body']): BcpC02RouteResponse['body'] => (isHead ? null : b);

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

    // 5. Authorization — decided ONLY by the guard; contract pinned server-side to C-02.
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
      return { httpStatus: 200, category: 'success', body: null };
    }

    // 7. Allowed GET: build ONLY the safe, bounded, already-redacted C-02 registry DTO from the
    //    server-supplied registry (empty array ⇒ safe emptyState). The builder is pure + no-throw.
    const envelope = buildC02RegistryReadinessEnvelope(req.modules ?? [], { mode: req.mode });
    return { httpStatus: 200, category: 'success', body: envelope };
  } catch {
    // Safe error: never expose the exception, stack, or any internal detail.
    return { httpStatus: 500, category: 'safe_error', body: { status: 'error' } };
  }
}

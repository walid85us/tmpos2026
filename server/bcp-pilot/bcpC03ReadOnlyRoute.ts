// Phase 2.0 M12 — C-03 Backend CP UI Coverage / Screen Readiness Lens: INERT route boundary handler.
//
// WHAT THIS IS: a PURE, transport-agnostic, NO-THROW route-boundary handler that wires the accepted C-03
// read model (flag → guard → UI coverage DTO builder) into a single request→response shape. It is the
// thin HTTP boundary ONLY; it adds NO business/redaction logic of its own (the builder already emits a
// safe, bounded, redacted DTO). Mirrors the frozen C-02 route handler exactly.
//
// SAFETY (binding):
//   - DEV-only + default-off run FIRST, for EVERY method: production or flag-off ⇒ a uniform
//     'unavailable' response (no data, no method/existence disclosure) regardless of HTTP method.
//   - The contract is PINNED to 'C-03' server-side; it is NEVER taken from the request.
//   - Authorization is decided ONLY by the existing guard from a server-side principal; client UID /
//     email / body / query / frontend labels are NEVER authority.
//   - GET-only: OPTIONS advertises GET (no body), HEAD mirrors GET status with no body, any other method
//     is rejected (405) with no side effect.
//   - Code/config-only: the response body is ONLY the C-03 UI coverage DTO, built from a server-supplied
//     coverage registry. Reads NOTHING live: no DB, Supabase, provider, fetch, getDb.
//   - Safe errors: any failure yields a generic 'error' shape — no stack traces, internals, auth-claim
//     dumps, existence hints, or identifiers.
//
// Server-side only. Never imported by src/ (the client bundle).

import { authorizeBcpRead } from './bcpAuthorizationGuard';
import type { SyntheticServerPrincipal, NonAuthorityHints } from './bcpAuthorizationGuard';
import {
  buildC03UiCoverageEnvelope,
  type C03UiCoverageEnvelope,
  type C03UiCoverageEntryInput,
} from './bcpC03UiCoverageReadModel';

/** The ONLY contract this inert route serves. Pinned server-side; never request-controlled. */
const PINNED_CONTRACT_ID = 'C-03';

export type BcpC03RouteCategory =
  | 'feature_disabled'
  | 'dev_only'
  | 'method_not_allowed'
  | 'not_authorized'
  | 'parity_blocked'
  | 'success'
  | 'no_content'
  | 'safe_error';

/** Minimal, transport-agnostic request descriptor. Authority is NEVER taken from request fields. */
export interface BcpC03RouteRequest {
  method: string;
  isDevEnvironment: boolean;
  featureEnabled: boolean;
  principal: SyntheticServerPrincipal | null;
  /** Ignored for authority; present only so tests can prove it is ignored. */
  hints?: NonAuthorityHints;
  // FORWARD-GUARD: server-controlled input that shapes the success envelope. A future LIVE adapter MUST
  // NOT map it from untrusted HTTP query/body/client input — it must be server-supplied. Safe here
  // because this boundary is inert and the builder independently sanitizes every value.
  /** Server-supplied code/config UI coverage entries. Never a live read. */
  entries?: readonly C03UiCoverageEntryInput[];
}

export interface BcpC03RouteResponse {
  httpStatus: number;
  category: BcpC03RouteCategory;
  headers?: Record<string, string>;
  body: C03UiCoverageEnvelope | { status: string; reason?: string } | null;
}

/**
 * Handle one inert C-03 UI coverage readiness request. PURE + FAIL-CLOSED + NO-THROW.
 * Never reads anything live; never promotes a request field to authority.
 */
export function handleBcpC03UiCoverageRequest(req: BcpC03RouteRequest): BcpC03RouteResponse {
  try {
    const method = (req.method || '').toUpperCase();
    const isHead = method === 'HEAD';
    const body = (b: BcpC03RouteResponse['body']): BcpC03RouteResponse['body'] => (isHead ? null : b);

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

    // 5. Authorization — decided ONLY by the guard; contract pinned server-side to C-03.
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
      return { httpStatus: 403, category: 'not_authorized', body: body({ status: 'not_authorized' }) };
    }

    // 6. HEAD short-circuit: allowed, but a HEAD carries no body — skip building the envelope.
    if (isHead) {
      return { httpStatus: 200, category: 'success', body: null };
    }

    // 7. Allowed GET: build ONLY the safe, bounded, already-redacted C-03 UI coverage DTO from the
    //    server-supplied entries (empty array ⇒ safe emptyState). The builder is pure + no-throw.
    const envelope = buildC03UiCoverageEnvelope(req.entries ?? []);
    return { httpStatus: 200, category: 'success', body: envelope };
  } catch {
    return { httpStatus: 500, category: 'safe_error', body: { status: 'error' } };
  }
}

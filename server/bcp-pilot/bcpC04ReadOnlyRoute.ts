// Phase 2.0 M14 — C-04 Backend CP Route Exposure Posture Lens: INERT route boundary handler.
//
// WHAT THIS IS: a PURE, transport-agnostic, NO-THROW route-boundary handler that wires the accepted C-04
// read model (flag → guard → route-exposure DTO builder) into a single request→response shape. Thin HTTP
// boundary ONLY; adds NO business/redaction logic of its own. Mirrors the frozen C-02/C-03 handlers.
//
// SAFETY (binding):
//   - DEV-only + default-off run FIRST, for EVERY method (production/flag-off ⇒ uniform unavailable).
//   - Contract PINNED to 'C-04' server-side; never taken from the request.
//   - Authorization decided ONLY by the guard from a server-side principal; client fields are never authority.
//   - GET-only: OPTIONS advertises GET (no body), HEAD mirrors GET status no body, others → 405.
//   - Code/config-only: body is ONLY the C-04 route-exposure DTO from a server-supplied, allow-listed
//     route registry. Reads NOTHING live; no runtime route scan; no router introspection.
//   - Safe errors only: no stack traces, internals, auth-claim dumps, existence hints, or identifiers.
//
// Server-side only. Never imported by src/ (the client bundle).

import { authorizeBcpRead } from './bcpAuthorizationGuard';
import type { SyntheticServerPrincipal, NonAuthorityHints } from './bcpAuthorizationGuard';
import {
  buildC04RouteExposureEnvelope,
  type C04RouteExposureEnvelope,
  type C04RouteExposureEntryInput,
} from './bcpC04RouteExposureReadModel';

/** The ONLY contract this inert route serves. Pinned server-side; never request-controlled. */
const PINNED_CONTRACT_ID = 'C-04';

export type BcpC04RouteCategory =
  | 'feature_disabled'
  | 'dev_only'
  | 'method_not_allowed'
  | 'not_authorized'
  | 'parity_blocked'
  | 'success'
  | 'no_content'
  | 'safe_error';

/** Minimal, transport-agnostic request descriptor. Authority is NEVER taken from request fields. */
export interface BcpC04RouteRequest {
  method: string;
  isDevEnvironment: boolean;
  featureEnabled: boolean;
  principal: SyntheticServerPrincipal | null;
  /** Ignored for authority; present only so tests can prove it is ignored. */
  hints?: NonAuthorityHints;
  // FORWARD-GUARD: server-controlled input shaping the success envelope. A future LIVE adapter MUST NOT
  // map it from untrusted HTTP input — server-supplied only. Safe here: inert boundary + the builder
  // independently allow-list-validates every route path and sanitizes every value.
  /** Server-supplied code/config route-exposure entries. Never a live read / route scan. */
  entries?: readonly C04RouteExposureEntryInput[];
}

export interface BcpC04RouteResponse {
  httpStatus: number;
  category: BcpC04RouteCategory;
  headers?: Record<string, string>;
  body: C04RouteExposureEnvelope | { status: string; reason?: string } | null;
}

/**
 * Handle one inert C-04 route-exposure request. PURE + FAIL-CLOSED + NO-THROW.
 * Never reads anything live, never scans routes, never promotes a request field to authority.
 */
export function handleBcpC04RouteExposureRequest(req: BcpC04RouteRequest): BcpC04RouteResponse {
  try {
    const method = (req.method || '').toUpperCase();
    const isHead = method === 'HEAD';
    const body = (b: BcpC04RouteResponse['body']): BcpC04RouteResponse['body'] => (isHead ? null : b);

    // 1. DEV-only gate — FIRST, for every method.
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

    // 5. Authorization — decided ONLY by the guard; contract pinned server-side to C-04.
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

    // 7. Allowed GET: build ONLY the safe, bounded, allow-listed C-04 route-exposure DTO from the
    //    server-supplied entries (empty ⇒ safe emptyState). The builder is pure + no-throw.
    const envelope = buildC04RouteExposureEnvelope(req.entries ?? []);
    return { httpStatus: 200, category: 'success', body: envelope };
  } catch {
    return { httpStatus: 500, category: 'safe_error', body: { status: 'error' } };
  }
}

// Phase 2.0 M35 — C-07 Backend CP Data Source Boundary Readiness Lens: INERT route boundary handler.
//
// WHAT THIS IS: a PURE, transport-agnostic, NO-THROW route-boundary handler that wires the accepted C-07
// read model (flag → guard → data-source-boundary DTO builder) into a single request→response shape. Thin
// HTTP boundary ONLY; adds NO business/redaction logic of its own. Mirrors the frozen C-02..C-06 handlers.
//
// SAFETY (binding):
//   - DEV-only + default-off run FIRST, for EVERY method (production/flag-off ⇒ uniform unavailable).
//   - Contract PINNED to 'C-07' server-side; never taken from the request.
//   - Authorization decided ONLY by the guard from a server-side principal; client fields are never authority.
//   - GET-only: OPTIONS advertises GET (no body), HEAD mirrors GET status no body, others → 405.
//   - Code/config-only: a success body would be ONLY the C-07 data-source-boundary DTO from server-supplied,
//     allow-listed declared posture items. Reads NOTHING live; no logs/test/typecheck/scan/transport output,
//     no env, no fs, no command, no package read. No production-readiness claim. C-07 stays a declared
//     self-attestation lens — never a live verifier.
//   - Safe errors only: no stack traces, internals, auth-claim dumps, existence hints, or identifiers.
//
// GUARD-GAP (M34 §12 — binding for M35): the shared guard maps C-01..C-06 only. With the pinned 'C-07'
// contract, authorizeBcpRead returns deny('unknown_contract') ⇒ this handler FAIL-CLOSES to 403
// not_authorized on an otherwise-authorized GET/HEAD. The 200 success branch below is structurally present
// but UNREACHABLE until an additive 'C-07' guard entry is separately authorized (M36). This handler NEVER
// modifies, injects, or bypasses the guard to force success, and reads `items` ONLY on the success branch —
// so a denied/disabled request never consumes provider/read-model items.
//
// Server-side only. Never imported by src/ (the client bundle).

import { authorizeBcpRead } from './bcpAuthorizationGuard';
import type { SyntheticServerPrincipal, NonAuthorityHints } from './bcpAuthorizationGuard';
import {
  buildC07DataSourceBoundaryEnvelope,
  type C07DataSourceBoundaryEnvelope,
  type C07BoundaryItemInput,
} from './bcpC07DataSourceBoundaryReadModel';

/** The ONLY contract this inert route serves. Pinned server-side; never request-controlled. */
const PINNED_CONTRACT_ID = 'C-07';

export type BcpC07RouteCategory =
  | 'feature_disabled'
  | 'dev_only'
  | 'method_not_allowed'
  | 'not_authorized'
  | 'parity_blocked'
  | 'success'
  | 'no_content'
  | 'safe_error';

/** Minimal, transport-agnostic request descriptor. Authority is NEVER taken from request fields. */
export interface BcpC07RouteRequest {
  method: string;
  isDevEnvironment: boolean;
  featureEnabled: boolean;
  principal: SyntheticServerPrincipal | null;
  /** Ignored for authority; present only so tests can prove it is ignored. */
  hints?: NonAuthorityHints;
  // FORWARD-GUARD: server-controlled input shaping the success envelope. A future adapter MUST NOT map it
  // from untrusted HTTP input — server-supplied only. Safe here: inert boundary + the builder independently
  // allow-list-validates every boundary item and emits only bounded labels (no raw evidence).
  /** Server-supplied code/config declared boundary items. Never a live read. Consulted ONLY on success. */
  items?: readonly C07BoundaryItemInput[];
}

export interface BcpC07RouteResponse {
  httpStatus: number;
  category: BcpC07RouteCategory;
  headers?: Record<string, string>;
  body: C07DataSourceBoundaryEnvelope | { status: string; reason?: string } | null;
}

/**
 * Handle one inert C-07 data-source-boundary request. PURE + FAIL-CLOSED + NO-THROW.
 * Never reads anything live, never reads env/fs/clock for output, never promotes a request field to authority.
 * Never modifies or bypasses the guard: with no 'C-07' guard entry the authorized path fail-closes to 403.
 */
export function handleBcpC07DataSourceBoundaryRequest(req: BcpC07RouteRequest): BcpC07RouteResponse {
  // Hoisted so the catch can honor "HEAD carries no body" even on the error path (set once method parses).
  let isHead = false;
  try {
    const method = (req.method || '').toUpperCase();
    isHead = method === 'HEAD';
    const body = (b: BcpC07RouteResponse['body']): BcpC07RouteResponse['body'] => (isHead ? null : b);

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

    // 5. Authorization — decided ONLY by the guard; contract pinned server-side to C-07. With no 'C-07' entry
    //    in the shared guard, this returns deny('unknown_contract') ⇒ 403 (fail-closed). NEVER bypassed.
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

    // 7. Allowed GET: build ONLY the safe, bounded, allow-listed C-07 data-source-boundary DTO from the
    //    server-supplied items (empty ⇒ safe emptyState). The builder is pure + no-throw. `items` is consulted
    //    ONLY here — never on a disabled/denied path. UNREACHABLE in M35 (guard-gap); present for M36.
    const envelope = buildC07DataSourceBoundaryEnvelope(req.items ?? []);
    return { httpStatus: 200, category: 'success', body: envelope };
  } catch {
    // HEAD stays bodyless even on error (when method already parsed as HEAD); otherwise a bounded safe body.
    return { httpStatus: 500, category: 'safe_error', body: isHead ? null : { status: 'error' } };
  }
}

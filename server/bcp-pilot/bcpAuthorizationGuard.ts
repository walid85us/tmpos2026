// Phase 2.0 M7C — BCP DEV-only read-only pilot: server-side authorization GUARD SKELETON.
//
// WHAT THIS IS: a PURE, SYNCHRONOUS, NO-THROW, fail-closed guard that decides whether a SYNTHETIC
// server-derived principal may read a given BCP read-only contract. It is a SKELETON for a future
// pilot — it reads NOTHING live: no DB, no Supabase, no provider, no request body authority.
//
// AUTHORITY RULES (binding, mirror M2.1/M6):
//   - The ONLY authority is a server-derived principal (source 'server_derived', verified, with a
//     durable internalUserId). Everything else is a non-authority HINT and is ignored.
//   - Client-supplied UID is NEVER authority. Email is NEVER authority. Frontend-only role labels
//     and URL tenant/store params are NEVER authority.
//   - Fail closed: missing/invalid principal ⇒ deny. Unresolved parity ⇒ blocked. Unknown ⇒ deny.
//
// Server-side only. Never imported by src/. Inert/dormant in M7C (imported only by the harness/tests).

import type { ScopeType } from '../platform-identity/requestContext'; // type-only: erased at runtime.

/** BCP read-only visibility classes (conceptual; see M5 §5 / M6 §5). Ordered weakest→strongest. */
export type BcpVisibilityClass =
  | 'none'
  | 'overview_viewer'
  | 'tenant_store_viewer'
  | 'billing_viewer'
  | 'identity_viewer'
  | 'audit_viewer'
  | 'sensitive_viewer'
  | 'cross_tenant_viewer'
  | 'system_owner';

const VISIBILITY_RANK: Record<BcpVisibilityClass, number> = {
  none: 0,
  overview_viewer: 1,
  tenant_store_viewer: 2,
  billing_viewer: 2,
  identity_viewer: 2,
  audit_viewer: 3,
  sensitive_viewer: 4,
  cross_tenant_viewer: 5,
  system_owner: 6,
};

/** Parity posture of the server-derived principal (see M6). Only 'ready' may proceed. */
export type ParityState = 'ready' | 'unresolved' | 'blocked';

/**
 * SYNTHETIC server-derived principal. In M7C this is only ever constructed by the test harness
 * with obvious placeholders — never from a live token, DB row, or request. The shape mirrors the
 * accepted server-derived model: durable `internalUserId` anchor, provider-aware, verified flag.
 */
export interface SyntheticServerPrincipal {
  /** The ONLY accepted authority source. Any other value is rejected. */
  source: 'server_derived';
  /** Durable, app-owned anchor. Null ⇒ fail closed (token-verified, not authenticated). */
  internalUserId: string | null;
  authProvider: 'firebase' | 'supabase' | null;
  /** True only for a cryptographically verified server-side principal. */
  verified: boolean;
  scopeType: ScopeType;
  parityState: ParityState;
  visibilityClass: BcpVisibilityClass;
}

/**
 * Non-authority hints that a malicious or naive caller might try to use as authority. The guard
 * NEVER reads authority from these — they exist in the type only so tests can prove they are ignored.
 */
export interface NonAuthorityHints {
  clientSuppliedUid?: string;
  email?: string;
  frontendRoleLabel?: string;
  urlTenantParam?: string;
  urlStoreParam?: string;
  bodyInternalUserId?: string;
}

/** Minimum visibility required to read each BCP contract. C-01..C-07 all reuse the overview_viewer floor
 * (read-only); each row is an additive entry — earlier rows are unchanged and no write/manage visibility
 * is introduced. */
const CONTRACT_MIN_VISIBILITY: Record<string, BcpVisibilityClass> = {
  'C-01': 'overview_viewer',
  'C-02': 'overview_viewer',
  'C-03': 'overview_viewer',
  'C-04': 'overview_viewer',
  'C-05': 'overview_viewer',
  'C-06': 'overview_viewer',
  'C-07': 'overview_viewer',
};

export type GuardDecision = 'allow' | 'deny' | 'blocked';

export type GuardReasonCode =
  | 'allow'
  | 'feature_disabled'
  | 'no_server_principal'
  | 'untrusted_authority_only'
  | 'unverified_principal'
  | 'no_internal_user_id'
  | 'parity_unresolved'
  | 'insufficient_visibility'
  | 'unknown_contract';

export interface GuardResult {
  decision: GuardDecision;
  reasonCode: GuardReasonCode;
}

export interface GuardRequest {
  contractId: string;
  /** Default-off feature flag state, resolved by the caller via isBcpDevReadonlyPilotEnabled(). */
  featureEnabled: boolean;
  /** The server-derived principal, or null when none was resolved. */
  principal: SyntheticServerPrincipal | null;
  /** Ignored for authority; present only so we can prove it is ignored. */
  hints?: NonAuthorityHints;
}

const deny = (reasonCode: GuardReasonCode): GuardResult => ({ decision: 'deny', reasonCode });
const blocked = (reasonCode: GuardReasonCode): GuardResult => ({ decision: 'blocked', reasonCode });

/**
 * Decide whether the principal may read the contract. PURE + FAIL-CLOSED. Authority is derived
 * ONLY from `principal`; `hints` are never consulted. Returns a safe decision; never throws.
 */
export function authorizeBcpRead(req: GuardRequest): GuardResult {
  // 0. Feature flag default-off: when disabled, nothing is authorized.
  if (!req.featureEnabled) return deny('feature_disabled');

  // 1. A server-derived principal is mandatory. A request carrying ONLY untrusted hints (a client
  //    UID / email / frontend role / URL param) and no server principal is denied — those are
  //    never promoted to authority.
  if (!req.principal) {
    const hadUntrustedAttempt =
      !!req.hints &&
      (req.hints.clientSuppliedUid != null ||
        req.hints.email != null ||
        req.hints.frontendRoleLabel != null ||
        req.hints.urlTenantParam != null ||
        req.hints.urlStoreParam != null ||
        req.hints.bodyInternalUserId != null);
    return deny(hadUntrustedAttempt ? 'untrusted_authority_only' : 'no_server_principal');
  }

  // 2. Only the server-derived source is accepted as authority.
  if (req.principal.source !== 'server_derived') return deny('no_server_principal');

  // 3. The principal must be a cryptographically verified server-side principal.
  if (!req.principal.verified) return deny('unverified_principal');

  // 4. Fail closed when no durable app-owned anchor resolved (token-verified ≠ authenticated).
  if (!req.principal.internalUserId) return deny('no_internal_user_id');

  // 5. Parity must be proven ready before any live-shaped read is authorized.
  if (req.principal.parityState !== 'ready') return blocked('parity_unresolved');

  // 6. Contract must be a KNOWN OWN mapping and the principal must meet its minimum visibility. Own-property
  //    lookup ONLY: an inherited Object.prototype key (e.g. 'toString', 'constructor', '__proto__', 'valueOf',
  //    'hasOwnProperty', 'isPrototypeOf') must be treated as an unknown contract — never resolved to a truthy
  //    inherited member. hasOwnProperty.call fails closed for every such key.
  if (!Object.prototype.hasOwnProperty.call(CONTRACT_MIN_VISIBILITY, req.contractId)) {
    return deny('unknown_contract');
  }
  const required = CONTRACT_MIN_VISIBILITY[req.contractId];
  // Defense-in-depth (symmetry with the contract lookup above): the principal's visibility class must be a
  // KNOWN OWN key of VISIBILITY_RANK. Own-property lookup ONLY — an inherited Object.prototype key (e.g.
  // 'toString', 'constructor', '__proto__', 'valueOf', 'hasOwnProperty', 'isPrototypeOf') resolves to a
  // truthy inherited member that a bare `=== undefined` check would miss, then coerces to NaN in the rank
  // comparison (never < the floor) and would fall through to allow. hasOwnProperty.call fails closed for
  // every such key; a genuinely-unknown class (own-lookup undefined) is likewise treated as insufficient.
  if (!Object.prototype.hasOwnProperty.call(VISIBILITY_RANK, req.principal.visibilityClass)) {
    return deny('insufficient_visibility');
  }
  const principalRank = VISIBILITY_RANK[req.principal.visibilityClass];
  if (principalRank < VISIBILITY_RANK[required]) {
    return deny('insufficient_visibility');
  }

  return { decision: 'allow', reasonCode: 'allow' };
}

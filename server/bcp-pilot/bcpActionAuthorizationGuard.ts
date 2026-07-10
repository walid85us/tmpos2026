// Phase 3.0 M2 — Controlled-action authorization guard (NEW, parallel to the frozen read guard).
//
// WHAT THIS IS: a PURE, SYNCHRONOUS, NO-THROW, fail-closed guard that decides whether a SERVER-DERIVED
// principal may EXECUTE a controlled backend action. It is a NEW, separate decision — it does NOT import
// the runtime logic of, fork, or mutate the frozen read guard (`bcpAuthorizationGuard.ts`). It reuses only
// the frozen guard's TYPES (type-only import, erased at runtime) and the existing platform permission-level
// helpers. It reads NOTHING live: no DB, no Supabase, no provider, no request body authority.
//
// FLOOR (binding, per Phase 3.0 M1): far stricter than the read floor (`overview_viewer`).
//   - Visibility: `system_owner` (the strongest class) — exact-equality is the floor (nothing outranks it).
//   - Permission: platform `manage` via `meetsPlatformPermissionLevel` (PLATFORM ordering: approve < manage).
//   - Read-only / overdue plan states cap the permission down to `view` (execute denied).
//   - DEV-only + default-off + verified server-derived principal + ready parity — all fail closed.
//
// Server-side only. Never imported by src/ (the client bundle).

import type { SyntheticServerPrincipal, BcpVisibilityClass, NonAuthorityHints } from './bcpAuthorizationGuard'; // type-only.
import { meetsPlatformPermissionLevel, capPlatformLevelForReadOnly } from '../platform-identity/permissionCatalog';
import type { PermissionLevelValue } from '../platform-identity/authorizationConstants';

/** Visibility floor for ANY controlled action: the strongest class. Exact equality IS the floor. */
export const BCP_ACTION_VISIBILITY_FLOOR: BcpVisibilityClass = 'system_owner';
/** Platform permission floor for ANY controlled action. */
export const BCP_ACTION_PERMISSION_FLOOR: PermissionLevelValue = 'manage';

export type ActionGuardDecision = 'allow' | 'deny' | 'blocked';

export type ActionGuardReasonCode =
  | 'allow'
  | 'production_forbidden'
  | 'feature_disabled'
  | 'no_server_principal'
  | 'untrusted_authority_only'
  | 'unverified_principal'
  | 'no_internal_user_id'
  | 'parity_unresolved'
  | 'insufficient_visibility'
  | 'insufficient_permission';

export interface ActionGuardResult {
  decision: ActionGuardDecision;
  reasonCode: ActionGuardReasonCode;
}

export interface ActionGuardRequest {
  /** The controlled-action key (pinned server-side by the caller; never a request field). */
  actionKey: string;
  /** DEV/non-production posture (NODE_ENV !== 'production'), resolved by the caller. */
  isDevEnvironment: boolean;
  /** Default-off feature flag state, resolved by the caller. */
  featureEnabled: boolean;
  /** The server-derived principal, or null when none was resolved. */
  principal: SyntheticServerPrincipal | null;
  /** Server-resolved platform permission level, or null. NEVER read from the request body. */
  platformPermissionLevel: PermissionLevelValue | null;
  /** Server-resolved read-only plan state (caps execute → view). */
  planReadOnly?: boolean;
  /** Server-resolved overdue plan state (caps execute → view). */
  planOverdue?: boolean;
  /** Ignored for authority; present only so tests can prove it is ignored. */
  hints?: NonAuthorityHints;
}

const deny = (reasonCode: ActionGuardReasonCode): ActionGuardResult => ({ decision: 'deny', reasonCode });
const blocked = (reasonCode: ActionGuardReasonCode): ActionGuardResult => ({ decision: 'blocked', reasonCode });

/**
 * Decide whether the principal may execute the controlled action. PURE + FAIL-CLOSED. Authority is derived
 * ONLY from `principal` + the server-resolved permission level; `hints` are never consulted. Never throws.
 */
export function authorizeBcpAction(req: ActionGuardRequest): ActionGuardResult {
  // 0. Production is never permitted (defense-in-depth even if the handler already gated).
  if (!req.isDevEnvironment) return deny('production_forbidden');

  // 1. Default-off feature flag.
  if (!req.featureEnabled) return deny('feature_disabled');

  // 2. A server-derived principal is mandatory; untrusted hints are never promoted to authority.
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

  // 3. Only the server-derived source is authority.
  if (req.principal.source !== 'server_derived') return deny('no_server_principal');
  // 4. Must be a cryptographically verified principal.
  if (!req.principal.verified) return deny('unverified_principal');
  // 5. Must carry a durable app-owned anchor.
  if (!req.principal.internalUserId) return deny('no_internal_user_id');
  // 6. Parity must be proven ready.
  if (req.principal.parityState !== 'ready') return blocked('parity_unresolved');

  // 7. Visibility floor: system_owner (the strongest class). Exact equality — an unknown/inherited class value
  //    will not equal 'system_owner', so this fails closed for anything weaker or malformed.
  if (req.principal.visibilityClass !== BCP_ACTION_VISIBILITY_FLOOR) return deny('insufficient_visibility');

  // 8. Permission floor: platform `manage`, with read-only/overdue cap. A missing level fails closed.
  if (req.platformPermissionLevel == null) return deny('insufficient_permission');
  let level: PermissionLevelValue = req.platformPermissionLevel;
  if (req.planReadOnly || req.planOverdue) level = capPlatformLevelForReadOnly(level);
  if (!meetsPlatformPermissionLevel(level, BCP_ACTION_PERMISSION_FLOOR)) return deny('insufficient_permission');

  return { decision: 'allow', reasonCode: 'allow' };
}

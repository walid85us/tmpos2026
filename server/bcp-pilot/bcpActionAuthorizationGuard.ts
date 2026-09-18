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
  | 'insufficient_permission'
  | 'scope_mismatch'
  | 'unknown_action';

/**
 * Every controlled action the guard can authorize. An action key outside this list is no action and is
 * refused (docs/phase-4/04 §3 safeguard #4). The owning modules' constants are asserted against it.
 */
export const BCP_CONTROLLED_ACTION_KEYS: readonly string[] = Object.freeze(['bcp.action.acknowledge_readiness_review']);

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
  // Every request field is read ONCE, here, so a getter cannot answer a check and its use differently;
  // a request that throws while being read is refused. Every boolean gate is `=== true`: a truthy
  // non-boolean ('false', 1) is not a yes.
  let fields: Pick<ActionGuardRequest, 'actionKey' | 'isDevEnvironment' | 'featureEnabled' | 'principal'
    | 'platformPermissionLevel' | 'planReadOnly' | 'planOverdue' | 'hints'>;
  try {
    const { actionKey, isDevEnvironment, featureEnabled, principal, platformPermissionLevel, planReadOnly, planOverdue, hints } = req;
    fields = { actionKey, isDevEnvironment, featureEnabled, principal, platformPermissionLevel, planReadOnly, planOverdue, hints };
  } catch {
    return deny('no_server_principal');
  }
  // 0. Production is never permitted (defense-in-depth even if the handler already gated).
  if (fields.isDevEnvironment !== true) return deny('production_forbidden');

  // 1. Default-off feature flag.
  if (fields.featureEnabled !== true) return deny('feature_disabled');

  // 1a. Only a declared controlled action can be authorized: an unknown action key is no action.
  if (typeof fields.actionKey !== 'string' || !BCP_CONTROLLED_ACTION_KEYS.includes(fields.actionKey)) {
    return deny('unknown_action');
  }

  return authorizeReadFields(fields);
}

function authorizeReadFields(req: Pick<ActionGuardRequest, 'principal' | 'platformPermissionLevel' | 'planReadOnly' | 'planOverdue' | 'hints'>): ActionGuardResult {
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

  // The principal's fields, read once.
  let p: Pick<SyntheticServerPrincipal, 'source' | 'verified' | 'internalUserId' | 'parityState' | 'scopeType' | 'visibilityClass'>;
  try {
    const { source, verified, internalUserId, parityState, scopeType, visibilityClass } = req.principal;
    p = { source, verified, internalUserId, parityState, scopeType, visibilityClass };
  } catch {
    return deny('no_server_principal');
  }
  // 3. Only the server-derived source is authority.
  if (p.source !== 'server_derived') return deny('no_server_principal');
  // 4. Must be a cryptographically verified principal.
  if (p.verified !== true) return deny('unverified_principal');
  // 5. Must carry a durable app-owned anchor.
  if (!p.internalUserId) return deny('no_internal_user_id');
  // 6. Parity must be proven ready.
  if (p.parityState !== 'ready') return blocked('parity_unresolved');
  // 6a. A controlled action is a PLATFORM action: a principal resolved at any other plane — tenant,
  //     store, none, or an unrecognised one — is refused before its visibility or level is consulted.
  if (p.scopeType !== 'platform') return deny('scope_mismatch');

  // 7. Visibility floor: system_owner (the strongest class). Exact equality — an unknown/inherited class value
  //    will not equal 'system_owner', so this fails closed for anything weaker or malformed.
  if (p.visibilityClass !== BCP_ACTION_VISIBILITY_FLOOR) return deny('insufficient_visibility');

  // 8. Permission floor: platform `manage`, with read-only/overdue cap. A missing level fails closed. Each plan
  //    flag lifts the cap only when it is exactly `false` or absent: a malformed flag (0, 'false') restricts.
  const held = req.platformPermissionLevel;
  if (held == null) return deny('insufficient_permission');
  const unrestricted = (flag: unknown): boolean => flag === false || flag === undefined;
  const level: PermissionLevelValue = unrestricted(req.planReadOnly) && unrestricted(req.planOverdue)
    ? held
    : capPlatformLevelForReadOnly(held);
  if (!meetsPlatformPermissionLevel(level, BCP_ACTION_PERMISSION_FLOOR)) return deny('insufficient_permission');

  return { decision: 'allow', reasonCode: 'allow' };
}

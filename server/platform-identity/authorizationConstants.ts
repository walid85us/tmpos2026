// Phase 1.5 M9 — Inert shared vocabulary for server-derived authorization + durable audit.
//
// PURPOSE: declare the STABLE constant vocabulary (versions, evaluator labels,
// action-id prefixes, reason-code families, status/level/role/scope values, the
// two distinct permission orderings, evidence levels, decision/result outcomes)
// that the future server-derived authorization model and durable audit will use.
//
// This file is INERT (Option B — contract-only):
//   - It contains TypeScript types and `as const` DATA ONLY. No functions that do
//     work, no side effects, no runtime adoption.
//   - It is imported by NOTHING at runtime — only by the M9 contract type files
//     (via `import type`), the two M9 diagnostics, and referenced by the M9 doc.
//   - It does NOT modify or replace the existing permission engines
//     (src/context/accessConfig.ts, src/owner/platformPermissionsConfig.ts,
//     server/platform-identity/permissionDecision.ts). It DUPLICATES their
//     vocabulary as a documented mirror so the server contract does not import the
//     client bundle. See DRIFT RISK below.
//
// SECURITY (binding): imports NOTHING. Reads NO env. No DB/Supabase/Firebase/
// Express. References NO service-role key, DB URL, JWT secret, raw token, JWKS,
// or connection string. Server-side only; never imported by the client bundle at
// runtime.
//
// ⚠ DRIFT RISK (documented, NOT resolved here): the level orderings and role ids
// below intentionally mirror the client engine. They are ALSO mirrored in
// server/platform-identity/permissionDecision.ts (which carries the same warning).
// A FUTURE milestone should unify all three into ONE shared catalog imported by
// BOTH src/ and server/. M9 only DECLARES that target (see
// SHARED_PERMISSION_CATALOG_TARGET) — it does not build it.

// =============================================================================
// Contract versions + evaluator labels
// =============================================================================

/** Version tag for the server-derived authorization contract (this era). */
export const AUTHORIZATION_CONTRACT_VERSION = 'authz.v1' as const;
/** Version tag for the durable audit-event contract (this era). */
export const AUDIT_CONTRACT_VERSION = 'audit.v1' as const;

/** Evaluator label for a future server-derived authorization decision. */
export const AUTHORIZATION_EVALUATED_BY = 'server_authorization@v0-contract' as const;
/** Evaluator label for a future durable audit event. */
export const AUDIT_EVALUATED_BY = 'durable_audit@v0-contract' as const;

// =============================================================================
// Action id prefixes + reason-code families (organizational vocabulary)
// =============================================================================

/** Prefix families for future action ids (mirror the M2/M3 actionId style). */
export const ACTION_ID_PREFIXES = {
  platform: 'platform.',
  tenant: 'tenant.',
  store: 'store.',
  auth: 'auth.',
} as const;
export type ActionIdPrefix = (typeof ACTION_ID_PREFIXES)[keyof typeof ACTION_ID_PREFIXES];

/**
 * Reason-code FAMILIES the future contracts group codes under. Declarative only;
 * the concrete codes (e.g. 'verified_supabase', 'denied_missing_permission',
 * 'denied_plan_locked', 'account_suspended') already live in the M6 session-resolve
 * contract and the M2 permissionDecision engine and are NOT re-declared here.
 */
export const REASON_CODE_FAMILIES = [
  'identity',
  'authorization',
  'plan_entitlement',
  'account_status',
  'scope',
  'system',
] as const;
export type ReasonCodeFamily = (typeof REASON_CODE_FAMILIES)[number];

// =============================================================================
// User type / scope / provider
// =============================================================================

export const USER_TYPE_VALUES = ['platform', 'tenant'] as const;
export type UserType = (typeof USER_TYPE_VALUES)[number];

export const SCOPE_TYPE_VALUES = ['platform', 'tenant', 'store', 'none'] as const;
export type ScopeTypeValue = (typeof SCOPE_TYPE_VALUES)[number];

export const AUTH_PROVIDER_VALUES = ['supabase', 'firebase'] as const;
export type AuthProviderValue = (typeof AUTH_PROVIDER_VALUES)[number];

// =============================================================================
// Account / membership status
// =============================================================================

/** Mirrors src/context/accessConfig.ts `AccountStatus`. Duplicated, not imported. */
export const ACCOUNT_STATUS_VALUES = [
  'active',
  'trialing',
  'overdue',
  'suspended',
  'read_only',
  'pending_activation',
] as const;
export type AccountStatusValue = (typeof ACCOUNT_STATUS_VALUES)[number];

/** Mirrors the AccessContext `Session.status` vocabulary. Duplicated, not imported. */
export const MEMBERSHIP_STATUS_VALUES = ['active', 'invited', 'suspended', 'pending_setup'] as const;
export type MembershipStatusValue = (typeof MEMBERSHIP_STATUS_VALUES)[number];

/** Statuses that DENY before any role grant (status precedence runs first). */
export const STATUS_DENY_BEFORE_ROLE: readonly AccountStatusValue[] = [
  'suspended',
  'pending_activation',
] as const;

// =============================================================================
// Permission levels + the two distinct orderings (the documented DRIFT RISK)
// =============================================================================

export const PERMISSION_LEVEL_VALUES = [
  'none',
  'view',
  'create',
  'edit',
  'manage',
  'approve',
  'full',
] as const;
export type PermissionLevelValue = (typeof PERMISSION_LEVEL_VALUES)[number];

/** MIRRORS src/context/accessConfig.ts PERMISSION_HIERARCHY (note: manage < approve). */
export const TENANT_PERMISSION_ORDERING: readonly PermissionLevelValue[] = [
  'none',
  'view',
  'create',
  'edit',
  'manage',
  'approve',
  'full',
] as const;

/** MIRRORS src/owner/platformPermissionsConfig.ts PLATFORM_PERMISSION_LEVELS (note: approve < manage). */
export const PLATFORM_PERMISSION_ORDERING: readonly PermissionLevelValue[] = [
  'none',
  'view',
  'create',
  'edit',
  'approve',
  'manage',
  'full',
] as const;

// =============================================================================
// Role ids (mirror; duplicated, NOT imported from the client engine)
// =============================================================================

export const PLATFORM_ROLE_IDS = [
  'system_owner',
  'support_admin',
  'billing_admin',
  'operations_admin',
  'security_admin',
] as const;
export type PlatformRoleId = (typeof PLATFORM_ROLE_IDS)[number];

export const TENANT_ROLE_IDS = ['store_owner', 'manager', 'technician', 'sales_staff'] as const;
export type TenantRoleId = (typeof TENANT_ROLE_IDS)[number];

/** Owner roles that short-circuit to full access within their scope. */
export const OWNER_ROLE_IDS = ['system_owner', 'store_owner'] as const;

// =============================================================================
// Audit vocabulary: evidence levels, decisions, result status
// =============================================================================

/**
 * Evidence levels DISTINGUISH the existing advisory dev-sidecar log (M2) from a
 * FUTURE durable compliance event. The advisory value is reused verbatim from the
 * M2 audit envelope; the durable value is the new, not-yet-emitted level.
 */
export const EVIDENCE_LEVELS = ['dev_sidecar_log_advisory', 'durable_compliance_event'] as const;
export type EvidenceLevel = (typeof EVIDENCE_LEVELS)[number];

export const DECISION_VALUES = ['allow', 'deny', 'deferred', 'not_applicable'] as const;
export type DecisionValue = (typeof DECISION_VALUES)[number];

export const RESULT_STATUS_VALUES = ['succeeded', 'failed', 'n_a'] as const;
export type ResultStatusValue = (typeof RESULT_STATUS_VALUES)[number];

// =============================================================================
// Future shared-catalog TARGET (declared, NOT built)
// =============================================================================

/**
 * The SHAPE of a future single-source-of-truth permission catalog entry that
 * BOTH src/ and server/ would import — replacing today's duplicated orderings and
 * sub-permission definitions. Declared for alignment only; NO catalog is built in
 * M9, and no existing engine is modified.
 */
export interface SharedPermissionCatalogEntry {
  /** Stable id (domain/feature key or sub-permission id). */
  key: string;
  /** Which ordering applies to this key. */
  ordering: 'tenant' | 'platform';
  /** Minimum module level required (for sub-permissions); null for domains. */
  minModuleLevel: PermissionLevelValue | null;
  /** Default level granted when no explicit grant exists. */
  defaultLevel: PermissionLevelValue;
  /** Plan/feature keys that must be entitled for this key to exist. */
  requiresEntitlements: readonly string[];
}

/** Documentation marker for the future shared-catalog unification target. */
export const SHARED_PERMISSION_CATALOG_TARGET = {
  status: 'declared_not_built',
  unifies: [
    'src/context/accessConfig.ts (tenant ordering + SUB_PERMISSIONS + FEATURE_PERMISSION_DEPENDENCIES)',
    'src/owner/platformPermissionsConfig.ts (platform ordering + platform sub-permissions + dependencies)',
    'server/platform-identity/permissionDecision.ts (server mirror of both orderings)',
  ],
  note: 'Future single source of truth imported by BOTH src/ and server/. Not built in M9.',
} as const;

// Phase 1.6 M13 — Dormant Server-Authz SHADOW COMPARISON helper: TYPES ONLY.
//
// PURPOSE: declare the SHAPE of (a) the SYNTHETIC / caller-provided server-derived
// authorization DTO the dormant comparison helper accepts, and (b) the NON-SECRET,
// STRUCTURAL comparison result it returns. This file is INERT:
//   - TypeScript types ONLY — no runtime values, no side effects, no env reads, no
//     fetch, no import-time execution, no top-level await.
//   - Imports NOTHING (no app module, no server module, no SDK).
//   - Imported only by `serverAuthzShadowComparison.ts` and the M13 dormancy diagnostic.
//
// COMPARISON BOUNDARY (binding): the result describes STRUCTURAL KEY-SPACE parity ONLY
// (permissions / subPermissions / entitlements key NAMES + counts + safe mismatch key
// names). It NEVER carries — and the helper NEVER reads/compares — permission-LEVEL
// values, allow/deny behavior, role values, tenant/store ids, plan values, identity
// fields, access/refresh tokens, raw JWTs, provider tokens, or the raw authorization
// DTO. `authorization: null` means server authorization is UNAVAILABLE / NOT EVALUATED
// (the legacy client engine remains authoritative) — it is NOT deny and NOT fail-open.

/**
 * Outcome phase of a single (synthetic-input) structural comparison run:
 *   - 'disabled'                 → not a DEV build, or the DEV-only shadow opt-in flag
 *                                  is not 'true'. The helper short-circuits and performs
 *                                  NO comparison (default OFF). Not deny, not fail-open.
 *   - 'server_authz_unavailable' → the caller passed `null` (server-derived authorization
 *                                  unavailable / not evaluated). The legacy client engine
 *                                  remains authoritative. Not deny, not fail-open.
 *   - 'compared'                 → enabled AND a non-null synthetic DTO was supplied; the
 *                                  three key-spaces were structurally compared. Result is
 *                                  COMPARABLE ONLY — never authoritative, never enforceable.
 */
export type ServerAuthzShadowComparisonPhase =
  | 'disabled'
  | 'server_authz_unavailable'
  | 'compared';

/**
 * SYNTHETIC / caller-provided shape that LOOSELY mirrors the server-derived authorization
 * DTO's three key-maps (`server/platform-identity/authorizationContract.ts`
 * `ServerDerivedAuthorizationV1`). It is intentionally declared HERE (not imported from the
 * server contract) so the dormant frontend helper takes a runtime dependency on NO server
 * module. ONLY the three key-maps are read — and ONLY their KEYS, never their values:
 *   - `permissions`    : domain / platform-feature key → (level value — NEVER read)
 *   - `subPermissions` : sub-permission id              → (granted boolean — NEVER read)
 *   - `entitlements`   : plan feature key               → (enabled boolean — NEVER read)
 * Any other server DTO fields (scope/roles/status/userType/derivedBy/authorizationVersion)
 * MAY be present on a synthetic object but are deliberately ignored — they are role / tenant
 * / store / plan / identity values and are OUT of the structural comparison boundary.
 */
export interface ServerDerivedAuthorizationLike {
  /** Effective permission key-space (value LEVELS are never read or compared). */
  permissions?: Readonly<Record<string, unknown>> | null;
  /** Effective sub-permission key-space (granted BOOLEANS are never read or compared). */
  subPermissions?: Readonly<Record<string, unknown>> | null;
  /** Feature entitlement key-space (enabled BOOLEANS are never read or compared). */
  entitlements?: Readonly<Record<string, unknown>> | null;
}

/**
 * Structural comparison of ONE key-space (permissions | subPermissions | entitlements).
 * Carries ONLY safe, non-secret KEY NAMES and counts — never values, levels, or decisions.
 */
export interface KeySpaceComparison {
  /** True when there are NO missing-from-server AND NO unknown-to-frontend keys. */
  parity: boolean;
  /** Count of known frontend vocabulary keys for this key-space. */
  frontendKeyCount: number;
  /** Count of distinct (normalized) keys present on the synthetic server DTO map. */
  serverKeyCount: number;
  /** Count of server keys that are recognized by the frontend vocabulary. */
  matchedKeyCount: number;
  /** Frontend vocabulary keys ABSENT from the synthetic server map (safe key names). */
  missingFromServerKeys: string[];
  /**
   * Synthetic server keys NOT recognized by the frontend vocabulary (safe key names).
   * Unknown keys are ALWAYS reported as a mismatch and NEVER fail open.
   */
  unknownToFrontendKeys: string[];
}

/** Non-secret top-level counts (key COUNTS only — never values/levels/identity). */
export interface ServerAuthzShadowComparisonCounts {
  frontendPermissionKeys: number;
  frontendSubPermissionKeys: number;
  frontendEntitlementKeys: number;
  serverPermissionKeys: number;
  serverSubPermissionKeys: number;
  serverEntitlementKeys: number;
}

/**
 * Non-secret STRUCTURAL comparison result. It carries ONLY: the phase, presence flag,
 * parity booleans, per-key-space comparisons (safe key names + counts), aggregate counts,
 * and a PHASE-DERIVED message. It NEVER carries a token / access_token / refresh_token /
 * JWT / provider token, internalUserId / authProvider / authProviderUid / email /
 * displayName / identity, tenantId / storeId, role values, plan values, permission-LEVEL
 * values, or the raw authorization DTO / raw entitlement payload.
 */
export interface ServerAuthzShadowComparisonResult {
  /** Honest, default-OFF phase (see ServerAuthzShadowComparisonPhase). */
  phase: ServerAuthzShadowComparisonPhase;
  /** True ONLY when a non-null synthetic DTO was supplied AND the helper was enabled. */
  serverAuthzPresent: boolean;
  /** True ONLY when all three key-spaces are in structural parity (and authz present). */
  overallParity: boolean;
  /** Per-key-space parity shortcuts (mirror the `*.parity` fields below). */
  permissionKeyParity: boolean;
  subPermissionKeyParity: boolean;
  entitlementKeyParity: boolean;
  /** Structural comparison of the permission key-space. */
  permissionKeySpace: KeySpaceComparison;
  /** Structural comparison of the subPermission key-space. */
  subPermissionKeySpace: KeySpaceComparison;
  /** Structural comparison of the entitlement key-space. */
  entitlementKeySpace: KeySpaceComparison;
  /** Aggregate non-secret counts. */
  counts: ServerAuthzShadowComparisonCounts;
  /** Safe, non-secret, PHASE-DERIVED status note (never echoes server values). */
  message: string;
}

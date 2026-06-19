// Phase 1.6 M13 — Dormant, DEV-flag-gated SERVER-AUTHZ SHADOW COMPARISON helper (Stage 4c).
//
// WHAT THIS IS: a PURE, SYNCHRONOUS, NO-THROW helper that — WHEN EXPLICITLY INVOKED BY A
// FUTURE, SEPARATELY-APPROVED CALLER — structurally compares a SYNTHETIC / caller-provided
// server-derived authorization DTO against the FRONTEND permission vocabulary. It compares
// ONLY KEY-SPACE coverage (permissions / subPermissions / entitlements key NAMES, counts,
// and safe mismatch key names) and returns a NON-SECRET structural result.
//
// WHAT THIS IS NOT (binding for M13): it changes NO current behavior and reads NOTHING live.
//   - It accepts SYNTHETIC / caller-provided input ONLY. It NEVER reads a live response, NEVER
//     calls the backend session-resolve route, NEVER fetches / XHRs / sendBeacons, NEVER uses a token,
//     and NEVER imports the M12 session-resolve shadow client or the M11 token bridge.
//   - It is DORMANT: imported by NOTHING active (not AccessContext, Login, AccessGuard, App
//     routing, src/main.tsx, or the pilot) and invoked by NOTHING in M13, so the bundler
//     tree-shakes it (and its identifiers + flag) out of production. (Proven by the M13
//     dormancy diagnostic + the bundle scan.)
//   - It has NO import-time side effects and NO top-level await. It builds frozen, in-memory
//     vocabulary key-sets at module load from PLAIN-DATA frontend config exports only.
//
// STRICT COMPARISON BOUNDARY (binding): it compares ONLY permission / subPermission /
// entitlement KEY-SPACES. It NEVER compares permission-LEVEL values, allow/deny behavior,
// AccessContext function outputs (hasPermission / checkSubPermission / canAccess /
// getPermissionLevel / isStoreActivated / resolveLandingRoute), role values, tenant ids,
// store ids, plan values, identity values, or routing. Only KEYS are read — never values.
// Unknown server keys are ALWAYS reported as a mismatch and NEVER fail open.
//
// NULL / NON-NULL (binding):
//   - `authorization: null` ⇒ server authorization UNAVAILABLE / NOT EVALUATED. The legacy
//     client engine remains authoritative. It is NOT deny, NOT fail-open, NOT enforceable.
//   - non-null authorization ⇒ COMPARABLE ONLY. NOT authoritative, NOT enforceable, NOT a
//     replacement for AccessContext.
//
// RESULT SAFETY (binding): the result carries ONLY phase / presence / parity booleans /
// per-key-space comparisons (safe key names + counts) / aggregate counts / a PHASE-DERIVED
// message. It NEVER carries a token / access_token / refresh_token / JWT / provider token,
// internalUserId / authProvider / authProviderUid / email / displayName / identity, tenantId /
// storeId, role values, plan values, permission-LEVEL values, or the raw authorization DTO.
//
// ISOLATION: imports the FRONTEND permission vocabulary (plain-data / pure-function modules
// `src/context/accessConfig.ts` + `src/owner/platformPermissionsConfig.ts`) and its own types
// ONLY — NOT the server permission catalog, NOT any server/backend module, NOT the M12 shadow
// client, NOT the M11 token bridge, NOT `@supabase/supabase-js`, NOT React, NOT Firebase, NOT
// AccessContext / Login / AccessGuard / App / main, and NOT the pilot.
//
// FLAG (binding): VITE_ENABLE_SERVER_AUTHZ_SHADOW is DEV-only and default OFF. It is SEPARATE
// from the foundation / bootstrap / awareness / diagnostic-surface / token-bridge /
// session-resolve-shadow flags. No other new flag is introduced; the session-resolve-shadow,
// token-bridge, and session-resolve-route-helper flags are deliberately NOT referenced here.

import {
  PERMISSION_DOMAINS,
  SUB_PERMISSIONS,
  planFeatures,
} from '../context/accessConfig';
import {
  PLATFORM_FEATURE_GROUPS,
  PLATFORM_SUB_PERMISSION_ALIASES,
} from '../owner/platformPermissionsConfig';
import type {
  ServerDerivedAuthorizationLike,
  ServerAuthzShadowComparisonPhase,
  ServerAuthzShadowComparisonResult,
  KeySpaceComparison,
} from './serverAuthzShadowComparisonTypes';

// -----------------------------------------------------------------------------
// Public env boundary (client-safe, VITE_-only). Read through a single narrow cast so this
// helper adds NO new ImportMeta typing error and does not alter the baseline. PURE reads only.
// -----------------------------------------------------------------------------

interface ShadowComparisonPublicEnv {
  /** Vite's built-in dev flag (true under `vite dev`, false in production builds). */
  DEV?: boolean;
  /** DEV-only server-authz-shadow opt-in — must equal the string 'true' to enable. */
  VITE_ENABLE_SERVER_AUTHZ_SHADOW?: string;
}

/** Pure read of the public env object. No side effects, no I/O. */
function readEnv(): ShadowComparisonPublicEnv {
  return (import.meta as unknown as { env?: ShadowComparisonPublicEnv }).env ?? {};
}

/** True only under a Vite DEV build (never in a production build). */
export function isDevBuild(): boolean {
  return readEnv().DEV === true;
}

/** True only when the operator has explicitly opted the server-authz shadow in. */
export function isServerAuthzShadowFlagOn(): boolean {
  return readEnv().VITE_ENABLE_SERVER_AUTHZ_SHADOW === 'true';
}

/**
 * The server-authz shadow comparison helper is ENABLED only when BOTH hold:
 *   - we are in a Vite DEV build (production is always OFF), AND
 *   - the explicit shadow opt-in flag is 'true'.
 * Default behaviour is OFF. Even when enabled, M13 invokes this from nowhere. Unlike the M12
 * shadow client, this helper does NOT require (or reference) the token bridge — it does NO
 * network and uses NO token.
 */
export function isServerAuthzShadowEnabled(): boolean {
  return isDevBuild() && isServerAuthzShadowFlagOn();
}

// -----------------------------------------------------------------------------
// Frozen FRONTEND permission vocabulary key-sets — derived ONCE at module load from PLAIN-DATA
// frontend config exports. No values/levels are captured; only KEY NAMES. The permission and
// subPermission key-spaces UNION the tenant-side (accessConfig) and platform-side
// (platformPermissionsConfig) vocabularies, mirroring the four key-spaces proven total by the
// M3 adoption-readiness diagnostic (tenant domains + platform features; tenant subs + platform
// subs). The entitlement key-space is the union of plan feature keys, alias-normalized.
// -----------------------------------------------------------------------------

/**
 * Known entitlement feature-key alias. The server-derived entitlement map may emit the
 * underscore form `supply_chain`; the frontend plan-feature vocabulary canonicalizes it to the
 * dashed `supply-chain`. Normalization is idempotent for already-canonical keys. (This is the
 * ENTITLEMENT-space alias only; the permission-space module id stays `supply_chain` on both
 * sides, so it needs no normalization.)
 */
export function normalizeEntitlementKey(key: string): string {
  return key === 'supply_chain' ? 'supply-chain' : key;
}

/** Permission key-space: tenant module domains ∪ platform feature keys. */
const FRONTEND_PERMISSION_KEYS: ReadonlySet<string> = new Set<string>([
  ...PERMISSION_DOMAINS.map((d) => d.id),
  ...PLATFORM_FEATURE_GROUPS.map((g) => g.key),
]);

/** SubPermission key-space: tenant sub-permission ids ∪ platform sub-permission ids ∪ aliases. */
const FRONTEND_SUBPERMISSION_KEYS: ReadonlySet<string> = new Set<string>([
  ...SUB_PERMISSIONS.map((s) => s.id),
  ...PLATFORM_FEATURE_GROUPS.flatMap((g) => g.subPermissions.map((sp) => sp.id)),
  ...Object.keys(PLATFORM_SUB_PERMISSION_ALIASES),
]);

/** Entitlement key-space: union of every plan's feature keys, alias-normalized. */
const FRONTEND_ENTITLEMENT_KEYS: ReadonlySet<string> = new Set<string>(
  Object.values(planFeatures)
    .reduce<string[]>((acc, list) => acc.concat(list), [])
    .map(normalizeEntitlementKey),
);

// -----------------------------------------------------------------------------
// Pure helpers. NO-THROW by construction: only object KEYS are read, never values; non-object
// inputs yield an empty key list rather than throwing.
// -----------------------------------------------------------------------------

/** Safe key read: returns own enumerable string keys, or [] for null/undefined/non-object. */
function safeKeys(map: Readonly<Record<string, unknown>> | null | undefined): string[] {
  if (!map || typeof map !== 'object') return [];
  return Object.keys(map);
}

/**
 * Structurally compare one key-space. `serverKeys` are the (already alias-normalized, deduped)
 * keys observed on the synthetic DTO map. Reports BOTH directions as safe key names:
 *   - missingFromServerKeys  : frontend vocabulary keys the synthetic DTO omitted.
 *   - unknownToFrontendKeys  : synthetic DTO keys the frontend vocabulary does not recognize
 *                              (ALWAYS a mismatch; NEVER fails open).
 * Parity holds only when BOTH directions are empty.
 */
function compareKeySpace(
  frontendKeys: ReadonlySet<string>,
  serverKeys: ReadonlyArray<string>,
): KeySpaceComparison {
  const serverSet = new Set<string>(serverKeys);
  const missingFromServerKeys: string[] = [];
  for (const k of frontendKeys) {
    if (!serverSet.has(k)) missingFromServerKeys.push(k);
  }
  const unknownToFrontendKeys: string[] = [];
  let matchedKeyCount = 0;
  for (const k of serverSet) {
    if (frontendKeys.has(k)) matchedKeyCount += 1;
    else unknownToFrontendKeys.push(k);
  }
  missingFromServerKeys.sort();
  unknownToFrontendKeys.sort();
  return {
    parity: missingFromServerKeys.length === 0 && unknownToFrontendKeys.length === 0,
    frontendKeyCount: frontendKeys.size,
    serverKeyCount: serverSet.size,
    matchedKeyCount,
    missingFromServerKeys,
    unknownToFrontendKeys,
  };
}

/** An empty key-space comparison for a given frontend vocabulary (no server keys present). */
function emptyKeySpace(frontendKeys: ReadonlySet<string>): KeySpaceComparison {
  return compareKeySpace(frontendKeys, []);
}

// -----------------------------------------------------------------------------
// Phase-derived, NON-SECRET messages (never echo server values).
// -----------------------------------------------------------------------------

const PHASE_MESSAGE: Record<ServerAuthzShadowComparisonPhase, string> = {
  disabled:
    'Server-authz shadow comparison is dormant: DEV + VITE_ENABLE_SERVER_AUTHZ_SHADOW are required (default OFF). No comparison performed.',
  server_authz_unavailable:
    'Server-authz shadow comparison: authorization is null (server authorization unavailable / not evaluated). The legacy client engine remains authoritative — not deny, not fail-open.',
  compared:
    'Server-authz shadow comparison: structural key-space comparison complete (comparable only — not authoritative, not enforceable).',
};

/** Build a NON-SECRET, no-comparison result for a short-circuit phase. */
function inertResult(phase: ServerAuthzShadowComparisonPhase): ServerAuthzShadowComparisonResult {
  const permissionKeySpace = emptyKeySpace(FRONTEND_PERMISSION_KEYS);
  const subPermissionKeySpace = emptyKeySpace(FRONTEND_SUBPERMISSION_KEYS);
  const entitlementKeySpace = emptyKeySpace(FRONTEND_ENTITLEMENT_KEYS);
  return {
    phase,
    serverAuthzPresent: false,
    // A short-circuit (disabled / unavailable) is NOT structural parity: nothing was compared.
    overallParity: false,
    permissionKeyParity: false,
    subPermissionKeyParity: false,
    entitlementKeyParity: false,
    permissionKeySpace,
    subPermissionKeySpace,
    entitlementKeySpace,
    counts: {
      frontendPermissionKeys: permissionKeySpace.frontendKeyCount,
      frontendSubPermissionKeys: subPermissionKeySpace.frontendKeyCount,
      frontendEntitlementKeys: entitlementKeySpace.frontendKeyCount,
      serverPermissionKeys: 0,
      serverSubPermissionKeys: 0,
      serverEntitlementKeys: 0,
    },
    message: PHASE_MESSAGE[phase],
  };
}

// -----------------------------------------------------------------------------
// Exported pure helper. Reads NOTHING live; performs a synchronous, no-throw STRUCTURAL
// comparison of a SYNTHETIC DTO against the frontend permission vocabulary. In M13 NOTHING
// calls this — the helper stays dormant.
// -----------------------------------------------------------------------------

/**
 * Structurally compare a SYNTHETIC / caller-provided server-derived authorization DTO against
 * the frontend permission vocabulary. PURE, SYNCHRONOUS, NO-THROW:
 *   - not DEV / flag off          ⇒ phase 'disabled' (no comparison; default OFF).
 *   - input === null              ⇒ phase 'server_authz_unavailable' (legacy engine authoritative).
 *   - non-null synthetic DTO      ⇒ phase 'compared' (key-space parity computed).
 *
 * Compares ONLY permission / subPermission / entitlement KEY-SPACES (key names + counts). NEVER
 * reads values/levels/booleans, NEVER compares allow/deny, role/tenant/store/plan/identity, and
 * NEVER invokes any AccessContext permission function. Unknown server keys are ALWAYS reported
 * as a mismatch and NEVER fail open. The result is NON-SECRET (no token / identity / raw DTO).
 *
 * NOTE (binding): M13 adds NO call site. Any invocation is a future, separately-approved step.
 */
export function compareServerAuthzShadow(
  input: ServerDerivedAuthorizationLike | null,
): ServerAuthzShadowComparisonResult {
  if (!isServerAuthzShadowEnabled()) {
    return inertResult('disabled');
  }
  if (input === null || input === undefined) {
    return inertResult('server_authz_unavailable');
  }

  // Read ONLY keys (never values). Entitlement keys are alias-normalized before comparison.
  const serverPermissionKeys = safeKeys(input.permissions);
  const serverSubPermissionKeys = safeKeys(input.subPermissions);
  const serverEntitlementKeys = safeKeys(input.entitlements).map(normalizeEntitlementKey);

  const permissionKeySpace = compareKeySpace(FRONTEND_PERMISSION_KEYS, serverPermissionKeys);
  const subPermissionKeySpace = compareKeySpace(FRONTEND_SUBPERMISSION_KEYS, serverSubPermissionKeys);
  const entitlementKeySpace = compareKeySpace(FRONTEND_ENTITLEMENT_KEYS, serverEntitlementKeys);

  const overallParity =
    permissionKeySpace.parity && subPermissionKeySpace.parity && entitlementKeySpace.parity;

  return {
    phase: 'compared',
    serverAuthzPresent: true,
    overallParity,
    permissionKeyParity: permissionKeySpace.parity,
    subPermissionKeyParity: subPermissionKeySpace.parity,
    entitlementKeyParity: entitlementKeySpace.parity,
    permissionKeySpace,
    subPermissionKeySpace,
    entitlementKeySpace,
    counts: {
      frontendPermissionKeys: permissionKeySpace.frontendKeyCount,
      frontendSubPermissionKeys: subPermissionKeySpace.frontendKeyCount,
      frontendEntitlementKeys: entitlementKeySpace.frontendKeyCount,
      serverPermissionKeys: permissionKeySpace.serverKeyCount,
      serverSubPermissionKeys: subPermissionKeySpace.serverKeyCount,
      serverEntitlementKeys: entitlementKeySpace.serverKeyCount,
    },
    message: PHASE_MESSAGE.compared,
  };
}

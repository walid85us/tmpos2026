// Phase 2.0 M14 — Safe server-owned C-04 Backend CP route inventory / route exposure provider.
//
// WHAT THIS IS: a PURE, server-owned, code/config-only source of the FOUR accepted Backend CP DEV route
// posture entries for the C-04 lens. It is NOT a runtime route scanner and does NOT introspect Express —
// it is a hand-curated, allow-listed constant, mirroring the proven C-02/C-03 provider pattern.
//
// BINDING SAFETY:
//   - PURE + DETERMINISTIC + NO-THROW + side-effect-free. No I/O. No DB/Supabase/getDb/live/network/
//     fetch/filesystem. No process.env. No request. No auth. No tenant/store/customer/identity/audit.
//     No mutation. No backend action.
//   - No runtime route scan, no router introspection, no Express app inspection, no broad app route list.
//   - No import from src/ (the client bundle); no mockData import; no sensitive row-shaped type import.
//     The ONLY imports are the hard ALLOW-LIST + TYPE-ONLY enum unions from the C-04 read model.
//   - Emits ONLY the 4 accepted Backend CP DEV routes with safe bounded labels/enums. NEVER a
//     customer-facing / production / broad app route, raw id, secret, token, DB url, email, domain,
//     filename, permission/RBAC key, or tenant/store/customer/identity/audit value.
//   - Deeply frozen constant + defensive-copy getter. An ENFORCED allow-list fitness function
//     (assertBcpC04RouteExposureAllowList) mechanically proves only accepted routes are present.

import {
  ALLOWED_BACKEND_ROUTES,
  ALLOWED_PROXY_ROUTES,
  ALLOWED_ROUTE_KEYS,
  type C04MethodPosture,
  type C04ExposurePosture,
  type C04ProductionPosture,
  type C04ReadOnlyPosture,
  type C04MutationPosture,
  type C04DataSourcePosture,
  type C04RegistrationPosture,
  type C04AuthorityPosture,
  type C04EvidenceStatus,
} from './bcpC04RouteExposureReadModel';

/** Safe, server-owned route-exposure entry — accepted bounded fields only. */
export interface BcpC04RouteExposureEntry {
  routeKey: string;
  routeLabel: string;
  backendRoutePath: string;
  frontendProxyPath: string;
  featureFlag: string;
  methodPosture: C04MethodPosture;
  exposurePosture: C04ExposurePosture;
  productionPosture: C04ProductionPosture;
  readOnlyPosture: C04ReadOnlyPosture;
  mutationPosture: C04MutationPosture;
  dataSourcePosture: C04DataSourcePosture;
  registrationPosture: C04RegistrationPosture;
  authorityPosture: C04AuthorityPosture;
  evidenceStatus: C04EvidenceStatus;
}

// Shared posture constants — every accepted Backend CP DEV route is GET/HEAD/OPTIONS-only, DEV-only,
// production-disabled, read-only, no-mutation, code/config-only, isolated, and server-sourced authority.
const M: C04MethodPosture = 'get_head_options_only';
const X: C04ExposurePosture = 'backend_cp_dev_only';
const PROD: C04ProductionPosture = 'production_disabled';
const RO: C04ReadOnlyPosture = 'read_only';
const NOMUT: C04MutationPosture = 'no_mutation';
const DS: C04DataSourcePosture = 'code_config_only';
const REG: C04RegistrationPosture = 'isolated_identity_api_only';
const AUTH: C04AuthorityPosture = 'server_sourced_only';
const EV: C04EvidenceStatus = 'transport_verified';

// Server-authored, code/config route-exposure registry — ONLY the four accepted Backend CP DEV routes.
const ENTRIES: readonly BcpC04RouteExposureEntry[] = [
  { routeKey: 'c01_readiness_summary', routeLabel: 'C-01 Readiness Summary', backendRoutePath: '/dev/bcp/readiness-summary', frontendProxyPath: '/__identity/dev/bcp/readiness-summary', featureFlag: 'ENABLE_BCP_DEV_READONLY_PILOT', methodPosture: M, exposurePosture: X, productionPosture: PROD, readOnlyPosture: RO, mutationPosture: NOMUT, dataSourcePosture: DS, registrationPosture: REG, authorityPosture: AUTH, evidenceStatus: EV },
  { routeKey: 'c02_registry_readiness', routeLabel: 'C-02 Registry Readiness', backendRoutePath: '/dev/bcp/registry-readiness', frontendProxyPath: '/__identity/dev/bcp/registry-readiness', featureFlag: 'ENABLE_BCP_DEV_C02_REGISTRY_READINESS', methodPosture: M, exposurePosture: X, productionPosture: PROD, readOnlyPosture: RO, mutationPosture: NOMUT, dataSourcePosture: DS, registrationPosture: REG, authorityPosture: AUTH, evidenceStatus: EV },
  { routeKey: 'c03_ui_coverage_readiness', routeLabel: 'C-03 UI Coverage Readiness', backendRoutePath: '/dev/bcp/ui-coverage-readiness', frontendProxyPath: '/__identity/dev/bcp/ui-coverage-readiness', featureFlag: 'ENABLE_BCP_DEV_C03_UI_COVERAGE_READINESS', methodPosture: M, exposurePosture: X, productionPosture: PROD, readOnlyPosture: RO, mutationPosture: NOMUT, dataSourcePosture: DS, registrationPosture: REG, authorityPosture: AUTH, evidenceStatus: EV },
  { routeKey: 'c04_route_exposure_readiness', routeLabel: 'C-04 Route Exposure Readiness', backendRoutePath: '/dev/bcp/route-exposure-readiness', frontendProxyPath: '/__identity/dev/bcp/route-exposure-readiness', featureFlag: 'ENABLE_BCP_DEV_C04_ROUTE_EXPOSURE_READINESS', methodPosture: M, exposurePosture: X, productionPosture: PROD, readOnlyPosture: RO, mutationPosture: NOMUT, dataSourcePosture: DS, registrationPosture: REG, authorityPosture: AUTH, evidenceStatus: EV },
];

/** The server-owned C-04 route-exposure registry, DEEPLY FROZEN. Safe bounded labels + allow-listed
 *  routes only. Read via getBcpC04RouteExposureEntries() for a copy. */
export const BCP_C04_SERVER_OWNED_ROUTE_EXPOSURE_ENTRIES: readonly Readonly<BcpC04RouteExposureEntry>[] =
  Object.freeze(ENTRIES.map((e) => Object.freeze({ ...e })));

/**
 * Return the server-owned C-04 route-exposure entries as a FRESH defensive copy. PURE, DETERMINISTIC,
 * NO-THROW. Takes NO arguments and reads NO env/request/global/live state. Mutating the result never
 * affects the constant or a later call.
 */
export function getBcpC04RouteExposureEntries(): BcpC04RouteExposureEntry[] {
  return BCP_C04_SERVER_OWNED_ROUTE_EXPOSURE_ENTRIES.map((e) => ({ ...e }));
}

/**
 * ENFORCED ALLOW-LIST FITNESS FUNCTION. Mechanically proves the C-04 route inventory exposes ONLY the
 * four accepted Backend CP DEV routes. THROWS with a descriptive message on ANY violation (extra route,
 * missing route, non-allow-listed backend/proxy path, non-allow-listed key, wrong count). Intended for
 * tests / defensive validation; it is NOT on the no-throw data path (getBcpC04RouteExposureEntries).
 * Accepts an optional entries array so tests can prove a tampered set is rejected.
 */
export function assertBcpC04RouteExposureAllowList(
  entries: readonly BcpC04RouteExposureEntry[] = getBcpC04RouteExposureEntries(),
): void {
  // Guard non-array input FIRST so a null/non-iterable arg yields the descriptive error, never a raw TypeError.
  if (!Array.isArray(entries)) {
    throw new Error('C-04 route allow-list violation(s): entries is not an array');
  }
  const violations: string[] = [];
  // Canonical index-aligned tuples: each accepted key MUST pair with its matching backend + proxy path.
  // This catches a mislabeled-but-individually-allow-listed row (e.g. c01 key with the c02 backend path),
  // not just "is this string in the union".
  const tupleByKey = new Map<string, { backend: string; proxy: string }>();
  for (let i = 0; i < ALLOWED_ROUTE_KEYS.length; i++) {
    tupleByKey.set(ALLOWED_ROUTE_KEYS[i], { backend: ALLOWED_BACKEND_ROUTES[i], proxy: ALLOWED_PROXY_ROUTES[i] });
  }

  if (entries.length !== ALLOWED_ROUTE_KEYS.length) {
    violations.push(`expected exactly ${ALLOWED_ROUTE_KEYS.length} entries, got ${entries.length}`);
  }
  const seenKeys = new Set<string>();
  for (const e of entries) {
    if (!e || typeof e !== 'object') { violations.push('non-object entry'); continue; }
    const tuple = tupleByKey.get(e.routeKey);
    if (!tuple) {
      violations.push(`route key not allow-listed: ${String(e.routeKey)}`);
    } else {
      if (e.backendRoutePath !== tuple.backend) violations.push(`backend route mismatch for ${e.routeKey}: ${String(e.backendRoutePath)}`);
      if (e.frontendProxyPath !== tuple.proxy) violations.push(`proxy route mismatch for ${e.routeKey}: ${String(e.frontendProxyPath)}`);
    }
    if (seenKeys.has(e.routeKey)) violations.push(`duplicate route key: ${String(e.routeKey)}`);
    seenKeys.add(e.routeKey);
  }
  for (const k of ALLOWED_ROUTE_KEYS) if (!seenKeys.has(k)) violations.push(`missing accepted route key: ${k}`);

  if (violations.length > 0) {
    throw new Error(`C-04 route allow-list violation(s): ${violations.join('; ')}`);
  }
}

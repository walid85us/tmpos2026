// Phase 2.0 M14 — C-04 Backend CP Route Inventory / Route Exposure Posture Lens: PURE read model + DTO.
//
// WHAT THIS IS: a PURE, SYNCHRONOUS, NO-THROW, DETERMINISTIC builder that maps server-owned, code/config
// route-exposure entries (the FOUR accepted Backend CP DEV routes only) into a safe, bounded C-04
// envelope. It mirrors the hardened C-02/C-03 read models and adds a HARD ALLOW-LIST for route paths.
//
// BINDING SAFETY:
//   - No DB/Supabase/provider/fetch/network/filesystem/I/O. No Express/router/request/auth dependency.
//   - No runtime route scanning and no router introspection — this only sanitizes a server-supplied list.
//   - Route-path fields are validated against a HARD ALLOW-LIST (not the generic label charset, which has
//     no '/'); any non-allow-listed path is redacted to `redacted_route` and never emitted as valid.
//   - All other values become a safe bounded label/enum or a safe fallback. NEVER tenant/store/customer
//     rows, identity/audit rows, permission/RBAC keys, secrets, tokens, DB URLs, emails, domains, raw
//     file paths/filenames, raw identifiers, or any customer-facing / production / broad app route.

export const C04_ROUTE_EXPOSURE_SCHEMA_VERSION_V1 = 'bcp.c04.route-exposure-readiness.v1-code-config';
export type C04SourceMode = 'code_config';
const FRESHNESS_LABEL = 'code-config-no-live-read';
const WARNING_LABEL = 'code_config';
const C04_GENERATED_AT = '2026-01-01T00:00:00.000Z';

// ---------------------------------------------------------------------------
// HARD ALLOW-LISTS — the ONLY accepted Backend CP DEV routes/keys. Single source of truth, reused by the
// provider, its allow-list fitness function, and the read model's route-path validator.
// ---------------------------------------------------------------------------
export const ALLOWED_BACKEND_ROUTES: readonly string[] = [
  '/dev/bcp/readiness-summary',
  '/dev/bcp/registry-readiness',
  '/dev/bcp/ui-coverage-readiness',
  '/dev/bcp/route-exposure-readiness',
];
export const ALLOWED_PROXY_ROUTES: readonly string[] = [
  '/__identity/dev/bcp/readiness-summary',
  '/__identity/dev/bcp/registry-readiness',
  '/__identity/dev/bcp/ui-coverage-readiness',
  '/__identity/dev/bcp/route-exposure-readiness',
];
export const ALLOWED_ROUTE_KEYS: readonly string[] = [
  'c01_readiness_summary',
  'c02_registry_readiness',
  'c03_ui_coverage_readiness',
  'c04_route_exposure_readiness',
];
const BACKEND_SET = new Set<string>(ALLOWED_BACKEND_ROUTES);
const PROXY_SET = new Set<string>(ALLOWED_PROXY_ROUTES);

// ---------------------------------------------------------------------------
// Safe bounded enum vocabularies.
// ---------------------------------------------------------------------------
export type C04MethodPosture = 'get_head_options_only' | 'mutations_405';
export type C04ExposurePosture = 'backend_cp_dev_only' | 'backend_cp_internal_only' | 'no_saas_nav_exposure' | 'no_external_facing_exposure';
export type C04ProductionPosture = 'production_disabled';
export type C04ReadOnlyPosture = 'read_only';
export type C04MutationPosture = 'no_mutation';
export type C04DataSourcePosture = 'code_config_only' | 'no_live_source' | 'no_db' | 'no_supabase';
export type C04RegistrationPosture = 'isolated_identity_api_only' | 'single_registration';
export type C04AuthorityPosture = 'server_sourced_only' | 'request_not_authority';
export type C04EvidenceStatus = 'tested' | 'transport_verified' | 'static_reviewed' | 'ui_static_reviewed' | 'browser_not_run' | 'unknown';

const METHOD_POSTURE = new Set<string>(['get_head_options_only', 'mutations_405']);
const EXPOSURE_POSTURE = new Set<string>(['backend_cp_dev_only', 'backend_cp_internal_only', 'no_saas_nav_exposure', 'no_external_facing_exposure']);
const PRODUCTION_POSTURE = new Set<string>(['production_disabled']);
const READ_ONLY_POSTURE = new Set<string>(['read_only']);
const MUTATION_POSTURE = new Set<string>(['no_mutation']);
const DATA_SOURCE_POSTURE = new Set<string>(['code_config_only', 'no_live_source', 'no_db', 'no_supabase']);
const REGISTRATION_POSTURE = new Set<string>(['isolated_identity_api_only', 'single_registration']);
const AUTHORITY_POSTURE = new Set<string>(['server_sourced_only', 'request_not_authority']);
const EVIDENCE_STATUS = new Set<string>(['tested', 'transport_verified', 'static_reviewed', 'ui_static_reviewed', 'browser_not_run', 'unknown']);

// ---------------------------------------------------------------------------
// Untrusted input + safe output shapes.
// ---------------------------------------------------------------------------
export interface C04RouteExposureEntryInput {
  routeKey?: unknown;
  routeLabel?: unknown;
  backendRoutePath?: unknown;
  frontendProxyPath?: unknown;
  featureFlag?: unknown;
  methodPosture?: unknown;
  exposurePosture?: unknown;
  productionPosture?: unknown;
  readOnlyPosture?: unknown;
  mutationPosture?: unknown;
  dataSourcePosture?: unknown;
  registrationPosture?: unknown;
  authorityPosture?: unknown;
  evidenceStatus?: unknown;
}

export interface C04RouteItem {
  routeKey: string;
  routeLabel: string;
  backendRoutePath: string;
  frontendProxyPath: string;
  featureFlag: string;
  methodPosture: C04MethodPosture | 'unknown';
  exposurePosture: C04ExposurePosture | 'unknown';
  productionPosture: C04ProductionPosture | 'unknown';
  readOnlyPosture: C04ReadOnlyPosture | 'unknown';
  mutationPosture: C04MutationPosture | 'unknown';
  dataSourcePosture: C04DataSourcePosture | 'unknown';
  registrationPosture: C04RegistrationPosture | 'unknown';
  authorityPosture: C04AuthorityPosture | 'unknown';
  evidenceStatus: C04EvidenceStatus;
}

export interface C04SummaryCounts {
  total: number;
  devOnly: number;
  productionDisabled: number;
  readOnly: number;
  mutationBlocked: number;
  internalOnly: number;
  unknown: number;
}

export interface C04EmptyState {
  isEmpty: boolean;
  reason: string;
}

export interface C04RouteExposureEnvelope {
  schemaVersion: string;
  sourceMode: C04SourceMode;
  generatedAt: string;
  freshness: { lastSuccessfulReadLabel: string };
  summaryCounts: C04SummaryCounts;
  routeItems: C04RouteItem[];
  emptyState: C04EmptyState;
  warnings: string[];
  redactionPosture: string;
  routePosture: string;
  productionPosture: string;
  mutationPosture: string;
  evidenceLabels: string[];
}

// ---------------------------------------------------------------------------
// Safe-label + safe-route-path + enum strategy (self-contained; same hardening as C-02/C-03).
// ---------------------------------------------------------------------------
const SAFE_LABEL_RE = /^[A-Za-z0-9_.\- ]{1,64}$/;
const REDACTED_LABEL = 'redacted_label';
const REDACTED_ROUTE = 'redacted_route';
const FORBIDDEN_SUBSTRINGS = [
  '://', '@', 'bearer', 'eyj', 'service_role', 'secret', 'token', 'password',
  'postgres', 'supabase', 'apikey', 'api_key',
  'sk_', 'sk-', 'pk_', 'pk-', 'rk_', 'ak_', 'cus_', 'acct_', 'usr_', 'txn_', 'tok_', 'card_',
  'tenant_', 'store_', 'customer_', 'identity_link', 'identitylink', 'provider_uid', 'internal_user',
  'audit_', 'permission_', 'entitlement_', 'mismatch_',
];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LONG_ALNUM_RUN_RE = /[A-Za-z0-9]{16,}/;
const DIGIT_RUN_RE = /\d{4,}/;
const DOMAINISH_RE = /\.[a-z0-9-]+\.[a-z]{2,}/i;
const FILE_EXT_RE = /\.(ts|tsx|js|jsx|mjs|cjs|json|env|key|pem|sql|sh|ya?ml|toml|lock)$/i;

/** Returns a safe bounded label, or the `redacted_label` sentinel when the value is unsafe to emit. */
function safeLabel(value: unknown): string {
  if (typeof value !== 'string') return REDACTED_LABEL;
  if (value.trim() === '') return REDACTED_LABEL;
  if (!SAFE_LABEL_RE.test(value)) return REDACTED_LABEL;
  const lower = value.toLowerCase();
  for (const bad of FORBIDDEN_SUBSTRINGS) if (lower.includes(bad)) return REDACTED_LABEL;
  if (UUID_RE.test(value) || LONG_ALNUM_RUN_RE.test(value) || DIGIT_RUN_RE.test(value) ||
      DOMAINISH_RE.test(value) || FILE_EXT_RE.test(value)) {
    return REDACTED_LABEL;
  }
  return value;
}

/** Returns the route path ONLY if it is in the hard allow-list; otherwise `redacted_route`. The allow-
 *  list is the security control: a non-accepted / customer-facing / production / broad app route can
 *  never be emitted as a valid path. */
function safeRoutePath(value: unknown, allowed: Set<string>): string {
  return typeof value === 'string' && allowed.has(value) ? value : REDACTED_ROUTE;
}

/** Normalize an untrusted value to a member of `allowed` or the `fallback` (never the raw value). */
function normalizeEnum<T extends string>(value: unknown, allowed: Set<string>, fallback: T): T {
  return typeof value === 'string' && allowed.has(value) ? (value as T) : fallback;
}

/** Read one untrusted field defensively — a throwing getter/proxy yields `undefined`, never a throw. */
function readField(obj: object, key: keyof C04RouteExposureEntryInput): unknown {
  try {
    return (obj as Record<string, unknown>)[key as string];
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Builder — PURE + NO-THROW + DETERMINISTIC.
// ---------------------------------------------------------------------------

/**
 * Build the C-04 route-exposure DTO envelope from server-owned code/config route entries. PURE,
 * SYNCHRONOUS, NO-THROW, DETERMINISTIC. Route paths are allow-list-validated; every other field is
 * sanitized; non-array input and non-object entries are handled safely (no throw, no invented entries).
 */
export function buildC04RouteExposureEnvelope(
  entries: readonly C04RouteExposureEntryInput[],
): C04RouteExposureEnvelope {
  const list: readonly unknown[] = Array.isArray(entries) ? entries : [];

  const routeItems: C04RouteItem[] = [];
  for (let idx = 0; idx < list.length; idx++) {
    let item: C04RouteItem | null = null;
    try {
      const entry = list[idx];
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      item = {
        routeKey: safeLabel(readField(entry, 'routeKey')),
        routeLabel: safeLabel(readField(entry, 'routeLabel')),
        backendRoutePath: safeRoutePath(readField(entry, 'backendRoutePath'), BACKEND_SET),
        frontendProxyPath: safeRoutePath(readField(entry, 'frontendProxyPath'), PROXY_SET),
        featureFlag: safeLabel(readField(entry, 'featureFlag')),
        methodPosture: normalizeEnum(readField(entry, 'methodPosture'), METHOD_POSTURE, 'unknown'),
        exposurePosture: normalizeEnum(readField(entry, 'exposurePosture'), EXPOSURE_POSTURE, 'unknown'),
        productionPosture: normalizeEnum(readField(entry, 'productionPosture'), PRODUCTION_POSTURE, 'unknown'),
        readOnlyPosture: normalizeEnum(readField(entry, 'readOnlyPosture'), READ_ONLY_POSTURE, 'unknown'),
        mutationPosture: normalizeEnum(readField(entry, 'mutationPosture'), MUTATION_POSTURE, 'unknown'),
        dataSourcePosture: normalizeEnum(readField(entry, 'dataSourcePosture'), DATA_SOURCE_POSTURE, 'unknown'),
        registrationPosture: normalizeEnum(readField(entry, 'registrationPosture'), REGISTRATION_POSTURE, 'unknown'),
        authorityPosture: normalizeEnum(readField(entry, 'authorityPosture'), AUTHORITY_POSTURE, 'unknown'),
        evidenceStatus: normalizeEnum(readField(entry, 'evidenceStatus'), EVIDENCE_STATUS, 'unknown'),
      };
    } catch {
      item = null;
    }
    if (item) routeItems.push(item);
  }

  const INTERNAL = new Set<string>(['backend_cp_dev_only', 'backend_cp_internal_only', 'no_saas_nav_exposure', 'no_external_facing_exposure']);
  const summaryCounts: C04SummaryCounts = {
    total: routeItems.length,
    devOnly: routeItems.filter((i) => i.exposurePosture === 'backend_cp_dev_only').length,
    productionDisabled: routeItems.filter((i) => i.productionPosture === 'production_disabled').length,
    readOnly: routeItems.filter((i) => i.readOnlyPosture === 'read_only').length,
    mutationBlocked: routeItems.filter((i) => i.mutationPosture === 'no_mutation').length,
    internalOnly: routeItems.filter((i) => INTERNAL.has(i.exposurePosture)).length,
    unknown: routeItems.filter((i) => i.exposurePosture === 'unknown').length,
  };

  const isEmpty = routeItems.length === 0;

  return {
    schemaVersion: C04_ROUTE_EXPOSURE_SCHEMA_VERSION_V1,
    sourceMode: 'code_config',
    generatedAt: C04_GENERATED_AT,
    freshness: { lastSuccessfulReadLabel: FRESHNESS_LABEL },
    summaryCounts,
    routeItems,
    emptyState: isEmpty
      ? { isEmpty: true, reason: 'no_route_exposure_entries' }
      : { isEmpty: false, reason: 'none' },
    warnings: [WARNING_LABEL],
    redactionPosture: 'safe_labels_only',
    routePosture: 'dev_isolated_api',
    productionPosture: 'production_disabled',
    mutationPosture: 'none',
    evidenceLabels: [
      'code_config_only',
      'no_live_source',
      'no_runtime_route_scan',
      'allow_listed_routes_only',
      'read_only',
      'no_mutation',
      'production_disabled',
      'dev_only',
      'backend_cp_internal_only',
      'no_external_facing_exposure',
      'no_saas_nav_exposure',
    ],
  };
}

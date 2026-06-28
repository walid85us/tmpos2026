// Phase 2.0 M17 — C-05 Backend CP Feature Flag / Environment Posture Lens: PURE read model + DTO.
//
// WHAT THIS IS: a PURE, SYNCHRONOUS, NO-THROW, DETERMINISTIC builder that maps server-owned, code/config
// feature-flag POSTURE entries (the SIX accepted Backend CP feature flag NAMES only) into a safe, bounded
// C-05 envelope. It mirrors the hardened C-02/C-03/C-04 read models and adds a HARD ALLOW-LIST for flag
// NAMES + flag KEYS — and emits ONLY bounded posture labels, never an environment VALUE or value-oracle.
//
// BINDING SAFETY:
//   - No DB/Supabase/provider/fetch/network/filesystem/I/O. No Express/router/request/auth dependency.
//   - NEVER reads process.env for output, never enumerates env, never parses dotenv, never reports
//     whether a flag is set/unset/enabled/disabled/present/missing/length/hash/count (no value oracle).
//   - flagName/flagKey are validated against a HARD ALLOW-LIST; any non-allow-listed value is redacted to
//     `redacted_flag` and never emitted as valid. All other fields become a safe bounded enum/label.
//   - NEVER tenant/store/customer rows, identity/audit rows, permission/RBAC keys, secrets, tokens, DB
//     URLs, emails, domains, raw env values, raw file paths/filenames, or raw identifiers.

export const C05_FEATURE_FLAG_POSTURE_SCHEMA_VERSION_V1 = 'bcp.c05.feature-flag-posture-readiness.v1-code-config';
export type C05SourceMode = 'code_config';
const FRESHNESS_LABEL = 'code-config-no-live-read';
const WARNING_LABEL = 'code_config';
// Synthetic constant — never the real server clock, so generatedAt can never become a runtime oracle.
const C05_GENERATED_AT = '2026-01-01T00:00:00.000Z';

// ---------------------------------------------------------------------------
// HARD ALLOW-LISTS — the ONLY accepted Backend CP feature flag NAMES/KEYS. Single source of truth, reused
// by the provider, its allow-list fitness function, and the read model's flag-name/key validators.
// ---------------------------------------------------------------------------
export const ALLOWED_FLAG_NAMES: readonly string[] = [
  'ENABLE_BCP_DEV_READONLY_PILOT',
  'ENABLE_BCP_DEV_C02_REGISTRY_READINESS',
  'ENABLE_BCP_DEV_C03_UI_COVERAGE_READINESS',
  'ENABLE_BCP_DEV_C04_ROUTE_EXPOSURE_READINESS',
  'VITE_ENABLE_BACKEND_CONTROL_PLANE',
  'ENABLE_BCP_DEV_C05_FEATURE_FLAG_POSTURE_READINESS',
];
export const ALLOWED_FLAG_KEYS: readonly string[] = [
  'c01_readiness_summary_backend_gate',
  'c02_registry_readiness_backend_gate',
  'c03_ui_coverage_backend_gate',
  'c04_route_exposure_backend_gate',
  'backend_cp_dev_shell_frontend_gate',
  'c05_feature_flag_posture_backend_gate',
];
const FLAG_NAME_SET = new Set<string>(ALLOWED_FLAG_NAMES);
const FLAG_KEY_SET = new Set<string>(ALLOWED_FLAG_KEYS);
const REDACTED_FLAG = 'redacted_flag';

// ---------------------------------------------------------------------------
// Safe bounded enum vocabularies.
// ---------------------------------------------------------------------------
export type C05FlagPurpose =
  | 'readiness_summary_lens_gate'
  | 'registry_readiness_lens_gate'
  | 'ui_coverage_lens_gate'
  | 'route_exposure_lens_gate'
  | 'backend_cp_dev_shell_gate'
  | 'feature_flag_posture_lens_gate';
export type C05OwnerSurface =
  | 'c01_readiness_summary'
  | 'c02_registry_readiness'
  | 'c03_ui_coverage'
  | 'c04_route_exposure'
  | 'backend_cp_dev_shell'
  | 'c05_feature_flag_posture';
export type C05DefaultPosture = 'expected_default_off';
export type C05DevGatePosture = 'dev_only';
export type C05ProductionPosture = 'production_disabled';
export type C05ExposurePosture = 'backend_cp_internal_only' | 'no_saas_nav_exposure' | 'no_external_facing_exposure';
export type C05DataSourcePosture = 'code_config_only' | 'no_live_source' | 'no_env_value_read' | 'no_env_inventory';
export type C05ValueExposurePosture = 'no_raw_env_value' | 'no_secret_value_exposed' | 'no_value_oracle';
export type C05MutationPosture = 'no_mutation';
export type C05EvidenceStatus = 'static_reviewed' | 'tested' | 'transport_verified' | 'browser_waived_phase_2_only' | 'unknown';

const FLAG_PURPOSE = new Set<string>(['readiness_summary_lens_gate', 'registry_readiness_lens_gate', 'ui_coverage_lens_gate', 'route_exposure_lens_gate', 'backend_cp_dev_shell_gate', 'feature_flag_posture_lens_gate']);
const OWNER_SURFACE = new Set<string>(['c01_readiness_summary', 'c02_registry_readiness', 'c03_ui_coverage', 'c04_route_exposure', 'backend_cp_dev_shell', 'c05_feature_flag_posture']);
const DEFAULT_POSTURE = new Set<string>(['expected_default_off']);
const DEV_GATE_POSTURE = new Set<string>(['dev_only']);
const PRODUCTION_POSTURE = new Set<string>(['production_disabled']);
const EXPOSURE_POSTURE = new Set<string>(['backend_cp_internal_only', 'no_saas_nav_exposure', 'no_external_facing_exposure']);
const DATA_SOURCE_POSTURE = new Set<string>(['code_config_only', 'no_live_source', 'no_env_value_read', 'no_env_inventory']);
const VALUE_EXPOSURE_POSTURE = new Set<string>(['no_raw_env_value', 'no_secret_value_exposed', 'no_value_oracle']);
const MUTATION_POSTURE = new Set<string>(['no_mutation']);
const EVIDENCE_STATUS = new Set<string>(['static_reviewed', 'tested', 'transport_verified', 'browser_waived_phase_2_only', 'unknown']);

// Counts derive ONLY from these static label sets — invariant to runtime process.env (no value oracle).
const NO_VALUE_SET = new Set<string>(['no_raw_env_value', 'no_secret_value_exposed', 'no_value_oracle']);
const INTERNAL_SET = new Set<string>(['backend_cp_internal_only', 'no_saas_nav_exposure', 'no_external_facing_exposure']);

// ---------------------------------------------------------------------------
// Untrusted input + safe output shapes.
// ---------------------------------------------------------------------------
export interface C05FeatureFlagPostureEntryInput {
  flagKey?: unknown;
  flagName?: unknown;
  flagPurpose?: unknown;
  ownerSurface?: unknown;
  defaultPosture?: unknown;
  devGatePosture?: unknown;
  productionPosture?: unknown;
  exposurePosture?: unknown;
  dataSourcePosture?: unknown;
  valueExposurePosture?: unknown;
  mutationPosture?: unknown;
  evidenceStatus?: unknown;
}

export interface C05FlagItem {
  flagKey: string;
  flagName: string;
  flagPurpose: C05FlagPurpose | 'unknown';
  ownerSurface: C05OwnerSurface | 'unknown';
  defaultPosture: C05DefaultPosture | 'unknown';
  devGatePosture: C05DevGatePosture | 'unknown';
  productionPosture: C05ProductionPosture | 'unknown';
  exposurePosture: C05ExposurePosture | 'unknown';
  dataSourcePosture: C05DataSourcePosture | 'unknown';
  valueExposurePosture: C05ValueExposurePosture | 'unknown';
  mutationPosture: C05MutationPosture | 'unknown';
  evidenceStatus: C05EvidenceStatus;
}

export interface C05SummaryCounts {
  total: number;
  devOnly: number;
  productionDisabled: number;
  defaultOff: number;
  valueHidden: number;
  noValueOracle: number;
  internalOnly: number;
  unknown: number;
}

export interface C05EmptyState {
  isEmpty: boolean;
  reason: string;
}

export interface C05FeatureFlagPostureEnvelope {
  schemaVersion: string;
  sourceMode: C05SourceMode;
  generatedAt: string;
  freshness: { lastSuccessfulReadLabel: string };
  summaryCounts: C05SummaryCounts;
  flagItems: C05FlagItem[];
  emptyState: C05EmptyState;
  warnings: string[];
  redactionPosture: string;
  productionPosture: string;
  exposurePosture: string;
  mutationPosture: string;
  valueExposurePosture: string;
  evidenceLabels: string[];
}

// ---------------------------------------------------------------------------
// Safe-label + safe-flag + enum strategy (self-contained; same hardening as C-02/C-03/C-04).
// ---------------------------------------------------------------------------
const SAFE_LABEL_RE = /^[A-Za-z0-9_.\- ]{1,64}$/;
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

/** Returns the flag NAME ONLY if it is in the hard allow-list; otherwise `redacted_flag`. The allow-list
 *  is the security control: only the SIX accepted Backend CP feature flag names can render as valid. */
function safeFlagName(value: unknown): string {
  return typeof value === 'string' && FLAG_NAME_SET.has(value) ? value : REDACTED_FLAG;
}

/** Returns the flag KEY ONLY if it is in the hard allow-list; otherwise `redacted_flag`. */
function safeFlagKey(value: unknown): string {
  return typeof value === 'string' && FLAG_KEY_SET.has(value) ? value : REDACTED_FLAG;
}

/** Normalize an untrusted value to a member of `allowed` or the `fallback` (never the raw value). */
function normalizeEnum<T extends string>(value: unknown, allowed: Set<string>, fallback: T): T {
  return typeof value === 'string' && allowed.has(value) ? (value as T) : fallback;
}

/** Read one untrusted field defensively — a throwing getter/proxy yields `undefined`, never a throw. */
function readField(obj: object, key: keyof C05FeatureFlagPostureEntryInput): unknown {
  try {
    return (obj as Record<string, unknown>)[key as string];
  } catch {
    return undefined;
  }
}

// Defense-in-depth: a generic label sanitizer used only by the allow-list fitness function (the read
// model itself emits only allow-listed flag values + bounded enums, so no raw label reaches the DTO).
/** True only when the value is a safe bounded label (no secrets/ids/domains/filenames). */
export function isSafeC05Label(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (value.trim() === '') return false;
  if (!SAFE_LABEL_RE.test(value)) return false;
  const lower = value.toLowerCase();
  for (const bad of FORBIDDEN_SUBSTRINGS) if (lower.includes(bad)) return false;
  if (UUID_RE.test(value) || LONG_ALNUM_RUN_RE.test(value) || DIGIT_RUN_RE.test(value) ||
      DOMAINISH_RE.test(value) || FILE_EXT_RE.test(value)) {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Builder — PURE + NO-THROW + DETERMINISTIC.
// ---------------------------------------------------------------------------

/**
 * Build the C-05 feature-flag-posture DTO envelope from server-owned code/config posture entries. PURE,
 * SYNCHRONOUS, NO-THROW, DETERMINISTIC. flagName/flagKey are allow-list-validated; every other field is a
 * bounded enum; non-array input and non-object entries are handled safely (no throw, no invented entries).
 * Reads ONLY the twelve known fields — an injected value/value-oracle field is never copied into output.
 */
export function buildC05FeatureFlagPostureEnvelope(
  entries: readonly C05FeatureFlagPostureEntryInput[],
): C05FeatureFlagPostureEnvelope {
  const list: readonly unknown[] = Array.isArray(entries) ? entries : [];

  const flagItems: C05FlagItem[] = [];
  for (let idx = 0; idx < list.length; idx++) {
    let item: C05FlagItem | null = null;
    try {
      const entry = list[idx];
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      item = {
        flagKey: safeFlagKey(readField(entry, 'flagKey')),
        flagName: safeFlagName(readField(entry, 'flagName')),
        flagPurpose: normalizeEnum(readField(entry, 'flagPurpose'), FLAG_PURPOSE, 'unknown'),
        ownerSurface: normalizeEnum(readField(entry, 'ownerSurface'), OWNER_SURFACE, 'unknown'),
        defaultPosture: normalizeEnum(readField(entry, 'defaultPosture'), DEFAULT_POSTURE, 'unknown'),
        devGatePosture: normalizeEnum(readField(entry, 'devGatePosture'), DEV_GATE_POSTURE, 'unknown'),
        productionPosture: normalizeEnum(readField(entry, 'productionPosture'), PRODUCTION_POSTURE, 'unknown'),
        exposurePosture: normalizeEnum(readField(entry, 'exposurePosture'), EXPOSURE_POSTURE, 'unknown'),
        dataSourcePosture: normalizeEnum(readField(entry, 'dataSourcePosture'), DATA_SOURCE_POSTURE, 'unknown'),
        valueExposurePosture: normalizeEnum(readField(entry, 'valueExposurePosture'), VALUE_EXPOSURE_POSTURE, 'unknown'),
        mutationPosture: normalizeEnum(readField(entry, 'mutationPosture'), MUTATION_POSTURE, 'unknown'),
        evidenceStatus: normalizeEnum(readField(entry, 'evidenceStatus'), EVIDENCE_STATUS, 'unknown'),
      };
    } catch {
      item = null;
    }
    if (item) flagItems.push(item);
  }

  // Counts are STATIC posture facts derived ONLY from bounded labels — byte-identical regardless of
  // whether any flag's env var is set/unset/true/false. Never a count of set/enabled keys.
  const summaryCounts: C05SummaryCounts = {
    total: flagItems.length,
    devOnly: flagItems.filter((i) => i.devGatePosture === 'dev_only').length,
    productionDisabled: flagItems.filter((i) => i.productionPosture === 'production_disabled').length,
    defaultOff: flagItems.filter((i) => i.defaultPosture === 'expected_default_off').length,
    valueHidden: flagItems.filter((i) => NO_VALUE_SET.has(i.valueExposurePosture)).length,
    noValueOracle: flagItems.filter((i) => NO_VALUE_SET.has(i.valueExposurePosture)).length,
    internalOnly: flagItems.filter((i) => INTERNAL_SET.has(i.exposurePosture)).length,
    unknown: flagItems.filter((i) => i.exposurePosture === 'unknown').length,
  };

  const isEmpty = flagItems.length === 0;

  return {
    schemaVersion: C05_FEATURE_FLAG_POSTURE_SCHEMA_VERSION_V1,
    sourceMode: 'code_config',
    generatedAt: C05_GENERATED_AT,
    freshness: { lastSuccessfulReadLabel: FRESHNESS_LABEL },
    summaryCounts,
    flagItems,
    emptyState: isEmpty
      ? { isEmpty: true, reason: 'no_feature_flag_posture_entries' }
      : { isEmpty: false, reason: 'none' },
    warnings: [WARNING_LABEL],
    redactionPosture: 'safe_labels_only',
    productionPosture: 'production_disabled',
    exposurePosture: 'backend_cp_internal_only',
    mutationPosture: 'none',
    valueExposurePosture: 'no_raw_env_value',
    evidenceLabels: [
      'code_config_only',
      'no_live_source',
      'no_env_value_read',
      'no_env_inventory',
      'no_value_oracle',
      'no_raw_env_value',
      'no_secret_value_exposed',
      'flag_names_only',
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

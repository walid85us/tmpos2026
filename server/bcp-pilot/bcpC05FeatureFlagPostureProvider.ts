// Phase 2.0 M17 — Safe server-owned C-05 Backend CP feature-flag POSTURE provider + fitness functions.
//
// WHAT THIS IS: a PURE, server-owned, code/config-only source of the SIX accepted Backend CP feature flag
// NAMES with safe bounded POSTURE labels. It is NOT an environment reader and does NOT inspect process.env
// — it is a hand-curated, allow-listed constant, mirroring the proven C-02/C-03/C-04 provider pattern.
//
// BINDING SAFETY:
//   - PURE + DETERMINISTIC + NO-THROW + side-effect-free. No I/O. No DB/Supabase/getDb/live/network/
//     fetch/filesystem. NO process.env read for output, NO process.env enumeration, NO dotenv parsing.
//     No request. No auth. No tenant/store/customer/identity/audit. No mutation. No backend action.
//   - Emits ONLY the SIX accepted Backend CP feature flag NAMES with safe bounded labels. NEVER an env
//     VALUE, never whether a flag is set/unset/enabled/disabled/present/missing/length/hash/count (no
//     value oracle), never a secret, token, DB url, email, domain, filename, permission/RBAC key, or
//     tenant/store/customer/identity/audit value.
//   - No import from src/ (the client bundle); no mockData import; no sensitive row-shaped type import.
//   - Deeply frozen constant + defensive-copy getter. TWO ENFORCED fitness functions mechanically prove
//     (1) only accepted flag names/keys are present, and (2) no value/value-oracle field can appear.

import {
  ALLOWED_FLAG_NAMES,
  ALLOWED_FLAG_KEYS,
  type C05FlagPurpose,
  type C05OwnerSurface,
  type C05DefaultPosture,
  type C05DevGatePosture,
  type C05ProductionPosture,
  type C05ExposurePosture,
  type C05DataSourcePosture,
  type C05ValueExposurePosture,
  type C05MutationPosture,
  type C05EvidenceStatus,
} from './bcpC05FeatureFlagPostureReadModel';

/** Safe, server-owned feature-flag posture entry — accepted bounded fields only. */
export interface BcpC05FeatureFlagPostureEntry {
  flagKey: string;
  flagName: string;
  flagPurpose: C05FlagPurpose;
  ownerSurface: C05OwnerSurface;
  defaultPosture: C05DefaultPosture;
  devGatePosture: C05DevGatePosture;
  productionPosture: C05ProductionPosture;
  exposurePosture: C05ExposurePosture;
  dataSourcePosture: C05DataSourcePosture;
  valueExposurePosture: C05ValueExposurePosture;
  mutationPosture: C05MutationPosture;
  evidenceStatus: C05EvidenceStatus;
}

// Index-aligned canonical tuples (key ↔ name ↔ purpose ↔ ownerSurface). The name/key arrays are the
// single source of truth from the read model; purpose/surface are aligned to the same order here.
const CANON_PURPOSES: readonly C05FlagPurpose[] = [
  'readiness_summary_lens_gate',
  'registry_readiness_lens_gate',
  'ui_coverage_lens_gate',
  'route_exposure_lens_gate',
  'backend_cp_dev_shell_gate',
  'feature_flag_posture_lens_gate',
];
const CANON_SURFACES: readonly C05OwnerSurface[] = [
  'c01_readiness_summary',
  'c02_registry_readiness',
  'c03_ui_coverage',
  'c04_route_exposure',
  'backend_cp_dev_shell',
  'c05_feature_flag_posture',
];

// Shared posture constants — every accepted Backend CP feature flag is DEV-only, default-off, production-
// disabled, backend-CP-internal-only, code/config-only, value-hidden (no raw env value), no-mutation.
const DEF: C05DefaultPosture = 'expected_default_off';
const DEV: C05DevGatePosture = 'dev_only';
const PROD: C05ProductionPosture = 'production_disabled';
const X: C05ExposurePosture = 'backend_cp_internal_only';
const DS: C05DataSourcePosture = 'code_config_only';
const VX: C05ValueExposurePosture = 'no_raw_env_value';
const NOMUT: C05MutationPosture = 'no_mutation';
const EV: C05EvidenceStatus = 'transport_verified';

// Server-authored, code/config feature-flag posture registry — ONLY the six accepted Backend CP flags.
const ENTRIES: readonly BcpC05FeatureFlagPostureEntry[] = ALLOWED_FLAG_KEYS.map((flagKey, i) => ({
  flagKey,
  flagName: ALLOWED_FLAG_NAMES[i],
  flagPurpose: CANON_PURPOSES[i],
  ownerSurface: CANON_SURFACES[i],
  defaultPosture: DEF,
  devGatePosture: DEV,
  productionPosture: PROD,
  exposurePosture: X,
  dataSourcePosture: DS,
  valueExposurePosture: VX,
  mutationPosture: NOMUT,
  evidenceStatus: EV,
}));

/** The server-owned C-05 feature-flag posture registry, DEEPLY FROZEN. Safe bounded labels + allow-listed
 *  flag names only. Read via getBcpC05FeatureFlagPostureEntries() for a copy. */
export const BCP_C05_SERVER_OWNED_FEATURE_FLAG_POSTURE_ENTRIES: readonly Readonly<BcpC05FeatureFlagPostureEntry>[] =
  Object.freeze(ENTRIES.map((e) => Object.freeze({ ...e })));

/**
 * Return the server-owned C-05 feature-flag posture entries as a FRESH defensive copy. PURE,
 * DETERMINISTIC, NO-THROW. Takes NO arguments and reads NO env/request/global/live state. Mutating the
 * result never affects the constant or a later call.
 */
export function getBcpC05FeatureFlagPostureEntries(): BcpC05FeatureFlagPostureEntry[] {
  return BCP_C05_SERVER_OWNED_FEATURE_FLAG_POSTURE_ENTRIES.map((e) => ({ ...e }));
}

// ---------------------------------------------------------------------------
// FITNESS FUNCTION 1 — ENFORCED FEATURE-FLAG NAME ALLOW-LIST.
// ---------------------------------------------------------------------------
const FLAG_NAME_SHAPE_RE = /^[A-Z0-9_]+$/;
// Substrings that must NEVER appear in an accepted flag NAME (a name must not encode a secret/identity).
const FLAG_NAME_DENY = ['tenant', 'store', 'customer', 'secret', 'token', 'password', 'credential', 'apikey', 'api_key', 'url', 'supabase', 'database'];

/**
 * ENFORCED ALLOW-LIST FITNESS FUNCTION. Mechanically proves the C-05 posture registry exposes ONLY the
 * six accepted Backend CP feature flag names/keys, in index-aligned tuples, each name shaped safely and
 * free of secret/identity substrings. THROWS with a descriptive message on ANY violation. Not on the
 * no-throw data path. Accepts an optional entries array so tests can prove a tampered set is rejected.
 */
export function assertBcpC05FeatureFlagNameAllowList(
  entries: readonly BcpC05FeatureFlagPostureEntry[] = getBcpC05FeatureFlagPostureEntries(),
): void {
  if (!Array.isArray(entries)) {
    throw new Error('C-05 flag allow-list violation(s): entries is not an array');
  }
  const violations: string[] = [];
  const tupleByKey = new Map<string, { name: string; purpose: string; surface: string }>();
  for (let i = 0; i < ALLOWED_FLAG_KEYS.length; i++) {
    tupleByKey.set(ALLOWED_FLAG_KEYS[i], { name: ALLOWED_FLAG_NAMES[i], purpose: CANON_PURPOSES[i], surface: CANON_SURFACES[i] });
  }

  if (entries.length !== ALLOWED_FLAG_KEYS.length) {
    violations.push(`expected exactly ${ALLOWED_FLAG_KEYS.length} entries, got ${entries.length}`);
  }
  const seenKeys = new Set<string>();
  const seenNames = new Set<string>();
  for (const e of entries) {
    if (!e || typeof e !== 'object') { violations.push('non-object entry'); continue; }
    const tuple = tupleByKey.get(e.flagKey);
    if (!tuple) {
      violations.push(`flag key not allow-listed: ${String(e.flagKey)}`);
    } else {
      if (e.flagName !== tuple.name) violations.push(`flag name mismatch for ${e.flagKey}: ${String(e.flagName)}`);
      if (e.flagPurpose !== tuple.purpose) violations.push(`flag purpose mismatch for ${e.flagKey}: ${String(e.flagPurpose)}`);
      if (e.ownerSurface !== tuple.surface) violations.push(`owner surface mismatch for ${e.flagKey}: ${String(e.ownerSurface)}`);
    }
    if (typeof e.flagName !== 'string' || !FLAG_NAME_SHAPE_RE.test(e.flagName)) {
      violations.push(`flag name unsafe shape: ${String(e.flagName)}`);
    } else {
      const lower = e.flagName.toLowerCase();
      for (const bad of FLAG_NAME_DENY) if (lower.includes(bad)) violations.push(`flag name contains forbidden substring "${bad}": ${e.flagName}`);
    }
    if (seenKeys.has(e.flagKey)) violations.push(`duplicate flag key: ${String(e.flagKey)}`);
    if (seenNames.has(e.flagName)) violations.push(`duplicate flag name: ${String(e.flagName)}`);
    seenKeys.add(e.flagKey);
    seenNames.add(e.flagName);
  }
  for (const k of ALLOWED_FLAG_KEYS) if (!seenKeys.has(k)) violations.push(`missing accepted flag key: ${k}`);

  if (violations.length > 0) {
    throw new Error(`C-05 flag allow-list violation(s): ${violations.join('; ')}`);
  }
}

// ---------------------------------------------------------------------------
// FITNESS FUNCTION 2 — ENFORCED NO-VALUE / NO-VALUE-ORACLE.
// ---------------------------------------------------------------------------
// EXACT field names (case-insensitive) that must NEVER appear anywhere in C-05 provider/read-model/client
// output. These would leak a raw env value or a value-oracle (set/unset/enabled/length/hash/count, etc.).
// NOTE: the safe meta-labels `valueExposurePosture` / `no_raw_env_value` are NOT in this list (they assert
// the ABSENCE of a value); only literal value/value-oracle FIELD names are banned.
export const PROHIBITED_VALUE_ORACLE_FIELDS: ReadonlySet<string> = new Set<string>([
  'value', 'rawvalue', 'currentvalue', 'envvalue', 'secretvalue', 'runtimevalue',
  'enabled', 'disabled', 'isenabled', 'isdisabled',
  'present', 'missing', 'exists', 'doesexist', 'doesnotexist', 'ispresent', 'ismissing', 'isset', 'isunset', 'set', 'unset',
  'length', 'hash', 'checksum', 'digest',
  'countofvalues', 'envcount', 'keycount', 'allenvkeys', 'rawenv', 'env',
  'secret', 'token', 'credential', 'password', 'privatekey', 'connectionstring', 'databaseurl', 'supabaseurl', 'supabasekey', 'url', 'domain',
]);

function collectKeysDeep(value: unknown, acc: string[], depth = 0): void {
  if (depth > 8 || value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const v of value) collectKeysDeep(v, acc, depth + 1);
    return;
  }
  for (const k of Object.keys(value as Record<string, unknown>)) {
    acc.push(k);
    try {
      collectKeysDeep((value as Record<string, unknown>)[k], acc, depth + 1);
    } catch {
      /* ignore throwing getters */
    }
  }
}

/**
 * ENFORCED NO-VALUE-ORACLE FITNESS FUNCTION. Mechanically proves a structure (provider entries, a DTO
 * envelope, or client-normalized items) contains NO prohibited value/value-oracle FIELD name at any
 * depth. THROWS with a descriptive message listing the offending field(s). Not on the no-throw data path.
 */
export function assertBcpC05NoValueOracleFields(
  value: unknown = getBcpC05FeatureFlagPostureEntries(),
): void {
  const keys: string[] = [];
  collectKeysDeep(value, keys);
  const offenders = Array.from(new Set(keys.filter((k) => PROHIBITED_VALUE_ORACLE_FIELDS.has(k.toLowerCase()))));
  if (offenders.length > 0) {
    throw new Error(`C-05 no-value-oracle violation(s): prohibited field name(s) present: ${offenders.join(', ')}`);
  }
}

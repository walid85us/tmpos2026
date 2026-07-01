// Phase 2.0 M33 — C-07 Data Source Boundary Readiness Lens: PURE read model + DTO (FIRST redaction boundary).
//
// WHAT THIS IS: a PURE, SYNCHRONOUS, NO-THROW, DETERMINISTIC builder that maps declared, code/config-only
// data-source-boundary posture items (the SEVEN accepted Backend-CP boundary keys only) into a safe, bounded
// C-07 envelope. It is the canonical single source of truth for the C-07 closed enum tables, label tables,
// cap tables, schema/envelope/item contract, and summary-count derivations locked in the M32 planning gate.
//
// C-07 is a DEV-only, production-disabled, read-only DECLARED `code_config` SELF-ATTESTATION that the Backend
// CP evidence surfaces (C-01..C-06 + the boundary transport harness) are declared to remain inside the
// approved data-source boundary. It is NOT a live verifier, drift detector, scanner, diagnostics surface,
// value oracle, production-readiness claim, or customer-facing feature.
//
// BINDING SAFETY:
//   - PURE + DETERMINISTIC + NO-THROW + side-effect-free. No I/O. No DB/SQL/Supabase/Supabase-MCP/live
//     provider/fetch/network/filesystem. NEVER reads process.env for output, NEVER enumerates env, NEVER
//     reads a runtime clock, NEVER executes a command, NEVER reads packages/file paths.
//   - NO `generatedAt` and NO runtime timestamp — PERMANENTLY EXCLUDED (freshness is the fixed constant
//     `static_code_config` only), so no field can become a runtime oracle.
//   - Every field is a member of a CLOSED enum; every displayable value maps to a static safe label; unknown
//     inputs normalize to a safe fallback that is itself a closed-set member (never the raw value).
//   - The declared postures self-attest DECLARED absence (`asserted_absent_code_config`) — never a live
//     verification result.

// ---------------------------------------------------------------------------
// Schema + fixed envelope constants (M32 §10).
// ---------------------------------------------------------------------------
export const C07_DATA_SOURCE_BOUNDARY_SCHEMA_VERSION_V1 =
  'bcp.c07.data-source-boundary-readiness.v1-code-config';
export const C07_SELF_ATTESTATION = 'design_time_code_config' as const;
export const C07_FRESHNESS = 'static_code_config' as const;
export const C07_REDACTION_POSTURE = 'enforced' as const;
export const C07_LOG_EXPOSURE_POSTURE = 'no_raw_logs' as const;

// ---------------------------------------------------------------------------
// Closed enum vocabularies (M32 §7). Every "unknown -> fallback" target below is itself a member of the
// field's closed set (or explicitly "drop the item"); fallbacks are inert (never value oracles).
// ---------------------------------------------------------------------------
export type C07SourceMode = 'code_config' | 'synthetic' | 'none';
export type C07Freshness = typeof C07_FRESHNESS;
export type C07BoundaryKey =
  | 'c01_readiness_summary'
  | 'c02_registry_readiness'
  | 'c03_ui_coverage_readiness'
  | 'c04_route_exposure_readiness'
  | 'c05_feature_flag_posture'
  | 'c06_quality_gates_evidence'
  | 'boundary_transport_matrix';
export type C07OwnerSurface = 'bcp_evidence_lens' | 'bcp_transport_harness' | 'redacted';
export type C07DataSourcePosture = 'code_config_only' | 'synthetic_only' | 'not_applicable' | 'redacted';
// Absence-posture family (M32 §7 #6..#13): declared-absent, never live-verified.
export type C07AbsencePosture = 'asserted_absent_code_config' | 'not_applicable' | 'redacted';
export type C07ValueOraclePosture = 'no_value_oracle' | 'not_applicable' | 'redacted';
export type C07ProductionPosture = 'production_disabled' | 'not_applicable' | 'redacted';
export type C07MutationPosture = 'mutation_blocked' | 'not_applicable' | 'redacted';
export type C07CustomerExposurePosture = 'no_customer_exposure' | 'not_applicable' | 'redacted';
export type C07EvidenceStatus = 'asserted_within_boundary' | 'redacted' | 'unknown_redacted';
export type C07EmptyStateReason = 'no_boundary_items' | 'no_live_source' | 'input_redacted';
export type C07Warning =
  | 'source_mode_redacted'
  | 'posture_value_redacted'
  | 'boundary_key_redacted'
  | 'item_count_capped'
  | 'warning_count_capped'
  | 'no_live_source';
export type C07EvidenceLabel = 'code_config_declared' | 'synthetic_fixture' | 'none_empty' | 'redacted';
export type C07SelfAttestation = typeof C07_SELF_ATTESTATION;

// ---------------------------------------------------------------------------
// Boundary keys (fixed order — M32 §7.3) + label / purpose / owner-surface maps (M32 §8). Single source of
// truth; the provider derives its declared items from these, and the builder DERIVES an item's label /
// purpose / owner-surface from the validated key (never trusting caller-supplied display strings).
// ---------------------------------------------------------------------------
// Object.freeze at runtime (not just TS `readonly`) so a cast-mutation cannot inject arbitrary output — the
// builder DERIVES each item's label/purpose/owner-surface from these maps, so they are a trust anchor.
export const C07_BOUNDARY_KEYS: readonly C07BoundaryKey[] = Object.freeze([
  'c01_readiness_summary',
  'c02_registry_readiness',
  'c03_ui_coverage_readiness',
  'c04_route_exposure_readiness',
  'c05_feature_flag_posture',
  'c06_quality_gates_evidence',
  'boundary_transport_matrix',
] as const);

export const C07_BOUNDARY_LABELS: Readonly<Record<C07BoundaryKey, string>> = Object.freeze({
  c01_readiness_summary: 'C-01 Readiness Summary',
  c02_registry_readiness: 'C-02 Registry Readiness',
  c03_ui_coverage_readiness: 'C-03 UI Coverage Readiness',
  c04_route_exposure_readiness: 'C-04 Route Exposure Readiness',
  c05_feature_flag_posture: 'C-05 Feature-Flag Posture',
  c06_quality_gates_evidence: 'C-06 Quality-Gates Evidence',
  boundary_transport_matrix: 'Boundary Transport Harness',
});

export const C07_BOUNDARY_PURPOSES: Readonly<Record<C07BoundaryKey, string>> = Object.freeze({
  c01_readiness_summary: 'Readiness summary evidence',
  c02_registry_readiness: 'Registry readiness evidence',
  c03_ui_coverage_readiness: 'UI coverage readiness evidence',
  c04_route_exposure_readiness: 'Route exposure readiness evidence',
  c05_feature_flag_posture: 'Feature-flag posture evidence',
  c06_quality_gates_evidence: 'Quality-gates evidence',
  boundary_transport_matrix: 'Boundary transport harness evidence',
});
export const C07_BOUNDARY_PURPOSE_FALLBACK = 'Redacted';

export const C07_OWNER_SURFACE_BY_KEY: Readonly<Record<C07BoundaryKey, C07OwnerSurface>> = Object.freeze({
  c01_readiness_summary: 'bcp_evidence_lens',
  c02_registry_readiness: 'bcp_evidence_lens',
  c03_ui_coverage_readiness: 'bcp_evidence_lens',
  c04_route_exposure_readiness: 'bcp_evidence_lens',
  c05_feature_flag_posture: 'bcp_evidence_lens',
  c06_quality_gates_evidence: 'bcp_evidence_lens',
  boundary_transport_matrix: 'bcp_transport_harness',
});

// Closed value sets (for O(1) membership normalization).
const SOURCE_MODE_SET = new Set<string>(['code_config', 'synthetic', 'none']);
const BOUNDARY_KEY_SET = new Set<string>(C07_BOUNDARY_KEYS);
const DATA_SOURCE_POSTURE_SET = new Set<string>(['code_config_only', 'synthetic_only', 'not_applicable', 'redacted']);
const ABSENCE_POSTURE_SET = new Set<string>(['asserted_absent_code_config', 'not_applicable', 'redacted']);
const VALUE_ORACLE_POSTURE_SET = new Set<string>(['no_value_oracle', 'not_applicable', 'redacted']);
const PRODUCTION_POSTURE_SET = new Set<string>(['production_disabled', 'not_applicable', 'redacted']);
const MUTATION_POSTURE_SET = new Set<string>(['mutation_blocked', 'not_applicable', 'redacted']);
const CUSTOMER_EXPOSURE_POSTURE_SET = new Set<string>(['no_customer_exposure', 'not_applicable', 'redacted']);
const EVIDENCE_STATUS_SET = new Set<string>(['asserted_within_boundary', 'redacted', 'unknown_redacted']);
const KEY_ORDER = new Map<string, number>(C07_BOUNDARY_KEYS.map((k, i) => [k, i]));

// The COMPLETE closed set of string values C-07 may ever emit — derived from the same vocabularies above so
// it can never drift. The provider's value-content fitness function asserts every emitted string is a member
// (an exact closed-set gate: no path/URL/token/DB/Supabase/provider/env value can pass on its own merit).
export const C07_ALLOWED_EMITTED_VALUES: ReadonlySet<string> = new Set<string>([
  C07_DATA_SOURCE_BOUNDARY_SCHEMA_VERSION_V1,
  C07_SELF_ATTESTATION,
  C07_FRESHNESS,
  C07_REDACTION_POSTURE,
  C07_LOG_EXPOSURE_POSTURE,
  ...SOURCE_MODE_SET,
  ...BOUNDARY_KEY_SET,
  ...Object.values(C07_BOUNDARY_LABELS),
  ...Object.values(C07_BOUNDARY_PURPOSES),
  C07_BOUNDARY_PURPOSE_FALLBACK,
  ...Object.values(C07_OWNER_SURFACE_BY_KEY),
  ...DATA_SOURCE_POSTURE_SET,
  ...ABSENCE_POSTURE_SET,
  ...VALUE_ORACLE_POSTURE_SET,
  ...PRODUCTION_POSTURE_SET,
  ...MUTATION_POSTURE_SET,
  ...CUSTOMER_EXPOSURE_POSTURE_SET,
  ...EVIDENCE_STATUS_SET,
  // empty-state reasons
  'no_boundary_items', 'no_live_source', 'input_redacted',
  // warnings
  'source_mode_redacted', 'posture_value_redacted', 'boundary_key_redacted',
  'item_count_capped', 'warning_count_capped',
  // evidence labels
  'code_config_declared', 'synthetic_fixture', 'none_empty',
]);

// ---------------------------------------------------------------------------
// Caps (M32 §9).
// ---------------------------------------------------------------------------
export const C07_MAX_BOUNDARY_ITEMS = 7; // one per closed key
export const C07_ITEM_CEILING = 12; // defensive safety ceiling (never reached by natural <=7 data)
export const C07_MAX_WARNINGS = 12; // final slot reserved for `warning_count_capped`
export const C07_MAX_EVIDENCE_LABELS = 4; // envelope-level, total (not per item)
export const C07_SUMMARY_COUNT_FIELDS = 16; // fixed; never grows
export const C07_MAX_LABEL_LEN = 64; // closed display labels
export const C07_MAX_NARRATIVE_LEN = 200; // the two narrative constants only

// ---------------------------------------------------------------------------
// Untrusted input + safe output shapes (M32 §10).
// ---------------------------------------------------------------------------
export interface C07BoundaryItemInput {
  boundaryKey?: unknown;
  sourceMode?: unknown;
  dataSourcePosture?: unknown;
  dbPosture?: unknown;
  sqlPosture?: unknown;
  supabasePosture?: unknown;
  liveProviderPosture?: unknown;
  runtimeEnvPosture?: unknown;
  commandOutputPosture?: unknown;
  diagnosticsPosture?: unknown;
  rawEvidencePosture?: unknown;
  valueOraclePosture?: unknown;
  productionPosture?: unknown;
  mutationPosture?: unknown;
  customerExposurePosture?: unknown;
  evidenceStatus?: unknown;
}

export interface C07BoundaryItem {
  boundaryKey: C07BoundaryKey;
  boundaryLabel: string;
  boundaryPurpose: string;
  ownerSurface: C07OwnerSurface;
  sourceMode: C07SourceMode;
  dataSourcePosture: C07DataSourcePosture;
  dbPosture: C07AbsencePosture;
  sqlPosture: C07AbsencePosture;
  supabasePosture: C07AbsencePosture;
  liveProviderPosture: C07AbsencePosture;
  runtimeEnvPosture: C07AbsencePosture;
  commandOutputPosture: C07AbsencePosture;
  diagnosticsPosture: C07AbsencePosture;
  rawEvidencePosture: C07AbsencePosture;
  valueOraclePosture: C07ValueOraclePosture;
  productionPosture: C07ProductionPosture;
  mutationPosture: C07MutationPosture;
  customerExposurePosture: C07CustomerExposurePosture;
  evidenceStatus: C07EvidenceStatus;
}

// Fixed 16-key integer summary-count object (M32 §11). No other key permitted; never grows.
export interface C07SummaryCounts {
  total: number;
  codeConfigOnly: number;
  syntheticOnly: number;
  noDb: number;
  noSql: number;
  noSupabase: number;
  noLiveProvider: number;
  noRuntimeEnvValues: number;
  noRawDiagnostics: number;
  noCommandOutput: number;
  productionDisabled: number;
  readOnly: number;
  mutationBlocked: number;
  valueOracleBlocked: number;
  customerExposureBlocked: number;
  unknownRedacted: number;
}

export interface C07DataSourceBoundaryEnvelope {
  schemaVersion: string;
  selfAttestation: C07SelfAttestation;
  sourceMode: C07SourceMode;
  freshness: C07Freshness;
  summaryCounts: C07SummaryCounts;
  boundaryItems: C07BoundaryItem[];
  emptyState: boolean;
  emptyStateReason: C07EmptyStateReason;
  warnings: C07Warning[];
  redactionPosture: typeof C07_REDACTION_POSTURE;
  productionPosture: C07ProductionPosture;
  mutationPosture: C07MutationPosture;
  dataSourcePosture: C07DataSourcePosture;
  logExposurePosture: typeof C07_LOG_EXPOSURE_POSTURE;
  valueOraclePosture: C07ValueOraclePosture;
  evidenceLabels: C07EvidenceLabel[];
}

// ---------------------------------------------------------------------------
// Normalization helpers — pure, no-throw. Never emit a raw untrusted value.
// ---------------------------------------------------------------------------
/** Read one untrusted field defensively — a throwing getter/proxy yields `undefined`, never a throw. */
function readField(obj: object, key: keyof C07BoundaryItemInput): unknown {
  try {
    return (obj as Record<string, unknown>)[key as string];
  } catch {
    return undefined;
  }
}

/** Normalize to a member of `allowed` or the `fallback` (never the raw value). */
function normalizeEnum<T extends string>(value: unknown, allowed: Set<string>, fallback: T): T {
  return typeof value === 'string' && allowed.has(value) ? (value as T) : fallback;
}

/** Normalize a posture field; report whether the RESULT is the `redacted` member (feeds `unknownRedacted`). */
function normalizePosture<T extends string>(value: unknown, allowed: Set<string>): [T, boolean] {
  const v = normalizeEnum<T>(value, allowed, 'redacted' as T);
  return [v, v === 'redacted'];
}

/** Normalize sourceMode; report whether the `none` fallback was triggered (feeds `source_mode_redacted`). */
function normalizeSourceMode(value: unknown): [C07SourceMode, boolean] {
  const ok = typeof value === 'string' && SOURCE_MODE_SET.has(value);
  return [ok ? (value as C07SourceMode) : 'none', !ok];
}

// ---------------------------------------------------------------------------
// Defensive cap helpers (M32 §9). Both are pure, deterministic, and — with the fixed closed vocabularies —
// unreachable by natural data; they are proven directly with synthetic over-size fixtures.
// ---------------------------------------------------------------------------
/** Cap warnings at 12, RESERVING the final slot for `warning_count_capped` so the cap signal is never lost. */
export function enforceC07WarningCap(warnings: readonly C07Warning[]): C07Warning[] {
  const list = Array.isArray(warnings) ? warnings.slice() : [];
  if (list.length <= C07_MAX_WARNINGS) return list;
  const kept = list.slice(0, C07_MAX_WARNINGS - 1);
  kept.push('warning_count_capped');
  return kept;
}

/** Cap envelope evidence labels at 4 (total, envelope-level). Deduplicates first, then truncates. NOTE: the
 *  closed vocabulary has exactly 4 members, so post-dedup the `.slice` is a no-op — this cap is dedup-only
 *  (unlike the warning cap, whose reserved-slot truncation is reachable via a synthetic over-size fixture). */
export function enforceC07EvidenceLabelCap(labels: readonly C07EvidenceLabel[]): C07EvidenceLabel[] {
  const deduped: C07EvidenceLabel[] = [];
  const seen = new Set<string>();
  for (const l of Array.isArray(labels) ? labels : []) {
    if (seen.has(l)) continue;
    seen.add(l);
    deduped.push(l);
  }
  return deduped.slice(0, C07_MAX_EVIDENCE_LABELS);
}

// ---------------------------------------------------------------------------
// Builder — PURE + NO-THROW + DETERMINISTIC (M32 §10/§11). The FIRST redaction boundary.
// ---------------------------------------------------------------------------

/**
 * Build the C-07 data-source-boundary DTO envelope from declared code/config posture items. PURE,
 * SYNCHRONOUS, NO-THROW, DETERMINISTIC, side-effect-free. Enforces closed enums, one-item-per-key dedup,
 * unknown-key drop, unknown-value redaction, deterministic ordering, bounded caps, and the fixed 16-key
 * summary-count derivations. Emits NO `generatedAt`/timestamp and no raw untrusted value.
 */
export function buildC07DataSourceBoundaryEnvelope(
  entries: readonly C07BoundaryItemInput[],
): C07DataSourceBoundaryEnvelope {
  // Copy input into a REAL array up front, guarded — a revoked/trapping array proxy throws on length/index
  // access, so `Array.from` inside try/catch keeps the builder truly no-throw (hostile input -> empty).
  let raw: readonly unknown[];
  try {
    raw = Array.isArray(entries) ? Array.from(entries) : [];
  } catch {
    raw = [];
  }

  let anyKeyDropped = false;

  // Accept only valid-key items; carry per-item flags (redaction / source-mode fallback) so the warning
  // signals below reflect the RETAINED (deduped) output, not dropped duplicates.
  const accepted: { item: C07BoundaryItem; redacted: boolean; sourceModeFallback: boolean }[] = [];
  for (let idx = 0; idx < raw.length; idx++) {
    try {
      const entry = raw[idx];
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        anyKeyDropped = true; // a non-object entry carries no valid boundary key
        continue;
      }
      const keyRaw = readField(entry, 'boundaryKey');
      if (!(typeof keyRaw === 'string' && BOUNDARY_KEY_SET.has(keyRaw))) {
        anyKeyDropped = true;
        continue; // unknown boundaryKey -> DROP, not counted (+ boundary_key_redacted)
      }
      const key = keyRaw as C07BoundaryKey;

      const [sourceMode, smFallback] = normalizeSourceMode(readField(entry, 'sourceMode'));

      let redacted = false;
      const posture = <T extends string>(field: keyof C07BoundaryItemInput, set: Set<string>): T => {
        const [v, wasRedacted] = normalizePosture<T>(readField(entry, field), set);
        if (wasRedacted) redacted = true;
        return v;
      };

      const dataSourcePosture = posture<C07DataSourcePosture>('dataSourcePosture', DATA_SOURCE_POSTURE_SET);
      const dbPosture = posture<C07AbsencePosture>('dbPosture', ABSENCE_POSTURE_SET);
      const sqlPosture = posture<C07AbsencePosture>('sqlPosture', ABSENCE_POSTURE_SET);
      const supabasePosture = posture<C07AbsencePosture>('supabasePosture', ABSENCE_POSTURE_SET);
      const liveProviderPosture = posture<C07AbsencePosture>('liveProviderPosture', ABSENCE_POSTURE_SET);
      const runtimeEnvPosture = posture<C07AbsencePosture>('runtimeEnvPosture', ABSENCE_POSTURE_SET);
      const commandOutputPosture = posture<C07AbsencePosture>('commandOutputPosture', ABSENCE_POSTURE_SET);
      const diagnosticsPosture = posture<C07AbsencePosture>('diagnosticsPosture', ABSENCE_POSTURE_SET);
      const rawEvidencePosture = posture<C07AbsencePosture>('rawEvidencePosture', ABSENCE_POSTURE_SET);
      const valueOraclePosture = posture<C07ValueOraclePosture>('valueOraclePosture', VALUE_ORACLE_POSTURE_SET);
      const productionPosture = posture<C07ProductionPosture>('productionPosture', PRODUCTION_POSTURE_SET);
      const mutationPosture = posture<C07MutationPosture>('mutationPosture', MUTATION_POSTURE_SET);
      const customerExposurePosture = posture<C07CustomerExposurePosture>(
        'customerExposurePosture', CUSTOMER_EXPOSURE_POSTURE_SET,
      );

      // evidenceStatus: an invalid/unknown input redacts to `unknown_redacted` AND counts as a field
      // redaction (so an isolated bad status is never a silent redaction — it feeds `unknownRedacted` and the
      // `posture_value_redacted` warning). If any posture was redacted, force `unknown_redacted` too.
      const rawStatus = readField(entry, 'evidenceStatus');
      const statusOk = typeof rawStatus === 'string' && EVIDENCE_STATUS_SET.has(rawStatus);
      if (!statusOk) redacted = true;
      let evidenceStatus: C07EvidenceStatus = statusOk ? (rawStatus as C07EvidenceStatus) : 'unknown_redacted';
      if (redacted) evidenceStatus = 'unknown_redacted';

      accepted.push({
        redacted,
        sourceModeFallback: smFallback,
        item: {
          boundaryKey: key,
          boundaryLabel: C07_BOUNDARY_LABELS[key], // derived from validated key (never caller-supplied)
          boundaryPurpose: C07_BOUNDARY_PURPOSES[key],
          ownerSurface: C07_OWNER_SURFACE_BY_KEY[key],
          sourceMode,
          dataSourcePosture,
          dbPosture,
          sqlPosture,
          supabasePosture,
          liveProviderPosture,
          runtimeEnvPosture,
          commandOutputPosture,
          diagnosticsPosture,
          rawEvidencePosture,
          valueOraclePosture,
          productionPosture,
          mutationPosture,
          customerExposurePosture,
          evidenceStatus,
        },
      });
    } catch {
      // A hostile throwing getter yields no item; treat as a dropped input.
      anyKeyDropped = true;
    }
  }

  // Defensive item ceiling (12): a SIGNAL that the raw accepted input volume was oversized. It does NOT
  // truncate before dedup — that could starve later distinct valid keys — so whole-input one-per-key
  // first-occurrence semantics are preserved. Never reached by natural <=7 data; exercised only by a
  // synthetic over-ceiling fixture.
  const itemCapped = accepted.length > C07_ITEM_CEILING;

  // Deduplicate one-item-per-key over the WHOLE accepted list (first occurrence wins), order by the fixed
  // §7.3 key order, then defensively bound to the 7-key maximum (dedup already yields <=7).
  const seenKeys = new Set<string>();
  const dedupedAll: { item: C07BoundaryItem; redacted: boolean; sourceModeFallback: boolean }[] = [];
  for (const rec of accepted) {
    if (seenKeys.has(rec.item.boundaryKey)) continue;
    seenKeys.add(rec.item.boundaryKey);
    dedupedAll.push(rec);
  }
  dedupedAll.sort((a, b) => (KEY_ORDER.get(a.item.boundaryKey)! - KEY_ORDER.get(b.item.boundaryKey)!));
  const deduped = dedupedAll.slice(0, C07_MAX_BOUNDARY_ITEMS);

  const boundaryItems = deduped.map((r) => r.item);
  const isEmpty = boundaryItems.length === 0;
  // Warning signals reflect the RETAINED output (dropped duplicates never raise a redaction warning).
  const anyPostureRedaction = deduped.some((r) => r.redacted);
  const anySourceModeFallback = deduped.some((r) => r.sourceModeFallback);

  // Summary counts — fixed 16 keys, each derived ONLY from the closed postures of retained/deduped items.
  const countBy = (pred: (i: C07BoundaryItem) => boolean): number => boundaryItems.filter(pred).length;
  const summaryCounts: C07SummaryCounts = {
    total: boundaryItems.length,
    codeConfigOnly: countBy((i) => i.dataSourcePosture === 'code_config_only'),
    syntheticOnly: countBy((i) => i.dataSourcePosture === 'synthetic_only'),
    noDb: countBy((i) => i.dbPosture === 'asserted_absent_code_config'),
    noSql: countBy((i) => i.sqlPosture === 'asserted_absent_code_config'),
    noSupabase: countBy((i) => i.supabasePosture === 'asserted_absent_code_config'),
    noLiveProvider: countBy((i) => i.liveProviderPosture === 'asserted_absent_code_config'),
    noRuntimeEnvValues: countBy((i) => i.runtimeEnvPosture === 'asserted_absent_code_config'),
    noRawDiagnostics: countBy((i) => i.diagnosticsPosture === 'asserted_absent_code_config'),
    noCommandOutput: countBy((i) => i.commandOutputPosture === 'asserted_absent_code_config'),
    productionDisabled: countBy((i) => i.productionPosture === 'production_disabled'),
    readOnly: countBy((i) => i.mutationPosture === 'mutation_blocked'),
    mutationBlocked: countBy((i) => i.mutationPosture === 'mutation_blocked'),
    valueOracleBlocked: countBy((i) => i.valueOraclePosture === 'no_value_oracle'),
    customerExposureBlocked: countBy((i) => i.customerExposurePosture === 'no_customer_exposure'),
    unknownRedacted: deduped.filter((r) => r.redacted).length,
  };

  // Empty-state reason: `no_live_source` is the non-empty steady state (C-07 has no live source by design);
  // `input_redacted` means entries were provided but all dropped/redacted away; `no_boundary_items` means
  // nothing was provided. Consumers gate on `emptyState`; the reason is always a true closed-set member.
  const anyRedactionSignal = anyKeyDropped || anySourceModeFallback || anyPostureRedaction;
  const emptyStateReason: C07EmptyStateReason = !isEmpty
    ? 'no_live_source'
    : anyRedactionSignal
      ? 'input_redacted'
      : 'no_boundary_items';

  // Warnings — fixed precedence, single occurrence each; final slot reserved for the cap signal.
  const warnings: C07Warning[] = [];
  if (anySourceModeFallback) warnings.push('source_mode_redacted');
  if (anyPostureRedaction) warnings.push('posture_value_redacted');
  if (anyKeyDropped) warnings.push('boundary_key_redacted');
  if (itemCapped) warnings.push('item_count_capped');
  if (isEmpty) warnings.push('no_live_source');
  const cappedWarnings = enforceC07WarningCap(warnings);

  // Envelope-level source/posture summary — derived from the retained set; `redacted`/`none` when empty or
  // non-uniform (fallback is a closed-set member, never a raw value).
  const envelopeSourceMode: C07SourceMode = isEmpty
    ? 'none'
    : boundaryItems.every((i) => i.sourceMode === 'code_config')
      ? 'code_config'
      : boundaryItems.every((i) => i.sourceMode === 'synthetic')
        ? 'synthetic'
        : 'none'; // non-uniform -> safe closed fallback (never misrepresent a mixed set by the first item)

  const envelopeDataSourcePosture: C07DataSourcePosture = isEmpty
    ? 'redacted'
    : boundaryItems.every((i) => i.dataSourcePosture === 'code_config_only')
      ? 'code_config_only'
      : boundaryItems.every((i) => i.dataSourcePosture === 'synthetic_only')
        ? 'synthetic_only'
        : 'redacted';

  const envelopeProductionPosture: C07ProductionPosture =
    !isEmpty && boundaryItems.every((i) => i.productionPosture === 'production_disabled')
      ? 'production_disabled'
      : 'redacted';
  const envelopeMutationPosture: C07MutationPosture =
    !isEmpty && boundaryItems.every((i) => i.mutationPosture === 'mutation_blocked')
      ? 'mutation_blocked'
      : 'redacted';
  const envelopeValueOraclePosture: C07ValueOraclePosture =
    !isEmpty && boundaryItems.every((i) => i.valueOraclePosture === 'no_value_oracle')
      ? 'no_value_oracle'
      : 'redacted';

  // Evidence labels (envelope-level, <=4): source-mode based, plus `redacted` if any redaction occurred.
  const evidenceLabels: C07EvidenceLabel[] = [];
  if (isEmpty || envelopeSourceMode === 'none') evidenceLabels.push('none_empty');
  else if (envelopeSourceMode === 'synthetic') evidenceLabels.push('synthetic_fixture');
  else evidenceLabels.push('code_config_declared');
  if (anyRedactionSignal) evidenceLabels.push('redacted');

  return {
    schemaVersion: C07_DATA_SOURCE_BOUNDARY_SCHEMA_VERSION_V1,
    selfAttestation: C07_SELF_ATTESTATION,
    sourceMode: envelopeSourceMode,
    freshness: C07_FRESHNESS,
    summaryCounts,
    boundaryItems,
    emptyState: isEmpty,
    emptyStateReason,
    warnings: cappedWarnings,
    redactionPosture: C07_REDACTION_POSTURE,
    productionPosture: envelopeProductionPosture,
    mutationPosture: envelopeMutationPosture,
    dataSourcePosture: envelopeDataSourcePosture,
    logExposurePosture: C07_LOG_EXPOSURE_POSTURE,
    valueOraclePosture: envelopeValueOraclePosture,
    evidenceLabels: enforceC07EvidenceLabelCap(evidenceLabels),
  };
}

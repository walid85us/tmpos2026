// Phase 2.0 M12 — C-03 Backend CP UI Coverage / Screen Readiness Lens: PURE backend read model + DTO.
//
// WHAT THIS IS: a PURE, SYNCHRONOUS, NO-THROW, DETERMINISTIC builder that maps server-owned, code/config
// UI coverage entries (safe bounded labels/enums only) into a safe, bounded C-03 readiness envelope. It
// mirrors the hardened C-02 read model: it reads NOTHING live and crosses NO boundary.
//
// BINDING SAFETY:
//   - No DB, no Supabase, no provider, no fetch, no network, no filesystem, no I/O of any kind.
//   - No createClient/@supabase/getDb/process.env.DATABASE/connection strings.
//   - No Express, no router, no request/response context. No browser/React APIs. No import from src/.
//   - Takes the coverage entries as an INPUT (dependency injection); never imports a frontend file.
//   - Reads ONLY the accepted bounded fields; every value becomes a safe label/enum or a safe fallback.
//     NEVER tenant/store/customer rows, identity/audit rows, permission/RBAC keys, auth claims, secrets,
//     tokens, DB URLs, emails, domains, raw file paths, raw component names, or raw identifiers.
//   - Output is safe bounded posture LABELS / enums / bounded counts ONLY. Any unknown/empty/whitespace/
//     unsafe/hostile value becomes the `redacted_label` sentinel (labels) or a safe enum fallback.

// ---------------------------------------------------------------------------
// Schema / source-mode / freshness / warning constants (bounded safe labels only).
// ---------------------------------------------------------------------------
export const C03_UI_COVERAGE_SCHEMA_VERSION_V1 = 'bcp.c03.ui-coverage-readiness.v1-code-config';
export type C03SourceMode = 'code_config';
const FRESHNESS_LABEL = 'code-config-no-live-read';
const WARNING_LABEL = 'code_config';
/** Fixed, deterministic dev stamp — never a wall-clock value that could correlate identity/env. */
const C03_GENERATED_AT = '2026-01-01T00:00:00.000Z';

// ---------------------------------------------------------------------------
// Safe bounded enum vocabularies (re-expressed to avoid redaction-triggering substrings, e.g. the
// `customer_`-shaped value from the prompt's recommended vocabulary is expressed as `no_external_facing`).
// ---------------------------------------------------------------------------
export type C03ScreenStatus = 'implemented' | 'preview' | 'placeholder' | 'deferred' | 'blocked';
export type C03CoverageClass =
  | 'internal_dev_screen' | 'readiness_gate' | 'preview_card'
  | 'placeholder_screen' | 'deferred_screen' | 'blocked_screen';
export type C03SubStatus = 'implemented' | 'not_implemented' | 'not_applicable' | 'deferred' | 'unknown';
export type C03DataSourceClass = 'code_config_only' | 'no_live_source';
export type C03DevGatePosture = 'dev_only' | 'backend_cp_shell_gate';
export type C03ProductionPosture = 'production_disabled';
export type C03ReadOnlyPosture = 'read_only';
export type C03MutationPosture = 'no_mutation';
export type C03ExposurePosture = 'backend_cp_internal_only' | 'no_external_facing_exposure' | 'no_saas_nav_exposure';
export type C03EvidenceStatus = 'tested' | 'static_reviewed' | 'transport_verified' | 'not_run' | 'unknown';

const SCREEN_STATUS = new Set<string>(['implemented', 'preview', 'placeholder', 'deferred', 'blocked']);
const COVERAGE_CLASS = new Set<string>(['internal_dev_screen', 'readiness_gate', 'preview_card', 'placeholder_screen', 'deferred_screen', 'blocked_screen']);
const SUB_STATUS = new Set<string>(['implemented', 'not_implemented', 'not_applicable', 'deferred', 'unknown']);
const DATA_SOURCE = new Set<string>(['code_config_only', 'no_live_source']);
const DEV_GATE = new Set<string>(['dev_only', 'backend_cp_shell_gate']);
const PRODUCTION_POSTURE = new Set<string>(['production_disabled']);
const READ_ONLY_POSTURE = new Set<string>(['read_only']);
const MUTATION_POSTURE = new Set<string>(['no_mutation']);
const EXPOSURE_POSTURE = new Set<string>(['backend_cp_internal_only', 'no_external_facing_exposure', 'no_saas_nav_exposure']);
const EVIDENCE_STATUS = new Set<string>(['tested', 'static_reviewed', 'transport_verified', 'not_run', 'unknown']);

// ---------------------------------------------------------------------------
// Untrusted input + safe output shapes.
// ---------------------------------------------------------------------------
export interface C03UiCoverageEntryInput {
  screenKey?: unknown;
  screenLabel?: unknown;
  screenStatus?: unknown;
  coverageClass?: unknown;
  previewCardStatus?: unknown;
  clientStatus?: unknown;
  routeStatus?: unknown;
  dataSourceClass?: unknown;
  devGatePosture?: unknown;
  productionPosture?: unknown;
  readOnlyPosture?: unknown;
  mutationPosture?: unknown;
  exposurePosture?: unknown;
  evidenceStatus?: unknown;
}

export interface C03CoverageItem {
  screenKey: string;
  screenLabel: string;
  screenStatus: C03ScreenStatus | 'unknown';
  coverageClass: C03CoverageClass | 'unknown';
  previewCardStatus: C03SubStatus;
  clientStatus: C03SubStatus;
  routeStatus: C03SubStatus;
  dataSourceClass: C03DataSourceClass | 'unknown';
  devGatePosture: C03DevGatePosture | 'unknown';
  productionPosture: C03ProductionPosture | 'unknown';
  readOnlyPosture: C03ReadOnlyPosture | 'unknown';
  mutationPosture: C03MutationPosture | 'unknown';
  exposurePosture: C03ExposurePosture | 'unknown';
  evidenceStatus: C03EvidenceStatus;
}

export interface C03SummaryCounts {
  total: number;
  implemented: number;
  preview: number;
  placeholder: number;
  deferred: number;
  blocked: number;
  unknown: number;
}

export interface C03EmptyState {
  isEmpty: boolean;
  reason: string;
}

export interface C03UiCoverageEnvelope {
  schemaVersion: string;
  sourceMode: C03SourceMode;
  generatedAt: string;
  freshness: { lastSuccessfulReadLabel: string };
  summaryCounts: C03SummaryCounts;
  coverageItems: C03CoverageItem[];
  emptyState: C03EmptyState;
  warnings: string[];
  redactionPosture: string;
  routePosture: string;
  productionPosture: string;
  mutationPosture: string;
  evidenceLabels: string[];
}

// ---------------------------------------------------------------------------
// Safe-label strategy (self-contained; identical hardening to the frozen C-02 read model).
// ---------------------------------------------------------------------------
const SAFE_LABEL_RE = /^[A-Za-z0-9_.\- ]{1,64}$/;
const REDACTED = 'redacted_label';
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
  if (typeof value !== 'string') return REDACTED;
  if (value.trim() === '') return REDACTED;
  if (!SAFE_LABEL_RE.test(value)) return REDACTED;
  const lower = value.toLowerCase();
  for (const bad of FORBIDDEN_SUBSTRINGS) if (lower.includes(bad)) return REDACTED;
  if (UUID_RE.test(value) || LONG_ALNUM_RUN_RE.test(value) || DIGIT_RUN_RE.test(value) ||
      DOMAINISH_RE.test(value) || FILE_EXT_RE.test(value)) {
    return REDACTED;
  }
  return value;
}

/** Normalize an untrusted value to a member of `allowed` or the `fallback` (never the raw value). */
function normalizeEnum<T extends string>(value: unknown, allowed: Set<string>, fallback: T): T {
  return typeof value === 'string' && allowed.has(value) ? (value as T) : fallback;
}

/** Read one untrusted field defensively — a throwing getter/proxy yields `undefined`, never a throw. */
function readField(obj: object, key: keyof C03UiCoverageEntryInput): unknown {
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
 * Build the C-03 UI coverage readiness DTO envelope from server-owned code/config coverage entries.
 * PURE, SYNCHRONOUS, NO-THROW, DETERMINISTIC. Sanitizes every field; emits only bounded labels/enums/
 * counts. Non-array input and non-object entries are handled safely (no throw, no invented entries).
 */
export function buildC03UiCoverageEnvelope(
  entries: readonly C03UiCoverageEntryInput[],
): C03UiCoverageEnvelope {
  const list: readonly unknown[] = Array.isArray(entries) ? entries : [];

  const coverageItems: C03CoverageItem[] = [];
  for (let idx = 0; idx < list.length; idx++) {
    let item: C03CoverageItem | null = null;
    try {
      const entry = list[idx];
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      item = {
        screenKey: safeLabel(readField(entry, 'screenKey')),
        screenLabel: safeLabel(readField(entry, 'screenLabel')),
        screenStatus: normalizeEnum(readField(entry, 'screenStatus'), SCREEN_STATUS, 'unknown'),
        coverageClass: normalizeEnum(readField(entry, 'coverageClass'), COVERAGE_CLASS, 'unknown'),
        previewCardStatus: normalizeEnum(readField(entry, 'previewCardStatus'), SUB_STATUS, 'unknown'),
        clientStatus: normalizeEnum(readField(entry, 'clientStatus'), SUB_STATUS, 'unknown'),
        routeStatus: normalizeEnum(readField(entry, 'routeStatus'), SUB_STATUS, 'unknown'),
        dataSourceClass: normalizeEnum(readField(entry, 'dataSourceClass'), DATA_SOURCE, 'unknown'),
        devGatePosture: normalizeEnum(readField(entry, 'devGatePosture'), DEV_GATE, 'unknown'),
        productionPosture: normalizeEnum(readField(entry, 'productionPosture'), PRODUCTION_POSTURE, 'unknown'),
        readOnlyPosture: normalizeEnum(readField(entry, 'readOnlyPosture'), READ_ONLY_POSTURE, 'unknown'),
        mutationPosture: normalizeEnum(readField(entry, 'mutationPosture'), MUTATION_POSTURE, 'unknown'),
        exposurePosture: normalizeEnum(readField(entry, 'exposurePosture'), EXPOSURE_POSTURE, 'unknown'),
        evidenceStatus: normalizeEnum(readField(entry, 'evidenceStatus'), EVIDENCE_STATUS, 'unknown'),
      };
    } catch {
      item = null;
    }
    if (item) coverageItems.push(item);
  }

  const summaryCounts: C03SummaryCounts = {
    total: coverageItems.length,
    implemented: coverageItems.filter((i) => i.screenStatus === 'implemented').length,
    preview: coverageItems.filter((i) => i.screenStatus === 'preview').length,
    placeholder: coverageItems.filter((i) => i.screenStatus === 'placeholder').length,
    deferred: coverageItems.filter((i) => i.screenStatus === 'deferred').length,
    blocked: coverageItems.filter((i) => i.screenStatus === 'blocked').length,
    unknown: coverageItems.filter((i) => i.screenStatus === 'unknown').length,
  };

  const isEmpty = coverageItems.length === 0;

  return {
    schemaVersion: C03_UI_COVERAGE_SCHEMA_VERSION_V1,
    sourceMode: 'code_config',
    generatedAt: C03_GENERATED_AT,
    freshness: { lastSuccessfulReadLabel: FRESHNESS_LABEL },
    summaryCounts,
    coverageItems,
    emptyState: isEmpty
      ? { isEmpty: true, reason: 'no_ui_coverage_entries' }
      : { isEmpty: false, reason: 'none' },
    warnings: [WARNING_LABEL],
    redactionPosture: 'safe_labels_only',
    routePosture: 'dev_isolated_api',
    productionPosture: 'production_disabled',
    mutationPosture: 'none',
    evidenceLabels: [
      'code_config_only',
      'no_live_source',
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

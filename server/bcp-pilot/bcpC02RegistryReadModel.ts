// Phase 2.0 M8C — C-02 Backend CP Route / Module Registry Readiness Lens: PURE backend read model + DTO/envelope.
//
// WHAT THIS IS: a PURE, SYNCHRONOUS, NO-THROW builder that maps a code/config/static module registry
// (id / name / status metadata only) into a safe, bounded readiness-lens DTO envelope. It is the first
// C-02 implementation artifact and is DELIBERATELY NOT WIRED: no route, no adapter, no Express, no
// registration, no frontend, no UI. It is imported only by its own test in M8C.
//
// BINDING SAFETY — reads NOTHING live and crosses NO boundary:
//   - No DB, no Supabase, no provider, no fetch, no network, no filesystem, no I/O of any kind.
//   - No `createClient`, no `@supabase`, no `getDb`, no `process.env.DATABASE`, no connection strings.
//   - No Express, no router, no `server.listen`, no route registration, no request/response context.
//   - No browser/React APIs; no import from `src/` (the client bundle). Fully self-contained — zero imports.
//   - Takes the module registry as an INPUT (dependency injection), mirroring the frozen C-01 pattern
//     (server-derived inputs supplied by a future adapter; never imported from `src/`, never from a DB).
//   - Reads ONLY module id / name / status. NEVER tenant/store/customer rows, identity_link rows, audit
//     rows, DatabaseRow/PermissionRow shapes, auth claims, provider UIDs, internal_user_id, secrets,
//     tokens, DB URLs, emails, domains, payment identifiers, raw file paths, or raw route internals.
//   - Output is safe bounded posture LABELS / enums / booleans / bounded counts ONLY. Any unknown, empty,
//     whitespace-only, unsafe, or hostile value becomes the `redacted_label` sentinel (or a safe enum
//     fallback). No raw object dumps, no raw strings that could carry sensitive content.
//
// HONESTY: the posture labels truthfully describe the FUTURE C-02 design (DEV-only, default-off,
// production-disabled, read-only, no-mutation, code/config-only, no-live-read) and the CURRENT M8C
// reality (route NOT registered, UI NOT implemented, read model only). It never claims a route,
// adapter, UI, live API, or production readiness exists.

// ---------------------------------------------------------------------------
// Schema / source-mode / freshness / warning constants (bounded safe labels only).
// ---------------------------------------------------------------------------
export const C02_REGISTRY_SCHEMA_VERSION_V1 = 'bcp.c02.registry-readiness.v1-code-config';
export const C02_REGISTRY_SCHEMA_VERSION_V0 = 'bcp.c02.registry-readiness.v0-synthetic';

export type C02SourceMode = 'code_config' | 'synthetic';

const FRESHNESS_BY_MODE: Record<C02SourceMode, string> = {
  code_config: 'code-config-no-live-read',
  synthetic: 'synthetic-no-live-read',
};
const SCHEMA_BY_MODE: Record<C02SourceMode, string> = {
  code_config: C02_REGISTRY_SCHEMA_VERSION_V1,
  synthetic: C02_REGISTRY_SCHEMA_VERSION_V0,
};
const WARNING_BY_MODE: Record<C02SourceMode, string> = {
  code_config: 'code_config',
  synthetic: 'synthetic',
};

/** Fixed, deterministic synthetic/dev stamp — never a wall-clock value that could correlate identity/env. */
const C02_GENERATED_AT = '2026-01-01T00:00:00.000Z';

// ---------------------------------------------------------------------------
// Local types (defined here; shared types are NOT modified). The four valid module
// statuses mirror src `ModuleStatus` by VALUE only — no cross-boundary import.
// ---------------------------------------------------------------------------
export type C02ModuleStatus = 'included' | 'placeholder' | 'deferred' | 'blocked';
/** Safe enum fallback for an unrecognized/hostile status (never the raw value). */
export type C02ModuleStatusLabel = C02ModuleStatus | 'unknown';

/** Untrusted input shape (fields are `unknown` so malformed/hostile values are exercised + sanitized). */
export interface C02RegistryModuleInput {
  id?: unknown;
  name?: unknown;
  status?: unknown;
}

/** Safe, bounded per-module readiness item — labels / enums / booleans only. */
export interface C02RegistryItem {
  moduleKey: string;
  moduleLabel: string;
  moduleStatus: C02ModuleStatusLabel;
  sourceMode: C02SourceMode;
  routeBoundaryCategory: string;
  devGatePosture: string;
  productionPosture: string;
  readOnlyPosture: boolean;
  mutationPosture: string;
  testCoveragePosture: string;
  dtoSchemaPosture: string;
  uiPreviewPosture: string;
  dataSourceClass: string;
  redactionPosture: string;
  rbacVisibilityPosture: string;
  implementationStatus: string;
  evidenceStatus: string;
}

export interface C02SummaryCounts {
  total: number;
  included: number;
  placeholder: number;
  deferred: number;
  blocked: number;
  unknown: number;
}

export interface C02EmptyState {
  isEmpty: boolean;
  reason: string;
}

export interface C02RegistryReadinessEnvelope {
  schemaVersion: string;
  sourceMode: C02SourceMode;
  generatedAt: string;
  freshness: { lastSuccessfulReadLabel: string };
  summaryCounts: C02SummaryCounts;
  registryItems: C02RegistryItem[];
  emptyState: C02EmptyState;
  warnings: string[];
  redactionPosture: string;
  routePosture: string;
  productionPosture: string;
  mutationPosture: string;
  evidenceLabels: string[];
}

export interface BuildC02Options {
  /** `code_config` (default) emits the v1 envelope; `synthetic` emits the v0 compatibility envelope. */
  mode?: C02SourceMode;
}

// ---------------------------------------------------------------------------
// Safe-label strategy (self-contained; mirrors the frozen C-01 hardening:
// charset + whitespace guard + forbidden-substring denylist + id-shape guard).
// ---------------------------------------------------------------------------
const SAFE_LABEL_RE = /^[A-Za-z0-9_.\- ]{1,64}$/;
const REDACTED = 'redacted_label';
/** Case-insensitive markers that, if present, force redaction even when the charset/length pass.
 * Includes secret/token keywords, secret/raw-identifier prefixes, and the sensitive ROW/KEY shape
 * markers in their snake/underscore form (e.g. `tenant_…`, `audit_…`, `permission_…`) — these signal a
 * raw identifier/row/key, never a human-readable module label, so real kebab module keys never match. */
const FORBIDDEN_SUBSTRINGS = [
  '://', '@', 'bearer', 'eyj', 'service_role', 'secret', 'token', 'password',
  'postgres', 'supabase', 'apikey', 'api_key',
  // secret / raw-identifier prefixes (with their separator)
  'sk_', 'sk-', 'pk_', 'pk-', 'rk_', 'ak_', 'cus_', 'acct_', 'usr_', 'txn_', 'tok_', 'card_',
  // sensitive row/key/id shape markers in snake form (the leak vector — not bare human-label words)
  'tenant_', 'store_', 'customer_', 'identity_link', 'identitylink', 'provider_uid', 'internal_user',
  'audit_', 'permission_', 'entitlement_', 'mismatch_',
];
/** UUID shape is treated as a raw identifier and redacted (module keys are kebab words). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A 16+ char contiguous alphanumeric run is token/key/raw-id shaped — real kebab module keys never are. */
const LONG_ALNUM_RUN_RE = /[A-Za-z0-9]{16,}/;
/** A 4+ digit run is identifier/number-shaped (raw IDs, card/phone fragments) — module keys have none. */
const DIGIT_RUN_RE = /\d{4,}/;
/** A multi-label dotted host (e.g. a.b.co) is domain-shaped — redact (module keys/names have no dots). */
const DOMAINISH_RE = /\.[a-z0-9-]+\.[a-z]{2,}/i;
/** A source-file extension is a raw filename — redact (never expose source filenames). */
const FILE_EXT_RE = /\.(ts|tsx|js|jsx|mjs|cjs|json|env|key|pem|sql|sh|ya?ml|toml|lock)$/i;

/** Returns a safe bounded label, or the `redacted_label` sentinel when the value is unsafe to emit. */
function safeLabel(value: unknown): string {
  if (typeof value !== 'string') return REDACTED;
  if (value.trim() === '') return REDACTED;
  if (!SAFE_LABEL_RE.test(value)) return REDACTED;
  const lower = value.toLowerCase();
  for (const bad of FORBIDDEN_SUBSTRINGS) if (lower.includes(bad)) return REDACTED;
  if (
    UUID_RE.test(value) ||
    LONG_ALNUM_RUN_RE.test(value) ||
    DIGIT_RUN_RE.test(value) ||
    DOMAINISH_RE.test(value) ||
    FILE_EXT_RE.test(value)
  ) {
    return REDACTED;
  }
  return value;
}

const VALID_STATUS = new Set<C02ModuleStatus>(['included', 'placeholder', 'deferred', 'blocked']);
/** Normalize an untrusted status to a known enum or the safe `unknown` fallback (never the raw value). */
function normalizeStatus(value: unknown): C02ModuleStatusLabel {
  return typeof value === 'string' && VALID_STATUS.has(value as C02ModuleStatus)
    ? (value as C02ModuleStatus)
    : 'unknown';
}

/** Read `options.mode` defensively — a throwing getter/proxy must not abort the build. */
function readMode(options: unknown): C02SourceMode {
  try {
    const mode = options && typeof options === 'object' ? (options as BuildC02Options).mode : undefined;
    return mode === 'synthetic' ? 'synthetic' : 'code_config';
  } catch {
    return 'code_config';
  }
}

/** Read a single untrusted field defensively — a throwing getter/proxy yields `undefined`, never a throw. */
function readField(obj: object, key: 'id' | 'name' | 'status'): unknown {
  try {
    return (obj as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Builder — PURE + NO-THROW + DETERMINISTIC.
// ---------------------------------------------------------------------------

/**
 * Build the C-02 registry-readiness DTO envelope from a code/config/static module registry.
 * PURE, SYNCHRONOUS, NO-THROW, DETERMINISTIC. Reads only id/name/status; sanitizes every field;
 * emits only bounded labels/enums/booleans/counts. Non-array input and non-object entries are
 * handled safely (no throw, no invented modules).
 */
export function buildC02RegistryReadinessEnvelope(
  modules: readonly C02RegistryModuleInput[],
  options?: BuildC02Options,
): C02RegistryReadinessEnvelope {
  const mode = readMode(options);
  // Array.isArray guarantees a genuine array, so indexed access below cannot be hijacked by a poisoned
  // Symbol.iterator; per-entry try/catch still contains any throwing index/field getter.
  const list: readonly unknown[] = Array.isArray(modules) ? modules : [];

  const registryItems: C02RegistryItem[] = [];
  for (let idx = 0; idx < list.length; idx++) {
    let item: C02RegistryItem | null = null;
    try {
      const entry = list[idx];
      // No-throw: skip null / non-object / array entries rather than inventing or coercing a module.
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      item = {
        moduleKey: safeLabel(readField(entry, 'id')),
        moduleLabel: safeLabel(readField(entry, 'name')),
        moduleStatus: normalizeStatus(readField(entry, 'status')),
        sourceMode: mode,
        routeBoundaryCategory: 'dev_isolated_api',
        devGatePosture: 'dev_only_default_off',
        productionPosture: 'production_disabled',
        readOnlyPosture: true,
        mutationPosture: 'none',
        testCoveragePosture: 'planned',
        dtoSchemaPosture: mode === 'synthetic' ? 'v0_synthetic' : 'v1_code_config',
        uiPreviewPosture: 'not_implemented',
        dataSourceClass: mode,
        redactionPosture: 'safe_labels_only',
        rbacVisibilityPosture: 'system_owner_only',
        implementationStatus: 'read_model_only',
        evidenceStatus: 'read_model_tests',
      };
    } catch {
      // Hostile entry (throwing getter / revoked proxy) → skip it; never throw or leak a raw error.
      item = null;
    }
    if (item) registryItems.push(item);
  }

  const summaryCounts: C02SummaryCounts = {
    total: registryItems.length,
    included: registryItems.filter((i) => i.moduleStatus === 'included').length,
    placeholder: registryItems.filter((i) => i.moduleStatus === 'placeholder').length,
    deferred: registryItems.filter((i) => i.moduleStatus === 'deferred').length,
    blocked: registryItems.filter((i) => i.moduleStatus === 'blocked').length,
    unknown: registryItems.filter((i) => i.moduleStatus === 'unknown').length,
  };

  const isEmpty = registryItems.length === 0;

  return {
    schemaVersion: SCHEMA_BY_MODE[mode],
    sourceMode: mode,
    generatedAt: C02_GENERATED_AT,
    freshness: { lastSuccessfulReadLabel: FRESHNESS_BY_MODE[mode] },
    summaryCounts,
    registryItems,
    emptyState: isEmpty ? { isEmpty: true, reason: 'no_modules' } : { isEmpty: false, reason: 'none' },
    warnings: [WARNING_BY_MODE[mode]],
    redactionPosture: 'safe_labels_only',
    // Honest M8C posture: the route is NOT registered in this milestone; it is only PLANNED, DEV-only.
    routePosture: 'not_registered_dev_only_planned',
    productionPosture: 'production_disabled',
    mutationPosture: 'none',
    // Bounded safe labels truthfully describing the M8C posture (no live read; nothing wired).
    evidenceLabels: [
      'code_config_only',
      'no_live_source',
      'read_only',
      'no_mutation',
      'production_disabled',
      'dev_only',
      'no_external_source',
      'route_not_registered',
      'ui_not_implemented',
      'read_model_only',
    ],
  };
}

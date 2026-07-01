// Phase 2.0 M33 — Safe server-owned C-07 Data Source Boundary Readiness DECLARED-POSTURE provider +
// fitness functions.
//
// WHAT THIS IS: a PURE, server-owned, code/config-only source of the SEVEN accepted Backend-CP boundary keys
// with safe bounded DECLARED postures. It is NOT a live verifier, drift detector, scanner, diagnostics
// surface, value oracle, or production-readiness claim, and does NOT inspect process.env, the filesystem, the
// clock, packages, the network, DB/SQL/Supabase/live providers, or any command output — it is a hand-curated,
// allow-listed compiled constant, mirroring the proven C-02..C-06 provider pattern.
//
// BINDING SAFETY:
//   - PURE + DETERMINISTIC + NO-THROW + side-effect-free. No I/O. No DB/SQL/Supabase/Supabase-MCP/live
//     provider/network/fetch/filesystem. NO process.env read for output, NO process.env enumeration, NO
//     command execution, NO package/dependency read, NO file-path read, NO clock read. No request. No auth.
//     No tenant/store/customer/identity/audit. No mutation. No backend action.
//   - Emits ONLY the SEVEN accepted boundary keys with safe bounded declared postures. NEVER a raw DB/table/
//     SQL/Supabase/URL/key/token/credential/identifier/permission/env/path/package/version/command/stack/
//     diagnostic/production-endpoint/provider value, and NEVER a runtime timestamp (`generatedAt` is
//     permanently excluded) or a production-readiness claim.
//   - No import from src/ (the client bundle); no route/adapter/registration/guard/matrix/server/auth/audit/
//     identity/session/DB/Supabase/network/filesystem/process import (M32 §14 import boundary).
//   - Deeply frozen constant + defensive-copy getter. SIX ENFORCED fitness functions mechanically prove the
//     boundary-key allow-list, the recursive output-key allow-list (incl. the `generatedAt`/timestamp ban),
//     the value-content closed-set gate, determinism/no-timestamp invariance, the production-readiness-claim
//     ban, and the self-attestation / non-verifier framing.

import {
  C07_BOUNDARY_KEYS,
  C07_BOUNDARY_LABELS,
  C07_BOUNDARY_PURPOSES,
  C07_OWNER_SURFACE_BY_KEY,
  C07_ALLOWED_EMITTED_VALUES,
  C07_SELF_ATTESTATION,
  buildC07DataSourceBoundaryEnvelope,
  type C07BoundaryItem,
  type C07BoundaryKey,
} from './bcpC07DataSourceBoundaryReadModel';

// Uniform DECLARED posture carried by every boundary item (only key/label/purpose/owner-surface vary). Every
// absence posture is the DECLARED `asserted_absent_code_config` — a design-time self-attestation, never a
// live-verification result. Static, so the bounded counts are constant and never a live result.
const DECLARED_POSTURE: Omit<
  C07BoundaryItem,
  'boundaryKey' | 'boundaryLabel' | 'boundaryPurpose' | 'ownerSurface'
> = {
  sourceMode: 'code_config',
  dataSourcePosture: 'code_config_only',
  dbPosture: 'asserted_absent_code_config',
  sqlPosture: 'asserted_absent_code_config',
  supabasePosture: 'asserted_absent_code_config',
  liveProviderPosture: 'asserted_absent_code_config',
  runtimeEnvPosture: 'asserted_absent_code_config',
  commandOutputPosture: 'asserted_absent_code_config',
  diagnosticsPosture: 'asserted_absent_code_config',
  rawEvidencePosture: 'asserted_absent_code_config',
  valueOraclePosture: 'no_value_oracle',
  productionPosture: 'production_disabled',
  mutationPosture: 'mutation_blocked',
  customerExposurePosture: 'no_customer_exposure',
  evidenceStatus: 'asserted_within_boundary',
};

// Server-authored, code/config declared-posture registry — ONLY the seven accepted boundary keys, in fixed
// order, with label/purpose/owner-surface DERIVED from the locked maps.
const ENTRIES: readonly C07BoundaryItem[] = C07_BOUNDARY_KEYS.map((boundaryKey) => ({
  boundaryKey,
  boundaryLabel: C07_BOUNDARY_LABELS[boundaryKey],
  boundaryPurpose: C07_BOUNDARY_PURPOSES[boundaryKey],
  ownerSurface: C07_OWNER_SURFACE_BY_KEY[boundaryKey],
  ...DECLARED_POSTURE,
}));

/** The server-owned C-07 declared boundary-item registry, DEEPLY FROZEN. Safe bounded declared postures +
 *  allow-listed boundary keys only. Read via getBcpC07DataSourceBoundaryItems() for a copy. */
export const BCP_C07_DATA_SOURCE_BOUNDARY_ITEMS: readonly Readonly<C07BoundaryItem>[] =
  Object.freeze(ENTRIES.map((e) => Object.freeze({ ...e })));

/**
 * Return the server-owned C-07 declared boundary items as a FRESH defensive copy. PURE, DETERMINISTIC,
 * NO-THROW. Takes NO arguments and reads NO env/request/global/live/filesystem/clock state. Mutating the
 * result never affects the constant or a later call.
 */
export function getBcpC07DataSourceBoundaryItems(): C07BoundaryItem[] {
  return BCP_C07_DATA_SOURCE_BOUNDARY_ITEMS.map((e) => ({ ...e }));
}

// ===========================================================================
// FITNESS FUNCTION 1 — ENFORCED BOUNDARY-KEY ALLOW-LIST.
// ===========================================================================
const BOUNDARY_KEY_SHAPE_RE = /^[a-z0-9_]+$/;
// Substrings that must NEVER appear in a boundary KEY (a key must not encode a secret, credential, DB/
// Supabase target, provider, or identity).
const BOUNDARY_KEY_DENY = [
  'tenant', 'store', 'customer', 'secret', 'token', 'password', 'credential', 'apikey', 'api_key',
  'private_key', 'privatekey', 'url', 'supabase', 'postgres', 'database', 'connection', 'auth', 'rbac',
  'permission', 'stdout', 'stderr',
];

/**
 * ENFORCED ALLOW-LIST FITNESS FUNCTION. Mechanically proves the C-07 registry exposes ONLY the seven accepted
 * boundary keys, in the fixed order, with index-aligned canonical tuples (key <-> label <-> purpose <->
 * ownerSurface), each key shaped safely and free of secret/identity/DB/Supabase substrings. THROWS with a
 * descriptive message on ANY violation. Not on the no-throw data path. Accepts an optional items array so
 * tests can prove a tampered set is rejected.
 */
export function assertBcpC07BoundaryKeyAllowList(
  items: readonly C07BoundaryItem[] = getBcpC07DataSourceBoundaryItems(),
): void {
  if (!Array.isArray(items)) {
    throw new Error('C-07 boundary-key allow-list violation(s): items is not an array');
  }
  const violations: string[] = [];
  if (items.length !== C07_BOUNDARY_KEYS.length) {
    violations.push(`expected exactly ${C07_BOUNDARY_KEYS.length} items, got ${items.length}`);
  }
  const seen = new Set<string>();
  for (let i = 0; i < items.length; i++) {
    const e = items[i];
    if (!e || typeof e !== 'object') { violations.push('non-object item'); continue; }
    const expectedKey = C07_BOUNDARY_KEYS[i];
    if (expectedKey !== undefined && e.boundaryKey !== expectedKey) {
      violations.push(`boundary key out of fixed order at index ${i} (${safeDescribe(e.boundaryKey)})`);
    }
    const key = e.boundaryKey as C07BoundaryKey;
    if (typeof e.boundaryKey !== 'string' || !(key in C07_BOUNDARY_LABELS)) {
      violations.push(`boundary key not allow-listed at index ${i} (${safeDescribe(e.boundaryKey)})`);
    } else {
      if (e.boundaryLabel !== C07_BOUNDARY_LABELS[key]) violations.push(`boundary label mismatch for ${key}`);
      if (e.boundaryPurpose !== C07_BOUNDARY_PURPOSES[key]) violations.push(`boundary purpose mismatch for ${key}`);
      if (e.ownerSurface !== C07_OWNER_SURFACE_BY_KEY[key]) violations.push(`owner surface mismatch for ${key}`);
    }
    if (typeof e.boundaryKey !== 'string' || !BOUNDARY_KEY_SHAPE_RE.test(e.boundaryKey)) {
      violations.push(`boundary key unsafe shape at index ${i} (${safeDescribe(e.boundaryKey)})`);
    } else {
      const lower = e.boundaryKey.toLowerCase();
      for (const bad of BOUNDARY_KEY_DENY) if (lower.includes(bad)) violations.push(`boundary key contains forbidden substring "${bad}" at index ${i}`);
    }
    if (typeof e.boundaryKey === 'string' && seen.has(e.boundaryKey)) violations.push(`duplicate boundary key at index ${i}`);
    if (typeof e.boundaryKey === 'string') seen.add(e.boundaryKey);
  }
  for (const k of C07_BOUNDARY_KEYS) if (!seen.has(k)) violations.push(`missing accepted boundary key: ${k}`);

  if (violations.length > 0) {
    throw new Error(`C-07 boundary-key allow-list violation(s): ${violations.join('; ')}`);
  }
}

// ===========================================================================
// FITNESS FUNCTION 2 — ENFORCED RECURSIVE OUTPUT-KEY ALLOW-LIST (incl. the generatedAt / timestamp ban).
// ===========================================================================
// The ONLY object keys C-07 output may contain, at any depth (envelope + summaryCounts + boundary item).
export const C07_ALLOWED_OUTPUT_KEYS: ReadonlySet<string> = new Set<string>([
  // envelope
  'schemaVersion', 'selfAttestation', 'sourceMode', 'freshness', 'summaryCounts', 'boundaryItems',
  'emptyState', 'emptyStateReason', 'warnings', 'redactionPosture', 'productionPosture', 'mutationPosture',
  'dataSourcePosture', 'logExposurePosture', 'valueOraclePosture', 'evidenceLabels',
  // summaryCounts (16)
  'total', 'codeConfigOnly', 'syntheticOnly', 'noDb', 'noSql', 'noSupabase', 'noLiveProvider',
  'noRuntimeEnvValues', 'noRawDiagnostics', 'noCommandOutput', 'productionDisabled', 'readOnly',
  'mutationBlocked', 'valueOracleBlocked', 'customerExposureBlocked', 'unknownRedacted',
  // boundary item — the 14 keys not already listed in the envelope block above; the other 5 item fields
  // (sourceMode, dataSourcePosture, valueOraclePosture, productionPosture, mutationPosture) are shared with
  // the envelope entries, so the union covers all 19 item fields.
  'boundaryKey', 'boundaryLabel', 'boundaryPurpose', 'ownerSurface', 'dbPosture', 'sqlPosture',
  'supabasePosture', 'liveProviderPosture', 'runtimeEnvPosture', 'commandOutputPosture', 'diagnosticsPosture',
  'rawEvidencePosture', 'customerExposurePosture', 'evidenceStatus',
]);

// Safe descriptor for a rejected/untrusted value — NEVER echoes the raw value into a thrown message (the lens
// forbids any diagnostics/leakage surface, even on the assertion-failure path). Reports type + length only.
function safeDescribe(v: unknown): string {
  if (typeof v === 'string') return `string[len=${v.length}]`;
  if (v === null) return 'null';
  if (Array.isArray(v)) return `array[len=${v.length}]`;
  return typeof v;
}

// Keys (case-insensitive) that must NEVER appear in C-07 output at any depth — runtime timestamps, raw
// evidence / logs / command output / diagnostics / paths / packages / process details / secrets / identity.
export const C07_PROHIBITED_OUTPUT_KEYS: ReadonlySet<string> = new Set<string>([
  'generatedat', 'timestamp', 'createdat', 'updatedat', 'time', 'datetime', 'clock', 'now',
  'log', 'logs', 'rawlog', 'rawlogs', 'output', 'rawoutput', 'commandoutput', 'stdout', 'stderr',
  'stack', 'stacktrace', 'error', 'rawerror', 'exception', 'details', 'metadata', 'diagnostics',
  'runtime', 'runtimestate', 'build', 'buildoutput', 'command', 'shell',
  'file', 'files', 'filepath', 'path', 'paths', 'filename', 'sourcepath', 'line', 'column',
  'package', 'packages', 'dependency', 'dependencies', 'version', 'versions',
  'artifact', 'artifacts', 'trace', 'traces', 'raw',
  'env', 'secret', 'token', 'credential', 'password', 'privatekey', 'apikey',
  'url', 'domain', 'databaseurl', 'supabaseurl', 'authprovider',
  'tenantid', 'storeid', 'userid', 'email', 'permission', 'permissions', 'rbac',
  'connection', 'connectionstring', 'pid', 'port', 'socket',
]);

const MAX_OUTPUT_DEPTH = 4;

/**
 * ENFORCED RECURSIVE OUTPUT-KEY ALLOW-LIST FITNESS FUNCTION. Path-aware, recursive, bounded to depth 4,
 * ATOMIC FAIL-CLOSED. Mechanically proves a structure contains ONLY frozen, allow-listed object keys at every
 * depth — and NO prohibited key (runtime timestamp / raw log / command output / stack / diagnostics / path /
 * package / process detail / secret / identity). THROWS with the offending path(s). Over-depth => fail
 * closed. Not on the no-throw data path.
 */
export function assertBcpC07OutputKeyAllowList(
  value: unknown = buildC07DataSourceBoundaryEnvelope(getBcpC07DataSourceBoundaryItems()),
): void {
  const violations: string[] = [];
  const walk = (node: unknown, path: string, depth: number): void => {
    if (node === null || typeof node !== 'object') return;
    if (depth > MAX_OUTPUT_DEPTH) { violations.push(`over-depth (>${MAX_OUTPUT_DEPTH}) at ${path}`); return; }
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) walk(node[i], `${path}[${i}]`, depth + 1);
      return;
    }
    for (const key of Object.keys(node as Record<string, unknown>)) {
      const p = `${path}.${key}`;
      // Report the SAFE parent path + a redacted descriptor of the offending key, never the raw key string.
      if (C07_PROHIBITED_OUTPUT_KEYS.has(key.toLowerCase())) violations.push(`prohibited output key ${safeDescribe(key)} at ${path}`);
      else if (!C07_ALLOWED_OUTPUT_KEYS.has(key)) violations.push(`non-allow-listed output key ${safeDescribe(key)} at ${path}`);
      let child: unknown;
      try { child = (node as Record<string, unknown>)[key]; } catch { child = undefined; }
      walk(child, p, depth + 1);
    }
  };
  walk(value, '$', 0);
  if (violations.length > 0) {
    throw new Error(`C-07 output-key allow-list violation(s): ${violations.join('; ')}`);
  }
}

// ===========================================================================
// FITNESS FUNCTION 3 — VALUE-CONTENT CLOSED-SET GATE.
// ===========================================================================
// Named-threat detectors — classify WHY a non-allow-listed string is unsafe (for reporting only; the closed
// allow-list membership is the actual gate, so legitimately-emitted labels never reach these).
const C07_THREAT_DETECTORS: { name: string; re: RegExp }[] = [
  { name: 'url', re: /:\/\// },
  { name: 'email_or_at', re: /@/ },
  { name: 'path', re: /\// },
  { name: 'db_or_supabase', re: /supabase|postgres|service_role|\bdatabase\b|\bsql\b/i },
  { name: 'secret_or_token', re: /\bsecret\b|\btoken\b|bearer|\bpassword\b|api[_-]?key|eyj|sk_live/i },
  { name: 'std_stream', re: /\b(stdout|stderr)\b/i },
  { name: 'command', re: /\b(npm|npx|tsx|node|bash|git|sudo|curl|wget|grep|chmod)\b|&&|\|\||\$\(|`/i },
  { name: 'file_extension', re: /\.(ts|tsx|js|jsx|json|env|key|pem|sql|sh|ya?ml|toml|lock|log|txt|md)\b/i },
  { name: 'runtime_timestamp', re: /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/ },
  { name: 'long_hex', re: /\b[0-9a-f]{7,}\b/i },
];

function collectStringsDeep(value: unknown, acc: string[], depth = 0): void {
  if (depth > 8 || value === null) return;
  if (typeof value === 'string') { acc.push(value); return; }
  if (typeof value !== 'object') return;
  if (Array.isArray(value)) { for (const v of value) collectStringsDeep(v, acc, depth + 1); return; }
  for (const k of Object.keys(value as Record<string, unknown>)) {
    try { collectStringsDeep((value as Record<string, unknown>)[k], acc, depth + 1); } catch { /* throwing getter */ }
  }
}

/**
 * ENFORCED VALUE-CONTENT CLOSED-SET GATE. Recursively inspects EVERY emitted string value and THROWS if any
 * is NOT a member of the canonical C07_ALLOWED_EMITTED_VALUES set (an exact closed-set gate — no path / URL /
 * token / DB / Supabase / live-provider / env / package / timestamp value can pass on its own merit). Any
 * non-member is additionally classified by the named-threat detectors for a safe, non-leaking report. Not on
 * the no-throw data path.
 */
export function assertBcpC07ValueContentSafety(
  value: unknown = buildC07DataSourceBoundaryEnvelope(getBcpC07DataSourceBoundaryItems()),
): void {
  const strings: string[] = [];
  collectStringsDeep(value, strings);
  const violations: string[] = [];
  for (const s of strings) {
    if (C07_ALLOWED_EMITTED_VALUES.has(s)) continue;
    const classes = C07_THREAT_DETECTORS.filter((d) => d.re.test(s)).map((d) => d.name);
    // Report the threat CLASSIFICATION + a redacted descriptor, never the raw offending value.
    violations.push(`non-allow-listed emitted value [${classes.join(',') || 'unclassified'}] (${safeDescribe(s)})`);
  }
  if (violations.length > 0) {
    throw new Error(`C-07 value-content violation(s): ${violations.join('; ')}`);
  }
}

// ===========================================================================
// FITNESS FUNCTION 4 — DETERMINISM / NO-TIMESTAMP INVARIANCE.
// ===========================================================================
const ISO_TIMESTAMP_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const TIMESTAMP_KEYS = new Set<string>(['generatedat', 'timestamp', 'createdat', 'updatedat', 'time', 'datetime', 'now', 'clock']);

/**
 * ENFORCED DETERMINISM / NO-TIMESTAMP FITNESS FUNCTION. Proves the built envelope is DETERMINISTIC across
 * calls AND carries NO `generatedAt`/runtime-timestamp key at any depth and NO ISO-timestamp string value —
 * i.e. it cannot vary with the runtime clock because it reads none. THROWS on any non-determinism or any
 * timestamp. (The companion test additionally mutates process.env / the clock around these calls to prove
 * byte-identical output.) Not on the no-throw data path.
 */
export function assertBcpC07DeterminismNoTimestamp(): void {
  const violations: string[] = [];
  const build = () => buildC07DataSourceBoundaryEnvelope(getBcpC07DataSourceBoundaryItems());
  const e1 = JSON.stringify(build());
  const e2 = JSON.stringify(build());
  if (e1 !== e2) violations.push('built envelope is not deterministic across calls');
  if (JSON.stringify(buildC07DataSourceBoundaryEnvelope([])) !== JSON.stringify(buildC07DataSourceBoundaryEnvelope([]))) {
    violations.push('empty-input envelope is not deterministic across calls');
  }
  const env = build() as unknown as Record<string, unknown>;
  if ('generatedAt' in env) violations.push('envelope carries a generatedAt field');

  const walkKeys = (node: unknown, depth: number): void => {
    if (node === null || typeof node !== 'object' || depth > 8) return;
    if (Array.isArray(node)) { for (const v of node) walkKeys(v, depth + 1); return; }
    for (const k of Object.keys(node as Record<string, unknown>)) {
      if (TIMESTAMP_KEYS.has(k.toLowerCase())) violations.push(`timestamp-shaped key (${safeDescribe(k)})`);
      walkKeys((node as Record<string, unknown>)[k], depth + 1);
    }
  };
  walkKeys(build(), 0);

  const strings: string[] = [];
  collectStringsDeep(build(), strings);
  for (const s of strings) if (ISO_TIMESTAMP_RE.test(s)) violations.push(`ISO-timestamp string value (${safeDescribe(s)})`);

  if (violations.length > 0) {
    throw new Error(`C-07 determinism/no-timestamp violation(s): ${violations.join('; ')}`);
  }
}

// ===========================================================================
// FITNESS FUNCTION 5 — PRODUCTION-READINESS-CLAIM BAN.
// ===========================================================================
const READINESS_CLAIM_PHRASES = [
  'production ready', 'ready for production', 'ready for customer', 'customer ready',
  'fully certified', 'fully compliant', 'all quality gates passed', 'no risk',
  'complete assurance', 'production approved', 'phase 3 ready', 'phase 4 ready',
  'safe to deploy', 'ready to ship', 'ship it', 'go live', 'ready for release',
  'release ready', 'good to go', 'deploy to production', 'ready to release', 'verified within boundary',
];
function normalizeForClaim(s: string): string {
  return s.toLowerCase().replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function isProductionReadinessClaim(value: string): boolean {
  const n = normalizeForClaim(value);
  return READINESS_CLAIM_PHRASES.some((p) => n.includes(p));
}

/**
 * ENFORCED PRODUCTION-READINESS-CLAIM BAN. Recursively inspects every emitted string value and THROWS if any
 * states/implies production/customer readiness, certification, full compliance, no-risk, or Phase 3/4
 * readiness. Allowed non-readiness postures (production_disabled, no_customer_exposure, ...) pass. Not on the
 * no-throw data path.
 */
export function assertBcpC07ProductionReadinessClaimBan(
  value: unknown = buildC07DataSourceBoundaryEnvelope(getBcpC07DataSourceBoundaryItems()),
): void {
  const strings: string[] = [];
  collectStringsDeep(value, strings);
  const offenders = strings.filter(isProductionReadinessClaim);
  if (offenders.length > 0) {
    // Count only — never echo the offending claim string(s).
    throw new Error(`C-07 production-readiness-claim violation(s): ${offenders.length} claim string(s) detected`);
  }
}

// ===========================================================================
// FITNESS FUNCTION 6 — SELF-ATTESTATION / NON-VERIFIER FRAMING.
// ===========================================================================
// Tokens implying LIVE verification / drift detection / scanning — C-07 is a DECLARED self-attestation and
// must never emit these. (The declared `asserted_*` vocabulary and `no_live_source` negation do NOT match.)
const LIVE_VERIFICATION_TOKENS = ['verified', 'drift_detected', 'live_verified', 'scanner_result', 'live_check', 'confirmed_live'];

/**
 * ENFORCED SELF-ATTESTATION / NON-VERIFIER FRAMING FITNESS FUNCTION. Proves (a) the envelope carries the fixed
 * `selfAttestation = design_time_code_config`; (b) every boundary item's evidenceStatus is a declared status
 * (`asserted_within_boundary` / `redacted` / `unknown_redacted`), never an affirmative live-verification
 * status; and (c) no emitted string implies live verification / drift detection / scanning. THROWS on any
 * violation. Not on the no-throw data path.
 */
export function assertBcpC07SelfAttestationFraming(
  value: unknown = buildC07DataSourceBoundaryEnvelope(getBcpC07DataSourceBoundaryItems()),
): void {
  const violations: string[] = [];
  const env = value as { selfAttestation?: unknown; boundaryItems?: unknown };
  if (env.selfAttestation !== C07_SELF_ATTESTATION) {
    violations.push(`selfAttestation is not the fixed ${C07_SELF_ATTESTATION} (${safeDescribe(env.selfAttestation)})`);
  }
  const items = Array.isArray(env.boundaryItems) ? env.boundaryItems : [];
  for (const it of items) {
    const status = (it as { evidenceStatus?: unknown })?.evidenceStatus;
    if (status !== 'asserted_within_boundary' && status !== 'redacted' && status !== 'unknown_redacted') {
      violations.push(`non-declared evidenceStatus (${safeDescribe(status)})`);
    }
  }
  const strings: string[] = [];
  collectStringsDeep(value, strings);
  for (const s of strings) {
    const lower = s.toLowerCase();
    // `tok` is a known safe marker; never echo the raw string `s`.
    for (const tok of LIVE_VERIFICATION_TOKENS) if (lower.includes(tok)) violations.push(`live-verification token "${tok}" (${safeDescribe(s)})`);
  }
  if (violations.length > 0) {
    throw new Error(`C-07 self-attestation framing violation(s): ${violations.join('; ')}`);
  }
}

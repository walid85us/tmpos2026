// Phase 2.0 M33 — Tests for the PURE C-07 data-source-boundary read model / DTO builder (FIRST redaction
// boundary). Covers the 20 mandatory read-model cases (R1..R20) locked in M32 §16, plus no-throw / structural
// safety extras. Safe assertion messages only — no raw output is echoed on failure.
import assert from 'node:assert/strict';
import {
  buildC07DataSourceBoundaryEnvelope,
  enforceC07WarningCap,
  enforceC07EvidenceLabelCap,
  C07_DATA_SOURCE_BOUNDARY_SCHEMA_VERSION_V1,
  C07_SELF_ATTESTATION,
  C07_BOUNDARY_KEYS,
  C07_BOUNDARY_LABELS,
  C07_BOUNDARY_PURPOSES,
  C07_OWNER_SURFACE_BY_KEY,
  C07_MAX_EVIDENCE_LABELS,
  C07_MAX_WARNINGS,
  type C07BoundaryItemInput,
  type C07Warning,
  type C07EvidenceLabel,
} from './bcpC07DataSourceBoundaryReadModel';
import {
  getBcpC07DataSourceBoundaryItems,
  assertBcpC07OutputKeyAllowList,
  assertBcpC07ValueContentSafety,
  assertBcpC07ProductionReadinessClaimBan,
  assertBcpC07SelfAttestationFraming,
} from './bcpC07DataSourceBoundaryProvider';

const ITEM_KEYS = [
  'boundaryKey', 'boundaryLabel', 'boundaryPurpose', 'ownerSurface', 'sourceMode', 'dataSourcePosture',
  'dbPosture', 'sqlPosture', 'supabasePosture', 'liveProviderPosture', 'runtimeEnvPosture',
  'commandOutputPosture', 'diagnosticsPosture', 'rawEvidencePosture', 'valueOraclePosture',
  'productionPosture', 'mutationPosture', 'customerExposurePosture', 'evidenceStatus',
].sort();
const SUMMARY_KEYS = [
  'total', 'codeConfigOnly', 'syntheticOnly', 'noDb', 'noSql', 'noSupabase', 'noLiveProvider',
  'noRuntimeEnvValues', 'noRawDiagnostics', 'noCommandOutput', 'productionDisabled', 'readOnly',
  'mutationBlocked', 'valueOracleBlocked', 'customerExposureBlocked', 'unknownRedacted',
].sort();
const EXPECTED_COUNTS = {
  total: 7, codeConfigOnly: 7, syntheticOnly: 0, noDb: 7, noSql: 7, noSupabase: 7, noLiveProvider: 7,
  noRuntimeEnvValues: 7, noRawDiagnostics: 7, noCommandOutput: 7, productionDisabled: 7, readOnly: 7,
  mutationBlocked: 7, valueOracleBlocked: 7, customerExposureBlocked: 7, unknownRedacted: 0,
};
const ABSENCE = 'asserted_absent_code_config';

const P = () => getBcpC07DataSourceBoundaryItems();
const build = (x: readonly C07BoundaryItemInput[]) => buildC07DataSourceBoundaryEnvelope(x);
const mk = (key: string): C07BoundaryItemInput => ({ ...P()[0], boundaryKey: key } as C07BoundaryItemInput);

const cases: { name: string; fn: () => void }[] = [];
const test = (n: string, fn: () => void) => cases.push({ name: n, fn });

// --- R1: closed-enum enforcement on every field ---
test('R1 every field of a fully-garbage item normalizes to a closed-set fallback member', () => {
  const g = {
    boundaryKey: 'c02_registry_readiness', sourceMode: 'x', dataSourcePosture: 'x', dbPosture: 'x',
    sqlPosture: 'x', supabasePosture: 'x', liveProviderPosture: 'x', runtimeEnvPosture: 'x',
    commandOutputPosture: 'x', diagnosticsPosture: 'x', rawEvidencePosture: 'x', valueOraclePosture: 'x',
    productionPosture: 'x', mutationPosture: 'x', customerExposurePosture: 'x', evidenceStatus: 'x',
  } as C07BoundaryItemInput;
  const it = build([g]).boundaryItems[0];
  assert.equal(it.sourceMode, 'none');
  for (const v of [it.dataSourcePosture, it.dbPosture, it.sqlPosture, it.supabasePosture, it.liveProviderPosture, it.runtimeEnvPosture, it.commandOutputPosture, it.diagnosticsPosture, it.rawEvidencePosture, it.valueOraclePosture, it.productionPosture, it.mutationPosture, it.customerExposurePosture]) {
    assert.equal(v, 'redacted');
  }
  assert.equal(it.evidenceStatus, 'unknown_redacted');
  assert.equal(it.boundaryLabel, 'C-02 Registry Readiness'); // derived from validated key
  assert.equal(it.ownerSurface, 'bcp_evidence_lens');
});

// --- R2: unknown sourceMode -> none + source_mode_redacted (does NOT count as unknownRedacted) ---
test('R2 unknown sourceMode -> none + source_mode_redacted warning', () => {
  const e = build([{ ...mk('c01_readiness_summary'), sourceMode: 'bogus' } as C07BoundaryItemInput]);
  assert.equal(e.boundaryItems[0].sourceMode, 'none');
  assert.ok(e.warnings.includes('source_mode_redacted'));
  assert.equal(e.summaryCounts.unknownRedacted, 0);
});

// --- R3: unknown boundaryKey -> dropped, not counted, + boundary_key_redacted ---
test('R3 unknown boundaryKey -> dropped + boundary_key_redacted, not counted', () => {
  const e = build([mk('c01_readiness_summary'), { boundaryKey: 'not_a_key' } as C07BoundaryItemInput]);
  assert.equal(e.boundaryItems.length, 1);
  assert.equal(e.summaryCounts.total, 1);
  assert.ok(e.warnings.includes('boundary_key_redacted'));
});

// --- R4: unknown posture value -> redacted + item retained ---
test('R4 unknown posture value -> redacted, item retained, posture_value_redacted', () => {
  const e = build([{ ...mk('c03_ui_coverage_readiness'), dbPosture: 'weird' } as C07BoundaryItemInput]);
  assert.equal(e.boundaryItems.length, 1);
  assert.equal(e.boundaryItems[0].dbPosture, 'redacted');
  assert.ok(e.warnings.includes('posture_value_redacted'));
});

// --- R5: exactly 16 summary keys AND each count equals its derived value ---
test('R5 summaryCounts has exactly the 16 fixed keys', () => assert.deepEqual(Object.keys(build(P()).summaryCounts).sort(), SUMMARY_KEYS));
test('R5 count VALUES equal the §11 derivations for the provider', () => assert.deepEqual(build(P()).summaryCounts, EXPECTED_COUNTS));
test('R5 derivations shift correctly when postures change', () => {
  const items = P();
  (items[0] as unknown as Record<string, unknown>).dbPosture = 'x';
  (items[1] as unknown as Record<string, unknown>).valueOraclePosture = 'x';
  const c = build(items).summaryCounts;
  assert.equal(c.noDb, 6);
  assert.equal(c.valueOracleBlocked, 6);
  assert.equal(c.unknownRedacted, 2);
});

// --- R6: unknownRedacted counts retained field-redacted items only (sourceMode fallback excluded) ---
test('R6 unknownRedacted counts a retained field-redacted item', () => {
  const items = P();
  (items[2] as unknown as Record<string, unknown>).productionPosture = 'nope';
  assert.equal(build(items).summaryCounts.unknownRedacted, 1);
});
test('R6 sourceMode fallback does NOT contribute to unknownRedacted', () => {
  const items = P();
  (items[0] as unknown as Record<string, unknown>).sourceMode = 'nope';
  assert.equal(build(items).summaryCounts.unknownRedacted, 0);
});

// --- R7: discarded unknown keys not counted ---
test('R7 discarded unknown keys are not counted', () => {
  const e = build([mk('c01_readiness_summary'), { boundaryKey: 'bad1' } as C07BoundaryItemInput, { boundaryKey: 'bad2' } as C07BoundaryItemInput]);
  assert.equal(e.summaryCounts.total, 1);
  assert.equal(e.summaryCounts.unknownRedacted, 0);
});

// --- R8: duplicate boundaryKey deduped (first wins) ---
test('R8 duplicate boundaryKey deduped, first occurrence wins', () => {
  const first = mk('c04_route_exposure_readiness');
  const dup = { ...mk('c04_route_exposure_readiness'), dbPosture: 'x' } as C07BoundaryItemInput;
  const e = build([first, dup]);
  assert.equal(e.boundaryItems.length, 1);
  assert.equal(e.boundaryItems[0].dbPosture, ABSENCE); // the valid first item, not the redacted duplicate
  assert.equal(e.summaryCounts.unknownRedacted, 0); // dropped duplicate raises no redaction signal
  assert.ok(!e.warnings.includes('posture_value_redacted'));
});

// --- R9: deterministic ordering ---
test('R9 items are ordered by the fixed key order regardless of input order', () => {
  const reversed = [...C07_BOUNDARY_KEYS].reverse().map(mk);
  assert.deepEqual(build(reversed).boundaryItems.map((i) => i.boundaryKey), [...C07_BOUNDARY_KEYS]);
});

// --- R10: warning-truncation reserves the final cap slot ---
test('R10 enforceC07WarningCap reserves the final warning_count_capped slot', () => {
  const many = Array<C07Warning>(15).fill('no_live_source');
  const capped = enforceC07WarningCap(many);
  assert.equal(capped.length, C07_MAX_WARNINGS);
  assert.equal(capped[capped.length - 1], 'warning_count_capped');
  assert.ok(capped.slice(0, C07_MAX_WARNINGS - 1).every((w) => w === 'no_live_source'));
});
test('R10 within-cap warnings pass through unchanged', () => assert.deepEqual(enforceC07WarningCap(['source_mode_redacted']), ['source_mode_redacted']));

// --- R11: no raw value leakage (injected raw fields stripped) ---
test('R11 injected raw log/path/stack/command fields are STRIPPED (only known fields copied)', () => {
  const e = build([{ ...mk('c05_feature_flag_posture'), log: 'x', filePath: '/etc/passwd', stack: 's', commandOutput: 'y' } as unknown as C07BoundaryItemInput]);
  const it = e.boundaryItems[0] as unknown as Record<string, unknown>;
  for (const bad of ['log', 'filePath', 'stack', 'commandOutput']) assert.ok(!(bad in it), bad);
  assert.doesNotThrow(() => assertBcpC07ValueContentSafety(e));
});

// --- R12: empty-state distinguishes no_live_source vs input_redacted ---
test('R12 empty-state reasons are distinguished across conditions', () => {
  assert.equal(build(P()).emptyStateReason, 'no_live_source'); // non-empty steady state
  const dropped = build([{ boundaryKey: 'bad' } as C07BoundaryItemInput]);
  assert.equal(dropped.emptyState, true);
  assert.equal(dropped.emptyStateReason, 'input_redacted'); // emptied by redaction
  assert.equal(build([]).emptyStateReason, 'no_boundary_items'); // nothing provided
  assert.notEqual(build(P()).emptyStateReason, dropped.emptyStateReason);
});

// --- R13: no value-oracle behavior (output invariant to any prohibited/extra input value) ---
test('R13 output is invariant to injected prohibited input values (no value oracle)', () => {
  const clean = build(P());
  const dirty = build(P().map((i) => ({ ...i, secret: 'leak', filePath: '/etc/passwd', log: 'zzz' }) as unknown as C07BoundaryItemInput));
  assert.deepEqual(dirty, clean);
  assert.doesNotThrow(() => assertBcpC07ValueContentSafety(dirty));
});

// --- R14: no production-readiness claim ---
test('R14 built envelope passes the production-readiness-claim ban', () => assert.doesNotThrow(() => assertBcpC07ProductionReadinessClaimBan(build(P()))));

// --- R15: closed absence-postures present, no raw DB/Supabase/live-provider identifiers ---
test('R15 absence postures present; no raw DB/Supabase/provider identifiers', () => {
  const e = build(P());
  for (const it of e.boundaryItems) { assert.equal(it.dbPosture, ABSENCE); assert.equal(it.supabasePosture, ABSENCE); assert.equal(it.liveProviderPosture, ABSENCE); }
  const j = JSON.stringify(e).toLowerCase();
  for (const bad of ['postgres', 'supabaseurl', 'service_role', 'jdbc', 'mongodb', 'createclient']) assert.ok(!j.includes(bad), bad);
});

// --- R16: deterministic warning construction (fixed precedence + dedup) ---
test('R16 warnings are built in fixed precedence with no duplicates', () => {
  const input = [{ ...mk('c01_readiness_summary'), sourceMode: 'x', dbPosture: 'x' } as C07BoundaryItemInput, { boundaryKey: 'bad' } as C07BoundaryItemInput];
  assert.deepEqual(build(input).warnings, ['source_mode_redacted', 'posture_value_redacted', 'boundary_key_redacted']);
  assert.deepEqual(build(input).warnings, build(input).warnings);
});

// --- R17: boundaryKey -> boundaryLabel mapping ---
test('R17 boundaryKey -> boundaryLabel matches the locked table', () => {
  for (const key of C07_BOUNDARY_KEYS) assert.equal(build([mk(key)]).boundaryItems[0].boundaryLabel, C07_BOUNDARY_LABELS[key]);
});

// --- R18: boundaryKey -> boundaryPurpose AND boundaryKey -> ownerSurface mapping ---
test('R18 boundaryKey -> boundaryPurpose and -> ownerSurface match the locked mapping', () => {
  for (const key of C07_BOUNDARY_KEYS) {
    const it = build([mk(key)]).boundaryItems[0];
    assert.equal(it.boundaryPurpose, C07_BOUNDARY_PURPOSES[key]);
    assert.equal(it.ownerSurface, C07_OWNER_SURFACE_BY_KEY[key]);
  }
  assert.equal(build([mk('boundary_transport_matrix')]).boundaryItems[0].ownerSurface, 'bcp_transport_harness');
});

// --- R19: envelope evidenceLabels capped at <=4 ---
test('R19 enforceC07EvidenceLabelCap caps envelope evidence labels at <=4', () => {
  const over = ['code_config_declared', 'synthetic_fixture', 'none_empty', 'redacted', 'code_config_declared', 'none_empty'] as C07EvidenceLabel[];
  assert.ok(enforceC07EvidenceLabelCap(over).length <= C07_MAX_EVIDENCE_LABELS);
  assert.equal(C07_MAX_EVIDENCE_LABELS, 4);
  assert.ok(build(P()).evidenceLabels.length <= C07_MAX_EVIDENCE_LABELS);
  assert.deepEqual(build(P()).evidenceLabels, ['code_config_declared']);
});

// --- R20: item_count_capped is defensive-only (synthetic over-ceiling fixture) ---
test('R20 over-ceiling input raises item_count_capped; natural <=7 does not', () => {
  const many = Array.from({ length: 13 }, () => mk('c01_readiness_summary'));
  const e = build(many);
  assert.ok(e.warnings.includes('item_count_capped'));
  assert.equal(e.boundaryItems.length, 1); // still deduped to one per key
  assert.ok(!build(P()).warnings.includes('item_count_capped'));
});

// --- structural / no-throw safety extras ---
test('schemaVersion is the v1 code-config schema', () => assert.equal(build(P()).schemaVersion, C07_DATA_SOURCE_BOUNDARY_SCHEMA_VERSION_V1));
test('selfAttestation is the fixed design_time_code_config', () => assert.equal(build(P()).selfAttestation, C07_SELF_ATTESTATION));
test('freshness/redaction/logExposure are fixed safe constants', () => { const e = build(P()); assert.equal(e.freshness, 'static_code_config'); assert.equal(e.redactionPosture, 'enforced'); assert.equal(e.logExposurePosture, 'no_raw_logs'); });
test('generatedAt is permanently EXCLUDED (no such key)', () => assert.ok(!('generatedAt' in (build(P()) as unknown as Record<string, unknown>))));
test('non-array input -> no-throw safe empty (no_boundary_items)', () => { assert.doesNotThrow(() => build(null as unknown as never)); const e = build(null as unknown as never); assert.equal(e.boundaryItems.length, 0); assert.equal(e.emptyStateReason, 'no_boundary_items'); });
test('malformed entries (null / number / string / array / {}) -> no-throw', () => { assert.doesNotThrow(() => build([null, 1, 'x', [], {}] as unknown as C07BoundaryItemInput[])); });
test('throwing-getter entry -> no-throw and dropped', () => { const h = {} as Record<string, unknown>; Object.defineProperty(h, 'boundaryKey', { enumerable: true, get() { throw new Error('boom'); } }); const e = build([h as C07BoundaryItemInput]); assert.equal(e.boundaryItems.length, 0); assert.ok(e.warnings.includes('boundary_key_redacted')); });
test('every emitted item has ONLY the 19 accepted fields', () => { for (const it of build(P()).boundaryItems) assert.deepEqual(Object.keys(it).sort(), ITEM_KEYS); });
test('built envelope passes the output-key allow-list and self-attestation framing', () => { const e = build(P()); assert.doesNotThrow(() => assertBcpC07OutputKeyAllowList(e)); assert.doesNotThrow(() => assertBcpC07SelfAttestationFraming(e)); });
test('deterministic output across calls', () => assert.deepEqual(build(P()), build(P())));

// --- hardening (cross-model review): no-throw for a hostile revoked array proxy ---
test('hostile revoked array proxy -> no-throw safe empty', () => {
  const { proxy, revoke } = Proxy.revocable<C07BoundaryItemInput[]>([], {});
  revoke();
  assert.doesNotThrow(() => build(proxy as unknown as C07BoundaryItemInput[]));
  assert.equal(build(proxy as unknown as C07BoundaryItemInput[]).boundaryItems.length, 0);
});

// --- hardening: duplicate-flood must NOT starve later distinct valid keys (whole-input dedup) ---
test('duplicate-flood keeps every distinct key in fixed order + raises item_count_capped', () => {
  const flood: C07BoundaryItemInput[] = [
    ...Array.from({ length: 12 }, () => mk('c01_readiness_summary')),
    mk('c02_registry_readiness'), mk('c03_ui_coverage_readiness'), mk('c04_route_exposure_readiness'),
    mk('c05_feature_flag_posture'), mk('c06_quality_gates_evidence'), mk('boundary_transport_matrix'),
  ];
  const e = build(flood);
  assert.deepEqual(e.boundaryItems.map((i) => i.boundaryKey), [...C07_BOUNDARY_KEYS]);
  assert.ok(e.warnings.includes('item_count_capped'));
});

// --- hardening: an isolated unknown evidenceStatus is not a silent redaction ---
test('isolated unknown evidenceStatus -> unknown_redacted, counted, warned', () => {
  const e = build([{ ...mk('c01_readiness_summary'), evidenceStatus: 'bogus' } as C07BoundaryItemInput]);
  assert.equal(e.boundaryItems[0].evidenceStatus, 'unknown_redacted');
  assert.equal(e.summaryCounts.unknownRedacted, 1);
  assert.ok(e.warnings.includes('posture_value_redacted'));
});

// --- hardening: mixed valid source modes -> safe `none` fallback (never the first item) ---
test('mixed valid source modes -> envelope sourceMode none', () => {
  const e = build([
    { ...mk('c01_readiness_summary'), sourceMode: 'code_config' } as C07BoundaryItemInput,
    { ...mk('c02_registry_readiness'), sourceMode: 'synthetic' } as C07BoundaryItemInput,
  ]);
  assert.equal(e.sourceMode, 'none');
});

// --- coverage: envelope-level scalar postures derive correctly (clean + empty) ---
test('envelope-level postures derive correctly (clean + empty)', () => {
  const e = build(P());
  assert.equal(e.dataSourcePosture, 'code_config_only');
  assert.equal(e.productionPosture, 'production_disabled');
  assert.equal(e.mutationPosture, 'mutation_blocked');
  assert.equal(e.valueOraclePosture, 'no_value_oracle');
  const z = build([]);
  assert.equal(z.sourceMode, 'none');
  for (const v of [z.dataSourcePosture, z.productionPosture, z.mutationPosture, z.valueOraclePosture]) assert.equal(v, 'redacted');
});

// --- coverage: readOnly and mutationBlocked both track mutationPosture (can diverge from 7) ---
test('readOnly and mutationBlocked both fall when mutationPosture is redacted', () => {
  const items = P();
  (items[2] as unknown as Record<string, unknown>).mutationPosture = 'x';
  (items[3] as unknown as Record<string, unknown>).mutationPosture = 'x';
  const c = build(items).summaryCounts;
  assert.equal(c.readOnly, 5);
  assert.equal(c.mutationBlocked, 5);
});

// --- coverage: the string-scanning gates still pass on an actual redaction-path envelope ---
test('redaction-path envelope still passes the string-scanning gates', () => {
  const e = build([
    { boundaryKey: 'c02_registry_readiness', sourceMode: 'x', dbPosture: 'x', productionPosture: 'x' } as C07BoundaryItemInput,
    { boundaryKey: 'bad' } as C07BoundaryItemInput,
  ]);
  assert.doesNotThrow(() => assertBcpC07OutputKeyAllowList(e));
  assert.doesNotThrow(() => assertBcpC07ValueContentSafety(e));
  assert.doesNotThrow(() => assertBcpC07SelfAttestationFraming(e));
});

(() => { let p = 0; const f: string[] = []; for (const c of cases) { try { c.fn(); p++; console.log('PASS ' + c.name); } catch (e) { f.push(c.name + ' :: ' + (e instanceof Error ? e.message : String(e))); console.log('FAIL ' + c.name); } } console.log(`\n[M33 BCP C-07 read model] ${p}/${cases.length} passed`); if (f.length) { console.log('FAILURES:'); for (const x of f) console.log('  - ' + x); process.exit(1); } console.log('ALL_TESTS_PASSED'); process.exit(0); })();

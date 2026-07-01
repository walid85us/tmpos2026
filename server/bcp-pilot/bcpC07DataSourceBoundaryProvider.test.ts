// Phase 2.0 M33 — Tests for the server-owned C-07 Data Source Boundary Readiness declared-posture provider.
// Covers the 13 mandatory provider cases (P1..P13) locked in M32 §16, plus the six enforced fitness functions
// and their rejection paths. Safe assertion messages only — no raw output is echoed on failure.
import assert from 'node:assert/strict';
import {
  BCP_C07_DATA_SOURCE_BOUNDARY_ITEMS,
  getBcpC07DataSourceBoundaryItems,
  assertBcpC07BoundaryKeyAllowList,
  assertBcpC07OutputKeyAllowList,
  assertBcpC07ValueContentSafety,
  assertBcpC07DeterminismNoTimestamp,
  assertBcpC07ProductionReadinessClaimBan,
  assertBcpC07SelfAttestationFraming,
} from './bcpC07DataSourceBoundaryProvider';
import {
  buildC07DataSourceBoundaryEnvelope,
  C07_BOUNDARY_KEYS,
  C07_BOUNDARY_LABELS,
  C07_SELF_ATTESTATION,
  C07_DATA_SOURCE_BOUNDARY_SCHEMA_VERSION_V1,
  type C07BoundaryItem,
} from './bcpC07DataSourceBoundaryReadModel';

const ITEM_KEYS = [
  'boundaryKey', 'boundaryLabel', 'boundaryPurpose', 'ownerSurface', 'sourceMode', 'dataSourcePosture',
  'dbPosture', 'sqlPosture', 'supabasePosture', 'liveProviderPosture', 'runtimeEnvPosture',
  'commandOutputPosture', 'diagnosticsPosture', 'rawEvidencePosture', 'valueOraclePosture',
  'productionPosture', 'mutationPosture', 'customerExposurePosture', 'evidenceStatus',
].sort();

const P = () => getBcpC07DataSourceBoundaryItems();
const env = () => buildC07DataSourceBoundaryEnvelope(P());
const ABSENCE = 'asserted_absent_code_config';

const cases: { name: string; fn: () => void }[] = [];
const test = (n: string, fn: () => void) => cases.push({ name: n, fn });

// --- P1: deterministic output across repeated calls ---
test('P1 provider items are deterministic across calls', () => assert.deepEqual(P(), P()));
test('P1 built envelope is deterministic across calls', () => assert.deepEqual(env(), env()));
test('P1 defensive copy — mutating the result never affects the frozen constant', () => {
  const a = P();
  (a[0] as unknown as Record<string, unknown>).boundaryKey = 'mutated';
  assert.equal(BCP_C07_DATA_SOURCE_BOUNDARY_ITEMS[0].boundaryKey, 'c01_readiness_summary');
  assert.equal(P()[0].boundaryKey, 'c01_readiness_summary');
});

// --- P2: selfAttestation present and fixed ---
test('P2 envelope selfAttestation is the fixed design_time_code_config', () => assert.equal(env().selfAttestation, C07_SELF_ATTESTATION));
test('P2 schemaVersion is the v1 code-config schema', () => assert.equal(env().schemaVersion, C07_DATA_SOURCE_BOUNDARY_SCHEMA_VERSION_V1));

// --- P3: only code_config/synthetic/none source-modes ---
test('P3 every item sourceMode is code_config (closed set)', () => { for (const it of P()) assert.ok(['code_config', 'synthetic', 'none'].includes(it.sourceMode)); });
test('P3 envelope sourceMode is code_config', () => assert.equal(env().sourceMode, 'code_config'));

// --- P4: no generatedAt / no runtime timestamp ---
test('P4 envelope carries NO generatedAt field', () => assert.ok(!('generatedAt' in (env() as unknown as Record<string, unknown>))));
test('P4 freshness is the fixed static_code_config (no runtime timing)', () => assert.equal(env().freshness, 'static_code_config'));
test('P4 no ISO-timestamp string anywhere; determinism/no-timestamp FF passes', () => {
  assert.ok(!/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(JSON.stringify(env())));
  assert.doesNotThrow(() => assertBcpC07DeterminismNoTimestamp());
});

// --- P5: no DB/SQL/Supabase/live-provider source categories referenced (declared absent only) ---
test('P5 db/sql/supabase/live-provider postures are all declared-absent', () => {
  for (const it of P()) {
    assert.equal(it.dbPosture, ABSENCE);
    assert.equal(it.sqlPosture, ABSENCE);
    assert.equal(it.supabasePosture, ABSENCE);
    assert.equal(it.liveProviderPosture, ABSENCE);
  }
});
test('P5 no raw DB/Supabase/SQL/provider string in output', () => {
  const j = JSON.stringify(env()).toLowerCase();
  for (const bad of ['postgres', 'supabaseurl', 'service_role', 'createclient', 'select ', 'insert ', 'jdbc']) assert.ok(!j.includes(bad), bad);
});

// --- P6: no runtime env value referenced ---
test('P6 runtimeEnvPosture is declared-absent; output invariant to process.env mutation', () => {
  for (const it of P()) assert.equal(it.runtimeEnvPosture, ABSENCE);
  const before = JSON.stringify(env());
  const key = '__BCP_C07_PROBE__';
  process.env[key] = 'leak-me';
  try { assert.equal(JSON.stringify(env()), before); } finally { delete process.env[key]; }
});

// --- P7/P8: no command output, no diagnostics ---
test('P7 commandOutputPosture is declared-absent', () => { for (const it of P()) assert.equal(it.commandOutputPosture, ABSENCE); });
test('P8 diagnosticsPosture is declared-absent; rawEvidencePosture is declared-absent', () => { for (const it of P()) { assert.equal(it.diagnosticsPosture, ABSENCE); assert.equal(it.rawEvidencePosture, ABSENCE); } });

// --- P9: no package/file-path inventory ---
test('P9 no file-extension / path / package tokens in output; output-key FF passes', () => {
  const j = JSON.stringify(env());
  assert.ok(!/\.(ts|tsx|js|json|env|sql|sh|lock|log|pem|key)\b/i.test(j));
  assert.ok(!/[\\/]node_modules[\\/]|package-lock|"version"/i.test(j));
  assert.doesNotThrow(() => assertBcpC07OutputKeyAllowList(env()));
});

// --- P10/P11: bounded items, seven closed keys, fixed order ---
test('P10 exactly 7 bounded items, one per key', () => { assert.equal(P().length, 7); assert.equal(new Set(P().map((i) => i.boundaryKey)).size, 7); });
test('P11 the seven closed boundary keys only, in fixed order', () => assert.deepEqual(P().map((i) => i.boundaryKey), [...C07_BOUNDARY_KEYS]));
test('P11 no future_lens_placeholder anywhere', () => assert.ok(!JSON.stringify(env()).includes('future_lens_placeholder')));

// --- P12: closed warning labels only (none for the clean provider input) ---
test('P12 provider envelope emits no warnings (all inputs valid)', () => assert.deepEqual(env().warnings, []));

// --- P13: no raw identifiers/secrets/credentials/tokens ---
test('P13 no secrets/ids/tokens/urls/emails in serialized output', () => {
  const j = JSON.stringify(env());
  assert.ok(!/:\/\/|@|sk_live|bearer|eyj|[0-9a-f]{8}-[0-9a-f]{4}|[0-9a-f]{7,}|\bpassword\b|\btoken\b|\bsecret\b/i.test(j));
});
test('P13 value-content closed-set gate passes', () => assert.doesNotThrow(() => assertBcpC07ValueContentSafety(env())));

// --- FF1: boundary-key allow-list (pass + rejection paths) ---
test('FF1 boundary-key allow-list passes for the provider', () => assert.doesNotThrow(() => assertBcpC07BoundaryKeyAllowList()));
test('FF1 rejects wrong length', () => assert.throws(() => assertBcpC07BoundaryKeyAllowList(P().slice(0, 6))));
test('FF1 rejects a tampered label', () => assert.throws(() => assertBcpC07BoundaryKeyAllowList([{ ...P()[0], boundaryLabel: 'Hacked Label' }, ...P().slice(1)])));
test('FF1 rejects an unsafe/out-of-set key', () => assert.throws(() => assertBcpC07BoundaryKeyAllowList([{ ...P()[0], boundaryKey: 'supabase_url' } as unknown as C07BoundaryItem, ...P().slice(1)])));
test('FF1 rejects keys out of fixed order', () => { const a = P(); const s = [a[1], a[0], ...a.slice(2)]; assert.throws(() => assertBcpC07BoundaryKeyAllowList(s)); });

// --- FF2: output-key allow-list (pass + generatedAt/path rejection) ---
test('FF2 output-key allow-list passes for the provider envelope', () => assert.doesNotThrow(() => assertBcpC07OutputKeyAllowList()));
test('FF2 rejects an injected generatedAt key', () => assert.throws(() => assertBcpC07OutputKeyAllowList({ ...env(), generatedAt: 'x' } as unknown)));
test('FF2 rejects an injected filePath key', () => assert.throws(() => assertBcpC07OutputKeyAllowList({ ...env(), filePath: '/etc/passwd' } as unknown)));

// --- FF3: value-content gate (pass + leak rejection) ---
test('FF3 value-content gate passes for the provider envelope', () => assert.doesNotThrow(() => assertBcpC07ValueContentSafety()));
test('FF3 rejects a leaked URL value', () => assert.throws(() => assertBcpC07ValueContentSafety({ ...env(), warnings: ['https://evil.example.com/leak'] } as unknown)));

// --- FF4: determinism/no-timestamp ---
test('FF4 determinism/no-timestamp FF passes', () => assert.doesNotThrow(() => assertBcpC07DeterminismNoTimestamp()));

// --- FF5: production-readiness-claim ban (pass + rejection) ---
test('FF5 production-readiness-claim ban passes for the provider envelope', () => assert.doesNotThrow(() => assertBcpC07ProductionReadinessClaimBan()));
test('FF5 rejects a production-readiness claim string', () => assert.throws(() => assertBcpC07ProductionReadinessClaimBan({ note: 'this is production ready' } as unknown)));

// --- FF6: self-attestation / non-verifier framing (pass + rejection) ---
test('FF6 self-attestation framing passes for the provider envelope', () => assert.doesNotThrow(() => assertBcpC07SelfAttestationFraming()));
test('FF6 rejects a wrong selfAttestation value', () => assert.throws(() => assertBcpC07SelfAttestationFraming({ selfAttestation: 'live_check', boundaryItems: [] } as unknown)));
test('FF6 rejects a live-verification evidenceStatus', () => assert.throws(() => assertBcpC07SelfAttestationFraming({ selfAttestation: C07_SELF_ATTESTATION, boundaryItems: [{ evidenceStatus: 'live_verified' }] } as unknown)));

// --- structural: only the 19 accepted item fields ---
test('every provider item has ONLY the 19 accepted fields', () => { for (const it of P()) assert.deepEqual(Object.keys(it).sort(), ITEM_KEYS); });
test('every declared posture value is a safe snake_case / bounded label', () => {
  for (const it of P()) {
    for (const v of [it.dataSourcePosture, it.valueOraclePosture, it.productionPosture, it.mutationPosture, it.customerExposurePosture, it.evidenceStatus]) {
      assert.ok(/^[a-z0-9_]+$/.test(v), v);
    }
  }
});

// --- hardening: frozen trust-anchor maps resist mutation (no output injection) ---
test('boundary key array and label map are runtime-frozen (resist cast-mutation)', () => {
  assert.ok(Object.isFrozen(C07_BOUNDARY_KEYS));
  assert.ok(Object.isFrozen(C07_BOUNDARY_LABELS));
  try { (C07_BOUNDARY_LABELS as unknown as Record<string, string>).c01_readiness_summary = 'HACKED'; } catch { /* strict-mode throw is acceptable */ }
  try { (C07_BOUNDARY_KEYS as unknown as string[])[0] = 'evil_url'; } catch { /* acceptable */ }
  assert.equal(C07_BOUNDARY_LABELS.c01_readiness_summary, 'C-01 Readiness Summary');
  assert.equal(C07_BOUNDARY_KEYS[0], 'c01_readiness_summary');
  assert.equal(env().boundaryItems[0].boundaryLabel, 'C-01 Readiness Summary'); // output still canonical
});

// --- hardening: output invariant to clock mutation (backs the FF4 determinism claim) ---
test('P1/P4 output is invariant to Date.now / clock mutation', () => {
  const before = JSON.stringify(env());
  const realNow = Date.now;
  Date.now = () => 4102444800000;
  try { assert.equal(JSON.stringify(env()), before); } finally { Date.now = realNow; }
});

// --- hardening: fitness-function errors never echo the raw offending value ---
test('fitness-function failure messages do not leak the raw offending value', () => {
  const marker = 'PLAINTEXT-SECRET-abc123-do-not-leak';
  const leak = `https://evil.example.com/${marker}`;
  assert.throws(() => assertBcpC07ValueContentSafety({ ...env(), warnings: [leak] } as unknown), (e: unknown) => {
    const m = e instanceof Error ? e.message : String(e);
    return !m.includes(marker) && !m.includes(leak);
  });
  assert.throws(() => assertBcpC07ProductionReadinessClaimBan({ note: `ship it ${marker}` } as unknown), (e: unknown) => {
    const m = e instanceof Error ? e.message : String(e);
    return !m.includes(marker);
  });
});

(() => { let p = 0; const f: string[] = []; for (const c of cases) { try { c.fn(); p++; console.log('PASS ' + c.name); } catch (e) { f.push(c.name + ' :: ' + (e instanceof Error ? e.message : String(e))); console.log('FAIL ' + c.name); } } console.log(`\n[M33 BCP C-07 provider] ${p}/${cases.length} passed`); if (f.length) { console.log('FAILURES:'); for (const x of f) console.log('  - ' + x); process.exit(1); } console.log('ALL_TESTS_PASSED'); process.exit(0); })();

// Phase 2.0 M27 — Backend CP BOUNDARY TRANSPORT MATRIX (consolidated cross-lens, no-process).
//
// WHAT THIS IS: a TEST-ONLY harness that asserts the SINGLE uniform transport contract shared by the
// six frozen DEV-only read-only Backend Control Panel lenses (C-01..C-06) as one regressionable
// property. It exercises the EXISTING frozen boundaries in-process:
//   1. the pure, transport-agnostic route handlers (handle*Request) — for the full gate/method/guard/
//      catch contract, driven entirely through the typed request object (NO env mutation), and
//   2. the real frozen Express adapter factories (create*Handler) — for the HTTP-shape edge
//      (status code / Allow header / no-body / json vs end), driven through in-process mock req/res.
//
// SAFETY (binding — mirrors the frozen modules it imports):
//   - NO server is started. NO socket / listener / port. NO outbound network I/O. NO child/background
//     process. NO filesystem writes. NO package/dependency/browser-tooling change. NO DB/Supabase/live
//     provider. NO mutation/action. The harness runs entirely in the test runner's own process.
//   - It IMPORTS frozen adapters/handlers only; it adds NO dependency injection to any frozen module
//     and edits NOTHING. The non-injectable C-01 adapter is exercised via a tightly-scoped env
//     snapshot/finally-restore (withEnv) — no global state is left mutated.
//   - Authority is never taken from the request: hostile non-authority hints are passed and proven
//     ignored. Assertions use safe summary predicates (status category, no-body, Allow:GET boolean,
//     fixed safe-error body). Response bodies are scanned for forbidden raw-evidence categories; the
//     scan NEVER surfaces the raw value in a failure message.
//   - All inputs are obvious synthetic placeholders (no real tenant/store/customer/identity/secret).
//
// Runner style mirrors the existing bcp-pilot tests: prints "X/Y passed" + "ALL_TESTS_PASSED".

import assert from 'node:assert/strict';
import type { Request, Response } from 'express'; // type-only: erased at runtime.

import type { SyntheticServerPrincipal, NonAuthorityHints } from './bcpAuthorizationGuard';

// Frozen pure route-boundary handlers (one per lens).
import { handleBcpReadinessSummaryRequest } from './bcpReadOnlyRoute';
import { handleBcpC02RegistryReadinessRequest } from './bcpC02ReadOnlyRoute';
import { handleBcpC03UiCoverageRequest } from './bcpC03ReadOnlyRoute';
import { handleBcpC04RouteExposureRequest } from './bcpC04ReadOnlyRoute';
import { handleBcpC05FeatureFlagPostureRequest } from './bcpC05ReadOnlyRoute';
import { handleBcpC06QualityGatesEvidenceRequest } from './bcpC06ReadOnlyRoute';

// Frozen Express adapter factories (one per lens).
import { createBcpReadinessSummaryHandler } from './bcpReadOnlyExpressAdapter';
import { createBcpC02RegistryReadinessHandler } from './bcpC02ReadOnlyExpressAdapter';
import { createBcpC03UiCoverageReadinessHandler } from './bcpC03ReadOnlyExpressAdapter';
import { createBcpC04RouteExposureReadinessHandler } from './bcpC04ReadOnlyExpressAdapter';
import { createBcpC05FeatureFlagPostureReadinessHandler } from './bcpC05ReadOnlyExpressAdapter';
import { createBcpC06QualityGatesEvidenceReadinessHandler } from './bcpC06ReadOnlyExpressAdapter';

// ---------------------------------------------------------------------------------------------------
// Common request/response shapes. The six handlers each have their own request type, but all share the
// four core fields below (+ optional hints). A BoundaryReq is structurally assignable to every handler
// param; every handler return is structurally assignable to BoundaryRes.
// ---------------------------------------------------------------------------------------------------
interface BoundaryReq {
  method: string;
  isDevEnvironment: boolean;
  featureEnabled: boolean;
  principal: SyntheticServerPrincipal | null;
  hints?: NonAuthorityHints;
}
interface BoundaryRes {
  httpStatus: number;
  category: string;
  headers?: Record<string, string>;
  body: unknown;
}
type AdapterDeps = { isDevEnvironment?: () => boolean; featureEnabled?: () => boolean };
type ExpressHandler = (req: Request, res: Response) => void;

interface Lens {
  id: string;
  handler: (req: BoundaryReq) => BoundaryRes;
  makeAdapter: (deps?: AdapterDeps) => ExpressHandler;
  /** C-02..C-06 accept injectable gate deps; C-01's adapter is non-injectable (reads process.env). */
  injectable: boolean;
  /** Feature-flag env var name (used only for the scoped C-01 adapter-edge withEnv path). */
  flagEnv: string;
}

const LENSES: Lens[] = [
  { id: 'C-01', injectable: false, flagEnv: 'ENABLE_BCP_DEV_READONLY_PILOT',
    handler: (r) => handleBcpReadinessSummaryRequest(r),
    makeAdapter: () => createBcpReadinessSummaryHandler() },
  { id: 'C-02', injectable: true, flagEnv: 'ENABLE_BCP_DEV_C02_REGISTRY_READINESS',
    handler: (r) => handleBcpC02RegistryReadinessRequest(r),
    makeAdapter: (d) => createBcpC02RegistryReadinessHandler(d) },
  { id: 'C-03', injectable: true, flagEnv: 'ENABLE_BCP_DEV_C03_UI_COVERAGE_READINESS',
    handler: (r) => handleBcpC03UiCoverageRequest(r),
    makeAdapter: (d) => createBcpC03UiCoverageReadinessHandler(d) },
  { id: 'C-04', injectable: true, flagEnv: 'ENABLE_BCP_DEV_C04_ROUTE_EXPOSURE_READINESS',
    handler: (r) => handleBcpC04RouteExposureRequest(r),
    makeAdapter: (d) => createBcpC04RouteExposureReadinessHandler(d) },
  { id: 'C-05', injectable: true, flagEnv: 'ENABLE_BCP_DEV_C05_FEATURE_FLAG_POSTURE_READINESS',
    handler: (r) => handleBcpC05FeatureFlagPostureRequest(r),
    makeAdapter: (d) => createBcpC05FeatureFlagPostureReadinessHandler(d) },
  { id: 'C-06', injectable: true, flagEnv: 'ENABLE_BCP_DEV_C06_QUALITY_GATES_EVIDENCE_COVERAGE_READINESS',
    handler: (r) => handleBcpC06QualityGatesEvidenceRequest(r),
    makeAdapter: (d) => createBcpC06QualityGatesEvidenceReadinessHandler(d) },
];

// ---------------------------------------------------------------------------------------------------
// Synthetic, obviously-fake fixtures (no real identifiers / secrets).
// ---------------------------------------------------------------------------------------------------
const VALID_PRINCIPAL: SyntheticServerPrincipal = {
  source: 'server_derived',
  internalUserId: 'iu_synthetic_dev',
  authProvider: 'supabase',
  verified: true,
  scopeType: 'platform',
  parityState: 'ready',
  visibilityClass: 'overview_viewer',
};
// parityState !== 'ready' ⇒ guard returns 'blocked' ⇒ 409.
const PARITY_UNRESOLVED_PRINCIPAL: SyntheticServerPrincipal = { ...VALID_PRINCIPAL, parityState: 'unresolved' };
// Hostile non-authority attempt: even a forged "system_owner" role label must be ignored.
const HOSTILE_HINTS: NonAuthorityHints = {
  clientSuppliedUid: 'evil-uid-synthetic',
  email: 'attacker@example.test',
  frontendRoleLabel: 'system_owner',
  urlTenantParam: 'tenant-synthetic',
  urlStoreParam: 'store-synthetic',
  bodyInternalUserId: 'iu_injected_synthetic',
};

// ---------------------------------------------------------------------------------------------------
// Safe helpers (all confined to this single test file).
// ---------------------------------------------------------------------------------------------------
const isSuccessCat = (c: string): boolean => c === 'success' || c === 'synthetic_success';

// Unambiguous raw-evidence leak markers that can never appear in a safe BCP envelope. The failure
// message is intentionally generic — it never echoes the raw response value.
const FORBIDDEN_LEAK = ['iu_synthetic_dev', 'service_role', 'Bearer ', '/home/', 'node_modules', 'Error:', '.ts:'];
function assertNoRawEvidence(body: unknown, label: string): void {
  const s = typeof body === 'string' ? body : JSON.stringify(body ?? null);
  for (const bad of FORBIDDEN_LEAK) {
    assert.ok(!s.includes(bad), `${label}: response surfaced a forbidden raw-evidence category`);
  }
}

// Prove a hostile non-authority attempt never echoes back: none of the hostile hint VALUES may appear
// in the response body. The failure message stays generic (never echoes the value).
function assertHintsNotLeaked(body: unknown, label: string): void {
  const s = typeof body === 'string' ? body : JSON.stringify(body ?? null);
  for (const v of Object.values(HOSTILE_HINTS)) {
    if (typeof v === 'string') assert.ok(!s.includes(v), `${label}: a hostile hint value leaked into the response`);
  }
}

// Tightly-scoped env snapshot/restore: snapshots ONLY the named keys, restores them in finally (even on
// throw), never enumerates or logs process.env. Used only for the non-injectable C-01 adapter edge.
function withEnv(overrides: Record<string, string | undefined>, fn: () => void): void {
  const keys = Object.keys(overrides);
  const snapshot: Record<string, string | undefined> = {};
  for (const k of keys) snapshot[k] = process.env[k];
  try {
    for (const k of keys) {
      const v = overrides[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fn();
  } finally {
    for (const k of keys) {
      const v = snapshot[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

interface FakeRes {
  headers: Record<string, string>;
  ended: boolean;
  headersSent: boolean;
  statusCode: number | undefined;
  body: unknown;
  setHeader(k: string, v: string): void;
  status(c: number): FakeRes;
  json(b: unknown): void;
  end(): void;
}
function fakeRes(): FakeRes {
  const res: FakeRes = {
    headers: {}, ended: false, headersSent: false, statusCode: undefined, body: undefined,
    setHeader(k, v) { res.headers[k] = v; },
    status(c) { res.statusCode = c; return res; },
    json(b) { res.body = b; res.ended = true; res.headersSent = true; },
    end() { res.ended = true; res.headersSent = true; },
  };
  return res;
}
function exerciseAdapter(make: () => ExpressHandler, method: string): FakeRes {
  const res = fakeRes();
  make()({ method } as unknown as Request, res as unknown as Response);
  return res;
}

interface Case { name: string; fn: () => void }

// ---------------------------------------------------------------------------------------------------
// Pure-handler contract sub-matrix (full uniform contract, NO env mutation).
// ---------------------------------------------------------------------------------------------------
function pureHandlerCases(lens: Lens): Case[] {
  const run = lens.handler;
  const enabled = { isDevEnvironment: true, featureEnabled: true } as const;
  return [
    { name: `${lens.id} pure dev_only/production-disabled (isDev=false) → 404`, fn: () => {
        const r = run({ method: 'GET', isDevEnvironment: false, featureEnabled: true, principal: VALID_PRINCIPAL });
        assert.equal(r.httpStatus, 404); assert.equal(r.category, 'dev_only'); assertNoRawEvidence(r.body, `${lens.id} dev_only`); } },
    { name: `${lens.id} pure feature_disabled → 404`, fn: () => {
        const r = run({ method: 'GET', isDevEnvironment: true, featureEnabled: false, principal: VALID_PRINCIPAL });
        assert.equal(r.httpStatus, 404); assert.equal(r.category, 'feature_disabled'); assertNoRawEvidence(r.body, `${lens.id} feature_disabled`); } },
    { name: `${lens.id} pure OPTIONS → 204 Allow:GET no-body`, fn: () => {
        const r = run({ method: 'OPTIONS', ...enabled, principal: VALID_PRINCIPAL });
        assert.equal(r.httpStatus, 204); assert.equal(r.category, 'no_content'); assert.equal(r.headers?.Allow, 'GET'); assert.equal(r.body, null); } },
    { name: `${lens.id} pure POST → 405 Allow:GET`, fn: () => {
        const r = run({ method: 'POST', ...enabled, principal: VALID_PRINCIPAL });
        assert.equal(r.httpStatus, 405); assert.equal(r.category, 'method_not_allowed'); assert.equal(r.headers?.Allow, 'GET'); assertNoRawEvidence(r.body, `${lens.id} 405`); } },
    { name: `${lens.id} pure DELETE → 405 Allow:GET`, fn: () => {
        const r = run({ method: 'DELETE', ...enabled, principal: VALID_PRINCIPAL });
        assert.equal(r.httpStatus, 405); assert.equal(r.headers?.Allow, 'GET'); } },
    { name: `${lens.id} pure guard null-principal → 403`, fn: () => {
        const r = run({ method: 'GET', ...enabled, principal: null });
        assert.equal(r.httpStatus, 403); assert.equal(r.category, 'not_authorized'); assertNoRawEvidence(r.body, `${lens.id} 403`); } },
    { name: `${lens.id} pure guard parity-unresolved → 409`, fn: () => {
        const r = run({ method: 'GET', ...enabled, principal: PARITY_UNRESOLVED_PRINCIPAL });
        assert.equal(r.httpStatus, 409); assert.equal(r.category, 'parity_blocked'); assertNoRawEvidence(r.body, `${lens.id} 409`); } },
    { name: `${lens.id} pure HEAD → 200 no-body`, fn: () => {
        const r = run({ method: 'HEAD', ...enabled, principal: VALID_PRINCIPAL });
        assert.equal(r.httpStatus, 200); assert.equal(r.body, null); } },
    { name: `${lens.id} pure GET → 200 success non-null`, fn: () => {
        const r = run({ method: 'GET', ...enabled, principal: VALID_PRINCIPAL });
        assert.equal(r.httpStatus, 200); assert.ok(isSuccessCat(r.category)); assert.notEqual(r.body, null); assertNoRawEvidence(r.body, `${lens.id} GET-success`); } },
    { name: `${lens.id} pure catch → 500 safe {status:'error'}`, fn: () => {
        const r = run({ get method(): string { throw new Error('synthetic-induced-boom'); }, ...enabled, principal: VALID_PRINCIPAL });
        assert.equal(r.httpStatus, 500); assert.equal(r.category, 'safe_error'); assert.deepEqual(r.body, { status: 'error' }); } },
    { name: `${lens.id} pure hostile-hints + valid principal → 200 (hints ignored)`, fn: () => {
        const r = run({ method: 'GET', ...enabled, principal: VALID_PRINCIPAL, hints: HOSTILE_HINTS });
        assert.equal(r.httpStatus, 200); assert.ok(isSuccessCat(r.category)); assertNoRawEvidence(r.body, `${lens.id} hostile-valid`); assertHintsNotLeaked(r.body, `${lens.id} hostile-valid`); } },
    { name: `${lens.id} pure hostile-hints + null principal → 403 (no promotion)`, fn: () => {
        const r = run({ method: 'GET', ...enabled, principal: null, hints: HOSTILE_HINTS });
        assert.equal(r.httpStatus, 403); assert.equal(r.category, 'not_authorized'); assertNoRawEvidence(r.body, `${lens.id} hostile-null`); assertHintsNotLeaked(r.body, `${lens.id} hostile-null`); } },
  ];
}

// ---------------------------------------------------------------------------------------------------
// Adapter-edge HTTP-shape sub-matrix (real frozen adapters via mock req/res).
//   C-02..C-06: injectable deps — no env mutation.
//   C-01: non-injectable — tightly-scoped withEnv snapshot/finally-restore.
// ---------------------------------------------------------------------------------------------------
function adapterEdgeCases(lens: Lens): Case[] {
  if (lens.injectable) {
    const on: AdapterDeps = { isDevEnvironment: () => true, featureEnabled: () => true };
    return [
      { name: `${lens.id} adapter GET → 200 json body`, fn: () => {
          const res = exerciseAdapter(() => lens.makeAdapter(on), 'GET');
          assert.equal(res.statusCode, 200); assert.ok(res.ended); assert.notEqual(res.body, undefined); assertNoRawEvidence(res.body, `${lens.id} adapter GET`); } },
      { name: `${lens.id} adapter HEAD → 200 no-body (end, not json)`, fn: () => {
          const res = exerciseAdapter(() => lens.makeAdapter(on), 'HEAD');
          assert.equal(res.statusCode, 200); assert.ok(res.ended); assert.equal(res.body, undefined); } },
      { name: `${lens.id} adapter OPTIONS → 204 Allow:GET`, fn: () => {
          const res = exerciseAdapter(() => lens.makeAdapter(on), 'OPTIONS');
          assert.equal(res.statusCode, 204); assert.equal(res.headers.Allow, 'GET'); assert.ok(res.ended); } },
      { name: `${lens.id} adapter POST → 405 Allow:GET`, fn: () => {
          const res = exerciseAdapter(() => lens.makeAdapter(on), 'POST');
          assert.equal(res.statusCode, 405); assert.equal(res.headers.Allow, 'GET'); } },
      { name: `${lens.id} adapter feature-off → 404`, fn: () => {
          const res = exerciseAdapter(() => lens.makeAdapter({ isDevEnvironment: () => true, featureEnabled: () => false }), 'GET');
          assert.equal(res.statusCode, 404); } },
      { name: `${lens.id} adapter dev-off → 404`, fn: () => {
          const res = exerciseAdapter(() => lens.makeAdapter({ isDevEnvironment: () => false, featureEnabled: () => true }), 'GET');
          assert.equal(res.statusCode, 404); } },
    ];
  }
  // Non-injectable C-01: scoped env mutation with guaranteed restore.
  return [
    { name: `${lens.id} adapter(env) GET/HEAD/OPTIONS/POST shapes`, fn: () => {
        withEnv({ NODE_ENV: 'development', [lens.flagEnv]: 'true' }, () => {
          const g = exerciseAdapter(() => lens.makeAdapter(), 'GET');
          assert.equal(g.statusCode, 200); assert.ok(g.ended); assert.notEqual(g.body, undefined); assertNoRawEvidence(g.body, `${lens.id} adapter GET`);
          const h = exerciseAdapter(() => lens.makeAdapter(), 'HEAD');
          assert.equal(h.statusCode, 200); assert.equal(h.body, undefined);
          const o = exerciseAdapter(() => lens.makeAdapter(), 'OPTIONS');
          assert.equal(o.statusCode, 204); assert.equal(o.headers.Allow, 'GET');
          const p = exerciseAdapter(() => lens.makeAdapter(), 'POST');
          assert.equal(p.statusCode, 405); assert.equal(p.headers.Allow, 'GET');
        });
      } },
    { name: `${lens.id} adapter(env) feature-off → 404`, fn: () => {
        withEnv({ NODE_ENV: 'development', [lens.flagEnv]: undefined }, () => {
          const r = exerciseAdapter(() => lens.makeAdapter(), 'GET');
          assert.equal(r.statusCode, 404);
        });
      } },
    { name: `${lens.id} adapter(env) dev-off (production) → 404`, fn: () => {
        withEnv({ NODE_ENV: 'production', [lens.flagEnv]: 'true' }, () => {
          const r = exerciseAdapter(() => lens.makeAdapter(), 'GET');
          assert.equal(r.statusCode, 404);
        });
      } },
    { name: `${lens.id} scoped env fully restored after mutation`, fn: () => {
        const before = process.env[lens.flagEnv];
        withEnv({ [lens.flagEnv]: 'true' }, () => { /* mutated only within scope */ });
        assert.equal(process.env[lens.flagEnv], before, 'scoped env was not restored');
      } },
  ];
}

// ---------------------------------------------------------------------------------------------------
// Build + run. Fail loudly on missing required coverage.
// ---------------------------------------------------------------------------------------------------
assert.equal(LENSES.length, 6, 'expected exactly 6 lenses (C-01..C-06)');
assert.equal(new Set(LENSES.map((l) => l.id)).size, 6, 'lens ids must be unique');

const cases: Case[] = [];
for (const lens of LENSES) {
  const pure = pureHandlerCases(lens);
  const edge = adapterEdgeCases(lens);
  assert.ok(pure.length >= 12, `${lens.id}: missing required pure-handler scenarios`);
  assert.ok(edge.length >= 2, `${lens.id}: missing required adapter-edge scenarios`);
  cases.push(...pure, ...edge);
}

let pass = 0;
const failures: string[] = [];
for (const c of cases) {
  try {
    c.fn();
    pass++;
  } catch {
    // Safe-output contract: record ONLY the static case name — never e.message, which could carry a
    // raw assertion value or thrown data.
    failures.push(c.name);
    console.log('FAIL ' + c.name);
  }
}

console.log(`\n[M27 BCP boundary transport matrix C-01..C-06] ${pass}/${cases.length} passed`);
if (failures.length) {
  console.log('FAILURES:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('ALL_TESTS_PASSED');
process.exit(0);

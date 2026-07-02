// Phase 2.0 M35/M37 — Tests for the C-07 data-source-boundary route boundary handler.
//
// M37: the additive 'C-07': 'overview_viewer' guard entry now exists, so a fully-valid GET/HEAD reaches the
// real authorized 200 success path (envelope built from the server-owned items). These tests assert that
// authorized path AND every denied/disabled/method/error path honestly, prove denied/disabled requests never
// consume items, prove the success path consumes items ONLY after the guard passes, verify the guard maps
// C-07 (and only C-07) to overview_viewer while unknown ids still deny, and lock the success-envelope CONTRACT.
// No test fakes, injects, or bypasses guard authorization — the 200 arises solely from the real guard entry.
import assert from 'node:assert/strict';
import { handleBcpC07DataSourceBoundaryRequest, type BcpC07RouteRequest } from './bcpC07DataSourceBoundaryReadOnlyRoute';
import { authorizeBcpRead, type SyntheticServerPrincipal } from './bcpAuthorizationGuard';
import {
  getBcpC07DataSourceBoundaryItems,
  assertBcpC07OutputKeyAllowList,
  assertBcpC07ValueContentSafety,
  assertBcpC07ProductionReadinessClaimBan,
  assertBcpC07SelfAttestationFraming,
} from './bcpC07DataSourceBoundaryProvider';
import { buildC07DataSourceBoundaryEnvelope, type C07BoundaryItemInput } from './bcpC07DataSourceBoundaryReadModel';

const PRINCIPAL: SyntheticServerPrincipal = { source: 'server_derived', internalUserId: 'iu_synthetic_dev', authProvider: 'supabase', verified: true, scopeType: 'platform', parityState: 'ready', visibilityClass: 'overview_viewer' };
const ITEMS = getBcpC07DataSourceBoundaryItems();
const base = (o: Partial<BcpC07RouteRequest> = {}): BcpC07RouteRequest => ({ method: 'GET', isDevEnvironment: true, featureEnabled: true, principal: PRINCIPAL, items: ITEMS, ...o });
const H = handleBcpC07DataSourceBoundaryRequest;

// A denied/disabled body may only be a bounded {status,reason?} shape or null — never an envelope, never a
// raw error/stack, never a forbidden key/value.
const SAFE_DENIED_STATUS = new Set(['unavailable', 'method_not_allowed', 'not_authorized', 'parity_blocked', 'error']);
const SAFE_DENIED_REASON = new Set(['dev_only', 'feature_disabled']);
function assertSafeDeniedBody(body: unknown): void {
  if (body === null) return; // HEAD / OPTIONS / no-content
  assert.equal(typeof body, 'object');
  const b = body as Record<string, unknown>;
  for (const k of Object.keys(b)) assert.ok(k === 'status' || k === 'reason', `unexpected denied-body key: ${k}`);
  if ('status' in b) assert.ok(SAFE_DENIED_STATUS.has(String(b.status)), `status: ${String(b.status)}`);
  if ('reason' in b) assert.ok(SAFE_DENIED_REASON.has(String(b.reason)), `reason: ${String(b.reason)}`);
  assert.equal(b.schemaVersion, undefined); // never an envelope
  assert.ok(!/Error:|at Object\.|"stack":/.test(JSON.stringify(b)), 'no raw error/stack in body');
}

const cases: { name: string; fn: () => void }[] = [];
const test = (n: string, fn: () => void) => cases.push({ name: n, fn });

// --- DEV-only / default-off gates (run first, every method) ---
test('production ⇒ 404 dev_only (DEV gate first)', () => { const r = H(base({ isDevEnvironment: false, featureEnabled: false })); assert.equal(r.httpStatus, 404); assert.equal(r.category, 'dev_only'); assertSafeDeniedBody(r.body); });
test('feature disabled ⇒ 404 feature_disabled', () => { const r = H(base({ featureEnabled: false })); assert.equal(r.httpStatus, 404); assert.equal(r.category, 'feature_disabled'); assert.deepEqual(r.body, { status: 'unavailable', reason: 'feature_disabled' }); });
test('non-GET in production ⇒ 404 dev_only (DEV gate precedes method gate)', () => { const r = H(base({ method: 'POST', isDevEnvironment: false })); assert.equal(r.httpStatus, 404); assert.equal(r.category, 'dev_only'); });

// --- method gates ---
test('OPTIONS ⇒ 204 Allow: GET, no body', () => { const r = H(base({ method: 'OPTIONS' })); assert.equal(r.httpStatus, 204); assert.equal(r.headers?.Allow, 'GET'); assert.equal(r.body, null); });
for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) test(`${m} ⇒ 405 Allow: GET`, () => { const r = H(base({ method: m })); assert.equal(r.httpStatus, 405); assert.equal(r.headers?.Allow, 'GET'); assertSafeDeniedBody(r.body); });

// --- guard authority-denial matrix (all reachable NOW; these guard steps precede the contract lookup) ---
test('null principal ⇒ 403 (no_server_principal)', () => { const r = H(base({ principal: null })); assert.equal(r.httpStatus, 403); assert.equal(r.category, 'not_authorized'); assertSafeDeniedBody(r.body); });
test('hints-only (no principal) ⇒ 403 (untrusted_authority_only; hints never authority)', () => { const r = H(base({ principal: null, hints: { clientSuppliedUid: 'evil', email: 'a@b.co' } })); assert.equal(r.httpStatus, 403); assertSafeDeniedBody(r.body); });
test('unverified principal ⇒ 403', () => assert.equal(H(base({ principal: { ...PRINCIPAL, verified: false } })).httpStatus, 403));
test('principal with null internalUserId ⇒ 403', () => assert.equal(H(base({ principal: { ...PRINCIPAL, internalUserId: null } })).httpStatus, 403));
test('non-ready parity ⇒ 409 parity_blocked (parity precedes contract lookup)', () => { const r = H(base({ principal: { ...PRINCIPAL, parityState: 'unresolved' } })); assert.equal(r.httpStatus, 409); assert.equal(r.category, 'parity_blocked'); assertSafeDeniedBody(r.body); });
test('blocked parity ⇒ 409 parity_blocked', () => assert.equal(H(base({ principal: { ...PRINCIPAL, parityState: 'blocked' } })).httpStatus, 409));

// --- authorized success path (unlocked by the additive 'C-07': 'overview_viewer' guard entry, M37) ---
test('AUTHORIZED: fully-valid GET ⇒ 200 success envelope', () => { const r = H(base()); assert.equal(r.httpStatus, 200); assert.equal(r.category, 'success'); assert.equal((r.body as Record<string, unknown>).schemaVersion, 'bcp.c07.data-source-boundary-readiness.v1-code-config'); });
test('AUTHORIZED: fully-valid HEAD ⇒ 200 bodyless (no envelope on HEAD)', () => { const r = H(base({ method: 'HEAD' })); assert.equal(r.httpStatus, 200); assert.equal(r.category, 'success'); assert.equal(r.body, null); });
test('AUTHORIZED: GET now EMITS the envelope (200 reached via the real guard entry, not faked)', () => { const r = H(base()); const b = r.body as Record<string, unknown>; assert.equal(b.schemaVersion, 'bcp.c07.data-source-boundary-readiness.v1-code-config'); assert.equal(b.selfAttestation, 'design_time_code_config'); assert.equal(b.generatedAt, undefined); });
test('AUTHORIZED: hostile hints WITH valid principal still 200 (hints never authority; same envelope)', () => { const r = H(base({ hints: { clientSuppliedUid: 'evil', bodyInternalUserId: 'x', urlTenantParam: 't' } })); assert.equal(r.httpStatus, 200); assert.deepEqual(r.body, buildC07DataSourceBoundaryEnvelope(ITEMS)); });
test('AUTHORIZED: GET success body deep-equals the read-model builder output for the same items', () => assert.deepEqual(H(base()).body, buildC07DataSourceBoundaryEnvelope(ITEMS)));

// --- denied/disabled requests never consume items ---
test('DENIED GET (null principal) does NOT consume items (array proxy throwing on EVERY access ⇒ no throw, 403)', () => {
  const throwingItems = new Proxy([] as unknown[], { get() { throw new Error('boom'); }, has() { throw new Error('boom'); } }) as unknown as readonly C07BoundaryItemInput[];
  let r: ReturnType<typeof H> | undefined;
  assert.doesNotThrow(() => { r = H(base({ principal: null, items: throwingItems })); });
  assert.equal(r?.httpStatus, 403);
});
test('AUTHORIZED GET consumes items ONLY after the guard passes (real items ⇒ envelope reflects them)', () => {
  // Pairs with the denied throwing-proxy above: denied ⇒ items untouched; authorized ⇒ items are read to build
  // the envelope. Same server-owned ITEMS ⇒ the success body equals the builder output.
  const r = H(base());
  assert.equal(r.httpStatus, 200);
  assert.deepEqual(r.body, buildC07DataSourceBoundaryEnvelope(ITEMS));
});
test('disabled request does NOT consume items (throwing items proxy ⇒ no throw, 404)', () => {
  const throwingItems = new Proxy([] as unknown[], { get(_t, p) { if (p === 'length') return 1; throw new Error('boom'); } }) as unknown as readonly C07BoundaryItemInput[];
  let r: ReturnType<typeof H> | undefined;
  assert.doesNotThrow(() => { r = H(base({ featureEnabled: false, items: throwingItems })); });
  assert.equal(r?.httpStatus, 404);
});

// --- no-throw / safe-error ---
test('handler no-throw on a hostile throwing method getter ⇒ safe 500', () => {
  const r: Record<string, unknown> = { isDevEnvironment: true, featureEnabled: true, principal: PRINCIPAL, items: ITEMS };
  Object.defineProperty(r, 'method', { enumerable: true, get() { throw new Error('boom'); } });
  let out: ReturnType<typeof H> | undefined;
  assert.doesNotThrow(() => { out = H(r as unknown as BcpC07RouteRequest); });
  assert.equal(out?.httpStatus, 500);
  assert.deepEqual(out?.body, { status: 'error' });
});
test('HEAD stays bodyless even on the error path (throwing gate getter ⇒ 500 body null)', () => {
  const r: Record<string, unknown> = { method: 'HEAD', featureEnabled: true, principal: PRINCIPAL, items: ITEMS };
  Object.defineProperty(r, 'isDevEnvironment', { enumerable: true, get() { throw new Error('boom'); } });
  let out: ReturnType<typeof H> | undefined;
  assert.doesNotThrow(() => { out = H(r as unknown as BcpC07RouteRequest); });
  assert.equal(out?.httpStatus, 500);
  assert.equal(out?.body, null); // HEAD must carry no body on EVERY branch, including error
});
test('no raw errors / stack traces in any response body', () => { for (const m of ['GET', 'HEAD', 'OPTIONS', 'POST']) assert.ok(!/Error:|at Object\.|"stack":/.test(JSON.stringify(H(base({ method: m })).body)), m); });
test('every reachable DENIED/DISABLED state produces a SAFE denied/disabled body', () => {
  assertSafeDeniedBody(H(base({ isDevEnvironment: false })).body);
  assertSafeDeniedBody(H(base({ featureEnabled: false })).body);
  assertSafeDeniedBody(H(base({ method: 'OPTIONS' })).body);
  assertSafeDeniedBody(H(base({ method: 'POST' })).body);
  assertSafeDeniedBody(H(base({ principal: null })).body);
  assertSafeDeniedBody(H(base({ principal: { ...PRINCIPAL, parityState: 'unresolved' } })).body);
  // NOTE: H(base()) is now the AUTHORIZED 200 envelope (asserted separately) — deliberately NOT a denied body.
});

// --- authority is server-side only: request hint fields never change the outcome ---
test('gating outcome ignores all hint fields (authority server-side)', () => assert.deepEqual(H(base()).body, H(base({ hints: { bodyInternalUserId: 'evil', urlTenantParam: 't', urlStoreParam: 's', frontendRoleLabel: 'admin' } })).body));

// --- success-envelope CONTRACT (proven at the read-model builder; route surfaces it once M36 lands) ---
test('CONTRACT: builder emits v1 schema, design_time_code_config self-attestation, and NO generatedAt', () => {
  const env = buildC07DataSourceBoundaryEnvelope(ITEMS);
  assert.equal(env.schemaVersion, 'bcp.c07.data-source-boundary-readiness.v1-code-config');
  assert.equal(env.selfAttestation, 'design_time_code_config');
  assert.equal((env as unknown as Record<string, unknown>).generatedAt, undefined);
});
test('CONTRACT: success envelope passes output-key allow-list (no generatedAt/timestamp/raw key)', () => assert.doesNotThrow(() => assertBcpC07OutputKeyAllowList(buildC07DataSourceBoundaryEnvelope(ITEMS))));
test('CONTRACT: success envelope passes value-content closed-set gate', () => assert.doesNotThrow(() => assertBcpC07ValueContentSafety(buildC07DataSourceBoundaryEnvelope(ITEMS))));
test('CONTRACT: success envelope carries NO production-readiness claim', () => assert.doesNotThrow(() => assertBcpC07ProductionReadinessClaimBan(buildC07DataSourceBoundaryEnvelope(ITEMS))));
test('CONTRACT: success envelope keeps declared self-attestation framing (non-verifier)', () => assert.doesNotThrow(() => assertBcpC07SelfAttestationFraming(buildC07DataSourceBoundaryEnvelope(ITEMS))));

// --- route success body (not just the builder) passes the C-07 fitness gates ---
test('AUTHORIZED: route success body passes output-key / value / production-ban / self-attestation gates', () => {
  const env = H(base()).body as ReturnType<typeof buildC07DataSourceBoundaryEnvelope>;
  assert.doesNotThrow(() => assertBcpC07OutputKeyAllowList(env));
  assert.doesNotThrow(() => assertBcpC07ValueContentSafety(env));
  assert.doesNotThrow(() => assertBcpC07ProductionReadinessClaimBan(env));
  assert.doesNotThrow(() => assertBcpC07SelfAttestationFraming(env));
});

// --- guard authorization (direct): the additive 'C-07' entry maps only to overview_viewer; nothing else moved ---
const guardReq = (contractId: string, principal: SyntheticServerPrincipal | null = PRINCIPAL) => authorizeBcpRead({ contractId, featureEnabled: true, principal });
test('GUARD: C-07 now maps to overview_viewer ⇒ allow for the valid principal', () => { const g = guardReq('C-07'); assert.equal(g.decision, 'allow'); assert.equal(g.reasonCode, 'allow'); });
test('GUARD: unknown id (C-99) still denies unknown_contract (map widened by exactly one row)', () => { const g = guardReq('C-99'); assert.equal(g.decision, 'deny'); assert.equal(g.reasonCode, 'unknown_contract'); });
test('GUARD: C-01..C-06 mappings remain allow (unchanged by the additive C-07 row)', () => { for (const id of ['C-01', 'C-02', 'C-03', 'C-04', 'C-05', 'C-06']) assert.equal(guardReq(id).decision, 'allow', id); });
test('GUARD: insufficient capability (visibilityClass none) ⇒ deny for C-07', () => { const g = guardReq('C-07', { ...PRINCIPAL, visibilityClass: 'none' }); assert.equal(g.decision, 'deny'); assert.equal(g.reasonCode, 'insufficient_visibility'); });
test('GUARD: null principal ⇒ deny for C-07 (no request-supplied authority)', () => assert.equal(guardReq('C-07', null).decision, 'deny'));
test('GUARD: default-off — featureEnabled false ⇒ deny feature_disabled for C-07', () => { const g = authorizeBcpRead({ contractId: 'C-07', featureEnabled: false, principal: PRINCIPAL }); assert.equal(g.decision, 'deny'); assert.equal(g.reasonCode, 'feature_disabled'); });

(() => { let p = 0; const f: string[] = []; for (const c of cases) { try { c.fn(); p++; console.log('PASS ' + c.name); } catch (e) { f.push(c.name + ' :: ' + (e instanceof Error ? e.message : String(e))); console.log('FAIL ' + c.name); } } console.log(`\n[M35 BCP C-07 route] ${p}/${cases.length} passed`); if (f.length) { console.log('FAILURES:'); for (const x of f) console.log('  - ' + x); process.exit(1); } console.log('ALL_TESTS_PASSED'); process.exit(0); })();

// Phase 2.0 M35 — Tests for the inert C-07 data-source-boundary route boundary handler.
//
// GUARD-GAP (M34 §12): the shared guard maps C-01..C-06 only, so a pinned-'C-07' authorized GET/HEAD
// fail-closes to 403 not_authorized (unknown_contract). These tests assert the REACHABLE gate/denial paths
// honestly, prove denied/disabled requests never consume items, and lock the success-envelope CONTRACT at the
// read-model builder layer (the route surfaces it once the additive 'C-07' guard entry lands in M36). No test
// fakes, injects, or bypasses guard authorization.
import assert from 'node:assert/strict';
import { handleBcpC07DataSourceBoundaryRequest, type BcpC07RouteRequest } from './bcpC07DataSourceBoundaryReadOnlyRoute';
import type { SyntheticServerPrincipal } from './bcpAuthorizationGuard';
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

// --- guard-gap: authorized GET/HEAD fail-close to 403 unknown_contract (200 deferred to M36, not faked) ---
test('GUARD-GAP: fully-valid GET ⇒ 403 not_authorized (no C-07 guard entry)', () => { const r = H(base()); assert.equal(r.httpStatus, 403); assert.equal(r.category, 'not_authorized'); assertSafeDeniedBody(r.body); });
test('GUARD-GAP: fully-valid HEAD ⇒ 403 bodyless', () => { const r = H(base({ method: 'HEAD' })); assert.equal(r.httpStatus, 403); assert.equal(r.body, null); });
test('GUARD-GAP: authorized GET does NOT emit an envelope (200 deferred; not faked)', () => { const r = H(base()); assert.equal((r.body as Record<string, unknown>).schemaVersion, undefined); });
test('hostile hints WITH valid principal still 403 (hints not authority; guard-gap holds)', () => assert.equal(H(base({ hints: { clientSuppliedUid: 'evil', bodyInternalUserId: 'x', urlTenantParam: 't' } })).httpStatus, 403));

// --- denied/disabled requests never consume items ---
test('denied GET does NOT consume items (array proxy throwing on EVERY access ⇒ no throw, still 403)', () => {
  const throwingItems = new Proxy([] as unknown[], { get() { throw new Error('boom'); }, has() { throw new Error('boom'); } }) as unknown as readonly C07BoundaryItemInput[];
  let r: ReturnType<typeof H> | undefined;
  assert.doesNotThrow(() => { r = H(base({ items: throwingItems })); });
  assert.equal(r?.httpStatus, 403);
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
test('every reachable state produces a SAFE denied/disabled body', () => {
  assertSafeDeniedBody(H(base({ isDevEnvironment: false })).body);
  assertSafeDeniedBody(H(base({ featureEnabled: false })).body);
  assertSafeDeniedBody(H(base({ method: 'OPTIONS' })).body);
  assertSafeDeniedBody(H(base({ method: 'POST' })).body);
  assertSafeDeniedBody(H(base({ principal: null })).body);
  assertSafeDeniedBody(H(base({ principal: { ...PRINCIPAL, parityState: 'unresolved' } })).body);
  assertSafeDeniedBody(H(base()).body); // guard-gap 403
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

(() => { let p = 0; const f: string[] = []; for (const c of cases) { try { c.fn(); p++; console.log('PASS ' + c.name); } catch (e) { f.push(c.name + ' :: ' + (e instanceof Error ? e.message : String(e))); console.log('FAIL ' + c.name); } } console.log(`\n[M35 BCP C-07 route] ${p}/${cases.length} passed`); if (f.length) { console.log('FAILURES:'); for (const x of f) console.log('  - ' + x); process.exit(1); } console.log('ALL_TESTS_PASSED'); process.exit(0); })();

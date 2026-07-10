// Phase 3.0 M2 — Tests for the "Acknowledge Backend CP Readiness Review" controlled-action pilot:
// the pure handler + the action authorization guard + the DEV-only advisory audit sink.
//
// Posture (per Phase 3.0 M1): DEV-only, POST-only, non-destructive (audit-only), no live DB/Supabase/provider.
// Authority is a SERVER-DERIVED principal (system_owner) + platform `manage` permission — never a request field.
// The advisory sink is injectable and in-memory; it NEVER calls writeAuditEvent/getDb. Reason free-text is
// bounded + sanitized in the handler and NEVER stored raw in any audit event.
import assert from 'node:assert/strict';
import {
  handleBcpActionAcknowledgeReadinessReview,
  sanitizeAckReason,
  BCP_ACTION_ACK_KEY,
  REASON_MIN,
  REASON_MAX,
  type AckRequest,
} from './bcpActionAcknowledgeReadinessReview';
import { authorizeBcpAction, BCP_ACTION_VISIBILITY_FLOOR, BCP_ACTION_PERMISSION_FLOOR } from './bcpActionAuthorizationGuard';
import { createRecordingActionAuditSink } from './bcpActionAuditSink';
import type { SyntheticServerPrincipal } from './bcpAuthorizationGuard';
import type { PermissionLevelValue } from '../platform-identity/authorizationConstants';

const OWNER: SyntheticServerPrincipal = {
  source: 'server_derived', internalUserId: 'iu_synthetic_dev', authProvider: 'supabase',
  verified: true, scopeType: 'platform', parityState: 'ready', visibilityClass: 'system_owner',
};
const okBody = () => ({ confirm: true, reason: 'Reviewed C-07 readiness lens.', idempotencyKey: 'ack-key-0001', lensKey: 'C-07' });

const base = (o: Partial<AckRequest> = {}): AckRequest => ({
  method: 'POST', isDevEnvironment: true, featureEnabled: true, principal: OWNER,
  platformPermissionLevel: 'manage', body: okBody(), sink: createRecordingActionAuditSink(),
  idempotencyStore: new Set<string>(), ...o,
});
const H = handleBcpActionAcknowledgeReadinessReview;

// A denied/disabled/invalid body may only carry closed, safe fields — never raw reason text, secrets, stack, path.
function assertSafeBody(body: unknown): void {
  const s = JSON.stringify(body);
  assert.ok(!/Error:|at Object\.|"stack":|password|token|service_role|:\/\//i.test(s), `unsafe body: ${s}`);
}

const cases: { name: string; fn: () => void }[] = [];
const test = (n: string, fn: () => void) => cases.push({ name: n, fn });

// ============================ Feature / environment gates ============================
test('non-POST method => 405 method_not_allowed, 0 audit', () => {
  const sink = createRecordingActionAuditSink();
  const r = H(base({ method: 'GET', sink }));
  assert.equal(r.httpStatus, 405); assert.equal(r.category, 'method_not_allowed');
  assert.equal(sink.events.length, 0); assertSafeBody(r.body);
});
test('production (isDevEnvironment false) => 404 dev_only, 0 audit', () => {
  const sink = createRecordingActionAuditSink();
  const r = H(base({ isDevEnvironment: false, sink }));
  assert.equal(r.httpStatus, 404); assert.equal(r.category, 'dev_only'); assert.equal(sink.events.length, 0);
});
test('flag OFF => 404 feature_disabled, 0 audit', () => {
  const sink = createRecordingActionAuditSink();
  const r = H(base({ featureEnabled: false, sink }));
  assert.equal(r.httpStatus, 404); assert.equal(r.category, 'feature_disabled'); assert.equal(sink.events.length, 0);
});
test('production precedes flag (both off => dev_only)', () => {
  const r = H(base({ isDevEnvironment: false, featureEnabled: false }));
  assert.equal(r.category, 'dev_only');
});

// ============================ Authorization (guard) ============================
test('null principal => 403 not_authorized + exactly 1 deny audit', () => {
  const sink = createRecordingActionAuditSink();
  const r = H(base({ principal: null, sink }));
  assert.equal(r.httpStatus, 403); assert.equal(r.category, 'not_authorized');
  assert.equal(sink.events.length, 1); assert.equal(sink.events[0].decision, 'deny'); assert.equal(sink.events[0].result, 'denied');
});
test('unverified principal => 403', () => assert.equal(H(base({ principal: { ...OWNER, verified: false } })).httpStatus, 403));
test('null internalUserId => 403', () => assert.equal(H(base({ principal: { ...OWNER, internalUserId: null } })).httpStatus, 403));
test('non-ready parity => 409 parity_blocked + 1 deny audit', () => {
  const sink = createRecordingActionAuditSink();
  const r = H(base({ principal: { ...OWNER, parityState: 'unresolved' }, sink }));
  assert.equal(r.httpStatus, 409); assert.equal(r.category, 'parity_blocked'); assert.equal(sink.events.length, 1);
});
test('non-system-owner visibility (overview_viewer) => 403 insufficient_visibility', () => {
  const sink = createRecordingActionAuditSink();
  const r = H(base({ principal: { ...OWNER, visibilityClass: 'overview_viewer' }, sink }));
  assert.equal(r.httpStatus, 403); assert.equal(sink.events[0].reasonCode, 'insufficient_visibility');
});
test('sensitive_viewer (rank 4, below system_owner) => 403', () =>
  assert.equal(H(base({ principal: { ...OWNER, visibilityClass: 'sensitive_viewer' } })).httpStatus, 403));
test('permission below manage (edit) => 403 insufficient_permission', () => {
  const sink = createRecordingActionAuditSink();
  const r = H(base({ platformPermissionLevel: 'edit', sink }));
  assert.equal(r.httpStatus, 403); assert.equal(sink.events[0].reasonCode, 'insufficient_permission');
});
test('permission approve (platform ordering: approve < manage) => 403', () =>
  assert.equal(H(base({ platformPermissionLevel: 'approve' })).httpStatus, 403));
test('permission null => 403 insufficient_permission', () =>
  assert.equal(H(base({ platformPermissionLevel: null })).httpStatus, 403));
test('permission full (>= manage) => 200 success', () =>
  assert.equal(H(base({ platformPermissionLevel: 'full' })).httpStatus, 200));
test('read-only plan cap denies (manage capped to view) => 403', () =>
  assert.equal(H(base({ planReadOnly: true })).httpStatus, 403));
test('overdue plan cap denies => 403', () =>
  assert.equal(H(base({ planOverdue: true })).httpStatus, 403));
test('system_owner + manage + all gates => 200 success', () => {
  const r = H(base());
  assert.equal(r.httpStatus, 200); assert.equal(r.category, 'success');
  assert.equal((r.body as Record<string, unknown>).actionKey, BCP_ACTION_ACK_KEY);
});

// ============================ Request-body cannot elevate authority ============================
test('body actor/role/permission fields are REJECTED (strict schema) before any auth grant', () => {
  const r = H(base({ body: { ...okBody(), userId: 'x', role: 'system_owner', permissions: { platform: 'full' }, visibilityClass: 'system_owner' } }));
  assert.equal(r.httpStatus, 400); assert.equal(r.category, 'invalid');
  assert.equal((r.body as Record<string, unknown>).code, 'unexpected_field');
});
test('malicious body + NON-qualifying principal => still 403 (body never authority)', () => {
  const r = H(base({ principal: { ...OWNER, visibilityClass: 'overview_viewer' }, body: { ...okBody(), role: 'system_owner' } }));
  assert.equal(r.httpStatus, 403);
});

// ============================ Confirmation ============================
test('missing confirm => 400 confirmation_required', () => {
  const b = okBody() as Record<string, unknown>; delete b.confirm;
  assert.equal((H(base({ body: b })).body as Record<string, unknown>).code, 'confirmation_required');
});
test('confirm false => 400 confirmation_required', () =>
  assert.equal((H(base({ body: { ...okBody(), confirm: false } })).body as Record<string, unknown>).code, 'confirmation_required'));
test('confirm non-boolean => 400 confirmation_required', () =>
  assert.equal((H(base({ body: { ...okBody(), confirm: 'true' } })).body as Record<string, unknown>).code, 'confirmation_required'));

// ============================ Reason bounds + sanitization ============================
test('missing reason => 400 reason_required', () => {
  const b = okBody() as Record<string, unknown>; delete b.reason;
  assert.equal((H(base({ body: b })).body as Record<string, unknown>).code, 'reason_required');
});
test('empty reason => reason_required', () =>
  assert.equal((H(base({ body: { ...okBody(), reason: '' } })).body as Record<string, unknown>).code, 'reason_required'));
test('whitespace-only reason => reason_required', () =>
  assert.equal((H(base({ body: { ...okBody(), reason: '   ' } })).body as Record<string, unknown>).code, 'reason_required'));
test('reason shorter than REASON_MIN => reason_required', () =>
  assert.equal((H(base({ body: { ...okBody(), reason: 'ok' } })).body as Record<string, unknown>).code, 'reason_required'));
test('reason longer than REASON_MAX => reason_too_long', () =>
  assert.equal((H(base({ body: { ...okBody(), reason: 'a'.repeat(REASON_MAX + 1) } })).body as Record<string, unknown>).code, 'reason_too_long'));
test('reason with secret-shaped content => reason_unsafe (rejected, not stored)', () =>
  assert.equal((H(base({ body: { ...okBody(), reason: 'token=eyJhbGciOiJ' } })).body as Record<string, unknown>).code, 'reason_unsafe'));
test('reason with URL => reason_unsafe', () =>
  assert.equal((H(base({ body: { ...okBody(), reason: 'see https://evil.example' } })).body as Record<string, unknown>).code, 'reason_unsafe'));
test('reason with control char => reason_unsafe', () =>
  assert.equal((H(base({ body: { ...okBody(), reason: 'badchar' } })).body as Record<string, unknown>).code, 'reason_unsafe'));
test('valid bounded reason => 200 success', () => assert.equal(H(base()).httpStatus, 200));
test('REASON_MIN/MAX are sane bounds', () => { assert.ok(REASON_MIN >= 1 && REASON_MAX > REASON_MIN); });
test('sanitizeAckReason trims + accepts safe text', () => {
  const r = sanitizeAckReason('  Reviewed the lens.  ');
  assert.equal(r.ok, true); assert.equal(r.value, 'Reviewed the lens.');
});
test('SUCCESS audit never contains the raw reason text (only reasonProvided boolean)', () => {
  const sink = createRecordingActionAuditSink();
  H(base({ body: { ...okBody(), reason: 'Reviewed the special marker note.' }, sink }));
  assert.equal(sink.events.length, 1);
  assert.ok(!JSON.stringify(sink.events[0]).includes('special marker note'), 'reason text leaked into audit');
  assert.equal(sink.events[0].reasonProvided, true);
});

// ============================ Idempotency / duplicate prevention ============================
test('missing idempotencyKey => 400 idempotency_key_required', () => {
  const b = okBody() as Record<string, unknown>; delete b.idempotencyKey;
  assert.equal((H(base({ body: b })).body as Record<string, unknown>).code, 'idempotency_key_required');
});
test('malformed idempotencyKey => 400 idempotency_key_invalid', () =>
  assert.equal((H(base({ body: { ...okBody(), idempotencyKey: 'bad key!' } })).body as Record<string, unknown>).code, 'idempotency_key_invalid'));
test('first valid request executes once (1 success audit, key stored)', () => {
  const store = new Set<string>(); const sink = createRecordingActionAuditSink();
  const r = H(base({ idempotencyStore: store, sink }));
  assert.equal(r.category, 'success'); assert.equal(sink.events.length, 1); assert.ok(store.has('ack-key-0001'));
});
test('duplicate accepted key => 200 duplicate, NO second marker (0 new audit)', () => {
  const store = new Set<string>();
  const sink1 = createRecordingActionAuditSink(); H(base({ idempotencyStore: store, sink: sink1 }));
  const sink2 = createRecordingActionAuditSink();
  const r = H(base({ idempotencyStore: store, sink: sink2 }));
  assert.equal(r.httpStatus, 200); assert.equal(r.category, 'duplicate');
  assert.equal((r.body as Record<string, unknown>).alreadyAcknowledged, true);
  assert.equal(sink2.events.length, 0, 'duplicate must not emit a second marker');
});
test('sink throw on success does NOT persist the key (retry re-attempts, not silent duplicate)', () => {
  const store = new Set<string>();
  let calls = 0;
  const flakySink = { record() { calls++; if (calls === 1) throw new Error('boom'); } };
  const r1 = H(base({ idempotencyStore: store, sink: flakySink }));
  assert.equal(r1.httpStatus, 500);
  assert.equal(store.has('ack-key-0001'), false, 'key must NOT be stored when the audit marker failed');
  const sink2 = createRecordingActionAuditSink();
  const r2 = H(base({ idempotencyStore: store, sink: sink2 }));
  assert.equal(r2.category, 'success'); assert.equal(sink2.events.length, 1);
});
test('body with __proto__ key is rejected (unexpected_field)', () =>
  assert.equal((H(base({ body: JSON.parse('{"confirm":true,"reason":"Reviewed lens.","idempotencyKey":"ack-key-0001","lensKey":"C-07","__proto__":{"x":1}}') })).body as Record<string, unknown>).code, 'unexpected_field'));
test('different key evaluated independently (2 distinct successes)', () => {
  const store = new Set<string>(); const sink = createRecordingActionAuditSink();
  H(base({ idempotencyStore: store, sink, body: { ...okBody(), idempotencyKey: 'ack-key-aaaa' } }));
  const r = H(base({ idempotencyStore: store, sink, body: { ...okBody(), idempotencyKey: 'ack-key-bbbb' } }));
  assert.equal(r.category, 'success'); assert.equal(sink.events.length, 2);
});

// ============================ Lens key ============================
test('invalid lensKey => 400 lens_invalid', () =>
  assert.equal((H(base({ body: { ...okBody(), lensKey: 'C-99' } })).body as Record<string, unknown>).code, 'lens_invalid'));
test('lensKey ALL accepted => 200', () =>
  assert.equal(H(base({ body: { ...okBody(), lensKey: 'ALL' } })).httpStatus, 200));

// ============================ Malformed body / no-throw ============================
test('non-object body => 400 malformed_body', () =>
  assert.equal((H(base({ body: 'not-an-object' })).body as Record<string, unknown>).code, 'malformed_body'));
test('null body => 400 malformed_body', () =>
  assert.equal((H(base({ body: null })).body as Record<string, unknown>).code, 'malformed_body'));
test('array body => 400 malformed_body', () =>
  assert.equal((H(base({ body: [1, 2, 3] })).body as Record<string, unknown>).code, 'malformed_body'));
test('handler no-throw on hostile throwing sink => safe 500', () => {
  const throwingSink = { record() { throw new Error('boom'); } };
  let out: ReturnType<typeof H> | undefined;
  assert.doesNotThrow(() => { out = H(base({ sink: throwingSink })); });
  assert.equal(out?.httpStatus, 500); assert.deepEqual(out?.body, { status: 'error' });
});

// ============================ Audit event SHAPE + advisory label ============================
test('SUCCESS emits exactly 1 advisory event, dev_sidecar_log_advisory label (NOT durable)', () => {
  const sink = createRecordingActionAuditSink(); H(base({ sink }));
  const e = sink.events[0];
  assert.equal(e.evidenceLevel, 'dev_sidecar_log_advisory');
  assert.notEqual(e.evidenceLevel as unknown as string, 'durable_compliance_event');
  assert.equal(e.decision, 'allow'); assert.equal(e.result, 'success'); assert.equal(e.actionKey, BCP_ACTION_ACK_KEY);
  assert.equal(e.actorType, 'server_derived_synthetic'); assert.equal(e.actorId, 'iu_synthetic_dev');
  assert.equal(e.correlationKey, 'ack-key-0001'); assert.equal(e.lensKey, 'C-07');
});
test('deny audit carries NO body-derived data (safe n_a placeholders)', () => {
  const sink = createRecordingActionAuditSink();
  H(base({ principal: null, sink, body: { ...okBody(), reason: 'super hidden note phrase' } }));
  const e = sink.events[0];
  assert.equal(e.decision, 'deny'); assert.ok(!JSON.stringify(e).includes('hidden note phrase'));
  assert.equal(e.correlationKey, 'n_a'); assert.equal(e.lensKey, 'n_a');
});
test('every event is JSON-safe (no secrets/tokens/paths/stack)', () => {
  const sink = createRecordingActionAuditSink();
  H(base({ sink })); H(base({ principal: null, sink }));
  for (const e of sink.events) assertSafeBody(e);
});

// ============================ Guard direct + floors ============================
test('GUARD floors: system_owner visibility + manage permission', () => {
  assert.equal(BCP_ACTION_VISIBILITY_FLOOR, 'system_owner');
  assert.equal(BCP_ACTION_PERMISSION_FLOOR, 'manage');
});
test('GUARD: allow only when dev+flag+system_owner+manage all hold', () => {
  const g = authorizeBcpAction({ actionKey: BCP_ACTION_ACK_KEY, isDevEnvironment: true, featureEnabled: true, principal: OWNER, platformPermissionLevel: 'manage' as PermissionLevelValue });
  assert.equal(g.decision, 'allow');
});
test('GUARD: production => deny production_forbidden', () => {
  const g = authorizeBcpAction({ actionKey: BCP_ACTION_ACK_KEY, isDevEnvironment: false, featureEnabled: true, principal: OWNER, platformPermissionLevel: 'manage' });
  assert.equal(g.decision, 'deny'); assert.equal(g.reasonCode, 'production_forbidden');
});
test('GUARD: hints are never authority', () => {
  const g = authorizeBcpAction({ actionKey: BCP_ACTION_ACK_KEY, isDevEnvironment: true, featureEnabled: true, principal: null, platformPermissionLevel: 'manage', hints: { clientSuppliedUid: 'evil', frontendRoleLabel: 'system_owner' } });
  assert.equal(g.decision, 'deny'); assert.equal(g.reasonCode, 'untrusted_authority_only');
});

// ============================ No mutation / scope ============================
test('success DTO exposes only closed safe fields (no raw data / audit dump)', () => {
  const r = H(base()); const b = r.body as Record<string, unknown>;
  for (const k of Object.keys(b)) assert.ok(['status', 'actionKey', 'acknowledged', 'auditRecorded', 'lensKey', 'correlationKey'].includes(k), `unexpected success key: ${k}`);
  assertSafeBody(b);
});

(() => { let p = 0; const f: string[] = []; for (const c of cases) { try { c.fn(); p++; } catch (e) { f.push(c.name + ' :: ' + (e instanceof Error ? e.message : String(e))); } } console.log(`\n[P3.0 M2 BCP action ack handler] ${p}/${cases.length} passed`); if (f.length) { console.log('FAILURES:'); for (const x of f) console.log('  - ' + x); process.exit(1); } console.log('ALL_TESTS_PASSED'); process.exit(0); })();

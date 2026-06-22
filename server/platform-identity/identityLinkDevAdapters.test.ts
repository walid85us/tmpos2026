// Phase 1.6 M20.13 — Unit tests for the identity-link DEV repository adapter + audit adapter.
//
// Self-contained, in-memory, DB-FREE. Runnable via `npx tsx <thisfile>` (the repo ships no test
// framework; mirrors the existing assertion-script convention). Uses Node's built-in assert. NO real
// ids/uids/emails/tokens/secrets — obvious fake placeholders only. NO Supabase env vars, NO Supabase
// MCP, NO real DB connection, NO real rows inserted. Fakes route on the adapter's `il_op=` markers.

import assert from 'node:assert/strict';
import {
  createIdentityLinkAdminProvisioningService,
  IDENTITY_LINK_AUDIT_EVENTS,
  type IdentityLinkAuditEvent,
  type IdentityLinkAuditSink,
  type IdentityLinkRepository,
  type IdentityLinkProvisionRequest,
  type IdentityLinkLifecycleRequest,
} from './identityLinkAdminProvisioning';
import {
  createIdentityLinkDevRepository,
  classifyDbError,
  SafeRepositoryError,
} from './identityLinkDevRepository';
import {
  createIdentityLinkAuditAdapter,
  buildIdentityLinkAuditWriteInput,
  buildSafeIdentityLinkAuditPayload,
  sanitizeIdentityLinkAuditPayload,
  decisionForOutcome,
  resultStatusForOutcome,
  SafeAuditError,
  IDENTITY_LINK_AUDIT_METADATA_ALLOWLIST,
  type DurableAuditWriteFn,
} from './identityLinkAuditAdapter';
import type { AuditEventWriteInput } from './auditEventWriter';

// ---- Fake placeholders (NOT real values; none are UUID/email shaped) ----
const FB = 'FAKE_FB_REFERENCE_zzz';
const SB = 'FAKE_SB_REFERENCE_zzz';
const ANCHOR = 'FAKE_ANCHOR_REFERENCE_zzz';
const REQ = 'FAKE_REQUESTER_REF_zzz';
const APV = 'FAKE_APPROVER_REF_zzz';
const SECRET = 'FAKE_SECRET_DETAIL_zzz';
const LINK_REF = 'LINK_REF_MOCK';
const SENSITIVE = [FB, SB, ANCHOR, REQ, APV, SECRET];

// ---- Routed fake SQL executor (DB-free). Routes on the `il_op=NAME` marker comment. ----
// OpHandler may return a malformed/non-array value (undefined/null/{}) to exercise the adapter's
// defensive handling — it is not constrained to a row array.
type OpHandler = (values: any[]) => any;
function makeRoutedSql(handlers: Record<string, OpHandler>) {
  const calls: { op: string; values: any[]; text: string }[] = [];
  const sql = (strings: TemplateStringsArray, ...values: any[]): Promise<any> => {
    const text = strings.join(' ? ');
    const m = text.match(/il_op=(\w+)/);
    const op = m ? m[1] : 'unknown';
    calls.push({ op, values, text });
    const handler = handlers[op];
    if (!handler) return Promise.resolve([]);
    try {
      return Promise.resolve(handler(values));
    } catch (err) {
      return Promise.reject(err);
    }
  };
  return {
    sql,
    calls,
    ops: () => calls.map((c) => c.op),
    textFor: (op: string) => calls.find((c) => c.op === op)?.text ?? '',
  };
}
function repoWith(handlers: Record<string, OpHandler>) {
  const routed = makeRoutedSql(handlers);
  const repo = createIdentityLinkDevRepository({ sql: routed.sql as any });
  return { repo, calls: routed.calls, ops: routed.ops, textFor: routed.textFor };
}

// ---- Fake durable audit writer (records inputs; DB-free) ----
function makeFakeWriter(opts: { throw?: boolean } = {}) {
  const writes: AuditEventWriteInput[] = [];
  const fn: DurableAuditWriteFn = async (event) => {
    if (opts.throw) throw new Error(`writer boom detail ${SECRET}`);
    writes.push(event);
    return { eventId: 'EVENT_REF_MOCK', requestId: event.requestId };
  };
  return { writes, fn };
}

function goodRequest(over: Partial<IdentityLinkProvisionRequest> = {}): IdentityLinkProvisionRequest {
  return {
    operation: 'create',
    environment: 'dev',
    anchorRef: ANCHOR,
    firebaseProof: { provider: 'firebase', reference: FB, verified: true },
    supabaseProof: { provider: 'supabase', reference: SB, verified: true },
    verificationMethod: 'verified_both_sides',
    approval: { requestedByRef: REQ, approvedByRef: APV },
    correlationLabel: 'corr-001',
    ...over,
  };
}

function assertNoSensitive(blob: string, label: string): void {
  for (const tok of SENSITIVE) {
    assert.ok(!blob.includes(tok), `redaction breach (${label}): found "${tok}"`);
  }
}

// success-path handlers for a full create flow
const SUCCESS_HANDLERS: Record<string, OpHandler> = {
  anchor_eligibility: () => [{ ok: 1 }],
  provider_exists: () => [{ ok: 1 }],
  find_active_pair: () => [],
  find_active_firebase: () => [],
  find_active_supabase: () => [],
  find_historical_pair: () => [],
  create_active_link: () => [{ status: 'active' }],
};

// ---- Test registry ----
type Case = { name: string; fn: () => Promise<void> };
const cases: Case[] = [];
const C = (name: string, fn: () => Promise<void>) => cases.push({ name, fn });

// ========================= Repository adapter =========================

C('R1 getAnchorEligibility found / not-found', async () => {
  const found = repoWith({ anchor_eligibility: () => [{ ok: 1 }] });
  assert.deepEqual(await found.repo.getAnchorEligibility(ANCHOR), { found: true, eligible: true });
  const missing = repoWith({ anchor_eligibility: () => [] });
  assert.deepEqual(await missing.repo.getAnchorEligibility(ANCHOR), { found: false, eligible: false });
});

C('R2 providerReferenceExists true / false', async () => {
  const yes = repoWith({ provider_exists: () => [{ ok: 1 }] });
  assert.equal(await yes.repo.providerReferenceExists('firebase', FB), true);
  const no = repoWith({ provider_exists: () => [] });
  assert.equal(await no.repo.providerReferenceExists('supabase', SB), false);
});

C('R3 findActiveLinkByPair present / null (exact pair)', async () => {
  const present = repoWith({ find_active_pair: () => [{ link_id: LINK_REF }] });
  assert.deepEqual(await present.repo.findActiveLinkByPair(FB, SB), { linkRef: LINK_REF });
  const none = repoWith({ find_active_pair: () => [] });
  assert.equal(await none.repo.findActiveLinkByPair(FB, SB), null);
});

C('R4 findActiveLinkByFirebaseRef present / null (firebase side)', async () => {
  const present = repoWith({ find_active_firebase: () => [{ link_id: LINK_REF }] });
  assert.deepEqual(await present.repo.findActiveLinkByFirebaseRef(FB), { linkRef: LINK_REF });
  const none = repoWith({ find_active_firebase: () => [] });
  assert.equal(await none.repo.findActiveLinkByFirebaseRef(FB), null);
});

C('R5 findActiveLinkBySupabaseRef present / null (supabase side)', async () => {
  const present = repoWith({ find_active_supabase: () => [{ link_id: LINK_REF }] });
  assert.deepEqual(await present.repo.findActiveLinkBySupabaseRef(SB), { linkRef: LINK_REF });
  const none = repoWith({ find_active_supabase: () => [] });
  assert.equal(await none.repo.findActiveLinkBySupabaseRef(SB), null);
});

C('R6 findHistoricalPair disabled/revoked / null', async () => {
  const disabled = repoWith({ find_historical_pair: () => [{ link_id: LINK_REF, status: 'disabled' }] });
  assert.deepEqual(await disabled.repo.findHistoricalPair(FB, SB), { linkRef: LINK_REF, lifecycleState: 'disabled' });
  const revoked = repoWith({ find_historical_pair: () => [{ link_id: LINK_REF, status: 'revoked' }] });
  assert.deepEqual(await revoked.repo.findHistoricalPair(FB, SB), { linkRef: LINK_REF, lifecycleState: 'revoked' });
  const none = repoWith({ find_historical_pair: () => [] });
  assert.equal(await none.repo.findHistoricalPair(FB, SB), null);
});

C('R7 createActiveLink success → active + issues an insert', async () => {
  const r = repoWith({ create_active_link: () => [{ status: 'active' }] });
  const res = await r.repo.createActiveLink({
    anchorRef: ANCHOR, firebaseReference: FB, supabaseReference: SB,
    verificationMethod: 'verified_both_sides', createdByRef: REQ, approvedByRef: APV,
  });
  assert.deepEqual(res, { lifecycleState: 'active' });
  assert.ok(r.ops().includes('create_active_link'), 'expected an insert op');
});

C('R8 createActiveLink unique violation → constraint_conflict (no leak)', async () => {
  const r = repoWith({ create_active_link: () => { throw { code: '23505', message: `dup ${SECRET}` }; } });
  await assert.rejects(
    r.repo.createActiveLink({ anchorRef: ANCHOR, firebaseReference: FB, supabaseReference: SB, verificationMethod: 'admin_provisioned', createdByRef: REQ, approvedByRef: APV }),
    (e: unknown) => {
      assert.ok(e instanceof SafeRepositoryError);
      assert.equal((e as SafeRepositoryError).code, 'constraint_conflict');
      assertNoSensitive((e as Error).message, 'R8 error message');
      return true;
    },
  );
});

C('R9 createActiveLink FK violation → missing_platform_identity', async () => {
  const r = repoWith({ create_active_link: () => { throw { code: '23503', message: `fk ${SECRET}` }; } });
  await assert.rejects(
    r.repo.createActiveLink({ anchorRef: ANCHOR, firebaseReference: FB, supabaseReference: SB, verificationMethod: 'admin_provisioned', createdByRef: REQ, approvedByRef: APV }),
    (e: unknown) => (e as SafeRepositoryError).code === 'missing_platform_identity',
  );
});

C('R10 setLifecycleState disable success', async () => {
  const r = repoWith({ set_lifecycle_state: () => [{ status: 'disabled' }] });
  assert.deepEqual(await r.repo.setLifecycleState(LINK_REF, 'disabled'), { lifecycleState: 'disabled' });
});

C('R11 setLifecycleState revoke success', async () => {
  const r = repoWith({ set_lifecycle_state: () => [{ status: 'revoked' }] });
  assert.deepEqual(await r.repo.setLifecycleState(LINK_REF, 'revoked'), { lifecycleState: 'revoked' });
});

C('R12 setLifecycleState no row → not_found', async () => {
  const r = repoWith({ set_lifecycle_state: () => [] });
  await assert.rejects(
    r.repo.setLifecycleState(LINK_REF, 'disabled'),
    (e: unknown) => (e as SafeRepositoryError).code === 'not_found',
  );
});

C('R13 findActiveLinkForLifecycle by ref / by pair / none', async () => {
  const byRef = repoWith({ find_active_for_lifecycle_by_ref: () => [{ link_id: LINK_REF }] });
  assert.deepEqual(await byRef.repo.findActiveLinkForLifecycle({ linkRef: LINK_REF }), { linkRef: LINK_REF });
  const byPair = repoWith({ find_active_for_lifecycle_by_pair: () => [{ link_id: LINK_REF }] });
  assert.deepEqual(await byPair.repo.findActiveLinkForLifecycle({ firebaseReference: FB, supabaseReference: SB }), { linkRef: LINK_REF });
  const none = repoWith({});
  assert.equal(await none.repo.findActiveLinkForLifecycle({}), null);
});

C('R14 classifyDbError mapping', async () => {
  assert.equal(classifyDbError({ code: '23505' }), 'constraint_conflict');
  assert.equal(classifyDbError({ code: '23503' }), 'missing_platform_identity');
  assert.equal(classifyDbError({ code: '23514' }), 'constraint_conflict');
  assert.equal(classifyDbError({ code: '23502' }), 'write_failed');
  assert.equal(classifyDbError({ code: '99999' }), 'unexpected_error');
  assert.equal(classifyDbError(new Error('no code ' + SECRET)), 'unexpected_error');
  assert.equal(classifyDbError(null), 'unexpected_error');
});

C('R15 production guard → factory throws production_blocked', async () => {
  const prior = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    assert.throws(
      () => createIdentityLinkDevRepository({ sql: (() => Promise.resolve([])) as any }),
      (e: unknown) => e instanceof SafeRepositoryError && (e as SafeRepositoryError).code === 'production_blocked',
    );
  } finally {
    if (prior === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prior;
  }
});

C('R16 raw DB error detail never leaks into SafeRepositoryError', async () => {
  const r = repoWith({ anchor_eligibility: () => { throw new Error(`host=db detail=${SECRET}`); } });
  await assert.rejects(
    r.repo.getAnchorEligibility(ANCHOR),
    (e: unknown) => {
      assert.ok(e instanceof SafeRepositoryError);
      assertNoSensitive((e as Error).message, 'R16');
      return true;
    },
  );
});

// ========================= Audit adapter =========================

function sampleEvent(over: Partial<IdentityLinkAuditEvent> = {}): IdentityLinkAuditEvent {
  return {
    actionCategory: 'identity_link',
    kind: IDENTITY_LINK_AUDIT_EVENTS.CREATE_SUCCEEDED,
    outcome: 'succeeded',
    sourceFlow: 'admin_provisioning',
    reasonCode: 'provisioned',
    verificationMethod: 'verified_both_sides',
    lifecycleState: 'active',
    policyDecision: true,
    correlationLabel: 'corr-audit',
    ...over,
  };
}

C('A1 buildIdentityLinkAuditWriteInput maps safely (actor null, scope none, actionId=kind)', async () => {
  const input = buildIdentityLinkAuditWriteInput(sampleEvent());
  assert.equal(input.actorInternalUserId, null);
  assert.equal(input.actorAuthProvider, null);
  assert.equal(input.scopeType, 'none');
  assert.equal(input.tenantId, null);
  assert.equal(input.storeId, null);
  assert.equal(input.actionId, IDENTITY_LINK_AUDIT_EVENTS.CREATE_SUCCEEDED);
  assert.equal(input.decision, 'allow');
  assert.equal(input.resultStatus, 'succeeded');
  assert.equal(input.reasonCode, 'provisioned');
  assert.equal(input.evidenceLevel, 'durable_compliance_event');
  assert.deepEqual(input.metadata, { phase: 'phase-1.6-m20.13' });
  assert.equal(input.requestId, 'corr-audit');
});

C('A2 buildSafeIdentityLinkAuditPayload allow-listed only + redactionApplied', async () => {
  const payload = buildSafeIdentityLinkAuditPayload(sampleEvent());
  for (const k of Object.keys(payload)) {
    assert.ok(IDENTITY_LINK_AUDIT_METADATA_ALLOWLIST.includes(k), `unexpected payload key: ${k}`);
  }
  assert.equal(payload.redactionApplied, true);
  assert.equal(payload.kind, IDENTITY_LINK_AUDIT_EVENTS.CREATE_SUCCEEDED);
});

C('A3 sanitize strips forbidden + non-allow-listed + non-scalar keys', async () => {
  const dirty = {
    outcome: 'succeeded',            // allow-listed scalar → kept
    email: SECRET,                   // forbidden key → dropped
    firebaseUid: FB,                 // forbidden key → dropped
    supabaseUid: SB,                 // forbidden key → dropped
    internalUserId: ANCHOR,          // forbidden key → dropped
    token: SECRET,                   // forbidden key → dropped
    somethingRandom: 'x',            // non-allow-listed → dropped
    nested: { a: 1 },                // non-scalar → dropped
  };
  const out = sanitizeIdentityLinkAuditPayload(dirty);
  assert.deepEqual(Object.keys(out), ['outcome']);
  assertNoSensitive(JSON.stringify(out), 'A3');
});

C('A4 emit success calls injected writer once with mapped input', async () => {
  const w = makeFakeWriter();
  const sink = createIdentityLinkAuditAdapter({ writeAuditEvent: w.fn });
  await sink.emit(sampleEvent());
  assert.equal(w.writes.length, 1);
  assert.equal(w.writes[0].actionId, IDENTITY_LINK_AUDIT_EVENTS.CREATE_SUCCEEDED);
  assert.equal(w.writes[0].actorInternalUserId, null);
});

C('A5 emit failure → SafeAuditError (no raw detail)', async () => {
  const w = makeFakeWriter({ throw: true });
  const sink = createIdentityLinkAuditAdapter({ writeAuditEvent: w.fn });
  await assert.rejects(
    sink.emit(sampleEvent()),
    (e: unknown) => {
      assert.ok(e instanceof SafeAuditError);
      assertNoSensitive((e as Error).message, 'A5');
      return true;
    },
  );
});

C('A6 M20.9 taxonomy coverage: actionId === kind for all kinds, no forbidden content', async () => {
  for (const kind of Object.values(IDENTITY_LINK_AUDIT_EVENTS)) {
    const input = buildIdentityLinkAuditWriteInput(sampleEvent({ kind: kind as any, outcome: 'requested' }));
    assert.equal(input.actionId, kind);
    assert.equal(input.actorInternalUserId, null);
    assertNoSensitive(JSON.stringify(input), `A6 ${kind}`);
  }
});

C('A7 decision/result outcome mapping', async () => {
  assert.equal(decisionForOutcome('succeeded'), 'allow');
  assert.equal(decisionForOutcome('rejected'), 'deny');
  assert.equal(decisionForOutcome('conflict'), 'deny');
  assert.equal(decisionForOutcome('requested'), 'not_applicable');
  assert.equal(resultStatusForOutcome('succeeded'), 'succeeded');
  assert.equal(resultStatusForOutcome('failed'), 'failed');
  assert.equal(resultStatusForOutcome('requested'), 'n_a');
});

C('A8 builder ignores injected forbidden fields on the event object', async () => {
  const evt = sampleEvent() as any;
  evt.email = SECRET; evt.firebaseUid = FB; evt.internalUserId = ANCHOR; evt.token = SECRET;
  const input = buildIdentityLinkAuditWriteInput(evt);
  const payload = buildSafeIdentityLinkAuditPayload(evt);
  assertNoSensitive(JSON.stringify({ input, payload }), 'A8');
});

// ========================= End-to-end (M20.11 service + new adapters) =========================

C('E1 adapters structurally satisfy the M20.11 contracts', async () => {
  const r = repoWith(SUCCESS_HANDLERS);
  const w = makeFakeWriter();
  const repoContract: IdentityLinkRepository = r.repo;          // compile-time assignment
  const sinkContract: IdentityLinkAuditSink = createIdentityLinkAuditAdapter({ writeAuditEvent: w.fn });
  assert.equal(typeof repoContract.createActiveLink, 'function');
  assert.equal(typeof sinkContract.emit, 'function');
});

C('E2 full provision success via real service + DEV adapters (fakes)', async () => {
  const r = repoWith(SUCCESS_HANDLERS);
  const w = makeFakeWriter();
  const svc = createIdentityLinkAdminProvisioningService({
    repository: r.repo,
    audit: createIdentityLinkAuditAdapter({ writeAuditEvent: w.fn }),
  });
  const res = await svc.provisionLink(goodRequest());
  assert.equal(res.ok, true);
  assert.equal(res.outcome, 'succeeded');
  assert.equal(res.reasonCode, 'provisioned');
  assert.equal(res.lifecycleState, 'active');
  assert.equal(res.mutated, true);
  assert.ok(r.ops().includes('create_active_link'), 'expected insert');
  assert.equal(w.writes.length, 4); // requested, validated, approved, succeeded
  assert.deepEqual(w.writes.map((x) => x.actionId), [
    IDENTITY_LINK_AUDIT_EVENTS.CREATE_REQUESTED,
    IDENTITY_LINK_AUDIT_EVENTS.CREATE_VALIDATED,
    IDENTITY_LINK_AUDIT_EVENTS.CREATE_APPROVED,
    IDENTITY_LINK_AUDIT_EVENTS.CREATE_SUCCEEDED,
  ]);
  for (const x of w.writes) assert.equal(x.actorInternalUserId, null);
  assertNoSensitive(JSON.stringify({ res, writes: w.writes }), 'E2');
});

C('E3 firebase-side conflict end-to-end (no insert)', async () => {
  const r = repoWith({
    ...SUCCESS_HANDLERS,
    find_active_firebase: () => [{ link_id: LINK_REF }],
  });
  const w = makeFakeWriter();
  const svc = createIdentityLinkAdminProvisioningService({
    repository: r.repo,
    audit: createIdentityLinkAuditAdapter({ writeAuditEvent: w.fn }),
  });
  const res = await svc.provisionLink(goodRequest());
  assert.equal(res.outcome, 'conflict');
  assert.equal(res.reasonCode, 'firebase_already_linked');
  assert.equal(res.mutated, false);
  assert.ok(!r.ops().includes('create_active_link'), 'must not insert on conflict');
  assert.ok(w.writes.some((x) => x.actionId === IDENTITY_LINK_AUDIT_EVENTS.CREATE_CONFLICT), 'expected conflict audit');
  assertNoSensitive(JSON.stringify({ res, writes: w.writes }), 'E3');
});

C('E4 disable lifecycle end-to-end', async () => {
  const r = repoWith({
    find_active_for_lifecycle_by_ref: () => [{ link_id: LINK_REF }],
    set_lifecycle_state: () => [{ status: 'disabled' }],
  });
  const w = makeFakeWriter();
  const svc = createIdentityLinkAdminProvisioningService({
    repository: r.repo,
    audit: createIdentityLinkAuditAdapter({ writeAuditEvent: w.fn }),
  });
  const req: IdentityLinkLifecycleRequest = {
    operation: 'disable',
    environment: 'dev',
    selector: { linkRef: LINK_REF },
    approval: { requestedByRef: REQ, approvedByRef: APV },
    correlationLabel: 'corr-disable',
  };
  const res = await svc.disableLink(req);
  assert.equal(res.ok, true);
  assert.equal(res.outcome, 'succeeded');
  assert.equal(res.lifecycleState, 'disabled');
  assert.ok(w.writes.some((x) => x.actionId === IDENTITY_LINK_AUDIT_EVENTS.DISABLE_SUCCEEDED), 'expected disable.succeeded audit');
  assertNoSensitive(JSON.stringify({ res, writes: w.writes }), 'E4');
});

// ========================= M20.14 hardening =========================

C('H1 factory does not connect/query at construction (no auto-connect)', async () => {
  let called = false;
  const sql = ((..._a: any[]) => { called = true; return Promise.resolve([]); }) as any;
  const repo = createIdentityLinkDevRepository({ sql });
  assert.equal(called, false, 'factory must not query at construction');
  assert.equal(typeof repo.createActiveLink, 'function');
});

C('H2 find maps non-array (undefined) result to unexpected_error', async () => {
  const r = repoWith({ find_active_pair: () => undefined });
  await assert.rejects(
    r.repo.findActiveLinkByPair(FB, SB),
    (e: unknown) => e instanceof SafeRepositoryError && (e as SafeRepositoryError).code === 'unexpected_error',
  );
});

C('H3 find maps malformed row (missing link_id) to unexpected_error', async () => {
  const r = repoWith({ find_active_firebase: () => [{}] });
  await assert.rejects(
    r.repo.findActiveLinkByFirebaseRef(FB),
    (e: unknown) => (e as SafeRepositoryError).code === 'unexpected_error',
  );
});

C('H4 createActiveLink maps malformed/undefined result to write_failed', async () => {
  const r = repoWith({ create_active_link: () => undefined });
  await assert.rejects(
    r.repo.createActiveLink({ anchorRef: ANCHOR, firebaseReference: FB, supabaseReference: SB, verificationMethod: 'admin_provisioned', createdByRef: REQ, approvedByRef: APV }),
    (e: unknown) => (e as SafeRepositoryError).code === 'write_failed',
  );
});

C('H5 createActiveLink check-constraint (23514) → constraint_conflict (no leak)', async () => {
  const r = repoWith({ create_active_link: () => { throw { code: '23514', message: `chk ${SECRET}` }; } });
  await assert.rejects(
    r.repo.createActiveLink({ anchorRef: ANCHOR, firebaseReference: FB, supabaseReference: SB, verificationMethod: 'admin_provisioned', createdByRef: REQ, approvedByRef: APV }),
    (e: unknown) => {
      assert.equal((e as SafeRepositoryError).code, 'constraint_conflict');
      assertNoSensitive((e as Error).message, 'H5');
      return true;
    },
  );
});

C('H6 setLifecycleState maps non-array result to unexpected_error', async () => {
  const r = repoWith({ set_lifecycle_state: () => undefined });
  await assert.rejects(
    r.repo.setLifecycleState(LINK_REF, 'disabled'),
    (e: unknown) => (e as SafeRepositoryError).code === 'unexpected_error',
  );
});

C('H7 disable is an UPDATE, never a DELETE', async () => {
  const r = repoWith({ set_lifecycle_state: () => [{ status: 'disabled' }] });
  await r.repo.setLifecycleState(LINK_REF, 'disabled');
  const t = r.textFor('set_lifecycle_state').toLowerCase();
  assert.ok(t.includes('update identity_link'), 'expected an UPDATE');
  assert.ok(!t.includes('delete'), 'must never DELETE');
});

C('H8 revoke is an UPDATE, never a DELETE', async () => {
  const r = repoWith({ set_lifecycle_state: () => [{ status: 'revoked' }] });
  await r.repo.setLifecycleState(LINK_REF, 'revoked');
  const t = r.textFor('set_lifecycle_state').toLowerCase();
  assert.ok(t.includes('update identity_link'), 'expected an UPDATE');
  assert.ok(!t.includes('delete'), 'must never DELETE');
});

C('H9 exact-pair existing → idempotent_existing (distinct from conflict; no insert)', async () => {
  const r = repoWith({ ...SUCCESS_HANDLERS, find_active_pair: () => [{ link_id: LINK_REF }] });
  const w = makeFakeWriter();
  const svc = createIdentityLinkAdminProvisioningService({ repository: r.repo, audit: createIdentityLinkAuditAdapter({ writeAuditEvent: w.fn }) });
  const res = await svc.provisionLink(goodRequest());
  assert.equal(res.outcome, 'idempotent_existing');
  assert.equal(res.mutated, false);
  assert.ok(!r.ops().includes('create_active_link'), 'must not insert on idempotent');
  assert.ok(w.writes.some((x) => x.actionId === IDENTITY_LINK_AUDIT_EVENTS.CREATE_IDEMPOTENT_EXISTING), 'expected idempotent audit');
});

C('H10 supabase-side conflict → supabase_already_linked (distinct from exact pair; no insert)', async () => {
  const r = repoWith({ ...SUCCESS_HANDLERS, find_active_supabase: () => [{ link_id: LINK_REF }] });
  const w = makeFakeWriter();
  const svc = createIdentityLinkAdminProvisioningService({ repository: r.repo, audit: createIdentityLinkAuditAdapter({ writeAuditEvent: w.fn }) });
  const res = await svc.provisionLink(goodRequest());
  assert.equal(res.outcome, 'conflict');
  assert.equal(res.reasonCode, 'supabase_already_linked');
  assert.equal(res.mutated, false);
  assert.ok(!r.ops().includes('create_active_link'), 'must not insert on conflict');
});

C('H11 audit sanitize strips array values (non-scalar)', async () => {
  const out = sanitizeIdentityLinkAuditPayload({ outcome: 'succeeded', arr: [1, 2, 3] as any });
  assert.deepEqual(Object.keys(out), ['outcome']);
});

C('H12 audit sanitize drops non-allow-listed keys (any case)', async () => {
  const out = sanitizeIdentityLinkAuditPayload({ outcome: 'succeeded', Email: SECRET, FIREBASEUID: FB, Token: SECRET, OUTCOME: 'x' });
  assert.deepEqual(Object.keys(out), ['outcome']);
  assertNoSensitive(JSON.stringify(out), 'H12');
});

C('H13 audit builder never emits injected identifiers/secrets; actor stays null', async () => {
  const evt = sampleEvent({ correlationLabel: 'corr-h13' }) as any;
  evt.firebaseUid = FB; evt.supabaseUid = SB; evt.internalUserId = ANCHOR;
  evt.email = SECRET; evt.token = SECRET; evt.actorInternalUserId = ANCHOR;
  const input = buildIdentityLinkAuditWriteInput(evt);
  const payload = buildSafeIdentityLinkAuditPayload(evt);
  assert.equal(input.actorInternalUserId, null);
  assertNoSensitive(JSON.stringify({ input, payload }), 'H13');
});

C('H14 hardened adapters remain M20.11-compatible (full success)', async () => {
  const r = repoWith(SUCCESS_HANDLERS);
  const w = makeFakeWriter();
  const svc = createIdentityLinkAdminProvisioningService({ repository: r.repo, audit: createIdentityLinkAuditAdapter({ writeAuditEvent: w.fn }) });
  const res = await svc.provisionLink(goodRequest());
  assert.equal(res.ok, true);
  assert.equal(res.reasonCode, 'provisioned');
  assert.equal(res.mutated, true);
  assert.ok(r.ops().includes('create_active_link'));
});

// ---- Runner ----
(async () => {
  let pass = 0;
  const failures: string[] = [];
  for (const c of cases) {
    try {
      await c.fn();
      pass++;
      console.log('PASS ' + c.name);
    } catch (e) {
      failures.push(c.name + ' :: ' + (e instanceof Error ? e.message : String(e)));
      console.log('FAIL ' + c.name);
    }
  }
  console.log(`\n[M20.13 identity-link DEV repository + audit adapters] ${pass}/${cases.length} passed`);
  if (failures.length) {
    console.log('FAILURES:');
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
  console.log('ALL_TESTS_PASSED');
  process.exit(0);
})();

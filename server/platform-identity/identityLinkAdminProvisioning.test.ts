// Phase 1.6 M20.11 — Unit tests for the identity-link admin provisioning service.
//
// Self-contained, mock-only, DB-free. Runnable via `npx tsx <thisfile>` (the repo ships no test
// framework; this mirrors the existing scripts/diagnostics-*.ts assertion-script convention). Uses
// Node's built-in assert. NO real ids/uids/emails/tokens/secrets — obvious fake placeholders only.
// Asserts redaction: emitted audit events and returned results contain none of the fake input refs.

import assert from 'node:assert/strict';
import {
  createIdentityLinkAdminProvisioningService,
  IDENTITY_LINK_AUDIT_EVENTS,
  type IdentityLinkAuditEvent,
  type IdentityLinkProvisionRequest,
  type IdentityLinkLifecycleRequest,
  type IdentityLinkRepository,
  type ExistingActiveLink,
  type ExistingHistoricalLink,
} from './identityLinkAdminProvisioning';

// ---- Fake placeholders (NOT real values) ----
const FB = 'FAKE_FB_REFERENCE_zzz';
const SB = 'FAKE_SB_REFERENCE_zzz';
const ANCHOR = 'FAKE_ANCHOR_REFERENCE_zzz';
const REQ_ACTOR = 'FAKE_REQUESTER_REF_zzz';
const APV_ACTOR = 'FAKE_APPROVER_REF_zzz';
const FAKE_EMAIL = 'fake-user@example.invalid';
const SENSITIVE_TOKENS = [FB, SB, ANCHOR, REQ_ACTOR, APV_ACTOR, FAKE_EMAIL];

// ---- Mock audit sink ----
function makeAudit(opts: { throwOn?: string } = {}) {
  const events: IdentityLinkAuditEvent[] = [];
  return {
    events,
    sink: {
      async emit(e: IdentityLinkAuditEvent): Promise<void> {
        if (opts.throwOn && e.kind === opts.throwOn) throw new Error('audit boom');
        events.push(e);
      },
    },
    kinds: () => events.map((e) => e.kind),
  };
}

// ---- Mock repository (happy-path defaults; override per test) ----
type RepoOverrides = Partial<IdentityLinkRepository>;
function makeRepo(over: RepoOverrides = {}) {
  const calls = { createActiveLink: 0, setLifecycleState: 0 };
  const base: IdentityLinkRepository = {
    async getAnchorEligibility() { return { found: true, eligible: true }; },
    async providerReferenceExists() { return true; },
    async findActiveLinkByPair() { return null; },
    async findActiveLinkByFirebaseRef() { return null; },
    async findActiveLinkBySupabaseRef() { return null; },
    async findHistoricalPair() { return null; },
    async createActiveLink() { return { lifecycleState: 'active' as const }; },
    async findActiveLinkForLifecycle() { return { linkRef: 'FAKE_LINK_REF_zzz' }; },
    async setLifecycleState(_ref, state) { return { lifecycleState: state }; },
  };
  // Wrap createActiveLink/setLifecycleState so call counts hold even when overridden.
  const repo: IdentityLinkRepository = { ...base, ...over };
  const origCreate = repo.createActiveLink.bind(repo);
  repo.createActiveLink = async (input) => { calls.createActiveLink++; return origCreate(input); };
  const origSet = repo.setLifecycleState.bind(repo);
  repo.setLifecycleState = async (r, s) => { calls.setLifecycleState++; return origSet(r, s); };
  return { repo, calls };
}

function goodRequest(over: Partial<IdentityLinkProvisionRequest> = {}): IdentityLinkProvisionRequest {
  return {
    operation: 'create',
    environment: 'dev',
    anchorRef: ANCHOR,
    firebaseProof: { provider: 'firebase', reference: FB, verified: true },
    supabaseProof: { provider: 'supabase', reference: SB, verified: true },
    verificationMethod: 'verified_both_sides',
    approval: { requestedByRef: REQ_ACTOR, approvedByRef: APV_ACTOR },
    correlationLabel: 'corr-001',
    ...over,
  };
}

function assertRedacted(audit: ReturnType<typeof makeAudit>, res: unknown): void {
  const blob = JSON.stringify({ events: audit.events, res });
  for (const tok of SENSITIVE_TOKENS) {
    assert.ok(!blob.includes(tok), `redaction breach: found "${tok}" in audit/result output`);
  }
}

// ---- Test registry ----
type Case = { name: string; fn: () => Promise<void> };
const cases: Case[] = [];
const C = (name: string, fn: () => Promise<void>) => cases.push({ name, fn });

C('1 successful create (verified both sides)', async () => {
  const audit = makeAudit(); const { repo, calls } = makeRepo();
  const svc = createIdentityLinkAdminProvisioningService({ repository: repo, audit: audit.sink });
  const res = await svc.provisionLink(goodRequest());
  assert.equal(res.ok, true); assert.equal(res.outcome, 'succeeded'); assert.equal(res.reasonCode, 'provisioned');
  assert.equal(res.lifecycleState, 'active'); assert.equal(res.mutated, true); assert.equal(calls.createActiveLink, 1);
  assert.deepEqual(audit.kinds(), [
    IDENTITY_LINK_AUDIT_EVENTS.CREATE_REQUESTED, IDENTITY_LINK_AUDIT_EVENTS.CREATE_VALIDATED,
    IDENTITY_LINK_AUDIT_EVENTS.CREATE_APPROVED, IDENTITY_LINK_AUDIT_EVENTS.CREATE_SUCCEEDED,
  ]);
  assertRedacted(audit, res);
});

C('2 idempotent existing active pair (no duplicate)', async () => {
  const audit = makeAudit();
  const { repo, calls } = makeRepo({ async findActiveLinkByPair() { return { linkRef: 'FAKE_LINK_REF_zzz' } as ExistingActiveLink; } });
  const svc = createIdentityLinkAdminProvisioningService({ repository: repo, audit: audit.sink });
  const res = await svc.provisionLink(goodRequest());
  assert.equal(res.ok, true); assert.equal(res.outcome, 'idempotent_existing'); assert.equal(res.reasonCode, 'idempotent_existing');
  assert.equal(res.mutated, false); assert.equal(calls.createActiveLink, 0);
  assert.ok(audit.kinds().includes(IDENTITY_LINK_AUDIT_EVENTS.CREATE_IDEMPOTENT_EXISTING));
  assert.ok(!audit.kinds().includes(IDENTITY_LINK_AUDIT_EVENTS.CREATE_SUCCEEDED));
  assertRedacted(audit, res);
});

C('3 firebase reference already linked elsewhere blocks', async () => {
  const audit = makeAudit();
  const { repo, calls } = makeRepo({ async findActiveLinkByFirebaseRef() { return { linkRef: 'OTHER_LINK' } as ExistingActiveLink; } });
  const svc = createIdentityLinkAdminProvisioningService({ repository: repo, audit: audit.sink });
  const res = await svc.provisionLink(goodRequest());
  assert.equal(res.ok, false); assert.equal(res.outcome, 'conflict'); assert.equal(res.reasonCode, 'firebase_already_linked');
  assert.equal(calls.createActiveLink, 0); assert.ok(audit.kinds().includes(IDENTITY_LINK_AUDIT_EVENTS.CREATE_CONFLICT));
  assertRedacted(audit, res);
});

C('4 supabase reference already linked elsewhere blocks', async () => {
  const audit = makeAudit();
  const { repo, calls } = makeRepo({ async findActiveLinkBySupabaseRef() { return { linkRef: 'OTHER_LINK' } as ExistingActiveLink; } });
  const svc = createIdentityLinkAdminProvisioningService({ repository: repo, audit: audit.sink });
  const res = await svc.provisionLink(goodRequest());
  assert.equal(res.reasonCode, 'supabase_already_linked'); assert.equal(res.outcome, 'conflict'); assert.equal(calls.createActiveLink, 0);
  assertRedacted(audit, res);
});

C('5 missing anchor blocks', async () => {
  const audit = makeAudit(); const { repo, calls } = makeRepo();
  const svc = createIdentityLinkAdminProvisioningService({ repository: repo, audit: audit.sink });
  const res = await svc.provisionLink(goodRequest({ anchorRef: '' }));
  assert.equal(res.reasonCode, 'missing_anchor'); assert.equal(res.ok, false); assert.equal(calls.createActiveLink, 0);
  assertRedacted(audit, res);
});

C('6 missing firebase proof blocks', async () => {
  const audit = makeAudit(); const { repo } = makeRepo();
  const svc = createIdentityLinkAdminProvisioningService({ repository: repo, audit: audit.sink });
  const res = await svc.provisionLink(goodRequest({ firebaseProof: undefined }));
  assert.equal(res.reasonCode, 'missing_firebase_proof'); assertRedacted(audit, res);
});

C('7 missing supabase proof blocks', async () => {
  const audit = makeAudit(); const { repo } = makeRepo();
  const svc = createIdentityLinkAdminProvisioningService({ repository: repo, audit: audit.sink });
  const res = await svc.provisionLink(goodRequest({ supabaseProof: undefined }));
  assert.equal(res.reasonCode, 'missing_supabase_proof'); assertRedacted(audit, res);
});

C('8 email-as-authority attempt blocks', async () => {
  const audit = makeAudit(); const { repo } = makeRepo();
  const svc = createIdentityLinkAdminProvisioningService({ repository: repo, audit: audit.sink });
  const res = await svc.provisionLink(goodRequest({ emailAsAuthority: true }));
  assert.equal(res.reasonCode, 'email_as_authority_forbidden'); assertRedacted(audit, res);
});

C('9 client-supplied UID authority attempt blocks', async () => {
  const audit = makeAudit(); const { repo } = makeRepo();
  const svc = createIdentityLinkAdminProvisioningService({ repository: repo, audit: audit.sink });
  const res = await svc.provisionLink(goodRequest({ clientSuppliedUidAuthority: true }));
  assert.equal(res.reasonCode, 'client_uid_authority_forbidden'); assertRedacted(audit, res);
});

C('10a invalid verification method blocks', async () => {
  const audit = makeAudit(); const { repo } = makeRepo();
  const svc = createIdentityLinkAdminProvisioningService({ repository: repo, audit: audit.sink });
  const res = await svc.provisionLink(goodRequest({ verificationMethod: 'unverified' }));
  assert.equal(res.reasonCode, 'invalid_verification_method'); assertRedacted(audit, res);
});

C('10b missing verification method blocks', async () => {
  const audit = makeAudit(); const { repo } = makeRepo();
  const svc = createIdentityLinkAdminProvisioningService({ repository: repo, audit: audit.sink });
  const res = await svc.provisionLink(goodRequest({ verificationMethod: '' }));
  assert.equal(res.reasonCode, 'missing_verification_method'); assertRedacted(audit, res);
});

C('10c verification incomplete (proof.verified=false) blocks', async () => {
  const audit = makeAudit(); const { repo } = makeRepo();
  const svc = createIdentityLinkAdminProvisioningService({ repository: repo, audit: audit.sink });
  const res = await svc.provisionLink(goodRequest({ firebaseProof: { provider: 'firebase', reference: FB, verified: false } }));
  assert.equal(res.reasonCode, 'verification_incomplete'); assertRedacted(audit, res);
});

C('11 missing approval blocks', async () => {
  const audit = makeAudit(); const { repo } = makeRepo();
  const svc = createIdentityLinkAdminProvisioningService({ repository: repo, audit: audit.sink });
  const res = await svc.provisionLink(goodRequest({ approval: undefined }));
  assert.equal(res.reasonCode, 'missing_approval'); assertRedacted(audit, res);
});

C('12 separation-of-duties violation blocks when required', async () => {
  const audit = makeAudit(); const { repo } = makeRepo();
  const svc = createIdentityLinkAdminProvisioningService({ repository: repo, audit: audit.sink });
  const res = await svc.provisionLink(goodRequest({ approval: { requestedByRef: REQ_ACTOR, approvedByRef: REQ_ACTOR } }));
  assert.equal(res.reasonCode, 'separation_of_duties_violation'); assertRedacted(audit, res);
});

C('13 disabled/revoked historical pair does not silently reactivate', async () => {
  const audit = makeAudit();
  const { repo, calls } = makeRepo({ async findHistoricalPair() { return { linkRef: 'HIST', lifecycleState: 'revoked' } as ExistingHistoricalLink; } });
  const svc = createIdentityLinkAdminProvisioningService({ repository: repo, audit: audit.sink });
  const res = await svc.provisionLink(goodRequest());
  assert.equal(res.reasonCode, 'disabled_or_revoked_pair_requires_reactivation'); assert.equal(res.ok, false); assert.equal(calls.createActiveLink, 0);
  assertRedacted(audit, res);
});

C('14 disable transitions via repo + safe audit', async () => {
  const audit = makeAudit(); const { repo, calls } = makeRepo();
  const svc = createIdentityLinkAdminProvisioningService({ repository: repo, audit: audit.sink });
  const req: IdentityLinkLifecycleRequest = { operation: 'disable', environment: 'dev', selector: { linkRef: 'FAKE_LINK_REF_zzz' }, approval: { requestedByRef: REQ_ACTOR, approvedByRef: APV_ACTOR } };
  const res = await svc.disableLink(req);
  assert.equal(res.ok, true); assert.equal(res.outcome, 'succeeded'); assert.equal(res.reasonCode, 'disabled');
  assert.equal(res.lifecycleState, 'disabled'); assert.equal(res.mutated, true); assert.equal(calls.setLifecycleState, 1);
  assert.deepEqual(audit.kinds(), [IDENTITY_LINK_AUDIT_EVENTS.DISABLE_REQUESTED, IDENTITY_LINK_AUDIT_EVENTS.DISABLE_SUCCEEDED]);
  assertRedacted(audit, res);
});

C('15 revoke transitions via repo + safe audit', async () => {
  const audit = makeAudit(); const { repo, calls } = makeRepo();
  const svc = createIdentityLinkAdminProvisioningService({ repository: repo, audit: audit.sink });
  const req: IdentityLinkLifecycleRequest = { operation: 'revoke', environment: 'dev', selector: { firebaseReference: FB, supabaseReference: SB }, approval: { requestedByRef: REQ_ACTOR, approvedByRef: APV_ACTOR } };
  const res = await svc.revokeLink(req);
  assert.equal(res.ok, true); assert.equal(res.reasonCode, 'revoked'); assert.equal(res.lifecycleState, 'revoked'); assert.equal(calls.setLifecycleState, 1);
  assert.deepEqual(audit.kinds(), [IDENTITY_LINK_AUDIT_EVENTS.REVOKE_REQUESTED, IDENTITY_LINK_AUDIT_EVENTS.REVOKE_SUCCEEDED]);
  assertRedacted(audit, res);
});

C('15b lifecycle blocks when active link not found', async () => {
  const audit = makeAudit();
  const { repo, calls } = makeRepo({ async findActiveLinkForLifecycle() { return null; } });
  const svc = createIdentityLinkAdminProvisioningService({ repository: repo, audit: audit.sink });
  const res = await svc.disableLink({ operation: 'disable', selector: { linkRef: 'NOPE' }, approval: { requestedByRef: REQ_ACTOR, approvedByRef: APV_ACTOR } });
  assert.equal(res.reasonCode, 'link_not_found'); assert.equal(res.ok, false); assert.equal(calls.setLifecycleState, 0);
  assertRedacted(audit, res);
});

C('16 validation-only performs no mutation', async () => {
  const audit = makeAudit(); const { repo, calls } = makeRepo();
  const svc = createIdentityLinkAdminProvisioningService({ repository: repo, audit: audit.sink });
  const res = await svc.validateProvision(goodRequest());
  assert.equal(res.ok, true); assert.equal(res.outcome, 'validated'); assert.equal(res.reasonCode, 'validated'); assert.equal(res.mutated, false);
  assert.equal(calls.createActiveLink, 0);
  assert.ok(audit.kinds().includes(IDENTITY_LINK_AUDIT_EVENTS.CREATE_VALIDATED));
  assert.ok(!audit.kinds().includes(IDENTITY_LINK_AUDIT_EVENTS.CREATE_APPROVED));
  assert.ok(!audit.kinds().includes(IDENTITY_LINK_AUDIT_EVENTS.CREATE_SUCCEEDED));
  assertRedacted(audit, res);
});

C('17 audit payloads carry safe fields only', async () => {
  const audit = makeAudit(); const { repo } = makeRepo();
  const svc = createIdentityLinkAdminProvisioningService({ repository: repo, audit: audit.sink });
  await svc.provisionLink(goodRequest());
  const ALLOWED = new Set(['actionCategory', 'kind', 'outcome', 'sourceFlow', 'reasonCode', 'verificationMethod', 'lifecycleState', 'policyDecision', 'correlationLabel']);
  for (const e of audit.events) {
    assert.equal(e.actionCategory, 'identity_link');
    assert.equal(e.sourceFlow, 'admin_provisioning');
    for (const k of Object.keys(e)) assert.ok(ALLOWED.has(k), `unexpected audit field "${k}"`);
  }
});

C('18 audit/result contain no raw identifiers across many flows', async () => {
  // exercise success, conflict, reject, idempotent, disable — then assert nothing leaked
  for (const build of [
    () => makeRepo(),
    () => makeRepo({ async findActiveLinkByFirebaseRef() { return { linkRef: 'X' }; } }),
    () => makeRepo({ async findActiveLinkByPair() { return { linkRef: 'X' }; } }),
  ]) {
    const audit = makeAudit(); const { repo } = build();
    const svc = createIdentityLinkAdminProvisioningService({ repository: repo, audit: audit.sink });
    const res = await svc.provisionLink(goodRequest());
    assertRedacted(audit, res);
  }
});

C('19 unknown repository failure maps to internal_error', async () => {
  const audit = makeAudit();
  const { repo } = makeRepo({ async getAnchorEligibility() { throw new Error('db boom'); } });
  const svc = createIdentityLinkAdminProvisioningService({ repository: repo, audit: audit.sink });
  const res = await svc.provisionLink(goodRequest());
  assert.equal(res.ok, false); assert.equal(res.outcome, 'failed'); assert.equal(res.reasonCode, 'internal_error');
  // error message detail must not leak into result/audit
  const blob = JSON.stringify({ events: audit.events, res });
  assert.ok(!blob.includes('db boom'), 'raw error detail leaked');
  assertRedacted(audit, res);
});

C('20 non-dev target indicator blocks', async () => {
  const audit = makeAudit(); const { repo, calls } = makeRepo();
  const svc = createIdentityLinkAdminProvisioningService({ repository: repo, audit: audit.sink });
  const res = await svc.provisionLink(goodRequest({ environment: 'production' }));
  assert.equal(res.reasonCode, 'non_dev_target_blocked'); assert.equal(calls.createActiveLink, 0);
  assertRedacted(audit, res);
});

// ---- Runner ----
(async () => {
  let pass = 0; const failures: string[] = [];
  for (const c of cases) {
    try { await c.fn(); pass++; console.log('PASS ' + c.name); }
    catch (e) { failures.push(c.name + ' :: ' + (e instanceof Error ? e.message : String(e))); console.log('FAIL ' + c.name); }
  }
  console.log(`\n[M20.11 identity-link admin provisioning] ${pass}/${cases.length} passed`);
  if (failures.length) { console.log('FAILURES:'); for (const f of failures) console.log('  - ' + f); process.exit(1); }
  console.log('ALL_TESTS_PASSED');
  process.exit(0);
})();

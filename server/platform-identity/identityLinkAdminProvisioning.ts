// Phase 1.6 M20.11 — Identity Link ADMIN PROVISIONING service (server-only, DEV-only, default-OFF).
//
// WHAT THIS IS: a pure, dependency-injected service that realizes the M20.8 verified-both-sides
// creation flow and the M20.9 redacted audit taxonomy for the additive `identity_link` table
// (created in DEV by the M20.4 / M20.6 migration). It validates an admin-provisioning request,
// blocks unsafe authorities, handles conflict / duplicate / idempotent cases, emits redaction-safe
// audit events through an INJECTED audit sink, and supports disable / revoke lifecycle transitions
// through an INJECTED repository. It returns SAFE reason codes + lifecycle states only.
//
// WHAT THIS IS NOT (binding for M20.11):
//   - It is server-only and is imported by NOTHING active: no route, no `sessionResolve`, no
//     AccessContext / Login / AccessGuard / App / main / pilot, no startup, no seed, no migration
//     runner. It has no public endpoint and no UI. It changes no existing authorization behavior.
//   - It instantiates NO database connection and imports NO repository / audit-writer / Supabase /
//     Firebase module. Every external effect is an INJECTED interface (so unit tests use mocks
//     only). A FUTURE, separately-approved milestone would supply a real DEV repository + the
//     existing append-only audit writer adapter.
//   - It inserts NO `identity_link` row and writes NO `audit_event` row by itself in M20.11; the
//     mock dependencies in the test do.
//
// SECURITY (binding): it NEVER returns, logs, or places into an audit event any raw provider
// reference, raw internal anchor reference, email, token, secret, or authorization object. Result
// and audit shapes carry ONLY safe codes, lifecycle states, safe flags, and non-sensitive labels.
// email is NEVER an authority; a client-supplied UID is NEVER an authority.

// =============================================================================
// Default-OFF flag (for a FUTURE call site only; the pure service does not consult it)
// =============================================================================

/** Server-side opt-in flag name for a FUTURE admin-provisioning call site. Default OFF. */
export const IDENTITY_LINK_ADMIN_PROVISIONING_FLAG = 'ENABLE_IDENTITY_LINK_ADMIN_PROVISIONING' as const;

/**
 * True ONLY when explicitly enabled AND the process is non-production. Conservative on purpose:
 * NEVER relies on NODE_ENV alone and NEVER enables in production. Reads only presence/equality —
 * it never returns or logs the value. The pure service does NOT call this; it gates a future caller.
 */
export function isIdentityLinkAdminProvisioningEnabled(): boolean {
  if (process.env.NODE_ENV === 'production') return false;
  return process.env[IDENTITY_LINK_ADMIN_PROVISIONING_FLAG] === 'true';
}

// =============================================================================
// Public vocabulary
// =============================================================================

export type IdentityLinkOperationType = 'create' | 'disable' | 'revoke';
export type IdentityLinkLifecycleState = 'active' | 'disabled' | 'revoked';

/** Only VERIFIED methods may reach an active link. 'unverified' is never sufficient. */
export type IdentityLinkVerificationMethod = 'verified_both_sides' | 'admin_provisioned';
const VERIFIED_METHODS: ReadonlySet<string> = new Set<string>(['verified_both_sides', 'admin_provisioned']);

/** Safe, non-sensitive reason codes. NEVER contains an identifier/email/secret. */
export type IdentityLinkReasonCode =
  // success outcomes
  | 'provisioned'
  | 'idempotent_existing'
  | 'validated'
  | 'disabled'
  | 'revoked'
  // rejections / validation failures
  | 'invalid_operation'
  | 'non_dev_target_blocked'
  | 'email_as_authority_forbidden'
  | 'client_uid_authority_forbidden'
  | 'missing_anchor'
  | 'missing_firebase_proof'
  | 'missing_supabase_proof'
  | 'missing_verification_method'
  | 'invalid_verification_method'
  | 'verification_incomplete'
  | 'missing_approval'
  | 'separation_of_duties_violation'
  | 'audit_unavailable'
  | 'anchor_not_found'
  | 'anchor_not_eligible'
  | 'firebase_reference_not_found'
  | 'supabase_reference_not_found'
  | 'firebase_already_linked'
  | 'supabase_already_linked'
  | 'disabled_or_revoked_pair_requires_reactivation'
  | 'link_not_found'
  | 'internal_error';

/** M20.9 audit taxonomy — planning labels realized as typed constants. */
export const IDENTITY_LINK_AUDIT_EVENTS = {
  CREATE_REQUESTED: 'identity_link.create.requested',
  CREATE_VALIDATED: 'identity_link.create.validated',
  CREATE_APPROVED: 'identity_link.create.approved',
  CREATE_SUCCEEDED: 'identity_link.create.succeeded',
  CREATE_REJECTED: 'identity_link.create.rejected',
  CREATE_CONFLICT: 'identity_link.create.conflict',
  CREATE_IDEMPOTENT_EXISTING: 'identity_link.create.idempotent_existing',
  DISABLE_REQUESTED: 'identity_link.disable.requested',
  DISABLE_SUCCEEDED: 'identity_link.disable.succeeded',
  REVOKE_REQUESTED: 'identity_link.revoke.requested',
  REVOKE_SUCCEEDED: 'identity_link.revoke.succeeded',
  VALIDATION_FAILED: 'identity_link.validation.failed',
} as const;
export type IdentityLinkAuditKind =
  (typeof IDENTITY_LINK_AUDIT_EVENTS)[keyof typeof IDENTITY_LINK_AUDIT_EVENTS];

export type IdentityLinkAuditOutcome =
  | 'requested'
  | 'validated'
  | 'approved'
  | 'succeeded'
  | 'rejected'
  | 'conflict'
  | 'idempotent_existing'
  | 'failed';

/**
 * Redaction-safe audit event. By CONSTRUCTION it has NO field for a provider reference, anchor
 * reference, email, token, or secret — so the service cannot emit one. Carries only safe labels.
 */
export interface IdentityLinkAuditEvent {
  actionCategory: 'identity_link';
  kind: IdentityLinkAuditKind;
  outcome: IdentityLinkAuditOutcome;
  sourceFlow: 'admin_provisioning';
  reasonCode?: IdentityLinkReasonCode;
  verificationMethod?: IdentityLinkVerificationMethod;
  lifecycleState?: IdentityLinkLifecycleState;
  /** True only when the approval/separation-of-duties boundary was satisfied. */
  policyDecision?: boolean;
  /** Non-sensitive correlation label (caller-provided; never an identifier/UUID). */
  correlationLabel?: string;
}

// =============================================================================
// Request shapes (opaque references only — the service never inspects their content)
// =============================================================================

/** A provider-reference proof. `reference` is opaque; the service never logs/returns it. */
export interface ProviderReferenceProof {
  provider: 'firebase' | 'supabase';
  /** Opaque external reference (e.g., the provider uid reference). NEVER logged/returned. */
  reference: string;
  /** Server-verified flag. A link reaches `active` only when BOTH sides are verified. */
  verified: boolean;
}

/** Approval provenance. App-owned actor references only; never exposed in result/audit. */
export interface ApprovalContext {
  requestedByRef: string;
  approvedByRef: string;
}

export interface IdentityLinkProvisionRequest {
  operation: 'create';
  /** If provided, must be 'dev'. A non-dev indicator blocks the operation. */
  environment?: string;
  /** App-owned stable anchor reference (opaque). */
  anchorRef?: string;
  firebaseProof?: ProviderReferenceProof;
  supabaseProof?: ProviderReferenceProof;
  verificationMethod?: string;
  approval?: ApprovalContext;
  /** If true, an email-as-authority attempt is implied → blocked. */
  emailAsAuthority?: boolean;
  /** If true, a client-supplied-UID authority attempt is implied → blocked. */
  clientSuppliedUidAuthority?: boolean;
  /** Separation-of-duties required (default true). */
  requireSeparationOfDuties?: boolean;
  /** Non-sensitive correlation label. */
  correlationLabel?: string;
}

export interface IdentityLinkLifecycleRequest {
  operation: 'disable' | 'revoke';
  environment?: string;
  /** Opaque selector for the active link (e.g., the verified pair or a link selector). */
  selector?: { firebaseReference?: string; supabaseReference?: string; linkRef?: string };
  approval?: ApprovalContext;
  requireSeparationOfDuties?: boolean;
  correlationLabel?: string;
}

export interface IdentityLinkResult {
  ok: boolean;
  operation: IdentityLinkOperationType;
  outcome: IdentityLinkAuditOutcome;
  reasonCode: IdentityLinkReasonCode;
  lifecycleState: IdentityLinkLifecycleState | null;
  /** True only when a repository mutation was performed. */
  mutated: boolean;
  /** The audit kinds emitted during this operation (labels only). */
  auditKinds: IdentityLinkAuditKind[];
  correlationLabel?: string;
}

// =============================================================================
// Injected dependencies (no DB, no SDK; tests supply mocks)
// =============================================================================

export interface ExistingActiveLink {
  /** Opaque link reference; never returned to callers by this service. */
  linkRef: string;
}
export interface ExistingHistoricalLink {
  linkRef: string;
  lifecycleState: 'disabled' | 'revoked';
}

export interface IdentityLinkRepository {
  getAnchorEligibility(anchorRef: string): Promise<{ found: boolean; eligible: boolean }>;
  providerReferenceExists(provider: 'firebase' | 'supabase', reference: string): Promise<boolean>;
  findActiveLinkByPair(firebaseReference: string, supabaseReference: string): Promise<ExistingActiveLink | null>;
  findActiveLinkByFirebaseRef(firebaseReference: string): Promise<ExistingActiveLink | null>;
  findActiveLinkBySupabaseRef(supabaseReference: string): Promise<ExistingActiveLink | null>;
  findHistoricalPair(firebaseReference: string, supabaseReference: string): Promise<ExistingHistoricalLink | null>;
  createActiveLink(input: {
    anchorRef: string;
    firebaseReference: string;
    supabaseReference: string;
    verificationMethod: IdentityLinkVerificationMethod;
    createdByRef: string;
    approvedByRef: string;
  }): Promise<{ lifecycleState: 'active' }>;
  findActiveLinkForLifecycle(selector: NonNullable<IdentityLinkLifecycleRequest['selector']>): Promise<ExistingActiveLink | null>;
  setLifecycleState(linkRef: string, state: 'disabled' | 'revoked'): Promise<{ lifecycleState: 'disabled' | 'revoked' }>;
}

export interface IdentityLinkAuditSink {
  emit(event: IdentityLinkAuditEvent): Promise<void>;
}

export interface Clock {
  now(): Date;
}

export interface IdentityLinkAdminProvisioningDeps {
  repository: IdentityLinkRepository;
  audit: IdentityLinkAuditSink;
  clock?: Clock;
}

// =============================================================================
// Service
// =============================================================================

export interface IdentityLinkAdminProvisioningService {
  provisionLink(
    request: IdentityLinkProvisionRequest,
    options?: { validateOnly?: boolean },
  ): Promise<IdentityLinkResult>;
  validateProvision(request: IdentityLinkProvisionRequest): Promise<IdentityLinkResult>;
  disableLink(request: IdentityLinkLifecycleRequest): Promise<IdentityLinkResult>;
  revokeLink(request: IdentityLinkLifecycleRequest): Promise<IdentityLinkResult>;
}

function nonEmpty(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

export function createIdentityLinkAdminProvisioningService(
  deps: IdentityLinkAdminProvisioningDeps,
): IdentityLinkAdminProvisioningService {
  const { repository } = deps;
  const audit = deps.audit;

  async function emit(
    kinds: IdentityLinkAuditKind[],
    event: IdentityLinkAuditEvent,
  ): Promise<void> {
    kinds.push(event.kind);
    await audit.emit(event);
  }

  function result(
    operation: IdentityLinkOperationType,
    outcome: IdentityLinkAuditOutcome,
    reasonCode: IdentityLinkReasonCode,
    auditKinds: IdentityLinkAuditKind[],
    extra: { ok?: boolean; lifecycleState?: IdentityLinkLifecycleState | null; mutated?: boolean; correlationLabel?: string } = {},
  ): IdentityLinkResult {
    return {
      ok: extra.ok ?? false,
      operation,
      outcome,
      reasonCode,
      lifecycleState: extra.lifecycleState ?? null,
      mutated: extra.mutated ?? false,
      auditKinds,
      correlationLabel: extra.correlationLabel,
    };
  }

  async function provisionLink(
    request: IdentityLinkProvisionRequest,
    options: { validateOnly?: boolean } = {},
  ): Promise<IdentityLinkResult> {
    const validateOnly = options.validateOnly === true;
    const kinds: IdentityLinkAuditKind[] = [];
    const corr = request.correlationLabel;
    const vm = request.verificationMethod as IdentityLinkVerificationMethod | undefined;

    // Audit-capability guard FIRST: a mutation requires an audit sink. Reported, not thrown.
    if (!audit || typeof audit.emit !== 'function') {
      return result('create', 'rejected', 'audit_unavailable', kinds);
    }

    try {
      await emit(kinds, { actionCategory: 'identity_link', kind: IDENTITY_LINK_AUDIT_EVENTS.CREATE_REQUESTED, outcome: 'requested', sourceFlow: 'admin_provisioning', correlationLabel: corr });

      // Helper to emit a validation-failed audit + return a rejection result.
      const reject = async (reasonCode: IdentityLinkReasonCode): Promise<IdentityLinkResult> => {
        await emit(kinds, { actionCategory: 'identity_link', kind: IDENTITY_LINK_AUDIT_EVENTS.VALIDATION_FAILED, outcome: 'failed', sourceFlow: 'admin_provisioning', reasonCode, verificationMethod: VERIFIED_METHODS.has(String(vm)) ? vm : undefined, policyDecision: false, correlationLabel: corr });
        return result('create', 'rejected', reasonCode, kinds, { correlationLabel: corr });
      };

      // ---- Pure / shape guards (no repository I/O) ----
      if (request.operation !== 'create') return await reject('invalid_operation');
      if (request.environment !== undefined && request.environment !== 'dev') return await reject('non_dev_target_blocked');
      if (request.emailAsAuthority === true) return await reject('email_as_authority_forbidden');
      if (request.clientSuppliedUidAuthority === true) return await reject('client_uid_authority_forbidden');
      if (!nonEmpty(request.anchorRef)) return await reject('missing_anchor');
      if (!request.firebaseProof || !nonEmpty(request.firebaseProof.reference) || request.firebaseProof.provider !== 'firebase') return await reject('missing_firebase_proof');
      if (!request.supabaseProof || !nonEmpty(request.supabaseProof.reference) || request.supabaseProof.provider !== 'supabase') return await reject('missing_supabase_proof');
      if (!nonEmpty(request.verificationMethod)) return await reject('missing_verification_method');
      if (!VERIFIED_METHODS.has(request.verificationMethod)) return await reject('invalid_verification_method');
      if (request.firebaseProof.verified !== true || request.supabaseProof.verified !== true) return await reject('verification_incomplete');
      if (!request.approval || !nonEmpty(request.approval.requestedByRef) || !nonEmpty(request.approval.approvedByRef)) return await reject('missing_approval');
      const sodRequired = request.requireSeparationOfDuties !== false; // default true
      if (sodRequired && request.approval.requestedByRef === request.approval.approvedByRef) return await reject('separation_of_duties_violation');

      const anchorRef = request.anchorRef;
      const fbRef = request.firebaseProof.reference;
      const sbRef = request.supabaseProof.reference;

      // ---- Repository guards ----
      const anchor = await repository.getAnchorEligibility(anchorRef);
      if (!anchor.found) return await reject('anchor_not_found');
      if (!anchor.eligible) return await reject('anchor_not_eligible');
      if (!(await repository.providerReferenceExists('firebase', fbRef))) return await reject('firebase_reference_not_found');
      if (!(await repository.providerReferenceExists('supabase', sbRef))) return await reject('supabase_reference_not_found');

      // Idempotency: exact active pair already exists ⇒ idempotent success (NO mutation).
      const existingPair = await repository.findActiveLinkByPair(fbRef, sbRef);
      if (existingPair) {
        await emit(kinds, { actionCategory: 'identity_link', kind: IDENTITY_LINK_AUDIT_EVENTS.CREATE_IDEMPOTENT_EXISTING, outcome: 'idempotent_existing', sourceFlow: 'admin_provisioning', reasonCode: 'idempotent_existing', verificationMethod: vm, lifecycleState: 'active', policyDecision: true, correlationLabel: corr });
        return result('create', 'idempotent_existing', 'idempotent_existing', kinds, { ok: true, lifecycleState: 'active', mutated: false, correlationLabel: corr });
      }

      // Conflict: either side already actively linked elsewhere ⇒ block.
      const conflict = async (reasonCode: IdentityLinkReasonCode): Promise<IdentityLinkResult> => {
        await emit(kinds, { actionCategory: 'identity_link', kind: IDENTITY_LINK_AUDIT_EVENTS.CREATE_CONFLICT, outcome: 'conflict', sourceFlow: 'admin_provisioning', reasonCode, policyDecision: false, correlationLabel: corr });
        return result('create', 'conflict', reasonCode, kinds, { correlationLabel: corr });
      };
      if (await repository.findActiveLinkByFirebaseRef(fbRef)) return await conflict('firebase_already_linked');
      if (await repository.findActiveLinkBySupabaseRef(sbRef)) return await conflict('supabase_already_linked');

      // Disabled/revoked historical exact pair ⇒ do NOT silently reactivate.
      if (await repository.findHistoricalPair(fbRef, sbRef)) return await reject('disabled_or_revoked_pair_requires_reactivation');

      // ---- All guards passed: validated ----
      await emit(kinds, { actionCategory: 'identity_link', kind: IDENTITY_LINK_AUDIT_EVENTS.CREATE_VALIDATED, outcome: 'validated', sourceFlow: 'admin_provisioning', verificationMethod: vm, policyDecision: true, correlationLabel: corr });

      if (validateOnly) {
        return result('create', 'validated', 'validated', kinds, { ok: true, mutated: false, correlationLabel: corr });
      }

      // ---- Approve + mutate exactly once + succeeded ----
      await emit(kinds, { actionCategory: 'identity_link', kind: IDENTITY_LINK_AUDIT_EVENTS.CREATE_APPROVED, outcome: 'approved', sourceFlow: 'admin_provisioning', verificationMethod: vm, policyDecision: true, correlationLabel: corr });
      const created = await repository.createActiveLink({
        anchorRef, firebaseReference: fbRef, supabaseReference: sbRef,
        verificationMethod: request.verificationMethod as IdentityLinkVerificationMethod,
        createdByRef: request.approval.requestedByRef, approvedByRef: request.approval.approvedByRef,
      });
      await emit(kinds, { actionCategory: 'identity_link', kind: IDENTITY_LINK_AUDIT_EVENTS.CREATE_SUCCEEDED, outcome: 'succeeded', sourceFlow: 'admin_provisioning', reasonCode: 'provisioned', verificationMethod: vm, lifecycleState: created.lifecycleState, policyDecision: true, correlationLabel: corr });
      return result('create', 'succeeded', 'provisioned', kinds, { ok: true, lifecycleState: created.lifecycleState, mutated: true, correlationLabel: corr });
    } catch {
      // Unknown failure ⇒ safe internal reason code (no detail surfaced). Best-effort audit.
      try {
        await emit(kinds, { actionCategory: 'identity_link', kind: IDENTITY_LINK_AUDIT_EVENTS.VALIDATION_FAILED, outcome: 'failed', sourceFlow: 'admin_provisioning', reasonCode: 'internal_error', correlationLabel: corr });
      } catch { /* swallow: never surface detail */ }
      return result('create', 'failed', 'internal_error', kinds, { correlationLabel: corr });
    }
  }

  async function validateProvision(request: IdentityLinkProvisionRequest): Promise<IdentityLinkResult> {
    return provisionLink(request, { validateOnly: true });
  }

  async function lifecycle(
    request: IdentityLinkLifecycleRequest,
    state: 'disabled' | 'revoked',
    requestedKind: IdentityLinkAuditKind,
    succeededKind: IdentityLinkAuditKind,
    successReason: IdentityLinkReasonCode,
  ): Promise<IdentityLinkResult> {
    const op: IdentityLinkOperationType = state === 'disabled' ? 'disable' : 'revoke';
    const kinds: IdentityLinkAuditKind[] = [];
    const corr = request.correlationLabel;

    if (!audit || typeof audit.emit !== 'function') {
      return result(op, 'rejected', 'audit_unavailable', kinds);
    }
    try {
      await emit(kinds, { actionCategory: 'identity_link', kind: requestedKind, outcome: 'requested', sourceFlow: 'admin_provisioning', correlationLabel: corr });
      const reject = async (reasonCode: IdentityLinkReasonCode): Promise<IdentityLinkResult> => {
        await emit(kinds, { actionCategory: 'identity_link', kind: IDENTITY_LINK_AUDIT_EVENTS.VALIDATION_FAILED, outcome: 'failed', sourceFlow: 'admin_provisioning', reasonCode, policyDecision: false, correlationLabel: corr });
        return result(op, 'rejected', reasonCode, kinds, { correlationLabel: corr });
      };

      if (request.operation !== op) return await reject('invalid_operation');
      if (request.environment !== undefined && request.environment !== 'dev') return await reject('non_dev_target_blocked');
      if (!request.approval || !nonEmpty(request.approval.requestedByRef) || !nonEmpty(request.approval.approvedByRef)) return await reject('missing_approval');
      const sodRequired = request.requireSeparationOfDuties !== false;
      if (sodRequired && request.approval.requestedByRef === request.approval.approvedByRef) return await reject('separation_of_duties_violation');
      if (!request.selector || (!nonEmpty(request.selector.linkRef) && !(nonEmpty(request.selector.firebaseReference) && nonEmpty(request.selector.supabaseReference)))) {
        return await reject('link_not_found');
      }

      const existing = await repository.findActiveLinkForLifecycle(request.selector);
      if (!existing) return await reject('link_not_found');

      const updated = await repository.setLifecycleState(existing.linkRef, state);
      await emit(kinds, { actionCategory: 'identity_link', kind: succeededKind, outcome: 'succeeded', sourceFlow: 'admin_provisioning', reasonCode: successReason, lifecycleState: updated.lifecycleState, policyDecision: true, correlationLabel: corr });
      return result(op, 'succeeded', successReason, kinds, { ok: true, lifecycleState: updated.lifecycleState, mutated: true, correlationLabel: corr });
    } catch {
      try {
        await emit(kinds, { actionCategory: 'identity_link', kind: IDENTITY_LINK_AUDIT_EVENTS.VALIDATION_FAILED, outcome: 'failed', sourceFlow: 'admin_provisioning', reasonCode: 'internal_error', correlationLabel: corr });
      } catch { /* swallow */ }
      return result(op, 'failed', 'internal_error', kinds, { correlationLabel: corr });
    }
  }

  return {
    provisionLink,
    validateProvision,
    disableLink: (request) =>
      lifecycle(request, 'disabled', IDENTITY_LINK_AUDIT_EVENTS.DISABLE_REQUESTED, IDENTITY_LINK_AUDIT_EVENTS.DISABLE_SUCCEEDED, 'disabled'),
    revokeLink: (request) =>
      lifecycle(request, 'revoked', IDENTITY_LINK_AUDIT_EVENTS.REVOKE_REQUESTED, IDENTITY_LINK_AUDIT_EVENTS.REVOKE_SUCCEEDED, 'revoked'),
  };
}

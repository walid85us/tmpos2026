// Phase 4.0 M7b — the PostgreSQL side of recording payments against an issued invoice (M7B-PAYMENTS-P1; docs/phase-4/15 §12,
// ADR-52; G-IAM, G-ISOLATION, G-PERSIST, G-AUDIT; migration 036, schema tmpos_invoice_payment): the record's and the
// reversal's mutators (server/runtime/invoicePayments.ts), each ONE fixed call into 036's session-bound SECURITY DEFINER
// routine, and the payments read over 036's m7b_invoice_payments_get. Every value is a bound parameter, every bigint as exact
// decimal text; no table is named here.
//
// THE TWO MUTATORS are ROUTINE-AUDITED (postgresTransactionalStore.ts ROUTINE_AUDITED_KINDS; doc 15 §12.5 I2, D-PAY-8): each
// routine writes the command's one audit record itself, in the command's transaction, under the command's correlation id
// (MutationAuthority.correlationId), and the store writes none. So 'applied' is accepted ONLY with a canonical audit event id
// from the routine, beside exactly this transaction's tenant, store, actor and grant, the command's payment id and (record)
// the path invoice or (reversal) version 2. Inside the command's transaction after the fence and the store-scope revalidation,
// bound from the presenting session's key and the REVALIDATED trusted store (never the change set or the request target).
//   record  — store.invoice_payment.record, a CREATE (paymentRefusals 'record'; since M7B-PAYMENTS-P2 into 037's
//             m7b_invoice_payment_record_v2 with the registration and its proof): 'tenant_mismatch' → 'precondition_failed'
//             (rolled back, the unsealed 409); 'not_found' (rolled back, the 404); 'already_recorded', 'invalid_state'
//             (voided) and 'amount_exceeds_remaining', each the sealed 409 its completion alone commits; 'refused' (the 503).
//   reverse — store.invoice_payment.reverse, an UPDATE at version 1 exactly (any other expected version: 'unavailable',
//             nothing called): the same tenant and not-found words; 'invalid_state'
//             (already reversed) and 'conflict' (another version, unreachable through HTTP), each sealed; 'refused'. After
//             'applied' the recent sign-in's deadline the store handed over is judged once more on the DATABASE clock
//             (postgresSessionStore.ts authenticationFresh, the void's rule): stale after the routine's lock waits is 'refused',
//             and the reversal and its audit record roll back with everything else.
// Anything else — another identity, version, payment or invoice, no audit id, an unknown word, another row count, a column
// more or less, an identity on a refusal — is 'mismatch' (rolled back, the 503). A raise is not caught: the kernel rolls back.
//
// THE READ (createPostgresInvoicePayments) and READINESS (probeInvoicePayments, asking 036's read last with a random key no
// session holds): postgresInvoiceIssuing.ts's pattern — INVOICE_DRAFT_READ_BOUNDS, the trusted STORE scope checked before any
// statement, the rows checked column for column and handed to the runtime's own decoder (invoicePaymentsOf), which must accept
// them; any fault is one bounded message.
//
// No driver error message, row value, key or body is ever logged. IT CONSTRUCTS NOTHING AND READS NOTHING at import.
import { randomBytes, randomUUID } from 'node:crypto';
import type { TransactionMutation } from '../runtime/commandTransaction.js';
import {
  INVOICE_PAYMENTS_ASK, INVOICE_PAYMENT_ATTEMPTS_ASK, INVOICE_PAYMENT_RECORD_CONTRACT, INVOICE_PAYMENT_REGISTER_CONTRACT,
  INVOICE_PAYMENT_REVERSE_CONTRACT, INVOICE_PAYMENT_SETTLE_CONTRACT, invoicePaymentAttemptsOf, invoicePaymentsOf, isInvoicePaymentMethod,
  isInvoicePaymentReversalReasonCode, registrationProofOf,
} from '../runtime/invoicePayments.js';
import type { InvoicePaymentAttemptsCursor, InvoicePaymentRegistrationsPort, InvoicePaymentsPort } from '../runtime/invoicePayments.js';
import { isTrustedScope } from '../runtime/principals.js';
import type { TrustedScope } from '../runtime/principals.js';
import { INVOICE_DRAFT_READ_BOUNDS } from './postgresInvoiceDrafts.js';
import { authenticationFresh } from './postgresSessionStore.js';
import type { AggregateMutator, MutationAuthority, PgStatement } from './postgresTransactionalStore.js';
import type { SupervisedPgClient } from './supervisedPgClient.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);
const isRecord = (v: unknown): v is Readonly<Record<string, unknown>> => typeof v === 'object' && v !== null && !Array.isArray(v);
const hasColumns = (row: unknown, columns: readonly string[]): row is Readonly<Record<string, unknown>> => {
  if (!isRecord(row)) return false;
  const keys = Object.keys(row);
  return keys.length === columns.length && columns.every((c) => keys.includes(c));
};
const isInt = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
const MAX = Number.MAX_SAFE_INTEGER;
/** A registration proof: 64 lowercase hex digits (037). */
const PROOF_RE = /^[0-9a-f]{64}$/;

/** The store context, key and correlation id a payment routine is called with, or null: never a call without all three. */
function authorityOf(authority: MutationAuthority | undefined): { context: TrustedScope; sessionKey: string; correlationId: string } | null {
  const context = authority?.context ?? null;
  const sessionKey = authority?.sessionKey ?? null;
  const correlationId = authority?.correlationId ?? null;
  if (context === null || context.scope !== 'store' || !isUuid(context.tenant) || !isUuid(context.store) || typeof sessionKey !== 'string'
    || typeof correlationId !== 'string' || !UUID_V4_RE.test(correlationId)) return null;
  return { context, sessionKey, correlationId };
}

const RECORD_COLUMNS: readonly string[] = ['o_outcome', 'o_tenant_id', 'o_store_id', 'o_actor_id', 'o_membership_id', 'o_payment_id', 'o_invoice_id', 'o_audit_event_id'];
const RECORD_REFUSALS: ReadonlySet<string> = new Set(['not_found', 'already_recorded', 'invalid_state', 'amount_exceeds_remaining', 'refused']);

async function applyInvoicePaymentRecord(sql: PgStatement, mutation: TransactionMutation, authority?: MutationAuthority): Promise<unknown> {
  const held = authorityOf(authority);
  if (held === null) return 'unavailable';
  const { context, sessionKey, correlationId } = held;
  const { aggregateId, expectedVersion, changes } = mutation;
  const { invoiceId, expectedTenant, attemptId, amountCents, method, registrationId, registrationProof } = changes;
  if (expectedVersion !== null || !isUuid(aggregateId) || !isUuid(invoiceId) || !isUuid(expectedTenant) || !isUuid(attemptId)
    || !isInt(amountCents, 1, MAX) || !isInvoicePaymentMethod(method) || !isUuid(registrationId)
    || typeof registrationProof !== 'string' || !PROOF_RE.test(registrationProof)) return 'unavailable';
  // M7B-PAYMENTS-P2: 037's record v2 (036's nine-argument record is no longer the runtime's): the registration and its proof
  // are SQL parameters only; a mismatch of either is the routine's uniform 'not_found'.
  const rows = await sql`select o_outcome, o_tenant_id, o_store_id, o_actor_id, o_membership_id, o_payment_id, o_invoice_id, o_audit_event_id
    from tmpos_invoice_payment.m7b_invoice_payment_record_v2(${sessionKey}::text, ${context.store}::uuid, ${invoiceId}::uuid, ${expectedTenant}::uuid,
      ${aggregateId}::uuid, ${registrationId}::uuid, ${attemptId}::uuid, ${String(amountCents)}::bigint, ${method}::text, ${registrationProof}::text,
      ${correlationId}::uuid)`;
  if (rows.length !== 1 || !hasColumns(rows[0], RECORD_COLUMNS)) return 'mismatch';
  const {
    o_outcome: outcome, o_tenant_id: tenant, o_store_id: store, o_actor_id: actor, o_membership_id: membership, o_payment_id: payment,
    o_invoice_id: invoice, o_audit_event_id: auditEvent,
  } = rows[0];
  if (outcome === 'applied') {
    if (tenant !== context.tenant || store !== context.store || actor !== context.actor || membership !== context.membershipId
      || payment !== aggregateId || invoice !== invoiceId || !isUuid(auditEvent)) return 'mismatch';
    return 'applied';
  }
  // A refusal names nothing: every other column null.
  if ([tenant, store, actor, membership, payment, invoice, auditEvent].some((v) => v !== null)) return 'mismatch';
  if (outcome === 'tenant_mismatch') return 'precondition_failed';
  return typeof outcome === 'string' && RECORD_REFUSALS.has(outcome) ? outcome : 'mismatch';
}

const REVERSE_COLUMNS: readonly string[] = ['o_outcome', 'o_tenant_id', 'o_store_id', 'o_actor_id', 'o_membership_id', 'o_version', 'o_payment_id', 'o_audit_event_id'];
const REVERSE_REFUSALS: ReadonlySet<string> = new Set(['not_found', 'invalid_state', 'conflict', 'refused']);
/** doc 15 §12.3: a reversal moves an ACTIVE payment (version 1) to reversed (version 2), never any other step. */
const ACTIVE_PAYMENT_VERSION = 1;
const REVERSED_PAYMENT_VERSION = '2';

async function applyInvoicePaymentReverse(sql: PgStatement, mutation: TransactionMutation, authority?: MutationAuthority): Promise<unknown> {
  const held = authorityOf(authority);
  const authNotAfter = authority?.authNotAfter ?? null;
  // The reversal is sensitive: never a call without the deadline the revalidator judged.
  if (held === null || !isInt(authNotAfter, 1, MAX)) return 'unavailable';
  const { context, sessionKey, correlationId } = held;
  const { aggregateId, expectedVersion, changes } = mutation;
  const { invoiceId, expectedTenant, reasonCode } = changes;
  if (!isUuid(aggregateId) || expectedVersion !== ACTIVE_PAYMENT_VERSION || !isUuid(invoiceId) || !isUuid(expectedTenant)
    || !isInvoicePaymentReversalReasonCode(reasonCode)) return 'unavailable';
  const rows = await sql`select o_outcome, o_tenant_id, o_store_id, o_actor_id, o_membership_id, o_version, o_payment_id, o_audit_event_id
    from tmpos_invoice_payment.m7b_invoice_payment_reverse(${sessionKey}::text, ${context.store}::uuid, ${invoiceId}::uuid, ${aggregateId}::uuid,
      ${expectedTenant}::uuid, ${String(expectedVersion)}::bigint, ${reasonCode}::text, ${correlationId}::uuid)`;
  if (rows.length !== 1 || !hasColumns(rows[0], REVERSE_COLUMNS)) return 'mismatch';
  const {
    o_outcome: outcome, o_tenant_id: tenant, o_store_id: store, o_actor_id: actor, o_membership_id: membership, o_version: version,
    o_payment_id: payment, o_audit_event_id: auditEvent,
  } = rows[0];
  if (outcome === 'applied') {
    // bigint arrives as its decimal text: compared exactly, never through a float.
    if (tenant !== context.tenant || store !== context.store || actor !== context.actor || membership !== context.membershipId
      || version !== REVERSED_PAYMENT_VERSION || payment !== aggregateId || !isUuid(auditEvent)) return 'mismatch';
    // The recent sign-in, judged again now that the routine's lock waits are over (header).
    return (await authenticationFresh(sql, authNotAfter)) ? 'applied' : 'refused';
  }
  if ([tenant, store, actor, membership, version, payment, auditEvent].some((v) => v !== null)) return 'mismatch';
  if (outcome === 'tenant_mismatch') return 'precondition_failed';
  return typeof outcome === 'string' && REVERSE_REFUSALS.has(outcome) ? outcome : 'mismatch';
}

/** The record's mutator, as the tenant inventory registers it (server/composition/tenantTransactions.ts). */
export const INVOICE_PAYMENT_RECORD_MUTATOR: AggregateMutator = Object.freeze({
  kind: INVOICE_PAYMENT_RECORD_CONTRACT.kind,
  mode: 'create',
  aggregateType: INVOICE_PAYMENT_RECORD_CONTRACT.aggregateType,
  contextScope: 'store',
  paymentRefusals: 'record',
  routineAudited: true,
  apply: applyInvoicePaymentRecord,
});

/** The reversal's mutator, as the tenant inventory registers it. */
export const INVOICE_PAYMENT_REVERSE_MUTATOR: AggregateMutator = Object.freeze({
  kind: INVOICE_PAYMENT_REVERSE_CONTRACT.kind,
  mode: 'update',
  aggregateType: INVOICE_PAYMENT_REVERSE_CONTRACT.aggregateType,
  contextScope: 'store',
  routineAudited: true,
  apply: applyInvoicePaymentReverse,
});

// ---------------------------------------------------------------------------
// The read
// ---------------------------------------------------------------------------

/** A session key: the SHA-256 of a session identifier, unpadded base64url (sessions.ts digestOf). */
const SESSION_KEY_RE = /^[A-Za-z0-9_-]{43}$/;
const BIGINT_TEXT_RE = /^(0|[1-9][0-9]{0,15})$/;
/** Every fault is the same bounded message: nothing about the row, the value or the driver. */
const fault = (): Error => new Error('invoice payments answer invalid');

type Row = Readonly<Record<string, unknown>>;
const HEADER_COLUMNS: readonly string[] = ['o_outcome', 'o_tenant_id', 'o_store_id', 'o_invoice_id', 'o_status', 'o_currency', 'o_total_cents',
  'o_due_cents', 'o_applied_cents', 'o_remaining_cents', 'o_payment_status'];
const PAYMENT_COLUMNS: readonly string[] = ['o_payment_id', 'o_attempt_id', 'o_amount_cents', 'o_method', 'o_recorded_at', 'o_reversed_at', 'o_reason_code'];
const PAYMENTS_COLUMNS: readonly string[] = [...HEADER_COLUMNS, ...PAYMENT_COLUMNS];

/** A bigint column's exact value within 2^53 - 1, at or above `min`; a fault otherwise. */
function amountOf(v: unknown, min: number): number {
  if (typeof v !== 'string' || !BIGINT_TEXT_RE.test(v)) throw fault();
  const n = Number(v);
  if (!Number.isSafeInteger(n) || String(n) !== v || n < min) throw fault();
  return n;
}
const isRefusal = (row: Row): boolean => PAYMENTS_COLUMNS.every((c) => c === 'o_outcome' || row[c] === null);
function scopeAt(scope: unknown): TrustedScope {
  if (!isTrustedScope(scope) || scope.scope !== 'store' || !isUuid(scope.tenant) || !isUuid(scope.store)) throw fault();
  return scope;
}

/** 036's rows as the port's answer (the adapter asked INVOICE_PAYMENTS_ASK); a throw for anything out of shape. */
export function invoicePaymentsAnswerOf(rows: unknown, scope: TrustedScope, invoiceId: string, after: string | null): unknown {
  // The bound is checked before any row is read, so an oversized answer costs nothing to refuse.
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > INVOICE_PAYMENTS_ASK) throw fault();
  const all: Row[] = rows.map((row) => { if (!hasColumns(row, PAYMENTS_COLUMNS)) throw fault(); return row; });
  const first = all[0];
  if (first.o_outcome !== 'payments') {
    // A refusal is the routine's only row; 'cursor_unknown' only for a continuation.
    const words = after !== null ? ['denied', 'not_found', 'cursor_unknown'] : ['denied', 'not_found'];
    if (all.length !== 1 || !isRefusal(first) || typeof first.o_outcome !== 'string' || !words.includes(first.o_outcome)) throw fault();
    return Object.freeze({ outcome: first.o_outcome });
  }
  // Every row carries the same header, naming this scope's tenant and store and the invoice asked for.
  if (first.o_tenant_id !== scope.tenant || first.o_store_id !== scope.store || first.o_invoice_id !== invoiceId) throw fault();
  if (!all.every((row) => HEADER_COLUMNS.every((c) => row[c] === first[c]))) throw fault();
  // One row with every payment column null is the empty page; otherwise every row is a payment.
  const empty = all.length === 1 && PAYMENT_COLUMNS.every((c) => first[c] === null);
  const payments = empty ? [] : all.map((row) => {
    if (row.o_payment_id === null || (row.o_reversed_at === null) !== (row.o_reason_code === null)) throw fault();
    return {
      id: row.o_payment_id, attemptId: row.o_attempt_id, amountCents: amountOf(row.o_amount_cents, 1), method: row.o_method,
      recordedAt: row.o_recorded_at,
      reversal: row.o_reversed_at === null ? null : { reversedAt: row.o_reversed_at, reasonCode: row.o_reason_code },
    };
  });
  const answer = {
    outcome: 'payments', invoice: { id: first.o_invoice_id, status: first.o_status }, currency: first.o_currency,
    totalCents: amountOf(first.o_total_cents, 0), dueCents: amountOf(first.o_due_cents, 0), appliedCents: amountOf(first.o_applied_cents, 0),
    remainingCents: amountOf(first.o_remaining_cents, 0), paymentStatus: first.o_payment_status, payments,
  };
  // The runtime's own decoder must accept it as a page (never as a refusal word).
  const judged = invoicePaymentsOf(answer, invoiceId, after);
  if (typeof judged !== 'object' || judged === null) throw fault();
  return Object.freeze(answer);
}

/** The payments read over `client` (header: THE READ). */
export function createPostgresInvoicePayments(deps: { readonly client: SupervisedPgClient }): InvoicePaymentsPort {
  const client = deps?.client;
  if (typeof client?.transaction !== 'function') throw new TypeError('invoice payments read options invalid');
  return Object.freeze({
    async payments(rawScope: TrustedScope, sessionKey: string, invoiceId: string, after: string | null, signal: AbortSignal): Promise<unknown> {
      const scope = scopeAt(rawScope);
      if (typeof sessionKey !== 'string' || !SESSION_KEY_RE.test(sessionKey)) throw fault();
      if (!isUuid(invoiceId) || (after !== null && !isUuid(after))) throw fault();
      return client.transaction(signal, INVOICE_DRAFT_READ_BOUNDS, async (sql) => invoicePaymentsAnswerOf(
        await sql`select o_outcome, o_tenant_id, o_store_id, o_invoice_id, o_status, o_currency, o_total_cents, o_due_cents, o_applied_cents,
            o_remaining_cents, o_payment_status, o_payment_id, o_attempt_id, o_amount_cents, o_method, o_recorded_at, o_reversed_at, o_reason_code
          from tmpos_invoice_payment.m7b_invoice_payments_get(${sessionKey}::text, ${scope.tenant}::uuid, ${scope.store}::uuid, ${invoiceId}::uuid,
            ${after}::uuid, ${INVOICE_PAYMENTS_ASK}::integer)`,
        scope, invoiceId, after,
      ));
    },
  });
}

/** Readiness: true only for 036's read's one 'denied' row for a random key no session holds; anything else is false. */
export async function probeInvoicePayments(client: SupervisedPgClient, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false;
  const absentKey = randomBytes(32).toString('base64url');
  const [tenant, store, id] = [randomUUID(), randomUUID(), randomUUID()];
  try {
    return await client.transaction(signal, INVOICE_DRAFT_READ_BOUNDS, async (sql) => {
      const rows = await sql`select o_outcome, o_tenant_id, o_store_id, o_invoice_id, o_status, o_currency, o_total_cents, o_due_cents, o_applied_cents,
          o_remaining_cents, o_payment_status, o_payment_id, o_attempt_id, o_amount_cents, o_method, o_recorded_at, o_reversed_at, o_reason_code
        from tmpos_invoice_payment.m7b_invoice_payments_get(${absentKey}::text, ${tenant}::uuid, ${store}::uuid, ${id}::uuid, ${null}::uuid, ${1}::integer)`;
      return Array.isArray(rows) && rows.length === 1 && hasColumns(rows[0], PAYMENTS_COLUMNS) && rows[0].o_outcome === 'denied' && isRefusal(rows[0]);
    });
  } catch {
    return false; // an outage, an abort, an overrun, a driver fault or a row out of shape: nothing is disclosed
  }
}

// ---------------------------------------------------------------------------
// M7B-PAYMENTS-P2 (PRQ-1, migration 037): the registration and the settlement mutators, the proof and attempts reads, and
// the startup key probe
// ---------------------------------------------------------------------------
// Both mutators are ROUTINE-AUDITED, exactly as the record's: 037's routine writes the one audit record itself in the command's
// transaction under its correlation id, so 'applied' is accepted ONLY with a canonical audit event id beside exactly this
// transaction's tenant, store, actor and grant.
//   register — store.invoice_payment.register, a CREATE (paymentRefusals 'record'): 'tenant_mismatch' → 'precondition_failed';
//              'not_found' (the 404); 'already_recorded' and 'invalid_state' (sealed 409s); 'conflict' (an own unsettled
//              registration on the invoice: the sealed 409 write_conflict); 'refused' (the 503). The registration id is the
//              runtime's new id.
//   settle   — store.invoice_payment.settle, an UPDATE of the caller's registration of the body's attempt at version 1 or 2:
//              'applied' and 'unchanged' (the same settlement already in place: no audit id, the plan's same 200) each with
//              version 3; 'tenant_mismatch', 'not_found', 'conflict' (sealed write_conflict), 'refused'. It never reads the key.
// 037's 55000 raises (no proof key, fsync off, an unverified WAL layout, the isolation) are not caught: the kernel rolls back
// and answers its bounded 503; a read's is the port's outage. The proof routine's durability wait ends in an ANSWER,
// ('not_durable', NULLs), never a raise: the decoder returns it, so the read's transaction COMMITS — the xid-less WAL the
// transaction's own reads may have written (a HOT prune of a page short of free space) is flushed only once it commits, and a
// rollback never asks for it. COMMIT is a transaction boundary, not a flush: the port then asks ONCE more, in a fresh
// transaction, under the same strict rule, within the route's deadline; a second 'not_durable' (or no time left for one) is the
// port's bounded outage, the existing retryable 503. The proof travels as a SQL parameter or a row value only: never logged,
// never in an error.

const REGISTER_COLUMNS: readonly string[] = ['o_outcome', 'o_tenant_id', 'o_store_id', 'o_actor_id', 'o_membership_id', 'o_registration_id', 'o_invoice_id', 'o_audit_event_id'];
const REGISTER_REFUSALS: ReadonlySet<string> = new Set(['not_found', 'already_recorded', 'invalid_state', 'conflict', 'refused']);

async function applyInvoicePaymentRegister(sql: PgStatement, mutation: TransactionMutation, authority?: MutationAuthority): Promise<unknown> {
  const held = authorityOf(authority);
  if (held === null) return 'unavailable';
  const { context, sessionKey, correlationId } = held;
  const { aggregateId, expectedVersion, changes } = mutation;
  const { invoiceId, expectedTenant, attemptId } = changes;
  if (expectedVersion !== null || !isUuid(aggregateId) || !isUuid(invoiceId) || !isUuid(expectedTenant) || !isUuid(attemptId)) return 'unavailable';
  const rows = await sql`select o_outcome, o_tenant_id, o_store_id, o_actor_id, o_membership_id, o_registration_id, o_invoice_id, o_audit_event_id
    from tmpos_invoice_payment.m7b_invoice_payment_register(${sessionKey}::text, ${context.store}::uuid, ${invoiceId}::uuid, ${expectedTenant}::uuid,
      ${aggregateId}::uuid, ${attemptId}::uuid, ${correlationId}::uuid)`;
  if (rows.length !== 1 || !hasColumns(rows[0], REGISTER_COLUMNS)) return 'mismatch';
  const {
    o_outcome: outcome, o_tenant_id: tenant, o_store_id: store, o_actor_id: actor, o_membership_id: membership,
    o_registration_id: registration, o_invoice_id: invoice, o_audit_event_id: auditEvent,
  } = rows[0];
  if (outcome === 'applied') {
    if (tenant !== context.tenant || store !== context.store || actor !== context.actor || membership !== context.membershipId
      || registration !== aggregateId || invoice !== invoiceId || !isUuid(auditEvent)) return 'mismatch';
    return 'applied';
  }
  if ([tenant, store, actor, membership, registration, invoice, auditEvent].some((v) => v !== null)) return 'mismatch';
  if (outcome === 'tenant_mismatch') return 'precondition_failed';
  return typeof outcome === 'string' && REGISTER_REFUSALS.has(outcome) ? outcome : 'mismatch';
}

const SETTLE_COLUMNS: readonly string[] = ['o_outcome', 'o_tenant_id', 'o_store_id', 'o_actor_id', 'o_membership_id', 'o_version', 'o_invoice_id', 'o_audit_event_id'];
const SETTLE_REFUSALS: ReadonlySet<string> = new Set(['not_found', 'conflict', 'refused']);
/** A settled registration's lifecycle version (037), as its bigint decimal text. */
const SETTLED_REGISTRATION_VERSION = '3';

async function applyInvoicePaymentSettle(sql: PgStatement, mutation: TransactionMutation, authority?: MutationAuthority): Promise<unknown> {
  const held = authorityOf(authority);
  if (held === null) return 'unavailable';
  const { context, sessionKey, correlationId } = held;
  const { aggregateId, expectedVersion, changes } = mutation;
  const { invoiceId, expectedTenant, attemptId } = changes;
  if (!isUuid(aggregateId) || aggregateId !== attemptId || (expectedVersion !== 1 && expectedVersion !== 2) || !isUuid(invoiceId)
    || !isUuid(expectedTenant)) return 'unavailable';
  const rows = await sql`select o_outcome, o_tenant_id, o_store_id, o_actor_id, o_membership_id, o_version, o_invoice_id, o_audit_event_id
    from tmpos_invoice_payment.m7b_invoice_payment_settle(${sessionKey}::text, ${context.store}::uuid, ${invoiceId}::uuid, ${expectedTenant}::uuid,
      ${attemptId}::uuid, ${String(expectedVersion)}::bigint, ${correlationId}::uuid)`;
  if (rows.length !== 1 || !hasColumns(rows[0], SETTLE_COLUMNS)) return 'mismatch';
  const {
    o_outcome: outcome, o_tenant_id: tenant, o_store_id: store, o_actor_id: actor, o_membership_id: membership, o_version: version,
    o_invoice_id: invoice, o_audit_event_id: auditEvent,
  } = rows[0];
  if (outcome === 'applied' || outcome === 'unchanged') {
    if (tenant !== context.tenant || store !== context.store || actor !== context.actor || membership !== context.membershipId
      || version !== SETTLED_REGISTRATION_VERSION || invoice !== invoiceId) return 'mismatch';
    // 'applied' wrote its one audit record; 'unchanged' wrote nothing, so names none.
    if (outcome === 'applied' ? !isUuid(auditEvent) : auditEvent !== null) return 'mismatch';
    return outcome;
  }
  if ([tenant, store, actor, membership, version, invoice, auditEvent].some((v) => v !== null)) return 'mismatch';
  if (outcome === 'tenant_mismatch') return 'precondition_failed';
  return typeof outcome === 'string' && SETTLE_REFUSALS.has(outcome) ? outcome : 'mismatch';
}

/** The registration's mutator, as the tenant inventory registers it. */
export const INVOICE_PAYMENT_REGISTER_MUTATOR: AggregateMutator = Object.freeze({
  kind: INVOICE_PAYMENT_REGISTER_CONTRACT.kind,
  mode: 'create',
  aggregateType: INVOICE_PAYMENT_REGISTER_CONTRACT.aggregateType,
  contextScope: 'store',
  paymentRefusals: 'record',
  routineAudited: true,
  apply: applyInvoicePaymentRegister,
});

/** The settlement's mutator, as the tenant inventory registers it. */
export const INVOICE_PAYMENT_SETTLE_MUTATOR: AggregateMutator = Object.freeze({
  kind: INVOICE_PAYMENT_SETTLE_CONTRACT.kind,
  mode: 'update',
  aggregateType: INVOICE_PAYMENT_SETTLE_CONTRACT.aggregateType,
  contextScope: 'store',
  routineAudited: true,
  apply: applyInvoicePaymentSettle,
});

const registrationsFault = (): Error => new Error('invoice payment registrations answer invalid');
/** The proof routine's 'not_durable' answer: the port's alone (it commits, then asks once more); it never reaches the runtime. */
const PROOF_NOT_DURABLE = Object.freeze({ outcome: 'not_durable' });
/** 037's wait bound per attempt (it refuses more), the time an attempt keeps beside its wait (a pooled connection, BEGIN and the
 * bounds, the reads before the wait, the MAC, COMMIT), and the attempts one proof read may take. */
const PROOF_WAIT_MAX_MS = 1000;
const PROOF_ATTEMPT_RESERVE_MS = 250;
const PROOF_ATTEMPTS = 2;
const PROOF_COLUMNS: readonly string[] = ['o_outcome', 'o_tenant_id', 'o_store_id', 'o_invoice_id', 'o_registration_id', 'o_attempt_id', 'o_proof'];
const ATTEMPTS_COLUMNS: readonly string[] = ['o_outcome', 'o_tenant_id', 'o_store_id', 'o_invoice_id', 'o_invoice_number', 'o_attempt_id', 'o_state',
  'o_version', 'o_registered_at', 'o_settled_at', 'o_payment_id', 'o_amount_cents', 'o_method', 'o_recorded_at', 'o_reversed_at', 'o_reason_code'];
const PAYMENT_ATTEMPT_COLUMNS: readonly string[] = ['o_payment_id', 'o_amount_cents', 'o_method', 'o_recorded_at', 'o_reversed_at', 'o_reason_code'];
const allNullBut = (row: Row, columns: readonly string[]): boolean => columns.every((c) => c === 'o_outcome' || row[c] === null);
/** A bigint column's exact value within 2^53 - 1, at or above `min`; a registrations fault otherwise. */
function exactOf(v: unknown, min: number): number {
  if (typeof v !== 'string' || !BIGINT_TEXT_RE.test(v)) throw registrationsFault();
  const n = Number(v);
  if (!Number.isSafeInteger(n) || String(n) !== v || n < min) throw registrationsFault();
  return n;
}

/** 037's proof row as the port's answer; a throw for anything out of shape (the runtime's decoder must accept it). */
export function registrationProofAnswerOf(rows: unknown, scope: TrustedScope, invoiceId: string, registrationId: string): unknown {
  if (!Array.isArray(rows) || rows.length !== 1 || !hasColumns(rows[0], PROOF_COLUMNS)) throw registrationsFault();
  const row: Row = rows[0];
  if (row.o_outcome === 'denied' || row.o_outcome === 'not_found' || row.o_outcome === 'not_durable') {
    if (!allNullBut(row, PROOF_COLUMNS)) throw registrationsFault();
    return row.o_outcome === 'not_durable' ? PROOF_NOT_DURABLE : Object.freeze({ outcome: row.o_outcome });
  }
  if (row.o_outcome !== 'proof' || row.o_tenant_id !== scope.tenant || row.o_store_id !== scope.store || row.o_invoice_id !== invoiceId
    || row.o_registration_id !== registrationId) throw registrationsFault();
  const answer = Object.freeze({ outcome: 'proof', registrationId, invoiceId, attemptId: row.o_attempt_id, proof: row.o_proof });
  if (registrationProofOf(answer, invoiceId, registrationId) === null) throw registrationsFault();
  return answer;
}

/** 037's attempts rows (none for an empty page) as the port's answer; a throw for anything out of shape. */
export function invoicePaymentAttemptsAnswerOf(rows: unknown, scope: TrustedScope, after: InvoicePaymentAttemptsCursor | null): unknown {
  // The bound is checked before any row is read.
  if (!Array.isArray(rows) || rows.length > INVOICE_PAYMENT_ATTEMPTS_ASK) throw registrationsFault();
  const all: Row[] = rows.map((row) => { if (!hasColumns(row, ATTEMPTS_COLUMNS)) throw registrationsFault(); return row; });
  const first = all[0];
  if (first !== undefined && first.o_outcome !== 'attempt') {
    const words = after !== null ? ['denied', 'cursor_unknown'] : ['denied'];
    if (all.length !== 1 || !allNullBut(first, ATTEMPTS_COLUMNS) || typeof first.o_outcome !== 'string' || !words.includes(first.o_outcome)) {
      throw registrationsFault();
    }
    return Object.freeze({ outcome: first.o_outcome });
  }
  const attempts = all.map((row) => {
    if (row.o_outcome !== 'attempt' || row.o_tenant_id !== scope.tenant || row.o_store_id !== scope.store) throw registrationsFault();
    const paid = row.o_payment_id !== null;
    if (!paid && !PAYMENT_ATTEMPT_COLUMNS.every((c) => row[c] === null)) throw registrationsFault();
    if (paid && (row.o_reversed_at === null) !== (row.o_reason_code === null)) throw registrationsFault();
    return {
      invoiceId: row.o_invoice_id, invoiceNumber: exactOf(row.o_invoice_number, 1), attemptId: row.o_attempt_id, state: row.o_state,
      version: exactOf(row.o_version, 1), registeredAt: row.o_registered_at, settledAt: row.o_settled_at,
      payment: !paid ? null : {
        id: row.o_payment_id, amountCents: exactOf(row.o_amount_cents, 1), method: row.o_method, recordedAt: row.o_recorded_at,
        reversal: row.o_reversed_at === null ? null : { reversedAt: row.o_reversed_at, reasonCode: row.o_reason_code },
      },
    };
  });
  const answer = Object.freeze({ outcome: 'attempts', attempts });
  const judged = invoicePaymentAttemptsOf(answer, after);
  if (typeof judged !== 'object' || judged === null) throw registrationsFault();
  return answer;
}

/**
 * The proof and attempts reads over `client` (037's session-bound routines, under the read bounds; neither writes). The proof
 * is at most TWO transactions within `deadlineMs` of the call: each waits clamp(remaining - reserve, 0, 1000) ms; a second only
 * after the first answered 'not_durable' AND committed, and only while more than the reserve remains. The second re-runs the
 * whole routine (034's reader revalidates the session, the authority and the scope; no request-level session write happens
 * here). A raise is never retried; 'denied' and 'not_found' are answered as they come.
 */
export function createPostgresInvoicePaymentRegistrations(deps: { readonly client: SupervisedPgClient }): InvoicePaymentRegistrationsPort {
  const client = deps?.client;
  if (typeof client?.transaction !== 'function') throw new TypeError('invoice payment registrations read options invalid');
  const scopeOf = (raw: TrustedScope, sessionKey: string): TrustedScope => {
    if (!isTrustedScope(raw) || raw.scope !== 'store' || !isUuid(raw.tenant) || !isUuid(raw.store)) throw registrationsFault();
    if (typeof sessionKey !== 'string' || !SESSION_KEY_RE.test(sessionKey)) throw registrationsFault();
    return raw;
  };
  return Object.freeze({
    async proof(rawScope: TrustedScope, sessionKey: string, invoiceId: string, registrationId: string, signal: AbortSignal, deadlineMs: number): Promise<unknown> {
      const scope = scopeOf(rawScope, sessionKey);
      if (!isUuid(invoiceId) || !isUuid(registrationId) || !Number.isSafeInteger(deadlineMs) || deadlineMs < 1) throw registrationsFault();
      const until = Date.now() + deadlineMs;
      for (let attempt = 1; ; attempt += 1) {
        // 'not_durable' is RETURNED from the body, so this transaction commits before any other begins.
        const answer = await client.transaction(signal, INVOICE_DRAFT_READ_BOUNDS, async (sql) => {
          // Measured once the pooled connection is held and BEGIN has run, so the pool's queue time is already spent.
          const waitMs = Math.min(PROOF_WAIT_MAX_MS, Math.max(0, Math.floor(until - Date.now() - PROOF_ATTEMPT_RESERVE_MS)));
          return registrationProofAnswerOf(
            await sql`select o_outcome, o_tenant_id, o_store_id, o_invoice_id, o_registration_id, o_attempt_id, o_proof
              from tmpos_invoice_payment.m7b_invoice_payment_registration_proof(${sessionKey}::text, ${scope.store}::uuid, ${invoiceId}::uuid,
                ${scope.tenant}::uuid, ${registrationId}::uuid, ${waitMs}::integer)`,
            scope, invoiceId, registrationId,
          );
        });
        if (answer !== PROOF_NOT_DURABLE) return answer;
        if (attempt >= PROOF_ATTEMPTS || until - Date.now() <= PROOF_ATTEMPT_RESERVE_MS) throw new Error('invoice payment registration proof not yet durable');
      }
    },
    async attempts(rawScope: TrustedScope, sessionKey: string, after: InvoicePaymentAttemptsCursor | null, signal: AbortSignal): Promise<unknown> {
      const scope = scopeOf(rawScope, sessionKey);
      if (after !== null && (!isRecord(after) || !isUuid(after.invoiceId) || !isUuid(after.attemptId))) throw registrationsFault();
      return client.transaction(signal, INVOICE_DRAFT_READ_BOUNDS, async (sql) => invoicePaymentAttemptsAnswerOf(
        await sql`select o_outcome, o_tenant_id, o_store_id, o_invoice_id, o_invoice_number, o_attempt_id, o_state, o_version, o_registered_at,
            o_settled_at, o_payment_id, o_amount_cents, o_method, o_recorded_at, o_reversed_at, o_reason_code
          from tmpos_invoice_payment.m7b_invoice_payment_attempts(${sessionKey}::text, ${scope.store}::uuid, ${scope.tenant}::uuid,
            ${after === null ? null : after.invoiceId}::uuid, ${after === null ? null : after.attemptId}::uuid, ${INVOICE_PAYMENT_ATTEMPTS_ASK}::integer)`,
        scope, after,
      ));
    },
  });
}

/**
 * The startup preflight's key-presence question (037's m7b_payment_proof_key_probe: never the bytes or a digest): 'present'
 * with a generation, 'absent' without; a throw for anything else. Asked at startup only — never by readiness — so a key
 * removed later fails register, proof and record closed (037's 55000) while the attempts read and the settlement keep working.
 */
export async function probePaymentProofKey(client: SupervisedPgClient, signal: AbortSignal): Promise<'present' | 'absent'> {
  const rows = await client.transaction(signal, INVOICE_DRAFT_READ_BOUNDS,
    async (sql) => sql`select o_present, o_generation from tmpos_invoice_payment.m7b_payment_proof_key_probe()`);
  if (!Array.isArray(rows) || rows.length !== 1 || !hasColumns(rows[0], ['o_present', 'o_generation'])) throw new Error('payment proof key probe malformed');
  const { o_present: present, o_generation: generation } = rows[0];
  if (present === true && typeof generation === 'string' && BIGINT_TEXT_RE.test(generation) && generation !== '0') return 'present';
  if (present === false && generation === null) return 'absent';
  throw new Error('payment proof key probe malformed');
}

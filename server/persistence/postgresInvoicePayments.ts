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
//   record  — store.invoice_payment.record, a CREATE (paymentRefusals 'record'): 'tenant_mismatch' → 'precondition_failed'
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
  INVOICE_PAYMENTS_ASK, INVOICE_PAYMENT_RECORD_CONTRACT, INVOICE_PAYMENT_REVERSE_CONTRACT, invoicePaymentsOf, isInvoicePaymentMethod,
  isInvoicePaymentReversalReasonCode,
} from '../runtime/invoicePayments.js';
import type { InvoicePaymentsPort } from '../runtime/invoicePayments.js';
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
  const { invoiceId, expectedTenant, attemptId, amountCents, method } = changes;
  if (expectedVersion !== null || !isUuid(aggregateId) || !isUuid(invoiceId) || !isUuid(expectedTenant) || !isUuid(attemptId)
    || !isInt(amountCents, 1, MAX) || !isInvoicePaymentMethod(method)) return 'unavailable';
  const rows = await sql`select o_outcome, o_tenant_id, o_store_id, o_actor_id, o_membership_id, o_payment_id, o_invoice_id, o_audit_event_id
    from tmpos_invoice_payment.m7b_invoice_payment_record(${sessionKey}::text, ${context.store}::uuid, ${invoiceId}::uuid, ${expectedTenant}::uuid,
      ${aggregateId}::uuid, ${attemptId}::uuid, ${String(amountCents)}::bigint, ${method}::text, ${correlationId}::uuid)`;
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

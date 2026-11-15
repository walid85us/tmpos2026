// Phase 4.0 M7b — the PostgreSQL side of credit notes against an issued store invoice (M7B-CREDITNOTES-P1; docs/phase-4/16
// D-CN-7..9, §7; G-IAM, G-ISOLATION, G-PERSIST, G-AUDIT; migration 038, schema tmpos_invoice_credit_note): the registration's,
// the issue's, the settlement's and the withdrawal's mutators (server/runtime/invoiceCreditNotes.ts), each ONE fixed call into
// 038's session-bound SECURITY DEFINER routine, and the proof, attempts and list reads. Every value is a bound parameter, every
// bigint as exact decimal text; no table is named here.
//
// THE FOUR MUTATORS are ROUTINE-AUDITED (postgresTransactionalStore.ts ROUTINE_AUDITED_KINDS; doc 16 D-CN-8 A): each routine
// writes the command's one audit record itself, in the command's transaction, under the command's correlation id, and the
// store writes none. So 'applied' is accepted ONLY with a canonical audit event id from the routine, beside exactly this
// transaction's tenant, store, actor and grant and the command's own aggregate and path invoice. Inside the command's
// transaction after the fence and the store-scope revalidation, bound from the presenting session's key and the REVALIDATED
// trusted store (never the change set or the request target).
//   register — store.invoice_credit_note.register, a CREATE ('credit'): 'tenant_mismatch' → 'precondition_failed' (rolled back,
//              the unsealed 409); 'not_found' (rolled back, the 404); 'already_issued' and 'invalid_state' (sealed 409s);
//              'conflict' (an own unsettled registration on the invoice: the sealed write_conflict); 'refused' (the 503).
//   issue    — store.invoice_credit_note.issue, a CREATE ('credit'): the same words plus 'amount_exceeds_remaining' (sealed).
//   settle   — store.invoice_credit_note.settle, an UPDATE of the caller's registration of the body's attempt at version 1 or 2:
//              'applied' and 'unchanged' (no audit id) each with version 3; 'tenant_mismatch', 'not_found', 'conflict', 'refused'.
//   withdraw — store.invoice_credit_note.withdraw, an UPDATE at version 1 exactly: the tenant and not-found words; 'invalid_state'
//              (already withdrawn, or a voided invoice) and 'conflict', each sealed; 'refused'.
// register, issue and withdraw are SENSITIVE: never a call without the deadline the revalidator judged, and after 'applied' that
// deadline is judged once more on the DATABASE clock (postgresSessionStore.ts authenticationFresh): stale after the routine's
// lock waits is 'refused', and everything rolls back.
// Anything else — another identity, aggregate or invoice, no audit id, an unknown word, another row count, a column more or
// less, an identity on a refusal — is 'mismatch' (rolled back, the 503). A raise is not caught: the kernel rolls back.
//
// THE READS. The proof routine's durability wait ends in an ANSWER ('not_durable', NULLs), never a raise: the port commits that
// transaction and asks ONCE more in a fresh one within the route's deadline; a second 'not_durable' is the port's bounded outage
// (postgresInvoicePayments.ts's rule, restated). The attempts and the list are checked column for column and handed to the
// runtime's own decoders, which must accept them. The list's names travel only when 038 says they are visible.
//
// No driver error message, row value, key, proof or body is ever logged. IT CONSTRUCTS NOTHING AND READS NOTHING at import.
import type { TransactionMutation } from '../runtime/commandTransaction.js';
import {
  INVOICE_CREDIT_NOTES_ASK, INVOICE_CREDIT_NOTE_ATTEMPTS_ASK, INVOICE_CREDIT_NOTE_ISSUE_CONTRACT, INVOICE_CREDIT_NOTE_REGISTER_CONTRACT,
  INVOICE_CREDIT_NOTE_SETTLE_CONTRACT, INVOICE_CREDIT_NOTE_WITHDRAW_CONTRACT, creditNoteProofOf, invoiceCreditNoteAttemptsOf, invoiceCreditNotesOf,
  isInvoiceCreditNoteReason, isInvoiceCreditNoteWithdrawalReason,
} from '../runtime/invoiceCreditNotes.js';
import type { InvoiceCreditNoteAttemptsCursor, InvoiceCreditNotesPort } from '../runtime/invoiceCreditNotes.js';
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
const PROOF_RE = /^[0-9a-f]{64}$/;
/** A session key: the SHA-256 of a session identifier, unpadded base64url (sessions.ts digestOf). */
const SESSION_KEY_RE = /^[A-Za-z0-9_-]{43}$/;
const BIGINT_TEXT_RE = /^(0|[1-9][0-9]{0,15})$/;
type Row = Readonly<Record<string, unknown>>;

/** The store context, key and correlation id a credit-note routine is called with, or null: never a call without all three. */
function authorityOf(authority: MutationAuthority | undefined): { context: TrustedScope; sessionKey: string; correlationId: string } | null {
  const context = authority?.context ?? null;
  const sessionKey = authority?.sessionKey ?? null;
  const correlationId = authority?.correlationId ?? null;
  if (context === null || context.scope !== 'store' || !isUuid(context.tenant) || !isUuid(context.store) || typeof sessionKey !== 'string'
    || typeof correlationId !== 'string' || !UUID_V4_RE.test(correlationId)) return null;
  return { context, sessionKey, correlationId };
}

/** The sensitive commands' authority: the above plus the recent sign-in's deadline the revalidator judged; null without it. */
function sensitiveAuthorityOf(authority: MutationAuthority | undefined): ReturnType<typeof authorityOf> & { authNotAfter: number } | null {
  const held = authorityOf(authority);
  const authNotAfter = authority?.authNotAfter ?? null;
  return held === null || !isInt(authNotAfter, 1, MAX) ? null : { ...held, authNotAfter };
}

/**
 * One writer's row, judged: 'applied' only beside exactly this context, the expected aggregate column and path invoice and a
 * canonical audit id; a refusal only with every other column null and a word in `refusals`; 'tenant_mismatch' is the store's
 * 'precondition_failed'; anything else 'mismatch'.
 */
function writerAnswerOf(rows: readonly unknown[], columns: readonly string[], aggregateColumn: string, aggregateId: string, invoiceId: string,
  context: TrustedScope, refusals: ReadonlySet<string>): 'applied' | 'precondition_failed' | 'mismatch' | string {
  if (rows.length !== 1 || !hasColumns(rows[0], columns)) return 'mismatch';
  const row: Row = rows[0];
  const outcome = row.o_outcome;
  if (outcome === 'applied') {
    return row.o_tenant_id === context.tenant && row.o_store_id === context.store && row.o_actor_id === context.actor
      && row.o_membership_id === context.membershipId && row[aggregateColumn] === aggregateId && row.o_invoice_id === invoiceId
      && isUuid(row.o_audit_event_id) ? 'applied' : 'mismatch';
  }
  if (columns.some((c) => c !== 'o_outcome' && row[c] !== null)) return 'mismatch';
  if (outcome === 'tenant_mismatch') return 'precondition_failed';
  return typeof outcome === 'string' && refusals.has(outcome) ? outcome : 'mismatch';
}

const REGISTER_COLUMNS: readonly string[] = ['o_outcome', 'o_tenant_id', 'o_store_id', 'o_actor_id', 'o_membership_id', 'o_registration_id', 'o_invoice_id', 'o_audit_event_id'];
const REGISTER_REFUSALS: ReadonlySet<string> = new Set(['not_found', 'already_issued', 'invalid_state', 'conflict', 'refused']);

async function applyInvoiceCreditNoteRegister(sql: PgStatement, mutation: TransactionMutation, authority?: MutationAuthority): Promise<unknown> {
  const held = sensitiveAuthorityOf(authority);
  if (held === null) return 'unavailable';
  const { context, sessionKey, correlationId, authNotAfter } = held;
  const { aggregateId, expectedVersion, changes } = mutation;
  const { invoiceId, expectedTenant, attemptId, grossCents, reason } = changes;
  if (expectedVersion !== null || !isUuid(aggregateId) || !isUuid(invoiceId) || !isUuid(expectedTenant) || !isUuid(attemptId)
    || !isInt(grossCents, 1, MAX) || !isInvoiceCreditNoteReason(reason)) return 'unavailable';
  const rows = await sql`select o_outcome, o_tenant_id, o_store_id, o_actor_id, o_membership_id, o_registration_id, o_invoice_id, o_audit_event_id
    from tmpos_invoice_credit_note.m7b_invoice_credit_note_register(${sessionKey}::text, ${context.store}::uuid, ${invoiceId}::uuid,
      ${expectedTenant}::uuid, ${aggregateId}::uuid, ${attemptId}::uuid, ${String(grossCents)}::bigint, ${reason}::text, ${correlationId}::uuid)`;
  const answer = writerAnswerOf(rows, REGISTER_COLUMNS, 'o_registration_id', aggregateId, invoiceId, context, REGISTER_REFUSALS);
  // The recent sign-in, judged again now that the routine's lock waits are over (header).
  return answer === 'applied' && !(await authenticationFresh(sql, authNotAfter)) ? 'refused' : answer;
}

const ISSUE_COLUMNS: readonly string[] = ['o_outcome', 'o_tenant_id', 'o_store_id', 'o_actor_id', 'o_membership_id', 'o_credit_note_id', 'o_invoice_id', 'o_audit_event_id'];
const ISSUE_REFUSALS: ReadonlySet<string> = new Set(['not_found', 'already_issued', 'invalid_state', 'conflict', 'amount_exceeds_remaining', 'refused']);

async function applyInvoiceCreditNoteIssue(sql: PgStatement, mutation: TransactionMutation, authority?: MutationAuthority): Promise<unknown> {
  const held = sensitiveAuthorityOf(authority);
  if (held === null) return 'unavailable';
  const { context, sessionKey, correlationId, authNotAfter } = held;
  const { aggregateId, expectedVersion, changes } = mutation;
  const { invoiceId, expectedTenant, registrationId, attemptId, grossCents, reason, registrationProof } = changes;
  if (expectedVersion !== null || !isUuid(aggregateId) || !isUuid(invoiceId) || !isUuid(expectedTenant) || !isUuid(registrationId) || !isUuid(attemptId)
    || !isInt(grossCents, 1, MAX) || !isInvoiceCreditNoteReason(reason) || typeof registrationProof !== 'string' || !PROOF_RE.test(registrationProof)) {
    return 'unavailable';
  }
  const rows = await sql`select o_outcome, o_tenant_id, o_store_id, o_actor_id, o_membership_id, o_credit_note_id, o_invoice_id, o_audit_event_id
    from tmpos_invoice_credit_note.m7b_invoice_credit_note_issue(${sessionKey}::text, ${context.store}::uuid, ${invoiceId}::uuid,
      ${expectedTenant}::uuid, ${aggregateId}::uuid, ${registrationId}::uuid, ${attemptId}::uuid, ${String(grossCents)}::bigint, ${reason}::text,
      ${registrationProof}::text, ${correlationId}::uuid)`;
  const answer = writerAnswerOf(rows, ISSUE_COLUMNS, 'o_credit_note_id', aggregateId, invoiceId, context, ISSUE_REFUSALS);
  return answer === 'applied' && !(await authenticationFresh(sql, authNotAfter)) ? 'refused' : answer;
}

const SETTLE_COLUMNS: readonly string[] = ['o_outcome', 'o_tenant_id', 'o_store_id', 'o_actor_id', 'o_membership_id', 'o_version', 'o_invoice_id', 'o_audit_event_id'];
const SETTLE_REFUSALS: ReadonlySet<string> = new Set(['not_found', 'conflict', 'refused']);
/** A settled registration's lifecycle version (038), as its bigint decimal text. */
const SETTLED_REGISTRATION_VERSION = '3';

async function applyInvoiceCreditNoteSettle(sql: PgStatement, mutation: TransactionMutation, authority?: MutationAuthority): Promise<unknown> {
  const held = authorityOf(authority);
  if (held === null) return 'unavailable';
  const { context, sessionKey, correlationId } = held;
  const { aggregateId, expectedVersion, changes } = mutation;
  const { invoiceId, expectedTenant, attemptId } = changes;
  if (!isUuid(aggregateId) || aggregateId !== attemptId || (expectedVersion !== 1 && expectedVersion !== 2) || !isUuid(invoiceId)
    || !isUuid(expectedTenant)) return 'unavailable';
  const rows = await sql`select o_outcome, o_tenant_id, o_store_id, o_actor_id, o_membership_id, o_version, o_invoice_id, o_audit_event_id
    from tmpos_invoice_credit_note.m7b_invoice_credit_note_settle(${sessionKey}::text, ${context.store}::uuid, ${invoiceId}::uuid,
      ${expectedTenant}::uuid, ${attemptId}::uuid, ${String(expectedVersion)}::bigint, ${correlationId}::uuid)`;
  if (rows.length !== 1 || !hasColumns(rows[0], SETTLE_COLUMNS)) return 'mismatch';
  const row: Row = rows[0];
  const outcome = row.o_outcome;
  if (outcome === 'applied' || outcome === 'unchanged') {
    if (row.o_tenant_id !== context.tenant || row.o_store_id !== context.store || row.o_actor_id !== context.actor
      || row.o_membership_id !== context.membershipId || row.o_version !== SETTLED_REGISTRATION_VERSION || row.o_invoice_id !== invoiceId) return 'mismatch';
    // 'applied' wrote its one audit record; 'unchanged' wrote nothing, so names none.
    if (outcome === 'applied' ? !isUuid(row.o_audit_event_id) : row.o_audit_event_id !== null) return 'mismatch';
    return outcome;
  }
  if (SETTLE_COLUMNS.some((c) => c !== 'o_outcome' && row[c] !== null)) return 'mismatch';
  if (outcome === 'tenant_mismatch') return 'precondition_failed';
  return typeof outcome === 'string' && SETTLE_REFUSALS.has(outcome) ? outcome : 'mismatch';
}

const WITHDRAW_COLUMNS: readonly string[] = ['o_outcome', 'o_tenant_id', 'o_store_id', 'o_actor_id', 'o_membership_id', 'o_credit_note_id', 'o_invoice_id', 'o_audit_event_id'];
const WITHDRAW_REFUSALS: ReadonlySet<string> = new Set(['not_found', 'invalid_state', 'conflict', 'refused']);
/** D-CN-9: a withdrawal moves an ACTIVE credit note (version 1), never any other step. */
const ACTIVE_CREDIT_NOTE_VERSION = 1;

async function applyInvoiceCreditNoteWithdraw(sql: PgStatement, mutation: TransactionMutation, authority?: MutationAuthority): Promise<unknown> {
  const held = sensitiveAuthorityOf(authority);
  if (held === null) return 'unavailable';
  const { context, sessionKey, correlationId, authNotAfter } = held;
  const { aggregateId, expectedVersion, changes } = mutation;
  const { invoiceId, expectedTenant, reason } = changes;
  if (!isUuid(aggregateId) || expectedVersion !== ACTIVE_CREDIT_NOTE_VERSION || !isUuid(invoiceId) || !isUuid(expectedTenant)
    || !isInvoiceCreditNoteWithdrawalReason(reason)) return 'unavailable';
  const rows = await sql`select o_outcome, o_tenant_id, o_store_id, o_actor_id, o_membership_id, o_credit_note_id, o_invoice_id, o_audit_event_id
    from tmpos_invoice_credit_note.m7b_invoice_credit_note_withdraw(${sessionKey}::text, ${context.store}::uuid, ${invoiceId}::uuid,
      ${expectedTenant}::uuid, ${aggregateId}::uuid, ${String(expectedVersion)}::bigint, ${reason}::text, ${correlationId}::uuid)`;
  const answer = writerAnswerOf(rows, WITHDRAW_COLUMNS, 'o_credit_note_id', aggregateId, invoiceId, context, WITHDRAW_REFUSALS);
  return answer === 'applied' && !(await authenticationFresh(sql, authNotAfter)) ? 'refused' : answer;
}

/** The registration's mutator, as the tenant inventory registers it (server/composition/tenantTransactions.ts). */
export const INVOICE_CREDIT_NOTE_REGISTER_MUTATOR: AggregateMutator = Object.freeze({
  kind: INVOICE_CREDIT_NOTE_REGISTER_CONTRACT.kind, mode: 'create', aggregateType: INVOICE_CREDIT_NOTE_REGISTER_CONTRACT.aggregateType,
  contextScope: 'store', paymentRefusals: 'credit', routineAudited: true, apply: applyInvoiceCreditNoteRegister,
});
/** The issue's mutator. */
export const INVOICE_CREDIT_NOTE_ISSUE_MUTATOR: AggregateMutator = Object.freeze({
  kind: INVOICE_CREDIT_NOTE_ISSUE_CONTRACT.kind, mode: 'create', aggregateType: INVOICE_CREDIT_NOTE_ISSUE_CONTRACT.aggregateType,
  contextScope: 'store', paymentRefusals: 'credit', routineAudited: true, apply: applyInvoiceCreditNoteIssue,
});
/** The settlement's mutator. */
export const INVOICE_CREDIT_NOTE_SETTLE_MUTATOR: AggregateMutator = Object.freeze({
  kind: INVOICE_CREDIT_NOTE_SETTLE_CONTRACT.kind, mode: 'update', aggregateType: INVOICE_CREDIT_NOTE_SETTLE_CONTRACT.aggregateType,
  contextScope: 'store', routineAudited: true, apply: applyInvoiceCreditNoteSettle,
});
/** The withdrawal's mutator. */
export const INVOICE_CREDIT_NOTE_WITHDRAW_MUTATOR: AggregateMutator = Object.freeze({
  kind: INVOICE_CREDIT_NOTE_WITHDRAW_CONTRACT.kind, mode: 'update', aggregateType: INVOICE_CREDIT_NOTE_WITHDRAW_CONTRACT.aggregateType,
  contextScope: 'store', routineAudited: true, apply: applyInvoiceCreditNoteWithdraw,
});

// ---------------------------------------------------------------------------
// The reads
// ---------------------------------------------------------------------------

const fault = (): Error => new Error('invoice credit notes answer invalid');
/** The proof routine's 'not_durable' answer: the port's alone (it commits, then asks once more); it never reaches the runtime. */
const PROOF_NOT_DURABLE = Object.freeze({ outcome: 'not_durable' });
/** 038's wait bound per attempt (037's), the time an attempt keeps beside its wait, and the attempts one proof read may take. */
const PROOF_WAIT_MAX_MS = 1000;
const PROOF_ATTEMPT_RESERVE_MS = 250;
const PROOF_ATTEMPTS = 2;
const PROOF_COLUMNS: readonly string[] = ['o_outcome', 'o_tenant_id', 'o_store_id', 'o_invoice_id', 'o_registration_id', 'o_attempt_id', 'o_proof'];
const ATTEMPTS_COLUMNS: readonly string[] = ['o_outcome', 'o_tenant_id', 'o_store_id', 'o_invoice_id', 'o_invoice_number', 'o_attempt_id', 'o_state',
  'o_version', 'o_registered_at', 'o_settled_at', 'o_gross_cents', 'o_reason_code', 'o_credit_note_id', 'o_issued_at', 'o_withdrawn_at'];
const LIST_HEADER_COLUMNS: readonly string[] = ['o_outcome', 'o_tenant_id', 'o_store_id', 'o_invoice_id', 'o_names_visible'];
const LIST_NOTE_COLUMNS: readonly string[] = ['o_credit_note_id', 'o_credit_note_number', 'o_gross_cents', 'o_tax_cents', 'o_net_cents', 'o_reason_code',
  'o_issued_at', 'o_issued_by_name', 'o_withdrawn_at', 'o_withdrawal_reason_code', 'o_withdrawn_by_name'];
const LIST_COLUMNS: readonly string[] = [...LIST_HEADER_COLUMNS, ...LIST_NOTE_COLUMNS];
const allNullBut = (row: Row, columns: readonly string[]): boolean => columns.every((c) => c === 'o_outcome' || row[c] === null);
/** A bigint column's exact value within 2^53 - 1, at or above `min`; a fault otherwise. */
function exactOf(v: unknown, min: number): number {
  if (typeof v !== 'string' || !BIGINT_TEXT_RE.test(v)) throw fault();
  const n = Number(v);
  if (!Number.isSafeInteger(n) || String(n) !== v || n < min) throw fault();
  return n;
}

/** 038's proof row as the port's answer; a throw for anything out of shape (the runtime's decoder must accept it). */
export function creditNoteProofAnswerOf(rows: unknown, scope: TrustedScope, invoiceId: string, registrationId: string): unknown {
  if (!Array.isArray(rows) || rows.length !== 1 || !hasColumns(rows[0], PROOF_COLUMNS)) throw fault();
  const row: Row = rows[0];
  if (row.o_outcome === 'denied' || row.o_outcome === 'not_found' || row.o_outcome === 'not_durable') {
    if (!allNullBut(row, PROOF_COLUMNS)) throw fault();
    return row.o_outcome === 'not_durable' ? PROOF_NOT_DURABLE : Object.freeze({ outcome: row.o_outcome });
  }
  if (row.o_outcome !== 'proof' || row.o_tenant_id !== scope.tenant || row.o_store_id !== scope.store || row.o_invoice_id !== invoiceId
    || row.o_registration_id !== registrationId) throw fault();
  const answer = Object.freeze({ outcome: 'proof', registrationId, invoiceId, attemptId: row.o_attempt_id, proof: row.o_proof });
  if (creditNoteProofOf(answer, invoiceId, registrationId) === null) throw fault();
  return answer;
}

/** 038's attempts rows (none for an empty page) as the port's answer; a throw for anything out of shape. */
export function creditNoteAttemptsAnswerOf(rows: unknown, scope: TrustedScope, after: InvoiceCreditNoteAttemptsCursor | null): unknown {
  // The bound is checked before any row is read.
  if (!Array.isArray(rows) || rows.length > INVOICE_CREDIT_NOTE_ATTEMPTS_ASK) throw fault();
  const all: Row[] = rows.map((row) => { if (!hasColumns(row, ATTEMPTS_COLUMNS)) throw fault(); return row; });
  const first = all[0];
  if (first !== undefined && first.o_outcome !== 'attempt') {
    const words = after !== null ? ['denied', 'cursor_unknown'] : ['denied'];
    if (all.length !== 1 || !allNullBut(first, ATTEMPTS_COLUMNS) || typeof first.o_outcome !== 'string' || !words.includes(first.o_outcome)) throw fault();
    return Object.freeze({ outcome: first.o_outcome });
  }
  const attempts = all.map((row) => {
    if (row.o_outcome !== 'attempt' || row.o_tenant_id !== scope.tenant || row.o_store_id !== scope.store) throw fault();
    const issued = row.o_credit_note_id !== null;
    if (!issued && (row.o_issued_at !== null || row.o_withdrawn_at !== null)) throw fault();
    return {
      invoiceId: row.o_invoice_id, invoiceNumber: exactOf(row.o_invoice_number, 1), attemptId: row.o_attempt_id, state: row.o_state,
      version: exactOf(row.o_version, 1), registeredAt: row.o_registered_at, settledAt: row.o_settled_at, grossCents: exactOf(row.o_gross_cents, 1),
      reason: row.o_reason_code,
      creditNote: !issued ? null : { id: row.o_credit_note_id, issuedAt: row.o_issued_at, withdrawnAt: row.o_withdrawn_at },
    };
  });
  const answer = Object.freeze({ outcome: 'attempts', attempts });
  const judged = invoiceCreditNoteAttemptsOf(answer, after);
  if (typeof judged !== 'object' || judged === null) throw fault();
  return answer;
}

/** 038's list rows as the port's answer; a throw for anything out of shape. Names travel only when 038 says they are visible. */
export function creditNotesListAnswerOf(rows: unknown, scope: TrustedScope, invoiceId: string, after: string | null): unknown {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > INVOICE_CREDIT_NOTES_ASK) throw fault();
  const all: Row[] = rows.map((row) => { if (!hasColumns(row, LIST_COLUMNS)) throw fault(); return row; });
  const first = all[0];
  if (first.o_outcome !== 'credit_notes') {
    // A refusal is the routine's only row; 'cursor_unknown' only for a continuation.
    const words = after !== null ? ['denied', 'not_found', 'cursor_unknown'] : ['denied', 'not_found'];
    if (all.length !== 1 || !allNullBut(first, LIST_COLUMNS) || typeof first.o_outcome !== 'string' || !words.includes(first.o_outcome)) throw fault();
    return Object.freeze({ outcome: first.o_outcome });
  }
  // Every row carries the same header, naming this scope's tenant and store, the invoice asked for and one visibility.
  if (first.o_tenant_id !== scope.tenant || first.o_store_id !== scope.store || first.o_invoice_id !== invoiceId || typeof first.o_names_visible !== 'boolean') throw fault();
  if (!all.every((row) => LIST_HEADER_COLUMNS.every((c) => row[c] === first[c]))) throw fault();
  // One row with every credit-note column null is the empty page; otherwise every row is a credit note.
  const empty = all.length === 1 && LIST_NOTE_COLUMNS.every((c) => first[c] === null);
  const creditNotes = empty ? [] : all.map((row) => {
    if (row.o_credit_note_id === null) throw fault();
    const withdrawn = row.o_withdrawn_at !== null;
    if (!withdrawn && (row.o_withdrawal_reason_code !== null || row.o_withdrawn_by_name !== null)) throw fault();
    return {
      id: row.o_credit_note_id, number: exactOf(row.o_credit_note_number, 1), grossCents: exactOf(row.o_gross_cents, 1),
      taxCents: exactOf(row.o_tax_cents, 0), netCents: exactOf(row.o_net_cents, 0), reason: row.o_reason_code, issuedAt: row.o_issued_at,
      issuedByName: row.o_issued_by_name,
      withdrawal: !withdrawn ? null : { withdrawnAt: row.o_withdrawn_at, reason: row.o_withdrawal_reason_code, withdrawnByName: row.o_withdrawn_by_name },
    };
  });
  const answer = Object.freeze({ outcome: 'credit_notes', invoiceId, namesVisible: first.o_names_visible, creditNotes });
  // The runtime's own decoder must accept it as a page (never as a refusal word).
  const judged = invoiceCreditNotesOf(answer, invoiceId, after);
  if (typeof judged !== 'object' || judged === null) throw fault();
  return answer;
}

/**
 * The proof, attempts and list reads over `client` (038's session-bound routines, under the read bounds; none writes). The proof
 * is at most TWO transactions within `deadlineMs` of the call: each waits clamp(remaining - reserve, 0, 1000) ms; a second only
 * after the first answered 'not_durable' AND committed, and only while more than the reserve remains. A raise is never retried.
 */
export function createPostgresInvoiceCreditNotes(deps: { readonly client: SupervisedPgClient }): InvoiceCreditNotesPort {
  const client = deps?.client;
  if (typeof client?.transaction !== 'function') throw new TypeError('invoice credit notes read options invalid');
  const scopeOf = (raw: TrustedScope, sessionKey: string): TrustedScope => {
    if (!isTrustedScope(raw) || raw.scope !== 'store' || !isUuid(raw.tenant) || !isUuid(raw.store)) throw fault();
    if (typeof sessionKey !== 'string' || !SESSION_KEY_RE.test(sessionKey)) throw fault();
    return raw;
  };
  return Object.freeze({
    async proof(rawScope: TrustedScope, sessionKey: string, invoiceId: string, registrationId: string, signal: AbortSignal, deadlineMs: number): Promise<unknown> {
      const scope = scopeOf(rawScope, sessionKey);
      if (!isUuid(invoiceId) || !isUuid(registrationId) || !Number.isSafeInteger(deadlineMs) || deadlineMs < 1) throw fault();
      const until = Date.now() + deadlineMs;
      for (let attempt = 1; ; attempt += 1) {
        // 'not_durable' is RETURNED from the body, so this transaction commits before any other begins.
        const answer = await client.transaction(signal, INVOICE_DRAFT_READ_BOUNDS, async (sql) => {
          const waitMs = Math.min(PROOF_WAIT_MAX_MS, Math.max(0, Math.floor(until - Date.now() - PROOF_ATTEMPT_RESERVE_MS)));
          return creditNoteProofAnswerOf(
            await sql`select o_outcome, o_tenant_id, o_store_id, o_invoice_id, o_registration_id, o_attempt_id, o_proof
              from tmpos_invoice_credit_note.m7b_invoice_credit_note_registration_proof(${sessionKey}::text, ${scope.store}::uuid, ${invoiceId}::uuid,
                ${scope.tenant}::uuid, ${registrationId}::uuid, ${waitMs}::integer)`,
            scope, invoiceId, registrationId,
          );
        });
        if (answer !== PROOF_NOT_DURABLE) return answer;
        if (attempt >= PROOF_ATTEMPTS || until - Date.now() <= PROOF_ATTEMPT_RESERVE_MS) throw new Error('invoice credit note registration proof not yet durable');
      }
    },
    async attempts(rawScope: TrustedScope, sessionKey: string, after: InvoiceCreditNoteAttemptsCursor | null, signal: AbortSignal): Promise<unknown> {
      const scope = scopeOf(rawScope, sessionKey);
      if (after !== null && (!isRecord(after) || !isUuid(after.invoiceId) || !isUuid(after.attemptId))) throw fault();
      return client.transaction(signal, INVOICE_DRAFT_READ_BOUNDS, async (sql) => creditNoteAttemptsAnswerOf(
        await sql`select o_outcome, o_tenant_id, o_store_id, o_invoice_id, o_invoice_number, o_attempt_id, o_state, o_version, o_registered_at,
            o_settled_at, o_gross_cents, o_reason_code, o_credit_note_id, o_issued_at, o_withdrawn_at
          from tmpos_invoice_credit_note.m7b_invoice_credit_note_attempts(${sessionKey}::text, ${scope.store}::uuid, ${scope.tenant}::uuid,
            ${after === null ? null : after.invoiceId}::uuid, ${after === null ? null : after.attemptId}::uuid, ${INVOICE_CREDIT_NOTE_ATTEMPTS_ASK}::integer)`,
        scope, after,
      ));
    },
    async list(rawScope: TrustedScope, sessionKey: string, invoiceId: string, after: string | null, signal: AbortSignal): Promise<unknown> {
      const scope = scopeOf(rawScope, sessionKey);
      if (!isUuid(invoiceId) || (after !== null && !isUuid(after))) throw fault();
      return client.transaction(signal, INVOICE_DRAFT_READ_BOUNDS, async (sql) => creditNotesListAnswerOf(
        await sql`select o_outcome, o_tenant_id, o_store_id, o_invoice_id, o_names_visible, o_credit_note_id, o_credit_note_number, o_gross_cents,
            o_tax_cents, o_net_cents, o_reason_code, o_issued_at, o_issued_by_name, o_withdrawn_at, o_withdrawal_reason_code, o_withdrawn_by_name
          from tmpos_invoice_credit_note.m7b_invoice_credit_notes_list(${sessionKey}::text, ${scope.tenant}::uuid, ${scope.store}::uuid, ${invoiceId}::uuid,
            ${after}::uuid, ${INVOICE_CREDIT_NOTES_ASK}::integer)`,
        scope, invoiceId, after,
      ));
    },
  });
}

// Phase 4.0 M7b — the PostgreSQL side of issuing (M7B-INVOICES-ISSUE-P1; docs/phase-4/12 §10; G-IAM, G-ISOLATION, G-PERSIST,
// G-AUDIT; migration 034, schema tmpos_invoice_issue): the issue's mutator, the issuing-settings write's mutator, and the
// four reads' production adapters (server/runtime/invoiceIssuing.ts, server/runtime/issuingSettings.ts), each ONE fixed call
// into one of 034's session-bound SECURITY DEFINER routines — since M7B-INVOICES-VOID-P1 the issued page and get into 035's
// v2 routines instead (schema tmpos_invoice_void; THE LIFECYCLE below). Every value is a bound parameter, bigints as exact
// decimal text; no table is named here.
//
// THE ISSUE'S MUTATOR (INVOICE_ISSUE_MUTATOR: store.invoice.issue, mode update, context scope 'store', issuingRefusals,
// audit subjects 'issued_invoice'). For POST /api/v1/stores/{storeId}/invoice-drafts/{id}/issue, inside the command's
// transaction after the idempotency fence and the store-scope revalidation and before the audit record and the completion
// (postgresTransactionalStore.ts commit), one statement — tmpos_invoice_issue.m7b_invoice_issue — bound from the presenting
// session's key, the REVALIDATED trusted store (never the change set or the request target), the draft (the command's
// aggregate id), the expected tenant, the expected draft, settings and customer versions and the runtime's new invoice id.
// Its answers, one row: 'applied' naming exactly this transaction's tenant, store, actor and grant, the draft at
// expectedVersion + 1, the invoice id asked for, a customer uuid and a number 1..2^53 - 1 — answered as { outcome:
// 'applied', subjectCustomerId } so the audit record names the customer the database derived; every refusal with every
// other column null — 'tenant_mismatch' as 'precondition_failed' (rolled back, the unsealed 409), 'not_found' (rolled back,
// the 404), 'invalid_state', 'conflict', 'issuing_not_configured' and 'amount_out_of_range' (each the sealed 409, its
// completion all that commits), 'refused' (rolled back, the 503). Anything else — another identity, version, invoice id,
// outcome or row count, an identity on a refusal — is 'mismatch' (rolled back, the 503). A raise is not caught: the kernel
// rolls back, a 503, and a retry re-plans.
//
// THE SETTINGS WRITE'S MUTATOR (ISSUING_SETTINGS_UPDATE_MUTATOR: tenant.issuing_settings.update, mode create, context scope
// 'tenant', audit subjects 'store'). For PUT /api/v1/issuing-settings/{id}, at the same point of the same order, one
// statement — tmpos_invoice_issue.m7b_issuing_settings_set — bound from the session key, the path's store (the change set's,
// a selector the routine judges in the session's own tenant), the expected tenant and version, the normalized values (the
// postal address's lines joined by LF), the tax registration id or NULL, the mode, and the rate or NULL under 'none'. Its
// answers, one row: 'applied' naming exactly this transaction's tenant, the path's store, this actor and grant, at
// expectedVersion + 1; every refusal with every other column null — 'tenant_mismatch' as 'precondition_failed', 'not_found'
// (rolled back, the 404), 'conflict' (the sealed 409), 'refused' (the 503); anything else 'mismatch'.
// THE RECENT SIGN-IN, AGAIN (postgresRoleLevels.ts's rule): edit_issuing_settings is sensitive and the revalidator judges its
// deadline before this mutator runs, but the routine's per-store advisory key and settings row lock can wait; so after the
// routine answered 'applied' the deadline is judged once more on the DATABASE clock, and a sign-in that went stale during the
// wait is 'refused' — the write rolls back with everything else. A command without a deadline never reaches the routine.
//
// THE READS (createPostgresIssuingSettings, createPostgresInvoiceIssuing). The settings read, the preview, the issued page
// and the issued get each run ONE statement on the kernel's client, in one short read transaction with the drafts' bounds
// (postgresInvoiceDrafts.ts INVOICE_DRAFT_READ_BOUNDS), handed the session key and the TRUSTED scope's tenant (and store) as
// the routine's expected ones — never anything the request carried beyond a validated store id, draft id, anchor, source
// draft, invoice id or page size. Every row is untrusted: a refusal must be the routine's only row with every other column
// null; every data row must name exactly the trusted tenant and store and carry well-formed values (bigints as exact decimal
// text within 2^53 - 1, header columns identical on every line row, positions 1..n, the line count the row count), and the
// assembled answer must pass the runtime's own validator. Anything else — and an abort, a timeout, a lost connection, a
// driver error — is a THROW, an outage the route answers as a bounded 503, never a refusal. The routes validate again.
//
// THE LIFECYCLE (M7B-INVOICES-VOID-P1, migration 035). The issued page and get ask 035's v2 routines,
// tmpos_invoice_void.m7b_issued_invoice_page_v2 and m7b_issued_invoice_get_v2: 034's answers row for row, plus o_status on a
// page row and o_status, o_voided_at and o_reason_code on every line row of the get (all NULL on a refusal row). 035 revoked
// the runtime's EXECUTE on 034's page and get, so a 034 statement here would be refused outright — never an answer that
// conceals a void. The get's lifecycle is a header value: identical on every line row, or a fault. The runtime validator
// judges the words, the void time against issuedAt and the code (invoiceIssuing.ts THE LIFECYCLE). The voiding actor is no
// column of either routine. The void's own mutator is postgresInvoiceVoid.ts.
//
// READINESS (probeInvoiceIssuing, chained last into the tenant reads' probe). It asks the four reads — 034's settings read
// and preview, and since M7B-INVOICES-VOID-P1 035's v2 page and get in place of 034's — for a random key no session holds and
// requires each one's single 'denied' row with every other column null: the login's EXECUTE and USAGE.
//
// No driver error message, row value, key or body is ever logged. IT CONSTRUCTS NOTHING AND READS NOTHING at import: the
// caller hands it the kernel the composition root already built.
import { randomBytes, randomUUID } from 'node:crypto';
import { isTrustedScope } from '../runtime/principals.js';
import type { TrustedScope } from '../runtime/principals.js';
import type { TransactionMutation } from '../runtime/commandTransaction.js';
import { INVOICE_DRAFT_MAX_LINES } from '../runtime/invoiceDrafts.js';
import {
  INVOICE_ISSUE_CONTRACT, ISSUED_INVOICE_MAX_LIMIT, invoiceIssuePreviewOf, issuedInvoiceOf, issuedInvoicePageOf,
} from '../runtime/invoiceIssuing.js';
import type { InvoiceIssueReadPort, IssuedInvoiceListQuery } from '../runtime/invoiceIssuing.js';
import { ISSUING_POSTAL_ADDRESS_MAX_LINES, ISSUING_SETTINGS_UPDATE_CONTRACT, ISSUING_TAX_MODES, ISSUING_TAX_RATE_MAX, issuingSettingsOf } from '../runtime/issuingSettings.js';
import type { IssuingSettingsReadPort } from '../runtime/issuingSettings.js';
import { INVOICE_DRAFT_READ_BOUNDS } from './postgresInvoiceDrafts.js';
import { authenticationFresh } from './postgresSessionStore.js';
import type { AggregateMutator, MutationAuthority, PgStatement } from './postgresTransactionalStore.js';
import type { SupervisedPgClient } from './supervisedPgClient.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);
const isRecord = (v: unknown): v is Readonly<Record<string, unknown>> => typeof v === 'object' && v !== null && !Array.isArray(v);
const hasColumns = (row: unknown, columns: readonly string[]): row is Readonly<Record<string, unknown>> => {
  if (!isRecord(row)) return false;
  const keys = Object.keys(row);
  return keys.length === columns.length && columns.every((c) => keys.includes(c));
};
/** A safe integer in [min, max]. */
const isInt = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
/** A bigint as the driver hands it: exact decimal text, never a float. */
const BIGINT_TEXT_RE = /^(0|[1-9][0-9]{0,15})$/;
const MAX = Number.MAX_SAFE_INTEGER;

// ---------------------------------------------------------------------------
// The issue's mutator
// ---------------------------------------------------------------------------

const ISSUE_COLUMNS: readonly string[] = ['o_outcome', 'o_tenant_id', 'o_store_id', 'o_actor_id', 'o_membership_id', 'o_version', 'o_invoice_id',
  'o_customer_id', 'o_number'];
/** The routine's refusals, each with every other column null; 'tenant_mismatch' is the store's 'precondition_failed'. */
const ISSUE_REFUSALS: ReadonlySet<string> = new Set(['not_found', 'invalid_state', 'conflict', 'issuing_not_configured', 'amount_out_of_range', 'refused']);

/** Whether `v` is a bigint's decimal text of a number 1..2^53 - 1. */
const isNumberText = (v: unknown): boolean => typeof v === 'string' && BIGINT_TEXT_RE.test(v) && v !== '0' && Number.isSafeInteger(Number(v)) && String(Number(v)) === v;

async function applyInvoiceIssue(sql: PgStatement, mutation: TransactionMutation, authority?: MutationAuthority): Promise<unknown> {
  const context = authority?.context ?? null;
  const sessionKey = authority?.sessionKey ?? null;
  const { aggregateId, expectedVersion, changes } = mutation;
  const { expectedTenant, expectedSettingsVersion, expectedCustomerVersion, invoiceId } = changes;
  // Never a call without the revalidated STORE context and the key that presented it, uuids, and the planner's bounds.
  if (context === null || context.scope !== 'store' || !isUuid(context.tenant) || !isUuid(context.store) || typeof sessionKey !== 'string') return 'unavailable';
  if (!isUuid(aggregateId) || !isUuid(expectedTenant) || !isUuid(invoiceId)) return 'unavailable';
  if (!isInt(expectedVersion, 1, MAX - 1) || !isInt(expectedSettingsVersion, 1, MAX) || !isInt(expectedCustomerVersion, 1, MAX)) return 'unavailable';
  const rows = await sql`select o_outcome, o_tenant_id, o_store_id, o_actor_id, o_membership_id, o_version, o_invoice_id, o_customer_id, o_number
    from tmpos_invoice_issue.m7b_invoice_issue(${sessionKey}::text, ${context.store}::uuid, ${aggregateId}::uuid, ${expectedTenant}::uuid,
      ${String(expectedVersion)}::bigint, ${String(expectedSettingsVersion)}::bigint, ${String(expectedCustomerVersion)}::bigint, ${invoiceId}::uuid)`;
  if (rows.length !== 1 || !hasColumns(rows[0], ISSUE_COLUMNS)) return 'mismatch';
  const {
    o_outcome: outcome, o_tenant_id: tenant, o_store_id: store, o_actor_id: actor, o_membership_id: membership, o_version: version,
    o_invoice_id: invoice, o_customer_id: customer, o_number: number,
  } = rows[0];
  if (outcome === 'applied') {
    const identified = tenant === context.tenant && store === context.store && actor === context.actor && membership === context.membershipId;
    // bigint arrives as its decimal text: compared exactly, never through a float.
    return identified && version === String(expectedVersion + 1) && invoice === invoiceId && isUuid(customer) && isNumberText(number)
      ? Object.freeze({ outcome: 'applied', subjectCustomerId: customer }) : 'mismatch';
  }
  // A refusal names nothing: every other column null.
  if ([tenant, store, actor, membership, version, invoice, customer, number].some((v) => v !== null)) return 'mismatch';
  if (outcome === 'tenant_mismatch') return 'precondition_failed';
  return typeof outcome === 'string' && ISSUE_REFUSALS.has(outcome) ? outcome : 'mismatch';
}

/** The mutator the tenant inventory registers for the issue (server/composition/tenantTransactions.ts). */
export const INVOICE_ISSUE_MUTATOR: AggregateMutator = Object.freeze({
  kind: INVOICE_ISSUE_CONTRACT.kind,
  mode: 'update',
  aggregateType: INVOICE_ISSUE_CONTRACT.aggregateType,
  contextScope: 'store',
  issuingRefusals: true,
  auditSubjects: 'issued_invoice',
  apply: applyInvoiceIssue,
});

// ---------------------------------------------------------------------------
// The settings write's mutator
// ---------------------------------------------------------------------------

const SET_COLUMNS: readonly string[] = ['o_outcome', 'o_tenant_id', 'o_store_id', 'o_actor_id', 'o_membership_id', 'o_version'];
const SET_REFUSALS: ReadonlySet<string> = new Set(['not_found', 'conflict', 'refused']);

/**
 * A frozen copy of plain object `v`'s own data values at exactly `keys` — each read once from its descriptor, never through a
 * getter — or null for any other shape: another prototype, a missing, extra or symbol key, or an accessor.
 */
function ownCopyOf(v: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> | null {
  if (!isRecord(v)) return null;
  const proto: unknown = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return null;
  const own = Reflect.ownKeys(v);
  if (own.length !== keys.length || !keys.every((k) => own.includes(k))) return null;
  const copy: Record<string, unknown> = {};
  for (const k of keys) {
    const d = Object.getOwnPropertyDescriptor(v, k);
    if (d === undefined || !('value' in d)) return null;
    copy[k] = d.value;
  }
  return Object.freeze(copy);
}

/** The change set's keys: exactly the contract's change schema. */
const SETTINGS_CHANGE_KEYS: readonly string[] = Object.freeze(Object.keys(ISSUING_SETTINGS_UPDATE_CONTRACT.changes));
const ADDRESS_ROW_KEYS: readonly string[] = Object.freeze(['line']);

/** The address rows — 1..8 plain { line: string } rows, each read once — as the one LF-joined text the routine stores, or null. */
function addressText(rows: unknown): string | null {
  if (!Array.isArray(rows) || Object.getPrototypeOf(rows) !== Array.prototype) return null;
  const count = rows.length; // read once: the bound checked is the bound the loop runs to
  if (count < 1 || count > ISSUING_POSTAL_ADDRESS_MAX_LINES) return null;
  const lines: string[] = [];
  for (let i = 0; i < count; i++) {
    const row = ownCopyOf(rows[i], ADDRESS_ROW_KEYS);
    if (row === null || typeof row.line !== 'string') return null;
    lines.push(row.line);
  }
  return lines.join('\n');
}

async function applyIssuingSettingsUpdate(sql: PgStatement, mutation: TransactionMutation, authority?: MutationAuthority): Promise<unknown> {
  const context = authority?.context ?? null;
  const sessionKey = authority?.sessionKey ?? null;
  const authNotAfter = authority?.authNotAfter ?? null;
  // Exactly the contract's keys, each value copied once; only the copies are judged and bound.
  const changes = ownCopyOf(mutation.changes, SETTINGS_CHANGE_KEYS);
  if (changes === null) return 'unavailable';
  const {
    storeId, expectedTenant, expectedVersion, legalName, storeName, postalAddress, hasTaxRegistrationId, taxRegistrationId, taxMode, taxRateMilliPercent,
  } = changes;
  // Never a call without the revalidated TENANT context, the key that presented it and the recent sign-in's deadline the
  // revalidator judged: the store proved all three. The planner's values are checked again for type and consistency.
  if (context === null || context.scope !== 'tenant' || !isUuid(context.tenant) || typeof sessionKey !== 'string' || !isInt(authNotAfter, 1, MAX)) return 'unavailable';
  if (!isUuid(storeId) || !isUuid(expectedTenant) || !isInt(expectedVersion, 0, MAX - 1)) return 'unavailable';
  const address = addressText(postalAddress);
  if (typeof legalName !== 'string' || typeof storeName !== 'string' || address === null || typeof hasTaxRegistrationId !== 'boolean'
    || typeof taxRegistrationId !== 'string' || hasTaxRegistrationId !== (taxRegistrationId !== '')) return 'unavailable';
  if (typeof taxMode !== 'string' || !ISSUING_TAX_MODES.includes(taxMode) || !isInt(taxRateMilliPercent, 0, ISSUING_TAX_RATE_MAX)
    || (taxMode === 'none' && taxRateMilliPercent !== 0)) return 'unavailable';
  const rows = await sql`select o_outcome, o_tenant_id, o_store_id, o_actor_id, o_membership_id, o_version
    from tmpos_invoice_issue.m7b_issuing_settings_set(${sessionKey}::text, ${storeId}::uuid, ${expectedTenant}::uuid, ${String(expectedVersion)}::bigint,
      ${legalName}::text, ${storeName}::text, ${address}::text, ${hasTaxRegistrationId ? taxRegistrationId : null}::text, ${taxMode}::text,
      ${taxMode === 'none' ? null : taxRateMilliPercent}::integer)`;
  if (rows.length !== 1 || !hasColumns(rows[0], SET_COLUMNS)) return 'mismatch';
  const { o_outcome: outcome, o_tenant_id: tenant, o_store_id: store, o_actor_id: actor, o_membership_id: membership, o_version: version } = rows[0];
  if (outcome === 'applied') {
    if (tenant !== context.tenant || store !== storeId || actor !== context.actor || membership !== context.membershipId
      || version !== String(expectedVersion + 1)) return 'mismatch';
    // The recent sign-in, judged again now that the routine's lock waits are over (header).
    return (await authenticationFresh(sql, authNotAfter)) ? 'applied' : 'refused';
  }
  // A refusal names nothing: every other column null; it wrote nothing, so it is answered as it is, stale or not.
  if (tenant !== null || store !== null || actor !== null || membership !== null || version !== null) return 'mismatch';
  if (outcome === 'tenant_mismatch') return 'precondition_failed';
  return typeof outcome === 'string' && SET_REFUSALS.has(outcome) ? outcome : 'mismatch';
}

/** The mutator the tenant inventory registers for the issuing-settings write (server/composition/tenantTransactions.ts). */
export const ISSUING_SETTINGS_UPDATE_MUTATOR: AggregateMutator = Object.freeze({
  kind: ISSUING_SETTINGS_UPDATE_CONTRACT.kind,
  mode: 'create',
  aggregateType: ISSUING_SETTINGS_UPDATE_CONTRACT.aggregateType,
  contextScope: 'tenant',
  auditSubjects: 'store',
  apply: applyIssuingSettingsUpdate,
});

// ---------------------------------------------------------------------------
// The reads
// ---------------------------------------------------------------------------

/** A session key: the SHA-256 of a session identifier, unpadded base64url (sessions.ts digestOf). */
const SESSION_KEY_RE = /^[A-Za-z0-9_-]{43}$/;

/** Every fault is the same bounded message: nothing about the row, the value or the driver. */
const fault = (): Error => new Error('invoice issuing answer invalid');

type Row = Readonly<Record<string, unknown>>;
function rowOf(value: unknown, columns: readonly string[]): Row {
  if (!hasColumns(value, columns)) throw fault();
  return value;
}
/** A bigint column's exact value within 2^53 - 1, at or above `min`; a fault otherwise. */
function amountOf(v: unknown, min: number): number {
  if (typeof v !== 'string' || !BIGINT_TEXT_RE.test(v)) throw fault();
  const n = Number(v);
  if (!Number.isSafeInteger(n) || String(n) !== v || n < min) throw fault();
  return n;
}
/** An integer column within [min, max]; a fault otherwise. */
function intOf(v: unknown, min: number, max: number): number {
  if (!isInt(v, min, max)) throw fault();
  return v;
}
/** A refusal row: the outcome alone, every other column null. */
const isRefusal = (row: Row, columns: readonly string[]): boolean => columns.every((c) => c === 'o_outcome' || row[c] === null);
/** The routine's only row, a refusal in `words`, as the port's answer; a fault otherwise. */
function refusalOf(all: readonly Row[], columns: readonly string[], words: readonly string[]): unknown {
  const first = all[0];
  if (all.length !== 1 || !isRefusal(first, columns) || typeof first.o_outcome !== 'string' || !words.includes(first.o_outcome)) throw fault();
  return Object.freeze({ outcome: first.o_outcome });
}
/** The tax columns as a tax setting (the runtime validator judges the rate's range); a fault for any other combination. */
function taxOf(mode: unknown, rate: unknown): unknown {
  if (mode === 'none' && rate === null) return Object.freeze({ mode: 'none' });
  if (mode === 'exclusive_rate' && typeof rate === 'number') return Object.freeze({ mode: 'exclusive_rate', rateMilliPercent: rate });
  throw fault();
}
/** Every row carries exactly the first row's `header` columns. */
function sameHeader(all: readonly Row[], header: readonly string[]): void {
  const first = all[0];
  if (!all.every((row) => header.every((c) => row[c] === first[c]))) throw fault();
}
/** The line columns of every row, in order: positions 1..n (the runtime checks every amount again). */
function linesOf(all: readonly Row[]): unknown[] {
  return all.map((row, i) => {
    if (row.o_position !== i + 1 || typeof row.o_description !== 'string') throw fault();
    return {
      position: i + 1, description: row.o_description, quantity: amountOf(row.o_quantity, 1), unitPriceCents: amountOf(row.o_unit_price_cents, 0),
      lineTotalCents: amountOf(row.o_line_total_cents, 0),
    };
  });
}
/** The answer, once the runtime's own validator accepts it as data (never as a refusal word); a fault otherwise. */
function accepted(answer: unknown, judged: unknown): unknown {
  if (typeof judged !== 'object' || judged === null) throw fault();
  return Object.freeze(answer);
}
/** The trusted scope a read is asked under, at `level`, or a fault: never a statement for anything else. */
function scopeAt(scope: unknown, level: 'tenant' | 'store'): TrustedScope {
  if (!isTrustedScope(scope) || scope.scope !== level || !isUuid(scope.tenant) || (level === 'store' && !isUuid(scope.store))) throw fault();
  return scope;
}
const checkKey = (sessionKey: unknown): void => { if (typeof sessionKey !== 'string' || !SESSION_KEY_RE.test(sessionKey)) throw fault(); };

const SETTINGS_COLUMNS: readonly string[] = ['o_outcome', 'o_tenant_id', 'o_store_id', 'o_version', 'o_legal_name', 'o_store_name', 'o_postal_address',
  'o_tax_registration_id', 'o_tax_mode', 'o_tax_rate'];

/** The settings routine's rows as the port's answer; a throw for anything out of shape. */
export function issuingSettingsAnswerOf(rows: unknown, scope: TrustedScope, storeId: string): unknown {
  if (!Array.isArray(rows) || rows.length !== 1) throw fault();
  const row = rowOf(rows[0], SETTINGS_COLUMNS);
  if (row.o_outcome === 'denied' || row.o_outcome === 'not_found') return refusalOf([row], SETTINGS_COLUMNS, ['denied', 'not_found']);
  if (row.o_tenant_id !== scope.tenant || row.o_store_id !== storeId) throw fault();
  let answer: unknown;
  if (row.o_outcome === 'none') {
    // No settings: version 0 and nothing else.
    if (row.o_version !== '0' || SETTINGS_COLUMNS.slice(4).some((c) => row[c] !== null)) throw fault();
    answer = { outcome: 'settings', issuingSettings: { storeId, version: 0, configured: false } };
  } else if (row.o_outcome === 'settings') {
    answer = {
      outcome: 'settings',
      issuingSettings: {
        storeId, version: amountOf(row.o_version, 1), configured: true, legalName: row.o_legal_name, storeName: row.o_store_name,
        postalAddress: row.o_postal_address, taxRegistrationId: row.o_tax_registration_id, tax: taxOf(row.o_tax_mode, row.o_tax_rate),
      },
    };
  } else {
    throw fault();
  }
  return accepted(answer, issuingSettingsOf(answer, storeId));
}

const LINE_COLUMNS: readonly string[] = ['o_position', 'o_description', 'o_quantity', 'o_unit_price_cents', 'o_line_total_cents'];
const PREVIEW_HEADER: readonly string[] = ['o_outcome', 'o_tenant_id', 'o_store_id', 'o_draft_id', 'o_draft_version', 'o_customer_id', 'o_customer_name',
  'o_customer_version', 'o_settings_version', 'o_legal_name', 'o_store_name', 'o_postal_address', 'o_tax_registration_id', 'o_tax_mode', 'o_tax_rate',
  'o_currency', 'o_line_count', 'o_subtotal_cents', 'o_tax_cents', 'o_total_cents'];
const PREVIEW_COLUMNS: readonly string[] = [...PREVIEW_HEADER, ...LINE_COLUMNS];
const PREVIEW_REFUSALS: readonly string[] = ['denied', 'not_found', 'invalid_state', 'issuing_not_configured', 'amount_out_of_range'];

/** The preview routine's rows as the port's answer; a throw for anything out of shape. */
export function invoiceIssuePreviewAnswerOf(rows: unknown, scope: TrustedScope, draftId: string): unknown {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > INVOICE_DRAFT_MAX_LINES) throw fault();
  const all = rows.map((row) => rowOf(row, PREVIEW_COLUMNS));
  const first = all[0];
  if (first.o_outcome !== 'line') return refusalOf(all, PREVIEW_COLUMNS, PREVIEW_REFUSALS);
  if (first.o_tenant_id !== scope.tenant || first.o_store_id !== scope.store || first.o_draft_id !== draftId) throw fault();
  sameHeader(all, PREVIEW_HEADER);
  if (intOf(first.o_line_count, 1, INVOICE_DRAFT_MAX_LINES) !== all.length) throw fault();
  const answer = {
    outcome: 'preview',
    preview: {
      draft: { id: draftId, version: amountOf(first.o_draft_version, 1), subtotalCents: amountOf(first.o_subtotal_cents, 0), lines: linesOf(all) },
      customer: { id: first.o_customer_id, name: first.o_customer_name, version: amountOf(first.o_customer_version, 1) },
      issuingSettings: {
        version: amountOf(first.o_settings_version, 1), legalName: first.o_legal_name, storeName: first.o_store_name, postalAddress: first.o_postal_address,
        taxRegistrationId: first.o_tax_registration_id, tax: taxOf(first.o_tax_mode, first.o_tax_rate),
      },
      currency: first.o_currency,
      taxCents: first.o_tax_cents === null ? null : amountOf(first.o_tax_cents, 0),
      totalCents: amountOf(first.o_total_cents, 0),
    },
  };
  return accepted(answer, invoiceIssuePreviewOf(answer, draftId));
}

/** 034's page columns, then (M7B-INVOICES-VOID-P1) 035's v2 lifecycle column. */
const PAGE_COLUMNS: readonly string[] = ['o_outcome', 'o_tenant_id', 'o_store_id', 'o_invoice_id', 'o_number', 'o_source_draft_id', 'o_customer_id',
  'o_customer_name', 'o_currency', 'o_total_cents', 'o_issued_at', 'o_snapshot_version', 'o_status'];

const PAGE_QUERY_KEYS: readonly string[] = Object.freeze(['after', 'sourceDraft', 'limit']);

/** The page routine's rows as the port's answer (the route asked limit + 1 rows); a throw for anything out of shape. */
export function issuedInvoicePageAnswerOf(rows: unknown, scope: TrustedScope, query: IssuedInvoiceListQuery): unknown {
  // The bound is checked before any row is read, so an oversized answer costs nothing to refuse.
  if (!Array.isArray(rows) || rows.length > query.limit + 1) throw fault();
  const all = rows.map((row) => rowOf(row, PAGE_COLUMNS));
  const first = all[0];
  if (first !== undefined && first.o_outcome !== 'invoice') {
    // A refusal is the routine's only row; 'cursor_unknown' only for a continuation.
    return refusalOf(all, PAGE_COLUMNS, query.after !== null ? ['denied', 'cursor_unknown'] : ['denied']);
  }
  const invoices = all.map((row) => {
    if (row.o_outcome !== 'invoice' || row.o_tenant_id !== scope.tenant || row.o_store_id !== scope.store) throw fault();
    return {
      id: row.o_invoice_id, number: amountOf(row.o_number, 1), sourceDraftId: row.o_source_draft_id, customerId: row.o_customer_id,
      customerName: row.o_customer_name, currency: row.o_currency, totalCents: amountOf(row.o_total_cents, 0), issuedAt: row.o_issued_at,
      snapshotVersion: row.o_snapshot_version, status: row.o_status,
    };
  });
  const hasMore = invoices.length > query.limit;
  // The look-ahead row is judged too: the whole answer, ordered and unique, as one page of limit + 1.
  if (issuedInvoicePageOf({ outcome: 'page', invoices, hasMore: false }, { ...query, limit: query.limit + 1 }) === null) throw fault();
  const answer = { outcome: 'page', invoices: hasMore ? invoices.slice(0, query.limit) : invoices, hasMore };
  return accepted(answer, issuedInvoicePageOf(answer, query));
}

const GET_HEADER: readonly string[] = ['o_outcome', 'o_tenant_id', 'o_store_id', 'o_invoice_id', 'o_number', 'o_snapshot_version', 'o_issued_at',
  'o_source_draft_id', 'o_source_draft_version', 'o_settings_version', 'o_legal_name', 'o_store_name', 'o_postal_address', 'o_tax_registration_id',
  'o_customer_id', 'o_customer_name', 'o_customer_version', 'o_currency', 'o_line_count', 'o_subtotal_cents', 'o_tax_mode', 'o_tax_rate', 'o_tax_cents',
  'o_total_cents'];
/** 035's v2 lifecycle columns (M7B-INVOICES-VOID-P1), after 034's: the same three values on every line row. */
const GET_LIFECYCLE: readonly string[] = ['o_status', 'o_voided_at', 'o_reason_code'];
const GET_COLUMNS: readonly string[] = [...GET_HEADER, ...LINE_COLUMNS, ...GET_LIFECYCLE];

/** The get routine's rows as the port's answer; a throw for anything out of shape. */
export function issuedInvoiceAnswerOf(rows: unknown, scope: TrustedScope, invoiceId: string): unknown {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > INVOICE_DRAFT_MAX_LINES) throw fault();
  const all = rows.map((row) => rowOf(row, GET_COLUMNS));
  const first = all[0];
  if (first.o_outcome !== 'line') return refusalOf(all, GET_COLUMNS, ['denied', 'not_found']);
  if (first.o_tenant_id !== scope.tenant || first.o_store_id !== scope.store || first.o_invoice_id !== invoiceId) throw fault();
  // The lifecycle is the invoice's, not a line's: one value on every row (M7B-INVOICES-VOID-P1).
  sameHeader(all, [...GET_HEADER, ...GET_LIFECYCLE]);
  if (intOf(first.o_line_count, 1, INVOICE_DRAFT_MAX_LINES) !== all.length) throw fault();
  const answer = {
    outcome: 'invoice',
    invoice: {
      id: invoiceId, number: amountOf(first.o_number, 1), snapshotVersion: first.o_snapshot_version, issuedAt: first.o_issued_at,
      sourceDraft: { id: first.o_source_draft_id, version: amountOf(first.o_source_draft_version, 1) },
      seller: {
        legalName: first.o_legal_name, storeName: first.o_store_name, postalAddress: first.o_postal_address, taxRegistrationId: first.o_tax_registration_id,
      },
      issuingSettingsVersion: amountOf(first.o_settings_version, 1),
      customer: { id: first.o_customer_id, name: first.o_customer_name, version: amountOf(first.o_customer_version, 1) },
      currency: first.o_currency,
      subtotalCents: amountOf(first.o_subtotal_cents, 0),
      tax: taxOf(first.o_tax_mode, first.o_tax_rate),
      taxCents: first.o_tax_cents === null ? null : amountOf(first.o_tax_cents, 0),
      totalCents: amountOf(first.o_total_cents, 0),
      lines: linesOf(all),
      status: first.o_status,
      voidedAt: first.o_voided_at,
      reasonCode: first.o_reason_code,
    },
  };
  return accepted(answer, issuedInvoiceOf(answer, invoiceId));
}

/** The production settings read over the M6 runtime client the composition root already built. */
export function createPostgresIssuingSettings(deps: { readonly client: SupervisedPgClient }): IssuingSettingsReadPort {
  const { client } = deps;
  return Object.freeze({
    async settings(rawScope: TrustedScope, sessionKey: string, storeId: string, signal: AbortSignal): Promise<unknown> {
      // Refused before a statement runs: only the trusted tenant scope, a key of the store-key shape and a uuid store.
      const scope = scopeAt(rawScope, 'tenant');
      checkKey(sessionKey);
      if (!isUuid(storeId)) throw fault();
      return client.transaction(signal, INVOICE_DRAFT_READ_BOUNDS, async (sql) => issuingSettingsAnswerOf(
        await sql`select o_outcome, o_tenant_id, o_store_id, o_version, o_legal_name, o_store_name, o_postal_address, o_tax_registration_id, o_tax_mode, o_tax_rate
          from tmpos_invoice_issue.m7b_issuing_settings_get(${sessionKey}::text, ${scope.tenant}::uuid, ${storeId}::uuid)`,
        scope, storeId,
      ));
    },
  });
}

/** The production preview and issued reads over the M6 runtime client the composition root already built. */
export function createPostgresInvoiceIssuing(deps: { readonly client: SupervisedPgClient }): InvoiceIssueReadPort {
  const { client } = deps;
  return Object.freeze({
    async preview(rawScope: TrustedScope, sessionKey: string, draftId: string, signal: AbortSignal): Promise<unknown> {
      const scope = scopeAt(rawScope, 'store');
      checkKey(sessionKey);
      if (!isUuid(draftId)) throw fault();
      return client.transaction(signal, INVOICE_DRAFT_READ_BOUNDS, async (sql) => invoiceIssuePreviewAnswerOf(
        await sql`select o_outcome, o_tenant_id, o_store_id, o_draft_id, o_draft_version, o_customer_id, o_customer_name, o_customer_version,
            o_settings_version, o_legal_name, o_store_name, o_postal_address, o_tax_registration_id, o_tax_mode, o_tax_rate, o_currency, o_line_count,
            o_subtotal_cents, o_tax_cents, o_total_cents, o_position, o_description, o_quantity, o_unit_price_cents, o_line_total_cents
          from tmpos_invoice_issue.m7b_invoice_issue_preview(${sessionKey}::text, ${scope.tenant}::uuid, ${scope.store}::uuid, ${draftId}::uuid)`,
        scope, draftId,
      ));
    },
    async page(rawScope: TrustedScope, sessionKey: string, rawQuery: IssuedInvoiceListQuery, signal: AbortSignal): Promise<unknown> {
      const scope = scopeAt(rawScope, 'store');
      checkKey(sessionKey);
      // Exactly the three keys, copied once; only the copies are judged, bound and used to judge the answer.
      const copy = ownCopyOf(rawQuery, PAGE_QUERY_KEYS);
      if (copy === null) throw fault();
      const { limit, after, sourceDraft } = copy;
      if (!isInt(limit, 1, ISSUED_INVOICE_MAX_LIMIT) || (after !== null && !isUuid(after)) || (sourceDraft !== null && !isUuid(sourceDraft))
        || (sourceDraft !== null && (after !== null || limit !== 1))) throw fault();
      // Each is null or a uuid, proved just above.
      const query: IssuedInvoiceListQuery = Object.freeze({ after: after as string | null, sourceDraft: sourceDraft as string | null, limit });
      return client.transaction(signal, INVOICE_DRAFT_READ_BOUNDS, async (sql) => issuedInvoicePageAnswerOf(
        await sql`select o_outcome, o_tenant_id, o_store_id, o_invoice_id, o_number, o_source_draft_id, o_customer_id, o_customer_name, o_currency,
            o_total_cents, o_issued_at, o_snapshot_version, o_status
          from tmpos_invoice_void.m7b_issued_invoice_page_v2(${sessionKey}::text, ${scope.tenant}::uuid, ${scope.store}::uuid, ${after}::uuid,
            ${sourceDraft}::uuid, ${limit + 1}::integer)`,
        scope, query,
      ));
    },
    async invoice(rawScope: TrustedScope, sessionKey: string, invoiceId: string, signal: AbortSignal): Promise<unknown> {
      const scope = scopeAt(rawScope, 'store');
      checkKey(sessionKey);
      if (!isUuid(invoiceId)) throw fault();
      return client.transaction(signal, INVOICE_DRAFT_READ_BOUNDS, async (sql) => issuedInvoiceAnswerOf(
        await sql`select o_outcome, o_tenant_id, o_store_id, o_invoice_id, o_number, o_snapshot_version, o_issued_at, o_source_draft_id,
            o_source_draft_version, o_settings_version, o_legal_name, o_store_name, o_postal_address, o_tax_registration_id, o_customer_id,
            o_customer_name, o_customer_version, o_currency, o_line_count, o_subtotal_cents, o_tax_mode, o_tax_rate, o_tax_cents, o_total_cents,
            o_position, o_description, o_quantity, o_unit_price_cents, o_line_total_cents, o_status, o_voided_at, o_reason_code
          from tmpos_invoice_void.m7b_issued_invoice_get_v2(${sessionKey}::text, ${scope.tenant}::uuid, ${scope.store}::uuid, ${invoiceId}::uuid)`,
        scope, invoiceId,
      ));
    },
  });
}

/** Whether `rows` is exactly one 'denied' row of `columns`, every other column null. */
const deniedOnly = (rows: unknown, columns: readonly string[]): boolean =>
  Array.isArray(rows) && rows.length === 1 && hasColumns(rows[0], columns) && rows[0].o_outcome === 'denied' && isRefusal(rows[0], columns);

/**
 * Readiness: true only for each of the four reads' one refusal of a random key no session holds — 034's settings read and
 * preview, 035's v2 page and get (M7B-INVOICES-VOID-P1) — in that order; anything else is false.
 */
export async function probeInvoiceIssuing(client: SupervisedPgClient, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false;
  const absentKey = randomBytes(32).toString('base64url');
  const [tenant, store, id] = [randomUUID(), randomUUID(), randomUUID()];
  try {
    return await client.transaction(signal, INVOICE_DRAFT_READ_BOUNDS, async (sql) => {
      const settings = await sql`select o_outcome, o_tenant_id, o_store_id, o_version, o_legal_name, o_store_name, o_postal_address, o_tax_registration_id, o_tax_mode, o_tax_rate
        from tmpos_invoice_issue.m7b_issuing_settings_get(${absentKey}::text, ${tenant}::uuid, ${store}::uuid)`;
      if (!deniedOnly(settings, SETTINGS_COLUMNS)) return false;
      const preview = await sql`select o_outcome, o_tenant_id, o_store_id, o_draft_id, o_draft_version, o_customer_id, o_customer_name, o_customer_version,
          o_settings_version, o_legal_name, o_store_name, o_postal_address, o_tax_registration_id, o_tax_mode, o_tax_rate, o_currency, o_line_count,
          o_subtotal_cents, o_tax_cents, o_total_cents, o_position, o_description, o_quantity, o_unit_price_cents, o_line_total_cents
        from tmpos_invoice_issue.m7b_invoice_issue_preview(${absentKey}::text, ${tenant}::uuid, ${store}::uuid, ${id}::uuid)`;
      if (!deniedOnly(preview, PREVIEW_COLUMNS)) return false;
      const page = await sql`select o_outcome, o_tenant_id, o_store_id, o_invoice_id, o_number, o_source_draft_id, o_customer_id, o_customer_name, o_currency,
          o_total_cents, o_issued_at, o_snapshot_version, o_status
        from tmpos_invoice_void.m7b_issued_invoice_page_v2(${absentKey}::text, ${tenant}::uuid, ${store}::uuid, ${null}::uuid, ${null}::uuid, ${1}::integer)`;
      if (!deniedOnly(page, PAGE_COLUMNS)) return false;
      const got = await sql`select o_outcome, o_tenant_id, o_store_id, o_invoice_id, o_number, o_snapshot_version, o_issued_at, o_source_draft_id,
          o_source_draft_version, o_settings_version, o_legal_name, o_store_name, o_postal_address, o_tax_registration_id, o_customer_id,
          o_customer_name, o_customer_version, o_currency, o_line_count, o_subtotal_cents, o_tax_mode, o_tax_rate, o_tax_cents, o_total_cents,
          o_position, o_description, o_quantity, o_unit_price_cents, o_line_total_cents, o_status, o_voided_at, o_reason_code
        from tmpos_invoice_void.m7b_issued_invoice_get_v2(${absentKey}::text, ${tenant}::uuid, ${store}::uuid, ${id}::uuid)`;
      return deniedOnly(got, GET_COLUMNS);
    });
  } catch {
    return false; // an outage, an abort, an overrun, a driver fault or a row out of shape: nothing is disclosed
  }
}

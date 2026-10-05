// Phase 4.0 M7b — the PostgreSQL side of store-owned invoice drafts: the save's mutator and the two reads' production
// adapter (server/runtime/invoiceDrafts.ts), each one fixed call into migration 028's session-bound routines
// (M7B-INVOICES-P1; G-IAM, G-ISOLATION, G-PERSIST).
//
// THE MUTATOR (INVOICE_DRAFT_CREATE_MUTATOR, context scope 'store'). The one business mutation the tenant store commits for
// POST /api/v1/stores/{storeId}/invoice-drafts, handed to the store in trusted source by the tenant transaction root alone.
// It runs inside the command's transaction, after the idempotency fence and the store-scope revalidation
// (tenantAuthorization.ts createTenantContextRevalidator), and before the audit record, the outbox event and the completion
// (postgresTransactionalStore.ts commit): the store owns that order, this file owns one statement —
// tmpos_invoice_draft.m7b_invoice_draft_create. Its ONE authority input is the presenting session's key, handed here as
// `authority.sessionKey`; p_store_id is bound from the REVALIDATED trusted store (`authority.context.store`), never from the
// change set or the request target — the change set's storeId (the path's) must merely EQUAL it, so the Location the plan
// built names the store the draft is saved at. The expected tenant and the customer come from the change set (both judged
// by the planner and again by the routine); the lines are bound as ONE jsonb text of exactly { description, quantity,
// unitPriceCents } objects (bound as text and cast in the statement, so the driver never re-serializes it as a JSON string),
// re-validated element by element by the routine; the subtotal is the planner's BigInt sum, which
// the routine requires to equal its own numeric sum. Every value is a bound parameter; no table is named here.
//
// ITS ANSWERS. The routine answers one row. 'applied' only when it names exactly the tenant, the store, the actor and the
// grant this transaction revalidated — so every identity the audit record carries is the one the database derived — else
// 'mismatch'. 'tenant_mismatch' (the expected tenant is not the store's) is 'precondition_failed': rolled back, the unsealed
// 409. 'customer_not_found' (missing, or another tenant's — one answer) passes through: the routine decided it before
// writing anything, and the store records the command's sealed 422 as the completion. 'refused' (the session's authority,
// the store grant or a level no longer holds) passes through and rolls everything back — the NULL role rows included — as
// the generic 503 (DA-70). A raise (a reused id, a value a CHECK refuses, a malformed argument, an isolation other than READ
// COMMITTED) is not caught: the kernel rolls back, a 503, and a retry re-plans. No row, value or driver message is logged.
//
// THE READS (createPostgresInvoiceDrafts). page and get each run ONE statement on the kernel's client, in one short
// transaction: the routine is handed the session key and the TRUSTED scope's tenant and store as its expected ones (never
// anything the request carried beyond a validated anchor id, draft id and page size). Every row is untrusted: a refusal must
// be the routine's only row with every other column null; every other row must name exactly the trusted tenant and store —
// any mismatch is a fault — and carry well-formed values (canonical ids, status 'draft', 'USD', version 1, a microsecond UTC
// creation time, bigint amounts as exact decimal text within 2^53 - 1, ordered rows). Anything else — more rows than asked,
// an 'invalid' answer (every argument was checked first, so it is a fault), an abort, a timeout, a lost connection, a driver
// error — is a THROW, an outage the route answers as a bounded 503, never a refusal. The route validates the answer again.
//
// READINESS (probeInvoiceDrafts, chained into the tenant reads' probe). It asks both reads for a random key no session holds
// and requires each one's single 'denied' row with every other column null: the login's EXECUTE and USAGE answer.
//
// IT CONSTRUCTS NOTHING AND READS NOTHING at import: the caller hands it the kernel the composition root already built.
import { randomBytes, randomUUID } from 'node:crypto';
import { isTrustedScope } from '../runtime/principals.js';
import type { TrustedScope } from '../runtime/principals.js';
import type { TransactionMutation } from '../runtime/commandTransaction.js';
import {
  INVOICE_DRAFT_CREATE_CONTRACT, INVOICE_DRAFT_CURRENCY, INVOICE_DRAFT_MAX_LIMIT, INVOICE_DRAFT_MAX_LINES, INVOICE_DRAFT_STATUS,
  inInvoiceDraftOrder, isDraftCreatedAt, normalizeDraftDescription,
} from '../runtime/invoiceDrafts.js';
import type { InvoiceDraftListQuery, InvoiceDraftReadPort } from '../runtime/invoiceDrafts.js';
import type { AggregateMutator, MutationAuthority, PgStatement } from './postgresTransactionalStore.js';
import type { SupervisedPgClient, TransactionBounds } from './supervisedPgClient.js';

// ---------------------------------------------------------------------------
// The mutator
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);
const isRecord = (v: unknown): v is Readonly<Record<string, unknown>> => typeof v === 'object' && v !== null && !Array.isArray(v);
const CREATE_COLUMNS: readonly string[] = ['o_outcome', 'o_tenant_id', 'o_store_id', 'o_actor_id', 'o_membership_id'];
const hasColumns = (row: unknown, columns: readonly string[]): row is Readonly<Record<string, unknown>> => {
  if (!isRecord(row)) return false;
  const keys = Object.keys(row);
  return keys.length === columns.length && columns.every((c) => keys.includes(c));
};

/** The lines as the ONE jsonb text the routine re-validates: exactly the three keys of each row, in order. */
function linesText(lines: unknown): string | null {
  if (!Array.isArray(lines) || lines.length < 1 || lines.length > INVOICE_DRAFT_MAX_LINES) return null;
  const out: { description: string; quantity: number; unitPriceCents: number }[] = [];
  for (const line of lines) {
    if (!isRecord(line)) return null;
    const { description, quantity, unitPriceCents } = line;
    if (typeof description !== 'string' || typeof quantity !== 'number' || typeof unitPriceCents !== 'number') return null;
    out.push({ description, quantity, unitPriceCents });
  }
  return JSON.stringify(out);
}

async function applyInvoiceDraftCreate(sql: PgStatement, mutation: TransactionMutation, authority?: MutationAuthority): Promise<string> {
  const context = authority?.context ?? null;
  const sessionKey = authority?.sessionKey ?? null;
  const { storeId, expectedTenant, customerId, subtotalCents, lines } = mutation.changes;
  // Never a call without the revalidated STORE context and the key that presented it: the store proved both. The path's
  // store must be the revalidated one, or the plan's Location would name another store.
  if (context === null || context.scope !== 'store' || context.tenant === null || context.store === null || typeof sessionKey !== 'string') return 'unavailable';
  if (storeId !== context.store || !isUuid(expectedTenant) || !isUuid(customerId) || typeof subtotalCents !== 'number') return 'unavailable';
  const text = linesText(lines);
  if (text === null) return 'unavailable';
  const rows = await sql`select o_outcome, o_tenant_id, o_store_id, o_actor_id, o_membership_id
    from tmpos_invoice_draft.m7b_invoice_draft_create(${sessionKey}::text, ${context.store}::uuid, ${mutation.aggregateId}::uuid,
      ${expectedTenant}::uuid, ${customerId}::uuid, ${text}::text::jsonb, ${String(subtotalCents)}::bigint)`;
  if (rows.length !== 1 || !hasColumns(rows[0], CREATE_COLUMNS)) return 'mismatch';
  const { o_outcome: outcome, o_tenant_id: tenant, o_store_id: store, o_actor_id: actor, o_membership_id: membership } = rows[0];
  if (outcome === 'applied') {
    return tenant === context.tenant && store === context.store && actor === context.actor && membership === context.membershipId ? 'applied' : 'mismatch';
  }
  // A refusal names nothing: every other column null.
  if (tenant !== null || store !== null || actor !== null || membership !== null) return 'mismatch';
  if (outcome === 'tenant_mismatch') return 'precondition_failed';
  if (outcome === 'customer_not_found' || outcome === 'refused') return outcome;
  return 'mismatch';
}

/** The mutator the tenant inventory registers for the draft save (server/composition/tenantTransactions.ts). */
export const INVOICE_DRAFT_CREATE_MUTATOR: AggregateMutator = Object.freeze({
  kind: INVOICE_DRAFT_CREATE_CONTRACT.kind,
  mode: 'create',
  aggregateType: INVOICE_DRAFT_CREATE_CONTRACT.aggregateType,
  contextScope: 'store',
  apply: applyInvoiceDraftCreate,
});

// ---------------------------------------------------------------------------
// The reads
// ---------------------------------------------------------------------------

/** One short read, cancelled by PostgreSQL itself if it overruns, like the other runtime reads. */
export const INVOICE_DRAFT_READ_DEADLINE_MS = 3_000;
export const INVOICE_DRAFT_READ_BOUNDS: TransactionBounds = Object.freeze({
  lock: `${Math.floor(INVOICE_DRAFT_READ_DEADLINE_MS * 0.7)}ms`,
  statement: `${Math.floor(INVOICE_DRAFT_READ_DEADLINE_MS * 0.9)}ms`,
  idle: `${INVOICE_DRAFT_READ_DEADLINE_MS * 2}ms`,
});

const PAGE_COLUMNS: readonly string[] = ['o_outcome', 'o_tenant_id', 'o_store_id', 'o_draft_id', 'o_customer_id', 'o_status', 'o_currency',
  'o_line_count', 'o_subtotal_cents', 'o_created_at'];
const GET_COLUMNS: readonly string[] = ['o_outcome', 'o_tenant_id', 'o_store_id', 'o_draft_id', 'o_customer_id', 'o_status', 'o_currency',
  'o_version', 'o_created_at', 'o_line_count', 'o_subtotal_cents', 'o_position', 'o_description', 'o_quantity', 'o_unit_price_cents',
  'o_line_total_cents'];
/** A session key: the SHA-256 of a session identifier, unpadded base64url (sessions.ts digestOf). */
const SESSION_KEY_RE = /^[A-Za-z0-9_-]{43}$/;
/** A bigint as the driver hands it: exact decimal text, never a float. */
const BIGINT_TEXT_RE = /^(0|[1-9][0-9]{0,15})$/;

/** Every fault is the same bounded message: nothing about the row, the value or the driver. */
const fault = (): Error => new Error('invoice draft answer invalid');

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
/** An integer column (1-50). */
function countOf(v: unknown): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1 || v > INVOICE_DRAFT_MAX_LINES) throw fault();
  return v;
}
/** A refusal row: the outcome alone, every other column null. */
function isRefusal(row: Row, columns: readonly string[]): boolean {
  return columns.every((c) => c === 'o_outcome' || row[c] === null);
}
/** The trusted STORE scope a read is asked under, or a fault: never a statement for anything else. */
function storeScopeOf(scope: unknown): TrustedScope {
  if (!isTrustedScope(scope) || scope.scope !== 'store' || !isUuid(scope.tenant) || !isUuid(scope.store)) throw fault();
  return scope;
}

/** The page routine's rows as the port's answer (the route asked limit + 1 rows); a throw for anything out of shape. */
export function invoiceDraftPageAnswerOf(rows: unknown, scope: TrustedScope, query: InvoiceDraftListQuery): unknown {
  // The bound is checked before any row is read, so an oversized answer costs nothing to refuse.
  if (!Array.isArray(rows) || rows.length > query.limit + 1) throw fault();
  const all = rows.map((row) => rowOf(row, PAGE_COLUMNS));
  const first = all[0];
  if (first !== undefined && first.o_outcome !== 'draft') {
    // A refusal is the routine's only row; only 'denied' and (for a continuation) 'cursor_unknown' are answers.
    if (all.length !== 1 || !isRefusal(first, PAGE_COLUMNS)) throw fault();
    if (first.o_outcome === 'denied') return Object.freeze({ outcome: 'denied' });
    if (first.o_outcome === 'cursor_unknown' && query.after !== null) return Object.freeze({ outcome: 'cursor_unknown' });
    throw fault();
  }
  const drafts = all.map((row) => {
    if (row.o_outcome !== 'draft' || row.o_tenant_id !== scope.tenant || row.o_store_id !== scope.store) throw fault();
    const { o_draft_id: id, o_customer_id: customerId, o_status: status, o_currency: currency, o_created_at: createdAt } = row;
    if (!isUuid(id) || !isUuid(customerId) || status !== INVOICE_DRAFT_STATUS || currency !== INVOICE_DRAFT_CURRENCY || !isDraftCreatedAt(createdAt)) throw fault();
    return Object.freeze({
      id, customerId, status, currency, lineCount: countOf(row.o_line_count), subtotalCents: amountOf(row.o_subtotal_cents, 0), createdAt,
    });
  });
  if (new Set(drafts.map((d) => d.id)).size !== drafts.length || drafts.some((d) => d.id === query.after) || !inInvoiceDraftOrder(drafts)) throw fault();
  const hasMore = drafts.length > query.limit;
  return Object.freeze({ outcome: 'page', drafts: Object.freeze(hasMore ? drafts.slice(0, query.limit) : drafts), hasMore });
}

/** The get routine's rows as the port's answer; a throw for anything out of shape. */
export function invoiceDraftAnswerOf(rows: unknown, scope: TrustedScope, draftId: string): unknown {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > INVOICE_DRAFT_MAX_LINES) throw fault();
  const all = rows.map((row) => rowOf(row, GET_COLUMNS));
  const first = all[0];
  if (first.o_outcome !== 'draft') {
    if (all.length !== 1 || !isRefusal(first, GET_COLUMNS)) throw fault();
    if (first.o_outcome === 'denied' || first.o_outcome === 'not_found') return Object.freeze({ outcome: first.o_outcome });
    throw fault();
  }
  // The header, from the first row; every row must carry exactly it, in exactly the trusted tenant and store.
  const header = ['o_outcome', 'o_tenant_id', 'o_store_id', 'o_draft_id', 'o_customer_id', 'o_status', 'o_currency', 'o_version', 'o_created_at',
    'o_line_count', 'o_subtotal_cents'];
  if (first.o_tenant_id !== scope.tenant || first.o_store_id !== scope.store || first.o_draft_id !== draftId) throw fault();
  if (!all.every((row) => header.every((c) => row[c] === first[c]))) throw fault();
  const { o_customer_id: customerId, o_status: status, o_currency: currency, o_created_at: createdAt } = first;
  if (!isUuid(customerId) || status !== INVOICE_DRAFT_STATUS || currency !== INVOICE_DRAFT_CURRENCY || !isDraftCreatedAt(createdAt)) throw fault();
  if (amountOf(first.o_version, 1) !== 1) throw fault();
  const lineCount = countOf(first.o_line_count);
  const subtotalCents = amountOf(first.o_subtotal_cents, 0);
  if (all.length !== lineCount) throw fault();
  let sum = 0n;
  const lines = all.map((row, i) => {
    const { o_position: position, o_description: description } = row;
    if (position !== i + 1 || typeof description !== 'string' || normalizeDraftDescription(description) !== description) throw fault();
    const quantity = amountOf(row.o_quantity, 1);
    const unitPriceCents = amountOf(row.o_unit_price_cents, 0);
    const lineTotalCents = amountOf(row.o_line_total_cents, 0);
    if (BigInt(quantity) * BigInt(unitPriceCents) !== BigInt(lineTotalCents)) throw fault();
    sum += BigInt(lineTotalCents);
    return Object.freeze({ position, description, quantity, unitPriceCents, lineTotalCents });
  });
  if (sum !== BigInt(subtotalCents)) throw fault();
  return Object.freeze({
    outcome: 'draft',
    draft: Object.freeze({
      id: draftId, storeId: scope.store, customerId, status, currency, version: 1, createdAt, subtotalCents, lines: Object.freeze(lines),
    }),
  });
}

/**
 * The production reads over the M6 runtime client. `client` is the kernel the composition root already built — one
 * client, one credential, one governed endpoint.
 */
export function createPostgresInvoiceDrafts(deps: { readonly client: SupervisedPgClient }): InvoiceDraftReadPort {
  const { client } = deps;
  return Object.freeze({
    async page(rawScope: TrustedScope, sessionKey: string, query: InvoiceDraftListQuery, signal: AbortSignal): Promise<unknown> {
      // Refused before a statement runs: only the trusted store scope, a key of the store-key shape and a validated query.
      const scope = storeScopeOf(rawScope);
      if (typeof sessionKey !== 'string' || !SESSION_KEY_RE.test(sessionKey)) throw fault();
      if (!isRecord(query) || !Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > INVOICE_DRAFT_MAX_LIMIT
        || (query.after !== null && !isUuid(query.after))) throw fault();
      const { limit, after } = query;
      return client.transaction(signal, INVOICE_DRAFT_READ_BOUNDS, async (sql) => invoiceDraftPageAnswerOf(
        await sql`select o_outcome, o_tenant_id, o_store_id, o_draft_id, o_customer_id, o_status, o_currency, o_line_count, o_subtotal_cents, o_created_at
          from tmpos_invoice_draft.m7b_invoice_draft_page(${sessionKey}::text, ${scope.tenant}::uuid, ${scope.store}::uuid, ${after}::uuid,
            ${limit + 1}::integer)`,
        scope, query,
      ));
    },
    async get(rawScope: TrustedScope, sessionKey: string, draftId: string, signal: AbortSignal): Promise<unknown> {
      const scope = storeScopeOf(rawScope);
      if (typeof sessionKey !== 'string' || !SESSION_KEY_RE.test(sessionKey) || !isUuid(draftId)) throw fault();
      return client.transaction(signal, INVOICE_DRAFT_READ_BOUNDS, async (sql) => invoiceDraftAnswerOf(
        await sql`select o_outcome, o_tenant_id, o_store_id, o_draft_id, o_customer_id, o_status, o_currency, o_version, o_created_at,
            o_line_count, o_subtotal_cents, o_position, o_description, o_quantity, o_unit_price_cents, o_line_total_cents
          from tmpos_invoice_draft.m7b_invoice_draft_get(${sessionKey}::text, ${scope.tenant}::uuid, ${scope.store}::uuid, ${draftId}::uuid)`,
        scope, draftId,
      ));
    },
  });
}

/** Readiness: true only for each read's one refusal of a random key no session holds; anything else is false. */
export async function probeInvoiceDrafts(client: SupervisedPgClient, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false;
  const absentKey = randomBytes(32).toString('base64url');
  const [tenant, store, draft] = [randomUUID(), randomUUID(), randomUUID()];
  try {
    return await client.transaction(signal, INVOICE_DRAFT_READ_BOUNDS, async (sql) => {
      const page = await sql`select o_outcome, o_tenant_id, o_store_id, o_draft_id, o_customer_id, o_status, o_currency, o_line_count, o_subtotal_cents, o_created_at
        from tmpos_invoice_draft.m7b_invoice_draft_page(${absentKey}::text, ${tenant}::uuid, ${store}::uuid, ${null}::uuid, ${1}::integer)`;
      if (!Array.isArray(page) || page.length !== 1 || !hasColumns(page[0], PAGE_COLUMNS) || page[0].o_outcome !== 'denied' || !isRefusal(page[0], PAGE_COLUMNS)) return false;
      const got = await sql`select o_outcome, o_tenant_id, o_store_id, o_draft_id, o_customer_id, o_status, o_currency, o_version, o_created_at,
          o_line_count, o_subtotal_cents, o_position, o_description, o_quantity, o_unit_price_cents, o_line_total_cents
        from tmpos_invoice_draft.m7b_invoice_draft_get(${absentKey}::text, ${tenant}::uuid, ${store}::uuid, ${draft}::uuid)`;
      return Array.isArray(got) && got.length === 1 && hasColumns(got[0], GET_COLUMNS) && got[0].o_outcome === 'denied' && isRefusal(got[0], GET_COLUMNS);
    });
  } catch {
    return false; // an outage, an abort, an overrun, a driver fault or a row out of shape: nothing is disclosed
  }
}

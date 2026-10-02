// Phase 4.0 M7a — the PostgreSQL customer directory: the production adapter behind the tenant customer directory's port
// (server/runtime/customerDirectory.ts), over migration 020's session-bound read (M7A-CUSTOMERS-P2, -P3-R1; G-IAM, G-PERSIST).
//
// WHAT IT ASKS. For the presenting session's store key, and a validated continuation and page size, it calls
// tmpos_role.m7a_customer_page_v3 once — migration 018's page_v2, which 020 revokes from the runtime role, plus the role's
// CURRENT Customers level (M7A-CUSTOMERS-P3-R1): a role an owner narrowed below View is answered 'denied', exactly as a
// withdrawn grant is. The routine reads the session and its mint-ledger row, requires it minted, of
// audience tenant, live on the database clock and of an unchanged standing, derives the actor, its account security
// version and its ONE tenant grant from that session inside the database, and delegates to migration 017's page as its
// owner — which confirms, in the snapshot it reads the page in, that exactly this authority still holds, and answers a
// page of THAT tenant's customers, 'denied' or 'cursor_unknown'. The runtime login cannot call 017's page itself. Nothing
// the request carried is a parameter here beyond the continuation's customer id and the page size, both validated by the
// runtime before this port is asked; the key is the chain's own (RouteContext.sessionKey), a SQL parameter and nothing
// else. The trusted scope the authorizer selected is still required, and its tenant is checked against every row.
//
// ONE MORE ROW THAN THE PAGE. It asks for limit + 1 rows and returns at most `limit`: the extra row says that another
// page follows, without a second statement or a count.
//
// IT CONSTRUCTS NOTHING AND READS NOTHING. The caller hands it the transaction kernel the composition root already
// built — one client, one credential, one governed endpoint. Importing this file connects to nothing and reads no secret.
//
// EVERY ROW MUST NAME THE ADMITTED TENANT. The routine returns each customer's tenant beside it, and a row naming any
// tenant but the AUTHORIZER's is a fault — a second, independent check that a routine which lost its tenant filter (a later
// replacement, a wrong edit) could never put another tenant's customer on a page.
//
// FAIL CLOSED. A row out of shape, with a name no row can hold, or out of page order, a row of another tenant, an answer mixing a refusal with customers, an abort, a
// timeout, a lost connection and a driver error are all a THROW — an outage the route answers as a bounded 503 — never a page, and never a refusal. The
// runtime validates the answer again before any of it reaches a response. Nothing is logged: a driver error propagates
// without a message of this file's own, and the route discards it.
//
// READINESS (probeCustomerDirectory, the tenant entry's). It asks the same routine for a random key no session holds and
// requires its one refusal: the login's EXECUTE and the routine's own reads of the session and its ledger row answer. The
// routine refuses an unknown key before it reads the issuer key, 016's admission, the role's level or 017's page, so those
// are not re-proved here: the issuer key and the admission are readiness checks of their own, and 017's page and 020's
// level read are pinned by the startup ledger's checksums (docs/phase-4/08 DA-108).
//
// M7A-CUSTOMERS-P4 UPDATE — THE DETAIL READ (createPostgresCustomerDetail). For the presenting session's store key, a
// canonical customer id and the authorizer's tenant, it calls migration 022's tmpos_customer_detail.m7a_customer_get once,
// in one statement: the routine derives the tenant from the session (the scope's tenant is a precondition it compares, never
// a selector), re-decides the list's authority on one snapshot, and answers exactly one row. Only an exactly shaped row
// is an answer: 'customer' naming the authorizer's tenant, the id asked for and a storable name; 'not_found' or 'denied' with
// every other column null. Anything else — 'invalid', no row, two rows, another tenant, another id — is a throw (503). Its
// readiness (probeCustomerDetail) asks the routine for a random key no session holds and requires its one 'denied'; the
// tenant entry's one reads probe asks the directory's and then this one.
//
// M7A-CUSTOMERS-P6 UPDATE — THE PROFILE READ (createPostgresCustomerProfile). The detail read's shape over migration 023's
// tmpos_customer_contact.m7a_contact_profile, which delegates every decision and the point read to 022's routine and adds
// that row's phone, email and creation time (UTC text in toISOString's form, or NULL for a customer created before 023).
// Only an exactly shaped row is an answer: 'customer' naming the authorizer's tenant and the id asked for, with a storable
// name, each contact NULL or a value the create stores (the runtime's own normalizer answering it unchanged), and a
// creation time NULL or exactly that form; 'not_found' or 'denied' with every other column null. Anything else is a throw
// (503), with this file's one bounded message — never a contact. Its readiness (probeCustomerProfile) asks the routine
// for a random key no session holds and requires its one 'denied' with every other column null; the reads probe asks it
// after the detail's.
//
// M7A-CUSTOMERS-P7 UPDATE — THE VERSIONED PROFILE. The profile read (and its probe) now asks migration 024's
// tmpos_customer_edit.m7a_customer_profile — 024 revokes the runtime role's EXECUTE on 023's routine — which delegates to
// 023's on one snapshot and adds the customer's row version (o_version, NULL on every refusal). A 'customer' row must carry
// it as bigint decimal text from 1 to 2^53-1 with no leading zero, answered to the runtime as a number; anything else is
// the same bounded throw (503).
//
// M7A-CUSTOMERS-P8 UPDATE — THE NAME SEARCH. The directory's one port method dispatches on query.search: null asks 020's
// page_v3 exactly as before; a search text — already the runtime's applied text, checked again here before any statement
// (isCustomerSearchText) — asks migration 025's tmpos_customer_search.m7a_customer_search once, with (key, the
// authorizer's tenant, the text, the continuation's id, limit + 1). That routine derives the tenant from the session
// itself and compares the authorizer's (a precondition, never a selector), re-decides 022's authority on one snapshot,
// and answers the matching customers of that tenant in page order, 'denied', 'cursor_unknown' or 'invalid'. Its rows are
// judged by the same answerOf as the list's: every row the authorizer's tenant, distinct, storable, in page order;
// 'invalid' or any other shape is the bounded throw (503). Its readiness (probeCustomerSearch) asks it for a random key
// no session holds and requires its one 'denied' with every other column null; the reads probe asks it last.
import { randomBytes, randomUUID } from 'node:crypto';
import { isTrustedScope } from '../runtime/principals.js';
import type { TrustedScope } from '../runtime/principals.js';
import {
  CUSTOMER_DIRECTORY_MAX_LIMIT, inCustomerPageOrder, isCustomerCreatedAt, isCustomerSearchText, isStorableName, normalizeCustomerEmail,
  normalizeCustomerPhone,
} from '../runtime/customerDirectory.js';
import type { CustomerDetailPort, CustomerDirectoryPort, CustomerDirectoryQuery, CustomerProfilePort } from '../runtime/customerDirectory.js';
import type { SupervisedPgClient, TransactionBounds } from './supervisedPgClient.js';

/** One short read, cancelled by PostgreSQL itself if it overruns, like the other runtime reads. */
export const CUSTOMER_DIRECTORY_DEADLINE_MS = 3_000;
export const CUSTOMER_DIRECTORY_BOUNDS: TransactionBounds = Object.freeze({
  lock: `${Math.floor(CUSTOMER_DIRECTORY_DEADLINE_MS * 0.7)}ms`,
  statement: `${Math.floor(CUSTOMER_DIRECTORY_DEADLINE_MS * 0.9)}ms`,
  idle: `${CUSTOMER_DIRECTORY_DEADLINE_MS * 2}ms`,
});

/** The columns migration 020's routine answers with — 018's and 017's own. */
const ROW_COLUMNS: readonly string[] = ['o_outcome', 'o_tenant_id', 'o_customer_id', 'o_name'];
/** The columns migration 024's profile read answers with: 022's, then 023's contact record's three, then the row version. */
const PROFILE_COLUMNS: readonly string[] = [...ROW_COLUMNS, 'o_phone', 'o_email', 'o_created_at', 'o_version'];
/** A row version as PostgreSQL sends a bigint: decimal text, no sign, no leading zero, at most 16 digits. */
const VERSION_TEXT_RE = /^[1-9][0-9]{0,15}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A session store key: the SHA-256 of a session identifier, unpadded base64url (sessions.ts digestOf). */
const SESSION_KEY_RE = /^[A-Za-z0-9_-]{43}$/;

/** Every fault is the same bounded message: nothing about the row, the value or the driver. */
const fault = (): Error => new Error('customer directory answer invalid');

type Row = Readonly<Record<string, unknown>>;

function rowOf(value: unknown, columns: readonly string[] = ROW_COLUMNS): Row {
  if (typeof value !== 'object' || value === null) throw fault();
  const keys = Object.keys(value as Record<string, unknown>);
  if (keys.length !== columns.length || !columns.every((c) => keys.includes(c))) throw fault();
  return value as Row;
}

/** The routine's rows as the port's answer for `tenant`; a throw for anything out of shape. */
function answerOf(rows: unknown, limit: number, tenant: string): unknown {
  // The bound is checked before any row is read, so an oversized answer costs nothing to refuse.
  if (!Array.isArray(rows) || rows.length > limit + 1) throw fault();
  const all = rows.map((row) => rowOf(row));
  const first = all[0];
  // A refusal is the routine's only row, with every other column null.
  if (first !== undefined && first.o_outcome !== 'customer') {
    const refusal = first.o_outcome;
    if (all.length !== 1 || (refusal !== 'denied' && refusal !== 'cursor_unknown')) throw fault();
    if (first.o_tenant_id !== null || first.o_customer_id !== null || first.o_name !== null) throw fault();
    return Object.freeze({ outcome: refusal });
  }
  // Every row, the lookahead included, is checked in full, must name a distinct customer and must follow the one before
  // it in page order — the route never sees the lookahead, so an out-of-order one would otherwise pass unchecked and
  // the next page, starting after this one's last row, would skip it. Only the lookahead's presence is reported.
  const seen = new Set<string>();
  const customers = all.map((row) => {
    const { o_outcome: outcome, o_tenant_id: owner, o_customer_id: id, o_name: name } = row;
    if (outcome !== 'customer' || owner !== tenant) throw fault();
    if (typeof id !== 'string' || !UUID_RE.test(id) || seen.has(id)) throw fault();
    if (!isStorableName(name)) throw fault();
    seen.add(id);
    return Object.freeze({ id, name });
  });
  if (!inCustomerPageOrder(customers)) throw fault();
  return Object.freeze({ outcome: 'page', customers: Object.freeze(customers.slice(0, limit)), hasMore: all.length > limit });
}

/**
 * The production customer directory over the M6 runtime client. `client` is the kernel the composition root already
 * built — one client, one credential, one governed endpoint.
 */
export function createPostgresCustomerDirectory(deps: { readonly client: SupervisedPgClient }): CustomerDirectoryPort {
  const { client } = deps;
  return Object.freeze({
    async page(scope: TrustedScope, sessionKey: string, query: CustomerDirectoryQuery, signal: AbortSignal): Promise<unknown> {
      // Refused before a statement runs: only a tenant scope the authorizer selected, naming its tenant, is an authority,
      // and only a key of the store-key shape names a session.
      if (!isTrustedScope(scope) || scope.scope !== 'tenant' || scope.tenant === null || !UUID_RE.test(scope.tenant)) throw fault();
      if (typeof sessionKey !== 'string' || !SESSION_KEY_RE.test(sessionKey)) throw fault();
      const tenant = scope.tenant;
      const { after, limit, search } = query;
      if (after !== null && (typeof after !== 'string' || !UUID_RE.test(after))) throw fault();
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > CUSTOMER_DIRECTORY_MAX_LIMIT) throw fault();
      // Only null (the unfiltered list) or an applied search text: anything else never reaches a statement.
      if (search !== null && !isCustomerSearchText(search)) throw fault();
      return client.transaction(signal, CUSTOMER_DIRECTORY_BOUNDS, async (sql) => {
        const rows = search === null
          ? await sql`select o_outcome, o_tenant_id, o_customer_id, o_name
              from tmpos_role.m7a_customer_page_v3(${sessionKey}::text, ${after}::uuid, ${limit + 1}::integer)`
          : await sql`select o_outcome, o_tenant_id, o_customer_id, o_name
              from tmpos_customer_search.m7a_customer_search(${sessionKey}::text, ${tenant}::uuid, ${search}::text, ${after}::uuid, ${limit + 1}::integer)`;
        return answerOf(rows, limit, tenant);
      });
    },
  });
}

/** Readiness: true only for the search routine's one refusal of a random key no session holds; anything else is false. */
export async function probeCustomerSearch(client: SupervisedPgClient, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false;
  const absentKey = randomBytes(32).toString('base64url');
  try {
    return await client.transaction(signal, CUSTOMER_DIRECTORY_BOUNDS, async (sql) => {
      const rows = await sql`select o_outcome, o_tenant_id, o_customer_id, o_name
        from tmpos_customer_search.m7a_customer_search(${absentKey}::text, ${randomUUID()}::uuid, 'probe'::text, null::uuid, 1::integer)`;
      if (!Array.isArray(rows) || rows.length !== 1) return false;
      const row = rowOf(rows[0]);
      return row.o_outcome === 'denied' && row.o_tenant_id === null && row.o_customer_id === null && row.o_name === null;
    });
  } catch {
    return false; // an outage, an abort, an overrun, a driver fault or a row out of shape: nothing is disclosed
  }
}

/** Readiness: true only for the routine's one refusal of a random key no session holds; any other answer or fault is false. */
export async function probeCustomerDirectory(client: SupervisedPgClient, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false;
  const absentKey = randomBytes(32).toString('base64url');
  try {
    return await client.transaction(signal, CUSTOMER_DIRECTORY_BOUNDS, async (sql) => {
      const rows = await sql`select o_outcome, o_tenant_id, o_customer_id, o_name
        from tmpos_role.m7a_customer_page_v3(${absentKey}::text, null::uuid, 1::integer)`;
      if (!Array.isArray(rows) || rows.length !== 1) return false;
      const row = rowOf(rows[0]);
      return row.o_outcome === 'denied' && row.o_tenant_id === null && row.o_customer_id === null && row.o_name === null;
    });
  } catch {
    return false; // an outage, an abort, an overrun, a driver fault or a row out of shape: nothing is disclosed
  }
}

/** The detail routine's one row as the port's answer for `tenant` and `customerId`; a throw for anything out of shape. */
function detailOf(rows: unknown, tenant: string, customerId: string): unknown {
  if (!Array.isArray(rows) || rows.length !== 1) throw fault();
  const { o_outcome: outcome, o_tenant_id: owner, o_customer_id: id, o_name: name } = rowOf(rows[0]);
  if (outcome === 'not_found' || outcome === 'denied') {
    if (owner !== null || id !== null || name !== null) throw fault();
    return Object.freeze({ outcome });
  }
  if (outcome !== 'customer' || owner !== tenant || id !== customerId || !isStorableName(name)) throw fault();
  return Object.freeze({ outcome: 'customer', id, name });
}

/** The production customer detail read over the M6 runtime client — the kernel the composition root already built. */
export function createPostgresCustomerDetail(deps: { readonly client: SupervisedPgClient }): CustomerDetailPort {
  const { client } = deps;
  return Object.freeze({
    async get(scope: TrustedScope, sessionKey: string, customerId: string, signal: AbortSignal): Promise<unknown> {
      // Refused before a statement runs, as the page's: only a selected tenant scope, a store-key-shaped key and a
      // canonical id reach the database.
      if (!isTrustedScope(scope) || scope.scope !== 'tenant' || scope.tenant === null || !UUID_RE.test(scope.tenant)) throw fault();
      if (typeof sessionKey !== 'string' || !SESSION_KEY_RE.test(sessionKey)) throw fault();
      if (typeof customerId !== 'string' || !UUID_RE.test(customerId)) throw fault();
      const tenant = scope.tenant;
      return client.transaction(signal, CUSTOMER_DIRECTORY_BOUNDS, async (sql) => {
        const rows = await sql`select o_outcome, o_tenant_id, o_customer_id, o_name
          from tmpos_customer_detail.m7a_customer_get(${sessionKey}::text, ${customerId}::uuid, ${tenant}::uuid)`;
        return detailOf(rows, tenant, customerId);
      });
    },
  });
}

/** Readiness: true only for the detail routine's one refusal of a random key no session holds; anything else is false. */
export async function probeCustomerDetail(client: SupervisedPgClient, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false;
  const absentKey = randomBytes(32).toString('base64url');
  try {
    return await client.transaction(signal, CUSTOMER_DIRECTORY_BOUNDS, async (sql) => {
      const rows = await sql`select o_outcome, o_tenant_id, o_customer_id, o_name
        from tmpos_customer_detail.m7a_customer_get(${absentKey}::text, ${randomUUID()}::uuid, ${randomUUID()}::uuid)`;
      if (!Array.isArray(rows) || rows.length !== 1) return false;
      const row = rowOf(rows[0]);
      return row.o_outcome === 'denied' && row.o_tenant_id === null && row.o_customer_id === null && row.o_name === null;
    });
  } catch {
    return false; // an outage, an abort, an overrun, a driver fault or a row out of shape: nothing is disclosed
  }
}

/** The profile routine's one row as the port's answer for `tenant` and `customerId`; a throw for anything out of shape. */
function profileOf(rows: unknown, tenant: string, customerId: string): unknown {
  if (!Array.isArray(rows) || rows.length !== 1) throw fault();
  const {
    o_outcome: outcome, o_tenant_id: owner, o_customer_id: id, o_name: name, o_phone: phone, o_email: email, o_created_at: createdAt,
    o_version: versionText,
  } = rowOf(rows[0], PROFILE_COLUMNS);
  if (outcome === 'not_found' || outcome === 'denied') {
    if (owner !== null || id !== null || name !== null || phone !== null || email !== null || createdAt !== null || versionText !== null) {
      throw fault();
    }
    return Object.freeze({ outcome });
  }
  if (outcome !== 'customer' || owner !== tenant || id !== customerId || !isStorableName(name)) throw fault();
  // A stored contact is already the value the create stores: null, or a string its normalizer answers unchanged.
  if (phone !== null && (typeof phone !== 'string' || normalizeCustomerPhone(phone) !== phone)) throw fault();
  if (email !== null && (typeof email !== 'string' || normalizeCustomerEmail(email) !== email)) throw fault();
  if (!isCustomerCreatedAt(createdAt)) throw fault();
  // Compared as text first, so no value is ever rounded through a float before it is known to be exact.
  if (typeof versionText !== 'string' || !VERSION_TEXT_RE.test(versionText)) throw fault();
  const version = Number(versionText);
  if (!Number.isSafeInteger(version) || String(version) !== versionText) throw fault();
  return Object.freeze({ outcome: 'customer', id, name, phone, email, createdAt, version });
}

/** The production customer profile read over the M6 runtime client — the kernel the composition root already built. */
export function createPostgresCustomerProfile(deps: { readonly client: SupervisedPgClient }): CustomerProfilePort {
  const { client } = deps;
  return Object.freeze({
    async get(scope: TrustedScope, sessionKey: string, customerId: string, signal: AbortSignal): Promise<unknown> {
      // Refused before a statement runs, as the detail's.
      if (!isTrustedScope(scope) || scope.scope !== 'tenant' || scope.tenant === null || !UUID_RE.test(scope.tenant)) throw fault();
      if (typeof sessionKey !== 'string' || !SESSION_KEY_RE.test(sessionKey)) throw fault();
      if (typeof customerId !== 'string' || !UUID_RE.test(customerId)) throw fault();
      const tenant = scope.tenant;
      return client.transaction(signal, CUSTOMER_DIRECTORY_BOUNDS, async (sql) => {
        const rows = await sql`select o_outcome, o_tenant_id, o_customer_id, o_name, o_phone, o_email, o_created_at, o_version
          from tmpos_customer_edit.m7a_customer_profile(${sessionKey}::text, ${customerId}::uuid, ${tenant}::uuid)`;
        return profileOf(rows, tenant, customerId);
      });
    },
  });
}

/** Readiness: true only for the profile routine's one refusal of a random key no session holds; anything else is false. */
export async function probeCustomerProfile(client: SupervisedPgClient, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false;
  const absentKey = randomBytes(32).toString('base64url');
  try {
    return await client.transaction(signal, CUSTOMER_DIRECTORY_BOUNDS, async (sql) => {
      const rows = await sql`select o_outcome, o_tenant_id, o_customer_id, o_name, o_phone, o_email, o_created_at, o_version
        from tmpos_customer_edit.m7a_customer_profile(${absentKey}::text, ${randomUUID()}::uuid, ${randomUUID()}::uuid)`;
      if (!Array.isArray(rows) || rows.length !== 1) return false;
      const row = rowOf(rows[0], PROFILE_COLUMNS);
      return row.o_outcome === 'denied' && PROFILE_COLUMNS.slice(1).every((column) => row[column] === null);
    });
  } catch {
    return false; // an outage, an abort, an overrun, a driver fault or a row out of shape: nothing is disclosed
  }
}

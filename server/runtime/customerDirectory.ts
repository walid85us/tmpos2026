// Phase 4.0 M7a — the tenant customer directory: the first tenant business route, a bounded read of the customers of
// the tenant a session is admitted to (M7A-CUSTOMERS-P1; G-IAM, G-PERSIST; docs/phase-4/10 ADR-32).
//
// GET /api/v1/customers[?limit=N][&cursor=C] — a session route of the TENANT boundary, under the established
// conventions (routes.ts): tenant business routes live under /api/v1, and the path is literal — it carries no tenant.
// The chain proves the tenant session and asks the tenant authorizer (tenantAuthorization.ts) for view_customers — the
// Customers domain at View or above (m5CanonicalPermissions.ts) — before this handler runs, so a 401, a 403 or an
// authorization outage never reaches it. The route declares `trustedContext: 'required'`: the chain refuses it unless
// the authorizer resolved the session's actor and the ONE tenant grant it decided on, and that trusted scope — never a
// path, query, header, cursor or body — is the only thing that says whose customers are read.
//
// BOUND TO THE PRESENTING SESSION (M7A-CUSTOMERS-P2). The route declares `sessionBinding: 'required'`, so the chain
// hands this handler the presenting session's store key, and the port asks the database with that key alone: the read is
// bound in the database to the presenting minted session, which derives the tenant itself — a caller holding the
// runtime's database login but no live minted session reads nothing. The key is a SQL parameter and nothing else.
//
// THE QUERY. Exactly two optional parameters, each at most once and nothing else: `limit`, a decimal 1-100 (default 50),
// and `cursor`, the continuation a previous page returned. Any other key, a repeat, an empty pair, an encoding, a
// non-canonical spelling or an overlong query is a 400 invalid_request, decided before the customer port is asked (the
// chain has already proved the session and decided the permission, so an unauthenticated one is a 401 first). The cursor is
// opaque to the client: 23 base64url characters encoding a tag byte and the id of the last customer of the previous
// page, accepted only in its one canonical spelling. It carries NO authority and no tenant: the routine looks its
// position up only among the admitted tenant's customers, so a cursor naming another tenant's customer — or none — is
// the same 400 as any unknown one and reveals nothing about any tenant.
//
// THE PAGE. The port asks migration 018's session-bound routine, which delegates to migration 017's, for at most `limit`
// customers after the cursor, ordered by (name, id) in byte order — a total order, so pages never overlap. The routine
// re-confirms, in the snapshot it reads, that the session's one tenant grant still holds. Its answer is untrusted: only an exactly shaped answer becomes a page —
// canonical customer ids, none repeated and none the cursor's own, names of 1-200 characters in well-formed UTF-16,
// in strictly increasing page order (so a continuation can never repeat or skip a row the answer put out of order) —
// and anything else is a bounded 503. The response is built field by field from that validated answer:
//   { customers: [{ id, name }], nextCursor }
// It carries nothing else: no tenant, store, role, grant or membership, no contact, loyalty or money field, no session
// data, no database detail. Chain-wide headers mark every response no-store.
//
// NO AUDIT RECORD. Owner decision (M7A-CUSTOMERS-P1): this read writes no durable audit event; whether a list of
// personal data is audited is recorded open for the privacy and audit design (doc 08 G-AUDIT). The request log the chain
// writes for it names the route, the status and a bounded reason — never a customer, a query value or a body.
//
// FAILURES. The routine's 'denied' (the grant stopped holding between the authorizer and the read) is the same generic
// 403 every other denial is; a continuation naming no customer of the tenant is a 400; a port that throws, overruns its
// deadline or answers out of shape is a 503 whose reason goes to the request log alone — never a cached, partial or
// synthetic page.
//
// M7A-CUSTOMERS-P4 UPDATE — THE DETAIL READ. GET /api/v1/customers/{id}: one customer by id, under the list's permission
// (view_customers), trusted context and session binding, over the same module's conventions. It is the route table's one
// template (routes.ts): /api/v1/customers/ plus one raw segment of 1-128 characters without '/' reaches this handler only
// after the chain has proved the session and decided the permission, so an unauthenticated caller gets the chain's 401 or
// 403 whatever the segment. Then, as the list's query: any query at all, or a segment that is not a canonical lowercase
// uuid (uppercase, %-encoded, braces, anything else), is a 400 invalid_request before the port is asked. A canonical id
// makes EXACTLY ONE port call — no cache, no early answer: the runtime cannot tell another tenant's id from a missing one
// and never tries. The port asks migration 022's session-bound routine, which derives the tenant from the presenting
// session, asserts it equals the trusted scope's (a precondition, never a selector), re-decides the role's current
// Customers level and 017's rechecks on one snapshot, and reads the one row. A missing id and another tenant's id are the
// same 404 {error:'not_found', requestId} — the terminal 404's body shape — with the same headers and one log reason; a
// withdrawn authority is the list's 403; an outage or an out-of-shape answer a 503. 200 { customer: { id, name } } — the
// create's 201 body shape, the list entry's two fields, nothing else. No audit record (the list's owner decision).
//
// PURE AND PORTABLE: part of the emitted runtime artifact, importing only the runtime. It holds no infrastructure; the
// port is handed to it by the composition root.
import { Buffer } from 'node:buffer';
import type { Response } from 'express';
import { PORT_DEADLINE_MS, outage, withDeadline } from './deadline.js';
import type { TrustedScope } from './principals.js';
import { EnforcementSetupError, PATH_ID_SEGMENT, pathIdOf } from './routes.js';
import type { AuthorizationRequirement, RouteContext, RouteDefinition, RouteHandler } from './routes.js';

export const CUSTOMER_DIRECTORY_PATH = '/api/v1/customers';
/** The detail read's path: the route table's one template, '/api/v1/customers/{id}'. */
export const CUSTOMER_DETAIL_PATH = `${CUSTOMER_DIRECTORY_PATH}${PATH_ID_SEGMENT}`;
/** The canonical tenant route permission: the Customers domain at View or above. */
export const CUSTOMER_DIRECTORY_PERMISSION = 'view_customers';
export const CUSTOMER_DIRECTORY_REQUIREMENT: AuthorizationRequirement = Object.freeze({ scope: 'tenant', permission: CUSTOMER_DIRECTORY_PERMISSION });
export const CUSTOMER_DIRECTORY_DEFAULT_LIMIT = 50;
export const CUSTOMER_DIRECTORY_MAX_LIMIT = 100;
/**
 * The longest name a page carries, in characters (Unicode code points) — migration 017's column limit. A longer one is
 * not a row this schema can hold, so the page is a 503 rather than an unbounded response.
 */
export const CUSTOMER_NAME_MAX_CHARACTERS = 200;

/**
 * Whether `name` could be a stored name by length and encoding: 1-200 characters and well formed (a lone surrogate
 * cannot be stored in a UTF-8 database). The column's character rules (controls, Bidi_Control, edge whitespace) are its
 * own CHECK and are not restated here.
 */
export function isStorableName(name: unknown): name is string {
  // At most two UTF-16 units per character: a cheap bound before anything is copied.
  if (typeof name !== 'string' || name.length === 0 || name.length > 2 * CUSTOMER_NAME_MAX_CHARACTERS) return false;
  // A lone surrogate encodes as U+FFFD, so it does not survive the round trip.
  if (Buffer.from(name, 'utf8').toString('utf8') !== name) return false;
  return Array.from(name).length <= CUSTOMER_NAME_MAX_CHARACTERS;
}

/**
 * Whether `entries` are in the routine's page order, strictly increasing: name in byte order (the "C" collation over
 * UTF-8), then id — a canonical lowercase uuid, whose text order is its byte order. The route checks every page it
 * serves; the PostgreSQL adapter checks every row it reads, the look-ahead row included, which the route never sees.
 */
export function inCustomerPageOrder(entries: readonly { readonly id: string; readonly name: string }[]): boolean {
  // inv: entries[0..i) is strictly increasing; term: i rises to entries.length.
  for (let i = 1; i < entries.length; i++) {
    const before = entries[i - 1];
    const after = entries[i];
    const byName = Buffer.compare(Buffer.from(before.name, 'utf8'), Buffer.from(after.name, 'utf8'));
    if (byName > 0 || (byName === 0 && before.id >= after.id)) return false;
  }
  return true;
}

/** The continuation to read after, as a customer id, and the page size. Both already validated. */
export interface CustomerDirectoryQuery {
  readonly after: string | null;
  readonly limit: number;
}

/** One customer as the page shows it. */
export interface CustomerDirectoryEntry {
  readonly id: string;
  readonly name: string;
}

/**
 * The port to migration 018's session-bound read, handed the trusted scope and the presenting session's store key
 * (RouteContext.sessionKey), a SQL parameter it never logs, echoes or stores. Its answer is untrusted input, expected to be one of
 *   { outcome: 'page', customers: CustomerDirectoryEntry[], hasMore: boolean }  — at most query.limit customers;
 *   { outcome: 'denied' }                                                      — the scope's grant no longer holds;
 *   { outcome: 'cursor_unknown' }                                              — query.after names no customer of the tenant.
 * A throw is an outage.
 */
export interface CustomerDirectoryPort {
  page(scope: TrustedScope, sessionKey: string, query: CustomerDirectoryQuery, signal: AbortSignal): unknown;
}

/** What the route is built from. */
export interface CustomerDirectoryPorts {
  readonly customers: CustomerDirectoryPort;
}

/**
 * Any uuid in PostgreSQL's canonical lowercase text form — no version or variant constraint, because migration 017's
 * customer_id column accepts every uuid. A stricter pattern would turn one stored id into a 503 for every page that
 * holds it, and a continuation encoding it could never be decoded again.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const QUERY_PAIR_RE = /^(limit|cursor)=([A-Za-z0-9_-]{1,32})$/;
const LIMIT_RE = /^[1-9][0-9]{0,2}$/;
/** 17 bytes — a tag byte and a 16-byte customer id — as unpadded base64url. */
const CURSOR_RE = /^[A-Za-z0-9_-]{23}$/;
/** Distinct from the tenant directory's, so neither route's continuation is ever read as the other's. */
const CURSOR_TAG = 0x02;
const MAX_QUERY_LENGTH = 128;
const PAGE_KEYS: readonly string[] = ['outcome', 'customers', 'hasMore'];
const ENTRY_KEYS: readonly string[] = ['id', 'name'];

/** The opaque continuation for a page that ends at `customerId`. */
export function encodeCustomerCursor(customerId: string): string {
  return Buffer.concat([Buffer.from([CURSOR_TAG]), Buffer.from(customerId.replace(/-/g, ''), 'hex')]).toString('base64url');
}

/** The customer id a continuation names, or null unless it is exactly the canonical spelling of one. */
export function decodeCustomerCursor(cursor: string): string | null {
  if (!CURSOR_RE.test(cursor)) return null;
  const bytes = Buffer.from(cursor, 'base64url');
  // Canonical only: decoding ignores the unused low bits of the last character, so a re-encoding that differs means a
  // second spelling of the same bytes, which is refused rather than accepted.
  if (bytes.length !== 17 || bytes[0] !== CURSOR_TAG || bytes.toString('base64url') !== cursor) return null;
  const hex = bytes.subarray(1).toString('hex');
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return UUID_RE.test(id) ? id : null;
}

/** The request target's query as a validated CustomerDirectoryQuery, or null for anything the contract refuses. */
export function parseCustomerDirectoryQuery(target: string): CustomerDirectoryQuery | null {
  const at = target.indexOf('?');
  if (at < 0) return Object.freeze({ after: null, limit: CUSTOMER_DIRECTORY_DEFAULT_LIMIT });
  const raw = target.slice(at + 1);
  if (raw.length > MAX_QUERY_LENGTH) return null;
  let after: string | null = null;
  let limit: number | null = null;
  const seen = new Set<string>();
  // inv: every pair before this one matched the contract once per key; term: the pairs are finite.
  for (const pair of raw.split('&')) {
    const match = QUERY_PAIR_RE.exec(pair);
    if (match === null || seen.has(match[1])) return null;
    seen.add(match[1]);
    if (match[1] === 'limit') {
      if (!LIMIT_RE.test(match[2])) return null;
      limit = Number(match[2]);
      if (limit > CUSTOMER_DIRECTORY_MAX_LIMIT) return null;
    } else {
      after = decodeCustomerCursor(match[2]);
      if (after === null) return null;
    }
  }
  return Object.freeze({ after, limit: limit ?? CUSTOMER_DIRECTORY_DEFAULT_LIMIT });
}

const isPlain = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};
const hasExactly = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => own.includes(key));
};

type PageAnswer = { readonly customers: readonly CustomerDirectoryEntry[]; readonly hasMore: boolean } | 'denied' | 'cursor_unknown';

/** The port's answer as a validated page, 'denied', 'cursor_unknown' — or null for anything out of shape. Never throws. */
export function customerDirectoryPageOf(raw: unknown, query: CustomerDirectoryQuery): PageAnswer | null {
  try {
    if (!isPlain(raw)) return null;
    const { outcome } = raw;
    if (outcome === 'denied') return hasExactly(raw, ['outcome']) ? 'denied' : null;
    if (outcome === 'cursor_unknown') return hasExactly(raw, ['outcome']) && query.after !== null ? 'cursor_unknown' : null;
    if (outcome !== 'page' || !hasExactly(raw, PAGE_KEYS)) return null;
    const { customers, hasMore } = raw;
    if (!Array.isArray(customers) || typeof hasMore !== 'boolean') return null;
    // The length is read once, so the bound checked is the bound the loop runs to.
    const count = customers.length;
    if (count > query.limit) return null;
    // A next page exists only behind a full one: the port read one row more than it returned.
    if (hasMore && count !== query.limit) return null;
    const seen = new Set<string>();
    const out: CustomerDirectoryEntry[] = [];
    // inv: out holds a validated copy of each entry below i, and seen their ids; term: i rises to count.
    for (let i = 0; i < count; i++) {
      const entry: unknown = customers[i];
      if (!isPlain(entry) || !hasExactly(entry, ENTRY_KEYS)) return null;
      // Read once each, so a value validated is the value copied.
      const { id, name } = entry;
      if (typeof id !== 'string' || !UUID_RE.test(id) || seen.has(id) || id === query.after) return null;
      if (!isStorableName(name)) return null;
      seen.add(id);
      out.push(Object.freeze({ id, name }));
    }
    if (!inCustomerPageOrder(out)) return null;
    return Object.freeze({ customers: Object.freeze(out), hasMore });
  } catch {
    return null; // a throwing getter or proxy trap is never a page
  }
}

/** A bounded refusal in the chain's own shape: fixed error word and correlation id; the reason is logged only. */
function refuse(res: Response, ctx: RouteContext, status: number, error: string, reason: string): void {
  res.locals.refusal = reason;
  res.status(status).json({ error, requestId: ctx.requestId });
}

/** The customer directory route over `ports`, for a route table; refused at construction without its port. */
export function createCustomerDirectoryRoute(ports: CustomerDirectoryPorts, options: { deadlineMs?: number } = {}): RouteDefinition {
  const reader = ports?.customers;
  if (typeof reader?.page !== 'function') throw new EnforcementSetupError('route_handler_invalid');
  const deadlineMs = options.deadlineMs ?? PORT_DEADLINE_MS;
  // One more port call in the chain, bounded like the rest so the whole chain fits the socket timeout.
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > PORT_DEADLINE_MS) {
    throw new EnforcementSetupError('port_deadline_invalid');
  }
  const handler: RouteHandler = async (req, res, ctx) => {
    const query = parseCustomerDirectoryQuery(typeof req.url === 'string' ? req.url : '');
    if (query === null) return refuse(res, ctx, 400, 'invalid_request', 'customer_directory_query_invalid');
    // The chain refused this request already unless a tenant scope was resolved; this states it again.
    const scope = ctx.trusted;
    if (scope === null || scope.scope !== 'tenant' || scope.tenant === null) return refuse(res, ctx, 403, 'forbidden', 'authz_context_missing');
    // The route declares the binding, so the chain hands the key; this states it again.
    const { sessionKey } = ctx;
    if (sessionKey === null) return refuse(res, ctx, 403, 'forbidden', 'authz_context_missing');
    let raw: unknown;
    try {
      raw = await withDeadline(deadlineMs, (signal) => reader.page(scope, sessionKey, query, signal));
    } catch (err) {
      return refuse(res, ctx, 503, 'service_unavailable', outage('customer_directory', err));
    }
    const page = customerDirectoryPageOf(raw, query);
    if (page === 'denied') return refuse(res, ctx, 403, 'forbidden', 'customer_directory_denied');
    if (page === 'cursor_unknown') return refuse(res, ctx, 400, 'invalid_request', 'customer_directory_cursor_unknown');
    if (page === null) return refuse(res, ctx, 503, 'service_unavailable', 'customer_directory_answer_invalid');
    const last = page.customers[page.customers.length - 1];
    res.status(200).json({
      customers: page.customers.map((c) => ({ id: c.id, name: c.name })),
      nextCursor: page.hasMore && last !== undefined ? encodeCustomerCursor(last.id) : null,
    });
  };
  const route: RouteDefinition = {
    method: 'GET',
    path: CUSTOMER_DIRECTORY_PATH,
    policy: Object.freeze({ access: 'session', audience: 'tenant', authorization: CUSTOMER_DIRECTORY_REQUIREMENT }),
    body: Object.freeze({ kind: 'none' }),
    idempotency: 'none',
    // A read, but one that names whose authority it reads under: the routine re-confirms that exact grant and reads
    // only its tenant, so the route needs the resolved scope, never a verified principal alone. No recent sign-in.
    trustedContext: 'required',
    recentAuth: 'none',
    // The database binds the read to the presenting minted session, so the handler is handed its store key.
    sessionBinding: 'required',
    handler,
  };
  return Object.freeze(route);
}

/**
 * The port to migration 022's session-bound detail read, handed the trusted scope, the presenting session's store key (a
 * SQL parameter it never logs, echoes or stores) and a canonical customer id. Its answer is untrusted input, expected to be
 *   { outcome: 'customer', id, name } — id exactly the one asked for;
 *   { outcome: 'not_found' }         — no customer of the session's tenant has that id (missing and foreign alike);
 *   { outcome: 'denied' }            — the authority no longer holds.
 * A throw is an outage.
 */
export interface CustomerDetailPort {
  get(scope: TrustedScope, sessionKey: string, customerId: string, signal: AbortSignal): unknown;
}

/** What the detail route is built from. */
export interface CustomerDetailPorts {
  readonly customerDetail: CustomerDetailPort;
}

const DETAIL_KEYS: readonly string[] = ['outcome', 'id', 'name'];

/** The port's answer as {id, name}, 'not_found' or 'denied' — or null for anything out of shape. Never throws. */
export function customerDetailOf(raw: unknown, customerId: string): CustomerDirectoryEntry | 'not_found' | 'denied' | null {
  try {
    if (!isPlain(raw)) return null;
    const { outcome } = raw;
    if (outcome === 'denied' || outcome === 'not_found') return hasExactly(raw, ['outcome']) ? outcome : null;
    if (outcome !== 'customer' || !hasExactly(raw, DETAIL_KEYS)) return null;
    // Read once each, so a value validated is the value copied.
    const { id, name } = raw;
    if (typeof id !== 'string' || id !== customerId || !UUID_RE.test(id) || !isStorableName(name)) return null;
    return Object.freeze({ id, name });
  } catch {
    return null; // a throwing getter or proxy trap is never a customer
  }
}

/** The customer detail route over `ports`, for a route table; refused at construction without its port. */
export function createCustomerDetailRoute(ports: CustomerDetailPorts, options: { deadlineMs?: number } = {}): RouteDefinition {
  const reader = ports?.customerDetail;
  if (typeof reader?.get !== 'function') throw new EnforcementSetupError('route_handler_invalid');
  const deadlineMs = options.deadlineMs ?? PORT_DEADLINE_MS;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > PORT_DEADLINE_MS) {
    throw new EnforcementSetupError('port_deadline_invalid');
  }
  const handler: RouteHandler = async (req, res, ctx) => {
    // No query is part of this contract: any at all, an empty one included, is refused.
    if ((typeof req.url === 'string' ? req.url : '').includes('?')) return refuse(res, ctx, 400, 'invalid_request', 'customer_detail_query_invalid');
    const scope = ctx.trusted;
    if (scope === null || scope.scope !== 'tenant' || scope.tenant === null) return refuse(res, ctx, 403, 'forbidden', 'authz_context_missing');
    const { sessionKey } = ctx;
    if (sessionKey === null) return refuse(res, ctx, 403, 'forbidden', 'authz_context_missing');
    // The same req.path the table matched. Anything but one canonical lowercase uuid is the list's bounded 400.
    const id = pathIdOf(typeof req.path === 'string' ? req.path : '');
    if (id === null) return refuse(res, ctx, 400, 'invalid_request', 'customer_detail_id_invalid');
    let raw: unknown;
    try {
      raw = await withDeadline(deadlineMs, (signal) => reader.get(scope, sessionKey, id, signal));
    } catch (err) {
      return refuse(res, ctx, 503, 'service_unavailable', outage('customer_detail', err));
    }
    const answer = customerDetailOf(raw, id);
    if (answer === 'denied') return refuse(res, ctx, 403, 'forbidden', 'customer_detail_denied');
    // Missing and foreign alike: one status, one body shape (the terminal 404's), one log reason.
    if (answer === 'not_found') return refuse(res, ctx, 404, 'not_found', 'customer_not_found');
    if (answer === null) return refuse(res, ctx, 503, 'service_unavailable', 'customer_detail_answer_invalid');
    res.status(200).json({ customer: { id: answer.id, name: answer.name } });
  };
  const route: RouteDefinition = {
    method: 'GET',
    path: CUSTOMER_DETAIL_PATH,
    policy: Object.freeze({ access: 'session', audience: 'tenant', authorization: CUSTOMER_DIRECTORY_REQUIREMENT }),
    body: Object.freeze({ kind: 'none' }),
    idempotency: 'none',
    // The list's reasons: the routine re-confirms that exact grant and reads only its tenant, bound to the presenting
    // minted session. No recent sign-in.
    trustedContext: 'required',
    recentAuth: 'none',
    sessionBinding: 'required',
    handler,
  };
  return Object.freeze(route);
}

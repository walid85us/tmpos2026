// Phase 4.0 M7b — the store directory: which stores the presenting tenant session may act at (M7B-INVOICES-P1; G-IAM,
// G-ISOLATION; docs/phase-4/10).
//
// GET /api/v1/stores — a session route of the TENANT boundary and the route table's one CLOSED authorization-free business
// route (routes.ts): it declares no authorization, no trusted context, no recent sign-in, no body and no idempotency, and it
// declares the session binding. So the chain proves the tenant session (401 otherwise), requires the presenting session's
// CSRF token in `X-TMPOS-Session-CSRF` on this GET (403 otherwise: a request whose cookie is another session's reads
// nothing, DA-138's rule), runs NO authorizer, and hands this handler the presenting session's session key — the only thing it
// is handed that names authority. It must: a store-only actor holds no tenant grant, so no tenant-scope decision could
// serve it, and no store-scope decision can be made before a store is named. The database decides instead.
//
// WHAT IS READ. The port asks migration 027's session-bound routine (tmpos_store_access.m7b_store_directory) with that key
// alone. The routine derives everything in the database: the minted, live session under the installed issuer key, the 016
// standing it was minted at, an account whose status admits a read, and then every store where that standing names EXACTLY
// ONE active store-scope grant whose store row is in the grant's tenant, with tenant and store statuses that admit a read.
// A store with two grants (two roles at one store) is ambiguous and left out — the tenant authorizer denies it too
// (server/composition/tenantAuthorization.ts) — and a tenant-scope grant contributes no store: there is no tenant-to-store
// inheritance. A tenant-only actor therefore reads an empty list. Nothing the request carries is a parameter: there is no
// query (any at all is a 400), no path segment and no body.
//
// THE ANSWER. 200 { "stores": [ { "id", "tenantId", "name", "readOnly" } ] } — every usable store (at most 200: 007's resolver
// refuses an actor with more grants), ordered by name in byte order with unnamed stores last, then id; no continuation.
// `tenantId` is the tenant the store belongs to — what a later store request names as its expected tenant; `name` is the
// store's stored name when it is servable (1-256 characters — the routine applies this route's own rule and serves null
// otherwise, so one bad name degrades its own entry, never the list) or null; `readOnly` is true when the account, the
// tenant or the store is read_only or overdue (reads only). The port's answer is untrusted: only an exactly shaped list
// becomes a response — canonical lowercase ids and tenant ids, no store twice, names of 1-256 characters in well-formed
// UTF-16 or null, a boolean flag, strictly in the routine's order — and anything else is a bounded 503 (defence in depth:
// the routine never answers such a name). The response carries nothing else: no role, grant, membership, status word,
// actor or session data. Chain-wide headers mark it no-store. A routine answer of 'denied' (the session ended or its
// standing moved between the chain and the read) is the generic 403.
//
// NO AUDIT RECORD, as for every tenant read (the customer reads' owner decision, doc 08 G-AUDIT). The request log names the
// route, the status and a bounded reason — never a store, a tenant or a name.
//
// PURE AND PORTABLE: part of the emitted runtime artifact, importing only the runtime. The port is handed to it by the
// composition root.
import { Buffer } from 'node:buffer';
import type { Response } from 'express';
import { PORT_DEADLINE_MS, outage, withDeadline } from './deadline.js';
import { EnforcementSetupError, STORE_DIRECTORY_PATH } from './routes.js';
import type { RouteContext, RouteDefinition, RouteHandler } from './routes.js';

export { STORE_DIRECTORY_PATH };

/** The most stores one answer carries: 007's resolver refuses an actor holding more than 200 grants. */
export const STORE_DIRECTORY_MAX_ENTRIES = 200;
/**
 * The longest store name served, in characters (code points). public.store.store_name has no CHECK, so migration 027's
 * routine serves an empty or longer stored name as null (the same rule as isServableStoreName); a port answer that still
 * carries one is out of shape — a bounded 503, never an unbounded response.
 */
export const STORE_NAME_MAX_CHARACTERS = 256;

/** One store the session may act at, as the response shows it. */
export interface StoreDirectoryEntry {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string | null;
  readonly readOnly: boolean;
}

/**
 * The port to migration 027's session-bound read, handed the presenting session's session key (RouteContext.sessionKey), a SQL
 * parameter it never logs, echoes or stores. Its answer is untrusted input, expected to be one of
 *   { outcome: 'stores', stores: StoreDirectoryEntry[] } — every usable store, in the routine's order;
 *   { outcome: 'denied' }                                 — the key names no live minted session of an unchanged standing.
 * A throw is an outage.
 */
export interface StoreDirectoryPort {
  stores(sessionKey: string, signal: AbortSignal): unknown;
}

/** What the route is built from. */
export interface StoreDirectoryPorts {
  readonly stores: StoreDirectoryPort;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ENTRY_KEYS: readonly string[] = ['id', 'tenantId', 'name', 'readOnly'];

const isPlain = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};
const hasExactly = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => own.includes(key));
};

/** Whether `name` is a store name this route serves: null, or 1-256 characters of well-formed UTF-16. */
export function isServableStoreName(name: unknown): name is string | null {
  if (name === null) return true;
  // At most two UTF-16 units per character: a cheap bound before anything is copied.
  if (typeof name !== 'string' || name.length === 0 || name.length > 2 * STORE_NAME_MAX_CHARACTERS) return false;
  // A lone surrogate encodes as U+FFFD, so it does not survive the round trip.
  if (Buffer.from(name, 'utf8').toString('utf8') !== name) return false;
  return Array.from(name).length <= STORE_NAME_MAX_CHARACTERS;
}

/**
 * Whether `entries` are in the routine's order, strictly increasing: name in byte order (the "C" collation over UTF-8) with
 * null names after every named store, then id (a canonical lowercase uuid, whose text order is its byte order). The route
 * checks every list it serves, and the PostgreSQL adapter every row it reads.
 */
export function inStoreDirectoryOrder(entries: readonly { readonly id: string; readonly name: string | null }[]): boolean {
  // inv: entries[0..i) is strictly increasing; term: i rises to entries.length.
  for (let i = 1; i < entries.length; i++) {
    const before = entries[i - 1];
    const after = entries[i];
    const byName = before.name === null
      ? (after.name === null ? 0 : 1)
      : (after.name === null ? -1 : Buffer.compare(Buffer.from(before.name, 'utf8'), Buffer.from(after.name, 'utf8')));
    if (byName > 0 || (byName === 0 && before.id >= after.id)) return false;
  }
  return true;
}

/** The port's answer as a validated list, 'denied' — or null for anything out of shape. Never throws. */
export function storeDirectoryOf(raw: unknown): readonly StoreDirectoryEntry[] | 'denied' | null {
  try {
    if (!isPlain(raw)) return null;
    const { outcome } = raw;
    if (outcome === 'denied') return hasExactly(raw, ['outcome']) ? 'denied' : null;
    if (outcome !== 'stores' || !hasExactly(raw, ['outcome', 'stores'])) return null;
    const { stores } = raw;
    if (!Array.isArray(stores)) return null;
    // The length is read once, so the bound checked is the bound the loop runs to.
    const count = stores.length;
    if (count > STORE_DIRECTORY_MAX_ENTRIES) return null;
    const seen = new Set<string>();
    const out: StoreDirectoryEntry[] = [];
    // inv: out holds a validated copy of each entry below i, and seen their ids; term: i rises to count.
    for (let i = 0; i < count; i++) {
      const entry: unknown = stores[i];
      if (!isPlain(entry) || !hasExactly(entry, ENTRY_KEYS)) return null;
      // Read once each, so a value validated is the value copied.
      const { id, tenantId, name, readOnly } = entry;
      if (typeof id !== 'string' || !UUID_RE.test(id) || seen.has(id)) return null;
      if (typeof tenantId !== 'string' || !UUID_RE.test(tenantId)) return null;
      if (!isServableStoreName(name) || typeof readOnly !== 'boolean') return null;
      seen.add(id);
      out.push(Object.freeze({ id, tenantId, name, readOnly }));
    }
    return inStoreDirectoryOrder(out) ? Object.freeze(out) : null;
  } catch {
    return null; // a throwing getter or proxy trap is never a list
  }
}

/** A bounded refusal in the chain's own shape: fixed error word and correlation id; the reason is logged only. */
function refuse(res: Response, ctx: RouteContext, status: number, error: string, reason: string): void {
  res.locals.refusal = reason;
  res.status(status).json({ error, requestId: ctx.requestId });
}

/** The store directory route over `ports`, for a route table; refused at construction without its port. */
export function createStoreDirectoryRoute(ports: StoreDirectoryPorts, options: { deadlineMs?: number } = {}): RouteDefinition {
  const reader = ports?.stores;
  if (typeof reader?.stores !== 'function') throw new EnforcementSetupError('route_handler_invalid');
  const deadlineMs = options.deadlineMs ?? PORT_DEADLINE_MS;
  // One more port call in the chain, bounded like the rest so the whole chain fits the socket timeout.
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > PORT_DEADLINE_MS) {
    throw new EnforcementSetupError('port_deadline_invalid');
  }
  const handler: RouteHandler = async (req, res, ctx) => {
    // No query is part of this contract: any at all, an empty one included, is refused before the port is asked.
    if ((typeof req.url === 'string' ? req.url : '').includes('?')) return refuse(res, ctx, 400, 'invalid_request', 'store_directory_query_invalid');
    // The route declares the binding, so the chain hands the key; this states it again.
    const { sessionKey } = ctx;
    if (sessionKey === null) return refuse(res, ctx, 403, 'forbidden', 'authz_context_missing');
    let raw: unknown;
    try {
      raw = await withDeadline(deadlineMs, (signal) => reader.stores(sessionKey, signal));
    } catch (err) {
      return refuse(res, ctx, 503, 'service_unavailable', outage('store_directory', err));
    }
    const stores = storeDirectoryOf(raw);
    if (stores === 'denied') return refuse(res, ctx, 403, 'forbidden', 'store_directory_denied');
    if (stores === null) return refuse(res, ctx, 503, 'service_unavailable', 'store_directory_answer_invalid');
    res.status(200).json({ stores: stores.map((s) => ({ id: s.id, tenantId: s.tenantId, name: s.name, readOnly: s.readOnly })) });
  };
  const route: RouteDefinition = {
    method: 'GET',
    path: STORE_DIRECTORY_PATH,
    // The route table's one closed authorization-free shape (routes.ts): no authorizer can decide before a store is named.
    policy: Object.freeze({ access: 'session', audience: 'tenant', authorization: null }),
    body: Object.freeze({ kind: 'none' }),
    idempotency: 'none',
    trustedContext: 'none',
    recentAuth: 'none',
    // The database derives every store from the presenting minted session, so the handler is handed its session key.
    sessionBinding: 'required',
    handler,
  };
  return Object.freeze(route);
}

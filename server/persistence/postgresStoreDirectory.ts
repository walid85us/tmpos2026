// Phase 4.0 M7b — the PostgreSQL store directory: the production adapter behind the store directory's port
// (server/runtime/storeDirectory.ts), over migration 027's session-bound read (M7B-INVOICES-P1; G-IAM, G-PERSIST).
//
// WHAT IT ASKS. For the presenting session's session key — the chain's own (RouteContext.sessionKey), a SQL parameter and
// nothing else — it calls tmpos_store_access.m7b_store_directory once, in one fixed statement on the kernel's client. The
// routine derives every store from that key inside the database (the minted, live session under the installed issuer
// key, the 016 standing it was minted at, an account whose status admits a read, and each store where that standing names
// exactly one usable store-scope grant) and answers one row per store, no row when there is none, or one 'denied' row.
// Nothing the request carried is a parameter.
//
// IT CONSTRUCTS NOTHING AND READS NOTHING. The caller hands it the transaction kernel the composition root already built —
// one client, one credential, one governed endpoint. Importing this file connects to nothing and reads no secret.
//
// FAIL CLOSED. More rows than the routine can answer, a row out of shape, a refusal beside a store row, an 'invalid' answer
// (the key's shape was checked first, so it is a fault), a store named twice, a name the route does not serve (027 answers
// such a stored name as NULL, so that check is defence in depth), rows out of the routine's order, an abort, a timeout, a
// lost connection and a driver error are all a THROW — an outage the route answers as a bounded 503 — never a list, and
// never a refusal. The runtime validates the answer again before any of it
// reaches a response. Nothing is logged: a driver error propagates without a message of this file's own.
//
// READINESS (probeStoreDirectory, the tenant entry's reads probe). It asks the same routine for a random key no session
// holds and requires its one 'denied' row with every other column null: the login's EXECUTE and USAGE, and the routine's own
// read of the session and its ledger row, answer. The routine refuses an unknown key before it reads the issuer key, the
// admission or any store, so those are not re-proved here: the issuer key and the admission are readiness checks of their
// own, and the routine's text is pinned by the startup ledger's checksum.
import { randomBytes } from 'node:crypto';
import { STORE_DIRECTORY_MAX_ENTRIES, inStoreDirectoryOrder, isServableStoreName } from '../runtime/storeDirectory.js';
import type { StoreDirectoryPort } from '../runtime/storeDirectory.js';
import type { SupervisedPgClient, TransactionBounds } from './supervisedPgClient.js';

/** One short read, cancelled by PostgreSQL itself if it overruns, like the other runtime reads. */
export const STORE_DIRECTORY_DEADLINE_MS = 3_000;
export const STORE_DIRECTORY_BOUNDS: TransactionBounds = Object.freeze({
  lock: `${Math.floor(STORE_DIRECTORY_DEADLINE_MS * 0.7)}ms`,
  statement: `${Math.floor(STORE_DIRECTORY_DEADLINE_MS * 0.9)}ms`,
  idle: `${STORE_DIRECTORY_DEADLINE_MS * 2}ms`,
});

/** The columns migration 027's routine answers with. */
const ROW_COLUMNS: readonly string[] = ['o_outcome', 'o_store_id', 'o_tenant_id', 'o_store_name', 'o_read_only'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A session key: the SHA-256 of a session identifier, unpadded base64url (sessions.ts digestOf). */
const SESSION_KEY_RE = /^[A-Za-z0-9_-]{43}$/;

/** Every fault is the same bounded message: nothing about the row, the value or the driver. */
const fault = (): Error => new Error('store directory answer invalid');

type Row = Readonly<Record<string, unknown>>;

function rowOf(value: unknown): Row {
  if (typeof value !== 'object' || value === null) throw fault();
  const keys = Object.keys(value as Record<string, unknown>);
  if (keys.length !== ROW_COLUMNS.length || !ROW_COLUMNS.every((c) => keys.includes(c))) throw fault();
  return value as Row;
}

/** The routine's rows as the port's answer; a throw for anything out of shape. */
export function storeDirectoryAnswerOf(rows: unknown): unknown {
  // The bound is checked before any row is read, so an oversized answer costs nothing to refuse.
  if (!Array.isArray(rows) || rows.length > STORE_DIRECTORY_MAX_ENTRIES) throw fault();
  const all = rows.map((row) => rowOf(row));
  const first = all[0];
  // A refusal is the routine's only row, with every other column null; only 'denied' is an answer ('invalid' is a fault).
  if (first !== undefined && first.o_outcome !== 'store') {
    if (all.length !== 1 || first.o_outcome !== 'denied') throw fault();
    if (first.o_store_id !== null || first.o_tenant_id !== null || first.o_store_name !== null || first.o_read_only !== null) throw fault();
    return Object.freeze({ outcome: 'denied' });
  }
  const seen = new Set<string>();
  const stores = all.map((row) => {
    const { o_outcome: outcome, o_store_id: id, o_tenant_id: tenantId, o_store_name: name, o_read_only: readOnly } = row;
    if (outcome !== 'store' || typeof id !== 'string' || !UUID_RE.test(id) || seen.has(id)) throw fault();
    if (typeof tenantId !== 'string' || !UUID_RE.test(tenantId)) throw fault();
    if (!isServableStoreName(name) || typeof readOnly !== 'boolean') throw fault();
    seen.add(id);
    return Object.freeze({ id, tenantId, name, readOnly });
  });
  if (!inStoreDirectoryOrder(stores)) throw fault();
  return Object.freeze({ outcome: 'stores', stores: Object.freeze(stores) });
}

/**
 * The production store directory over the M6 runtime client. `client` is the kernel the composition root already built —
 * one client, one credential, one governed endpoint.
 */
export function createPostgresStoreDirectory(deps: { readonly client: SupervisedPgClient }): StoreDirectoryPort {
  const { client } = deps;
  return Object.freeze({
    async stores(sessionKey: string, signal: AbortSignal): Promise<unknown> {
      // Refused before a statement runs: only a key of the session-key shape names a session.
      if (typeof sessionKey !== 'string' || !SESSION_KEY_RE.test(sessionKey)) throw fault();
      return client.transaction(signal, STORE_DIRECTORY_BOUNDS, async (sql) => storeDirectoryAnswerOf(
        await sql`select o_outcome, o_store_id, o_tenant_id, o_store_name, o_read_only
          from tmpos_store_access.m7b_store_directory(${sessionKey}::text)`,
      ));
    },
  });
}

/** Readiness: true only for the routine's one refusal of a random key no session holds; anything else is false. */
export async function probeStoreDirectory(client: SupervisedPgClient, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false;
  const absentKey = randomBytes(32).toString('base64url');
  try {
    return await client.transaction(signal, STORE_DIRECTORY_BOUNDS, async (sql) => {
      const rows = await sql`select o_outcome, o_store_id, o_tenant_id, o_store_name, o_read_only
        from tmpos_store_access.m7b_store_directory(${absentKey}::text)`;
      if (!Array.isArray(rows) || rows.length !== 1) return false;
      const row = rowOf(rows[0]);
      return row.o_outcome === 'denied' && row.o_store_id === null && row.o_tenant_id === null && row.o_store_name === null
        && row.o_read_only === null;
    });
  } catch {
    return false; // an outage, an abort, an overrun, a driver fault or a row out of shape: nothing is disclosed
  }
}

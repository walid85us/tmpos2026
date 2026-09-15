// Phase 4.0 M6-PG-P5 — the transactional store's pool supervisor (docs/phase-4/08 DA-15).
//
// The pinned driver (postgres 3.4.9, the latest release; no released version fixes this) can leave a pool slot
// unable to reconnect: a connection that closes in the same turn as a write it was handed keeps a stale write
// timer, so the slot's next start-up message is never sent and every later use of it waits out connect_timeout.
// Which slot, and whether, cannot be seen from outside the driver. So this client holds one pool at a time and
// retires it after any transaction that failed for a reason its body did not raise — a lost or refused
// connection, a FATAL, a failed BEGIN, COMMIT or ROLLBACK — and the next transaction opens on a fresh pool.
// A retired pool is ended with a bounded grace; no caller waits on it. Nothing is retried: the failed call fails
// exactly as it would have. A body's own failure — a server ERROR on an open connection, a refusal it raised —
// retires nothing.
import type { PgClient, PgTransaction } from './postgresTransactionalStore.js';

/** A pool as the driver builds one: transactions, and an end that closes what is still open after `timeout` s. */
export interface PgPool extends PgClient {
  end(options: { timeout: number }): Promise<unknown>;
}

export interface SupervisedPgClient extends PgClient {
  /** Retires the current pool and waits for every retiring one, each bounded; later transactions are refused. */
  end(): Promise<void>;
}

/** Seconds a retired pool's transactions still in flight may finish before their connections are closed. */
export const RETIRED_POOL_GRACE_S = 5;
/** The one message a transaction on an ended client rejects with. */
export const CLIENT_ENDED = 'transactional_store_client_ended';

export function createSupervisedPgClient(connect: () => PgPool): SupervisedPgClient {
  if (typeof connect !== 'function') throw new TypeError('createSupervisedPgClient: connect must be a function');
  let current: PgPool | null = null;
  let ended = false;
  const retired = new WeakSet<PgPool>();
  const retiring = new Set<Promise<void>>();

  const retire = (pool: PgPool): void => {
    if (current === pool) current = null;
    if (retired.has(pool)) return;
    retired.add(pool);
    const done = Promise.resolve()
      .then(() => pool.end({ timeout: RETIRED_POOL_GRACE_S }))
      .then(() => undefined, () => undefined);
    retiring.add(done);
    void done.then(() => retiring.delete(done));
  };

  return Object.freeze({
    async begin(fn: (tx: PgTransaction) => Promise<unknown>): Promise<unknown> {
      if (ended) throw new Error(CLIENT_ENDED);
      const pool = current ?? (current = connect());
      const body = { failed: false, error: undefined as unknown };
      try {
        return await pool.begin(async (tx) => {
          try {
            return await fn(tx);
          } catch (error) {
            body.failed = true;
            body.error = error;
            throw error;
          }
        });
      } catch (err) {
        if (!body.failed || body.error !== err) retire(pool);
        throw err;
      }
    },
    async end(): Promise<void> {
      ended = true;
      if (current !== null) retire(current);
      await Promise.all(retiring);
    },
  });
}

// M7A-CUSTOMERS-P3-R1 — keep a migration's own behaviour suite on the chain it was written for.
//
// Migration 020 revokes the runtime login's EXECUTE on 019's create routine and 018's page_v2 and replaces them with
// tmpos_role's routines. The suites that prove 018's and 019's own behaviour (tenantSessionMint, customerCreateRoutine)
// therefore apply the chain only THROUGH their migration: `portThrough` hides every later file from the migration file
// port the trusted executor reads, so the same executor applies exactly 001..N.
//
// On a shared disposable service (CI runs every database step against ONE database) an earlier step may already have
// applied a later migration; the executor would then refuse the ledger's unknown version. `rollBackAbove` runs each later
// migration's own committed down file (newest first, each with its ledger row, in one READ COMMITTED transaction) and
// answers a `restore` that re-applies each up file and re-inserts its exact ledger row (oldest first), so the suite leaves
// the service as it found it. A later down that refuses (020 refuses while an owner edit differs from its default) fails
// the suite loudly: it never forces a rollback. On a fresh cluster there is nothing later, and restore does nothing.
import { readFileSync, readdirSync } from 'node:fs';

const versionOf = (name) => /^(\d{3})_/.exec(name)?.[1];

/** The migration file port with every file after `through` ('NNN') hidden; every other operation is the port's own. */
export function portThrough(port, through) {
  return Object.freeze({
    ...port,
    list: () => port.list().filter((name) => { const v = versionOf(name); return v === undefined || v <= through; }),
  });
}

/**
 * Rolls back, newest first, every applied migration after `through`, through its committed down file and ledger row;
 * answers `{ rolledBack, restore }`. `owner` is a postgres.js client of the applying principal.
 */
export async function rollBackAbove(owner, migDir, through) {
  const fileOf = (v, kind) => {
    const name = readdirSync(migDir).find((f) => versionOf(f) === v && f.endsWith(`.${kind}.sql`));
    if (name === undefined) throw new Error(`migration ${v} has no ${kind} file`);
    return readFileSync(`${migDir}/${name}`, 'utf8');
  };
  const [{ ledger }] = await owner`select pg_catalog.to_regclass('public.schema_migrations') is not null as ledger`;
  const rows = !ledger ? [] : await owner`select version, checksum, dirty, started_at::text as started_at, finished_at::text as finished_at
    from public.schema_migrations where version > ${through} order by version desc`;
  for (const row of rows) {
    await owner.begin('isolation level read committed', async (tx) => {
      await tx.unsafe(fileOf(row.version, 'down')).simple();
      await tx`delete from public.schema_migrations where version = ${row.version}`;
    });
  }
  const restore = async () => {
    for (const row of [...rows].reverse()) {
      await owner.begin('isolation level read committed', async (tx) => {
        await tx.unsafe(fileOf(row.version, 'up')).simple();
        await tx`insert into public.schema_migrations (version, checksum, dirty, started_at, finished_at)
          values (${row.version}, ${row.checksum}, ${row.dirty}, ${row.started_at}::text::timestamptz, ${row.finished_at}::text::timestamptz)`;
      });
    }
  };
  return { rolledBack: rows.map((r) => r.version), restore };
}

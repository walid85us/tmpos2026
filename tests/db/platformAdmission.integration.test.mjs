// Phase 4.0 M5-GIAM-D1-P4 — durable platform-administrator admission against REAL PostgreSQL: migration 013 (one table,
// one trigger function fired by four triggers — on public.platform_identity, public.app_user, public.identity_link and
// public.user_membership — and one admission read, in its own schema), observed from the owner and from the runtime's own
// non-owner login, and the production adapter createPostgresPlatformAdmission over the same supervised client the
// composition root builds.
//
// WHAT IS PROVED HERE. The platform authority version moves by exactly one on every write to an actor's identity anchor,
// account, identity links or PLATFORM grants, and on nothing else — never on an updated_at-only write, never on the email
// or display name the provider mirrors, never on a tenant or store grant — including for a session running as a replica,
// where the updated_at triggers do not fire. It never returns to a value it has held: not when a grant or a link is
// re-inserted byte for byte, not when a provider reference is repointed and back, not when the account is deleted and
// recreated. Every assertion about a move is a DELTA read before and after the write, because creating a fixture moves the
// version too. The read answers 007's principal narrowed to its platform grants, keyed by scope and never by role id, with
// that version, in one row; every refusal is the same row. The runtime reaches none of it but the read. 013's own
// postcondition refuses each widening it names, each shown to change the one thing it names and nothing else. The
// rollback and a re-application each refuse while any administrative session exists — the only place a witness lives —
// and otherwise the rollback removes exactly what 013 created, after which a re-apply starts every counter again at zero.
//
// MIGRATION 015 (M5-ADMIN-REVOKE-P1) places one more trigger function in the same schema, fired BEFORE ROW from
// public.platform_identity (UPDATE, DELETE), public.identity_link and public.user_membership (INSERT, UPDATE), that takes
// FOR KEY SHARE on the account of each actor an anchor change or delete, or a link or grant insert or re-point, moves.
// Proved here against a transaction holding the account FOR UPDATE, as 009's command lock does: an anchor repoint, a link
// or a grant inserted for the actor or re-pointed to it, and the anchor's DELETE each WAIT for that transaction — as a
// replica too, where no foreign-key check or cascade runs — and then land; a profile update, the identity sync's upsert
// and a link re-pointed AWAY do not wait; an anchor DELETE of another actor does not, and nothing deadlocks. Every wait
// is observed through pg_blocking_pids, never assumed from elapsed time. 015's own postcondition refuses each widening it names, its rollback
// removes exactly its objects, and 013's postcondition and rollback, which predate it, are run with 015 rolled back first.
//
// DISPOSABLE ONLY. The target is whatever the harness resolves — a supplied disposable target or a cluster this file
// creates and destroys; assertDisposableTestDsn refuses anything else before a statement runs. Every fixture is synthetic and randomly
// named, so the suite re-runs on the shared CI service, where earlier suites already applied the chain and left rows of
// their own: the ledger is read rather than this run's report, and every rollback, widening and planted-row proof runs
// inside one transaction that is rolled back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { resolveDisposableTarget, testClient, testDriver } from './localPostgres.harness.mjs';
import { assertDisposableTestDsn, createPostgresExecutor, runTrustedApply } from '../../server/platform-identity/migrationExecutor.ts';
import { createNodeFsPort } from '../../server/platform-identity/migrationEngine.ts';
import { runtimeClientOptions } from '../../server/platform-identity/db.ts';
import { createSupervisedPgClient } from '../../server/persistence/supervisedPgClient.ts';
import { createPostgresPlatformAdmission } from '../../server/persistence/postgresPlatformAdmission.ts';

const MIG_REL = 'server/platform-identity/migrations';
const MIG_DIR = new URL(`../../${MIG_REL}/`, import.meta.url).pathname.replace(/\/$/, '');
const UP_013 = readFileSync(`${MIG_DIR}/013_m5_platform_admission.up.sql`, 'utf8');
const DOWN_013 = readFileSync(`${MIG_DIR}/013_m5_platform_admission.down.sql`, 'utf8');
/** 013's section 6 postcondition, run again on its own after a deliberate widening, to prove it refuses. */
const POSTCONDITION_013 = UP_013.slice(UP_013.lastIndexOf('do $$'));
const UP_015 = readFileSync(`${MIG_DIR}/015_m5_admin_standing_serialization.up.sql`, 'utf8');
const DOWN_015 = readFileSync(`${MIG_DIR}/015_m5_admin_standing_serialization.down.sql`, 'utf8');
/** 015's section 4 postcondition, run again on its own after a deliberate widening, to prove it refuses. */
const POSTCONDITION_015 = UP_015.slice(UP_015.lastIndexOf('do $$'));
const READ = 'tmpos_admission.m5_admit_platform_session(text, text)';
const MOVED = 'tmpos_admission.m5_platform_authority_moved()';
const SERIALIZE = 'tmpos_admission.m5_platform_standing_serialize()';
const TABLE = 'tmpos_admission.platform_authority_version';
const MIGRATOR = { purpose: 'migration', migratorRef: 'm5p-migrator', runtimeRef: 'm5p-runtime' };
const LOCK_KEY = 528_513;
const NOW = () => new Date().toISOString();

const RUNTIME_LOGIN = 'tmpos_m5p_probe';
const SUFFIX = randomUUID().slice(0, 8);
const signal = () => AbortSignal.timeout(10_000);

// ---------------------------------------------------------------------------
// cluster lifecycle
// ---------------------------------------------------------------------------

const TARGET = resolveDisposableTarget('M5P');
const TARGET_DSN = TARGET.dsn;
const cluster = TARGET.cluster ?? null;

assertDisposableTestDsn(TARGET_DSN);
const DATABASE = new URL(TARGET_DSN).pathname.slice(1);

/** `host`/`user` travel in client options, never the URL; a named role REPLACES the userinfo. */
function driverDsn(raw, user) {
  const url = new URL(raw);
  url.search = '';
  if (user !== undefined) { url.username = user; url.password = ''; }
  return url.toString();
}
const connect = (user, max) =>
  testClient(TARGET, { ...(user === undefined ? {} : { user }), max, onnotice: () => {} });

/** The owner: applies the migrations, writes the fixtures and observes. RLS does not restrict it. */
const owner = connect(undefined, 2);
let runtime = null;
let client = null;

test.after(async () => {
  if (client) await client.end();
  if (runtime) await runtime.end({ timeout: 5 });
  await owner.end({ timeout: 5 });
  if (cluster) cluster.stop();
});

// ---------------------------------------------------------------------------
// setup: the real chain 001-018, a real non-owner runtime login, the real adapter
// ---------------------------------------------------------------------------

await owner.unsafe(`do $$ begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;`);
await owner.unsafe(`revoke create on database "${DATABASE}" from public`);
await owner.unsafe(`revoke temporary on database "${DATABASE}" from public`);

let applyReport;
{
  const handle = await createPostgresExecutor(assertDisposableTestDsn(TARGET_DSN));
  try {
    applyReport = await runTrustedApply({
      fsPort: createNodeFsPort(MIG_DIR, MIG_REL), adapter: handle.adapter, ledger: handle.ledger, connectionMode: 'session',
      credential: MIGRATOR, lockKey: LOCK_KEY, now: NOW, deadlineMs: 180_000,
    });
  } finally {
    await handle.dispose();
  }
}

await owner.unsafe(`drop role if exists ${RUNTIME_LOGIN}`);
await owner.unsafe(`create role ${RUNTIME_LOGIN} login nosuperuser nocreatedb nocreaterole noreplication nobypassrls inherit`);
await owner.unsafe(`grant tmpos_app to ${RUNTIME_LOGIN}`);
await owner.unsafe(`grant tmpos_audit_writer to ${RUNTIME_LOGIN}`);
runtime = connect(RUNTIME_LOGIN, 2);

/** The transaction kernel over the runtime login — ONE client, as the composition root builds it. */
client = createSupervisedPgClient(testDriver(TARGET), driverDsn(TARGET_DSN, RUNTIME_LOGIN), {
  ...runtimeClientOptions(TARGET_DSN), ssl: false, max: 4, idle_timeout: 0, user: RUNTIME_LOGIN,
});
/** The real adapter over that one client — exactly what productionTransactions.ts builds. */
const admission = createPostgresPlatformAdmission({ client });

// ---------------------------------------------------------------------------
// fixtures and observers
// ---------------------------------------------------------------------------

/** A synthetic actor: an identity, an account in `status`, and the given memberships. */
async function actor(label, memberships, status = 'active') {
  const uid = `m5p-${label}-${SUFFIX}`;
  const [{ internal_user_id: id }] = await owner`
    insert into platform_identity (auth_provider, auth_provider_uid) values ('firebase', ${uid}) returning internal_user_id`;
  await owner`insert into app_user (internal_user_id, status) values (${id}, ${status})`;
  for (const m of memberships) await grant({ id }, m);
  return { id, uid, principal: Object.freeze({ authProvider: 'firebase', authProviderUid: uid }) };
}
/** One membership row for `who`, answering its id. Fully qualified: it also runs after a migration pinned the search path. */
const grant = async (who, m, sql = owner) => (await sql`insert into public.user_membership (internal_user_id, tenant_id, store_id, scope_type, role_id, status)
  values (${who.id}, ${m.tenant ?? null}, ${m.store ?? null}, ${m.scope}, ${m.role}, 'active') returning membership_id`)[0].membership_id;

const [{ tenant_id: T_HOME }] = await owner`insert into tenant (display_name) values (${`m5p-home-${SUFFIX}`}) returning tenant_id`;
const [{ store_id: STORE }] = await owner`insert into store (tenant_id, store_name) values (${T_HOME}, ${`m5p-s-${SUFFIX}`}) returning store_id`;

/** The version row as the owner sees it: decimal text, or null when the actor has none. */
const versionRow = async (who, sql = owner) =>
  (await sql`select authority_version::text as v from tmpos_admission.platform_authority_version where internal_user_id = ${who.id}`)[0]?.v ?? null;
/** 013's read, called with every argument explicit, as plain rows. */
const readAs = async (sql, provider, uid) => (await sql`select outcome, actor_id, account_status, limitation, security_version, memberships, authority_version
  from tmpos_admission.m5_admit_platform_session(${provider}::text, ${uid}::text)`).map((r) => ({ ...r }));
/** 007's own answer for the same reference — the one definition of an actor's grants 013 narrows. */
const resolveAs = async (sql, uid) => ({ ...(await sql`select outcome, actor_id, account_status, limitation, security_version, memberships
  from tmpos_identity.m5_resolve_principal('firebase'::text, ${uid}::text)`)[0] });
const REFUSED_ROW = Object.freeze({
  outcome: 'refused', actor_id: null, account_status: null, limitation: null, security_version: null, memberships: null, authority_version: null,
});

/** The four triggers 013 section 4 declares, one per table that decides an administrator's standing, in name order: each
 *  AFTER ROW on INSERT, UPDATE and DELETE (tgtype 29), enabled ALWAYS, with no column list, no WHEN, not internal. */
const DECLARED = Object.freeze([
  ['trg_app_user_platform_authority', 'public.app_user'],
  ['trg_identity_link_platform_authority', 'public.identity_link'],
  ['trg_platform_identity_platform_authority', 'public.platform_identity'],
  ['trg_user_membership_platform_authority', 'public.user_membership'],
].map(([name, relation]) => Object.freeze({ name, relation, tgtype: 29, enabled: 'A', columns: '', no_when: true, internal: false })));
/** Every trigger that calls 013's function, wherever it is, as the catalog records it, in name order. */
const versionTriggers = async (sql = owner) => (await sql`select g.tgname::text as name,
    n.nspname::text || '.' || c.relname::text as relation, g.tgtype, g.tgenabled::text as enabled,
    g.tgattr::text as columns, g.tgqual is null as no_when, g.tgisinternal as internal
  from pg_catalog.pg_trigger g
  join pg_catalog.pg_class c on c.oid = g.tgrelid
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where g.tgfoid = ${MOVED}::regprocedure order by g.tgname`).map((r) => ({ ...r }));
/** The three triggers 015 section 3 declares, in name order: BEFORE ROW INSERT or UPDATE on the link and on the grant
 *  (tgtype 23), BEFORE ROW UPDATE or DELETE on the anchor (27), each enabled ALWAYS, with no column list, no WHEN, not
 *  internal. */
const DECLARED_015 = Object.freeze([
  ['trg_identity_link_standing_serialize', 'public.identity_link', 23],
  ['trg_platform_identity_standing_serialize', 'public.platform_identity', 27],
  ['trg_user_membership_standing_serialize', 'public.user_membership', 23],
].map(([name, relation, tgtype]) => Object.freeze({ name, relation, tgtype, enabled: 'A', columns: '', no_when: true, internal: false })));
/** Every trigger that calls 015's function, wherever it is, as the catalog records it, in name order. */
const serializeTriggers = async (sql = owner) => (await sql`select g.tgname::text as name,
    n.nspname::text || '.' || c.relname::text as relation, g.tgtype, g.tgenabled::text as enabled,
    g.tgattr::text as columns, g.tgqual is null as no_when, g.tgisinternal as internal
  from pg_catalog.pg_trigger g
  join pg_catalog.pg_class c on c.oid = g.tgrelid
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where g.tgfoid = to_regprocedure(${SERIALIZE}) order by g.tgname`).map((r) => ({ ...r }));

// --- concurrency: a transaction on a connection of its own, and a wait observed in the catalog -----------------------

const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
/** Runs `body` in one owner transaction on a connection of its own, and answers at once. `pid` resolves to its backend
 *  once known — before `body` runs; `outcome` to `{ ok, value }` or `{ ok: false, code, message }` once it has ended;
 *  `settled()` says whether it has. Every lock wait is bounded by `lockTimeout`, so a wait that should not happen FAILS
 *  (55P03) instead of hanging the suite. `replica` runs it with session_replication_role = replica. */
function inTransaction(body, { lockTimeout = '10s', replica = false } = {}) {
  const sql = connect(undefined, 1);
  const pid = deferred();
  let settled = false;
  const outcome = sql.begin(async (tx) => {
    await tx`select pg_catalog.set_config('lock_timeout', ${lockTimeout}, true)`;
    if (replica) {
      await tx`set local session_replication_role = replica`.catch((err) => {
        throw new Error(`M5P needs an owner that may set session_replication_role, and this one may not: ${err.message}`);
      });
    }
    pid.resolve((await tx`select pg_catalog.pg_backend_pid() as pid`)[0].pid);
    return body(tx);
  }).then((value) => ({ ok: true, value }), (err) => ({ ok: false, code: err.code ?? null, message: String(err.message) }))
    .then(async (result) => { settled = true; await sql.end({ timeout: 5 }); return result; });
  return { pid: pid.promise, outcome, settled: () => settled };
}
/** Takes `lock(tx)`'s row locks in a transaction of its own and holds them, open, until `release()` commits it. Answers
 *  once the locks are taken, with the lock statement's answer; a holder that fails first fails the test. */
async function holding(lock) {
  const taken = deferred();
  const release = deferred();
  const run = inTransaction(async (tx) => { taken.resolve(await lock(tx)); await release.promise; });
  const first = await Promise.race([taken.promise.then((answer) => ({ answer })), run.outcome.then((failed) => ({ failed }))]);
  if ('failed' in first) throw new Error(`M5P: the holder ended before its locks were taken: ${JSON.stringify(first.failed)}`);
  return {
    pid: await run.pid, answer: first.answer, settled: run.settled,
    release: () => { release.resolve(); return run.outcome; },
  };
}
/** 009's account lock and nothing more — the stand-in for a command or login holding the actor's account. */
const holdAccount = (who) => holding((tx) => tx`select 1 from public.app_user where internal_user_id = ${who.id} for update`);
/** Whether backend `waiter` is blocked by backend `holder` — that one — polled until it is, until `ended()`, or for `ms`. */
async function blockedBy(waiter, holder, ended, ms = 10_000) {
  const until = performance.now() + ms;
  while (performance.now() < until && !ended()) {
    const [{ blocked }] = await owner`select ${holder}::int = any (pg_catalog.pg_blocking_pids(${waiter}::int)) as blocked`;
    if (blocked) return true;
    await sleep(5);
  }
  return false;
}
/** A supabase anchor, the other side every link must name. */
const supabaseAnchor = async (label) => {
  const uid = `m5p-${label}-sb-${SUFFIX}`;
  await owner`insert into public.platform_identity (auth_provider, auth_provider_uid) values ('supabase', ${uid})`;
  return uid;
};
/** One active link of `who`, from its own firebase reference to a new supabase anchor; answers the link id. */
const linkOf = async (who, label) => (await owner`insert into public.identity_link (internal_user_id, firebase_auth_provider_uid,
  supabase_auth_provider_uid) values (${who.id}, ${who.uid}, ${await supabaseAnchor(label)}) returning link_id`)[0].link_id;

/** The statement's refusal, caught inside a savepoint so the surrounding transaction survives: {code, message}, or null. */
const refusalIn = (tx) => async (fn) => {
  try { await tx.savepoint(fn); return null; } catch (err) { return { code: err.code ?? null, message: String(err.message) }; }
};
const ROLLBACK = new Error('m5p: roll the proof back');
/** Runs `fn` in one owner transaction that is ALWAYS rolled back, so a shared database keeps its state. */
async function rolledBack(fn) {
  await assert.rejects(owner.begin(async (tx) => { await fn(tx); throw ROLLBACK; }), (err) => err === ROLLBACK);
}

// ---------------------------------------------------------------------------
// migration 013 as applied
// ---------------------------------------------------------------------------

test('M5P-01: 001-029 apply clean; tmpos_admission is three definer routines and one RLS table, and the triggers are exactly the four 013 declares and the three 015 declares', async () => {
  // The LEDGER, not this run's report: on the shared CI service an earlier suite has already applied the chain, so this
  // run applies nothing and its report lists no version.
  assert.equal(applyReport.outcome, 'complete', JSON.stringify(applyReport).slice(0, 400));
  const ledger = await owner`select version, dirty from public.schema_migrations order by version`;
  assert.deepEqual(ledger.map((r) => [r.version, r.dirty]),
    ['001', '002', '003', '004', '005', '006', '007', '008', '009', '010', '011', '012', '013', '014', '015', '016', '017', '018', '019', '020', '021', '022', '023', '024', '025', '026', '027', '028', '029'].map((v) => [v, false]));

  const routines = await owner`select p.proname::text as name, p.prosecdef, p.provolatile::text as volatility, p.proconfig,
      p.prorettype::regtype::text as returns, p.proowner = n.nspowner as schema_owner
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'tmpos_admission' order by p.proname`;
  assert.deepEqual(routines.map((r) => ({ ...r })), [
    { name: 'm5_admit_platform_session', prosecdef: true, volatility: 's', proconfig: ['search_path=pg_catalog, pg_temp'], returns: 'record', schema_owner: true },
    { name: 'm5_platform_authority_moved', prosecdef: true, volatility: 'v', proconfig: ['search_path=pg_catalog, pg_temp'], returns: 'trigger', schema_owner: true },
    // 015's serialization trigger function: volatile, because it takes row locks.
    { name: 'm5_platform_standing_serialize', prosecdef: true, volatility: 'v', proconfig: ['search_path=pg_catalog, pg_temp'], returns: 'trigger', schema_owner: true },
  ]);
  // One table (and its primary-key index), nothing else: no view, no sequence, no second table.
  const relations = await owner`select c.relname::text as name, c.relkind::text as kind
    from pg_catalog.pg_class c where c.relnamespace = 'tmpos_admission'::regnamespace order by c.relname`;
  assert.deepEqual(relations.map((r) => [r.name, r.kind]),
    [['platform_authority_version', 'r'], ['platform_authority_version_pkey', 'i']]);
  // No foreign key: the counter outlives the account it counts (M5P-04 shows why that matters).
  const constraints = await owner`select conname::text as name, contype::text as kind from pg_catalog.pg_constraint
    where conrelid = ${TABLE}::regclass order by conname`;
  assert.deepEqual(constraints.map((r) => [r.name, r.kind]),
    [['platform_authority_version_pkey', 'p'], ['platform_authority_version_range_chk', 'c']]);
  const [rls] = await owner`select relrowsecurity, relforcerowsecurity from pg_catalog.pg_class where oid = ${TABLE}::regclass`;
  assert.deepEqual({ ...rls }, { relrowsecurity: true, relforcerowsecurity: false }, 'row security on, not forced on the owner the routines run as');

  // Exactly four triggers call the function, one on each table that decides an administrator's standing, each AFTER ROW
  // on INSERT, UPDATE and DELETE (29), enabled ALWAYS, with no column list and no WHEN condition — and no fifth, on any
  // table, calls it.
  assert.deepEqual(await versionTriggers(), DECLARED);
  // And exactly three call 015's function: BEFORE ROW UPDATE or DELETE on the anchor, BEFORE ROW INSERT or UPDATE on the
  // link and on the grant — none on public.app_user — each enabled ALWAYS, with no column list and no WHEN.
  assert.deepEqual(await serializeTriggers(), DECLARED_015);

  // The range bound refuses a value outside 1..2^53-1 rather than storing one the runtime could not round-trip.
  await rolledBack(async (tx) => {
    const code = refusalIn(tx);
    const put = (v) => (sp) => sp`insert into tmpos_admission.platform_authority_version values (${randomUUID()}::uuid, ${v}::bigint)`;
    assert.equal((await code(put('0')))?.code, '23514', 'zero is refused');
    assert.equal((await code(put('9007199254740992')))?.code, '23514', '2^53 is refused');
    assert.equal(await code(put('9007199254740991')), null, '2^53-1 is the largest stored');
  });
});

test('M5P-02: from the runtime login the table and the trigger function are unreachable, the read alone answers, and no runtime role owns anything', async () => {
  const id = randomUUID();
  for (const statement of [
    'select count(*) from tmpos_admission.platform_authority_version',
    `insert into tmpos_admission.platform_authority_version values ('${id}', 1)`,
    'update tmpos_admission.platform_authority_version set authority_version = authority_version + 1',
    'delete from tmpos_admission.platform_authority_version',
    'truncate tmpos_admission.platform_authority_version',
  ]) {
    const code = await runtime.unsafe(statement).then(() => null, (err) => err.code);
    assert.equal(code, '42501', `the runtime role is refused: ${statement}`);
  }
  // The trigger function is granted to nobody: the runtime is refused its EXECUTE, and even the owner, who holds it,
  // cannot invoke it outside a trigger — it can be reached by writing one of the four tables it watches and in no other way.
  assert.equal(await runtime.unsafe(`select ${MOVED}`).then(() => null, (err) => err.code), '42501');
  assert.equal(await owner.unsafe('select tmpos_admission.m5_platform_authority_moved()').then(() => null, (err) => err.code), '0A000');
  // 015's function likewise: refused to the runtime, uncallable outside a trigger even by the owner, and its ACL holds the
  // owner's own entry and nothing else — no PUBLIC, no runtime role.
  assert.equal(await runtime.unsafe(`select ${SERIALIZE}`).then(() => null, (err) => err.code), '42501');
  assert.equal(await owner.unsafe(`select ${SERIALIZE}`).then(() => null, (err) => err.code), '0A000');
  const acl = await owner`select g.grantee = p.proowner as is_owner, g.privilege_type
    from pg_catalog.pg_proc p, pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g
    where p.oid = ${SERIALIZE}::regprocedure`;
  assert.deepEqual(acl.map((r) => ({ ...r })), [{ is_owner: true, privilege_type: 'EXECUTE' }], 'EXECUTE for the owner alone');
  const [{ public_execute: publicExecute }] = await owner`select pg_catalog.has_function_privilege('public', ${SERIALIZE}::regprocedure, 'EXECUTE') as public_execute`;
  assert.equal(publicExecute, false, 'PUBLIC cannot execute it');
  // The one thing the runtime may call.
  assert.deepEqual(await readAs(runtime, 'firebase', `m5p-nobody-${SUFFIX}`), [REFUSED_ROW]);

  const roles = ['tmpos_app', 'tmpos_audit_writer', 'anon', 'authenticated', RUNTIME_LOGIN];
  const privileges = await owner`select r.rolname::text as role,
      pg_catalog.has_table_privilege(r.oid, ${TABLE}::regclass, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') as on_table,
      pg_catalog.has_any_column_privilege(r.oid, ${TABLE}::regclass, 'SELECT, INSERT, UPDATE, REFERENCES') as on_column,
      pg_catalog.has_function_privilege(r.oid, ${MOVED}::regprocedure, 'EXECUTE') as on_trigger_fn,
      pg_catalog.has_function_privilege(r.oid, ${SERIALIZE}::regprocedure, 'EXECUTE') as on_serialize_fn,
      pg_catalog.has_function_privilege(r.oid, ${READ}::regprocedure, 'EXECUTE') as on_read,
      pg_catalog.has_schema_privilege(r.oid, 'tmpos_admission', 'USAGE') as usage,
      pg_catalog.has_schema_privilege(r.oid, 'tmpos_admission', 'CREATE') as create_in
    from pg_catalog.pg_roles r where r.rolname = any (${roles}::name[]) order by r.rolname`;
  const runtimeSide = (role) => role === 'tmpos_app' || role === RUNTIME_LOGIN;
  assert.deepEqual(privileges.map((r) => ({ ...r })), [...roles].sort().map((role) => ({
    role, on_table: false, on_column: false, on_trigger_fn: false, on_serialize_fn: false, on_read: runtimeSide(role), usage: runtimeSide(role), create_in: false,
  })));
  // Membership of an owner would hand a role everything the owner holds, a direct write of every version included.
  const members = await owner`select distinct r.rolname::text as role
    from pg_catalog.pg_roles r
    cross join (
      select n.nspowner as owner from pg_catalog.pg_namespace n where n.nspname = 'tmpos_admission'
      union select c.relowner from pg_catalog.pg_class c where c.oid = ${TABLE}::regclass
      union select p.proowner from pg_catalog.pg_proc p where p.pronamespace = 'tmpos_admission'::regnamespace
    ) o
    where r.rolname = any (${roles}::name[]) and pg_catalog.pg_has_role(r.oid, o.owner, 'MEMBER')`;
  assert.deepEqual(members.map((r) => r.role), [], 'no runtime role is a member of any owner');
});

test('M5P-03: 013\'s own postcondition refuses every widening it names, each proved in its own rolled-back transaction', async () => {
  // 013's postcondition is a snapshot of the schema as 013 left it — two routines — so each proof first rolls 015 back
  // through 015's own rollback, inside the same rolled-back transaction, and judges 013's state alone.
  const NOT_THE_FOUR = /the version triggers are not exactly the four section 4 declares/;
  /** DECLARED with one trigger's catalog row changed — what a widening that alters exactly that property leaves. */
  const but = (name, change) => DECLARED.map((t) => (t.name === name ? { ...t, ...change } : t));
  const [{ n: STATUS }] = await owner`select attnum::text as n from pg_catalog.pg_attribute
    where attrelid = 'public.app_user'::regclass and attname = 'status'`;
  /** A replacement for app_user's trigger under the same name, enabled ALWAYS, differing from it only in `events` or `when`. */
  const replaced = (events, when) => `drop trigger trg_app_user_platform_authority on public.app_user;
    create trigger trg_app_user_platform_authority after ${events} on public.app_user for each row ${when}
      execute function ${MOVED};
    alter table public.app_user enable always trigger trg_app_user_platform_authority`;
  // Each case states the exact trigger inventory it leaves, so a refusal can only be for the one property it changed —
  // never for a side effect of how the widening was written (a replacement left enabled ORIGIN, say).
  for (const [label, widen, refusal, leaves] of [
    ['SELECT on the version table to tmpos_app', `grant select on table ${TABLE} to tmpos_app`,
      /platform_authority_version carries a direct grant \(table tmpos_app:SELECT\)/, DECLARED],
    ['EXECUTE on the trigger function to tmpos_app', `grant execute on function ${MOVED} to tmpos_app`,
      /unexpected direct grant remains on a routine \(m5_platform_authority_moved tmpos_app:EXECUTE\)/, DECLARED],
    ['EXECUTE on the read WITH GRANT OPTION', `grant execute on function ${READ} to tmpos_app with grant option`,
      /unexpected direct grant remains on a routine \(m5_admit_platform_session tmpos_app:EXECUTE\)/, DECLARED],
    ['a fifth trigger calling the function, itself shaped exactly like the four', `create trigger m5p_fifth
      after insert or update or delete on public.app_user for each row execute function ${MOVED};
      alter table public.app_user enable always trigger m5p_fifth`, NOT_THE_FOUR,
      [{ ...DECLARED[0], name: 'm5p_fifth' }, ...DECLARED]],
    ['one of the four disabled', 'alter table public.identity_link disable trigger trg_identity_link_platform_authority',
      NOT_THE_FOUR, but('trg_identity_link_platform_authority', { enabled: 'D' })],
    ['one of the four enabled for origin sessions only — what a plain ENABLE restores',
      'alter table public.user_membership enable trigger trg_user_membership_platform_authority',
      NOT_THE_FOUR, but('trg_user_membership_platform_authority', { enabled: 'O' })],
    ['one of the four enabled for replicas only', 'alter table public.user_membership enable replica trigger trg_user_membership_platform_authority',
      NOT_THE_FOUR, but('trg_user_membership_platform_authority', { enabled: 'R' })],
    ['one of the four dropped', 'drop trigger trg_platform_identity_platform_authority on public.platform_identity',
      NOT_THE_FOUR, DECLARED.filter((t) => t.name !== 'trg_platform_identity_platform_authority')],
    ['one of the four replaced by one with a WHEN condition — here the one that would skip replica sessions',
      replaced('insert or update or delete', `when (pg_catalog.current_setting('session_replication_role') <> 'replica')`),
      NOT_THE_FOUR, but('trg_app_user_platform_authority', { no_when: false })],
    ['one of the four replaced by one with a column list (UPDATE OF status)', replaced('insert or update of status or delete', ''),
      NOT_THE_FOUR, but('trg_app_user_platform_authority', { columns: STATUS })],
  ]) {
    await rolledBack(async (tx) => {
      await tx.unsafe(DOWN_015).simple();
      await tx.unsafe(widen).simple();
      assert.deepEqual(await versionTriggers(tx), leaves, `${label}: the widening changes that one property and nothing else`);
      const refused = await refusalIn(tx)((sp) => sp.unsafe(POSTCONDITION_013).simple());
      assert.equal(refused?.code, '55000', `the postcondition refuses ${label}`);
      assert.match(refused.message, refusal, label);
    });
  }
  // Control: over the state 013 left, its postcondition holds.
  await rolledBack(async (tx) => {
    await tx.unsafe(DOWN_015).simple();
    assert.equal(await refusalIn(tx)((sp) => sp.unsafe(POSTCONDITION_013).simple()), null);
  });
});

// ---------------------------------------------------------------------------
// what moves the version, and what never does
// ---------------------------------------------------------------------------

test('M5P-04: each write to an actor\'s anchor, account, links or PLATFORM grants moves its version by exactly one — nothing else does, not even as a replica, and it never decreases', async () => {
  /** Every [actor, version] this test observes, in order: along it, no actor's version may ever fall. */
  const trail = [];
  /** The actor's version as a number — 0 while it has no row, as the read reports it — recorded on the trail. */
  const versionOf = async (who) => {
    const v = Number((await versionRow(who)) ?? '0');
    trail.push([who.id, v]);
    return v;
  };
  /** Runs `write`, then asserts it moved each listed actor's version by exactly the amount paired with it. DELTAS only:
   *  creating a fixture moves the version too, so no absolute value is ever assumed. */
  const moves = async (label, write, ...expected) => {
    const before = [];
    for (const [who] of expected) before.push(await versionOf(who));
    await write();
    const moved = [];
    for (const [i, [who]] of expected.entries()) moved.push((await versionOf(who)) - before[i]);
    assert.deepEqual(moved, expected.map(([, by]) => by), label);
  };

  // --- public.platform_identity: the ANCHOR. Its id is chosen here, so its version is read before the row exists.
  const A = { id: randomUUID(), uid: `m5p-mover-${SUFFIX}` };
  await moves('the anchor INSERTed: +1, and the insert succeeds', () => owner`insert into platform_identity
    (internal_user_id, auth_provider, auth_provider_uid) values (${A.id}, 'firebase', ${A.uid})`, [A, 1]);
  // Repointed to another uid and back, the row ends as it began but for updated_at, and 007's security version does not
  // cover the anchor at all. Done before any link names this reference: 004's link foreign key would refuse the repoint.
  await moves('the provider reference repointed and back: +2', async () => {
    await owner`update platform_identity set auth_provider_uid = ${`${A.uid}-elsewhere`} where internal_user_id = ${A.id}`;
    await owner`update platform_identity set auth_provider_uid = ${A.uid} where internal_user_id = ${A.id}`;
  }, [A, 2]);
  await moves('the email and display name the identity sync mirrors from the provider: 0', async () => {
    await owner`update platform_identity set email = ${`m5p-${SUFFIX}@example.test`} where internal_user_id = ${A.id}`;
    await owner`update platform_identity set display_name = 'M5P mover' where internal_user_id = ${A.id}`;
  }, [A, 0]);
  await moves('an anchor write that changes nothing but updated_at: 0',
    () => owner`update platform_identity set updated_at = updated_at where internal_user_id = ${A.id}`, [A, 0]);

  // --- public.app_user: the ACCOUNT. Every column but updated_at counts here, unlike on the anchor.
  await moves('the account INSERTed: +1, and the insert succeeds',
    () => owner`insert into app_user (internal_user_id, status) values (${A.id}, 'active')`, [A, 1]);
  await moves('the account suspended and restored: +2', async () => {
    await owner`update app_user set status = 'suspended' where internal_user_id = ${A.id}`;
    await owner`update app_user set status = 'active' where internal_user_id = ${A.id}`;
  }, [A, 2]);
  await moves('the account\'s display name: +1',
    () => owner`update app_user set display_name = 'M5P mover' where internal_user_id = ${A.id}`, [A, 1]);
  const accountStamp = async () => (await owner`select updated_at::text as at from app_user where internal_user_id = ${A.id}`)[0].at;
  const stamped = await accountStamp();
  await moves('an account write that changes nothing but updated_at: 0',
    () => owner`update app_user set status = status where internal_user_id = ${A.id}`, [A, 0]);
  assert.notEqual(await accountStamp(), stamped, '002\'s trigger did move updated_at');
  // As a replica, 002's updated_at trigger does not fire, so the same round trip leaves the account row byte for byte as it
  // was, and 007's digest cannot see it. The version triggers are enabled ALWAYS and count it anyway. The owner must be able
  // to take the replica role; if it cannot, this proof is not made and the test FAILS rather than skipping it.
  const account = async () => (await owner`select pg_catalog.row_to_json(u)::text as row from app_user u where internal_user_id = ${A.id}`)[0].row;
  const asItWas = await account();
  await moves('the same round trip as a replica: still +2', () => owner.begin(async (tx) => {
    await tx`set local session_replication_role = replica`.catch((err) => {
      throw new Error(`M5P-04 needs an owner that may set session_replication_role, and this one may not: ${err.message}`);
    });
    assert.equal((await tx`select pg_catalog.current_setting('session_replication_role') as mode`)[0].mode, 'replica');
    await tx`update app_user set status = 'suspended' where internal_user_id = ${A.id}`;
    await tx`update app_user set status = 'active' where internal_user_id = ${A.id}`;
  }), [A, 2]);
  assert.equal(await account(), asItWas, 'the account row is exactly as it was, updated_at included');

  // --- public.identity_link: a LINK. Its Supabase side must name a real platform_identity row — another anchor, whose own
  // version that insert moves, not this actor's.
  const supabaseUid = `m5p-mover-sb-${SUFFIX}`;
  await moves('another anchor INSERTed moves nothing of this actor',
    () => owner`insert into platform_identity (auth_provider, auth_provider_uid) values ('supabase', ${supabaseUid})`, [A, 0]);
  let link;
  await moves('a link INSERTed: +1, and the insert succeeds', async () => {
    link = (await owner`insert into identity_link (internal_user_id, firebase_auth_provider_uid, supabase_auth_provider_uid)
      values (${A.id}, ${A.uid}, ${supabaseUid}) returning link_id`)[0].link_id;
  }, [A, 1]);
  await moves('the link disabled — one UPDATE of two columns is one write: +1',
    () => owner`update identity_link set status = 'disabled', disabled_at = now() where link_id = ${link}`, [A, 1]);
  // Exported as jsonb text, so the timestamps keep their microseconds (a JavaScript Date would round them to milliseconds).
  const exportLink = async () => (await owner`select pg_catalog.to_jsonb(l)::text as row from identity_link l where link_id = ${link}`)[0]?.row;
  const linkRow = await exportLink();
  await moves('the link deleted and its exported row re-inserted exactly: +2', async () => {
    await owner`delete from identity_link where link_id = ${link}`;
    await owner`insert into identity_link select * from pg_catalog.jsonb_populate_record(null::public.identity_link, ${linkRow}::text::jsonb)`;
  }, [A, 2]);
  assert.equal(await exportLink(), linkRow, 'the link is restored byte for byte, updated_at included');

  // --- public.user_membership: a GRANT, which counts only when it is at PLATFORM scope on one side of the write.
  let m;
  await moves('a platform grant INSERTed: +1, and the insert succeeds',
    async () => { m = await grant(A, { scope: 'platform', role: 'system_owner' }); }, [A, 1]);
  const grantStamp = async () => (await owner`select updated_at::text as at from user_membership where membership_id = ${m}`)[0].at;
  const granted = await grantStamp();
  await moves('a grant write that changes nothing but updated_at signs nobody out: 0', async () => {
    await owner`update user_membership set status = status where membership_id = ${m}`;
    await owner`update user_membership set updated_at = updated_at where membership_id = ${m}`;
  }, [A, 0]);
  assert.notEqual(await grantStamp(), granted, '002\'s trigger did move updated_at');
  await moves('disabled: +1', () => owner`update user_membership set status = 'suspended' where membership_id = ${m}`, [A, 1]);
  await moves('re-enabled — the same membership id and role as before, yet a new version: +1',
    () => owner`update user_membership set status = 'active' where membership_id = ${m}`, [A, 1]);
  await moves('re-roled: +1', () => owner`update user_membership set role_id = 'support_admin' where membership_id = ${m}`, [A, 1]);

  // Tenant- and store-scope grants of the SAME actor never move it: a tenant-plane change ends no administrative session.
  await moves('tenant- and store-scope inserts, updates (a tenant grant re-roled among them) and deletes: 0', async () => {
    const t = await grant(A, { scope: 'tenant', tenant: T_HOME, role: 'manager' });
    await owner`update user_membership set role_id = 'technician' where membership_id = ${t}`;
    await owner`update user_membership set status = 'suspended' where membership_id = ${t}`;
    await owner`delete from user_membership where membership_id = ${t}`;
    const s = await grant(A, { scope: 'store', tenant: T_HOME, store: STORE, role: 'technician' });
    await owner`update user_membership set role_id = 'sales_staff' where membership_id = ${s}`;
    await owner`delete from user_membership where membership_id = ${s}`;
  }, [A, 0]);

  // Re-scoped either way: the side that was, or becomes, a platform grant counts.
  await moves('re-scoped from platform to tenant: +1', () => owner`update user_membership
    set scope_type = 'tenant', tenant_id = ${T_HOME}, role_id = 'manager' where membership_id = ${m}`, [A, 1]);
  await moves('re-scoped from tenant to platform: +1', () => owner`update user_membership
    set scope_type = 'platform', tenant_id = null, role_id = 'support_admin' where membership_id = ${m}`, [A, 1]);

  // The most natural "restore": export the row, delete it, insert it again with every value it had. The row is
  // byte-identical — membership id, created_at and updated_at included — and the version is still new.
  const exportGrant = async () => (await owner`select pg_catalog.to_jsonb(g)::text as row from user_membership g where membership_id = ${m}`)[0]?.row;
  const grantRow = await exportGrant();
  await moves('removed: +1', () => owner`delete from user_membership where membership_id = ${m}`, [A, 1]);
  await moves('the exported row re-inserted exactly: +1', () => owner`insert into user_membership
    select * from pg_catalog.jsonb_populate_record(null::public.user_membership, ${grantRow}::text::jsonb)`, [A, 1]);
  assert.equal(await exportGrant(), grantRow, 'the grant is restored byte for byte');

  // Moved to another actor: both actors' standing changed, and each moves exactly once.
  const B = await actor('receiver', []);
  await moves('moved from one actor to another: each +1',
    () => owner`update user_membership set internal_user_id = ${B.id} where membership_id = ${m}`, [A, 1], [B, 1]);

  // The whole account deleted from its anchor: the cascade takes the account and the link, each table's trigger fires for
  // its own row, and so the version moves several times — only that it ROSE matters. The row outlives the account (013
  // gives it no foreign key), and an anchor recreated under the same id continues from there: an old witness is never met
  // again.
  const beforeDelete = await versionOf(A);
  await owner`delete from platform_identity where internal_user_id = ${A.id}`;
  const [{ account_rows: accountRows, link_rows: linkRows }] = await owner`select
    (select pg_catalog.count(*)::int from app_user where internal_user_id = ${A.id}) as account_rows,
    (select pg_catalog.count(*)::int from identity_link where internal_user_id = ${A.id}) as link_rows`;
  assert.deepEqual([accountRows, linkRows], [0, 0], 'the cascade took the account and the link');
  assert.notEqual(await versionRow(A), null, 'the version row remains');
  assert.ok((await versionOf(A)) > beforeDelete, 'and it only increased');
  await moves('the anchor recreated under the same id: +1 from where it stood, never back to 1', () => owner`insert into platform_identity
    (internal_user_id, auth_provider, auth_provider_uid) values (${A.id}, 'firebase', ${A.uid})`, [A, 1]);

  // An actor 013 has never seen written — any account provisioned before it was applied — has no row, and the read reports
  // 0 for it. Planted by removing a resolvable actor's row inside a transaction that is rolled back.
  await rolledBack(async (tx) => {
    await tx`delete from tmpos_admission.platform_authority_version where internal_user_id = ${B.id}`;
    assert.equal(await versionRow(B, tx), null);
    assert.equal((await readAs(tx, 'firebase', B.uid))[0].authority_version, '0', 'no row reads as 0');
  });
  // Otherwise the read reports what the table holds.
  assert.equal((await readAs(runtime, 'firebase', B.uid))[0].authority_version, String(await versionOf(B)));

  for (const id of new Set(trail.map(([who]) => who))) {
    const seen = trail.filter(([who]) => who === id).map(([, v]) => v);
    assert.deepEqual(seen, [...seen].sort((x, y) => x - y), 'along the whole trail, no version ever decreased');
  }
});

// ---------------------------------------------------------------------------
// the read
// ---------------------------------------------------------------------------

test('M5P-05: the read answers 007\'s principal narrowed to its PLATFORM grants and the table\'s version, and every refusal is one row', async () => {
  // Refused identically — a reference naming nobody, a provider 007 does not admit, a denied account — as the runtime sees it.
  const denied = await actor('denied', [{ scope: 'platform', role: 'system_owner' }], 'suspended');
  for (const [label, provider, uid] of [['an unknown reference', 'firebase', `m5p-nobody-${SUFFIX}`],
    ['an unknown provider naming a real reference', 'github', denied.uid], ['a suspended account', 'firebase', denied.uid]]) {
    assert.deepEqual(await readAs(runtime, provider, uid), [REFUSED_ROW], label);
  }

  // Only the platform grants of an actor who also holds a tenant and a store grant, in 007's own entry shape. Creating the
  // actor moved its version (anchor, account, platform grant); the tenant and store grants added after it move nothing.
  const mixed = await actor('mixed', [{ scope: 'platform', role: 'billing_admin' }]);
  const created = await versionRow(mixed);
  await grant(mixed, { scope: 'tenant', tenant: T_HOME, role: 'store_owner' });
  await grant(mixed, { scope: 'store', tenant: T_HOME, store: STORE, role: 'manager' });
  assert.equal(await versionRow(mixed), created, 'its tenant and store grants moved nothing');
  const resolved = await resolveAs(runtime, mixed.uid);
  assert.equal(resolved.memberships.length, 3, '007 reports all three');
  const [row] = await readAs(runtime, 'firebase', mixed.uid);
  assert.deepEqual(row, {
    outcome: 'resolved', actor_id: mixed.id, account_status: 'active', limitation: 'none', security_version: resolved.security_version,
    memberships: resolved.memberships.filter((g) => g.scopeType === 'platform'), authority_version: created,
  });
  assert.equal(row.memberships.length, 1);

  // Two platform grants are both reported, in membership-id order; which one admits is decided in trusted source.
  const two = await actor('two', [{ scope: 'platform', role: 'system_owner' }, { scope: 'platform', role: 'support_admin' }]);
  const ids = (await owner`select membership_id from user_membership where internal_user_id = ${two.id} order by membership_id`).map((r) => r.membership_id);
  const [both] = await readAs(runtime, 'firebase', two.uid);
  assert.deepEqual(both.memberships.map((g) => [g.membershipId, g.scopeType]), ids.map((id) => [id, 'platform']));
  assert.equal(both.authority_version, await versionRow(two), 'the read reports the table');

  // The narrowing is by SCOPE, never by role id. A tenant-scope grant carrying a platform role id is impossible under 003's
  // CHECK, so the CHECK is dropped inside a rolled-back transaction to plant one: 007 reports it, and 013 does not.
  await rolledBack(async (tx) => {
    await tx`alter table public.user_membership drop constraint user_membership_role_scope_chk`;
    const [before] = await readAs(tx, 'firebase', mixed.uid);
    await grant(mixed, { scope: 'tenant', tenant: T_HOME, role: 'system_owner' }, tx);
    const planted = (await resolveAs(tx, mixed.uid)).memberships.filter((g) => g.roleId === 'system_owner');
    assert.deepEqual(planted.map((g) => [g.scopeType, g.tenantId]), [['tenant', T_HOME]], '007 reports the planted grant');
    const [after] = await readAs(tx, 'firebase', mixed.uid);
    assert.deepEqual(after.memberships, before.memberships, 'and 013 does not: it is not a platform grant');
    assert.equal(after.authority_version, before.authority_version, 'nor did it move the version');
  });
});

// ---------------------------------------------------------------------------
// the adapter over the runtime client
// ---------------------------------------------------------------------------

test('M5P-06: the adapter reports what the read says, decides nothing, and answers unavailable — never refused — when it cannot read', async () => {
  const admin = await actor('admin', [{ scope: 'platform', role: 'system_owner' }]);
  const tenantOnly = await actor('tenant-only', [{ scope: 'tenant', tenant: T_HOME, role: 'store_owner' }]);
  const suspended = await actor('suspended', [{ scope: 'platform', role: 'system_owner' }], 'suspended');
  const [{ membership_id: membershipId }] = await owner`select membership_id from user_membership where internal_user_id = ${admin.id}`;
  const { security_version: securityVersion } = await resolveAs(owner, admin.uid);
  const expected = {
    outcome: 'resolved',
    principal: {
      actor: admin.id, accountStatus: 'active', limitation: 'none', securityVersion,
      memberships: [{ membershipId, scopeType: 'platform', roleId: 'system_owner', tenant: null, store: null, tenantStatus: null, storeStatus: null }],
    },
    // The table's value, whatever creating the fixture moved it to: the adapter carries it through unparsed.
    authorityVersion: await versionRow(admin),
  };
  const answer = await admission.admit(admin.principal, signal());
  assert.deepEqual(answer, expected);
  assert.ok(Object.isFrozen(answer) && Object.isFrozen(answer.principal) && Object.isFrozen(answer.principal.memberships)
    && Object.isFrozen(answer.principal.memberships[0]), 'nothing it answers can be edited by its caller');
  // No platform grant is still a resolution: the policy that refuses it lives in trusted source, not here.
  assert.deepEqual(await admission.admit(tenantOnly.principal, signal()), {
    outcome: 'resolved',
    principal: { actor: tenantOnly.id, accountStatus: 'active', limitation: 'none', securityVersion: (await resolveAs(owner, tenantOnly.uid)).security_version, memberships: [] },
    authorityVersion: await versionRow(tenantOnly),
  });
  for (const [label, principal] of [['a reference naming nobody', { authProvider: 'firebase', authProviderUid: `m5p-nobody-${SUFFIX}` }],
    ['a suspended account', suspended.principal], ['an unknown provider', { authProvider: 'github', authProviderUid: admin.uid }],
    ['an over-long reference', { authProvider: 'firebase', authProviderUid: 'x'.repeat(256) }]]) {
    assert.deepEqual(await admission.admit(principal, signal()), { outcome: 'refused' }, label);
  }
  assert.equal(await admission.probe(signal()), true, 'readiness runs the read end to end');
  assert.deepEqual(await admission.admit(admin.principal, AbortSignal.abort()), { outcome: 'unavailable' }, 'an aborted call reads nothing');

  // The read made unreachable — the state a rollback of 013 leaves too. An outage revokes nothing, so it must never read
  // as a refusal: the boundary ends every session a principal holds on a refusal.
  await owner.unsafe(`revoke execute on function ${READ} from tmpos_app`);
  try {
    assert.deepEqual(await admission.admit(admin.principal, signal()), { outcome: 'unavailable' });
    assert.deepEqual(await admission.admit({ authProvider: 'firebase', authProviderUid: `m5p-nobody-${SUFFIX}` }, signal()), { outcome: 'unavailable' },
      'not even a reference naming nobody is answered as refused');
    assert.equal(await admission.probe(signal()), false, 'and readiness says so');
  } finally {
    await owner.unsafe(`grant execute on function ${READ} to tmpos_app`);
  }
  assert.deepEqual(await admission.admit(admin.principal, signal()), expected, 'restored');
  assert.equal(await admission.probe(signal()), true);
});

// ---------------------------------------------------------------------------
// rollback and re-application — inside transactions that are rolled back
// ---------------------------------------------------------------------------

test('M5P-07: neither 013\'s rollback nor its re-application proceeds while an administrative session exists; beneath 015 the rollback refuses; otherwise it removes exactly what 013 created, and a re-apply starts from zero', async () => {
  const who = await actor('rollback', [{ scope: 'platform', role: 'operations_admin' }]);
  await owner`update user_membership set status = 'suspended' where internal_user_id = ${who.id}`;
  await owner`update user_membership set status = 'active' where internal_user_id = ${who.id}`;
  // Whatever creating the actor and those two writes moved it to: the rollback must leave it there, and a re-apply must not.
  const held = await versionRow(who);
  assert.notEqual(held, null);
  const at = Date.now();
  const session = (tx, audience) => tx`select tmpos_session.m5_session_create(${`m5p-${audience}-${randomUUID()}`}::text, ${audience}::text,
    'firebase'::text, ${who.uid}::text, ${`pk-m5p-${SUFFIX}`}::text, 'p1:probe'::text,
    ${at}::bigint, ${at}::bigint, ${at}::bigint, ${at}::bigint, ${at + 3_600_000}::bigint) as created`;
  // `triggers` counts every trigger, on any table, bearing one of the four names section 4 declares.
  const FOUR = DECLARED.map((t) => t.name);
  const present = async (tx) => ({ ...(await tx`select pg_catalog.to_regnamespace('tmpos_admission') is not null as schema,
      pg_catalog.to_regprocedure('tmpos_admission.m5_admit_platform_session(text, text)') is not null as read,
      exists (select 1 from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
               where n.nspname = 'tmpos_admission' and c.relname = 'platform_authority_version') as version_table,
      (select pg_catalog.count(*)::int from pg_catalog.pg_trigger g where g.tgname = any (${FOUR}::name[])) as triggers`)[0] });
  const APPLIED = { schema: true, read: true, version_table: true, triggers: 4 };

  // REFUSED while one administrative session row exists — and nothing is changed by the refusal.
  await rolledBack(async (tx) => {
    assert.equal((await session(tx, 'admin'))[0].created, 'created');
    const refused = await refusalIn(tx)((sp) => sp.unsafe(DOWN_013).simple());
    assert.equal(refused?.code, '55000', 'object_not_in_prerequisite_state');
    assert.match(refused.message, /administrative session row\(s\) remain/);
    assert.deepEqual(await present(tx), APPLIED, 'nothing was dropped');
    assert.deepEqual(await versionTriggers(tx), DECLARED, 'every trigger still as declared');
    assert.equal((await tx`select pg_catalog.has_function_privilege('tmpos_app', ${READ}, 'EXECUTE') as ok`)[0].ok, true, 'nor any grant revoked');
    assert.equal(await versionRow(who, tx), held, 'and every version is where it was');
  });

  await rolledBack(async (tx) => {
    // The remedy the refusal names: end the administrative sessions (other suites on a shared service may hold some). A
    // TENANT session carries no platform witness and blocks neither the rollback nor the re-application below.
    await tx`delete from tmpos_session.session where audience = 'admin'`;
    assert.equal((await session(tx, 'tenant'))[0].created, 'created');
    // 015's function lives in 013's schema, which 013's rollback drops WITHOUT CASCADE: beneath 015 it refuses
    // (dependent_objects_still_exist) and changes nothing, so 015 is rolled back first, through its own rollback.
    const beneath = await refusalIn(tx)((sp) => sp.unsafe(DOWN_013).simple());
    assert.equal(beneath?.code, '2BP01', `013's rollback refuses beneath 015: ${beneath?.message}`);
    assert.deepEqual(await present(tx), APPLIED, 'nothing was dropped');
    assert.deepEqual(await serializeTriggers(tx), DECLARED_015, 'nor any of 015\'s triggers');
    await tx.unsafe(DOWN_015).simple();
    await tx.unsafe(DOWN_013).simple();
    // DOWN pinned this transaction's search_path to pg_catalog: every name below is qualified.
    assert.deepEqual(await present(tx), { schema: false, read: false, version_table: false, triggers: 0 },
      'everything 013 created is gone, and none of the four trigger names remains anywhere');
    const [kept] = await tx`select
        pg_catalog.to_regprocedure('tmpos_directory.m5_tenant_directory_page(uuid, text, uuid, text, uuid, integer)') is not null as s012,
        pg_catalog.to_regprocedure('tmpos_session.m5_admit_tenant_session(text, text)') is not null as s011,
        pg_catalog.to_regclass('tmpos_session.session') is not null as session_table,
        pg_catalog.to_regprocedure('tmpos_command.m5_tenant_status_change(uuid, bigint, text, text)') is not null as s010,
        pg_catalog.to_regprocedure('tmpos_identity.m5_resolve_principal(text, text)') is not null as s007,
        (select pg_catalog.count(*)::int from tmpos_session.session where auth_provider_uid = ${who.uid} and audience = 'tenant') as tenant_rows,
        (select pg_catalog.array_agg(g.tgname::text order by g.tgname) from pg_catalog.pg_trigger g
          where g.tgrelid in ('public.platform_identity'::regclass, 'public.app_user'::regclass,
                              'public.identity_link'::regclass, 'public.user_membership'::regclass)
            and not g.tgisinternal) as left_on_the_four`;
    assert.deepEqual({ ...kept }, {
      s012: true, s011: true, session_table: true, s010: true, s007: true, tenant_rows: 1,
      left_on_the_four: ['trg_app_user_updated_at', 'trg_identity_link_updated_at', 'trg_platform_identity_updated_at',
        'trg_user_membership_tenant_grant_version', 'trg_user_membership_updated_at'],
    }, '007-012 intact, the tenant session untouched, and 001\'s, 002\'s and 004\'s updated_at triggers the only ones left on the four tables beside 016\'s grant trigger, which 013\'s rollback does not own');

    // THE RE-APPLICATION REFUSES TOO while an administrative session exists: a login that read its witness before the
    // rollback can commit its row after it, and the counters restart at zero below, so that witness could be met again.
    // The row is created inside the savepoint the refusal rolls back, and the rollback's lock is still held, so it is the
    // only administrative row there is: the count in the message is exactly 1.
    const refusedUp = await refusalIn(tx)(async (sp) => {
      assert.equal((await session(sp, 'admin'))[0].created, 'created');
      await sp.unsafe(UP_013).simple();
    });
    assert.deepEqual(refusedUp, {
      code: '55000',
      message: 'migration 013 refused: 1 administrative session row(s) exist, and a witness issued before this application could be met again once its counters restart',
    }, 'object_not_in_prerequisite_state, from section 1');
    assert.deepEqual(await present(tx), { schema: false, read: false, version_table: false, triggers: 0 },
      'the refused up created nothing: no schema, no read, no table, and none of the four trigger names anywhere');
    const [left] = await tx`select
        (select pg_catalog.count(*)::int from tmpos_session.session where audience = 'admin') as admin_rows,
        (select pg_catalog.count(*)::int from tmpos_session.session where auth_provider_uid = ${who.uid} and audience = 'tenant') as tenant_rows`;
    assert.deepEqual({ ...left }, { admin_rows: 0, tenant_rows: 1 }, 'the refusal took its administrative row with it; the tenant row remains');

    // 012 -> 013 again, over that TENANT row: it carries no witness and does not block the up. The upgrade applies over
    // the rolled-back state, and every counter starts again at zero.
    await tx.unsafe(UP_013).simple();
    assert.deepEqual(await present(tx), APPLIED, 're-applied');
    assert.deepEqual(await versionTriggers(tx), DECLARED, 'the four triggers exactly as declared again');
    assert.equal(await versionRow(who, tx), null, 'the table is new and empty');
    const [again] = await readAs(tx, 'firebase', who.uid);
    assert.deepEqual([again.outcome, again.memberships.length, again.authority_version], ['resolved', 1, '0'],
      `the actor was at ${held}; the re-applied read says 0 until it is written again — which is why the rollback refuses while any witness exists`);
    await tx`update public.user_membership set status = 'suspended' where internal_user_id = ${who.id}`;
    assert.equal(await versionRow(who, tx), '1', 'and the re-applied trigger moves it again, from the start');
    // 015 re-applies over the re-applied 013, its postcondition satisfied.
    await tx.unsafe(UP_015).simple();
    assert.deepEqual(await serializeTriggers(tx), DECLARED_015, '015 re-applied over it');
  });

  assert.deepEqual(await present(owner), APPLIED, 'the shared state is untouched');
  assert.deepEqual(await versionTriggers(), DECLARED);
  assert.deepEqual(await serializeTriggers(), DECLARED_015);
  assert.equal(await versionRow(who), held, 'and so is the version');
});

test('M5P-08: migrations 005-012 are byte-identical to what this stage found', () => {
  const PINNED = {
    '005_principal_separation_rls_foundation.up.sql': 'a4a61385beedf98194fb427bcd528704b068d7ca2947a9713d7a1a1c87157bda',
    '005_principal_separation_rls_foundation.down.sql': 'c198c0fa9c481cb2fe99c7f841aba4023bfbbef06663e2948755abca1d74db64',
    '006_m6_transactional_store.up.sql': '091933e19559d1d109580dd86cd381ada12398fbe1a93b011ac97e15c23dc68c',
    '006_m6_transactional_store.down.sql': '767afd8a194b5bfe4b8541af25342f12346d219b8bc046d588ddb18cf3d44ecc',
    '007_m5_trusted_principal_resolution.up.sql': 'a3a9aa98b299cd343e35df6b9048ea1468f5b11668e7ea6996045cb514f7bcbe',
    '007_m5_trusted_principal_resolution.down.sql': '1f3a130489d2c19a9cba27ece60d2937fa92956bf7b1d5e13cfa63602b697984',
    '008_m5_tenant_display_name_command.up.sql': 'cfaa5724bd4b9bb1681f6a8633a282aa8dd3ea3ed3d3cf9a89a8e28d33a51d5e',
    '008_m5_tenant_display_name_command.down.sql': '532ef95098745971cabbef107fe8a8b1fad02fe7f29e4b8722b1a38e3362718f',
    '009_m5_first_command_hardening.up.sql': '032842618ee71ca1e523502a75d9824ea5c922236e03670defb99f0e0764b54c',
    '009_m5_first_command_hardening.down.sql': 'b08558c05c36b0248713409cb2d1924f9d773eb5301707ff77d792a50f75f2b3',
    '010_m5_tenant_lifecycle_command.up.sql': 'a3a2f41107df582826c20001a91edff569507582e1d90df6c339778b2fb8748b',
    '010_m5_tenant_lifecycle_command.down.sql': '02b1633e9f22fa92ca458131c97ac2a79b6499b38802e67fc2c125cf6c240297',
    '011_m5_tenant_admission.up.sql': 'b3944f909c4298f700746784cd52385c5410acd3a15ad39f0a7138d5d6911c7d',
    '011_m5_tenant_admission.down.sql': 'c272ab6656c7a37e62d007bf60404bfaebe21a40ef95dc906efacd7914f7495b',
    '012_m5_platform_tenant_directory.up.sql': '6e71d4d5223576b86bd6acc46ed429bbcff64390d69a6d3980a3bc9baf3efce6',
    '012_m5_platform_tenant_directory.down.sql': '9d359194edc3031ff5dd1dd60bd54bbe448d850c58d393876993cb5301f47a89',
  };
  for (const [name, digest] of Object.entries(PINNED)) {
    assert.equal(createHash('sha256').update(readFileSync(`${MIG_DIR}/${name}`)).digest('hex'), digest, name);
  }
});

// ---------------------------------------------------------------------------
// migration 015: what waits for a held account, and what does not
// ---------------------------------------------------------------------------

test('M5P-09: an anchor repoint or delete, and a link or grant inserted for the actor or re-pointed to it, each WAIT for a transaction holding the actor\'s account FOR UPDATE — as a replica too — and land once it commits', async () => {
  /** Each case prepares its own fixture around the held actor A: the write that must wait, what it leaves once it has
   *  landed, how far it moves A's version (013), and any clean-up of what a replica-mode write leaves behind. */
  const cases = [
    ['the anchor repointed to another uid', async (A) => {
      const moved = `${A.uid}-moved`;
      return {
        write: (tx) => tx`update public.platform_identity set auth_provider_uid = ${moved} where internal_user_id = ${A.id}`,
        landed: async () => (await owner`select auth_provider_uid as v from public.platform_identity where internal_user_id = ${A.id}`)[0].v === moved,
      };
    }],
    ['a link inserted for the actor', async (A, tag) => {
      const supabaseUid = await supabaseAnchor(`insert-${tag}`);
      return {
        write: (tx) => tx`insert into public.identity_link (internal_user_id, firebase_auth_provider_uid, supabase_auth_provider_uid)
          values (${A.id}, ${A.uid}, ${supabaseUid})`,
        landed: async () => (await owner`select pg_catalog.count(*)::int as n from public.identity_link where internal_user_id = ${A.id}`)[0].n === 1,
      };
    }],
    ['another actor\'s link re-pointed to the actor', async (A, tag) => {
      const B = await actor(`repoint-from-${tag}`, []);
      const link = await linkOf(B, `repoint-${tag}`);
      return {
        write: (tx) => tx`update public.identity_link set internal_user_id = ${A.id} where link_id = ${link}`,
        landed: async () => (await owner`select internal_user_id as v from public.identity_link where link_id = ${link}`)[0].v === A.id,
      };
    }],
    // A grant's own foreign key already waits in an ordinary session; as a replica no foreign-key check runs, and only
    // 015's trigger on user_membership makes it wait.
    ['a platform grant inserted for the actor', async (A) => ({
      write: (tx) => tx`insert into public.user_membership (internal_user_id, scope_type, role_id, status)
        values (${A.id}, 'platform', 'system_owner', 'active')`,
      landed: async () => (await owner`select pg_catalog.count(*)::int as n from public.user_membership where internal_user_id = ${A.id}`)[0].n === 1,
    })],
    ['another actor\'s platform grant re-pointed to the actor', async (A, tag) => {
      const B = await actor(`grant-from-${tag}`, [{ scope: 'platform', role: 'system_owner' }]);
      const [{ membership_id: m }] = await owner`select membership_id from public.user_membership where internal_user_id = ${B.id}`;
      return {
        write: (tx) => tx`update public.user_membership set internal_user_id = ${A.id} where membership_id = ${m}`,
        landed: async () => (await owner`select internal_user_id as v from public.user_membership where membership_id = ${m}`)[0].v === A.id,
      };
    }],
    // The DELETE must REMOVE the anchor once it lands (a BEFORE DELETE trigger that returned no row would skip it). In an
    // ordinary session the cascade takes the account with it (+2: the anchor, then the account); as a replica no
    // cascade runs, the account is left behind (+1), and the test deletes it afterwards.
    ['the anchor deleted', async (A, tag, replica) => {
      const rows = async () => (await owner`select
        (select pg_catalog.count(*)::int from public.platform_identity where internal_user_id = ${A.id}) as anchors,
        (select pg_catalog.count(*)::int from public.app_user where internal_user_id = ${A.id}) as accounts`)[0];
      return {
        write: (tx) => tx`delete from public.platform_identity where internal_user_id = ${A.id}`,
        landed: async () => { const r = await rows(); return r.anchors === 0 && r.accounts === (replica ? 1 : 0); },
        moves: replica ? 1 : 2,
        cleanUp: replica ? () => owner`delete from public.app_user where internal_user_id = ${A.id}` : undefined,
      };
    }],
  ];
  for (const replica of [false, true]) {
    for (const [i, [label, prepare]] of cases.entries()) {
      const tag = `${replica ? 'r' : 'o'}${i}`;
      const what = `${label}${replica ? ', as a replica' : ''}`;
      const A = await actor(`held-${tag}`, []);
      const { write, landed, moves = 1, cleanUp } = await prepare(A, tag, replica);
      const before = Number((await versionRow(A)) ?? '0');
      const hold = await holdAccount(A);
      const change = inTransaction(write, { replica });
      let released = false;
      try {
        assert.equal(await blockedBy(await change.pid, hold.pid, change.settled), true, `${what}: blocked by the holder itself`);
        assert.equal(change.settled(), false, `${what}: still waiting`);
        assert.equal(await landed(), false, `${what}: nothing has landed while the account is held`);
        released = true;
        assert.deepEqual(await hold.release(), { ok: true, value: undefined }, `${what}: the holder commits`);
      } finally {
        if (!released) await hold.release();
      }
      const done = await change.outcome;
      assert.equal(done.ok, true, `${what}: it lands once the holder has committed: ${JSON.stringify(done)}`);
      assert.equal(await landed(), true, `${what}: landed`);
      assert.equal(Number(await versionRow(A)) - before, moves, `${what}: and 013 moved the actor's version, after the wait`);
      if (cleanUp) await cleanUp();
    }
  }
});

test('M5P-10: a profile update, the identity sync\'s upsert and a link re-pointed AWAY from the held actor do not wait; under 009\'s whole lock set an anchor DELETE of another actor does not, of the held actor waits and then removes it with its cascade, and nothing deadlocks', async () => {
  // Held by the account lock alone: none of these writes moves an anchor or brings a link to the held actor, so none
  // waits. The link re-point proves the actor a link LEAVES is not locked (015 locks the new actor only).
  const A = await actor('nowait', []);
  const B = await actor('nowait-to', []);
  const link = await linkOf(A, 'nowait');
  const hold = await holdAccount(A);
  try {
    for (const [label, write] of [
      ['the email and display name', (tx) => tx`update public.platform_identity set email = ${`m5p-nowait-${SUFFIX}@example.test`},
        display_name = 'M5P nowait' where internal_user_id = ${A.id}`],
      // The identity sync's own statement (identityRepository.ts upsertIdentity), on the held actor's reference: its
      // conflict turns it into an UPDATE of the profile columns, which moves no anchor and waits for nothing.
      ['the identity sync\'s upsert', (tx) => tx`insert into public.platform_identity (auth_provider, auth_provider_uid, email, display_name)
        values ('firebase', ${A.uid}, ${`m5p-sync-${SUFFIX}@example.test`}, 'M5P sync')
        on conflict (auth_provider, auth_provider_uid)
        do update set email = excluded.email, display_name = excluded.display_name, updated_at = now()`],
      ['the actor\'s link re-pointed to another actor', (tx) => tx`update public.identity_link set internal_user_id = ${B.id} where link_id = ${link}`],
    ]) {
      const done = await inTransaction(write, { lockTimeout: '2s' }).outcome;
      assert.equal(done.ok, true, `${label}: completes while the account is held: ${JSON.stringify(done)}`);
    }
    assert.equal(hold.settled(), false, 'each completed while the holder was still open');
  } finally {
    assert.deepEqual(await hold.release(), { ok: true, value: undefined });
  }
  assert.equal((await owner`select internal_user_id as v from public.identity_link where link_id = ${link}`)[0].v, B.id);

  // Held by 009 itself — the account FOR UPDATE, then its link and its grant FOR SHARE — as a command holds them.
  const D = await actor('delete', [{ scope: 'platform', role: 'system_owner' }]);
  await linkOf(D, 'delete');
  const C = await actor('delete-other', [{ scope: 'platform', role: 'system_owner' }]);
  await linkOf(C, 'delete-other');
  const [{ membership_id: membershipId }] = await owner`select membership_id from public.user_membership where internal_user_id = ${D.id}`;
  const { security_version: securityVersion } = await resolveAs(owner, D.uid);
  const command = await holding(async (tx) => (await tx`select outcome from tmpos_command.m5_revalidate_platform_authority(
    ${D.id}::uuid, ${securityVersion}::text, ${membershipId}::uuid, 'system_owner'::text)`)[0].outcome);
  assert.equal(command.answer, 'valid', '009 answered, holding its whole lock set');
  let released = false;
  let own;
  try {
    const other = await inTransaction((tx) => tx`delete from public.platform_identity where internal_user_id = ${C.id}`, { lockTimeout: '2s' }).outcome;
    assert.equal(other.ok, true, `another actor's anchor, account and link are deleted without waiting: ${JSON.stringify(other)}`);
    own = inTransaction((tx) => tx`delete from public.platform_identity where internal_user_id = ${D.id}`);
    assert.equal(await blockedBy(await own.pid, command.pid, own.settled), true, 'the held actor\'s anchor DELETE waits on the holder');
    assert.equal(own.settled(), false);
    released = true;
    assert.deepEqual(await command.release(), { ok: true, value: undefined }, 'the holder commits: it was no deadlock victim (40P01)');
  } finally {
    if (!released) await command.release();
  }
  const deleted = await own.outcome;
  assert.equal(deleted.ok, true, `the delete lands after the holder's commit, no deadlock: ${JSON.stringify(deleted)}`);
  const [{ anchors, accounts, links, grants }] = await owner`select
    (select pg_catalog.count(*)::int from public.platform_identity where internal_user_id = any (${[C.id, D.id]}::uuid[])) as anchors,
    (select pg_catalog.count(*)::int from public.app_user where internal_user_id = any (${[C.id, D.id]}::uuid[])) as accounts,
    (select pg_catalog.count(*)::int from public.identity_link where internal_user_id = any (${[C.id, D.id]}::uuid[])) as links,
    (select pg_catalog.count(*)::int from public.user_membership where internal_user_id = any (${[C.id, D.id]}::uuid[])) as grants`;
  assert.deepEqual({ anchors, accounts, links, grants }, { anchors: 0, accounts: 0, links: 0, grants: 0 },
    'both anchors are gone, and both cascades took the account, the link and the grant');
});

test('M5P-11: 015\'s own postcondition refuses every widening or narrowing it names, forced row security on the account table included; its rollback removes exactly its function and three triggers, it re-applies cleanly, and a member of the schema owner is refused before anything is created — all rolled back', async () => {
  const NOT_THE_THREE = /the serialization triggers are not exactly the three section 3 declares/;
  const NOT_DECLARED = /m5_platform_standing_serialize does not match its declaration/;
  const but = (name, change) => DECLARED_015.map((t) => (t.name === name ? { ...t, ...change } : t));
  for (const [label, widen, refusal, leaves] of [
    ['EXECUTE to tmpos_app', `grant execute on function ${SERIALIZE} to tmpos_app`,
      /unexpected direct grant remains on m5_platform_standing_serialize \(tmpos_app:EXECUTE\)/, DECLARED_015],
    ['EXECUTE to PUBLIC', `grant execute on function ${SERIALIZE} to public`,
      /unexpected direct grant remains on m5_platform_standing_serialize \(-:EXECUTE\)/, DECLARED_015],
    ['SECURITY INVOKER', `alter function ${SERIALIZE} security invoker`, NOT_DECLARED, DECLARED_015],
    ['its search path unpinned', `alter function ${SERIALIZE} reset search_path`, NOT_DECLARED, DECLARED_015],
    ['a fourth routine in the schema', 'create function tmpos_admission.m5p_extra() returns integer language sql as \'select 1\'',
      /schema tmpos_admission does not hold exactly 013's two routines and this file's one/, DECLARED_015],
    ['a fourth trigger calling it', `create trigger m5p_fourth before insert or update on public.identity_link
      for each row execute function ${SERIALIZE};
      alter table public.identity_link enable always trigger m5p_fourth`, NOT_THE_THREE,
      [{ ...DECLARED_015[0], name: 'm5p_fourth' }, ...DECLARED_015]],
    ['the link trigger disabled', 'alter table public.identity_link disable trigger trg_identity_link_standing_serialize',
      NOT_THE_THREE, but('trg_identity_link_standing_serialize', { enabled: 'D' })],
    ['the anchor trigger enabled for origin sessions only', 'alter table public.platform_identity enable trigger trg_platform_identity_standing_serialize',
      NOT_THE_THREE, but('trg_platform_identity_standing_serialize', { enabled: 'O' })],
    ['the anchor trigger narrowed to UPDATE alone — a replica-mode anchor DELETE would no longer wait',
      `drop trigger trg_platform_identity_standing_serialize on public.platform_identity;
      create trigger trg_platform_identity_standing_serialize before update on public.platform_identity
        for each row execute function ${SERIALIZE};
      alter table public.platform_identity enable always trigger trg_platform_identity_standing_serialize`,
      NOT_THE_THREE, but('trg_platform_identity_standing_serialize', { tgtype: 19 })],
    ['the grant trigger dropped — a replica-mode grant insert would no longer wait',
      'drop trigger trg_user_membership_standing_serialize on public.user_membership',
      NOT_THE_THREE, DECLARED_015.filter((t) => t.name !== 'trg_user_membership_standing_serialize')],
    // Forced row security would hide every account row from the owner-run lock, which would then serialize nothing.
    ['FORCE ROW LEVEL SECURITY on public.app_user', 'alter table public.app_user force row level security',
      /row level security would hide public\.app_user rows from m5_platform_standing_serialize/, DECLARED_015],
  ]) {
    await rolledBack(async (tx) => {
      await tx.unsafe(widen).simple();
      assert.deepEqual(await serializeTriggers(tx), leaves, `${label}: the widening changes that one property and nothing else`);
      const refused = await refusalIn(tx)((sp) => sp.unsafe(POSTCONDITION_015).simple());
      assert.equal(refused?.code, '55000', `the postcondition refuses ${label}`);
      assert.match(refused.message, refusal, label);
    });
  }
  // Control: over the state 015 left, its postcondition holds.
  await rolledBack(async (tx) => { assert.equal(await refusalIn(tx)((sp) => sp.unsafe(POSTCONDITION_015).simple()), null); });

  await rolledBack(async (tx) => {
    await tx.unsafe(DOWN_015).simple();
    // DOWN pinned this transaction's search_path to pg_catalog: every name below is qualified.
    const [left] = await tx`select pg_catalog.to_regprocedure(${SERIALIZE}) is null as function_gone,
        (select pg_catalog.array_agg(g.tgname::text order by g.tgname) from pg_catalog.pg_trigger g
          where g.tgrelid in ('public.platform_identity'::regclass, 'public.identity_link'::regclass, 'public.user_membership'::regclass)
            and not g.tgisinternal) as triggers`;
    assert.deepEqual({ ...left }, {
      function_gone: true,
      triggers: ['trg_identity_link_platform_authority', 'trg_identity_link_updated_at', 'trg_platform_identity_platform_authority',
        'trg_platform_identity_updated_at', 'trg_user_membership_platform_authority', 'trg_user_membership_tenant_grant_version',
        'trg_user_membership_updated_at'],
    }, '015\'s function and triggers are gone; 013\'s, 016\'s and 001\'s/002\'s/004\'s remain');
    assert.deepEqual(await versionTriggers(tx), DECLARED, '013 untouched');
    await tx.unsafe(UP_015).simple();
    assert.deepEqual(await serializeTriggers(tx), DECLARED_015, 're-applied, exactly as declared');
  });

  // Applied by a MEMBER of the schema's owner — one that may act as the owner, and so passes every table-ownership
  // check — section 1 refuses before anything is created: the function would be the member's, not the schema owner's.
  const member = `m5p_member_${SUFFIX.replace(/-/g, '')}`;
  await rolledBack(async (tx) => {
    await tx.unsafe(DOWN_015).simple();
    await tx.unsafe(`create role ${member} nologin inherit`);
    const [{ schema_owner: schemaOwner }] = await tx`select n.nspowner::regrole::text as schema_owner
      from pg_catalog.pg_namespace n where n.nspname = 'tmpos_admission'`;
    await tx.unsafe(`grant ${schemaOwner} to ${member}`);
    const refused = await refusalIn(tx)(async (sp) => {
      await sp.unsafe(`set local role ${member}`);
      await sp.unsafe(UP_015).simple();
    });
    assert.deepEqual(refused, {
      code: '42501',
      message: 'migration 015 refused: the applying principal does not own schema tmpos_admission, so the trigger function it creates would not pass the ownership postcondition',
    }, 'insufficient_privilege, from section 1');
    assert.deepEqual(await serializeTriggers(tx), [], 'the refused up created no trigger');
    assert.equal((await tx`select pg_catalog.to_regprocedure(${SERIALIZE}) is null as absent`)[0].absent, true, 'and no function');
  });
  assert.deepEqual(await serializeTriggers(), DECLARED_015, 'the shared state is untouched');
});

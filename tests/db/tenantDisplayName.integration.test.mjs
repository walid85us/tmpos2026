// Phase 4.0 M5-GIAM-D1-P1 — the first server-authorized business command against REAL PostgreSQL: migration 008 (the
// tenant's row version, its trigger, and the one fixed display-name operation), the M6 store committing the command with
// its mutator and the trusted context's revalidation, and the whole HTTP chain over the real resolver and store.
//
// DISPOSABLE ONLY. The target is TM_POS_TEST_DATABASE_URL when CI binds one, otherwise a cluster this file creates and
// destroys; assertDisposableTestDsn refuses anything else before a statement runs. Every fixture is synthetic and randomly
// named, so the suite re-runs on the shared CI service, where earlier suites already applied 001-008 and may have moved
// other tenants' versions. The rollback and upgrade proof runs inside one transaction that is rolled back, so the shared
// database keeps its state.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';

import { startDisposablePostgres, localPostgresAvailable } from './localPostgres.harness.mjs';
import {
  assertDisposableTestDsn,
  createPostgresExecutor,
  runTrustedApply,
} from '../../server/platform-identity/migrationExecutor.ts';
import { createNodeFsPort } from '../../server/platform-identity/migrationEngine.ts';
import { runtimeClientOptions } from '../../server/platform-identity/db.ts';
import { createSupervisedPgClient } from '../../server/persistence/supervisedPgClient.ts';
import { createPostgresTransactionalStore } from '../../server/persistence/postgresTransactionalStore.ts';
import { createPostgresPrincipalResolver, revalidateTrustedScope } from '../../server/persistence/postgresPrincipalResolver.ts';
import { TENANT_DISPLAY_NAME_MUTATOR } from '../../server/persistence/tenantDisplayNameMutator.ts';
import { createPlatformRouteAuthorizer } from '../../server/composition/platformAuthorization.ts';
import { createApp, createBoundedServer, createReadinessState } from '../../server/runtime/app.ts';
import { prepareCommand } from '../../server/runtime/commandTransaction.ts';
import { IDEMPOTENCY_POLICY, createIdempotencyKeyring } from '../../server/runtime/idempotency.ts';
import { TEST_IDEMPOTENCY_KEY } from '../../server/runtime/idempotencyStore.testkit.ts';
import { defineOutboxEvents } from '../../server/runtime/outbox.ts';
import { selectScope } from '../../server/runtime/principals.ts';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '../../server/runtime/requestSecurity.ts';
import { sessionPaths } from '../../server/runtime/routes.ts';
import { SESSION_COOKIES, SESSION_CSRF_HEADER } from '../../server/runtime/sessions.ts';
import { createMemorySessionStore } from '../../server/runtime/memorySessionStore.testkit.ts';
import { testRequestLimits } from '../../server/runtime/rateLimiter.testkit.ts';
import {
  TENANT_DISPLAY_NAME_CONTRACT,
  TENANT_DISPLAY_NAME_EVENTS,
  TENANT_DISPLAY_NAME_PATH,
  TENANT_DISPLAY_NAME_ROUTE,
  planTenantDisplayName,
} from '../../server/runtime/tenantDisplayName.ts';

const MIG_REL = 'server/platform-identity/migrations';
const MIG_DIR = new URL(`../../${MIG_REL}/`, import.meta.url).pathname.replace(/\/$/, '');
const UP_008 = readFileSync(`${MIG_DIR}/008_m5_tenant_display_name_command.up.sql`, 'utf8');
const DOWN_008 = readFileSync(`${MIG_DIR}/008_m5_tenant_display_name_command.down.sql`, 'utf8');
const MIGRATOR = { purpose: 'migration', migratorRef: 'm5d-migrator', runtimeRef: 'm5d-runtime' };
const LOCK_KEY = 528_508;
const NOW = () => new Date().toISOString();

/** The non-owner LOGIN the store and the resolver connect as: tmpos_app and tmpos_audit_writer, nothing else. */
const RUNTIME_LOGIN = 'tmpos_m5d_probe';
const SUFFIX = randomUUID().slice(0, 8);
const ADMIN_ORIGIN = 'http://admin.trusted.test';
const REQUIREMENT = Object.freeze({ scope: 'platform', permission: 'edit_tenant_profile' });
const signal = () => AbortSignal.timeout(10_000);

// ---------------------------------------------------------------------------
// cluster lifecycle
// ---------------------------------------------------------------------------

const ambient = process.env.TM_POS_TEST_DATABASE_URL;
let cluster = null;
let TARGET_DSN = null;
let CLIENT_OPTS = {};

if (typeof ambient === 'string' && ambient.trim() !== '') {
  TARGET_DSN = ambient.trim();
  const target = new URL(TARGET_DSN);
  const socketDir = target.hostname === '' ? target.searchParams.get('host') : null;
  if (socketDir !== null) {
    const user = target.searchParams.get('user');
    CLIENT_OPTS = { host: socketDir, ...(user !== null ? { user } : {}) };
  }
} else if (localPostgresAvailable()) {
  cluster = startDisposablePostgres();
  TARGET_DSN = cluster.dsn;
  CLIENT_OPTS = cluster.clientOptions;
} else {
  throw new Error(
    'M5D INFRASTRUCTURE BLOCKER: no TM_POS_TEST_DATABASE_URL and no local initdb/pg_ctl. ' +
    'Docker and remote databases are not substitutes.',
  );
}

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
  postgres(driverDsn(TARGET_DSN, user), { ...CLIENT_OPTS, ...(user === undefined ? {} : { user }), max, onnotice: () => {} });

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
// setup: real migrations, a real non-owner principal, synthetic identities
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
      fsPort: createNodeFsPort(MIG_DIR, MIG_REL),
      adapter: handle.adapter,
      ledger: handle.ledger,
      connectionMode: 'session',
      credential: MIGRATOR,
      lockKey: LOCK_KEY,
      now: NOW,
      deadlineMs: 120_000,
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

/** The transaction kernel over the runtime login, exactly as the store suite builds it (no TLS on a disposable target). */
client = createSupervisedPgClient(postgres, driverDsn(TARGET_DSN, RUNTIME_LOGIN), {
  ...runtimeClientOptions(TARGET_DSN),
  ssl: false,
  max: 6,
  idle_timeout: 0,
  ...CLIENT_OPTS,
  user: RUNTIME_LOGIN,
});
const store = createPostgresTransactionalStore({ client, mutators: [TENANT_DISPLAY_NAME_MUTATOR], revalidate: revalidateTrustedScope });
const principals = createPostgresPrincipalResolver({ client });
const keyring = createIdempotencyKeyring(TEST_IDEMPOTENCY_KEY);
const EVENTS = defineOutboxEvents(TENANT_DISPLAY_NAME_EVENTS);

/** A synthetic platform actor: an identity, an active account and, unless null, one active membership. */
async function actor(label, membership) {
  const uid = `m5d-${label}-${SUFFIX}`;
  const [{ internal_user_id: id }] = await owner`
    insert into platform_identity (auth_provider, auth_provider_uid) values ('firebase', ${uid}) returning internal_user_id`;
  await owner`insert into app_user (internal_user_id, status) values (${id}, 'active')`;
  if (membership !== null) {
    await owner`insert into user_membership (internal_user_id, tenant_id, store_id, scope_type, role_id, status)
      values (${id}, ${membership.tenant ?? null}, ${membership.store ?? null}, ${membership.scope}, ${membership.role}, 'active')`;
  }
  return { id, uid, principal: Object.freeze({ authProvider: 'firebase', authProviderUid: uid }) };
}
const tenantRow = async (id) => (await owner`select display_name, legal_name, status, plan_key, row_version from tenant where tenant_id = ${id}`)[0];
const newTenant = async (name) => (await owner`insert into tenant (display_name) values (${name}) returning tenant_id`)[0].tenant_id;
const auditFor = (correlation) => owner`select actor_internal_user_id, scope_type, tenant_id, store_id, action_id, required_permission, request_id, decision, result_status
  from audit_event where request_id = ${correlation}`;
const eventsFor = (tenant) => owner`select event_type, event_version, aggregate_type, aggregate_id, aggregate_version, correlation_id, tenant_digest,
  store_digest, actor_digest, payload from tmpos_internal.outbox_event where aggregate_id = ${tenant} order by aggregate_version`;
const auditCountFor = async (action) => (await owner`select count(*)::int as n from audit_event where action_id = ${action}`)[0].n;
const recordDone = async (scope) => (await owner`select response is not null as done from tmpos_internal.idempotency_record where scope = ${scope}`)[0]?.done;
const call = async (tenant, expected, name, sql = runtime) =>
  (await sql`select o_outcome, o_version from tmpos_command.m5_tenant_display_name_update(${tenant}::uuid, ${expected}::bigint, ${name}::text)`)[0];
const refusalCode = async (fn) => {
  try { await fn(); return null; } catch (err) { return err.code ?? String(err.message); }
};

const [{ tenant_id: T_STORE }] = await owner`insert into tenant (display_name) values (${`m5d-store-tenant-${SUFFIX}`}) returning tenant_id`;
const [{ store_id: STORE }] = await owner`insert into store (tenant_id, store_name) values (${T_STORE}, ${`m5d-s-${SUFFIX}`}) returning store_id`;
const OWNER = await actor('owner', { scope: 'platform', role: 'system_owner' });
const SUPPORT = await actor('support', { scope: 'platform', role: 'support_admin' });
const BILLING = await actor('billing', { scope: 'platform', role: 'billing_admin' });
const TENANT_ONLY = await actor('tenant-only', { scope: 'tenant', tenant: T_STORE, role: 'manager' });
const STORE_ONLY = await actor('store-only', { scope: 'store', tenant: T_STORE, store: STORE, role: 'technician' });
const STALE_VERSION = await actor('stale-version', { scope: 'platform', role: 'system_owner' });
const STALE_GRANT = await actor('stale-grant', { scope: 'platform', role: 'system_owner' });

/** The trusted scope the canonical authorizer would hand the command: resolved and selected by the real resolver. */
async function contextOf(who) {
  const resolution = await principals.resolve(who.principal, signal());
  assert.equal(resolution.outcome, 'resolved', `${who.uid} resolves`);
  const selection = selectScope(resolution.principal, 'platform', { tenant: null, store: null });
  assert.equal(selection.outcome, 'selected');
  return selection.scope;
}

/** An idempotency record acquired under a fresh key, as the chain acquires one. */
async function acquired(who, body) {
  const operation = keyring.operationOf(randomUUID(), who.principal, {
    method: 'PATCH', path: TENANT_DISPLAY_NAME_PATH, audience: 'admin', tenant: null, store: null, body: Buffer.from(JSON.stringify(body)),
  });
  const lease = randomBytes(32).toString('base64url');
  assert.deepEqual(await store.idempotency.acquire({ ...operation, lease, ...IDEMPOTENCY_POLICY }, signal()), { outcome: 'acquired', reclaimed: false });
  return { operation, lease };
}

/** The command the chain would commit: planned from the body, prepared under the record's lease and the trusted context. */
function prepared({ operation, lease }, context, body) {
  const plan = planTenantDisplayName({ audience: 'admin', body, newAggregateId: randomUUID() });
  const command = prepareCommand(TENANT_DISPLAY_NAME_CONTRACT, EVENTS, plan, {
    scope: operation.scope, lease, newAggregateId: randomUUID(), authorization: REQUIREMENT, context, seal: (envelope) => keyring.seal(envelope, operation),
  });
  assert.ok(command !== null, 'the plan is in contract');
  return command;
}
const commit = (command) => store.transactions.commit(command, signal());

// ---------------------------------------------------------------------------
// migration 008 as applied
// ---------------------------------------------------------------------------

test('M5D-01: 001-008 apply clean, and 008 is exactly its column, its trigger, its two functions and their grants', async () => {
  assert.equal(applyReport.outcome, 'complete', JSON.stringify(applyReport).slice(0, 400));
  const ledger = await owner`select version, dirty from public.schema_migrations order by version`;
  assert.deepEqual(ledger.map((r) => [r.version, r.dirty]), ['001', '002', '003', '004', '005', '006', '007', '008'].map((v) => [v, false]));

  const [column] = await owner`select a.atttypid::regtype::text as type, a.attnotnull as not_null, pg_catalog.pg_get_expr(d.adbin, d.adrelid) as dflt,
      (select pg_catalog.pg_get_constraintdef(c.oid) from pg_catalog.pg_constraint c where c.conname = 'tenant_row_version_chk') as chk
    from pg_catalog.pg_attribute a join pg_catalog.pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
   where a.attrelid = 'public.tenant'::regclass and a.attname = 'row_version'`;
  assert.deepEqual(column, { type: 'bigint', not_null: true, dflt: '1', chk: 'CHECK (((row_version >= 1) AND (row_version <= \'9007199254740991\'::bigint)))' });

  const fns = await owner`select p.proname, p.prosecdef, p.provolatile, p.proconfig, p.proowner = n.nspowner as owned
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace where n.nspname = 'tmpos_command' order by p.proname`;
  assert.deepEqual(fns.map((f) => ({ ...f })), [
    { proname: 'm5_tenant_display_name_update', prosecdef: true, provolatile: 'v', proconfig: ['search_path=pg_catalog, pg_temp'], owned: true },
    { proname: 'm5_tenant_row_version', prosecdef: false, provolatile: 'v', proconfig: ['search_path=pg_catalog, pg_temp'], owned: true },
  ]);

  const acl = await owner`select p.proname, a.grantee::regrole::text as grantee, a.privilege_type, a.is_grantable
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    cross join pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
   where n.nspname = 'tmpos_command' and a.grantee <> p.proowner order by p.proname`;
  assert.deepEqual(acl.map((r) => ({ ...r })), [{ proname: 'm5_tenant_display_name_update', grantee: 'tmpos_app', privilege_type: 'EXECUTE', is_grantable: false }],
    'tmpos_app may execute the operation only, never grant it; nobody holds the trigger function');

  const [trigger] = await owner`select g.tgname, g.tgenabled, g.tgtype::int as tgtype, p.proname from pg_catalog.pg_trigger g
    join pg_catalog.pg_proc p on p.oid = g.tgfoid where g.tgrelid = 'public.tenant'::regclass and g.tgname = 'trg_tenant_row_version'`;
  assert.deepEqual({ ...trigger }, { tgname: 'trg_tenant_row_version', tgenabled: 'A', tgtype: 19, proname: 'm5_tenant_row_version' },
    'one BEFORE UPDATE row trigger, enabled ALWAYS');
});

test('M5D-02: the runtime role may call the operation and nothing else: no version write, no platform-scope row, no object in the schema', async () => {
  const tenant = await newTenant(`m5d-priv-${SUFFIX}`);
  assert.deepEqual({ ...(await call(tenant, 1, 'Priv Two')) }, { o_outcome: 'applied', o_version: '2' }, 'the operation answers the runtime role');
  assert.equal(await refusalCode(() => runtime`select tmpos_command.m5_tenant_row_version()`), '42501', 'the trigger function is nobody\'s to call');
  for (const privilege of ['UPDATE', 'INSERT']) {
    assert.equal((await owner`select pg_catalog.has_column_privilege('tmpos_app', 'public.tenant', 'row_version', ${privilege}) as ok`)[0].ok, false, privilege);
    assert.equal((await runtime`select pg_catalog.has_column_privilege('public.tenant', 'row_version', ${privilege}) as ok`)[0].ok, false, `${privilege} as the login`);
  }
  assert.equal(await refusalCode(() => runtime`update public.tenant set row_version = 99 where tenant_id = ${tenant}`), '42501', 'no version write');
  // 005's column grant answers only under a tenant/store RLS context, which a platform command never installs.
  const direct = await runtime`update public.tenant set display_name = 'direct' where tenant_id = ${tenant}`;
  assert.equal(direct.count, 0, 'a direct platform-scope write reaches no row');
  assert.equal((await tenantRow(tenant)).display_name, 'Priv Two');
  assert.equal(await refusalCode(() => runtime.unsafe('create function tmpos_command.m5d_evil() returns int language sql as $$ select 1 $$')), '42501',
    'nothing may be added to the schema');
  // A hostile search_path changes nothing: the operation pins its own path and qualifies every name.
  const evil = `m5d_evil_${SUFFIX.replace(/-/g, '')}`;
  await owner.unsafe(`create schema ${evil}`);
  await owner.unsafe(`create function ${evil}.char_length(text) returns integer language sql immutable as $$ select 1 $$`);
  await owner.unsafe(`create table ${evil}.tenant (tenant_id uuid, display_name text, row_version bigint)`);
  await owner.unsafe(`insert into ${evil}.tenant values ('${tenant}', 'shadow', 2)`);
  await owner.unsafe(`grant usage on schema ${evil} to tmpos_app`);
  await owner.unsafe(`grant select, update on all tables in schema ${evil} to tmpos_app`);
  await owner.unsafe(`grant execute on all functions in schema ${evil} to tmpos_app`);
  try {
    const answers = await runtime.begin(async (tx) => {
      await tx.unsafe(`set local search_path = ${evil}, public, pg_temp`);
      return [await call(tenant, 2, 'x'.repeat(121), tx), await call(tenant, 2, 'Priv Three', tx)];
    });
    assert.deepEqual(answers.map((a) => a.o_outcome), ['invalid', 'applied'], 'the length check and the update are pg_catalog\'s and public\'s');
    assert.equal((await tenantRow(tenant)).display_name, 'Priv Three');
    assert.equal((await owner.unsafe(`select display_name from ${evil}.tenant`))[0].display_name, 'shadow', 'the shadow table was never touched');
  } finally {
    await owner.unsafe(`drop schema ${evil} cascade`);
  }
});

test('M5D-03: the operation\'s answers — invalid, not_found, conflict before the name, unchanged, applied — and only displayName moves', async () => {
  const tenant = await newTenant(`m5d-ops-${SUFFIX}`);
  await owner`update tenant set legal_name = ${'Legal Co'}, plan_key = 'growth' where tenant_id = ${tenant}`; // version 2
  const before = await tenantRow(tenant);
  assert.equal(before.row_version, '2');
  for (const [label, args] of [
    ['null tenant', [null, 2, 'n']], ['null version', [tenant, null, 'n']], ['version 0', [tenant, 0, 'n']],
    ['version past the bound', [tenant, 9007199254740991, 'n']], ['null name', [tenant, 2, null]], ['empty name', [tenant, 2, '']],
    ['121 scalars', [tenant, 2, 'y'.repeat(121)]], ['a control character', [tenant, 2, 'a\u0001b']], ['a C1 control', [tenant, 2, 'a\u0085b']],
    ['a line separator', [tenant, 2, 'a\u2028b']],
    // No leading or trailing character ECMAScript's trim removes (M5-GIAM-D1-P1 cross-model review): the routine re-checks it.
    ['only spaces', [tenant, 2, '   ']], ['a leading space', [tenant, 2, ' Acme']], ['a trailing no-break space', [tenant, 2, 'Acme\u00a0']],
    ['a leading ideographic space', [tenant, 2, '\u3000Acme']], ['a trailing tab', [tenant, 2, 'Acme\t']], ['a leading BOM', [tenant, 2, '\ufeffAcme']],
  ]) assert.deepEqual({ ...(await call(...args)) }, { o_outcome: 'invalid', o_version: null }, label);
  assert.deepEqual({ ...(await call(randomUUID(), 1, 'n')) }, { o_outcome: 'not_found', o_version: null });
  assert.deepEqual({ ...(await call(tenant, 1, `m5d-ops-${SUFFIX}`)) }, { o_outcome: 'conflict', o_version: null }, 'a stale version conflicts even when the name matches');
  assert.deepEqual({ ...(await call(tenant, 2, `m5d-ops-${SUFFIX}`)) }, { o_outcome: 'unchanged', o_version: '2' });
  assert.deepEqual(await tenantRow(tenant), before, 'unchanged moves nothing');
  const astral = '\u{1F600}'.repeat(120);
  assert.deepEqual({ ...(await call(tenant, 2, astral)) }, { o_outcome: 'applied', o_version: '3' }, '120 scalars in 240 code units');
  assert.deepEqual({ ...(await tenantRow(tenant)) }, { ...before, display_name: astral, row_version: '3' }, 'only the name and the version moved, once');
});

test('M5D-04: the trigger alone moves the version — once per real change, never on a no-op, never to a value a writer names', async () => {
  const tenant = await newTenant(`m5d-trg-${SUFFIX}`);
  const version = async () => (await tenantRow(tenant)).row_version;
  await owner`update tenant set legal_name = 'L1' where tenant_id = ${tenant}`;
  assert.equal(await version(), '2', 'a legal-name change moves it by one');
  await owner`update tenant set legal_name = 'L1' where tenant_id = ${tenant}`;
  assert.equal(await version(), '2', 'a no-op keeps it (updated_at alone moved)');
  await owner`update tenant set row_version = 99 where tenant_id = ${tenant}`;
  assert.equal(await version(), '2', 'a named version is overwritten, even the owner\'s');
  await owner`update tenant set status = 'read_only' where tenant_id = ${tenant}`;
  assert.equal(await version(), '3', 'a status change moves it too: the whole row is versioned');
  await owner`update tenant set status = 'active', row_version = 1 where tenant_id = ${tenant}`;
  assert.equal(await version(), '4', 'and a change that names a version still moves exactly one step');
});

// ---------------------------------------------------------------------------
// the command through the real store
// ---------------------------------------------------------------------------

test('M5D-05: a committed command moves the name and the version together with one audit record, one event and the completion', async () => {
  const tenant = await newTenant(`m5d-cmd-${SUFFIX}`);
  const context = await contextOf(OWNER);
  assert.equal(context.actor, OWNER.id);
  const body = { tenantId: tenant, displayName: '  Acme  Holdings\u00a0Ltd  ', expectedVersion: 1 };
  const record = await acquired(OWNER, body);
  const { command } = prepared(record, context, body);
  assert.deepEqual(await commit(command), { outcome: 'committed' });
  assert.deepEqual({ ...(await tenantRow(tenant)) }, { display_name: 'Acme  Holdings\u00a0Ltd', legal_name: null, status: 'active', plan_key: 'starter', row_version: '2' });
  const audit = await auditFor(command.audit.correlationId);
  assert.deepEqual(audit.map((r) => ({ ...r })), [{
    actor_internal_user_id: OWNER.id, scope_type: 'platform', tenant_id: null, store_id: null, action_id: 'platform.tenant.display_name.update',
    required_permission: 'edit_tenant_profile', request_id: command.audit.correlationId, decision: 'allow', result_status: 'succeeded',
  }], 'one audit record naming the app-owned actor, never the provider UID');
  const events = await eventsFor(tenant);
  assert.deepEqual(events.map((e) => ({ ...e })), [{
    event_type: 'tenant.display_name_changed', event_version: 1, aggregate_type: 'tenant', aggregate_id: tenant, aggregate_version: '2',
    correlation_id: command.audit.correlationId, tenant_digest: null, store_digest: null, actor_digest: null, payload: { displayName: 'Acme  Holdings\u00a0Ltd' },
  }], 'exactly one event, sharing the audit record\'s correlation');
  assert.equal(await recordDone(record.operation.scope), true, 'the idempotency record is completed in the same transaction');
  // The response is lost; the retry acquires the same record and replays — no second mutation, audit record or event.
  const replay = await store.idempotency.acquire({ ...record.operation, lease: randomBytes(32).toString('base64url'), ...IDEMPOTENCY_POLICY }, signal());
  assert.equal(replay.outcome, 'replay');
  assert.deepEqual(keyring.unseal(replay.response, record.operation)?.body, JSON.stringify({ tenantId: tenant, displayName: 'Acme  Holdings\u00a0Ltd', version: 2 }));
  assert.equal((await eventsFor(tenant)).length, 1);
  assert.equal((await tenantRow(tenant)).row_version, '2');
});

test('M5D-06: a stale version, a missing tenant, changes already in place, a lost lease and a stale context each commit nothing', async () => {
  const tenant = await newTenant(`m5d-refuse-${SUFFIX}`);
  const context = await contextOf(OWNER);
  const nothingMoved = async (label, record, correlation) => {
    assert.deepEqual({ ...(await tenantRow(tenant)) }.row_version, '1', `${label}: no version moved`);
    assert.equal((await tenantRow(tenant)).display_name, `m5d-refuse-${SUFFIX}`, `${label}: no name moved`);
    assert.equal((await auditFor(correlation)).length, 0, `${label}: no audit record`);
    assert.equal((await eventsFor(tenant)).length, 0, `${label}: no event`);
    if (record !== null) assert.equal(await recordDone(record.operation.scope), false, `${label}: the record stays in progress`);
  };
  const stale = { tenantId: tenant, displayName: 'Stale', expectedVersion: 7 };
  let record = await acquired(OWNER, stale);
  let command = prepared(record, context, stale).command;
  assert.deepEqual(await commit(command), { outcome: 'conflict' });
  await nothingMoved('stale version', record, command.audit.correlationId);

  const missing = { tenantId: randomUUID(), displayName: 'Nobody', expectedVersion: 1 };
  record = await acquired(OWNER, missing);
  command = prepared(record, context, missing).command;
  assert.deepEqual(await commit(command), { outcome: 'not_found' });
  await nothingMoved('missing tenant', record, command.audit.correlationId);

  const same = { tenantId: tenant, displayName: ` m5d-refuse-${SUFFIX} `, expectedVersion: 1 };
  record = await acquired(OWNER, same);
  command = prepared(record, context, same).command;
  assert.deepEqual(await commit(command), { outcome: 'unchanged' });
  await nothingMoved('unchanged', record, command.audit.correlationId);

  const change = { tenantId: tenant, displayName: 'Would Change', expectedVersion: 1 };
  record = await acquired(OWNER, change);
  command = { ...prepared(record, context, change).command, lease: randomBytes(32).toString('base64url') };
  assert.deepEqual(await commit(command), { outcome: 'lease_lost' });
  await nothingMoved('lost lease', record, command.audit.correlationId);

  // The security version moves (the account row is touched), so the context planned before it no longer holds.
  const staleVersion = await contextOf(STALE_VERSION);
  await owner`update app_user set status = 'active' where internal_user_id = ${STALE_VERSION.id}`;
  record = await acquired(STALE_VERSION, change);
  command = prepared(record, staleVersion, change).command;
  assert.deepEqual(await commit(command), { outcome: 'unavailable' });
  await nothingMoved('moved security version', record, command.audit.correlationId);

  // The platform grant is withdrawn after the context was resolved.
  const staleGrant = await contextOf(STALE_GRANT);
  await owner`update user_membership set status = 'suspended' where internal_user_id = ${STALE_GRANT.id}`;
  record = await acquired(STALE_GRANT, change);
  command = prepared(record, staleGrant, change).command;
  assert.deepEqual(await commit(command), { outcome: 'unavailable' });
  await nothingMoved('withdrawn grant', record, command.audit.correlationId);
});

test('M5D-07: a fault after the mutation rolls back the name, the version, the audit record, the event and the completion together', async () => {
  const context = await contextOf(OWNER);
  // (a) An event ID that is not new: the enqueue answers false, and the whole transaction rolls back.
  const first = await newTenant(`m5d-atom-a-${SUFFIX}`);
  const firstBody = { tenantId: first, displayName: 'Atom First', expectedVersion: 1 };
  const committed = prepared(await acquired(OWNER, firstBody), context, firstBody).command;
  assert.deepEqual(await commit(committed), { outcome: 'committed' });
  const second = await newTenant(`m5d-atom-b-${SUFFIX}`);
  const body = { tenantId: second, displayName: 'Atom Second', expectedVersion: 1 };
  const record = await acquired(OWNER, body);
  const fresh = prepared(record, context, body).command;
  const reused = { ...fresh, events: [{ ...fresh.events[0], eventId: committed.events[0].eventId }] };
  assert.deepEqual(await commit(reused), { outcome: 'unavailable' });
  assert.deepEqual([(await tenantRow(second)).display_name, (await tenantRow(second)).row_version], [`m5d-atom-b-${SUFFIX}`, '1'], 'the mutation rolled back');
  assert.equal((await auditFor(fresh.audit.correlationId)).length, 0, 'the audit record rolled back');
  assert.equal((await eventsFor(second)).length, 0);
  assert.equal(await recordDone(record.operation.scope), false, 'the completion rolled back');

  // (b) A mutator that applies and then throws: nothing it or anything before it wrote survives.
  const throwing = createPostgresTransactionalStore({
    client,
    mutators: [{ ...TENANT_DISPLAY_NAME_MUTATOR, apply: async (sql, mutation) => { await TENANT_DISPLAY_NAME_MUTATOR.apply(sql, mutation); throw new Error('m5d injected'); } }],
    revalidate: revalidateTrustedScope,
  });
  const record2 = await acquired(OWNER, body);
  const command2 = prepared(record2, context, body).command;
  assert.deepEqual(await throwing.transactions.commit(command2, signal()), { outcome: 'unavailable' });
  assert.equal((await tenantRow(second)).row_version, '1');
  assert.equal((await auditFor(command2.audit.correlationId)).length, 0);
  assert.equal(await recordDone(record2.operation.scope), false);
});

test('M5D-08: concurrent commands at one expected version have exactly one winner', async () => {
  const tenant = await newTenant(`m5d-race-${SUFFIX}`);
  const context = await contextOf(SUPPORT);
  const commands = [];
  for (let i = 0; i < 8; i++) {
    const body = { tenantId: tenant, displayName: `Racer ${i}`, expectedVersion: 1 };
    commands.push(prepared(await acquired(SUPPORT, body), context, body).command);
  }
  const answers = await Promise.all(commands.map((command) => commit(command)));
  const outcomes = answers.map((a) => a.outcome).sort();
  assert.deepEqual(outcomes, ['committed', ...Array(7).fill('conflict')].sort(), JSON.stringify(answers));
  const winner = commands[answers.findIndex((a) => a.outcome === 'committed')];
  assert.deepEqual([(await tenantRow(tenant)).display_name, (await tenantRow(tenant)).row_version], [winner.mutation.changes.displayName, '2']);
  assert.equal((await eventsFor(tenant)).length, 1, 'one event');
  let audits = 0;
  for (const command of commands) audits += (await auditFor(command.audit.correlationId)).length;
  assert.equal(audits, 1, 'one audit record');
});

// ---------------------------------------------------------------------------
// the whole chain over HTTP, on the real resolver, authorizer and store
// ---------------------------------------------------------------------------

function send(port, method, path, headers = {}, body) {
  const payload = body === undefined ? undefined : Buffer.from(body);
  const framed = method === 'GET' ? headers : { 'content-length': String(payload?.length ?? 0), ...headers };
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: framed, agent: false }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

async function withChain(fn, over = {}) {
  const tokens = new Map([OWNER, SUPPORT, BILLING, TENANT_ONLY, STORE_ONLY].map((who) => [`tok-${who.uid}`, who.uid]));
  tokens.set('tok-unknown', `m5d-unknown-${SUFFIX}`);
  const readiness = createReadinessState();
  readiness.setReady();
  const logs = [];
  const app = createApp({
    readiness,
    log: { log: (line) => { logs.push(line); } },
    routes: [TENANT_DISPLAY_NAME_ROUTE],
    events: TENANT_DISPLAY_NAME_EVENTS,
    idempotency: { store: store.idempotency, keySecret: TEST_IDEMPOTENCY_KEY },
    transactions: { port: over.port ?? store.transactions },
    limits: testRequestLimits(),
    dependencyChecks: [(s) => principals.probe(s)],
    sessions: {
      admin: {
        trustedOrigins: [ADMIN_ORIGIN],
        verifier: {
          async verify(view) {
            const uid = tokens.get(view.bearerToken);
            return uid === undefined ? null : { verified: true, authProvider: 'firebase', authProviderUid: uid, authenticatedAt: Date.now(), secondFactor: 'totp' };
          },
        },
        admission: { admit: () => ({ admitted: true, securityVersion: 'v1' }) },
        authorizer: createPlatformRouteAuthorizer({ principals }),
        store: createMemorySessionStore(),
      },
    },
  });
  const server = createBoundedServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const signIn = async (who) => {
    const token = who === null ? 'tok-unknown' : `tok-${who.uid}`;
    const login = await send(port, 'POST', sessionPaths('admin').login, {
      origin: ADMIN_ORIGIN, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE, authorization: `Bearer ${token}`,
    });
    assert.equal(login.status, 200, `admin login: ${login.body}`);
    const cookie = (login.headers['set-cookie'] ?? [''])[0].split('; ')[0];
    const csrf = JSON.parse(login.body).csrfToken;
    return (body, key = randomUUID(), extra = {}) => send(port, 'PATCH', TENANT_DISPLAY_NAME_PATH, {
      origin: ADMIN_ORIGIN, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE, [SESSION_CSRF_HEADER]: csrf, cookie,
      'content-type': 'application/json', 'idempotency-key': key, ...extra,
    }, typeof body === 'string' ? body : JSON.stringify(body));
  };
  try {
    await fn({ port, signIn, logs });
  } finally {
    await new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  }
}
const errorOf = (reply) => JSON.parse(reply.body).error;

test('M5D-09: over HTTP the canonical authorizer admits System Owner and support_admin and refuses every other actor with one generic 403', async () => {
  const tenant = await newTenant(`m5d-http-authz-${SUFFIX}`);
  await withChain(async ({ signIn }) => {
    for (const [label, who] of [['billing_admin (Tenants at View)', BILLING], ['a tenant-role holder', TENANT_ONLY], ['a store-role holder', STORE_ONLY], ['no actor at all', null]]) {
      const patch = await signIn(who);
      const refused = await patch({ tenantId: tenant, displayName: 'Refused', expectedVersion: 1 }, randomUUID(), {
        'x-internal-user-id': OWNER.id, 'x-role': 'system_owner', 'x-permission': 'edit_tenant_profile', 'x-tenant-id': tenant,
      });
      assert.deepEqual([refused.status, errorOf(refused)], [403, 'forbidden'], `${label}: request-supplied identity, role and scope are never read`);
    }
    assert.equal((await tenantRow(tenant)).row_version, '1', 'nothing moved');
    const asOwner = await signIn(OWNER);
    const first = await asOwner({ tenantId: tenant, displayName: 'By Owner', expectedVersion: 1 });
    assert.deepEqual([first.status, JSON.parse(first.body)], [200, { tenantId: tenant, displayName: 'By Owner', version: 2 }], 'System Owner, through the same canonical rule');
    const support = await signIn(SUPPORT);
    const second = await support({ tenantId: tenant, displayName: 'By Support', expectedVersion: 2 });
    assert.deepEqual([second.status, JSON.parse(second.body)], [200, { tenantId: tenant, displayName: 'By Support', version: 3 }], 'support_admin (Tenants at Edit)');
    const audits = await owner_audits(tenant);
    assert.deepEqual(audits, [OWNER.id, SUPPORT.id], 'each audit record names the resolved internal actor, never the provider UID');
  });
});

async function owner_audits(tenant) {
  const rows = await owner`select a.actor_internal_user_id from audit_event a join tmpos_internal.outbox_event e on e.correlation_id::text = a.request_id
    where e.aggregate_id = ${tenant} order by e.aggregate_version`;
  return rows.map((r) => r.actor_internal_user_id);
}

test('M5D-10: over HTTP — 200, replay, 409, 404, 400 that records nothing, 422 key reuse, and the unchanged 200 with its replay', async () => {
  const tenant = await newTenant(`m5d-http-${SUFFIX}`);
  await withChain(async ({ signIn }) => {
    const patch = await signIn(OWNER);
    const key = randomUUID();
    const body = { tenantId: tenant, displayName: 'Http Name', expectedVersion: 1 };
    const first = await patch(body, key);
    assert.deepEqual([first.status, JSON.parse(first.body)], [200, { tenantId: tenant, displayName: 'Http Name', version: 2 }]);
    const replay = await patch(body, key);
    assert.deepEqual([replay.status, replay.headers['idempotent-replayed'], replay.body], [200, 'true', first.body], 'the exact retry replays');
    assert.equal((await eventsFor(tenant)).length, 1, 'no second event');
    assert.equal((await owner_audits(tenant)).length, 1, 'no second audit record');

    const stale = await patch({ tenantId: tenant, displayName: 'Stale', expectedVersion: 1 });
    assert.deepEqual([stale.status, errorOf(stale)], [409, 'write_conflict']);
    const missing = await patch({ tenantId: randomUUID(), displayName: 'Nobody', expectedVersion: 1 });
    assert.deepEqual([missing.status, errorOf(missing)], [404, 'not_found']);

    const scopeOf = (k) => keyring.operationOf(k, OWNER.principal, { method: 'PATCH', path: TENANT_DISPLAY_NAME_PATH, audience: 'admin', tenant: null, store: null, body: Buffer.alloc(0) }).scope;
    for (const invalid of [
      { tenantId: tenant, displayName: '   ', expectedVersion: 2 }, { tenantId: tenant.toUpperCase(), displayName: 'n', expectedVersion: 2 },
      { tenantId: tenant, displayName: 'n', expectedVersion: 0 }, { tenantId: tenant, displayName: 'n\u0000', expectedVersion: 2 },
      { tenantId: tenant, displayName: 'n', expectedVersion: 2, role: 'system_owner' },
    ]) {
      const invalidKey = randomUUID();
      const refused = await patch(invalid, invalidKey);
      assert.deepEqual([refused.status, errorOf(refused)], [400, 'invalid_request'], JSON.stringify(invalid));
      assert.equal(await recordDone(scopeOf(invalidKey)), false,
        `${JSON.stringify(invalid)}: the record is held in progress with no response, bound to this body until its lease expires`);
    }
    assert.equal((await eventsFor(tenant)).length, 1, 'no refused body wrote an event');
    assert.equal((await owner_audits(tenant)).length, 1, 'or an audit record');

    const reused = await patch({ ...body, displayName: 'Other Name' }, key);
    assert.deepEqual([reused.status, errorOf(reused)], [422, 'idempotency_key_reused']);
    const reusedMalformed = await patch({ ...body, displayName: '   ' }, key);
    assert.deepEqual([reusedMalformed.status, errorOf(reusedMalformed)], [422, 'idempotency_key_reused'], 'a spent key with a malformed body is the same conflict');

    const sameKey = randomUUID();
    const same = await patch({ tenantId: tenant, displayName: '  Http Name ', expectedVersion: 2 }, sameKey);
    assert.deepEqual([same.status, JSON.parse(same.body)], [200, { tenantId: tenant, displayName: 'Http Name', version: 2 }], 'unchanged: the current representation');
    const sameReplay = await patch({ tenantId: tenant, displayName: '  Http Name ', expectedVersion: 2 }, sameKey);
    assert.deepEqual([sameReplay.status, sameReplay.headers['idempotent-replayed'], sameReplay.body], [200, 'true', same.body], 'and it replays');
    assert.equal((await tenantRow(tenant)).row_version, '2', 'no version moved');
    assert.equal((await eventsFor(tenant)).length, 1, 'no event for the unchanged request');
    assert.equal((await owner_audits(tenant)).length, 1, 'no audit record for it either');
  });
});

test('M5D-11: readiness reflects the store and the resolver, and health touches neither', async () => {
  await withChain(async ({ port }) => {
    assert.equal((await send(port, 'GET', '/readiness')).status, 200);
    assert.equal((await send(port, 'GET', '/health')).status, 200);
  });
  const down = { commit: (...args) => store.transactions.commit(...args), probe: () => false };
  await withChain(async ({ port }) => {
    assert.equal((await send(port, 'GET', '/readiness')).status, 503, 'a store that cannot serve is not ready');
    assert.equal((await send(port, 'GET', '/health')).status, 200, 'while the process is alive');
  }, { port: down });
});

// ---------------------------------------------------------------------------
// rollback and upgrade — inside one transaction that is rolled back
// ---------------------------------------------------------------------------

test('M5D-12: 008 refuses to roll back past a moved version or over a stray object, otherwise reverses exactly, and re-applies over existing rows', async () => {
  const ROLLBACK = new Error('m5d: roll the proof back');
  const outcome = await owner.begin(async (tx) => {
    const code = async (fn) => {
      try { await tx.savepoint(fn); return null; } catch (err) { return err.code ?? String(err.message); }
    };
    // This suite has moved versions, so the rollback refuses and drops nothing.
    assert.ok((await tx`select count(*)::int as n from public.tenant where row_version > 1`)[0].n > 0);
    assert.equal(await code((sp) => sp.unsafe(DOWN_008).simple()), '55006', 'a moved version refuses the rollback');
    // Reset every version (only inside this transaction), then a stray object in the schema still refuses it.
    await tx.unsafe('alter table public.tenant disable trigger trg_tenant_row_version');
    await tx.unsafe('update public.tenant set row_version = 1 where row_version <> 1');
    await tx.unsafe('alter table public.tenant enable always trigger trg_tenant_row_version');
    await tx.unsafe('create table tmpos_command.m5d_stray (id integer)');
    assert.equal(await code((sp) => sp.unsafe(DOWN_008).simple()), '2BP01', 'a stray object refuses the rollback');
    await tx.unsafe('drop table tmpos_command.m5d_stray');

    await tx.unsafe(DOWN_008).simple();
    const [gone] = await tx`select pg_catalog.to_regnamespace('tmpos_command') is null as schema,
      (select count(*)::int from pg_catalog.pg_attribute where attrelid = 'public.tenant'::regclass and attname = 'row_version' and not attisdropped) as columns,
      (select count(*)::int from pg_catalog.pg_trigger where tgrelid = 'public.tenant'::regclass and tgname = 'trg_tenant_row_version') as triggers,
      pg_catalog.to_regnamespace('tmpos_internal') is not null as store_schema, pg_catalog.to_regnamespace('tmpos_identity') is not null as identity_schema`;
    assert.deepEqual({ ...gone }, { schema: true, columns: 0, triggers: 0, store_schema: true, identity_schema: true }, 'exactly 008 is gone; 006 and 007 stay');

    // The upgrade from 007: rows that exist before 008 each start at version 1, and the verify section passes.
    const [{ tenant_id: pre }] = await tx`insert into public.tenant (display_name) values (${`m5d-pre-${SUFFIX}`}) returning tenant_id`;
    await tx.unsafe(UP_008).simple();
    const [{ row_version: preVersion }] = await tx`select row_version from public.tenant where tenant_id = ${pre}`;
    assert.equal(preVersion, '1');
    const [{ other }] = await tx`select count(*)::int as other from public.tenant where row_version <> 1`;
    assert.equal(other, 0, 'every existing row starts at 1');
    const [answer] = await tx`select o_outcome, o_version from tmpos_command.m5_tenant_display_name_update(${pre}::uuid, 1::bigint, 'After Upgrade'::text)`;
    assert.deepEqual({ ...answer }, { o_outcome: 'applied', o_version: '2' }, 'and the re-applied operation works');
    throw ROLLBACK;
  }).then(() => 'committed', (err) => (err === ROLLBACK ? 'rolled back' : Promise.reject(err)));
  assert.equal(outcome, 'rolled back');
  const [present] = await owner`select pg_catalog.to_regprocedure('tmpos_command.m5_tenant_display_name_update(uuid, bigint, text)') is not null as operation,
    (select count(*)::int from pg_catalog.pg_trigger where tgrelid = 'public.tenant'::regclass and tgname = 'trg_tenant_row_version') as triggers`;
  assert.deepEqual({ ...present }, { operation: true, triggers: 1 }, 'the shared database keeps 008');
});

test('M5D-13: 008 refuses to finish while any role the runtime could hold is a member of its owner, SET-only included, or the schema grants more than USAGE', async () => {
  // A clean apply leaves exactly the owner and tmpos_app's non-grantable USAGE on the schema.
  const acl = await owner`select coalesce(a.grantee::regrole::text, '?') as grantee, a.privilege_type as privilege, a.is_grantable as grantable
    from pg_catalog.pg_namespace n cross join pg_catalog.aclexplode(coalesce(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) a
    where n.nspname = 'tmpos_command' and a.grantee <> n.nspowner`;
  assert.deepEqual(acl.map((r) => ({ ...r })), [{ grantee: 'tmpos_app', privilege: 'USAGE', grantable: false }]);
  // Section 6 is the up file's last DO block; it is re-run over a state it must refuse, inside a transaction rolled back.
  const VERIFY = UP_008.slice(UP_008.lastIndexOf('do $$'));
  const [{ ownerRole }] = await owner`select n.nspowner::regrole::text as "ownerRole" from pg_catalog.pg_namespace n where n.nspname = 'tmpos_command'`;
  const ROLLBACK = new Error('m5d: roll the proof back');
  const outcome = await owner.begin(async (tx) => {
    const code = async (fn) => {
      try { await tx.savepoint(fn); return null; } catch (err) { return err.code ?? String(err.message); }
    };
    assert.equal(await code((sp) => sp.unsafe(VERIFY).simple()), null, 'the verify section passes over the applied state (positive control)');
    assert.equal(await code(async (sp) => {
      await sp.unsafe('grant create on schema tmpos_command to tmpos_app');
      await sp.unsafe(VERIFY).simple();
    }), '55000', 'a CREATE grant on the schema refuses');
    assert.equal(await code(async (sp) => {
      await sp.unsafe(`grant "${ownerRole}" to tmpos_app with inherit false, set true`);
      assert.equal((await sp`select pg_catalog.pg_has_role('tmpos_app', ${ownerRole}, 'USAGE') as usage`)[0].usage, false, 'USAGE does not report a SET-only membership');
      await sp.unsafe(VERIFY).simple();
    }), '55000', 'a SET-only membership in the owner refuses');
    throw ROLLBACK;
  }).then(() => 'committed', (err) => (err === ROLLBACK ? 'rolled back' : Promise.reject(err)));
  assert.equal(outcome, 'rolled back');
  const [{ member }] = await owner`select pg_catalog.pg_has_role('tmpos_app', ${ownerRole}, 'MEMBER') as member`;
  assert.equal(member, false, 'the shared database keeps no membership');
});

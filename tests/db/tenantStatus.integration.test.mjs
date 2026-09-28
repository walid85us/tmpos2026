// Phase 4.0 M5-GIAM-D1-P2 — the tenant lifecycle command against REAL PostgreSQL: migration 010 (the tenant access
// version and the one fixed status operation), the privilege containment that makes that operation the only path, the
// M6 store committing the command with its mutator, the trusted context's revalidation and the step-up deadline, the
// audit record and the event, concurrency, and 010's apply, upgrade and rollback.
//
// DISPOSABLE ONLY. The target is the harness's resolved target: a supplied CI service when one is bound, otherwise a cluster this file creates and
// destroys; assertDisposableTestDsn refuses anything else before a statement runs. Every fixture is synthetic and
// randomly named, so the suite re-runs on the shared CI service where earlier suites already applied 001-009 and may
// have moved other tenants' versions. The rollback and upgrade proof runs inside one transaction that is rolled back,
// so the shared database keeps its state.
//
// M5-ADMIN-REVOKE-P1: the store runs the production revalidator whole — 009's locks, the presenting administrative
// session held, then 013's read of that session's standing — so every context-carrying command below is presented by a
// real live administrative session, established the way the login establishes one (sessionOf).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { resolveDisposableTarget, testClient, testDriver } from './localPostgres.harness.mjs';
import {
  assertDisposableTestDsn,
  createPostgresExecutor,
  runTrustedApply,
} from '../../server/platform-identity/migrationExecutor.ts';
import { createNodeFsPort } from '../../server/platform-identity/migrationEngine.ts';
import { runtimeClientOptions } from '../../server/platform-identity/db.ts';
import { createSupervisedPgClient } from '../../server/persistence/supervisedPgClient.ts';
import { createPostgresTransactionalStore } from '../../server/persistence/postgresTransactionalStore.ts';
import {
  createPostgresPrincipalResolver, lockPlatformAuthority, revalidatePlatformAuthority,
} from '../../server/persistence/postgresPrincipalResolver.ts';
import { createPostgresPlatformAdmission, readPlatformAdmission } from '../../server/persistence/postgresPlatformAdmission.ts';
import { createPostgresSessionStore, holdAdministrativeSession } from '../../server/persistence/postgresSessionStore.ts';
import { TENANT_STATUS_MUTATOR } from '../../server/persistence/tenantStatusMutator.ts';
import {
  createPlatformContextRevalidator, createPlatformEstablishCheck, createPlatformSessionAdmission,
} from '../../server/composition/platformAuthorization.ts';
import { prepareCommand } from '../../server/runtime/commandTransaction.ts';
import { IDEMPOTENCY_POLICY, createIdempotencyKeyring } from '../../server/runtime/idempotency.ts';
import { TEST_IDEMPOTENCY_KEY } from '../../server/runtime/idempotencyStore.testkit.ts';
import { defineOutboxEvents } from '../../server/runtime/outbox.ts';
import { selectScope } from '../../server/runtime/principals.ts';
import { RECENT_AUTH_MAX_AGE_MS, principalKeyOf } from '../../server/runtime/sessions.ts';
import {
  TENANT_STATUS_CONTRACT,
  TENANT_STATUS_EVENTS,
  TENANT_STATUS_PATH,
  planTenantStatus,
} from '../../server/runtime/tenantStatus.ts';

const MIG_REL = 'server/platform-identity/migrations';
const MIG_DIR = new URL(`../../${MIG_REL}/`, import.meta.url).pathname.replace(/\/$/, '');
const UP_010 = readFileSync(`${MIG_DIR}/010_m5_tenant_lifecycle_command.up.sql`, 'utf8');
const DOWN_010 = readFileSync(`${MIG_DIR}/010_m5_tenant_lifecycle_command.down.sql`, 'utf8');
// M5-TENANT-SESSION-P1: 016's trigger now owns every write of access_version, and the chain rolls back NEWEST FIRST.
const DOWN_016 = readFileSync(`${MIG_DIR}/016_m5_tenant_session_ordering.down.sql`, 'utf8');
/**
 * The production revalidator, composed exactly as productionTransactions.ts composes it: 009's exact-authority routine,
 * the presenting administrative session held, 013's read of that session's standing (M5-ADMIN-REVOKE-P1), then the
 * permission on the built-in definitions.
 */
const REVALIDATE = createPlatformContextRevalidator({
  authority: revalidatePlatformAuthority, session: (sql, key) => holdAdministrativeSession(sql, key, Date.now()), read: readPlatformAdmission,
});
const MIGRATOR = { purpose: 'migration', migratorRef: 'm5s-migrator', runtimeRef: 'm5s-runtime' };
const LOCK_KEY = 528_510;
const NOW = () => new Date().toISOString();

/** The non-owner LOGIN the store and the resolver connect as: tmpos_app and tmpos_audit_writer, nothing else. */
const RUNTIME_LOGIN = 'tmpos_m5s_probe';
/** A second login that holds tmpos_app only through a SET-only membership, never inherited. */
const SETONLY_LOGIN = 'tmpos_m5s_setonly';
const SUFFIX = randomUUID().slice(0, 8);
const REQUIREMENT = Object.freeze({ scope: 'platform', permission: 'change_tenant_status' });
const REASON = 'Payment dispute escalated by the billing team.';
const signal = () => AbortSignal.timeout(10_000);

// ---------------------------------------------------------------------------
// cluster lifecycle
// ---------------------------------------------------------------------------

const TARGET = resolveDisposableTarget('M5S');
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
const owner = connect(undefined, 3);
let runtime = null;
let setonly = null;
let client = null;

test.after(async () => {
  if (client) await client.end();
  if (runtime) await runtime.end({ timeout: 5 });
  if (setonly) await setonly.end({ timeout: 5 });
  await owner.end({ timeout: 5 });
  if (cluster) cluster.stop();
});

// ---------------------------------------------------------------------------
// setup: real migrations, real non-owner principals, synthetic identities
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

// A SET-only member holds nothing until it SETs ROLE, which is the path a privilege check that asks only
// about inherited rights would miss (migration 010 section 5 asks pg_has_role(..., 'MEMBER')).
await owner.unsafe(`drop role if exists ${SETONLY_LOGIN}`);
await owner.unsafe(`create role ${SETONLY_LOGIN} login nosuperuser nocreatedb nocreaterole noreplication nobypassrls noinherit`);
await owner.unsafe(`grant tmpos_app to ${SETONLY_LOGIN}`);
setonly = connect(SETONLY_LOGIN, 1);

/** The transaction kernel over the runtime login (no TLS on a disposable target). */
client = createSupervisedPgClient(testDriver(TARGET), driverDsn(TARGET_DSN, RUNTIME_LOGIN), {
  ...runtimeClientOptions(TARGET_DSN),
  ssl: false,
  max: 6,
  idle_timeout: 0,
  user: RUNTIME_LOGIN,
});
const store = createPostgresTransactionalStore({ client, mutators: [TENANT_STATUS_MUTATOR], revalidate: REVALIDATE });
const principals = createPostgresPrincipalResolver({ client });
/** The production session store over the same kernel, with the administrative login's standing check (M5-ADMIN-REVOKE-P1). */
const SESSIONS = createPostgresSessionStore({
  client, standing: createPlatformEstablishCheck({ read: readPlatformAdmission, authority: lockPlatformAuthority }),
});
const ADMISSION = createPlatformSessionAdmission({ admission: createPostgresPlatformAdmission({ client }) });
const keyring = createIdempotencyKeyring(TEST_IDEMPOTENCY_KEY);
const EVENTS = defineOutboxEvents(TENANT_STATUS_EVENTS);

/** A synthetic platform actor: an identity, an active account and, unless null, one active membership. */
async function actor(label, membership) {
  const uid = `m5s-${label}-${SUFFIX}`;
  const [{ internal_user_id: id }] = await owner`
    insert into platform_identity (auth_provider, auth_provider_uid) values ('firebase', ${uid}) returning internal_user_id`;
  await owner`insert into app_user (internal_user_id, status) values (${id}, 'active')`;
  if (membership !== null) {
    await owner`insert into user_membership (internal_user_id, tenant_id, store_id, scope_type, role_id, status)
      values (${id}, ${membership.tenant ?? null}, ${membership.store ?? null}, ${membership.scope}, ${membership.role}, 'active')`;
  }
  return { id, uid, principal: Object.freeze({ authProvider: 'firebase', authProviderUid: uid }) };
}

const tenantRow = async (id) =>
  (await owner`select display_name, status, row_version, access_version from tenant where tenant_id = ${id}`)[0];
const newTenant = async (label, status = 'active') =>
  (await owner`insert into tenant (display_name, status) values (${`m5s-${label}-${SUFFIX}`}, ${status}) returning tenant_id`)[0].tenant_id;
const auditsOf = (tenant) => owner`select actor_internal_user_id, scope_type, tenant_id, store_id, subject_tenant_id, action_id,
  required_permission, request_id, decision, result_status, reason_code, human_readable_reason
  from audit_event where subject_tenant_id = ${tenant} order by occurred_at, request_id`;
const eventsFor = (tenant) => owner`select event_type, event_version, aggregate_type, aggregate_id, aggregate_version, correlation_id,
  tenant_digest, store_digest, actor_digest, payload from tmpos_internal.outbox_event where aggregate_id = ${tenant} order by aggregate_version`;
const recordDone = async (scope) => (await owner`select response is not null as done from tmpos_internal.idempotency_record where scope = ${scope}`)[0]?.done;
/** 010's operation, called directly as the mutator calls it. */
const call = async (tenant, expected, from, to, sql = runtime) =>
  (await sql`select o_outcome, o_version from tmpos_command.m5_tenant_status_change(${tenant}::uuid, ${expected}::bigint, ${from}::text, ${to}::text)`)[0];
const refusalCode = async (fn) => {
  try { await fn(); return null; } catch (err) { return err.code ?? String(err.message); }
};

const OWNER = await actor('owner', { scope: 'platform', role: 'system_owner' });
const OPS = await actor('ops', { scope: 'platform', role: 'operations_admin' });
const SUPPORT = await actor('support', { scope: 'platform', role: 'support_admin' });
const BILLING = await actor('billing', { scope: 'platform', role: 'billing_admin' });

/**
 * A live administrative session of `who`, established exactly as the production login establishes one — admitted by
 * migration 013 at its current witness, then the production session store's own establish: the standing re-read under
 * 009's locks, the session row and its login audit record, in one transaction — and its store key (the digest of an
 * identifier nobody holds). No row is written around the store: the store's establish is the login's only write.
 */
async function sessionOf(who) {
  const decision = await ADMISSION.admit(who.principal, 'admin', signal());
  assert.equal(decision?.admitted, true, `${who.uid} is admitted`);
  const key = createHash('sha256').update(randomBytes(32).toString('base64url')).digest('base64url');
  const t = Date.now();
  const record = Object.freeze({
    audience: 'admin', authProvider: who.principal.authProvider, authProviderUid: who.principal.authProviderUid,
    principalKey: principalKeyOf(who.principal), securityVersion: decision.securityVersion, authenticatedAt: t, createdAt: t, lastSeenAt: t, validatedAt: t,
  });
  const audit = Object.freeze({ action: 'login', operationId: randomUUID(), actor: decision.context.actor, authenticatedAt: t });
  assert.equal(await SESSIONS.establish(key, record, null, audit, signal()), 'established', `${who.uid}: a session is established`);
  return key;
}
/** The store key of the session each actor's latest context was planned under (M5-ADMIN-REVOKE-P1). */
const SESSION_KEYS = new Map();

/**
 * The trusted scope the canonical authorizer would hand the command: resolved and selected by the real resolver — and,
 * as the chain presents every command through a live administrative session, a session of that actor established at
 * this moment's witness, whose key prepared() binds to the command.
 */
async function contextOf(who) {
  const resolution = await principals.resolve(who.principal, signal());
  assert.equal(resolution.outcome, 'resolved', `${who.uid} resolves`);
  const selection = selectScope(resolution.principal, 'platform', { tenant: null, store: null });
  assert.equal(selection.outcome, 'selected');
  SESSION_KEYS.set(selection.scope.actor, await sessionOf(who));
  return selection.scope;
}

/** An idempotency record acquired under a fresh key, as the chain acquires one. */
async function acquired(who, body) {
  const operation = keyring.operationOf(randomUUID(), who.principal, {
    method: 'PATCH', path: TENANT_STATUS_PATH, audience: 'admin', tenant: null, store: null, actor: null, body: Buffer.from(JSON.stringify(body)),
  });
  const lease = randomBytes(32).toString('base64url');
  assert.deepEqual(await store.idempotency.acquire({ ...operation, lease, ...IDEMPOTENCY_POLICY }, signal()), { outcome: 'acquired', reclaimed: false });
  return { operation, lease };
}

const bodyOf = (tenant, status, expectedVersion, reason = REASON) => ({ tenantId: tenant, status, reason, expectedVersion });

/**
 * The command the chain would commit: planned from the body, prepared under the record's lease and the trusted context,
 * presented by the actor's session from contextOf.
 */
function prepared({ operation, lease }, context, body, authNotAfter = Date.now() + RECENT_AUTH_MAX_AGE_MS) {
  const plan = planTenantStatus({ audience: 'admin', body, newAggregateId: randomUUID() });
  const command = prepareCommand(TENANT_STATUS_CONTRACT, EVENTS, plan, {
    scope: operation.scope, lease, newAggregateId: randomUUID(), authorization: REQUIREMENT, context, authNotAfter,
    sessionKey: context === null ? null : (SESSION_KEYS.get(context.actor) ?? null),
    seal: (envelope) => keyring.seal(envelope, operation),
  });
  assert.ok(command !== null, 'the plan is in contract');
  return command;
}
const commit = (command) => store.transactions.commit(command, signal());

/** Acquire, prepare and commit one transition as the chain would. */
async function transition(who, tenant, status, expectedVersion, over = {}) {
  const body = bodyOf(tenant, status, expectedVersion, over.reason);
  const record = await acquired(who, body);
  const context = over.context === undefined ? await contextOf(who) : over.context;
  const command = prepared(record, context, body, over.authNotAfter);
  const answer = await commit(command.command);
  return { record, command: command.command, answer };
}

// ---------------------------------------------------------------------------
// migration 010 as applied
// ---------------------------------------------------------------------------

test('M5S-01: 001-020 apply clean; 010 is its column, its one operation and one narrow grant', async () => {
  assert.equal(applyReport.outcome, 'complete', JSON.stringify(applyReport).slice(0, 400));
  const ledger = await owner`select version, dirty from public.schema_migrations order by version`;
  assert.deepEqual(ledger.map((r) => [r.version, r.dirty]),
    ['001', '002', '003', '004', '005', '006', '007', '008', '009', '010', '011', '012', '013', '014', '015', '016', '017', '018', '019', '020'].map((v) => [v, false]));

  const [column] = await owner`select a.atttypid::regtype::text as type, a.attnotnull as not_null,
      pg_catalog.pg_get_expr(d.adbin, d.adrelid) as dflt,
      (select pg_catalog.pg_get_constraintdef(c.oid) from pg_catalog.pg_constraint c where c.conname = 'tenant_access_version_chk') as chk
    from pg_catalog.pg_attribute a join pg_catalog.pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
    where a.attrelid = 'public.tenant'::regclass and a.attname = 'access_version' and not a.attisdropped`;
  assert.equal(column.type, 'bigint');
  assert.equal(column.not_null, true);
  assert.match(String(column.dflt), /^1$/);
  assert.match(String(column.chk), /access_version >= 1/);

  const [fn] = await owner`select p.prosecdef, p.provolatile, p.proconfig, p.proowner = n.nspowner as owned_by_schema,
      pg_catalog.pg_get_function_result(p.oid) as result
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where p.oid = 'tmpos_command.m5_tenant_status_change(uuid, bigint, text, text)'::regprocedure`;
  assert.equal(fn.prosecdef, true, 'SECURITY DEFINER');
  assert.equal(fn.provolatile, 'v');
  assert.deepEqual(fn.proconfig, ['search_path=pg_catalog, pg_temp']);
  assert.equal(fn.owned_by_schema, true, 'owned by the schema owner, as 008 and 009 are');
  assert.match(String(fn.result), /o_outcome text/);

  // tmpos_command now holds exactly five routines: 008's two, 009's two and this one.
  const names = await owner`select p.proname from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'tmpos_command' order by p.proname`;
  assert.deepEqual(names.map((r) => r.proname), [
    'm5_revalidate_platform_authority', 'm5_tenant_display_name_update', 'm5_tenant_display_name_update_v2',
    'm5_tenant_row_version', 'm5_tenant_status_change',
  ]);

  // EXECUTE reaches tmpos_app and nobody else; PUBLIC lost the default.
  const [{ ok: appMay }] = await owner`select pg_catalog.has_function_privilege('tmpos_app', 'tmpos_command.m5_tenant_status_change(uuid, bigint, text, text)', 'EXECUTE') as ok`;
  assert.equal(appMay, true, 'tmpos_app may call the operation');
  for (const role of ['public', 'anon', 'authenticated', 'tmpos_audit_writer']) {
    const [{ ok }] = await owner`select pg_catalog.has_function_privilege(${role}, 'tmpos_command.m5_tenant_status_change(uuid, bigint, text, text)', 'EXECUTE') as ok`;
    assert.equal(ok, false, `${role} may not call the operation`);
  }
});

test('M5S-02: no runtime-holdable role may write the status or the access version — directly, inherited, or after SET ROLE', async () => {
  const tenant = await newTenant('privilege');
  for (const role of ['tmpos_app', 'tmpos_audit_writer', 'anon', 'authenticated']) {
    for (const [column, privilege] of [['status', 'UPDATE'], ['status', 'INSERT'], ['access_version', 'UPDATE'], ['access_version', 'INSERT']]) {
      const [{ ok }] = await owner`select pg_catalog.has_column_privilege(${role}, 'public.tenant'::regclass, ${column}, ${privilege}) as ok`;
      assert.equal(ok, false, `${role} may not ${privilege} tenant.${column}`);
    }
    const [{ del }] = await owner`select pg_catalog.has_table_privilege(${role}, 'public.tenant'::regclass, 'DELETE') as del`;
    assert.equal(del, false, `${role} may not delete a tenant row`);
  }
  // 005's surviving column grant is legal_name alone (009 revoked display_name; DA-29 keeps this one).
  const [{ ok: legal }] = await owner`select pg_catalog.has_column_privilege('tmpos_app', 'public.tenant'::regclass, 'legal_name', 'UPDATE') as ok`;
  assert.equal(legal, true, 'legal_name is left exactly as 005 wrote it');

  // The runtime login, inheriting tmpos_app, cannot write either column however it phrases the statement.
  for (const statement of [
    (sql) => sql`update public.tenant set status = 'suspended' where tenant_id = ${tenant}`,
    (sql) => sql`update public.tenant set access_version = 99 where tenant_id = ${tenant}`,
    (sql) => sql`update public.tenant set status = 'suspended', access_version = 99 where tenant_id = ${tenant}`,
    (sql) => sql`delete from public.tenant where tenant_id = ${tenant}`,
  ]) {
    assert.equal(await refusalCode(() => statement(runtime)), '42501', 'the runtime login is refused');
  }
  // A session that sets the tenant-scope settings 005's policies trust still cannot: no column privilege exists to abuse.
  assert.equal(await refusalCode(async () => {
    await runtime`select set_config('app.scope_type', 'tenant', true)`;
    await runtime`select set_config('app.tenant_id', ${tenant}, true)`;
    await runtime`update public.tenant set status = 'suspended' where tenant_id = ${tenant}`;
  }), '42501', 'session-set settings cannot bypass the command');

  // A SET-only member holds nothing until it sets the role — and then still holds no privilege on these columns.
  assert.equal(await refusalCode(() => setonly`update public.tenant set status = 'suspended' where tenant_id = ${tenant}`), '42501',
    'noinherit: refused before SET ROLE');
  assert.equal(await refusalCode(async () => {
    await setonly`set role tmpos_app`;
    await setonly`update public.tenant set status = 'suspended' where tenant_id = ${tenant}`;
  }), '42501', 'and refused after SET ROLE');
  await setonly`reset role`;
  assert.equal((await tenantRow(tenant)).status, 'active', 'the row never moved');
});

test('M5S-03: the operation answers exactly its five outcomes, and every transition but active<->suspended is refused', async () => {
  const tenant = await newTenant('outcomes');
  const v1 = Number((await tenantRow(tenant)).row_version);
  // A pair the command never makes is 'invalid', decided before the row is even read.
  for (const [from, to] of [['active', 'active'], ['suspended', 'suspended'], ['active', 'read_only'], ['read_only', 'active'],
    ['overdue', 'suspended'], ['suspended', 'trialing'], ['active', 'ACTIVE'], ['', 'suspended'], ['active', '']]) {
    assert.deepEqual(await call(tenant, v1, from, to), { o_outcome: 'invalid', o_version: null }, `${from} -> ${to}`);
  }
  assert.deepEqual(await call(tenant, 0, 'active', 'suspended'), { o_outcome: 'invalid', o_version: null }, 'version 0');
  assert.deepEqual(await call(randomUUID(), v1, 'active', 'suspended'), { o_outcome: 'not_found', o_version: null });
  assert.deepEqual(await call(tenant, v1 + 5, 'active', 'suspended'), { o_outcome: 'conflict', o_version: null });

  // A row that does not hold the status the transition starts from: invalid_state, and nothing is written.
  for (const status of ['read_only', 'overdue', 'trialing', 'pending_activation']) {
    const other = await newTenant(`from-${status}`, status);
    const before = await tenantRow(other);
    assert.deepEqual(await call(other, Number(before.row_version), 'active', 'suspended'), { o_outcome: 'invalid_state', o_version: null }, `a ${status} tenant`);
    assert.deepEqual(await tenantRow(other), before, `${status} is untouched`);
  }

  // Applied: the status and the access version move together, and row_version moves exactly once.
  assert.deepEqual(await call(tenant, v1, 'active', 'suspended'), { o_outcome: 'applied', o_version: String(v1 + 1) });
  assert.deepEqual(await tenantRow(tenant), {
    display_name: `m5s-outcomes-${SUFFIX}`, status: 'suspended', row_version: String(v1 + 1), access_version: '2',
  });
  // The same target again is now an invalid transition, not a no-op.
  assert.deepEqual(await call(tenant, v1 + 1, 'active', 'suspended'), { o_outcome: 'invalid_state', o_version: null },
    'asking for the state it already holds');
  // And back: a second transition, a second access version.
  assert.deepEqual(await call(tenant, v1 + 1, 'suspended', 'active'), { o_outcome: 'applied', o_version: String(v1 + 2) });
  assert.deepEqual(await tenantRow(tenant), {
    display_name: `m5s-outcomes-${SUFFIX}`, status: 'active', row_version: String(v1 + 2), access_version: '3',
  });
});

test('M5S-04: a harmless profile edit moves the row version and NOT the access version, so it ends no session', async () => {
  const tenant = await newTenant('profile');
  const before = await tenantRow(tenant);
  const [renamed] = await runtime`select o_outcome, o_version from tmpos_command.m5_tenant_display_name_update_v2(
    ${tenant}::uuid, ${before.row_version}::bigint, ${`m5s-renamed-${SUFFIX}`}::text)`;
  assert.equal(renamed.o_outcome, 'applied');
  const after = await tenantRow(tenant);
  assert.equal(after.row_version, String(Number(before.row_version) + 1), 'the row version moved');
  assert.equal(after.access_version, before.access_version, 'the access version did not');
  // And 005's surviving legal_name grant moves the row version too, still without touching the access
  // version. 005's policy is tenant-scoped, so the write needs the settings any tenant session sets.
  await runtime`select set_config('app.scope_type', 'tenant', false)`;
  await runtime`select set_config('app.tenant_id', ${tenant}, false)`;
  const written = await runtime`update public.tenant set legal_name = ${`m5s-legal-${SUFFIX}`} where tenant_id = ${tenant}`;
  assert.equal(written.count, 1, 'the legal_name grant 005 wrote is still reachable under its own policy');
  await runtime`select set_config('app.scope_type', '', false)`;
  await runtime`select set_config('app.tenant_id', '', false)`;
  const third = await tenantRow(tenant);
  assert.equal(third.row_version, String(Number(after.row_version) + 1));
  assert.equal(third.access_version, before.access_version, 'still the version every session was admitted under');
});

// ---------------------------------------------------------------------------
// the command, committed through the real store
// ---------------------------------------------------------------------------

test('M5S-05: a suspension commits the status, both versions, one audit record, one event and the completion together', async () => {
  const tenant = await newTenant('commit');
  const v1 = Number((await tenantRow(tenant)).row_version);
  const { record, command, answer } = await transition(OWNER, tenant, 'suspended', v1);
  assert.deepEqual(answer, { outcome: 'committed' });

  assert.deepEqual(await tenantRow(tenant), {
    display_name: `m5s-commit-${SUFFIX}`, status: 'suspended', row_version: String(v1 + 1), access_version: '2',
  }, 'the status and both versions moved exactly once');
  assert.equal(await recordDone(record.operation.scope), true, 'the idempotency record completed in the same transaction');

  const audits = await auditsOf(tenant);
  assert.equal(audits.length, 1, 'exactly one audit record names this tenant as its subject');
  const [audit] = audits;
  assert.equal(audit.subject_tenant_id, tenant, 'the record names its tenant directly, with no join to the outbox');
  assert.equal(audit.actor_internal_user_id, OWNER.id, 'the app-owned actor, never a provider uid');
  assert.equal(audit.scope_type, 'platform');
  assert.equal(audit.tenant_id, null, 'a platform-scope record carries no scope tenant');
  assert.equal(audit.action_id, 'platform.tenant.status.change');
  assert.equal(audit.required_permission, 'change_tenant_status');
  assert.equal(audit.decision, 'allow');
  assert.equal(audit.result_status, 'succeeded');
  assert.equal(audit.reason_code, 'tenant_status_active_to_suspended', 'the code names the status left and the status taken');
  assert.equal(audit.human_readable_reason, REASON, 'the operator\'s own bounded reason, stored verbatim');
  assert.equal(audit.request_id, command.audit.correlationId);

  const events = await eventsFor(tenant);
  assert.equal(events.length, 1, 'exactly one event');
  const [event] = events;
  assert.equal(event.event_type, 'tenant.suspended');
  assert.equal(event.event_version, 1);
  assert.equal(event.aggregate_type, 'tenant');
  assert.equal(event.aggregate_id, tenant);
  assert.equal(event.aggregate_version, String(v1 + 1));
  assert.equal(event.correlation_id, command.audit.correlationId, 'the event and the audit share one correlation');
  assert.deepEqual([event.tenant_digest, event.store_digest, event.actor_digest], [null, null, null]);
  assert.deepEqual(event.payload, { fromStatus: 'active' });
  assert.ok(!JSON.stringify(event.payload).includes(REASON), 'no event carries the reason text');

  // Reactivation: the other event, the access version moved a second time, never back to what it was.
  const v2 = Number((await tenantRow(tenant)).row_version);
  const back = await transition(OWNER, tenant, 'active', v2);
  assert.deepEqual(back.answer, { outcome: 'committed' });
  const row = await tenantRow(tenant);
  assert.deepEqual([row.status, row.access_version], ['active', '3'], 'reactivation moves the version forward, never back');
  assert.deepEqual((await eventsFor(tenant)).map((e) => e.event_type), ['tenant.suspended', 'tenant.reactivated']);
  assert.deepEqual((await auditsOf(tenant)).map((a) => a.reason_code),
    ['tenant_status_active_to_suspended', 'tenant_status_suspended_to_active']);
});

test('M5S-06: a deterministic rejection writes no business state and SEALS its own 409 as the completion; a missing tenant seals nothing', async () => {
  // M5-GIAM-D1-P2-R1. The two post-authorization rejections are decided inside the transaction that
  // already fenced the lease, revalidated the authority and locked the tenant row — so each records its
  // own bounded 409 there and commits that alone. Nothing else: no status, no version, no audit record,
  // no event. The intent is then terminal for the rest of its retention.
  for (const [label, status, expected, outcome] of [
    ['a stale expected version', 'suspended', 99_999, 'conflict'],
    ['a state the transition cannot start from', 'active', null, 'invalid_state'],
  ]) {
    const tenant = await newTenant(`refusal-${outcome}`);
    const before = await tenantRow(tenant);
    const version = expected === null ? Number(before.row_version) : expected;
    const { record, answer, command } = await transition(OWNER, tenant, status, version);
    assert.deepEqual(answer, { outcome }, label);
    assert.deepEqual(await tenantRow(tenant), before, `${label}: the row is untouched`);
    assert.equal((await auditsOf(tenant)).length, 0, `${label}: no audit record`);
    assert.equal((await eventsFor(tenant)).length, 0, `${label}: no event`);
    assert.equal(await recordDone(record.operation.scope), true, `${label}: the rejection IS the completion`);
    // The record replays the exact sealed 409 the command carried for this rejection, and nothing else.
    const replay = await store.idempotency.acquire({ ...record.operation, lease: randomBytes(32).toString('base64url'), ...IDEMPOTENCY_POLICY }, signal());
    const sealed = outcome === 'conflict' ? command.rejected.conflict : command.rejected.invalidState;
    assert.equal(replay.outcome, 'replay', `${label}: the sealed rejection replays`);
    assert.equal(replay.response, sealed, `${label}: byte for byte, the 409 the commit recorded`);
    // And the key is terminal: the same lease can never turn the refused intent into a mutation.
    assert.deepEqual(await commit(command), { outcome: 'lease_lost' }, `${label}: no second commit under the sealed record`);
    assert.deepEqual(await tenantRow(tenant), before, `${label}: still untouched`);
  }
  // A missing tenant is NOT sealed: the aggregate may yet exist, so the lease is left to expire.
  const missing = await transition(OWNER, randomUUID(), 'suspended', 1);
  assert.deepEqual(missing.answer, { outcome: 'not_found' });
  assert.equal(await recordDone(missing.record.operation.scope), false);
});

test('M5S-07: authority is re-decided inside the transaction — a role below Manage, a withdrawn grant and a suspended account commit nothing', async () => {
  // A platform role whose tenant_management is below Manage is refused by the revalidator, on the same
  // definitions the initial authorization uses.
  for (const who of [SUPPORT, BILLING]) {
    const tenant = await newTenant(`authz-${who.uid.slice(4, 10)}`);
    const before = await tenantRow(tenant);
    const { answer } = await transition(who, tenant, 'suspended', Number(before.row_version));
    assert.deepEqual(answer, { outcome: 'unavailable' }, `${who.uid}: below Manage commits nothing`);
    assert.deepEqual(await tenantRow(tenant), before);
    assert.equal((await auditsOf(tenant)).length, 0, 'no audit record');
  }
  // Manage and above pass: operations_admin as well as system_owner.
  const okTenant = await newTenant('authz-ops');
  const okVersion = Number((await tenantRow(okTenant)).row_version);
  assert.deepEqual((await transition(OPS, okTenant, 'suspended', okVersion)).answer, { outcome: 'committed' }, 'operations_admin holds Manage');

  // Authority that changes between the request and the commit: the context is re-read on the committing transaction.
  const revoked = await actor('revoked', { scope: 'platform', role: 'system_owner' });
  const tenant = await newTenant('authz-revoked');
  const before = await tenantRow(tenant);
  const context = await contextOf(revoked);
  await owner`update user_membership set status = 'suspended' where internal_user_id = ${revoked.id}`;
  const body = bodyOf(tenant, 'suspended', Number(before.row_version));
  const record = await acquired(revoked, body);
  assert.deepEqual(await commit(prepared(record, context, body).command), { outcome: 'unavailable' }, 'a withdrawn grant commits nothing');
  assert.deepEqual(await tenantRow(tenant), before);

  // A suspended account, likewise.
  const suspended = await actor('suspended-actor', { scope: 'platform', role: 'system_owner' });
  const context2 = await contextOf(suspended);
  await owner`update app_user set status = 'suspended' where internal_user_id = ${suspended.id}`;
  const record2 = await acquired(suspended, body);
  assert.deepEqual(await commit(prepared(record2, context2, body).command), { outcome: 'unavailable' }, 'a suspended account commits nothing');
  assert.deepEqual(await tenantRow(tenant), before);
  assert.equal((await auditsOf(tenant)).length, 0, 'no audit record');
});

test('M5S-08: the step-up deadline is re-judged on the database clock — evidence that has expired commits nothing', async () => {
  const tenant = await newTenant('stepup');
  const before = await tenantRow(tenant);
  const context = await contextOf(OWNER);
  const body = bodyOf(tenant, 'suspended', Number(before.row_version));
  // Fresh when the chain admitted it, stale by the time the transaction runs.
  const stale = await acquired(OWNER, body);
  assert.deepEqual(await commit(prepared(stale, context, body, Date.now() - 60_000).command), { outcome: 'unavailable' },
    'an expired recent authentication commits nothing');
  assert.deepEqual(await tenantRow(tenant), before);
  assert.equal((await auditsOf(tenant)).length, 0, 'no audit record');
  assert.equal(await recordDone(stale.operation.scope), false);
  // The same command with evidence still inside the window commits.
  const fresh = await acquired(OWNER, body);
  assert.deepEqual(await commit(prepared(fresh, context, body, Date.now() + RECENT_AUTH_MAX_AGE_MS).command), { outcome: 'committed' });
  assert.equal((await tenantRow(tenant)).status, 'suspended');
});

test('M5S-09: a fenced lease commits nothing, and an exact retry replays the recorded response', async () => {
  const tenant = await newTenant('lease');
  const before = await tenantRow(tenant);
  const context = await contextOf(OWNER);
  const body = bodyOf(tenant, 'suspended', Number(before.row_version));
  const record = await acquired(OWNER, body);
  // A lease that is not the one the record holds: fenced before any business state is read.
  const fenced = prepared({ operation: record.operation, lease: randomBytes(32).toString('base64url') }, context, body);
  assert.deepEqual(await commit(fenced.command), { outcome: 'lease_lost' });
  assert.deepEqual(await tenantRow(tenant), before, 'a fenced attempt learns nothing and changes nothing');
  assert.equal((await auditsOf(tenant)).length, 0, 'no audit record');
  // The real lease commits, and the record then replays it.
  const real = prepared(record, context, body);
  assert.deepEqual(await commit(real.command), { outcome: 'committed' });
  const replay = await store.idempotency.acquire({ ...record.operation, lease: randomBytes(32).toString('base64url'), ...IDEMPOTENCY_POLICY }, signal());
  assert.equal(replay.outcome, 'replay', 'the completed record replays');
  assert.equal(replay.response, real.command.response, 'byte for byte, the sealed response the commit recorded');
  // A second commit under the completed record changes nothing.
  assert.deepEqual(await commit(real.command), { outcome: 'lease_lost' });
  assert.equal((await tenantRow(tenant)).access_version, '2', 'the access version moved exactly once');
});

test('M5S-10: two concurrent transitions of one tenant have exactly one winner', async () => {
  const tenant = await newTenant('race');
  const version = Number((await tenantRow(tenant)).row_version);
  const context = await contextOf(OWNER);
  const first = bodyOf(tenant, 'suspended', version);
  const second = bodyOf(tenant, 'suspended', version, `${REASON} Second.`);
  const [a, b] = await Promise.all([acquired(OWNER, first), acquired(OWNER, second)]);
  const answers = await Promise.all([
    commit(prepared(a, context, first).command),
    commit(prepared(b, context, second).command),
  ]);
  assert.deepEqual(answers.map((x) => x.outcome).sort(), ['committed', 'conflict'], `one winner: ${JSON.stringify(answers)}`);
  const row = await tenantRow(tenant);
  assert.deepEqual([row.status, row.row_version, row.access_version], ['suspended', String(version + 1), '2'],
    'the loser moved nothing: one transition, one version step');
  assert.equal((await auditsOf(tenant)).length, 1, 'exactly one audit record');
  assert.equal((await eventsFor(tenant)).length, 1, 'exactly one event');
});

// ---------------------------------------------------------------------------
// 010's rollback and upgrade, inside a transaction that is rolled back
// ---------------------------------------------------------------------------

test('M5S-11: 010 rolls back to the 009 state, refuses once a tenant has been suspended, and re-applies over it', async () => {
  await owner.begin(async (tx) => {
    // Newest first: 016 comes off before 010's column can be reset or dropped. Its rollback refuses while a tenant session
    // exists; earlier suites on the shared service may have left some, and they go only inside this transaction.
    await tx.unsafe(`delete from tmpos_session.session where audience = 'tenant'`);
    await tx.unsafe(DOWN_016).simple();
    // A database where nothing was ever suspended rolls back freely.
    await tx.unsafe(`update public.tenant set access_version = 1 where access_version <> 1`);
    await tx.unsafe(`update public.tenant set status = 'active' where status = 'suspended'`);
    await tx.unsafe(DOWN_010).simple();
    const [{ gone }] = await tx`select pg_catalog.to_regprocedure('tmpos_command.m5_tenant_status_change(uuid, bigint, text, text)') is null as gone`;
    assert.equal(gone, true, 'the operation is dropped');
    const [{ column }] = await tx`select count(*)::int as column from pg_catalog.pg_attribute
      where attrelid = 'public.tenant'::regclass and attname = 'access_version' and not attisdropped`;
    assert.equal(column, 0, 'and the column with it');
    const [{ n }] = await tx`select count(*)::int as n from pg_catalog.pg_proc p join pg_catalog.pg_namespace s on s.oid = p.pronamespace
      where s.nspname = 'tmpos_command'`;
    assert.equal(n, 4, '008 and 009 keep their four routines');

    // 009 -> 010 again, over the rolled-back state: the upgrade applies cleanly.
    await tx.unsafe(UP_010).simple();
    const [{ back }] = await tx`select pg_catalog.to_regprocedure('tmpos_command.m5_tenant_status_change(uuid, bigint, text, text)') is not null as back`;
    assert.equal(back, true, 'the upgrade re-applies');

    // Now suspend one tenant through the operation, and the rollback refuses: the witness would be lost.
    const [{ tenant_id: victim }] = await tx`insert into public.tenant (display_name) values (${`m5s-rollback-${SUFFIX}`}) returning tenant_id`;
    const [{ row_version: v }] = await tx`select row_version from public.tenant where tenant_id = ${victim}`;
    const [applied] = await tx`select o_outcome from tmpos_command.m5_tenant_status_change(${victim}::uuid, ${v}::bigint, 'active'::text, 'suspended'::text)`;
    assert.equal(applied.o_outcome, 'applied');
    await assert.rejects(tx.unsafe(DOWN_010).simple(), (err) => err.code === '55006' && /rollback refused/.test(String(err.message)),
      'a suspended tenant refuses the rollback: it would remove the only operation that could reactivate it');
    throw new Error('m5s-rollback-probe'); // roll the whole proof back
  }).catch((err) => {
    if (!/m5s-rollback-probe/.test(String(err.message))) throw err;
  });

  // The shared database is exactly as it was: 010 applied, its operation callable.
  const [{ present }] = await owner`select pg_catalog.to_regprocedure('tmpos_command.m5_tenant_status_change(uuid, bigint, text, text)') is not null as present`;
  assert.equal(present, true, 'the proof left the database untouched');
});

test('M5S-13: the rollback refusal is CLEARED by the remedy it names — reactivating, which raises the version further', async () => {
  await owner.begin(async (tx) => {
    await tx.unsafe(`update public.tenant set status = 'active' where status = 'suspended'`).simple();
    const [{ tenant_id: t }] = await tx`insert into public.tenant (display_name) values (${`m5s-clear-${SUFFIX}`}) returning tenant_id`;
    const [{ row_version: v1 }] = await tx`select row_version from public.tenant where tenant_id = ${t}`;
    await tx`select o_outcome from tmpos_command.m5_tenant_status_change(${t}::uuid, ${v1}::bigint, 'active'::text, 'suspended'::text)`;
    await assert.rejects(tx.unsafe(DOWN_010).simple(), (err) => err.code === '55006', 'suspended: refused');
    throw new Error('m5s-clear-probe');
  }).catch((err) => { if (!/m5s-clear-probe/.test(String(err.message))) throw err; });

  await owner.begin(async (tx) => {
    // Same tenant, now reactivated through the command — the access version is at 3, NOT back at 1 — and the
    // rollback proceeds. A version test here would be uncleanable by any sanctioned path.
    await tx.unsafe(`update public.tenant set status = 'active' where status = 'suspended'`).simple();
    const [{ tenant_id: t }] = await tx`insert into public.tenant (display_name) values (${`m5s-clear2-${SUFFIX}`}) returning tenant_id`;
    const [{ row_version: v1 }] = await tx`select row_version from public.tenant where tenant_id = ${t}`;
    await tx`select o_outcome from tmpos_command.m5_tenant_status_change(${t}::uuid, ${v1}::bigint, 'active'::text, 'suspended'::text)`;
    const [{ row_version: v2 }] = await tx`select row_version from public.tenant where tenant_id = ${t}`;
    await tx`select o_outcome from tmpos_command.m5_tenant_status_change(${t}::uuid, ${v2}::bigint, 'suspended'::text, 'active'::text)`;
    const [row] = await tx`select status, access_version from public.tenant where tenant_id = ${t}`;
    assert.deepEqual([row.status, row.access_version], ['active', '3'], 'reactivation raises the version, never resets it');
    await tx.unsafe(DOWN_010).simple();
    const [{ gone }] = await tx`select pg_catalog.to_regprocedure('tmpos_command.m5_tenant_status_change(uuid, bigint, text, text)') is null as gone`;
    assert.equal(gone, true, 'the remedy the refusal names actually clears it');
    throw new Error('m5s-clear-probe');
  }).catch((err) => { if (!/m5s-clear-probe/.test(String(err.message))) throw err; });
});

test('M5S-12: migrations 005-009 are byte-identical to what this stage found', () => {
  const pinned = {
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
  };
  for (const [name, digest] of Object.entries(pinned)) {
    const actual = createHash('sha256').update(readFileSync(`${MIG_DIR}/${name}`)).digest('hex');
    assert.equal(actual, digest, `${name} is unchanged`);
  }
  assert.ok(UP_010.length > 0 && DOWN_010.length > 0, '010 is the only migration this stage adds');
});

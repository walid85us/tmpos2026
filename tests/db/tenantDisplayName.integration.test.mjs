// Phase 4.0 M5-GIAM-D1-P1 — the first server-authorized business command against REAL PostgreSQL: migration 008 (the
// tenant's row version, its trigger, and the one fixed display-name operation), the M6 store committing the command with
// its mutator and the trusted context's revalidation, and the whole HTTP chain over the real resolver and store.
// M5-GIAM-D1-P1-R1 adds migration 009 and its proofs: the no-op's completion committed with its decision, the exact
// transaction-time authority (changes and races included), the legacy direct write closed for every runtime principal,
// the audit record's direct subject, the Bidi_Control rule in both validators, and 009's rollback, upgrade and verify.
// M5-GIAM-D1-P4 composes the chain's admin boundary with the durable pair: migration 013's admission (asked at login and
// on every request) and the authorizer deciding on the scope that admission selected — so an actor with no platform
// grant, or two, is refused at the login and never reaches the route.
// M5-ADMIN-REVOKE-P1 composes the production revalidator whole — 009's locks, the presenting administrative session held,
// then 013's read of that session's standing — and the production session store with the login's standing check: every
// context-carrying command below is presented by a real live administrative session established the way the login
// establishes one (sessionOf), and M5D-22 proves a command whose session ended, or whose standing moved in a way 009
// cannot see, commits nothing.
//
// DISPOSABLE ONLY. The target is the harness's resolved target: a supplied CI service when one is bound, otherwise a
// cluster this file creates and destroys; assertDisposableTestDsn refuses anything else before a statement runs. Every fixture is synthetic and randomly
// named, so the suite re-runs on the shared CI service, where earlier suites already applied 001-008 and may have moved
// other tenants' versions. The rollback and upgrade proof runs inside one transaction that is rolled back, so the shared
// database keeps its state.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
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
import {
  PLATFORM_ADMISSION_BOUNDS, createPostgresPlatformAdmission, readPlatformAdmission,
} from '../../server/persistence/postgresPlatformAdmission.ts';
import { createPostgresSessionStore, holdAdministrativeSession } from '../../server/persistence/postgresSessionStore.ts';
import { TENANT_DISPLAY_NAME_MUTATOR } from '../../server/persistence/tenantDisplayNameMutator.ts';
import {
  createAdmittedPlatformAuthorizer, createPlatformContextRevalidator, createPlatformEstablishCheck, createPlatformSessionAdmission,
} from '../../server/composition/platformAuthorization.ts';
import { createApp, createBoundedServer, createReadinessState } from '../../server/runtime/app.ts';
import { prepareCommand } from '../../server/runtime/commandTransaction.ts';
import { IDEMPOTENCY_POLICY, createIdempotencyKeyring } from '../../server/runtime/idempotency.ts';
import { TEST_IDEMPOTENCY_KEY } from '../../server/runtime/idempotencyStore.testkit.ts';
import { defineOutboxEvents } from '../../server/runtime/outbox.ts';
import { selectScope } from '../../server/runtime/principals.ts';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '../../server/runtime/requestSecurity.ts';
import { sessionPaths } from '../../server/runtime/routes.ts';
import { SESSION_COOKIES, SESSION_CSRF_HEADER, principalKeyOf } from '../../server/runtime/sessions.ts';
import { testRequestLimits } from '../../server/runtime/rateLimiter.testkit.ts';
import {
  TENANT_DISPLAY_NAME_CONTRACT,
  TENANT_DISPLAY_NAME_EVENTS,
  TENANT_DISPLAY_NAME_PATH,
  TENANT_DISPLAY_NAME_ROUTE,
  normalizeTenantDisplayName,
  planTenantDisplayName,
} from '../../server/runtime/tenantDisplayName.ts';

const MIG_REL = 'server/platform-identity/migrations';
const MIG_DIR = new URL(`../../${MIG_REL}/`, import.meta.url).pathname.replace(/\/$/, '');
const UP_008 = readFileSync(`${MIG_DIR}/008_m5_tenant_display_name_command.up.sql`, 'utf8');
const DOWN_008 = readFileSync(`${MIG_DIR}/008_m5_tenant_display_name_command.down.sql`, 'utf8');
const UP_009 = readFileSync(`${MIG_DIR}/009_m5_first_command_hardening.up.sql`, 'utf8');
const DOWN_009 = readFileSync(`${MIG_DIR}/009_m5_first_command_hardening.down.sql`, 'utf8');
// M5-GIAM-D1-P2: 010 now sits above 009, and the chain rolls back NEWEST FIRST — so every proof below that
// replays 008's or 009's own verify, or rolls one of them back, takes 010 off first.
const DOWN_010 = readFileSync(`${MIG_DIR}/010_m5_tenant_lifecycle_command.down.sql`, 'utf8');
// M5-TENANT-SESSION-P1: 016's access-version trigger fires on every tenant UPDATE, so it comes off before 010's.
const DOWN_016 = readFileSync(`${MIG_DIR}/016_m5_tenant_session_ordering.down.sql`, 'utf8');
/**
 * The production revalidator, composed exactly as productionTransactions.ts composes it: 009's exact-authority routine,
 * the presenting administrative session held, 013's read of that session's standing (M5-ADMIN-REVOKE-P1), then the
 * permission on the built-in definitions.
 */
const REVALIDATE = createPlatformContextRevalidator({
  authority: revalidatePlatformAuthority, session: (sql, key) => holdAdministrativeSession(sql, key, Date.now()), read: readPlatformAdmission,
});
const MIGRATOR = { purpose: 'migration', migratorRef: 'm5d-migrator', runtimeRef: 'm5d-runtime' };
const LOCK_KEY = 528_508;
const NOW = () => new Date().toISOString();

/** The non-owner LOGIN the store and the resolver connect as: tmpos_app and tmpos_audit_writer, nothing else. */
const RUNTIME_LOGIN = 'tmpos_m5d_probe';
const SUFFIX = randomUUID().slice(0, 8);
const ADMIN_ORIGIN = 'http://admin.trusted.test';
const REQUIREMENT = Object.freeze({ scope: 'platform', permission: 'edit_tenant_profile' });
/** Every code point with the Unicode Bidi_Control property (migration 009 section 5). */
const BIDI_CONTROLS = [0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069];
const signal = () => AbortSignal.timeout(10_000);

// ---------------------------------------------------------------------------
// cluster lifecycle
// ---------------------------------------------------------------------------

const TARGET = resolveDisposableTarget('M5D');
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
client = createSupervisedPgClient(testDriver(TARGET), driverDsn(TARGET_DSN, RUNTIME_LOGIN), {
  ...runtimeClientOptions(TARGET_DSN),
  ssl: false,
  max: 6,
  idle_timeout: 0,
  user: RUNTIME_LOGIN,
});
const store = createPostgresTransactionalStore({ client, mutators: [TENANT_DISPLAY_NAME_MUTATOR], revalidate: REVALIDATE });
const principals = createPostgresPrincipalResolver({ client });
/** The production session store over the same kernel, with the administrative login's standing check (M5-ADMIN-REVOKE-P1). */
const SESSIONS = createPostgresSessionStore({
  client, standing: createPlatformEstablishCheck({ read: readPlatformAdmission, authority: lockPlatformAuthority }),
});
const ADMISSION = createPlatformSessionAdmission({ admission: createPostgresPlatformAdmission({ client }) });
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
const auditFor = (correlation) => owner`select actor_internal_user_id, scope_type, tenant_id, store_id, subject_tenant_id, action_id, required_permission,
  request_id, decision, result_status from audit_event where request_id = ${correlation}`;
/** Every audit record whose action targeted `tenant`, found by its subject alone — no join to the outbox (migration 009). */
const auditsOf = (tenant) => owner`select actor_internal_user_id, scope_type, tenant_id, action_id, request_id from audit_event
  where subject_tenant_id = ${tenant} order by occurred_at, request_id`;
const eventsFor = (tenant) => owner`select event_type, event_version, aggregate_type, aggregate_id, aggregate_version, correlation_id, tenant_digest,
  store_digest, actor_digest, payload from tmpos_internal.outbox_event where aggregate_id = ${tenant} order by aggregate_version`;
const auditCountFor = async (action) => (await owner`select count(*)::int as n from audit_event where action_id = ${action}`)[0].n;
const recordDone = async (scope) => (await owner`select response is not null as done from tmpos_internal.idempotency_record where scope = ${scope}`)[0]?.done;
const call = async (tenant, expected, name, sql = runtime) =>
  (await sql`select o_outcome, o_version from tmpos_command.m5_tenant_display_name_update_v2(${tenant}::uuid, ${expected}::bigint, ${name}::text)`)[0];
/** 008's operation, which 009 supersedes: the runtime role may no longer call it. */
const call008 = async (tenant, expected, name, sql = runtime) =>
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
    method: 'PATCH', path: TENANT_DISPLAY_NAME_PATH, audience: 'admin', tenant: null, store: null, actor: null, body: Buffer.from(JSON.stringify(body)),
  });
  const lease = randomBytes(32).toString('base64url');
  assert.deepEqual(await store.idempotency.acquire({ ...operation, lease, ...IDEMPOTENCY_POLICY }, signal()), { outcome: 'acquired', reclaimed: false });
  return { operation, lease };
}

/**
 * The command the chain would commit: planned from the body, prepared under the record's lease and the trusted context,
 * presented by the actor's session from contextOf — or by `sessionKey` when a case names another.
 */
function prepared({ operation, lease }, context, body, sessionKey = context === null ? null : (SESSION_KEYS.get(context.actor) ?? null)) {
  const plan = planTenantDisplayName({ audience: 'admin', body, newAggregateId: randomUUID() });
  const command = prepareCommand(TENANT_DISPLAY_NAME_CONTRACT, EVENTS, plan, {
    scope: operation.scope, lease, newAggregateId: randomUUID(), authorization: REQUIREMENT, context, authNotAfter: null, sessionKey,
    seal: (envelope) => keyring.seal(envelope, operation),
  });
  assert.ok(command !== null, 'the plan is in contract');
  return command;
}
const commit = (command) => store.transactions.commit(command, signal());

// ---------------------------------------------------------------------------
// migration 008 as applied
// ---------------------------------------------------------------------------

test('M5D-01: 001-035 apply clean; 008 is its column, trigger and operation, and 009 its two routines and grants', async () => {
  assert.equal(applyReport.outcome, 'complete', JSON.stringify(applyReport).slice(0, 400));
  const ledger = await owner`select version, dirty from public.schema_migrations order by version`;
  assert.deepEqual(ledger.map((r) => [r.version, r.dirty]), ['001', '002', '003', '004', '005', '006', '007', '008', '009', '010', '011', '012', '013', '014', '015', '016', '017', '018', '019', '020', '021', '022', '023', '024', '025', '026', '027', '028', '029', '030', '031', '032', '033', '034', '035'].map((v) => [v, false]));

  const [column] = await owner`select a.atttypid::regtype::text as type, a.attnotnull as not_null, pg_catalog.pg_get_expr(d.adbin, d.adrelid) as dflt,
      (select pg_catalog.pg_get_constraintdef(c.oid) from pg_catalog.pg_constraint c where c.conname = 'tenant_row_version_chk') as chk
    from pg_catalog.pg_attribute a join pg_catalog.pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
   where a.attrelid = 'public.tenant'::regclass and a.attname = 'row_version'`;
  assert.deepEqual(column, { type: 'bigint', not_null: true, dflt: '1', chk: 'CHECK (((row_version >= 1) AND (row_version <= \'9007199254740991\'::bigint)))' });

  const fns = await owner`select p.proname, p.prosecdef, p.provolatile, p.proconfig, p.proowner = n.nspowner as owned
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace where n.nspname = 'tmpos_command' order by p.proname`;
  assert.deepEqual(fns.map((f) => ({ ...f })), [
    { proname: 'm5_revalidate_platform_authority', prosecdef: true, provolatile: 'v', proconfig: ['search_path=pg_catalog, pg_temp'], owned: true },
    { proname: 'm5_tenant_display_name_update', prosecdef: true, provolatile: 'v', proconfig: ['search_path=pg_catalog, pg_temp'], owned: true },
    { proname: 'm5_tenant_display_name_update_v2', prosecdef: true, provolatile: 'v', proconfig: ['search_path=pg_catalog, pg_temp'], owned: true },
    { proname: 'm5_tenant_row_version', prosecdef: false, provolatile: 'v', proconfig: ['search_path=pg_catalog, pg_temp'], owned: true },
    // M5-GIAM-D1-P2: migration 010 adds the fifth routine to the same schema.
    { proname: 'm5_tenant_status_change', prosecdef: true, provolatile: 'v', proconfig: ['search_path=pg_catalog, pg_temp'], owned: true },
  ]);

  const acl = await owner`select p.proname, a.grantee::regrole::text as grantee, a.privilege_type, a.is_grantable
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    cross join pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
   where n.nspname = 'tmpos_command' and a.grantee <> p.proowner order by p.proname`;
  assert.deepEqual(acl.map((r) => ({ ...r })), [
    { proname: 'm5_revalidate_platform_authority', grantee: 'tmpos_app', privilege_type: 'EXECUTE', is_grantable: false },
    { proname: 'm5_tenant_display_name_update_v2', grantee: 'tmpos_app', privilege_type: 'EXECUTE', is_grantable: false },
    { proname: 'm5_tenant_status_change', grantee: 'tmpos_app', privilege_type: 'EXECUTE', is_grantable: false },
  ], 'tmpos_app may execute 009\'s two routines only, never grant them; 008\'s superseded operation and the trigger function are nobody\'s');
  const [subject] = await owner`select a.atttypid::regtype::text as type, a.attnotnull as not_null, a.atthasdef as has_default,
      pg_catalog.to_regclass('public.idx_audit_event_subject_tenant_occurred') is not null as indexed
    from pg_catalog.pg_attribute a where a.attrelid = 'public.audit_event'::regclass and a.attname = 'subject_tenant_id' and not a.attisdropped`;
  assert.deepEqual({ ...subject }, { type: 'uuid', not_null: false, has_default: false, indexed: true }, 'the audit subject: a nullable uuid, indexed');
  const [{ indexdef }] = await owner`select pg_catalog.pg_get_indexdef('public.idx_audit_event_subject_tenant_occurred'::regclass) as indexdef`;
  assert.match(indexdef, /\(subject_tenant_id, occurred_at DESC\) WHERE \(subject_tenant_id IS NOT NULL\)/,
    'the partial index the subject search uses, on exactly those columns');

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
  // 009 revoked 005's column grant: a direct write of the name is refused outright (M5D-15 proves every principal and path).
  assert.equal(await refusalCode(() => runtime`update public.tenant set display_name = 'direct' where tenant_id = ${tenant}`), '42501', 'no direct name write');
  assert.equal(await refusalCode(() => call008(tenant, 2, 'Via 008')), '42501', '008\'s superseded operation answers the runtime no longer');
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
    // 009: every Bidi_Control character, anywhere (M5D-20 proves the runtime agrees character by character).
    ...BIDI_CONTROLS.map((code) => [`Bidi_Control U+${code.toString(16)}`, [tenant, 2, `a${String.fromCodePoint(code)}b`]]),
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
    actor_internal_user_id: OWNER.id, scope_type: 'platform', tenant_id: null, store_id: null, subject_tenant_id: tenant,
    action_id: 'platform.tenant.display_name.update', required_permission: 'edit_tenant_profile', request_id: command.audit.correlationId,
    decision: 'allow', result_status: 'succeeded',
  }], 'one audit record naming the app-owned actor, never the provider UID, and the tenant it changed as its direct subject');
  assert.deepEqual((await auditsOf(tenant)).map((r) => r.request_id), [command.audit.correlationId], 'found by its subject alone, with no outbox join');
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

test('M5D-06: a stale version, a missing tenant, changes already in place, a lost lease and a stale context each write no business state; only the deterministic and no-op answers commit a completion', async () => {
  const tenant = await newTenant(`m5d-refuse-${SUFFIX}`);
  const context = await contextOf(OWNER);
  // `sealed` is the one difference between the two kinds of refusal (M5-GIAM-D1-P2-R1): a conflict is
  // deterministic, so it records its own bounded 409 as the completion inside the transaction that
  // decided it; every other refusal here records nothing at all and leaves the lease to expire.
  const nothingMoved = async (label, record, correlation, sealed = false) => {
    assert.deepEqual({ ...(await tenantRow(tenant)) }.row_version, '1', `${label}: no version moved`);
    assert.equal((await tenantRow(tenant)).display_name, `m5d-refuse-${SUFFIX}`, `${label}: no name moved`);
    assert.equal((await auditFor(correlation)).length, 0, `${label}: no audit record`);
    assert.equal((await eventsFor(tenant)).length, 0, `${label}: no event`);
    if (record !== null) {
      assert.equal(await recordDone(record.operation.scope), sealed,
        `${label}: ${sealed ? 'the rejection IS the completion' : 'the record stays in progress'}`);
    }
  };
  const stale = { tenantId: tenant, displayName: 'Stale', expectedVersion: 7 };
  let record = await acquired(OWNER, stale);
  let command = prepared(record, context, stale).command;
  assert.deepEqual(await commit(command), { outcome: 'conflict' });
  await nothingMoved('stale version', record, command.audit.correlationId, true);
  // The sealed 409 is what the key now answers with, for the rest of its retention.
  const sealedReplay = await store.idempotency.acquire({ ...record.operation, lease: randomBytes(32).toString('base64url'), ...IDEMPOTENCY_POLICY }, signal());
  assert.equal(sealedReplay.outcome, 'replay', 'the conflict replays');
  assert.equal(sealedReplay.response, command.rejected.conflict, 'byte for byte, the 409 the commit recorded');

  const missing = { tenantId: randomUUID(), displayName: 'Nobody', expectedVersion: 1 };
  record = await acquired(OWNER, missing);
  command = prepared(record, context, missing).command;
  assert.deepEqual(await commit(command), { outcome: 'not_found' });
  await nothingMoved('missing tenant', record, command.audit.correlationId);

  // Changes already in place commit their unchanged response as the completion and nothing else (M5-GIAM-D1-P1-R1; M5D-16).
  const same = { tenantId: tenant, displayName: ` m5d-refuse-${SUFFIX} `, expectedVersion: 1 };
  record = await acquired(OWNER, same);
  command = prepared(record, context, same).command;
  assert.deepEqual(await commit(command), { outcome: 'unchanged' });
  await nothingMoved('unchanged', null, command.audit.correlationId);
  assert.equal(await recordDone(record.operation.scope), true, 'unchanged: the record is completed, in the same transaction');

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
    revalidate: REVALIDATE,
  });
  const record2 = await acquired(OWNER, body);
  const command2 = prepared(record2, context, body).command;
  assert.deepEqual(await throwing.transactions.commit(command2, signal()), { outcome: 'unavailable' });
  assert.equal((await tenantRow(second)).row_version, '1');
  assert.equal((await auditFor(command2.audit.correlationId)).length, 0);
  assert.equal((await auditsOf(second)).length, 0, 'rollback leaves no audit record naming the tenant either');
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
// the whole chain over HTTP, on the real admission, authorizer and store
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
  const tokens = new Map([OWNER, SUPPORT, BILLING, TENANT_ONLY, STORE_ONLY, ...(over.actors ?? [])].map((who) => [`tok-${who.uid}`, who.uid]));
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
        // M5-GIAM-D1-P4: the durable pair — migration 013's admission, asked at login and on every request, and the
        // authorizer deciding on the scope that request's admission selected.
        admission: ADMISSION,
        authorizer: createAdmittedPlatformAuthorizer(),
        // M5-ADMIN-REVOKE-P1: the durable session store, as production binds it, so the session a command carries is the
        // row its transaction holds.
        store: SESSIONS,
      },
    },
  });
  const server = createBoundedServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  /** The admin login's raw reply for `who` (null: a verified reference naming nobody), with any `extra` headers on it. */
  const login = (who, extra = {}) => send(port, 'POST', sessionPaths('admin').login, {
    origin: ADMIN_ORIGIN, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE,
    authorization: `Bearer ${who === null ? 'tok-unknown' : `tok-${who.uid}`}`, ...extra,
  });
  const signIn = async (who) => {
    const reply = await login(who);
    assert.equal(reply.status, 200, `admin login: ${reply.body}`);
    const cookie = (reply.headers['set-cookie'] ?? [''])[0].split('; ')[0];
    const csrf = JSON.parse(reply.body).csrfToken;
    return (body, key = randomUUID(), extra = {}) => send(port, 'PATCH', TENANT_DISPLAY_NAME_PATH, {
      origin: ADMIN_ORIGIN, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE, [SESSION_CSRF_HEADER]: csrf, cookie,
      'content-type': 'application/json', 'idempotency-key': key, ...extra,
    }, typeof body === 'string' ? body : JSON.stringify(body));
  };
  try {
    await fn({ port, signIn, login, logs });
  } finally {
    await new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  }
}
const errorOf = (reply) => JSON.parse(reply.body).error;

test('M5D-09: over HTTP the canonical authorizer admits System Owner and support_admin and refuses billing_admin with one generic 403; no other actor holds a session', async () => {
  const tenant = await newTenant(`m5d-http-authz-${SUFFIX}`);
  await withChain(async ({ signIn, login }) => {
    const forged = { 'x-internal-user-id': OWNER.id, 'x-role': 'system_owner', 'x-permission': 'edit_tenant_profile', 'x-tenant-id': tenant };
    const patch = await signIn(BILLING);
    const refused = await patch({ tenantId: tenant, displayName: 'Refused', expectedVersion: 1 }, randomUUID(), forged);
    assert.deepEqual([refused.status, errorOf(refused)], [403, 'forbidden'],
      'billing_admin (Tenants at View): request-supplied identity, role and scope are never read');
    // M5-GIAM-D1-P4: an actor with no platform grant, or no actor at all, is refused by durable admission at the login
    // itself — the generic 401 and no cookie — so it never reaches the route; the same forged headers change nothing there.
    for (const [label, who] of [['a tenant-role holder', TENANT_ONLY], ['a store-role holder', STORE_ONLY], ['no actor at all', null]]) {
      const denied = await login(who, forged);
      assert.deepEqual([denied.status, errorOf(denied), denied.headers['set-cookie']], [401, 'unauthenticated', undefined],
        `${label}: admission refuses, whatever the request names`);
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

/** The actors of every audit record whose action targeted `tenant` — by its direct subject (migration 009), never the outbox. */
async function owner_audits(tenant) {
  return (await auditsOf(tenant)).map((r) => r.actor_internal_user_id);
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

    const scopeOf = (k) => keyring.operationOf(k, OWNER.principal, { method: 'PATCH', path: TENANT_DISPLAY_NAME_PATH, audience: 'admin', tenant: null, store: null, actor: null, body: Buffer.alloc(0) }).scope;
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

test('M5D-12: rollback runs newest first — 009 refuses over audit subjects, 008 over 009 — each reverses exactly, and 008 then 009 re-apply over existing rows', async () => {
  const ROLLBACK = new Error('m5d: roll the proof back');
  const outcome = await owner.begin(async (tx) => {
    const code = refusalIn(tx);
    // Newest first: 016 (its rollback refuses while a tenant session exists; those rows go only inside this transaction),
    // then 010, before 009 can be asked.
    await tx.unsafe(`delete from tmpos_session.session where audience = 'tenant'`);
    await tx.unsafe(DOWN_016).simple();
    await tx.unsafe(DOWN_010).simple();
    // This suite has committed commands, so audit records name their subject: 009's rollback refuses and drops nothing.
    assert.ok((await tx`select count(*)::int as n from public.audit_event where subject_tenant_id is not null`)[0].n > 0);
    assert.equal(await code((sp) => sp.unsafe(DOWN_009).simple()), '55006', 'an audit subject refuses 009\'s rollback');
    // 008's own guard still stands: this suite has moved versions, so its rollback refuses before anything else.
    assert.ok((await tx`select count(*)::int as n from public.tenant where row_version > 1`)[0].n > 0);
    assert.equal(await code((sp) => sp.unsafe(DOWN_008).simple()), '55006', 'a moved version refuses 008\'s rollback');
    // And 008 cannot go first anyway: even with every version reset (inside this transaction only), 009's routines live in its schema.
    await tx.unsafe('alter table public.tenant disable trigger trg_tenant_row_version');
    await tx.unsafe('update public.tenant set row_version = 1 where row_version <> 1');
    await tx.unsafe('alter table public.tenant enable always trigger trg_tenant_row_version');
    assert.equal(await code((sp) => sp.unsafe(DOWN_008).simple()), '2BP01', '008\'s rollback refuses while 009 is applied');
    // Clear the subjects (the append-only trigger lifted and restored inside this transaction), then 009 reverses exactly.
    await clearSubjects(tx);
    await tx.unsafe(DOWN_009).simple();
    const [after009] = await tx`select
        pg_catalog.to_regprocedure('tmpos_command.m5_revalidate_platform_authority(uuid, text, uuid, text)') is null as authority_gone,
        pg_catalog.to_regprocedure('tmpos_command.m5_tenant_display_name_update_v2(uuid, bigint, text)') is null as v2_gone,
        pg_catalog.has_function_privilege('tmpos_app', 'tmpos_command.m5_tenant_display_name_update(uuid, bigint, text)', 'EXECUTE') as op008,
        pg_catalog.has_column_privilege('tmpos_app', 'public.tenant', 'display_name', 'UPDATE') as name_grant,
        (select count(*)::int from pg_catalog.pg_attribute
          where attrelid = 'public.audit_event'::regclass and attname = 'subject_tenant_id' and not attisdropped) as subject_columns`;
    assert.deepEqual({ ...after009 }, { authority_gone: true, v2_gone: true, op008: true, name_grant: true, subject_columns: 0 }, 'exactly the 008 state');

    await tx.unsafe(DOWN_008).simple();
    const [gone] = await tx`select pg_catalog.to_regnamespace('tmpos_command') is null as schema,
      (select count(*)::int from pg_catalog.pg_attribute where attrelid = 'public.tenant'::regclass and attname = 'row_version' and not attisdropped) as columns,
      (select count(*)::int from pg_catalog.pg_trigger where tgrelid = 'public.tenant'::regclass and tgname = 'trg_tenant_row_version') as triggers,
      pg_catalog.to_regnamespace('tmpos_internal') is not null as store_schema, pg_catalog.to_regnamespace('tmpos_identity') is not null as identity_schema`;
    assert.deepEqual({ ...gone }, { schema: true, columns: 0, triggers: 0, store_schema: true, identity_schema: true }, 'exactly 008 is gone; 006 and 007 stay');

    // The upgrade from 007: rows that exist before 008 each start at version 1; then 009 over them — a name carrying a
    // Bidi_Control character stored before 009 is not rewritten, and every existing audit record keeps a null subject.
    const legacyName = `m5d-pre-${SUFFIX}${String.fromCodePoint(0x202e)}txt`;
    const [{ tenant_id: pre }] = await tx`insert into public.tenant (display_name) values (${legacyName}) returning tenant_id`;
    await tx.unsafe(UP_008).simple();
    assert.equal((await tx`select row_version from public.tenant where tenant_id = ${pre}`)[0].row_version, '1');
    assert.equal((await tx`select count(*)::int as other from public.tenant where row_version <> 1`)[0].other, 0, 'every existing row starts at 1');
    await tx.unsafe(UP_009).simple();
    assert.equal((await tx`select display_name from public.tenant where tenant_id = ${pre}`)[0].display_name, legacyName, 'a stored name is not rewritten');
    assert.equal((await tx`select count(*)::int as n from public.audit_event where subject_tenant_id is not null`)[0].n, 0);
    const [answer] = await tx`select o_outcome, o_version from tmpos_command.m5_tenant_display_name_update_v2(${pre}::uuid, 1::bigint, 'After Upgrade'::text)`;
    assert.deepEqual({ ...answer }, { o_outcome: 'applied', o_version: '2' }, 'and the re-applied operation works');
    throw ROLLBACK;
  }).then(() => 'committed', (err) => (err === ROLLBACK ? 'rolled back' : Promise.reject(err)));
  assert.equal(outcome, 'rolled back');
  const [present] = await owner`select pg_catalog.to_regprocedure('tmpos_command.m5_tenant_display_name_update_v2(uuid, bigint, text)') is not null as operation,
    (select count(*)::int from pg_catalog.pg_trigger where tgrelid = 'public.tenant'::regclass and tgname = 'trg_tenant_row_version') as triggers`;
  assert.deepEqual({ ...present }, { operation: true, triggers: 1 }, 'the shared database keeps 008 and 009');
});

/** Every audit subject cleared — the append-only trigger lifted and restored — inside the caller's own (rolled-back) transaction. */
async function clearSubjects(tx) {
  await tx.unsafe('alter table public.audit_event disable trigger trg_audit_event_reject_mutation');
  await tx.unsafe('update public.audit_event set subject_tenant_id = null where subject_tenant_id is not null');
  await tx.unsafe('alter table public.audit_event enable trigger trg_audit_event_reject_mutation');
}
/** A refusal's SQLSTATE, or null: `fn` runs in a savepoint of `tx`, so a refusal leaves `tx` usable. */
function refusalIn(tx) {
  return async (fn) => {
    try { await tx.savepoint(fn); return null; } catch (err) { return err.code ?? String(err.message); }
  };
}
/** `fn` over `tx` inside one transaction that is always rolled back; `to008` first rolls 009 back within it. */
async function rolledBack(fn, { to008 = false } = {}) {
  const ROLLBACK = new Error('m5d: roll the proof back');
  const outcome = await owner.begin(async (tx) => {
    if (to008) {
      await clearSubjects(tx);
      await tx.unsafe(DOWN_009).simple();
    }
    await fn(tx);
    throw ROLLBACK;
  }).then(() => 'committed', (err) => (err === ROLLBACK ? 'rolled back' : Promise.reject(err)));
  assert.equal(outcome, 'rolled back');
}

test('M5D-13: 008 refuses to finish while any role the runtime could hold is a member of its owner, SET-only included, or the schema grants more than USAGE', async () => {
  // A clean apply leaves exactly the owner and tmpos_app's non-grantable USAGE on the schema.
  const acl = await owner`select coalesce(a.grantee::regrole::text, '?') as grantee, a.privilege_type as privilege, a.is_grantable as grantable
    from pg_catalog.pg_namespace n cross join pg_catalog.aclexplode(coalesce(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) a
    where n.nspname = 'tmpos_command' and a.grantee <> n.nspowner`;
  assert.deepEqual(acl.map((r) => ({ ...r })), [{ grantee: 'tmpos_app', privilege: 'USAGE', grantable: false }]);
  // 008's section 6 enumerates exactly its own two functions, so it is re-run over the 008 state: 009 rolled back inside the proof.
  const VERIFY = UP_008.slice(UP_008.lastIndexOf('do $$'));
  const [{ ownerRole }] = await owner`select n.nspowner::regrole::text as "ownerRole" from pg_catalog.pg_namespace n where n.nspname = 'tmpos_command'`;
  await rolledBack(async (tx) => {
    const code = refusalIn(tx);
    await tx.unsafe(`drop function if exists tmpos_command.m5_tenant_status_change(uuid, bigint, text, text); alter table public.tenant drop column if exists access_version;`).simple(); // 008's section 6 counts its own routines: 010's objects come off first
    assert.equal(await code((sp) => sp.unsafe(VERIFY).simple()), null, 'the verify section passes over the 008 state (positive control)');
    assert.equal(await code(async (sp) => {
      await sp.unsafe('grant create on schema tmpos_command to tmpos_app');
      await sp.unsafe(VERIFY).simple();
    }), '55000', 'a CREATE grant on the schema refuses');
    assert.equal(await code(async (sp) => {
      await sp.unsafe(`grant "${ownerRole}" to tmpos_app with inherit false, set true`);
      assert.equal((await sp`select pg_catalog.pg_has_role('tmpos_app', ${ownerRole}, 'USAGE') as usage`)[0].usage, false, 'USAGE does not report a SET-only membership');
      await sp.unsafe(VERIFY).simple();
    }), '55000', 'a SET-only membership in the owner refuses');
  }, { to008: true });
  const [{ member }] = await owner`select pg_catalog.pg_has_role('tmpos_app', ${ownerRole}, 'MEMBER') as member`;
  assert.equal(member, false, 'the shared database keeps no membership');
});

test('M5D-14: 009 refuses to finish while a runtime role reaches an owner, the name is writable again, 008\'s operation is re-granted, or the schema holds more', async () => {
  const VERIFY = UP_009.slice(UP_009.lastIndexOf('do $$'));
  const [{ schemaOwner, tenantOwner }] = await owner`select
      (select n.nspowner::regrole::text from pg_catalog.pg_namespace n where n.nspname = 'tmpos_command') as "schemaOwner",
      (select c.relowner::regrole::text from pg_catalog.pg_class c where c.oid = 'public.tenant'::regclass) as "tenantOwner"`;
  await rolledBack(async (tx) => {
    const code = refusalIn(tx);
    await tx.unsafe(`drop function if exists tmpos_command.m5_tenant_status_change(uuid, bigint, text, text); alter table public.tenant drop column if exists access_version;`).simple(); // 009's section 7 counts the schema's routines: 010's objects come off first
    assert.equal(await code((sp) => sp.unsafe(VERIFY).simple()), null, 'the verify section passes over the applied state (positive control)');
    for (const [label, setup] of [
      ['UPDATE of the name re-granted to tmpos_app', 'grant update (display_name) on table public.tenant to tmpos_app'],
      ['UPDATE of the whole tenant row to PUBLIC', 'grant update on table public.tenant to public'],
      ['INSERT of the name to authenticated', 'grant insert (display_name) on table public.tenant to authenticated'],
      ['UPDATE of the name to tmpos_audit_writer', 'grant update (display_name) on table public.tenant to tmpos_audit_writer'],
      ['008\'s operation re-granted to tmpos_app', 'grant execute on function tmpos_command.m5_tenant_display_name_update(uuid, bigint, text) to tmpos_app'],
      ['the authority routine to PUBLIC', 'grant execute on function tmpos_command.m5_revalidate_platform_authority(uuid, text, uuid, text) to public'],
      ['the v2 operation WITH GRANT OPTION', 'grant execute on function tmpos_command.m5_tenant_display_name_update_v2(uuid, bigint, text) to tmpos_app with grant option'],
      ['a fifth function in the schema', 'create function tmpos_command.m5d_extra() returns integer language sql as $$ select 1 $$'],
      ['CREATE on the schema', 'grant create on schema tmpos_command to tmpos_app'],
      ['a SET-only membership in the tenant\'s owner', `grant "${tenantOwner}" to tmpos_app with inherit false, set true`],
      ['the audit writer a member of the schema owner', `grant "${schemaOwner}" to tmpos_audit_writer`],
    ]) {
      assert.equal(await code(async (sp) => { await sp.unsafe(setup); await sp.unsafe(VERIFY).simple(); }), '55000', label);
    }
  });
});

// ---------------------------------------------------------------------------
// M5-GIAM-D1-P1-R1 — the legacy direct write, the no-op's completion, exact authority, Unicode
// ---------------------------------------------------------------------------

test('M5D-15: no runtime principal writes a display name outside the command — directly, under a tenant context it sets itself, or as a role it can become', async () => {
  const tenant = await newTenant(`m5d-legacy-${SUFFIX}`);
  const update = (tx) => tx`update public.tenant set display_name = 'Legacy Write' where tenant_id = ${tenant}`;
  // The tenant-scope RLS context is two settings any session may set: that is what made 005's grant reachable.
  const asTenant = (sql, fn) => sql.begin(async (tx) => {
    await tx`select pg_catalog.set_config('app.scope_type', 'tenant', true)`;
    await tx`select pg_catalog.set_config('app.tenant_id', ${tenant}, true)`;
    return fn(tx);
  });
  // The production-composed runtime LOGIN (tmpos_app and tmpos_audit_writer, inherited), and each role it can become.
  assert.equal(await refusalCode(() => update(runtime)), '42501', 'the login, no context');
  assert.equal(await refusalCode(() => asTenant(runtime, update)), '42501', 'the login, under a tenant context it set itself');
  for (const role of ['tmpos_app', 'tmpos_audit_writer']) {
    assert.equal(await refusalCode(() => asTenant(runtime, async (tx) => { await tx.unsafe(`set local role ${role}`); return update(tx); })), '42501', `as ${role}`);
  }
  // A login holding tmpos_app only through SET (INHERIT FALSE): no privilege of its own, and none by becoming the role.
  const setOnly = `tmpos_m5d_setonly_${SUFFIX.replace(/-/g, '')}`;
  await owner.unsafe(`create role ${setOnly} login nosuperuser nocreatedb nocreaterole noreplication nobypassrls noinherit`);
  await owner.unsafe(`grant tmpos_app to ${setOnly} with inherit false, set true`);
  const setOnlySql = connect(setOnly, 1);
  try {
    assert.equal(await refusalCode(() => asTenant(setOnlySql, update)), '42501', 'the SET-only login');
    assert.equal(await refusalCode(() => asTenant(setOnlySql, async (tx) => { await tx.unsafe('set local role tmpos_app'); return update(tx); })), '42501',
      'the SET-only login as tmpos_app');
  } finally {
    await setOnlySql.end({ timeout: 5 });
    await owner.unsafe(`drop role ${setOnly}`);
  }
  // The privilege matrix: no runtime-holdable role may write the name — directly, through a membership or through PUBLIC.
  for (const role of ['tmpos_app', 'tmpos_audit_writer', 'anon', 'authenticated']) {
    for (const privilege of ['UPDATE', 'INSERT']) {
      assert.equal((await owner`select pg_catalog.has_column_privilege(${role}, 'public.tenant', 'display_name', ${privilege}) as ok`)[0].ok, false, `${role} ${privilege}`);
    }
  }
  assert.equal((await runtime`select pg_catalog.has_column_privilege('public.tenant', 'display_name', 'UPDATE') as ok`)[0].ok, false, 'the login itself');
  assert.equal((await tenantRow(tenant)).display_name, `m5d-legacy-${SUFFIX}`, 'nothing was written');
  // The unrelated half of 005's grant stays (legal_name serves no command yet), and still moves the version for every writer.
  const legal = await asTenant(runtime, (tx) => tx`update public.tenant set legal_name = 'Legacy Legal' where tenant_id = ${tenant}`);
  assert.equal(legal.count, 1);
  const row = await tenantRow(tenant);
  assert.deepEqual([row.display_name, row.legal_name, row.row_version], [`m5d-legacy-${SUFFIX}`, 'Legacy Legal', '2']);
  // The fixed command operation still answers the same login.
  assert.deepEqual({ ...(await call(tenant, 2, 'Via Command')) }, { o_outcome: 'applied', o_version: '3' });
});

/** A store whose display-name mutator, once its operation has answered, runs `extra` and then holds the transaction until released. */
function heldStore(extra = async () => undefined) {
  let arrive = () => undefined;
  const arrived = new Promise((resolve) => { arrive = resolve; });
  let release = () => undefined;
  const released = new Promise((resolve) => { release = resolve; });
  const held = createPostgresTransactionalStore({
    client, revalidate: REVALIDATE,
    mutators: [{ ...TENANT_DISPLAY_NAME_MUTATOR, apply: async (sql, mutation) => {
      const answer = await TENANT_DISPLAY_NAME_MUTATOR.apply(sql, mutation);
      await extra(sql);
      arrive();
      await released;
      return answer;
    } }],
  });
  return { held, arrived, release };
}
/** How many backends of this database are waiting on a lock right now. */
const lockWaiters = async () =>
  (await owner`select pg_catalog.count(*)::int as n from pg_catalog.pg_stat_activity
     where datname = pg_catalog.current_database() and wait_event_type = 'Lock'`)[0].n;
/** 'settled' once `promise` settles, 'pending' if it has not within `ms`. */
async function settlesWithin(promise, ms) {
  let timer;
  const late = new Promise((resolve) => { timer = setTimeout(resolve, ms, 'pending'); });
  try {
    return await Promise.race([promise.then(() => 'settled', () => 'settled'), late]);
  } finally {
    clearTimeout(timer);
  }
}

test('M5D-16: a same-name request seals its response in the transaction that locked the row and found it — a concurrent change waits, and the replay is that response', async () => {
  const tenant = await newTenant(`m5d-noop-${SUFFIX}`);
  const sameBody = { tenantId: tenant, displayName: `m5d-noop-${SUFFIX}`, expectedVersion: 1 };
  const record = await acquired(OWNER, sameBody);
  const noop = prepared(record, await contextOf(OWNER), sameBody);
  const { held, arrived, release } = heldStore();
  const noopAnswer = held.transactions.commit(noop.command, signal());
  await arrived; // the operation answered unchanged and still holds the tenant row
  // A real change at the same expected version, by another actor, cannot land between the decision and the completion.
  const changeBody = { tenantId: tenant, displayName: 'Changed After', expectedVersion: 1 };
  const change = prepared(await acquired(SUPPORT, changeBody), await contextOf(SUPPORT), changeBody);
  const changeAnswer = commit(change.command);
  assert.equal(await settlesWithin(changeAnswer, 300), 'pending', 'the change waits on the row the no-op locked');
  assert.ok((await lockWaiters()) > 0, 'and it is waiting on a lock, not merely slow');
  assert.equal(await recordDone(record.operation.scope), false, 'nothing of the no-op is visible before it commits');
  release();
  assert.deepEqual(await noopAnswer, { outcome: 'unchanged' });
  assert.deepEqual(await changeAnswer, { outcome: 'committed' }, 'then the change lands, after the no-op committed at version 1');
  // The exact retry replays the sealed unchanged response byte for byte: the state the no-op observed and committed at.
  const replay = await store.idempotency.acquire({ ...record.operation, lease: randomBytes(32).toString('base64url'), ...IDEMPOTENCY_POLICY }, signal());
  assert.deepEqual(replay, { outcome: 'replay', response: noop.command.unchanged });
  assert.equal(keyring.unseal(replay.response, record.operation)?.body, JSON.stringify({ tenantId: tenant, displayName: `m5d-noop-${SUFFIX}`, version: 1 }));
  // The no-op wrote nothing else: one version step, one audit record and one event — all the change's.
  assert.equal((await tenantRow(tenant)).row_version, '2');
  assert.deepEqual((await auditsOf(tenant)).map((r) => r.request_id), [change.command.audit.correlationId]);
  assert.equal((await auditFor(noop.command.audit.correlationId)).length, 0, 'no audit record for the no-op');
  assert.equal((await eventsFor(tenant)).length, 1, 'no event for it');
});

test('M5D-17: a no-op whose completion cannot hold rolls back whole — no completion, and the record stays in progress', async () => {
  const tenant = await newTenant(`m5d-noop-fail-${SUFFIX}`);
  const body = { tenantId: tenant, displayName: `m5d-noop-fail-${SUFFIX}`, expectedVersion: 1 };
  // A record retained for 300 ms, and a transaction that outlives it after the operation answered: 006's completion judges
  // retention again on the store's clock, refuses, and the no-op's decision rolls back with it.
  const operation = keyring.operationOf(randomUUID(), OWNER.principal, {
    method: 'PATCH', path: TENANT_DISPLAY_NAME_PATH, audience: 'admin', tenant: null, store: null, actor: null, body: Buffer.from(JSON.stringify(body)),
  });
  const lease = randomBytes(32).toString('base64url');
  // Everything the commit needs is built BEFORE the short-lived record is acquired, so only the mutator's own
  // sleep outlives the retention: the fence still holds when the transaction starts, and the completion does not.
  const { held, release } = heldStore(async (sql) => { await sql`select pg_catalog.pg_sleep(1.2)`; });
  release();
  const context = await contextOf(OWNER);
  assert.deepEqual(await store.idempotency.acquire({ ...operation, lease, leaseMs: 800, retentionMs: 800 }, signal()), { outcome: 'acquired', reclaimed: false });
  const { command } = prepared({ operation, lease }, context, body);
  assert.deepEqual(await held.transactions.commit(command, signal()), { outcome: 'unavailable' });
  assert.equal(await recordDone(operation.scope), false, 'no completion was recorded');
  assert.deepEqual([(await tenantRow(tenant)).row_version, (await auditsOf(tenant)).length, (await eventsFor(tenant)).length], ['1', 0, 0]);
});

/** Another active platform grant for `who`, at a chosen membership_id so its order against the authorized one is fixed. */
const addGrant = (who, membershipId, role) => owner`insert into user_membership (membership_id, internal_user_id, scope_type, role_id, status)
  values (${membershipId}::uuid, ${who.id}, 'platform', ${role}, 'active')`;

test('M5D-18: authority changed after authorization commits nothing — removed, disabled, added in any order, re-issued, re-roled, read-only, re-versioned or substituted', async () => {
  const tenant = await newTenant(`m5d-authz-${SUFFIX}`);
  const refusedAfter = async (label, who, context) => {
    const body = { tenantId: tenant, displayName: `Authz ${label}`, expectedVersion: 1 };
    const record = await acquired(who, body);
    const { command } = prepared(record, context, body);
    assert.deepEqual(await commit(command), { outcome: 'unavailable' }, label);
    assert.equal((await tenantRow(tenant)).row_version, '1', `${label}: no version moved`);
    assert.equal((await auditFor(command.audit.correlationId)).length, 0, `${label}: no audit record`);
    assert.equal((await eventsFor(tenant)).length, 0, `${label}: no event`);
    assert.equal(await recordDone(record.operation.scope), false, `${label}: no completion`);
  };
  const changes = [
    ['the grant removed', (who) => owner`delete from user_membership where internal_user_id = ${who.id}`],
    ['the grant disabled', (who) => owner`update user_membership set status = 'suspended' where internal_user_id = ${who.id}`],
    ['a second grant added, ordered before it', (who) => addGrant(who, `00000000${randomUUID().slice(8)}`, 'support_admin')],
    ['a second grant added, ordered after it', (who) => addGrant(who, `ffffffff${randomUUID().slice(8)}`, 'support_admin')],
    ['the grant re-issued under a new id', async (who) => {
      await owner`delete from user_membership where internal_user_id = ${who.id}`;
      await owner`insert into user_membership (internal_user_id, scope_type, role_id, status) values (${who.id}, 'platform', 'system_owner', 'active')`;
    }],
    ['the grant re-roled below Edit', (who) => owner`update user_membership set role_id = 'billing_admin' where internal_user_id = ${who.id}`],
    ['the grant re-roled to another editor', (who) => owner`update user_membership set role_id = 'support_admin' where internal_user_id = ${who.id}`],
    ['the account made read-only', (who) => owner`update app_user set status = 'read_only' where internal_user_id = ${who.id}`],
    ['the account made overdue', (who) => owner`update app_user set status = 'overdue' where internal_user_id = ${who.id}`],
    ['the account suspended', (who) => owner`update app_user set status = 'suspended' where internal_user_id = ${who.id}`],
    ['the account returned to pending activation', (who) => owner`update app_user set status = 'pending_activation' where internal_user_id = ${who.id}`],
    ['the security version moved', (who) => owner`update app_user set status = 'active' where internal_user_id = ${who.id}`],
  ];
  for (const [label, change] of changes) {
    const who = await actor(`authz-${label.replace(/[^a-z]+/gi, '-')}`, { scope: 'platform', role: 'system_owner' });
    const context = await contextOf(who);
    await change(who);
    await refusedAfter(label, who, context);
  }
  // A different grant never answers for the authorized one: another actor's, or this actor's own tenant grant.
  const other = await actor('authz-other', { scope: 'platform', role: 'system_owner' });
  const [{ membership_id: othersGrant }] = await owner`select membership_id from user_membership where internal_user_id = ${other.id}`;
  const mixed = await actor('authz-mixed', { scope: 'platform', role: 'system_owner' });
  await owner`insert into user_membership (internal_user_id, tenant_id, scope_type, role_id, status) values (${mixed.id}, ${T_STORE}, 'tenant', 'manager', 'active')`;
  const [{ membership_id: ownTenantGrant }] = await owner`select membership_id from user_membership where internal_user_id = ${mixed.id} and scope_type = 'tenant'`;
  await refusedAfter('another actor\'s grant substituted', mixed, { ...(await contextOf(mixed)), membershipId: othersGrant });
  await refusedAfter('the actor\'s tenant grant substituted', mixed, { ...(await contextOf(mixed)), membershipId: ownTenantGrant });
  // Control: unchanged authority commits.
  const body = { tenantId: tenant, displayName: 'Authz Control', expectedVersion: 1 };
  const { command } = prepared(await acquired(mixed, body), await contextOf(mixed), body);
  assert.deepEqual(await commit(command), { outcome: 'committed' }, 'the same actor, its authority unchanged, commits');
});

test('M5D-19: a grant added or revoked while a command holds its revalidated authority waits for that command, never slipping in between', async () => {
  const tenant = await newTenant(`m5d-race-authz-${SUFFIX}`);
  let version = 1;
  for (const [label, change] of [
    ['a second platform grant inserted', (sql, who) => sql`insert into user_membership (internal_user_id, scope_type, role_id, status) values (${who.id}, 'platform', 'support_admin', 'active')`],
    ['the authorized grant suspended', (sql, who) => sql`update user_membership set status = 'suspended' where internal_user_id = ${who.id}`],
    ['the account suspended', (sql, who) => sql`update app_user set status = 'suspended' where internal_user_id = ${who.id}`],
  ]) {
    const who = await actor(`race-${label.replace(/[^a-z]+/gi, '-')}`, { scope: 'platform', role: 'system_owner' });
    const body = { tenantId: tenant, displayName: `Race ${label}`, expectedVersion: version };
    const { command } = prepared(await acquired(who, body), await contextOf(who), body);
    const { held, arrived, release } = heldStore();
    const answer = held.transactions.commit(command, signal());
    await arrived; // revalidated and mutated, the authority rows locked
    const racer = connect(undefined, 1);
    try {
      const racing = change(racer, who);
      assert.equal(await settlesWithin(racing, 300), 'pending', `${label}: waits on the command's locks`);
      assert.ok((await lockWaiters()) > 0, `${label}: waiting on a lock, not merely slow`);
      release();
      assert.deepEqual(await answer, { outcome: 'committed' }, `${label}: the command committed on the authority it held`);
      await racing;
    } finally {
      await racer.end({ timeout: 5 });
    }
    version += 1;
    const resolution = await principals.resolve(who.principal, signal());
    const after = resolution.outcome === 'resolved' ? selectScope(resolution.principal, 'platform', { tenant: null, store: null }).outcome : 'refused';
    assert.equal(after, 'refused', `${label}: afterwards the actor is refused at the chain`);
  }
});

test('M5D-20: over HTTP one platform grant authorizes, none or two refuse, and authority changed after the authorizer and before the transaction commits nothing', async () => {
  const tenant = await newTenant(`m5d-http-authority-${SUFFIX}`);
  const single = await actor('http-single', { scope: 'platform', role: 'system_owner' });
  const double = await actor('http-double', { scope: 'platform', role: 'system_owner' });
  await addGrant(double, randomUUID(), 'support_admin');
  const changing = [];
  for (const label of ['removed', 'added', 'rerolled']) changing.push(await actor(`http-${label}`, { scope: 'platform', role: 'system_owner' }));
  let beforeCommit = async () => undefined;
  const port = { commit: async (c, s) => { await beforeCommit(); return store.transactions.commit(c, s); }, probe: (s) => store.transactions.probe(s) };
  await withChain(async ({ signIn, login }) => {
    // M5-GIAM-D1-P4: none or two are refused by durable admission at the login — the generic 401 — before any route.
    const refusedNone = await login(TENANT_ONLY);
    assert.deepEqual([refusedNone.status, errorOf(refusedNone)], [401, 'unauthenticated'], 'no platform grant');
    const refusedTwo = await login(double);
    assert.deepEqual([refusedTwo.status, errorOf(refusedTwo)], [401, 'unauthenticated'], 'two platform grants are ambiguous');
    for (const [who, change] of [
      [changing[0], () => owner`delete from user_membership where internal_user_id = ${changing[0].id}`],
      [changing[1], () => addGrant(changing[1], randomUUID(), 'support_admin')],
      [changing[2], () => owner`update user_membership set role_id = 'billing_admin' where internal_user_id = ${changing[2].id}`],
    ]) {
      const patch = await signIn(who);
      beforeCommit = async () => { beforeCommit = async () => undefined; await change(); };
      const refused = await patch({ tenantId: tenant, displayName: 'Changed Underneath', expectedVersion: 1 });
      assert.deepEqual([refused.status, errorOf(refused)], [503, 'service_unavailable'], 'authorized, then changed before the transaction: nothing commits');
    }
    assert.deepEqual([(await tenantRow(tenant)).row_version, (await auditsOf(tenant)).length, (await eventsFor(tenant)).length], ['1', 0, 0], 'nothing moved');
    const one = await signIn(single);
    const granted = await one({ tenantId: tenant, displayName: 'Single Grant', expectedVersion: 1 });
    assert.deepEqual([granted.status, JSON.parse(granted.body)], [200, { tenantId: tenant, displayName: 'Single Grant', version: 2 }], 'one grant authorizes');
    assert.deepEqual(await owner_audits(tenant), [single.id]);
  }, { port, actors: [single, double, ...changing] });
});

test('M5D-21: the runtime validator and the database operation agree character by character — every Bidi_Control refused by both, ordinary text accepted by both', async () => {
  const tenant = await newTenant(`m5d-unicode-${SUFFIX}`);
  const cp = (...codes) => String.fromCodePoint(...codes);
  const corpus = [
    ...BIDI_CONTROLS.map((code) => `Acme${cp(code)}Repairs`), `${cp(0x200f)}Acme`, `Acme${cp(0x2069)}`, `invoice${cp(0x202e)}fdp.exe`,
    cp(0x645, 0x62a, 0x62c, 0x631, 0x20, 0x627, 0x644, 0x625, 0x635, 0x644, 0x627, 0x62d), cp(0x5ea, 0x5d9, 0x5e7, 0x5d5, 0x5df),
    `Acme ${cp(0x5d7, 0x5e0, 0x5d5, 0x5ea)} 24`, `Cafe${cp(0x301)} Re${cp(0x301)}paration`, `${cp(0x1f469, 0x200d, 0x1f527)} Fix`,
    `Acme${cp(0x200b)}Repairs`, `Acme${cp(0x2060)}Repairs`, `Acme${cp(0xad)}Repairs`, `${cp(0x2764, 0xfe0f)} Repairs`, 'Acme  Repairs',
  ];
  let version = 1;
  let refused = 0;
  for (const name of corpus) {
    const runtimeAccepts = normalizeTenantDisplayName(name) === name;
    const answer = await call(tenant, version, name);
    assert.equal(answer.o_outcome !== 'invalid', runtimeAccepts, `${JSON.stringify(name)}: runtime ${runtimeAccepts}, database ${answer.o_outcome}`);
    if (answer.o_outcome === 'applied') version += 1;
    if (!runtimeAccepts) refused += 1;
  }
  assert.equal(refused, BIDI_CONTROLS.length + 3, 'exactly the Bidi_Control names are refused');
  assert.equal(version, corpus.length - refused + 1, 'and every other name was written');
});

test('M5D-22: a command commits only while the session presenting it is live and bound to its current standing — ended, absent, another\'s, or a grant removed and restored commits nothing; a logout racing a held command waits for it', async () => {
  // M5-ADMIN-REVOKE-P1, over the production revalidator: 009's locks, then the presenting session held, then 013's read.
  const refused = async (label, who, context, sessionKey) => {
    const tenant = await newTenant(`m5d-session-${label.replace(/[^a-z]+/gi, '-')}-${SUFFIX}`);
    const body = { tenantId: tenant, displayName: `Session ${label}`, expectedVersion: 1 };
    const record = await acquired(who, body);
    const { command } = prepared(record, context, body, sessionKey);
    assert.deepEqual(await commit(command), { outcome: 'unavailable' }, label);
    assert.deepEqual([(await tenantRow(tenant)).row_version, (await auditFor(command.audit.correlationId)).length, (await eventsFor(tenant)).length,
      await recordDone(record.operation.scope)], ['1', 0, 0, false], `${label}: no mutation, audit record, event or completion`);
  };
  // The presenting session ended first — a logout or a revocation committed before the command's transaction (R3).
  const loggedOut = await actor('session-ended', { scope: 'platform', role: 'system_owner' });
  const context = await contextOf(loggedOut);
  const ended = SESSION_KEYS.get(loggedOut.id);
  await SESSIONS.revoke(ended, signal());
  await refused('the presenting session ended first', loggedOut, context, ended);
  await refused('no session presented', loggedOut, context, null);
  // Another administrator's live session: it holds, but its standing selects another grant than the command's scope.
  const other = await actor('session-other', { scope: 'platform', role: 'system_owner' });
  await contextOf(other);
  const self = await actor('session-self', { scope: 'platform', role: 'system_owner' });
  await refused('another administrator\'s session', self, await contextOf(self), SESSION_KEYS.get(other.id));
  // The grant removed and restored (R4): 009 alone still answers valid — the same grant, the same role, 007's version
  // unmoved — but 013's authority version only increases, so the session's witness no longer holds.
  const restored = await actor('session-restored', { scope: 'platform', role: 'system_owner' });
  const before = await contextOf(restored);
  const boundKey = SESSION_KEYS.get(restored.id);
  await owner`update user_membership set status = 'suspended' where internal_user_id = ${restored.id}`;
  await owner`update user_membership set status = 'active' where internal_user_id = ${restored.id}`;
  assert.equal(await client.transaction(signal(), PLATFORM_ADMISSION_BOUNDS, (sql) => revalidatePlatformAuthority(sql, before, null)), true,
    '009 cannot see a removal followed by a restoration');
  await refused('a grant removed and restored', restored, before, boundKey);
  // Control: a session established since, at the new witness, commits the very same command shape.
  const since = await contextOf(restored);
  const tenant = await newTenant(`m5d-session-control-${SUFFIX}`);
  const body = { tenantId: tenant, displayName: 'Session Control', expectedVersion: 1 };
  assert.deepEqual(await commit(prepared(await acquired(restored, body), since, body).command), { outcome: 'committed' }, 'a live session at the current witness commits');

  // Command first: a logout racing a command that holds its session waits for the command's COMMIT, never slipping in between.
  const racing = await actor('session-race', { scope: 'platform', role: 'system_owner' });
  const raceContext = await contextOf(racing);
  const raceKey = SESSION_KEYS.get(racing.id);
  const raceTenant = await newTenant(`m5d-session-race-${SUFFIX}`);
  const raceBody = { tenantId: raceTenant, displayName: 'Session Race', expectedVersion: 1 };
  const { command } = prepared(await acquired(racing, raceBody), raceContext, raceBody);
  const { held, arrived, release } = heldStore();
  const answer = held.transactions.commit(command, signal());
  await arrived; // revalidated — the session row held — and mutated
  const logout = SESSIONS.revoke(raceKey, signal());
  assert.equal(await settlesWithin(logout, 300), 'pending', 'the logout waits on the session row the command holds');
  assert.ok((await lockWaiters()) > 0, 'waiting on a lock, not merely slow');
  release();
  assert.deepEqual(await answer, { outcome: 'committed' }, 'the command committed while its session was live');
  await logout;
  assert.equal(await SESSIONS.get(raceKey, signal()), undefined, 'then the logout ended the session');
  assert.equal((await tenantRow(raceTenant)).row_version, '2');
});

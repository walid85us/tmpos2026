// Phase 4.0 M3 S2 — tenant/store isolation against a REAL disposable PostgreSQL.
//
// Everything here runs against a throwaway `tmpos_s1b_*` database: locally a cluster the S1b
// harness creates on a task-owned Unix socket, in CI the workflow's disposable loopback service.
// No managed provider, no persistent application database, and no ambient application DSN is
// ever consulted — the trusted executor itself refuses anything that is not a disposable local
// target.
//
// WHY THIS SUITE EXISTS AND THE STATIC CONTRACT IS NOT ENOUGH:
//   tests/quality/migration-005-contract.test.mjs proves migration 005 has the right SHAPE.
//   Shape is not isolation. A policy can be syntactically perfect, target the right role, carry
//   both clauses, and still be semantically overbroad — or be entirely unreachable because the
//   privilege it guards was never granted. Only a real server, queried by a real non-owner
//   principal, can tell those apart.
//
// THE OWNER PROVES NOTHING HERE. Migration 005 deliberately does not set FORCE ROW LEVEL
// SECURITY, so the table owner still bypasses every policy. A suite that queried as the owner
// would see all four stores and report success no matter how broken the policies were. Every
// isolation assertion below therefore runs through an ephemeral NON-OWNER LOGIN role that
// inherits nothing but the tmpos_app / tmpos_audit_writer privilege roles.
//
// PRIVILEGE DENIAL IS NOT RLS DENIAL. Both surface as SQLSTATE 42501, and conflating them is
// the classic way to "prove" isolation that is really just a missing GRANT. `classifyDenial`
// separates them by message and every negative assertion states which one it expects.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

import { startDisposablePostgres, localPostgresAvailable } from './localPostgres.harness.mjs';
import {
  assertDisposableTestDsn,
  createPostgresExecutor,
  runTrustedApply,
} from '../../server/platform-identity/migrationExecutor.ts';
import { createNodeFsPort } from '../../server/platform-identity/migrationEngine.ts';
import {
  withTenantContext,
  readTenantContext,
  runtimeClientOptions,
  DB_SESSION_BOUNDS,
  CONTEXT_SETTINGS,
} from '../../server/platform-identity/db.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const MIG_DIR = join(REPO, 'server', 'platform-identity', 'migrations');
const MIG_REL = 'server/platform-identity/migrations';
const FIXTURE_SQL = readFileSync(join(HERE, 'fixtures', 'twoTenantTwoStore.setup.sql'), 'utf8');
const UP_005 = readFileSync(join(MIG_DIR, '005_principal_separation_rls_foundation.up.sql'), 'utf8');
const DOWN_005 = readFileSync(join(MIG_DIR, '005_principal_separation_rls_foundation.down.sql'), 'utf8');

const LOCK_KEY = 720100302;
const CREDENTIAL = { purpose: 'migration', migratorRef: 's2-migrator', runtimeRef: 's2-runtime' };
const NOW = () => new Date().toISOString();

const RUNTIME_ROLE = 'tmpos_app';
const AUDIT_ROLE = 'tmpos_audit_writer';
const APP_PROBE = 'tmpos_rls_probe_app';
const AUDIT_PROBE = 'tmpos_rls_probe_audit';

// Fixture identifiers (see tests/db/fixtures/twoTenantTwoStore.setup.sql).
const T_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const T_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const S_A1 = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
const S_A2 = 'a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2';
const S_B1 = 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1';
const S_B2 = 'b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2';
const PLATFORM_MEMBERSHIP = 'cccccccc-0005-4ccc-8ccc-cccccccccccc';

const CTX_TENANT_A = { scopeType: 'tenant', tenantId: T_A };
const CTX_TENANT_B = { scopeType: 'tenant', tenantId: T_B };
const CTX_STORE_A1 = { scopeType: 'store', tenantId: T_A, storeId: S_A1 };

// ---------------------------------------------------------------------------
// cluster lifecycle
// ---------------------------------------------------------------------------

const ambientTestDsn = process.env.TM_POS_TEST_DATABASE_URL;
let cluster = null;
let TARGET_DSN = null;
let CLIENT_OPTS = {};

if (typeof ambientTestDsn === 'string' && ambientTestDsn.trim() !== '') {
  TARGET_DSN = ambientTestDsn.trim();
} else if (localPostgresAvailable()) {
  cluster = startDisposablePostgres();
  TARGET_DSN = cluster.dsn;
  CLIENT_OPTS = cluster.clientOptions;
} else {
  throw new Error(
    'S2 INFRASTRUCTURE BLOCKER: no TM_POS_TEST_DATABASE_URL and no local initdb/pg_ctl. ' +
    'Docker and remote databases are not substitutes.',
  );
}

// VALIDATE BEFORE TOUCHING ANYTHING. The statements below include cluster-wide DDL (CREATE
// ROLE), which is not scoped to a database and cannot be undone by dropping one. Running the
// executor's own guard here — not later, at apply time — means an ambient
// TM_POS_TEST_DATABASE_URL pointing anywhere but a disposable local target is refused before a
// single byte is sent.
assertDisposableTestDsn(TARGET_DSN);

/** `host`/`user` are libpq TRANSPORT parameters; the driver would forward them to the server as
 *  startup settings and the connection would be refused, so they are stripped from the URL and
 *  travel in CLIENT_OPTS instead. Userinfo is REPLACED (not blanked) when a role is named: the
 *  CI service DSN carries `tmpos_s1b_owner@`, and blanking it would fall back to the OS account,
 *  which is not a role in that cluster. */
function driverDsn(raw, user) {
  const u = new URL(raw);
  u.searchParams.delete('host');
  u.searchParams.delete('user');
  if (user !== undefined) {
    u.username = encodeURIComponent(user);
    u.password = '';
  }
  return u.toString();
}

/** The OWNER connection. Used only to build fixtures and to observe out of band — never to
 *  make an isolation claim, because the owner is not subject to any policy here. */
const observer = postgres(driverDsn(TARGET_DSN), {
  max: 1, prepare: false, idle_timeout: 0, onnotice: () => {}, ...CLIENT_OPTS,
});

/**
 * A probe client for one non-owner role, configured with the RUNTIME PRINCIPAL'S OWN options.
 *
 * `runtimeClientOptions` is imported from db.ts rather than restated, so the bounds proved live
 * below are the bounds the runtime client really applies. `max: 1` is a deliberate override and
 * the strongest available setting for the context-leak tests: every transaction is served by the
 * SAME physical backend, so a context that survived its transaction would be visible to the next
 * one. A larger pool could hand out a fresh backend and prove nothing.
 */
function probeClient(role) {
  return postgres(driverDsn(TARGET_DSN, role), {
    ...runtimeClientOptions(TARGET_DSN),
    // EXPLICIT TLS opt-out, stated here rather than inferred by db.ts from the hostname. The
    // disposable target is a task-owned socket locally and a plaintext loopback service in CI;
    // neither offers TLS. Making the exemption visible at the call site is what lets the
    // production helper keep requiring TLS for every loopback DSN (see sslFor in db.ts).
    ssl: false,
    max: 1,
    idle_timeout: 0,
    onnotice: () => {},
    ...CLIENT_OPTS,
    user: role,
  });
}

let appProbe = null;
let auditProbe = null;
let applyReport = null;

/** Classify a rejection. Both privilege and RLS-check failures are SQLSTATE 42501; treating
 *  them as one is how a missing GRANT gets mistaken for working isolation. */
function classifyDenial(err) {
  const msg = String(err?.message ?? '');
  const code = err?.code ?? null;
  if (/row-level security policy/i.test(msg)) return { kind: 'rls', code, msg };
  if (/permission denied/i.test(msg)) return { kind: 'privilege', code, msg };
  if (/append-only/i.test(msg)) return { kind: 'append_only', code, msg };
  if (/violates check constraint/i.test(msg)) return { kind: 'constraint', code, msg };
  return { kind: 'other', code, msg };
}

/** Run `fn` and report how it was refused ('none' when it was not). */
async function refusal(fn) {
  try {
    await fn();
    return { kind: 'none', code: null, msg: '' };
  } catch (e) {
    return classifyDenial(e);
  }
}

/** Every isolation assertion goes through the real S2 context helper, on a real connection. */
const asApp = (ctx, fn) => withTenantContext(appProbe, ctx, fn);
const asAuditWriter = (ctx, fn) => withTenantContext(auditProbe, ctx, fn);

// ---------------------------------------------------------------------------
// setup: real migrations, real fixture, real non-owner principals
// ---------------------------------------------------------------------------

// 001-004 revoke from `anon` and `authenticated`, which exist on Supabase Postgres but not in a
// bare cluster. Creating them here reproduces the role environment those migrations declare they
// assume, rather than editing a frozen migration to accommodate the test.
await observer.unsafe(`do $$ begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;`);

{
  const dsn = assertDisposableTestDsn(TARGET_DSN);
  const handle = await createPostgresExecutor(dsn);
  try {
    applyReport = await runTrustedApply({
      fsPort: createNodeFsPort(MIG_DIR, MIG_REL),
      adapter: handle.adapter,
      ledger: handle.ledger,
      connectionMode: 'session',
      credential: CREDENTIAL,
      lockKey: LOCK_KEY,
      now: NOW,
      deadlineMs: 60_000,
    });
  } finally {
    await handle.dispose();
  }
}

await observer.unsafe(FIXTURE_SQL).simple();

// Ephemeral LOGIN probes. They carry NO password: the disposable cluster authenticates locally
// by trust, so no credential is created, stored, or transmitted anywhere in this suite.
await observer.unsafe(
  `create role ${APP_PROBE} login nosuperuser nocreatedb nocreaterole noreplication nobypassrls inherit`,
);
await observer.unsafe(
  `create role ${AUDIT_PROBE} login nosuperuser nocreatedb nocreaterole noreplication nobypassrls inherit`,
);
await observer.unsafe(`grant ${RUNTIME_ROLE} to ${APP_PROBE}`);
await observer.unsafe(`grant ${AUDIT_ROLE} to ${AUDIT_PROBE}`);

appProbe = probeClient(APP_PROBE);
auditProbe = probeClient(AUDIT_PROBE);

test.after(async () => {
  for (const c of [appProbe, auditProbe]) {
    if (c) await c.end({ timeout: 0 }).catch(() => {});
  }
  await observer.end({ timeout: 5 }).catch(() => {});
  if (cluster !== null) {
    const life = cluster.stop();
    assert.equal(life.stopped, true, 'the task-created PostgreSQL process must be stopped');
    assert.equal(life.removed, true, 'the task-created temporary directory must be removed');
  }
});

// ---------------------------------------------------------------------------
// foundation
// ---------------------------------------------------------------------------

test('S2-DB-1: migrations 001-005 apply to a DISPOSABLE database through the trusted engine', async () => {
  assert.equal(applyReport.outcome, 'complete', `apply failed: ${applyReport.code}`);
  assert.deepEqual(applyReport.applied, ['001', '002', '003', '004', '005']);
  const dsn = assertDisposableTestDsn(TARGET_DSN);
  assert.match(dsn.database, /^tmpos_s1b_/, 'the target database must be disposable by name');
  const [{ current_database: live }] = await observer`select current_database()`;
  assert.equal(live, dsn.database);
  const rows = await observer`select version, dirty from public.schema_migrations order by version`;
  assert.deepEqual(rows.map((r) => [r.version, r.dirty]),
    [['001', false], ['002', false], ['003', false], ['004', false], ['005', false]]);
});

test('S2-DB-2: both privilege roles exist and are NOLOGIN and least-privileged', async () => {
  const rows = await observer`
    select rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolinherit
    from pg_catalog.pg_roles where rolname in (${RUNTIME_ROLE}, ${AUDIT_ROLE}) order by rolname`;
  assert.deepEqual(rows.map((r) => r.rolname), [RUNTIME_ROLE, AUDIT_ROLE].sort());
  for (const r of rows) {
    assert.equal(r.rolcanlogin, false, `${r.rolname} must be NOLOGIN — it carries privileges, it does not connect`);
    assert.equal(r.rolsuper, false, `${r.rolname} SUPERUSER`);
    assert.equal(r.rolcreatedb, false, `${r.rolname} CREATEDB`);
    assert.equal(r.rolcreaterole, false, `${r.rolname} CREATEROLE`);
    assert.equal(r.rolreplication, false, `${r.rolname} REPLICATION`);
    assert.equal(r.rolbypassrls, false, `${r.rolname} BYPASSRLS`);
  }
});

test("S2-DB-2b: 005's role management succeeds for a NON-superuser holding only CREATEROLE", async () => {
  // S2-DB-1 applies through the cluster's bootstrap SUPERUSER, which accepts statements a
  // managed deployment refuses — so on its own it cannot prove the migration is portable. This
  // runs 005's role-management blocks verbatim under the REAL production constraint
  // (NOSUPERUSER + CREATEROLE), which is the only way to catch a statement like COMMENT ON ROLE
  // that silently needs ADMIN OPTION.
  const MIGRATOR = 'tmpos_s2_nonsuper_migrator';
  const NS_APP = 'tmpos_ns_app';
  const NS_AUDIT = 'tmpos_ns_audit';
  await observer.unsafe(
    `create role ${MIGRATOR} login nosuperuser createrole nocreatedb noreplication nobypassrls inherit`,
  );
  const asMigrator = postgres(driverDsn(TARGET_DSN, MIGRATOR), {
    ssl: false, max: 1, prepare: false, idle_timeout: 0, onnotice: () => {}, ...CLIENT_OPTS, user: MIGRATOR,
  });
  try {
    const [{ issuper }] = await asMigrator`select rolsuper as issuper from pg_catalog.pg_roles
                                           where rolname = current_user`;
    assert.equal(issuper, false, 'the probe migrator must NOT be a superuser, or this proves nothing');

    const blocks = UP_005.match(/do \$\$[\s\S]*?\$\$;/g) ?? [];
    assert.equal(blocks.length, 2, 'expected exactly the two role-management DO blocks in 005');
    for (const block of blocks) {
      // Renamed so this cannot collide with the roles the main apply already created.
      const probe = block.replace(/tmpos_audit_writer/g, NS_AUDIT).replace(/tmpos_app/g, NS_APP)
        .replace(/;\s*$/, '');
      const r = await refusal(() => asMigrator.unsafe(probe));
      assert.equal(r.kind, 'none',
        `a NOSUPERUSER CREATEROLE migrator must be able to run 005 role management: ${r.code} ${r.msg}`);
    }

    const created = await observer`
      select rolname, rolcanlogin, rolsuper, rolbypassrls from pg_catalog.pg_roles
      where rolname in (${NS_APP}, ${NS_AUDIT}) order by rolname`;
    assert.equal(created.length, 2, 'both privilege roles were created by the non-superuser');
    assert.ok(created.every((r) => r.rolcanlogin === false && r.rolsuper === false && r.rolbypassrls === false),
      'and they came out least-privileged');
  } finally {
    await asMigrator.end({ timeout: 0 }).catch(() => {});
    for (const r of [NS_APP, NS_AUDIT, MIGRATOR]) {
      await observer.unsafe(`drop role if exists ${r}`).catch(() => {});
    }
  }
});

test('S2-DB-3: the probe is a non-owner, NOBYPASSRLS role inheriting only the privilege roles', async () => {
  const [probe] = await observer`
    select rolsuper, rolbypassrls, rolinherit from pg_catalog.pg_roles where rolname = ${APP_PROBE}`;
  assert.equal(probe.rolsuper, false);
  assert.equal(probe.rolbypassrls, false, 'a probe that could bypass RLS would prove nothing');
  assert.equal(probe.rolinherit, true, 'the probe must inherit the privilege role it is a member of');

  const memberships = await observer`
    select r.rolname from pg_catalog.pg_auth_members m
    join pg_catalog.pg_roles r on r.oid = m.roleid
    join pg_catalog.pg_roles g on g.oid = m.member
    where g.rolname = ${APP_PROBE} order by r.rolname`;
  assert.deepEqual(memberships.map((m) => m.rolname), [RUNTIME_ROLE], 'exactly one membership, and it is the runtime role');

  const owners = await observer`
    select tableowner from pg_catalog.pg_tables where schemaname = 'public' and tablename = 'store'`;
  assert.notEqual(owners[0].tableowner, APP_PROBE, 'the probe must NOT own the tables it queries');

  const [{ me }] = await appProbe`select current_user as me`;
  assert.equal(me, APP_PROBE, 'the probe session really authenticates as the probe role');
});

test("S2-DB-4: the runtime principal's server-side bounds are live on the probe session", async () => {
  assert.equal(appProbe.options.connection.statement_timeout, DB_SESSION_BOUNDS.statement_timeout);
  assert.equal(
    appProbe.options.connection.idle_in_transaction_session_timeout,
    DB_SESSION_BOUNDS.idle_in_transaction_session_timeout,
  );
  // Proved on the SERVER, not merely requested by the client.
  const [st] = await appProbe`show statement_timeout`;
  const [it] = await appProbe`show idle_in_transaction_session_timeout`;
  assert.equal(st.statement_timeout, '15s');
  assert.equal(it.idle_in_transaction_session_timeout, '15s');
});

// ---------------------------------------------------------------------------
// positive controls — every granted verb works IN SCOPE
// ---------------------------------------------------------------------------

test('S2-DB-5: same-scope SELECT succeeds on every readable table', async () => {
  await asApp(CTX_TENANT_A, async (tx) => {
    const tenants = await tx`select tenant_id from tenant`;
    assert.deepEqual(tenants.map((r) => r.tenant_id), [T_A], 'exactly the context tenant is visible');

    const stores = await tx`select store_id from store order by store_id`;
    assert.deepEqual(stores.map((r) => r.store_id).sort(), [S_A1, S_A2].sort());

    const memberships = await tx`select membership_id from user_membership`;
    assert.equal(memberships.length, 3, 'the three tenant-A grants, and nothing else');

    const ents = await tx`select feature_key, enabled from tenant_feature_entitlement`;
    assert.deepEqual(ents.map((r) => [r.feature_key, r.enabled]), [['fixture.capability', true]]);
  });
});

test('S2-DB-6: same-scope UPDATE succeeds on tenant and store (both granted verbs)', async () => {
  await asApp(CTX_TENANT_A, async (tx) => {
    const t = await tx`update tenant set display_name = 'Fixture Tenant A (renamed)' where tenant_id = ${T_A}`;
    assert.equal(t.count, 1, 'a tenant-scoped UPDATE of the context tenant must succeed');

    const s = await tx`update store set store_name = 'Tenant A / Store 1 (renamed)' where store_id = ${S_A1}`;
    assert.equal(s.count, 1, 'a same-tenant store UPDATE must succeed');
  });
  const [{ display_name: name }] = await observer`select display_name from tenant where tenant_id = ${T_A}`;
  assert.equal(name, 'Fixture Tenant A (renamed)', 'the write really committed');
});

test('S2-DB-6b: the authorization-critical COLUMNS are not writable, even in scope', async () => {
  // RLS is row-granular: no policy can stop a permitted UPDATE from touching a given column.
  // The only thing that can is a column-list GRANT, so this is what proves it. tenant.status
  // and store.status are deny-BEFORE-role in the resolver and plan_key gates entitlements — a
  // principal able to clear its own suspension or raise its own plan would not be least
  // privileged, however correct the row predicates are.
  for (const [label, run] of [
    ['tenant.status', (tx) => tx`update tenant set status = 'active' where tenant_id = ${T_A}`],
    ['tenant.plan_key', (tx) => tx`update tenant set plan_key = 'advanced' where tenant_id = ${T_A}`],
    ['store.status', (tx) => tx`update store set status = 'active' where store_id = ${S_A1}`],
  ]) {
    const r = await refusal(() => asApp(CTX_TENANT_A, run));
    assert.equal(r.kind, 'privilege', `${label} must be refused by column privilege: ${r.kind} ${r.msg}`);
    assert.equal(r.code, '42501');
  }
  const [{ status, plan_key: plan }] = await observer`select status, plan_key from tenant where tenant_id = ${T_A}`;
  assert.equal(status, 'active', 'the fixture tenant status is unchanged');
  assert.equal(plan, 'growth', 'and its plan was not raised');
});

test('S2-DB-7: same-scope INSERT succeeds on store (the one granted INSERT)', async () => {
  const NEW_STORE = 'a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3';
  await asApp(CTX_TENANT_A, async (tx) => {
    const r = await tx`insert into store (store_id, tenant_id, store_name)
                       values (${NEW_STORE}, ${T_A}, 'Tenant A / Store 3')`;
    assert.equal(r.count, 1, 'an in-tenant store INSERT must succeed');
  });
  const rows = await observer`select tenant_id from store where store_id = ${NEW_STORE}`;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tenant_id, T_A);
  await observer`delete from store where store_id = ${NEW_STORE}`;
});

// ---------------------------------------------------------------------------
// negative controls — cross-tenant
// ---------------------------------------------------------------------------

test('S2-DB-8: cross-tenant SELECT returns no unauthorized row', async () => {
  await asApp(CTX_TENANT_A, async (tx) => {
    // Explicitly asking for tenant B returns nothing: RLS filters, it does not error.
    const stores = await tx`select store_id from store where tenant_id = ${T_B}`;
    assert.deepEqual([...stores], [], 'tenant A must not see a tenant-B store');
    const tenants = await tx`select tenant_id from tenant where tenant_id = ${T_B}`;
    assert.deepEqual([...tenants], [], 'tenant A must not see the tenant-B row');
    const ents = await tx`select entitlement_id from tenant_feature_entitlement where tenant_id = ${T_B}`;
    assert.deepEqual([...ents], [], 'tenant A must not see tenant-B entitlements');
  });
  // And symmetrically, so the test cannot pass merely because tenant A happens to be first.
  await asApp(CTX_TENANT_B, async (tx) => {
    const stores = await tx`select store_id from store order by store_id`;
    assert.deepEqual(stores.map((r) => r.store_id).sort(), [S_B1, S_B2].sort());
  });
});

test('S2-DB-9: a PLATFORM-scope membership (tenant_id NULL) is invisible to every tenant context', async () => {
  for (const ctx of [CTX_TENANT_A, CTX_TENANT_B, CTX_STORE_A1]) {
    await asApp(ctx, async (tx) => {
      const rows = await tx`select membership_id from user_membership where membership_id = ${PLATFORM_MEMBERSHIP}`;
      assert.deepEqual([...rows], [], `platform grant leaked into ${ctx.scopeType} scope`);
    });
  }
  // It really is there — the owner can see it, so the empty result above is RLS, not an empty table.
  const owned = await observer`select membership_id from user_membership where membership_id = ${PLATFORM_MEMBERSHIP}`;
  assert.equal(owned.length, 1, 'the platform grant exists; the runtime principal simply cannot see it');
});

test('S2-DB-10: cross-tenant INSERT is rejected by WITH CHECK, not by a missing privilege', async () => {
  const r = await refusal(() => asApp(CTX_TENANT_A, async (tx) => {
    await tx`insert into store (store_id, tenant_id, store_name)
             values ('a9a9a9a9-a9a9-4a9a-8a9a-a9a9a9a9a9a9', ${T_B}, 'smuggled into tenant B')`;
  }));
  assert.equal(r.kind, 'rls', `expected an RLS refusal, got ${r.kind}: ${r.msg}`);
  assert.equal(r.code, '42501');
  const leaked = await observer`select store_id from store where store_name = 'smuggled into tenant B'`;
  assert.deepEqual([...leaked], [], 'nothing may reach tenant B');
});

test('S2-DB-11: cross-tenant UPDATE affects no row, and redirecting one across tenants is refused', async () => {
  await asApp(CTX_TENANT_A, async (tx) => {
    const blind = await tx`update store set store_name = 'hijacked' where store_id = ${S_B1}`;
    assert.equal(blind.count, 0, 'a tenant-B store is not even targetable from tenant A');
  });
  // Redirecting a VISIBLE row out of scope is refused EARLIER than RLS: since the UPDATE grant
  // is column-scoped to store_name, tenant_id is not writable at all, so this is a privilege
  // denial rather than a WITH CHECK violation. That is the stronger of the two — the scope
  // columns cannot be touched, so no predicate has to catch a redirect. Labelled as what it
  // actually is; the WITH CHECK path itself is exercised on INSERT by S2-DB-10 and S2-DB-15.
  const r = await refusal(() => asApp(CTX_TENANT_A, async (tx) => {
    await tx`update store set tenant_id = ${T_B} where store_id = ${S_A1}`;
  }));
  assert.equal(r.kind, 'privilege', `expected a column-privilege refusal, got ${r.kind}: ${r.msg}`);
  assert.equal(r.code, '42501');
  const [{ tenant_id: still }] = await observer`select tenant_id from store where store_id = ${S_A1}`;
  assert.equal(still, T_A, 'the store never moved tenant');
});

test('S2-DB-12: DELETE is refused — and it is a PRIVILEGE denial, which is the honest label', async () => {
  // The approved matrix grants no DELETE anywhere: tenant-scoped rows are retired by status.
  // So this is refused before RLS is ever consulted. Recording it as an "RLS denial" would be
  // false, and would hide the fact that the policies' DELETE path is currently unreachable.
  const r = await refusal(() => asApp(CTX_TENANT_A, async (tx) => {
    await tx`delete from store where store_id = ${S_A1}`;
  }));
  assert.equal(r.kind, 'privilege', `expected a privilege denial, got ${r.kind}: ${r.msg}`);
  assert.equal(r.code, '42501');
  const own = await refusal(() => asApp(CTX_TENANT_A, async (tx) => {
    await tx`delete from tenant where tenant_id = ${T_A}`;
  }));
  assert.equal(own.kind, 'privilege', 'even the context tenant cannot be deleted');
  const survivors = await observer`select store_id from store where store_id = ${S_A1}`;
  assert.equal(survivors.length, 1, 'nothing was deleted');
});

// ---------------------------------------------------------------------------
// negative controls — cross-STORE, inside one tenant
// ---------------------------------------------------------------------------

test('S2-DB-13: a tenant-scoped context is tenant-wide; a store-scoped context is one store', async () => {
  await asApp(CTX_TENANT_A, async (tx) => {
    const rows = await tx`select store_id from store order by store_id`;
    assert.equal(rows.length, 2, 'tenant scope reaches every store in the tenant');
  });
  await asApp(CTX_STORE_A1, async (tx) => {
    const rows = await tx`select store_id from store`;
    assert.deepEqual(rows.map((r) => r.store_id), [S_A1], 'store scope reaches exactly the selected store');
  });
});

test('S2-DB-14: store scope cannot read or mutate a SIBLING store in the same tenant', async () => {
  await asApp(CTX_STORE_A1, async (tx) => {
    const sibling = await tx`select store_id from store where store_id = ${S_A2}`;
    assert.deepEqual([...sibling], [], 'the sibling store in the SAME tenant must be invisible');

    const blind = await tx`update store set store_name = 'cross-store write' where store_id = ${S_A2}`;
    assert.equal(blind.count, 0, 'the sibling store must not be mutable');

    const memberships = await tx`select membership_id, store_id from user_membership order by membership_id`;
    // `[].every(...)` is true, so the anchor matters: without it this assertion would pass just
    // as happily if the policy denied EVERYTHING, proving nothing about store scoping.
    assert.equal(memberships.length, 1, 'exactly the one store-A1 grant is visible');
    assert.ok(memberships.every((m) => m.store_id === S_A1),
      "store scope must not see the sibling store's grants or the tenant-wide grant");
  });
  const [{ store_name: name }] = await observer`select store_name from store where store_id = ${S_A2}`;
  assert.equal(name, 'Tenant A / Store 2', 'the sibling store is untouched');
});

test('S2-DB-15: a store-scoped INSERT cannot place a row in a sibling store', async () => {
  const r = await refusal(() => asApp(CTX_STORE_A1, async (tx) => {
    await tx`insert into store (store_id, tenant_id, store_name)
             values ('a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a4a4', ${T_A}, 'wrong store scope')`;
  }));
  // The new row's store_id is its own, which is not the context store, so WITH CHECK refuses.
  assert.equal(r.kind, 'rls', `expected WITH CHECK to refuse, got ${r.kind}: ${r.msg}`);
  const leaked = await observer`select store_id from store where store_name = 'wrong store scope'`;
  assert.deepEqual([...leaked], []);
});

// ---------------------------------------------------------------------------
// context: absent, transaction-local, non-inheritable
// ---------------------------------------------------------------------------

test('S2-DB-16: with NO context installed, every tenant-scoped table denies by default', async () => {
  // Deliberately NOT via withTenantContext: this is the "someone forgot" path.
  const rows = await appProbe`select store_id from store`;
  assert.deepEqual([...rows], [], 'absent context must deny reads');
  const t = await appProbe`select tenant_id from tenant`;
  assert.deepEqual([...t], [], 'absent context must deny reads');
  const m = await appProbe`select membership_id from user_membership`;
  assert.deepEqual([...m], [], 'absent context must deny reads');
  const e = await appProbe`select entitlement_id from tenant_feature_entitlement`;
  assert.deepEqual([...e], [], 'absent context must deny reads');

  const r = await refusal(async () => {
    await appProbe`insert into store (store_id, tenant_id, store_name)
                   values ('a5a5a5a5-a5a5-4a5a-8a5a-a5a5a5a5a5a5', ${T_A}, 'no context')`;
  });
  assert.equal(r.kind, 'rls', `absent context must deny writes, got ${r.kind}: ${r.msg}`);
});

test('S2-DB-17: a PARTIAL context (tenant set, scope_type absent) still denies', async () => {
  // Proves the predicate is a conjunction, not a single check that a tenant id is present.
  await appProbe.begin(async (tx) => {
    await tx`select set_config(${CONTEXT_SETTINGS.tenantId}, ${T_A}, true)`;
    const rows = await tx`select store_id from store`;
    assert.deepEqual([...rows], [], 'a tenant id without a scope_type must not open anything');
  });
});

test('S2-DB-18: context is transaction-local — gone after COMMIT and after ROLLBACK, same backend', async () => {
  const pids = [];
  await asApp(CTX_TENANT_A, async (tx) => {
    const ctx = await readTenantContext(tx);
    assert.deepEqual(ctx, { scopeType: 'tenant', tenantId: T_A, storeId: null }, 'context is installed inside the tx');
    const [{ pid }] = await tx`select pg_backend_pid() as pid`;
    pids.push(pid);
  });

  // After COMMIT, on the SAME pooled backend.
  await appProbe.begin(async (tx) => {
    const [{ pid }] = await tx`select pg_backend_pid() as pid`;
    pids.push(pid);
    assert.equal(await readTenantContext(tx), null, 'a committed transaction leaves no context behind');
    const rows = await tx`select store_id from store`;
    assert.deepEqual([...rows], [], 'and the policies deny again');
  });

  // Now a transaction that ROLLS BACK with a context installed.
  const rolled = await refusal(() => asApp(CTX_TENANT_A, async (tx) => {
    const [{ pid }] = await tx`select pg_backend_pid() as pid`;
    pids.push(pid);
    throw new Error('deliberate rollback');
  }));
  assert.equal(rolled.kind, 'other', 'the deliberate rollback really propagated');

  await appProbe.begin(async (tx) => {
    const [{ pid }] = await tx`select pg_backend_pid() as pid`;
    pids.push(pid);
    assert.equal(await readTenantContext(tx), null, 'a rolled-back transaction leaves no context behind');
  });

  assert.equal(pids.length, 4);
  assert.equal(new Set(pids).size, 1,
    `all four transactions must share ONE backend for this to prove anything (saw ${new Set(pids).size})`);
});

test('S2-DB-19: an independent connection starts with no context of its own', async () => {
  // NOTE ON WHAT THIS DOES AND DOES NOT PROVE. `fresh` is a SEPARATE client, so it gets a
  // different backend, and session-local state never crosses backends in PostgreSQL — this
  // case would pass even if the context leaked. The load-bearing leakage proof is S2-DB-18,
  // which reuses ONE backend (max:1) across four transactions and asserts a single pid. This
  // test covers the weaker, still-worth-stating property: a second connection is not seeded
  // with someone else's scope.
  await asApp(CTX_STORE_A1, async (tx) => {
    assert.equal((await readTenantContext(tx)).storeId, S_A1);
  });
  const fresh = probeClient(APP_PROBE);
  try {
    await fresh.begin(async (tx) => {
      assert.equal(await readTenantContext(tx), null, 'a separate connection starts with no context');
      const rows = await tx`select store_id from store`;
      assert.deepEqual([...rows], [], 'and therefore sees nothing');
    });
  } finally {
    await fresh.end({ timeout: 0 }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// the runtime role's hard limits
// ---------------------------------------------------------------------------

test('S2-DB-20: the runtime role cannot CREATE objects or perform DDL', async () => {
  for (const stmt of [
    'create table probe_should_not_exist (id int)',
    'create index probe_idx on store (store_name)',
    'alter table store add column probe_column text',
    'drop table store',
  ]) {
    const r = await refusal(() => appProbe.unsafe(stmt));
    assert.notEqual(r.kind, 'none', `DDL must not succeed: ${stmt}`);
    assert.equal(r.code, '42501', `DDL must be refused for privilege reasons: ${stmt} -> ${r.code} ${r.msg}`);
  }
  const [{ present }] = await observer`select to_regclass('public.probe_should_not_exist') is not null as present`;
  assert.equal(present, false, 'no object was created');
  const [{ cols }] = await observer`select count(*)::int as cols from information_schema.columns
                                    where table_name = 'store' and column_name = 'probe_column'`;
  assert.equal(cols, 0, 'no column was added');

  // HONEST LIMIT, asserted rather than glossed: revoking CREATE on schema public does NOT stop
  // CREATE TEMPORARY TABLE, because that rides on the database-level TEMPORARY privilege which
  // PostgreSQL grants to PUBLIC. So the guarantee is "no PERSISTENT object", not "no object".
  // The residual is bounded: a temp table lives in a session-local schema, it cannot shadow a
  // protected relation for anyone else, and 001-005 create no SECURITY DEFINER function whose
  // search_path such a table could subvert. Recorded here so the claim matches reality.
  const temp = await refusal(() => appProbe.unsafe('create temporary table probe_temp (id int)'));
  assert.equal(temp.kind, 'none', 'a temp table IS creatable — the guarantee is about persistent objects');
  await appProbe.unsafe('drop table if exists probe_temp').catch(() => {});
  const [{ definers }] = await observer`select count(*)::int as definers from pg_catalog.pg_proc p
                                        join pg_catalog.pg_namespace n on n.oid = p.pronamespace
                                        where n.nspname = 'public' and p.prosecdef`;
  assert.equal(definers, 0, 'no SECURITY DEFINER function exists for a temp object to subvert');
});

test('S2-DB-21: the runtime role cannot bypass RLS, even by asking', async () => {
  const r = await refusal(async () => {
    await appProbe.begin(async (tx) => {
      await tx`set local row_security to off`;
      await tx`select store_id from store`;
    });
  });
  assert.notEqual(r.kind, 'none', 'turning RLS off must not silently work');
  assert.equal(r.code, '42501', `expected insufficient_privilege, got ${r.code}: ${r.msg}`);
});

test('S2-DB-22: the runtime role cannot reach platform_identity, app_user, or identity_link', async () => {
  for (const table of ['platform_identity', 'app_user', 'identity_link']) {
    const read = await refusal(() => appProbe.unsafe(`select 1 from ${table} limit 1`));
    assert.equal(read.kind, 'privilege',
      `${table} must be refused by PRIVILEGE, not merely filtered: ${read.kind} ${read.msg}`);
    const write = await refusal(() => appProbe.unsafe(`delete from ${table}`));
    assert.equal(write.kind, 'privilege', `${table} write must be refused by privilege`);
  }
  // The tenant runtime is also barred from the audit table entirely — the audit writer is a
  // SEPARATE principal precisely so a compromised request path cannot read the evidence.
  const audit = await refusal(() => appProbe`select 1 from audit_event limit 1`);
  assert.equal(audit.kind, 'privilege', 'the tenant runtime must not touch audit_event');
});

test('S2-DB-22b: the identity store is unreachable INDIRECTLY as well as directly', async () => {
  // Direct SELECT is the obvious case. The interesting one is reaching an ungranted table
  // THROUGH a granted one: a join or a subquery from user_membership, which the runtime
  // principal legitimately reads. PostgreSQL checks privileges per relation, so both must be
  // refused — but that has to be demonstrated, not assumed.
  // Each probe runs in its OWN transaction: a failed statement aborts its transaction, so
  // chaining them would report the second as a transaction-aborted error rather than a denial.
  const join = await refusal(() => asApp(CTX_TENANT_A, (tx) =>
    tx`select u.membership_id from user_membership u
       join app_user a on a.internal_user_id = u.internal_user_id`));
  assert.equal(join.kind, 'privilege', `a join into app_user must be refused: ${join.kind} ${join.msg}`);

  const sub = await refusal(() => asApp(CTX_TENANT_A, (tx) =>
    tx`select membership_id from user_membership
       where internal_user_id in (select internal_user_id from platform_identity)`));
  assert.equal(sub.kind, 'privilege', `a subquery into platform_identity must be refused: ${sub.kind} ${sub.msg}`);

  const linked = await refusal(() => asApp(CTX_TENANT_A, (tx) =>
    tx`select count(*)::int as n from identity_link where internal_user_id is not null`));
  assert.equal(linked.kind, 'privilege', 'even an aggregate over identity_link must be refused');
});

test('S2-DB-22c: a table created LATER is closed by default — the default privileges hold', async () => {
  // The contract test proves no ALTER DEFAULT PRIVILEGES pre-grants anything to a runtime role.
  // This proves the consequence on a real server: a table the owner adds after 005 is applied is
  // unreachable until a migration grants it deliberately.
  await observer.unsafe('create table public.s2_future_table (id uuid primary key, tenant_id uuid not null)');
  try {
    const read = await refusal(() => appProbe`select 1 from s2_future_table limit 1`);
    assert.equal(read.kind, 'privilege', `a future table must not be readable: ${read.kind} ${read.msg}`);
    const write = await refusal(() => appProbe`insert into s2_future_table (id, tenant_id)
                                               values (gen_random_uuid(), ${T_A})`);
    assert.equal(write.kind, 'privilege', 'nor writable');
    const auditRead = await refusal(() => auditProbe`select 1 from s2_future_table limit 1`);
    assert.equal(auditRead.kind, 'privilege', 'nor reachable by the audit writer');

    // And nothing was granted to PUBLIC, anon or authenticated either.
    const [{ acl }] = await observer`select coalesce(relacl::text, '') as acl
                                     from pg_catalog.pg_class where relname = 's2_future_table'`;
    for (const role of [RUNTIME_ROLE, AUDIT_ROLE, 'anon', 'authenticated']) {
      assert.ok(!acl.includes(`${role}=`), `${role} must not appear in the new table's ACL: ${acl}`);
    }
  } finally {
    await observer.unsafe('drop table if exists public.s2_future_table');
  }
});

// ---------------------------------------------------------------------------
// the audit writer
// ---------------------------------------------------------------------------

const auditRow = (over = {}) => ({
  request_id: 'rls-fixture-request',
  scope_type: 'tenant',
  tenant_id: T_A,
  store_id: null,
  action_id: 'fixture.action',
  required_permission: 'fixture.permission',
  decision: 'deny',
  reason_code: 'fixture_denied',
  human_readable_reason: 'fixture denial recorded by the audit writer',
  result_status: 'failed',
  source_of_truth: 'fixture',
  evaluated_by: 'fixture',
  evidence_level: 'durable_compliance_event',
  ...over,
});

test('S2-DB-23: the audit writer can APPEND, including a denial for a tenant it cannot read', async () => {
  // The point of a context-independent policy: recording that tenant B was denied must work
  // from a session whose context is tenant A, or the most security-relevant events are the only
  // ones that cannot be written.
  await asAuditWriter(CTX_TENANT_A, async (tx) => {
    const own = auditRow();
    const r1 = await tx`insert into audit_event ${tx(own, ...Object.keys(own))}`;
    assert.equal(r1.count, 1, 'an in-context audit append must succeed');
    const foreign = auditRow({ tenant_id: T_B, reason_code: 'cross_scope_attempt' });
    const r2 = await tx`insert into audit_event ${tx(foreign, ...Object.keys(foreign))}`;
    assert.equal(r2.count, 1, 'a denial concerning ANOTHER tenant must still be recordable');
  });
  const rows = await observer`select tenant_id, reason_code from audit_event order by reason_code`;
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.reason_code), ['cross_scope_attempt', 'fixture_denied']);
});

test('S2-DB-24: the audit writer can only append — SELECT, UPDATE and DELETE are refused', async () => {
  // Counted RELATIVE to the row set this test finds, not against an absolute number: an
  // absolute count silently couples this case to whichever earlier test happened to insert.
  const [{ n: before }] = await observer`select count(*)::int as n from audit_event`;
  for (const [label, stmt] of [
    ['select', 'select 1 from audit_event limit 1'],
    ['update', "update audit_event set reason_code = 'tampered'"],
    ['delete', 'delete from audit_event'],
  ]) {
    const r = await refusal(() => auditProbe.unsafe(stmt));
    assert.equal(r.kind, 'privilege', `audit ${label} must be refused by privilege: ${r.kind} ${r.msg}`);
    assert.equal(r.code, '42501');
  }
  const [{ n: after }] = await observer`select count(*)::int as n from audit_event`;
  assert.equal(after, before, 'the evidence is intact — nothing was amended or erased');
  const tampered = await observer`select count(*)::int as n from audit_event where reason_code = 'tampered'`;
  assert.equal(tampered[0].n, 0, 'and no row was rewritten');
});

test('S2-DB-25: the audit policy refuses an advisory dev-sidecar record', async () => {
  const r = await refusal(() => asAuditWriter(CTX_TENANT_A, async (tx) => {
    const row = auditRow({ evidence_level: 'dev_sidecar_log_advisory', reason_code: 'advisory' });
    await tx`insert into audit_event ${tx(row, ...Object.keys(row))}`;
  }));
  assert.equal(r.kind, 'rls', `expected the WITH CHECK to refuse, got ${r.kind}: ${r.msg}`);
});

test('S2-DB-26: the scope-consistency constraint rejects every malformed scope tuple', async () => {
  // Asserted through the OWNER, so it is the CHECK CONSTRAINT under test and not the policy —
  // the constraint must bind every writer, including the one that bypasses RLS.
  const MALFORMED = [
    ['tenant scope with no tenant', { scope_type: 'tenant', tenant_id: null, store_id: null }],
    ['tenant scope carrying a store', { scope_type: 'tenant', tenant_id: T_A, store_id: S_A1 }],
    ['store scope with no store', { scope_type: 'store', tenant_id: T_A, store_id: null }],
    ['store scope with no tenant', { scope_type: 'store', tenant_id: null, store_id: S_A1 }],
    ['platform scope carrying a tenant', { scope_type: 'platform', tenant_id: T_A, store_id: null }],
    ['none scope carrying a store', { scope_type: 'none', tenant_id: T_A, store_id: S_A1 }],
  ];
  for (const [label, over] of MALFORMED) {
    const row = auditRow(over);
    const r = await refusal(() => observer`insert into audit_event ${observer(row, ...Object.keys(row))}`);
    assert.equal(r.kind, 'constraint', `${label} must be rejected by the constraint: ${r.kind} ${r.msg}`);
    assert.ok(r.msg.includes('audit_event_scope_consistency_chk'), `wrong constraint fired for ${label}: ${r.msg}`);
  }
  // And the well-formed shapes are all accepted, so the constraint is not simply "reject all".
  for (const over of [
    { scope_type: 'platform', tenant_id: null, store_id: null },
    { scope_type: 'none', tenant_id: null, store_id: null },
    { scope_type: 'store', tenant_id: T_A, store_id: S_A1 },
  ]) {
    const row = auditRow({ ...over, reason_code: `wellformed_${over.scope_type}` });
    const r = await refusal(() => observer`insert into audit_event ${observer(row, ...Object.keys(row))}`);
    assert.equal(r.kind, 'none', `a well-formed ${over.scope_type} event must be accepted: ${r.msg}`);
  }
});

test('S2-DB-27: the 002 append-only guarantee is still effective, for the owner too', async () => {
  const upd = await refusal(() => observer`update audit_event set reason_code = 'tampered'`);
  assert.equal(upd.kind, 'append_only', `expected the append-only trigger, got ${upd.kind}: ${upd.msg}`);
  const del = await refusal(() => observer`delete from audit_event`);
  assert.equal(del.kind, 'append_only', `expected the append-only trigger, got ${del.kind}: ${del.msg}`);
});

// ---------------------------------------------------------------------------
// down / up
// ---------------------------------------------------------------------------

test('S2-DB-28: the 005 rollback removes every S2-owned object and NOTHING from 001-004', async () => {
  // Counted RELATIVE to whatever audit rows exist when this test starts, so the assertion does
  // not silently depend on which earlier tests ran.
  const [{ n: auditBefore }] = await observer`select count(*)::int as n from audit_event`;
  assert.ok(auditBefore > 0, 'precondition: there is audit evidence to preserve');

  // The down migration documents its precondition: a LOGIN role holding membership must be
  // retired first, or DROP ROLE fails loudly. This follows that documented procedure.
  await observer.unsafe(`revoke ${RUNTIME_ROLE} from ${APP_PROBE}`);
  await observer.unsafe(`revoke ${AUDIT_ROLE} from ${AUDIT_PROBE}`);

  await observer.unsafe(DOWN_005).simple();

  const roles = await observer`select rolname from pg_catalog.pg_roles where rolname in (${RUNTIME_ROLE}, ${AUDIT_ROLE})`;
  assert.deepEqual([...roles], [], 'both privilege roles are gone');
  const policies = await observer`select policyname from pg_catalog.pg_policies where schemaname = 'public'`;
  assert.deepEqual([...policies], [], 'every S2 policy is gone');
  const constraints = await observer`
    select conname from pg_catalog.pg_constraint where conname = 'audit_event_scope_consistency_chk'`;
  assert.deepEqual([...constraints], [], 'the S2 constraint is gone');

  // 001-004 survive intact.
  const tables = await observer`
    select tablename, rowsecurity from pg_catalog.pg_tables
    where schemaname = 'public' and tablename in
      ('platform_identity','app_user','tenant','store','user_membership','tenant_feature_entitlement','audit_event','identity_link')
    order by tablename`;
  assert.equal(tables.length, 8, 'all eight 001-004 tables still exist');
  assert.ok(tables.every((t) => t.rowsecurity === true), 'RLS stays enabled on every table');
  const [{ n: auditAfter }] = await observer`select count(*)::int as n from audit_event`;
  assert.equal(auditAfter, auditBefore, 'no audit evidence was destroyed by the rollback');
  const memberChk = await observer`
    select conname from pg_catalog.pg_constraint where conname = 'user_membership_scope_consistency_chk'`;
  assert.equal(memberChk.length, 1, 'the 002 scope constraint is untouched');
  // The platform_identity revocation is deliberately RETAINED — reversing it would re-open a
  // table to anon/authenticated, which is a regression rather than a rollback.
  const acl = await observer`select relacl::text as acl from pg_catalog.pg_class where relname = 'platform_identity'`;
  assert.ok(!/(^|,)anon=/.test(acl[0].acl ?? ''), 'anon must not regain access on rollback');
});

test('S2-DB-29: re-applying 005 restores the foundation deterministically', async () => {
  await observer.unsafe(UP_005).simple();

  const roles = await observer`
    select rolname, rolcanlogin, rolbypassrls from pg_catalog.pg_roles
    where rolname in (${RUNTIME_ROLE}, ${AUDIT_ROLE}) order by rolname`;
  assert.equal(roles.length, 2, 'both privilege roles are back');
  assert.ok(roles.every((r) => r.rolcanlogin === false && r.rolbypassrls === false), 'and still least-privileged');

  const policies = await observer`
    select policyname from pg_catalog.pg_policies where schemaname = 'public' order by policyname`;
  assert.deepEqual(policies.map((p) => p.policyname), [
    'tmpos_app_entitlement_scope',
    'tmpos_app_membership_scope',
    'tmpos_app_store_scope',
    'tmpos_app_tenant_scope',
    'tmpos_audit_writer_append',
  ]);
  const constraints = await observer`
    select conname from pg_catalog.pg_constraint where conname = 'audit_event_scope_consistency_chk'`;
  assert.equal(constraints.length, 1, 'the constraint is back');

  // Re-establish the probe membership and prove isolation still holds after the round trip.
  await observer.unsafe(`grant ${RUNTIME_ROLE} to ${APP_PROBE}`);
  await appProbe.end({ timeout: 0 }).catch(() => {});
  appProbe = probeClient(APP_PROBE);

  await asApp(CTX_TENANT_A, async (tx) => {
    const mine = await tx`select store_id from store order by store_id`;
    assert.equal(mine.length, 2, 'the restored policies still admit the in-scope stores');
    const theirs = await tx`select store_id from store where tenant_id = ${T_B}`;
    assert.deepEqual([...theirs], [], 'and still deny the cross-tenant read');
  });
});

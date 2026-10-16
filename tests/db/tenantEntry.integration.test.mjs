// M7A-CUSTOMERS-P2 — THE TENANT ENTRY, END TO END: startTenantEntry (server/entry/tenantEntry.ts) composing the tenant
// transaction root and the tenant session boundary alone, over REAL loopback HTTP and a disposable PostgreSQL, exactly as
// server/entry/tenantMain.ts would but for its construction — and M7TE-C1 runs the COMPILED entry (tsconfig.server.tenant.json)
// the same way.
//
// WHAT IS SUBSTITUTED, STATED EXACTLY. Three things, none of them on the path under test (as the administrative suite,
// tests/db/productionEntry.integration.test.mjs):
//   * THE DATABASE CLIENT. `construction.databaseClient` ignores the classified endpoint it is handed and returns instead a
//     supervised kernel over the disposable cluster, as a non-owner least-privilege runtime LOGIN (tmpos_m7te_probe, holding
//     tmpos_app and tmpos_audit_writer and nothing else), through a byte relay so the store can be taken down.
//   * THE IDENTITY VERIFIER. `construction.tokenVerifier` is a synthetic bearer-token map: a known token answers
//     { uid, authTime: now, secondFactor: 'totp' }, an unknown one throws.
//   * THE LISTENER. `construction.listen` always binds 127.0.0.1:0, whatever PORT names.
// The owner installs the tenant issuer key (migration 018) — 32 bytes made in this process, never written anywhere — and the
// entry is configured with its base64url. Everything else — configuration, composition, the startup preflight (connect, the
// login, the ledger, parameter logging, the issuer key, the limiter key), the route table, the host lock, the session and
// authorization chain, the customer read, readiness and shutdown — is production's own code, unmodified. The hosts are
// synthetic (tenant.tmpos.test, admin.tmpos.test) and nothing leaves the loopback interface.
//
// DISPOSABLE ONLY. The target is the harness's resolved target: a supplied CI service when one is bound, otherwise a cluster this file creates and
// destroys; assertDisposableTestDsn refuses anything else before a statement runs. On a shared service it removes its own
// customer, session and mint-ledger rows, restores the limiter's fingerprint, the issuer key row it found (or its absence)
// and every grant, ledger row and setting a test changes, and drops its login. What it leaves is what every suite leaves:
// its synthetically named identities, tenants and store, and the approved PUBLIC revokes every suite establishes.
//
// M7A-CUSTOMERS-P3 UPDATE. The entry now also serves POST /api/v1/customers (tests/db/customerCreate.integration.test.mjs
// proves it end to end), so it requires its own IDEMPOTENCY_KEY — present, canonical, never the limiter's or the issuer's
// key — and readiness also asks the tenant store's probe. M7TE-01 pins the seven-route table, M7TE-07 the key's three
// refusals, M7TE-08 the create's EXECUTE at startup, M7TE-11 the store probe after it, and M7TE-C1 has the COMPILED entry
// create one customer while the administrative inventory stays its eight routes.
//
// M7A-CUSTOMERS-P3-R1 UPDATE. The entry also serves PUT /api/v1/roles/levels, the owner's durable Customers-level edit
// (tests/db/roleLevels.integration.test.mjs proves it end to end), and its tenant route authorizer reads migration 020's
// role levels. The chain is 001-020: M7TE-01 pins the route table (nine since M7A-CUSTOMERS-P3-R2: the levels' read-back),
// M7TE-08 the login's EXECUTE on 020's page_v3, create, level read and level set at startup — and refuses 019's create or
// 018's page_v2 given back —, M7TE-10 the 001-020 ledger (a fake next row is '021'), and M7TE-11 withdraws page_v3 after
// startup.
//
// M7A-CUSTOMERS-P4 UPDATE. The owner's edit is conditional on the tenant and version the owner reviewed (DA-125): migration
// 021's schema tmpos_role_edit holds the set the runtime calls and the one-snapshot read-back, and 021 revokes 020's
// unconditional set from the runtime role. The chain is 001-021: M7TE-08 requires the login's EXECUTE on 021's set and read
// instead of 020's set — and refuses 020's set given back —, and M7TE-10 pins the 001-021 ledger (a fake next row is '022').
//
// M7A-CUSTOMERS-P4 UPDATE (detail). The entry also serves GET /api/v1/customers/{id} over migration 022's session-bound
// routine (tests/db/customerDetail.integration.test.mjs proves the routine). The chain is 001-022: M7TE-01 pins ten routes,
// M7TE-08 the login's EXECUTE on 022's read, M7TE-10 the 001-022 ledger (a fake next row is '023'), M7TE-11 withdraws 022's
// read after startup, M7TE-14 drives the detail read end to end on the source entry — own 200, foreign and missing 404s
// alike, malformed ids 400 only after authentication, a narrowed role, a revoked and a parked-then-revoked session, the admin
// cookie, the wrong Host, the store down, a read-only tenant — and M7TE-C1 follows the compiled create's Location.
//
// M7A-CUSTOMERS-P6 UPDATE (contacts). Migration 023 adds phone, email and created_at to the customer table, its create
// (now the login's only create path: 023 revokes 020's) and its profile read, served as GET /api/v1/customers/{id}/profile
// (tests/db/customerContact.integration.test.mjs proves the routines). The chain is 001-023: M7TE-01 pins eleven routes,
// M7TE-08 the login's EXECUTE on 023's create and profile read and refuses 020's create given back, M7TE-10 the 001-023 ledger
// (a fake next row is '024'), M7TE-11 withdraws the profile read after startup, M7TE-15 drives a create with contacts and
// the profile read end to end on the source entry, and M7TE-C1 does both on the compiled entry.
//
// M7A-CUSTOMERS-P7 UPDATE (edits). Migration 024 adds the customer row version, the session-bound edit served as
// PATCH /api/v1/customers/{id} and a versioned profile read that replaces 023's for the login (024 revokes 023's)
// (tests/db/customerEdit.integration.test.mjs proves the routines). The chain is 001-024: M7TE-01 pins twelve routes, M7TE-04
// finds the PATCH template behind the session like the detail, M7TE-08 the login's EXECUTE on 024's edit and profile read and
// refuses 023's profile read given back, M7TE-10 the 001-024 ledger (a fake next row is '025'), and M7TE-11 withdraws 024's
// profile read after startup. This file edits no customer (024's rollback refuses while any customer is edited).
//
// M7A-CUSTOMERS-P8 UPDATE (name search). Migration 025 adds the session-bound name search the list asks for a `q`
// (tests/db/customerSearch.integration.test.mjs proves the routine and the HTTP search). The chain is 001-025: no route is
// added, M7TE-08 the login's EXECUTE on 025's search, and M7TE-10 the 001-026 ledger (a fake next row is '027').
//
// M5-INVOICES-AUTH-P1 UPDATE (Invoices role levels). Migration 026 stores the owner's Invoices level beside the Customers one
// (configuration only: no invoice operation is decided on it) and the entry serves its read-back, GET
// /api/v1/roles/levels/invoices (tests/db/invoiceRoleLevels.integration.test.mjs proves it over HTTP). The chain is 001-026:
// M7TE-01 pins thirteen routes and M7TE-10 the 001-026 ledger.
//
// M7B-INVOICES-P1 UPDATE (store discovery). Migration 027 adds the session-bound store directory and the entry serves
// GET /api/v1/stores (tests/db/storeAccess.integration.test.mjs proves the routine and the route over HTTP). The chain is
// 001-027: M7TE-01 pins fourteen routes and M7TE-10 the 001-027 ledger (a fake next row is '028').
//
// M7B-INVOICES-P1 UPDATE (invoice drafts). Migration 028 adds the store-owned invoice drafts and the entry serves their list,
// read and save (tests/db/invoiceDraftRoutine.integration.test.mjs and invoiceDraftsHttp.integration.test.mjs prove them).
// The chain is 001-028: M7TE-01 pins seventeen routes and M7TE-10 the 001-028 ledger (a fake next row is '029').
//
// M7B-INVOICES-P1-R2 UPDATE (draft creation eligibility). The entry also serves
// GET /api/v1/stores/{storeId}/invoice-drafts/eligibility, a bodiless session read with no migration
// (invoiceDraftsHttp.integration.test.mjs proves it over 028): M7TE-01 pins eighteen routes; the ledger is still 001-028.
//
// M7B-INVOICES-P2 UPDATE (draft edit). Migration 029 adds the draft edit routine: the ledger is 001-029, so M7TE-10 judges
// 029 as the newest row and its fake next row is '030'.
//
// M7B-INVOICES-P2-R1 UPDATE (Invoices authority guard). Migration 030 adds the guarded draft edit routine and the level
// guard trigger: the ledger is 001-030, so M7TE-10 judges 030 as the newest row and its fake next row is '031'.
//
// M7B-INVOICES-P1-R3 UPDATE (guarded draft save). Migration 031 adds the guarded draft save routine: the ledger is 001-031, so
// M7TE-10 judges 031 as the newest row and its fake next row is '032'.
//
// M7B-INVOICES-P1-R4 UPDATE (Customers authority of the guarded draft save). Migration 032 adds the version-3 save routine and the
// Customers level guard: the ledger is 001-032, so M7TE-10 judges 032 as the newest row and its fake next row is '033'.
//
// M7B-INVOICES-DISCARD-P1 UPDATE (draft discard). Migration 033 adds the open-only draft reads, the discard routine, the discarded
// status and two terminal-state triggers, in its own schema; the tenant entry serves two routes more (the discard POST and its
// bodiless eligibility GET: twenty-two): M7TE-01 pins twenty-two routes, the ledger is 001-033, so M7TE-10 judges 033 as the newest
// row and its fake next row is '034'.
//
// M7B-INVOICES-ISSUE-P1 UPDATE (invoice issuing). Migration 034 adds the issuing settings, the issued-invoice tables, the issue
// routine and the issued status, in its own schema; the tenant entry serves seven routes more (the issuing-settings read and write,
// the draft's issue eligibility, preview and issue, and the issued-invoice list and read: twenty-nine): M7TE-01 pins twenty-nine
// routes, the ledger is 001-034, so M7TE-10 judges 034 as the newest row and its fake next row is '035'.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import tls from 'node:tls';
import { generateKeyPairSync, randomBytes, randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { installTestIssuerKey, resolveDisposableTarget, testClient, testDriverVia, childEnv } from './localPostgres.harness.mjs';
import { assertDisposableTestDsn, createPostgresExecutor, runTrustedApply } from '../../server/platform-identity/migrationExecutor.ts';
import { createNodeFsPort } from '../../server/platform-identity/migrationEngine.ts';
import { runtimeClientOptions } from '../../server/platform-identity/db.ts';
import { createSupervisedPgClient, MAX_POOLS } from '../../server/persistence/supervisedPgClient.ts';
import { tenantMintProof } from '../../server/persistence/postgresSessionStore.ts';
import { rateLimitKeyFingerprint } from '../../server/persistence/postgresRateLimiter.ts';
import { startTenantEntry, TENANT_SHIPPING_ROUTES } from '../../server/entry/tenantEntry.ts';
import { SHIPPING_ROUTES } from '../../server/entry/productionEntry.ts';
import { principalKeyOf, SESSION_COOKIES, SESSION_CSRF_HEADER, SESSION_TTL } from '../../server/runtime/sessions.ts';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '../../server/runtime/requestSecurity.ts';
import { sessionPaths } from '../../server/runtime/routes.ts';
import { SECURITY_HEADERS, HSTS_HEADER } from '../../server/runtime/securityHeaders.ts';
import { CUSTOMER_DIRECTORY_PATH, decodeCustomerCursor, encodeCustomerCursor } from '../../server/runtime/customerDirectory.ts';

const MIG_REL = 'server/platform-identity/migrations';
const MIG_DIR = new URL(`../../${MIG_REL}/`, import.meta.url).pathname.replace(/\/$/, '');
const REPO = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const MIGRATOR = { purpose: 'migration', migratorRef: 'm7te-migrator', runtimeRef: 'm7te-runtime' };
const LOCK_KEY = 528_523;
const NOW = () => new Date().toISOString();
const SUFFIX = randomUUID().slice(0, 8);
const RUNTIME_LOGIN = 'tmpos_m7te_probe';
const TENANT_HOST = 'tenant.tmpos.test';
const TENANT_ORIGIN = `https://${TENANT_HOST}`;
const ADMIN_HOST = 'admin.tmpos.test';
const ADMIN_ORIGIN = `https://${ADMIN_HOST}`;
/** app.ts PROBE_REUSE_MS (1 s, not exported) and a margin: a readiness probe is reused for that long. */
const PROBE_REUSE_WAIT_MS = 1_100;
/** The customer read the login calls (M7A-CUSTOMERS-P3-R1): 020's page_v3 — 018's page_v2 is revoked from the login. */
const V3 = 'tmpos_role.m7a_customer_page_v3(text, uuid, integer)';
/** The routines the tenant entry's other readiness probes call as the login: 018's mint, 011's session read, 016's admission. */
const MINT = 'tmpos_mint.m7a_session_create(text, text, text, text, text, text, bigint, bigint, bigint, bigint, bigint, bytea)';
const SESSION_GET = 'tmpos_session.m5_session_get(text, bigint)';
const ADMIT = 'tmpos_session.m5_admit_tenant_session_v2(text, text)';
/**
 * The customer create — since M7A-CUSTOMERS-P3-R1 020's (019's is revoked from the login) —, 020's role-level read (the
 * tenant route authorizer's), 021's conditional set (the owner's edit) and one-snapshot states read (its read-back) — since
 * M7A-CUSTOMERS-P4, when 020's unconditional set left the login —, and 006's probe the tenant store answers readiness with
 * (its idempotency and command ports).
 */
/** The customer create the login calls: migration 023's since M7A-CUSTOMERS-P6, deciding through 020's create. */
const CREATE = 'tmpos_customer_contact.m7a_contact_create(text, uuid, text, text, text)';
/** 020's create: revoked from the login by 023, and a grant too many if given back. */
const CREATE_020 = 'tmpos_role.m7a_customer_create(text, uuid, text)';
/** The customer profile read the login calls: 024's versioned one since M7A-CUSTOMERS-P7 (023's was the P6 read). */
const PROFILE_GET = 'tmpos_customer_edit.m7a_customer_profile(text, uuid, uuid)';
/** 023's customer profile read: revoked from the login by 024, and a grant too many if given back. */
const PROFILE_023 = 'tmpos_customer_contact.m7a_contact_profile(text, uuid, uuid)';
/** 024's customer edit (M7A-CUSTOMERS-P7). */
const CUSTOMER_UPDATE = 'tmpos_customer_edit.m7a_customer_update(text, uuid, uuid, bigint, text, boolean, text, boolean, text)';
/** 025's customer name search (M7A-CUSTOMERS-P8). */
const CUSTOMER_SEARCH = 'tmpos_customer_search.m7a_customer_search(text, uuid, text, uuid, integer)';
const LEVELS_READ = 'tmpos_role.m7a_role_levels(uuid, text)';
const LEVEL_SET = 'tmpos_role_edit.m7a_role_level_set_v2(text, text, text, text, uuid, bigint)';
const LEVEL_STATES = 'tmpos_role_edit.m7a_role_level_states(uuid)';
/** 020's unconditional set: revoked from the login by 021, and a grant too many if given back. */
const LEVEL_SET_020 = 'tmpos_role.m7a_role_level_set(text, text, text, text)';
const STORE_PROBE = 'tmpos_internal.m6_store_probe()';
/** 022's customer detail read (M7A-CUSTOMERS-P4). */
const DETAIL_GET = 'tmpos_customer_detail.m7a_customer_get(text, uuid, uuid)';

// ---------------------------------------------------------------------------
// cluster lifecycle (mirrors tests/db/productionEntry.integration.test.mjs)
// ---------------------------------------------------------------------------

const TARGET = resolveDisposableTarget('M7TE');
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

/** The owner: applies the migrations, creates the runtime login and writes/observes fixtures. RLS does not restrict it. */
const owner = testClient(TARGET, { max: 3, onnotice: () => {} });

const DROP_RUNTIME_LOGIN = `do $$ begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = '${RUNTIME_LOGIN}') then
    perform pg_catalog.pg_terminate_backend(pid) from pg_catalog.pg_stat_activity where usename = '${RUNTIME_LOGIN}';
    drop owned by ${RUNTIME_LOGIN};
    drop role ${RUNTIME_LOGIN};
  end if;
end $$;`;

/** Every provider reference, tenant and session store key this suite creates: what teardown removes rows of. */
const UIDS = [];
const TENANTS = [];
const KEYS = new Set();
/** The registered rate-limit key fingerprint before this suite touched it: undefined until taken, then the row or null. */
let rateLimitFingerprintBefore;
async function fingerprintRow() {
  const rows = await owner`select singleton, fingerprint, registered_at::text as registered_at from tmpos_rate_limit.key_fingerprint where singleton`;
  return rows.length === 0 ? null : { singleton: rows[0].singleton, fingerprint: Buffer.from(rows[0].fingerprint), registered_at: rows[0].registered_at };
}
/** The tenant issuer key row before this suite installed its own: undefined until taken, then its bytes or null. Never printed. */
let issuerKeyBefore;
async function issuerKeyRow() {
  const rows = await owner`select key from tmpos_mint.issuer_key where singleton`;
  return rows.length === 0 ? null : Buffer.from(rows[0].key);
}
/** The fingerprint this suite registers (its RATE_LIMIT_KEY's), put back after each test that replaced it. */
const registerFingerprint = (key) => owner.begin(async (sql) => {
  await sql`delete from tmpos_rate_limit.key_fingerprint`;
  await sql`insert into tmpos_rate_limit.key_fingerprint (singleton, fingerprint) values (true, ${rateLimitKeyFingerprint(key)})`;
});

async function teardown() {
  const failures = [];
  const step = async (fn) => { try { await fn(); } catch (err) { failures.push(err); } };
  try {
    // 016's up/down refuse while a tenant session exists, 017's down while a customer row does, 018's while a ledger row does.
    if (TENANTS.length > 0) await step(() => owner`delete from tmpos_customer.customer where tenant_id = any(${TENANTS}::uuid[])`);
    if (UIDS.length > 0) {
      await step(async () => {
        for (const row of await owner`select session_key from tmpos_session.session where auth_provider_uid = any(${UIDS}::text[])`) KEYS.add(row.session_key);
      });
    }
    if (KEYS.size > 0) await step(() => owner`delete from tmpos_mint.tenant_session where session_key = any(${[...KEYS]}::text[])`);
    if (UIDS.length > 0) await step(() => owner`delete from tmpos_session.session where auth_provider_uid = any(${UIDS}::text[])`);
    await step(() => owner.unsafe(DROP_RUNTIME_LOGIN));
    if (rateLimitFingerprintBefore !== undefined) {
      await step(async () => {
        await owner.begin(async (sql) => {
          await sql`delete from tmpos_rate_limit.key_fingerprint where singleton`;
          if (rateLimitFingerprintBefore !== null) {
            await sql`insert into tmpos_rate_limit.key_fingerprint (singleton, fingerprint, registered_at)
              values (${rateLimitFingerprintBefore.singleton}, ${rateLimitFingerprintBefore.fingerprint}, ${rateLimitFingerprintBefore.registered_at}::text::timestamptz)`;
          }
        });
        assert.deepEqual(await fingerprintRow(), rateLimitFingerprintBefore);
      });
    }
    if (issuerKeyBefore !== undefined) {
      await step(async () => {
        await owner.begin(async (sql) => {
          await sql`delete from tmpos_mint.issuer_key where singleton`;
          if (issuerKeyBefore !== null) await sql`insert into tmpos_mint.issuer_key (singleton, key) values (true, ${issuerKeyBefore})`;
        });
        const after = await issuerKeyRow();
        // Compared, never printed: the message names no byte of either key.
        assert.ok(after === null ? issuerKeyBefore === null : issuerKeyBefore !== null && after.equals(issuerKeyBefore),
          'the issuer key row this suite found is restored exactly');
      });
    }
  } finally {
    await step(() => owner.end({ timeout: 5 }));
    if (cluster) cluster.stop();
  }
  if (failures.length > 0) throw new AggregateError(failures, 'M7TE teardown: a cleanup step failed');
}
test.after(teardown);

async function setupStep(fn) {
  try {
    return await fn();
  } catch (err) {
    await teardown().catch((cleanup) => { throw new AggregateError([err, cleanup], 'M7TE setup failed, and so did its teardown'); });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// the byte relay: a construction's only way to the cluster, so the store can be taken down
// ---------------------------------------------------------------------------

function startRelay() {
  const upstream = TARGET.hostKind === 'unix_socket'
    ? { path: join(TARGET.host, `.s.PGSQL.${TARGET.port}`) }
    : { host: TARGET.host, port: TARGET.port };
  const dir = mkdtempSync(join(tmpdir(), 'tmpos-m7te-relay-'));
  const pairs = new Set();
  const state = { closes: 0, pairs };
  const server = net.createServer((client) => {
    client.on('error', () => {});
    const db = net.connect(upstream);
    const pair = { cut: () => { pairs.delete(pair); client.destroy(); db.destroy(); } };
    pairs.add(pair);
    client.pipe(db);
    db.pipe(client);
    for (const socket of [client, db]) {
      socket.on('error', pair.cut);
      socket.on('close', pair.cut);
    }
  });
  const path = join(dir, '.s.PGSQL.5432');
  const listen = () => new Promise((done) => server.listen(path, done));
  const refuse = () => (server.listening ? new Promise((done) => server.close(done)) : Promise.resolve());
  return {
    dir,
    listening: listen(),
    state,
    refuse,
    restore: async () => { if (!server.listening) await listen(); },
    async close() {
      const drained = refuse();
      for (const pair of [...pairs]) pair.cut();
      await drained;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** End every runtime-login backend, so the kernel's next transaction opens a new session (and reads new role settings). */
async function endLoginSessions() {
  await owner`select pg_catalog.pg_terminate_backend(pid) from pg_catalog.pg_stat_activity where usename = ${RUNTIME_LOGIN}`;
}

/** Take the store down the way a server does: refuse new connections and end every runtime session. */
async function storeDown(relay) {
  const open = relay.state.pairs.size;
  const closedBefore = relay.state.closes;
  const drained = relay.refuse();
  await endLoginSessions();
  const deadline = Date.now() + 5_000;
  while (relay.state.closes - closedBefore < open) {
    if (Date.now() > deadline) throw new Error('the runtime sessions did not end within 5 s');
    await delay(5);
  }
  await drained;
}

/**
 * A production-shaped database client factory bound to one relay, from `kernelModule`; the classified endpoint is ignored.
 * The driver dials the relay's socket through the harness (testDriverVia); the relay forwards only to TARGET.
 */
function databaseClientOver(relay, kernelModule = { createSupervisedPgClient, MAX_POOLS, runtimeClientOptions }) {
  return (_endpoint) => kernelModule.createSupervisedPgClient(testDriverVia(TARGET, relay.dir), driverDsn(TARGET_DSN, RUNTIME_LOGIN), {
    ...kernelModule.runtimeClientOptions(TARGET_DSN), ssl: false, max: kernelModule.MAX_POOLS, idle_timeout: 0,
    onclose: () => { relay.state.closes += 1; },
    user: RUNTIME_LOGIN,
  });
}

// ---------------------------------------------------------------------------
// setup: real migrations 001-021, a real non-owner least-privilege runtime login, the issuer key and the limiter key
// ---------------------------------------------------------------------------

await setupStep(async () => {
  await owner.unsafe(`do $$ begin
    if not exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then create role anon nologin; end if;
    if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  end $$;`);
  await owner.unsafe(`revoke create on database "${DATABASE}" from public`);
  await owner.unsafe(`revoke temporary on database "${DATABASE}" from public`);
  const handle = await createPostgresExecutor(assertDisposableTestDsn(TARGET_DSN));
  try {
    const report = await runTrustedApply({
      fsPort: createNodeFsPort(MIG_DIR, MIG_REL), adapter: handle.adapter, ledger: handle.ledger, connectionMode: 'session',
      credential: MIGRATOR, lockKey: LOCK_KEY, now: NOW, deadlineMs: 180_000,
    });
    assert.equal(report.outcome, 'complete', JSON.stringify(report).slice(0, 400));
  } finally {
    await handle.dispose();
  }
});

await setupStep(async () => {
  await owner.unsafe(DROP_RUNTIME_LOGIN);
  await owner.unsafe(`create role ${RUNTIME_LOGIN} login nosuperuser nocreatedb nocreaterole noreplication nobypassrls inherit`);
  await owner.unsafe(`grant tmpos_app to ${RUNTIME_LOGIN}`);
  await owner.unsafe(`grant tmpos_audit_writer to ${RUNTIME_LOGIN}`);
  // G-DBROLE provisioning (not a migration): the ledger read the startup preflight requires of the runtime login.
  await owner.unsafe(`grant select on public.schema_migrations to ${RUNTIME_LOGIN}`);
});

/**
 * Made in this process, never written anywhere: the limiter's key, the tenant issuer key (a fresh key is not weak) and the
 * tenant entry's own command key (M7A-CUSTOMERS-P3), three distinct keys.
 */
const RATE_KEY = randomBytes(32);
const ISSUER_KEY = randomBytes(32);
const IDEMPOTENCY_KEY = randomBytes(32);

await setupStep(async () => {
  rateLimitFingerprintBefore = await fingerprintRow();
  await registerFingerprint(RATE_KEY);
  issuerKeyBefore = await issuerKeyRow();
  await installTestIssuerKey(owner, ISSUER_KEY);
});

// ---------------------------------------------------------------------------
// the synthetic identity provider and configuration every entry starts from
// ---------------------------------------------------------------------------

const TOKENS = new Map(); // bearer token -> { uid }
const VERIFIER = Object.freeze({
  async verify(token) {
    const rec = TOKENS.get(token);
    if (rec === undefined) {
      const err = new Error('unknown_token');
      err.code = 'auth/invalid-id-token';
      throw err;
    }
    return { uid: rec.uid, authTime: Math.floor(Date.now() / 1000), secondFactor: 'totp' };
  },
});

const { privateKey: FIREBASE_PRIVATE_KEY } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const FIREBASE_JSON = JSON.stringify({
  type: 'service_account',
  project_id: 'm7te-test-project',
  client_email: 'm7te-test@m7te-test-project.iam.gserviceaccount.com',
  private_key: FIREBASE_PRIVATE_KEY,
});

function baseEnv(overrides = {}) {
  const env = {
    NODE_ENV: 'production',
    PORT: '8443',
    APP_DATABASE_URL: 'postgres://tmpos_runtime:synthetic-pw@db.abcdefghijklmnop.supabase.co:5432/postgres',
    DATABASE_CA_CERT: tls.rootCertificates[0],
    RATE_LIMIT_KEY: RATE_KEY.toString('base64url'),
    TRUSTED_PROXY_CIDRS: '127.0.0.2/32',
    SESSION_ADMIN_ORIGINS: ADMIN_ORIGIN,
    SESSION_TENANT_ORIGINS: TENANT_ORIGIN,
    TENANT_SESSION_ISSUER_KEY: ISSUER_KEY.toString('base64url'),
    IDEMPOTENCY_KEY: IDEMPOTENCY_KEY.toString('base64url'),
    FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON: FIREBASE_JSON,
    ...overrides,
  };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
  return Object.freeze(env);
}

// ---------------------------------------------------------------------------
// small generic helpers
// ---------------------------------------------------------------------------

function waitFor(predicate, timeoutMs = 5_000, intervalMs = 10) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    (function tick() {
      if (predicate()) { resolve(); return; }
      if (Date.now() > deadline) { reject(new Error('timed out waiting for condition')); return; }
      setTimeout(tick, intervalMs);
    })();
  });
}

/** A random 127.x.y.z loopback source, never the trusted proxy and never the same twice within a run. */
function randomLoopback() {
  const b = randomBytes(3);
  return `127.${1 + (b[0] % 254)}.${b[1]}.${1 + (b[2] % 254)}`;
}

/** Every captured log line, across every test in this file — for the M7TE-11 check at the end. */
const ALL_LOG_LINES = [];
/** Every secret-shaped value the suite handles: none may reach a log line. */
const SECRETS = new Set();

function makeCapture() {
  const lines = [];
  const codes = [];
  const proc = new EventEmitter();
  const log = { log: (line) => { lines.push(line); ALL_LOG_LINES.push(line); } };
  const exit = (code) => { codes.push(code); };
  return { lines, codes, proc, log, exit };
}

function sendReq(port, method, path, headers = {}, localAddress, body) {
  const payload = body === undefined ? undefined : Buffer.from(body);
  const framed = { ...(method === 'GET' ? {} : { 'content-length': String(payload?.length ?? 0) }), ...headers };
  return new Promise((resolve, reject) => {
    const options = { host: '127.0.0.1', port, method, path, headers: framed, agent: false };
    if (localAddress) options.localAddress = localAddress;
    const request = http.request(options, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
    });
    request.on('error', reject);
    request.setTimeout(10_000, () => request.destroy(new Error(`no reply within 10 s: ${method} ${path}`)));
    request.end(payload);
  });
}

function parseHttpHead(raw) {
  const idx = raw.indexOf('\r\n\r\n');
  if (idx === -1) return null;
  const lines = raw.slice(0, idx).split('\r\n');
  const m = /^HTTP\/\d\.\d (\d{3})/.exec(lines[0] ?? '');
  if (m === null) return null;
  const headers = {};
  const setCookies = [];
  for (const line of lines.slice(1)) {
    const at = line.indexOf(':');
    if (at < 0) continue;
    const name = line.slice(0, at).trim().toLowerCase();
    const value = line.slice(at + 1).trim();
    if (name === 'set-cookie') setCookies.push(value); else headers[name] = value;
  }
  const bodyStart = idx + 4;
  const len = Number(headers['content-length'] ?? '0');
  if (raw.length - bodyStart < len) return null;
  return { status: Number(m[1]), headers, setCookies, body: raw.slice(bodyStart, bodyStart + len) };
}

/** A raw HTTP request over a fresh socket — the only way to send a duplicated or absent Host header. */
function rawRequest(port, text, { localAddress, timeoutMs = 4_000 } = {}) {
  return new Promise((resolve) => {
    const options = { port, host: '127.0.0.1' };
    if (localAddress) options.localAddress = localAddress;
    const socket = net.connect(options);
    let raw = '';
    let settled = false;
    const timer = setTimeout(() => finish(parseHttpHead(raw) ?? { status: 0, headers: {}, setCookies: [], body: raw }), timeoutMs);
    function finish(value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    }
    socket.on('connect', () => socket.write(text));
    socket.on('data', (chunk) => {
      raw += chunk.toString('latin1');
      const parsed = parseHttpHead(raw);
      if (parsed !== null) finish(parsed);
    });
    socket.on('error', () => finish({ status: 0, headers: {}, setCookies: [], body: '' }));
    socket.on('close', () => finish(parseHttpHead(raw) ?? { status: 0, headers: {}, setCookies: [], body: raw }));
  });
}

/** A refusal is the fixed `{ error, requestId }` and nothing else, and never sets a cookie. */
function assertRefusal(reply, status, error, label) {
  assert.equal(reply.status, status, `${label}: ${reply.body}`);
  const body = JSON.parse(reply.body);
  assert.deepEqual(Object.keys(body).sort(), ['error', 'requestId'], `${label}: ${reply.body}`);
  assert.equal(body.error, error, label);
  const cookies = reply.setCookies ?? reply.headers['set-cookie'];
  assert.ok(cookies === undefined || cookies.length === 0, `${label}: no Set-Cookie`);
}
const assertBounded404 = (reply, label) => assertRefusal(reply, 404, 'not_found', label);

/** The composed table in a canonical, order-independent form, for a deep-equal against TENANT_SHIPPING_ROUTES. */
function canonical(routes) {
  return [...routes].map((r) => `${r.method} ${r.path} ${r.access} ${r.body} ${r.idempotency}`).sort();
}

/** Wraps net.Server.prototype.listen so a real bind attempt is proven, not inferred; always restore. */
function spyOnBind() {
  const original = net.Server.prototype.listen;
  let attempts = 0;
  net.Server.prototype.listen = function spiedListen(...args) {
    attempts += 1;
    return original.apply(this, args);
  };
  return { count: () => attempts, restore: () => { net.Server.prototype.listen = original; } };
}

/** A built client whose end() is counted — `calls` when invoked, `completed` once it resolved. */
function recordingEnd(real, ends) {
  return {
    transaction: (...args) => real.transaction(...args),
    end: async () => { ends.calls += 1; await real.end(); ends.completed += 1; },
  };
}

async function ensureShutdown(cap) {
  if (cap.codes.length === 0) {
    cap.proc.emit('SIGTERM');
    await waitFor(() => cap.codes.length > 0, 5_000).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// fixtures — all written through the owner
// ---------------------------------------------------------------------------

async function actor(label, memberships, status = 'active') {
  const uid = `m7te-${label}-${SUFFIX}`;
  const [{ internal_user_id: id }] = await owner`
    insert into platform_identity (auth_provider, auth_provider_uid) values ('firebase', ${uid}) returning internal_user_id`;
  await owner`insert into app_user (internal_user_id, status) values (${id}, ${status})`;
  for (const m of memberships) {
    await owner`insert into user_membership (internal_user_id, tenant_id, store_id, scope_type, role_id, status)
      values (${id}, ${m.tenant ?? null}, ${m.store ?? null}, ${m.scope}, ${m.role}, 'active')`;
  }
  const token = `tok-${uid}`;
  TOKENS.set(token, { uid });
  UIDS.push(uid);
  SECRETS.add(token).add(uid).add(id);
  return { id, uid, token, principal: Object.freeze({ authProvider: 'firebase', authProviderUid: uid }) };
}
const tenantGrant = (tenant, role) => ({ scope: 'tenant', tenant, role });

async function newTenant(label, status = 'active') {
  const name = `m7te-${label}-${SUFFIX}`;
  const [{ tenant_id: id }] = await owner`insert into tenant (display_name, status) values (${name}, ${status}) returning tenant_id`;
  TENANTS.push(id);
  SECRETS.add(id).add(name);
  return id;
}

/** Insert customers for `tenant` as the owner. Answers [{ id, name }]; every id and name is a secret to the logs. */
async function seed(tenant, names) {
  const rows = names.map((name) => ({ customer_id: randomUUID(), tenant_id: tenant, name }));
  await owner`insert into tmpos_customer.customer ${owner(rows, 'customer_id', 'tenant_id', 'name')}`;
  for (const r of rows) SECRETS.add(r.customer_id).add(r.name);
  return rows.map((r) => ({ id: r.customer_id, name: r.name }));
}
/** The page order the contract promises: UTF-8 byte order of the name, then the uuid — computed here, not by the database. */
const byteOrder = (a, b) => Buffer.compare(Buffer.from(a.name, 'utf8'), Buffer.from(b.name, 'utf8')) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

const T_A = await setupStep(() => newTenant('a'));
const T_B = await setupStep(() => newTenant('b'));
const T_RO = await setupStep(() => newTenant('read-only', 'read_only'));
const STORE_A = await setupStep(async () =>
  (await owner`insert into store (tenant_id, store_name, status) values (${T_A}, ${`m7te-store-a-${SUFFIX}`}, 'active') returning store_id`)[0].store_id);
const SEED_A = (await setupStep(() => seed(T_A, [`Élan ${SUFFIX}`, `elan ${SUFFIX}`, `Same ${SUFFIX}`, `Same ${SUFFIX}`, `Ａcme ${SUFFIX}`,
  `\u{1F600} Smile ${SUFFIX}`, `Zed ${SUFFIX}`]))).sort(byteOrder);
const SEED_B = (await setupStep(() => seed(T_B, Array.from({ length: 60 }, (_, i) => `B ${String(i).padStart(3, '0')} ${SUFFIX}`)))).sort(byteOrder);
const SEED_RO = (await setupStep(() => seed(T_RO, [`Ro one ${SUFFIX}`, `Ro two ${SUFFIX}`]))).sort(byteOrder);

/** The store key of the session a cookie presents: the SHA-256 of its identifier, as the chain computes it. */
const keyOf = (cookie) => createHash('sha256').update(cookie.slice(cookie.indexOf('=') + 1)).digest('base64url');
/** Records a fresh sign-in's identifier, store key and mint proof (read back before any request touches the row) as secrets. */
async function noteSession(cookie) {
  const key = keyOf(cookie);
  KEYS.add(key);
  SECRETS.add(cookie.slice(cookie.indexOf('=') + 1)).add(key);
  const [row] = await owner`select audience, auth_provider, auth_provider_uid, principal_key, security_version, authenticated_at,
      created_at, last_seen_at, validated_at, expires_at from tmpos_session.session where session_key = ${key}`;
  assert.equal(row?.audience, 'tenant', 'the sign-in wrote one tenant session row');
  const proof = tenantMintProof(ISSUER_KEY, key, {
    audience: row.audience, authProvider: row.auth_provider, authProviderUid: row.auth_provider_uid, principalKey: row.principal_key,
    securityVersion: row.security_version, authenticatedAt: row.authenticated_at === null ? null : Number(row.authenticated_at),
    createdAt: Number(row.created_at), lastSeenAt: Number(row.last_seen_at), validatedAt: Number(row.validated_at),
  }, Number(row.expires_at));
  for (const encoding of ['hex', 'base64', 'base64url']) SECRETS.add(proof.toString(encoding));
}

/**
 * An administrative session row, live and well formed, minted as the runtime login through 018's admin branch (which takes
 * no proof, DA-37): the identifier a cookie would carry.
 */
async function adminSessionId(who) {
  const id = randomBytes(32).toString('base64url');
  const key = createHash('sha256').update(id).digest('base64url');
  KEYS.add(key);
  SECRETS.add(id).add(key);
  const runtime = testClient(TARGET, { user: RUNTIME_LOGIN, max: 1, onnotice: () => {} });
  try {
    const at = Date.now();
    const [{ outcome }] = await runtime`select tmpos_mint.m7a_session_create(${key}::text, 'admin'::text, 'firebase'::text,
      ${who.uid}::text, ${principalKeyOf(who.principal)}::text, 'm7te-admin'::text, ${at}::bigint, ${at}::bigint, ${at}::bigint,
      ${at}::bigint, ${at + SESSION_TTL.admin.absoluteMs}::bigint, null::bytea) as outcome`;
    assert.equal(outcome, 'created', 'an administrative row exists to be presented');
  } finally {
    await runtime.end({ timeout: 5 });
  }
  return id;
}

// ---------------------------------------------------------------------------
// the entry harness
// ---------------------------------------------------------------------------

/**
 * Start one tenant entry over its own relay — the source entry, or `start` (M7TE-C1's compiled one) — hand the test a bound
 * request surface, then stop it.
 */
async function withEntry(overrides, fn) {
  const relay = startRelay();
  await relay.listening;
  const clientAddress = randomLoopback();
  const cap = makeCapture();
  const ends = { calls: 0, completed: 0 };
  let built = 0;
  const buildClient = databaseClientOver(relay, overrides.kernelModule);
  const construction = {
    databaseClient: (endpoint) => { built += 1; return recordingEnd(buildClient(endpoint), ends); },
    tokenVerifier: VERIFIER,
    listen: () => ({ port: 0, host: '127.0.0.1' }),
  };
  const bindSpy = spyOnBind();
  let result;
  try {
    result = await (overrides.start ?? startTenantEntry)({
      env: baseEnv(overrides.env ?? {}), construction, proc: cap.proc, exit: cap.exit, log: cap.log,
    });
  } finally {
    bindSpy.restore();
  }
  const port = result.address?.port ?? null;
  const ctx = {
    result, cap, relay, ends, port, clientAddress, bindAttempts: bindSpy.count(), clientsBuilt: () => built,
    req: (method, path, headers = {}, body) => sendReq(port, method, path, { host: TENANT_HOST, ...headers }, clientAddress, body),
    raw: (text) => rawRequest(port, text, { localAddress: clientAddress }),
    login: (who, extra = {}) => sendReq(port, 'POST', sessionPaths('tenant').login, {
      host: TENANT_HOST, origin: TENANT_ORIGIN, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE,
      authorization: `Bearer ${who.token}`, ...extra,
    }, clientAddress),
  };
  try {
    return await fn(ctx);
  } finally {
    await ensureShutdown(cap);
    await relay.restore().catch(() => {});
    await relay.close().catch(() => {});
  }
}

/** The session CSRF token each sign-in answered, by cookie pair: a customer read names the session it presents (M7A-CUSTOMERS-P5-R1). */
const CSRF_OF = new Map();
const csrfOf = (cookie) => (CSRF_OF.has(cookie) ? { [SESSION_CSRF_HEADER]: CSRF_OF.get(cookie) } : {});

async function signIn(ctx, who) {
  const reply = await ctx.login(who);
  assert.equal(reply.status, 200, `login ${who.uid}: ${reply.body}`);
  const setCookie = (reply.headers['set-cookie'] ?? [''])[0];
  const cookie = setCookie.split('; ')[0];
  await noteSession(cookie);
  const csrf = JSON.parse(reply.body).csrfToken;
  SECRETS.add(csrf);
  CSRF_OF.set(cookie, csrf);
  return { cookie, setCookie, csrf };
}

const list = (ctx, cookie, query = '') => {
  for (const m of query.matchAll(/cursor=([^&]*)/g)) if (m[1].length >= 16) SECRETS.add(m[1]); // a cursor, not a malformed probe like 'abc'
  return ctx.req('GET', `${CUSTOMER_DIRECTORY_PATH}${query}`, cookie === null ? {} : { cookie, ...csrfOf(cookie) });
};

/** A page body: exactly { customers: [{ id, name }], nextCursor }. Answers it. */
function pageOf(reply, label) {
  assert.equal(reply.status, 200, `${label}: ${reply.body}`);
  const body = JSON.parse(reply.body);
  assert.deepEqual(Object.keys(body), ['customers', 'nextCursor'], label);
  for (const c of body.customers) assert.deepEqual(Object.keys(c), ['id', 'name'], label);
  if (body.nextCursor !== null) {
    SECRETS.add(body.nextCursor);
    assert.equal(decodeCustomerCursor(body.nextCursor), body.customers.at(-1).id, `${label}: the cursor names the last customer`);
  }
  return body;
}

/** Every page of a walk at `limit`, following nextCursor. */
async function walk(ctx, cookie, limit) {
  const pages = [];
  let query = `?limit=${limit}`;
  for (let guard = 0; guard < 100; guard++) {
    const body = pageOf(await list(ctx, cookie, query), `walk page ${pages.length + 1}`);
    pages.push(body.customers);
    if (body.nextCursor === null) return pages;
    query = `?limit=${limit}&cursor=${body.nextCursor}`;
  }
  throw new Error('walk did not end');
}

/** The refusal reason the runtime logged for one reply. */
function reasonOf(ctx, reply) {
  const lines = ctx.cap.lines.map((l) => { try { return JSON.parse(l); } catch { return {}; } })
    .filter((r) => r.event === 'request' && r.requestId === reply.headers['x-request-id']);
  assert.equal(lines.length, 1, 'exactly one log line for the request');
  return lines[0].reason ?? '-';
}

async function readinessUntil(ctx, status, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await ctx.req('GET', '/readiness')).status === status) return true;
    await delay(200);
  }
  return false;
}

/** Readiness stays `status` across three reuse windows: the dependency, not a transient reconnect, decides it. */
async function readinessHolds(ctx, status) {
  for (let i = 0; i < 3; i++) {
    await delay(PROBE_REUSE_WAIT_MS);
    assert.equal((await ctx.req('GET', '/readiness')).status, status, `readiness ${status} after ${i + 1} reuse window(s)`);
  }
}

/** `fn`'s ACL, one sorted line per entry: grantor, grantee (0 is PUBLIC), privilege and grant option. */
async function aclOf(fn) {
  const rows = await owner`select a.grantor::regrole::text as grantor, a.grantee::text as grantee, a.privilege_type as privilege,
      a.is_grantable as grantable
    from pg_catalog.pg_proc p cross join lateral pg_catalog.aclexplode(p.proacl) a where p.oid = pg_catalog.to_regprocedure(${fn})`;
  return rows.map((r) => `${r.grantor}>${r.grantee}:${r.privilege}:${r.grantable}`).sort();
}

/**
 * EXECUTE on `fn` withdrawn from tmpos_app while `work` runs, then granted back as the migration granted it — and the
 * routine's ACL proved exactly as found, whether or not `work` failed.
 */
async function withoutExecute(fn, work) {
  const before = await aclOf(fn);
  assert.ok(before.length > 0, `${fn}: an ACL to restore`);
  try {
    await owner.unsafe(`revoke execute on function ${fn} from tmpos_app`);
    await work();
  } finally {
    await owner.unsafe(`grant execute on function ${fn} to tmpos_app`);
    assert.deepEqual(await aclOf(fn), before, `${fn}: EXECUTE restored exactly`);
  }
}

/**
 * CX-T3: the tenant host in another letter case is the same authority — the runtime lowercases Host (app.ts) — so the login
 * and the read are served, with only the caller's `rows`; with a trailing dot it is another authority: the bounded 404, both.
 */
async function assertHostSpellings(ctx, who, rows, label) {
  const loginText = (host) => `POST ${sessionPaths('tenant').login} HTTP/1.1\r\nHost: ${host}\r\nOrigin: ${TENANT_ORIGIN}\r\n`
    + `Sec-Fetch-Site: same-origin\r\n${CSRF_HEADER}: ${CSRF_HEADER_VALUE}\r\nAuthorization: Bearer ${who.token}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`;
  const listText = (host, cookie, csrf) => `GET ${CUSTOMER_DIRECTORY_PATH} HTTP/1.1\r\nHost: ${host}\r\nCookie: ${cookie}\r\nX-TMPOS-Session-CSRF: ${csrf}\r\nConnection: close\r\n\r\n`;
  let cookie = null;
  let csrf = null;
  for (const host of [TENANT_HOST.toUpperCase(), 'Tenant.Tmpos.Test']) {
    const login = await ctx.raw(loginText(host));
    assert.equal(login.status, 200, `${label}: login on ${host}: ${login.body}`);
    cookie = login.setCookies[0].split('; ')[0];
    await noteSession(cookie);
    csrf = JSON.parse(login.body).csrfToken;
    SECRETS.add(csrf);
    const read = await ctx.raw(listText(host, cookie, csrf));
    assert.equal(read.status, 200, `${label}: read on ${host}: ${read.body}`);
    assert.deepEqual(JSON.parse(Buffer.from(read.body, 'latin1').toString('utf8')).customers, rows, `${label}: read on ${host}, only the caller's rows`);
  }
  assertBounded404(await ctx.raw(loginText(`${TENANT_HOST}.`)), `${label}: login on the tenant host with a trailing dot`);
  assertBounded404(await ctx.raw(listText(`${TENANT_HOST}.`, cookie, csrf)), `${label}: read on the tenant host with a trailing dot`);
}

/** A refused startup: its category and codes, no listener, exit 1 — and, when a client was built, that client ended. */
function assertRefused(ctx, failure, reasons, label) {
  assert.equal(ctx.result.outcome, 'refused', `${label}: ${JSON.stringify(ctx.result)}`);
  assert.equal(ctx.result.failure, failure, label);
  if (reasons !== undefined) assert.deepEqual([...ctx.result.reasons].sort(), [...reasons].sort(), label);
  assert.equal(ctx.result.address, null, label);
  assert.equal(ctx.bindAttempts, 0, `${label}: no real bind attempt`);
  assert.deepEqual(ctx.cap.codes, [1], `${label}: exit 1, once`);
  assert.ok(ctx.cap.lines.some((l) => { try { const r = JSON.parse(l); return r.event === 'startup_refused' && r.reason.startsWith(failure); } catch { return false; } }),
    `${label}: a startup_refused line names the category`);
  if (ctx.clientsBuilt() > 0) assert.deepEqual(ctx.ends, { calls: 1, completed: 1 }, `${label}: the refusal ended the entry's own client`);
}

// ===========================================================================
// Acceptance (3): only the tenant route, only on the tenant host, only for a valid tenant session
// ===========================================================================

test('M7TE-01: a valid configuration binds exactly one listener serving TENANT_SHIPPING_ROUTES; the probes answer on any host with HSTS and the baseline headers', async () => {
  await withEntry({}, async (ctx) => {
    assert.equal(ctx.result.outcome, 'listening', JSON.stringify(ctx.result));
    assert.equal(ctx.result.address.address, '127.0.0.1');
    assert.deepEqual(canonical(ctx.result.routes), canonical(TENANT_SHIPPING_ROUTES));
    // The table itself, pinned here rather than read from the module: the customer create (M7A-CUSTOMERS-P3) and the
    // owner's role-level edit (M7A-CUSTOMERS-P3-R1) are its two body-bearing, idempotent routes; the edit's read-back
    // (M7A-CUSTOMERS-P3-R2) is a bodiless session read, and so is its Invoices sibling (M5-INVOICES-AUTH-P1), and so is the
    // store directory (M7B-INVOICES-P1); the invoice drafts' save is a third body-bearing, idempotent route, their list and
    // read bodiless session reads (M7B-INVOICES-P1), and so is the save's creation eligibility (M7B-INVOICES-P1-R2); the draft
    // edit is a fourth body-bearing, idempotent route and its edit eligibility a bodiless session read (M7B-INVOICES-P2); the
    // draft discard is a fifth body-bearing, idempotent route and its discard eligibility a bodiless session read
    // (M7B-INVOICES-DISCARD-P1); the issuing settings' read and write, the draft's issue eligibility, preview and issue, and the issued
    // list and read are seven more routes (M7B-INVOICES-ISSUE-P1): twenty-nine routes.
    assert.deepEqual(canonical(ctx.result.routes), [
      // The seven M7B-INVOICES-ISSUE-P1 rows sit in canonical() sort order (the comparison sorts both sides, so the order here is not a shipping-order claim).
      'GET /api/v1/customers session none none',
      'GET /api/v1/customers/{id} session none none',
      'GET /api/v1/customers/{id}/profile session none none',
      'GET /api/v1/issuing-settings/{id} session none none',
      'GET /api/v1/roles/levels session none none',
      'GET /api/v1/roles/levels/invoices session none none',
      'GET /api/v1/session session none none',
      'GET /api/v1/stores session none none',
      'GET /api/v1/stores/{storeId}/invoice-drafts session none none',
      'GET /api/v1/stores/{storeId}/invoice-drafts/eligibility session none none',
      'GET /api/v1/stores/{storeId}/invoice-drafts/{id} session none none',
      'GET /api/v1/stores/{storeId}/invoice-drafts/{id}/discard-eligibility session none none',
      'GET /api/v1/stores/{storeId}/invoice-drafts/{id}/edit-eligibility session none none',
      'GET /api/v1/stores/{storeId}/invoice-drafts/{id}/issue-eligibility session none none',
      'GET /api/v1/stores/{storeId}/invoice-drafts/{id}/issue-preview session none none',
      'GET /api/v1/stores/{storeId}/invoices session none none',
      'GET /api/v1/stores/{storeId}/invoices/{id} session none none',
      'GET /health public none none',
      'GET /readiness public none none',
      'PATCH /api/v1/customers/{id} session json required',
      'PATCH /api/v1/stores/{storeId}/invoice-drafts/{id} session json required',
      'POST /api/v1/customers session json required',
      'POST /api/v1/session/login login none none',
      'POST /api/v1/session/logout session none none',
      'POST /api/v1/stores/{storeId}/invoice-drafts session json required',
      'POST /api/v1/stores/{storeId}/invoice-drafts/{id}/discard session json required',
      'POST /api/v1/stores/{storeId}/invoice-drafts/{id}/issue session json required',
      'PUT /api/v1/issuing-settings/{id} session json required',
      'PUT /api/v1/roles/levels session json required',
    ]);
    assert.equal(ctx.bindAttempts, 1, 'exactly one real bind attempt');
    assert.equal(ctx.clientsBuilt(), 1, 'one kernel');
    for (const host of [TENANT_HOST, ADMIN_HOST, 'foreign.test']) {
      const health = await ctx.req('GET', '/health', { host });
      assert.equal(health.status, 200, health.body);
      assert.deepEqual(JSON.parse(health.body), { status: 'alive' });
      const readiness = await ctx.req('GET', '/readiness', { host });
      assert.equal(readiness.status, 200, readiness.body);
      assert.deepEqual(JSON.parse(readiness.body), { status: 'ready' });
      assert.equal(health.headers['strict-transport-security'], HSTS_HEADER.value, host);
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) assert.equal(health.headers[name.toLowerCase()], value, `${name} on ${host}`);
    }
  });
});

test('M7TE-02: a tenant user logs in on the tenant host on a host-only cookie and reads only its own tenant\'s id/name rows, under the P1 paging and error contract', async () => {
  const aUser = await actor('m7te02-a', [tenantGrant(T_A, 'manager')]);
  const bUser = await actor('m7te02-b', [tenantGrant(T_B, 'sales_staff')]);
  await withEntry({}, async (ctx) => {
    const a = await signIn(ctx, aUser);
    assert.match(a.setCookie, /^__Host-tmpos_tenant_session=[^;]+; Path=\/; Max-Age=\d+; Secure; HttpOnly; SameSite=Strict$/);
    assert.doesNotMatch(a.setCookie.toLowerCase(), /domain=/);

    // Only A's customers, exactly, in UTF-8 byte order then id; one at a time and two at a time, nothing repeated or skipped.
    assert.deepEqual(pageOf(await list(ctx, a.cookie), 'A default'), { customers: SEED_A, nextCursor: null });
    assert.deepEqual((await walk(ctx, a.cookie, 1)).flat(), SEED_A, 'limit=1 walk');
    const pairs = await walk(ctx, a.cookie, 2);
    assert.deepEqual(pairs.map((p) => p.length), [2, 2, 2, 1]);
    assert.deepEqual(pairs.flat(), SEED_A, 'limit=2 walk');

    // B: default 50 then the rest; 100 accepted; B's session never sees A's rows, nor A's B's.
    const b = await signIn(ctx, bUser);
    const first = pageOf(await list(ctx, b.cookie), 'B default');
    assert.deepEqual(first.customers, SEED_B.slice(0, 50), 'default limit 50');
    const rest = pageOf(await list(ctx, b.cookie, `?cursor=${first.nextCursor}`), 'B rest');
    assert.deepEqual(rest, { customers: SEED_B.slice(50), nextCursor: null });
    assert.deepEqual(pageOf(await list(ctx, b.cookie, '?limit=100'), 'B 100').customers, SEED_B);
    const aIds = new Set(SEED_A.map((c) => c.id));
    assert.ok(first.customers.every((c) => !aIds.has(c.id)) && rest.customers.every((c) => !aIds.has(c.id)), 'B never sees A');

    // Every bad query is one 400; a cursor issued to B, presented by A, is the same 400 as a random one.
    for (const query of ['?limit=0', '?limit=101', '?limit=-1', '?limit=abc', '?limit=5&limit=5', `?tenant=${T_B}`, '?',
      `?cursor=${encodeCustomerCursor(SEED_A[0].id)}&cursor=${encodeCustomerCursor(SEED_A[0].id)}`, '?cursor=abc']) {
      assertRefusal(await list(ctx, a.cookie, query), 400, 'invalid_request', query);
    }
    const foreign = await list(ctx, a.cookie, `?cursor=${first.nextCursor}`);
    const random = await list(ctx, a.cookie, `?cursor=${encodeCustomerCursor(randomUUID())}`);
    assertRefusal(foreign, 400, 'invalid_request', 'B\'s cursor to A');
    assertRefusal(random, 400, 'invalid_request', 'random cursor');
    assert.equal(foreign.body.length, random.body.length, 'bodies of one length: only the request id differs');
    assert.deepEqual([reasonOf(ctx, foreign), reasonOf(ctx, random)], ['customer_directory_cursor_unknown', 'customer_directory_cursor_unknown']);
    for (const c of SEED_B) assert.ok(!foreign.body.includes(c.id) && !foreign.body.includes(c.name));
  });
});

test('M7TE-03: no session, a forged session, a store-only actor and an actor with two tenant grants are refused; a read-only tenant still reads; a platform-only or grantless user cannot log in on the tenant host', async () => {
  const storeOnly = await actor('m7te03-store', [{ scope: 'store', tenant: T_A, store: STORE_A, role: 'manager' }]);
  const twoTenants = await actor('m7te03-two', [tenantGrant(T_A, 'manager'), tenantGrant(T_B, 'manager')]);
  const readOnly = await actor('m7te03-ro', [tenantGrant(T_RO, 'technician')]);
  const platformOnly = await actor('m7te03-platform', [{ scope: 'platform', role: 'system_owner' }]);
  const noGrant = await actor('m7te03-none', []);
  await withEntry({}, async (ctx) => {
    assertRefusal(await list(ctx, null), 401, 'unauthenticated', 'no cookie');
    const forged = randomBytes(32).toString('base64url');
    SECRETS.add(forged);
    assertRefusal(await list(ctx, `${SESSION_COOKIES.tenant}=${forged}`), 401, 'unauthenticated', 'forged session cookie');
    assertRefusal(await list(ctx, (await signIn(ctx, storeOnly)).cookie), 403, 'forbidden', 'store-only actor');
    assertRefusal(await list(ctx, (await signIn(ctx, twoTenants)).cookie), 403, 'forbidden', 'two tenant grants');
    assert.deepEqual(pageOf(await list(ctx, (await signIn(ctx, readOnly)).cookie), 'read_only tenant'), { customers: SEED_RO, nextCursor: null },
      'a read-only tenant reads: the route is classified a read');
    for (const [label, who] of [['platform-only', platformOnly], ['grantless', noGrant]]) {
      const reply = await ctx.login(who);
      assertRefusal(reply, 401, 'unauthenticated', `${label} login on the tenant host`);
      assert.equal(reasonOf(ctx, reply), 'login_admission_denied', label);
    }
    const [{ n }] = await owner`select count(*)::int as n from tmpos_session.session where auth_provider_uid = any(${[platformOnly.uid, noGrant.uid]}::text[])`;
    assert.equal(n, 0, 'no session was issued to either');
  });
});

test('M7TE-04: an administrative session is no tenant session; no administrative, witness or DEV route exists on the tenant entry', async () => {
  const admin = await actor('m7te04-admin', [{ scope: 'platform', role: 'system_owner' }]);
  const id = await adminSessionId(admin);
  await withEntry({}, async (ctx) => {
    const underAdminName = await list(ctx, `${SESSION_COOKIES.admin}=${id}`);
    assertRefusal(underAdminName, 401, 'unauthenticated', 'an administrative cookie');
    assert.equal(reasonOf(ctx, underAdminName), 'session_missing', 'the tenant boundary never reads the administrative cookie');
    const underTenantName = await list(ctx, `${SESSION_COOKIES.tenant}=${id}`);
    assertRefusal(underTenantName, 401, 'unauthenticated', 'an administrative session under the tenant cookie name');
    assert.equal(reasonOf(ctx, underTenantName), 'session_wrong_audience');
    for (const [method, path] of [['POST', sessionPaths('admin').login], ['GET', sessionPaths('admin').current], ['POST', sessionPaths('admin').logout],
      ['GET', '/admin/v1/tenants'], ['PATCH', '/admin/v1/tenants/display-name'], ['PATCH', '/admin/v1/tenants/status'],
      ['GET', '/__witness'], ['GET', '/admin/v1/witness'], ['GET', '/dev'], ['GET', '/identity/whoami'], ['GET', '/diagnostics'],
      // M7A-CUSTOMERS-P3: POST on the customer path is now the create (M7TE-01); no other write method is.
      ['GET', '/bootstrap'], ['GET', '/migrations'], ['PUT', CUSTOMER_DIRECTORY_PATH], ['PATCH', CUSTOMER_DIRECTORY_PATH],
      // M7A-CUSTOMERS-P4: GET /api/v1/customers/<one segment> is now the detail template (below), and since
      // M7A-CUSTOMERS-P7 PATCH on it is the edit; deeper paths and other methods on it are still no route.
      ['DELETE', CUSTOMER_DIRECTORY_PATH], ['GET', `${CUSTOMER_DIRECTORY_PATH}/x/y`], ['DELETE', `${CUSTOMER_DIRECTORY_PATH}/x`],
      ['GET', `${CUSTOMER_DIRECTORY_PATH}/`]]) {
      assertBounded404(await ctx.req(method, path, { cookie: `${SESSION_COOKIES.admin}=${id}` }), `${method} ${path}`);
      assert.ok(!ctx.result.routes.some((r) => r.method === method && r.path === path), `${method} ${path} is not in the served inventory`);
    }
    // C2.5, documented: any one segment below /api/v1/customers is now an AUTHENTICATED route — the administrative cookie is
    // no tenant session there either (401), and nothing about the segment is judged before that.
    const detailUnderAdmin = await ctx.req('GET', `${CUSTOMER_DIRECTORY_PATH}/x`, { cookie: `${SESSION_COOKIES.admin}=${id}` });
    assertRefusal(detailUnderAdmin, 401, 'unauthenticated', 'the detail template under the administrative cookie');
    assert.equal(reasonOf(ctx, detailUnderAdmin), 'session_missing');
    // M7A-CUSTOMERS-P7: the edit template likewise — a well-formed unsafe request (Origin, CSRF, a JSON body, a key) under
    // the administrative cookie is no tenant session there (401).
    const editUnderAdmin = await ctx.req('PATCH', `${CUSTOMER_DIRECTORY_PATH}/x`, {
      origin: TENANT_ORIGIN, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE, cookie: `${SESSION_COOKIES.admin}=${id}`,
      'content-type': 'application/json', 'idempotency-key': randomUUID(),
    }, JSON.stringify({ expectedVersion: 1, name: 'Ada Lovelace' }));
    assertRefusal(editUnderAdmin, 401, 'unauthenticated', 'the edit template under the administrative cookie');
    assert.equal(reasonOf(ctx, editUnderAdmin), 'session_missing');
  });
});

test('M7TE-05: the admin host, an unknown, wildcard-looking or IP host, the tenant host with :443 or a trailing dot, a duplicated or missing Host and a forwarded Host each get the bounded 404 — the route and the login alike; the tenant host in another letter case is served', async () => {
  const who = await actor('m7te05', [tenantGrant(T_A, 'store_owner')]);
  await withEntry({}, async (ctx) => {
    const session = await signIn(ctx, who);
    const listText = (hostLines, version = '1.1') =>
      `GET ${CUSTOMER_DIRECTORY_PATH} HTTP/${version}\r\n${hostLines}Cookie: ${session.cookie}\r\nX-TMPOS-Session-CSRF: ${session.csrf}\r\nConnection: close\r\n\r\n`;
    const loginText = (hostLines, version = '1.1') =>
      `POST ${sessionPaths('tenant').login} HTTP/${version}\r\n${hostLines}Origin: ${TENANT_ORIGIN}\r\nSec-Fetch-Site: same-origin\r\n`
      + `${CSRF_HEADER}: ${CSRF_HEADER_VALUE}\r\nAuthorization: Bearer ${who.token}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`;
    for (const host of [ADMIN_HOST, 'unknown.tmpos.test', `*.tmpos.test`, '*', `${TENANT_HOST}.evil.test`, `evil.${TENANT_HOST}`, '127.0.0.1',
      '[::1]', `${TENANT_HOST}:443`, `${TENANT_HOST}:8443`, `x@${TENANT_HOST}`]) {
      assertBounded404(await ctx.raw(listText(`Host: ${host}\r\n`)), `list on ${host}`);
      assertBounded404(await ctx.raw(loginText(`Host: ${host}\r\n`)), `login on ${host}`);
    }
    assertBounded404(await ctx.raw(listText(`Host: ${TENANT_HOST}\r\nHost: ${TENANT_HOST}\r\n`)), 'duplicated Host');
    assertBounded404(await ctx.raw(loginText(`Host: ${TENANT_HOST}\r\nHost: ${TENANT_HOST}\r\n`)), 'duplicated Host, login');
    assertBounded404(await ctx.raw(listText('', '1.0')), 'missing Host (HTTP/1.0)');
    assertBounded404(await ctx.raw(loginText('', '1.0')), 'missing Host (HTTP/1.0), login');
    assertBounded404(await ctx.raw(listText(`Host: evil.test\r\nX-Forwarded-Host: ${TENANT_HOST}\r\n`)), 'X-Forwarded-Host is never read');
    // The tenant host is served — a foreign X-Forwarded-Host changes nothing.
    const served = await ctx.raw(listText(`Host: ${TENANT_HOST}\r\nX-Forwarded-Host: evil.test\r\n`));
    assert.equal(served.status, 200, served.body);
    assert.deepEqual(JSON.parse(Buffer.from(served.body, 'latin1').toString('utf8')).customers, SEED_A, 'the raw socket reads bytes');
    await assertHostSpellings(ctx, who, SEED_A, 'M7TE-05');
  });
});

test('M7TE-06: a wrong Origin, a missing pre-session CSRF header or a cross-site fetch refuse the login with no cookie', async () => {
  const who = await actor('m7te06', [tenantGrant(T_A, 'manager')]);
  await withEntry({}, async (ctx) => {
    const base = {
      host: TENANT_HOST, origin: TENANT_ORIGIN, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE, authorization: `Bearer ${who.token}`,
    };
    const { [CSRF_HEADER]: _dropped, ...noCsrf } = base;
    for (const [label, headers] of [
      ['wrong Origin', { ...base, origin: 'https://evil.test' }],
      ['the admin Origin', { ...base, origin: ADMIN_ORIGIN }],
      ['no pre-session CSRF', noCsrf],
      ['cross-site', { ...base, 'sec-fetch-site': 'cross-site' }],
    ]) {
      assertRefusal(await sendReq(ctx.port, 'POST', sessionPaths('tenant').login, headers, ctx.clientAddress), 403, 'forbidden', label);
    }
    const [{ n }] = await owner`select count(*)::int as n from tmpos_session.session where auth_provider_uid = ${who.uid}`;
    assert.equal(n, 0, 'no session was issued');
  });
});

// ===========================================================================
// Acceptance (5): every missing or malformed dependency refuses startup; readiness is never ready while one fails
// ===========================================================================

test('M7TE-07: each missing or malformed tenant configuration refuses config_invalid with its bounded code, builds no client and binds nothing', async () => {
  const weakByte = randomBytes(1)[0];
  const cases = [
    ['SESSION_TENANT_ORIGINS missing', { SESSION_TENANT_ORIGINS: undefined }, 'SESSION_TENANT_ORIGINS:session_tenant_origin_missing'],
    ['a wildcard tenant origin', { SESSION_TENANT_ORIGINS: 'https://*.tmpos.test' }, 'SESSION_TENANT_ORIGINS:session_tenant_origin_invalid'],
    ['an http tenant origin', { SESSION_TENANT_ORIGINS: `http://${TENANT_HOST}` }, 'SESSION_TENANT_ORIGINS:session_tenant_origin_invalid'],
    ['two tenant origins', { SESSION_TENANT_ORIGINS: `${TENANT_ORIGIN},https://other.tmpos.test` }, 'SESSION_TENANT_ORIGINS:session_tenant_origin_not_single'],
    ['the admin host', { SESSION_TENANT_ORIGINS: `https://${ADMIN_HOST}:8443` }, 'SESSION_TENANT_ORIGINS:session_tenant_origin_shares_admin_host'],
    ['SESSION_ADMIN_ORIGINS missing', { SESSION_ADMIN_ORIGINS: undefined }, 'SESSION_ADMIN_ORIGINS:session_admin_origin_missing'],
    ['issuer key missing', { TENANT_SESSION_ISSUER_KEY: undefined }, 'TENANT_SESSION_ISSUER_KEY:tenant_issuer_key_missing'],
    ['issuer key malformed', { TENANT_SESSION_ISSUER_KEY: 'not-a-key' }, 'TENANT_SESSION_ISSUER_KEY:tenant_issuer_key_invalid'],
    ['issuer key = RATE_LIMIT_KEY', { TENANT_SESSION_ISSUER_KEY: RATE_KEY.toString('base64url') }, 'TENANT_SESSION_ISSUER_KEY:tenant_issuer_key_shared'],
    ['issuer key = the recorded vector', { TENANT_SESSION_ISSUER_KEY: Buffer.from(Array.from({ length: 32 }, (_, i) => i)).toString('base64url') },
      'TENANT_SESSION_ISSUER_KEY:tenant_issuer_key_weak'],
    ['issuer key of one repeated byte', { TENANT_SESSION_ISSUER_KEY: Buffer.alloc(32, weakByte).toString('base64url') }, 'TENANT_SESSION_ISSUER_KEY:tenant_issuer_key_weak'],
    // M7A-CUSTOMERS-P3: the entry's own command key — required, canonical, and neither of the other two keys.
    ['IDEMPOTENCY_KEY missing', { IDEMPOTENCY_KEY: undefined }, 'IDEMPOTENCY_KEY:idempotency_key_missing'],
    ['IDEMPOTENCY_KEY malformed', { IDEMPOTENCY_KEY: 'abc' }, 'IDEMPOTENCY_KEY:idempotency_key_invalid'],
    ['IDEMPOTENCY_KEY = RATE_LIMIT_KEY', { IDEMPOTENCY_KEY: RATE_KEY.toString('base64url') }, 'IDEMPOTENCY_KEY:idempotency_key_shared'],
    ['IDEMPOTENCY_KEY = the issuer key', { IDEMPOTENCY_KEY: ISSUER_KEY.toString('base64url') }, 'IDEMPOTENCY_KEY:idempotency_key_shared'],
    ['RATE_LIMIT_KEY missing', { RATE_LIMIT_KEY: undefined }, 'RATE_LIMIT_KEY:rate_limit_key_missing'],
    ['RATE_LIMIT_KEY malformed', { RATE_LIMIT_KEY: 'abc' }, 'RATE_LIMIT_KEY:rate_limit_key_invalid'],
    ['APP_DATABASE_URL missing', { APP_DATABASE_URL: undefined }, 'APP_DATABASE_URL:app_database_url_missing'],
  ];
  for (const [label, env, reason] of cases) {
    // A malformed probe as short as 'abc' is no secret, and would match a request id or cursor by chance: every real secret,
    // origin and DSN is at least 12 characters.
    for (const value of Object.values(env)) if (value !== undefined && value.length >= 12) SECRETS.add(value);
    await withEntry({ env }, async (ctx) => {
      assertRefused(ctx, 'config_invalid', [reason], label);
      assert.equal(ctx.clientsBuilt(), 0, `${label}: no database client was built`);
    });
  }
});

test('M7TE-08: the database must hold this process\'s issuer key; the limiter must hold its key; the login must hold the customer read, the customer create and the session mint — each refuses startup with its bounded code', async () => {
  try {
    await owner`delete from tmpos_mint.issuer_key`;
    await withEntry({}, async (ctx) => assertRefused(ctx, 'tenant_issuer_key_absent', [], 'no key installed'));
    await installTestIssuerKey(owner, randomBytes(32));
    await withEntry({}, async (ctx) => assertRefused(ctx, 'tenant_issuer_key_mismatch', [], 'another key installed'));
  } finally {
    await installTestIssuerKey(owner, ISSUER_KEY);
  }
  try {
    await registerFingerprint(randomBytes(32));
    await withEntry({}, async (ctx) => assertRefused(ctx, 'rate_limit_key_mismatch', [], 'another limiter key registered'));
  } finally {
    await registerFingerprint(RATE_KEY);
  }
  try {
    await owner.unsafe(`revoke execute on function ${V3} from tmpos_app`);
    await withEntry({}, async (ctx) => assertRefused(ctx, 'database_login_unsafe', ['role_privilege_missing'], 'the customer read withdrawn'));
  } finally {
    await owner.unsafe(`grant execute on function ${V3} to tmpos_app`);
  }
  // The mint withdrawn: the runtime login's grant census names it before the readiness step's mint probe is reached.
  await withoutExecute(MINT, () => withEntry({}, async (ctx) => assertRefused(ctx, 'database_login_unsafe', ['role_privilege_missing'],
    'the session mint withdrawn')));
  // The customer create withdrawn (M7A-CUSTOMERS-P3): the same census names it — the write never serves without it (020's
  // since M7A-CUSTOMERS-P3-R1, 023's since M7A-CUSTOMERS-P6). So do 020's role-level read, which every tenant route decision asks, and — since
  // M7A-CUSTOMERS-P4 — 021's set and its states read.
  await withoutExecute(CREATE, () => withEntry({}, async (ctx) => assertRefused(ctx, 'database_login_unsafe', ['role_privilege_missing'],
    'the customer create withdrawn')));
  await withoutExecute(LEVELS_READ, () => withEntry({}, async (ctx) => assertRefused(ctx, 'database_login_unsafe', ['role_privilege_missing'],
    'the role-level read withdrawn')));
  await withoutExecute(LEVEL_SET, () => withEntry({}, async (ctx) => assertRefused(ctx, 'database_login_unsafe', ['role_privilege_missing'],
    'the role-level set withdrawn')));
  await withoutExecute(LEVEL_STATES, () => withEntry({}, async (ctx) => assertRefused(ctx, 'database_login_unsafe', ['role_privilege_missing'],
    'the role-level states read withdrawn')));
  // M7A-CUSTOMERS-P4: 022's customer detail read.
  await withoutExecute(DETAIL_GET, () => withEntry({}, async (ctx) => assertRefused(ctx, 'database_login_unsafe', ['role_privilege_missing'],
    'the customer detail read withdrawn')));
  // M7A-CUSTOMERS-P6: the customer profile read (024's since M7A-CUSTOMERS-P7).
  await withoutExecute(PROFILE_GET, () => withEntry({}, async (ctx) => assertRefused(ctx, 'database_login_unsafe', ['role_privilege_missing'],
    'the customer profile read withdrawn')));
  // M7A-CUSTOMERS-P7: 024's customer edit.
  await withoutExecute(CUSTOMER_UPDATE, () => withEntry({}, async (ctx) => assertRefused(ctx, 'database_login_unsafe', ['role_privilege_missing'],
    'the customer edit withdrawn')));
  // M7A-CUSTOMERS-P8: 025's customer name search.
  await withoutExecute(CUSTOMER_SEARCH, () => withEntry({}, async (ctx) => assertRefused(ctx, 'database_login_unsafe', ['role_privilege_missing'],
    'the customer search withdrawn')));
  // 019's create or 018's page_v2 given back to the login (the name-only role decisions 020 closed) is a grant too many; so is
  // 020's unconditional set (M7A-CUSTOMERS-P4: an edit that asserts neither the tenant nor the version).
  for (const [label, fn] of [['019\'s create', 'tmpos_customer_write.m7a_customer_create(text, uuid, text)'], ['018\'s page_v2', 'tmpos_mint.m7a_customer_page_v2(text, uuid, integer)'],
    ['020\'s set', LEVEL_SET_020], ['020\'s create (023 revoked it: M7A-CUSTOMERS-P6)', CREATE_020],
    ['023\'s profile read (024 revoked it: M7A-CUSTOMERS-P7)', PROFILE_023]]) {
    try {
      await owner.unsafe(`grant execute on function ${fn} to tmpos_app`);
      await withEntry({}, async (ctx) => assertRefused(ctx, 'database_login_unsafe', ['role_privilege_unexpected'], `${label} given back`));
    } finally {
      await owner.unsafe(`revoke execute on function ${fn} from tmpos_app`);
    }
  }
  await withEntry({}, async (ctx) => assert.equal(ctx.result.outcome, 'listening', 'restored: it starts'));
});

test('M7TE-09: any setting that would log a bound parameter refuses startup database_logging_unsafe, naming the setting', async () => {
  const set = (settings) => owner.unsafe(`alter role ${RUNTIME_LOGIN} set ${settings}`);
  const reset = () => owner.unsafe(`alter role ${RUNTIME_LOGIN} reset all`);
  const cases = [
    ['log_parameter_max_length_on_error = 64', ['log_parameter_max_length_on_error = 64'], ['log_parameter_max_length_on_error']],
    ['log_statement = all', ['log_statement = \'all\''], ['log_statement']],
    ['log_min_duration_statement = 0', ['log_min_duration_statement = 0'], ['log_min_duration_statement']],
    ['log_min_duration_sample = 250ms', ['log_min_duration_sample = 250'], ['log_min_duration_sample']],
    ['debug_print_plan = on', ['debug_print_plan = on'], ['debug_print_plan']],
    // auto_explain logs a plan, and a custom plan carries the parameter values whatever its own parameter length says.
    ['auto_explain loaded, logging every plan', ['session_preload_libraries = \'auto_explain\'', 'auto_explain.log_min_duration = 0',
      'auto_explain.log_parameter_max_length = 0'], ['auto_explain_parameters']],
  ];
  try {
    for (const [label, settings, reasons] of cases) {
      for (const s of settings) await set(s);
      try {
        await withEntry({}, async (ctx) => assertRefused(ctx, 'database_logging_unsafe', reasons, label));
      } finally {
        await reset();
      }
    }
    // The statement logged with no parameter attached is safe: log_parameter_max_length = 0 turns every other rule off.
    await set('log_parameter_max_length = 0');
    await set('log_statement = \'all\'');
    await withEntry({}, async (ctx) => assert.equal(ctx.result.outcome, 'listening', JSON.stringify(ctx.result)));
  } finally {
    await reset();
    await endLoginSessions();
  }
  await withEntry({}, async (ctx) => assert.equal(ctx.result.outcome, 'listening', 'reset: it starts'));
});

test('M7TE-10: a migration ledger that is not exactly 001-034 refuses startup migration_state_invalid', async () => {
  // M7A-CUSTOMERS-P4: the newest required migration was 022 (the detail read); M7A-CUSTOMERS-P6 made it 023 (the contact
  // records), M7A-CUSTOMERS-P7 024 (customer edits), M7A-CUSTOMERS-P8 025 (the name search), M5-INVOICES-AUTH-P1 026 (the Invoices level)
  // and M7B-INVOICES-P1 027 (store discovery) and 028 (invoice drafts), M7B-INVOICES-P2 029 (the draft edit) and
  // M7B-INVOICES-P2-R1 030 (the Invoices authority guard) and M7B-INVOICES-P1-R3 031 (the guarded draft save) and
  // M7B-INVOICES-P1-R4 032 (the Customers authority of the guarded draft save), M7B-INVOICES-DISCARD-P1 033 (the draft
  // discard) and M7B-INVOICES-ISSUE-P1 034 (invoice issuing), so the fake "next migration" row is '035' — the restore below never
  // removes the real 034 row it re-inserts.
  const [row] = await owner`select version, checksum, dirty, started_at::text as started_at, finished_at::text as finished_at
    from public.schema_migrations where version = '034'`;
  assert.ok(row !== undefined, '034 is recorded');
  const restore = () => owner.begin(async (sql) => {
    await sql`delete from public.schema_migrations where version in ('034', '035')`;
    await sql`insert into public.schema_migrations (version, checksum, dirty, started_at, finished_at)
      values (${row.version}, ${row.checksum}, ${row.dirty}, ${row.started_at}::text::timestamptz, ${row.finished_at}::text::timestamptz)`;
  });
  try {
    await owner`delete from public.schema_migrations where version = '034'`;
    await withEntry({}, async (ctx) => assertRefused(ctx, 'migration_state_invalid', ['migration_missing'], 'a database at 033'));
    await restore();
    await owner`update public.schema_migrations set checksum = ${createHash('sha256').update('not 034').digest('hex')} where version = '034'`;
    await withEntry({}, async (ctx) => assertRefused(ctx, 'migration_state_invalid', ['migration_checksum_mismatch'], '034 with another checksum'));
    await restore();
    await owner`insert into public.schema_migrations (version, checksum, dirty, started_at, finished_at)
      values ('035', ${createHash('sha256').update('035').digest('hex')}, false, now(), now())`;
    await withEntry({}, async (ctx) => assertRefused(ctx, 'migration_state_invalid', ['migration_unknown'], 'an unknown 035'));
    await restore();
    // Not only the newest row is judged: an intermediate migration left dirty refuses as well.
    await owner`update public.schema_migrations set dirty = true where version = '010'`;
    await withEntry({}, async (ctx) => assertRefused(ctx, 'migration_state_invalid', ['migration_dirty'], '010 dirty'));
  } finally {
    await owner`update public.schema_migrations set dirty = false where version = '010'`;
    await restore();
  }
  const [back] = await owner`select version, checksum, dirty, started_at::text as started_at, finished_at::text as finished_at
    from public.schema_migrations where version = '034'`;
  assert.deepEqual({ ...back }, { ...row }, 'the ledger row is restored exactly');
});

test('M7TE-11: after startup, readiness is 503 while the issuer key is deleted or rotated, parameter logging is on, the customer read, the session mint, the session read, the tenant admission or the tenant store\'s probe is withdrawn, the limiter key is replaced or the database is down — each alone, and 200 once each recovers; /health stays 200', async () => {
  const who = await actor('m7te11', [tenantGrant(T_A, 'manager')]);
  await withEntry({}, async (ctx) => {
    assert.equal(ctx.result.outcome, 'listening', JSON.stringify(ctx.result));
    const session = await signIn(ctx, who);
    assert.equal((await ctx.req('GET', '/readiness')).status, 200);
    try {
      // The key deleted: not ready, no new login, and an existing session reads nothing.
      await owner`delete from tmpos_mint.issuer_key`;
      await readinessHolds(ctx, 503);
      assertRefusal(await ctx.login(who), 503, 'service_unavailable', 'login with no key');
      assertRefusal(await list(ctx, session.cookie), 403, 'forbidden', 'a session read with no key');
      assert.equal((await ctx.req('GET', '/health')).status, 200);
      await installTestIssuerKey(owner, ISSUER_KEY);
      assert.ok(await readinessUntil(ctx, 200), 'the key reinstalled: ready');
      assert.deepEqual(pageOf(await list(ctx, session.cookie), 'the same key again').customers, SEED_A);
      // The key rotated to one this process does not hold.
      await installTestIssuerKey(owner, randomBytes(32));
      await readinessHolds(ctx, 503);
      assertRefusal(await list(ctx, session.cookie), 403, 'forbidden', 'a session minted under the old key');
    } finally {
      await installTestIssuerKey(owner, ISSUER_KEY);
    }
    assert.ok(await readinessUntil(ctx, 200), 'restored');

    // Parameter logging turned on for the login's sessions: a reconnect alone recovers, the setting holds readiness at 503.
    try {
      await endLoginSessions();
      assert.ok(await readinessUntil(ctx, 200), 'a reconnect alone is ready again');
      await owner.unsafe(`alter role ${RUNTIME_LOGIN} set log_min_duration_statement = 0`);
      await endLoginSessions();
      await readinessHolds(ctx, 503);
    } finally {
      await owner.unsafe(`alter role ${RUNTIME_LOGIN} reset all`);
      await endLoginSessions();
    }
    assert.ok(await readinessUntil(ctx, 200), 'logging reset: ready');

    // The customer read withdrawn from the login.
    try {
      await owner.unsafe(`revoke execute on function ${V3} from tmpos_app`);
      await readinessHolds(ctx, 503);
      assertRefusal(await list(ctx, session.cookie), 503, 'service_unavailable', 'the read withdrawn');
    } finally {
      await owner.unsafe(`grant execute on function ${V3} to tmpos_app`);
    }
    assert.ok(await readinessUntil(ctx, 200), 'the read restored: ready');

    // M7A-CUSTOMERS-P4: the customer detail read withdrawn from the login — the second half of the reads' probe.
    await withoutExecute(DETAIL_GET, async () => {
      await readinessHolds(ctx, 503);
      assertRefusal(await ctx.req('GET', `${CUSTOMER_DIRECTORY_PATH}/${SEED_A[0].id}`, { cookie: session.cookie, ...csrfOf(session.cookie) }), 503, 'service_unavailable',
        'the detail read withdrawn');
      assert.deepEqual(pageOf(await list(ctx, session.cookie), 'the list still reads').customers, SEED_A);
    });
    assert.ok(await readinessUntil(ctx, 200), 'the detail read restored: ready');

    // M7A-CUSTOMERS-P6: the customer profile read (024's since M7A-CUSTOMERS-P7) withdrawn from the login — the third part
    // of the reads' probe.
    await withoutExecute(PROFILE_GET, async () => {
      await readinessHolds(ctx, 503);
      assertRefusal(await ctx.req('GET', `${CUSTOMER_DIRECTORY_PATH}/${SEED_A[0].id}/profile`, { cookie: session.cookie, ...csrfOf(session.cookie) }), 503,
        'service_unavailable', 'the profile read withdrawn');
      assert.equal((await ctx.req('GET', `${CUSTOMER_DIRECTORY_PATH}/${SEED_A[0].id}`, { cookie: session.cookie, ...csrfOf(session.cookie) })).status, 200,
        'the detail still reads');
    });
    assert.ok(await readinessUntil(ctx, 200), 'the profile read restored: ready');

    // The mint probe writes nothing: readiness asked it across three reuse windows, and every mint-ledger and session row is
    // exactly as it was — counted, and digested whole on the server (a digest, never a row, leaves the database).
    const rowState = async () => ({ ...(await owner`select
      (select count(*) from tmpos_mint.tenant_session)::int as minted,
      (select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(coalesce(pg_catalog.string_agg(m::text, '|' order by m.session_key), ''),
        'UTF8')), 'hex') from tmpos_mint.tenant_session m) as minted_digest,
      (select count(*) from tmpos_session.session)::int as sessions,
      (select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(coalesce(pg_catalog.string_agg(s::text, '|' order by s.session_key), ''),
        'UTF8')), 'hex') from tmpos_session.session s) as sessions_digest`)[0] });
    const rowsBefore = await rowState();
    await readinessHolds(ctx, 200);
    assert.deepEqual(await rowState(), rowsBefore, 'the mint probe adds, changes and removes no mint-ledger or session row');

    // The session mint withdrawn from the login: not ready, and no login can be issued.
    await withoutExecute(MINT, async () => {
      await readinessHolds(ctx, 503);
      assertRefusal(await ctx.login(who), 503, 'service_unavailable', 'login with the mint withdrawn');
      assert.equal((await ctx.req('GET', '/health')).status, 200);
    });
    assert.ok(await readinessUntil(ctx, 200), 'the mint restored: ready');

    // The limiter's registered fingerprint replaced under the running process (as the owner, as M7TE-08 does).
    try {
      await registerFingerprint(randomBytes(32));
      await readinessHolds(ctx, 503);
      assertRefusal(await list(ctx, session.cookie), 503, 'service_unavailable', 'a read with another limiter key registered');
      assert.equal((await ctx.req('GET', '/health')).status, 200);
    } finally {
      await registerFingerprint(RATE_KEY);
    }
    assert.ok(await readinessUntil(ctx, 200), 'the limiter key restored: ready');

    // The session read (the store's get) and the tenant admission withdrawn from the login, each alone.
    for (const [label, fn] of [['the session read', SESSION_GET], ['the tenant admission', ADMIT]]) {
      await withoutExecute(fn, async () => {
        await readinessHolds(ctx, 503);
        assertRefusal(await list(ctx, session.cookie), 503, 'service_unavailable', `a read with ${label} withdrawn`);
        assert.equal((await ctx.req('GET', '/health')).status, 200);
      });
      assert.ok(await readinessUntil(ctx, 200), `${label} restored: ready`);
    }

    // The tenant store's probe withdrawn (M7A-CUSTOMERS-P3): its idempotency and command ports answer readiness with it, so
    // not ready — while the read, which needs neither, still answers.
    await withoutExecute(STORE_PROBE, async () => {
      await readinessHolds(ctx, 503);
      assert.deepEqual(pageOf(await list(ctx, session.cookie), 'a read with the store probe withdrawn').customers, SEED_A);
      assert.equal((await ctx.req('GET', '/health')).status, 200);
    });
    assert.ok(await readinessUntil(ctx, 200), 'the store probe restored: ready');

    // The database down.
    await storeDown(ctx.relay);
    await readinessHolds(ctx, 503);
    assertRefusal(await list(ctx, session.cookie), 503, 'service_unavailable', 'the store down');
    assert.equal((await ctx.req('GET', '/health')).status, 200, 'still alive');
    await ctx.relay.restore();
    assert.ok(await readinessUntil(ctx, 200), 'the store restored: ready');
    assert.deepEqual(pageOf(await list(ctx, session.cookie), 'after every recovery').customers, SEED_A);
  });
});

test('M7TE-12: shutdown closes the listener and ends the database client exactly once', async () => {
  await withEntry({}, async (ctx) => {
    assert.equal(ctx.result.outcome, 'listening');
    ctx.cap.proc.emit('SIGTERM');
    await waitFor(() => ctx.cap.codes.length > 0, 5_000);
    ctx.cap.proc.emit('SIGTERM');
    await delay(100);
    assert.deepEqual(ctx.cap.codes, [0], 'exit was called exactly once, with 0');
    assert.deepEqual(ctx.ends, { calls: 1, completed: 1 });
    await new Promise((resolve, reject) => {
      const s = net.connect(ctx.port, '127.0.0.1');
      s.on('connect', () => { s.destroy(); reject(new Error('connected after shutdown')); });
      s.on('error', () => resolve());
    });
  });
});

// ===========================================================================
// M7TE-14: the customer detail read, GET /api/v1/customers/{id} (M7A-CUSTOMERS-P4), on the source entry
// ===========================================================================

/** The detail read of `segment`, with `cookie` (or none). */
const detail = (ctx, cookie, segment, headers = {}) =>
  ctx.req('GET', `${CUSTOMER_DIRECTORY_PATH}/${segment}`, { ...(cookie === null ? {} : { cookie, ...csrfOf(cookie) }), ...headers });
/** A 200 detail body: exactly { customer: { id, name } }. */
function customerOf(reply, label) {
  assert.equal(reply.status, 200, `${label}: ${reply.body}`);
  const body = JSON.parse(reply.body);
  assert.deepEqual(Object.keys(body), ['customer'], label);
  assert.deepEqual(Object.keys(body.customer), ['id', 'name'], label);
  return body.customer;
}
/** Headers compared across two replies: everything but the request id, the date and the body hash's value. */
const headerShape = (reply) => Object.fromEntries(Object.entries(reply.headers)
  .filter(([k]) => k !== 'x-request-id' && k !== 'date').map(([k, v]) => [k, k === 'etag' ? typeof v : v]));
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

/**
 * The production kernel, with one lever: before a statement naming 022's routine is sent, `gate.park` (when set) is awaited
 * once — the chain has already authenticated and authorized the request, so whatever `park` commits lands between the
 * chain's decision and the routine's snapshot.
 */
function parkingKernel(gate) {
  return {
    MAX_POOLS, runtimeClientOptions,
    createSupervisedPgClient: (...args) => {
      const real = createSupervisedPgClient(...args);
      return {
        end: () => real.end(),
        transaction: (signal, bounds, work) => real.transaction(signal, bounds, (sql) => work(new Proxy(sql, {
          apply: (target, self, argv) => {
            const text = Array.isArray(argv[0]) ? argv[0].join('?') : '';
            const park = gate.park;
            if (park === null || !text.includes('m7a_customer_get')) return Reflect.apply(target, self, argv);
            gate.park = null;
            return park().then(() => Reflect.apply(target, self, argv));
          },
        }))),
      };
    },
  };
}

test('M7TE-14: the customer detail read — own 200, foreign and missing 404s alike, malformed ids 400 only after authentication, a narrowed role, a logged-out or parked-then-revoked session, the admin cookie, the wrong Host, the store down and a read-only tenant', async () => {
  const T_N = await newTenant('m7te14-narrow');
  const [seedN] = await seed(T_N, [`Narrow ${SUFFIX}`]);
  const aUser = await actor('m7te14-a', [tenantGrant(T_A, 'manager')]);
  const nUser = await actor('m7te14-n', [tenantGrant(T_N, 'manager')]);
  const roUser = await actor('m7te14-ro', [tenantGrant(T_RO, 'technician')]);
  const admin = await actor('m7te14-admin', [{ scope: 'platform', role: 'system_owner' }]);
  const adminId = await adminSessionId(admin);
  const gate = { park: null };
  const missing = randomUUID();
  SECRETS.add(missing);
  try {
    await withEntry({ kernelModule: parkingKernel(gate) }, async (ctx) => {
      assert.equal(ctx.result.outcome, 'listening', JSON.stringify(ctx.result));
      const a = await signIn(ctx, aUser);
      // Own: 200, exactly the id and the name.
      const own = SEED_A[0];
      assert.deepEqual(customerOf(await detail(ctx, a.cookie, own.id), 'own'), own);
      // Another tenant's id and a random id: one status, one body shape, one header set, one log reason.
      const foreign = await detail(ctx, a.cookie, SEED_B[0].id);
      const absent = await detail(ctx, a.cookie, missing);
      for (const [label, reply] of [['foreign', foreign], ['missing', absent]]) {
        assertBounded404(reply, label);
        assert.equal(reasonOf(ctx, reply), 'customer_not_found', label);
        assert.ok(!reply.body.includes(SEED_B[0].name) && !reply.body.includes(SEED_B[0].id), `${label}: nothing of B`);
      }
      assert.deepEqual(headerShape(foreign), headerShape(absent), 'foreign and missing: identical headers modulo request id, date and body hash');
      // Timing SANITY bound, not a constant-time claim (doc 08 residual): interleaved, medians within max(10 ms, 50%).
      const times = { f: [], m: [] };
      for (let i = 0; i < 20; i++) {
        const pair = [['f', SEED_B[1].id], ['m', randomUUID()]];
        for (const [k, id] of (i % 2 === 0 ? pair : pair.reverse())) {
          const t0 = process.hrtime.bigint();
          const r = await detail(ctx, a.cookie, id);
          times[k].push(Number(process.hrtime.bigint() - t0) / 1e6);
          assert.equal(r.status, 404);
        }
      }
      const [mf, mm] = [median(times.f), median(times.m)];
      assert.ok(Math.abs(mf - mm) <= Math.max(10, 0.5 * Math.max(mf, mm)), `timing sanity: foreign ${mf.toFixed(2)} ms, missing ${mm.toFixed(2)} ms`);
      // Malformed segments: the chain's 401 without a session — no id-shape oracle — and the list's 400 after authentication.
      for (const segment of [own.id.toUpperCase(), own.id.replace(/-/g, '%2d'), '{id}', `%7B${own.id}%7D`, 'x', 'a'.repeat(128)]) {
        assertRefusal(await detail(ctx, null, segment), 401, 'unauthenticated', `${segment}: no session`);
        const bad = await detail(ctx, a.cookie, segment);
        assertRefusal(bad, 400, 'invalid_request', `${segment}: authenticated`);
        assert.equal(reasonOf(ctx, bad), 'customer_detail_id_invalid');
      }
      assertRefusal(await detail(ctx, null, `${own.id}?`), 401, 'unauthenticated', 'a query, no session');
      assertRefusal(await detail(ctx, a.cookie, `${own.id}?`), 400, 'invalid_request', 'a query, authenticated');
      for (const [label, path] of [['a trailing slash', `${own.id}/`], ['an extra segment', `${own.id}/x`], ['129 characters', 'a'.repeat(129)], ['empty', '']]) {
        assertBounded404(await detail(ctx, a.cookie, path), label);
      }
      assert.equal((await ctx.req('HEAD', `${CUSTOMER_DIRECTORY_PATH}/${own.id}`, { cookie: a.cookie })).status, 404, 'HEAD is no route');
      // The wrong Host: the bounded 404 before anything else.
      assertBounded404(await detail(ctx, a.cookie, own.id, { host: ADMIN_HOST }), 'the admin host');
      // The administrative cookie on the tenant host is no tenant session.
      assertRefusal(await detail(ctx, `${SESSION_COOKIES.admin}=${adminId}`, own.id), 401, 'unauthenticated', 'the admin cookie');
      assertRefusal(await detail(ctx, `${SESSION_COOKIES.tenant}=${adminId}`, own.id), 401, 'unauthenticated', 'an admin session as a tenant one');
      // A read-only tenant reads (a read is admitted there, as the list is).
      const ro = await signIn(ctx, roUser);
      assert.deepEqual(customerOf(await detail(ctx, ro.cookie, SEED_RO[0].id), 'read-only tenant'), SEED_RO[0]);
      // A role narrowed to None after sign-in: the formerly visible customer is the list's 403.
      const n = await signIn(ctx, nUser);
      assert.deepEqual(customerOf(await detail(ctx, n.cookie, seedN.id), 'before the narrowing'), seedN);
      await owner`insert into tmpos_role.tenant_role_level (tenant_id, role_id, domain, level, updated_at)
        values (${T_N}, 'manager', 'customers', 'none', now())`;
      assertRefusal(await detail(ctx, n.cookie, seedN.id), 403, 'forbidden', 'narrowed to None');
      // Logged out: the session row is gone, 401.
      const out = await signIn(ctx, aUser);
      const bye = await ctx.req('POST', sessionPaths('tenant').logout, {
        origin: TENANT_ORIGIN, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE, cookie: out.cookie, [SESSION_CSRF_HEADER]: out.csrf,
      });
      assert.equal(bye.status, 204, bye.body);
      assertRefusal(await detail(ctx, out.cookie, own.id), 401, 'unauthenticated', 'logged out');
      // PARKED (C2.2): the chain authenticates and authorizes, then — before 022's statement is sent — the session is revoked
      // and that commits. The routine finds no session row: never a 200.
      const parked = await signIn(ctx, aUser);
      let revoked = false;
      gate.park = async () => {
        await owner`select tmpos_session.m5_session_revoke(${keyOf(parked.cookie)}::text)`;
        revoked = true;
      };
      const late = await detail(ctx, parked.cookie, own.id);
      assert.ok(revoked && gate.park === null, 'the lever engaged and the revocation committed');
      assertRefusal(late, 403, 'forbidden', 'revoked between the decision and the read');
      assert.equal(reasonOf(ctx, late), 'customer_detail_denied', 'the routine refused it');
      // The store down: a bounded 503, then recovery.
      await storeDown(ctx.relay);
      assertRefusal(await detail(ctx, a.cookie, own.id), 503, 'service_unavailable', 'the store down');
      await ctx.relay.restore();
      assert.ok(await readinessUntil(ctx, 200), 'the store restored: ready');
      assert.deepEqual(customerOf(await detail(ctx, a.cookie, own.id), 'after recovery'), own);
    });
  } finally {
    await owner`delete from tmpos_role_edit.role_level_version where tenant_id = ${T_N}`;
    await owner`delete from tmpos_role.tenant_role_level where tenant_id = ${T_N}`;
  }
});

/** GET /api/v1/customers/{segment}/profile presenting `cookie` (null: no session) and its CSRF token. */
const profileOf = (ctx, cookie, segment, headers = {}) =>
  ctx.req('GET', `${CUSTOMER_DIRECTORY_PATH}/${segment}/profile`, { ...(cookie === null ? {} : { cookie, ...csrfOf(cookie) }), ...headers });
/** A 200 profile body: exactly { customer: { id, name, phone, email, createdAt } }, in that key order. */
function profileBody(reply, label) {
  assert.equal(reply.status, 200, `${label}: ${reply.body}`);
  const body = JSON.parse(reply.body);
  assert.deepEqual(Object.keys(body), ['customer'], label);
  assert.deepEqual(Object.keys(body.customer), ['id', 'name', 'phone', 'email', 'createdAt'], label);
  return body.customer;
}
/** A POST /api/v1/customers presenting `s`, under a fresh Idempotency-Key unless one is given. */
const createWith = (ctx, s, body, key = randomUUID()) => ctx.req('POST', CUSTOMER_DIRECTORY_PATH, {
  origin: TENANT_ORIGIN, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE, cookie: s.cookie,
  [SESSION_CSRF_HEADER]: s.csrf, 'content-type': 'application/json', 'idempotency-key': key,
}, typeof body === 'string' ? body : JSON.stringify(body));

test('M7TE-15: a create with contacts and the profile read end to end — 201 {customer:{id,name}}, the row holding the contacts and the database\'s creation time, the profile 200 in its exact shape, a legacy row\'s null creation time, foreign and missing one 404, malformed ids 400 only after authentication, the session-binding witness, a refused contact writing nothing', async () => {
  // Its own tenant: the list pins of the cases around it (M7TE-C1 reads T_A's page) see none of its customers.
  const T_C = await newTenant('m7te15');
  const who = await actor('m7te15', [tenantGrant(T_C, 'manager')]);
  const name = `Contact ${SUFFIX}`;
  const phone = `+1 555 01${SUFFIX.slice(0, 2).replace(/[^0-9]/g, '0')}`;
  const email = `m7te15-${SUFFIX}@example.test`;
  SECRETS.add(name).add(phone).add(email);
  // A row as a 022 database left it: no contact and no creation time (the owner states the NULL the default would fill).
  const legacyId = randomUUID();
  const legacyName = `Legacy ${SUFFIX}`;
  SECRETS.add(legacyId).add(legacyName);
  await owner`insert into tmpos_customer.customer (customer_id, tenant_id, name, created_at) values (${legacyId}, ${T_C}, ${legacyName}, null)`;
  try {
    await withEntry({}, async (ctx) => {
      assert.equal(ctx.result.outcome, 'listening', JSON.stringify(ctx.result));
      const s = await signIn(ctx, who);
      const counts = async () => ({ ...(await owner`select (select count(*) from tmpos_customer.customer where tenant_id = ${T_C})::int as c,
        (select count(*) from public.audit_event where action_id = 'tenant.customer.create' and actor_internal_user_id = ${who.id})::int as a`)[0] });
      const before = await counts();
      const created = await createWith(ctx, s, { name: ` ${name} `, phone: ` ${phone} `, email });
      assert.equal(created.status, 201, created.body);
      const { customer } = JSON.parse(created.body);
      SECRETS.add(customer.id);
      assert.deepEqual(JSON.parse(created.body), { customer: { id: customer.id, name } }, 'the 201 is {customer:{id,name}}: no contact');
      assert.equal(created.headers.location, `${CUSTOMER_DIRECTORY_PATH}/${customer.id}`);
      assert.deepEqual(await counts(), { c: before.c + 1, a: before.a + 1 }, 'one customer, one audit record');
      const [row] = await owner`select tenant_id, phone, email, created_at, pg_catalog.floor(extract(epoch from created_at) * 1000)::bigint::text as ms
        from tmpos_customer.customer where customer_id = ${customer.id}`;
      assert.deepEqual([row.tenant_id, row.phone, row.email], [T_C, phone, email], 'stored trimmed, as sent otherwise');
      // The profile: the contacts, and the database's creation time in toISOString's form.
      const own = profileBody(await profileOf(ctx, s.cookie, customer.id), 'own');
      assert.deepEqual({ ...own, createdAt: null }, { id: customer.id, name, phone, email, createdAt: null });
      assert.equal(own.createdAt, new Date(Number(row.ms)).toISOString(), 'the stored instant, truncated to the millisecond, UTC');
      assert.deepEqual(profileBody(await profileOf(ctx, s.cookie, legacyId), 'legacy'), { id: legacyId, name: legacyName, phone: null, email: null, createdAt: null },
        'a customer from before 023: no contact, an unknown creation time');
      // The detail read is unchanged: {id, name} only.
      assert.deepEqual(JSON.parse((await ctx.req('GET', created.headers.location, { cookie: s.cookie, ...csrfOf(s.cookie) })).body), { customer: { id: customer.id, name } });
      // Foreign and missing: one 404 body, one header set, one log reason.
      const missing = randomUUID();
      SECRETS.add(missing);
      const foreign = await profileOf(ctx, s.cookie, SEED_B[0].id);
      const absent = await profileOf(ctx, s.cookie, missing);
      for (const [label, reply] of [['foreign', foreign], ['missing', absent]]) {
        assertBounded404(reply, label);
        assert.equal(reasonOf(ctx, reply), 'customer_not_found', label);
      }
      assert.deepEqual(headerShape(foreign), headerShape(absent), 'foreign and missing: identical headers modulo request id, date and body hash');
      // Malformed: the chain's 401 without a session, the 400 after authentication.
      for (const segment of [customer.id.toUpperCase(), '{id}', 'x']) {
        assertRefusal(await profileOf(ctx, null, segment), 401, 'unauthenticated', `${segment}: no session`);
        const bad = await profileOf(ctx, s.cookie, segment);
        assertRefusal(bad, 400, 'invalid_request', `${segment}: authenticated`);
        assert.equal(reasonOf(ctx, bad), 'customer_profile_id_invalid');
      }
      for (const path of [`${customer.id}/profile/`, `${customer.id}/profile/x`, `${customer.id}/contacts`]) {
        assertBounded404(await ctx.req('GET', `${CUSTOMER_DIRECTORY_PATH}/${path}`, { cookie: s.cookie, ...csrfOf(s.cookie) }), path);
      }
      // The session-binding witness: no CSRF token, or another session's, is a 403 before the read.
      assertRefusal(await ctx.req('GET', `${CUSTOMER_DIRECTORY_PATH}/${customer.id}/profile`, { cookie: s.cookie }), 403, 'forbidden', 'no session CSRF');
      assertRefusal(await ctx.req('GET', `${CUSTOMER_DIRECTORY_PATH}/${customer.id}/profile`, { cookie: s.cookie, [SESSION_CSRF_HEADER]: 'A'.repeat(43) }),
        403, 'forbidden', 'another token');
      // A refused contact: 400, and nothing written.
      const mid = await counts();
      for (const body of [{ name, phone: 'no digit' }, { name, email: 'two@at@example.test' }, { name, email: 'a b@example.test' }, { name, phone: 5550100 }]) {
        assertRefusal(await createWith(ctx, s, body), 400, 'invalid_request', JSON.stringify(Object.keys(body)));
      }
      assert.deepEqual(await counts(), mid, 'no refused contact wrote a customer or an audit record');
      // AC-5 over HTTP: a role narrowed to None after sign-in is refused the profile of a customer that HAS a phone and an
      // email — the list's and the detail's 403 — and the refusal carries neither value (nor the name or the creation time).
      const readable = profileBody(await profileOf(ctx, s.cookie, customer.id), 'before the narrowing (control)');
      assert.deepEqual([readable.phone, readable.email], [phone, email], 'the customer holds both contacts, readable before the narrowing');
      // An upsert: the creates above took the manager's row lock, which seeds the row at its default level.
      await owner`insert into tmpos_role.tenant_role_level (tenant_id, role_id, domain, level, updated_at)
        values (${T_C}, 'manager', 'customers', 'none', now())
        on conflict (tenant_id, role_id, domain) do update set level = excluded.level, updated_at = excluded.updated_at`;
      assert.equal((await owner`select level from tmpos_role.tenant_role_level where tenant_id = ${T_C} and role_id = 'manager' and domain = 'customers'`)[0].level, 'none', 'the manager is narrowed to None');
      const narrowed = await profileOf(ctx, s.cookie, customer.id);
      assertRefusal(narrowed, 403, 'forbidden', 'the profile of a customer with contacts, narrowed to None');
      for (const secret of [phone, email, name, readable.createdAt]) {
        assert.ok(!narrowed.body.includes(secret), 'the narrowed refusal carries no customer value');
        assert.ok(!JSON.stringify(narrowed.headers).includes(secret), 'nor does a header of it');
      }
    });
  } finally {
    // 020's down (a later suite's rollback) refuses while a level row exists: this test's own are removed.
    await owner`delete from tmpos_role_edit.role_level_version where tenant_id = ${T_C}`;
    await owner`delete from tmpos_role.tenant_role_level where tenant_id = ${T_C}`;
  }
});

// ===========================================================================
// M7TE-C1: the COMPILED tenant entry over the same disposable database and real sockets
// ===========================================================================

test('M7TE-C1: the compiled tenant entry starts over the disposable database, serves the customer read on the tenant host alone (in another letter case too, never with a trailing dot), refuses the admin cookie, creates one customer, and stops cleanly; the administrative inventory is still its eight routes', async () => {
  // The administrative artifact is compiled from productionEntry.ts's SHIPPING_ROUTES (its compiled inventory is pinned by
  // production-runtime-contract): still exactly these eight — no customer route, nothing of the tenant boundary's.
  assert.deepEqual(canonical(SHIPPING_ROUTES), [
    'GET /admin/v1/session session none none',
    'GET /admin/v1/tenants session none none',
    'GET /health public none none',
    'GET /readiness public none none',
    'PATCH /admin/v1/tenants/display-name session json required',
    'PATCH /admin/v1/tenants/status session json required',
    'POST /admin/v1/session/login login none none',
    'POST /admin/v1/session/logout session none none',
  ]);
  // The compiled ENTRY module is started, as the source one is above: the compiled executable (tenantMain.js) passes
  // PRODUCTION_CONSTRUCTION — verified TLS to the sealed managed endpoint — which no disposable database can answer. Its own
  // bytes are pinned elsewhere: it runs under node and refuses (production-runtime-contract), and its one call passes
  // exactly the administrative executable's options (the A9 census there). Built into node_modules/.cache (gitignored), so
  // the emitted ESM resolves its packages from the repository's node_modules.
  mkdirSync(join(REPO, 'node_modules', '.cache'), { recursive: true });
  const out = mkdtempSync(join(REPO, 'node_modules', '.cache', 'tmpos-tenant-build-'));
  try {
    const build = spawnSync(join(REPO, 'node_modules', '.bin', 'tsc'), ['-p', 'tsconfig.server.tenant.json', '--outDir', out],
      { cwd: REPO, env: childEnv(undefined), encoding: 'utf8', timeout: 180_000 });
    assert.equal(build.status, 0, `the tenant build succeeds:\n${(build.stdout || '') + (build.stderr || '')}`);
    const compiled = (m) => import(pathToFileURL(join(out, m)).href);
    const entry = await compiled('server/entry/tenantEntry.js');
    const kernel = await compiled('server/persistence/supervisedPgClient.js');
    const { runtimeClientOptions: compiledClientOptions } = await compiled('server/platform-identity/db.js');
    assert.notEqual(entry.startTenantEntry, startTenantEntry, 'the compiled module, not the source');

    const who = await actor('m7te-c1', [tenantGrant(T_A, 'manager')]);
    const admin = await actor('m7te-c1-admin', [{ scope: 'platform', role: 'system_owner' }]);
    const adminId = await adminSessionId(admin);
    // The compiled entry, over the compiled kernel and client options: every module on the path is the artifact's.
    const kernelModule = { createSupervisedPgClient: kernel.createSupervisedPgClient, MAX_POOLS: kernel.MAX_POOLS, runtimeClientOptions: compiledClientOptions };
    await withEntry({ start: entry.startTenantEntry, kernelModule }, async (ctx) => {
      assert.equal(ctx.result.outcome, 'listening', JSON.stringify(ctx.result));
      assert.deepEqual(canonical(ctx.result.routes), canonical(TENANT_SHIPPING_ROUTES));
      assert.deepEqual(canonical(entry.TENANT_SHIPPING_ROUTES), canonical(TENANT_SHIPPING_ROUTES), 'the compiled inventory is the source literal');
      const session = await signIn(ctx, who);
      assert.match(session.setCookie, /^__Host-tmpos_tenant_session=[^;]+; Path=\/; Max-Age=\d+; Secure; HttpOnly; SameSite=Strict$/);
      assert.deepEqual(pageOf(await list(ctx, session.cookie, '?limit=100'), 'compiled read'), { customers: SEED_A, nextCursor: null });
      const listText = (hostLines, version = '1.1') =>
        `GET ${CUSTOMER_DIRECTORY_PATH} HTTP/${version}\r\n${hostLines}Cookie: ${session.cookie}\r\nX-TMPOS-Session-CSRF: ${session.csrf}\r\nConnection: close\r\n\r\n`;
      assertBounded404(await ctx.raw(listText(`Host: ${ADMIN_HOST}\r\n`)), 'compiled: the admin host');
      assertBounded404(await ctx.raw(listText('Host: unknown.tmpos.test\r\n')), 'compiled: an unknown host');
      assertBounded404(await ctx.raw(listText('Host: *.tmpos.test\r\n')), 'compiled: a wildcard-looking host');
      assertBounded404(await ctx.raw(listText('', '1.0')), 'compiled: no Host');
      await assertHostSpellings(ctx, who, SEED_A, 'compiled');
      const adminCookie = await list(ctx, `${SESSION_COOKIES.admin}=${adminId}`);
      assertRefusal(adminCookie, 401, 'unauthenticated', 'compiled: the administrative cookie');
      assertRefusal(await list(ctx, `${SESSION_COOKIES.tenant}=${adminId}`), 401, 'unauthenticated', 'compiled: an administrative session as a tenant one');
      assertBounded404(await ctx.req('GET', '/admin/v1/tenants', { cookie: `${SESSION_COOKIES.admin}=${adminId}` }), 'compiled: no administrative route');
      assert.equal((await ctx.req('GET', '/readiness')).status, 200);

      // M7A-CUSTOMERS-P3: the compiled artifact carries the create and its store — one real POST commits one customer in the
      // session's tenant, with its one audit record (the full contract is tests/db/customerCreate.integration.test.mjs's).
      const name = `Compiled create ${SUFFIX}`;
      const key = randomUUID();
      SECRETS.add(name).add(key);
      const created = await ctx.req('POST', CUSTOMER_DIRECTORY_PATH, {
        origin: TENANT_ORIGIN, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE, cookie: session.cookie,
        [SESSION_CSRF_HEADER]: session.csrf, 'content-type': 'application/json', 'idempotency-key': key,
      }, JSON.stringify({ name }));
      assert.equal(created.status, 201, `compiled create: ${created.body}`);
      const { customer } = JSON.parse(created.body);
      SECRETS.add(customer.id);
      assert.equal(customer.name, name);
      const [row] = await owner`select tenant_id, name from tmpos_customer.customer where customer_id = ${customer.id}`;
      assert.deepEqual({ ...row }, { tenant_id: T_A, name }, 'compiled create: the row, in the session\'s tenant');
      const [{ n }] = await owner`select count(*)::int as n from public.audit_event
        where action_id = 'tenant.customer.create' and actor_internal_user_id = ${who.id}`;
      assert.equal(n, 1, 'compiled create: one audit record');
      // M7A-CUSTOMERS-P4: the 201's Location is the detail route of the new id; following it reads the same customer. A
      // same-key replay carries the same Location; another tenant's id and a random id are one 404; uppercase is a 400.
      assert.equal(created.headers.location, `${CUSTOMER_DIRECTORY_PATH}/${customer.id}`, 'compiled create: Location');
      const followed = await ctx.req('GET', created.headers.location, { cookie: session.cookie, ...csrfOf(session.cookie) });
      assert.equal(followed.status, 200, followed.body);
      assert.deepEqual(JSON.parse(followed.body), { customer }, 'compiled: Location reads the created customer');
      const replay = await ctx.req('POST', CUSTOMER_DIRECTORY_PATH, {
        origin: TENANT_ORIGIN, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE, cookie: session.cookie,
        [SESSION_CSRF_HEADER]: session.csrf, 'content-type': 'application/json', 'idempotency-key': key,
      }, JSON.stringify({ name }));
      assert.deepEqual([replay.status, replay.body, replay.headers['idempotent-replayed'], replay.headers.location],
        [201, created.body, 'true', created.headers.location], 'compiled: the same-key replay carries the same Location');
      const randomId = randomUUID();
      SECRETS.add(randomId);
      for (const [label, id] of [['foreign', SEED_B[0].id], ['random', randomId]]) {
        assertBounded404(await ctx.req('GET', `${CUSTOMER_DIRECTORY_PATH}/${id}`, { cookie: session.cookie, ...csrfOf(session.cookie) }), `compiled: ${label}`);
      }
      assertRefusal(await ctx.req('GET', `${CUSTOMER_DIRECTORY_PATH}/${customer.id.toUpperCase()}`, { cookie: session.cookie, ...csrfOf(session.cookie) }), 400,
        'invalid_request', 'compiled: an uppercase id');
      // M7A-CUSTOMERS-P6: the compiled artifact carries the contacts and the profile read — a create with both contacts, and
      // its profile with the database's creation time; the name-only create above has no contact.
      const contacts = { phone: '+1 555 0142', email: `m7te-c1-${SUFFIX}@example.test` };
      SECRETS.add(contacts.email);
      const withContacts = await createWith(ctx, session, { name, ...contacts });
      assert.equal(withContacts.status, 201, `compiled create with contacts: ${withContacts.body}`);
      const contactId = JSON.parse(withContacts.body).customer.id;
      SECRETS.add(contactId);
      const profile = profileBody(await profileOf(ctx, session.cookie, contactId), 'compiled profile');
      assert.deepEqual({ ...profile, createdAt: null }, { id: contactId, name, ...contacts, createdAt: null });
      assert.equal(new Date(profile.createdAt).toISOString(), profile.createdAt, 'compiled profile: toISOString\'s form');
      const nameOnly = profileBody(await profileOf(ctx, session.cookie, customer.id), 'compiled profile, name only');
      assert.deepEqual([nameOnly.id, nameOnly.name, nameOnly.phone, nameOnly.email], [customer.id, name, null, null]);
      assert.equal(new Date(nameOnly.createdAt).toISOString(), nameOnly.createdAt, 'a name-only create has a creation time too');
      assertBounded404(await profileOf(ctx, session.cookie, SEED_B[0].id), 'compiled profile: foreign');

      ctx.cap.proc.emit('SIGTERM');
      await waitFor(() => ctx.cap.codes.length > 0, 5_000);
      assert.deepEqual(ctx.cap.codes, [0], 'the compiled entry stops cleanly, exit 0');
      assert.deepEqual(ctx.ends, { calls: 1, completed: 1 }, 'and ends its kernel exactly once');
    });
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('M7TE-13: no captured log line carries a configuration value, a key, a proof, a session identifier or key, a token, a customer name or id (the detail reads\' own and foreign ids included), or a cursor', () => {
  const forbidden = [
    'synthetic-pw',
    ...['hex', 'base64', 'base64url'].flatMap((e) => [RATE_KEY.toString(e), ISSUER_KEY.toString(e), IDEMPOTENCY_KEY.toString(e)]),
    ...FIREBASE_PRIVATE_KEY.split('\n').filter((line) => line.length > 20 && !line.startsWith('-----')),
    ...SECRETS,
  ];
  assert.ok(ALL_LOG_LINES.length > 0 && SECRETS.size > 0, 'log lines and secrets were actually captured across the suite');
  for (const line of ALL_LOG_LINES) {
    for (const needle of forbidden) assert.ok(!line.includes(needle), `a log line leaked a value: ${String(needle).slice(0, 6)}...`);
  }
});

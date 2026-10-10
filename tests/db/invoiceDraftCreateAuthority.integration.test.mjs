// Phase 4.0 M7B-INVOICES-P1-R3 — the Invoices authority of an invoice-draft SAVE held through its newly sealed outcome, at
// ROUTINE level against REAL PostgreSQL: migration 031's tmpos_invoice_edit.m7b_invoice_draft_create_v2 — migration 028's save
// routine with exactly three changes: step 10 reads the customer and no longer answers; step 10b takes migration 030's advisory
// key (530030, hashtext(tenant || '/' || role)) SHARED, reads the database clock again and decides the Invoices level again by
// a plain SELECT, then step 10c answers 'customer_not_found'; steps 11-12 lose the Invoices anchor and its FOR SHARE — and
// 031's rollback. Every save is bound as the production adapter binds it (server/persistence/postgresInvoiceDrafts.ts: the lines
// serialized once as jsonb text, every bigint as decimal text), as the runtime's own non-owner login (tmpos_icr_probe, holding
// tmpos_app and tmpos_audit_writer) unless a case says it runs as the routine's OWNER to read its own uncommitted rows. The
// narrowing writer is the REAL setter (026's tmpos_role_invoice.m7a_invoice_role_level_set, as the runtime login) run by a THIRD
// operator — a store owner holding exactly one tenant grant, never the actor whose save is under test, so no shared account lock
// (016's hold takes the account FOR UPDATE) can serialize a race — or, where a case says so, an owner's direct write. The
// routine under test is CREATE_FN, the single place it is named.
//
// Case labels: R = red on the entry source c4ba482 (migrations 001-030; the save runs 028's routine) for the defect DA-210 — none
// here (DA-210's red reproductions are tests/db/invoiceDraftCreateAuthorityHttp.integration.test.mjs's ICA-01 and ICA-02); N =
// the new contract of migration 031; G = a guard that holds before and after. A case that mixes them says which block is which.
//
// WHAT IS PROVEN (each title carries the stage brief's acceptance criterion).
//   ICA-05 (AC-06, N/G) NO CONFIGURATION ANCHOR. For each editable role (manager, technician, sales_staff), read inside the save's
//          own transaction (run as the routine's owner, then rolled back): with no stored row — and, for the technician, whose
//          catalog default View refuses, with only the owner's stored Create — 'tenant_mismatch', 'customer_not_found' and a
//          refusal (the default View, a stored narrowing to View) write no role row and no version row [G]; the applied path
//          writes exactly the role's Customers NULL anchor and NO Invoices row [N: 028 also wrote an Invoices anchor]; a save
//          that reached 10b holds exactly the role's key SHARED and nothing else of any advisory class, one refused before it
//          holds none [N]. A store owner's 'tenant_mismatch', 'customer_not_found' and applied save take NO advisory lock and
//          write no role row [G: unchanged since 028]; in a separate subtest, a manager's save at the same point holds exactly
//          the key SHARED (the positive control) [N].
//   ICA-06 (AC-07, N) A FRESH DECISION AFTER EVERY WAIT. (a) the REAL setter's narrowing of the manager's Invoices level to View
//          held uncommitted (absent row: its first insertion; stored Full: an update) holds the key EXCLUSIVE; a save with a
//          missing and with an existing customer is seen waiting on exactly that key (one ungranted advisory ShareLock, classid
//          530030, objid the key, objsubid 2, behind the writer's pid); the writer commits -> ('refused', NULLs), nothing of
//          the save written (no Customers anchor, draft or line; the role and version rows exactly the setter's). (b) the same
//          barrier, the writer rolled back -> 'customer_not_found' (no row) and 'applied' (the Customers NULL anchor only).
//          (c) POST-WAIT EXPIRY, NOT A TIMEOUT: two managers' 8 s sessions (IDE-19's pattern); an owner's uncommitted FIRST
//          non-NULL INSERT of the manager's Invoices level (Create: it would admit the save) holds the key; each save — a
//          missing and an existing customer — runs on an OWNER connection whose lock_timeout and statement_timeout are 0 (read
//          inside the transaction), is seen waiting on the key while its session is live on the DATABASE clock, keeps waiting
//          until the database clock has passed the session's expiry, and is released only then by the writer's ROLLBACK (the
//          level is the catalog default Full again); each answers ('refused', NULLs) and, inside its own transaction, has made
//          no role row: the missing customer is not 'customer_not_found' (so the refusal precedes 10c) and the existing one has
//          no Customers anchor (so it precedes step 11) — the clock read after the key.
//   ICA-07 (AC-08, N) ORDERINGS WITHOUT A NEW CYCLE — each a separate subtest; every participant commits or answers, none ends in
//          40P01, every wait claimed is first seen in pg_locks: (1) a save holding the key ('applied' and 'customer_not_found')
//          -> the setter waits on it (an advisory ExclusiveLock), both finish; (2) the setter holding the key -> the save waits
//          (an advisory ShareLock), both finish, the save on the committed level; (3) a save waiting on its role's Customers row
//          behind 021's REAL Customers setter (holding the key SHARED, granted) while an Invoices setter waits on the save's
//          key: all three finish; (4) a save waiting on the customer behind 024's REAL customer edit (FOR UPDATE; the save holds
//          the key) while an Invoices setter waits on the save's key: all three finish; (5) a save and an edit v2 of one role,
//          in both orders, hold the key SHARED at once and neither waits; (6) a later save queued on the key behind a setter
//          that waits behind an earlier save: all finish, the later save refused on the committed narrowing; (7) an owner
//          holding the role's Invoices row FOR UPDATE (no key taken) does not block a save at all — it applies.
//   ICA-11 (AC-14, N) PRIVILEGES AND DEPENDENCIES: the runtime login's EXECUTE on 028's routine refused (42501), on create_v2
//          allowed; create_v2 plpgsql, SECURITY DEFINER, VOLATILE, pinned search_path and row_security, owned by the applier,
//          028's arguments and RETURNS TABLE, 031's comment, its complete ACL exactly the owner's and tmpos_app's EXECUTE
//          (owner-granted, non-grantable), 028's exactly the owner's; no other runtime role executes either; 030's rollback,
//          run as the executor's down path runs it (the down file and its ledger row, one READ COMMITTED transaction), on this
//          001-031 database is REFUSED with 2BP01 (its plain DROP SCHEMA meets create_v2) and changes nothing — the trigger, v2,
//          the guard function, create_v2, the schema and every grant identical, the ledger identical; STATIC: the installed
//          create_v2 is the up file's body, 028's routine its own, and create_v2's code equals 028's with exactly the three
//          changes (the method is stated in the case), the key after the step-10 read, in the outermost block, before the
//          'customer_not_found' answer and the Customers anchor, its expression the guard function's, no Invoices anchor or
//          Invoices row lock.
//   ICA-10 (AC-13, N) 031 DOWN / UP / DOWN over drafts at version 1 and edited above it, stored overrides, absent defaults, a
//          real setter's version row, an audit record, an outbox event and two idempotency records (a sealed completion and an
//          open lease): an up over the applied chain refused; the down (the executor's down path) — every row identical; the
//          exact 030-era surface (create_v2 gone; 028's ACL the owner's and tmpos_app's EXECUTE again, owner-granted and
//          non-grantable; tmpos_invoice_edit exactly 030's two functions, each with its body, ACL, attributes and comment; the
//          schema's ACL and comment; the level table's two triggers, ENABLE ALWAYS; v2's grant) and 030's postcondition; the
//          001-031 runtime refuses what is left; the login executes 028's routine again and create_v2 no longer exists; a
//          second down refused; the up refused (each in a rolled-back owner transaction) with 030's guard trigger disabled,
//          enabled in origin mode only or dropped, and with 028's ACL widened, narrowed or grantable; the up waits for an
//          in-flight save and an in-flight setter and finishes (no deadlock); THE UPGRADE 030 -> 031 by the trusted executor —
//          every row identical, the same surface as the first apply, the ledger 001-031, the preflight accepting; the down
//          again waits for an in-flight save, an in-flight setter and a setter queued on the key behind a save, and finishes
//          (rolled back; inside it the exact 030-era surface and every row identical).
//
// DISPOSABLE ONLY. The harness's resolved target: a supplied CI service when one is bound, otherwise a cluster this file creates
// and destroys; assertDisposableTestDsn refuses anything else before a statement runs. Every fixture is synthetic and randomly
// suffixed; every id and key is made at run time. It rolls 031 back and restores it (ICA-10) and runs 030's rollback to its
// refusal (ICA-11), so on a shared service it runs after every step that rolls 028 back. It leaves 031 applied, the ledger
// 001-031, the issuer key row it found, and NO draft, line, audit subject, role row, session, mint-ledger row, synthetic audit,
// outbox or idempotency row, or login of its own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { installTestIssuerKey, resolveDisposableTarget, testClient, testDriver } from './localPostgres.harness.mjs';
import { rollBackAbove } from './migrationsThrough.mjs';
import { assertDisposableTestDsn, createPostgresExecutor, runTrustedApply } from '../../server/platform-identity/migrationExecutor.ts';
import { createNodeFsPort } from '../../server/platform-identity/migrationEngine.ts';
import { REQUIRED_MIGRATIONS, createPostgresStartupPreflight } from '../../server/persistence/postgresStartupPreflight.ts';
import { runtimeClientOptions } from '../../server/platform-identity/db.ts';
import { createSupervisedPgClient } from '../../server/persistence/supervisedPgClient.ts';
import { TENANT_ROLE_PERMISSION_DEFAULTS } from '../../server/platform-identity/permissionCatalog.ts';
import { principalKeyOf } from '../../server/runtime/sessions.ts';

const MIG_REL = 'server/platform-identity/migrations';
const MIG_DIR = new URL(`../../${MIG_REL}/`, import.meta.url).pathname.replace(/\/$/, '');
const UP_028 = readFileSync(`${MIG_DIR}/028_m7b_invoice_drafts.up.sql`, 'utf8');
const UP_030 = readFileSync(`${MIG_DIR}/030_m7b_invoice_edit_authority.up.sql`, 'utf8');
const DOWN_030 = readFileSync(`${MIG_DIR}/030_m7b_invoice_edit_authority.down.sql`, 'utf8');
const UP_031 = readFileSync(`${MIG_DIR}/031_m7b_invoice_create_authority.up.sql`, 'utf8');
const DOWN_031 = readFileSync(`${MIG_DIR}/031_m7b_invoice_create_authority.down.sql`, 'utf8');
/** Each up file's last DO block, its postcondition, run again on its own. */
const POSTCONDITION_030 = UP_030.slice(UP_030.lastIndexOf('do $$'));
const POSTCONDITION_031 = UP_031.slice(UP_031.lastIndexOf('do $$'));
/** The save routine the suite's create() calls, by name: the single place the routine under test is named. */
const CREATE_FN = 'tmpos_invoice_edit.m7b_invoice_draft_create_v2';
/** 028's save routine by name (create() calls it with { fn }): the contract 031's rollback restores. */
const CREATE_FN_028 = 'tmpos_invoice_draft.m7b_invoice_draft_create';
const SAVE_ARGS = '(text, uuid, uuid, uuid, uuid, jsonb, bigint)';
/** The two save routines as the catalog names them (never derived from CREATE_FN: the catalog checks name them exactly). */
const CREATE_V2 = `tmpos_invoice_edit.m7b_invoice_draft_create_v2${SAVE_ARGS}`;
const CREATE_028 = `tmpos_invoice_draft.m7b_invoice_draft_create${SAVE_ARGS}`;
const UPDATE_FN = 'tmpos_invoice_edit.m7b_invoice_draft_update_v2';
const UPDATE_V2 = `${UPDATE_FN}(text, uuid, uuid, uuid, bigint, uuid, jsonb, bigint)`;
const GUARD = 'tmpos_invoice_edit.m7b_invoice_level_guard()';
/** The class of the advisory key every Invoices-level writer, the edit and the save take: pg_locks.classid, objsubid 2. */
const GUARD_CLASS = 530_030;
const MIGRATOR = { purpose: 'migration', migratorRef: 'icr-migrator', runtimeRef: 'icr-runtime' };
const LOCK_KEY = 531_032;
const NOW = () => new Date().toISOString();
const SUFFIX = randomUUID().slice(0, 8);
const RUNTIME_LOGIN = 'tmpos_icr_probe';
const HOUR = 3_600_000;
const ROLLBACK = new Error('icr: roll the proof back');
const RC = 'isolation level read committed';
const ISSUER_KEY = randomBytes(32);
const EDITABLE = ['manager', 'technician', 'sales_staff'];
const NULLS = Object.freeze({ o_tenant_id: null, o_store_id: null, o_actor_id: null, o_membership_id: null });
const answer = (outcome) => ({ o_outcome: outcome, ...NULLS });
const REFUSED = answer('refused');
const NO_ROWS = Object.freeze({ roles: [], versions: [] });
/** The seven tables 030's and 031's files lock first, in the writers' order. */
const WRITERS_ORDER = ['public.store', 'tmpos_role.tenant_role_level', 'tmpos_role_edit.role_level_version', 'tmpos_customer.customer',
  'tmpos_invoice_draft.invoice_draft', 'tmpos_invoice_draft.invoice_draft_line', 'public.audit_event'];

// ---------------------------------------------------------------------------
// the mint construction, computed here independently of the runtime's own (027's and 028's suites')
// ---------------------------------------------------------------------------

const netstring = (s) => {
  const bytes = Buffer.from(s, 'utf8');
  return Buffer.concat([Buffer.from(`${bytes.length}:`), bytes, Buffer.from(',')]);
};
const mintMessage = (key, r, expiresAt) => Buffer.concat([Buffer.from('tmpos-tenant-session-mint:v1'),
  ...[key, r.audience, r.authProvider, r.authProviderUid, r.principalKey, r.securityVersion,
    r.authenticatedAt === null ? '' : r.authenticatedAt, r.createdAt, r.lastSeenAt, r.validatedAt, expiresAt]
    .map((v) => netstring(String(v)))]);
const proofOf = (issuer, key, r, expiresAt) => createHmac('sha256', issuer).update(mintMessage(key, r, expiresAt)).digest();
const newKey = () => createHash('sha256').update(randomBytes(32).toString('base64url')).digest('base64url');

// ---------------------------------------------------------------------------
// cluster lifecycle
// ---------------------------------------------------------------------------

const TARGET = resolveDisposableTarget('ICA');
const TARGET_DSN = TARGET.dsn;
const cluster = TARGET.cluster ?? null;
assertDisposableTestDsn(TARGET_DSN);
const DATABASE = new URL(TARGET_DSN).pathname.slice(1);

function driverDsn(raw, user) {
  const url = new URL(raw);
  url.search = '';
  if (user !== undefined) { url.username = user; url.password = ''; }
  return url.toString();
}
const connect = (user, max) => testClient(TARGET, { ...(user === undefined ? {} : { user }), max, onnotice: () => {} });

const owner = connect(undefined, 6);
let runtime = null;
const UIDS = [];
const TENANTS = [];
const KEYS = new Set();
/** ICA-10's synthetic rows, removed by the case and again by the teardown. */
const SYNTHETIC = { audits: [], events: [], scopes: [] };
let issuerKeyBefore;

async function trustedApply() {
  const handle = await createPostgresExecutor(assertDisposableTestDsn(TARGET_DSN));
  try {
    return await runTrustedApply({
      fsPort: createNodeFsPort(MIG_DIR, MIG_REL), adapter: handle.adapter, ledger: handle.ledger,
      connectionMode: 'session', credential: MIGRATOR, lockKey: LOCK_KEY, now: NOW, deadlineMs: 180_000,
    });
  } finally {
    await handle.dispose();
  }
}

/** Runs `fn(tx)` with 002's append-only audit trigger lifted, restored in exactly the mode it was found in. */
async function withAuditUnlocked(tx, fn) {
  const [{ mode }] = await tx`select tgenabled as mode from pg_catalog.pg_trigger
    where tgrelid = 'public.audit_event'::regclass and tgname = 'trg_audit_event_reject_mutation'`;
  const restore = { O: 'enable trigger', D: 'disable trigger', R: 'enable replica trigger', A: 'enable always trigger' }[mode];
  assert.ok(restore, `the append-only trigger's mode is known: ${mode}`);
  await tx.unsafe('alter table public.audit_event disable trigger trg_audit_event_reject_mutation');
  await fn();
  await tx.unsafe(`alter table public.audit_event ${restore} trg_audit_event_reject_mutation`);
}

/** ICA-10's synthetic audit, outbox and idempotency rows (an audit record naming a draft would block nothing, but is this suite's). */
async function removeSynthetic() {
  await owner.begin(RC, async (sql) => {
    if (SYNTHETIC.audits.length > 0) {
      await withAuditUnlocked(sql, () => sql`delete from public.audit_event where request_id = any(${SYNTHETIC.audits}::text[])`);
    }
    if (SYNTHETIC.events.length > 0) await sql`delete from tmpos_internal.outbox_event where event_id = any(${SYNTHETIC.events}::uuid[])`;
    if (SYNTHETIC.scopes.length > 0) await sql`delete from tmpos_internal.idempotency_record where scope = any(${SYNTHETIC.scopes}::text[])`;
  });
}

/** Everything this suite wrote that a later rollback of 031, 030, 029 or 028 would refuse over: drafts, lines, anchors, subjects. */
async function cleanDrafts() {
  if (TENANTS.length === 0) return;
  await owner.begin(RC, async (sql) => {
    const drafts = (await sql`select draft_id from tmpos_invoice_draft.invoice_draft where tenant_id = any(${TENANTS}::uuid[])`).map((r) => r.draft_id);
    if (drafts.length > 0) {
      await withAuditUnlocked(sql, () => sql`update public.audit_event set subject_invoice_draft_id = null where subject_invoice_draft_id = any(${drafts}::uuid[])`);
    }
    await sql`delete from tmpos_invoice_draft.invoice_draft_line where tenant_id = any(${TENANTS}::uuid[])`;
    await sql`delete from tmpos_invoice_draft.invoice_draft where tenant_id = any(${TENANTS}::uuid[])`;
    await sql`delete from tmpos_role_edit.role_level_version where tenant_id = any(${TENANTS}::uuid[])`;
    await sql`delete from tmpos_role.tenant_role_level where tenant_id = any(${TENANTS}::uuid[])`;
  });
}

test.after(async () => {
  const failures = [];
  const step = async (fn) => { try { await fn(); } catch (err) { failures.push(err); } };
  try {
    await step(removeSynthetic);
    // A failed ICA-10 may have left 031 rolled back: the executor applies it again.
    await step(async () => {
      if (!(await owner`select exists (select 1 from public.schema_migrations where version = '031') as applied`)[0].applied) {
        const report = await trustedApply();
        assert.equal(report.outcome, 'complete', JSON.stringify(report).slice(0, 300));
      }
    });
    await step(cleanDrafts);
    if (UIDS.length > 0) {
      await step(async () => {
        for (const row of await owner`select session_key from tmpos_session.session where auth_provider_uid = any(${UIDS}::text[])`) KEYS.add(row.session_key);
      });
    }
    if (KEYS.size > 0) await step(() => owner`delete from tmpos_mint.tenant_session where session_key = any(${[...KEYS]}::text[])`);
    if (UIDS.length > 0) await step(() => owner`delete from tmpos_session.session where auth_provider_uid = any(${UIDS}::text[])`);
    if (issuerKeyBefore !== undefined) {
      await step(() => owner.begin(async (sql) => {
        await sql`delete from tmpos_mint.issuer_key where singleton`;
        if (issuerKeyBefore !== null) await sql`insert into tmpos_mint.issuer_key (singleton, key) values (true, ${issuerKeyBefore})`;
      }));
    }
    if (runtime) await step(() => runtime.end({ timeout: 5 }));
    await step(() => owner`select pg_catalog.pg_terminate_backend(pid, 5000) from pg_catalog.pg_stat_activity where usename = ${RUNTIME_LOGIN}`);
    await step(() => owner.unsafe(`do $$ begin
      if exists (select 1 from pg_catalog.pg_roles where rolname = '${RUNTIME_LOGIN}') then execute 'drop owned by ${RUNTIME_LOGIN}'; end if;
    end $$;`));
    await step(() => owner.unsafe(`drop role if exists ${RUNTIME_LOGIN}`));
    await step(async () => {
      const [state] = await owner`select
          pg_catalog.to_regprocedure(${CREATE_V2}) is not null as routine_031,
          exists (select 1 from public.schema_migrations where version = '031') as ledger_031,
          (select count(*) from tmpos_invoice_draft.invoice_draft where tenant_id = any(${TENANTS}::uuid[]))::int as drafts,
          (select count(*) from public.audit_event where subject_invoice_draft_id is not null and tenant_id = any(${TENANTS}::uuid[]))::int as subjects,
          (select count(*) from tmpos_role.tenant_role_level where tenant_id = any(${TENANTS}::uuid[]))::int as anchors,
          (select count(*) from tmpos_session.session where auth_provider_uid = any(${UIDS}::text[]))::int as sessions,
          (select count(*) from public.audit_event where request_id = any(${SYNTHETIC.audits}::text[]))::int as audits,
          (select count(*) from tmpos_internal.outbox_event where event_id = any(${SYNTHETIC.events}::uuid[]))::int as events,
          (select count(*) from tmpos_internal.idempotency_record where scope = any(${SYNTHETIC.scopes}::text[]))::int as records,
          exists (select 1 from pg_catalog.pg_roles where rolname = ${RUNTIME_LOGIN}) as login`;
      assert.deepEqual({ ...state }, { routine_031: true, ledger_031: true, drafts: 0, subjects: 0, anchors: 0, sessions: 0, audits: 0, events: 0, records: 0, login: false },
        'left as found: 031 applied and recorded, nothing of this suite\'s retained');
    });
  } finally {
    await step(() => owner.end({ timeout: 5 }));
    if (cluster) cluster.stop();
  }
  if (failures.length > 0) throw new AggregateError(failures, 'ICA routine teardown: a cleanup step or postcondition failed');
});

// ---------------------------------------------------------------------------
// setup: every migration in the directory (001-031), a real non-owner runtime login, the issuer key installed by the owner
// ---------------------------------------------------------------------------

await owner.unsafe(`do $$ begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;`);
await owner.unsafe(`revoke create on database "${DATABASE}" from public`);
await owner.unsafe(`revoke temporary on database "${DATABASE}" from public`);
const applyReport = await trustedApply();
assert.equal(applyReport.outcome, 'complete', JSON.stringify(applyReport).slice(0, 400));
await owner.unsafe(`do $$ begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = '${RUNTIME_LOGIN}') then execute 'drop owned by ${RUNTIME_LOGIN}'; end if;
end $$;`);
await owner.unsafe(`drop role if exists ${RUNTIME_LOGIN}`);
await owner.unsafe(`create role ${RUNTIME_LOGIN} login nosuperuser nocreatedb nocreaterole noreplication nobypassrls inherit`);
await owner.unsafe(`grant tmpos_app to ${RUNTIME_LOGIN}`);
await owner.unsafe(`grant tmpos_audit_writer to ${RUNTIME_LOGIN}`);
await owner.unsafe(`grant select on public.schema_migrations to ${RUNTIME_LOGIN}`);
runtime = connect(RUNTIME_LOGIN, 5);
issuerKeyBefore = (await owner`select key from tmpos_mint.issuer_key where singleton`)[0]?.key ?? null;
if (issuerKeyBefore !== null) issuerKeyBefore = Buffer.from(issuerKeyBefore);
await installTestIssuerKey(owner, ISSUER_KEY);
const ME = (await owner`select current_user::text as me`)[0].me;

// ---------------------------------------------------------------------------
// fixtures (owner connection, synthetic)
// ---------------------------------------------------------------------------

const newTenant = async (label, status = 'active') => {
  const [{ tenant_id: id }] = await owner`insert into tenant (display_name, status) values (${`icr-${label}-${SUFFIX}`}, ${status}) returning tenant_id`;
  TENANTS.push(id);
  return id;
};
const newStore = async (tenant, name, status = 'active') =>
  (await owner`insert into store (tenant_id, store_name, status) values (${tenant}, ${name}, ${status}) returning store_id`)[0].store_id;
const newCustomer = async (tenant, label) => {
  const id = randomUUID();
  await owner`insert into tmpos_customer.customer (customer_id, tenant_id, name) values (${id}, ${tenant}, ${`ICR ${label} ${SUFFIX}`})`;
  return id;
};
async function actor(label, memberships, accountStatus = 'active') {
  const uid = `icr-${label}-${SUFFIX}`;
  const [{ internal_user_id: id }] = await owner`
    insert into platform_identity (auth_provider, auth_provider_uid) values ('firebase', ${uid}) returning internal_user_id`;
  await owner`insert into app_user (internal_user_id, status) values (${id}, ${accountStatus})`;
  const memberships_ = [];
  for (const m of memberships) {
    const [{ membership_id: mid }] = await owner`insert into user_membership (internal_user_id, tenant_id, store_id, scope_type, role_id, status)
      values (${id}, ${m.tenant}, ${m.store ?? null}, ${m.scope}, ${m.role}, ${m.status ?? 'active'}) returning membership_id`;
    memberships_.push(mid);
  }
  UIDS.push(uid);
  return { id, uid, label, memberships: memberships_, principal: Object.freeze({ authProvider: 'firebase', authProviderUid: uid }) };
}
const storeGrant = (tenant, store, role) => ({ scope: 'store', tenant, store, role });
const tenantGrant = (tenant, role) => ({ scope: 'tenant', tenant, role });
/** The tenant owner's stored level for `role` on `domain` (020's table, as the role-level suites write it; an owner's direct write). */
const setLevel = (tenant, role, domain, level) => owner`insert into tmpos_role.tenant_role_level (tenant_id, role_id, domain, level, updated_at)
  values (${tenant}, ${role}, ${domain}, ${level}, now()) on conflict (tenant_id, role_id, domain) do update set level = excluded.level, updated_at = excluded.updated_at`;

// ---------------------------------------------------------------------------
// the runtime login's calls, bound as the production adapters bind them
// ---------------------------------------------------------------------------

const record = (who, at = Date.now()) => ({
  audience: 'tenant', authProvider: 'firebase', authProviderUid: who.uid, principalKey: principalKeyOf(who.principal),
  securityVersion: 't2:icr', authenticatedAt: at, createdAt: at, lastSeenAt: at, validatedAt: at,
});
async function mint(who, { lifetime = 8 * HOUR } = {}) {
  const key = newKey();
  const r = record(who);
  const expiresAt = r.createdAt + lifetime;
  KEYS.add(key);
  const [{ outcome }] = await runtime`select tmpos_mint.m7a_session_create(${key}::text, ${r.audience}::text, ${r.authProvider}::text,
    ${r.authProviderUid}::text, ${r.principalKey}::text, ${r.securityVersion}::text, ${r.authenticatedAt}::bigint,
    ${r.createdAt}::bigint, ${r.lastSeenAt}::bigint, ${r.validatedAt}::bigint, ${expiresAt}::bigint,
    ${proofOf(ISSUER_KEY, key, r, expiresAt)}::bytea) as outcome`;
  assert.equal(outcome, 'created', `a tenant session for ${who.uid}`);
  return key;
}
const line = (description, quantity, unitPriceCents) => ({ description, quantity, unitPriceCents });
const sumOf = (lines) => lines.reduce((s, l) => s + BigInt(l.quantity) * BigInt(l.unitPriceCents), 0n);
const LINES = [line('Screen replacement', 1, 12_999), line('Labour  (1 hr)', 2, 4_500), line('Tempered glass ' + String.fromCodePoint(0x1f4f1), 3, 0)];
/** The save (CREATE_FN; `fn` names another with the same signature, 028's), bound as the create mutator binds it: its rows. */
async function create(key, store, tenant, customer, lines = LINES, { db = runtime, fn = CREATE_FN, draft = randomUUID() } = {}) {
  return (await db.unsafe(`select o_outcome, o_tenant_id, o_store_id, o_actor_id, o_membership_id
    from ${fn}($1::text, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::text::jsonb, $7::bigint)`,
  [key, store, draft, tenant, customer, JSON.stringify(lines), String(sumOf(lines))])).map((r) => ({ ...r }));
}
/** The applied answer of `who`'s save at (tenant, store). */
const saved = (who, tenant, store) => ({ o_outcome: 'applied', o_tenant_id: tenant, o_store_id: store, o_actor_id: who.id, o_membership_id: who.memberships[0] });
/** A save that must apply: the new draft's id. */
async function save(who, key, store, tenant, customer, lines = LINES, { db = runtime, fn = CREATE_FN } = {}) {
  const draft = randomUUID();
  assert.deepEqual(await create(key, store, tenant, customer, lines, { db, fn, draft }), [saved(who, tenant, store)], `${who.label}'s save applied`);
  return draft;
}
/** 030's edit v2, bound as the update mutator binds it. */
async function edit(key, store, tenant, draft, version, customer, lines, { db = runtime } = {}) {
  return (await db.unsafe(`select o_outcome, o_tenant_id, o_store_id, o_actor_id, o_membership_id, o_version
    from ${UPDATE_FN}($1::text, $2::uuid, $3::uuid, $4::uuid, $5::bigint, $6::uuid, $7::text::jsonb, $8::bigint)`,
  [key, store, draft, tenant, String(version), customer, JSON.stringify(lines), String(sumOf(lines))])).map((r) => ({ ...r }));
}
const edited = (who, tenant, store, version) => ({ o_outcome: 'applied', o_tenant_id: tenant, o_store_id: store, o_actor_id: who.id,
  o_membership_id: who.memberships[0], o_version: String(version) });
/** 026's Invoices setter, the REAL writer, as the runtime login (or on `db`): the answer's version as a number. */
const setInvoices = async (key, role, level, tenant, version, db = runtime) => (await db`select o_outcome, o_tenant_id, o_actor_id, o_membership_id, o_level, o_version
  from tmpos_role_invoice.m7a_invoice_role_level_set(${key}::text, ${role}::text, ${level}::text, ${tenant}::uuid, ${String(version)}::bigint)`)
  .map((r) => ({ ...r, o_version: r.o_version === null ? null : Number(r.o_version) }));
/** 021's Customers setter, the REAL writer of a Customers level, as the runtime login (or on `db`). */
const setCustomers = async (key, role, level, tenant, version, db = runtime) => (await db`select o_outcome, o_tenant_id, o_actor_id, o_membership_id, o_level, o_version
  from tmpos_role_edit.m7a_role_level_set_v2(${key}::text, ${role}::text, 'customers'::text, ${level}::text, ${tenant}::uuid, ${String(version)}::bigint)`)
  .map((r) => ({ ...r, o_version: r.o_version === null ? null : Number(r.o_version) }));
/** 024's customer edit, the REAL writer of a customer row (its name only), as the runtime login (or on `db`). */
const editCustomer = async (key, customer, tenant, version, name, db = runtime) => (await db`select o_outcome, o_tenant_id, o_actor_id, o_membership_id, o_version
  from tmpos_customer_edit.m7a_customer_update(${key}::text, ${customer}::uuid, ${tenant}::uuid, ${String(version)}::bigint, ${name}::text,
    false, null::text, false, null::text)`).map((r) => ({ ...r, o_version: r.o_version === null ? null : Number(r.o_version) }));
const setterApplied = (own, tenant, level, version) => ({ o_outcome: 'applied', o_tenant_id: tenant, o_actor_id: own.who.id,
  o_membership_id: own.who.memberships[0], o_level: level, o_version: version });
const errorOf = (p) => Promise.resolve(p).then(() => null, (err) => ({ code: err.code, message: String(err.message), detail: err.detail ?? null }));

/** What a scope holds now: drafts, lines and role rows of its tenant(s); every audit record, outbox event and idempotency record. */
async function footprint(tenants, db = owner) {
  const [r] = await db`select
    (select count(*) from tmpos_invoice_draft.invoice_draft where tenant_id = any(${tenants}::uuid[]))::int as drafts,
    (select count(*) from tmpos_invoice_draft.invoice_draft_line where tenant_id = any(${tenants}::uuid[]))::int as lines,
    (select count(*) from tmpos_role.tenant_role_level where tenant_id = any(${tenants}::uuid[]))::int as roles,
    (select count(*) from tmpos_role_edit.role_level_version where tenant_id = any(${tenants}::uuid[]))::int as versions,
    (select count(*) from public.audit_event)::int as audits,
    (select count(*) from tmpos_internal.outbox_event)::int as events,
    (select count(*) from tmpos_internal.idempotency_record)::int as records`;
  return { ...r };
}
/** The counts a save's refusal must leave as they were (the role and version rows are compared exactly, separately). */
const writes = async (tenants) => { const { roles, versions, ...rest } = await footprint(tenants); void roles; void versions; return rest; };
/** The role rows and edit counters of a tenant exactly as stored, row versions (xmin) included: a write by anyone moves them. */
async function invoicesRowsOf(tenant, db = owner) {
  return {
    roles: (await db`select role_id, domain, level, xmin::text as xmin from tmpos_role.tenant_role_level where tenant_id = ${tenant} order by role_id, domain`).map((r) => ({ ...r })),
    versions: (await db`select role_id, domain, version::text as version, xmin::text as xmin from tmpos_role_edit.role_level_version where tenant_id = ${tenant} order by role_id, domain`).map((r) => ({ ...r })),
  };
}
/** The same without the row versions: what the rows say. */
const strip = ({ roles, versions }) => ({ roles: roles.map(({ xmin, ...r }) => r), versions: versions.map(({ xmin, ...r }) => r) });
const byKey = (a, b) => (`${a.role_id}/${a.domain}` < `${b.role_id}/${b.domain}` ? -1 : 1);
/** The edit counter of (tenant, role, 'invoices') the setter reviews: 0 while there is no version row. */
const versionRowOf = async (tenant, role, domain = 'invoices') => Number((await owner`select coalesce((select v.version from tmpos_role_edit.role_level_version v
  where v.tenant_id = ${tenant} and v.role_id = ${role} and v.domain = ${domain}), 0)::text as version`)[0].version);
/** A diagnostic line the evidence is read from (printed by the runner whether the case passes or fails). */
const evidence = (t, what) => t.diagnostic(`EVIDENCE ${JSON.stringify(what)}`);
/** Runs `fn` in an owner transaction that is always rolled back: { value } or the { code, message } it raised. */
async function rolledBack(fn) {
  let out;
  await assert.rejects(owner.begin(RC, async (tx) => {
    out = await fn(tx).then((value) => ({ value }), (err) => ({ code: err.code, message: String(err.message) }));
    throw ROLLBACK;
  }), (err) => err === ROLLBACK);
  return out;
}

// ---------------------------------------------------------------------------
// race levers: polling on observable lock state, never on time
// ---------------------------------------------------------------------------

/** Polls `probe` until it answers truthy, or fails after `ms` (10 s): a lever that never engaged is a failure, never a pass. */
async function until(probe, what, ms = 10_000) {
  for (const end = Date.now() + ms; Date.now() < end;) {
    const value = await probe();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`lever did not engage: ${what}`);
}
/**
 * A transaction on `db` that runs `fn` and then holds everything it took, uncommitted, until `release('commit')` or
 * `release('rollback')`. `pid` is its backend; `ready` turns true once `fn` has answered (so a blocked `fn` is never ready).
 */
function holding(db, fn) {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const h = { pid: null, ready: false, release: (how) => release(how) };
  h.done = db.begin(RC, async (tx) => {
    h.pid = (await tx`select pg_catalog.pg_backend_pid() as pid`)[0].pid;
    const value = await fn(tx);
    h.ready = true;
    h.value = value;
    if ((await gate) === 'rollback') throw ROLLBACK;
    return value;
  }).then((value) => ({ outcome: 'committed', value }),
    (err) => (err === ROLLBACK ? { outcome: 'rolled back' } : { outcome: 'failed', code: err.code, message: String(err.message) }));
  h.done.then((out) => { h.out = out; });
  return h;
}
/** A statement on `db` in its own transaction (committed when it answers), its backend pid exposed as soon as it is known. */
function running(db, fn) {
  const r = { pid: null, out: null };
  r.done = db.begin(RC, async (tx) => {
    r.pid = (await tx`select pg_catalog.pg_backend_pid() as pid`)[0].pid;
    return fn(tx);
  }).then((value) => ({ outcome: 'committed', value }), (err) => ({ outcome: 'failed', code: err.code, message: String(err.message) }));
  r.done.then((out) => { r.out = out; });
  return r;
}
const blockedBy = async (pid, holder) => pid !== null && holder !== null
  && (await owner`select pg_catalog.pg_blocking_pids(${pid}) as b`)[0].b.includes(holder);
const queryOf = async (pid) => (await owner`select a.query from pg_catalog.pg_stat_activity a where a.pid = ${pid}`)[0]?.query ?? null;
/** 'waiting' once `r` is blocked behind `holder`, 'answered' once it answered without that: never a guess. */
const waitingOrAnswered = (r, holder, what) => until(async () => ((await blockedBy(r.pid, holder)) ? 'waiting'
  : (r.ready || (r.out !== null && r.out !== undefined)) ? 'answered' : false), what);
/** The ungranted locks `pid` waits for, as [locktype, mode] pairs. */
const waitsFor = async (pid) => (await owner`select l.locktype::text as locktype, l.mode::text as mode from pg_catalog.pg_locks l
  where l.pid = ${pid} and not l.granted order by 1, 2`).map((r) => [r.locktype, r.mode]);
/** The database clock, in epoch milliseconds (the routine's own reading). */
const dbNow = async () => BigInt((await owner`select pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp()) * 1000)::bigint::text as now`)[0].now);
/** The guard key of (tenant, role) as the database computes it: hashtext of 'tenant/role', an int4 (pg_locks.objid, read as int4). */
const guardKey = async (tenant, role) => (await owner`select pg_catalog.hashtext(${tenant}::text || '/' || ${role}::text) as k`)[0].k;
/** Every guard-class advisory lock `pid` holds or waits for: class, key (int4), objsubid, mode, granted — ordered. */
const guardLocksOf = async (pid) => (await owner`select l.classid::int as class, l.objid::int as key, l.objsubid::int as sub, l.mode::text as mode, l.granted
  from pg_catalog.pg_locks l where l.pid = ${pid} and l.locktype = 'advisory' and l.classid::int = ${GUARD_CLASS} order by 2, 4, 5`).map((r) => ({ ...r }));
/** The guard lock a participant holds or waits for on (tenant, role): ShareLock (a save or an edit) or ExclusiveLock (a writer). */
const guardLock = async (tenant, role, mode, granted = true) => ({ class: GUARD_CLASS, key: await guardKey(tenant, role), sub: 2, mode, granted });
/** The advisory locks of EVERY class `pid` holds or waits for (a fence or another suite's key would show here). */
const anyAdvisoryOf = async (pid) => (await owner`select l.classid::int as class, l.objid::int as key, l.objsubid::int as sub, l.mode::text as mode, l.granted
  from pg_catalog.pg_locks l where l.pid = ${pid} and l.locktype = 'advisory' order by 1, 2, 4`).map((r) => ({ ...r }));
/** `h` (holding) answers on its own — it is never seen waiting on a lock. */
async function readyUnblocked(h, label) {
  await until(async () => h.ready || h.out !== undefined
    || (h.pid !== null && (await owner`select wait_event_type from pg_catalog.pg_stat_activity where pid = ${h.pid}`)[0]?.wait_event_type === 'Lock'), label);
  assert.equal(h.ready, true, `${label}: it waited on a lock instead of answering (${JSON.stringify(h.out ?? null)})`);
}
/** Neither a deadlock victim nor any other failure: the transaction committed (or was rolled back by the case). */
function finished(out, label, how = 'committed') {
  assert.notEqual(out.code, '40P01', `${label}: a deadlock (${JSON.stringify(out)})`);
  assert.equal(out.outcome, how, `${label}: ${JSON.stringify(out)}`);
  return out;
}

/** A routine's body as a migration file declares it (between its `as $$` and the closing `$$;`). */
const routineBody = (file, schema, name) => {
  const at = file.indexOf(`create function ${schema}.${name}(`);
  assert.ok(at >= 0, `${schema}.${name} is declared`);
  const start = file.indexOf('as $$', at) + 'as $$'.length;
  return file.slice(start, file.indexOf('$$;', start));
};
/** The text of `comment on function <signature> is '...'` in a migration file, unescaped. */
const functionComment = (file, signature) => {
  const at = file.indexOf(`comment on function ${signature} is\n  '`);
  assert.ok(at >= 0, `the file comments ${signature}`);
  const start = file.indexOf("'", at) + 1;
  let end = start;
  while (file[end] !== "'" || file[end + 1] === "'") end += file[end] === "'" ? 2 : 1;
  return file.slice(start, end).replace(/''/g, "'");
};

// The tenant every 'tenant_mismatch' names (a real tenant the actors hold no grant in).
const T_OTHER = await newTenant('other');
assert.deepEqual(Object.fromEntries(EDITABLE.map((r) => [r, [TENANT_ROLE_PERMISSION_DEFAULTS[r].invoices, TENANT_ROLE_PERMISSION_DEFAULTS[r].customers]])),
  { manager: ['full', 'full'], technician: ['view', 'view'], sales_staff: ['create', 'create'] }, 'the catalog defaults the cases rely on');

/** A fresh tenant, store and two customers; its store owner (store grant: no role row ever) and a manager, with sessions. */
async function scene(label, { managerLevel } = {}) {
  const T = await newTenant(label);
  const S = await newStore(T, `${label} ${SUFFIX}`);
  const C1 = await newCustomer(T, `${label}-1`);
  const C2 = await newCustomer(T, `${label}-2`);
  const boss = await actor(`${label}-owner`, [storeGrant(T, S, 'store_owner')]);
  const manager = await actor(`${label}-manager`, [storeGrant(T, S, 'manager')]);
  if (managerLevel !== undefined) await setLevel(T, 'manager', 'invoices', managerLevel);
  return { T, S, C1, C2, boss, manager, kBoss: await mint(boss), kManager: await mint(manager) };
}
/** Another actor of `role` at the scene's store, with a live session of its own. */
async function member(f, label, role) {
  const who = await actor(`${label}-${role}-member`, [storeGrant(f.T, f.S, role)]);
  return { who, key: await mint(who) };
}
/** A third operator: a store owner with EXACTLY ONE tenant-scope grant on `tenant` (026's and 021's setters demand it), with a live session. */
async function tenantOwner(tenant, label) {
  const who = await actor(`${label}-tenant-owner`, [tenantGrant(tenant, 'store_owner')]);
  return { who, key: await mint(who) };
}
/**
 * The save in an OWNER transaction left open (the login reads none of its own uncommitted rows): its answer, the tenant's role
 * and version rows as that transaction sees them, and every advisory lock its backend holds once it answered — then rolled back.
 */
async function saveInOwnTransaction(f, key, customer, label, expectedTenant = f.T) {
  let seen = null;
  const held = holding(owner, async (tx) => {
    seen = { rows: await create(key, f.S, expectedTenant, customer, LINES, { db: tx }), levels: strip(await invoicesRowsOf(f.T, tx)) };
  });
  try {
    await until(() => held.ready || held.out !== undefined, `${label}: the save answered, its transaction open`);
    assert.equal(held.ready, true, `${label}: ${JSON.stringify(held.out)}`);
    seen.advisory = await anyAdvisoryOf(held.pid);
  } finally {
    held.release('rollback');
  }
  assert.equal((await held.done).outcome, 'rolled back', `${label}: rolled back`);
  return seen;
}

// ===========================================================================
// ICA-05: no configuration anchor
// ===========================================================================

test('ICA-05 (AC-06, N/G): for each editable role, tenant_mismatch, customer_not_found and a refusal write no role row and no version row; the applied path writes the Customers NULL anchor only, never an Invoices row; a save that reached the guard holds exactly the role\'s key SHARED; a store owner\'s saves take no key and write no row [G], beside a manager\'s positive control [N]', async (t) => {
  for (const role of EDITABLE) {
    await t.test(`${role}: tenant_mismatch, customer_not_found and a refusal write no role row and no version row [G]; the key is held only past step 9 [N]`, async (st) => {
      const f = await scene(`n05-${role}`);
      const { key } = await member(f, `n05-${role}`, role);
      const K = await guardLock(f.T, role, 'ShareLock');
      if (role === 'technician') {
        // Absent rows: the catalog default View refuses the save at step 8, before the key, writing nothing.
        assert.deepEqual(strip(await invoicesRowsOf(f.T)), NO_ROWS, 'technician: no stored row');
        const seen = await saveInOwnTransaction(f, key, f.C1, 'technician, the default View');
        assert.deepEqual(seen.rows, [REFUSED], 'technician, the default View: refused');
        assert.deepEqual(seen.levels, NO_ROWS, 'technician, the default View: no role row, no version row');
        assert.deepEqual(seen.advisory, [], 'technician, the default View: refused before the key, no advisory lock');
        // The owner's stored Create (the only row) admits it; every case below must add nothing to it.
        await setLevel(f.T, role, 'invoices', 'create');
      } else {
        assert.deepEqual(strip(await invoicesRowsOf(f.T)), NO_ROWS, `${role}: absent rows (its catalog default ${TENANT_ROLE_PERMISSION_DEFAULTS[role].invoices} governs)`);
      }
      const base = strip(await invoicesRowsOf(f.T));
      for (const [name, customer, expectedTenant, expected, holdsKey] of [
        ['tenant_mismatch', f.C1, T_OTHER, answer('tenant_mismatch'), false],
        ['customer_not_found (a missing id)', randomUUID(), f.T, answer('customer_not_found'), true],
        ['customer_not_found (another tenant\'s customer)', await newCustomer(T_OTHER, `n05-${role}-foreign`), f.T, answer('customer_not_found'), true],
      ]) {
        const label = `${role}, ${name}`;
        const seen = await saveInOwnTransaction(f, key, customer, label, expectedTenant);
        evidence(st, { case: `ICA-05 ${label}`, answer: seen.rows, levelsInsideItsTransaction: seen.levels, advisory: seen.advisory });
        assert.deepEqual(seen.rows, [expected], `${label}: the answer`);
        assert.deepEqual(seen.levels, base, `${label}: no role row and no version row added — not even inside its own transaction`);
        assert.deepEqual(seen.advisory, holdsKey ? [K] : [], holdsKey ? `${label}: answered past the guard, holding exactly the role's key SHARED`
          : `${label}: answered at step 9, before the key: no advisory lock`);
      }
      // A stored narrowing below Create: refused at step 8, before the key, adding nothing.
      await setLevel(f.T, role, 'invoices', 'view');
      const narrowed = strip(await invoicesRowsOf(f.T));
      const seen = await saveInOwnTransaction(f, key, f.C1, `${role}, narrowed to View`);
      evidence(st, { case: `ICA-05 ${role} narrowed`, answer: seen.rows, levelsInsideItsTransaction: seen.levels, advisory: seen.advisory });
      assert.deepEqual(seen.rows, [REFUSED], `${role}, narrowed to View: refused`);
      assert.deepEqual(seen.levels, narrowed, `${role}, narrowed to View: no role row and no version row added`);
      assert.deepEqual(seen.advisory, [], `${role}, narrowed to View: refused before the key`);
      const { drafts, lines } = await writes([f.T]);
      assert.deepEqual({ drafts, lines }, { drafts: 0, lines: 0 }, `${role}: every save rolled back, no draft or line remains`);
    });
    await t.test(`${role}: the applied path writes exactly the Customers NULL anchor — no Invoices row (the no-Invoices-row block) [N]`, async (st) => {
      const f = await scene(`a05-${role}`);
      const { who, key } = await member(f, `a05-${role}`, role);
      if (role === 'technician') await setLevel(f.T, role, 'invoices', 'create');
      const base = strip(await invoicesRowsOf(f.T));
      assert.deepEqual(base, role === 'technician' ? { roles: [{ role_id: role, domain: 'invoices', level: 'create' }], versions: [] } : NO_ROWS,
        `${role}: ${role === 'technician' ? 'the owner\'s stored Create only' : 'absent rows'}`);
      const seen = await saveInOwnTransaction(f, key, f.C1, `${role}, applied`);
      evidence(st, { case: `ICA-05 ${role} applied`, answer: seen.rows, levelsInsideItsTransaction: seen.levels, advisory: seen.advisory });
      assert.deepEqual(seen.rows, [saved(who, f.T, f.S)], `${role}: applied`);
      assert.deepEqual(seen.levels, { roles: [...base.roles, { role_id: role, domain: 'customers', level: null }].sort(byKey), versions: base.versions },
        `${role}: the save wrote exactly its role's Customers NULL anchor — no Invoices row, no version row`);
      assert.deepEqual(seen.advisory, [await guardLock(f.T, role, 'ShareLock')], `${role}: holding exactly the role's key SHARED`);
      assert.deepEqual(strip(await invoicesRowsOf(f.T)), base, `${role}: rolled back, nothing of it remains`);
    });
  }
  // One scene for both blocks below: the store owner's saves and, at the same point, the manager's positive control.
  const f = await scene('o05');
  await t.test('store_owner: tenant_mismatch, customer_not_found and applied take NO advisory lock of any class and write no role row [G]', async (st) => {
    for (const [name, customer, expectedTenant, expected] of [
      ['tenant_mismatch', f.C1, T_OTHER, answer('tenant_mismatch')],
      ['customer_not_found', randomUUID(), f.T, answer('customer_not_found')],
      ['applied', f.C1, f.T, saved(f.boss, f.T, f.S)],
    ]) {
      const seen = await saveInOwnTransaction(f, f.kBoss, customer, `the store owner, ${name}`, expectedTenant);
      evidence(st, { case: `ICA-05 store_owner ${name}`, answer: seen.rows, levelsInsideItsTransaction: seen.levels, advisory: seen.advisory });
      assert.deepEqual(seen.rows, [expected], `the store owner, ${name}: the answer`);
      assert.deepEqual(seen.levels, NO_ROWS, `the store owner, ${name}: no role row, no version row — not even inside its own transaction`);
      assert.deepEqual(seen.advisory, [], `the store owner, ${name}: no advisory lock of any class — no key taken`);
    }
  });
  await t.test('manager (the positive control beside the store owner): customer_not_found and applied at the same point hold exactly the role\'s key SHARED [N]', async (st) => {
    for (const [name, customer, expected, levels] of [
      ['customer_not_found', randomUUID(), answer('customer_not_found'), NO_ROWS],
      ['applied', f.C1, saved(f.manager, f.T, f.S), { roles: [{ role_id: 'manager', domain: 'customers', level: null }], versions: [] }],
    ]) {
      const seen = await saveInOwnTransaction(f, f.kManager, customer, `the manager (positive control), ${name}`);
      evidence(st, { case: `ICA-05 manager control ${name}`, answer: seen.rows, levelsInsideItsTransaction: seen.levels, advisory: seen.advisory });
      assert.deepEqual(seen.rows, [expected], `the manager, ${name}: the answer`);
      assert.deepEqual(seen.levels, levels, `the manager, ${name}: the rows inside its transaction`);
      assert.deepEqual(seen.advisory, [await guardLock(f.T, 'manager', 'ShareLock')], `the manager, ${name}: exactly the role's key, SHARED`);
    }
  });
});

// ===========================================================================
// ICA-06: a fresh decision after every wait (the level, and the database clock)
// ===========================================================================

test('ICA-06 (AC-07, N): (a) a save waiting on the key behind the REAL setter\'s uncommitted narrowing is refused once it commits, nothing written; (b) rolled back, the save answers customer_not_found or applies; (c) a save of an 8 s session waiting on the key until the database clock passed its expiry is refused by the clock read after the key — no lock or statement timeout on its connection', async (t) => {
  const missing = () => randomUUID();
  /** The manager's save waiting at the guard behind `writer` (the exact barrier), then released by `how`; what it left. */
  async function behindTheSetter(st, { label, stored, customerOf, how }) {
    const f = await scene(label, stored === undefined ? {} : { managerLevel: stored });
    const own = await tenantOwner(f.T, label);
    const customer = customerOf(f);
    const reviewed = await versionRowOf(f.T, 'manager');
    const before = { rows: strip(await invoicesRowsOf(f.T)), prints: await writes([f.T]) };
    const writer = holding(runtime, (tx) => setInvoices(own.key, 'manager', 'view', f.T, reviewed, tx));
    let saving = null;
    try {
      await until(() => writer.ready || writer.out !== undefined, `${label}: the setter's narrowing held, uncommitted`);
      assert.deepEqual(writer.value, [setterApplied(own, f.T, 'view', reviewed + 1)], `${label}: the setter applied, uncommitted`);
      assert.deepEqual(await guardLocksOf(writer.pid), [await guardLock(f.T, 'manager', 'ExclusiveLock')], `${label}: the setter holds the manager's key EXCLUSIVE`);
      saving = running(runtime, (tx) => create(f.kManager, f.S, f.T, customer, LINES, { db: tx }));
      const where = await waitingOrAnswered(saving, writer.pid, `${label}: the save waits behind the setter, or answers`);
      const barrier = where === 'waiting' ? { waitsFor: await waitsFor(saving.pid), guard: await guardLocksOf(saving.pid), query: await queryOf(saving.pid) } : null;
      evidence(st, { case: `ICA-06 ${label}`, save: where, answeredWithoutWaiting: where === 'answered' ? (await saving.done).value ?? saving.out : null, barrier });
      assert.equal(where, 'waiting', `${label}: the save answered ${JSON.stringify(saving.out)} without waiting for the setter's uncommitted narrowing`);
      // The exact barrier: one ungranted lock, the advisory ShareLock on the manager's key (classid 530030, objid the key, objsubid 2).
      assert.deepEqual(barrier.waitsFor, [['advisory', 'ShareLock']], `${label}: it waits for an advisory lock, SHARED — nothing else`);
      assert.deepEqual(barrier.guard, [await guardLock(f.T, 'manager', 'ShareLock', false)], `${label}: for exactly the manager's key`);
      assert.match(barrier.query, /m7b_invoice_draft_create/, `${label}: inside the save`);
      writer.release(how);
      assert.equal((await writer.done).outcome, how === 'commit' ? 'committed' : 'rolled back', `${label}: the setter ended`);
      const out = finished(await saving.done, `${label}: the save`);
      return { f, own, reviewed, before, out, after: { rows: strip(await invoicesRowsOf(f.T)), prints: await writes([f.T]) } };
    } finally {
      writer.release('rollback');
      await writer.done;
      if (saving !== null) await saving.done;
    }
  }
  for (const [customerName, customerOf] of [['a missing customer', () => missing()], ['an existing customer', (f) => f.C1]]) {
    for (const stored of [undefined, 'full']) {
      const override = stored === undefined ? 'absent override (the setter\'s first insertion)' : 'stored Full (the setter\'s update)';
      await t.test(`(a) ${customerName}, ${override}: the setter commits its narrowing to View — REFUSED, nothing written`, async (st) => {
        const r = await behindTheSetter(st, { label: `f06a-${customerName === 'a missing customer' ? 'missing' : 'existing'}-${stored ?? 'absent'}`, stored, customerOf, how: 'commit' });
        evidence(st, { case: 'ICA-06 (a)', answer: r.out.value, rowsAfter: r.after.rows });
        assert.deepEqual(r.out.value.map((x) => ({ ...x })), [REFUSED], 'refused on the narrowing that committed while the save waited — never a sealed answer');
        assert.deepEqual(r.after.rows, { roles: [{ role_id: 'manager', domain: 'invoices', level: 'view' }], versions: [{ role_id: 'manager', domain: 'invoices', version: String(r.reviewed + 1) }] },
          'the role and version rows exactly the setter\'s: no Customers anchor, nothing of the save');
        assert.deepEqual(r.after.prints, r.before.prints, 'no draft, line, audit record, event or idempotency record');
      });
    }
  }
  for (const [customerName, customerOf, expect] of [
    ['a missing customer', () => missing(), () => ({ answer: answer('customer_not_found'), rows: NO_ROWS, drafts: 0 })],
    ['an existing customer', (f) => f.C1, (f) => ({ answer: saved(f.manager, f.T, f.S), rows: { roles: [{ role_id: 'manager', domain: 'customers', level: null }], versions: [] }, drafts: 1 })],
  ]) {
    await t.test(`(b) ${customerName}, absent override: the setter rolls back — the save answers on the default`, async (st) => {
      const r = await behindTheSetter(st, { label: `f06b-${customerName === 'a missing customer' ? 'missing' : 'existing'}`, stored: undefined, customerOf, how: 'rollback' });
      const e = expect(r.f);
      evidence(st, { case: 'ICA-06 (b)', answer: r.out.value, rowsAfter: r.after.rows });
      assert.deepEqual(r.out.value.map((x) => ({ ...x })), [e.answer], 'the default (Full) admits it: the save\'s own answer');
      assert.deepEqual(r.after.rows, e.rows, 'the rows the save itself writes, and nothing of the rolled-back setter');
      assert.equal(r.after.prints.drafts - r.before.prints.drafts, e.drafts, 'the drafts it wrote');
    });
  }
  await t.test('(c) post-wait expiry, not a timeout: 8 s sessions wait at the key past their expiry on the database clock; the writer rolled back, each save is REFUSED by the clock read after the key, before step 10c and before step 11', async (st) => {
    const f = await scene('f06c');
    const m1 = await member(f, 'f06c-1', 'manager');
    const m2 = await member(f, 'f06c-2', 'manager');
    // Two managers (two accounts: 016's hold takes each account FOR UPDATE, so one manager's two saves would queue on the
    // account, not the key), each with a short-lived session: live through every step up to the key, expired once the key has
    // been waited for. The expiry is real time, chosen generous (8 s) so each save reaches the key long before it (asserted:
    // each is seen waiting there first, live); the test then waits on the DATABASE clock passing the expiry — a condition.
    const [k1, k2] = await Promise.all([mint(m1.who, { lifetime: 8_000 }), mint(m2.who, { lifetime: 8_000 })]);
    const expiries = (await owner`select expires_at::text as e from tmpos_session.session where session_key = any(${[k1, k2]}::text[])`).map((r) => BigInt(r.e));
    assert.equal(expiries.length, 2);
    const [first, last] = [expiries.reduce((a, b) => (a < b ? a : b)), expiries.reduce((a, b) => (a > b ? a : b))];
    // The writer: an owner's uncommitted FIRST non-NULL INSERT of the manager's Invoices level (no row exists), Create — a level
    // that would ADMIT the save. Its AFTER INSERT trigger takes the key EXCLUSIVE. Rolled back, the level is the catalog default
    // (Full) again, so nothing but the clock read after the key can refuse: a missing clock read would let the missing-customer
    // save seal 'customer_not_found' and the existing-customer one write its Customers anchor (and be refused only at step 13).
    const writer = holding(owner, (tx) => tx`insert into tmpos_role.tenant_role_level (tenant_id, role_id, domain, level, updated_at)
      values (${f.T}, 'manager', 'invoices', 'create', now())`);
    const seen = [null, null];
    const saves = [];
    try {
      await until(() => writer.ready, 'the writer\'s first insertion held, uncommitted');
      assert.deepEqual(await guardLocksOf(writer.pid), [await guardLock(f.T, 'manager', 'ExclusiveLock')], 'the writer holds the key EXCLUSIVE');
      const prints = await writes([f.T]);
      // Each save as the routine's OWNER (so its refusing transaction can read its own rows), on a connection with NO lock or
      // statement timeout — read inside the very transaction that then waits.
      for (const [i, key, customer] of [[0, k1, randomUUID()], [1, k2, f.C1]]) {
        saves.push(holding(owner, async (tx) => {
          const [timeouts] = await tx`select pg_catalog.current_setting('lock_timeout') as lock, pg_catalog.current_setting('statement_timeout') as statement`;
          const rows = await create(key, f.S, f.T, customer, LINES, { db: tx });
          seen[i] = { timeouts: { ...timeouts }, rows, levels: strip(await invoicesRowsOf(f.T, tx)),
            drafts: (await tx`select count(*)::int as n from tmpos_invoice_draft.invoice_draft where tenant_id = ${f.T}`)[0].n };
        }));
      }
      for (const [i, s] of saves.entries()) {
        await until(() => blockedBy(s.pid, writer.pid), `save ${i + 1}: waits for the writer's key`);
        assert.deepEqual(await waitsFor(s.pid), [['advisory', 'ShareLock']], `save ${i + 1}: at the guard — one ungranted advisory lock, SHARED`);
        assert.deepEqual(await guardLocksOf(s.pid), [await guardLock(f.T, 'manager', 'ShareLock', false)], `save ${i + 1}: for exactly the manager's key`);
        assert.match(await queryOf(s.pid), /m7b_invoice_draft_create/, `save ${i + 1}: inside the save`);
      }
      // Bracketed: both sessions are live on the database clock when both saves are seen waiting at the key ...
      const atBarrier = await dbNow();
      assert.ok(atBarrier < first, `the sessions are live at the barrier (${atBarrier} < ${first})`);
      // ... and the expiry then passes while they wait (a condition on the database clock, never a guess; the bound kept).
      await until(async () => (await dbNow()) >= last, 'both sessions expired while the saves waited', 20_000);
      for (const [i, s] of saves.entries()) assert.equal(await blockedBy(s.pid, writer.pid), true, `save ${i + 1}: still waiting at the key after its expiry — no timeout ended it`);
      assert.deepEqual(seen, [null, null], 'neither has answered while the writer holds the key');
      writer.release('rollback');
      assert.equal((await writer.done).outcome, 'rolled back', 'the writer rolled back: the level is the default Full again');
      await until(() => saves.every((s) => s.ready || s.out !== undefined), 'both saves answered');
      evidence(st, { case: 'ICA-06 (c)', expiries: expiries.map(String), atBarrier: String(atBarrier), seen });
      for (const [i, name] of [[0, 'the missing customer'], [1, 'the existing customer']]) {
        assert.equal(saves[i].ready, true, `${name}: ${JSON.stringify(saves[i].out)}`);
        assert.deepEqual(seen[i].timeouts, { lock: '0', statement: '0' }, `${name}: its connection had no lock or statement timeout — the wait ended by the writer, never by a timeout`);
        assert.deepEqual(seen[i].rows, [REFUSED], `${name}: refused by the clock read after the key`);
        assert.deepEqual(seen[i].levels, NO_ROWS, `${name}: inside the refusing transaction, no role row at all — ${i === 0 ? 'not customer_not_found: the refusal precedes step 10c' : 'no Customers anchor: the refusal precedes step 11'}`);
        assert.equal(seen[i].drafts, 0, `${name}: and no draft`);
      }
      for (const s of saves) s.release('rollback');
      for (const s of saves) assert.equal((await s.done).outcome, 'rolled back');
      assert.deepEqual(await writes([f.T]), prints, 'rolled back: no draft, line, audit, event or record remains');
      assert.deepEqual(strip(await invoicesRowsOf(f.T)), NO_ROWS, 'no role row, no version row');
    } finally {
      writer.release('rollback');
      await writer.done;
      for (const s of saves) { s.release('rollback'); await s.done; }
    }
  });
});

// ===========================================================================
// ICA-07: the orderings without a new cycle
// ===========================================================================

test('ICA-07 (AC-08, N): every ordering of a save with the Invoices setter, 021\'s Customers setter, 024\'s customer edit, the edit v2, a later save and an owner\'s row lock finishes — no 40P01; every wait first seen in pg_locks', async (t) => {
  await t.test('(1) the save holds the key — applied and customer_not_found — the setter waits on it, then both finish', async () => {
    for (const [name, customerOf, expectedOf] of [
      ['applied', (f) => f.C1, (f) => saved(f.manager, f.T, f.S)],
      ['customer_not_found', () => randomUUID(), () => answer('customer_not_found')],
    ]) {
      const f = await scene(`o071-${name === 'applied' ? 'a' : 'n'}`);
      const own = await tenantOwner(f.T, `o071-${name === 'applied' ? 'a' : 'n'}`);
      const held = holding(runtime, (tx) => create(f.kManager, f.S, f.T, customerOf(f), LINES, { db: tx }));
      let writer = null;
      try {
        await until(() => held.ready || held.out !== undefined, `${name}: the save answered, its transaction open`);
        assert.deepEqual(held.value, [expectedOf(f)], `${name}: the save's answer`);
        assert.deepEqual(await guardLocksOf(held.pid), [await guardLock(f.T, 'manager', 'ShareLock')], `${name}: the save holds the key SHARED`);
        writer = running(runtime, (tx) => setInvoices(own.key, 'manager', 'view', f.T, 0, tx));
        await until(() => blockedBy(writer.pid, held.pid), `${name}: the setter waits behind the save`);
        assert.deepEqual(await waitsFor(writer.pid), [['advisory', 'ExclusiveLock']], `${name}: on an advisory lock, EXCLUSIVE — nothing else`);
        assert.deepEqual((await guardLocksOf(writer.pid)).filter((l) => !l.granted), [await guardLock(f.T, 'manager', 'ExclusiveLock', false)], `${name}: the manager's key`);
        held.release('commit');
        finished(await held.done, `${name}: the save`);
        const out = finished(await writer.done, `${name}: the setter`);
        assert.deepEqual(out.value, [setterApplied(own, f.T, 'view', 1)], `${name}: the setter applied once the save committed`);
      } finally {
        held.release('rollback');
        await held.done;
        if (writer !== null) await writer.done;
      }
    }
  });
  await t.test('(2) the setter holds the key — the save waits on it, then both finish (the save on the committed level)', async () => {
    const f = await scene('o072');
    const own = await tenantOwner(f.T, 'o072');
    const writer = holding(runtime, (tx) => setInvoices(own.key, 'manager', 'manage', f.T, 0, tx));
    let saving = null;
    try {
      await until(() => writer.ready || writer.out !== undefined, 'the setter\'s change held, uncommitted');
      assert.deepEqual(await guardLocksOf(writer.pid), [await guardLock(f.T, 'manager', 'ExclusiveLock')], 'the setter holds the key EXCLUSIVE');
      saving = running(runtime, (tx) => create(f.kManager, f.S, f.T, f.C1, LINES, { db: tx }));
      await until(() => blockedBy(saving.pid, writer.pid), 'the save waits behind the setter');
      assert.deepEqual(await waitsFor(saving.pid), [['advisory', 'ShareLock']], 'at the guard: an advisory lock, SHARED');
      assert.deepEqual(await guardLocksOf(saving.pid), [await guardLock(f.T, 'manager', 'ShareLock', false)], 'the manager\'s key');
      writer.release('commit');
      assert.deepEqual(finished(await writer.done, 'the setter').value, [setterApplied(own, f.T, 'manage', 1)]);
      assert.deepEqual(finished(await saving.done, 'the save').value.map((x) => ({ ...x })), [saved(f.manager, f.T, f.S)], 'Manage admits Create: applied');
    } finally {
      writer.release('rollback');
      await writer.done;
      if (saving !== null) await saving.done;
    }
  });
  await t.test('(3) the save, holding the key, waits on its role\'s Customers row behind 021\'s REAL Customers setter while an Invoices setter waits on the save\'s key — all three finish', async () => {
    const f = await scene('o073');
    const ownC = await tenantOwner(f.T, 'o073-c');
    const ownI = await tenantOwner(f.T, 'o073-i');
    // 021's setter: the manager's Customers row inserted (NULL) and held FOR UPDATE, the level written; it takes no key (030's
    // trigger ignores a Customers row).
    const customers = holding(runtime, (tx) => setCustomers(ownC.key, 'manager', 'view', f.T, 0, tx));
    let saving = null;
    let writer = null;
    try {
      await until(() => customers.ready || customers.out !== undefined, 'the Customers setter held, uncommitted');
      assert.deepEqual(customers.value, [setterApplied(ownC, f.T, 'view', 1)], 'the Customers setter applied, uncommitted');
      assert.deepEqual(await anyAdvisoryOf(customers.pid), [], 'the Customers setter takes no key');
      saving = holding(runtime, (tx) => create(f.kManager, f.S, f.T, f.C1, LINES, { db: tx }));
      await until(() => blockedBy(saving.pid, customers.pid), 'the save waits behind the Customers setter');
      assert.deepEqual(await guardLocksOf(saving.pid), [await guardLock(f.T, 'manager', 'ShareLock')], 'past its guard: holding the key SHARED, granted');
      assert.deepEqual(await waitsFor(saving.pid), [['transactionid', 'ShareLock']], 'waiting on the Customers setter\'s row (its anchor INSERT), nothing else');
      writer = running(runtime, (tx) => setInvoices(ownI.key, 'manager', 'view', f.T, 0, tx));
      await until(() => blockedBy(writer.pid, saving.pid), 'the Invoices setter waits behind the save');
      assert.deepEqual(await waitsFor(writer.pid), [['advisory', 'ExclusiveLock']], 'on the save\'s key, EXCLUSIVE — nothing else');
      customers.release('commit');
      finished(await customers.done, 'the Customers setter');
      await until(() => saving.ready || saving.out !== undefined, 'the save answered once the Customers row was free');
      assert.deepEqual(saving.value, [saved(f.manager, f.T, f.S)], 'the save, on the committed Customers View and the held Invoices default: applied');
      assert.equal(await blockedBy(writer.pid, saving.pid), true, 'the Invoices setter still waits on the key while the save\'s transaction is open');
      saving.release('commit');
      finished(await saving.done, 'the save');
      assert.deepEqual(finished(await writer.done, 'the Invoices setter').value, [setterApplied(ownI, f.T, 'view', 1)]);
    } finally {
      customers.release('rollback');
      await customers.done;
      if (saving !== null) { saving.release('rollback'); await saving.done; }
      if (writer !== null) await writer.done;
    }
  });
  await t.test('(4) the save, holding the key, waits on the customer behind 024\'s REAL customer edit while an Invoices setter waits on the save\'s key — all three finish', async () => {
    const f = await scene('o074');
    const ownC = await tenantOwner(f.T, 'o074-c');
    const ownI = await tenantOwner(f.T, 'o074-i');
    // 024's edit, by a store owner with one tenant grant (no role row): the customer FOR UPDATE, renamed; no key.
    const customerEdit = holding(runtime, (tx) => editCustomer(ownC.key, f.C1, f.T, 1, `ICR renamed ${SUFFIX}`, tx));
    let saving = null;
    let writer = null;
    try {
      await until(() => customerEdit.ready || customerEdit.out !== undefined, 'the customer edit held, uncommitted');
      assert.deepEqual(customerEdit.value, [{ o_outcome: 'applied', o_tenant_id: f.T, o_actor_id: ownC.who.id, o_membership_id: ownC.who.memberships[0], o_version: 2 }]);
      assert.deepEqual(await anyAdvisoryOf(customerEdit.pid), [], 'the customer edit takes no key');
      saving = holding(runtime, (tx) => create(f.kManager, f.S, f.T, f.C1, LINES, { db: tx }));
      await until(() => blockedBy(saving.pid, customerEdit.pid), 'the save waits behind the customer edit');
      assert.deepEqual(await guardLocksOf(saving.pid), [await guardLock(f.T, 'manager', 'ShareLock')], 'past its guard: holding the key SHARED, granted');
      assert.deepEqual(await waitsFor(saving.pid), [['transactionid', 'ShareLock']], 'waiting on the customer row (its FOR KEY SHARE behind FOR UPDATE), nothing else');
      writer = running(runtime, (tx) => setInvoices(ownI.key, 'manager', 'view', f.T, 0, tx));
      await until(() => blockedBy(writer.pid, saving.pid), 'the Invoices setter waits behind the save');
      assert.deepEqual(await waitsFor(writer.pid), [['advisory', 'ExclusiveLock']], 'on the save\'s key, EXCLUSIVE — nothing else');
      customerEdit.release('commit');
      finished(await customerEdit.done, 'the customer edit');
      await until(() => saving.ready || saving.out !== undefined, 'the save answered once the customer was free');
      assert.deepEqual(saving.value, [saved(f.manager, f.T, f.S)], 'the save, the customer still in the tenant: applied');
      assert.equal(await blockedBy(writer.pid, saving.pid), true, 'the Invoices setter still waits on the key while the save\'s transaction is open');
      saving.release('commit');
      finished(await saving.done, 'the save');
      assert.deepEqual(finished(await writer.done, 'the Invoices setter').value, [setterApplied(ownI, f.T, 'view', 1)]);
    } finally {
      customerEdit.release('rollback');
      await customerEdit.done;
      if (saving !== null) { saving.release('rollback'); await saving.done; }
      if (writer !== null) await writer.done;
    }
  });
  await t.test('(5) a save and an edit v2 of one role, in both orders, hold the key SHARED at once — neither waits', async () => {
    const f = await scene('o075');
    const m2 = await member(f, 'o075-2', 'manager');
    const drafts = [await save(f.boss, f.kBoss, f.S, f.T, f.C1), await save(f.boss, f.kBoss, f.S, f.T, f.C1)];
    const K = await guardLock(f.T, 'manager', 'ShareLock');
    for (const [i, order] of ['the edit first', 'the save first'].entries()) {
      const startEdit = () => holding(runtime, (tx) => edit(f.kManager, f.S, f.T, drafts[i], 1, f.C2, [line(`Beside a save ${i}`, 1, 1)], { db: tx }));
      const startSave = () => holding(runtime, (tx) => create(m2.key, f.S, f.T, f.C1, LINES, { db: tx }));
      const first = i === 0 ? startEdit() : startSave();
      let second = null;
      try {
        await readyUnblocked(first, `${order}: the first answered`);
        second = i === 0 ? startSave() : startEdit();
        await readyUnblocked(second, `${order}: the second answered beside the first, never waiting`);
        const [editing, saving] = i === 0 ? [first, second] : [second, first];
        assert.deepEqual(editing.value, [edited(f.manager, f.T, f.S, 2)], `${order}: the edit applied`);
        assert.deepEqual(saving.value, [saved(m2.who, f.T, f.S)], `${order}: the save applied`);
        assert.deepEqual([await guardLocksOf(first.pid), await guardLocksOf(second.pid)], [[K], [K]], `${order}: both hold the manager's key SHARED, granted, at once`);
        first.release('commit');
        second.release('commit');
        finished(await first.done, `${order}: the first`);
        finished(await second.done, `${order}: the second`);
      } finally {
        first.release('rollback');
        await first.done;
        if (second !== null) { second.release('rollback'); await second.done; }
      }
    }
  });
  await t.test('(6) a later save queues on the key behind a setter that waits behind an earlier save — all finish; the later save is refused on the narrowing that committed', async () => {
    const f = await scene('o076');
    const own = await tenantOwner(f.T, 'o076');
    const m2 = await member(f, 'o076-2', 'manager');
    const earlier = holding(runtime, (tx) => create(f.kManager, f.S, f.T, f.C1, LINES, { db: tx }));
    let writer = null;
    let later = null;
    try {
      await until(() => earlier.ready || earlier.out !== undefined, 'the earlier save applied, uncommitted');
      assert.deepEqual(earlier.value, [saved(f.manager, f.T, f.S)]);
      writer = running(runtime, (tx) => setInvoices(own.key, 'manager', 'view', f.T, 0, tx));
      await until(() => blockedBy(writer.pid, earlier.pid), 'the setter waits behind the earlier save');
      assert.deepEqual(await waitsFor(writer.pid), [['advisory', 'ExclusiveLock']], 'on the key, EXCLUSIVE');
      later = running(runtime, (tx) => create(m2.key, f.S, f.T, f.C1, LINES, { db: tx }));
      await until(() => blockedBy(later.pid, writer.pid), 'the later save waits behind the waiting setter');
      assert.deepEqual(await waitsFor(later.pid), [['advisory', 'ShareLock']], 'the later save: at the guard, SHARED');
      assert.deepEqual(await guardLocksOf(later.pid), [await guardLock(f.T, 'manager', 'ShareLock', false)], 'for the same key: queued behind the waiting setter, not granted beside the earlier save');
      earlier.release('commit');
      finished(await earlier.done, 'the earlier save');
      assert.deepEqual(finished(await writer.done, 'the setter').value, [setterApplied(own, f.T, 'view', 1)]);
      assert.deepEqual(finished(await later.done, 'the later save').value.map((x) => ({ ...x })), [REFUSED], 'the later save, read after its key: the committed View refuses it');
    } finally {
      earlier.release('rollback');
      await earlier.done;
      if (writer !== null) await writer.done;
      if (later !== null) await later.done;
    }
  });
  await t.test('(7) an owner holding the role\'s Invoices row FOR UPDATE (no key taken) does not block a save at all — the Invoices anchor is gone', async () => {
    const f = await scene('o077', { managerLevel: 'full' });
    const rowLock = holding(owner, (tx) => tx`select 1 from tmpos_role.tenant_role_level
      where tenant_id = ${f.T} and role_id = 'manager' and domain = 'invoices' for update`);
    let saving = null;
    try {
      await until(() => rowLock.ready, 'the owner holds the Invoices row FOR UPDATE');
      assert.deepEqual(await anyAdvisoryOf(rowLock.pid), [], 'a row lock takes no key (no row trigger fires)');
      saving = holding(runtime, (tx) => create(f.kManager, f.S, f.T, f.C1, LINES, { db: tx }));
      await readyUnblocked(saving, 'the save answered beside the owner\'s row lock, never waiting');
      assert.deepEqual(saving.value, [saved(f.manager, f.T, f.S)], 'and applied');
      saving.release('commit');
      finished(await saving.done, 'the save');
      rowLock.release('rollback');
      finished(await rowLock.done, 'the owner\'s row lock', 'rolled back');
    } finally {
      rowLock.release('rollback');
      await rowLock.done;
      if (saving !== null) { saving.release('rollback'); await saving.done; }
    }
  });
});

// ===========================================================================
// ICA-11: privileges, dependencies and the routine's text
// ===========================================================================

/** 031's objects and the objects it must leave as 030 left them: the schema, its functions, the level table's triggers, 028's save. */
async function surface(db = owner) {
  const schema = (await db`select n.nspacl::text as acl, pg_catalog.obj_description(n.oid, 'pg_namespace') as comment
    from pg_catalog.pg_namespace n where n.nspname = 'tmpos_invoice_edit'`).map((r) => ({ ...r }));
  const functions = (await db`select p.oid::regprocedure::text as fn, pg_catalog.md5(p.prosrc) as src, p.proacl::text as acl, p.provolatile::text as vol,
      p.prosecdef as definer, p.proconfig as config, p.proowner::regrole::text as owner, pg_catalog.obj_description(p.oid, 'pg_proc') as comment
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace where n.nspname = 'tmpos_invoice_edit' order by 1`).map((r) => ({ ...r }));
  const triggers = (await db`select g.tgname::text as name, g.tgfoid::regprocedure::text as fn, g.tgtype::int as type, g.tgenabled::text as enabled
    from pg_catalog.pg_trigger g where g.tgrelid = 'tmpos_role.tenant_role_level'::regclass and not g.tgisinternal order by 1`).map((r) => ({ ...r }));
  const [save028] = await db`select pg_catalog.md5(p.prosrc) as src, p.provolatile::text as vol, p.prosecdef as definer, p.proconfig as config,
      p.proowner::regrole::text as owner, pg_catalog.obj_description(p.oid, 'pg_proc') as comment from pg_catalog.pg_proc p where p.oid = ${CREATE_028}::regprocedure`;
  return { schema, functions, triggers, save028: { ...save028, grants: await grantsOf(CREATE_028, db) } };
}
/** A routine's complete ACL in aclexplode form (the owner's implicit entry included). */
const grantsOf = async (signature, db = owner) => (await db`select g.grantee::regrole::text as grantee, g.privilege_type as priv, g.grantor::regrole::text as grantor, g.is_grantable as grantable
  from pg_catalog.pg_proc p, pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g where p.oid = ${signature}::regprocedure`)
  .map((x) => ({ ...x })).sort((a, b) => (`${a.grantee}/${a.priv}` < `${b.grantee}/${b.priv}` ? -1 : 1));
const EXECUTE_BY = (...grantees) => grantees.map((grantee) => ({ grantee, priv: 'EXECUTE', grantor: ME, grantable: false }))
  .sort((a, b) => (a.grantee < b.grantee ? -1 : 1));
const ledgerRows = async () => (await owner`select version, checksum, dirty, started_at::text as started, finished_at::text as finished
  from public.schema_migrations order by version`).map((r) => ({ ...r }));
async function preflightVerdict() {
  const client = createSupervisedPgClient(testDriver(TARGET), driverDsn(TARGET_DSN, RUNTIME_LOGIN), {
    ...runtimeClientOptions(TARGET_DSN), ssl: false, max: 1, idle_timeout: 0, user: RUNTIME_LOGIN,
  });
  try {
    const preflight = createPostgresStartupPreflight({ client });
    const signal = AbortSignal.timeout(20_000);
    return { runtimeLogin: await preflight.runtimeLogin(signal), migrationLedger: await preflight.migrationLedger(signal) };
  } finally {
    await client.end();
  }
}

test('ICA-11 (AC-14, N): the runtime login executes create_v2 and not 028\'s save; create_v2\'s attributes and exact ACL; 030\'s rollback on this 001-031 database refused with 2BP01, catalog and ledger unchanged; create_v2\'s code is 028\'s with exactly the three changes', async (t) => {
  await t.test('privileges: 42501 on 028\'s save for the runtime login; create_v2 executes; the exact ACLs and attributes', async () => {
    const f = await scene('p11');
    const refused = await errorOf(create(f.kManager, f.S, f.T, f.C1, LINES, { fn: CREATE_FN_028 }));
    assert.equal(refused?.code, '42501', `028's save, as the runtime login: ${JSON.stringify(refused)}`);
    assert.match(refused.message, /^permission denied for function m7b_invoice_draft_create$/);
    assert.deepEqual(await create(f.kManager, f.S, f.T, f.C1, LINES), [saved(f.manager, f.T, f.S)], 'create_v2, as the runtime login: applied');
    const [can] = await owner`select
        pg_catalog.has_function_privilege(${RUNTIME_LOGIN}, ${CREATE_V2}::regprocedure, 'EXECUTE') as login_v2,
        pg_catalog.has_function_privilege(${RUNTIME_LOGIN}, ${CREATE_028}::regprocedure, 'EXECUTE') as login_028,
        pg_catalog.has_function_privilege('tmpos_audit_writer', ${CREATE_V2}::regprocedure, 'EXECUTE') as writer_v2,
        pg_catalog.has_function_privilege('anon', ${CREATE_V2}::regprocedure, 'EXECUTE') as anon_v2,
        pg_catalog.has_function_privilege('authenticated', ${CREATE_V2}::regprocedure, 'EXECUTE') as authenticated_v2,
        pg_catalog.has_function_privilege('tmpos_audit_writer', ${CREATE_028}::regprocedure, 'EXECUTE') as writer_028,
        pg_catalog.has_function_privilege('anon', ${CREATE_028}::regprocedure, 'EXECUTE') as anon_028,
        pg_catalog.has_function_privilege('authenticated', ${CREATE_028}::regprocedure, 'EXECUTE') as authenticated_028`;
    assert.deepEqual({ ...can }, { login_v2: true, login_028: false, writer_v2: false, anon_v2: false, authenticated_v2: false, writer_028: false,
      anon_028: false, authenticated_028: false }, 'only the login (through tmpos_app) executes a save routine, and only create_v2');
    assert.deepEqual(await grantsOf(CREATE_V2), EXECUTE_BY(ME, 'tmpos_app'), 'create_v2: exactly the owner\'s and tmpos_app\'s EXECUTE, owner-granted, non-grantable (no PUBLIC)');
    assert.deepEqual(await grantsOf(CREATE_028), EXECUTE_BY(ME), '028\'s save: exactly the owner\'s EXECUTE');
    const [attrs] = await owner`select l.lanname::text as language, p.prosecdef as definer, p.provolatile::text as vol, p.proconfig as config,
        p.proowner::regrole::text as owner, pg_catalog.pg_get_function_arguments(p.oid) = pg_catalog.pg_get_function_arguments(${CREATE_028}::regprocedure) as same_arguments,
        pg_catalog.pg_get_function_result(p.oid) = pg_catalog.pg_get_function_result(${CREATE_028}::regprocedure) as same_result,
        pg_catalog.obj_description(p.oid, 'pg_proc') as comment
      from pg_catalog.pg_proc p join pg_catalog.pg_language l on l.oid = p.prolang where p.oid = ${CREATE_V2}::regprocedure`;
    assert.deepEqual({ ...attrs, comment: undefined }, { language: 'plpgsql', definer: true, vol: 'v', config: ['search_path=pg_catalog, pg_temp', 'row_security=off'],
      owner: ME, same_arguments: true, same_result: true, comment: undefined }, 'create_v2\'s attributes');
    assert.equal(attrs.comment, functionComment(UP_031, CREATE_V2), 'its comment is 031\'s');
    assert.equal((await rolledBack((tx) => tx.unsafe(POSTCONDITION_031).simple())).code, undefined, '031\'s own postcondition holds over the applied chain');
  });
  await t.test('030\'s rollback on a 001-031 database is REFUSED (2BP01) by the executor\'s down path; the catalog and the ledger unchanged', async (st) => {
    const before = { surface: await surface(), ledger: await ledgerRows() };
    assert.equal(before.surface.functions.length, 3, 'tmpos_invoice_edit holds v2, the guard function and create_v2');
    // The executor's down path for ONE version (tests/db/migrationsThrough.mjs rollBackAbove, the path IDE-21 uses for 030): the
    // down file and its ledger row's DELETE in one READ COMMITTED transaction — run for 030 alone, with 031 still applied.
    const refused = await errorOf(owner.begin(RC, async (tx) => {
      await tx.unsafe(DOWN_030).simple();
      await tx`delete from public.schema_migrations where version = '030'`;
    }));
    evidence(st, { case: 'ICA-11 030 down', refused });
    assert.equal(refused?.code, '2BP01', `030's rollback refused for a dependent object: ${JSON.stringify(refused)}`);
    assert.match(refused.message, /^cannot drop schema tmpos_invoice_edit because other objects depend on it$/);
    assert.match(refused.detail ?? '', /function tmpos_invoice_edit\.m7b_invoice_draft_create_v2\(text,uuid,uuid,uuid,uuid,jsonb,bigint\) depends on schema tmpos_invoice_edit/,
      'the dependent object is 031\'s save routine');
    assert.deepEqual(await surface(), before.surface, 'unchanged: the trigger, v2, the guard function, create_v2, the schema and every grant');
    assert.deepEqual(await ledgerRows(), before.ledger, 'unchanged: the ledger, 030\'s row included');
    assert.deepEqual(await preflightVerdict(), { runtimeLogin: [], migrationLedger: [] }, 'and the 001-031 runtime still accepts it');
  });
  await t.test('static: create_v2\'s code is 028\'s with exactly the three changes; the key after the step-10 read, in the outermost block, before the customer_not_found answer and the Customers anchor; its expression the guard function\'s', async () => {
    const proSrc = async (sig) => (await owner`select p.prosrc as src from pg_catalog.pg_proc p where p.oid = ${sig}::regprocedure`)[0].src;
    const src028 = await proSrc(CREATE_028);
    const srcV2 = await proSrc(CREATE_V2);
    assert.equal(srcV2, routineBody(UP_031, 'tmpos_invoice_edit', 'm7b_invoice_draft_create_v2'), 'the installed create_v2 is the 031 up file\'s body, character for character');
    assert.equal(src028, routineBody(UP_028, 'tmpos_invoice_draft', 'm7b_invoice_draft_create'), '028\'s save is still 028\'s body, character for character');
    // THE METHOD. Both bodies are read from pg_proc.prosrc. A line that is blank, or whose first non-blank characters are '--',
    // is dropped (the design lets the comments be reworded); every other line is kept whole, its indentation included, and no
    // kept line holds '--' anywhere (asserted), so no trailing comment survives and no code is dropped. The three changes are
    // then applied to 028's kept lines as exact edits, each edit first checking the lines it replaces or removes, the guard's
    // statements built from 028's own lines where 028 already has them (step 8's Invoices read and decision, step 13's clock),
    // and the result must equal create_v2's kept lines exactly.
    const codeOf = (body) => body.split('\n').filter((l) => l.trim() !== '' && !l.trim().startsWith('--'));
    const A = codeOf(src028);
    const B = codeOf(srcV2);
    for (const [label, lines] of [['028', A], ['create_v2', B]]) {
      const commented = lines.filter((l) => l.includes('--'));
      assert.deepEqual(commented, [], `${label}: no kept line holds a comment`);
    }
    const at = (lines, text, from = 0) => { const i = lines.indexOf(text, from); assert.ok(i >= 0, `found: ${text}`); return i; };
    /** Where `seq` occurs, line for line, exactly once in `lines`. */
    const seqAt = (lines, seq, what) => {
      const hits = lines.map((_, i) => i).filter((i) => seq.every((l, j) => lines[i + j] === l));
      assert.equal(hits.length, 1, `${what}: found exactly once, line for line`);
      return hits[0];
    };
    const REFUSE_4 = "    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid;";
    const IF_EDITABLE = "  if v_role in ('manager', 'technician', 'sales_staff') then";
    const KEY = "    perform pg_catalog.pg_advisory_xact_lock_shared(530030, pg_catalog.hashtext(v_tenant::text || '/' || v_role));";
    // 028's own lines the guard restates: step 13's clock read (top level, re-indented by two inside the guard's IF), step 8's
    // Invoices read and its Invoices decision (the first half of step 8's IF, closed with ' then') and step 8's refusal.
    const clockAt = at(A, '  if v_now >= v_session.expires_at then') - 1;
    const CLOCK = A.slice(clockAt, clockAt + 5);
    assert.deepEqual(CLOCK, ['  v_now := pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp()) * 1000)::bigint;', '  if v_now >= v_session.expires_at then',
      REFUSE_4, '    return;', '  end if;'], '028\'s clock read');
    const readAt = at(A, '    select l.level into v_invoices');
    const READ = A.slice(readAt, readAt + 3);
    assert.deepEqual(READ, ['    select l.level into v_invoices', '      from tmpos_role.tenant_role_level l',
      "     where l.tenant_id = v_tenant and l.role_id = v_role and l.domain = 'invoices';"], '028 step 8\'s plain Invoices read');
    const decideAt = at(A, '    if coalesce(pg_catalog.array_position(c_levels,', readAt);
    const DECIDE = A.slice(decideAt, decideAt + 9);
    assert.match(DECIDE[1], /^ {9}coalesce\(v_invoices, case v_role when 'manager' then 'full' when 'technician' then 'view' when 'sales_staff' then 'create' end\)\), 0\)$/);
    assert.equal(DECIDE[2], "       < pg_catalog.array_position(c_levels, 'create')", '028 step 8: Invoices below Create');
    assert.deepEqual(DECIDE.slice(6), ["      return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid;", '      return;', '    end if;'], '028 step 8\'s refusal');
    const GUARD_10B = [IF_EDITABLE, KEY, ...CLOCK.map((l) => `  ${l}`), ...READ, DECIDE[0], DECIDE[1], `${DECIDE[2]} then`, ...DECIDE.slice(6), '  end if;'];
    const expected = [...A];
    // (Δ) step 10 reads into a new boolean, and answers at 10c after the guard. Its declaration:
    expected.splice(at(expected, '  v_customers      text;') + 1, 0, '  v_customer_found boolean;');
    const STEP_10 = ['  if not exists (', '    select 1', '      from tmpos_customer.customer c', '     where c.customer_id = p_customer_id',
      '       and c.tenant_id = v_tenant) then', "    return query select 'customer_not_found'::text, null::uuid, null::uuid, null::uuid, null::uuid;", '    return;', '  end if;'];
    const s10 = seqAt(expected, STEP_10, '028\'s step 10');
    expected.splice(s10, STEP_10.length,
      '  v_customer_found := exists (', ...STEP_10.slice(1, 4), '       and c.tenant_id = v_tenant);',
      // (+) step 10b, the guard
      ...GUARD_10B,
      // (Δ) step 10c
      '  if not v_customer_found then', ...STEP_10.slice(5));
    // (−) steps 11-12 lose the Invoices anchor, its FOR SHARE and its not-found refusal — exactly these eleven lines.
    const INVOICES_ANCHOR = ['    insert into tmpos_role.tenant_role_level (tenant_id, role_id, domain, level, updated_at)',
      "    values (v_tenant, v_role, 'invoices', null, pg_catalog.now())", '    on conflict (tenant_id, role_id, domain) do nothing;',
      '    select l.level into v_invoices', '      from tmpos_role.tenant_role_level l',
      "     where l.tenant_id = v_tenant and l.role_id = v_role and l.domain = 'invoices'", '       for share;', '    if not found then',
      "      return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid;", '      return;', '    end if;'];
    const anchorAt = seqAt(expected, INVOICES_ANCHOR, '028\'s Invoices anchor, its FOR SHARE and its refusal');
    expected.splice(anchorAt, INVOICES_ANCHOR.length);
    const firstDiff = B.findIndex((l, i) => l !== expected[i]);
    assert.deepEqual(B, expected, `create_v2 = 028's code with exactly the three changes (first difference at kept line ${firstDiff}: ${JSON.stringify([B[firstDiff], expected[firstDiff]])})`);
    // Their order and placement inside create_v2 (comments dropped).
    const code = B.join('\n');
    const once = (needle) => {
      const i = code.indexOf(needle);
      assert.ok(i >= 0, `${needle} is in create_v2`);
      assert.equal(code.indexOf(needle, i + 1), -1, `${needle} appears once`);
      return i;
    };
    const read10 = once('v_customer_found := exists (');
    const key = once('perform pg_catalog.pg_advisory_xact_lock_shared(530030, ');
    const clock = code.indexOf('v_now >= v_session.expires_at', key);
    const reread = code.indexOf('select l.level into v_invoices', key);
    const notFound = once("return query select 'customer_not_found'::text");
    const anchor = once("values (v_tenant, v_role, 'customers', null, pg_catalog.now())");
    const customerLock = once('for key share');
    assert.ok(read10 < key, 'the key after the step-10 read');
    assert.ok(key < clock && clock < reread && reread < notFound, 'then the clock, then the Invoices re-read, then the customer_not_found answer');
    assert.ok(notFound < anchor && anchor < customerLock, 'the Customers anchor and the customer\'s lock after both');
    const depthAt = (src, index) => {
      let depth = 0;
      for (const m of src.matchAll(/\b(begin|end)\b(\s*;)?/gi)) {
        if (m.index >= index) break;
        if (m[1].toLowerCase() === 'begin') depth += 1; else if (m[2] !== undefined) depth -= 1;
      }
      return depth;
    };
    assert.equal(depthAt(code, key), 1, 'the key statement is in the outermost block: no BEGIN ... EXCEPTION around it');
    assert.equal(depthAt(code, reread), 1, 'and so is the re-read');
    assert.equal(depthAt(code, notFound), 1, 'and the customer_not_found answer');
    assert.doesNotMatch(code.slice(key, notFound), /\b(?:begin|exception)\b/i, 'nothing between the key and the answer opens a block');
    // No Invoices anchor, no Invoices or version row lock.
    assert.deepEqual([...code.matchAll(/\binsert into tmpos_role\.tenant_role_level[^;]*values \(v_tenant, v_role, '([a-z]+)'/g)].map((m) => m[1]), ['customers'],
      'the only role row the save writes is the Customers anchor');
    for (const st of code.split(';').filter((s) => s.includes("l.domain = 'invoices'"))) assert.doesNotMatch(st, /\bfor\s+(?:share|update|key|no key)\b/i, 'every Invoices read a plain SELECT');
    assert.doesNotMatch(code, /tmpos_role_edit/, 'no version row read or locked');
    // The key expression is the guard function's (030's trigger), in the same class.
    const keyExpressions = (src) => [...src.matchAll(/pg_catalog\.hashtext\(([^()]*)\)/g)].map((m) => m[1]
      .replace(/\b(?:v_tenant|new\.tenant_id|old\.tenant_id)\b/g, '<tenant>').replace(/\b(?:v_role|new\.role_id|old\.role_id)\b/g, '<role>'));
    const advisory = (src) => [...src.matchAll(/pg_catalog\.(pg_[a-z_]*advisory[a-z_]*)\((\d+),/g)].map((m) => [m[1], m[2]]);
    const guardCode = codeOf(await proSrc(GUARD)).join('\n');
    const EXPRESSION = "<tenant>::text || '/' || <role>";
    assert.deepEqual(keyExpressions(code), [EXPRESSION], 'create_v2: one key expression, hashtext(tenant::text || \'/\' || role)');
    assert.deepEqual([...new Set(keyExpressions(guardCode))], [EXPRESSION], 'the guard function\'s: the same expression');
    assert.deepEqual(advisory(code), [['pg_advisory_xact_lock_shared', '530030']], 'create_v2 takes the key SHARED, transaction-scoped, class 530030');
    assert.deepEqual([...new Set(advisory(guardCode).map(String))], ['pg_advisory_xact_lock,530030'], 'the guard function takes it EXCLUSIVE, class 530030');
  });
});

// ===========================================================================
// ICA-10: 031 down / up / down (last: it rolls 031 back)
// ===========================================================================

/** Every row a scope holds in the draft and role tables, and the synthetic audit, outbox and idempotency rows, exactly. */
async function rowsOf(tenants, db = owner) {
  const q = async (rel) => (await db.unsafe(`select pg_catalog.to_jsonb(t)::text as row from ${rel} t where t.tenant_id = any($1::uuid[]) order by 1`, [tenants])).map((r) => r.row);
  const by = async (sqlText, ids) => (await db.unsafe(sqlText, [ids])).map((r) => r.row);
  return {
    drafts: await q('tmpos_invoice_draft.invoice_draft'), lines: await q('tmpos_invoice_draft.invoice_draft_line'),
    levels: await q('tmpos_role.tenant_role_level'), versions: await q('tmpos_role_edit.role_level_version'),
    audits: await by('select pg_catalog.to_jsonb(a)::text as row from public.audit_event a where a.request_id = any($1::text[]) order by 1', SYNTHETIC.audits),
    events: await by('select pg_catalog.to_jsonb(e)::text as row from tmpos_internal.outbox_event e where e.event_id = any($1::uuid[]) order by 1', SYNTHETIC.events),
    records: await by('select pg_catalog.to_jsonb(r)::text as row from tmpos_internal.idempotency_record r where r.scope = any($1::text[]) order by 1', SYNTHETIC.scopes),
  };
}
/** The 030-era surface the down must leave: create_v2 gone, 028's ACL the owner's and tmpos_app's again, all else as with 031. */
const surface030 = (with031) => ({
  schema: with031.schema,
  functions: with031.functions.filter((f) => f.fn !== 'tmpos_invoice_edit.m7b_invoice_draft_create_v2(text,uuid,uuid,uuid,uuid,jsonb,bigint)'),
  triggers: with031.triggers,
  save028: { ...with031.save028, grants: EXECUTE_BY(ME, 'tmpos_app') },
});

test('ICA-10 (AC-13, N): 031 down, up and down again over drafts at version 1 and above it, stored overrides, absent defaults, audit, outbox and completions — every row identical; the exact 030-era surface after the down; the up refused when applied, when 030\'s trigger is disabled or missing and when 028\'s ACL is not exact; a second down refused; the up and the down each wait for an in-flight save and an in-flight setter and finish without deadlock', async () => {
  // The data: drafts at version 1 (the manager's — with its Customers anchor — and the owner's) and edited above it (by the
  // manager twice, by the owner once); a stored override for the manager (an owner's write) and one through the REAL setter for
  // the sales staff (its version row); the technician's absent default; an audit record naming a draft, an outbox event and two
  // idempotency records — a sealed completion and an open lease (synthetic: 031 never touches them, so every one must survive).
  const u = await scene('cycle', { managerLevel: 'edit' });
  const own = await tenantOwner(u.T, 'cycle');
  assert.deepEqual(await setInvoices(own.key, 'sales_staff', 'edit', u.T, 0), [setterApplied(own, u.T, 'edit', 1)], 'a version row made by the real setter');
  const atOne = await save(u.manager, u.kManager, u.S, u.T, u.C1);
  const twice = await save(u.boss, u.kBoss, u.S, u.T, u.C1);
  assert.deepEqual(await edit(u.kManager, u.S, u.T, twice, 1, u.C2, [line('Cycle edit', 2, 5)]), [edited(u.manager, u.T, u.S, 2)]);
  assert.deepEqual(await edit(u.kManager, u.S, u.T, twice, 2, u.C1, LINES), [edited(u.manager, u.T, u.S, 3)]);
  const once = await save(u.boss, u.kBoss, u.S, u.T, u.C2);
  assert.deepEqual(await edit(u.kBoss, u.S, u.T, once, 1, u.C1, [line('Owner edit', 3, 7)]), [edited(u.boss, u.T, u.S, 2)]);
  const audit = randomUUID();
  const event = randomUUID();
  const scopes = [newKey(), newKey()];
  SYNTHETIC.audits.push(audit);
  SYNTHETIC.events.push(event);
  SYNTHETIC.scopes.push(...scopes);
  try {
    await owner.begin(RC, async (tx) => {
      await tx`insert into public.audit_event (request_id, actor_internal_user_id, scope_type, tenant_id, store_id, action_id, required_permission, decision,
          reason_code, human_readable_reason, result_status, source_of_truth, evaluated_by, evidence_level, subject_invoice_draft_id)
        values (${audit}, null, 'store', ${u.T}, ${u.S}, 'store.invoice_draft.update', 'edit_invoice_drafts', 'allow', 'command_committed',
          'ICR synthetic record.', 'succeeded', 'command_transaction', 'm6_postgres_command_transaction@v1', 'durable_compliance_event', ${twice})`;
      await tx`insert into tmpos_internal.outbox_event (event_id, event_type, event_version, aggregate_type, aggregate_id, aggregate_version, correlation_id,
          payload, occurred_at, status, attempt, due_at)
        values (${event}, 'invoice_draft.updated', 1, 'invoice_draft', ${twice}, 3, ${randomUUID()}, ${tx.json({ storeId: u.S, customerId: u.C1, lineCount: 3 })},
          pg_catalog.now(), 'pending', 0, pg_catalog.now())`;
      await tx`insert into tmpos_internal.idempotency_record (scope, fingerprint, lease, lease_expires_at, expires_at, response)
        values (${scopes[0]}, ${newKey()}, ${newKey()}, pg_catalog.now() + interval '1 minute', pg_catalog.now() + interval '1 day', 'c2VhbGVkLWNvbXBsZXRpb24'),
               (${scopes[1]}, ${newKey()}, ${newKey()}, pg_catalog.now() + interval '1 minute', pg_catalog.now() + interval '1 day', null)`;
    });
    const rows0 = await rowsOf([u.T]);
    assert.equal(rows0.drafts.length, 3);
    assert.deepEqual(rows0.drafts.map((d) => JSON.parse(d).version).sort(), [1, 2, 3], 'drafts at version 1 and above it');
    assert.deepEqual(rows0.levels.map((r) => JSON.parse(r)).map((r) => `${r.role_id}/${r.domain}/${r.level}`).sort(),
      ['manager/customers/null', 'manager/invoices/edit', 'sales_staff/invoices/edit'], 'stored overrides, the manager\'s Customers anchor; the technician absent');
    assert.equal(rows0.versions.length, 1, 'the real setter\'s version row');
    assert.deepEqual([rows0.audits.length, rows0.events.length, rows0.records.length], [1, 1, 2], 'an audit record, an outbox event, a completion and a lease');
    assert.ok(JSON.parse(rows0.records.find((r) => JSON.parse(r).scope === scopes[0])).response !== null, 'a sealed completion');
    const with031 = await surface();
    assert.equal(with031.functions.length, 3);
    assert.deepEqual(with031.save028.grants, EXECUTE_BY(ME), 'applied: 028\'s save is the owner\'s alone');

    // 0. THE UP over the applied chain is refused.
    const again = await rolledBack((tx) => tx.unsafe(UP_031).simple());
    assert.deepEqual(again, { code: '55000', message: 'migration 031 refused: tmpos_invoice_edit.m7b_invoice_draft_create_v2 already exists' });

    // 1. THE DOWN, by the executor's down path (031's down file and its ledger row, one READ COMMITTED transaction).
    const { rolledBack: undone, restore } = await rollBackAbove(owner, MIG_DIR, '030');
    let restored = false;
    try {
      assert.deepEqual(undone, ['031'], 'only 031 sits above 030');
      assert.deepEqual(await rowsOf([u.T]), rows0, 'every draft, line, level, version, audit, outbox and idempotency row identical');
      assert.deepEqual(await surface(), surface030(with031), 'the exact 030-era surface: create_v2 gone; tmpos_invoice_edit exactly 030\'s two functions (bodies, ACLs, attributes, comments), its ACL and comment; the two triggers; 028\'s save the owner\'s and tmpos_app\'s again');
      assert.equal((await owner`select pg_catalog.to_regprocedure(${CREATE_V2}) is null as gone`)[0].gone, true, 'create_v2 gone');
      assert.deepEqual((await surface()).triggers.map((g) => g.enabled), ['A', 'A'], 'both triggers ENABLE ALWAYS');
      assert.equal((await rolledBack((tx) => tx.unsafe(POSTCONDITION_030).simple())).code, undefined, '030\'s own postcondition holds again');
      assert.deepEqual(await preflightVerdict(), { runtimeLogin: ['role_privilege_missing', 'role_privilege_unexpected'], migrationLedger: ['migration_missing'] },
        'the 001-031 runtime refuses what is left: create_v2\'s EXECUTE missing, 028\'s not approved, 031 not recorded');
      const gone = await errorOf(create(u.kManager, u.S, u.T, u.C1));
      assert.equal(gone?.code, '42883', `create_v2 no longer exists (${JSON.stringify(gone)})`);
      const at030 = await save(u.manager, u.kManager, u.S, u.T, u.C2, [line('Saved at 030', 1, 1)], { fn: CREATE_FN_028 });
      const rows1 = await rowsOf([u.T]);
      assert.deepEqual({ ...rows1, drafts: rows1.drafts.filter((d) => JSON.parse(d).draft_id !== at030), lines: rows1.lines.filter((l) => JSON.parse(l).draft_id !== at030) }, rows0,
        '028\'s save is the one the login executes again; it changed nothing but its own draft and lines (the manager\'s rows exist)');
      const second = await rolledBack((tx) => tx.unsafe(DOWN_031).simple());
      assert.equal(second.code, '55000', 'a second down is refused');
      assert.equal(second.message, 'migration 031 rollback refused: migration 031 is not applied (tmpos_invoice_edit.m7b_invoice_draft_create_v2 is missing)');

      // 2. THE UP refuses (rolled back) when its preconditions fail.
      const TRIGGER_REFUSAL = 'migration 031 refused: tmpos_role.tenant_role_level does not carry exactly 021\'s version trigger and 030\'s guard trigger, each in its exact shape and enabled ALWAYS';
      const ACL_REFUSAL = 'migration 031 refused: the applying principal does not own 028\'s save routine, or tmpos_app\'s EXECUTE on it is not the one non-grantable entry 028 issued';
      for (const [what, first, message] of [
        ['030\'s guard trigger disabled', 'alter table tmpos_role.tenant_role_level disable trigger trg_tenant_role_level_invoice_guard', TRIGGER_REFUSAL],
        ['030\'s guard trigger enabled only in origin mode', 'alter table tmpos_role.tenant_role_level enable trigger trg_tenant_role_level_invoice_guard', TRIGGER_REFUSAL],
        ['030\'s guard trigger missing', 'drop trigger trg_tenant_role_level_invoice_guard on tmpos_role.tenant_role_level', TRIGGER_REFUSAL],
        ['028\'s ACL widened (tmpos_audit_writer)', `grant execute on function ${CREATE_028} to tmpos_audit_writer`, ACL_REFUSAL],
        ['028\'s ACL narrowed (tmpos_app\'s EXECUTE gone)', `revoke execute on function ${CREATE_028} from tmpos_app`, ACL_REFUSAL],
        ['028\'s ACL with a grantable entry', `grant execute on function ${CREATE_028} to tmpos_app with grant option`, ACL_REFUSAL],
      ]) {
        const refused = await rolledBack(async (tx) => { await tx.unsafe(first); await tx.unsafe(UP_031).simple(); });
        assert.deepEqual(refused, { code: '55000', message }, `the up refused: ${what}`);
      }
      assert.deepEqual(await surface(), surface030(with031), 'every refusal rolled back: the 030-era surface as it was');

      // 3. THE UP waits for an in-flight save (028's, the login's at 030) and an in-flight setter, and finishes — no deadlock
      //    (rolled back each time; 031 stays down).
      const w = await scene('k10up');
      const wOwn = await tenantOwner(w.T, 'k10up');
      const waitsOnASeven = async (pid, holder, what) => {
        const wait = await lockWaitOf(pid, holder);
        assert.equal(wait.ungranted.length, 1, `${what}: one ungranted lock (${JSON.stringify(wait.locks)})`);
        assert.deepEqual([wait.ungranted[0].locktype, wait.ungranted[0].mode], ['relation', 'AccessExclusiveLock'], `${what}: an ACCESS EXCLUSIVE relation lock`);
        const rel = wait.ungranted[0].rel.includes('.') ? wait.ungranted[0].rel : `public.${wait.ungranted[0].rel}`;
        assert.ok(WRITERS_ORDER.includes(rel), `${what}: on one of the seven (${rel})`);
      };
      for (const [what, holder] of [
        ['an in-flight save (028\'s)', () => holding(runtime, (tx) => create(w.kManager, w.S, w.T, w.C1, LINES, { db: tx, fn: CREATE_FN_028 }))],
        ['an in-flight REAL setter', () => holding(runtime, (tx) => setInvoices(wOwn.key, 'manager', 'create', w.T, 0, tx))],
      ]) {
        const held = holder();
        let up = null;
        try {
          await until(() => held.ready || held.out !== undefined, `the up: ${what} reached`);
          assert.equal(held.value[0].o_outcome, 'applied', `${what}: applied, uncommitted`);
          up = holding(owner, (tx) => tx.unsafe(UP_031).simple());
          await until(() => blockedBy(up.pid, held.pid), `the up waits for ${what}`);
          await waitsOnASeven(up.pid, held.pid, `the up behind ${what}`);
          assert.equal(up.ready, false, `the up behind ${what}: nothing ran yet`);
          held.release('rollback');
          finished(await held.done, what, 'rolled back');
          await until(() => up.ready || up.out !== undefined, `the up ran once ${what} ended`);
          up.release('rollback');
          finished(await up.done, `the up behind ${what}`, 'rolled back');
        } finally {
          held.release('rollback');
          await held.done;
          if (up !== null) { up.release('rollback'); await up.done; }
        }
      }
      assert.equal((await owner`select pg_catalog.to_regprocedure(${CREATE_V2}) is null as gone`)[0].gone, true, 'every proof rolled back: still no create_v2');

      // 4. THE UPGRADE 030 -> 031 by the trusted executor: no row changes, the same surface the first apply left.
      const upgrade = await trustedApply();
      assert.deepEqual([upgrade.outcome, upgrade.applied], ['complete', ['031']], JSON.stringify(upgrade).slice(0, 300));
      restored = true;
      assert.deepEqual(await rowsOf([u.T]), rows1, 'every draft, line, level, version, audit, outbox and idempotency row identical across the upgrade');
      assert.deepEqual(await surface(), with031, 'the same schema, functions (bodies, grants, attributes, comments), triggers and 028 ACL as the first apply left');
      const ledger = await owner`select version, checksum from public.schema_migrations order by version`;
      assert.deepEqual(ledger.map((x) => [x.version, x.checksum]), REQUIRED_MIGRATIONS.map((m) => [m.version, m.checksum]), 'the ledger is 001-031 again');
      assert.equal(ledger.at(-1).version, '031');
      assert.deepEqual(await preflightVerdict(), { runtimeLogin: [], migrationLedger: [] }, 'accepted again');
      assert.equal((await rolledBack((tx) => tx.unsafe(POSTCONDITION_031).simple())).code, undefined, '031\'s postcondition holds again');
      assert.equal((await errorOf(create(u.kManager, u.S, u.T, u.C1, LINES, { fn: CREATE_FN_028 })))?.code, '42501', '028\'s save closed to the login again');
      await save(u.manager, u.kManager, u.S, u.T, u.C1, [line('Saved at 031 again', 1, 1)]);

      // 5. THE DOWN again waits for an in-flight save (create_v2), an in-flight setter, and a setter queued on the key behind a
      //    held save, and finishes — no deadlock (rolled back each time: 031 stays applied). Inside it: the 030-era surface and
      //    every row identical.
      const d = await scene('k10down');
      const dOwn = await tenantOwner(d.T, 'k10down');
      const rowsBeforeDown = await rowsOf([u.T]);
      for (const [what, holder] of [
        ['an in-flight save (create_v2)', () => holding(runtime, (tx) => create(d.kManager, d.S, d.T, d.C1, LINES, { db: tx }))],
        ['an in-flight REAL setter', () => holding(runtime, (tx) => setInvoices(dOwn.key, 'manager', 'create', d.T, 0, tx))],
      ]) {
        const held = holder();
        let down = null;
        let inside = null;
        try {
          await until(() => held.ready || held.out !== undefined, `the down: ${what} reached`);
          assert.equal(held.value[0].o_outcome, 'applied', `${what}: applied, uncommitted`);
          // Read inside the down's own transaction: it holds the seven tables ACCESS EXCLUSIVE, and its catalog changes are its own.
          down = holding(owner, async (tx) => {
            await tx.unsafe(DOWN_031).simple();
            inside = { surface: await surface(tx), rows: await rowsOf([u.T], tx) };
          });
          await until(() => blockedBy(down.pid, held.pid), `the down waits for ${what}`);
          await waitsOnASeven(down.pid, held.pid, `the down behind ${what}`);
          held.release('rollback');
          finished(await held.done, what, 'rolled back');
          await until(() => down.ready || down.out !== undefined, `the down ran once ${what} ended`);
          assert.deepEqual(inside.surface, surface030(with031), `the down behind ${what}: inside it, the exact 030-era surface`);
          assert.deepEqual(inside.rows, rowsBeforeDown, `the down behind ${what}: inside it, every row of the cycle's tenant identical`);
          down.release('rollback');
          finished(await down.done, `the down behind ${what}`, 'rolled back');
        } finally {
          held.release('rollback');
          await held.done;
          if (down !== null) { down.release('rollback'); await down.done; }
        }
      }
      {
        // A setter queued on the key behind a held save, and the down behind both: the save ends, the setter takes the key and
        // commits, the down then runs — the key never stands between the down and the tables it locks.
        const heldSave = holding(runtime, (tx) => create(d.kManager, d.S, d.T, d.C1, LINES, { db: tx }));
        let writer = null;
        let down = null;
        try {
          await until(() => heldSave.ready || heldSave.out !== undefined, 'convoy: the save applied, uncommitted');
          writer = running(runtime, (tx) => setInvoices(dOwn.key, 'manager', 'create', d.T, 0, tx));
          await until(() => blockedBy(writer.pid, heldSave.pid), 'convoy: the setter waits on the key behind the save');
          assert.deepEqual(await waitsFor(writer.pid), [['advisory', 'ExclusiveLock']], 'convoy: on the key');
          let inside = null;
          down = holding(owner, async (tx) => {
            await tx.unsafe(DOWN_031).simple();
            inside = { surface: await surface(tx), rows: await rowsOf([u.T], tx) };
          });
          await until(() => blockedBy(down.pid, heldSave.pid), 'convoy: the down waits behind the save');
          heldSave.release('commit');
          finished(await heldSave.done, 'convoy: the save');
          finished(await writer.done, 'convoy: the setter');
          await until(() => down.ready || down.out !== undefined, 'convoy: the down ran once both ended');
          assert.deepEqual(inside.surface, surface030(with031), 'convoy: inside the down, the exact 030-era surface');
          assert.deepEqual(inside.rows, rowsBeforeDown, 'convoy: inside the down, every row of the cycle\'s tenant identical');
          down.release('rollback');
          finished(await down.done, 'convoy: the down', 'rolled back');
        } finally {
          heldSave.release('rollback');
          await heldSave.done;
          if (writer !== null) await writer.done;
          if (down !== null) { down.release('rollback'); await down.done; }
        }
      }
      assert.deepEqual(await rowsOf([u.T]), rowsBeforeDown, 'every down rolled back: every row of the cycle\'s tenant identical');
      assert.deepEqual(await surface(), with031, 'every down rolled back: 031 as it was');
      assert.deepEqual(await preflightVerdict(), { runtimeLogin: [], migrationLedger: [] }, 'and the 001-031 runtime accepts it');
    } finally {
      if (!restored) await restore();
    }
  } finally {
    await removeSynthetic();
  }
});

/** Every lock `pid` holds or waits for, and the transaction ids `holder` holds. */
async function lockWaitOf(pid, holder) {
  const holderXids = (await owner`select l.transactionid::text as xid from pg_catalog.pg_locks l
    where l.pid = ${holder} and l.locktype = 'transactionid' and l.mode = 'ExclusiveLock' and l.granted`).map((r) => r.xid);
  const locks = (await owner`select l.locktype::text as locktype, l.mode::text as mode, l.granted, l.transactionid::text as xid,
      l.relation::regclass::text as rel
    from pg_catalog.pg_locks l where l.pid = ${pid}`).map((r) => ({ ...r }));
  return { holderXids, locks, ungranted: locks.filter((l) => !l.granted) };
}

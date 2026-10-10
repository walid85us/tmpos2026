// Phase 4.0 M7B-INVOICES-P2 and P2-R1 — editing a saved store invoice draft against REAL PostgreSQL: migration 029 (the version
// CHECK widened under its own name, the immutability trigger and its function, the session-bound edit routine
// tmpos_invoice_draft.m7b_invoice_draft_update) and migration 030 (the Invoices-level guard: the AFTER row trigger on
// tmpos_role.tenant_role_level through which every writer of an Invoices level takes the transaction-scoped advisory key
// (530030, hashtext(tenant || '/' || role)) EXCLUSIVE, and the edit routine tmpos_invoice_edit.m7b_invoice_draft_update_v2 that
// takes the same key SHARED right after the draft header and decides the level again), exercised as the runtime's own
// non-owner login, every call bound as the production adapter binds it (the lines serialized once as jsonb text, every bigint
// as decimal text). The routine under test is UPDATE_FN, the single place it is named. Since migration 031 (M7B-INVOICES-P1-R3)
// the drafts this file edits are saved through 031's guarded save tmpos_invoice_edit.m7b_invoice_draft_create_v2 (031 closed
// 028's create to the login), and since migration 032 (M7B-INVOICES-P1-R4) through 032's version-3 save m7b_invoice_draft_create_v3
// (CREATE_FN; 032 closed create_v2 to the login), all in 030's schema: every rollback of 030 here rolls 032 and 031 back first.
//
// Case labels: R = red on the entry source (029's routine, no guard) for the defect DA-204, N = the new contract of 030, G = a
// guard that holds before and after. A case that mixes them says which block is which.
//
// WHAT IS PROVEN (each title carries the stage brief's acceptance criteria it evidences).
//   IDE-01 (AC-18 AC-12, N) 001-032 applied clean by the trusted executor, every ledger checksum the pinned one; 029's postcondition
//          re-proven over the applied state once 030's one revoke is undone inside a rolled-back transaction (and refusing
//          without it), 030's own re-proven and refusing every widening it names (032 and 031, whose routines 030's exact inventory does
//          not know, rolled back first in the same rolled-back transaction); a second apply refused.
//   IDE-02 (AC-18 AC-05 AC-12, N) the exact surface: 029's routine now executable by nobody but its owner; schema tmpos_invoice_edit
//          granting USAGE to tmpos_app alone beside its owner's own and holding exactly 030's two functions, 031's guarded save
//          m7b_invoice_draft_create_v2 (M7B-INVOICES-P1-R3: owner's EXECUTE alone since 032; 028's create closed to tmpos_app),
//          032's Customers level guard m7b_customers_level_guard and 032's version-3 save m7b_invoice_draft_create_v3
//          (M7B-INVOICES-P1-R4: EXECUTE held by its owner and tmpos_app alone, non-grantable); the edit v2 a VOLATILE SECURITY DEFINER pinned, EXECUTE
//          held by its owner and tmpos_app alone (non-grantable); the guard function a SECURITY INVOKER no runtime role may
//          execute (no grantee beside its owner); the level table's two ENABLE ALWAYS row triggers (021's and 030's); 029's
//          draft trigger and widened CHECK; no grant beyond the owner's on either draft table; the login holds no table or
//          column privilege on either, and its direct SELECT on the drafts and INSERT, UPDATE and DELETE on both are refused
//          (42501).
//   IDE-03 (AC-05 AC-10, G/N) a real edit replaces the customer and the ordered lines (add, remove, reorder, edit), the line count and
//          the subtotal and steps the version by one, atomically, while draft_id, tenant, store, status, currency, created_at
//          and created_by stay; the routine writes no audit, outbox or idempotency row and NO ROLE ROW (030: the edit makes
//          none); another draft of the same store and one of another store stay byte for byte (rows, xmin, ctid).
//   IDE-04 (AC-05 D8) the trigger refuses an owner's UPDATE of each immutable column and any version move other than +0/+1,
//          also under session_replication_role = replica; the CHECKs refuse status and currency.
//   IDE-05 (AC-06 AC-05, G/N) a current-version no-op answers 'unchanged' with the current version and writes nothing: the header's
//          bytes, xmin and ctid and every line's identical, no role row and no version row; equal totals with other lines, and a
//          reorder, are changes.
//   IDE-06 (AC-07 AC-05, G/N) a stale version conflicts with other contents AND with contents equal to the stored ones, writing
//          nothing, no role row, no version row.
//   IDE-07 (DA-36 AC-10 AC-05, G/N) every sealed or rolled-back answer — conflict, invalid_state, unchanged, not_found (missing,
//          other-store, other-tenant draft; missing and other-tenant customer), refused, tenant_mismatch — is reached with
//          NOTHING written, not even a role anchor or a version row, for a role that had no stored row before the call; the
//          change path makes none either (030).
//   IDE-08 (AC-15) every bound at the runtime's own constants (server/runtime/invoiceDrafts.ts:161-164; commandTransaction.ts
//          :124): description, quantity, price, line total, sum, subtotal, line count and expected version refused with
//          22023 and a fixed message carrying no value, writing nothing; each limit itself admitted; the version's top end
//          (2^53 - 2 -> 2^53 - 1) and the CHECK beyond it; outside READ COMMITTED, 55000.
//   IDE-09 (AC-09 D7) the REAL get, blocked between its header and its lines statements by a holder of ACCESS EXCLUSIVE on
//          the line table (condition: the getter's UNGRANTED AccessShareLock on exactly that relation beside the holder's
//          granted AccessExclusiveLock), returns the complete EARLIER draft after the holder commits a replacement through the
//          real edit routine; a test-only VOLATILE copy of the same body under the same interleave returns a MIXED draft.
//   IDE-10 (AC-08 AC-07) two distinct actors edit one version: the second waits on the header lock — an ungranted
//          transactionid ShareLock behind the first's transaction, holding the tuple lock on the header table — then
//          conflicts (also with the first's very contents: a stale no-op), never not_found; the first rolled back, it applies.
//   IDE-11 (AC-14 AC-03 AC-10, N; last block AC-01 AC-02, R) an owner's narrowing of the Invoices level to Create held
//          uncommitted BEFORE the edit reaches the guard: the edit waits on the role's KEY (an ungranted advisory ShareLock,
//          classid 530030, objid the key, objsubid 2, behind the writer's pid; the header already held), committed it is
//          REFUSED with nothing written, rolled back it applies; the edit first: the narrowing's UPDATE waits on the same key
//          (an advisory ExclusiveLock) behind the edit's pid and governs only later edits. DA-204 (a defect reproduction, red on
//          the entry source): a downgrade by the REAL setter (026), run by a different actor (a store owner with one tenant
//          grant) with the version it reviewed, committed while a stale edit or a current no-op waits on the header: the edit
//          is REFUSED, that draft's row and lines, the counts and the setter's own role and version rows untouched.
//   IDE-16 (AC-03 DA-204, R) the same with NO Invoices role row (the catalog default governs): the setter's FIRST insertion
//          committed while a current no-op or a stale edit waits on the header refuses it, nothing of the edit written.
//   IDE-22 (AC-01 DA-204, R) invalid_state's ordering, behaviourally (IDE-07's rolled-back owner transaction): a writer's
//          uncommitted narrowing holds the edit back and, committed, the edit is REFUSED, never invalid_state.
//   IDE-12 (AC-14) a grant suspended and a store made read-only, each before (the edit waits in 016's hold, then is refused,
//          nothing written) and after (the change waits for the edit's COMMIT).
//   IDE-19 (AC-07, N; real database clock) an 8 s session; a writer holds the key (an uncommitted first non-NULL INSERT); the edit
//          waits at the guard until the database clock passes the session's expiry; the writer rolled back, the edit is
//          REFUSED by the clock check after the wait, nothing written, no role row (replaces 029's IDE-15, step 10's anchor).
//   IDE-17 (AC-04, N) an edit holding the key (the routine's 'unchanged' or 'conflict' answered inside a transaction that stays
//          open): the REAL setter and a direct owner UPDATE each wait on the key behind the edit's pid and commit once it does;
//          the next edit is REFUSED.
//   IDE-18 (AC-06, G/N) a store owner's no-op, conflict and change take no key and write no row (pg_locks, the tables); a
//          manager's edit at the same point holds exactly the key (positive control).
//   IDE-20 (AC-11, N) writer participation: while an edit holds the key each writer path waits on it behind the edit's pid (the
//          setter's first insertion, update and reset to the default word; an owner's INSERT, UPDATE, UPDATE to NULL, DELETE of
//          a non-NULL row and key-moving UPDATEs, a row moved into and out of the Invoices domain included — out of it for a
//          technician's stored Edit, so the default View then refuses the edit), and since 032 a Customers-domain write of a level for
//          the same role (C2); a NULL anchor of either domain, another role's and another tenant's Invoices write do not wait; an owner TRUNCATE waits on the relation behind the
//          edit (and truncates once the edit ends, rolled back after); conversely each writer path holding uncommitted blocks the
//          edit at the guard and the committed level decides it; a waiting writer queues a later
//          edit behind it; a draft create and an edit do not block each other (since 031 the create holds the key SHARED too, deciding both levels under it since 032: N);
//          two owner transactions of opposite key-moving
//          UPDATEs, both parked in flight on the smaller key, hold none and both commit once it is released (no 40P01).
//   IDE-13 (AC-15 AC-18, N) the parity of every SQL restatement in 029 and in 030's v2 (defaults, owner literal, editable set,
//          ordering, Edit threshold, 017's description regexes), the two key expressions of v2 and of the trigger function
//          identical, v2's order (the key after the header FOR UPDATE and before the invalid_state, conflict and unchanged
//          returns, in the outermost block, no step-10 anchor), no raw invisible code point, the exact ordered change lists of
//          030's up and down, and every file's lock block first, in the writers' order, before every check and change.
//   IDE-14 (AC-18, N) the rollback and the upgrade, over an edited draft of its own, 032, 031 and 030 rolled back first (029's down
//          cannot see them): 029's down refused while not applied and while a draft is at version > 1 (everything unchanged), and —
//          locks first — refused when an edit it waited for commits; retained edit audit and outbox rows do not block it; with
//          no edited draft it restores 028's contract exactly (CHECK, no trigger or function, three routines, 028's comments,
//          028's own postcondition; 028's create executable by tmpos_app again, 031's down having given its grant back) and the
//          001-032 runtime refuses that database; the 028 database holding drafts and role configuration (saved there through
//          028's create) upgrades to 032 with every row unchanged and edits at once.
//   IDE-21 (AC-12, N) 030 down, up and down again over drafts above version 1 and stored overrides, 032 and 031 (their routines
//          in 030's schema, which 030's down would refuse to drop) rolled back before each 030 down: every row identical; the
//          down restores 029's contract exactly (its routine's body, ACL and comment, the level table's one trigger of 021, the
//          schema gone) and the 001-032 runtime refuses what is left; a second down is refused; the down and the up each wait
//          for a held edit and a held writer and finish, without deadlock; the up refuses when 029's EXECUTE is already gone;
//          the upgrade 029 -> 032 changes no row.
//
// DISPOSABLE ONLY. The harness's resolved target: a supplied CI service when one is bound, otherwise a cluster this file
// creates and destroys. Every fixture is synthetic and randomly suffixed; every id and key is made at run time. It rolls 032, 031, 030
// and 029 back and restores them (IDE-14, IDE-21), so on a shared service it runs after every step that rolls 028 back. It leaves
// 030, 031 and 032 applied, the ledger 001-032, the issuer key row it found, and NO draft, line, audit subject, role row, session,
// mint-ledger row, throwaway schema or login of its own.
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
import { TENANT_ORDERING, TENANT_ROLE_PERMISSION_DEFAULTS } from '../../server/platform-identity/permissionCatalog.ts';
import { principalKeyOf } from '../../server/runtime/sessions.ts';
import {
  INVOICE_DRAFT_DESCRIPTION_MAX_CHARACTERS, INVOICE_DRAFT_MAX_AMOUNT, INVOICE_DRAFT_MAX_LINES,
} from '../../server/runtime/invoiceDrafts.ts';

const MIG_REL = 'server/platform-identity/migrations';
const MIG_DIR = new URL(`../../${MIG_REL}/`, import.meta.url).pathname.replace(/\/$/, '');
const UP_028 = readFileSync(`${MIG_DIR}/028_m7b_invoice_drafts.up.sql`, 'utf8');
const UP_029 = readFileSync(`${MIG_DIR}/029_m7b_invoice_draft_edit.up.sql`, 'utf8');
const DOWN_029 = readFileSync(`${MIG_DIR}/029_m7b_invoice_draft_edit.down.sql`, 'utf8');
const UP_030 = readFileSync(`${MIG_DIR}/030_m7b_invoice_edit_authority.up.sql`, 'utf8');
const DOWN_030 = readFileSync(`${MIG_DIR}/030_m7b_invoice_edit_authority.down.sql`, 'utf8');
/** M7B-INVOICES-P1-R3: 031 (the guarded draft save, in 030's schema) sits above 030: it rolls back first and is applied with it. */
const UP_031 = readFileSync(`${MIG_DIR}/031_m7b_invoice_create_authority.up.sql`, 'utf8');
const DOWN_031 = readFileSync(`${MIG_DIR}/031_m7b_invoice_create_authority.down.sql`, 'utf8');
/** M7B-INVOICES-P1-R4: 032 (the Customers authority of the guarded draft save, in 030's schema) sits above 031: it rolls back first and is applied with it. */
const UP_032 = readFileSync(`${MIG_DIR}/032_m7b_invoice_create_customers_authority.up.sql`, 'utf8');
const DOWN_032 = readFileSync(`${MIG_DIR}/032_m7b_invoice_create_customers_authority.down.sql`, 'utf8');
/** Each up file's last DO block, its postcondition, run again on its own. */
const POSTCONDITION_028 = UP_028.slice(UP_028.lastIndexOf('do $$'));
const POSTCONDITION_029 = UP_029.slice(UP_029.lastIndexOf('do $$'));
const POSTCONDITION_030 = UP_030.slice(UP_030.lastIndexOf('do $$'));
const CREATE = 'tmpos_invoice_draft.m7b_invoice_draft_create(text, uuid, uuid, uuid, uuid, jsonb, bigint)';
/**
 * The save the suite's create() calls, by name: migration 032's version-3 save (M7B-INVOICES-P1-R4), which 032 granted the login
 * in place of 031's create_v2 (CREATE_FN_V2), itself granted in place of 028's create (CREATE_FN_028; create() calls either with
 * { fn } on a database 032 and 031 are rolled back from).
 */
const CREATE_FN = 'tmpos_invoice_edit.m7b_invoice_draft_create_v3';
const CREATE_FN_V2 = 'tmpos_invoice_edit.m7b_invoice_draft_create_v2';
const CREATE_FN_028 = 'tmpos_invoice_draft.m7b_invoice_draft_create';
const CREATE_V2 = `${CREATE_FN_V2}(text, uuid, uuid, uuid, uuid, jsonb, bigint)`;
const CREATE_V3 = `${CREATE_FN}(text, uuid, uuid, uuid, uuid, jsonb, bigint)`;
const PAGE = 'tmpos_invoice_draft.m7b_invoice_draft_page(text, uuid, uuid, uuid, integer)';
const GET = 'tmpos_invoice_draft.m7b_invoice_draft_get(text, uuid, uuid, uuid)';
const UPDATE = 'tmpos_invoice_draft.m7b_invoice_draft_update(text, uuid, uuid, uuid, bigint, uuid, jsonb, bigint)';
/** The edit routine the suite's edit() calls, by name: the single place the routine under test is named. */
const UPDATE_FN = 'tmpos_invoice_edit.m7b_invoice_draft_update_v2';
/** 029's routine by name (edit() calls it with { fn }): the contract migration 030's rollback restores. */
const UPDATE_FN_029 = 'tmpos_invoice_draft.m7b_invoice_draft_update';
const UPDATE_V2 = `${UPDATE_FN}(text, uuid, uuid, uuid, bigint, uuid, jsonb, bigint)`;
const GUARD = 'tmpos_invoice_edit.m7b_invoice_level_guard()';
/** M7B-INVOICES-P1-R4: 032's trigger function for the Customers level, beside 030's for the Invoices level. */
const CUSTOMERS_GUARD = 'tmpos_invoice_edit.m7b_customers_level_guard()';
/** The class of the advisory key every Invoices-level writer and the edit take: pg_locks.classid, with objsubid 2 (two-int form). */
const GUARD_CLASS = 530_030;
const IMMUTABLE = 'tmpos_invoice_draft.m7b_invoice_draft_immutable()';
const MIGRATOR = { purpose: 'migration', migratorRef: 'ide-migrator', runtimeRef: 'ide-runtime' };
const LOCK_KEY = 529_529;
const NOW = () => new Date().toISOString();
const SUFFIX = randomUUID().slice(0, 8);
const RUNTIME_LOGIN = 'tmpos_ide_probe';
const SCRATCH_SCHEMA = `ide_volatile_${SUFFIX}`;
const HOUR = 3_600_000;
/** The runtime's amount bound (invoiceDrafts.ts:164) and its expected-version bound (commandTransaction.ts:124). */
const MAX = INVOICE_DRAFT_MAX_AMOUNT;
const MAX_EXPECTED = Number.MAX_SAFE_INTEGER - 1;
const ROLLBACK = new Error('ide: roll the proof back');
const RC = 'isolation level read committed';
const ISSUER_KEY = randomBytes(32);
const NULLS = Object.freeze({ o_tenant_id: null, o_store_id: null, o_actor_id: null, o_membership_id: null, o_version: null });
const answer = (outcome) => ({ o_outcome: outcome, ...NULLS });
const REFUSED = answer('refused');
/**
 * The seven tables 028's rollback locks, in the order the runtime's writers take them (R7): 029's up and down lock the same,
 * first.
 */
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

const TARGET = resolveDisposableTarget('IDE');
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

const owner = connect(undefined, 4);
let runtime = null;
const UIDS = [];
const TENANTS = [];
const KEYS = new Set();
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

/** Everything this suite wrote that a later rollback of 029, 028 or 026 would refuse over: drafts, lines, anchors, subjects. */
async function cleanDrafts() {
  if (TENANTS.length === 0) return;
  await owner.begin(RC, async (sql) => {
    const [{ applied }] = await sql`select pg_catalog.to_regclass('tmpos_invoice_draft.invoice_draft') is not null as applied`;
    if (applied) {
      const drafts = (await sql`select draft_id from tmpos_invoice_draft.invoice_draft where tenant_id = any(${TENANTS}::uuid[])`).map((r) => r.draft_id);
      if (drafts.length > 0) {
        // 002's append-only trigger is lifted for this one update and put back in exactly the mode it was found in.
        const [{ mode }] = await sql`select tgenabled as mode from pg_catalog.pg_trigger
          where tgrelid = 'public.audit_event'::regclass and tgname = 'trg_audit_event_reject_mutation'`;
        const restore = { O: 'enable trigger', D: 'disable trigger', R: 'enable replica trigger', A: 'enable always trigger' }[mode];
        assert.ok(restore, `the append-only trigger's mode is known: ${mode}`);
        await sql.unsafe('alter table public.audit_event disable trigger trg_audit_event_reject_mutation');
        await sql`update public.audit_event set subject_invoice_draft_id = null where subject_invoice_draft_id = any(${drafts}::uuid[])`;
        await sql.unsafe(`alter table public.audit_event ${restore} trg_audit_event_reject_mutation`);
      }
      await sql`delete from tmpos_invoice_draft.invoice_draft_line where tenant_id = any(${TENANTS}::uuid[])`;
      await sql`delete from tmpos_invoice_draft.invoice_draft where tenant_id = any(${TENANTS}::uuid[])`;
    }
    await sql`delete from tmpos_role_edit.role_level_version where tenant_id = any(${TENANTS}::uuid[])`;
    await sql`delete from tmpos_role.tenant_role_level where tenant_id = any(${TENANTS}::uuid[])`;
  });
}

test.after(async () => {
  const failures = [];
  const step = async (fn) => { try { await fn(); } catch (err) { failures.push(err); } };
  try {
    await step(() => owner.unsafe(`drop schema if exists ${SCRATCH_SCHEMA} cascade`));
    await step(cleanDrafts);
    // A failed IDE-14 or IDE-21 may have left 032, 031 and 030 (and 029) rolled back: the executor applies them again.
    await step(async () => {
      if (!(await owner`select exists (select 1 from public.schema_migrations where version = '032') as applied`)[0].applied) {
        const report = await trustedApply();
        assert.equal(report.outcome, 'complete', JSON.stringify(report).slice(0, 300));
      }
    });
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
          pg_catalog.to_regprocedure(${UPDATE}) is not null as routine_029,
          exists (select 1 from public.schema_migrations where version = '029') as ledger_029,
          pg_catalog.to_regprocedure(${UPDATE_V2}) is not null as routine_030,
          exists (select 1 from public.schema_migrations where version = '030') as ledger_030,
          pg_catalog.to_regprocedure(${CREATE_V2}) is not null as routine_031,
          exists (select 1 from public.schema_migrations where version = '031') as ledger_031,
          pg_catalog.to_regprocedure(${CREATE_V3}) is not null as routine_032,
          exists (select 1 from public.schema_migrations where version = '032') as ledger_032,
          pg_catalog.to_regnamespace(${SCRATCH_SCHEMA}) is null as no_scratch,
          (select count(*) from tmpos_invoice_draft.invoice_draft where tenant_id = any(${TENANTS}::uuid[]))::int as drafts,
          (select count(*) from public.audit_event where subject_invoice_draft_id is not null and tenant_id = any(${TENANTS}::uuid[]))::int as subjects,
          (select count(*) from tmpos_role.tenant_role_level where tenant_id = any(${TENANTS}::uuid[]))::int as anchors,
          (select count(*) from tmpos_session.session where auth_provider_uid = any(${UIDS}::text[]))::int as sessions,
          exists (select 1 from pg_catalog.pg_roles where rolname = ${RUNTIME_LOGIN}) as login`;
      assert.deepEqual({ ...state }, { routine_029: true, ledger_029: true, routine_030: true, ledger_030: true, routine_031: true, ledger_031: true, routine_032: true, ledger_032: true, no_scratch: true, drafts: 0, subjects: 0, anchors: 0, sessions: 0, login: false },
        'left as found: 029, 030, 031 and 032 applied and recorded, nothing of this suite\'s retained');
    });
  } finally {
    await step(() => owner.end({ timeout: 5 }));
    if (cluster) cluster.stop();
  }
  if (failures.length > 0) throw new AggregateError(failures, 'IDE teardown: a cleanup step or postcondition failed');
});

// ---------------------------------------------------------------------------
// setup: every migration in the directory (001-032), a real non-owner runtime login, the issuer key installed by the owner
// ---------------------------------------------------------------------------

await owner.unsafe(`do $$ begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;`);
await owner.unsafe(`revoke create on database "${DATABASE}" from public`);
await owner.unsafe(`revoke temporary on database "${DATABASE}" from public`);
const applyReport = await trustedApply();
await owner.unsafe(`do $$ begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = '${RUNTIME_LOGIN}') then execute 'drop owned by ${RUNTIME_LOGIN}'; end if;
end $$;`);
await owner.unsafe(`drop role if exists ${RUNTIME_LOGIN}`);
await owner.unsafe(`create role ${RUNTIME_LOGIN} login nosuperuser nocreatedb nocreaterole noreplication nobypassrls inherit`);
await owner.unsafe(`grant tmpos_app to ${RUNTIME_LOGIN}`);
await owner.unsafe(`grant tmpos_audit_writer to ${RUNTIME_LOGIN}`);
await owner.unsafe(`grant select on public.schema_migrations to ${RUNTIME_LOGIN}`);
runtime = connect(RUNTIME_LOGIN, 3);
issuerKeyBefore = (await owner`select key from tmpos_mint.issuer_key where singleton`)[0]?.key ?? null;
if (issuerKeyBefore !== null) issuerKeyBefore = Buffer.from(issuerKeyBefore);
await installTestIssuerKey(owner, ISSUER_KEY);

// ---------------------------------------------------------------------------
// fixtures (owner connection, synthetic)
// ---------------------------------------------------------------------------

const newTenant = async (label, status = 'active') => {
  const [{ tenant_id: id }] = await owner`insert into tenant (display_name, status) values (${`ide-${label}-${SUFFIX}`}, ${status}) returning tenant_id`;
  TENANTS.push(id);
  return id;
};
const newStore = async (tenant, name, status = 'active') =>
  (await owner`insert into store (tenant_id, store_name, status) values (${tenant}, ${name}, ${status}) returning store_id`)[0].store_id;
const newCustomer = async (tenant, label) => {
  const id = randomUUID();
  await owner`insert into tmpos_customer.customer (customer_id, tenant_id, name) values (${id}, ${tenant}, ${`IDE ${label} ${SUFFIX}`})`;
  return id;
};
async function actor(label, memberships, accountStatus = 'active') {
  const uid = `ide-${label}-${SUFFIX}`;
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
/** The tenant owner's stored level for `role` on `domain` (020's table, as the role-level suites write it). */
const setLevel = (tenant, role, domain, level) => owner`insert into tmpos_role.tenant_role_level (tenant_id, role_id, domain, level, updated_at)
  values (${tenant}, ${role}, ${domain}, ${level}, now()) on conflict (tenant_id, role_id, domain) do update set level = excluded.level, updated_at = excluded.updated_at`;

// ---------------------------------------------------------------------------
// the runtime login's calls, bound as postgresInvoiceDrafts.ts binds them
// ---------------------------------------------------------------------------

const record = (who, at = Date.now()) => ({
  audience: 'tenant', authProvider: 'firebase', authProviderUid: who.uid, principalKey: principalKeyOf(who.principal),
  securityVersion: 't2:ide', authenticatedAt: at, createdAt: at, lastSeenAt: at, validatedAt: at,
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
/** The save (CREATE_FN, 032's; `fn` names another with the same signature, 031's or 028's), as its mutator binds it. */
async function create(key, store, tenant, customer, lines, { db = runtime, fn = CREATE_FN } = {}) {
  const draft = randomUUID();
  const [row] = await db.unsafe(`select o_outcome from ${fn}($1::text, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::text::jsonb, $7::bigint)`,
    [key, store, draft, tenant, customer, JSON.stringify(lines), String(sumOf(lines))]);
  assert.equal(row.o_outcome, 'applied', 'the draft saved');
  return draft;
}
/** The edit routine (UPDATE_FN; `fn` names another with the same signature, 029's), bound as the update mutator binds it; `lines` a JS array (serialized once) or raw jsonb text. */
async function edit(key, store, tenant, draft, version, customer, lines, { subtotal, db = runtime, fn = UPDATE_FN } = {}) {
  const text = typeof lines === 'string' ? lines : JSON.stringify(lines);
  const total = subtotal ?? String(sumOf(lines));
  return (await db.unsafe(`select o_outcome, o_tenant_id, o_store_id, o_actor_id, o_membership_id, o_version
    from ${fn}($1::text, $2::uuid, $3::uuid, $4::uuid, $5::bigint, $6::uuid, $7::text::jsonb, $8::bigint)`,
  [key, store, draft, tenant, String(version), customer, text, String(total)])).map((r) => ({ ...r }));
}
const get = async (key, tenant, store, draft, db = runtime, fn = 'tmpos_invoice_draft.m7b_invoice_draft_get') => (await db.unsafe(
  `select o_outcome, o_draft_id, o_customer_id, o_version, o_line_count, o_subtotal_cents, o_position, o_description, o_quantity, o_unit_price_cents
     from ${fn}($1::text, $2::uuid, $3::uuid, $4::uuid)`, [key, tenant, store, draft])).map((r) => ({ ...r }));
const errorOf = (p) => Promise.resolve(p).then(() => null, (err) => ({ code: err.code, message: String(err.message) }));
const done = (outcome, who, tenant, store, version) => ({ o_outcome: outcome, o_tenant_id: tenant, o_store_id: store, o_actor_id: who.id,
  o_membership_id: who.memberships[0], o_version: String(version) });

/** What a scope holds now: drafts, lines and role rows of its tenant(s); every audit record (and those naming a draft), every outbox event and every idempotency record. */
async function footprint(tenants, db = owner) {
  const [r] = await db`select
    (select count(*) from tmpos_invoice_draft.invoice_draft where tenant_id = any(${tenants}::uuid[]))::int as drafts,
    (select count(*) from tmpos_invoice_draft.invoice_draft_line where tenant_id = any(${tenants}::uuid[]))::int as lines,
    (select count(*) from tmpos_role.tenant_role_level where tenant_id = any(${tenants}::uuid[]))::int as roles,
    (select count(*) from tmpos_role_edit.role_level_version where tenant_id = any(${tenants}::uuid[]))::int as versions,
    (select count(*) from public.audit_event where subject_invoice_draft_id is not null)::int as subjects,
    (select count(*) from public.audit_event)::int as audits,
    (select count(*) from tmpos_internal.outbox_event)::int as events,
    (select count(*) from tmpos_internal.idempotency_record)::int as records`;
  return { ...r };
}
/** A draft's exact stored state: the header's and each line's row, xmin and ctid (a write would move xmin and ctid). */
async function stateOf(draft, db = owner) {
  const header = (await db`select pg_catalog.to_jsonb(d) as row, d.xmin::text as xmin, d.ctid::text as ctid
    from tmpos_invoice_draft.invoice_draft d where d.draft_id = ${draft}`).map((r) => ({ ...r }));
  const lines = (await db`select pg_catalog.to_jsonb(l) as row, l.xmin::text as xmin, l.ctid::text as ctid
    from tmpos_invoice_draft.invoice_draft_line l where l.draft_id = ${draft} order by l.position`).map((r) => ({ ...r }));
  return { header, lines };
}
/** The header's business columns and its ordered lines, as stored. */
async function contentOf(draft, db = owner) {
  const [h] = await db`select draft_id, tenant_id, store_id, customer_id, status, currency, version::text as version, line_count,
      subtotal_cents::text as subtotal, created_at::text as created_at, created_by
    from tmpos_invoice_draft.invoice_draft where draft_id = ${draft}`;
  const lines = (await db`select position, description, quantity::text as q, unit_price_cents::text as p, line_total_cents::text as t
    from tmpos_invoice_draft.invoice_draft_line where draft_id = ${draft} order by position`).map((r) => ({ ...r }));
  return { header: h === undefined ? null : { ...h }, lines };
}
const linesAs = (lines) => lines.map((l, i) => ({ position: i + 1, description: l.description, q: String(l.quantity), p: String(l.unitPriceCents),
  t: String(BigInt(l.quantity) * BigInt(l.unitPriceCents)) }));
/** Runs `fn` in an owner transaction that is always rolled back: { value } or the { code, message } it raised. */
async function rolledBack(fn) {
  let out;
  await assert.rejects(owner.begin(RC, async (tx) => {
    out = await fn(tx).then((value) => ({ value }), (err) => ({ code: err.code, message: String(err.message) }));
    throw ROLLBACK;
  }), (err) => err === ROLLBACK);
  return out;
}
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
 * `release('rollback')`; released to commit, it first runs `then(tx, value)` (if given) in the same transaction. `pid` is
 * its backend; `ready` turns true once `fn` has answered (so a blocked `fn` is never ready).
 */
function holding(db, fn, then = null) {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const h = { pid: null, ready: false, release: (how) => release(how) };
  h.done = db.begin(RC, async (tx) => {
    h.pid = (await tx`select pg_catalog.pg_backend_pid() as pid`)[0].pid;
    const value = await fn(tx);
    h.ready = true;
    if ((await gate) === 'rollback') throw ROLLBACK;
    return then === null ? value : then(tx, value);
  }).then((value) => ({ outcome: 'committed', value }),
    (err) => (err === ROLLBACK ? { outcome: 'rolled back' } : { outcome: 'failed', code: err.code, message: String(err.message) }));
  return h;
}
/** A statement on `db` in its own transaction, its backend pid exposed as soon as it is known. */
function running(db, fn) {
  const r = { pid: null };
  r.done = db.begin(RC, async (tx) => {
    r.pid = (await tx`select pg_catalog.pg_backend_pid() as pid`)[0].pid;
    return fn(tx);
  }).then((value) => ({ outcome: 'committed', value }), (err) => ({ outcome: 'failed', code: err.code, message: String(err.message) }));
  return r;
}
const blockedBy = async (pid, holder) => pid !== null && holder !== null
  && (await owner`select pg_catalog.pg_blocking_pids(${pid}) as b`)[0].b.includes(holder);
const waitingIn = async (pid) => (await owner`select (select count(*) from pg_catalog.pg_locks l where l.pid = ${pid} and not l.granted)::int as waiting,
  (select a.query from pg_catalog.pg_stat_activity a where a.pid = ${pid}) as query`)[0];
/** Every lock `pid` holds or waits for, and the transaction ids `holder` holds (its own and its subtransactions'). */
async function lockWaitOf(pid, holder) {
  const holderXids = (await owner`select l.transactionid::text as xid from pg_catalog.pg_locks l
    where l.pid = ${holder} and l.locktype = 'transactionid' and l.mode = 'ExclusiveLock' and l.granted`).map((r) => r.xid);
  const locks = (await owner`select l.locktype::text as locktype, l.mode::text as mode, l.granted, l.transactionid::text as xid,
      l.relation::regclass::text as rel
    from pg_catalog.pg_locks l where l.pid = ${pid}`).map((r) => ({ ...r }));
  return { holderXids, locks, ungranted: locks.filter((l) => !l.granted), tuples: locks.filter((l) => l.locktype === 'tuple') };
}
/** The database clock, in epoch milliseconds (the routine's own reading). */
const dbNow = async () => BigInt((await owner`select pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp()) * 1000)::bigint::text as now`)[0].now);
/** The guard key of (tenant, role) as the database computes it: hashtext of 'tenant/role', an int4 (pg_locks.objid, read as int4). */
const guardKey = async (tenant, role) => (await owner`select pg_catalog.hashtext(${tenant}::text || '/' || ${role}::text) as k`)[0].k;
/** Every guard-class advisory lock `pid` holds or waits for: class, key (int4), objsubid, mode, granted — ordered. */
const guardLocksOf = async (pid) => (await owner`select l.classid::int as class, l.objid::int as key, l.objsubid::int as sub, l.mode::text as mode, l.granted
  from pg_catalog.pg_locks l where l.pid = ${pid} and l.locktype = 'advisory' and l.classid::int = ${GUARD_CLASS} order by 2, 4, 5`).map((r) => ({ ...r }));
/** The guard lock a participant holds or waits for on (tenant, role): ShareLock (the edit) or ExclusiveLock (a writer). */
const guardLock = async (tenant, role, mode, granted = true) => ({ class: GUARD_CLASS, key: await guardKey(tenant, role), sub: 2, mode, granted });
/** The ungranted locks `pid` waits for, as [locktype, mode] pairs (the barrier shape of IDE-10's header wait). */
const waitsFor = async (pid) => (await owner`select l.locktype::text as locktype, l.mode::text as mode from pg_catalog.pg_locks l
  where l.pid = ${pid} and not l.granted order by 1, 2`).map((r) => [r.locktype, r.mode]);
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
/** 029's postcondition over the applied chain: 030 revoked tmpos_app's EXECUTE on 029's routine, which 029 demands, so it is granted back first (inside the caller's rolled-back transaction). */
const post029 = async (tx, ...first) => {
  await tx.unsafe(`grant execute on function ${UPDATE} to tmpos_app`);
  for (const statement of first) await tx.unsafe(statement);
  await tx.unsafe(POSTCONDITION_029).simple();
};

// The scene: tenant A with two stores, tenant B with one; customers in each.
const T_A = await newTenant('a');
const T_B = await newTenant('b');
const S_A1 = await newStore(T_A, `A1 ${SUFFIX}`);
const S_A2 = await newStore(T_A, `A2 ${SUFFIX}`);
const S_B1 = await newStore(T_B, `B1 ${SUFFIX}`);
const C_A = await newCustomer(T_A, 'a');
const C_A2 = await newCustomer(T_A, 'a2');
const C_B = await newCustomer(T_B, 'b');
const LINES = [line('Screen replacement', 1, 12_999), line('Labour  (1 hr)', 2, 4_500), line('Tempered glass ' + String.fromCodePoint(0x1f4f1), 3, 0)];

/** A fresh tenant, store, two customers, its store owner (no role row ever) and a manager, and one saved draft (through `createFn`, else CREATE_FN). */
async function scene(label, { managerLevel, createFn } = {}) {
  const T = await newTenant(label);
  const S = await newStore(T, `${label} ${SUFFIX}`);
  const C1 = await newCustomer(T, `${label}-1`);
  const C2 = await newCustomer(T, `${label}-2`);
  const boss = await actor(`${label}-owner`, [storeGrant(T, S, 'store_owner')]);
  const manager = await actor(`${label}-manager`, [storeGrant(T, S, 'manager')]);
  if (managerLevel !== undefined) await setLevel(T, 'manager', 'invoices', managerLevel);
  const kBoss = await mint(boss);
  const kManager = await mint(manager);
  const draft = await create(kBoss, S, T, C1, LINES, createFn === undefined ? {} : { fn: createFn });
  return { T, S, C1, C2, boss, manager, kBoss, kManager, draft };
}

// ===========================================================================
// IDE-01..02: the migration, the surface and the ACL
// ===========================================================================

test('IDE-01 (AC-18 AC-12, N): 001-032 applied clean, every checksum the pinned one; 029\'s postcondition holds once 030\'s one revoke is undone (and refuses without it) and refuses every widening it names; 030\'s postcondition holds once 031 is rolled back above it (and refuses without that) and refuses every widening it names; a second apply is refused', async () => {
  assert.equal(applyReport.outcome, 'complete', JSON.stringify(applyReport).slice(0, 400));
  const ledger = await owner`select version, dirty, checksum from public.schema_migrations order by version`;
  assert.deepEqual(ledger.map((r) => [r.version, r.dirty]), Array.from({ length: 32 }, (_, i) => [String(i + 1).padStart(3, '0'), false]));
  assert.deepEqual(ledger.map((r) => r.checksum), REQUIRED_MIGRATIONS.map((m) => m.checksum), 'every ledger checksum is the pinned one');
  assert.equal(ledger[28].checksum, createHash('sha256').update(UP_029).digest('hex'), '029\'s checksum is its up bytes');
  assert.equal(ledger[29].checksum, createHash('sha256').update(UP_030).digest('hex'), '030\'s checksum is its up bytes');
  assert.equal(ledger[30].checksum, createHash('sha256').update(UP_031).digest('hex'), '031\'s checksum is its up bytes');
  assert.equal(ledger[31].checksum, createHash('sha256').update(UP_032).digest('hex'), '032\'s checksum is its up bytes');
  // 029's postcondition demands tmpos_app's EXECUTE on 029's routine; 030 revoked it (the new routine took its place), so the
  // postcondition holds over the applied state only with that one grant restored — inside a rolled-back transaction here.
  const without = await rolledBack((tx) => tx.unsafe(POSTCONDITION_029).simple());
  assert.equal(without.code, '55000', 'as applied, 029\'s postcondition sees 030\'s revoke');
  assert.match(without.message, /^migration 029 refused/);
  assert.equal((await rolledBack((tx) => post029(tx))).code, undefined, 'with 029\'s EXECUTE granted back, the applied state satisfies 029\'s postcondition');
  // M7B-INVOICES-P1-R3: 030's postcondition demands that its schema hold exactly its two functions; 031 put its guarded save
  // there (and 032, M7B-INVOICES-P1-R4, its Customers guard function and version-3 save, with a third trigger on the level table),
  // so 030's postcondition is judged on 030's own surface — 032's and then 031's committed downs run first, in the same
  // rolled-back transaction (neither down refuses on data) — and as applied it sees their routines.
  const on031 = await rolledBack((tx) => tx.unsafe(POSTCONDITION_030).simple());
  assert.equal(on031.code, '55000', `032 and 031 applied: 030's exact inventory sees their routines in its schema (${JSON.stringify(on031)})`);
  assert.match(on031.message, /^migration 030 refused/);
  assert.equal((await rolledBack(async (tx) => { await tx.unsafe(DOWN_032).simple(); await tx.unsafe(DOWN_031).simple(); await tx.unsafe(POSTCONDITION_030).simple(); })).code, undefined,
    'the applied state satisfies 030\'s postcondition (032 and 031 rolled back above it)');
  for (const [label, widen] of [
    ['EXECUTE to PUBLIC', `grant execute on function ${UPDATE} to public`],
    ['EXECUTE to the audit writer', `grant execute on function ${UPDATE} to tmpos_audit_writer`],
    ['a grantable EXECUTE', `grant execute on function ${UPDATE} to tmpos_app with grant option`],
    ['the trigger function to tmpos_app', `grant execute on function ${IMMUTABLE} to tmpos_app`],
    ['a stable edit', `alter function ${UPDATE} stable`],
    ['an invoker edit', `alter function ${UPDATE} security invoker`],
    ['an edit with row security on', `alter function ${UPDATE} reset row_security`],
    ['a definer trigger function', `alter function ${IMMUTABLE} security definer`],
    ['the trigger enabled for origin sessions only', 'alter table tmpos_invoice_draft.invoice_draft enable trigger trg_invoice_draft_immutable'],
    ['the trigger disabled', 'alter table tmpos_invoice_draft.invoice_draft disable trigger trg_invoice_draft_immutable'],
    ['a second trigger', `create trigger extra before delete on tmpos_invoice_draft.invoice_draft_line for each row execute function ${IMMUTABLE}`],
    ['the trigger dropped', 'drop trigger trg_invoice_draft_immutable on tmpos_invoice_draft.invoice_draft'],
    ['a relaxed version CHECK', 'alter table tmpos_invoice_draft.invoice_draft drop constraint invoice_draft_version_chk, add constraint invoice_draft_version_chk check (version >= 1)'],
    ['an unvalidated version CHECK', 'alter table tmpos_invoice_draft.invoice_draft drop constraint invoice_draft_version_chk, add constraint invoice_draft_version_chk check (version between 1 and 9007199254740991) not valid'],
    ['a sixth routine', 'create function tmpos_invoice_draft.extra() returns integer language sql as \'select 1\''],
    ['SELECT on the drafts to tmpos_app', 'grant select on tmpos_invoice_draft.invoice_draft to tmpos_app'],
    ['UPDATE on the lines to tmpos_app', 'grant update on tmpos_invoice_draft.invoice_draft_line to tmpos_app'],
    ['a column grant', 'grant update (customer_id) on tmpos_invoice_draft.invoice_draft to authenticated'],
    ['the audit subject\'s comment reverted', 'comment on column public.audit_event.subject_invoice_draft_id is \'x\''],
    ['a draft table\'s comment reverted', 'comment on table tmpos_invoice_draft.invoice_draft_line is \'x\''],
  ]) {
    const out = await rolledBack((tx) => post029(tx, widen));
    assert.equal(out.code, '55000', `${label}: refused (${JSON.stringify(out)})`);
    assert.match(out.message, /^migration 029 refused/, label);
  }
  // 030's postcondition refuses each widening of its own surface (each in a rolled-back transaction over the applied state, 032
  // and then 031 rolled back above it first).
  for (const [label, widen] of [
    ['v2 EXECUTE to PUBLIC', `grant execute on function ${UPDATE_V2} to public`],
    ['v2 EXECUTE to the audit writer', `grant execute on function ${UPDATE_V2} to tmpos_audit_writer`],
    ['a grantable v2 EXECUTE', `grant execute on function ${UPDATE_V2} to tmpos_app with grant option`],
    ['v2 EXECUTE revoked from tmpos_app', `revoke execute on function ${UPDATE_V2} from tmpos_app`],
    ['the guard function to tmpos_app', `grant execute on function ${GUARD} to tmpos_app`],
    ['029\'s routine back to tmpos_app', `grant execute on function ${UPDATE} to tmpos_app`],
    ['a stable v2', `alter function ${UPDATE_V2} stable`],
    ['an invoker v2', `alter function ${UPDATE_V2} security invoker`],
    ['a v2 with row security on', `alter function ${UPDATE_V2} reset row_security`],
    ['a definer guard function', `alter function ${GUARD} security definer`],
    ['the guard trigger disabled', 'alter table tmpos_role.tenant_role_level disable trigger trg_tenant_role_level_invoice_guard'],
    ['the guard trigger enabled for origin sessions only', 'alter table tmpos_role.tenant_role_level enable trigger trg_tenant_role_level_invoice_guard'],
    ['the guard trigger dropped', 'drop trigger trg_tenant_role_level_invoice_guard on tmpos_role.tenant_role_level'],
    ['021\'s trigger disabled', 'alter table tmpos_role.tenant_role_level disable trigger trg_tenant_role_level_version_advance'],
    ['a third trigger on the level table', `create trigger extra after delete on tmpos_role.tenant_role_level for each row execute function ${GUARD}`],
    ['a third function in the schema', 'create function tmpos_invoice_edit.extra() returns integer language sql as \'select 1\''],
    ['USAGE on the schema to PUBLIC', 'grant usage on schema tmpos_invoice_edit to public'],
    ['CREATE on the schema to tmpos_app', 'grant create on schema tmpos_invoice_edit to tmpos_app'],
    ['USAGE on the schema revoked from tmpos_app', 'revoke usage on schema tmpos_invoice_edit from tmpos_app'],
    ['the schema comment dropped', 'comment on schema tmpos_invoice_edit is null'],
  ]) {
    const out = await rolledBack(async (tx) => { await tx.unsafe(DOWN_032).simple(); await tx.unsafe(DOWN_031).simple(); await tx.unsafe(widen); await tx.unsafe(POSTCONDITION_030).simple(); });
    assert.equal(out.code, '55000', `${label}: refused (${JSON.stringify(out)})`);
    assert.match(out.message, /^migration 030 refused/, label);
  }
  const again = await rolledBack((tx) => tx.unsafe(UP_029).simple());
  assert.equal(again.code, '55000');
  assert.match(again.message, /^migration 029 refused: the edit routine, the trigger function or a trigger on the draft tables already exists$/);
  const again030 = await rolledBack((tx) => tx.unsafe(UP_030).simple());
  assert.equal(again030.code, '55000');
  assert.match(again030.message, /^migration 030 refused: schema tmpos_invoice_edit or the trigger trg_tenant_role_level_invoice_guard already exists$/);
});

test('IDE-02 (AC-18 AC-05 AC-12, N): 029\'s routine executable by nobody but its owner; schema tmpos_invoice_edit granting USAGE to tmpos_app alone beside its owner\'s own and holding exactly 030\'s two functions, 031\'s save (owner alone since 032) and 032\'s version-3 save and Customers guard (tmpos_app alone may execute the save beside its owner; 028\'s create and 031\'s save closed to tmpos_app); the edit v2 a pinned VOLATILE definer tmpos_app alone may execute beside its owner; the guard functions invokers no runtime role may execute; the level table\'s three ENABLE ALWAYS row triggers; 029\'s one BEFORE UPDATE draft trigger; the widened CHECK; no new table grant; the login\'s direct writes refused', async () => {
  const fns = (await owner`select p.proname::text as name, p.prosecdef, p.provolatile::text as volatility, p.proconfig, l.lanname::text as lang
    from pg_catalog.pg_proc p join pg_catalog.pg_language l on l.oid = p.prolang
    where p.pronamespace = 'tmpos_invoice_draft'::regnamespace order by 1`).map((r) => ({ ...r }));
  assert.deepEqual(fns.map((f) => [f.name, f.lang, f.prosecdef, f.volatility, f.proconfig]), [
    ['m7b_invoice_draft_create', 'plpgsql', true, 'v', ['search_path=pg_catalog, pg_temp', 'row_security=off']],
    ['m7b_invoice_draft_get', 'plpgsql', true, 's', ['search_path=pg_catalog, pg_temp', 'row_security=off']],
    ['m7b_invoice_draft_immutable', 'plpgsql', false, 'v', ['search_path=pg_catalog, pg_temp']],
    ['m7b_invoice_draft_page', 'plpgsql', true, 's', ['search_path=pg_catalog, pg_temp', 'row_security=off']],
    ['m7b_invoice_draft_update', 'plpgsql', true, 'v', ['search_path=pg_catalog, pg_temp', 'row_security=off']],
  ]);
  // 030's schema: exactly the guard function and the v2 edit, (M7B-INVOICES-P1-R3) 031's guarded save and (M7B-INVOICES-P1-R4)
  // 032's version-3 save and Customers guard function, each pinned, owned by the schema's owner, no relation: five functions.
  const edits = (await owner`select p.proname::text as name, p.prosecdef, p.provolatile::text as volatility, p.proconfig, l.lanname::text as lang,
      p.prorettype::regtype::text as returns, p.proowner = n.nspowner as owner_is_schema_owner
    from pg_catalog.pg_proc p join pg_catalog.pg_language l on l.oid = p.prolang join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where p.pronamespace = 'tmpos_invoice_edit'::regnamespace order by 1`).map((r) => ({ ...r }));
  assert.deepEqual(edits.map((f) => [f.name, f.lang, f.prosecdef, f.volatility, f.proconfig, f.returns, f.owner_is_schema_owner]), [
    ['m7b_customers_level_guard', 'plpgsql', false, 'v', ['search_path=pg_catalog, pg_temp'], 'trigger', true],
    ['m7b_invoice_draft_create_v2', 'plpgsql', true, 'v', ['search_path=pg_catalog, pg_temp', 'row_security=off'], 'record', true],
    ['m7b_invoice_draft_create_v3', 'plpgsql', true, 'v', ['search_path=pg_catalog, pg_temp', 'row_security=off'], 'record', true],
    ['m7b_invoice_draft_update_v2', 'plpgsql', true, 'v', ['search_path=pg_catalog, pg_temp', 'row_security=off'], 'record', true],
    ['m7b_invoice_level_guard', 'plpgsql', false, 'v', ['search_path=pg_catalog, pg_temp'], 'trigger', true],
  ], 'schema tmpos_invoice_edit: the v2 edit and the guard function (030), 031\'s save m7b_invoice_draft_create_v2 and 032\'s version-3 save and Customers guard function, nothing else');
  assert.equal((await owner`select count(*)::int as n from pg_catalog.pg_class c where c.relnamespace = 'tmpos_invoice_edit'::regnamespace`)[0].n, 0, 'and no relation');
  // EXACT grantees, read from the ACL itself (owner aside): v2's one non-grantable EXECUTE to tmpos_app, 032's version-3 save's
  // likewise, and nothing on the guard functions, on 029's routine (030 revoked tmpos_app's), on 028's create (031 revoked
  // tmpos_app's), on 031's save (032 revoked tmpos_app's) or on 029's trigger function.
  const grantees = async (sig) => (await owner`select g.grantee::regrole::text as grantee, g.privilege_type as priv, g.is_grantable as grantable
    from pg_catalog.pg_proc p, pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g
    where p.oid = ${sig}::regprocedure and g.grantee <> p.proowner order by 1, 2`).map((r) => ({ ...r }));
  assert.deepEqual(await grantees(UPDATE_V2), [{ grantee: 'tmpos_app', priv: 'EXECUTE', grantable: false }]);
  assert.deepEqual(await grantees(CREATE_V3), [{ grantee: 'tmpos_app', priv: 'EXECUTE', grantable: false }], '032\'s save: tmpos_app\'s one non-grantable EXECUTE');
  assert.deepEqual(await grantees(CREATE_V2), [], '031\'s save: no grantee at all since 032, PUBLIC and tmpos_app included');
  assert.deepEqual(await grantees(UPDATE), [], '029\'s routine: no grantee at all, PUBLIC and tmpos_app included');
  assert.deepEqual(await grantees(CREATE), [], '028\'s create: no grantee at all since 031, PUBLIC and tmpos_app included');
  assert.deepEqual(await grantees(GUARD), [], 'the guard function: no grantee at all, PUBLIC included');
  assert.deepEqual(await grantees(CUSTOMERS_GUARD), [], 'the Customers guard function: no grantee at all, PUBLIC included');
  assert.deepEqual(await grantees(IMMUTABLE), [], 'no grantee at all, PUBLIC included');
  for (const [sig, login] of [[UPDATE_V2, true], [CREATE_V3, true], [CREATE_V2, false], [UPDATE, false], [CREATE, false], [GUARD, false], [CUSTOMERS_GUARD, false], [IMMUTABLE, false]]) {
    const [can] = await owner`select pg_catalog.has_function_privilege(${RUNTIME_LOGIN}, ${sig}::regprocedure, 'EXECUTE') as login,
      pg_catalog.has_function_privilege('tmpos_audit_writer', ${sig}::regprocedure, 'EXECUTE') as audit,
      pg_catalog.has_function_privilege('anon', ${sig}::regprocedure, 'EXECUTE') as anon,
      pg_catalog.has_function_privilege('authenticated', ${sig}::regprocedure, 'EXECUTE') as authenticated`;
    assert.deepEqual({ ...can }, { login, audit: false, anon: false, authenticated: false }, sig);
  }
  // The schema: USAGE to tmpos_app alone (non-grantable) beyond its owner; the login can use it and not create in it.
  assert.deepEqual((await owner`select g.grantee::regrole::text as grantee, g.privilege_type as priv, g.is_grantable as grantable
    from pg_catalog.pg_namespace n, pg_catalog.aclexplode(coalesce(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) g
    where n.oid = 'tmpos_invoice_edit'::regnamespace and g.grantee <> n.nspowner order by 1, 2`).map((r) => ({ ...r })),
  [{ grantee: 'tmpos_app', priv: 'USAGE', grantable: false }], 'the schema\'s one grant beyond its owner\'s: USAGE to tmpos_app');
  assert.deepEqual({ ...(await owner`select pg_catalog.has_schema_privilege(${RUNTIME_LOGIN}, 'tmpos_invoice_edit', 'USAGE') as login,
      pg_catalog.has_schema_privilege('tmpos_audit_writer', 'tmpos_invoice_edit', 'USAGE') as audit,
      pg_catalog.has_schema_privilege('anon', 'tmpos_invoice_edit', 'USAGE') as anon,
      pg_catalog.has_schema_privilege('authenticated', 'tmpos_invoice_edit', 'USAGE') as authenticated,
      pg_catalog.has_schema_privilege(${RUNTIME_LOGIN}, 'tmpos_invoice_edit', 'CREATE') as login_create`)[0] },
  { login: true, audit: false, anon: false, authenticated: false, login_create: false }, 'schema USAGE');
  // The login calls 029's routine, 028's create, 031's save and the guard function and is refused (42501); v2 and 032's save it executes.
  const prober = await actor('surface-probe', [storeGrant(T_A, S_A1, 'store_owner')]);
  const probeKey = await mint(prober);
  const call028 = await errorOf(create(probeKey, S_A1, T_A, C_A, LINES, { fn: CREATE_FN_028 }));
  assert.equal(call028?.code, '42501', `the login cannot execute 028's create (${JSON.stringify(call028)})`);
  const callV2 = await errorOf(create(probeKey, S_A1, T_A, C_A, LINES, { fn: CREATE_FN_V2 }));
  assert.equal(callV2?.code, '42501', `the login cannot execute 031's save (${JSON.stringify(callV2)})`);
  const probeDraft = await create(probeKey, S_A1, T_A, C_A, LINES);
  const call029 = await errorOf(edit(probeKey, S_A1, T_A, probeDraft, 1, C_A, LINES, { fn: UPDATE_FN_029 }));
  assert.equal(call029?.code, '42501', `the login cannot execute 029's routine (${JSON.stringify(call029)})`);
  assert.equal((await errorOf(runtime`select tmpos_invoice_edit.m7b_invoice_level_guard()`))?.code, '42501', 'nor call the guard function');
  assert.deepEqual(await edit(probeKey, S_A1, T_A, probeDraft, 1, C_A, LINES), [done('unchanged', prober, T_A, S_A1, 1)], 'but v2 it executes');
  const triggers =(await owner`select g.tgrelid::regclass::text as rel, g.tgname::text as name, g.tgfoid::regprocedure::text as fn, g.tgtype::int as type,
      g.tgenabled::text as enabled from pg_catalog.pg_trigger g
    where g.tgrelid in ('tmpos_invoice_draft.invoice_draft'::regclass, 'tmpos_invoice_draft.invoice_draft_line'::regclass) and not g.tgisinternal`).map((r) => ({ ...r }));
  assert.deepEqual(triggers, [{ rel: 'tmpos_invoice_draft.invoice_draft', name: 'trg_invoice_draft_immutable', fn: 'tmpos_invoice_draft.m7b_invoice_draft_immutable()',
    type: 19, enabled: 'A' }], 'BEFORE (2) UPDATE (16) ROW (1), ALWAYS');
  // The level table: exactly three non-internal triggers, in name order — 032's Customers guard and 030's Invoices guard (each AFTER
  // INSERT, UPDATE, DELETE row) and 021's (AFTER UPDATE row).
  const levelTriggers = (await owner`select g.tgname::text as name, g.tgfoid::regprocedure::text as fn, g.tgtype::int as type, g.tgenabled::text as enabled,
      g.tgattr::text as columns, g.tgqual is null as no_when
    from pg_catalog.pg_trigger g where g.tgrelid = 'tmpos_role.tenant_role_level'::regclass and not g.tgisinternal order by 1`).map((r) => ({ ...r }));
  assert.deepEqual(levelTriggers, [
    { name: 'trg_tenant_role_level_customers_guard', fn: CUSTOMERS_GUARD, type: 29, enabled: 'A', columns: '', no_when: true },
    { name: 'trg_tenant_role_level_invoice_guard', fn: GUARD, type: 29, enabled: 'A', columns: '', no_when: true },
    { name: 'trg_tenant_role_level_version_advance', fn: 'tmpos_role_edit.m7a_role_level_version_advance()', type: 17, enabled: 'A', columns: '', no_when: true },
  ], 'the guards: ROW 1 + INSERT 4 + DELETE 8 + UPDATE 16 = 29, AFTER, ALWAYS; 021\'s: ROW 1 + UPDATE 16 = 17, ALWAYS');
  const [check] = await owner`select pg_catalog.pg_get_constraintdef(k.oid) as def, k.convalidated from pg_catalog.pg_constraint k
    where k.conrelid = 'tmpos_invoice_draft.invoice_draft'::regclass and k.conname = 'invoice_draft_version_chk'`;
  assert.deepEqual({ ...check }, { def: 'CHECK (((version >= 1) AND (version <= \'9007199254740991\'::bigint)))', convalidated: true });
  // No table grant beyond the owner's, on either table or any column; the login reaches neither by any path.
  const acls = (await owner`select c.relname::text as rel, g.grantee::regrole::text as grantee from pg_catalog.pg_class c,
      pg_catalog.aclexplode(coalesce(c.relacl, pg_catalog.acldefault('r', c.relowner))) g
    where c.relnamespace = 'tmpos_invoice_draft'::regnamespace and c.relkind = 'r' and g.grantee <> c.relowner`).map((r) => ({ ...r }));
  assert.deepEqual(acls, []);
  for (const t of ['tmpos_invoice_draft.invoice_draft', 'tmpos_invoice_draft.invoice_draft_line']) {
    const [p] = await owner`select pg_catalog.has_table_privilege(${RUNTIME_LOGIN}, ${t}::regclass, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') as any_priv,
      pg_catalog.has_any_column_privilege(${RUNTIME_LOGIN}, ${t}::regclass, 'SELECT, INSERT, UPDATE, REFERENCES') as any_column`;
    assert.deepEqual({ ...p }, { any_priv: false, any_column: false }, `${t}: the login reaches it only through the routines`);
  }
  const draft = await create(await mint(await actor('surface', [storeGrant(T_A, S_A1, 'store_owner')])), S_A1, T_A, C_A, LINES);
  for (const [label, attempt] of [
    ['SELECT the drafts', runtime`select count(*) from tmpos_invoice_draft.invoice_draft`],
    ['INSERT a draft', runtime`insert into tmpos_invoice_draft.invoice_draft (draft_id) values (${randomUUID()})`],
    ['UPDATE a draft', runtime`update tmpos_invoice_draft.invoice_draft set customer_id = ${C_A2} where draft_id = ${draft}`],
    ['DELETE a draft', runtime`delete from tmpos_invoice_draft.invoice_draft where draft_id = ${draft}`],
    ['INSERT a line', runtime`insert into tmpos_invoice_draft.invoice_draft_line (draft_id) values (${draft})`],
    ['UPDATE a line', runtime`update tmpos_invoice_draft.invoice_draft_line set quantity = 2 where draft_id = ${draft}`],
    ['DELETE a line', runtime`delete from tmpos_invoice_draft.invoice_draft_line where draft_id = ${draft}`],
  ]) {
    assert.equal((await errorOf(attempt))?.code, '42501', `the login cannot ${label}`);
  }
  assert.equal((await errorOf(runtime`select tmpos_invoice_draft.m7b_invoice_draft_immutable()`))?.code, '42501', 'nor call the trigger function');
});

// ===========================================================================
// IDE-03..07: the edit, its no-op, its conflicts and the answers that write nothing
// ===========================================================================

test('IDE-03 (AC-05 AC-10, G/N): a real edit replaces the customer and the ordered lines, the line count and the subtotal, and steps the version by one — atomically; the id, tenant, store, status, currency, creation time and creator stay; no audit, outbox, idempotency or role row (030: the edit makes no role row)', async () => {
  const s = await scene('change');
  // Neighbours the edit must leave byte for byte: another draft in the SAME store and one in ANOTHER store of the tenant (the
  // lines' DELETE and INSERT and the header's UPDATE are each scoped by draft, tenant and store).
  const sibling = await create(s.kBoss, s.S, s.T, s.C1, [line('Sibling', 2, 300), line('Sibling two', 1, 1)]);
  const S2 = await newStore(s.T, `change-2 ${SUFFIX}`);
  const elsewhere = await create(await mint(await actor('change-owner-2', [storeGrant(s.T, S2, 'store_owner')])), S2, s.T, s.C1, LINES);
  const neighbours = async () => ({ sibling: await stateOf(sibling), elsewhere: await stateOf(elsewhere) });
  const untouched = await neighbours();
  assert.equal(untouched.sibling.lines.length + untouched.elsewhere.lines.length, 5);
  const before = await contentOf(s.draft);
  assert.equal(before.header.version, '1');
  const prints = await footprint([s.T]);
  assert.equal(prints.roles, 0, 'the store owner\'s save made no role row; the manager has none');
  // 1 -> 2: another customer; the three lines reordered, one edited, one added.
  const v2 = [line('Labour  (1 hr)', 3, 4_500), line('Screen replacement', 1, 13_999), LINES[2], line('Case', 1, 2_000)];
  assert.deepEqual(await edit(s.kManager, s.S, s.T, s.draft, 1, s.C2, v2), [done('applied', s.manager, s.T, s.S, 2)]);
  const at2 = await contentOf(s.draft);
  const fixed = ({ draft_id, tenant_id, store_id, status, currency, created_at, created_by }) => ({ draft_id, tenant_id, store_id, status, currency, created_at, created_by });
  assert.deepEqual(fixed(at2.header), fixed(before.header), 'the id, tenant, store, status, currency, creation time and creator stay');
  assert.deepEqual([at2.header.customer_id, at2.header.version, at2.header.line_count, at2.header.subtotal],
    [s.C2, '2', 4, String(sumOf(v2))], 'the customer, version, count and subtotal move together');
  assert.deepEqual(at2.lines, linesAs(v2), 'positions 1..n in the order sent');
  const after2 = await footprint([s.T]);
  assert.deepEqual([after2.drafts - prints.drafts, after2.lines - prints.lines, after2.audits - prints.audits, after2.subjects - prints.subjects,
    after2.events - prints.events, after2.records - prints.records], [0, 1, 0, 0, 0, 0], 'one line more, and no audit, event or idempotency row: the runtime appends those');
  assert.deepEqual(await neighbours(), untouched, 'the same store\'s other draft and the other store\'s draft: header and lines byte for byte, same xmin and ctid');
  // N (030): the edit decides the level under the guard key and writes no role row — 029's change path made the manager's NULL
  // Invoices lock anchor here, and no Customers row; step 10 is gone.
  assert.deepEqual(await invoicesRowsOf(s.T), { roles: [], versions: [] }, 'the change path made no role row and no version row');
  // 2 -> 3: lines removed down to one, the same customer.
  const v3 = [line('Diagnostics', 1, 0)];
  assert.deepEqual(await edit(s.kManager, s.S, s.T, s.draft, 2, s.C2, v3), [done('applied', s.manager, s.T, s.S, 3)]);
  assert.deepEqual(await contentOf(s.draft), { header: { ...at2.header, version: '3', line_count: 1, subtotal: '0' }, lines: linesAs(v3) });
  // 3 -> 4: the store owner (no role row) back to the first customer and fifty lines; still no role row of its own.
  const fifty = Array.from({ length: INVOICE_DRAFT_MAX_LINES }, (_, i) => line(`L${i + 1}`, 1, i === 0 ? MAX - (INVOICE_DRAFT_MAX_LINES - 1) : 1));
  assert.deepEqual(await edit(s.kBoss, s.S, s.T, s.draft, 3, s.C1, fifty), [done('applied', s.boss, s.T, s.S, 4)]);
  const at4 = await contentOf(s.draft);
  assert.deepEqual([at4.header.customer_id, at4.header.version, at4.header.line_count, at4.header.subtotal], [s.C1, '4', 50, String(MAX)]);
  assert.deepEqual(at4.lines, linesAs(fifty));
  assert.deepEqual(await invoicesRowsOf(s.T), { roles: [], versions: [] }, 'the owner\'s edit made no role row either');
  assert.deepEqual(await neighbours(), untouched, 'after three edits, still byte for byte');
  // The real get answers exactly the stored edit.
  const got = await get(s.kManager, s.T, s.S, s.draft);
  assert.deepEqual(got.map((r) => [r.o_outcome, r.o_customer_id, r.o_version, r.o_line_count, r.o_subtotal_cents]), Array(50).fill(['draft', s.C1, '4', 50, String(MAX)]));
  assert.deepEqual(got.map((r) => [r.o_position, r.o_description, r.o_quantity, r.o_unit_price_cents]),
    fifty.map((l, i) => [i + 1, l.description, String(l.quantity), String(l.unitPriceCents)]));
});

test('IDE-04 (AC-05 D8): the trigger refuses an owner\'s UPDATE of the id, tenant, store, creation time or creator and any version move but +0 or +1 — also as a replica; the CHECKs refuse status and currency', async () => {
  const s = await scene('immutable');
  const other = await newStore(s.T, `immutable-other ${SUFFIX}`);
  const IMMUTABLE_MESSAGE = 'migration 029: an invoice draft\'s id, tenant, store, creation time and creator never change';
  const VERSION_MESSAGE = 'migration 029: an invoice draft\'s version stays or advances by exactly one';
  const before = await stateOf(s.draft);
  for (const [label, change, code, message] of [
    ['draft_id', (tx) => tx`update tmpos_invoice_draft.invoice_draft set draft_id = ${randomUUID()} where draft_id = ${s.draft}`, '23001', IMMUTABLE_MESSAGE],
    ['tenant_id', (tx) => tx`update tmpos_invoice_draft.invoice_draft set tenant_id = ${T_B} where draft_id = ${s.draft}`, '23001', IMMUTABLE_MESSAGE],
    ['store_id', (tx) => tx`update tmpos_invoice_draft.invoice_draft set store_id = ${other} where draft_id = ${s.draft}`, '23001', IMMUTABLE_MESSAGE],
    ['created_at', (tx) => tx`update tmpos_invoice_draft.invoice_draft set created_at = created_at - interval '1 microsecond' where draft_id = ${s.draft}`, '23001', IMMUTABLE_MESSAGE],
    ['created_by', (tx) => tx`update tmpos_invoice_draft.invoice_draft set created_by = ${randomUUID()} where draft_id = ${s.draft}`, '23001', IMMUTABLE_MESSAGE],
    ['version + 2', (tx) => tx`update tmpos_invoice_draft.invoice_draft set version = version + 2 where draft_id = ${s.draft}`, '23001', VERSION_MESSAGE],
    ['version - 1 (to 0)', (tx) => tx`update tmpos_invoice_draft.invoice_draft set version = version - 1 where draft_id = ${s.draft}`, '23001', VERSION_MESSAGE],
    ['status', (tx) => tx`update tmpos_invoice_draft.invoice_draft set status = 'issued' where draft_id = ${s.draft}`, '23514', null],
    ['currency', (tx) => tx`update tmpos_invoice_draft.invoice_draft set currency = 'EUR' where draft_id = ${s.draft}`, '23514', null],
  ]) {
    for (const replica of [false, true]) {
      const out = await rolledBack(async (tx) => {
        if (replica) await tx`set local session_replication_role = replica`;
        return change(tx);
      });
      assert.equal(out.code, code, `${label}${replica ? ' (replica)' : ''}: refused (${JSON.stringify(out)})`);
      if (message !== null) assert.equal(out.message, message, `${label}: the fixed message`);
    }
  }
  // Admitted: +1, +0 and the editable columns — the routine's own shape (each rolled back).
  for (const [label, change] of [
    ['version + 1', (tx) => tx`update tmpos_invoice_draft.invoice_draft set version = version + 1 where draft_id = ${s.draft} returning version::text as v`],
    ['version unchanged', (tx) => tx`update tmpos_invoice_draft.invoice_draft set version = version, line_count = line_count where draft_id = ${s.draft} returning version::text as v`],
    ['customer, count and subtotal', (tx) => tx`update tmpos_invoice_draft.invoice_draft set customer_id = ${s.C2} where draft_id = ${s.draft} returning version::text as v`],
  ]) {
    const out = await rolledBack(change);
    assert.equal(out.code, undefined, `${label}: admitted (${JSON.stringify(out)})`);
    assert.equal(out.value.length, 1, label);
  }
  assert.deepEqual(await stateOf(s.draft), before, 'every proof rolled back');
});

test('IDE-05 (AC-06 AC-05, G/N): a current-version no-op answers unchanged with the current version and writes nothing — the header\'s and every line\'s bytes, xmin and ctid identical, no role row and no version row; equal totals with other lines, and a reorder, are changes', async () => {
  const s = await scene('noop');
  const prints = await footprint([s.T]);
  const before = await stateOf(s.draft);
  assert.deepEqual(await invoicesRowsOf(s.T), { roles: [], versions: [] }, 'the manager has no stored Invoices level: the default governs');
  assert.deepEqual(await edit(s.kManager, s.S, s.T, s.draft, 1, s.C1, LINES), [done('unchanged', s.manager, s.T, s.S, 1)]);
  assert.deepEqual(await stateOf(s.draft), before, 'nothing written: same row bytes, xmin and ctid, header and lines');
  assert.deepEqual(await footprint([s.T]), prints, 'no role anchor, line, audit, event or record');
  assert.deepEqual(await invoicesRowsOf(s.T), { roles: [], versions: [] }, 'no role row, no role_level_version row, nothing advanced');
  // Equal totals, other lines: the same subtotal by another split — a change.
  const split = [line('Screen replacement', 1, 12_999), line('Labour  (1 hr)', 1, 9_000), line('Tempered glass ' + String.fromCodePoint(0x1f4f1), 3, 0)];
  assert.equal(sumOf(split), sumOf(LINES), 'the same subtotal');
  assert.deepEqual(await edit(s.kManager, s.S, s.T, s.draft, 1, s.C1, split), [done('applied', s.manager, s.T, s.S, 2)]);
  // A reorder of the very same lines: a change.
  const reordered = [split[2], split[0], split[1]];
  assert.deepEqual(await edit(s.kManager, s.S, s.T, s.draft, 2, s.C1, reordered), [done('applied', s.manager, s.T, s.S, 3)]);
  assert.deepEqual((await contentOf(s.draft)).lines, linesAs(reordered));
  // The customer alone: a change. Then the no-op again, at version 4.
  assert.deepEqual(await edit(s.kManager, s.S, s.T, s.draft, 3, s.C2, reordered), [done('applied', s.manager, s.T, s.S, 4)]);
  const at4 = await stateOf(s.draft);
  const prints4 = await footprint([s.T]);
  assert.deepEqual(await edit(s.kBoss, s.S, s.T, s.draft, 4, s.C2, reordered), [done('unchanged', s.boss, s.T, s.S, 4)]);
  assert.deepEqual(await stateOf(s.draft), at4);
  assert.deepEqual(await footprint([s.T]), prints4);
  // A line differing only in its description's case, its quantity or its price is a change; and one line fewer is.
  for (const [label, lines] of [
    ['description', [{ ...reordered[0], description: reordered[0].description.toUpperCase() }, reordered[1], reordered[2]]],
    ['quantity', [reordered[0], { ...reordered[1], quantity: 2 }, reordered[2]]],
    ['price', [reordered[0], reordered[1], { ...reordered[2], unitPriceCents: 9_001 }]],
    ['a line fewer', reordered.slice(0, 2)],
  ]) {
    const [{ v }] = await owner`select version::text as v from tmpos_invoice_draft.invoice_draft where draft_id = ${s.draft}`;
    const rows = await edit(s.kManager, s.S, s.T, s.draft, Number(v), s.C2, lines);
    assert.deepEqual(rows, [done('applied', s.manager, s.T, s.S, Number(v) + 1)], label);
  }
  assert.deepEqual(await invoicesRowsOf(s.T), { roles: [], versions: [] }, 'after every real change too: the edit made no role row and no version row');
});

test('IDE-06 (AC-07 AC-05, G/N): a stale version conflicts — with other contents and with contents equal to the stored ones — and writes nothing, no role row, no version row', async () => {
  const s = await scene('stale');
  const v2 = [line('Other', 1, 1)];
  assert.deepEqual(await edit(s.kManager, s.S, s.T, s.draft, 1, s.C2, v2), [done('applied', s.manager, s.T, s.S, 2)]);
  const prints = await footprint([s.T]);
  const at2 = await stateOf(s.draft);
  for (const [label, customer, lines, version] of [
    ['stale, other contents', s.C1, LINES, 1],
    ['stale, the stored contents exactly (a stale no-op)', s.C2, v2, 1],
    ['ahead of the stored version', s.C2, v2, 3],
  ]) {
    assert.deepEqual(await edit(s.kManager, s.S, s.T, s.draft, version, customer, lines), [answer('conflict')], label);
    assert.deepEqual(await stateOf(s.draft), at2, `${label}: nothing written`);
    assert.deepEqual(await footprint([s.T]), prints, `${label}: no anchor, line, audit, event or record`);
    assert.deepEqual(await invoicesRowsOf(s.T), { roles: [], versions: [] }, `${label}: no role row, no version row`);
  }
});

test('IDE-07 (DA-36 AC-10 AC-05, G/N): every sealed or rolled-back answer — conflict, invalid_state, unchanged, not_found, refused, tenant_mismatch — is reached with NOTHING written, not even a role anchor or a version row, for a role that had no stored row; the change path (030) makes none either', async () => {
  const s = await scene('nothing');
  const S2 = await newStore(s.T, `nothing-2 ${SUFFIX}`);
  const boss2 = await actor('nothing-owner-2', [storeGrant(s.T, S2, 'store_owner')]);
  const draftAtS2 = await create(await mint(boss2), S2, s.T, s.C1, LINES);
  const bossB = await actor('nothing-owner-b', [storeGrant(T_B, S_B1, 'store_owner')]);
  const draftAtB = await create(await mint(bossB), S_B1, T_B, C_B, LINES);
  const technician = await actor('nothing-technician', [storeGrant(s.T, s.S, 'technician')]);
  const salesStaff = await actor('nothing-sales', [storeGrant(s.T, s.S, 'sales_staff')]);
  const kTech = await mint(technician);
  const kSales = await mint(salesStaff);
  const watched = [s.T, T_B];
  const roleRows = async (db = owner) => (await db`select count(*)::int as n from tmpos_role.tenant_role_level where tenant_id = ${s.T}`)[0].n;
  assert.equal(await roleRows(), 0, 'no stored role row for the manager, technician or sales staff: every decision below is on a default');
  const NEW = [line('New', 1, 1)];
  for (const [label, call, expected] of [
    ['conflict', () => edit(s.kManager, s.S, s.T, s.draft, 2, s.C2, NEW), answer('conflict')],
    ['unchanged', () => edit(s.kManager, s.S, s.T, s.draft, 1, s.C1, LINES), done('unchanged', s.manager, s.T, s.S, 1)],
    ['not_found: a missing draft', () => edit(s.kManager, s.S, s.T, randomUUID(), 1, s.C2, NEW), answer('not_found')],
    ['not_found: the tenant\'s other store\'s draft', () => edit(s.kManager, s.S, s.T, draftAtS2, 1, s.C2, NEW), answer('not_found')],
    ['not_found: another tenant\'s draft', () => edit(s.kManager, s.S, s.T, draftAtB, 1, s.C2, NEW), answer('not_found')],
    ['not_found: a missing customer', () => edit(s.kManager, s.S, s.T, s.draft, 1, randomUUID(), NEW), answer('not_found')],
    ['not_found: another tenant\'s customer', () => edit(s.kManager, s.S, s.T, s.draft, 1, C_B, NEW), answer('not_found')],
    ['refused: the technician (default View)', () => edit(kTech, s.S, s.T, s.draft, 1, s.C2, NEW), REFUSED],
    ['refused: the sales staff (default Create)', () => edit(kSales, s.S, s.T, s.draft, 1, s.C2, NEW), REFUSED],
    ['refused: a store the manager holds no grant at', () => edit(s.kManager, S2, s.T, draftAtS2, 1, s.C2, NEW), REFUSED],
    ['refused: an unknown session', () => edit(newKey(), s.S, s.T, s.draft, 1, s.C2, NEW), REFUSED],
    ['tenant_mismatch', () => edit(s.kManager, s.S, T_B, s.draft, 1, s.C2, NEW), answer('tenant_mismatch')],
  ]) {
    const prints = await footprint(watched);
    const states = [await stateOf(s.draft), await stateOf(draftAtS2), await stateOf(draftAtB)];
    assert.deepEqual(await call(), [expected], label);
    assert.deepEqual(await footprint(watched), prints, `${label}: no draft, line, role row, version, audit, event or record`);
    assert.deepEqual([await stateOf(s.draft), await stateOf(draftAtS2), await stateOf(draftAtB)], states, `${label}: every draft byte for byte`);
    assert.equal(await roleRows(), 0, `${label}: no role anchor`);
    assert.deepEqual(await invoicesRowsOf(s.T), { roles: [], versions: [] }, `${label}: no role row, no version row`);
  }
  // invalid_state: unreachable while 028's CHECK pins the status, so it is shown inside one owner transaction that drops the
  // CHECK, moves the status and calls the same routine as the session's caller would — all rolled back.
  const out = await rolledBack(async (tx) => {
    await tx`alter table tmpos_invoice_draft.invoice_draft drop constraint invoice_draft_status_chk`;
    await tx`update tmpos_invoice_draft.invoice_draft set status = 'issued' where draft_id = ${s.draft}`;
    const prints = await footprint(watched, tx);
    const state = await stateOf(s.draft, tx);
    const rows = await edit(s.kManager, s.S, s.T, s.draft, 1, s.C2, NEW, { db: tx });
    return { rows, same: { prints: await footprint(watched, tx), state: await stateOf(s.draft, tx) }, was: { prints, state }, roles: await roleRows(tx) };
  });
  assert.equal(out.code, undefined, JSON.stringify(out));
  assert.deepEqual(out.value.rows, [answer('invalid_state')]);
  assert.deepEqual(out.value.same, out.value.was, 'invalid_state: nothing written');
  assert.equal(out.value.roles, 0, 'invalid_state: no role anchor');
  // N (030): the change path makes no role row either — 029's step 10 made exactly the manager's Invoices anchor here; the guard
  // key replaced it and nothing is inserted.
  assert.deepEqual(await edit(s.kManager, s.S, s.T, s.draft, 1, s.C2, NEW), [done('applied', s.manager, s.T, s.S, 2)]);
  assert.equal(await roleRows(), 0);
  assert.deepEqual(await invoicesRowsOf(s.T), { roles: [], versions: [] }, 'the change path made no role row and no version row');
});

// ===========================================================================
// IDE-08: the SQL bounds, at the runtime's own limits
// ===========================================================================

test('IDE-08 (AC-15): every bound refused with 22023 and a fixed message at the runtime\'s own limits, writing nothing; each limit itself admitted; the version\'s top end; outside READ COMMITTED, 55000', async () => {
  const s = await scene('bounds');
  const N = INVOICE_DRAFT_DESCRIPTION_MAX_CHARACTERS;
  const at = (description, quantity = 1, price = 1) => `[{"description":${JSON.stringify(description)},"quantity":${quantity},"unitPriceCents":${price}}]`;
  const M = 'migration 029 update: ';
  const BAD = [
    ['a malformed key', { key: '' }, `${M}an argument is malformed`],
    ['an expected version of 0', { version: 0 }, `${M}the expected version is not one the draft table can advance`],
    ['an expected version of 2^53 - 1', { version: MAX }, `${M}the expected version is not one the draft table can advance`],
    ['a negative subtotal', { lines: at('x', 1, 0), subtotal: '-1' }, `${M}the subtotal is not a whole number from 0 to 9007199254740991`],
    ['a subtotal of 2^53', { lines: at('x', 1, 0), subtotal: String(MAX + 1) }, `${M}the subtotal is not a whole number from 0 to 9007199254740991`],
    ['lines not an array', { lines: '{"description":"x","quantity":1,"unitPriceCents":1}', subtotal: '1' }, `${M}the lines are not an array`],
    ['no line', { lines: '[]', subtotal: '0' }, `${M}there are not 1 to 50 lines`],
    [`${INVOICE_DRAFT_MAX_LINES + 1} lines`, { lines: JSON.stringify(Array.from({ length: INVOICE_DRAFT_MAX_LINES + 1 }, () => line('x', 1, 1))), subtotal: String(INVOICE_DRAFT_MAX_LINES + 1) },
      `${M}there are not 1 to 50 lines`],
    ['an extra line key', { lines: '[{"description":"x","quantity":1,"unitPriceCents":1,"lineTotalCents":1}]', subtotal: '1' },
      `${M}a line is not exactly a description, a quantity and a unit price`],
    ['a missing line key', { lines: '[{"description":"x","quantity":1}]', subtotal: '0' }, `${M}a line is not exactly a description, a quantity and a unit price`],
    ['a quantity as a string', { lines: '[{"description":"x","quantity":"1","unitPriceCents":1}]', subtotal: '1' }, `${M}a line field has the wrong type`],
    [`a description of ${N + 1} characters`, { lines: at('d'.repeat(N + 1)) }, `${M}a line description is not one the line table admits`],
    ['an empty description', { lines: at('') }, `${M}a line description is not one the line table admits`],
    ['an edge space', { lines: at(' Opaque description') }, `${M}a line description is not one the line table admits`],
    ['a control character', { lines: at('Opaque\u0007description') }, `${M}a line description is not one the line table admits`],
    ['a Bidi_Control', { lines: at('Opaque\u202edescription') }, `${M}a line description is not one the line table admits`],
    ['a quantity of 0', { lines: at('x', 0, 1), subtotal: '0' }, `${M}a line quantity is not a whole number from 1 to 9007199254740991`],
    ['a quantity of 2^53', { lines: at('x', MAX + 1, 0), subtotal: '0' }, `${M}a line quantity is not a whole number from 1 to 9007199254740991`],
    ['a fractional quantity', { lines: at('x', '1.5', 0), subtotal: '0' }, `${M}a line quantity is not a whole number from 1 to 9007199254740991`],
    ['a negative price', { lines: at('x', 1, -1), subtotal: '0' }, `${M}a line unit price is not a whole number of cents from 0 to 9007199254740991`],
    ['a price of 2^53', { lines: at('x', 1, MAX + 1), subtotal: '0' }, `${M}a line unit price is not a whole number of cents from 0 to 9007199254740991`],
    ['a line total above 2^53 - 1', { lines: at('x', 2, 2 ** 52), subtotal: '0' }, `${M}a line total is above 9007199254740991`],
    ['a sum above 2^53 - 1', { lines: JSON.stringify([line('x', 1, MAX), line('y', 1, 1)]), subtotal: '0' }, `${M}the lines' sum is above 9007199254740991`],
    ['a subtotal that is not the sum', { lines: at('x', 2, 3), subtotal: '5' }, `${M}the subtotal is not the sum of the line totals`],
  ];
  const prints = await footprint([s.T]);
  const state = await stateOf(s.draft);
  for (const [label, o, message] of BAD) {
    const lines = o.lines ?? at('x');
    const out = await errorOf(edit(o.key ?? s.kManager, s.S, s.T, s.draft, o.version ?? 1, s.C2, lines, { subtotal: o.subtotal ?? '1' }));
    assert.deepEqual(out, { code: '22023', message }, label);
    assert.doesNotMatch(out.message, /Opaque|9007199254740992|1\.5/, `${label}: the message carries no value`);
  }
  assert.deepEqual(await footprint([s.T]), prints, 'no refusal wrote anything');
  assert.deepEqual(await stateOf(s.draft), state);
  // Each limit itself is admitted: 256 code points (an astral one counted once), 50 lines, the largest quantity and price.
  const limits = [
    [`a description of ${N} code points`, [line('d'.repeat(N - 1) + String.fromCodePoint(0x1f4f1), 1, 1)]],
    ['the largest quantity', [line('q', MAX, 1)]],
    ['the largest price', [line('p', 1, MAX)]],
    [`${INVOICE_DRAFT_MAX_LINES} lines summing to 2^53 - 1`, Array.from({ length: INVOICE_DRAFT_MAX_LINES }, (_, i) => line(`L${i}`, 1, i === 0 ? MAX - (INVOICE_DRAFT_MAX_LINES - 1) : 1))],
    ['a zero price', [line('z', 1, 0)]],
  ];
  for (const [i, [label, lines]] of limits.entries()) {
    assert.deepEqual(await edit(s.kManager, s.S, s.T, s.draft, i + 1, s.C2, lines), [done('applied', s.manager, s.T, s.S, i + 2)], label);
    assert.deepEqual((await contentOf(s.draft)).lines, linesAs(lines), `${label}: stored exactly`);
  }
  // The version's top end: a draft at 2^53 - 2 (set by the owner with the trigger lifted, in a transaction rolled back)
  // advances to 2^53 - 1; the expected version 2^53 - 1 is then refused before anything is read; the CHECK refuses beyond.
  const top = await rolledBack(async (tx) => {
    await tx`alter table tmpos_invoice_draft.invoice_draft disable trigger trg_invoice_draft_immutable`;
    await tx`update tmpos_invoice_draft.invoice_draft set version = ${String(MAX_EXPECTED)}::bigint where draft_id = ${s.draft}`;
    await tx`alter table tmpos_invoice_draft.invoice_draft enable always trigger trg_invoice_draft_immutable`;
    const rows = await edit(s.kManager, s.S, s.T, s.draft, MAX_EXPECTED, s.C1, LINES, { db: tx });
    const beyond = await errorOf(edit(s.kManager, s.S, s.T, s.draft, MAX, s.C1, LINES, { db: tx }));
    return { rows, beyond };
  });
  assert.equal(top.code, undefined, JSON.stringify(top));
  assert.deepEqual(top.value.rows, [done('applied', s.manager, s.T, s.S, MAX)], '2^53 - 2 -> 2^53 - 1, exact');
  assert.equal(top.value.beyond?.code, '22023', 'a draft at 2^53 - 1 can never be edited');
  const overflow = await rolledBack(async (tx) => {
    await tx`alter table tmpos_invoice_draft.invoice_draft disable trigger trg_invoice_draft_immutable`;
    await tx`update tmpos_invoice_draft.invoice_draft set version = ${String(MAX + 1)}::bigint where draft_id = ${s.draft}`;
  });
  assert.equal(overflow.code, '23514', 'the CHECK refuses a version above 2^53 - 1');
  const zero = await rolledBack(async (tx) => {
    await tx`alter table tmpos_invoice_draft.invoice_draft disable trigger trg_invoice_draft_immutable`;
    await tx`update tmpos_invoice_draft.invoice_draft set version = 0 where draft_id = ${s.draft}`;
  });
  assert.equal(zero.code, '23514', 'and one below 1');
  // Outside READ COMMITTED, before anything is read.
  for (const level of ['repeatable read', 'serializable']) {
    const out = await errorOf(runtime.begin(`isolation level ${level}`, (tx) => edit(s.kManager, s.S, s.T, s.draft, 6, s.C1, LINES, { db: tx })));
    assert.deepEqual(out, { code: '55000', message: `${M}it must run under READ COMMITTED, so that its checks see what committed before its locks` }, level);
  }
});


// ===========================================================================
// IDE-09: the consistent read (D7)
// ===========================================================================

test('IDE-09 (AC-09 D7): the REAL get, blocked between its header and its lines by an ACCESS EXCLUSIVE holder that then commits a replacement through the edit routine, answers the complete EARLIER draft; a VOLATILE copy of the same body, same interleave, answers a MIXED one', async () => {
  const s = await scene('snapshot');
  // The negative control: the installed get's own definition, with its schema and its volatility the only differences.
  const [{ def, src }] = await owner`select pg_catalog.pg_get_functiondef(${GET}::regprocedure) as def, p.prosrc as src
    from pg_catalog.pg_proc p where p.oid = ${GET}::regprocedure`;
  assert.equal(def.split('\n STABLE SECURITY DEFINER\n').length, 2, 'the installed get is STABLE SECURITY DEFINER');
  assert.equal(def.split('CREATE OR REPLACE FUNCTION tmpos_invoice_draft.m7b_invoice_draft_get(').length, 2);
  const copy = def.replace('CREATE OR REPLACE FUNCTION tmpos_invoice_draft.m7b_invoice_draft_get(', `CREATE FUNCTION ${SCRATCH_SCHEMA}.m7b_invoice_draft_get(`)
    .replace('\n STABLE SECURITY DEFINER\n', '\n VOLATILE SECURITY DEFINER\n');
  await owner.unsafe(`create schema ${SCRATCH_SCHEMA}`);
  try {
    await owner.unsafe(copy);
    const [{ same }] = await owner.unsafe(`select p.prosrc = $1 and p.provolatile = 'v' as same from pg_catalog.pg_proc p
      where p.oid = '${SCRATCH_SCHEMA}.m7b_invoice_draft_get(text, uuid, uuid, uuid)'::regprocedure`, [src]);
    assert.equal(same, true, 'the copy is the same body, VOLATILE');

    /**
     * One interleave: a holder takes ACCESS EXCLUSIVE on the line table (and nothing the get reads before its lines); a
     * getter starts — its statement's snapshot taken now — reads the header and blocks on the lines; once that is SEEN in
     * pg_locks, the holder replaces the header and the lines through the real edit routine, as its owner, in the same
     * transaction, and commits; the getter then finishes.
     */
    const interleave = async (label, getter, version, customer, lines) => {
      const holder = holding(owner, (tx) => tx`lock table tmpos_invoice_draft.invoice_draft_line in access exclusive mode`,
        (tx) => edit(s.kManager, s.S, s.T, s.draft, version, customer, lines, { db: tx }));
      let reading = null;
      try {
        await until(() => holder.ready, `${label}: the line table held`);
        reading = running(getter.db, (tx) => get(s.kManager, s.T, s.S, s.draft, tx, getter.fn));
        // THE CONDITION: the getter's one ungranted lock is an AccessShareLock on exactly invoice_draft_line, the relation the
        // holder holds AccessExclusiveLock on. A generic wait_event 'Lock' would not do: it could be admission work.
        await until(async () => reading.pid !== null && (await owner`select
            (select count(*) from pg_catalog.pg_locks l where l.pid = ${reading.pid} and not l.granted)::int = 1
            and exists (select 1 from pg_catalog.pg_locks l where l.pid = ${reading.pid} and not l.granted and l.locktype = 'relation'
                          and l.relation = 'tmpos_invoice_draft.invoice_draft_line'::regclass and l.mode = 'AccessShareLock')
            and exists (select 1 from pg_catalog.pg_locks l where l.pid = ${holder.pid} and l.granted and l.locktype = 'relation'
                          and l.relation = 'tmpos_invoice_draft.invoice_draft_line'::regclass and l.mode = 'AccessExclusiveLock') as ok`)[0].ok,
        `${label}: the getter waits on the line table alone, after its header read`);
      } catch (err) {
        holder.release('rollback');
        await holder.done;
        if (reading !== null) await reading.done;
        throw err;
      }
      holder.release('commit');
      assert.deepEqual(await holder.done, { outcome: 'committed', value: [done('applied', s.manager, s.T, s.S, version + 1)] },
        `${label}: the replacement committed while the getter waited`);
      const read = await reading.done;
      assert.equal(read.outcome, 'committed', JSON.stringify(read));
      return read.value;
    };
    const shape = (rows) => ({
      header: [...new Set(rows.map((r) => JSON.stringify([r.o_outcome, r.o_draft_id, r.o_customer_id, r.o_version, r.o_line_count, r.o_subtotal_cents])))].map((j) => JSON.parse(j)),
      lines: rows.map((r) => [r.o_position, r.o_description, r.o_quantity, r.o_unit_price_cents]),
    });
    const whole = (customer, version, lines) => ({ header: [['draft', s.draft, customer, String(version), lines.length, String(sumOf(lines))]],
      lines: lines.map((l, i) => [i + 1, l.description, String(l.quantity), String(l.unitPriceCents)]) });
    const R1 = [line('Replacement one', 2, 700), line('Replacement two', 1, 50)];
    const R2 = [line('Third A', 1, 1), line('Third B', 1, 2), line('Third C', 1, 3), line('Third D', 1, 4)];

    // The REAL routine, as the runtime login calls it: the complete earlier draft, header and lines of one instant.
    const real = await interleave('the real get', { db: runtime, fn: 'tmpos_invoice_draft.m7b_invoice_draft_get' }, 1, s.C2, R1);
    assert.deepEqual(shape(real), whole(s.C1, 1, LINES), 'the real get: version 1 whole');
    assert.deepEqual(shape(await get(s.kManager, s.T, s.S, s.draft)), whole(s.C2, 2, R1), 'read after the commit: version 2 whole');

    // The VOLATILE control, same interleave: version 2's header (customer, count, subtotal) over version 3's four lines.
    const mixed = await interleave('the VOLATILE copy', { db: owner, fn: `${SCRATCH_SCHEMA}.m7b_invoice_draft_get` }, 2, s.C1, R2);
    assert.deepEqual(shape(mixed), { header: whole(s.C2, 2, R1).header, lines: whole(s.C1, 3, R2).lines },
      'the VOLATILE copy mixes two saved versions: the interleave really happens');
    assert.deepEqual(shape(await get(s.kManager, s.T, s.S, s.draft)), whole(s.C1, 3, R2), 'read after the commit: version 3 whole');
  } finally {
    await owner.unsafe(`drop schema if exists ${SCRATCH_SCHEMA} cascade`);
  }
});

// ===========================================================================
// IDE-10..12: ordering against concurrent writers, by lock waits
// ===========================================================================

/** The draft's stored version, as a number. */
const versionOf = async (draft) => Number((await owner`select version::text as v from tmpos_invoice_draft.invoice_draft where draft_id = ${draft}`)[0].v);
/** The counts a refused or conflicting edit must leave as they were (role-level versions excluded: an owner's level edit moves them). */
const writes = async (tenants) => { const { versions, ...rest } = await footprint(tenants); void versions; return rest; };

/** A tenant-scope grant (the owner of 026's setter holds exactly one: 026 step 7). */
const tenantGrant = (tenant, role) => ({ scope: 'tenant', tenant, role });
/** A different actor from the manager: a store owner with EXACTLY ONE tenant-scope grant on `tenant`, and a live session of its own. */
async function tenantOwner(tenant, label) {
  const who = await actor(`${label}-tenant-owner`, [tenantGrant(tenant, 'store_owner')]);
  return { who, key: await mint(who) };
}
/** The edit counter of (tenant, role, 'invoices') the setter reviews: 0 while there is no version row. */
const versionRowOf = async (tenant, role) => Number((await owner`select coalesce((select v.version from tmpos_role_edit.role_level_version v
  where v.tenant_id = ${tenant} and v.role_id = ${role} and v.domain = 'invoices'), 0)::text as version`)[0].version);
/** 026's Invoices setter, the REAL writer, as the runtime login (or on `db`): the answer's version as a number. */
const setInvoices = async (key, role, level, tenant, version, db = runtime) => (await db`select o_outcome, o_tenant_id, o_actor_id, o_membership_id, o_level, o_version
  from tmpos_role_invoice.m7a_invoice_role_level_set(${key}::text, ${role}::text, ${level}::text, ${tenant}::uuid, ${String(version)}::bigint)`)
  .map((r) => ({ ...r, o_version: r.o_version === null ? null : Number(r.o_version) }));
/** The role rows and edit counters of a tenant exactly as stored, row versions (xmin) included: a write by anyone moves them. */
async function invoicesRowsOf(tenant, db = owner) {
  return {
    roles: (await db`select role_id, domain, level, xmin::text as xmin from tmpos_role.tenant_role_level where tenant_id = ${tenant} order by role_id, domain`).map((r) => ({ ...r })),
    versions: (await db`select role_id, domain, version::text as version, xmin::text as xmin from tmpos_role_edit.role_level_version where tenant_id = ${tenant} order by role_id, domain`).map((r) => ({ ...r })),
  };
}
/** A diagnostic line the evidence is read from (printed by the runner whether the case passes or fails). */
const evidence = (t, what) => t.diagnostic(`EVIDENCE ${JSON.stringify(what)}`);
/**
 * DA-204's window at routine level. The manager's edit passes step 3 (the unlocked Invoices decision) and waits on the draft
 * header, which an owner session holds. While it waits, a DIFFERENT actor — a store owner holding one tenant grant — commits
 * the downgrade of the manager's Invoices level through the REAL setter (026), with the version it reviewed (0 while there is
 * no version row). The header is then released. The snapshots are taken AFTER the downgrade, so the setter's own role and
 * version rows are never read as the edit's effects. Returns what was observed; the caller states the expectation.
 */
async function downgradeWhileWaiting({ s, own, version, customer, lines, label, level = 'create' }) {
  const header = holding(owner, (tx) => tx`select 1 from tmpos_invoice_draft.invoice_draft where draft_id = ${s.draft} for update`);
  let waiting = null;
  try {
    await until(() => header.ready, `${label}: the header held`);
    waiting = running(runtime, (tx) => edit(s.kManager, s.S, s.T, s.draft, version, customer, lines, { db: tx }));
    await until(() => blockedBy(waiting.pid, header.pid), `${label}: past step 3, waiting on the header`);
    // The exact barrier (IDE-10's): an ungranted transactionid ShareLock on the header holder's transaction, while holding
    // the tuple lock on the draft header table — the edit is at step 5, past step 3's unlocked decision.
    const wait = await lockWaitOf(waiting.pid, header.pid);
    assert.deepEqual(wait.ungranted.map((l) => [l.locktype, l.mode]), [['transactionid', 'ShareLock']], `${label}: ${JSON.stringify(wait.locks)}`);
    assert.ok(wait.holderXids.includes(wait.ungranted[0].xid), `${label}: behind the header holder's transaction`);
    assert.deepEqual(wait.tuples.map((l) => [l.rel, l.granted]), [['tmpos_invoice_draft.invoice_draft', true]], `${label}: holding the header's tuple lock`);
    const rowsBeforeDowngrade = await invoicesRowsOf(s.T);
    const reviewed = await versionRowOf(s.T, 'manager');
    const set = await setInvoices(own.key, 'manager', level, s.T, reviewed);
    const waitingAfterDowngrade = await blockedBy(waiting.pid, header.pid);
    const afterDowngrade = { state: await stateOf(s.draft), prints: await writes([s.T]), rows: await invoicesRowsOf(s.T) };
    header.release('rollback');
    await header.done;
    const out = await waiting.done;
    const afterRelease = { state: await stateOf(s.draft), prints: await writes([s.T]), rows: await invoicesRowsOf(s.T) };
    return { barrier: wait.ungranted.map((l) => [l.locktype, l.mode]), rowsBeforeDowngrade, reviewed, set, waitingAfterDowngrade, afterDowngrade, afterRelease, out };
  } finally {
    header.release('rollback');
    await header.done;
    if (waiting !== null) await waiting.done;
  }
}
/** What a refused edit must leave after the downgrade committed: the setter's rows exactly, the draft, lines and counts untouched. */
function assertDowngradeWon(obs, { owner: own, tenant, level = 'create', label }) {
  assert.deepEqual(obs.set, [{ o_outcome: 'applied', o_tenant_id: tenant, o_actor_id: own.who.id, o_membership_id: own.who.memberships[0], o_level: level,
    o_version: obs.reviewed + 1 }], `${label}: the real setter applied the downgrade`);
  assert.equal(obs.waitingAfterDowngrade, true, `${label}: the edit still waited on the header when the downgrade committed`);
  assert.deepEqual(obs.afterDowngrade.rows.roles.map(({ xmin, ...r }) => r).filter((r) => r.role_id === 'manager'),
    [{ role_id: 'manager', domain: 'invoices', level }], `${label}: the manager's Invoices row as the setter wrote it`);
  assert.deepEqual(obs.afterDowngrade.rows.versions.filter((r) => r.role_id === 'manager').map(({ xmin, ...r }) => r),
    [{ role_id: 'manager', domain: 'invoices', version: String(obs.reviewed + 1) }], `${label}: its version row as the setter wrote it`);
  assert.deepEqual(obs.out.value, [REFUSED], `${label}: the edit is refused once the downgrade committed — not a sealed answer`);
  assert.deepEqual(obs.afterRelease.state, obs.afterDowngrade.state, `${label}: that draft's row and lines untouched (xmin and ctid)`);
  assert.deepEqual(obs.afterRelease.prints, obs.afterDowngrade.prints, `${label}: no draft, line, role row, audit, event or record written by the edit`);
  assert.deepEqual(obs.afterRelease.rows, obs.afterDowngrade.rows, `${label}: the role and version rows exactly as the setter wrote them`);
}

test('IDE-10 (AC-08 AC-07): two distinct actors edit one version — the second waits on the header, then conflicts, also when it sends the first\'s very contents (a stale no-op), never not_found; the first rolled back instead, the second applies', async () => {
  // The manager's Invoices row stored up front (Full), so the guard's level re-read finds a stored level; no edit makes a role
  // row (030), so the second's "wrote nothing" is read against counts the first's commit does not move (every round's contents
  // are one line).
  const s = await scene('header', { managerLevel: 'full' });
  for (const [i, [label, ending, sameAsFirst, expected]] of [
    ['the first rolled back', 'rollback', false, 'applied'],
    ['the first committed, other contents', 'commit', false, 'conflict'],
    ['the first committed, its very contents', 'commit', true, 'conflict'],
  ].entries()) {
    const v = await versionOf(s.draft);
    // Contents new to the draft each round, so the first edit is a real change every time.
    const FIRST = [line(`First editor ${i}`, 1, 100)];
    const second = sameAsFirst ? FIRST : [line(`Second editor ${i}`, 2, 100)];
    const first = holding(runtime, (tx) => edit(s.kManager, s.S, s.T, s.draft, v, s.C2, FIRST, { db: tx }));
    let waiter = null;
    try {
      await until(() => first.ready, `${label}: the first edit applied, uncommitted`);
      const prints = await writes([s.T]);
      // The store owner: a distinct actor, so 016's hold (one actor's account FOR UPDATE) does not serialize the two.
      waiter = running(runtime, (tx) => edit(s.kBoss, s.S, s.T, s.draft, v, s.C2, second, { db: tx }));
      await until(() => blockedBy(waiter.pid, first.pid), `${label}: the second edit waits for the first`);
      const w = await waitingIn(waiter.pid);
      assert.equal(w.waiting, 1, `${label}: one ungranted lock`);
      assert.match(w.query, /m7b_invoice_draft_update/, `${label}: inside the edit`);
      // WHAT it waits on: an ungranted transactionid ShareLock on a transaction id the FIRST edit holds (its own, or a
      // subtransaction's: the routine's write blocks run as subtransactions), while holding the heavyweight tuple lock on a
      // row of the draft header table — the header FOR UPDATE, never 016's hold, a role row or the customer.
      const firstXids = (await owner`select l.transactionid::text as xid from pg_catalog.pg_locks l
        where l.pid = ${first.pid} and l.locktype = 'transactionid' and l.mode = 'ExclusiveLock' and l.granted`).map((r) => r.xid);
      const waits = (await owner`select l.locktype::text as locktype, l.mode::text as mode, l.granted, l.transactionid::text as xid,
          l.relation::regclass::text as rel
        from pg_catalog.pg_locks l where l.pid = ${waiter.pid} and (not l.granted or l.locktype = 'tuple')`).map((r) => ({ ...r }));
      const ungranted = waits.filter((l) => !l.granted);
      assert.deepEqual(ungranted.map((l) => [l.locktype, l.mode]), [['transactionid', 'ShareLock']], `${label}: ${JSON.stringify(waits)}`);
      assert.ok(firstXids.includes(ungranted[0].xid), `${label}: behind the first edit's transaction (${ungranted[0].xid} in ${firstXids})`);
      assert.deepEqual(waits.filter((l) => l.locktype === 'tuple').map((l) => [l.rel, l.granted]), [['tmpos_invoice_draft.invoice_draft', true]],
        `${label}: holding the tuple lock on the draft header`);
      first.release(ending);
      const firstOut = await first.done;
      assert.deepEqual(firstOut, ending === 'commit'
        ? { outcome: 'committed', value: [done('applied', s.manager, s.T, s.S, v + 1)] } : { outcome: 'rolled back' });
      const out = await waiter.done;
      assert.equal(out.outcome, 'committed', JSON.stringify(out));
      if (expected === 'conflict') {
        assert.deepEqual(out.value, [answer('conflict')], `${label}: the second re-read the committed version — a conflict, not not_found`);
        assert.equal(await versionOf(s.draft), v + 1, `${label}: the first's edit alone`);
        assert.deepEqual((await contentOf(s.draft)).lines, linesAs(FIRST));
        assert.deepEqual(await writes([s.T]), prints, `${label}: the second wrote nothing`);
      } else {
        assert.deepEqual(out.value, [done('applied', s.boss, s.T, s.S, v + 1)], label);
        assert.deepEqual((await contentOf(s.draft)).lines, linesAs(second));
      }
    } finally {
      first.release('rollback');
      await first.done;
      if (waiter !== null) await waiter.done;
    }
  }
});

test('IDE-11 (AC-14 AC-03 AC-10, N; the DA-204 block AC-01 AC-02, R): an owner\'s narrowing of Invoices to Create held uncommitted before the edit reaches the guard makes the edit wait on the role\'s key — after taking the header — and, committed, refuses it, nothing written; rolled back, the edit applies; edit first, the narrowing\'s UPDATE waits on the key behind the edit for its COMMIT and governs only later edits; a downgrade by the real setter committed while a stale edit or a current no-op waits on the header refuses it (DA-204)', async (t) => {
  const s = await scene('narrow', { managerLevel: 'edit' });
  const NEXT = [line('Narrowing', 1, 1)];
  // The owner's narrowing as 026's set takes it: the role row FOR UPDATE, then the level written (021's trigger moves its version).
  const narrow = async (tx) => {
    await tx`select 1 from tmpos_role.tenant_role_level where tenant_id = ${s.T} and role_id = 'manager' and domain = 'invoices' for update`;
    return tx`update tmpos_role.tenant_role_level set level = 'create', updated_at = now()
      where tenant_id = ${s.T} and role_id = 'manager' and domain = 'invoices' returning level`;
  };
  // The narrowing held first: the control (rolled back) and then committed.
  for (const ending of ['rollback', 'commit']) {
    const v = await versionOf(s.draft);
    const narrowing = holding(owner, narrow);
    let editing = null;
    try {
      await until(() => narrowing.ready, `${ending}: the narrowing held, uncommitted`);
      const before = await stateOf(s.draft);
      const prints = await writes([s.T]);
      // Contents new to the draft each round: a no-op would answer at step 9 and never reach the role row.
      editing = running(runtime, (tx) => edit(s.kManager, s.S, s.T, s.draft, v, s.C2, [line(`Narrowing ${ending}`, 1, 1)], { db: tx }));
      // THE BARRIER (N): the edit has decided on the committed Edit (step 3, unlocked), taken the header, and waits at 5b for the
      // role's key, which the narrowing's UPDATE holds EXCLUSIVE (its AFTER trigger): the edit's one ungranted lock is an advisory
      // ShareLock, classid 530030, objid the key, objsubid 2 — not the role row (the edit never waits for one).
      await until(() => blockedBy(editing.pid, narrowing.pid), `${ending}: the edit waits on the role's key behind the narrowing`);
      const w = await waitingIn(editing.pid);
      assert.equal(w.waiting, 1, `${ending}: one ungranted lock`);
      assert.match(w.query, /m7b_invoice_draft_update/, `${ending}: inside the edit`);
      assert.deepEqual(await waitsFor(editing.pid), [['advisory', 'ShareLock']], `${ending}: it waits for an advisory lock, SHARED`);
      assert.deepEqual(await guardLocksOf(editing.pid), [await guardLock(s.T, 'manager', 'ShareLock', false)], `${ending}: the manager's key, ungranted`);
      assert.deepEqual(await guardLocksOf(narrowing.pid), [await guardLock(s.T, 'manager', 'ExclusiveLock')], `${ending}: held EXCLUSIVE by the narrowing`);
      // ...having already taken the header FOR UPDATE (header before role row): a third session cannot take it.
      const nowait = await errorOf(owner.begin(RC, (tx) => tx`select 1 from tmpos_invoice_draft.invoice_draft where draft_id = ${s.draft} for update nowait`));
      assert.equal(nowait?.code, '55P03', `${ending}: the waiting edit holds the header`);
      narrowing.release(ending);
      assert.equal((await narrowing.done).outcome, ending === 'commit' ? 'committed' : 'rolled back');
      const out = await editing.done;
      if (ending === 'commit') {
        assert.deepEqual(out.value, [REFUSED], 'refused at the guard: the fresh read after the key wait sees the narrowing that committed');
        assert.deepEqual(await stateOf(s.draft), before, 'nothing written');
        assert.deepEqual(await writes([s.T]), prints);
      } else {
        assert.deepEqual(out.value, [done('applied', s.manager, s.T, s.S, v + 1)], 'rolled back: the same edit applies');
      }
    } finally {
      narrowing.release('rollback');
      await narrowing.done;
      if (editing !== null) await editing.done;
    }
  }
  assert.equal((await owner`select level from tmpos_role.tenant_role_level where tenant_id = ${s.T} and role_id = 'manager' and domain = 'invoices'`)[0].level, 'create');
  // The edit first (N): the owner's narrowing — the role row FOR UPDATE taken, the level UPDATEd — waits in its AFTER trigger for
  // the role's key, which the edit holds SHARED until its COMMIT (an advisory ExclusiveLock wait: classid 530030, objid the key,
  // objsubid 2), and governs only later edits.
  await setLevel(s.T, 'manager', 'invoices', 'edit');
  const v = await versionOf(s.draft);
  const editHold = holding(runtime, (tx) => edit(s.kManager, s.S, s.T, s.draft, v, s.C1, LINES, { db: tx }));
  let narrowing = null;
  try {
    await until(() => editHold.ready, 'the edit applied, uncommitted');
    narrowing = running(owner, narrow);
    await until(() => blockedBy(narrowing.pid, editHold.pid), 'the narrowing waits for the edit');
    assert.deepEqual(await waitsFor(narrowing.pid), [['advisory', 'ExclusiveLock']], 'the narrowing waits for an advisory lock, EXCLUSIVE');
    assert.deepEqual(await guardLocksOf(narrowing.pid), [await guardLock(s.T, 'manager', 'ExclusiveLock', false)], 'the manager\'s key, ungranted');
    assert.deepEqual(await guardLocksOf(editHold.pid), [await guardLock(s.T, 'manager', 'ShareLock')], 'held SHARED by the edit');
    editHold.release('commit');
    assert.deepEqual(await editHold.done, { outcome: 'committed', value: [done('applied', s.manager, s.T, s.S, v + 1)] });
    assert.equal((await narrowing.done).outcome, 'committed');
  } finally {
    editHold.release('rollback');
    await editHold.done;
    if (narrowing !== null) await narrowing.done;
  }
  assert.equal(await versionOf(s.draft), v + 1, 'the edit committed first');
  assert.deepEqual(await edit(s.kManager, s.S, s.T, s.draft, v + 1, s.C2, NEXT), [REFUSED], 'the next edit meets the narrowing');

  // DA-204 — the sealed answers and the Invoices level. The edit decides the level at step 3, UNLOCKED. With the header held by
  // another session, a stale edit and a current no-op each pass step 3 at Edit and wait on the header. A DIFFERENT actor (a
  // store owner holding one tenant grant) then commits the downgrade to Create through the REAL setter (026), with the version
  // it reviewed; the header is released. Current Invoices >= Edit must hold through the sealed answer: the edit is REFUSED,
  // nothing of the draft, its lines or any completion written, and the role and version rows are exactly the setter's (the
  // snapshot is taken AFTER the downgrade).
  const own = await tenantOwner(s.T, 'narrow');
  for (const [label, version, sealed] of [['a stale edit', v, answer('conflict')], ['a current no-op', v + 1, done('unchanged', s.manager, s.T, s.S, v + 1)]]) {
    await t.test(`DA-204 defect reproduction: ${label}, the downgrade committed while it waits on the header`, async (st) => {
      await setLevel(s.T, 'manager', 'invoices', 'edit');
      const obs = await downgradeWhileWaiting({ s, own, version, customer: s.C1, lines: LINES, label });
      evidence(st, { case: `IDE-11 ${label}`, decidingRead: 'step 3 (unlocked Invoices level, Edit) before the header wait', waitedOn: obs.barrier,
        downgrade: obs.set, downgradeCommittedWhileWaiting: obs.waitingAfterDowngrade, answer: obs.out.value, sealedAnswerOfEntry: sealed,
        draftUntouched: JSON.stringify(obs.afterRelease.state) === JSON.stringify(obs.afterDowngrade.state),
        writesUnchanged: JSON.stringify(obs.afterRelease.prints) === JSON.stringify(obs.afterDowngrade.prints),
        roleRowsUnchanged: JSON.stringify(obs.afterRelease.rows) === JSON.stringify(obs.afterDowngrade.rows) });
      assertDowngradeWon(obs, { owner: own, tenant: s.T, label });
    });
  }
});

test('IDE-12 (AC-14): a grant suspended or a store made read-only first — the edit waits in 016\'s hold, then is refused with nothing written (rolled back instead: it applies); the edit first — the change waits for its COMMIT and refuses only later edits', async () => {
  const NEXT = [line('Ordered', 1, 1)];
  for (const [label, change] of [
    ['grant', (s) => (tx) => tx`update user_membership set status = 'suspended' where membership_id = ${s.manager.memberships[0]} returning status`],
    ['store', (s) => (tx) => tx`update store set status = 'read_only' where store_id = ${s.S} returning status`],
  ]) {
    for (const ending of ['rollback', 'commit']) {
      const s = await scene(`${label}-first-${ending}`);
      const changing = holding(owner, change(s));
      let editing = null;
      try {
        await until(() => changing.ready, `${label} ${ending}: the change held`);
        const before = await stateOf(s.draft);
        const prints = await writes([s.T]);
        editing = running(runtime, (tx) => edit(s.kManager, s.S, s.T, s.draft, 1, s.C2, NEXT, { db: tx }));
        await until(() => blockedBy(editing.pid, changing.pid), `${label} ${ending}: the edit waits on the changed row`);
        const w = await waitingIn(editing.pid);
        assert.equal(w.waiting, 1, `${label} ${ending}: one ungranted lock`);
        assert.match(w.query, /m7b_invoice_draft_update/);
        changing.release(ending);
        await changing.done;
        const out = await editing.done;
        if (ending === 'commit') {
          assert.deepEqual(out.value, [REFUSED], `${label}: refused once the change committed`);
          assert.deepEqual(await stateOf(s.draft), before, `${label}: nothing written`);
          assert.deepEqual(await writes([s.T]), prints, `${label}: no role anchor either`);
        } else {
          assert.deepEqual(out.value, [done('applied', s.manager, s.T, s.S, 2)], `${label}: rolled back, the edit applies`);
        }
      } finally {
        changing.release('rollback');
        await changing.done;
        if (editing !== null) await editing.done;
      }
    }
    const s = await scene(`${label}-after`);
    const editHold = holding(runtime, (tx) => edit(s.kManager, s.S, s.T, s.draft, 1, s.C2, NEXT, { db: tx }));
    let changing = null;
    try {
      await until(() => editHold.ready, `${label} after: the edit applied, uncommitted`);
      changing = running(owner, change(s));
      await until(() => blockedBy(changing.pid, editHold.pid), `${label} after: the change waits for the edit`);
      editHold.release('commit');
      assert.deepEqual(await editHold.done, { outcome: 'committed', value: [done('applied', s.manager, s.T, s.S, 2)] });
      assert.equal((await changing.done).outcome, 'committed');
    } finally {
      editHold.release('rollback');
      await editHold.done;
      if (changing !== null) await changing.done;
    }
    assert.deepEqual(await edit(s.kManager, s.S, s.T, s.draft, 2, s.C1, LINES), [REFUSED], `${label}: the next edit meets the change`);
  }
});

// ===========================================================================
// IDE-19: a session that expires while the edit waits for the guard key (replaces 029's IDE-15, whose subject — step 10's lock
// anchor — is gone)
// ===========================================================================

test('IDE-19 (AC-07, N; real database clock): a writer holds the role\'s key (an uncommitted first non-NULL INSERT); the edit of an 8 s session waits for it at the guard until the database clock passes the expiry; the writer rolled back, the edit is REFUSED by the clock check after the wait — nothing written, no role row', async () => {
  const s = await scene('late');
  // A short-lived session for the manager (no stored role row): live through every step up to the guard, expired once the guard
  // has waited. The expiry cannot be moved by an UPDATE while the edit waits: the routine compares the database clock with the
  // expires_at it read in step 1 (held in a variable), and it holds the session and mint-ledger rows FOR SHARE from step 1 until
  // COMMIT, so an owner's UPDATE of either would wait for the edit and could not change the value it compares. The lifetime is
  // therefore real time, chosen generous (8 s) so the edit reaches the guard long before it (asserted below: it is seen waiting
  // there first); the test then waits on the database clock passing the expiry — a condition, never a guess.
  const key = await mint(s.manager, { lifetime: 8_000 });
  const [{ expires }] = await owner`select expires_at::text as expires from tmpos_session.session where session_key = ${key}`;
  // A writer's uncommitted FIRST INSERT of a non-NULL level for the manager's Invoices row (there is none): its AFTER INSERT
  // trigger takes the role's key EXCLUSIVE and holds it. Rolled back, the level is the catalog default (Full) again, so nothing
  // but the clock check after the wait can refuse the edit: a lost clock check would let it APPLY.
  const holder = holding(owner, (tx) => tx`insert into tmpos_role.tenant_role_level (tenant_id, role_id, domain, level, updated_at)
    values (${s.T}, 'manager', 'invoices', 'create', now())`);
  let editing = null;
  try {
    await until(() => holder.ready, 'the writer\'s first insertion held, uncommitted');
    assert.deepEqual(await guardLocksOf(holder.pid), [await guardLock(s.T, 'manager', 'ExclusiveLock')], 'the writer holds the key EXCLUSIVE');
    const prints = await footprint([s.T]);
    const before = await stateOf(s.draft);
    // As the routine's owner, so that the refusing transaction can count its own rows (the login reads none).
    let seen = null;
    editing = holding(owner, async (tx) => {
      seen = {
        rows: await edit(key, s.S, s.T, s.draft, 1, s.C2, [line('Late', 1, 1)], { db: tx }),
        roles: (await tx`select role_id, domain, level from tmpos_role.tenant_role_level where tenant_id = ${s.T}`).map((r) => ({ ...r })),
        state: await stateOf(s.draft, tx),
      };
    });
    await until(() => blockedBy(editing.pid, holder.pid), 'the edit waits for the writer\'s key at the guard');
    assert.match((await waitingIn(editing.pid)).query, /m7b_invoice_draft_update/);
    // The exact barrier: the one ungranted lock is the advisory ShareLock on the role's key (classid 530030, objid the key,
    // objsubid 2); the edit already holds the draft header (a third session cannot take it) and has written no line.
    const wait = await lockWaitOf(editing.pid, holder.pid);
    assert.deepEqual(wait.ungranted.map((l) => [l.locktype, l.mode]), [['advisory', 'ShareLock']], JSON.stringify(wait.locks));
    assert.deepEqual(await guardLocksOf(editing.pid), [await guardLock(s.T, 'manager', 'ShareLock', false)], 'waiting for exactly that key');
    assert.ok(!wait.locks.some((l) => l.rel === 'tmpos_invoice_draft.invoice_draft_line' && l.mode === 'RowExclusiveLock'), 'not yet at the lines');
    const nowait = await errorOf(owner.begin(RC, (tx) => tx`select 1 from tmpos_invoice_draft.invoice_draft where draft_id = ${s.draft} for update nowait`));
    assert.equal(nowait?.code, '55P03', 'the waiting edit holds the header');
    // Bracketed: the session is still live on the database clock when the edit is seen waiting ...
    assert.ok(await dbNow() < BigInt(expires), 'the session is live at the barrier');
    // ... and the expiry then passes while it waits (a condition on the database clock, never a guess; the bound kept).
    await until(async () => (await dbNow()) >= BigInt(expires), 'the session expired while the edit waited', 20_000);
    holder.release('rollback');
    await holder.done;
    await until(() => editing.ready, 'the edit answered');
    assert.deepEqual(seen.rows, [REFUSED], 'refused by the clock check after the key wait');
    assert.deepEqual(seen.roles, [], 'inside the refusing transaction: no role row at all (the writer\'s INSERT rolled back; the edit makes none)');
    assert.deepEqual(seen.state, before, 'and nothing of the draft');
    editing.release('rollback');
    const out = await editing.done;
    assert.equal(out.outcome, 'rolled back');
    assert.deepEqual(await stateOf(s.draft), before, 'the draft untouched');
    assert.deepEqual(await footprint([s.T]), prints, 'rolled back: no line, audit, event or record remains');
    assert.deepEqual(await invoicesRowsOf(s.T), { roles: [], versions: [] }, 'no role row, no version row');
  } finally {
    holder.release('rollback');
    await holder.done;
    if (editing !== null) { editing.release('rollback'); await editing.done; }
  }
});

// ===========================================================================
// IDE-16, IDE-22: DA-204 — current Invoices >= Edit through every sealed answer (absent override; invalid_state's ordering)
// ===========================================================================

test('IDE-16 (AC-03 DA-204): with NO Invoices role row for the manager (the catalog default, Full, governs) the owner\'s REAL setter makes the first insertion — to Create — while a current no-op or a stale edit waits on the header: REFUSED, nothing of the edit written, the setter\'s own rows exactly as it wrote them', async (t) => {
  for (const stale of [false, true]) {
    const label = stale ? 'a stale edit' : 'a current no-op';
    await t.test(`DA-204 defect reproduction: absent override, ${label}, the first insertion committed while it waits on the header`, async (st) => {
      // The store owner saved the draft: a store owner is fixed Full, so no role row of any role exists for the tenant.
      const s = await scene(stale ? 'absent-stale' : 'absent-noop');
      const own = await tenantOwner(s.T, stale ? 'absent-stale' : 'absent-noop');
      if (stale) {
        // A real edit by the store owner (never a role row): the draft is at version 2, so the manager's version 1 is stale.
        assert.deepEqual(await edit(s.kBoss, s.S, s.T, s.draft, 1, s.C2, [line('Prepared', 1, 1)]), [done('applied', s.boss, s.T, s.S, 2)]);
      }
      const sealed = stale ? answer('conflict') : done('unchanged', s.manager, s.T, s.S, 1);
      const obs = await downgradeWhileWaiting({ s, own, version: 1, customer: s.C1, lines: LINES, label });
      evidence(st, { case: `IDE-16 ${label}`, decidingRead: 'step 3 (unlocked; no row, so the catalog default Full) before the header wait', waitedOn: obs.barrier,
        rowsWhenWaiting: obs.rowsBeforeDowngrade, firstInsertion: obs.set, downgradeCommittedWhileWaiting: obs.waitingAfterDowngrade, answer: obs.out.value,
        sealedAnswerOfEntry: sealed, rowsAfterDowngrade: obs.afterDowngrade.rows, rowsAfterRelease: obs.afterRelease.rows,
        draftUntouched: JSON.stringify(obs.afterRelease.state) === JSON.stringify(obs.afterDowngrade.state),
        writesUnchanged: JSON.stringify(obs.afterRelease.prints) === JSON.stringify(obs.afterDowngrade.prints) });
      assert.deepEqual(obs.rowsBeforeDowngrade, { roles: [], versions: [] }, `${label}: no Invoices role row and no version row while the edit waits: the default governs`);
      assert.equal(obs.reviewed, 0, `${label}: the setter reviews version 0`);
      assertDowngradeWon(obs, { owner: own, tenant: s.T, label });
      assert.deepEqual(obs.afterRelease.rows.roles.map(({ xmin, ...r }) => r), [{ role_id: 'manager', domain: 'invoices', level: 'create' }],
        `${label}: the only role row is the setter's first insertion`);
    });
  }
});

test('IDE-22 (AC-01 DA-204): invalid_state is decided only after the current Invoices level is protected — in a rolled-back owner transaction that moves the draft to \'issued\', a writer\'s uncommitted narrowing holds the edit back and, committed, the edit is REFUSED, never invalid_state', async (t) => {
  // The status can never leave 'draft' in a committed state (028's CHECK): as IDE-07 shows invalid_state, the CHECK is dropped
  // and the status moved inside ONE owner transaction that is always rolled back. The edit runs in that transaction; the writer
  // is another session.
  const s = await scene('order', { managerLevel: 'edit' });
  const own = await tenantOwner(s.T, 'order');
  const reviewed = await versionRowOf(s.T, 'manager');
  // The writer: the REAL setter narrowing the manager to Create, its transaction held uncommitted after the level UPDATE.
  const writer = holding(runtime, (tx) => setInvoices(own.key, 'manager', 'create', s.T, reviewed, tx));
  let seen = null;
  let editing = null;
  try {
    await until(() => writer.ready, 'the writer\'s narrowing held, uncommitted');
    editing = holding(owner, async (tx) => {
      await tx`alter table tmpos_invoice_draft.invoice_draft drop constraint invoice_draft_status_chk`;
      await tx`update tmpos_invoice_draft.invoice_draft set status = 'issued' where draft_id = ${s.draft}`;
      // The writer's own role and version rows appear once it commits: only what an edit could write is compared.
      const mine = async () => { const { roles, versions, ...rest } = await footprint([s.T], tx); void roles; void versions; return { prints: rest, state: await stateOf(s.draft, tx) }; };
      const was = await mine();
      const rows = await edit(s.kManager, s.S, s.T, s.draft, 1, s.C2, [line('Ordered', 1, 1)], { db: tx });
      seen = { rows, was, now: await mine() };
    });
    const where = await until(async () => ((await blockedBy(editing.pid, writer.pid)) ? 'waiting' : editing.ready ? 'answered' : false),
      'the edit waits for the writer, or answers');
    evidence(t, { case: 'IDE-22', decidingRead: 'step 3 (unlocked Edit) then the header (own transaction), then step 6', edit: where,
      answerBeforeTheWriterCommitted: seen === null ? null : seen.rows });
    assert.equal(where, 'waiting', `the edit answered ${JSON.stringify(seen?.rows)} at once, without waiting for the writer's uncommitted narrowing`);
    assert.equal(seen, null, 'the edit has not answered while the writer holds its narrowing');
    writer.release('commit');
    const written = await writer.done;
    assert.deepEqual(written, { outcome: 'committed', value: [{ o_outcome: 'applied', o_tenant_id: s.T, o_actor_id: own.who.id, o_membership_id: own.who.memberships[0],
      o_level: 'create', o_version: reviewed + 1 }] });
    await until(() => editing.ready, 'the edit answered once the writer committed');
    evidence(t, { case: 'IDE-22', answerAfterTheWriterCommitted: seen.rows });
    assert.deepEqual(seen.rows, [REFUSED], 'refused on the narrowing that committed — not invalid_state');
    assert.deepEqual(seen.now, seen.was, 'nothing written');
    editing.release('rollback');
    assert.equal((await editing.done).outcome, 'rolled back');
  } finally {
    writer.release('rollback');
    await writer.done;
    if (editing !== null) { editing.release('rollback'); await editing.done; }
  }
  assert.equal((await owner`select status from tmpos_invoice_draft.invoice_draft where draft_id = ${s.draft}`)[0].status, 'draft', 'rolled back: the draft is still a draft');
  assert.equal((await owner`select count(*)::int as n from pg_catalog.pg_constraint where conname = 'invoice_draft_status_chk'
    and conrelid = 'tmpos_invoice_draft.invoice_draft'::regclass`)[0].n, 1, 'rolled back: 028\'s CHECK is back');
});

// ===========================================================================
// IDE-17, IDE-18, IDE-20: the guard key — who holds it, who waits for it (AC-04, AC-06, AC-11)
// ===========================================================================

/** An edit that answers inside a transaction that stays open (`h.answer` once `h.ready`): it holds everything it took until released. */
function holdingEdit(s, { key = s.kManager, db = runtime, version = 1, customer = s.C2, lines = [line('Held change', 1, 1)], draft = s.draft, fn = UPDATE_FN } = {}) {
  const h = holding(db, async (tx) => { h.answer = await edit(key, s.S, s.T, draft, version, customer, lines, { db: tx, fn }); });
  return h;
}
/** `r` (a `running` statement) settles on its own — it is never seen waiting on a lock. */
async function settlesUnblocked(r, label) {
  let out = null;
  r.done.then((v) => { out = v; });
  await until(async () => out !== null || (r.pid !== null && (await owner`select wait_event_type from pg_catalog.pg_stat_activity where pid = ${r.pid}`)[0]?.wait_event_type === 'Lock'), label);
  assert.notEqual(out, null, `${label}: it waited on a lock instead of settling`);
  assert.equal(out.outcome, 'committed', `${label}: ${JSON.stringify(out)}`);
  return out;
}
/** The manager's Invoices level as it effectively is now: the stored one, else the catalog default (Full). */
const managerLevelNow = async (tenant) => (await owner`select level from tmpos_role.tenant_role_level
  where tenant_id = ${tenant} and role_id = 'manager' and domain = 'invoices'`)[0]?.level ?? 'full';
/** The catalog default Invoices level of the two roles the writer paths use (the level a role without a stored row has). */
const INVOICES_DEFAULT = { manager: 'full', technician: 'view' };
/** A role's Invoices level as it effectively is now: the stored one, else the catalog default (the manager's and the technician's). */
const roleLevelNow = async (tenant, role) => (await owner`select level from tmpos_role.tenant_role_level
  where tenant_id = ${tenant} and role_id = ${role} and domain = 'invoices'`)[0]?.level ?? INVOICES_DEFAULT[role];
/** The advisory locks of every class `pid` holds or waits for (a fence or another suite's key would show here). */
const anyAdvisoryOf = async (pid) => (await owner`select l.classid::int as class, l.objid::int as key, l.mode::text as mode, l.granted
  from pg_catalog.pg_locks l where l.pid = ${pid} and l.locktype = 'advisory' order by 1, 2, 3`).map((r) => ({ ...r }));

test('IDE-17 (AC-04, N): an edit that answered unchanged or conflict inside a transaction that stays open holds the role\'s key SHARED — the owner\'s REAL setter and a direct owner UPDATE each wait on that key behind the edit\'s backend (an advisory ExclusiveLock wait), commit once the edit does, and the next edit is REFUSED', async () => {
  const attempts = {
    unchanged: (s) => ({ version: 1, customer: s.C1, lines: LINES, expected: done('unchanged', s.manager, s.T, s.S, 1) }),
    conflict: (s) => ({ version: 2, customer: s.C2, lines: [line('Stale', 1, 1)], expected: answer('conflict') }),
  };
  for (const sealed of ['unchanged', 'conflict']) {
    for (const via of ['setter', 'owner UPDATE']) {
      const label = `${sealed} / ${via}`;
      const tag = `${sealed}-${via === 'setter' ? 'setter' : 'update'}`;
      const s = await scene(`k17-${tag}`, { managerLevel: 'full' });
      const own = await tenantOwner(s.T, `k17-${tag}`);
      const reviewed = await versionRowOf(s.T, 'manager');
      const attempt = attempts[sealed](s);
      const held = holdingEdit(s, attempt);
      let writer = null;
      try {
        await until(() => held.ready, `${label}: the sealed answer reached, its transaction open`);
        assert.deepEqual(held.answer, [attempt.expected], `${label}: the sealed answer`);
        const before = { state: await stateOf(s.draft), prints: await writes([s.T]), rows: await invoicesRowsOf(s.T) };
        assert.deepEqual(await guardLocksOf(held.pid), [await guardLock(s.T, 'manager', 'ShareLock')], `${label}: the sealed answer holds the role's key SHARED`);
        writer = via === 'setter'
          ? running(runtime, (tx) => setInvoices(own.key, 'manager', 'create', s.T, reviewed, tx))
          : running(owner, (tx) => tx`update tmpos_role.tenant_role_level set level = 'create', updated_at = now()
              where tenant_id = ${s.T} and role_id = 'manager' and domain = 'invoices'`);
        let settled = null;
        writer.done.then((v) => { settled = v; });
        await until(() => blockedBy(writer.pid, held.pid), `${label}: the writer waits behind the edit`);
        assert.deepEqual(await waitsFor(writer.pid), [['advisory', 'ExclusiveLock']], `${label}: it waits for an advisory lock, EXCLUSIVE — nothing else`);
        assert.deepEqual((await guardLocksOf(writer.pid)).filter((l) => !l.granted), [await guardLock(s.T, 'manager', 'ExclusiveLock', false)], `${label}: the manager's key`);
        assert.equal(settled, null, `${label}: the writer cannot commit while the edit holds the key`);
        assert.deepEqual(await stateOf(s.draft), before.state, `${label}: the sealed answer wrote nothing`);
        assert.deepEqual(await invoicesRowsOf(s.T), before.rows, `${label}: and the level is still the committed one`);
        held.release('commit');
        assert.equal((await held.done).outcome, 'committed', `${label}: the edit's transaction ended`);
        const out = await writer.done;
        assert.equal(out.outcome, 'committed', `${label}: ${JSON.stringify(out)}`);
        if (via === 'setter') {
          assert.deepEqual(out.value.map((r) => ({ ...r })), [{ o_outcome: 'applied', o_tenant_id: s.T, o_actor_id: own.who.id,
            o_membership_id: own.who.memberships[0], o_level: 'create', o_version: reviewed + 1 }], `${label}: the real setter applied the downgrade`);
        }
        assert.equal(await managerLevelNow(s.T), 'create', `${label}: the downgrade committed after the edit`);
        assert.deepEqual(await stateOf(s.draft), before.state, `${label}: the draft as the sealed answer left it`);
        assert.deepEqual(await writes([s.T]), before.prints, `${label}: nothing written but the downgrade's own role and version rows`);
        assert.deepEqual(await edit(s.kManager, s.S, s.T, s.draft, 1, s.C2, [line('Next', 1, 1)]), [REFUSED], `${label}: the next edit meets the downgrade`);
        assert.deepEqual(await stateOf(s.draft), before.state, `${label}: and wrote nothing`);
      } finally {
        held.release('rollback');
        await held.done;
        if (writer !== null) await writer.done;
      }
    }
  }
});

test('IDE-18 (AC-06, G/N): a store owner\'s no-op, conflict and change take NO key and write no role row or version row — read from pg_locks and from the tables inside the edit\'s own transaction — while a manager\'s edit at the same point holds exactly the role\'s key (the positive control)', async () => {
  const s = await scene('k18');
  const attempts = [
    ['a no-op', { version: 1, customer: s.C1, lines: LINES }, (who) => done('unchanged', who, s.T, s.S, 1)],
    ['a sealed conflict', { version: 2, customer: s.C2, lines: [line('Stale', 1, 1)] }, () => answer('conflict')],
    ['a change', { version: 1, customer: s.C2, lines: [line('Changed', 1, 1)] }, (who) => done('applied', who, s.T, s.S, 2)],
  ];
  for (const [who, key, holdsKey] of [['the store owner', s.kBoss, false], ['the manager (positive control)', s.kManager, true]]) {
    const subject = holdsKey ? s.manager : s.boss;
    for (const [name, a, expected] of attempts) {
      const label = `${who}, ${name}`;
      let seen = null;
      // As the routine's owner, so that the transaction can read its own uncommitted rows (the login reads none).
      const held = holding(owner, async (tx) => {
        seen = { rows: await edit(key, s.S, s.T, s.draft, a.version, a.customer, a.lines, { db: tx }), levels: await invoicesRowsOf(s.T, tx) };
      });
      try {
        await until(() => held.ready, `${label}: answered, transaction open`);
        assert.deepEqual(seen.rows, [expected(subject)], `${label}: the answer`);
        assert.deepEqual(seen.levels, { roles: [], versions: [] }, `${label}: no role row, no version row — not even the transaction's own`);
        assert.deepEqual(await anyAdvisoryOf(held.pid), holdsKey ? [{ class: GUARD_CLASS, key: await guardKey(s.T, 'manager'), mode: 'ShareLock', granted: true }] : [],
          holdsKey ? `${label}: exactly the role's key, SHARED` : `${label}: no advisory lock of any class — no key taken`);
      } finally {
        held.release('rollback');
        await held.done;
      }
      assert.equal(await versionOf(s.draft), 1, `${label}: rolled back, the draft is as it was`);
    }
  }
  assert.deepEqual(await invoicesRowsOf(s.T), { roles: [], versions: [] }, 'nothing remains');
});

// The writer paths of IDE-20: how the world looks before (the manager's stored Invoices level — undefined: no row — plus an
// optional technician row or Customers row), what the writer runs, and the manager's effective level once it commits.
const WRITER_PATHS = [
  { name: 'the REAL setter, the first insertion (no row)', via: 'runtime', after: 'create', run: (f, tx) => setInvoices(f.own.key, 'manager', 'create', f.T, 0, tx) },
  { name: 'the REAL setter, an update', stored: 'full', via: 'runtime', after: 'create', run: (f, tx) => setInvoices(f.own.key, 'manager', 'create', f.T, 0, tx) },
  { name: 'the REAL setter, a reset to the default word', stored: 'edit', via: 'runtime', after: 'full', run: (f, tx) => setInvoices(f.own.key, 'manager', 'full', f.T, 0, tx) },
  { name: 'an owner INSERT of a level', via: 'owner', after: 'create', run: (f, tx) => tx`insert into tmpos_role.tenant_role_level (tenant_id, role_id, domain, level, updated_at)
      values (${f.T}, 'manager', 'invoices', 'create', now())` },
  { name: 'an owner UPDATE', stored: 'full', via: 'owner', after: 'create', run: (f, tx) => tx`update tmpos_role.tenant_role_level set level = 'create'
      where tenant_id = ${f.T} and role_id = 'manager' and domain = 'invoices'` },
  { name: 'an owner UPDATE of a non-NULL level to NULL (the default)', stored: 'edit', via: 'owner', after: 'full', run: (f, tx) => tx`update tmpos_role.tenant_role_level
      set level = null where tenant_id = ${f.T} and role_id = 'manager' and domain = 'invoices'` },
  { name: 'an owner DELETE of a non-NULL row', stored: 'edit', via: 'owner', after: 'full', run: (f, tx) => tx`delete from tmpos_role.tenant_role_level
      where tenant_id = ${f.T} and role_id = 'manager' and domain = 'invoices'` },
  { name: 'a key-moving UPDATE out of the key (manager -> technician)', stored: 'edit', via: 'owner', after: 'full', run: (f, tx) => tx`update tmpos_role.tenant_role_level
      set role_id = 'technician' where tenant_id = ${f.T} and role_id = 'manager' and domain = 'invoices'` },
  { name: 'a key-moving UPDATE into the key (technician -> manager)', technician: 'create', via: 'owner', after: 'create', run: (f, tx) => tx`update tmpos_role.tenant_role_level
      set role_id = 'manager' where tenant_id = ${f.T} and role_id = 'technician' and domain = 'invoices'` },
  { name: 'an owner UPDATE moving a Customers row into the Invoices domain', customers: 'view', via: 'owner', after: 'view', run: (f, tx) => tx`update tmpos_role.tenant_role_level
      set domain = 'invoices' where tenant_id = ${f.T} and role_id = 'manager' and domain = 'customers'` },
  // The edit is a technician's here (its default Invoices level is View): the stored Edit that lets it edit goes out of the domain.
  { name: 'an owner UPDATE moving an Invoices row out to the Customers domain (a technician with a stored Edit)', editor: 'technician', technician: 'edit', via: 'owner', after: 'view', run: (f, tx) => tx`update tmpos_role.tenant_role_level
      set domain = 'customers' where tenant_id = ${f.T} and role_id = 'technician' and domain = 'invoices'` },
];
/**
 * A fresh scene for a writer path: the manager's stored level, the technician's or Customers row if the path needs one, and the
 * tenant's owner. `f.role` is the role whose edit the path holds (the manager, or the technician when `editor` says so), `f.editor`
 * its actor and `f.kEditor` that actor's session key.
 */
async function guardScene(label, { stored, technician, customers, editor = 'manager', createFn } = {}) {
  const f = await scene(label, { ...(stored === undefined ? {} : { managerLevel: stored }), createFn });
  if (technician !== undefined) await setLevel(f.T, 'technician', 'invoices', technician);
  if (customers !== undefined) await setLevel(f.T, 'manager', 'customers', customers);
  f.own = await tenantOwner(f.T, label);
  f.role = editor;
  if (editor === 'manager') { f.editor = f.manager; f.kEditor = f.kManager; } else {
    f.editor = await actor(`${label}-${editor}`, [storeGrant(f.T, f.S, editor)]);
    f.kEditor = await mint(f.editor);
  }
  return f;
}
const writerDb = (path) => (path.via === 'runtime' ? runtime : owner);

test('IDE-20 (AC-11, N): while an edit holds the role\'s key every writer path waits on it behind the edit\'s backend — the REAL setter\'s first insertion, update and reset to the default word; an owner\'s INSERT, UPDATE, UPDATE to NULL, DELETE of a non-NULL row and key-moving UPDATEs (a row moved into and out of the Invoices domain included) — and commits once it does; conversely each holding its change uncommitted blocks the edit at the guard and the level it commits decides the edit; a NULL anchor, a Customers write, another role\'s and another tenant\'s Invoices write do not wait; an owner TRUNCATE waits behind the edit; a waiting writer queues a later edit; a create and an edit do not block each other; two opposite key-moving UPDATEs in flight both commit (the smaller key first, no deadlock)', async () => {
  for (const [i, path] of WRITER_PATHS.entries()) {
    // (a) the edit first: the writer waits on the key behind the edit's pid.
    {
      const label = `${path.name}, the edit first`;
      const f = await guardScene(`k20a${i}`, path);
      const held = holdingEdit(f, { key: f.kEditor });
      let writer = null;
      try {
        await until(() => held.ready, `${label}: the edit applied, uncommitted`);
        assert.deepEqual(held.answer, [done('applied', f.editor, f.T, f.S, 2)], `${label}: the edit's answer`);
        assert.deepEqual(await guardLocksOf(held.pid), [await guardLock(f.T, f.role, 'ShareLock')], `${label}: the edit holds the ${f.role}'s key SHARED`);
        const rowsBefore = await invoicesRowsOf(f.T);
        writer = running(writerDb(path), (tx) => path.run(f, tx));
        let settled = null;
        writer.done.then((v) => { settled = v; });
        await until(() => blockedBy(writer.pid, held.pid), `${label}: the writer waits behind the edit`);
        assert.deepEqual(await waitsFor(writer.pid), [['advisory', 'ExclusiveLock']], `${label}: it waits for an advisory lock, EXCLUSIVE — nothing else`);
        assert.deepEqual((await guardLocksOf(writer.pid)).filter((l) => !l.granted), [await guardLock(f.T, f.role, 'ExclusiveLock', false)], `${label}: the ${f.role}'s key`);
        assert.equal(settled, null, `${label}: it cannot commit while the edit holds the key`);
        assert.deepEqual(await invoicesRowsOf(f.T), rowsBefore, `${label}: the committed level is still the one the edit decided on`);
        held.release('commit');
        assert.equal((await held.done).outcome, 'committed', `${label}: the edit's transaction ended`);
        const out = await writer.done;
        assert.equal(out.outcome, 'committed', `${label}: the writer committed once the edit did (${JSON.stringify(out)})`);
        assert.equal(await roleLevelNow(f.T, f.role), path.after, `${label}: the ${f.role}'s level after the writer`);
        assert.equal(await versionOf(f.draft), 2, `${label}: the edit's change stands`);
      } finally {
        held.release('rollback');
        await held.done;
        if (writer !== null) await writer.done;
      }
    }
    // (b) the writer first: the edit waits at the guard on the key behind the writer's pid; the committed level decides it.
    {
      const label = `${path.name}, the writer first`;
      const f = await guardScene(`k20b${i}`, path);
      const writer = holding(writerDb(path), (tx) => path.run(f, tx));
      let editing = null;
      try {
        await until(() => writer.ready, `${label}: the writer's change held, uncommitted`);
        const editorKey = await guardKey(f.T, f.role);
        assert.ok((await guardLocksOf(writer.pid)).some((l) => l.granted && l.mode === 'ExclusiveLock' && l.key === editorKey), `${label}: the writer holds the ${f.role}'s key EXCLUSIVE`);
        const before = await stateOf(f.draft);
        editing = running(runtime, (tx) => edit(f.kEditor, f.S, f.T, f.draft, 1, f.C2, [line('Blocked change', 1, 1)], { db: tx }));
        await until(() => blockedBy(editing.pid, writer.pid), `${label}: the edit waits behind the writer`);
        assert.deepEqual(await waitsFor(editing.pid), [['advisory', 'ShareLock']], `${label}: at the guard — an advisory lock, SHARED`);
        assert.deepEqual(await guardLocksOf(editing.pid), [await guardLock(f.T, f.role, 'ShareLock', false)], `${label}: the ${f.role}'s key`);
        const nowait = await errorOf(owner.begin(RC, (tx) => tx`select 1 from tmpos_invoice_draft.invoice_draft where draft_id = ${f.draft} for update nowait`));
        assert.equal(nowait?.code, '55P03', `${label}: it already holds the draft header`);
        writer.release('commit');
        assert.equal((await writer.done).outcome, 'committed', `${label}: the writer committed`);
        const out = await editing.done;
        assert.equal(out.outcome, 'committed', `${label}: ${JSON.stringify(out)}`);
        assert.equal(await roleLevelNow(f.T, f.role), path.after, `${label}: the ${f.role}'s level after the writer`);
        if (['none', 'view', 'create'].includes(path.after)) {
          assert.deepEqual(out.value, [REFUSED], `${label}: the level it committed (${path.after}) refuses the edit`);
          assert.deepEqual(await stateOf(f.draft), before, `${label}: nothing written`);
        } else {
          assert.deepEqual(out.value, [done('applied', f.editor, f.T, f.S, 2)], `${label}: the level it committed (${path.after}) admits the edit`);
        }
      } finally {
        writer.release('rollback');
        await writer.done;
        if (editing !== null) await editing.done;
      }
    }
  }

  // (c) What does NOT wait, while an edit holds the manager's key: a NULL anchor (INSERT and DELETE) of either domain (a NULL
  // level is the default: no effective change, so neither guard takes the key for it), another role's Invoices write (a direct
  // one and the REAL setter's), another tenant's Invoices write. A Customers-domain write that sets or changes a level for the
  // same role no longer belongs here: since 032 (M7B-INVOICES-P1-R4) it waits on the same key, proven in (c2) below.
  {
    const f = await guardScene('k20c', {});
    const other = await newTenant('k20c-other');
    const held = holdingEdit(f);
    try {
      await until(() => held.ready, 'no-wait: the edit applied, uncommitted');
      assert.deepEqual(await guardLocksOf(held.pid), [await guardLock(f.T, 'manager', 'ShareLock')], 'no-wait: the edit holds the manager\'s key');
      await settlesUnblocked(running(owner, (tx) => tx`insert into tmpos_role.tenant_role_level (tenant_id, role_id, domain, level, updated_at)
        values (${f.T}, 'manager', 'invoices', null, now()) on conflict (tenant_id, role_id, domain) do nothing`), 'a NULL anchor INSERT for the same role and domain');
      await settlesUnblocked(running(owner, (tx) => tx`delete from tmpos_role.tenant_role_level where tenant_id = ${f.T} and role_id = 'manager'
        and domain = 'invoices' and level is null`), 'the DELETE of that NULL anchor');
      await settlesUnblocked(running(owner, (tx) => tx`insert into tmpos_role.tenant_role_level (tenant_id, role_id, domain, level, updated_at)
        values (${f.T}, 'manager', 'customers', null, now()) on conflict (tenant_id, role_id, domain) do nothing`), 'a Customers-domain NULL anchor INSERT for the same role');
      await settlesUnblocked(running(owner, (tx) => tx`delete from tmpos_role.tenant_role_level where tenant_id = ${f.T} and role_id = 'manager'
        and domain = 'customers' and level is null`), 'the DELETE of that Customers NULL anchor');
      await settlesUnblocked(running(owner, (tx) => tx`insert into tmpos_role.tenant_role_level (tenant_id, role_id, domain, level, updated_at)
        values (${f.T}, 'technician', 'invoices', 'create', now())`), 'another role\'s Invoices INSERT');
      await settlesUnblocked(running(owner, (tx) => tx`update tmpos_role.tenant_role_level set level = 'edit'
        where tenant_id = ${f.T} and role_id = 'technician' and domain = 'invoices'`), 'another role\'s Invoices UPDATE');
      const technicianVersion = await versionRowOf(f.T, 'technician');
      const setter = await settlesUnblocked(running(runtime, (tx) => setInvoices(f.own.key, 'technician', 'manage', f.T, technicianVersion, tx)),
        'the REAL setter for another role');
      assert.equal(setter.value[0].o_outcome, 'applied', 'and it applied');
      await settlesUnblocked(running(owner, (tx) => tx`insert into tmpos_role.tenant_role_level (tenant_id, role_id, domain, level, updated_at)
        values (${other}, 'manager', 'invoices', 'create', now())`), 'another tenant\'s Invoices INSERT for the same role');
      await settlesUnblocked(running(owner, (tx) => tx`update tmpos_role.tenant_role_level set level = 'full'
        where tenant_id = ${other} and role_id = 'manager' and domain = 'invoices'`), 'another tenant\'s Invoices UPDATE for the same role');
      assert.deepEqual(await guardLocksOf(held.pid), [await guardLock(f.T, 'manager', 'ShareLock')], 'the edit still holds exactly its key');
    } finally {
      held.release('rollback');
      await held.done;
    }
  }

  // (c2) M7B-INVOICES-P1-R4 (032): a Customers-domain write that sets or changes a level for the SAME role now waits on the
  // edit's key too, behind the edit's backend (the Customers guard takes the key EXCLUSIVE, an AFTER ROW trigger like 030's), and
  // commits once the edit's transaction ends — the converse of 030's Invoices proof above. Before 032 it did not wait.
  for (const [c2, [label, statement]] of [
    ['a Customers-domain INSERT of a level', (f) => (tx) => tx`insert into tmpos_role.tenant_role_level (tenant_id, role_id, domain, level, updated_at)
      values (${f.T}, 'manager', 'customers', 'view', now())`],
    ['a Customers-domain UPDATE of a level', (f) => (tx) => tx`update tmpos_role.tenant_role_level set level = 'edit'
      where tenant_id = ${f.T} and role_id = 'manager' and domain = 'customers'`],
  ].entries()) {
    const f = await guardScene(`k20c2-${c2}`, {});
    if (label.includes('UPDATE')) await setLevel(f.T, 'manager', 'customers', 'view');
    const held = holdingEdit(f);
    let writer = null;
    try {
      await until(() => held.ready, `${label}: the edit applied, uncommitted`);
      assert.deepEqual(await guardLocksOf(held.pid), [await guardLock(f.T, 'manager', 'ShareLock')], `${label}: the edit holds the manager's key SHARED`);
      writer = running(owner, statement(f));
      await until(() => blockedBy(writer.pid, held.pid), `${label}: the writer waits behind the edit`);
      assert.deepEqual(await waitsFor(writer.pid), [['advisory', 'ExclusiveLock']], `${label}: it waits for an advisory lock, EXCLUSIVE — nothing else`);
      assert.deepEqual((await guardLocksOf(writer.pid)).filter((l) => !l.granted), [await guardLock(f.T, 'manager', 'ExclusiveLock', false)], `${label}: the manager's key`);
      held.release('rollback');
      await held.done;
      const out = await writer.done;
      assert.equal(out.outcome, 'committed', `${label}: the writer committed once the edit's transaction ended (${JSON.stringify(out)})`);
    } finally {
      held.release('rollback');
      await held.done;
      if (writer !== null) await writer.done;
    }
  }

  // (d) TRUNCATE fires no row trigger; it is ordered by the relation lock instead: the edit's plain SELECTs hold ACCESS SHARE on
  // the level table to COMMIT, and the owner's TRUNCATE (ACCESS EXCLUSIVE) waits behind the edit — then is rolled back here.
  {
    const f = await guardScene('k20d', { stored: 'full' });
    const held = holdingEdit(f);
    let truncating = null;
    let truncated = null;
    try {
      await until(() => held.ready, 'truncate: the edit applied, uncommitted');
      truncating = holding(owner, async (tx) => { truncated = await tx.unsafe('truncate tmpos_role.tenant_role_level').then(() => 'truncated', (err) => `refused ${err.code}`); });
      await until(() => blockedBy(truncating.pid, held.pid), 'the TRUNCATE waits behind the edit');
      const wait = await lockWaitOf(truncating.pid, held.pid);
      assert.deepEqual(wait.ungranted.map((l) => [l.locktype, l.mode, l.rel]), [['relation', 'AccessExclusiveLock', 'tmpos_role.tenant_role_level']], 'on the level table, ACCESS EXCLUSIVE');
      assert.equal(truncating.ready, false, 'and it has not run');
      held.release('commit');
      assert.equal((await held.done).outcome, 'committed');
      await until(() => truncating.ready, 'the TRUNCATE ran once the edit ended');
      assert.equal(truncated, 'truncated', 'and it truncated (it is rolled back below, not refused)');
    } finally {
      held.release('rollback');
      await held.done;
      if (truncating !== null) { truncating.release('rollback'); await truncating.done; }
    }
    assert.deepEqual((await invoicesRowsOf(f.T)).roles.map(({ xmin, ...r }) => r), [{ role_id: 'manager', domain: 'invoices', level: 'full' }], 'the TRUNCATE was rolled back: the row stands');
  }

  // (e) A waiting writer queues a later edit behind it (no starvation): edit1 holds the key SHARED, the REAL setter waits for it
  // EXCLUSIVE, a second manager's edit of another draft reaches the guard and queues behind the setter; edit1 ends, the setter
  // commits, and the second edit — on the level the setter committed — is REFUSED.
  {
    const f = await guardScene('k20e', { stored: 'full' });
    const draft2 = await create(f.kBoss, f.S, f.T, f.C1, LINES);
    const manager2 = await actor('k20e-manager-2', [storeGrant(f.T, f.S, 'manager')]);
    const k2 = await mint(manager2);
    const first = holdingEdit(f);
    let writer = null;
    let second = null;
    try {
      await until(() => first.ready, 'queue: the first edit applied, uncommitted');
      writer = running(runtime, (tx) => setInvoices(f.own.key, 'manager', 'create', f.T, 0, tx));
      await until(() => blockedBy(writer.pid, first.pid), 'queue: the setter waits behind the first edit');
      second = running(runtime, (tx) => edit(k2, f.S, f.T, draft2, 1, f.C2, [line('Queued change', 1, 1)], { db: tx }));
      await until(() => blockedBy(second.pid, writer.pid), 'queue: the second edit waits behind the setter');
      assert.deepEqual(await guardLocksOf(second.pid), [await guardLock(f.T, 'manager', 'ShareLock', false)], 'queue: at the guard, for the same key');
      assert.ok((await owner`select pg_catalog.pg_blocking_pids(${second.pid}) as b`)[0].b.includes(writer.pid), 'queue: queued behind the waiting writer, not granted beside the first edit');
      first.release('commit');
      assert.equal((await first.done).outcome, 'committed');
      assert.equal((await writer.done).outcome, 'committed', 'queue: the setter committed');
      const out = await second.done;
      assert.equal(out.outcome, 'committed', JSON.stringify(out));
      assert.deepEqual(out.value, [REFUSED], 'queue: the queued edit meets the level the setter committed');
      assert.equal(await versionOf(draft2), 1, 'queue: and wrote nothing');
    } finally {
      first.release('rollback');
      await first.done;
      if (writer !== null) await writer.done;
      if (second !== null) await second.done;
    }
  }

  // (f) A draft create and an edit do not block each other. Since 031 (M7B-INVOICES-P1-R3) the save takes the role's key SHARED
  // and since 032 (M7B-INVOICES-P1-R4) it locks no role row of either domain (no Customers anchor any more): SHARED beside the
  // edit's SHARED, so neither waits.
  {
    const f = await guardScene('k20f', {});
    const manager2 = await actor('k20f-manager-2', [storeGrant(f.T, f.S, 'manager')]);
    const k2 = await mint(manager2);
    const first = holdingEdit(f);
    try {
      await until(() => first.ready, 'create: the edit applied, uncommitted');
      await settlesUnblocked(running(runtime, (tx) => create(k2, f.S, f.T, f.C1, [line('New draft', 1, 1)], { db: tx })), 'a create beside an edit holding the key');
    } finally {
      first.release('rollback');
      await first.done;
    }
    const creating = holding(runtime, async (tx) => { await create(k2, f.S, f.T, f.C1, [line('Held create', 1, 1)], { db: tx }); });
    try {
      await until(() => creating.ready, 'create: the second manager\'s create holds the key, uncommitted');
      assert.deepEqual(await guardLocksOf(creating.pid), [await guardLock(f.T, 'manager', 'ShareLock')], 'the create holds exactly the manager\'s key, SHARED (031; 032 adds no role row to it)');
      const edited = await settlesUnblocked(running(runtime, (tx) => edit(f.kManager, f.S, f.T, f.draft, 1, f.C2, [line('Beside a create', 1, 1)], { db: tx })),
        'an edit beside a create holding the key SHARED');
      assert.deepEqual(edited.value, [done('applied', f.manager, f.T, f.S, 2)], 'and it applied');
    } finally {
      creating.release('rollback');
      await creating.done;
    }
  }

  // (g) Two owner transactions of opposite key-moving UPDATEs both in flight: X moves (T, manager, customers) to (T, technician,
  // invoices) and Y moves (T, technician, customers) to (T, manager, invoices), so each statement needs BOTH roles' keys and
  // their natural orders are opposite. A parked holder of the SMALLER key stops both in flight: each waits for that key and holds
  // none (the smaller integer is requested first). Released, neither deadlocks (no 40P01): both commit; the rows are moved back.
  {
    // 030 lets two (tenant, role) keys collide (availability only): a tenant whose two keys collide is drawn again, not failed.
    let f = await guardScene('k20g', {});
    for (let n = 1; (await guardKey(f.T, 'manager')) === (await guardKey(f.T, 'technician')); n += 1) f = await guardScene(`k20g-${n}`, {});
    await setLevel(f.T, 'manager', 'customers', 'view');
    await setLevel(f.T, 'technician', 'customers', 'create');
    const rowsOf = async () => (await owner`select role_id, domain, level from tmpos_role.tenant_role_level where tenant_id = ${f.T} order by role_id, domain`).map((r) => ({ ...r }));
    const before = await rowsOf();
    assert.deepEqual(before, [{ role_id: 'manager', domain: 'customers', level: 'view' }, { role_id: 'technician', domain: 'customers', level: 'create' }], 'moving: the starting rows');
    const move = (from, to, domain, toDomain) => (tx) => tx`update tmpos_role.tenant_role_level set role_id = ${to}, domain = ${toDomain}
      where tenant_id = ${f.T} and role_id = ${from} and domain = ${domain}`;
    const [lo, hi] = [await guardKey(f.T, 'manager'), await guardKey(f.T, 'technician')].sort((a, b) => a - b);
    assert.notEqual(lo, hi, 'moving: the two roles have two different keys');
    const parked = holding(owner, (tx) => tx`select pg_catalog.pg_advisory_xact_lock(${GUARD_CLASS}::int, ${lo}::int)`);
    let x = null;
    let y = null;
    try {
      await until(() => parked.ready, 'moving: the smaller key is held');
      x = running(owner, move('manager', 'technician', 'customers', 'invoices'));
      await until(() => blockedBy(x.pid, parked.pid), 'moving: X waits for the smaller key');
      y = running(owner, move('technician', 'manager', 'customers', 'invoices'));
      await until(() => blockedBy(y.pid, parked.pid), 'moving: Y waits for the smaller key');
      for (const [who, r] of [['X', x], ['Y', y]]) {
        assert.deepEqual(await guardLocksOf(r.pid), [{ class: GUARD_CLASS, key: lo, sub: 2, mode: 'ExclusiveLock', granted: false }], `moving: ${who} waits for the smaller key and holds none`);
      }
      parked.release('rollback');
      assert.equal((await parked.done).outcome, 'rolled back', 'moving: the smaller key released');
      const [outX, outY] = [await x.done, await y.done];
      assert.equal(outX.outcome, 'committed', `moving: X committed, no deadlock (${JSON.stringify(outX)})`);
      assert.equal(outY.outcome, 'committed', `moving: Y committed, no deadlock (${JSON.stringify(outY)})`);
    } finally {
      parked.release('rollback');
      await parked.done;
      if (x !== null) await x.done;
      if (y !== null) await y.done;
    }
    assert.deepEqual(await rowsOf(), [{ role_id: 'manager', domain: 'invoices', level: 'create' }, { role_id: 'technician', domain: 'invoices', level: 'view' }], 'moving: each row went to the other role\'s Invoices key');
    await owner.begin(RC, async (tx) => {
      await move('technician', 'manager', 'invoices', 'customers')(tx);
      await move('manager', 'technician', 'invoices', 'customers')(tx);
    });
    assert.deepEqual(await rowsOf(), before, 'moving: the rows restored');
  }
});

// ===========================================================================
// IDE-13: parity of every restatement; the lock blocks
// ===========================================================================

test('IDE-13 (AC-15 AC-18, N): every SQL restatement in 029 and in 030\'s v2 — the defaults, the owner literal, the editable set, the ordering, the Edit threshold, 017\'s three description regexes — equals the catalog; v2 is 029\'s routine with exactly step 5b added and step 10 removed, its key after the header FOR UPDATE and before the sealed returns in the outermost block, the key expression the guard function\'s; no raw invisible code point; every file locks the writers\' seven first, before every check and change; 030\'s exact change lists', async () => {
  const EDITABLE = ['manager', 'technician', 'sales_staff'];
  assert.deepEqual(Object.fromEntries(EDITABLE.map((r) => [r, TENANT_ROLE_PERMISSION_DEFAULTS[r].invoices])), { manager: 'full', technician: 'view', sales_staff: 'create' },
    'the catalog\'s Invoices defaults this parity pins');
  const restated = (source, label, expect) => {
    const cases = [...source.matchAll(/case v_role ((?:when '[a-z_]+' then '[a-z]+' )+)end/g)]
      .map((m) => Object.fromEntries([...m[1].matchAll(/when '([a-z_]+)' then '([a-z]+)'/g)].map((p) => [p[1], p[2]])));
    assert.equal(cases.length, expect.cases, `${label}: every default restatement found`);
    for (const c of cases) assert.deepEqual(c, { manager: 'full', technician: 'view', sales_staff: 'create' }, `${label}: the defaults`);
    const owners = [...source.matchAll(/v_role = '([a-z_]+)'/g)].map((m) => m[1]);
    assert.deepEqual(owners, Array(expect.owners).fill('store_owner'), `${label}: the owner literal`);
    const sets = [...source.matchAll(/v_role in \(([^)]*)\)/g)].map((m) => m[1].split(',').map((x) => x.trim().replace(/^'|'$/g, '')).sort());
    assert.deepEqual(sets, Array(expect.sets).fill([...EDITABLE].sort()), `${label}: the editable set`);
    const orderings = [...source.matchAll(/array\[('none'[^\]]*)\]/g)].map((m) => m[1].split(',').map((x) => x.trim().replace(/^'|'$/g, '')));
    assert.deepEqual(orderings, Array(expect.orderings).fill([...TENANT_ORDERING]), `${label}: the ordering`);
    const thresholds = [...source.matchAll(/array_position\(c_levels, '([a-z]+)'\)/g)].map((m) => m[1]);
    assert.deepEqual(thresholds, Array(expect.thresholds).fill('edit'), `${label}: every threshold is Edit (no Customers corequisite, D1)`);
  };
  const installed = (await owner`select pg_catalog.pg_get_functiondef(${UPDATE}::regprocedure) as source`)[0].source;
  restated(installed, 'the installed edit', { cases: 2, owners: 1, sets: 2, orderings: 1, thresholds: 2 });
  restated(UP_029, 'the up file', { cases: 2, owners: 1, sets: 2, orderings: 1, thresholds: 2 });
  assert.doesNotMatch(installed, /'customers'/, 'the edit never reads the Customers level');
  // 017's three plain-text regexes, as the installed description CHECK carries them, restated exactly by the edit's step 0.
  const [{ def }] = await owner`select pg_catalog.pg_get_constraintdef(k.oid) as def from pg_catalog.pg_constraint k
    where k.conrelid = 'tmpos_invoice_draft.invoice_draft_line'::regclass and k.conname = 'invoice_draft_line_description_chk'`;
  const regexes = [...def.matchAll(/!~ '((?:[^']|'')*)'::text/g)].map((m) => m[1]);
  assert.equal(regexes.length, 3, def);
  for (const regex of regexes) assert.ok(installed.includes(`v_text !~ '${regex}'`), `the edit's step 0 restates ${regex}`);
  assert.ok(installed.includes(`char_length(v_text) between 1 and ${INVOICE_DRAFT_DESCRIPTION_MAX_CHARACTERS}`), 'and the length bound');
  for (const [label, file] of [['up', UP_029], ['down', DOWN_029]]) {
    assert.doesNotMatch(file, /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/u, `029 ${label}`);
  }
  // STATIC, for both files: the lock block is the first statement after the transaction settings and holds nothing but the
  // seven locks in the writers' order and the handler; no other LOCK statement; every check and the first change after it.
  const statements = (file) => file.split('\n').filter((l) => l.trim() !== '' && !l.startsWith('--'));
  const opensWith = (label, file, settings, raise) => {
    const want = [...settings, 'do $$', 'begin', ...WRITERS_ORDER.map((rel) => `  lock table ${rel} in access exclusive mode;`), 'exception',
      '  when undefined_table or invalid_schema_name then', raise, "      using errcode = 'object_not_in_prerequisite_state';", 'end', '$$;'];
    const got = statements(file).slice(0, want.length);
    want.forEach((l, i) => (l instanceof RegExp ? assert.match(got[i], l, `${label}, statement line ${i}`) : assert.equal(got[i], l, `${label}, statement line ${i}`)));
  };
  opensWith('the up', UP_029, ['set local search_path = pg_catalog, pg_temp;'], /^ {4}raise exception 'migration 029 refused: [^']* is missing \(migrations 002, 017, 020, 021 and 028 must be applied first\)'$/);
  opensWith('the down', DOWN_029, ['set local search_path = pg_catalog, pg_temp;', 'set local row_security = off;'],
    /^ {4}raise exception 'migration 029 rollback refused: migration 029 is not applied \([^']*\)'$/);
  const firstChange = (file) => Math.min(...[...file.matchAll(/^(?:alter|create|drop|insert|update|delete|grant|revoke|comment)\b/gm)].map((m) => m.index));
  for (const [label, file, checks] of [
    ['the up', UP_029, ['to_regprocedure(', 'to_regclass(', 'pg_constraint', 'has_function_privilege(', 'pg_has_role(', 'already exists']],
    ['the down', DOWN_029, ['to_regprocedure(', 'pg_trigger', 'transaction_isolation', 'rollback refused: an invoice draft has been edited']],
  ]) {
    const locks = [...file.matchAll(/^ *lock table ([a-z_.]+) in access exclusive mode;$/gm)];
    assert.deepEqual(locks.map((m) => m[1]), WRITERS_ORDER, `${label}: exactly the seven, in the writers' order`);
    const end = file.indexOf('\n$$;\n', locks.at(-1).index);
    assert.ok(end > 0 && end < firstChange(file), `${label}: the lock block before the first change`);
    for (const check of checks) assert.ok(file.indexOf(check) > end, `${label}: ${check} comes after the locks`);
  }
  assert.ok(DOWN_029.indexOf('rollback refused: an invoice draft has been edited') < firstChange(DOWN_029), 'the down\'s guard precedes its first change');
  // Every change either file makes, statement by statement (the first line of each): the up creates its own three objects,
  // widens the one CHECK and rewords three comments; the down removes exactly those and restores the CHECK and the comments.
  // Neither alters, replaces or re-grants an object 028 created beyond that.
  const changes = (file) => [...file.matchAll(/^(?:alter|create|drop|insert|update|delete|grant|revoke|comment)\b[^\n]*/gm)].map((m) => m[0]);
  assert.deepEqual(changes(UP_029), [
    'alter table tmpos_invoice_draft.invoice_draft',
    'comment on table tmpos_invoice_draft.invoice_draft is',
    'comment on table tmpos_invoice_draft.invoice_draft_line is',
    'create function tmpos_invoice_draft.m7b_invoice_draft_immutable()',
    'comment on function tmpos_invoice_draft.m7b_invoice_draft_immutable() is',
    'create trigger trg_invoice_draft_immutable',
    'alter table tmpos_invoice_draft.invoice_draft enable always trigger trg_invoice_draft_immutable;',
    'create function tmpos_invoice_draft.m7b_invoice_draft_update(',
    `comment on function ${UPDATE} is`,
    'comment on column public.audit_event.subject_invoice_draft_id is',
    `revoke all on function ${UPDATE} from public, anon, authenticated, tmpos_app, tmpos_audit_writer;`,
    `revoke all on function ${IMMUTABLE} from public, anon, authenticated, tmpos_app, tmpos_audit_writer;`,
    `grant execute on function ${UPDATE} to tmpos_app;`,
  ], 'the up\'s changes, in order');
  assert.ok(UP_029.includes('alter table tmpos_invoice_draft.invoice_draft\n  drop constraint invoice_draft_version_chk,\n  add constraint invoice_draft_version_chk check (version between 1 and 9007199254740991);\n'));
  assert.deepEqual(changes(DOWN_029), [
    `revoke execute on function ${UPDATE} from tmpos_app;`,
    `drop function ${UPDATE};`,
    'drop trigger trg_invoice_draft_immutable on tmpos_invoice_draft.invoice_draft;',
    `drop function ${IMMUTABLE};`,
    'alter table tmpos_invoice_draft.invoice_draft',
    'comment on table tmpos_invoice_draft.invoice_draft is',
    'comment on table tmpos_invoice_draft.invoice_draft_line is',
    'comment on column public.audit_event.subject_invoice_draft_id is',
  ], 'the down\'s changes, in order');
  assert.ok(DOWN_029.includes('alter table tmpos_invoice_draft.invoice_draft\n  drop constraint invoice_draft_version_chk,\n  add constraint invoice_draft_version_chk check (version = 1);\n'));
  assert.doesNotMatch(UP_029 + DOWN_029, /create or replace|\bexecute '|\bexecute format|cascade/i, 'no replacement, no dynamic SQL, no CASCADE');

  // ---------------------------------------------------------------------------------------------------------------------------
  // 030 (N): v2's parity with 029's routine and with the guard function, its order, and 030's two files.
  // ---------------------------------------------------------------------------------------------------------------------------
  const codeOf = (body) => body.split('\n').filter((l) => l.trim() !== '' && !l.trim().startsWith('--'));
  const proSrc = async (sig) => (await owner`select p.prosrc as src from pg_catalog.pg_proc p where p.oid = ${sig}::regprocedure`)[0].src;
  const bodyV2 = routineBody(UP_030, 'tmpos_invoice_edit', 'm7b_invoice_draft_update_v2');
  const bodyGuard = routineBody(UP_030, 'tmpos_invoice_edit', 'm7b_invoice_level_guard');
  assert.equal(await proSrc(UPDATE_V2), bodyV2, 'the installed v2 is the up file\'s body, character for character');
  assert.equal(await proSrc(GUARD), bodyGuard, 'the installed guard function is the up file\'s body, character for character');
  // v2 restates the same defaults, owner literal, editable set, ordering and Edit threshold as 029's routine does (step 5b's
  // restatements take the place of step 10's); it never reads the Customers level; step 0's description regexes are 017's.
  const installedV2 = (await owner`select pg_catalog.pg_get_functiondef(${UPDATE_V2}::regprocedure) as source`)[0].source;
  restated(installedV2, 'the installed v2', { cases: 2, owners: 1, sets: 2, orderings: 1, thresholds: 2 });
  restated(UP_030, 'the 030 up file', { cases: 2, owners: 1, sets: 2, orderings: 1, thresholds: 2 });
  assert.doesNotMatch(installedV2, /'customers'/, 'v2 never reads the Customers level');
  for (const regex of regexes) assert.ok(installedV2.includes(`v_text !~ '${regex}'`), `v2's step 0 restates ${regex}`);
  assert.ok(installedV2.includes(`char_length(v_text) between 1 and ${INVOICE_DRAFT_DESCRIPTION_MAX_CHARACTERS}`), 'and the length bound');
  // v2 IS 029's routine with EXACTLY two changes, comments aside: step 5b added after the header's clock check, step 10 (the
  // change path's anchor INSERT, role row FOR SHARE and second decision) removed.
  const A = codeOf(routineBody(UP_029, 'tmpos_invoice_draft', 'm7b_invoice_draft_update'));
  const B = codeOf(bodyV2);
  const IF_EDITABLE = "  if v_role in ('manager', 'technician', 'sales_staff') then";
  const span = (lines, anchor) => {
    const at = lines.findIndex((l) => l.startsWith(anchor));
    assert.ok(at > 0, `${anchor} is found`);
    assert.equal(lines[at - 1], IF_EDITABLE, `${anchor}: the block opens the line before`);
    return [at - 1, lines.indexOf('  end if;', at - 1) + 1];
  };
  const [a0, a1] = span(A, '    insert into tmpos_role.tenant_role_level (tenant_id, role_id, domain, level, updated_at)');
  const [b0, b1] = span(B, '    perform pg_catalog.pg_advisory_xact_lock_shared(530030, ');
  assert.ok(A.slice(a0, a1).some((l) => /for share;$/.test(l)), '029\'s step 10 takes the role row FOR SHARE');
  assert.deepEqual([...A.slice(0, a0), ...A.slice(a1)], [...B.slice(0, b0), ...B.slice(b1)],
    'v2 = 029\'s body with step 10 removed and step 5b added, every other statement character for character');
  // Step 5b's order inside v2 (comments stripped): the header FOR UPDATE, the key, the clock, the level re-read by a plain SELECT,
  // and only then the sealed returns, the customer's FOR KEY SHARE and the lines; in the routine's OUTERMOST block.
  const code = B.join('\n');
  const once = (needle) => {
    const i = code.indexOf(needle);
    assert.ok(i >= 0, `${needle} is in v2`);
    assert.equal(code.indexOf(needle, i + 1), -1, `${needle} appears once`);
    return i;
  };
  const header = once('into v_header');
  const headerLock = code.indexOf('for update;', header);
  const key = once('perform pg_catalog.pg_advisory_xact_lock_shared(530030, ');
  const reread = code.lastIndexOf('select l.level into v_invoices');
  const invalid = once("return query select 'invalid_state'::text");
  const conflict = once("return query select 'conflict'::text");
  const unchanged = once("return query select 'unchanged'::text");
  const customerLock = once('for key share');
  assert.ok(header < headerLock && headerLock < key, 'the key follows the header FOR UPDATE');
  assert.ok(key < reread && reread < invalid && invalid < conflict && conflict < unchanged, 'the key and the level re-read precede the invalid_state, conflict and unchanged returns');
  assert.ok(key < customerLock, 'and the replacement customer\'s lock');
  assert.ok(code.indexOf('v_now >= v_session.expires_at', key) > key && code.indexOf('v_now >= v_session.expires_at', key) < reread, 'the clock is read again between the key and the re-read');
  assert.equal((code.match(/\bfor update\b/g) ?? []).length, 1, 'the header\'s FOR UPDATE is the routine\'s only row lock of that kind');
  const depthAt = (src, index) => {
    let depth = 0;
    for (const m of src.matchAll(/\b(begin|end)\b(\s*;)?/gi)) {
      if (m.index >= index) break;
      if (m[1].toLowerCase() === 'begin') depth += 1; else if (m[2] !== undefined) depth -= 1;
    }
    return depth;
  };
  assert.equal(depthAt(code, header), 1, 'the header lock is in the outermost block');
  assert.equal(depthAt(code, key), 1, 'the key statement is in the outermost block: no BEGIN ... EXCEPTION around it');
  assert.equal(depthAt(code, reread), 1, 'and so is the re-read');
  assert.doesNotMatch(code.slice(key, reread), /\b(?:begin|exception)\b/i, 'nothing between the key and the re-read opens a block');
  // No step-10 anchor: v2 inserts only lines, reads the level table by two plain SELECTs (the ACCESS SHARE that orders a TRUNCATE
  // behind the edit), and never touches a version row.
  assert.deepEqual([...code.matchAll(/\binsert into ([a-z_.]+)/g)].map((m) => m[1]), ['tmpos_invoice_draft.invoice_draft_line'], 'v2 inserts only the lines');
  const levelStatements = code.split(';').filter((st) => st.includes('tmpos_role.tenant_role_level'));
  assert.equal(levelStatements.length, 2, 'the level table is read twice: step 3 and step 5b');
  for (const st of levelStatements) assert.doesNotMatch(st, /\bfor\s+(?:share|update|key)\b/i, 'each a plain SELECT');
  assert.doesNotMatch(code, /tmpos_role_edit/, 'v2 never reads a version row');
  // The two key expressions — v2's and the guard function's — are the same expression of (tenant, role), in the same class.
  const keyExpressions = (src) => [...src.matchAll(/pg_catalog\.hashtext\(([^()]*)\)/g)].map((m) => m[1]
    .replace(/\b(?:v_tenant|new\.tenant_id|old\.tenant_id)\b/g, '<tenant>').replace(/\b(?:v_role|new\.role_id|old\.role_id)\b/g, '<role>'));
  const advisory = (src) => [...src.matchAll(/pg_catalog\.(pg_[a-z_]*advisory[a-z_]*)\((\d+),/g)].map((m) => [m[1], m[2]]);
  const guardCode = codeOf(bodyGuard).join('\n');
  const KEY = "<tenant>::text || '/' || <role>";
  assert.deepEqual(keyExpressions(code), [KEY], 'v2: one key expression, hashtext(tenant::text || \'/\' || role)');
  assert.deepEqual(keyExpressions(guardCode), [KEY, KEY, KEY, KEY], 'the guard function: four, the same expression');
  assert.deepEqual(advisory(code), [['pg_advisory_xact_lock_shared', '530030']], 'v2 takes the key SHARED, transaction-scoped, class 530030');
  assert.deepEqual(advisory(guardCode), Array(4).fill(['pg_advisory_xact_lock', '530030']), 'the guard function takes it EXCLUSIVE, transaction-scoped, class 530030');
  assert.doesNotMatch(guardCode, /\bfor\s+(?:share|update)\b|\bfrom\s+[a-z_]+\.[a-z_]+|\bselect\b/i, 'the guard function reads no relation and locks no row');
  // 030's two files: no raw invisible code point; each opens with the seven locks in the writers' order, before every check and
  // change (comments aside); the exact ordered changes; no replacement, no dynamic SQL, no CASCADE.
  for (const [label, file] of [['up', UP_030], ['down', DOWN_030]]) {
    assert.doesNotMatch(file, /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/u, `030 ${label}`);
  }
  opensWith('the 030 up', UP_030, ['set local search_path = pg_catalog, pg_temp;'], /^ {4}raise exception 'migration 030 refused: [^']* is missing \(migrations 002, 017, 020, 021 and 028 must be applied first\)'$/);
  opensWith('the 030 down', DOWN_030, ['set local search_path = pg_catalog, pg_temp;', 'set local row_security = off;'],
    /^ {4}raise exception 'migration 030 rollback refused: migration 030 is not applied \([^']*\)'$/);
  for (const [label, file, checks] of [
    ['the 030 up', UP_030, ['to_regnamespace(', 'to_regprocedure(', 'pg_trigger', 'has_function_privilege(', 'pg_has_role(', 'already exists']],
    ['the 030 down', DOWN_030, ['to_regnamespace(', 'to_regprocedure(', 'pg_trigger', 'rollback refused: migration 029\'\'s edit routine is missing']],
  ]) {
    const text = `${codeOf(file).join('\n')}\n`;
    const locks = [...text.matchAll(/^ *lock table ([a-z_.]+) in access exclusive mode;$/gm)];
    assert.deepEqual(locks.map((m) => m[1]), WRITERS_ORDER, `${label}: exactly the seven, in the writers' order`);
    const end = text.indexOf('\n$$;\n', locks.at(-1).index);
    const change = Math.min(...[...text.matchAll(/^(?:alter|create|drop|insert|update|delete|grant|revoke|comment)\b/gm)].map((m) => m.index));
    assert.ok(end > 0 && end < change, `${label}: the lock block before the first change`);
    for (const check of checks) assert.ok(text.indexOf(check) > end, `${label}: ${check} comes after the locks`);
  }
  assert.ok(DOWN_030.indexOf('rollback refused: migration 030 is not applied (schema tmpos_invoice_edit') < DOWN_030.indexOf('\ndrop trigger '), 'the down\'s refusal precedes its first change');
  assert.deepEqual(changes(UP_030), [
    'create schema tmpos_invoice_edit;',
    'comment on schema tmpos_invoice_edit is',
    'revoke all on schema tmpos_invoice_edit from public, anon, authenticated, tmpos_app, tmpos_audit_writer;',
    'grant usage on schema tmpos_invoice_edit to tmpos_app;',
    `create function ${GUARD}`,
    `comment on function ${GUARD} is`,
    'create trigger trg_tenant_role_level_invoice_guard',
    'alter table tmpos_role.tenant_role_level enable always trigger trg_tenant_role_level_invoice_guard;',
    'create function tmpos_invoice_edit.m7b_invoice_draft_update_v2(',
    `comment on function ${UPDATE_V2} is`,
    `revoke all on function ${UPDATE_V2} from public, anon, authenticated, tmpos_app, tmpos_audit_writer;`,
    `revoke all on function ${GUARD} from public, anon, authenticated, tmpos_app, tmpos_audit_writer;`,
    `revoke execute on function ${UPDATE} from tmpos_app;`,
    `grant execute on function ${UPDATE_V2} to tmpos_app;`,
  ], 'the 030 up\'s changes, in order');
  assert.deepEqual(changes(DOWN_030), [
    'drop trigger trg_tenant_role_level_invoice_guard on tmpos_role.tenant_role_level;',
    `revoke execute on function ${UPDATE_V2} from tmpos_app;`,
    `drop function ${UPDATE_V2};`,
    `drop function ${GUARD};`,
    'drop schema tmpos_invoice_edit;',
    `grant execute on function ${UPDATE} to tmpos_app;`,
  ], 'the 030 down\'s changes, in order');
  assert.doesNotMatch(`${codeOf(UP_030).join('\n')}\n${codeOf(DOWN_030).join('\n')}`, /create or replace|\bexecute '|\bexecute format|cascade/i,
    'no replacement, no dynamic SQL, no CASCADE');
});

// ===========================================================================
// IDE-14: the rollback and the upgrade (last: it rolls 029 back and deletes this suite's drafts)
// ===========================================================================

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
/** A `comment on <target> is '...'` statement's text in a migration file, unescaped. */
const commentIn = (file, target) => {
  const m = new RegExp(`\\ncomment on ${target.replace(/\./g, '\\.')} is\\n  '((?:[^']|'')*)';\\n`).exec(file);
  assert.ok(m, `the file comments ${target}`);
  return m[1].replace(/''/g, '\'');
};
const COMMENTED = ['table tmpos_invoice_draft.invoice_draft', 'table tmpos_invoice_draft.invoice_draft_line', 'column public.audit_event.subject_invoice_draft_id'];
/** What 029 changes and what it must leave: the version CHECK, triggers, routines, comments, constraints and table ACLs. */
async function contract() {
  const [check] = await owner`select pg_catalog.pg_get_constraintdef(k.oid) as def, k.convalidated as valid from pg_catalog.pg_constraint k
    where k.conrelid = 'tmpos_invoice_draft.invoice_draft'::regclass and k.conname = 'invoice_draft_version_chk'`;
  const triggers = (await owner`select g.tgname::text as name from pg_catalog.pg_trigger g
    where g.tgrelid in ('tmpos_invoice_draft.invoice_draft'::regclass, 'tmpos_invoice_draft.invoice_draft_line'::regclass) and not g.tgisinternal`).map((r) => r.name);
  const routines = (await owner`select p.oid::regprocedure::text as fn, pg_catalog.md5(p.prosrc) as src, p.proacl::text as acl, p.provolatile::text as vol,
      p.prosecdef as definer, p.proconfig as config from pg_catalog.pg_proc p where p.pronamespace = 'tmpos_invoice_draft'::regnamespace order by 1`).map((r) => ({ ...r }));
  const [comments] = await owner`select pg_catalog.obj_description('tmpos_invoice_draft.invoice_draft'::regclass, 'pg_class') as header,
      pg_catalog.obj_description('tmpos_invoice_draft.invoice_draft_line'::regclass, 'pg_class') as lines,
      pg_catalog.col_description('public.audit_event'::regclass, (select a.attnum from pg_catalog.pg_attribute a
        where a.attrelid = 'public.audit_event'::regclass and a.attname = 'subject_invoice_draft_id')::integer) as subject`;
  const constraints = (await owner`select c.conname::text as name, pg_catalog.pg_get_constraintdef(c.oid) as def, c.convalidated as valid from pg_catalog.pg_constraint c
    where c.conrelid in ('tmpos_invoice_draft.invoice_draft'::regclass, 'tmpos_invoice_draft.invoice_draft_line'::regclass) and c.contype <> 'n'
      and c.conname <> 'invoice_draft_version_chk' order by 1`).map((r) => ({ ...r }));
  const acls = (await owner`select c.relname::text as rel, c.relacl::text as acl from pg_catalog.pg_class c
    where c.relnamespace = 'tmpos_invoice_draft'::regnamespace order by 1`).map((r) => ({ ...r }));
  return { check: { ...check }, triggers, routines, comments: { ...comments }, constraints, acls };
}
/** Every row a scope holds in the draft and role tables, exactly (to_jsonb keeps created_at to the microsecond). */
async function rowsOf(tenants) {
  const q = async (rel) => (await owner.unsafe(`select pg_catalog.to_jsonb(t)::text as row from ${rel} t where t.tenant_id = any($1::uuid[]) order by 1`, [tenants])).map((r) => r.row);
  return {
    drafts: await q('tmpos_invoice_draft.invoice_draft'), lines: await q('tmpos_invoice_draft.invoice_draft_line'),
    levels: await q('tmpos_role.tenant_role_level'), versions: await q('tmpos_role_edit.role_level_version'),
  };
}

test('IDE-14 (AC-18, N): with 032, 031 and 030 rolled back first (029\'s down cannot see them), 029\'s down is refused while not applied and while a draft is at version > 1 (everything unchanged), and when an edit it waited for commits; retained edit audit and outbox rows do not block it; clean, the rollback restores 028\'s contract exactly and the 001-032 runtime refuses that database; the 028 database with drafts and role configuration upgrades to 032 unchanged', async () => {
  const UP_028_COMMENTS = COMMENTED.map((t) => commentIn(UP_028, t));
  const UP_029_COMMENTS = COMMENTED.map((t) => commentIn(UP_029, t));
  // 029's down cannot see 030 (v2 is plpgsql: no catalog dependency records 029's routine, and 029's down would leave the guard
  // trigger and v2 behind), so every proof of it rolls 030 back first, in the same rolled-back transaction — 030's own rollback
  // never refuses on data — and 031 before 030 (M7B-INVOICES-P1-R3: 030's down refuses while 031's save is in its schema; 031's
  // rollback never refuses on data either) and 032 before 031 (M7B-INVOICES-P1-R4: 031's down refuses while 032's routines and
  // trigger are in 030's schema and on the level table; 032's rollback never refuses on data either).
  const down029 = async (tx) => { await tx.unsafe(DOWN_032).simple(); await tx.unsafe(DOWN_031).simple(); await tx.unsafe(DOWN_030).simple(); await tx.unsafe(DOWN_029).simple(); };
  assert.deepEqual(COMMENTED.map((t) => commentIn(DOWN_029, t)), UP_028_COMMENTS, 'the down restores 028\'s three comments, character for character');
  // 1. An edited draft of its own (version 2), whatever the cases before it left: refused, nothing changed.
  const e = await scene('down-edited');
  assert.deepEqual(await edit(e.kBoss, e.S, e.T, e.draft, 1, e.C2, [line('Edited', 1, 1)]), [done('applied', e.boss, e.T, e.S, 2)]);
  const edited = [e.draft];
  const with029 = await contract();
  assert.deepEqual(Object.values(with029.comments), UP_029_COMMENTS, 'applied: 029\'s comments');
  const rowsBefore = await rowsOf(TENANTS);
  const refused = await rolledBack(down029);
  assert.deepEqual(refused, { code: '55000', message: 'migration 029 rollback refused: an invoice draft has been edited (its version is above 1), and a rollback never resets a version or discards an edit' });
  assert.deepEqual(await contract(), with029, 'refused: the contract unchanged');
  assert.deepEqual(await rowsOf(TENANTS), rowsBefore, 'refused: every draft, line and role row unchanged');
  // 2. Retained edit evidence: an edit's audit record and its outbox event stay, and do not block the down once no edited
  //    draft is left (the drafts deleted here as an owner decision would delete them; all rolled back).
  const evidence = await rolledBack(async (tx) => {
    const [subject] = edited;
    await tx`insert into public.audit_event (request_id, actor_internal_user_id, scope_type, tenant_id, store_id, action_id, required_permission, decision,
        reason_code, human_readable_reason, result_status, source_of_truth, evaluated_by, evidence_level, subject_invoice_draft_id)
      values (${randomUUID()}, null, 'store', ${T_A}, ${S_A1}, 'store.invoice_draft.update', 'edit_invoice_drafts', 'allow', 'command_committed',
        'IDE synthetic record.', 'succeeded', 'command_transaction', 'm6_postgres_command_transaction@v1', 'durable_compliance_event', ${subject})`;
    await tx`insert into tmpos_internal.outbox_event (event_id, event_type, event_version, aggregate_type, aggregate_id, aggregate_version, correlation_id,
        payload, occurred_at, status, attempt, due_at)
      values (${randomUUID()}, 'invoice_draft.updated', 1, 'invoice_draft', ${subject}, 2, ${randomUUID()}, ${tx.json({ storeId: S_A1, customerId: C_A, lineCount: 1 })},
        pg_catalog.now(), 'pending', 0, pg_catalog.now())`;
    await tx`delete from tmpos_invoice_draft.invoice_draft_line where draft_id in (select draft_id from tmpos_invoice_draft.invoice_draft where version > 1)`;
    await tx`delete from tmpos_invoice_draft.invoice_draft where version > 1`;
    await down029(tx);
    const [kept] = await tx`select
        (select count(*) from public.audit_event where subject_invoice_draft_id = ${subject} and action_id = 'store.invoice_draft.update')::int as audit,
        (select count(*) from tmpos_internal.outbox_event where aggregate_id = ${subject} and event_type = 'invoice_draft.updated')::int as outbox,
        (select pg_catalog.pg_get_constraintdef(k.oid) from pg_catalog.pg_constraint k
          where k.conrelid = 'tmpos_invoice_draft.invoice_draft'::regclass and k.conname = 'invoice_draft_version_chk') as def`;
    const twice = await tx.unsafe(DOWN_029).simple().then(() => null, (err) => ({ code: err.code, message: String(err.message) }));
    return { ...kept, twice };
  });
  assert.equal(evidence.code, undefined, JSON.stringify(evidence));
  assert.deepEqual({ ...evidence.value, twice: evidence.value.twice?.code }, { audit: 1, outbox: 1, def: 'CHECK ((version = 1))', twice: '55000' },
    'the down completed over retained edit evidence and kept it; run again, it is refused (not applied)');
  assert.match(evidence.value.twice.message, /^migration 029 rollback refused: migration 029 is not applied \(/);
  // 3. Locks first: an edit running when the down starts commits first, and the guard then sees its version.
  await cleanDrafts();
  assert.equal((await owner`select count(*)::int as n from tmpos_invoice_draft.invoice_draft where version > 1`)[0].n, 0, 'no edited draft anywhere');
  const r = await scene('race');
  const editHold = holding(runtime, (tx) => edit(r.kBoss, r.S, r.T, r.draft, 1, r.C2, [line('Late edit', 1, 1)], { db: tx }));
  let down = null;
  try {
    await until(() => editHold.ready, 'the edit applied, uncommitted');
    down = running(owner, async (tx) => { await down029(tx); throw ROLLBACK; });
    await until(() => blockedBy(down.pid, editHold.pid), 'the down waits for the running edit before it reads anything');
    editHold.release('commit');
    assert.deepEqual(await editHold.done, { outcome: 'committed', value: [done('applied', r.boss, r.T, r.S, 2)] });
    const d = await down.done;
    assert.deepEqual({ outcome: d.outcome, code: d.code }, { outcome: 'failed', code: '55000' }, JSON.stringify(d));
    assert.match(d.message, /an invoice draft has been edited/, 'the guard saw the edit that committed while the down waited');
  } finally {
    editHold.release('rollback');
    await editHold.done;
    if (down !== null) await down.done;
  }
  await cleanDrafts();
  // 4. Clean: the executor's own path — 029's down and its ledger row — restores 028's contract exactly.
  assert.deepEqual(await preflightVerdict(), { runtimeLogin: [], migrationLedger: [] }, 'control: the 001-032 runtime is accepted');
  const { rolledBack: undone, restore } = await rollBackAbove(owner, MIG_DIR, '028');
  let restored = false;
  try {
    assert.deepEqual(undone, ['032', '031', '030', '029'], 'only 032, 031, 030 and 029 sit above 028, newest first');
    const at028 = await contract();
    assert.deepEqual(at028.check, { def: 'CHECK ((version = 1))', valid: true }, '028\'s CHECK, validated');
    assert.deepEqual(at028.triggers, [], 'no trigger');
    // M7B-INVOICES-P1-R3: on the 001-032 chain 028's create is its owner's alone (031 revoked tmpos_app's EXECUTE); 031's down
    // gave that EXECUTE back, so 028's create's ACL is the one difference from the routines captured there — exactly as 028
    // granted it.
    const me = (await owner`select current_user::text as me`)[0].me;
    const ACL_028 = `{${me}=X/${me},tmpos_app=X/${me}}`;
    const ACL_031 = `{${me}=X/${me}}`;
    const isCreate = (f) => f.fn.startsWith(`${CREATE_FN_028}(`);
    assert.equal(with029.routines.find(isCreate)?.acl, ACL_031, 'on the 001-032 chain 028\'s create is its owner\'s alone (031)');
    assert.deepEqual(at028.routines, with029.routines.filter((f) => !/m7b_invoice_draft_(update|immutable)\(/.test(f.fn)).map((f) => (isCreate(f) ? { ...f, acl: ACL_028 } : f)),
      'exactly 028\'s three routines, each byte for byte and with its ACL as before — 028\'s create\'s with tmpos_app\'s EXECUTE back (031\'s down)');
    assert.equal(at028.routines.length, 3);
    // Independently of any state captured with 029 applied: each surviving routine is exactly the body 028's file declares.
    const bodyOf = (file, name) => {
      const at = file.indexOf(`create function tmpos_invoice_draft.${name}(`);
      const start = file.indexOf('as $$', at) + 'as $$'.length;
      return file.slice(start, file.indexOf('$$;', start));
    };
    assert.deepEqual((await owner`select p.proname::text as name, p.prosrc as src from pg_catalog.pg_proc p
        where p.pronamespace = 'tmpos_invoice_draft'::regnamespace order by 1`).map((r) => ({ ...r })),
      ['m7b_invoice_draft_create', 'm7b_invoice_draft_get', 'm7b_invoice_draft_page'].map((name) => ({ name, src: bodyOf(UP_028, name) })),
      '028\'s three routines, each byte for byte the body 028\'s file declares');
    assert.deepEqual(Object.values(at028.comments), UP_028_COMMENTS, '028\'s comments, as 028\'s file wrote them');
    assert.deepEqual([at028.constraints, at028.acls], [with029.constraints, with029.acls], 'every other constraint and the table ACLs unchanged');
    assert.equal((await rolledBack((tx) => tx.unsafe(POSTCONDITION_028).simple())).code, undefined, '028\'s own postcondition holds again');
    assert.deepEqual(await preflightVerdict(), { runtimeLogin: ['role_privilege_missing', 'role_privilege_unexpected'], migrationLedger: ['migration_missing'] },
      'the 001-032 runtime refuses the 028 database: its grants (032\'s save, 030\'s v2 and schema missing; 028\'s create\'s EXECUTE, given back by 031\'s down, not approved) and its ledger');
    // 5. THE UPGRADE: a 028 database holding drafts (an owner's and a manager's) and role configuration (a stored level, the
    //    manager's save's lock anchors), upgraded by the trusted executor. The drafts are saved through 028's create: on this
    //    database it is the save the login executes (neither 031's nor 032's exists).
    const u = await scene('upgrade', { managerLevel: 'edit', createFn: CREATE_FN_028 });
    const managerDraft = await create(u.kManager, u.S, u.T, u.C2, [line('Saved at 028', 2, 250)], { fn: CREATE_FN_028 });
    await setLevel(u.T, 'technician', 'invoices', 'edit');
    const rows028 = await rowsOf([u.T]);
    assert.equal(rows028.drafts.length, 2);
    assert.ok(rows028.levels.length >= 2, 'role configuration and lock anchors exist at 028');
    const upgrade = await trustedApply();
    assert.deepEqual([upgrade.outcome, upgrade.applied], ['complete', ['029', '030', '031', '032']], JSON.stringify(upgrade).slice(0, 300));
    restored = true;
    assert.deepEqual(await rowsOf([u.T]), rows028, 'every draft, line, level and level version unchanged: ids, ownership, created_at, contents');
    const ledger = await owner`select version, checksum from public.schema_migrations order by version`;
    assert.deepEqual(ledger.map((x) => [x.version, x.checksum]), REQUIRED_MIGRATIONS.map((m) => [m.version, m.checksum]), 'the ledger is 001-032 again');
    assert.deepEqual(await preflightVerdict(), { runtimeLogin: [], migrationLedger: [] }, 'accepted again');
    assert.equal((await rolledBack((tx) => post029(tx))).code, undefined, 'the upgraded state satisfies 029\'s postcondition (030\'s one revoke undone in the proof)');
    assert.equal((await rolledBack(async (tx) => { await tx.unsafe(DOWN_032).simple(); await tx.unsafe(DOWN_031).simple(); await tx.unsafe(POSTCONDITION_030).simple(); })).code, undefined,
      'and 030\'s own (032 and 031 rolled back above it in the proof)');
    const reapplied = await contract();
    assert.deepEqual(reapplied, with029, 'the same contract as the fresh chain\'s');
    // The up leaves 028's routines, every other constraint and the table ACLs exactly as the 028 database held them (with the
    // down's statements, which touch none of them, this closes the chain: neither file alters an object 028 owns but the CHECK
    // and the comments) — but 028's create's ACL, which 031's up narrows to its owner's EXECUTE (M7B-INVOICES-P1-R3).
    assert.deepEqual([reapplied.routines.filter((f) => !/m7b_invoice_draft_(update|immutable)\(/.test(f.fn)), reapplied.constraints, reapplied.acls],
      [at028.routines.map((f) => (isCreate(f) ? { ...f, acl: ACL_031 } : f)), at028.constraints, at028.acls],
      're-applied over 028: 028\'s objects untouched but its create\'s ACL, which 031 narrows to the owner\'s EXECUTE');
    // The upgraded database edits at once: a draft saved at 028, by a technician the owner raised to Edit.
    const technician = await actor('upgrade-technician', [storeGrant(u.T, u.S, 'technician')]);
    assert.deepEqual(await edit(await mint(technician), u.S, u.T, managerDraft, 1, u.C1, LINES), [done('applied', technician, u.T, u.S, 2)]);
  } finally {
    if (!restored) await restore();
  }
});

// ===========================================================================
// IDE-21: 030's rollback and upgrade, over drafts above version 1 and stored overrides (after IDE-14: it rolls 030 back)
// ===========================================================================

/** 030's objects as the catalog holds them: the schema (ACL, comment), its functions (body, ACL, attributes, comment), the level table's triggers. */
async function contract030() {
  const schema = (await owner`select n.nspacl::text as acl, pg_catalog.obj_description(n.oid, 'pg_namespace') as comment
    from pg_catalog.pg_namespace n where n.nspname = 'tmpos_invoice_edit'`).map((r) => ({ ...r }));
  const functions = (await owner`select p.oid::regprocedure::text as fn, pg_catalog.md5(p.prosrc) as src, p.proacl::text as acl, p.provolatile::text as vol,
      p.prosecdef as definer, p.proconfig as config, pg_catalog.obj_description(p.oid, 'pg_proc') as comment
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace where n.nspname = 'tmpos_invoice_edit' order by 1`).map((r) => ({ ...r }));
  const triggers = (await owner`select g.tgname::text as name, g.tgfoid::regprocedure::text as fn, g.tgtype::int as type, g.tgenabled::text as enabled
    from pg_catalog.pg_trigger g where g.tgrelid = 'tmpos_role.tenant_role_level'::regclass and not g.tgisinternal order by 1`).map((r) => ({ ...r }));
  return { schema, functions, triggers };
}
/** 029's edit routine as the catalog holds it: body hash, comment, and its grants in aclexplode form (the owner's implicit one included). */
async function routine029() {
  const [r] = await owner`select pg_catalog.md5(p.prosrc) as src, pg_catalog.obj_description(p.oid, 'pg_proc') as comment, p.provolatile::text as vol, p.prosecdef as definer,
      p.proconfig as config from pg_catalog.pg_proc p where p.oid = ${UPDATE}::regprocedure`;
  const grants = (await owner`select g.grantee::regrole::text as grantee, g.privilege_type as priv, g.grantor::regrole::text as grantor, g.is_grantable as grantable
    from pg_catalog.pg_proc p, pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g where p.oid = ${UPDATE}::regprocedure order by 1, 2`).map((x) => ({ ...x }));
  return { ...r, grants };
}

test('IDE-21 (AC-12, N): 030 down, up and down again over drafts above version 1 and stored overrides, 032 and 031 rolled back before each 030 down — every row identical; the down restores 029\'s contract exactly (its routine\'s body, grants and comment, the level table\'s one trigger of 021, no schema) and the 001-032 runtime refuses what is left; a second down is refused; the up and the down each wait for a held edit and a held writer and finish, without deadlock; the up refuses when 029\'s EXECUTE is already gone; the upgrade 029 -> 032 changes no row', async () => {
  // Drafts above version 1 (edited by the manager and by the owner, so by both routines' callers) and stored overrides: the
  // manager's Invoices level, the technician's, and the sales staff's through the REAL setter (which makes a version row).
  const u = await scene('cycle', { managerLevel: 'edit' });
  const own = await tenantOwner(u.T, 'cycle');
  await setLevel(u.T, 'technician', 'invoices', 'edit');
  assert.equal((await setInvoices(own.key, 'sales_staff', 'edit', u.T, 0))[0].o_outcome, 'applied', 'a version row made by the real setter');
  assert.deepEqual(await edit(u.kManager, u.S, u.T, u.draft, 1, u.C2, [line('Cycle edit', 2, 5)]), [done('applied', u.manager, u.T, u.S, 2)]);
  assert.deepEqual(await edit(u.kManager, u.S, u.T, u.draft, 2, u.C1, LINES), [done('applied', u.manager, u.T, u.S, 3)]);
  const second = await create(u.kBoss, u.S, u.T, u.C1, [line('Second', 1, 1)]);
  assert.deepEqual(await edit(u.kBoss, u.S, u.T, second, 1, u.C2, [line('Second edit', 3, 7)]), [done('applied', u.boss, u.T, u.S, 2)]);
  assert.equal((await owner`select count(*)::int as n from tmpos_invoice_draft.invoice_draft where tenant_id = ${u.T} and version > 1`)[0].n, 2, 'two drafts above version 1');
  const rows0 = await rowsOf([u.T]);
  assert.ok(rows0.levels.length >= 3 && rows0.versions.length >= 1, 'stored overrides and a version row exist');
  const with030 = await contract030();
  // M7B-INVOICES-P1-R3 and -R4: 031's guarded save and 032's version-3 save and Customers guard function sit in 030's schema
  // beside 030's two functions; the level table carries 032's Customers guard trigger beside 030's and 021's.
  assert.deepEqual(with030.functions.map((f) => f.fn), [CUSTOMERS_GUARD, `${CREATE_FN_V2}(text,uuid,uuid,uuid,uuid,jsonb,bigint)`,
    `${CREATE_FN}(text,uuid,uuid,uuid,uuid,jsonb,bigint)`, `${UPDATE_FN}(text,uuid,uuid,uuid,bigint,uuid,jsonb,bigint)`, GUARD],
  '030\'s two functions, 031\'s save and 032\'s save and Customers guard');
  assert.equal(with030.triggers.length, 3);
  const body029 = createHash('md5').update(routineBody(UP_029, 'tmpos_invoice_draft', 'm7b_invoice_draft_update')).digest('hex');
  const comment029 = functionComment(UP_029, UPDATE);
  const before029 = await routine029();
  assert.equal(before029.src, body029, '030 left 029\'s routine body untouched');
  assert.equal(before029.comment, comment029);
  assert.deepEqual(before029.grants.filter((g) => g.grantee === 'tmpos_app'), [], '030 revoked tmpos_app\'s EXECUTE on it');
  const { rolledBack: undone, restore } = await rollBackAbove(owner, MIG_DIR, '029');
  let restored = false;
  try {
    // 1. THE DOWN: 029's contract, exactly. It never refused on the drafts above version 1. (032 and 031 first: their routines sit
    //    in 030's schema, which 030's down drops, and 032's trigger on the level table; neither down refuses on data either.)
    assert.deepEqual(undone, ['032', '031', '030'], 'only 032, 031 and 030 sit above 029, newest first');
    const at029 = await routine029();
    assert.equal(at029.src, body029, '029\'s routine: its body, md5 of prosrc, as 029\'s file declares it');
    assert.equal(at029.comment, comment029, 'its comment');
    assert.deepEqual([at029.vol, at029.definer, at029.config], [before029.vol, before029.definer, before029.config], 'its attributes');
    const me = (await owner`select current_user::text as me`)[0].me;
    assert.deepEqual(at029.grants, [
      { grantee: me, priv: 'EXECUTE', grantor: me, grantable: false },
      { grantee: 'tmpos_app', priv: 'EXECUTE', grantor: me, grantable: false },
    ].sort((a, b) => (a.grantee < b.grantee ? -1 : 1)), 'its grants: the owner\'s and tmpos_app\'s one non-grantable EXECUTE, nothing else (PUBLIC included)');
    assert.equal((await rolledBack((tx) => tx.unsafe(POSTCONDITION_029).simple())).code, undefined, '029\'s own postcondition holds again, unaided');
    assert.deepEqual(await contract030(), { schema: [], functions: [], triggers: [with030.triggers.find((t) => t.name === 'trg_tenant_role_level_version_advance')] },
      'no schema, no function, and the level table carries 021\'s one trigger');
    assert.equal((await owner`select count(*)::int as n from pg_catalog.pg_proc p where p.proname in ('m7b_invoice_draft_update_v2', 'm7b_invoice_level_guard', 'm7b_invoice_draft_create_v2', 'm7b_invoice_draft_create_v3', 'm7b_customers_level_guard')`)[0].n, 0, 'no 030, 031 or 032 function anywhere');
    assert.deepEqual(await rowsOf([u.T]), rows0, 'every draft, line, level and level version identical');
    assert.deepEqual(await preflightVerdict(), { runtimeLogin: ['role_privilege_missing', 'role_privilege_unexpected'], migrationLedger: ['migration_missing'] },
      'the 001-032 runtime refuses what is left: v2\'s and 032\'s save\'s EXECUTE and the schema\'s USAGE are missing, 029\'s and 028\'s create\'s EXECUTE are not approved, 030, 031 and 032 are not recorded');
    const refusedAgain = await rolledBack((tx) => tx.unsafe(DOWN_030).simple());
    assert.equal(refusedAgain.code, '55000', 'a second down is refused');
    assert.match(refusedAgain.message, /^migration 030 rollback refused: migration 030 is not applied \(/);
    // The routine tmpos_app can call is 029's again (with its window); v2 is gone.
    assert.equal((await errorOf(edit(u.kManager, u.S, u.T, u.draft, 3, u.C2, [line('Gone', 1, 1)])))?.code, '3F000', 'v2 no longer exists');
    assert.deepEqual(await edit(u.kManager, u.S, u.T, u.draft, 3, u.C2, [line('Back at 029', 1, 1)], { fn: UPDATE_FN_029 }), [done('applied', u.manager, u.T, u.S, 4)], '029\'s routine is the one the login executes');

    // 2. THE UP waits for a held edit and a held writer and finishes — no deadlock (rolled back each time; 029 stays). The scene's
    //    draft is saved through 028's create: on this database it is the save the login executes again (031's down).
    const w = await guardScene('k21up', { stored: 'edit', createFn: CREATE_FN_028 });
    const waitsOnASeven = async (pid, holder, what) => {
      const wait = await lockWaitOf(pid, holder);
      assert.equal(wait.ungranted.length, 1, `${what}: one ungranted lock (${JSON.stringify(wait.locks)})`);
      assert.deepEqual([wait.ungranted[0].locktype, wait.ungranted[0].mode], ['relation', 'AccessExclusiveLock'], `${what}: an ACCESS EXCLUSIVE relation lock`);
      const rel = wait.ungranted[0].rel.includes('.') ? wait.ungranted[0].rel : `public.${wait.ungranted[0].rel}`;
      assert.ok(WRITERS_ORDER.includes(rel), `${what}: on one of the seven (${rel})`);
    };
    for (const [what, holder] of [
      ['a held edit (029\'s)', () => holdingEdit(w, { fn: UPDATE_FN_029 })],
      ['a held owner UPDATE of a level', () => holding(owner, (tx) => tx`update tmpos_role.tenant_role_level set level = 'full'
        where tenant_id = ${w.T} and role_id = 'manager' and domain = 'invoices'`)],
      ['a held REAL setter', () => holding(runtime, (tx) => setInvoices(w.own.key, 'manager', 'full', w.T, 0, tx))],
    ]) {
      const held = holder();
      let up = null;
      try {
        await until(() => held.ready, `the up: ${what} reached`);
        up = holding(owner, (tx) => tx.unsafe(UP_030).simple());
        await until(() => blockedBy(up.pid, held.pid), `the up waits for ${what}`);
        await waitsOnASeven(up.pid, held.pid, `the up behind ${what}`);
        assert.equal(up.ready, false, `the up behind ${what}: nothing ran yet`);
        held.release('rollback');
        assert.equal((await held.done).outcome, 'rolled back');
        await until(() => up.ready, `the up ran once ${what} ended`);
        up.release('rollback');
        assert.equal((await up.done).outcome, 'rolled back', `the up behind ${what}: finished and rolled back`);
      } finally {
        held.release('rollback');
        await held.done;
        if (up !== null) { up.release('rollback'); await up.done; }
      }
    }
    assert.equal((await owner`select pg_catalog.to_regnamespace('tmpos_invoice_edit') is null as gone`)[0].gone, true, 'every proof rolled back: still no schema');
    // The up refuses when its precondition fails: 029's EXECUTE already revoked from tmpos_app.
    const precondition = await rolledBack(async (tx) => { await tx.unsafe(`revoke execute on function ${UPDATE} from tmpos_app`); await tx.unsafe(UP_030).simple(); });
    assert.equal(precondition.code, '55000', JSON.stringify(precondition));
    assert.match(precondition.message, /^migration 030 refused: the applying principal does not own 029's edit routine, or tmpos_app's EXECUTE on it is not the one non-grantable entry 029 issued$/);

    // 3. THE UPGRADE 029 -> 032 by the trusted executor: no row changes, the same objects the first apply left.
    const rows1 = await rowsOf([u.T]);
    const upgrade = await trustedApply();
    assert.deepEqual([upgrade.outcome, upgrade.applied], ['complete', ['030', '031', '032']], JSON.stringify(upgrade).slice(0, 300));
    restored = true;
    assert.deepEqual(await rowsOf([u.T]), rows1, 'every draft, line, level and level version identical across the upgrade');
    assert.deepEqual(await contract030(), with030, 'the same schema, functions (bodies, grants, attributes, comments) and triggers as the first apply left');
    assert.deepEqual((await routine029()).grants.filter((g) => g.grantee === 'tmpos_app'), [], '029\'s EXECUTE revoked again');
    const ledger = await owner`select version, checksum from public.schema_migrations order by version`;
    assert.deepEqual(ledger.map((x) => [x.version, x.checksum]), REQUIRED_MIGRATIONS.map((m) => [m.version, m.checksum]), 'the ledger is 001-032 again');
    assert.deepEqual(await preflightVerdict(), { runtimeLogin: [], migrationLedger: [] }, 'accepted again');
    assert.equal((await rolledBack(async (tx) => { await tx.unsafe(DOWN_032).simple(); await tx.unsafe(DOWN_031).simple(); await tx.unsafe(POSTCONDITION_030).simple(); })).code, undefined,
      '030\'s postcondition holds again (032 and 031 rolled back above it in the proof)');
    assert.deepEqual(await edit(u.kManager, u.S, u.T, u.draft, 4, u.C1, [line('Back at 030', 1, 1)]), [done('applied', u.manager, u.T, u.S, 5)], 'and the guarded edit works at once');

    // 4. THE DOWN waits for a held edit (v2), a held writer and a queued writer behind a held edit, and finishes — no deadlock
    //    (rolled back each time: 030 stays applied). It is 032's down, then 031's, then 030's in one transaction, the supported
    //    order (030's alone refuses while 031's or 032's routine is in its schema, and 031's while 032's is); 032's and 031's take
    //    the same seven locks first, in the same order.
    const down032031030 = async (tx) => { await tx.unsafe(DOWN_032).simple(); await tx.unsafe(DOWN_031).simple(); await tx.unsafe(DOWN_030).simple(); };
    const d = await guardScene('k21down', { stored: 'edit' });
    for (const [what, holder] of [
      ['a held edit (v2)', () => holdingEdit(d)],
      ['a held owner UPDATE of a level', () => holding(owner, (tx) => tx`update tmpos_role.tenant_role_level set level = 'full'
        where tenant_id = ${d.T} and role_id = 'manager' and domain = 'invoices'`)],
      ['a held REAL setter', () => holding(runtime, (tx) => setInvoices(d.own.key, 'manager', 'full', d.T, 0, tx))],
    ]) {
      const held = holder();
      let down = null;
      try {
        await until(() => held.ready, `the down: ${what} reached`);
        down = holding(owner, down032031030);
        await until(() => blockedBy(down.pid, held.pid), `the down waits for ${what}`);
        await waitsOnASeven(down.pid, held.pid, `the down behind ${what}`);
        held.release('rollback');
        assert.equal((await held.done).outcome, 'rolled back');
        await until(() => down.ready, `the down ran once ${what} ended`);
        down.release('rollback');
        assert.equal((await down.done).outcome, 'rolled back', `the down behind ${what}: finished and rolled back`);
      } finally {
        held.release('rollback');
        await held.done;
        if (down !== null) { down.release('rollback'); await down.done; }
      }
    }
    {
      // A writer queued on the key behind a held edit, and the down behind both: the edit ends, the writer takes the key and
      // commits, the down then runs — the key never stands between the down and the tables it locks.
      const heldEdit = holdingEdit(d, { version: 1, customer: d.C2, lines: [line('Convoy edit', 1, 1)] });
      let writer = null;
      let down = null;
      try {
        await until(() => heldEdit.ready, 'convoy: the edit applied, uncommitted');
        writer = running(owner, (tx) => tx`update tmpos_role.tenant_role_level set level = 'full', updated_at = now()
          where tenant_id = ${d.T} and role_id = 'manager' and domain = 'invoices'`);
        await until(() => blockedBy(writer.pid, heldEdit.pid), 'convoy: the writer waits on the key behind the edit');
        down = holding(owner, down032031030);
        await until(() => blockedBy(down.pid, heldEdit.pid), 'convoy: the down waits behind the edit');
        heldEdit.release('commit');
        assert.equal((await heldEdit.done).outcome, 'committed');
        assert.equal((await writer.done).outcome, 'committed', 'convoy: the writer committed');
        await until(() => down.ready, 'convoy: the down ran once both ended');
        down.release('rollback');
        assert.equal((await down.done).outcome, 'rolled back', 'convoy: finished and rolled back');
      } finally {
        heldEdit.release('rollback');
        await heldEdit.done;
        if (writer !== null) await writer.done;
        if (down !== null) { down.release('rollback'); await down.done; }
      }
    }
    assert.deepEqual(await contract030(), with030, 'every down was rolled back: 030 as it was');
    assert.deepEqual(await preflightVerdict(), { runtimeLogin: [], migrationLedger: [] }, 'and the 001-032 runtime accepts it');
  } finally {
    if (!restored) await restore();
  }
});

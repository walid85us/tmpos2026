// Phase 4.0 M7B-INVOICES-P1-R3 and -R4 — the Invoices AND Customers authority of an invoice-draft SAVE held through both newly
// sealed outcomes ('customer_not_found' and 'applied'), at ROUTINE level against REAL PostgreSQL. The save under test is
// migration 032's tmpos_invoice_edit.m7b_invoice_draft_create_v3 (M7B-INVOICES-P1-R4, DA-211): migration 031's create_v2 with
// exactly two changes — step 10b, after migration 030's advisory key (530030, hashtext(tenant || '/' || role)) SHARED and the
// clock, decides the Invoices level AND the Customers level again by plain SELECTs; steps 11-12 (the Customers NULL anchor, its
// FOR SHARE and the locked re-decision) are gone — beside 032's trigger trg_tenant_role_level_customers_guard, which makes every
// writer of a Customers level take the same key EXCLUSIVE (AFTER ROW, ENABLE ALWAYS, firing before 030's Invoices guard). 031's
// create_v2 (028's routine with three changes: step 10's customer check answered at 10c after the guard; the 10b guard — the key,
// the clock, the Invoices re-read and decision; no Invoices anchor in steps 11-12) stays installed, closed to the runtime role
// since 032. Every save is bound as the production adapter binds it (server/persistence/postgresInvoiceDrafts.ts:
// the lines serialized once as jsonb text, every bigint as decimal text), as the runtime's own non-owner login (tmpos_icr_probe,
// holding tmpos_app and tmpos_audit_writer) unless a case says it runs as the routine's OWNER to read its own uncommitted rows.
// The narrowing writer is a REAL setter (026's tmpos_role_invoice.m7a_invoice_role_level_set for Invoices, 021's
// tmpos_role_edit.m7a_role_level_set_v2 for Customers, as the runtime login) run by a THIRD operator — a store owner holding
// exactly one tenant grant, never the actor whose save is under test, so no shared account lock (016's hold takes the account
// FOR UPDATE) can serialize a race — or, where a case says so, an owner's direct write. The routine every create() call runs is
// CREATE_FN; CREATE_V3 repeats its name for the catalog checks.
//
// Case labels: R = red on the entry source — none here (DA-210's and DA-211's red reproductions are the HTTP suite's, tests/db/
// invoiceDraftCreateAuthorityHttp.integration.test.mjs: ICA-01/02 and CCA-01a/b); N = the new contract (of 031 for the ICA
// cases, of 032 for the CCA cases and wherever an ICA case says "032"); G = a guard that holds before and after. A case that
// mixes them says which block is which. ICA titles carry R3's acceptance criteria, CCA titles R4's.
//
// WHAT IS PROVEN.
//   ICA-05 (AC-06, N/G) NO CONFIGURATION ROW. For each editable role (manager, technician, sales_staff), read inside the save's
//          own transaction (run as the routine's owner, then rolled back): with no stored row — and, for the technician, whose
//          catalog default View refuses, with only the owner's stored Create — 'tenant_mismatch', 'customer_not_found' and a
//          refusal (the default View, a stored narrowing to View) write no role row and no version row [G]; the applied path
//          writes NO role row at all [N: 028 wrote an Invoices anchor, 031 a Customers anchor, 032 neither]; a save that reached
//          10b holds exactly the role's key SHARED and nothing else of any advisory class, one refused before it holds none [N].
//          A store owner's 'tenant_mismatch', 'customer_not_found' and applied save take NO advisory lock and write no role row
//          [G]; in a separate subtest, a manager's save at the same point holds exactly the key SHARED (the positive control).
//   ICA-06 (AC-07, N; CCA-08 [G]) A FRESH INVOICES DECISION AFTER EVERY WAIT, on v3. (a) 026's REAL setter's narrowing of the
//          manager's Invoices level to View held uncommitted (absent row: its first insertion; stored Full: an update) holds the
//          key EXCLUSIVE; a save with a missing and with an existing customer is seen waiting on exactly that key (one ungranted
//          advisory ShareLock, classid 530030, objid the key, objsubid 2, behind the writer's pid); the writer commits ->
//          ('refused', NULLs), nothing of the save written (the role and version rows exactly the setter's). (b) the same
//          barrier, the writer rolled back -> 'customer_not_found' and 'applied', NO role row (032). (c) POST-WAIT EXPIRY, NOT A
//          TIMEOUT: two managers' 8 s sessions; an owner's uncommitted FIRST non-NULL INSERT of the manager's Invoices level
//          (Create: it would admit the save) holds the key; each save — a missing and an existing customer — runs on an OWNER
//          connection whose lock_timeout and statement_timeout are 0 (read inside the transaction), is seen waiting on the key
//          while its session is live on the DATABASE clock, keeps waiting until the database clock has passed the session's
//          expiry, and is released only then by the writer's ROLLBACK; each answers ('refused', NULLs) and, inside its own
//          transaction, has made no row: the missing customer is not 'customer_not_found', so the clock read after the key
//          precedes 10c (the existing customer cannot tell 10b's clock from step 13's since 032: neither writes anything).
//   ICA-07 (AC-08, N; CCA-08 [G] for (1), (2), (6)) ORDERINGS WITHOUT A NEW CYCLE — each a separate subtest; every participant
//          commits or answers, none ends in 40P01, every wait claimed is first seen in pg_locks: (1) a save holding the key
//          ('applied' and 'customer_not_found') -> the Invoices setter waits on it (an advisory ExclusiveLock), both finish; (2)
//          the Invoices setter holding the key -> the save waits (an advisory ShareLock), both finish, the save on the committed
//          level; (3) [032, = CCA-07 (3) for a stored override] 021's REAL Customers setter holding its role row FOR UPDATE waits
//          on the save's key (and an Invoices setter behind it) while the save, paused on the customer behind an owner's row
//          lock, completes WITHOUT waiting for that row: all three finish; (4) a save waiting on the customer behind 024's REAL
//          customer edit (FOR UPDATE; the save holds the key) while an Invoices setter waits on the save's key: all three
//          finish; (5) a save and an edit v2 of one role, in both orders, hold the key SHARED at once and neither waits; (6) a
//          later save queued on the key behind a setter that waits behind an earlier save: all finish, the later save refused
//          on the committed narrowing; (7) an owner holding the role's Invoices row FOR UPDATE (no key) does not block a save.
//   CCA-04 (AC-04, N) DEFAULT-ONLY AND FIXED-OWNER POLICY WITHOUT CONFIGURATION ROWS: with NO stored row, the manager's and the
//          sales staff's 'applied', 'customer_not_found' and 'tenant_mismatch' and the technician's refusal (default Invoices
//          View), and the store owner's three answers, write no role row and no version row (inside the save's own
//          transaction); a save past 10b holds exactly the role's key SHARED, the store owner no advisory lock; the sales staff
//          with a stored Customers 'none' is refused before the key, and with a Customers 'none' an owner commits while its save
//          waits at the key (the save having passed step 8 on the default) is refused AT THE GUARD DECISION, writing nothing.
//   CCA-05 (AC-05, N) A FRESH CUSTOMERS DECISION AFTER A FORCED GUARD WAIT: ICA-06's three proofs with 021's REAL Customers
//          setter — (a) its uncommitted narrowing to None (a stored Full: an update; no row: the FIRST override over the
//          default) holds the key EXCLUSIVE, a save (missing and existing customer) waits on exactly that key, the setter
//          commits -> ('refused', NULLs), nothing written; (b) rolled back -> 'customer_not_found' / 'applied', no role row; (c)
//          8 s sessions waiting at the key past their expiry behind the setter's uncommitted first override (View), released by
//          its ROLLBACK -> refused by the clock read after the key (the Customers trigger's wait and the clock; the fresh
//          Customers READ is (a)'s proof: (c) refuses before either level is read).
//   CCA-06 (AC-06, N) WRITER PARTICIPATION, each transition seen as the writing backend's EXCLUSIVE key in pg_locks: 021's real
//          setter's first override, update and reset to the default word; owner DML — a non-NULL Customers INSERT, UPDATEs
//          non-NULL->non-NULL, NULL->level and level->NULL, a non-NULL DELETE, a tenant move, a role move, domain moves
//          customers->invoices and invoices->customers, a pair-and-domain move (both keys), the three cross-domain moves again
//          with 030's Invoices guard disabled inside the writing transaction (032's trigger alone) — and the same UPDATE with
//          session_replication_role = replica; NO key for a NULL INSERT or DELETE (anchors); prohibited transitions (domain
//          'other', role 'store_owner': 23514; an unknown tenant: 23503) refuse within a 2 s lock_timeout while every key they
//          could name is held SHARED elsewhere (so they never wait for a key); TRUNCATE: no runtime role holds it, and the
//          owner's waits for an in-flight save's ACCESS SHARE on the level table (recorded).
//   CCA-07 (AC-07, N) ORDER: the catalog's non-internal triggers on the level table in name order (customers guard, invoice
//          guard, version advance; tgtype 29/29/17; ENABLE ALWAYS); a key-moving Customers UPDATE (a pair move, and pair-and-
//          domain moves into and out of Invoices, with both guards and with 030's disabled in the mover: 032's alone) whose OLD
//          key is the higher one, with the higher key held SHARED elsewhere, holds the LOWER key granted and waits for the
//          higher; orderings with 021's real Customers setter, without 40P01,
//          every wait first seen: (1) a save holds the key -> the setter waits; (2) the setter holds it -> the save waits and
//          the committed level decides; (3) the setter (first override) holds its row FOR UPDATE and waits on the save's key
//          while the save completes; (4) a save waiting on its customer behind 024's real edit while the setter waits on the
//          save's key; (5) a save and an edit v2 of one role hold the key SHARED together and the setter waits for both.
//   CCA-08 (AC-08, G) INVOICES PROTECTION INTACT ON v3: carried by ICA-06 (026's Invoices setter's uncommitted narrowing holds the
//          key, the v3 save waits on it and is refused once it commits) and ICA-07 (1), (2) and (6) (the Invoices setter waits
//          behind a v3 save's key; a v3 save waits behind the setter and decides on the committed level; a later save queued
//          behind a waiting setter is refused) — those titles carry the tag.
//   NC-ii  (AC-06, negative control) with trg_tenant_role_level_customers_guard DISABLED inside the very owner transaction that
//          writes a Customers narrowing (and ENABLE ALWAYS again before its COMMIT), the narrowing COMMITS while a save holds
//          the key SHARED, its sealed answer still open — the "writer waits for the save" assertion fails without the trigger;
//          with it enabled the same write is seen waiting on the key (cancelled).
//   NC-iii (AC-07, negative control) 031's create_v2, run by the routine's OWNER under 032's trigger, holding the key SHARED and
//          then needing its Customers row while 021's real setter holds that row FOR UPDATE and waits for the key: PostgreSQL
//          aborts one side with 40P01 (bounded: lock_timeout 10 s on both; the server's deadlock_timeout read and asserted below
//          it) — why v2 is closed to the runtime; the same arrangement with v3 completes and the setter follows.
//   ICA-11 + CCA-11 (AC-14 / AC-11, N) PRIVILEGES, DEPENDENCIES AND TEXT: the runtime login executes create_v3; create_v2 and
//          028's routine are refused (42501); create_v3's and create_v2's attributes and comments; the complete ACLs (v3: the
//          owner's and tmpos_app's EXECUTE, owner-granted, non-grantable; v2, 028's and 032's trigger function: the owner's
//          alone); the schema's five functions; 032's postcondition holds, 031's refuses until 032 is rolled back above it; the
//          real preflight accepts the 001-033 database; 030's rollback on it (033 rolled back first, in the same transaction: its anchor
//          refuses every older down) is REFUSED with 2BP01 and changes nothing; STATIC:
//          create_v2 is 028's with exactly three changes, create_v3 is create_v2 with exactly the two design changes (the method
//          is stated in the case), 032's trigger function is 030's with the domain 'customers', and v3's key precedes both
//          level reads which precede 'customer_not_found', with no row lock on a level or version row and no role-row write.
//   ICA-10 + CCA-12 (AC-13 / AC-12, N) ROLLBACK WITH DATA PRESERVED, over drafts at version 1 and edited above it, stored
//          overrides of both domains, absent defaults, both real setters' version rows, an audit record, an outbox event and
//          two idempotency records (a sealed completion and an open lease): with 032 applied, 031's down REFUSED (55000) and
//          030's REFUSED (2BP01), nothing changed (033, M7B-INVOICES-DISCARD-P1, rolled back first in each transaction: its anchor
//          refuses every older down); 032's down (after 033's) waits for an in-flight save and setter; 032's and 033's downs by the
//          executor's down path -> the exact 031-era surface, every row identical, the 001-033 preflight refusing, the login on
//          create_v2 again; a second 032 down refused; 032's up refused when applied and when 030's trigger is disabled, an
//          extra trigger sits on the level table or create_v2's ACL is widened; the up waits for an in-flight save and setter;
//          at that 031-era state 031's own down waits for an in-flight create_v2 save, an Invoices setter and an Invoices setter
//          queued on the key behind a save (R3's proof); THE UPGRADE 031 -> 033 by the executor changes no row; then 031's own
//          cycle (033, 032 and 031 down by the executor; the
//          exact 030-era surface; the up's refusals and waits; the upgrade 030 -> 033; the down again behind in-flight work);
//          finally 033 -> 032 -> 031 -> 030 down and 030, 031, 032, 033 re-applied complete by the executor, every row identical.
//
// DISPOSABLE ONLY. The harness's resolved target: a supplied CI service when one is bound, otherwise a cluster this file creates
// and destroys; assertDisposableTestDsn refuses anything else before a statement runs. Every fixture is synthetic and randomly
// suffixed; every id and key is made at run time. It rolls 033, 032, 031 and 030 back and restores them (ICA-10 + CCA-12) and runs
// 030's rollback to its refusal (ICA-11), so on a shared service it runs after every step that rolls 028 back. It leaves 031, 032 and
// 033 applied and recorded (its teardown asserts both, and re-applies by the executor whatever a failed rollback case left
// down), the issuer key row it found, every trigger on the level table enabled ALWAYS, and NO draft, line, audit subject, role
// row, session, mint-ledger row, synthetic audit, outbox or idempotency row, or login of its own.
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
const UP_032 = readFileSync(`${MIG_DIR}/032_m7b_invoice_create_customers_authority.up.sql`, 'utf8');
const DOWN_032 = readFileSync(`${MIG_DIR}/032_m7b_invoice_create_customers_authority.down.sql`, 'utf8');
/** M7B-INVOICES-DISCARD-P1: 033 (the draft discard, in its own schema tmpos_invoice_discard) sits above 032: it rolls back first and is applied with it. */
const DOWN_033 = readFileSync(`${MIG_DIR}/033_m7b_invoice_draft_discard.down.sql`, 'utf8');
/** Each up file's last DO block, its postcondition, run again on its own. */
const POSTCONDITION_030 = UP_030.slice(UP_030.lastIndexOf('do $$'));
const POSTCONDITION_031 = UP_031.slice(UP_031.lastIndexOf('do $$'));
const POSTCONDITION_032 = UP_032.slice(UP_032.lastIndexOf('do $$'));
/** The save routine every create() call runs, by name (032's); CREATE_V3 below repeats it, as the catalog names it, for the catalog checks. */
const CREATE_FN = 'tmpos_invoice_edit.m7b_invoice_draft_create_v3';
/** 031's save routine by name (create() calls it with { fn }): closed to the login by 032, the contract 032's rollback restores. */
const CREATE_FN_V2 = 'tmpos_invoice_edit.m7b_invoice_draft_create_v2';
/** 028's save routine by name (create() calls it with { fn }): the contract 031's rollback restores. */
const CREATE_FN_028 = 'tmpos_invoice_draft.m7b_invoice_draft_create';
const SAVE_ARGS = '(text, uuid, uuid, uuid, uuid, jsonb, bigint)';
/** The three save routines as the catalog names them (never derived from CREATE_FN: the catalog checks name them exactly). */
const CREATE_V3 = `tmpos_invoice_edit.m7b_invoice_draft_create_v3${SAVE_ARGS}`;
const CREATE_V2 = `tmpos_invoice_edit.m7b_invoice_draft_create_v2${SAVE_ARGS}`;
const CREATE_028 = `tmpos_invoice_draft.m7b_invoice_draft_create${SAVE_ARGS}`;
const UPDATE_FN = 'tmpos_invoice_edit.m7b_invoice_draft_update_v2';
const UPDATE_V2 = `${UPDATE_FN}(text, uuid, uuid, uuid, bigint, uuid, jsonb, bigint)`;
const GUARD = 'tmpos_invoice_edit.m7b_invoice_level_guard()';
/** 032's trigger function and trigger: every writer of a Customers level takes the key EXCLUSIVE. */
const CUSTOMERS_GUARD = 'tmpos_invoice_edit.m7b_customers_level_guard()';
const CUSTOMERS_TRIGGER = 'trg_tenant_role_level_customers_guard';
/** The catalog's text of each signature (regprocedure output: no space after a comma). */
const CATALOG = (signature) => signature.replace(/, /g, ',');
/** The class of the advisory key every Invoices- and (032) Customers-level writer, the edit and the save take: pg_locks.classid, objsubid 2. */
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

/** Everything this suite wrote that a later rollback of 032, 031, 030, 029 or 028 would refuse over: drafts, lines, role rows, subjects. */
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
    // A failed ICA-10 + CCA-12 may have left 033, 032, 031 and 030 rolled back: the executor applies them again.
    await step(async () => {
      if (!(await owner`select exists (select 1 from public.schema_migrations where version = '033') as applied`)[0].applied) {
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
          pg_catalog.to_regprocedure(${CREATE_V3}) is not null as routine_032,
          exists (select 1 from public.schema_migrations where version = '032') as ledger_032,
          pg_catalog.to_regnamespace('tmpos_invoice_discard') is not null as schema_033,
          exists (select 1 from public.schema_migrations where version = '033') as ledger_033,
          (select pg_catalog.string_agg(g.tgname::text || ':' || g.tgenabled::text, ',' order by g.tgname::text collate "C") from pg_catalog.pg_trigger g
            where g.tgrelid = 'tmpos_role.tenant_role_level'::regclass and not g.tgisinternal) as triggers,
          (select count(*) from tmpos_invoice_draft.invoice_draft where tenant_id = any(${TENANTS}::uuid[]))::int as drafts,
          (select count(*) from public.audit_event where subject_invoice_draft_id is not null and tenant_id = any(${TENANTS}::uuid[]))::int as subjects,
          (select count(*) from tmpos_role.tenant_role_level where tenant_id = any(${TENANTS}::uuid[]))::int as anchors,
          (select count(*) from tmpos_session.session where auth_provider_uid = any(${UIDS}::text[]))::int as sessions,
          (select count(*) from public.audit_event where request_id = any(${SYNTHETIC.audits}::text[]))::int as audits,
          (select count(*) from tmpos_internal.outbox_event where event_id = any(${SYNTHETIC.events}::uuid[]))::int as events,
          (select count(*) from tmpos_internal.idempotency_record where scope = any(${SYNTHETIC.scopes}::text[]))::int as records,
          exists (select 1 from pg_catalog.pg_roles where rolname = ${RUNTIME_LOGIN}) as login`;
      assert.deepEqual({ ...state }, { routine_031: true, ledger_031: true, routine_032: true, ledger_032: true, schema_033: true, ledger_033: true,
        triggers: `${CUSTOMERS_TRIGGER}:A,trg_tenant_role_level_invoice_guard:A,trg_tenant_role_level_version_advance:A`,
        drafts: 0, subjects: 0, anchors: 0, sessions: 0, audits: 0, events: 0, records: 0, login: false },
        'left as found: 031, 032 and 033 applied and recorded, the level table\'s three triggers ENABLE ALWAYS, nothing of this suite\'s retained');
    });
  } finally {
    await step(() => owner.end({ timeout: 5 }));
    if (cluster) cluster.stop();
  }
  if (failures.length > 0) throw new AggregateError(failures, 'ICA routine teardown: a cleanup step or postcondition failed');
});

// ---------------------------------------------------------------------------
// setup: every migration in the directory (001-033), a real non-owner runtime login, the issuer key installed by the owner
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

test('ICA-05 (AC-06, N/G): for each editable role, tenant_mismatch, customer_not_found and a refusal write no role row and no version row; the applied path writes no role row at all (032: not even the Customers NULL anchor); a save that reached the guard holds exactly the role\'s key SHARED; a store owner\'s saves take no key and write no row [G], beside a manager\'s positive control [N]', async (t) => {
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
    await t.test(`${role}: the applied path writes no role row and no version row — no Invoices anchor (031), no Customers anchor (032) [N]`, async (st) => {
      const f = await scene(`a05-${role}`);
      const { who, key } = await member(f, `a05-${role}`, role);
      if (role === 'technician') await setLevel(f.T, role, 'invoices', 'create');
      const base = strip(await invoicesRowsOf(f.T));
      assert.deepEqual(base, role === 'technician' ? { roles: [{ role_id: role, domain: 'invoices', level: 'create' }], versions: [] } : NO_ROWS,
        `${role}: ${role === 'technician' ? 'the owner\'s stored Create only' : 'absent rows'}`);
      const seen = await saveInOwnTransaction(f, key, f.C1, `${role}, applied`);
      evidence(st, { case: `ICA-05 ${role} applied`, answer: seen.rows, levelsInsideItsTransaction: seen.levels, advisory: seen.advisory });
      assert.deepEqual(seen.rows, [saved(who, f.T, f.S)], `${role}: applied`);
      assert.deepEqual(seen.levels, base, `${role}: the save wrote no role row (no Customers anchor, no Invoices row) and no version row`);
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
      ['applied', f.C1, saved(f.manager, f.T, f.S), NO_ROWS],
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
// CCA-04: default-only and fixed-owner policy without configuration rows (032)
// ===========================================================================

test('CCA-04 (AC-04, N): with no stored row, the manager\'s and the sales staff\'s applied, customer_not_found and tenant_mismatch, the technician\'s refusal and the store owner\'s three answers write no role row and no version row; past 10b exactly the role\'s key SHARED, the store owner no advisory lock; a sales staff\'s Customers None refuses before the key when stored, and AT THE GUARD DECISION when it commits while the save waits at the key', async (t) => {
  const f = await scene('d04');
  const staff = await member(f, 'd04', 'sales_staff');
  const tech = await member(f, 'd04', 'technician');
  /** One save of `key` inside its own (owner) transaction: its answer, the tenant's rows inside it, its advisory locks. */
  async function judged(st, label, key, customer, expectedTenant, expected, advisory) {
    const seen = await saveInOwnTransaction(f, key, customer, label, expectedTenant);
    evidence(st, { case: `CCA-04 ${label}`, answer: seen.rows, levelsInsideItsTransaction: seen.levels, advisory: seen.advisory });
    assert.deepEqual(seen.rows, [expected], `${label}: the answer, on the catalog defaults`);
    assert.deepEqual(seen.levels, NO_ROWS, `${label}: no role row and no version row — not even inside its own transaction`);
    assert.deepEqual(seen.advisory, advisory, `${label}: ${advisory.length === 0 ? 'no advisory lock of any class' : 'exactly the role\'s key, SHARED'}`);
  }
  for (const [who, role, key] of [[f.manager, 'manager', f.kManager], [staff.who, 'sales_staff', staff.key]]) {
    await t.test(`${role}, default-only (no stored row of any role): applied, customer_not_found and tenant_mismatch write no configuration row`, async (st) => {
      assert.deepEqual(strip(await invoicesRowsOf(f.T)), NO_ROWS, 'no stored row: the catalog defaults govern');
      const K = [await guardLock(f.T, role, 'ShareLock')];
      await judged(st, `${role}, applied`, key, f.C1, f.T, saved(who, f.T, f.S), K);
      await judged(st, `${role}, customer_not_found`, key, randomUUID(), f.T, answer('customer_not_found'), K);
      await judged(st, `${role}, tenant_mismatch`, key, f.C1, T_OTHER, answer('tenant_mismatch'), []);
    });
  }
  await t.test('technician, default-only: its catalog Invoices View refuses at the step-8 pre-check, before the key, writing nothing', async (st) => {
    await judged(st, 'technician, the default View', tech.key, f.C1, f.T, REFUSED, []);
    await judged(st, 'technician, the default View (another expected tenant: step 8 precedes step 9)', tech.key, f.C1, T_OTHER, REFUSED, []);
  });
  await t.test('store_owner (Full by the catalog, never stored): applied, customer_not_found and tenant_mismatch take no advisory lock and write no row', async (st) => {
    await judged(st, 'store_owner, applied', f.kBoss, f.C1, f.T, saved(f.boss, f.T, f.S), []);
    await judged(st, 'store_owner, customer_not_found', f.kBoss, randomUUID(), f.T, answer('customer_not_found'), []);
    await judged(st, 'store_owner, tenant_mismatch', f.kBoss, f.C1, T_OTHER, answer('tenant_mismatch'), []);
    assert.deepEqual(strip(await invoicesRowsOf(f.T)), NO_ROWS, 'and nothing remains');
  });
  await t.test('sales_staff, a STORED Customers None: refused by the step-8 pre-check, before the key, nothing added', async (st) => {
    const g = await scene('d04n');
    const s2 = await member(g, 'd04n', 'sales_staff');
    await setLevel(g.T, 'sales_staff', 'customers', 'none');
    const base = strip(await invoicesRowsOf(g.T));
    assert.deepEqual(base, { roles: [{ role_id: 'sales_staff', domain: 'customers', level: 'none' }], versions: [] });
    for (const [name, customer] of [['a missing customer', randomUUID()], ['an existing customer', g.C1]]) {
      const seen = await saveInOwnTransaction(g, s2.key, customer, `the stored Customers None, ${name}`);
      evidence(st, { case: `CCA-04 stored None ${name}`, answer: seen.rows, levelsInsideItsTransaction: seen.levels, advisory: seen.advisory });
      assert.deepEqual(seen.rows, [REFUSED], `${name}: refused — never customer_not_found`);
      assert.deepEqual(seen.levels, base, `${name}: no row added`);
      assert.deepEqual(seen.advisory, [], `${name}: refused before the key`);
    }
  });
  await t.test('sales_staff, a Customers None an owner COMMITS while the save waits at the key (it passed step 8 on the default Create): refused AT THE GUARD DECISION, nothing written', async (st) => {
    const g = await scene('d04g');
    const s2 = await member(g, 'd04g', 'sales_staff');
    // The owner's uncommitted FIRST non-NULL Customers row of the role: 032's trigger takes the key EXCLUSIVE. The save read no
    // row at step 8 (the uncommitted insert is invisible), so it reaches the key on the default Create.
    const writer = holding(owner, (tx) => tx`insert into tmpos_role.tenant_role_level (tenant_id, role_id, domain, level, updated_at)
      values (${g.T}, 'sales_staff', 'customers', 'none', now())`);
    let saving = null;
    try {
      await until(() => writer.ready || writer.out !== undefined, 'the owner\'s Customers None held, uncommitted');
      assert.deepEqual(await guardLocksOf(writer.pid), [await guardLock(g.T, 'sales_staff', 'ExclusiveLock')], 'the owner\'s insert holds the role\'s key EXCLUSIVE (032\'s trigger)');
      const prints = await writes([g.T]);
      saving = running(runtime, (tx) => create(s2.key, g.S, g.T, randomUUID(), LINES, { db: tx }));
      await until(() => blockedBy(saving.pid, writer.pid), 'the save waits at the key behind the owner');
      assert.deepEqual(await waitsFor(saving.pid), [['advisory', 'ShareLock']], 'at the guard: one ungranted advisory lock, SHARED');
      assert.deepEqual(await guardLocksOf(saving.pid), [await guardLock(g.T, 'sales_staff', 'ShareLock', false)], 'for exactly the sales staff\'s key');
      writer.release('commit');
      finished(await writer.done, 'the owner\'s write');
      const out = finished(await saving.done, 'the save');
      evidence(st, { case: 'CCA-04 None at the guard decision', answer: out.value });
      assert.deepEqual(out.value.map((x) => ({ ...x })), [REFUSED], 'refused at 10b on the Customers None committed while it waited — never customer_not_found');
      assert.deepEqual(strip(await invoicesRowsOf(g.T)), { roles: [{ role_id: 'sales_staff', domain: 'customers', level: 'none' }], versions: [] }, 'only the owner\'s row: the save wrote none');
      assert.deepEqual(await writes([g.T]), prints, 'no draft, line, audit, event or record');
    } finally {
      writer.release('rollback');
      await writer.done;
      if (saving !== null) await saving.done;
    }
  });
});

// ===========================================================================
// ICA-06 (Invoices) and CCA-05 (Customers): a fresh decision after every wait (the level, and the database clock)
// ===========================================================================

/** Each domain's REAL setter (as the runtime login, or on `db`) and the narrowing below the save's requirement. */
const DOMAINS = Object.freeze({
  invoices: Object.freeze({ setter: (...a) => setInvoices(...a), narrowed: 'view', name: '026\'s Invoices setter' }),
  customers: Object.freeze({ setter: (...a) => setCustomers(...a), narrowed: 'none', name: '021\'s Customers setter' }),
});

/** The manager's save waiting at the guard behind `domain`'s REAL setter (the exact barrier), then released by `how`; what it left. */
async function behindTheSetter(st, { caseId, domain, label, stored, customerOf, how }) {
  const d = DOMAINS[domain];
  const f = await scene(label);
  if (stored !== undefined) await setLevel(f.T, 'manager', domain, stored);
  const own = await tenantOwner(f.T, label);
  const customer = customerOf(f);
  const reviewed = await versionRowOf(f.T, 'manager', domain);
  const before = { rows: strip(await invoicesRowsOf(f.T)), prints: await writes([f.T]) };
  const writer = holding(runtime, (tx) => d.setter(own.key, 'manager', d.narrowed, f.T, reviewed, tx));
  let saving = null;
  try {
    await until(() => writer.ready || writer.out !== undefined, `${label}: the setter's narrowing held, uncommitted`);
    assert.deepEqual(writer.value, [setterApplied(own, f.T, d.narrowed, reviewed + 1)], `${label}: ${d.name} applied, uncommitted`);
    assert.deepEqual(await guardLocksOf(writer.pid), [await guardLock(f.T, 'manager', 'ExclusiveLock')], `${label}: the setter holds the manager's key EXCLUSIVE`);
    saving = running(runtime, (tx) => create(f.kManager, f.S, f.T, customer, LINES, { db: tx }));
    const where = await waitingOrAnswered(saving, writer.pid, `${label}: the save waits behind the setter, or answers`);
    const barrier = where === 'waiting' ? { waitsFor: await waitsFor(saving.pid), guard: await guardLocksOf(saving.pid), query: await queryOf(saving.pid) } : null;
    evidence(st, { case: `${caseId} ${label}`, save: where, answeredWithoutWaiting: where === 'answered' ? (await saving.done).value ?? saving.out : null, barrier });
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

/** (a) and (b) of ICA-06 (Invoices) and CCA-05 (Customers), as subtests of `t`. */
async function freshDecisionAfterTheWait(t, { caseId, domain }) {
  const d = DOMAINS[domain];
  const tag = domain === 'invoices' ? 'i' : 'c';
  for (const [customerName, customerOf] of [['a missing customer', () => randomUUID()], ['an existing customer', (f) => f.C1]]) {
    for (const stored of [undefined, 'full']) {
      const override = stored === undefined ? 'absent override (the setter\'s FIRST override over the default)' : 'stored Full (the setter\'s update)';
      await t.test(`(a) ${customerName}, ${override}: ${d.name} commits its narrowing to ${d.narrowed} — REFUSED, nothing written`, async (st) => {
        const r = await behindTheSetter(st, { caseId, domain, label: `f${tag}a-${customerName === 'a missing customer' ? 'missing' : 'existing'}-${stored ?? 'absent'}`, stored, customerOf, how: 'commit' });
        evidence(st, { case: `${caseId} (a)`, answer: r.out.value, rowsAfter: r.after.rows });
        assert.deepEqual(r.out.value.map((x) => ({ ...x })), [REFUSED], 'refused on the narrowing that committed while the save waited — never a sealed answer');
        assert.deepEqual(r.after.rows, { roles: [{ role_id: 'manager', domain, level: d.narrowed }], versions: [{ role_id: 'manager', domain, version: String(r.reviewed + 1) }] },
          'the role and version rows exactly the setter\'s: no row of the save');
        assert.deepEqual(r.after.prints, r.before.prints, 'no draft, line, audit record, event or idempotency record');
      });
    }
  }
  for (const [customerName, customerOf, expect] of [
    ['a missing customer', () => randomUUID(), () => ({ answer: answer('customer_not_found'), drafts: 0 })],
    ['an existing customer', (f) => f.C1, (f) => ({ answer: saved(f.manager, f.T, f.S), drafts: 1 })],
  ]) {
    await t.test(`(b) ${customerName}, absent override: ${d.name} rolls back — the save answers on the default, writing no role row`, async (st) => {
      const r = await behindTheSetter(st, { caseId, domain, label: `f${tag}b-${customerName === 'a missing customer' ? 'missing' : 'existing'}`, stored: undefined, customerOf, how: 'rollback' });
      const e = expect(r.f);
      evidence(st, { case: `${caseId} (b)`, answer: r.out.value, rowsAfter: r.after.rows });
      assert.deepEqual(r.out.value.map((x) => ({ ...x })), [e.answer], 'the default (Full) admits it: the save\'s own answer');
      assert.deepEqual(r.after.rows, NO_ROWS, 'no role row and no version row: nothing of the save (032: no Customers anchor) and nothing of the rolled-back setter');
      assert.equal(r.after.prints.drafts - r.before.prints.drafts, e.drafts, 'the drafts it wrote');
    });
  }
}

/**
 * (c) of ICA-06 and CCA-05: POST-WAIT EXPIRY, NOT A TIMEOUT. Two managers' 8 s sessions; `writerOf(f)` holds the manager's key
 * EXCLUSIVE with an uncommitted write that would ADMIT the save; each save runs on an OWNER connection with no lock or statement
 * timeout, waits at the key past its session's expiry on the database clock, and is released only by the writer's ROLLBACK.
 */
async function expiryBehindTheKey(st, { caseId, label, writerOf }) {
  const f = await scene(label);
  const m1 = await member(f, `${label}-1`, 'manager');
  const m2 = await member(f, `${label}-2`, 'manager');
  // Two managers (two accounts: 016's hold takes each account FOR UPDATE, so one manager's two saves would queue on the
  // account, not the key), each with a short-lived session: live through every step up to the key, expired once the key has
  // been waited for. The expiry is real time, chosen generous (8 s) so each save reaches the key long before it (asserted:
  // each is seen waiting there first, live); the test then waits on the DATABASE clock passing the expiry — a condition.
  const [k1, k2] = await Promise.all([mint(m1.who, { lifetime: 8_000 }), mint(m2.who, { lifetime: 8_000 })]);
  const expiries = (await owner`select expires_at::text as e from tmpos_session.session where session_key = any(${[k1, k2]}::text[])`).map((r) => BigInt(r.e));
  assert.equal(expiries.length, 2);
  const [first, last] = [expiries.reduce((a, b) => (a < b ? a : b)), expiries.reduce((a, b) => (a > b ? a : b))];
  const writer = await writerOf(f);
  const seen = [null, null];
  const saves = [];
  try {
    await until(() => writer.ready || writer.out !== undefined, `${label}: the writer's admitting write held, uncommitted`);
    assert.equal(writer.ready, true, `${label}: the writer answered (${JSON.stringify(writer.out ?? null)})`);
    assert.deepEqual(await guardLocksOf(writer.pid), [await guardLock(f.T, 'manager', 'ExclusiveLock')], `${label}: the writer holds the key EXCLUSIVE`);
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
    assert.equal((await writer.done).outcome, 'rolled back', 'the writer rolled back: the level is the catalog default Full again');
    await until(() => saves.every((s) => s.ready || s.out !== undefined), 'both saves answered');
    evidence(st, { case: `${caseId} (c)`, expiries: expiries.map(String), atBarrier: String(atBarrier), seen });
    for (const [i, name] of [[0, 'the missing customer'], [1, 'the existing customer']]) {
      assert.equal(saves[i].ready, true, `${name}: ${JSON.stringify(saves[i].out)}`);
      assert.deepEqual(seen[i].timeouts, { lock: '0', statement: '0' }, `${name}: its connection had no lock or statement timeout — the wait ended by the writer, never by a timeout`);
      assert.deepEqual(seen[i].rows, [REFUSED], `${name}: refused by the clock read after the key`);
      assert.deepEqual(seen[i].levels, NO_ROWS, `${name}: inside the refusing transaction, no role row at all${i === 0 ? ' — not customer_not_found: the refusal precedes step 10c' : ''}`);
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
}

test('ICA-06 (AC-07, N; CCA-08 [G]): on v3, (a) a save waiting on the key behind 026\'s REAL Invoices setter\'s uncommitted narrowing is refused once it commits, nothing written; (b) rolled back, the save answers customer_not_found or applies, writing no role row; (c) a save of an 8 s session waiting on the key until the database clock passed its expiry is refused by the clock read after the key — no lock or statement timeout on its connection', async (t) => {
  await freshDecisionAfterTheWait(t, { caseId: 'ICA-06', domain: 'invoices' });
  await t.test('(c) post-wait expiry, not a timeout: 8 s sessions wait at the key past their expiry behind an owner\'s uncommitted first Invoices Create; the writer rolled back, each save is REFUSED by the clock read after the key', async (st) => {
    // The writer: an owner's uncommitted FIRST non-NULL INSERT of the manager's Invoices level (no row exists), Create — a level
    // that would ADMIT the save. Its AFTER INSERT trigger (030's) takes the key EXCLUSIVE. Rolled back, the level is the catalog
    // default (Full) again, so nothing but the clock read after the key can refuse: a missing clock read would let the
    // missing-customer save seal 'customer_not_found'.
    await expiryBehindTheKey(st, { caseId: 'ICA-06', label: 'f06c', writerOf: async (f) => holding(owner, (tx) => tx`insert into tmpos_role.tenant_role_level (tenant_id, role_id, domain, level, updated_at)
      values (${f.T}, 'manager', 'invoices', 'create', now())`) });
  });
});

test('CCA-05 (AC-05, N): a forced guard wait behind 021\'s REAL Customers setter — (a) its uncommitted narrowing to None (an update of a stored Full, and the FIRST override over the default) holds the key EXCLUSIVE, a save (missing and existing customer) waits on exactly that key and is REFUSED once it commits, nothing written; (b) rolled back, customer_not_found / applied with no role row; (c) 8 s sessions waiting at the key past their expiry behind the setter\'s uncommitted first override are refused by the clock read after the key', async (t) => {
  await freshDecisionAfterTheWait(t, { caseId: 'CCA-05', domain: 'customers' });
  await t.test('(c) post-wait expiry, not a timeout: 8 s sessions wait at the key past their expiry behind 021\'s real setter\'s uncommitted FIRST Customers override (View, which admits); rolled back, each save is REFUSED by the clock read after the key', async (st) => {
    await expiryBehindTheKey(st, { caseId: 'CCA-05', label: 'f05c', writerOf: async (f) => {
      const own = await tenantOwner(f.T, 'f05c');
      const writer = holding(runtime, (tx) => setCustomers(own.key, 'manager', 'view', f.T, 0, tx));
      await until(() => writer.ready || writer.out !== undefined, 'the Customers setter\'s first override held, uncommitted');
      assert.deepEqual(writer.value, [setterApplied(own, f.T, 'view', 1)], 'the Customers setter applied View, uncommitted');
      return writer;
    } });
  });
});

// ===========================================================================
// ICA-07 and CCA-07: the orderings without a new cycle
// ===========================================================================

/**
 * 032's ordering ICA-07 (3) and CCA-07 (3) stand for: 021's REAL Customers setter holding the manager's Customers row FOR UPDATE
 * (a stored override: its update; none: its FIRST override, an anchor it inserted) waits on a save's key, and an Invoices setter
 * behind it, while the save — holding the key, paused on the customer behind an owner's FOR UPDATE that takes no key — completes
 * WITHOUT waiting for that row (031's create_v2 would have needed it: its steps 11-12). All three finish, none in 40P01.
 */
async function customersSetterBehindASave(st, { caseId, label, stored }) {
  const f = await scene(label);
  if (stored !== undefined) await setLevel(f.T, 'manager', 'customers', stored);
  const ownC = await tenantOwner(f.T, `${label}-c`);
  const ownI = await tenantOwner(f.T, `${label}-i`);
  // The owner's row lock on the customer (no row trigger fires, no key) pauses the save at step 13, AFTER its key.
  const barrier = holding(owner, (tx) => tx`select 1 from tmpos_customer.customer where customer_id = ${f.C1} for update`);
  let saving = null;
  let customers = null;
  let invoices = null;
  try {
    await until(() => barrier.ready || barrier.out !== undefined, `${label}: the owner holds the customer FOR UPDATE`);
    assert.deepEqual(await anyAdvisoryOf(barrier.pid), [], `${label}: the owner's customer lock takes no key`);
    saving = holding(runtime, (tx) => create(f.kManager, f.S, f.T, f.C1, LINES, { db: tx }));
    await until(() => blockedBy(saving.pid, barrier.pid), `${label}: the save waits on the customer behind the owner`);
    assert.deepEqual(await guardLocksOf(saving.pid), [await guardLock(f.T, 'manager', 'ShareLock')], `${label}: the save, past its guard, holds the key SHARED, granted`);
    assert.deepEqual(await waitsFor(saving.pid), [['transactionid', 'ShareLock']], `${label}: the save waits on the customer row (FOR KEY SHARE behind FOR UPDATE), nothing else`);
    customers = running(runtime, (tx) => setCustomers(ownC.key, 'manager', 'view', f.T, 0, tx));
    await until(() => blockedBy(customers.pid, saving.pid), `${label}: the Customers setter waits on the save's key`);
    assert.deepEqual(await waitsFor(customers.pid), [['advisory', 'ExclusiveLock']], `${label}: the Customers setter waits on an advisory lock, EXCLUSIVE — nothing else: it already holds its role row`);
    assert.deepEqual((await guardLocksOf(customers.pid)).filter((l) => !l.granted), [await guardLock(f.T, 'manager', 'ExclusiveLock', false)], `${label}: on the manager's key`);
    if (stored !== undefined) {
      const probe = await rolledBack((tx) => tx`select 1 from tmpos_role.tenant_role_level
        where tenant_id = ${f.T} and role_id = 'manager' and domain = 'customers' for share nowait`);
      assert.equal(probe.code, '55P03', `${label}: the waiting Customers setter holds its role row FOR UPDATE (a FOR SHARE NOWAIT is refused: ${JSON.stringify(probe)})`);
    }
    invoices = running(runtime, (tx) => setInvoices(ownI.key, 'manager', 'view', f.T, 0, tx));
    await until(() => blockedBy(invoices.pid, saving.pid), `${label}: the Invoices setter waits on the key too`);
    assert.deepEqual(await waitsFor(invoices.pid), [['advisory', 'ExclusiveLock']], `${label}: the Invoices setter waits on the key, EXCLUSIVE — nothing else`);
    barrier.release('rollback');
    finished(await barrier.done, `${label}: the owner's customer lock`, 'rolled back');
    await until(() => saving.ready || saving.out !== undefined, `${label}: the save answered once the customer was free`);
    evidence(st, { case: caseId, label, save: saving.value ?? saving.out, customersSetterStillWaiting: await blockedBy(customers.pid, saving.pid) });
    assert.deepEqual(saving.value, [saved(f.manager, f.T, f.S)], `${label}: the save COMPLETED while the Customers setter held its role row FOR UPDATE — it never waits for a role row (032)`);
    assert.equal(await blockedBy(customers.pid, saving.pid), true, `${label}: the Customers setter still waits on the key while the save's transaction is open`);
    saving.release('commit');
    finished(await saving.done, `${label}: the save`);
    assert.deepEqual(finished(await customers.done, `${label}: the Customers setter`).value, [setterApplied(ownC, f.T, 'view', 1)], `${label}: the Customers setter applied after the save`);
    assert.deepEqual(finished(await invoices.done, `${label}: the Invoices setter`).value, [setterApplied(ownI, f.T, 'view', 1)], `${label}: and the Invoices setter`);
  } finally {
    barrier.release('rollback');
    await barrier.done;
    if (saving !== null) { saving.release('rollback'); await saving.done; }
    if (customers !== null) await customers.done;
    if (invoices !== null) await invoices.done;
  }
}

/**
 * ICA-07 (4) and CCA-07 (4): a save, holding the key, waits on the customer behind 024's REAL customer edit (FOR UPDATE; by a
 * store owner with one tenant grant: no role row, no key) while `domain`'s REAL setter waits on the save's key — all three finish.
 */
async function customerEditBesideASave(st, { caseId, label, domain }) {
  const f = await scene(label);
  const ownC = await tenantOwner(f.T, `${label}-c`);
  const ownW = await tenantOwner(f.T, `${label}-w`);
  const d = DOMAINS[domain];
  const customerEdit = holding(runtime, (tx) => editCustomer(ownC.key, f.C1, f.T, 1, `ICR renamed ${SUFFIX}`, tx));
  let saving = null;
  let writer = null;
  try {
    await until(() => customerEdit.ready || customerEdit.out !== undefined, `${label}: the customer edit held, uncommitted`);
    assert.deepEqual(customerEdit.value, [{ o_outcome: 'applied', o_tenant_id: f.T, o_actor_id: ownC.who.id, o_membership_id: ownC.who.memberships[0], o_version: 2 }]);
    assert.deepEqual(await anyAdvisoryOf(customerEdit.pid), [], `${label}: the customer edit takes no key`);
    saving = holding(runtime, (tx) => create(f.kManager, f.S, f.T, f.C1, LINES, { db: tx }));
    await until(() => blockedBy(saving.pid, customerEdit.pid), `${label}: the save waits behind the customer edit`);
    assert.deepEqual(await guardLocksOf(saving.pid), [await guardLock(f.T, 'manager', 'ShareLock')], `${label}: past its guard: holding the key SHARED, granted`);
    assert.deepEqual(await waitsFor(saving.pid), [['transactionid', 'ShareLock']], `${label}: waiting on the customer row (its FOR KEY SHARE behind FOR UPDATE), nothing else`);
    writer = running(runtime, (tx) => d.setter(ownW.key, 'manager', 'view', f.T, 0, tx));
    await until(() => blockedBy(writer.pid, saving.pid), `${label}: ${d.name} waits behind the save`);
    assert.deepEqual(await waitsFor(writer.pid), [['advisory', 'ExclusiveLock']], `${label}: on the save's key, EXCLUSIVE — nothing else`);
    customerEdit.release('commit');
    finished(await customerEdit.done, `${label}: the customer edit`);
    await until(() => saving.ready || saving.out !== undefined, `${label}: the save answered once the customer was free`);
    evidence(st, { case: caseId, label, save: saving.value ?? saving.out });
    assert.deepEqual(saving.value, [saved(f.manager, f.T, f.S)], `${label}: the save, the customer still in the tenant: applied`);
    assert.equal(await blockedBy(writer.pid, saving.pid), true, `${label}: ${d.name} still waits on the key while the save's transaction is open`);
    saving.release('commit');
    finished(await saving.done, `${label}: the save`);
    assert.deepEqual(finished(await writer.done, `${label}: ${d.name}`).value, [setterApplied(ownW, f.T, 'view', 1)]);
  } finally {
    customerEdit.release('rollback');
    await customerEdit.done;
    if (saving !== null) { saving.release('rollback'); await saving.done; }
    if (writer !== null) await writer.done;
  }
}

test('ICA-07 (AC-08, N; CCA-08 [G] for (1), (2), (6)): every ordering of a v3 save with the Invoices setter, 021\'s Customers setter, 024\'s customer edit, the edit v2, a later save and an owner\'s row lock finishes — no 40P01; every wait first seen in pg_locks', async (t) => {
  await t.test('(1) [CCA-08] the save holds the key — applied and customer_not_found — 026\'s Invoices setter waits on it, then both finish', async () => {
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
  await t.test('(2) [CCA-08] 026\'s Invoices setter holds the key — the save waits on it, then both finish (the save on the committed level)', async () => {
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
  await t.test('(3) [032; = CCA-07 (3) for a stored override] 021\'s REAL Customers setter, holding its role row FOR UPDATE, waits on the save\'s key (an Invoices setter behind it) while the save completes WITHOUT waiting for that row — all three finish', async (st) => {
    await customersSetterBehindASave(st, { caseId: 'ICA-07 (3)', label: 'o073', stored: 'full' });
  });
  await t.test('(4) the save, holding the key, waits on the customer behind 024\'s REAL customer edit while an Invoices setter waits on the save\'s key — all three finish', async (st) => {
    await customerEditBesideASave(st, { caseId: 'ICA-07 (4)', label: 'o074', domain: 'invoices' });
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
  await t.test('(6) [CCA-08] a later save queues on the key behind an Invoices setter that waits behind an earlier save — all finish; the later save is refused on the narrowing that committed', async () => {
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
// CCA-06: every writer of a Customers level takes the key (032's trigger)
// ===========================================================================

/** Deletes every role and version row of `tenants`, then inserts `rows` as role rows only (an owner's committed writes, no version row): a case's starting state. */
async function resetLevels(tenants, rows) {
  await owner.begin(RC, async (tx) => {
    await tx`delete from tmpos_role.tenant_role_level where tenant_id = any(${tenants}::uuid[])`;
    await tx`delete from tmpos_role_edit.role_level_version where tenant_id = any(${tenants}::uuid[])`;
    for (const r of rows) {
      await tx`insert into tmpos_role.tenant_role_level (tenant_id, role_id, domain, level, updated_at) values (${r.tenant}, ${r.role}, ${r.domain}, ${r.level}, now())`;
    }
  });
}
const levelRow = (tenant, role, domain, level) => ({ tenant, role, domain, level });
/** The guard locks a writer of `pairs` ([tenant, role]) holds: each distinct key EXCLUSIVE, granted, in key order. */
async function exclusiveOn(pairs) {
  const keys = [...new Set(await Promise.all(pairs.map(([tenant, role]) => guardKey(tenant, role))))].sort((a, b) => a - b);
  return keys.map((key) => ({ class: GUARD_CLASS, key, sub: 2, mode: 'ExclusiveLock', granted: true }));
}

test('CCA-06 (AC-06, N): every writer of a Customers level takes the key EXCLUSIVE — 021\'s real setter (first override, update, reset to the default word) and owner DML (non-NULL INSERT, UPDATEs non-NULL->non-NULL, NULL->level, level->NULL, non-NULL DELETE, tenant, role, domain and pair-and-domain moves, the same UPDATE in replica mode); NULL INSERT and DELETE take none; prohibited transitions refuse without asking for a key; TRUNCATE is owner-only and waits for an in-flight save', async (t) => {
  const T = await newTenant('w06');
  const T2 = await newTenant('w06-2');
  const own = await tenantOwner(T, 'w06');
  await t.test('021\'s REAL Customers setter: its first override, its update and its reset to the default word each hold the role\'s key EXCLUSIVE', async (st) => {
    for (const [name, stored, level] of [['the first override (no row)', undefined, 'view'], ['an update of a stored Edit', 'edit', 'view'],
      ['a reset of a stored View to the manager\'s default word Full', 'view', 'full']]) {
      await resetLevels([T, T2], stored === undefined ? [] : [levelRow(T, 'manager', 'customers', stored)]);
      const writer = holding(runtime, (tx) => setCustomers(own.key, 'manager', level, T, 0, tx));
      try {
        await until(() => writer.ready || writer.out !== undefined, `${name}: the setter answered, uncommitted`);
        assert.deepEqual(writer.value, [setterApplied(own, T, level, 1)], `${name}: applied`);
        const locks = await anyAdvisoryOf(writer.pid);
        evidence(st, { case: 'CCA-06 setter', name, locks });
        assert.deepEqual(locks, await exclusiveOn([[T, 'manager']]), `${name}: exactly the manager's key, EXCLUSIVE, and no other advisory lock`);
      } finally {
        writer.release('rollback');
        assert.equal((await writer.done).outcome, 'rolled back');
      }
    }
  });
  await t.test('owner DML: each transition holds exactly its old/new keys EXCLUSIVE (or none for a NULL INSERT or DELETE), in origin and in replica mode', async (st) => {
    const where = (domain = 'customers') => `tenant_id = '${T}' and role_id = 'manager' and domain = '${domain}'`;
    for (const [name, rows, statement, pairs, replica, alone] of [
      ['INSERT of a non-NULL Customers level', [], `insert into tmpos_role.tenant_role_level (tenant_id, role_id, domain, level, updated_at) values ('${T}', 'manager', 'customers', 'view', now())`, [[T, 'manager']]],
      ['UPDATE non-NULL -> non-NULL', [levelRow(T, 'manager', 'customers', 'view')], `update tmpos_role.tenant_role_level set level = 'edit' where ${where()}`, [[T, 'manager']]],
      ['UPDATE NULL -> a level', [levelRow(T, 'manager', 'customers', null)], `update tmpos_role.tenant_role_level set level = 'view' where ${where()}`, [[T, 'manager']]],
      ['UPDATE a level -> NULL', [levelRow(T, 'manager', 'customers', 'view')], `update tmpos_role.tenant_role_level set level = null where ${where()}`, [[T, 'manager']]],
      ['DELETE of a non-NULL Customers level', [levelRow(T, 'manager', 'customers', 'view')], `delete from tmpos_role.tenant_role_level where ${where()}`, [[T, 'manager']]],
      ['a tenant move', [levelRow(T, 'manager', 'customers', 'view')], `update tmpos_role.tenant_role_level set tenant_id = '${T2}' where ${where()}`, [[T, 'manager'], [T2, 'manager']]],
      ['a role move', [levelRow(T, 'manager', 'customers', 'view')], `update tmpos_role.tenant_role_level set role_id = 'sales_staff' where ${where()}`, [[T, 'manager'], [T, 'sales_staff']]],
      ['a domain move customers -> invoices', [levelRow(T, 'manager', 'customers', 'view')], `update tmpos_role.tenant_role_level set domain = 'invoices' where ${where()}`, [[T, 'manager']]],
      ['a domain move invoices -> customers', [levelRow(T, 'manager', 'invoices', 'view')], `update tmpos_role.tenant_role_level set domain = 'customers' where ${where('invoices')}`, [[T, 'manager']]],
      ['a pair-and-domain move customers -> invoices of another role', [levelRow(T, 'manager', 'customers', 'view')],
        `update tmpos_role.tenant_role_level set role_id = 'sales_staff', domain = 'invoices' where ${where()}`, [[T, 'manager'], [T, 'sales_staff']]],
      // The same three cross-domain moves with 030's Invoices guard DISABLED inside the writing transaction (rolled back): 030's
      // trigger takes the same keys for an Invoices old or new row, so only these attribute the keys to 032's trigger alone.
      ['a domain move customers -> invoices, 032\'s trigger alone', [levelRow(T, 'manager', 'customers', 'view')], `update tmpos_role.tenant_role_level set domain = 'invoices' where ${where()}`, [[T, 'manager']], false, true],
      ['a domain move invoices -> customers, 032\'s trigger alone', [levelRow(T, 'manager', 'invoices', 'view')], `update tmpos_role.tenant_role_level set domain = 'customers' where ${where('invoices')}`, [[T, 'manager']], false, true],
      ['a pair-and-domain move customers -> invoices of another role, 032\'s trigger alone', [levelRow(T, 'manager', 'customers', 'view')],
        `update tmpos_role.tenant_role_level set role_id = 'sales_staff', domain = 'invoices' where ${where()}`, [[T, 'manager'], [T, 'sales_staff']], false, true],
      ['INSERT of a NULL Customers level (an anchor)', [], `insert into tmpos_role.tenant_role_level (tenant_id, role_id, domain, level, updated_at) values ('${T}', 'manager', 'customers', null, now())`, []],
      ['DELETE of a NULL Customers level (an anchor)', [levelRow(T, 'manager', 'customers', null)], `delete from tmpos_role.tenant_role_level where ${where()}`, []],
      ['UPDATE non-NULL -> non-NULL with session_replication_role = replica', [levelRow(T, 'manager', 'customers', 'view')], `update tmpos_role.tenant_role_level set level = 'edit' where ${where()}`, [[T, 'manager']], true],
    ]) {
      await resetLevels([T, T2], rows);
      const writer = holding(owner, async (tx) => {
        if (alone) await tx.unsafe('alter table tmpos_role.tenant_role_level disable trigger trg_tenant_role_level_invoice_guard');
        if (replica) {
          await tx`set local session_replication_role = replica`.catch((err) => {
            throw new Error(`CCA-06 needs an owner that may set session_replication_role, and this one may not: ${err.message}`);
          });
          assert.equal((await tx`select pg_catalog.current_setting('session_replication_role') as mode`)[0].mode, 'replica');
        }
        return (await tx.unsafe(statement)).count;
      });
      try {
        await until(() => writer.ready || writer.out !== undefined, `${name}: the write answered, uncommitted`);
        assert.equal(writer.ready, true, `${name}: ${JSON.stringify(writer.out ?? null)}`);
        assert.equal(writer.value, 1, `${name}: one row written`);
        const locks = await anyAdvisoryOf(writer.pid);
        evidence(st, { case: 'CCA-06 owner DML', name, locks });
        assert.deepEqual(locks, await exclusiveOn(pairs), pairs.length === 0 ? `${name}: no key (a NULL level is the catalog default)`
          : `${name}: exactly ${pairs.length === 1 ? 'the pair\'s key' : 'the old and the new pair\'s keys'}, EXCLUSIVE, and no other advisory lock`);
      } finally {
        writer.release('rollback');
        assert.equal((await writer.done).outcome, 'rolled back');
      }
    }
  });
  await t.test('prohibited transitions refuse within a 2 s lock_timeout while every key they could name is held SHARED elsewhere: they never ask for a key', async (st) => {
    const unknown = randomUUID();
    const where = `tenant_id = '${T}' and role_id = 'manager' and domain = 'customers'`;
    const stored = [levelRow(T, 'manager', 'customers', 'view')];
    for (const [name, rows, statement, pairs, code] of [
      ['UPDATE into the domain \'other\'', stored, `update tmpos_role.tenant_role_level set domain = 'other' where ${where}`, [[T, 'manager']], '23514'],
      ['UPDATE into the role \'store_owner\'', stored, `update tmpos_role.tenant_role_level set role_id = 'store_owner' where ${where}`, [[T, 'manager'], [T, 'store_owner']], '23514'],
      ['UPDATE into an unknown tenant', stored, `update tmpos_role.tenant_role_level set tenant_id = '${unknown}' where ${where}`, [[T, 'manager'], [unknown, 'manager']], '23503'],
      ['INSERT of a Customers level for the role \'store_owner\'', [], `insert into tmpos_role.tenant_role_level (tenant_id, role_id, domain, level, updated_at) values ('${T}', 'store_owner', 'customers', 'view', now())`, [[T, 'store_owner']], '23514'],
      ['INSERT of a Customers level in an unknown tenant', [], `insert into tmpos_role.tenant_role_level (tenant_id, role_id, domain, level, updated_at) values ('${unknown}', 'manager', 'customers', 'view', now())`, [[unknown, 'manager']], '23503'],
    ]) {
      await resetLevels([T, T2], rows);
      const before = { here: strip(await invoicesRowsOf(T)), there: strip(await invoicesRowsOf(T2)) };
      const keys = (await exclusiveOn(pairs)).map((l) => l.key);
      const barrier = holding(owner, async (tx) => {
        for (const k of keys) await tx`select pg_catalog.pg_advisory_xact_lock_shared(${GUARD_CLASS}::int4, ${k}::int4)`;
      });
      try {
        await until(() => barrier.ready || barrier.out !== undefined, `${name}: the barrier holds the keys SHARED`);
        assert.equal(barrier.ready, true, `${name}: ${JSON.stringify(barrier.out ?? null)}`);
        const refused = await errorOf(owner.begin(RC, async (tx) => {
          await tx`set local lock_timeout = '2s'`;
          await tx.unsafe(statement);
        }));
        evidence(st, { case: 'CCA-06 prohibited', name, refused });
        assert.equal(refused?.code, code, `${name}: refused with ${code}, never 55P03 — had it asked for a key held SHARED by the barrier it would have waited (${JSON.stringify(refused)})`);
        assert.deepEqual({ here: strip(await invoicesRowsOf(T)), there: strip(await invoicesRowsOf(T2)) }, before, `${name}: nothing changed by the refusal`);
      } finally {
        barrier.release('rollback');
        await barrier.done;
      }
    }
  });
  await t.test('TRUNCATE (no row trigger fires): no runtime role holds it; the owner\'s TRUNCATE waits for an in-flight save\'s ACCESS SHARE on the level table (recorded)', async (st) => {
    const [priv] = await owner`select
        pg_catalog.has_table_privilege('tmpos_app', 'tmpos_role.tenant_role_level', 'TRUNCATE') as app,
        pg_catalog.has_table_privilege('tmpos_audit_writer', 'tmpos_role.tenant_role_level', 'TRUNCATE') as audit_writer,
        pg_catalog.has_table_privilege('anon', 'tmpos_role.tenant_role_level', 'TRUNCATE') as anon,
        pg_catalog.has_table_privilege('authenticated', 'tmpos_role.tenant_role_level', 'TRUNCATE') as authenticated,
        pg_catalog.has_table_privilege(${RUNTIME_LOGIN}, 'tmpos_role.tenant_role_level', 'TRUNCATE') as login`;
    assert.deepEqual({ ...priv }, { app: false, audit_writer: false, anon: false, authenticated: false, login: false }, 'no runtime role, and not the login, may TRUNCATE the level table');
    const f = await scene('w06t');
    const held = holding(runtime, (tx) => create(f.kManager, f.S, f.T, f.C1, LINES, { db: tx }));
    let truncating = null;
    try {
      await until(() => held.ready || held.out !== undefined, 'the save applied, uncommitted');
      assert.deepEqual(held.value, [saved(f.manager, f.T, f.S)]);
      const saveLocks = (await owner`select l.mode::text as mode, l.granted from pg_catalog.pg_locks l
        where l.pid = ${held.pid} and l.locktype = 'relation' and l.relation = 'tmpos_role.tenant_role_level'::regclass order by 1`).map((r) => ({ ...r }));
      assert.deepEqual(saveLocks, [{ mode: 'AccessShareLock', granted: true }], 'the in-flight save holds the level table ACCESS SHARE only (plain reads), until COMMIT');
      let truncated = null;
      truncating = holding(owner, async (tx) => { truncated = await tx.unsafe('truncate tmpos_role.tenant_role_level').then(() => 'truncated', (err) => `refused ${err.code}`); });
      await until(() => blockedBy(truncating.pid, held.pid), 'the TRUNCATE waits for the save');
      const wait = await lockWaitOf(truncating.pid, held.pid);
      evidence(st, { case: 'CCA-06 TRUNCATE', saveLocks, truncateWaits: wait.ungranted });
      assert.deepEqual(wait.ungranted.map((l) => [l.locktype, l.mode, l.rel]), [['relation', 'AccessExclusiveLock', 'tmpos_role.tenant_role_level']],
        'an ACCESS EXCLUSIVE relation lock on the level table, behind the save: ordered by the relation lock, not by a row trigger');
      held.release('commit');
      finished(await held.done, 'the save');
      await until(() => truncating.ready || truncating.out !== undefined, 'the TRUNCATE ran once the save ended');
      assert.equal(truncated, 'truncated', 'and it truncated (rolled back below)');
      truncating.release('rollback');
      finished(await truncating.done, 'the TRUNCATE', 'rolled back');
    } finally {
      held.release('rollback');
      await held.done;
      if (truncating !== null) { truncating.release('rollback'); await truncating.done; }
    }
  });
});

// ===========================================================================
// CCA-07: the order — the catalog's, the acquisition's, and the orderings with the Customers setter
// ===========================================================================

test('CCA-07 (AC-07, N): the level table\'s triggers in name order (Customers guard, Invoices guard, version advance), ENABLE ALWAYS; a key-moving Customers UPDATE takes its complete old/new key set ascending in the Customers guard; every ordering of a v3 save with 021\'s REAL Customers setter, 024\'s customer edit and the edit v2 finishes — no 40P01; every wait first seen in pg_locks', async (t) => {
  await t.test('the catalog: exactly three non-internal triggers, in name (byte) order 032\'s, 030\'s, 021\'s; AFTER ROW INSERT/UPDATE/DELETE (29), the same (29), UPDATE (17); ENABLE ALWAYS; no column list, no WHEN', async (st) => {
    const rows = (await owner`select g.tgname::text as name, g.tgfoid::regprocedure::text as fn, g.tgtype::int as type, g.tgenabled::text as enabled,
        g.tgattr::text as columns, g.tgqual is null as unconditional
      from pg_catalog.pg_trigger g where g.tgrelid = 'tmpos_role.tenant_role_level'::regclass and not g.tgisinternal order by g.tgname::text collate "C"`).map((r) => ({ ...r }));
    evidence(st, { case: 'CCA-07 catalog', triggers: rows });
    assert.deepEqual(rows, [
      { name: CUSTOMERS_TRIGGER, fn: CUSTOMERS_GUARD, type: 29, enabled: 'A', columns: '', unconditional: true },
      { name: 'trg_tenant_role_level_invoice_guard', fn: GUARD, type: 29, enabled: 'A', columns: '', unconditional: true },
      { name: 'trg_tenant_role_level_version_advance', fn: 'tmpos_role_edit.m7a_role_level_version_advance()', type: 17, enabled: 'A', columns: '', unconditional: true },
    ], 'the Customers guard fires first, then the Invoices guard, then the version advance');
  });
  await t.test('acquisition: a key-moving UPDATE whose OLD key is the higher one, the higher key held SHARED elsewhere, holds the LOWER key granted and waits for the higher — a pair move, and pair-and-domain moves into and out of Invoices', async (st) => {
    const T = await newTenant('o07m');
    const kM = await guardKey(T, 'manager');
    const kS = await guardKey(T, 'sales_staff');
    assert.notEqual(kM, kS, 'two distinct keys');
    const [hiRole, loRole] = kM > kS ? ['manager', 'sales_staff'] : ['sales_staff', 'manager'];
    const [lo, hi] = [Math.min(kM, kS), Math.max(kM, kS)];
    const at = (key, granted) => ({ class: GUARD_CLASS, key, sub: 2, mode: 'ExclusiveLock', granted });
    for (const [name, from, to, alone] of [['a pair move (customers -> customers: 032\'s trigger alone fires)', 'customers', 'customers', false],
      ['a pair-and-domain move into Invoices (both guards)', 'customers', 'invoices', false], ['a pair-and-domain move out of Invoices (both guards)', 'invoices', 'customers', false],
      // 030's guard takes the same sorted keys for an Invoices old or new row: disabled inside the mover's own (rolled-back)
      // transaction, the order observed is 032's trigger's alone.
      ['a pair-and-domain move into Invoices (030\'s guard disabled in the mover: 032\'s trigger alone)', 'customers', 'invoices', true],
      ['a pair-and-domain move out of Invoices (030\'s guard disabled in the mover: 032\'s trigger alone)', 'invoices', 'customers', true]]) {
      await resetLevels([T], [levelRow(T, hiRole, from, 'view')]);
      const barrier = holding(owner, (tx) => tx`select pg_catalog.pg_advisory_xact_lock_shared(${GUARD_CLASS}::int4, ${hi}::int4)`);
      let mover = null;
      try {
        await until(() => barrier.ready || barrier.out !== undefined, `${name}: the higher key held SHARED`);
        mover = holding(owner, async (tx) => {
          if (alone) await tx.unsafe('alter table tmpos_role.tenant_role_level disable trigger trg_tenant_role_level_invoice_guard');
          return tx`update tmpos_role.tenant_role_level set role_id = ${loRole}, domain = ${to}
            where tenant_id = ${T} and role_id = ${hiRole} and domain = ${from}`;
        });
        await until(() => blockedBy(mover.pid, barrier.pid), `${name}: the mover waits for the higher key`);
        const atWait = await guardLocksOf(mover.pid);
        evidence(st, { case: 'CCA-07 acquisition', name, from: `${hiRole}/${from}`, to: `${loRole}/${to}`, lo, hi, atWait });
        assert.deepEqual(await waitsFor(mover.pid), [['advisory', 'ExclusiveLock']], `${name}: one ungranted lock, an advisory EXCLUSIVE`);
        assert.deepEqual(atWait, [at(lo, true), at(hi, false)], `${name}: the LOWER (new) key held and the higher (old) one awaited — the complete set, ascending, taken by the trigger that fires first`);
        barrier.release('rollback');
        finished(await barrier.done, `${name}: the barrier`, 'rolled back');
        await until(() => mover.ready || mover.out !== undefined, `${name}: the move answered once the higher key was free`);
        assert.equal(mover.ready, true, `${name}: ${JSON.stringify(mover.out ?? null)}`);
        assert.deepEqual(await guardLocksOf(mover.pid), [at(lo, true), at(hi, true)], `${name}: both keys EXCLUSIVE, the later triggers re-entering them`);
        mover.release('rollback');
        finished(await mover.done, `${name}: the move`, 'rolled back');
      } finally {
        barrier.release('rollback');
        await barrier.done;
        if (mover !== null) { mover.release('rollback'); await mover.done; }
      }
    }
  });
  await t.test('(1) a save holds the key — applied and customer_not_found — 021\'s Customers setter (narrowing to None) waits on it, holding nothing a save needs; both finish', async () => {
    for (const [name, customerOf, expectedOf] of [
      ['applied', (f) => f.C1, (f) => saved(f.manager, f.T, f.S)],
      ['customer_not_found', () => randomUUID(), () => answer('customer_not_found')],
    ]) {
      const f = await scene(`c071-${name === 'applied' ? 'a' : 'n'}`);
      const own = await tenantOwner(f.T, `c071-${name === 'applied' ? 'a' : 'n'}`);
      const held = holding(runtime, (tx) => create(f.kManager, f.S, f.T, customerOf(f), LINES, { db: tx }));
      let writer = null;
      try {
        await until(() => held.ready || held.out !== undefined, `${name}: the save answered, its transaction open`);
        assert.deepEqual(held.value, [expectedOf(f)], `${name}: the save's answer`);
        assert.deepEqual(await guardLocksOf(held.pid), [await guardLock(f.T, 'manager', 'ShareLock')], `${name}: the save holds the key SHARED`);
        writer = running(runtime, (tx) => setCustomers(own.key, 'manager', 'none', f.T, 0, tx));
        await until(() => blockedBy(writer.pid, held.pid), `${name}: the Customers setter waits behind the save`);
        assert.deepEqual(await waitsFor(writer.pid), [['advisory', 'ExclusiveLock']], `${name}: on an advisory lock, EXCLUSIVE — nothing else`);
        assert.deepEqual((await guardLocksOf(writer.pid)).filter((l) => !l.granted), [await guardLock(f.T, 'manager', 'ExclusiveLock', false)], `${name}: the manager's key`);
        assert.equal(writer.out, null, `${name}: the narrowing has not committed while the save's transaction is open`);
        held.release('commit');
        finished(await held.done, `${name}: the save`);
        assert.deepEqual(finished(await writer.done, `${name}: the Customers setter`).value, [setterApplied(own, f.T, 'none', 1)], `${name}: the narrowing applied once the save committed`);
      } finally {
        held.release('rollback');
        await held.done;
        if (writer !== null) await writer.done;
      }
    }
  });
  await t.test('(2) 021\'s Customers setter holds the key — the save waits on it, then both finish, the save on the committed level (View admits)', async () => {
    const f = await scene('c072');
    const own = await tenantOwner(f.T, 'c072');
    const writer = holding(runtime, (tx) => setCustomers(own.key, 'manager', 'view', f.T, 0, tx));
    let saving = null;
    try {
      await until(() => writer.ready || writer.out !== undefined, 'the Customers setter\'s change held, uncommitted');
      assert.deepEqual(await guardLocksOf(writer.pid), [await guardLock(f.T, 'manager', 'ExclusiveLock')], 'the Customers setter holds the key EXCLUSIVE');
      saving = running(runtime, (tx) => create(f.kManager, f.S, f.T, f.C1, LINES, { db: tx }));
      await until(() => blockedBy(saving.pid, writer.pid), 'the save waits behind the Customers setter');
      assert.deepEqual(await waitsFor(saving.pid), [['advisory', 'ShareLock']], 'at the guard: an advisory lock, SHARED');
      assert.deepEqual(await guardLocksOf(saving.pid), [await guardLock(f.T, 'manager', 'ShareLock', false)], 'the manager\'s key');
      writer.release('commit');
      assert.deepEqual(finished(await writer.done, 'the Customers setter').value, [setterApplied(own, f.T, 'view', 1)]);
      assert.deepEqual(finished(await saving.done, 'the save').value.map((x) => ({ ...x })), [saved(f.manager, f.T, f.S)], 'Customers View admits the save: applied');
    } finally {
      writer.release('rollback');
      await writer.done;
      if (saving !== null) await saving.done;
    }
  });
  await t.test('(3) 021\'s Customers setter\'s FIRST override (the anchor it inserted, held FOR UPDATE) waits on the save\'s key (an Invoices setter behind it) while the save completes WITHOUT waiting for that row — all three finish', async (st) => {
    await customersSetterBehindASave(st, { caseId: 'CCA-07 (3)', label: 'c073', stored: undefined });
  });
  await t.test('(4) a save, holding the key, waits on its customer behind 024\'s REAL customer edit while 021\'s Customers setter waits on the save\'s key — all three finish', async (st) => {
    await customerEditBesideASave(st, { caseId: 'CCA-07 (4)', label: 'c074', domain: 'customers' });
  });
  await t.test('(5) a save and an edit v2 of one role hold the key SHARED together; 021\'s Customers setter waits for BOTH, then applies', async () => {
    const f = await scene('c075');
    const own = await tenantOwner(f.T, 'c075');
    const m2 = await member(f, 'c075-2', 'manager');
    const draft = await save(f.boss, f.kBoss, f.S, f.T, f.C1);
    const K = await guardLock(f.T, 'manager', 'ShareLock');
    const editing = holding(runtime, (tx) => edit(f.kManager, f.S, f.T, draft, 1, f.C2, [line('Beside a save and a setter', 1, 1)], { db: tx }));
    let saving = null;
    let writer = null;
    try {
      await readyUnblocked(editing, 'the edit answered');
      assert.deepEqual(editing.value, [edited(f.manager, f.T, f.S, 2)], 'the edit applied');
      saving = holding(runtime, (tx) => create(m2.key, f.S, f.T, f.C1, LINES, { db: tx }));
      await readyUnblocked(saving, 'the save answered beside the edit, never waiting');
      assert.deepEqual(saving.value, [saved(m2.who, f.T, f.S)], 'the save applied');
      assert.deepEqual([await guardLocksOf(editing.pid), await guardLocksOf(saving.pid)], [[K], [K]], 'both hold the manager\'s key SHARED, granted, at once');
      writer = running(runtime, (tx) => setCustomers(own.key, 'manager', 'none', f.T, 0, tx));
      await until(async () => (await blockedBy(writer.pid, editing.pid)) && (await blockedBy(writer.pid, saving.pid)), 'the Customers setter waits for both');
      assert.deepEqual(await waitsFor(writer.pid), [['advisory', 'ExclusiveLock']], 'on the key, EXCLUSIVE — nothing else');
      editing.release('commit');
      finished(await editing.done, 'the edit');
      assert.equal(await blockedBy(writer.pid, saving.pid), true, 'the edit ended: the setter still waits for the save');
      assert.equal(writer.out, null, 'and has not committed');
      saving.release('commit');
      finished(await saving.done, 'the save');
      assert.deepEqual(finished(await writer.done, 'the Customers setter').value, [setterApplied(own, f.T, 'none', 1)], 'applied once both ended');
    } finally {
      editing.release('rollback');
      await editing.done;
      if (saving !== null) { saving.release('rollback'); await saving.done; }
      if (writer !== null) await writer.done;
    }
  });
});

// ===========================================================================
// Negative controls (throwaway owner transactions; nothing left disabled or applied)
// ===========================================================================

test('NC-ii (AC-06, negative control): with trg_tenant_role_level_customers_guard DISABLED inside the owner transaction that writes a Customers narrowing (re-enabled ALWAYS before its COMMIT), the narrowing COMMITS while a save holds the key SHARED — without the trigger the writer is not held behind the save (the lock-level form of the ordering CCA-03 and CCA-05 assert); enabled, the same write waits', async (t) => {
  const f = await scene('nc2');
  const K = await guardLock(f.T, 'manager', 'ShareLock');
  const insertNone = (tx) => tx`insert into tmpos_role.tenant_role_level (tenant_id, role_id, domain, level, updated_at) values (${f.T}, 'manager', 'customers', 'none', now())`;
  // The sealed answer DA-211 concerns, held open: the manager's 'customer_not_found', the key SHARED.
  const held = holding(runtime, (tx) => create(f.kManager, f.S, f.T, randomUUID(), LINES, { db: tx }));
  try {
    await until(() => held.ready || held.out !== undefined, 'the save answered, its transaction open');
    assert.deepEqual(held.value, [answer('customer_not_found')], 'the sealed customer_not_found, uncommitted');
    assert.deepEqual(await guardLocksOf(held.pid), [K], 'the save holds the key SHARED');
    await t.test('the trigger ENABLED (the protection): the owner\'s Customers narrowing waits on the save\'s key (cancelled)', async (st) => {
      // Bounded twice over: a 10 s lock_timeout of its own, and a cancel in finally should anything fail before the cancel below.
      const writer = holding(owner, async (tx) => { await tx`set local lock_timeout = '10s'`; return insertNone(tx); });
      try {
        await until(() => blockedBy(writer.pid, held.pid), 'the narrowing waits behind the save');
        const waits = await waitsFor(writer.pid);
        evidence(st, { case: 'NC-ii enabled', waits });
        assert.deepEqual(waits, [['advisory', 'ExclusiveLock']], 'on the key, EXCLUSIVE');
        await owner`select pg_catalog.pg_cancel_backend(${writer.pid})`;
        const out = await writer.done;
        assert.equal(out.code, '57014', `cancelled while waiting: ${JSON.stringify(out)}`);
      } finally {
        if (writer.pid !== null && writer.out === undefined) await owner`select pg_catalog.pg_cancel_backend(${writer.pid})`;
        writer.release('rollback');
        await writer.done;
      }
    });
    await t.test('the trigger DISABLED in the writing transaction (the control): the narrowing COMMITS while the save still holds the key — the protected ordering is gone', async (st) => {
      const writer = running(owner, async (tx) => {
        await tx.unsafe(`alter table tmpos_role.tenant_role_level disable trigger ${CUSTOMERS_TRIGGER}`);
        await insertNone(tx);
        await tx.unsafe(`alter table tmpos_role.tenant_role_level enable always trigger ${CUSTOMERS_TRIGGER}`);
        return (await tx`select g.tgenabled::text as mode from pg_catalog.pg_trigger g
          where g.tgrelid = 'tmpos_role.tenant_role_level'::regclass and g.tgname = ${CUSTOMERS_TRIGGER}`)[0].mode;
      });
      const out = await writer.done;
      const after = { holder: await guardLocksOf(held.pid), saveOpen: held.out === undefined, rows: strip(await invoicesRowsOf(f.T)) };
      evidence(st, { case: 'NC-ii disabled', writer: out, after });
      assert.deepEqual(out, { outcome: 'committed', value: 'A' }, 'the unprotected narrowing COMMITTED (the trigger ENABLE ALWAYS again inside it) — it never waited for the save');
      assert.deepEqual(after.holder, [K], 'while the save still holds the key SHARED');
      assert.equal(after.saveOpen, true, 'and its sealed customer_not_found is still uncommitted: the narrowing won the race the trigger exists to order');
      assert.deepEqual(after.rows, { roles: [{ role_id: 'manager', domain: 'customers', level: 'none' }], versions: [] }, 'the narrowing is committed');
    });
  } finally {
    held.release('rollback');
    await held.done;
  }
  assert.deepEqual((await owner`select g.tgenabled::text as mode from pg_catalog.pg_trigger g
    where g.tgrelid = 'tmpos_role.tenant_role_level'::regclass and g.tgname = ${CUSTOMERS_TRIGGER}`).map((r) => r.mode), ['A'], 'the trigger is ENABLE ALWAYS after the control');
});

test('NC-iii (AC-07, negative control): 031\'s create_v2, run by its OWNER under 032\'s trigger, holding the key SHARED and then needing the Customers row 021\'s REAL setter holds FOR UPDATE while that setter waits for the key — 40P01 on one side (bounded); the same arrangement with v3 completes and the setter follows', async (t) => {
  for (const [variant, fn, deadlock] of [['031\'s create_v2 (owner-executable only since 032)', CREATE_FN_V2, true], ['032\'s create_v3 (the runtime\'s)', CREATE_FN, false]]) {
    await t.test(variant, async (st) => {
      const f = await scene(`nc3${deadlock ? 'a' : 'b'}`);
      await setLevel(f.T, 'manager', 'customers', 'full');
      const own = await tenantOwner(f.T, `nc3${deadlock ? 'a' : 'b'}`);
      const K = await guardKey(f.T, 'manager');
      let go;
      const gate = new Promise((resolve) => { go = resolve; });
      const flags = { keyHeld: false, deadlockTimeoutMs: null };
      // The save's transaction takes the role's key SHARED first and then calls the routine, whose own step-10b request for the
      // same key re-enters it: this only widens, deterministically, the window between the routine's key and its later steps.
      const saving = holding(owner, async (tx) => {
        await tx`set local lock_timeout = '10s'`;
        flags.deadlockTimeoutMs = Number((await tx`select (extract(epoch from pg_catalog.current_setting('deadlock_timeout')::interval) * 1000)::bigint::text as ms`)[0].ms);
        await tx`select pg_catalog.pg_advisory_xact_lock_shared(${GUARD_CLASS}::int4, ${K}::int4)`;
        flags.keyHeld = true;
        await gate;
        return create(f.kManager, f.S, f.T, f.C1, LINES, { db: tx, fn });
      });
      let writer = null;
      try {
        await until(() => flags.keyHeld || saving.out !== undefined, 'the save\'s transaction holds the key SHARED');
        assert.ok(flags.deadlockTimeoutMs > 0 && flags.deadlockTimeoutMs < 10_000,
          `the server's deadlock_timeout (${flags.deadlockTimeoutMs} ms) is below both sides' 10 s lock_timeout, so a cycle surfaces as 40P01, never 55P03`);
        writer = running(runtime, async (tx) => {
          await tx`set local lock_timeout = '10s'`;
          return setCustomers(own.key, 'manager', 'none', f.T, 0, tx);
        });
        await until(() => blockedBy(writer.pid, saving.pid), 'the Customers setter waits for the key behind the save');
        assert.deepEqual(await waitsFor(writer.pid), [['advisory', 'ExclusiveLock']], 'the setter waits on the key, EXCLUSIVE');
        const probe = await rolledBack((tx) => tx`select 1 from tmpos_role.tenant_role_level
          where tenant_id = ${f.T} and role_id = 'manager' and domain = 'customers' for share nowait`);
        assert.equal(probe.code, '55P03', `the waiting setter holds the Customers row FOR UPDATE (${JSON.stringify(probe)})`);
        go();
        if (deadlock) {
          await until(() => (saving.ready || saving.out !== undefined) && writer.out !== null, 'one side aborted, the other went on', 15_000);
          saving.release('rollback');
          const outs = { save: await saving.done, setter: await writer.done };
          evidence(st, { case: 'NC-iii create_v2', outs });
          const victims = Object.entries(outs).filter(([, o]) => o.code === '40P01').map(([k]) => k);
          assert.equal(victims.length, 1, `exactly one side is the deadlock victim (40P01), never a lock timeout: ${JSON.stringify(outs)}`);
          if (victims[0] === 'save') assert.deepEqual(outs.setter.value, [setterApplied(own, f.T, 'none', 1)], 'the setter then applied');
          else assert.equal(outs.save.outcome, 'rolled back', 'the save then answered (rolled back by the case)');
        } else {
          await until(() => saving.ready || saving.out !== undefined, 'the v3 save answered');
          evidence(st, { case: 'NC-iii create_v3', save: saving.value ?? saving.out });
          assert.deepEqual(saving.value, [saved(f.manager, f.T, f.S)], 'v3 completed while the setter held its row FOR UPDATE: no row lock after the key');
          assert.equal(await blockedBy(writer.pid, saving.pid), true, 'the setter still waits on the key');
          saving.release('commit');
          finished(await saving.done, 'the v3 save');
          assert.deepEqual(finished(await writer.done, 'the Customers setter').value, [setterApplied(own, f.T, 'none', 1)], 'then the setter applied — no 40P01');
        }
      } finally {
        go();
        saving.release('rollback');
        await saving.done;
        if (writer !== null) await writer.done;
      }
    });
  }
});

// ===========================================================================
// ICA-11 + CCA-11: privileges, dependencies and the routines' text
// ===========================================================================

/**
 * The objects 030, 031 and 032 own, and those they must leave as they found them: the schema, its functions (each with its
 * complete ACL in aclexplode form, the owner's entry included), the level table's triggers, 028's save.
 */
async function surface(db = owner) {
  const schema = (await db`select n.nspacl::text as acl, pg_catalog.obj_description(n.oid, 'pg_namespace') as comment
    from pg_catalog.pg_namespace n where n.nspname = 'tmpos_invoice_edit'`).map((r) => ({ ...r }));
  const functions = [];
  for (const r of await db`select p.oid::regprocedure::text as fn, pg_catalog.md5(p.prosrc) as src, p.provolatile::text as vol,
      p.prosecdef as definer, p.proconfig as config, p.proowner::regrole::text as owner, pg_catalog.obj_description(p.oid, 'pg_proc') as comment
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace where n.nspname = 'tmpos_invoice_edit' order by 1`) {
    functions.push({ ...r, grants: await grantsOf(r.fn, db) });
  }
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
/** The 031-era surface 032's rollback must leave: create_v3 and 032's trigger function and trigger gone, create_v2's EXECUTE tmpos_app's again. */
const surface031 = (with032) => ({
  schema: with032.schema,
  functions: with032.functions.filter((f) => f.fn !== CATALOG(CREATE_V3) && f.fn !== CUSTOMERS_GUARD)
    .map((f) => (f.fn === CATALOG(CREATE_V2) ? { ...f, grants: EXECUTE_BY(ME, 'tmpos_app') } : f)),
  triggers: with032.triggers.filter((g) => g.name !== CUSTOMERS_TRIGGER),
  save028: with032.save028,
});
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

test('ICA-11 + CCA-11 (AC-14 / AC-11, N): the runtime login executes create_v3 and neither create_v2 nor 028\'s save; create_v3\'s and create_v2\'s attributes, the complete ACLs, the schema\'s five functions, 032\'s trigger function; 032\'s postcondition holds, 031\'s only with 032 rolled back above it; the real preflight accepts the 001-033 database; 030\'s rollback on it (033 rolled back first in the same transaction) refused with 2BP01, catalog and ledger unchanged; create_v2 is 028\'s with exactly three changes and create_v3 is create_v2 with exactly the two design changes', async (t) => {
  await t.test('privileges: create_v3 executes for the runtime login; 42501 on create_v2 and on 028\'s save; the exact ACLs and attributes; the schema\'s five functions; the postconditions; the preflight accepts', async (st) => {
    const f = await scene('p11');
    const refused028 = await errorOf(create(f.kManager, f.S, f.T, f.C1, LINES, { fn: CREATE_FN_028 }));
    assert.equal(refused028?.code, '42501', `028's save, as the runtime login: ${JSON.stringify(refused028)}`);
    assert.match(refused028.message, /^permission denied for function m7b_invoice_draft_create$/);
    const refusedV2 = await errorOf(create(f.kManager, f.S, f.T, f.C1, LINES, { fn: CREATE_FN_V2 }));
    assert.equal(refusedV2?.code, '42501', `031's create_v2, as the runtime login (032 revoked it): ${JSON.stringify(refusedV2)}`);
    assert.match(refusedV2.message, /^permission denied for function m7b_invoice_draft_create_v2$/);
    assert.deepEqual(await create(f.kManager, f.S, f.T, f.C1, LINES), [saved(f.manager, f.T, f.S)], 'create_v3, as the runtime login: applied');
    const [can] = await owner`select
        pg_catalog.has_function_privilege(${RUNTIME_LOGIN}, ${CREATE_V3}::regprocedure, 'EXECUTE') as login_v3,
        pg_catalog.has_function_privilege(${RUNTIME_LOGIN}, ${CREATE_V2}::regprocedure, 'EXECUTE') as login_v2,
        pg_catalog.has_function_privilege(${RUNTIME_LOGIN}, ${CREATE_028}::regprocedure, 'EXECUTE') as login_028,
        pg_catalog.has_function_privilege(${RUNTIME_LOGIN}, ${CUSTOMERS_GUARD}::regprocedure, 'EXECUTE') as login_guard,
        pg_catalog.has_function_privilege('tmpos_audit_writer', ${CREATE_V3}::regprocedure, 'EXECUTE') as writer_v3,
        pg_catalog.has_function_privilege('anon', ${CREATE_V3}::regprocedure, 'EXECUTE') as anon_v3,
        pg_catalog.has_function_privilege('authenticated', ${CREATE_V3}::regprocedure, 'EXECUTE') as authenticated_v3,
        pg_catalog.has_function_privilege('tmpos_audit_writer', ${CREATE_V2}::regprocedure, 'EXECUTE') as writer_v2,
        pg_catalog.has_function_privilege('anon', ${CREATE_V2}::regprocedure, 'EXECUTE') as anon_v2,
        pg_catalog.has_function_privilege('authenticated', ${CREATE_V2}::regprocedure, 'EXECUTE') as authenticated_v2,
        pg_catalog.has_function_privilege('tmpos_audit_writer', ${CREATE_028}::regprocedure, 'EXECUTE') as writer_028,
        pg_catalog.has_function_privilege('anon', ${CREATE_028}::regprocedure, 'EXECUTE') as anon_028,
        pg_catalog.has_function_privilege('authenticated', ${CREATE_028}::regprocedure, 'EXECUTE') as authenticated_028`;
    assert.deepEqual({ ...can }, { login_v3: true, login_v2: false, login_028: false, login_guard: false, writer_v3: false, anon_v3: false, authenticated_v3: false,
      writer_v2: false, anon_v2: false, authenticated_v2: false, writer_028: false, anon_028: false, authenticated_028: false },
    'only the login (through tmpos_app) executes a save routine, and only create_v3');
    assert.deepEqual(await grantsOf(CREATE_V3), EXECUTE_BY(ME, 'tmpos_app'), 'create_v3: exactly the owner\'s and tmpos_app\'s EXECUTE, owner-granted, non-grantable (no PUBLIC)');
    assert.deepEqual(await grantsOf(CREATE_V2), EXECUTE_BY(ME), 'create_v2: exactly the owner\'s EXECUTE (032 revoked tmpos_app\'s)');
    assert.deepEqual(await grantsOf(CREATE_028), EXECUTE_BY(ME), '028\'s save: exactly the owner\'s EXECUTE');
    assert.deepEqual(await grantsOf(CUSTOMERS_GUARD), EXECUTE_BY(ME), '032\'s trigger function: exactly the owner\'s EXECUTE (granted to nobody)');
    const fns = (await owner`select p.oid::regprocedure::text as fn from pg_catalog.pg_proc p where p.pronamespace = 'tmpos_invoice_edit'::regnamespace`).map((r) => r.fn).sort();
    assert.deepEqual(fns, [CUSTOMERS_GUARD, CATALOG(CREATE_V2), CATALOG(CREATE_V3), CATALOG(UPDATE_V2), GUARD].sort(),
      'the schema holds exactly five functions: 030\'s edit and Invoices guard, 031\'s create_v2, 032\'s create_v3 and Customers guard');
    const attrs = async (signature, other) => {
      const [a] = await owner`select l.lanname::text as language, p.prosecdef as definer, p.provolatile::text as vol, p.proconfig as config,
          p.proowner::regrole::text as owner, pg_catalog.pg_get_function_arguments(p.oid) = pg_catalog.pg_get_function_arguments(${other}::regprocedure) as same_arguments,
          pg_catalog.pg_get_function_result(p.oid) = pg_catalog.pg_get_function_result(${other}::regprocedure) as same_result,
          pg_catalog.obj_description(p.oid, 'pg_proc') as comment
        from pg_catalog.pg_proc p join pg_catalog.pg_language l on l.oid = p.prolang where p.oid = ${signature}::regprocedure`;
      return { ...a };
    };
    const SAVE_ATTRS = { language: 'plpgsql', definer: true, vol: 'v', config: ['search_path=pg_catalog, pg_temp', 'row_security=off'], owner: ME, same_arguments: true, same_result: true };
    const v3 = await attrs(CREATE_V3, CREATE_V2);
    assert.deepEqual({ ...v3, comment: undefined }, { ...SAVE_ATTRS, comment: undefined }, 'create_v3: plpgsql, SECURITY DEFINER, VOLATILE, pinned, owned by the applier, create_v2\'s arguments and RETURNS TABLE');
    assert.equal(v3.comment, functionComment(UP_032, CREATE_V3), 'its comment is 032\'s');
    const v2 = await attrs(CREATE_V2, CREATE_028);
    assert.deepEqual({ ...v2, comment: undefined }, { ...SAVE_ATTRS, comment: undefined }, 'create_v2\'s attributes (028\'s arguments and RETURNS TABLE)');
    assert.equal(v2.comment, functionComment(UP_031, CREATE_V2), 'its comment is 031\'s');
    const [guard] = await owner`select l.lanname::text as language, p.prosecdef as definer, p.provolatile::text as vol, p.proconfig as config,
        p.proowner::regrole::text as owner, p.prorettype::regtype::text as returns, pg_catalog.obj_description(p.oid, 'pg_proc') as comment
      from pg_catalog.pg_proc p join pg_catalog.pg_language l on l.oid = p.prolang where p.oid = ${CUSTOMERS_GUARD}::regprocedure`;
    assert.deepEqual({ ...guard, comment: undefined }, { language: 'plpgsql', definer: false, vol: 'v', config: ['search_path=pg_catalog, pg_temp'], owner: ME, returns: 'trigger', comment: undefined },
      '032\'s trigger function: plpgsql, SECURITY INVOKER, VOLATILE, pinned, returns trigger, owned by the applier');
    assert.equal(guard.comment, functionComment(UP_032, CUSTOMERS_GUARD), 'its comment is 032\'s');
    assert.equal((await rolledBack((tx) => tx.unsafe(POSTCONDITION_032).simple())).code, undefined, '032\'s own postcondition holds over the applied chain');
    const on032 = await rolledBack((tx) => tx.unsafe(POSTCONDITION_031).simple());
    evidence(st, { case: 'CCA-11 031 postcondition over 032', on032 });
    assert.equal(on032.code, '55000', `031's postcondition refuses over 001-033: its exact inventory sees 032's objects (${JSON.stringify(on032)})`);
    assert.equal((await rolledBack(async (tx) => { await tx.unsafe(DOWN_033).simple(); await tx.unsafe(DOWN_032).simple(); await tx.unsafe(POSTCONDITION_031).simple(); })).code, undefined,
      '031\'s postcondition holds once 033 and 032 are rolled back above it (rolled back)');
    assert.deepEqual(await preflightVerdict(), { runtimeLogin: [], migrationLedger: [] }, 'the real preflight accepts the 001-033 database');
  });
  await t.test('030\'s rollback on the 001-033 database with 033 rolled back first (its anchor refuses every older down), run as rollBackAbove runs a down (its file and ledger row in one transaction), is REFUSED (2BP01); the catalog and the ledger unchanged', async (st) => {
    const before = { surface: await surface(), ledger: await ledgerRows() };
    assert.equal(before.surface.functions.length, 5, 'tmpos_invoice_edit holds v2, the Invoices guard, create_v2, create_v3 and the Customers guard');
    // The executor's down path for ONE version (tests/db/migrationsThrough.mjs rollBackAbove, the path IDE-21 uses for 030): the
    // down file and its ledger row's DELETE in one READ COMMITTED transaction — run for 030 alone, with 031 and 032 still applied
    // (033's down first, in the same transaction: while 033 is applied its anchor refuses every older down at the first drop).
    const refused = await errorOf(owner.begin(RC, async (tx) => {
      await tx.unsafe(DOWN_033).simple();
      await tx.unsafe(DOWN_030).simple();
      await tx`delete from public.schema_migrations where version = '030'`;
    }));
    evidence(st, { case: 'ICA-11 030 down', refused });
    assert.equal(refused?.code, '2BP01', `030's rollback refused for a dependent object: ${JSON.stringify(refused)}`);
    assert.match(refused.message, /^cannot drop schema tmpos_invoice_edit because other objects depend on it$/);
    for (const [what, re] of [['031\'s save routine', /function tmpos_invoice_edit\.m7b_invoice_draft_create_v2\(text,uuid,uuid,uuid,uuid,jsonb,bigint\) depends on schema tmpos_invoice_edit/],
      ['032\'s save routine', /function tmpos_invoice_edit\.m7b_invoice_draft_create_v3\(text,uuid,uuid,uuid,uuid,jsonb,bigint\) depends on schema tmpos_invoice_edit/],
      ['032\'s trigger function', /function tmpos_invoice_edit\.m7b_customers_level_guard\(\) depends on schema tmpos_invoice_edit/]]) {
      assert.match(refused.detail ?? '', re, `a dependent object is ${what}`);
    }
    assert.deepEqual(await surface(), before.surface, 'unchanged: the triggers, v2, the guard functions, create_v2, create_v3, the schema and every grant');
    assert.deepEqual(await ledgerRows(), before.ledger, 'unchanged: the ledger, 030\'s row included');
    assert.deepEqual(await preflightVerdict(), { runtimeLogin: [], migrationLedger: [] }, 'and the 001-033 runtime still accepts it');
  });
  await t.test('static: create_v2\'s code is 028\'s with exactly the three changes; create_v3\'s is create_v2\'s with exactly the two design changes; 032\'s trigger function is 030\'s with the domain customers; v3\'s key precedes both level reads, which precede the customer_not_found answer, with no level or version row locked and no role row written', async () => {
    const proSrc = async (sig) => (await owner`select p.prosrc as src from pg_catalog.pg_proc p where p.oid = ${sig}::regprocedure`)[0].src;
    const src028 = await proSrc(CREATE_028);
    const srcV2 = await proSrc(CREATE_V2);
    const srcV3 = await proSrc(CREATE_V3);
    assert.equal(srcV3, routineBody(UP_032, 'tmpos_invoice_edit', 'm7b_invoice_draft_create_v3'), 'the installed create_v3 is the 032 up file\'s body, character for character');
    assert.equal(srcV2, routineBody(UP_031, 'tmpos_invoice_edit', 'm7b_invoice_draft_create_v2'), 'the installed create_v2 is the 031 up file\'s body, character for character');
    assert.equal(src028, routineBody(UP_028, 'tmpos_invoice_draft', 'm7b_invoice_draft_create'), '028\'s save is still 028\'s body, character for character');
    // THE METHOD. Each body is read from pg_proc.prosrc. A line that is blank, or whose first non-blank characters are '--', is
    // dropped (the design lets the comments be reworded); every other line is kept whole, its indentation included, and no kept
    // line holds '--' anywhere (asserted), so no trailing comment survives and no code is dropped. Each change is then applied to
    // the older routine's kept lines as an exact edit, each edit first checking the lines it replaces or removes, the restated
    // statements built from the older routine's own lines where it already has them, and the result must equal the newer
    // routine's kept lines exactly.
    const codeOf = (body) => body.split('\n').filter((l) => l.trim() !== '' && !l.trim().startsWith('--'));
    const A = codeOf(src028);
    const B = codeOf(srcV2);
    const C = codeOf(srcV3);
    for (const [label, lines] of [['028', A], ['create_v2', B], ['create_v3', C]]) {
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

    // ---- create_v2 = 028 with exactly three changes (031) ----
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

    // ---- create_v3 = create_v2 with exactly the two design changes (032) ----
    // create_v2's own lines: 10b's Invoices-only decision (its last line, '  end if;', closes 10b's IF and stays), and the step
    // 11-12 block — the Customers anchor, the Customers read FOR SHARE, its not-found refusal, then both levels decided.
    const V2_10B_DECIDE = [DECIDE[0], DECIDE[1], `${DECIDE[2]} then`, ...DECIDE.slice(6)];
    const V2_STEPS_11_12 = [IF_EDITABLE,
      '    insert into tmpos_role.tenant_role_level (tenant_id, role_id, domain, level, updated_at)',
      "    values (v_tenant, v_role, 'customers', null, pg_catalog.now())", '    on conflict (tenant_id, role_id, domain) do nothing;',
      '    select l.level into v_customers', '      from tmpos_role.tenant_role_level l',
      "     where l.tenant_id = v_tenant and l.role_id = v_role and l.domain = 'customers'", '       for share;', '    if not found then',
      "      return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid;", '      return;', '    end if;'];
    const BOTH = [DECIDE[0], DECIDE[1], DECIDE[2], '       or coalesce(pg_catalog.array_position(c_levels,',
      "         coalesce(v_customers, case v_role when 'manager' then 'full' when 'technician' then 'view' when 'sales_staff' then 'create' end)), 0)",
      "       < pg_catalog.array_position(c_levels, 'view') then", ...DECIDE.slice(6)];
    const expected3 = [...B];
    const d10b = seqAt(expected3, [...V2_10B_DECIDE, '  end if;', '  if not v_customer_found then'], 'create_v2\'s 10b Invoices-only decision, before 10c');
    assert.ok(expected3.slice(0, d10b).includes(KEY), 'create_v2\'s 10b decision follows its key');
    const s1112 = seqAt(expected3, [...V2_STEPS_11_12, ...BOTH, '  end if;'], 'create_v2\'s steps 11-12, ending in the decision of both levels');
    assert.ok(s1112 > d10b, 'steps 11-12 follow 10b');
    // (−) steps 11-12 removed whole: the anchor INSERT, the FOR SHARE read, its refusal and the locked decision, with their IF.
    expected3.splice(s1112, V2_STEPS_11_12.length + BOTH.length + 1);
    // (~) 10b decides both levels: the Customers level read again by a PLAIN SELECT (12's read, without FOR SHARE), then 12's
    //     decision of both levels in place of the Invoices-only one; 10b's closing '  end if;' and 10c follow unchanged.
    expected3.splice(d10b, V2_10B_DECIDE.length, ...V2_STEPS_11_12.slice(4, 6), `${V2_STEPS_11_12[6]};`, ...BOTH);
    const firstDiff3 = C.findIndex((l, i) => l !== expected3[i]);
    assert.deepEqual(C, expected3, `create_v3 = create_v2's code with exactly the two changes (first difference at kept line ${firstDiff3}: ${JSON.stringify([C[firstDiff3], expected3[firstDiff3]])})`);

    // Their order and placement inside create_v3 (comments dropped).
    const code = C.join('\n');
    const once = (needle) => {
      const i = code.indexOf(needle);
      assert.ok(i >= 0, `${needle} is in create_v3`);
      assert.equal(code.indexOf(needle, i + 1), -1, `${needle} appears once`);
      return i;
    };
    const read10 = once('v_customer_found := exists (');
    const key = once('perform pg_catalog.pg_advisory_xact_lock_shared(530030, ');
    const clock = code.indexOf('v_now >= v_session.expires_at', key);
    const invoicesRead = code.indexOf("l.domain = 'invoices';", key);
    const customersRead = code.indexOf("l.domain = 'customers';", key);
    const decision = code.indexOf("< pg_catalog.array_position(c_levels, 'view') then", key);
    const notFound = once("return query select 'customer_not_found'::text");
    const customerLock = once('for key share');
    assert.ok(read10 < key, 'the key after the step-10 read');
    assert.ok(key < clock && clock < invoicesRead && invoicesRead < customersRead && customersRead < decision && decision < notFound,
      'then the clock, the Invoices read, the Customers read and the decision of both — all before the customer_not_found answer');
    assert.ok(notFound < customerLock, 'the customer\'s lock after the answer');
    const depthAt = (src, index) => {
      let depth = 0;
      for (const m of src.matchAll(/\b(begin|end)\b(\s*;)?/gi)) {
        if (m.index >= index) break;
        if (m[1].toLowerCase() === 'begin') depth += 1; else if (m[2] !== undefined) depth -= 1;
      }
      return depth;
    };
    for (const [what, i] of [['the key', key], ['the Invoices re-read', invoicesRead], ['the Customers re-read', customersRead], ['the customer_not_found answer', notFound]]) {
      assert.equal(depthAt(code, i), 1, `${what}: in the outermost block, no BEGIN ... EXCEPTION around it`);
    }
    assert.doesNotMatch(code.slice(key, notFound), /\b(?:begin|exception)\b/i, 'nothing between the key and the answer opens a block');
    // No role row written, no level or version row locked, no version row read: plain reads of the level table only.
    assert.doesNotMatch(code, /\binsert\s+into\s+tmpos_role/i, 'create_v3 inserts no role row (no Customers or Invoices anchor)');
    assert.doesNotMatch(code, /tmpos_role_edit|role_level_version/, 'no version row read or locked');
    const levelStatements = code.split(';').filter((s) => s.includes('tmpos_role.tenant_role_level'));
    assert.equal(levelStatements.length, 4, 'four reads of the level table: step 8\'s two and 10b\'s two');
    for (const s of levelStatements) assert.doesNotMatch(s, /\bfor\s+(?:share|update|key|no\s+key)\b/i, `a plain SELECT: ${s.trim().split('\n')[0]}`);
    // The key expression is the guard functions' (030's and 032's triggers), in the same class.
    const keyExpressions = (src) => [...src.matchAll(/pg_catalog\.hashtext\(([^()]*)\)/g)].map((m) => m[1]
      .replace(/\b(?:v_tenant|new\.tenant_id|old\.tenant_id)\b/g, '<tenant>').replace(/\b(?:v_role|new\.role_id|old\.role_id)\b/g, '<role>'));
    const advisory = (src) => [...src.matchAll(/pg_catalog\.(pg_[a-z_]*advisory[a-z_]*)\((\d+),/g)].map((m) => [m[1], m[2]]);
    const guardCode = codeOf(await proSrc(GUARD)).join('\n');
    const customersGuardLines = codeOf(await proSrc(CUSTOMERS_GUARD));
    const customersGuardCode = customersGuardLines.join('\n');
    const EXPRESSION = "<tenant>::text || '/' || <role>";
    assert.deepEqual(keyExpressions(code), [EXPRESSION], 'create_v3: one key expression, hashtext(tenant::text || \'/\' || role)');
    assert.deepEqual(keyExpressions(codeOf(srcV2).join('\n')), [EXPRESSION], 'create_v2: the same');
    assert.deepEqual([...new Set(keyExpressions(guardCode))], [EXPRESSION], '030\'s guard function: the same expression');
    assert.deepEqual([...new Set(keyExpressions(customersGuardCode))], [EXPRESSION], '032\'s guard function: the same expression');
    assert.deepEqual(advisory(code), [['pg_advisory_xact_lock_shared', '530030']], 'create_v3 takes the key SHARED, transaction-scoped, class 530030');
    assert.deepEqual([...new Set(advisory(guardCode).map(String))], ['pg_advisory_xact_lock,530030'], '030\'s guard function takes it EXCLUSIVE, class 530030');
    assert.deepEqual([...new Set(advisory(customersGuardCode).map(String))], ['pg_advisory_xact_lock,530030'], '032\'s guard function takes it EXCLUSIVE, class 530030');
    // 032's trigger function is 030's with the domain 'customers' in place of 'invoices' (and its own name in its message).
    assert.equal(await proSrc(CUSTOMERS_GUARD), routineBody(UP_032, 'tmpos_invoice_edit', 'm7b_customers_level_guard'), 'the installed trigger function is the 032 up file\'s body');
    assert.deepEqual(customersGuardLines, codeOf(await proSrc(GUARD)).map((l) => l.replace(/'invoices'/g, "'customers'").replace('m7b_invoice_level_guard', 'm7b_customers_level_guard')),
      '032\'s trigger function = 030\'s with \'customers\' for \'invoices\', line for line');
  });
});

// ===========================================================================
// ICA-10 + CCA-12: 032 down / up; 031 down / up / down; 032 -> 030 down and re-apply (last: it rolls them back)
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
/** `rows` without the draft `draft` and its lines. */
const without = (rows, draft) => ({ ...rows, drafts: rows.drafts.filter((d) => JSON.parse(d).draft_id !== draft), lines: rows.lines.filter((l) => JSON.parse(l).draft_id !== draft) });
/** The 030-era surface 031's rollback must leave: create_v2 gone, 028's ACL the owner's and tmpos_app's again, all else as with 031. */
const surface030 = (with031) => ({
  schema: with031.schema,
  functions: with031.functions.filter((f) => f.fn !== CATALOG(CREATE_V2)),
  triggers: with031.triggers,
  save028: { ...with031.save028, grants: EXECUTE_BY(ME, 'tmpos_app') },
});
const isGone = async (signature) => (await owner`select pg_catalog.to_regprocedure(${signature}) is null as gone`)[0].gone;

test('ICA-10 + CCA-12 (AC-13 / AC-12, N): over drafts at version 1 and above it, stored overrides of both domains, absent defaults, both setters\' version rows, audit, outbox and completions — with 032 applied 031\'s and 030\'s downs refused, nothing changed (033 rolled back first in each transaction); 032\'s down (after 033\'s) waits for in-flight work, leaves the exact 031-era surface and every row; its up refused when applied or its preconditions fail, waits for in-flight work; the upgrade 031 -> 033 changes no row; 031\'s own cycle with 033 and 032 rolled back first; 033 -> 032 -> 031 -> 030 down and 030, 031, 032, 033 re-applied complete', async (t) => {
  // The data: drafts at version 1 (the manager's — no role row of its own since 032 — and the owner's) and edited above it (by
  // the manager twice, by the owner once); stored overrides of both domains for the manager (an owner's writes) and through
  // BOTH real setters for the sales staff (their version rows); the technician's absent defaults; an audit record naming a
  // draft, an outbox event and two idempotency records — a sealed completion and an open lease (synthetic: 030, 031 and 032
  // never touch them, so every one must survive).
  const u = await scene('cycle', { managerLevel: 'edit' });
  const own = await tenantOwner(u.T, 'cycle');
  await setLevel(u.T, 'manager', 'customers', 'view');
  assert.deepEqual(await setInvoices(own.key, 'sales_staff', 'edit', u.T, 0), [setterApplied(own, u.T, 'edit', 1)], 'an Invoices version row made by the real setter');
  assert.deepEqual(await setCustomers(own.key, 'sales_staff', 'manage', u.T, 0), [setterApplied(own, u.T, 'manage', 1)], 'a Customers version row made by the real setter');
  await save(u.manager, u.kManager, u.S, u.T, u.C1);
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
  /** `pid` waits for exactly one ungranted lock: an ACCESS EXCLUSIVE relation lock on one of the seven tables. */
  const waitsOnASeven = async (pid, holder, what) => {
    const wait = await lockWaitOf(pid, holder);
    assert.equal(wait.ungranted.length, 1, `${what}: one ungranted lock (${JSON.stringify(wait.locks)})`);
    assert.deepEqual([wait.ungranted[0].locktype, wait.ungranted[0].mode], ['relation', 'AccessExclusiveLock'], `${what}: an ACCESS EXCLUSIVE relation lock`);
    const rel = wait.ungranted[0].rel.includes('.') ? wait.ungranted[0].rel : `public.${wait.ungranted[0].rel}`;
    assert.ok(WRITERS_ORDER.includes(rel), `${what}: on one of the seven (${rel})`);
  };
  /** A down or up file, run by `run(tx)` in a held owner transaction behind each in-flight `holders` entry; it must wait, then finish. */
  const behindInFlight = async (label, holders, run) => {
    for (const [what, holder] of holders) {
      const held = holder();
      let file = null;
      try {
        await until(() => held.ready || held.out !== undefined, `${label}: ${what} reached`);
        assert.equal(held.value?.[0]?.o_outcome, 'applied', `${label}: ${what} applied, uncommitted (${JSON.stringify(held.out ?? null)})`);
        file = holding(owner, run);
        await until(() => blockedBy(file.pid, held.pid), `${label} waits for ${what}`);
        await waitsOnASeven(file.pid, held.pid, `${label} behind ${what}`);
        assert.equal(file.ready, false, `${label} behind ${what}: nothing ran yet`);
        held.release('rollback');
        finished(await held.done, what, 'rolled back');
        await until(() => file.ready || file.out !== undefined, `${label} ran once ${what} ended`);
        assert.equal(file.ready, true, `${label} behind ${what}: ${JSON.stringify(file.out ?? null)}`);
        file.release('rollback');
        finished(await file.done, `${label} behind ${what}`, 'rolled back');
      } finally {
        held.release('rollback');
        await held.done;
        if (file !== null) { file.release('rollback'); await file.done; }
      }
    }
  };
  /**
   * A setter (`writerOf()`) queued on the key behind a held save (`saveOf()`), and `run` (a down) in a held owner transaction behind
   * both: the save ends, the setter takes the key and commits, the down then runs — the key never stands between a down and the
   * tables it locks. Rolled back.
   */
  const behindAConvoy = async (label, saveOf, writerOf, run) => {
    const heldSave = saveOf();
    let writer = null;
    let file = null;
    try {
      await until(() => heldSave.ready || heldSave.out !== undefined, `${label}, convoy: the save applied, uncommitted`);
      assert.equal(heldSave.value?.[0]?.o_outcome, 'applied', `${label}, convoy: ${JSON.stringify(heldSave.out ?? null)}`);
      writer = writerOf();
      await until(() => blockedBy(writer.pid, heldSave.pid), `${label}, convoy: the setter waits on the key behind the save`);
      assert.deepEqual(await waitsFor(writer.pid), [['advisory', 'ExclusiveLock']], `${label}, convoy: on the key`);
      file = holding(owner, run);
      await until(() => blockedBy(file.pid, heldSave.pid), `${label}, convoy: it waits behind the save`);
      await waitsOnASeven(file.pid, heldSave.pid, `${label}, convoy`);
      heldSave.release('commit');
      finished(await heldSave.done, `${label}, convoy: the save`);
      finished(await writer.done, `${label}, convoy: the setter`);
      await until(() => file.ready || file.out !== undefined, `${label}, convoy: it ran once both ended`);
      assert.equal(file.ready, true, `${label}, convoy: ${JSON.stringify(file.out ?? null)}`);
      file.release('rollback');
      finished(await file.done, `${label}, convoy`, 'rolled back');
    } finally {
      heldSave.release('rollback');
      await heldSave.done;
      if (writer !== null) await writer.done;
      if (file !== null) { file.release('rollback'); await file.done; }
    }
  };
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
      ['manager/customers/view', 'manager/invoices/edit', 'sales_staff/customers/manage', 'sales_staff/invoices/edit'],
      'stored overrides of both domains; no anchor of the manager\'s save (032); the technician absent');
    assert.deepEqual(rows0.versions.map((r) => JSON.parse(r)).map((r) => `${r.role_id}/${r.domain}/${r.version}`).sort(),
      ['sales_staff/customers/1', 'sales_staff/invoices/1'], 'both real setters\' version rows');
    assert.deepEqual([rows0.audits.length, rows0.events.length, rows0.records.length], [1, 1, 2], 'an audit record, an outbox event, a completion and a lease');
    assert.ok(JSON.parse(rows0.records.find((r) => JSON.parse(r).scope === scopes[0])).response !== null, 'a sealed completion');
    const with032 = await surface();
    assert.equal(with032.functions.length, 5);
    assert.deepEqual(with032.triggers.map((g) => [g.name, g.enabled]), [[CUSTOMERS_TRIGGER, 'A'], ['trg_tenant_role_level_invoice_guard', 'A'], ['trg_tenant_role_level_version_advance', 'A']]);
    const ledger032 = await ledgerRows();
    const w = await scene('k12');
    const wOwn = await tenantOwner(w.T, 'k12');
    const inFlightSave = (fn = CREATE_FN) => () => holding(runtime, (tx) => create(w.kManager, w.S, w.T, w.C1, LINES, { db: tx, fn }));
    const inFlightCustomersSetter = () => holding(runtime, (tx) => setCustomers(wOwn.key, 'manager', 'view', w.T, 0, tx));
    const inFlightInvoicesSetter = () => holding(runtime, (tx) => setInvoices(wOwn.key, 'manager', 'create', w.T, 0, tx));

    // ---- CCA-12, 032's own rollback ----
    // 0. With 032 applied: its up refused; 031's and 030's downs — each its down file and its ledger row's DELETE in one READ
    //    COMMITTED transaction, the shape rollBackAbove runs, after 033's down in the same transaction (while 033 is applied its anchor
    //    refuses every older down at the first drop, a different refusal from the one proved here) — REFUSED and nothing changed.
    assert.deepEqual(await rolledBack((tx) => tx.unsafe(UP_032).simple()),
      { code: '55000', message: 'migration 032 refused: tmpos_invoice_edit.m7b_invoice_draft_create_v3, tmpos_invoice_edit.m7b_customers_level_guard or the trigger trg_tenant_role_level_customers_guard already exists' });
    for (const [version, down, code, message] of [
      ['031', DOWN_031, '55000', /^migration 031 rollback refused: the save routine still exists, or schema tmpos_invoice_edit does not hold exactly migration 030's two functions$/],
      ['030', DOWN_030, '2BP01', /^cannot drop schema tmpos_invoice_edit because other objects depend on it$/],
    ]) {
      const refused = await errorOf(owner.begin(RC, async (tx) => {
        await tx.unsafe(DOWN_033).simple();
        await tx.unsafe(down).simple();
        await tx`delete from public.schema_migrations where version = ${version}`;
      }));
      evidence(t, { case: `CCA-12 ${version} down while 032 is applied`, refused });
      assert.equal(refused?.code, code, `${version}'s rollback refused while 032 is applied: ${JSON.stringify(refused)}`);
      assert.match(refused.message, message);
      assert.deepEqual(await surface(), with032, `${version}'s refused rollback changed nothing in the catalog`);
      assert.deepEqual(await rowsOf([u.T]), rows0, `${version}'s refused rollback changed no row`);
      assert.deepEqual(await ledgerRows(), ledger032, `${version}'s refused rollback changed no ledger row`);
    }
    // 1. 032's DOWN (after 033's, whose lock block takes the same seven locks first, in the same order) waits for an in-flight save
    //    (create_v3) and an in-flight REAL Customers setter, and finishes (rolled back; inside it the exact 031-era surface and every
    //    row identical).
    let inside = null;
    await behindInFlight('033\'s and 032\'s downs', [['an in-flight save (create_v3)', inFlightSave()], ['an in-flight REAL Customers setter', inFlightCustomersSetter]],
      async (tx) => {
        await tx.unsafe(DOWN_033).simple();
        await tx.unsafe(DOWN_032).simple();
        inside = { surface: await surface(tx), rows: await rowsOf([u.T], tx) };
        assert.deepEqual(inside.surface, surface031(with032), '032\'s down, inside it: the exact 031-era surface');
        assert.deepEqual(inside.rows, rows0, '032\'s down, inside it: every row identical');
      });
    assert.deepEqual(await surface(), with032, 'every 033 and 032 down rolled back: 032 as it was');

    // 2. 033's and then 032's DOWN by the executor's down path (each its down file and its ledger row, one READ COMMITTED transaction).
    const { rolledBack: undone032, restore: restore032 } = await rollBackAbove(owner, MIG_DIR, '031');
    let restored032 = false;
    let rows1;
    try {
      assert.deepEqual(undone032, ['033', '032'], 'only 033 and 032 sit above 031');
      assert.deepEqual(await rowsOf([u.T]), rows0, 'every draft, line, level, version, audit, outbox and idempotency row identical');
      assert.deepEqual(await surface(), surface031(with032), 'the exact 031-era surface: create_v3, 032\'s trigger function and trigger gone; create_v2\'s EXECUTE tmpos_app\'s again; 030\'s and 031\'s functions (bodies, ACLs, attributes, comments), the schema, the two triggers and 028\'s save as they were');
      assert.deepEqual([await isGone(CREATE_V3), await isGone(CUSTOMERS_GUARD)], [true, true], 'create_v3 and the Customers guard gone');
      assert.deepEqual((await surface()).triggers.map((g) => g.enabled), ['A', 'A'], 'both remaining triggers ENABLE ALWAYS');
      assert.equal((await rolledBack((tx) => tx.unsafe(POSTCONDITION_031).simple())).code, undefined, '031\'s own postcondition holds again');
      assert.deepEqual(await preflightVerdict(), { runtimeLogin: ['role_privilege_missing', 'role_privilege_unexpected'], migrationLedger: ['migration_missing'] },
        'the 001-033 runtime refuses what is left: create_v3\'s and 033\'s routines\' EXECUTE missing, create_v2\'s and 028\'s page\'s and get\'s not approved, 032 and 033 not recorded');
      const gone = await errorOf(create(u.kManager, u.S, u.T, u.C1));
      assert.equal(gone?.code, '42883', `create_v3 no longer exists (${JSON.stringify(gone)})`);
      const atV2 = await save(u.manager, u.kManager, u.S, u.T, u.C2, [line('Saved at 031', 1, 1)], { fn: CREATE_FN_V2 });
      rows1 = await rowsOf([u.T]);
      assert.deepEqual(without(rows1, atV2), rows0, 'create_v2 is the save the login executes again (the DA-211 window restored); it changed nothing but its own draft and lines (the manager\'s Customers row exists)');
      assert.deepEqual(await rolledBack((tx) => tx.unsafe(DOWN_032).simple()), { code: '55000',
        message: 'migration 032 rollback refused: migration 032 is not applied (tmpos_invoice_edit.m7b_invoice_draft_create_v3, tmpos_invoice_edit.m7b_customers_level_guard or trg_tenant_role_level_customers_guard is missing)' },
      'a second 032 down is refused');

      // 3. 032's UP refuses (rolled back) when its preconditions fail.
      const TRIGGERS_032 = 'migration 032 refused: tmpos_role.tenant_role_level does not carry exactly 021\'s version trigger and 030\'s guard trigger, each in its exact shape and enabled ALWAYS';
      const ACL_032 = 'migration 032 refused: the applying principal does not own 031\'s save routine, or tmpos_app\'s EXECUTE on it is not the one non-grantable entry 031 issued';
      for (const [what, first, message] of [
        ['030\'s guard trigger disabled', 'alter table tmpos_role.tenant_role_level disable trigger trg_tenant_role_level_invoice_guard', TRIGGERS_032],
        ['an extra trigger on the level table', 'create trigger trg_tenant_role_level_zz_extra after update on tmpos_role.tenant_role_level for each row execute function tmpos_role_edit.m7a_role_level_version_advance()', TRIGGERS_032],
        ['create_v2\'s ACL widened (tmpos_audit_writer)', `grant execute on function ${CREATE_V2} to tmpos_audit_writer`, ACL_032],
      ]) {
        const refused = await rolledBack(async (tx) => { await tx.unsafe(first); await tx.unsafe(UP_032).simple(); });
        assert.deepEqual(refused, { code: '55000', message }, `032's up refused: ${what}`);
      }
      assert.deepEqual(await surface(), surface031(with032), 'every refusal rolled back: the 031-era surface as it was');

      // 4. 032's UP waits for an in-flight save (create_v2, the login's at 031) and an in-flight REAL Customers setter, and
      //    finishes (rolled back each time; 032 stays down).
      await behindInFlight('032\'s up', [['an in-flight save (create_v2)', inFlightSave(CREATE_FN_V2)], ['an in-flight REAL Customers setter', inFlightCustomersSetter]],
        (tx) => tx.unsafe(UP_032).simple());
      assert.equal(await isGone(CREATE_V3), true, 'every 032 up rolled back: still no create_v3');

      // 4b. [ICA-10 at the 031-era] 031's DOWN itself waits for an in-flight save (create_v2, the login's at 031), an in-flight
      //     REAL Invoices setter, and an Invoices setter queued on the key behind a held save, and finishes (rolled back each
      //     time; 031 stays applied). Inside it: the exact 030-era surface and every row identical.
      const d = await scene('k10down');
      const dOwn = await tenantOwner(d.T, 'k10down');
      const down031 = async (tx) => {
        await tx.unsafe(DOWN_031).simple();
        inside = { surface: await surface(tx), rows: await rowsOf([u.T], tx) };
        assert.deepEqual(inside.surface, surface030(surface031(with032)), '031\'s down, inside it: the exact 030-era surface');
        assert.deepEqual(inside.rows, rows1, '031\'s down, inside it: every row of the cycle\'s tenant identical');
      };
      const savingAt031 = () => holding(runtime, (tx) => create(d.kManager, d.S, d.T, d.C1, LINES, { db: tx, fn: CREATE_FN_V2 }));
      await behindInFlight('031\'s down', [['an in-flight save (create_v2)', savingAt031],
        ['an in-flight REAL Invoices setter', () => holding(runtime, (tx) => setInvoices(dOwn.key, 'manager', 'create', d.T, 0, tx))]], down031);
      await behindAConvoy('031\'s down', savingAt031, () => running(runtime, (tx) => setInvoices(dOwn.key, 'manager', 'create', d.T, 0, tx)), down031);
      assert.deepEqual(await rowsOf([u.T]), rows1, 'every 031 down rolled back: every row of the cycle\'s tenant identical');
      assert.deepEqual(await surface(), surface031(with032), 'every 031 down rolled back: the 031-era surface as it was');

      // 5. THE UPGRADE 031 -> 033 by the trusted executor: no row changes, the same surface the first apply left.
      const upgrade = await trustedApply();
      assert.deepEqual([upgrade.outcome, upgrade.applied], ['complete', ['032', '033']], JSON.stringify(upgrade).slice(0, 300));
      restored032 = true;
      assert.deepEqual(await rowsOf([u.T]), rows1, 'every draft, line, level, version, audit, outbox and idempotency row identical across the upgrade');
      assert.deepEqual(await surface(), with032, 'the same schema, functions (bodies, grants, attributes, comments), triggers and 028 ACL as the first apply left');
      assert.deepEqual((await ledgerRows()).map((x) => [x.version, x.checksum]), REQUIRED_MIGRATIONS.map((m) => [m.version, m.checksum]), 'the ledger is 001-033 again');
      assert.deepEqual(await preflightVerdict(), { runtimeLogin: [], migrationLedger: [] }, 'accepted again');
      assert.equal((await rolledBack((tx) => tx.unsafe(POSTCONDITION_032).simple())).code, undefined, '032\'s postcondition holds again');
      assert.equal((await errorOf(create(u.kManager, u.S, u.T, u.C1, LINES, { fn: CREATE_FN_V2 })))?.code, '42501', 'create_v2 closed to the login again');
    } finally {
      if (!restored032) await restore032();
    }

    // ---- ICA-10, 031's own cycle: 033 and 032 roll back first ----
    const rows2 = await rowsOf([u.T]);
    const with031 = surface031(with032);
    // 0. 031's UP over the applied chain is refused.
    assert.deepEqual(await rolledBack((tx) => tx.unsafe(UP_031).simple()), { code: '55000', message: 'migration 031 refused: tmpos_invoice_edit.m7b_invoice_draft_create_v2 already exists' });
    // 1. THE DOWN, by the executor's down path: 033's down file and ledger row, then 032's, then 031's, each one READ COMMITTED transaction.
    const { rolledBack: undone, restore } = await rollBackAbove(owner, MIG_DIR, '030');
    let restored = false;
    try {
      assert.deepEqual(undone, ['033', '032', '031'], '033 rolls back first, then 032, then 031');
      assert.deepEqual(await rowsOf([u.T]), rows2, 'every draft, line, level, version, audit, outbox and idempotency row identical');
      assert.deepEqual(await surface(), surface030(with031), 'the exact 030-era surface: create_v2 and create_v3 gone; tmpos_invoice_edit exactly 030\'s two functions (bodies, ACLs, attributes, comments), its ACL and comment; the two triggers; 028\'s save the owner\'s and tmpos_app\'s again');
      assert.deepEqual([await isGone(CREATE_V2), await isGone(CREATE_V3)], [true, true], 'create_v2 and create_v3 gone');
      assert.deepEqual((await surface()).triggers.map((g) => g.enabled), ['A', 'A'], 'both triggers ENABLE ALWAYS');
      assert.equal((await rolledBack((tx) => tx.unsafe(POSTCONDITION_030).simple())).code, undefined, '030\'s own postcondition holds again');
      assert.deepEqual(await preflightVerdict(), { runtimeLogin: ['role_privilege_missing', 'role_privilege_unexpected'], migrationLedger: ['migration_missing'] },
        'the 001-033 runtime refuses what is left: create_v3\'s and 033\'s routines\' EXECUTE missing, 028\'s create\'s, page\'s and get\'s not approved, 031, 032 and 033 not recorded');
      const gone = await errorOf(create(u.kManager, u.S, u.T, u.C1));
      assert.equal(gone?.code, '42883', `create_v3 no longer exists (${JSON.stringify(gone)})`);
      const at030 = await save(u.manager, u.kManager, u.S, u.T, u.C2, [line('Saved at 030', 1, 1)], { fn: CREATE_FN_028 });
      const rows3 = await rowsOf([u.T]);
      assert.deepEqual(without(rows3, at030), rows2, '028\'s save is the one the login executes again; it changed nothing but its own draft and lines (the manager\'s rows exist)');
      const second = await rolledBack((tx) => tx.unsafe(DOWN_031).simple());
      assert.equal(second.code, '55000', 'a second 031 down is refused');
      assert.equal(second.message, 'migration 031 rollback refused: migration 031 is not applied (tmpos_invoice_edit.m7b_invoice_draft_create_v2 is missing)');

      // 2. 031's UP refuses (rolled back) when its preconditions fail.
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
        assert.deepEqual(refused, { code: '55000', message }, `031's up refused: ${what}`);
      }
      assert.deepEqual(await surface(), surface030(with031), 'every refusal rolled back: the 030-era surface as it was');

      // 3. 031's UP waits for an in-flight save (028's, the login's at 030) and an in-flight REAL Invoices setter, and finishes
      //    (rolled back each time; 031 stays down).
      await behindInFlight('031\'s up', [['an in-flight save (028\'s)', inFlightSave(CREATE_FN_028)], ['an in-flight REAL Invoices setter', inFlightInvoicesSetter]],
        (tx) => tx.unsafe(UP_031).simple());
      assert.deepEqual([await isGone(CREATE_V2), await isGone(CREATE_V3)], [true, true], 'every proof rolled back: still no create_v2 or create_v3');

      // 4. THE UPGRADE 030 -> 033 by the trusted executor: no row changes, the same surface the first apply left.
      const upgrade = await trustedApply();
      assert.deepEqual([upgrade.outcome, upgrade.applied], ['complete', ['031', '032', '033']], JSON.stringify(upgrade).slice(0, 300));
      restored = true;
      assert.deepEqual(await rowsOf([u.T]), rows3, 'every draft, line, level, version, audit, outbox and idempotency row identical across the upgrade');
      assert.deepEqual(await surface(), with032, 'the same schema, functions (bodies, grants, attributes, comments), triggers and 028 ACL as the first apply left');
      const ledger = await owner`select version, checksum from public.schema_migrations order by version`;
      assert.deepEqual(ledger.map((x) => [x.version, x.checksum]), REQUIRED_MIGRATIONS.map((m) => [m.version, m.checksum]), 'the ledger is 001-033 again');
      assert.equal(ledger.at(-1).version, '033');
      assert.deepEqual(await preflightVerdict(), { runtimeLogin: [], migrationLedger: [] }, 'accepted again');
      assert.equal((await rolledBack((tx) => tx.unsafe(POSTCONDITION_032).simple())).code, undefined, '032\'s postcondition holds again');
      assert.equal((await errorOf(create(u.kManager, u.S, u.T, u.C1, LINES, { fn: CREATE_FN_028 })))?.code, '42501', '028\'s save closed to the login again');
      await save(u.manager, u.kManager, u.S, u.T, u.C1, [line('Saved at 032 again', 1, 1)]);

      // 5. THE DOWN of 033, 032 and 031 again waits for an in-flight save (create_v3), an in-flight setter, and a setter queued on the
      //    key behind a held save, and finishes — no deadlock (rolled back each time: all stay applied). Inside it: the
      //    030-era surface and every row identical.
      const rowsBeforeDown = await rowsOf([u.T]);
      const downBoth = async (tx) => {
        await tx.unsafe(DOWN_033).simple();
        await tx.unsafe(DOWN_032).simple();
        await tx.unsafe(DOWN_031).simple();
        inside = { surface: await surface(tx), rows: await rowsOf([u.T], tx) };
        assert.deepEqual(inside.surface, surface030(with031), 'inside the downs: the exact 030-era surface');
        assert.deepEqual(inside.rows, rowsBeforeDown, 'inside the downs: every row of the cycle\'s tenant identical');
      };
      await behindInFlight('033\'s, 032\'s and 031\'s downs', [['an in-flight save (create_v3)', inFlightSave()], ['an in-flight REAL Invoices setter', inFlightInvoicesSetter]], downBoth);
      await behindAConvoy('033\'s, 032\'s and 031\'s downs', inFlightSave(), () => running(runtime, (tx) => setCustomers(wOwn.key, 'manager', 'view', w.T, 0, tx)), downBoth);
      assert.deepEqual(await rowsOf([u.T]), rowsBeforeDown, 'every down rolled back: every row of the cycle\'s tenant identical');
      assert.deepEqual(await surface(), with032, 'every down rolled back: 031, 032 and 033 as they were');
      assert.deepEqual(await preflightVerdict(), { runtimeLogin: [], migrationLedger: [] }, 'and the 001-033 runtime accepts it');
    } finally {
      if (!restored) await restore();
    }

    // ---- CCA-12: 033 -> 032 -> 031 -> 030 down, and 030, 031, 032, 033 re-applied by the trusted executor ----
    const rows4 = await rowsOf([u.T]);
    const { rolledBack: undoneAll, restore: restoreAll } = await rollBackAbove(owner, MIG_DIR, '029');
    let restoredAll = false;
    try {
      assert.deepEqual(undoneAll, ['033', '032', '031', '030'], '033, then 032, then 031, then 030');
      assert.deepEqual(await rowsOf([u.T]), rows4, 'every draft (edited ones included), line, level, version, audit, outbox and idempotency row identical with 030 rolled back too');
      assert.equal((await owner`select pg_catalog.to_regnamespace('tmpos_invoice_edit') is null as gone`)[0].gone, true, '030\'s schema gone');
      assert.deepEqual((await owner`select g.tgname::text as name from pg_catalog.pg_trigger g where g.tgrelid = 'tmpos_role.tenant_role_level'::regclass and not g.tgisinternal`).map((r) => r.name),
        ['trg_tenant_role_level_version_advance'], 'only 021\'s trigger remains on the level table');
      const reapply = await trustedApply();
      assert.deepEqual([reapply.outcome, reapply.applied], ['complete', ['030', '031', '032', '033']], JSON.stringify(reapply).slice(0, 300));
      restoredAll = true;
      assert.deepEqual(await rowsOf([u.T]), rows4, 'every row identical across the re-apply');
      assert.deepEqual(await surface(), with032, 'the same surface as the first apply');
      assert.deepEqual((await ledgerRows()).map((x) => [x.version, x.checksum]), REQUIRED_MIGRATIONS.map((m) => [m.version, m.checksum]), 'the ledger is 001-033 again');
      assert.deepEqual(await preflightVerdict(), { runtimeLogin: [], migrationLedger: [] }, 'accepted');
      assert.equal((await rolledBack((tx) => tx.unsafe(POSTCONDITION_032).simple())).code, undefined, '032\'s postcondition holds');
      await save(u.manager, u.kManager, u.S, u.T, u.C1, [line('Saved after the re-apply', 1, 1)]);
    } finally {
      if (!restoredAll) await restoreAll();
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

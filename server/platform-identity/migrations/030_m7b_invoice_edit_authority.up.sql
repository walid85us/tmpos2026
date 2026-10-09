-- Phase 4.0 M7b — holding the Invoices Edit authority through every newly sealed outcome of the invoice-draft edit: one
-- transaction-scoped advisory key per (tenant, role) that the edit takes SHARED and that every writer of an Invoices level
-- takes EXCLUSIVE through one row trigger, and the edit routine re-issued with that key in place of its change-path-only role
-- row lock (M7B-INVOICES-P2-R1; DA-204; G-IAM, G-ISOLATION, G-DBROLE; docs/phase-4/05, 08, 10)
-- Migration: 030_m7b_invoice_edit_authority (UP)
--
-- SCOPE / TRUTH (binding):
--   - ONE SCHEMA, TWO FUNCTIONS, ONE TRIGGER, THREE PRIVILEGE CHANGES. Schema tmpos_invoice_edit (owned by the applying
--     principal; USAGE granted to tmpos_app alone, beside its owner's own) holds exactly the trigger function
--     m7b_invoice_level_guard() and the edit routine m7b_invoice_draft_update_v2. The trigger trg_tenant_role_level_invoice_guard
--     (AFTER INSERT OR UPDATE OR DELETE, FOR EACH ROW, ENABLE ALWAYS) on tmpos_role.tenant_role_level calls the first. The three
--     privilege changes: tmpos_app gains USAGE on the schema and EXECUTE on the second, and loses its EXECUTE on 029's
--     tmpos_invoice_draft.m7b_invoice_draft_update.
--     NO TABLE, COLUMN, INDEX, ROW, ROLE, MEMBERSHIP, POLICY OR TYPE; no comment on an earlier object; no privilege on any table. 001-029 stay byte for byte as committed (the
--     migration-files contract's pinned checksums prove that); 029's routine and trigger stay where they are, unaltered.
--   - WHY IT EXISTS (DA-204). 029's m7b_invoice_draft_update decides the role's Invoices level at Edit ONCE, UNLOCKED (its
--     step 3), and decides it again on a locked value only on the change path (its step 10: the role's row made to exist and
--     held FOR SHARE). Its sealed answers — 'invalid_state', 'conflict' and 'unchanged' — return before step 10, so an owner's
--     narrowing of the level below Edit that commits after step 3 (while the edit waits on the draft header, say) still let the
--     edit seal one of them and commit its idempotency completion; the runtime's in-transaction revalidator reads the levels
--     unlocked too. The stage's contract is the opposite: current authority stays valid and protected through every newly
--     sealed outcome. Step 10 cannot simply move earlier: it INSERTs the role's row when there is none (a lock anchor), and a
--     no-op or a conflict must create no configuration row, advance no version, change no draft and write no audit record or
--     event; and a read that finds no row protects nothing about that absence at READ COMMITTED.
--   - THE GUARD: A TRANSACTION-SCOPED ADVISORY KEY PER (TENANT, ROLE). pg_catalog.pg_advisory_xact_lock{,_shared}(530030,
--     pg_catalog.hashtext(<tenant>::text || '/' || <role>)) — the two-integer form (pg_locks: classid 530030, objid the hash,
--     objsubid 2), a space distinct from the migration runner's single-bigint session key (objsubid 1) and from the test suites'
--     parking keys. Taken in a transaction it is released at that transaction's COMMIT or ROLLBACK, so it cannot outlive the
--     command transaction. It is the primitive that orders a reader of a value against its writers when the value's row may
--     not exist: a role without an override has NO row (the catalog default applies, and a no-op may not make one). No durable
--     row can serve instead (see WHY NOT A ROW). Two (tenant, role) pairs whose hashes collide are merely serialized:
--     availability, never authority. The key is derived INLINE, with the same expression, in the trigger function and in the
--     routine, and in no helper: a SECURITY INVOKER trigger function that called a function of this schema would run that call
--     as the WRITER, who need not be the schema's owner (029 admits an applier that only inherits the table's owner), and every
--     Invoices level write would then fail with 42501.
--   - EVERY WRITER PARTICIPATES, BY A TRIGGER ON THE TABLE, not by editing a writer: 026's setter is frozen, and the table's
--     owner and any older or later path write the table directly. trg_tenant_role_level_invoice_guard is AFTER INSERT OR UPDATE
--     OR DELETE, FOR EACH ROW, ENABLE ALWAYS (021's form: a session running as a replica meets it too), no column list, no WHEN.
--     It takes the key EXCLUSIVE for
--       * an INSERT of a row whose domain is 'invoices' and whose level is NOT NULL: the NEW row's key;
--       * an UPDATE of a row whose OLD or NEW domain is 'invoices': the OLD row's key and, when the update moved the row to
--         another (tenant, role), the NEW row's too — the smaller integer first, so two single-row key-moving UPDATE statements
--         cannot deadlock on each other's keys (the order is within one row's firing; it does not order keys across the rows
--         or statements of one transaction: see WHAT THIS DOES NOT DEFEND);
--       * a DELETE of a row whose domain is 'invoices' and whose level is NOT NULL: the OLD row's key;
--     and takes NOTHING otherwise. In particular the INSERT of a NULL level — the lock anchors of 026's setter (its first
--     write), of 028's create and of 029's edit — and the DELETE of a NULL row (028's rollback) take no key: NULL is the
--     catalog default, exactly what an absent row means, so such a write changes no effective level (and a key there would
--     serialize every draft save of a role). An update to or from NULL is an UPDATE and takes it; a reset to the default is
--     an UPDATE to the default word (026), so it takes it. 026's setter therefore takes the key at its level UPDATE, after its
--     role row FOR UPDATE and its version row FOR UPDATE — except that on a role's FIRST level change no version row exists: the
--     setter's FOR UPDATE finds none, and 021's AFTER trigger, which fires after this one (triggers fire in name order),
--     INSERTS the version row after the key.
--     AFTER, not BEFORE (021's reason, and one more): a BEFORE INSERT trigger would take the key BEFORE the primary key's
--     uniqueness check, so a raw INSERT of a level racing 026's first insertion (its uncommitted NULL anchor) would hold the key
--     while waiting for that transaction, which in turn waits for the key — a deadlock. An AFTER ROW trigger fires only for a
--     row actually written (an INSERT skipped by ON CONFLICT DO NOTHING takes nothing), at the end of the writing statement and
--     still before COMMIT. TRUNCATE fires no row trigger; it is ordered by a relation lock instead: the edit reads the table by
--     plain SELECTs, whose ACCESS SHARE is held to COMMIT, and TRUNCATE needs ACCESS EXCLUSIVE (owner-only: tmpos_app holds no
--     TRUNCATE). That is an invariant of the routine below — it reads the table by plain SELECT, never FOR SHARE or FOR UPDATE.
--   - THE EDIT, tmpos_invoice_edit.m7b_invoice_draft_update_v2: 029's routine with its signature, its RETURNS TABLE, its answers
--     and attributes (plpgsql, SECURITY DEFINER, VOLATILE, search_path pg_catalog then pg_temp, row_security off) and every
--     statement and every raised message of its body character for character, EXCEPT EXACTLY TWO CHANGES:
--       (+) STEP 5b, right after the header FOR UPDATE and its clock check and before step 6. For manager, technician and
--           sales_staff: the role's key SHARED (pg_advisory_xact_lock_shared); the session's clock again (the wait may have been
--           long: expired is ('refused', NULLs)); the Invoices level read again by a plain SELECT and decided exactly as step 3
--           decides it (the stored level, else the catalog default; below Edit is ('refused', NULLs)). Nothing is inserted or row
--           locked. store_owner is Full by the catalog, never stored: no key, no read. Every sealed answer ('invalid_state',
--           'conflict', 'unchanged') and the change path are decided AFTER 5b and committed while the key is held — the lock is
--           released only by the command transaction's COMMIT or ROLLBACK, i.e. after the runtime's audit record, outbox event
--           and idempotency completion. Step 3 (unlocked) stays as an early pre-check that refuses before the header is locked;
--           5b is the decision of record. The three statements of 5b are SEPARATE and sit in the routine's OUTERMOST block,
--           never inside a BEGIN ... EXCEPTION block (a subtransaction that aborts releases a transaction-scoped advisory
--           lock), and the re-read is a fresh READ COMMITTED snapshot because the routine is VOLATILE and refuses any other
--           isolation (step 0): both are load-bearing, as in 019's, 020's, 024's, 028's and 029's reasoning.
--       (-) STEP 10 REMOVED (the change path's INSERT-if-missing anchor and the role row FOR SHARE with its re-decision).
--           REQUIRED, not cosmetic: with the trigger, a level writer's order is role row FOR UPDATE, version row FOR UPDATE (none yet on
--           a role's first level change), THEN the key EXCLUSIVE; an edit holding the key SHARED that then waited for the role row FOR SHARE (or for the anchor's
--           INSERT behind the writer's uncommitted one) would close a cycle, and PostgreSQL would abort one side. After 5b the
--           level cannot change until COMMIT, so step 10's re-decision is redundant. The edit now writes no role row at all:
--           029's DA-36 (an anchor written before a refusal) does not arise for it.
--     A new routine, not a replacement of 029's — 018, 020, 021, 023 and 024 each superseded a routine this way: the new name
--     carries the new contract, tmpos_app's EXECUTE on the old one is revoked, and 029's routine stays byte for byte in place,
--     so the rollback restores 029's exact contract by granting that EXECUTE again. In its own schema, because 029's
--     postcondition and its rollback's pin the exact inventory of tmpos_invoice_draft.
--   - THE ORDERING (the stage's contract). A downgrade that commits before 5b's key is granted is read by 5b's fresh SELECT: the
--     edit answers ('refused', NULLs) and the runtime rolls the command transaction back — no completion, no configuration row,
--     no draft change, no audit record, no event — which is the existing transaction-time refusal (the generic 503, the lease
--     kept). A writer cannot COMMIT an Invoices change while an edit holds the key — the key is held through the edit's audit
--     record, event and completion until its COMMIT or ROLLBACK (a waiting writer may instead time out and roll back). A request
--     that completed before a downgrade stays completed; a replay is judged by the chain's unlocked current-authority check as
--     before — this file adds no lock to a replay.
--   - LOCK ORDER (every participant; the fence, 016's hold, session and ledger, issuer order of every tenant write is unchanged):
--       the edit (v2):     fence -> 016's hold (account FOR UPDATE; links, grants, tenants, stores FOR SHARE) -> session and ledger
--                          rows -> issuer key row -> store row -> draft header FOR UPDATE -> [5b] THE KEY, SHARED -> the
--                          replacement customer FOR KEY SHARE -> the lines. It never waits for a role row or a version row.
--       026's setter:      fence -> 016's hold -> session, ledger, issuer -> role row (anchor inserted, then FOR UPDATE) -> version
--                          row FOR UPDATE (none on a role's first level change) -> [the trigger, at its level UPDATE] THE KEY,
--                          EXCLUSIVE -> 021's trigger's upsert of the version row (the row it already holds; on a first level
--                          change an INSERT, after the key). It never waits for a header, a customer or a line.
--       028's create:      ... -> role rows (NULL anchors, FOR SHARE: no key) -> customer -> the new draft's rows.
--       024's customer edit: ... -> Customers role row (anchor + FOR SHARE) -> customer FOR UPDATE; never takes the key.
--     WHY IT CANNOT CYCLE: the key adds three kinds of wait edge only — an edit behind a writer's EXCLUSIVE, a writer behind
--     edits' SHARED, and a writer behind another writer's EXCLUSIVE. After its UPDATE the writer touches only the version row
--     (the one it holds; on a role's first level change the one its own trigger inserts — only a holder of that role row, or
--     the table owner, can write a version row, and an edit never waits for a role row or a version row), its own audit, outbox
--     and completion rows and the clock, none of which an edit holds; after 5b an edit waits only for a customer (a customer
--     edit's FOR UPDATE, which never touches an Invoices row or the key), its own lines and its own record, none of which a
--     writer holds; two edits of one draft serialize on the header before either takes the key, and two edits of one actor on
--     the account before that; SHARED keys are compatible; a create never takes the key. Writer behind writer: a writer takes a
--     pair's key only in this AFTER ROW trigger, so only once its statement has written a row whose OLD or NEW (tenant, role)
--     is that pair — holding that row, or (an INSERT, or an UPDATE moving a row onto the pair) past the primary key's wait for
--     any transaction that has written that pair's row. Two writers of one pair therefore serialize on the row before either
--     takes the key, and a writer waiting for the key of another pair (equal hashes) holds nothing the holder still needs:
--     after its key the holder writes only the version row of each pair of the row it wrote (021's upsert), which another
--     writer can write only by writing a row of that pair, after the holder's (and two writers of one actor serialize on the
--     account before either takes a key). That covers every writer that keeps THE RULE below, as every runtime writer does
--     (026's setter); a table-owner transaction that breaks it can deadlock (MULTI-PAIR WRITERS). A waiting EXCLUSIVE normally
--     queues later SHARED requests behind it (a starvation property only: deadlock freedom rests on the acyclic order above,
--     not on queue order), so a writer is not starved by a stream of edits. Every wait is bounded by the command transaction's
--     lock and statement timeouts (70% and 90% of its 2000 ms deadline), ending in the existing 503 with the lease kept.
--     THE RULE THIS ORDER NEEDS: A TRANSACTION HOLDING THE KEY SHARED (AN EDIT) NEVER LOCKS AN INVOICES ROLE ROW OR VERSION ROW
--     AFTER TAKING IT; A WRITER TAKING IT EXCLUSIVE HOLDS BEFORE IT NOTHING A KEY HOLDER WAITS FOR AFTER ITS KEY (another
--     pair's version row, a customer, a draft's lines), AND AFTER IT WRITES NO ROLE ROW OR VERSION ROW BUT THE VERSION ROWS OF
--     THE ROLE ROW IT ALREADY HOLDS (021's upsert), WHICH NO EDIT LOCKS, beside its own audit, outbox and completion rows. The
--     runtime never breaks the rule: it runs one mutator per command transaction, and 026's setter locks before its key, beyond
--     what every tenant write locks first (the fence, 016's hold, the session, ledger and issuer rows), only its own pair's
--     role row and version row. A holder of tmpos_app and a live key that ran v2 and then 028's create in ONE transaction would
--     break it, and could deadlock with a setter (PostgreSQL aborts one side: availability), as can a table-owner transaction
--     that breaks it (MULTI-PAIR WRITERS).
--   - WRITER LIVENESS. The setter's new key wait follows 026's last clock check. 026 is not changed. On the runtime path the
--     role-level mutator re-judges the owner's recent sign-in on the database clock after the setter returns, in the same command
--     transaction (postgresRoleLevels.ts, authenticationFresh), and that deadline precedes the session's expiry. A direct tmpos_app
--     caller of 026's setter (no runtime, no audit, no recent sign-in — the existing G-AUDIT class) could hold its transaction on
--     the key past its session's expiry: a recorded residual.
--   - WHY NOT A ROW. No routine creates tenants, so a guard row would need a trigger on public.tenant or its creation on a no-op
--     (both excluded); a role_level_version row does not exist until the first level update; the tenant row is held FOR SHARE by
--     every tenant request's 016 hold, so a writer conflicting with it would have to upgrade a lock it already holds (readers
--     arriving meanwhile do not queue behind an upgrader, two upgraders deadlock) and would stall the whole tenant.
--   - WHAT THIS DOES NOT DEFEND (doc 08; none of it is claimed closed). 028's and 029's residuals stand for v2 (audit only through
--     the HTTP route; the role row FOR SHARE they list is now the key, held SHARED), and:
--       * ANY DATABASE LOGIN can hold a guard key — the advisory functions are executable by PUBLIC and no session key is needed —
--         in transaction form or in session form (pg_advisory_lock outlives a COMMIT until unlocked or disconnected). Availability
--         only: an EXCLUSIVE holder makes every edit of that (tenant, role) answer 503; a SHARED holder makes every Invoices level
--         write of that pair wait (the owner's PUT: 503; a raw owner write: unbounded). Nobody can release another session's lock
--         or pass the guard by it. DA-115's and DA-120's class, widened from tmpos_app with a live key to any login;
--       * CONVOY: a writer waiting for the key holds the role row FOR UPDATE (up to the lock timeout), so that role's creates wait
--         behind it and an edit arriving after it normally queues behind it — all bounded, ending in the 503; creates can still delay the
--         writer (DA-120(2));
--       * the TABLE OWNER, or a member of the owner role, can DISABLE the trigger (SHARE ROW EXCLUSIVE conflicts with neither the
--         edit's ACCESS SHARE nor the key), replace a function, or alter the table by DDL that does not wait for an edit in flight:
--         DA-204 is closed for the runtime paths WHILE THE TRIGGER IS ENABLED;
--       * the owner can still run 029's routine directly (only tmpos_app's EXECUTE is revoked): it takes no key;
--       * MULTI-PAIR WRITERS: "the smaller key first" protects a single-row key-moving UPDATE; it does not order keys across
--         the ROWS or STATEMENTS of one transaction. A table-owner transaction that writes several (tenant, role) Invoices
--         pairs, or that locks or writes, before a level, a row a key holder may still wait for after its key (another pair's
--         version row, a customer, a draft's lines), breaks THE RULE and can deadlock with a writer or an edit that takes the
--         same rows or keys in the opposite order: PostgreSQL detects it (40P01) and aborts one of them, and no wrong authority
--         answer results. Every runtime writer (026's setter) writes exactly one row of one pair per transaction. No code
--         change for it;
--       * 028's draft SAVE still seals customer_not_found (422) on levels it read unlocked: its step 8 decides Invoices >= Create
--         and Customers >= View on unlocked reads (028 up:661-685), its step 10 finds no customer, unlocked (028 up:694-703), and
--         only then are its role rows locked FOR SHARE (028 up:705-730): the save, not the edit. 028 is frozen; the docs commit
--         records it as a register item;
--       * two (tenant, role) pairs with equal hashes are serialized (availability).
--   - APPLY: A MAINTENANCE WINDOW. Before any check and before any change — its first statements after the search path, with
--     nothing read before them, not even the catalog — the file takes ACCESS EXCLUSIVE until COMMIT on 029's seven tables in the
--     writers' order: public.store, tmpos_role.tenant_role_level, tmpos_role_edit.role_level_version, tmpos_customer.customer,
--     tmpos_invoice_draft.invoice_draft, tmpos_invoice_draft.invoice_draft_line, public.audit_event — in one block whose handler
--     turns a missing table or schema into this file's refusal (55000), the block's locks released first. So no draft save or
--     edit, level edit, store, customer or audit write, and no earlier file's rollback that locks any of the seven, is in flight
--     while the guard goes in: it committed before this file read anything or waits for its COMMIT. THE COST: every read and
--     write of those seven tables waits until COMMIT — in effect every tenant request — though no row is rewritten and no index
--     is built; creating the trigger takes the level table's lock anyway.
--   - DEPLOY AND ROLLBACK: FAIL CLOSED BOTH WAYS. It and the runtime that calls v2 move together: the startup preflight pins the
--     exact ledger (001-030) and the exact grants (v2's EXECUTE and the schema's USAGE in place of 029's EXECUTE), so the 001-029
--     runtime refuses a 030 database (its EXECUTE is gone) and this runtime refuses a 029 one. ROLL 030 BACK BEFORE 029 and before
--     every earlier file: 029's down and the earlier downs cannot see this file (v2 is plpgsql, so no catalog dependency records
--     029's routine, and 020's down drops the level table and with it the trigger, leaving this schema orphaned). The rollback
--     NEVER REFUSES ON DATA: this file adds no table, row or version (an advisory key lives and dies with a transaction), so every
--     draft at any version, every line, role row, version row, audit record, outbox row and completion stays; it refuses only on
--     the catalog or the applier's rights (030's objects not all in place, 029's routine missing, and the rest its header
--     lists). IT RESTORES 029'S CONTRACT AND ITS DA-204 WINDOW: after it, the edit routine tmpos_app can call is 029's again,
--     whose sealed answers rest on the unlocked decision.
--   - NO SECRET, NO DYNAMIC SQL, NO EXTENSION, NO TEMPORARY OBJECT. Every statement is fixed text, every value a parameter, every
--     relation and routine schema-qualified; the routine pins its search_path to pg_catalog then pg_temp and runs with
--     row_security off; the trigger function pins its search_path. There is no backfill.
--
-- Reversible via 030_m7b_invoice_edit_authority.down.sql, which never refuses on data and restores 029's grant. Roll 030 back
-- before 029.
--
-- Assumes 001-029 are applied. A future managed apply targets the complete contiguous chain through the newest committed
-- migration — now 001-030 (owner decision D4); this file authorizes no apply.

-- =============================================================================
-- 1) This transaction's search path
-- =============================================================================
set local search_path = pg_catalog, pg_temp;

-- =============================================================================
-- 2) The locks, in the writers' order: the first statements after the search path, before any check or any change
-- =============================================================================
-- 029's seven tables (028's rollback order, R7). Nothing is read or checked before them, not even the catalog. A LOCK naming a
-- table or schema that is missing raises undefined_table (42P01) or invalid_schema_name (3F000); the block's handler turns
-- either into this file's refusal (55000). The block runs as a subtransaction: once it completes, this transaction keeps its
-- locks until COMMIT; refused, the subtransaction has released the locks it took, and the refusal aborts the file.
do $$
begin
  lock table public.store in access exclusive mode;
  lock table tmpos_role.tenant_role_level in access exclusive mode;
  lock table tmpos_role_edit.role_level_version in access exclusive mode;
  lock table tmpos_customer.customer in access exclusive mode;
  lock table tmpos_invoice_draft.invoice_draft in access exclusive mode;
  lock table tmpos_invoice_draft.invoice_draft_line in access exclusive mode;
  lock table public.audit_event in access exclusive mode;
exception
  when undefined_table or invalid_schema_name then
    raise exception 'migration 030 refused: public.store, tmpos_role.tenant_role_level, tmpos_role_edit.role_level_version, tmpos_customer.customer, tmpos_invoice_draft.invoice_draft, tmpos_invoice_draft.invoice_draft_line or public.audit_event is missing (migrations 002, 017, 020, 021 and 028 must be applied first)'
      using errcode = 'object_not_in_prerequisite_state';
end
$$;

-- =============================================================================
-- 3) Preconditions: what this file builds on
-- =============================================================================
do $$
declare
  v_me oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user);
begin
  -- Nothing of this file exists yet: it is applied once, over a chain that has never held it.
  if pg_catalog.to_regnamespace('tmpos_invoice_edit') is not null
     or exists (select 1 from pg_catalog.pg_trigger g
                 where g.tgrelid = 'tmpos_role.tenant_role_level'::regclass and g.tgname = 'trg_tenant_role_level_invoice_guard') then
    raise exception 'migration 030 refused: schema tmpos_invoice_edit or the trigger trg_tenant_role_level_invoice_guard already exists'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- The chain is contiguous: 029 is the newest migration this file sits on, with its routine and its trigger.
  if pg_catalog.to_regprocedure('tmpos_invoice_draft.m7b_invoice_draft_update(text, uuid, uuid, uuid, bigint, uuid, jsonb, bigint)') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_draft.m7b_invoice_draft_immutable()') is null
     or not exists (select 1 from pg_catalog.pg_trigger g
                     where g.tgrelid = 'tmpos_invoice_draft.invoice_draft'::regclass and g.tgname = 'trg_invoice_draft_immutable') then
    raise exception 'migration 030 refused: migration 029 must be applied first (its edit routine and its immutability trigger)'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- 026's setter and 021's trigger function are in place, and 021's trigger, exactly as 021 left it, is the only trigger on the
  -- level table. tgtype: ROW 1 + UPDATE 16 = 17.
  if pg_catalog.to_regprocedure('tmpos_role_invoice.m7a_invoice_role_level_set(text, text, text, uuid, bigint)') is null
     or pg_catalog.to_regprocedure('tmpos_role_edit.m7a_role_level_version_advance()') is null then
    raise exception 'migration 030 refused: migration 021 or 026 is not applied'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if (select pg_catalog.count(*) from pg_catalog.pg_trigger g
       where g.tgrelid = 'tmpos_role.tenant_role_level'::regclass and not g.tgisinternal) <> 1
     or not exists (select 1 from pg_catalog.pg_trigger g
                     where g.tgrelid = 'tmpos_role.tenant_role_level'::regclass
                       and g.tgname = 'trg_tenant_role_level_version_advance'
                       and g.tgfoid = 'tmpos_role_edit.m7a_role_level_version_advance()'::regprocedure
                       and g.tgtype = 17
                       and g.tgenabled = 'A'
                       and g.tgattr = ''::pg_catalog.int2vector
                       and g.tgqual is null
                       and not g.tgisinternal) then
    raise exception 'migration 030 refused: tmpos_role.tenant_role_level does not carry exactly 021''s one version trigger'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- The objects the routine restates, reads or locks.
  if pg_catalog.to_regprocedure('tmpos_session.m5_hold_tenant_standing(text, text)') is null
     or pg_catalog.to_regprocedure('tmpos_session.m5_admit_tenant_session_v2(text, text)') is null
     or pg_catalog.to_regclass('tmpos_session.session') is null
     or pg_catalog.to_regclass('tmpos_mint.tenant_session') is null
     or pg_catalog.to_regclass('tmpos_mint.issuer_key') is null
     or pg_catalog.to_regclass('public.tenant') is null
     or pg_catalog.to_regclass('public.user_membership') is null then
    raise exception 'migration 030 refused: 016''s hold or admission read, 018''s mint ledger or issuer key, or 002''s tenant or membership table is missing'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- The runtime roles this file grants to and revokes from.
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'tmpos_app')
     or not exists (select 1 from pg_catalog.pg_roles where rolname = 'tmpos_audit_writer') then
    raise exception 'migration 030 refused: migration 005 must be applied first'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- The routine calls 016's hold and admission read as its owner, the principal applying this file, and reads and writes the
  -- schemas below.
  if not (pg_catalog.has_function_privilege(current_user, 'tmpos_session.m5_hold_tenant_standing(text, text)', 'EXECUTE')
          and pg_catalog.has_function_privilege(current_user, 'tmpos_session.m5_admit_tenant_session_v2(text, text)', 'EXECUTE')
          and pg_catalog.has_schema_privilege(current_user, 'tmpos_session', 'USAGE')
          and pg_catalog.has_schema_privilege(current_user, 'tmpos_mint', 'USAGE')
          and pg_catalog.has_schema_privilege(current_user, 'tmpos_role', 'USAGE')
          and pg_catalog.has_schema_privilege(current_user, 'tmpos_customer', 'USAGE')
          and pg_catalog.has_schema_privilege(current_user, 'tmpos_invoice_draft', 'USAGE')) then
    raise exception 'migration 030 refused: the applying principal cannot execute 016''s hold and admission read, which the routine calls, or use the schemas it reads'
      using errcode = 'insufficient_privilege';
  end if;
  -- A SECURITY DEFINER routine reads and writes only what its owner may (017's argument): were the applying principal neither
  -- the owner nor a role inheriting the owner of every table the routine reads or writes — or row security FORCEd on one — the
  -- routine would find no session and refuse everything, or fail on a write.
  if exists (
    select 1
      from pg_catalog.pg_class c
     where c.oid = any (array['tmpos_session.session'::regclass, 'tmpos_mint.tenant_session'::regclass,
                              'tmpos_mint.issuer_key'::regclass, 'tmpos_role.tenant_role_level'::regclass,
                              'tmpos_customer.customer'::regclass, 'public.store'::regclass, 'public.tenant'::regclass,
                              'public.user_membership'::regclass, 'tmpos_invoice_draft.invoice_draft'::regclass,
                              'tmpos_invoice_draft.invoice_draft_line'::regclass])
       and (not pg_catalog.pg_has_role(current_user, c.relowner, 'USAGE') or c.relforcerowsecurity)) then
    raise exception 'migration 030 refused: the applying principal neither owns nor inherits the owner of a table the edit routine reads or writes, or one has forced row security'
      using errcode = 'insufficient_privilege';
  end if;
  -- The revoke below and the rollback's grant are exact only if the applying principal OWNS 029's routine and its COMPLETE ACL
  -- (coalesce(proacl, acldefault), every entry, the owner's included) is exactly two entries: the owner's EXECUTE and tmpos_app's
  -- EXECUTE, each granted by the owner and non-grantable — nothing else, PUBLIC included. Then the rollback's grant restores the
  -- ACL byte for byte, and the revoke is not a silent no-op.
  if not exists (select 1 from pg_catalog.pg_proc p
                  where p.oid = 'tmpos_invoice_draft.m7b_invoice_draft_update(text, uuid, uuid, uuid, bigint, uuid, jsonb, bigint)'::regprocedure
                    and p.proowner = v_me)
     or (select pg_catalog.count(*)
           from pg_catalog.pg_proc p,
                pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g
          where p.oid = 'tmpos_invoice_draft.m7b_invoice_draft_update(text, uuid, uuid, uuid, bigint, uuid, jsonb, bigint)'::regprocedure) <> 2
     or (select pg_catalog.count(*)
           from pg_catalog.pg_proc p,
                pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g
          where p.oid = 'tmpos_invoice_draft.m7b_invoice_draft_update(text, uuid, uuid, uuid, bigint, uuid, jsonb, bigint)'::regprocedure
            and g.grantee = p.proowner and g.privilege_type = 'EXECUTE' and not g.is_grantable
            and g.grantor = p.proowner) <> 1
     or (select pg_catalog.count(*)
           from pg_catalog.pg_proc p,
                pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g
          where p.oid = 'tmpos_invoice_draft.m7b_invoice_draft_update(text, uuid, uuid, uuid, bigint, uuid, jsonb, bigint)'::regprocedure
            and g.grantee = 'tmpos_app'::regrole and g.privilege_type = 'EXECUTE' and not g.is_grantable
            and g.grantor = p.proowner) <> 1 then
    raise exception 'migration 030 refused: the applying principal does not own 029''s edit routine, or tmpos_app''s EXECUTE on it is not the one non-grantable entry 029 issued'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$$;

-- Under READ COMMITTED the checks above and the postcondition below see every row committed before the locks were granted
-- (017's reason).
do $$
begin
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'migration 030 refused: it must run under READ COMMITTED, so that its checks see every committed row'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$$;

-- =============================================================================
-- 4) The schema
-- =============================================================================
create schema tmpos_invoice_edit;

comment on schema tmpos_invoice_edit is
  'Phase 4.0 M7b (migration 030): the guard of the Invoices level — the trigger function every writer of an Invoices level meets and the invoice-draft edit that holds the same advisory key. Owned by this migration; tmpos_app holds USAGE and EXECUTE on the edit only.';

revoke all on schema tmpos_invoice_edit from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
grant usage on schema tmpos_invoice_edit to tmpos_app;

-- =============================================================================
-- 5) The trigger function and the trigger (every writer of an Invoices level takes the key)
-- =============================================================================
-- SECURITY INVOKER and granted to nobody: a trigger function fires without an EXECUTE grant, and it reads no relation, so it
-- needs no privilege of its own (008's and 021's form); it calls only pg_catalog functions every login may execute, so it works
-- for whoever writes the table. A firing this file does not declare raises rather than guessing (015's rule). AFTER ROW, so it
-- fires only for a row actually written; it returns NULL, which an AFTER trigger ignores.
create function tmpos_invoice_edit.m7b_invoice_level_guard()
returns trigger
language plpgsql
volatile
security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
  v_old integer;
  v_new integer;
begin
  if tg_when is distinct from 'AFTER' or tg_level is distinct from 'ROW'
     or tg_op not in ('INSERT', 'UPDATE', 'DELETE')
     or tg_table_schema is distinct from 'tmpos_role' or tg_table_name is distinct from 'tenant_role_level' then
    raise exception 'm7b_invoice_level_guard: fired by an undeclared trigger'
      using errcode = 'triggered_action_exception';
  end if;
  if tg_op = 'INSERT' then
    -- A NULL level is the catalog default, what an absent row means: no effective change, no key.
    if new.domain = 'invoices' and new.level is not null then
      perform pg_catalog.pg_advisory_xact_lock(530030, pg_catalog.hashtext(new.tenant_id::text || '/' || new.role_id));
    end if;
  elsif tg_op = 'DELETE' then
    if old.domain = 'invoices' and old.level is not null then
      perform pg_catalog.pg_advisory_xact_lock(530030, pg_catalog.hashtext(old.tenant_id::text || '/' || old.role_id));
    end if;
  else
    -- An UPDATE: the old row's key and, when the row moved to another (tenant, role), the new row's too, the smaller first.
    if old.domain = 'invoices' or new.domain = 'invoices' then
      v_old := pg_catalog.hashtext(old.tenant_id::text || '/' || old.role_id);
      v_new := pg_catalog.hashtext(new.tenant_id::text || '/' || new.role_id);
      perform pg_catalog.pg_advisory_xact_lock(530030, least(v_old, v_new));
      if v_old <> v_new then
        perform pg_catalog.pg_advisory_xact_lock(530030, greatest(v_old, v_new));
      end if;
    end if;
  end if;
  return null;
end
$$;

comment on function tmpos_invoice_edit.m7b_invoice_level_guard() is
  'Phase 4.0 M7b (migration 030): AFTER INSERT OR UPDATE OR DELETE row trigger on tmpos_role.tenant_role_level (enabled ALWAYS). Takes the transaction-scoped advisory key pg_advisory_xact_lock(530030, hashtext(tenant_id || ''/'' || role_id)) EXCLUSIVE for an insert of a non-NULL Invoices level, for an update whose old or new row is an Invoices row (the old key and, when the row moved, the new one, the smaller first; an update to or from a NULL level, or out of or into the Invoices domain, takes it) and for a delete of a non-NULL Invoices row, so a writer cannot commit an Invoices change while an invoice-draft edit holds that key (a waiting writer may time out and roll back instead); takes nothing for an insert or delete of a NULL level (the catalog default) or of another domain. Raises triggered_action_exception for any other firing. Reads no relation. Granted to nobody.';

create trigger trg_tenant_role_level_invoice_guard
  after insert or update or delete on tmpos_role.tenant_role_level
  for each row execute function tmpos_invoice_edit.m7b_invoice_level_guard();

-- ALWAYS, as 013's, 021's and 029's are: a write by a session running as a replica meets it too.
alter table tmpos_role.tenant_role_level enable always trigger trg_tenant_role_level_invoice_guard;

-- =============================================================================
-- 6) The routine
-- =============================================================================
create function tmpos_invoice_edit.m7b_invoice_draft_update_v2(
  p_session_key text, p_store_id uuid, p_draft_id uuid, p_expected_tenant uuid, p_expected_version bigint,
  p_customer_id uuid, p_lines jsonb, p_subtotal_cents bigint)
returns table (
  o_outcome       text,
  o_tenant_id     uuid,
  o_store_id      uuid,
  o_actor_id      uuid,
  o_membership_id uuid,
  o_version       bigint
)
language plpgsql
-- VOLATILE IS LOAD-BEARING (019's, 020's, 024's and 028's reason): it locks and then re-reads, and each statement must see
-- what committed before its own locks. Do not make it STABLE.
volatile
security definer
set search_path = pg_catalog, pg_temp
set row_security = off
as $$
declare
  -- The tenant ordering (permissionCatalog.ts TENANT_ORDERING), 020's constant, pinned by the parity test.
  c_levels         constant text[] := array['none', 'view', 'create', 'edit', 'manage', 'approve', 'full'];
  -- The largest integer a JavaScript number holds exactly: every amount's bound and the version's.
  c_max            constant numeric := 9007199254740991;
  v_count          integer;
  v_line           record;
  v_text           text;
  v_quantity       text;
  v_price          text;
  v_total          numeric;
  v_sum            numeric := 0;
  v_now            bigint;
  v_provider       text;
  v_uid            text;
  v_expires        bigint;
  v_minted_expires bigint;
  v_minted_issuer  bytea;
  v_session        record;
  v_issuer         bytea;
  v_admission      record;
  v_grants         jsonb;
  v_role           text;
  v_tenant         uuid;
  v_membership     uuid;
  v_store          record;
  v_invoices       text;
  v_header         record;
  v_written        bigint;
  v_updated        integer;
  v_check          record;
begin
  -- 0. Every argument, before anything is read, locked or written. A refusal names the field, never the value.
  if p_session_key is null or p_session_key !~ '^[\x21-\x7e]{1,128}$'
     or p_store_id is null
     or p_draft_id is null
     or p_expected_tenant is null
     or p_customer_id is null then
    raise exception 'migration 029 update: an argument is malformed'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_expected_version is null or p_expected_version < 1 or p_expected_version > 9007199254740990 then
    raise exception 'migration 029 update: the expected version is not one the draft table can advance'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_subtotal_cents is null or p_subtotal_cents < 0 or p_subtotal_cents > c_max then
    raise exception 'migration 029 update: the subtotal is not a whole number from 0 to 9007199254740991'
      using errcode = 'invalid_parameter_value';
  end if;
  -- The lines: 028's create step 0, restated (028 is frozen).
  if p_lines is null or pg_catalog.jsonb_typeof(p_lines) is distinct from 'array' then
    raise exception 'migration 029 update: the lines are not an array'
      using errcode = 'invalid_parameter_value';
  end if;
  v_count := pg_catalog.jsonb_array_length(p_lines);
  if v_count < 1 or v_count > 50 then
    raise exception 'migration 029 update: there are not 1 to 50 lines'
      using errcode = 'invalid_parameter_value';
  end if;
  for v_line in select e.entry from pg_catalog.jsonb_array_elements(p_lines) as e(entry) loop
    if pg_catalog.jsonb_typeof(v_line.entry) is distinct from 'object'
       or (select pg_catalog.array_agg(k.key order by k.key collate "C") from pg_catalog.jsonb_object_keys(v_line.entry) as k(key))
          is distinct from array['description', 'quantity', 'unitPriceCents']::text[] then
      raise exception 'migration 029 update: a line is not exactly a description, a quantity and a unit price'
        using errcode = 'invalid_parameter_value';
    end if;
    if pg_catalog.jsonb_typeof(v_line.entry -> 'description') is distinct from 'string'
       or pg_catalog.jsonb_typeof(v_line.entry -> 'quantity') is distinct from 'number'
       or pg_catalog.jsonb_typeof(v_line.entry -> 'unitPriceCents') is distinct from 'number' then
      raise exception 'migration 029 update: a line field has the wrong type'
        using errcode = 'invalid_parameter_value';
    end if;
    -- The description: one the line table's CHECK admits (restated, so the insert below cannot refuse it).
    v_text := v_line.entry ->> 'description';
    if not (
         pg_catalog.char_length(v_text) between 1 and 256
         and v_text !~ '[\u0001-\u001f\u007f-\u009f\u2028\u2029]'
         and v_text !~ '[\u061c\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069]'
         and v_text !~ '^[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]|[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]$') then
      raise exception 'migration 029 update: a line description is not one the line table admits'
        using errcode = 'invalid_parameter_value';
    end if;
    v_quantity := v_line.entry ->> 'quantity';
    if v_quantity !~ '^[1-9][0-9]{0,15}$' or v_quantity::numeric > c_max then
      raise exception 'migration 029 update: a line quantity is not a whole number from 1 to 9007199254740991'
        using errcode = 'invalid_parameter_value';
    end if;
    v_price := v_line.entry ->> 'unitPriceCents';
    if v_price !~ '^(0|[1-9][0-9]{0,15})$' or v_price::numeric > c_max then
      raise exception 'migration 029 update: a line unit price is not a whole number of cents from 0 to 9007199254740991'
        using errcode = 'invalid_parameter_value';
    end if;
    v_total := v_quantity::numeric * v_price::numeric;
    if v_total > c_max then
      raise exception 'migration 029 update: a line total is above 9007199254740991'
        using errcode = 'invalid_parameter_value';
    end if;
    v_sum := v_sum + v_total;
    if v_sum > c_max then
      raise exception 'migration 029 update: the lines'' sum is above 9007199254740991'
        using errcode = 'invalid_parameter_value';
    end if;
  end loop;
  if v_sum <> p_subtotal_cents::numeric then
    raise exception 'migration 029 update: the subtotal is not the sum of the line totals'
      using errcode = 'invalid_parameter_value';
  end if;
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'migration 029 update: it must run under READ COMMITTED, so that its checks see what committed before its locks'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- 1. The caller, derived exactly as 028's create derives it (028 up, steps 1-6; 024 and 019 give each step's reason): the
  --    unlocked live/issuer pre-check, 016's hold, the session and ledger rows FOR SHARE, the issuer key FOR SHARE, the clock
  --    after those waits, the standing digest the session was minted under, a write account status.
  select s.auth_provider, s.auth_provider_uid, s.expires_at, m.expires_at, m.issuer_digest
    into v_provider, v_uid, v_expires, v_minted_expires, v_minted_issuer
    from tmpos_session.session s
    join tmpos_mint.tenant_session m on m.session_key = s.session_key
   where s.session_key = p_session_key
     and s.audience = 'tenant';
  if not found then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint;
    return;
  end if;
  v_now := pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp()) * 1000)::bigint;
  if v_expires is distinct from v_minted_expires or v_now >= v_expires then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint;
    return;
  end if;
  select pg_catalog.sha256(k.key) into v_issuer from tmpos_mint.issuer_key k where k.singleton;
  if v_issuer is null or v_issuer is distinct from v_minted_issuer then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint;
    return;
  end if;

  if tmpos_session.m5_hold_tenant_standing(v_provider, v_uid) is distinct from 'held' then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint;
    return;
  end if;

  select s.expires_at, m.standing_digest, m.issuer_digest, m.expires_at as minted_expires_at
    into v_session
    from tmpos_session.session s
    join tmpos_mint.tenant_session m on m.session_key = s.session_key
   where s.session_key = p_session_key
     and s.audience = 'tenant'
     and s.auth_provider = v_provider
     and s.auth_provider_uid = v_uid
     for share of s, m;
  if not found or v_session.expires_at is distinct from v_session.minted_expires_at then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint;
    return;
  end if;

  select pg_catalog.sha256(k.key) into v_issuer from tmpos_mint.issuer_key k where k.singleton for share;
  if v_issuer is null or v_issuer is distinct from v_session.issuer_digest then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint;
    return;
  end if;

  v_now := pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp()) * 1000)::bigint;
  if v_now >= v_session.expires_at then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint;
    return;
  end if;

  select r.outcome, r.actor_id, r.account_status, r.memberships,
         pg_catalog.sha256(pg_catalog.convert_to(r::text, 'UTF8')) as digest
    into strict v_admission
    from tmpos_session.m5_admit_tenant_session_v2(v_provider, v_uid) r;
  if v_admission.outcome is distinct from 'resolved'
     or v_admission.digest is distinct from v_session.standing_digest
     or v_admission.actor_id is null
     or v_admission.account_status is null
     or v_admission.account_status not in ('active', 'trialing')
     or pg_catalog.jsonb_typeof(v_admission.memberships) is distinct from 'array' then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint;
    return;
  end if;

  -- 2. EXACTLY ONE store-scope grant naming p_store_id — a selector among the actor's own grants, never proof — on a tenant
  --    and a store whose statuses are write statuses (028's step 7). A tenant grant and a grant at another store never count.
  select pg_catalog.jsonb_agg(e.entry) into v_grants
    from pg_catalog.jsonb_array_elements(v_admission.memberships) as e(entry)
   where e.entry ->> 'scopeType' = 'store'
     and e.entry ->> 'storeId' = p_store_id::text;
  if v_grants is null
     or pg_catalog.jsonb_array_length(v_grants) <> 1
     or (v_grants -> 0 ->> 'tenantId') is null
     or (v_grants -> 0 ->> 'membershipId') is null
     or (v_grants -> 0 ->> 'roleId') is null
     or (v_grants -> 0 ->> 'tenantStatus') is null
     or (v_grants -> 0 ->> 'tenantStatus') not in ('active', 'trialing')
     or (v_grants -> 0 ->> 'storeStatus') is null
     or (v_grants -> 0 ->> 'storeStatus') not in ('active', 'trialing') then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint;
    return;
  end if;
  v_role := v_grants -> 0 ->> 'roleId';
  v_tenant := (v_grants -> 0 ->> 'tenantId')::uuid;
  v_membership := (v_grants -> 0 ->> 'membershipId')::uuid;
  -- 2a. Still that actor's active membership row at exactly that tenant, store and role (016's hold holds it).
  if not exists (
    select 1
      from public.user_membership um
     where um.membership_id = v_membership
       and um.internal_user_id = v_admission.actor_id
       and um.status = 'active'
       and um.scope_type = 'store'
       and um.tenant_id = v_tenant
       and um.store_id = p_store_id
       and um.role_id = v_role) then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint;
    return;
  end if;
  -- 2b. The store row, re-read FOR SHARE (016's hold already holds it): in that grant's tenant, with a write status.
  select st.tenant_id, st.status into v_store
    from public.store st
   where st.store_id = p_store_id
     for share;
  if not found
     or v_store.tenant_id is distinct from v_tenant
     or v_store.status is null
     or v_store.status not in ('active', 'trialing') then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint;
    return;
  end if;

  -- 3. The role's Invoices level, UNLOCKED, at Edit or above: an early pre-check, refusing before the header is locked (the
  --    decision of record is step 5b's). store_owner is Full (never stored); an editable role is its stored level, else its
  --    catalog default; any other role refuses. Nothing is written or locked by a refusal here.
  if v_role = 'store_owner' then
    null;
  elsif v_role in ('manager', 'technician', 'sales_staff') then
    select l.level into v_invoices
      from tmpos_role.tenant_role_level l
     where l.tenant_id = v_tenant and l.role_id = v_role and l.domain = 'invoices';
    if coalesce(pg_catalog.array_position(c_levels,
         coalesce(v_invoices, case v_role when 'manager' then 'full' when 'technician' then 'view' when 'sales_staff' then 'create' end)), 0)
       < pg_catalog.array_position(c_levels, 'edit') then
      return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint;
      return;
    end if;
  else
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint;
    return;
  end if;

  -- 4. The request's expectedTenant (caller-supplied, never authority) against the tenant derived from the grant — a
  --    precondition only (021's and 022's rule): nothing written, nothing locked beyond the derivation's rows.
  if v_tenant is distinct from p_expected_tenant then
    return query select 'tenant_mismatch'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint;
    return;
  end if;

  -- 5. The header, locked FOR UPDATE until COMMIT in ONE statement, filtered by id, derived tenant and store ONLY (never the
  --    version: under READ COMMITTED a waiter re-evaluates its WHERE on the row a concurrent edit committed, and a version
  --    filter there would turn that edit into 'not_found' instead of 'conflict'). A missing id, another store's and another
  --    tenant's take this same statement and answer — before the role's key is taken (step 5b) and before the customer.
  select d.status, d.version, d.customer_id, d.line_count
    into v_header
    from tmpos_invoice_draft.invoice_draft d
   where d.draft_id = p_draft_id
     and d.tenant_id = v_tenant
     and d.store_id = p_store_id
     for update;
  if not found then
    return query select 'not_found'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint;
    return;
  end if;
  -- Live, on the database clock read again now: the header lock may have waited (another edit of this draft).
  v_now := pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp()) * 1000)::bigint;
  if v_now >= v_session.expires_at then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint;
    return;
  end if;

  -- 5b. THE GUARD: the role's key taken SHARED and held until COMMIT, then the level decided again. The header is locked, so
  --     every other edit of this draft is out; what is left to order against is a writer of the role's Invoices level, which
  --     takes the same key EXCLUSIVE (trg_tenant_role_level_invoice_guard). Every answer below — the sealed 'invalid_state',
  --     'conflict' and 'unchanged' and the change path alike — is decided after this point and committed while the key is
  --     held. Three SEPARATE top-level statements of the routine's outermost block, never inside a BEGIN ... EXCEPTION block
  --     (a subtransaction that aborts releases a transaction-scoped advisory lock): the key; the clock again, because the
  --     wait may have been long (an expired session is refused); and the level read again by a PLAIN SELECT, a fresh READ
  --     COMMITTED snapshot taken after the wait, so a level a writer committed before releasing the key is seen. No FOR SHARE
  --     or FOR UPDATE on a role or version row after the key (the lock-order rule in this file's header), nothing inserted:
  --     a role without a stored level is decided on its catalog default and no row is made for it. The plain SELECT's ACCESS
  --     SHARE on the table, held to COMMIT, is what orders a TRUNCATE. store_owner is Full and never stored: no key, no read.
  if v_role in ('manager', 'technician', 'sales_staff') then
    perform pg_catalog.pg_advisory_xact_lock_shared(530030, pg_catalog.hashtext(v_tenant::text || '/' || v_role));
    v_now := pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp()) * 1000)::bigint;
    if v_now >= v_session.expires_at then
      return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint;
      return;
    end if;
    select l.level into v_invoices
      from tmpos_role.tenant_role_level l
     where l.tenant_id = v_tenant and l.role_id = v_role and l.domain = 'invoices';
    if coalesce(pg_catalog.array_position(c_levels,
         coalesce(v_invoices, case v_role when 'manager' then 'full' when 'technician' then 'view' when 'sales_staff' then 'create' end)), 0)
       < pg_catalog.array_position(c_levels, 'edit') then
      return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint;
      return;
    end if;
  end if;

  -- 6. Only a draft is editable (028's CHECK pins every row to 'draft' today).
  if v_header.status is distinct from 'draft' then
    return query select 'invalid_state'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint;
    return;
  end if;

  -- 7. The version, before the values: a stale editor conflicts even when what it sends equals what is stored.
  if v_header.version is distinct from p_expected_version then
    return query select 'conflict'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint;
    return;
  end if;

  -- 8. The replacement customer, held FOR KEY SHARE in the derived tenant until COMMIT (the foreign key's own lock, taken
  --    first): a missing id and another tenant's are the draft's answer.
  perform 1
     from tmpos_customer.customer c
    where c.customer_id = p_customer_id
      and c.tenant_id = v_tenant
      for key share;
  if not found then
    return query select 'not_found'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint;
    return;
  end if;
  v_now := pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp()) * 1000)::bigint;
  if v_now >= v_session.expires_at then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint;
    return;
  end if;

  -- 9. The no-op: the same customer and, position by position, the same lines — as many stored as sent, and every sent line
  --    equal to the stored line at its position (positions are the line table's key, so that is the whole stored list).
  --    Nothing is written; the deciding locks stay held until the runtime's completion commits.
  if v_header.customer_id = p_customer_id
     and (select pg_catalog.count(*) from tmpos_invoice_draft.invoice_draft_line l
           where l.draft_id = p_draft_id and l.tenant_id = v_tenant and l.store_id = p_store_id) = v_count
     and not exists (
       select 1
         from pg_catalog.jsonb_array_elements(p_lines) with ordinality as e(entry, ordinality)
         left join tmpos_invoice_draft.invoice_draft_line l
           on l.draft_id = p_draft_id and l.tenant_id = v_tenant and l.store_id = p_store_id
          and l.position = e.ordinality::integer
        where l.position is null
           or l.description is distinct from (e.entry ->> 'description')
           or l.quantity is distinct from (e.entry ->> 'quantity')::bigint
           or l.unit_price_cents is distinct from (e.entry ->> 'unitPriceCents')::bigint) then
    return query select 'unchanged'::text, v_tenant, p_store_id, v_admission.actor_id, v_membership, v_header.version;
    return;
  end if;

  -- 10. (029's change-path-only role-row anchor, FOR SHARE and locked re-decision are not here: step 5b decided the level for
  --     every answer, and a lock on a role or version row after the key would close a cycle with 026's setter — see this file's
  --     header. The edit writes no role row at all.)

  -- 11. The edit: the lines replaced, then the header, on exactly the locked draft. draft_id, the tenant, the store, status,
  --     currency, created_at and created_by are never written. The CHECKs restate step 0, so they cannot refuse; were any
  --     constraint ever to, the raise is fixed text, never the row.
  begin
    delete from tmpos_invoice_draft.invoice_draft_line l
     where l.draft_id = p_draft_id and l.tenant_id = v_tenant and l.store_id = p_store_id;
    insert into tmpos_invoice_draft.invoice_draft_line
      (draft_id, tenant_id, store_id, position, description, quantity, unit_price_cents, line_total_cents)
    select p_draft_id, v_tenant, p_store_id, e.ordinality::integer, e.entry ->> 'description',
           (e.entry ->> 'quantity')::bigint, (e.entry ->> 'unitPriceCents')::bigint,
           ((e.entry ->> 'quantity')::numeric * (e.entry ->> 'unitPriceCents')::numeric)::bigint
      from pg_catalog.jsonb_array_elements(p_lines) with ordinality as e(entry, ordinality);
  exception
    when unique_violation or check_violation or foreign_key_violation or not_null_violation or numeric_value_out_of_range then
      raise exception 'migration 029 update: a line is not one the line table admits'
        using errcode = 'integrity_constraint_violation';
  end;
  begin
    update tmpos_invoice_draft.invoice_draft d
       set customer_id = p_customer_id, line_count = v_count, subtotal_cents = p_subtotal_cents, version = d.version + 1
     where d.draft_id = p_draft_id
       and d.tenant_id = v_tenant
       and d.store_id = p_store_id
       and d.version = p_expected_version
    returning d.version into v_written;
    get diagnostics v_updated = row_count;
  exception
    when check_violation or foreign_key_violation or not_null_violation then
      raise exception 'migration 029 update: the draft is not one the draft table admits'
        using errcode = 'integrity_constraint_violation';
  end;
  if v_updated <> 1 or v_written is distinct from p_expected_version + 1 then
    raise exception 'migration 029 update: the edit was not written to exactly the locked draft at the next version'
      using errcode = 'no_data_found';
  end if;

  -- 12. Exactly the lines step 0 judged: n rows at positions 1..n whose totals sum to the header's subtotal.
  select pg_catalog.count(*)::integer as n, pg_catalog.min(l.position) as lo, pg_catalog.max(l.position) as hi,
         coalesce(pg_catalog.sum(l.line_total_cents::numeric), -1) as total
    into v_check
    from tmpos_invoice_draft.invoice_draft_line l
   where l.draft_id = p_draft_id and l.tenant_id = v_tenant and l.store_id = p_store_id;
  if v_check.n is distinct from v_count or v_check.lo is distinct from 1 or v_check.hi is distinct from v_count
     or v_check.total is distinct from p_subtotal_cents::numeric then
    raise exception 'migration 029 update: the lines written are not exactly the lines judged'
      using errcode = 'no_data_found';
  end if;

  return query select 'applied'::text, v_tenant, p_store_id, v_admission.actor_id, v_membership, v_written;
end
$$;

comment on function tmpos_invoice_edit.m7b_invoice_draft_update_v2(text, uuid, uuid, uuid, bigint, uuid, jsonb, bigint) is
  'Phase 4.0 M7b (migration 030): migration 029''s m7b_invoice_draft_update with the role''s Invoices level held through completion: replaces one saved invoice draft''s customer and its 1-50 ordered lines at an expected version, at a store, for a key naming a ledger-minted, live (database clock, read after every lock wait) tenant session minted under the installed issuer key, after 016''s hold and the session, ledger and issuer key rows, whose standing digest is unchanged, whose account status is active or trialing, who holds EXACTLY ONE active store-scope grant at p_store_id (a selector only) on an active or trialing tenant and store — the store row re-read FOR SHARE in that grant''s tenant — and whose role''s Invoices level is Edit or above (store_owner full; manager, technician, sales_staff the owner''s stored level, else the catalog default). That level is read unlocked as an early pre-check and decided again after the draft header is locked and the role''s transaction-scoped advisory key pg_advisory_xact_lock_shared(530030, hashtext(tenant || ''/'' || role)) is taken (a plain read; nothing inserted or row-locked; the session''s clock read again after the wait), and the key is held until the command transaction ends, so every writer of an Invoices level — which takes the same key EXCLUSIVE through trg_tenant_role_level_invoice_guard — cannot commit an Invoices change while the edit holds the key (a waiting writer may time out and roll back instead), and a downgrade that committed first refuses the edit. Judges every argument first (invalid_parameter_value, a fixed message naming the field, never the value; the expected version 1 to 9007199254740990). Answers one row: (''refused'', NULLs) for any authority refusal, the second level decision and a session that expired while the key waited included; (''tenant_mismatch'', NULLs) when the grant''s tenant is not p_expected_tenant; then (''not_found'', NULLs) for a missing, another store''s and another tenant''s draft, answered when the header lock finds no such row, before the role''s key is taken; then, the draft locked FOR UPDATE and, for manager, technician and sales_staff, the key held: (''invalid_state'', NULLs) for a status other than draft; (''conflict'', NULLs) for any other version; (''not_found'', NULLs) again for a missing or another tenant''s customer; (''unchanged'', tenant, store, actor, membership, version) when the customer and the ordered lines equal the stored ones — all of these with nothing written and no role row made; else replaces the lines, writes the customer, line count, subtotal and version + 1 and answers (''applied'', tenant, store, actor, membership, new version). Never writes a role or version row, nor the id, tenant, store, status, currency, created_at or created_by. Writes no audit record.';

-- =============================================================================
-- 7) Privileges, and the proof that nothing wider was issued
-- =============================================================================
-- PostgreSQL grants EXECUTE on a new function to PUBLIC by default, so every default is removed explicitly before the one
-- intended grant is issued. The trigger function is granted to nobody. tmpos_app loses its EXECUTE on 029's routine, which stays
-- in its schema, unaltered, for the rollback. No table grant.
revoke all on function tmpos_invoice_edit.m7b_invoice_draft_update_v2(text, uuid, uuid, uuid, bigint, uuid, jsonb, bigint) from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
revoke all on function tmpos_invoice_edit.m7b_invoice_level_guard() from public, anon, authenticated, tmpos_app, tmpos_audit_writer;

revoke execute on function tmpos_invoice_draft.m7b_invoice_draft_update(text, uuid, uuid, uuid, bigint, uuid, jsonb, bigint) from tmpos_app;

grant execute on function tmpos_invoice_edit.m7b_invoice_draft_update_v2(text, uuid, uuid, uuid, bigint, uuid, jsonb, bigint) to tmpos_app;

-- =============================================================================
-- 8) Postcondition
-- =============================================================================
-- Proven rather than asserted, in 029's form. This file refuses to finish unless, now:
--   (a) schema tmpos_invoice_edit holds exactly the two functions this file creates and no relation or standalone type, and is
--       owned by the applying principal; its complete ACL is exactly the owner's USAGE and CREATE and a non-grantable USAGE to
--       tmpos_app, each granted by the owner;
--   (b) the trigger function is plpgsql, SECURITY INVOKER, VOLATILE, returns trigger, pinned to pg_catalog, pg_temp and owned
--       by the applying principal; the edit routine is plpgsql, SECURITY DEFINER, VOLATILE, pinned to pg_catalog, pg_temp with
--       row_security off and owned by the applying principal;
--   (c) the complete ACL of the edit routine is exactly two entries, the owner's EXECUTE and a non-grantable EXECUTE to tmpos_app,
--       which holds it, each granted by the owner; that of the trigger function exactly the owner's one; and that of 029's
--       routine now exactly the owner's one — tmpos_app included, PUBLIC included;
--   (d) tmpos_app CAN execute the edit routine and CANNOT execute the trigger function or 029's routine; tmpos_audit_writer,
--       anon and authenticated can execute none of the three, by any path;
--   (e) none of the four runtime roles is a MEMBER of the owner of the schema or of either function;
--   (f) tmpos_role.tenant_role_level carries EXACTLY two non-internal triggers: 021's, with its exact shape, and this file's —
--       AFTER ROW INSERT, UPDATE and DELETE, enabled ALWAYS, no column list, no WHEN — calling the trigger function, which
--       nothing else calls;
--   (g) the schema and both functions carry a comment.
-- Each ACL is read through coalesce(acl, acldefault(kind, owner)), and a role reachable through a membership is followed
-- whatever the membership's options (019's reasons). WHAT THIS DOES NOT PROVE: it is a snapshot at apply time; the runtime
-- LOGIN's grants are enforced at every start by the startup preflight (server/persistence/postgresStartupPreflight.ts).
do $$
declare
  v_bad   text;
  v_me    oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user);
  v_v2    oid := 'tmpos_invoice_edit.m7b_invoice_draft_update_v2(text, uuid, uuid, uuid, bigint, uuid, jsonb, bigint)'::regprocedure;
  v_guard oid := 'tmpos_invoice_edit.m7b_invoice_level_guard()'::regprocedure;
  v_029   oid := 'tmpos_invoice_draft.m7b_invoice_draft_update(text, uuid, uuid, uuid, bigint, uuid, jsonb, bigint)'::regprocedure;
begin
  -- (a)
  if (select pg_catalog.string_agg(p.oid::regprocedure::text, ', ' order by p.oid::regprocedure::text)
        from pg_catalog.pg_proc p where p.pronamespace = 'tmpos_invoice_edit'::regnamespace)
     is distinct from
     'tmpos_invoice_edit.m7b_invoice_draft_update_v2(text,uuid,uuid,uuid,bigint,uuid,jsonb,bigint), tmpos_invoice_edit.m7b_invoice_level_guard()'
     or exists (select 1 from pg_catalog.pg_class c where c.relnamespace = 'tmpos_invoice_edit'::regnamespace)
     or exists (select 1 from pg_catalog.pg_type t
                 where t.typnamespace = 'tmpos_invoice_edit'::regnamespace and t.typrelid = 0 and t.typelem = 0)
     or not exists (select 1 from pg_catalog.pg_namespace n where n.oid = 'tmpos_invoice_edit'::regnamespace and n.nspowner = v_me) then
    raise exception 'migration 030 refused: schema tmpos_invoice_edit does not hold exactly the two functions this file creates, or is not owned by the applying principal'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  select pg_catalog.string_agg(pg_catalog.format('%s:%s', g.grantee::regrole::text, g.privilege_type), ', ')
    into v_bad
    from pg_catalog.pg_namespace n,
         pg_catalog.aclexplode(coalesce(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) g
   where n.oid = 'tmpos_invoice_edit'::regnamespace
     and not (not g.is_grantable and g.grantor = n.nspowner
              and ((g.grantee = n.nspowner and g.privilege_type in ('USAGE', 'CREATE'))
                   or (g.grantee = 'tmpos_app'::regrole and g.privilege_type = 'USAGE')));
  -- The complete ACL, the owner's entries included: exactly the owner's USAGE and CREATE and tmpos_app's USAGE, three rows.
  if v_bad is not null
     or (select pg_catalog.count(*)
           from pg_catalog.pg_namespace n,
                pg_catalog.aclexplode(coalesce(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) g
          where n.oid = 'tmpos_invoice_edit'::regnamespace) <> 3
     or not pg_catalog.has_schema_privilege('tmpos_app', 'tmpos_invoice_edit'::regnamespace, 'USAGE') then
    raise exception 'migration 030 refused: schema tmpos_invoice_edit carries an unexpected grant or lacks an expected one (%), or tmpos_app cannot use it', coalesce(v_bad, 'none listed')
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (b)
  if not exists (select 1 from pg_catalog.pg_proc p join pg_catalog.pg_language l on l.oid = p.prolang
                  where p.oid = v_guard
                    and l.lanname = 'plpgsql' and not p.prosecdef and p.provolatile = 'v'
                    and p.prorettype = 'pg_catalog.trigger'::regtype
                    and p.proconfig = array['search_path=pg_catalog, pg_temp'] and p.proowner = v_me)
     or not exists (select 1 from pg_catalog.pg_proc p join pg_catalog.pg_language l on l.oid = p.prolang
                     where p.oid = v_v2
                       and l.lanname = 'plpgsql' and p.prosecdef and p.provolatile = 'v'
                       and p.prorettype <> 'pg_catalog.trigger'::regtype
                       and p.proconfig = array['search_path=pg_catalog, pg_temp', 'row_security=off'] and p.proowner = v_me) then
    raise exception 'migration 030 refused: the trigger function is not the plpgsql SECURITY INVOKER VOLATILE function section 5 declares, or the edit routine is not the plpgsql SECURITY DEFINER VOLATILE routine pinned to pg_catalog, pg_temp with row_security off section 6 declares, or one is not owned by the applying principal'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (c)
  select pg_catalog.string_agg(pg_catalog.format('%s %s:%s', p.proname, g.grantee::regrole::text, g.privilege_type), ', ')
    into v_bad
    from pg_catalog.pg_proc p,
         pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g
   where p.oid in (v_v2, v_guard, v_029)
     and not (g.privilege_type = 'EXECUTE' and not g.is_grantable and g.grantor = p.proowner
              and (g.grantee = p.proowner or (p.oid = v_v2 and g.grantee = 'tmpos_app'::regrole)));
  -- The complete ACL, the owner's entry included: v2 exactly two entries (the owner's and tmpos_app's), the others exactly one.
  if v_bad is not null
     or exists (select 1 from pg_catalog.pg_proc p
                 where p.oid in (v_v2, v_guard, v_029)
                   and (select pg_catalog.count(*)
                          from pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g)
                       <> case when p.oid = v_v2 then 2 else 1 end) then
    raise exception 'migration 030 refused: an unexpected direct grant remains on the edit routine, the trigger function or 029''s routine, or an entry is missing (%)', coalesce(v_bad, 'none listed')
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if (select pg_catalog.count(*)
        from pg_catalog.pg_proc p,
             pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g
       where p.oid = v_v2 and g.grantee = 'tmpos_app'::regrole and g.privilege_type = 'EXECUTE' and not g.is_grantable) <> 1 then
    raise exception 'migration 030 refused: tmpos_app does not hold a direct EXECUTE on the edit routine'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (d)
  if not pg_catalog.has_function_privilege('tmpos_app', v_v2, 'EXECUTE')
     or pg_catalog.has_function_privilege('tmpos_app', v_guard, 'EXECUTE')
     or pg_catalog.has_function_privilege('tmpos_app', v_029, 'EXECUTE') then
    raise exception 'migration 030 refused: tmpos_app must execute the edit routine and neither the trigger function nor 029''s routine'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  select pg_catalog.string_agg(distinct r.rolname::text || ' ' || p.proname::text, ', ') into v_bad
    from pg_catalog.pg_roles r
    join pg_catalog.pg_roles x on pg_catalog.pg_has_role(r.oid, x.oid, 'MEMBER')
    cross join pg_catalog.pg_proc p
   where p.oid in (v_v2, v_guard, v_029)
     and (r.rolname = any (array['tmpos_audit_writer', 'anon', 'authenticated']::name[])
          or (r.rolname = 'tmpos_app' and p.oid in (v_guard, v_029)))
     and pg_catalog.has_function_privilege(x.oid, p.oid, 'EXECUTE');
  if v_bad is not null then
    raise exception 'migration 030 refused: a runtime role can execute a function this file does not grant it (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (e)
  select pg_catalog.string_agg(distinct r.rolname::text, ', ') into v_bad
    from pg_catalog.pg_roles r
    cross join (
      select n.nspowner as owner from pg_catalog.pg_namespace n where n.oid = 'tmpos_invoice_edit'::regnamespace
      union
      select p.proowner from pg_catalog.pg_proc p where p.oid in (v_v2, v_guard)
    ) o
   where r.rolname = any (array['tmpos_app', 'tmpos_audit_writer', 'anon', 'authenticated']::name[])
     and pg_catalog.pg_has_role(r.oid, o.owner, 'MEMBER');
  if v_bad is not null then
    raise exception 'migration 030 refused: % is a member of the owner of schema tmpos_invoice_edit or of a function in it', v_bad
      using errcode = 'object_not_in_prerequisite_state',
            hint = 'membership hands a role everything the owner holds, including a direct write of every level and draft';
  end if;

  -- (f) tgtype: ROW 1 + INSERT 4 + DELETE 8 + UPDATE 16 = 29 (AFTER sets no bit; TRUNCATE and INSTEAD OF absent). 021's: 17.
  if (select pg_catalog.count(*) from pg_catalog.pg_trigger g
       where g.tgrelid = 'tmpos_role.tenant_role_level'::regclass and not g.tgisinternal) <> 2
     or (select pg_catalog.count(*) from pg_catalog.pg_trigger g where g.tgfoid = v_guard) <> 1
     or (select pg_catalog.count(*) from pg_catalog.pg_trigger g
          where g.tgfoid = 'tmpos_role_edit.m7a_role_level_version_advance()'::regprocedure) <> 1
     or not exists (select 1 from pg_catalog.pg_trigger g
                     where g.tgrelid = 'tmpos_role.tenant_role_level'::regclass
                       and g.tgname = 'trg_tenant_role_level_invoice_guard'
                       and g.tgfoid = v_guard
                       and g.tgtype = 29
                       and g.tgenabled = 'A'
                       and g.tgattr = ''::pg_catalog.int2vector
                       and g.tgqual is null
                       and not g.tgisinternal)
     or not exists (select 1 from pg_catalog.pg_trigger g
                     where g.tgrelid = 'tmpos_role.tenant_role_level'::regclass
                       and g.tgname = 'trg_tenant_role_level_version_advance'
                       and g.tgfoid = 'tmpos_role_edit.m7a_role_level_version_advance()'::regprocedure
                       and g.tgtype = 17
                       and g.tgenabled = 'A'
                       and g.tgattr = ''::pg_catalog.int2vector
                       and g.tgqual is null
                       and not g.tgisinternal) then
    raise exception 'migration 030 refused: tmpos_role.tenant_role_level does not carry exactly 021''s version trigger and the guard trigger section 5 declares'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (g)
  if pg_catalog.obj_description('tmpos_invoice_edit'::regnamespace, 'pg_namespace') is null
     or pg_catalog.obj_description(v_v2, 'pg_proc') is null
     or pg_catalog.obj_description(v_guard, 'pg_proc') is null then
    raise exception 'migration 030 refused: the schema or a function it holds carries no comment'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$$;

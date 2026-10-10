-- Phase 4.0 M7b — holding the Customers View authority through both sealed outcomes of the invoice-draft save: every writer of a
-- Customers level made to take migration 030's advisory key EXCLUSIVE through one more row trigger, and 031's save routine
-- re-issued to decide the Customers level again under the key it already takes SHARED, with 031's routine closed to the
-- runtime role (M7B-INVOICES-P1-R4; DA-211; G-IAM, G-ISOLATION, G-DBROLE; docs/phase-4/05, 08, 10)
-- Migration: 032_m7b_invoice_create_customers_authority (UP)
--
-- SCOPE / TRUTH (binding):
--   - ONE TRIGGER FUNCTION, ONE TRIGGER, ONE ROUTINE, THREE PRIVILEGE CHANGES, all in 030's schema tmpos_invoice_edit. The
--     trigger function m7b_customers_level_guard() and the trigger trg_tenant_role_level_customers_guard (AFTER INSERT OR UPDATE
--     OR DELETE, FOR EACH ROW, ENABLE ALWAYS) on tmpos_role.tenant_role_level; the save routine m7b_invoice_draft_create_v3. The
--     privilege changes: every default EXECUTE on the new routine and on the trigger function (PUBLIC's) removed, the trigger
--     function granted to nobody; tmpos_app gains EXECUTE on the routine (it already holds USAGE on the schema, from 030);
--     tmpos_app loses its EXECUTE on 031's tmpos_invoice_edit.m7b_invoice_draft_create_v2.
--     NO TABLE, COLUMN, INDEX, ROW, ROLE, MEMBERSHIP, POLICY, TYPE OR SCHEMA; no comment on an earlier object; no privilege on
--     any table. 001-031 stay byte for byte as committed (the migration-files contract's pinned checksums prove that); 031's
--     routine stays where it is, unaltered (owner-executable only); 028's routine stays closed to tmpos_app (031 closed it);
--     030's schema, trigger, trigger function and edit routine and 021's trigger are not altered.
--   - WHY IT EXISTS (DA-211). 031's create_v2 decides the role's Customers level at View ONCE, UNLOCKED (its step 8, 031
--     up:571-595); its step 10b re-reads only the Invoices level under the key (031 up:613-641); its step 10c answers the sealed
--     'customer_not_found' (031 up:643-647) before the only locked Customers re-decision (steps 11-12, 031 up:649-676, reached
--     on the applied path alone). Writers of a Customers level take no key: 030's trigger filters the domain 'invoices' (030
--     up:385-404). An owner's narrowing of the Customers level below View that commits after step 8 therefore still let the save
--     seal its 422 and commit its idempotency completion — 031's first recorded residual (031 up:81-84). The stage's contract is
--     030's: current authority stays valid and protected through every newly sealed outcome, for BOTH levels the save requires
--     (Invoices at Create and Customers at View). A read that finds no row protects nothing about that absence at READ
--     COMMITTED, and a refusal or a 'customer_not_found' may create no configuration row (030's and 031's reasoning), so the
--     Customers level needs what the Invoices level has: a key every writer meets.
--   - THE GUARD, REUSED, NOT CHANGED: 030's transaction-scoped advisory key per (tenant, role),
--     pg_catalog.pg_advisory_xact_lock{,_shared}(530030, pg_catalog.hashtext(<tenant>::text || '/' || <role>)) — the identical
--     key and the identical expression, derived INLINE in the trigger function and in the routine (030's reason: a SECURITY
--     INVOKER trigger function that called a helper would run it as the writer). One key per (tenant, role) now guards both of
--     the pair's levels: 030's trigger takes it EXCLUSIVE for every write that can change an Invoices level, this file's for
--     every write that can change a Customers level; 030's edit and this file's save take it SHARED. 030's header gives why it
--     is a key and not a row and its availability residuals; this file adds one more EXCLUSIVE taker and one more SHARED holder.
--   - EVERY WRITER PARTICIPATES, BY A TRIGGER ON THE TABLE, not by editing a writer: 021's and 020's Customers setters are
--     frozen, and the table's owner and any older or later path write the table directly. trg_tenant_role_level_customers_guard
--     is AFTER INSERT OR UPDATE OR DELETE, FOR EACH ROW, ENABLE ALWAYS (021's and 030's form: a session running as a replica
--     meets it too), no column list, no WHEN. Its function is 030's m7b_invoice_level_guard() with the domain 'customers' in
--     place of 'invoices', otherwise the same: it takes the key EXCLUSIVE for
--       * an INSERT of a row whose domain is 'customers' and whose level is NOT NULL: the NEW row's key;
--       * an UPDATE of a row whose OLD or NEW domain is 'customers': the OLD row's key and, when the update moved the row to
--         another (tenant, role), the NEW row's too — the smaller integer first;
--       * a DELETE of a row whose domain is 'customers' and whose level is NOT NULL: the OLD row's key;
--     and takes NOTHING otherwise. The INSERT of a NULL level — the lock anchors of 020's customer create (through 023), 024's
--     customer edit, 021's and 020's setters (their first write) and 031's create_v2 — and the DELETE of a NULL row take no key:
--     NULL is the catalog default, exactly what an absent row means, so such a write changes no effective level (and a key
--     there would serialize every customer create and edit of a role). An update to or from NULL is an UPDATE and takes it; a
--     reset to the default is an UPDATE to the default word (021), so it takes it. 021's setter therefore takes the key at its
--     level UPDATE, after its Customers role row FOR UPDATE and its version row FOR UPDATE (none on a role's first level change:
--     021's AFTER trigger, which fires after this one, INSERTs the version row after the key).
--     FIRING ORDER, NAME ORDER: AFTER ROW triggers of one event fire in name order, and 'trg_tenant_role_level_customers_guard'
--     sorts before 030's 'trg_tenant_role_level_invoice_guard' and 021's 'trg_tenant_role_level_version_advance' ('c' < 'i' <
--     'v'; the postcondition pins the three names in that order). So a row that moves between the Customers and the Invoices
--     domain, or to another (tenant, role), takes its COMPLETE old/new key set here, ascending, before 030's trigger re-enters
--     the same keys — an advisory lock a transaction already holds is granted to it again without a wait — and no single row
--     takes a lower key after a higher one. A domain move inside one pair is one key.
--     AFTER, not BEFORE (030's reason): a BEFORE INSERT trigger would take the key BEFORE the primary key's uniqueness check, so
--     a raw INSERT of a level racing a setter's first insertion (its uncommitted NULL anchor) would hold the key while waiting
--     for that transaction, which in turn waits for the key. An AFTER ROW trigger fires only for a row actually written (an
--     INSERT skipped by ON CONFLICT DO NOTHING takes nothing), at the end of the writing statement and still before COMMIT.
--     TRUNCATE fires no row trigger; it is ordered by a relation lock instead: the save reads the table by plain SELECTs from
--     its step 8 on, whose ACCESS SHARE is held to COMMIT, and TRUNCATE needs ACCESS EXCLUSIVE (owner-only: no runtime role
--     holds any privilege on the table). That is an invariant of the routine below — it reads the table by plain SELECT, never
--     FOR SHARE or FOR UPDATE, and never writes it.
--   - THE SAVE, tmpos_invoice_edit.m7b_invoice_draft_create_v3: 031's create_v2 with its signature, its RETURNS TABLE, its
--     answers and attributes (plpgsql, SECURITY DEFINER, VOLATILE, search_path pg_catalog then pg_temp, row_security off) and
--     every statement and every raised message of its body character for character, EXCEPT EXACTLY TWO CHANGES:
--       (~) STEP 10b DECIDES BOTH LEVELS: after the key (the unchanged statement) and the clock (unchanged), the Invoices level
--           AND the Customers level are each read again by a plain SELECT — separate statements, fresh READ COMMITTED snapshots
--           taken after the wait — and decided exactly as step 8 decides them (the stored level, else the catalog default;
--           Invoices below Create or Customers below View is ('refused', NULLs)). Still SEPARATE top-level statements of the
--           routine's outermost block, never inside a BEGIN ... EXCEPTION block (a subtransaction that aborts releases a
--           transaction-scoped advisory lock). Both sealed answers — 'customer_not_found' (10c) and 'applied' — are decided after
--           10b and committed while the key is held. Step 8 (unlocked) stays an early pre-check; 10b is the decision of record
--           for both levels. Nothing is inserted or row locked. store_owner is Full by the catalog, never stored: no key, no read.
--       (-) STEPS 11-12 REMOVED: the Customers NULL anchor INSERT, its FOR SHARE and the locked re-decision. REQUIRED, not
--           cosmetic: with this file's trigger a Customers setter holds its role row FOR UPDATE (and its version row) BEFORE it
--           requests the key EXCLUSIVE; a save holding the key SHARED that then waited for that row (or for its anchor's INSERT
--           behind a setter's uncommitted one) would close a cycle (40P01). After 10b neither level can change until COMMIT, so
--           11-12's re-decision is redundant. The save now writes no role row and no version row at all, on any path.
--     Step 13 (clock, customer FOR KEY SHARE, clock) and steps 14-15 are unchanged; only comments that named step 11 or the
--     Invoices level alone are adjusted.
--     A new routine, not a replacement of 031's — as 031 superseded 028's save and 030 029's edit: the new name carries the new
--     contract, tmpos_app's EXECUTE on the old one is revoked, and 031's routine stays byte for byte in place, so the rollback
--     restores 031's exact contract by granting that EXECUTE again. In 030's schema, as 031's is: 030's rollback ends with a plain
--     DROP SCHEMA tmpos_invoice_edit, which refuses (dependent_objects_still_exist, 2BP01) while this file's objects are in the
--     schema; and 031's rollback pins the exact function inventory of the schema and exactly two non-internal triggers on the
--     level table, so it refuses while this file is applied (see DEPLOY AND ROLLBACK).
--   - THE ORDERING (the stage's contract). A narrowing of either level that commits before 10b's key is granted is read by 10b's
--     fresh SELECTs: the save answers ('refused', NULLs) and the runtime rolls the command transaction back — no completion,
--     draft, line, audit record, event or role row — which is the existing transaction-time refusal (the generic 503, the lease
--     kept). A writer cannot COMMIT a Customers or an Invoices change of the pair while a save holds the key (a waiting writer
--     may instead time out and roll back). A request that completed before a narrowing stays completed; a replay is judged by
--     the chain's unlocked current-authority check as before — this file adds no lock to a replay.
--   - LOCK ORDER (every participant; the fence, 016's hold, session and ledger, issuer order of every tenant write is unchanged):
--       the save (v3):      fence -> 016's hold -> 016's hold again -> session and ledger rows FOR SHARE -> issuer key row FOR
--                           SHARE -> store row FOR SHARE -> [8] the level table, plain reads (ACCESS SHARE to COMMIT) -> [10] the
--                           customer, a plain read -> [10b] THE KEY, SHARED -> the clock -> the Invoices and the Customers level,
--                           plain reads -> [10c] 'customer_not_found' | [13] the customer FOR KEY SHARE -> the new header and
--                           lines -> (the runtime) audit record, outbox event, completion -> COMMIT. It never waits for a role
--                           row or a version row.
--       021's Customers setter (v2, the runtime PUT): fence -> 016's hold -> session, ledger, issuer -> the Customers role row
--                           (anchor inserted, then FOR UPDATE) -> the clock -> the version row FOR UPDATE (none on a role's first
--                           level change) -> the level UPDATE -> [this file's trigger] THE KEY, EXCLUSIVE -> [030's trigger:
--                           nothing for a Customers row] -> [021's trigger] the version upsert -> (the runtime) the recent
--                           sign-in check, audit record, outbox event, completion. It never waits for a header, a customer or a
--                           line. 020's legacy setter (owner-only since 021) has the same order without the version FOR UPDATE.
--       026's Invoices setter: unchanged — ... -> the Invoices role row (anchor, FOR UPDATE) -> version row FOR UPDATE -> the
--                           level UPDATE -> [this file's trigger: nothing for an Invoices row] -> [030's trigger] THE KEY,
--                           EXCLUSIVE -> [021's trigger] the version upsert.
--       030's edit (v2):    unchanged — ... -> draft header FOR UPDATE -> [5b] THE KEY, SHARED -> the replacement customer FOR
--                           KEY SHARE -> the lines. It never waits for a role row or a version row.
--       024's customer edit: unchanged — ... -> the Customers role row (NULL anchor + FOR SHARE: no key) -> the customer FOR
--                           UPDATE. It never takes the key. 020's customer create (through 023): the Customers role row (NULL
--                           anchor + FOR SHARE: no key) -> the new customer; never the key.
--     WHY IT CANNOT CYCLE: the key adds three kinds of wait edge only — a save or an edit behind a writer's EXCLUSIVE, a writer
--     behind saves' and edits' SHARED, and a writer behind another writer's EXCLUSIVE. After its key a save waits only for the
--     customer (FOR KEY SHARE, which only a FOR UPDATE blocks: 024's customer edit or the owner — 024 takes no key and, holding
--     the customer, waits for nothing a key holder holds: it locked its Customers role row BEFORE the customer) and for its own
--     new rows; an edit after its key waits only for a customer and its own rows (030). A writer taking the key EXCLUSIVE holds
--     before it, beyond what every tenant write locks first, only its own pair's role row of its domain and that row's version
--     row, which no save or edit ever waits for — neither locks a role row or a version row — and after the key it writes only
--     the version rows of the row it wrote (021's upsert), beside its own audit, outbox and completion rows, none of which a key
--     holder waits for. A Customers setter waiting for the key holds its Customers role row FOR UPDATE, so a 024 edit or a
--     customer create of the pair waits on that row BEFORE it locks any customer: it holds nothing a save waits for. Writer
--     behind writer: two writers of one row serialize on the row before either takes the key; a Customers and an Invoices
--     setter of one pair hold disjoint rows (role rows and version rows are per (tenant, role, DOMAIN): 021 up:195-203), and the
--     second waits for the key behind the first, which after its key touches only its own version row. SHARED keys are
--     compatible: saves and edits of one role do not conflict on the key (a later SHARED request queues only behind a waiting
--     EXCLUSIVE one: CONVOY below).
--     THE RULE (030's, WIDENED TO BOTH DOMAINS): A TRANSACTION HOLDING THE KEY SHARED (A SAVE OR AN EDIT) NEVER LOCKS A
--     CUSTOMERS OR AN INVOICES ROLE ROW OR VERSION ROW AFTER TAKING IT; A WRITER TAKING IT EXCLUSIVE HOLDS BEFORE IT NOTHING A
--     KEY HOLDER WAITS FOR AFTER ITS KEY (another pair's version row, a customer, a draft's lines), AND AFTER IT WRITES NO ROLE
--     ROW OR VERSION ROW BUT THE VERSION ROWS OF THE ROLE ROW IT ALREADY HOLDS. The runtime never breaks it: it runs one mutator
--     per command transaction, and each runtime setter writes exactly one row of one (tenant, role, domain).
--   - WRITER LIVENESS. 021's setter's new key wait follows its last clock check (021 up:408-411), as 026's does since 030. 021 is
--     not changed. On the runtime path the role-level mutator re-judges the owner's recent sign-in on the database clock after
--     the setter returns, in the same command transaction (postgresRoleLevels.ts, authenticationFresh), and that deadline
--     precedes the session's expiry. A direct tmpos_app caller of 021's setter (no runtime, no audit, no recent sign-in — the
--     existing G-AUDIT class) could hold its transaction on the key past its session's expiry: 030's recorded residual, now
--     for the Customers setter too.
--   - WHAT THIS DOES NOT DEFEND (doc 08; none of it is claimed closed). 028's, 030's and 031's residuals stand for the save, and:
--       * the TABLE OWNER, or a member of the owner role, can DISABLE either trigger, replace a function, or alter the table by
--         DDL that does not wait for a save in flight: DA-211 is closed for the runtime save WHILE THIS FILE'S TRIGGER IS
--         ENABLED (and DA-210 while 030's is);
--       * the owner can still run 031's create_v2 directly (only tmpos_app's EXECUTE is revoked) and 028's create: neither
--         decides the Customers level under the key, and create_v2 — the key SHARED, then its Customers anchor and FOR SHARE —
--         can now deadlock with a Customers setter (40P01: availability; the reason tmpos_app loses it);
--       * MULTI-PAIR AND MULTI-DOMAIN WRITERS (030's class, widened): a table-owner transaction that writes several (tenant,
--         role) pairs, or both domains of one pair in separate statements, or that locks a customer and then writes a level,
--         breaks THE RULE and can deadlock with a setter, a save or an edit (40P01: availability, no wrong authority answer);
--         one owner statement over several pairs takes keys row by row, not sorted across rows (030's class). A direct
--         tmpos_app transaction that holds the key SHARED (030's edit or this save) and then runs 023's customer create or 024's
--         customer edit (a Customers role row FOR SHARE after the key) can deadlock with a Customers setter the same way;
--       * ANY DATABASE LOGIN can hold the key (the advisory functions are executable by PUBLIC): availability only, 030's
--         residual, now covering Customers level writes too;
--       * two (tenant, role) pairs with equal hashes are serialized (availability);
--       * CONTENTION AND CONVOY: Customers level writes now wait for in-flight draft saves AND draft edits of the same (tenant,
--         role) — an edit decides only the Invoices level yet shares the key — and Customers and Invoices setters of one pair
--         serialize on it; a Customers setter waiting for the key holds its role row FOR UPDATE, so that role's customer
--         creates and customer edits queue on the row behind it, and a later save or edit of the role queues on the key behind
--         it — every wait bounded by the command transaction's lock and statement timeouts (70% and 90% of its 2000 ms
--         deadline), ending in the existing 503 with the lease kept.
--   - APPLY: A MAINTENANCE WINDOW, 030's. Before any check and before any change — its first statements after the search path,
--     with nothing read before them, not even the catalog — the file takes ACCESS EXCLUSIVE until COMMIT on 030's seven tables
--     in the writers' order: public.store, tmpos_role.tenant_role_level, tmpos_role_edit.role_level_version,
--     tmpos_customer.customer, tmpos_invoice_draft.invoice_draft, tmpos_invoice_draft.invoice_draft_line, public.audit_event —
--     in one block whose handler turns a missing table or schema into this file's refusal (55000), the block's locks released
--     first. So no draft save or edit, level write, store, customer or audit write is in flight while the trigger goes in and
--     the grant moves: it committed before this file read anything or waits for its COMMIT. THE COST: every read and write of
--     those seven tables waits until COMMIT, though no row is rewritten; creating the trigger takes the level table's lock
--     anyway.
--   - DEPLOY AND ROLLBACK: FAIL CLOSED BOTH WAYS. It and the runtime that calls create_v3 move together: the startup preflight
--     pins the exact ledger (001-032) and the exact grants (create_v3's EXECUTE in place of create_v2's), so the 001-031 runtime
--     refuses a 032 database (its EXECUTE is gone) and this runtime refuses a 031 one. ROLL 032 BACK BEFORE 031, AND 031 BEFORE
--     030: 031's rollback refuses while this file is applied (its postcondition finds this file's two functions in
--     tmpos_invoice_edit and a third non-internal trigger on the level table, and the whole 031 rollback rolls back — the
--     intended atomic refusal), and 030's rollback refuses too (its plain DROP SCHEMA meets this file's objects, 2BP01). The
--     rollback NEVER REFUSES ON DATA: this file adds no table, row or version (an advisory key lives and dies with a
--     transaction), so every draft at any version, line, role row, version row, audit record, outbox row and completion stays;
--     it refuses only on the catalog or the applier's rights. IT RESTORES THE 031-ERA CONTRACT AND THE DA-211 WINDOW: after it,
--     the save routine tmpos_app can call is create_v2 again, whose sealed 'customer_not_found' rests on the unlocked Customers
--     decision, and writers of a Customers level take no key again.
--   - NO SECRET, NO DYNAMIC SQL, NO EXTENSION, NO TEMPORARY OBJECT, NO BACKFILL. Every statement is fixed text, every value a
--     parameter, every relation and routine schema-qualified; the routine pins its search_path to pg_catalog then pg_temp and
--     runs with row_security off; the trigger function pins its search_path.
--
-- Reversible via 032_m7b_invoice_create_customers_authority.down.sql, which never refuses on data and restores 031's grant.
-- Roll 032 back before 031, and 031 before 030.
--
-- Assumes 001-031 are applied. A future managed apply targets the complete contiguous chain through the newest committed
-- migration — now 001-032 (owner decision D4); this file authorizes no apply.

-- =============================================================================
-- 1) This transaction's search path
-- =============================================================================
set local search_path = pg_catalog, pg_temp;

-- =============================================================================
-- 2) The locks, in the writers' order: the first statements after the search path, before any check or any change
-- =============================================================================
-- 030's seven tables, in 030's order. Nothing is read or checked before them, not even the catalog. A LOCK naming a table or
-- schema that is missing raises undefined_table (42P01) or invalid_schema_name (3F000); the block's handler turns either into
-- this file's refusal (55000). The block runs as a subtransaction: once it completes, this transaction keeps its locks until
-- COMMIT; refused, the subtransaction has released the locks it took, and the refusal aborts the file.
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
    raise exception 'migration 032 refused: public.store, tmpos_role.tenant_role_level, tmpos_role_edit.role_level_version, tmpos_customer.customer, tmpos_invoice_draft.invoice_draft, tmpos_invoice_draft.invoice_draft_line or public.audit_event is missing (migrations 002, 017, 020, 021 and 028 must be applied first)'
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
  if pg_catalog.to_regprocedure('tmpos_invoice_edit.m7b_invoice_draft_create_v3(text, uuid, uuid, uuid, uuid, jsonb, bigint)') is not null
     or pg_catalog.to_regprocedure('tmpos_invoice_edit.m7b_customers_level_guard()') is not null
     or exists (select 1 from pg_catalog.pg_trigger g
                 where g.tgrelid = 'tmpos_role.tenant_role_level'::regclass and g.tgname = 'trg_tenant_role_level_customers_guard') then
    raise exception 'migration 032 refused: tmpos_invoice_edit.m7b_invoice_draft_create_v3, tmpos_invoice_edit.m7b_customers_level_guard or the trigger trg_tenant_role_level_customers_guard already exists'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- The runtime roles this file grants to and revokes from, checked before any ::regrole cast below can raise undefined_object.
  if (select pg_catalog.count(*) from pg_catalog.pg_roles r
       where r.rolname = any (array['tmpos_app', 'tmpos_audit_writer', 'anon', 'authenticated']::name[])) <> 4 then
    raise exception 'migration 032 refused: the runtime roles tmpos_app, tmpos_audit_writer, anon and authenticated must exist (migration 005 and the Supabase roles)'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- The chain is contiguous: 031 is the newest migration this file sits on, exactly as 031 left it — 030's schema holding
  -- exactly 030's two functions and 031's routine and nothing else, with exactly 030's and 031's grants, 028's routine closed
  -- to everyone but its owner, and 021's and 030's triggers the only ones on the level table, in their exact shapes, enabled
  -- ALWAYS.
  if pg_catalog.to_regnamespace('tmpos_invoice_edit') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_edit.m7b_invoice_draft_update_v2(text, uuid, uuid, uuid, bigint, uuid, jsonb, bigint)') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_edit.m7b_invoice_level_guard()') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_edit.m7b_invoice_draft_create_v2(text, uuid, uuid, uuid, uuid, jsonb, bigint)') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_draft.m7b_invoice_draft_create(text, uuid, uuid, uuid, uuid, jsonb, bigint)') is null then
    raise exception 'migration 032 refused: migration 031 must be applied first (schema tmpos_invoice_edit, 030''s edit routine and trigger function, 031''s save routine and 028''s)'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if (select pg_catalog.string_agg(p.oid::regprocedure::text, ', ' order by p.oid::regprocedure::text)
        from pg_catalog.pg_proc p where p.pronamespace = 'tmpos_invoice_edit'::regnamespace)
     is distinct from
     'tmpos_invoice_edit.m7b_invoice_draft_create_v2(text,uuid,uuid,uuid,uuid,jsonb,bigint), tmpos_invoice_edit.m7b_invoice_draft_update_v2(text,uuid,uuid,uuid,bigint,uuid,jsonb,bigint), tmpos_invoice_edit.m7b_invoice_level_guard()'
     or exists (select 1 from pg_catalog.pg_class c where c.relnamespace = 'tmpos_invoice_edit'::regnamespace)
     or exists (select 1 from pg_catalog.pg_type t where t.typnamespace = 'tmpos_invoice_edit'::regnamespace)
     -- 030's grants, exactly: the edit routine's complete ACL is the owner's EXECUTE and tmpos_app's, the trigger function's
     -- the owner's alone, the schema's the owner's USAGE and CREATE and tmpos_app's USAGE — each granted by the owner and
     -- non-grantable, every entry read through coalesce(acl, acldefault), the owner's included (PUBLIC would be one more).
     or exists (select 1
                  from pg_catalog.pg_proc p,
                       pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g
                 where p.oid in ('tmpos_invoice_edit.m7b_invoice_draft_update_v2(text, uuid, uuid, uuid, bigint, uuid, jsonb, bigint)'::regprocedure,
                                 'tmpos_invoice_edit.m7b_invoice_level_guard()'::regprocedure)
                   and not (g.privilege_type = 'EXECUTE' and not g.is_grantable and g.grantor = p.proowner
                            and (g.grantee = p.proowner
                                 or (p.oid = 'tmpos_invoice_edit.m7b_invoice_draft_update_v2(text, uuid, uuid, uuid, bigint, uuid, jsonb, bigint)'::regprocedure
                                     and g.grantee = 'tmpos_app'::regrole))))
     or (select pg_catalog.count(*)
           from pg_catalog.pg_proc p,
                pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g
          where p.oid = 'tmpos_invoice_edit.m7b_invoice_draft_update_v2(text, uuid, uuid, uuid, bigint, uuid, jsonb, bigint)'::regprocedure) <> 2
     or (select pg_catalog.count(*)
           from pg_catalog.pg_proc p,
                pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g
          where p.oid = 'tmpos_invoice_edit.m7b_invoice_level_guard()'::regprocedure) <> 1
     or exists (select 1
                  from pg_catalog.pg_namespace n,
                       pg_catalog.aclexplode(coalesce(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) g
                 where n.oid = 'tmpos_invoice_edit'::regnamespace
                   and not (not g.is_grantable and g.grantor = n.nspowner
                            and ((g.grantee = n.nspowner and g.privilege_type in ('USAGE', 'CREATE'))
                                 or (g.grantee = 'tmpos_app'::regrole and g.privilege_type = 'USAGE'))))
     or (select pg_catalog.count(*)
           from pg_catalog.pg_namespace n,
                pg_catalog.aclexplode(coalesce(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) g
          where n.oid = 'tmpos_invoice_edit'::regnamespace) <> 3
     -- 028's routine, exactly as 031 left it: its complete ACL the owner's EXECUTE alone, granted by the owner, non-grantable.
     or (select pg_catalog.count(*)
           from pg_catalog.pg_proc p,
                pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g
          where p.oid = 'tmpos_invoice_draft.m7b_invoice_draft_create(text, uuid, uuid, uuid, uuid, jsonb, bigint)'::regprocedure) <> 1
     or (select pg_catalog.count(*)
           from pg_catalog.pg_proc p,
                pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g
          where p.oid = 'tmpos_invoice_draft.m7b_invoice_draft_create(text, uuid, uuid, uuid, uuid, jsonb, bigint)'::regprocedure
            and g.grantee = p.proowner and g.privilege_type = 'EXECUTE' and not g.is_grantable
            and g.grantor = p.proowner) <> 1 then
    raise exception 'migration 032 refused: schema tmpos_invoice_edit does not hold exactly migration 030''s two functions and 031''s routine and nothing else, or 030''s grants or 028''s routine''s are not exactly as 031 left them'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- tgtype: ROW 1 + INSERT 4 + DELETE 8 + UPDATE 16 = 29 (030's); ROW 1 + UPDATE 16 = 17 (021's).
  if (select pg_catalog.count(*) from pg_catalog.pg_trigger g
       where g.tgrelid = 'tmpos_role.tenant_role_level'::regclass and not g.tgisinternal) <> 2
     or not exists (select 1 from pg_catalog.pg_trigger g
                     where g.tgrelid = 'tmpos_role.tenant_role_level'::regclass
                       and g.tgname = 'trg_tenant_role_level_invoice_guard'
                       and g.tgfoid = 'tmpos_invoice_edit.m7b_invoice_level_guard()'::regprocedure
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
    raise exception 'migration 032 refused: tmpos_role.tenant_role_level does not carry exactly 021''s version trigger and 030''s guard trigger, each in its exact shape and enabled ALWAYS'
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
    raise exception 'migration 032 refused: 016''s hold or admission read, 018''s mint ledger or issuer key, or 002''s tenant or membership table is missing'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- The routine and the trigger function are created in 030's schema; the routine calls 016's hold and admission read as its
  -- owner, the principal applying this file, and reads and writes the schemas below.
  if not (pg_catalog.has_schema_privilege(current_user, 'tmpos_invoice_edit', 'CREATE')
          and pg_catalog.has_function_privilege(current_user, 'tmpos_session.m5_hold_tenant_standing(text, text)', 'EXECUTE')
          and pg_catalog.has_function_privilege(current_user, 'tmpos_session.m5_admit_tenant_session_v2(text, text)', 'EXECUTE')
          and pg_catalog.has_schema_privilege(current_user, 'public', 'USAGE')
          and pg_catalog.has_schema_privilege(current_user, 'tmpos_session', 'USAGE')
          and pg_catalog.has_schema_privilege(current_user, 'tmpos_mint', 'USAGE')
          and pg_catalog.has_schema_privilege(current_user, 'tmpos_role', 'USAGE')
          and pg_catalog.has_schema_privilege(current_user, 'tmpos_customer', 'USAGE')
          and pg_catalog.has_schema_privilege(current_user, 'tmpos_invoice_draft', 'USAGE')) then
    raise exception 'migration 032 refused: the applying principal cannot create in schema tmpos_invoice_edit, execute 016''s hold and admission read, which the routine calls, or use the schemas it reads'
      using errcode = 'insufficient_privilege';
  end if;
  -- A SECURITY DEFINER routine reads and writes only what its owner may (017's argument): were the applying principal neither
  -- the owner nor a role inheriting the owner of every table the routine reads or writes — or row security FORCEd on one — the
  -- routine would find no session and refuse everything, or fail on a write. Owning (or inheriting the owner of) the level
  -- table is also what creating its trigger and enabling it ALWAYS need.
  if exists (
    select 1
      from pg_catalog.pg_class c
     where c.oid = any (array['tmpos_session.session'::regclass, 'tmpos_mint.tenant_session'::regclass,
                              'tmpos_mint.issuer_key'::regclass, 'tmpos_role.tenant_role_level'::regclass,
                              'tmpos_customer.customer'::regclass, 'public.store'::regclass, 'public.tenant'::regclass,
                              'public.user_membership'::regclass, 'tmpos_invoice_draft.invoice_draft'::regclass,
                              'tmpos_invoice_draft.invoice_draft_line'::regclass])
       and (not pg_catalog.pg_has_role(current_user, c.relowner, 'USAGE') or c.relforcerowsecurity)) then
    raise exception 'migration 032 refused: the applying principal neither owns nor inherits the owner of a table the save routine reads or writes, or one has forced row security'
      using errcode = 'insufficient_privilege';
  end if;
  -- The revoke below and the rollback's grant are exact only if the applying principal OWNS 031's routine and its COMPLETE ACL
  -- (coalesce(proacl, acldefault), every entry, the owner's included) is exactly two entries: the owner's EXECUTE and tmpos_app's
  -- EXECUTE, each granted by the owner and non-grantable — nothing else, PUBLIC included. Then the rollback's grant restores the
  -- ACL byte for byte, and the revoke is not a silent no-op.
  if not exists (select 1 from pg_catalog.pg_proc p
                  where p.oid = 'tmpos_invoice_edit.m7b_invoice_draft_create_v2(text, uuid, uuid, uuid, uuid, jsonb, bigint)'::regprocedure
                    and p.proowner = v_me)
     or (select pg_catalog.count(*)
           from pg_catalog.pg_proc p,
                pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g
          where p.oid = 'tmpos_invoice_edit.m7b_invoice_draft_create_v2(text, uuid, uuid, uuid, uuid, jsonb, bigint)'::regprocedure) <> 2
     or (select pg_catalog.count(*)
           from pg_catalog.pg_proc p,
                pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g
          where p.oid = 'tmpos_invoice_edit.m7b_invoice_draft_create_v2(text, uuid, uuid, uuid, uuid, jsonb, bigint)'::regprocedure
            and g.grantee = p.proowner and g.privilege_type = 'EXECUTE' and not g.is_grantable
            and g.grantor = p.proowner) <> 1
     or (select pg_catalog.count(*)
           from pg_catalog.pg_proc p,
                pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g
          where p.oid = 'tmpos_invoice_edit.m7b_invoice_draft_create_v2(text, uuid, uuid, uuid, uuid, jsonb, bigint)'::regprocedure
            and g.grantee = 'tmpos_app'::regrole and g.privilege_type = 'EXECUTE' and not g.is_grantable
            and g.grantor = p.proowner) <> 1 then
    raise exception 'migration 032 refused: the applying principal does not own 031''s save routine, or tmpos_app''s EXECUTE on it is not the one non-grantable entry 031 issued'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$$;

-- Under READ COMMITTED the checks above and the postcondition below see every row committed before the locks were granted
-- (017's reason).
do $$
begin
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'migration 032 refused: it must run under READ COMMITTED, so that its checks see every committed row'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$$;

-- =============================================================================
-- 4) The trigger function and the trigger (every writer of a Customers level takes the key)
-- =============================================================================
-- 030's trigger function with the domain 'customers' in place of 'invoices'. SECURITY INVOKER and granted to nobody: a trigger
-- function fires without an EXECUTE grant, and it reads no relation, so it needs no privilege of its own; it calls only
-- pg_catalog functions every login may execute, so it works for whoever writes the table. A firing this file does not declare
-- raises rather than guessing (015's rule). AFTER ROW, so it fires only for a row actually written; it returns NULL, which an
-- AFTER trigger ignores.
create function tmpos_invoice_edit.m7b_customers_level_guard()
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
    raise exception 'm7b_customers_level_guard: fired by an undeclared trigger'
      using errcode = 'triggered_action_exception';
  end if;
  if tg_op = 'INSERT' then
    -- A NULL level is the catalog default, what an absent row means: no effective change, no key.
    if new.domain = 'customers' and new.level is not null then
      perform pg_catalog.pg_advisory_xact_lock(530030, pg_catalog.hashtext(new.tenant_id::text || '/' || new.role_id));
    end if;
  elsif tg_op = 'DELETE' then
    if old.domain = 'customers' and old.level is not null then
      perform pg_catalog.pg_advisory_xact_lock(530030, pg_catalog.hashtext(old.tenant_id::text || '/' || old.role_id));
    end if;
  else
    -- An UPDATE: the old row's key and, when the row moved to another (tenant, role), the new row's too, the smaller first.
    -- This trigger fires before 030's (name order), so a row moving into or out of the Customers domain takes its complete
    -- key set here and 030's trigger re-enters keys this transaction already holds.
    if old.domain = 'customers' or new.domain = 'customers' then
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

comment on function tmpos_invoice_edit.m7b_customers_level_guard() is
  'Phase 4.0 M7b (migration 032): AFTER INSERT OR UPDATE OR DELETE row trigger on tmpos_role.tenant_role_level (enabled ALWAYS), named to fire before migration 030''s trg_tenant_role_level_invoice_guard. Takes migration 030''s transaction-scoped advisory key pg_advisory_xact_lock(530030, hashtext(tenant_id || ''/'' || role_id)) EXCLUSIVE for an insert of a non-NULL Customers level, for an update whose old or new row is a Customers row (the old key and, when the row moved, the new one, the smaller first; an update to or from a NULL level, or out of or into the Customers domain, takes it) and for a delete of a non-NULL Customers row, so a writer cannot commit a Customers change while an invoice-draft save holds that key (a waiting writer may time out and roll back instead); takes nothing for an insert or delete of a NULL level (the catalog default) or of another domain. Raises triggered_action_exception for any other firing. Reads no relation. Granted to nobody.';

create trigger trg_tenant_role_level_customers_guard
  after insert or update or delete on tmpos_role.tenant_role_level
  for each row execute function tmpos_invoice_edit.m7b_customers_level_guard();

-- ALWAYS, as 013's, 021's, 029's and 030's are: a write by a session running as a replica meets it too.
alter table tmpos_role.tenant_role_level enable always trigger trg_tenant_role_level_customers_guard;

-- =============================================================================
-- 5) The routine
-- =============================================================================
create function tmpos_invoice_edit.m7b_invoice_draft_create_v3(
  p_session_key text, p_store_id uuid, p_draft_id uuid, p_expected_tenant uuid, p_customer_id uuid,
  p_lines jsonb, p_subtotal_cents bigint)
returns table (
  o_outcome       text,
  o_tenant_id     uuid,
  o_store_id      uuid,
  o_actor_id      uuid,
  o_membership_id uuid
)
language plpgsql
-- VOLATILE IS LOAD-BEARING (019's, 020's, 024's, 028's and 030's reason): it locks and then re-reads, and each statement must
-- see what committed before its own locks. Do not make it STABLE.
volatile
security definer
set search_path = pg_catalog, pg_temp
set row_security = off
as $$
declare
  -- The tenant ordering (permissionCatalog.ts TENANT_ORDERING), 020's constant, pinned by the parity test.
  c_levels         constant text[] := array['none', 'view', 'create', 'edit', 'manage', 'approve', 'full'];
  -- The largest integer a JavaScript number holds exactly: every amount's bound.
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
  v_customers      text;
  v_customer_found boolean;
  v_check          record;
begin
  -- 0. Every argument, before anything is read, locked or written. A refusal names the field, never the value.
  if p_session_key is null or p_session_key !~ '^[\x21-\x7e]{1,128}$'
     or p_store_id is null
     or p_draft_id is null
     or p_expected_tenant is null
     or p_customer_id is null then
    raise exception 'migration 028 create: an argument is malformed'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_subtotal_cents is null or p_subtotal_cents < 0 or p_subtotal_cents > c_max then
    raise exception 'migration 028 create: the subtotal is not a whole number from 0 to 9007199254740991'
      using errcode = 'invalid_parameter_value';
  end if;
  -- The lines: one array of 1-50 objects, each exactly {description, quantity, unitPriceCents}, judged one by one in
  -- order. Amounts are the plain digits a JSON integer is written in, bounded before any cast; every product and the
  -- running sum are numeric, so nothing overflows or rounds.
  if p_lines is null or pg_catalog.jsonb_typeof(p_lines) is distinct from 'array' then
    raise exception 'migration 028 create: the lines are not an array'
      using errcode = 'invalid_parameter_value';
  end if;
  v_count := pg_catalog.jsonb_array_length(p_lines);
  if v_count < 1 or v_count > 50 then
    raise exception 'migration 028 create: there are not 1 to 50 lines'
      using errcode = 'invalid_parameter_value';
  end if;
  for v_line in select e.entry from pg_catalog.jsonb_array_elements(p_lines) as e(entry) loop
    if pg_catalog.jsonb_typeof(v_line.entry) is distinct from 'object'
       or (select pg_catalog.array_agg(k.key order by k.key collate "C") from pg_catalog.jsonb_object_keys(v_line.entry) as k(key))
          is distinct from array['description', 'quantity', 'unitPriceCents']::text[] then
      raise exception 'migration 028 create: a line is not exactly a description, a quantity and a unit price'
        using errcode = 'invalid_parameter_value';
    end if;
    if pg_catalog.jsonb_typeof(v_line.entry -> 'description') is distinct from 'string'
       or pg_catalog.jsonb_typeof(v_line.entry -> 'quantity') is distinct from 'number'
       or pg_catalog.jsonb_typeof(v_line.entry -> 'unitPriceCents') is distinct from 'number' then
      raise exception 'migration 028 create: a line field has the wrong type'
        using errcode = 'invalid_parameter_value';
    end if;
    -- The description: one the line table's CHECK admits (restated, so the insert below cannot refuse it).
    v_text := v_line.entry ->> 'description';
    if not (
         pg_catalog.char_length(v_text) between 1 and 256
         and v_text !~ '[\u0001-\u001f\u007f-\u009f\u2028\u2029]'
         and v_text !~ '[\u061c\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069]'
         and v_text !~ '^[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]|[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]$') then
      raise exception 'migration 028 create: a line description is not one the line table admits'
        using errcode = 'invalid_parameter_value';
    end if;
    v_quantity := v_line.entry ->> 'quantity';
    if v_quantity !~ '^[1-9][0-9]{0,15}$' or v_quantity::numeric > c_max then
      raise exception 'migration 028 create: a line quantity is not a whole number from 1 to 9007199254740991'
        using errcode = 'invalid_parameter_value';
    end if;
    v_price := v_line.entry ->> 'unitPriceCents';
    if v_price !~ '^(0|[1-9][0-9]{0,15})$' or v_price::numeric > c_max then
      raise exception 'migration 028 create: a line unit price is not a whole number of cents from 0 to 9007199254740991'
        using errcode = 'invalid_parameter_value';
    end if;
    v_total := v_quantity::numeric * v_price::numeric;
    if v_total > c_max then
      raise exception 'migration 028 create: a line total is above 9007199254740991'
        using errcode = 'invalid_parameter_value';
    end if;
    v_sum := v_sum + v_total;
    if v_sum > c_max then
      raise exception 'migration 028 create: the lines'' sum is above 9007199254740991'
        using errcode = 'invalid_parameter_value';
    end if;
  end loop;
  if v_sum <> p_subtotal_cents::numeric then
    raise exception 'migration 028 create: the subtotal is not the sum of the line totals'
      using errcode = 'invalid_parameter_value';
  end if;
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'migration 028 create: it must run under READ COMMITTED, so that its checks see what committed before its locks'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- 1-6. The caller, derived exactly as 024's edit derives it (024 up, steps 1-6; see there and 019 for each step's
  --      reason): the unlocked live/issuer pre-check, 016's hold, the session and ledger rows FOR SHARE, the issuer key FOR
  --      SHARE, the clock after those waits, the standing digest the session was minted under, a write account status.
  select s.auth_provider, s.auth_provider_uid, s.expires_at, m.expires_at, m.issuer_digest
    into v_provider, v_uid, v_expires, v_minted_expires, v_minted_issuer
    from tmpos_session.session s
    join tmpos_mint.tenant_session m on m.session_key = s.session_key
   where s.session_key = p_session_key
     and s.audience = 'tenant';
  if not found then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;
  v_now := pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp()) * 1000)::bigint;
  if v_expires is distinct from v_minted_expires or v_now >= v_expires then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;
  select pg_catalog.sha256(k.key) into v_issuer from tmpos_mint.issuer_key k where k.singleton;
  if v_issuer is null or v_issuer is distinct from v_minted_issuer then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;

  if tmpos_session.m5_hold_tenant_standing(v_provider, v_uid) is distinct from 'held' then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid;
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
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;

  select pg_catalog.sha256(k.key) into v_issuer from tmpos_mint.issuer_key k where k.singleton for share;
  if v_issuer is null or v_issuer is distinct from v_session.issuer_digest then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;

  v_now := pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp()) * 1000)::bigint;
  if v_now >= v_session.expires_at then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid;
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
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;

  -- 7. EXACTLY ONE store-scope grant naming p_store_id — a selector among the actor's own grants, never proof — on a tenant
  --    and a store whose statuses are write statuses. A tenant grant and a grant at another store never count.
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
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;
  v_role := v_grants -> 0 ->> 'roleId';
  v_tenant := (v_grants -> 0 ->> 'tenantId')::uuid;
  v_membership := (v_grants -> 0 ->> 'membershipId')::uuid;
  -- 7a. Still that actor's active membership row at exactly that tenant, store and role (027's re-check; 016's hold holds it).
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
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;
  -- 7b. The store row, re-read FOR SHARE (016's hold already holds it): in that grant's tenant, with a write status.
  select st.tenant_id, st.status into v_store
    from public.store st
   where st.store_id = p_store_id
     for share;
  if not found
     or v_store.tenant_id is distinct from v_tenant
     or v_store.status is null
     or v_store.status not in ('active', 'trialing') then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;

  -- 8. The role's levels, UNLOCKED: Invoices at Create or above AND Customers at View or above. store_owner is Full (never
  --    stored); an editable role is its stored level, else its catalog default (the same for both domains); any other role
  --    refuses. Nothing is written or locked by a refusal here.
  if v_role = 'store_owner' then
    null;
  elsif v_role in ('manager', 'technician', 'sales_staff') then
    select l.level into v_invoices
      from tmpos_role.tenant_role_level l
     where l.tenant_id = v_tenant and l.role_id = v_role and l.domain = 'invoices';
    select l.level into v_customers
      from tmpos_role.tenant_role_level l
     where l.tenant_id = v_tenant and l.role_id = v_role and l.domain = 'customers';
    if coalesce(pg_catalog.array_position(c_levels,
         coalesce(v_invoices, case v_role when 'manager' then 'full' when 'technician' then 'view' when 'sales_staff' then 'create' end)), 0)
       < pg_catalog.array_position(c_levels, 'create')
       or coalesce(pg_catalog.array_position(c_levels,
         coalesce(v_customers, case v_role when 'manager' then 'full' when 'technician' then 'view' when 'sales_staff' then 'create' end)), 0)
       < pg_catalog.array_position(c_levels, 'view') then
      return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid;
      return;
    end if;
  else
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;

  -- 9. The request's expectedTenant (caller-supplied, never authority) against the tenant derived from the grant — a
  --    precondition only (021's and 022's rule): nothing written, no role row made to exist.
  if v_tenant is distinct from p_expected_tenant then
    return query select 'tenant_mismatch'::text, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;

  -- 10. The customer, UNLOCKED, filtered to the derived tenant: a missing id and another tenant's id are one finding, READ
  --     here and ANSWERED at step 10c, after the role's level is held (step 10b) and before any write (DA-36: the runtime
  --     seals it and commits only its completion).
  v_customer_found := exists (
    select 1
      from tmpos_customer.customer c
     where c.customer_id = p_customer_id
       and c.tenant_id = v_tenant);

  -- 10b. THE GUARD (migration 030's key, reused): the role's key taken SHARED and held until COMMIT, then the Invoices level
  --      AND the Customers level decided again. The writers it orders against are those of either level of the role, which
  --      take the same key EXCLUSIVE (032's trg_tenant_role_level_customers_guard, 030's trg_tenant_role_level_invoice_guard).
  --      Both sealed answers — 'customer_not_found' (step 10c) and 'applied' — are decided after this point and committed
  --      while the key is held. SEPARATE top-level statements of the routine's outermost block, never inside a BEGIN ...
  --      EXCEPTION block (a subtransaction that aborts releases a transaction-scoped advisory lock): the key, with 030's exact
  --      expression; the clock again, because the wait may have been long (an expired session is refused); and each level read
  --      again by a PLAIN SELECT, a fresh READ COMMITTED snapshot taken after the wait, so a level a writer committed before
  --      releasing the key is seen, decided exactly as step 8 decides them. Step 8 stays an early pre-check; this is the
  --      decision of record for both levels. No FOR SHARE or FOR UPDATE on a role row or a version row after the key (030's
  --      lock-order rule, widened by 032 to the Customers domain), nothing inserted: a role without a stored level is decided
  --      on its catalog default and no row is made for it. store_owner is Full and never stored: no key, no read.
  if v_role in ('manager', 'technician', 'sales_staff') then
    perform pg_catalog.pg_advisory_xact_lock_shared(530030, pg_catalog.hashtext(v_tenant::text || '/' || v_role));
    v_now := pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp()) * 1000)::bigint;
    if v_now >= v_session.expires_at then
      return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid;
      return;
    end if;
    select l.level into v_invoices
      from tmpos_role.tenant_role_level l
     where l.tenant_id = v_tenant and l.role_id = v_role and l.domain = 'invoices';
    select l.level into v_customers
      from tmpos_role.tenant_role_level l
     where l.tenant_id = v_tenant and l.role_id = v_role and l.domain = 'customers';
    if coalesce(pg_catalog.array_position(c_levels,
         coalesce(v_invoices, case v_role when 'manager' then 'full' when 'technician' then 'view' when 'sales_staff' then 'create' end)), 0)
       < pg_catalog.array_position(c_levels, 'create')
       or coalesce(pg_catalog.array_position(c_levels,
         coalesce(v_customers, case v_role when 'manager' then 'full' when 'technician' then 'view' when 'sales_staff' then 'create' end)), 0)
       < pg_catalog.array_position(c_levels, 'view') then
      return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid;
      return;
    end if;
  end if;

  -- 10c. Step 10's finding, answered now that both levels are held: nothing written, no role row made.
  if not v_customer_found then
    return query select 'customer_not_found'::text, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;

  -- 13. Live, on the database clock read again now (031's check, kept as it was).
  v_now := pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp()) * 1000)::bigint;
  if v_now >= v_session.expires_at then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;
  -- The customer, held FOR KEY SHARE in the derived tenant until COMMIT (the foreign key's own lock, taken first). Step 10
  -- found it; a customer gone since is a fault, never an answer.
  perform 1
     from tmpos_customer.customer c
    where c.customer_id = p_customer_id
      and c.tenant_id = v_tenant
      for key share;
  if not found then
    raise exception 'migration 028 create: the customer is no longer in the tenant'
      using errcode = 'no_data_found';
  end if;
  v_now := pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp()) * 1000)::bigint;
  if v_now >= v_session.expires_at then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;

  -- 14. The header and the lines. The CHECKs restate step 0, so they cannot refuse; were any constraint ever to (a reused
  --     id included), the raise is fixed text, never the row.
  begin
    insert into tmpos_invoice_draft.invoice_draft
      (draft_id, tenant_id, store_id, customer_id, status, currency, version, line_count, subtotal_cents, created_by)
    values
      (p_draft_id, v_tenant, p_store_id, p_customer_id, 'draft', 'USD', 1, v_count, p_subtotal_cents, v_admission.actor_id);
  exception
    when unique_violation or check_violation or foreign_key_violation or not_null_violation then
      raise exception 'migration 028 create: the draft is not one the draft table admits'
        using errcode = 'integrity_constraint_violation';
  end;
  begin
    insert into tmpos_invoice_draft.invoice_draft_line
      (draft_id, tenant_id, store_id, position, description, quantity, unit_price_cents, line_total_cents)
    select p_draft_id, v_tenant, p_store_id, e.ordinality::integer, e.entry ->> 'description',
           (e.entry ->> 'quantity')::bigint, (e.entry ->> 'unitPriceCents')::bigint,
           ((e.entry ->> 'quantity')::numeric * (e.entry ->> 'unitPriceCents')::numeric)::bigint
      from pg_catalog.jsonb_array_elements(p_lines) with ordinality as e(entry, ordinality);
  exception
    when unique_violation or check_violation or foreign_key_violation or not_null_violation or numeric_value_out_of_range then
      raise exception 'migration 028 create: a line is not one the line table admits'
        using errcode = 'integrity_constraint_violation';
  end;

  -- 15. Exactly the lines step 0 judged: n rows at positions 1..n whose totals sum to the header's subtotal.
  select pg_catalog.count(*)::integer as n, pg_catalog.min(l.position) as lo, pg_catalog.max(l.position) as hi,
         coalesce(pg_catalog.sum(l.line_total_cents::numeric), -1) as total
    into v_check
    from tmpos_invoice_draft.invoice_draft_line l
   where l.draft_id = p_draft_id and l.tenant_id = v_tenant and l.store_id = p_store_id;
  if v_check.n is distinct from v_count or v_check.lo is distinct from 1 or v_check.hi is distinct from v_count
     or v_check.total is distinct from p_subtotal_cents::numeric then
    raise exception 'migration 028 create: the lines written are not exactly the lines judged'
      using errcode = 'no_data_found';
  end if;

  return query select 'applied'::text, v_tenant, p_store_id, v_admission.actor_id, v_membership;
end
$$;

comment on function tmpos_invoice_edit.m7b_invoice_draft_create_v3(text, uuid, uuid, uuid, uuid, jsonb, bigint) is
  'Phase 4.0 M7b (migration 032): migration 031''s m7b_invoice_draft_create_v2 with the role''s Customers level held through completion as well as its Invoices level: saves one invoice draft (status draft, USD, version 1) and its 1-50 ordered lines at a store, for a key naming a ledger-minted, live (database clock, read after every lock wait) tenant session minted under the installed issuer key, after 016''s hold and the session, ledger and issuer key rows, whose standing digest is unchanged, whose account status is active or trialing, who holds EXACTLY ONE active store-scope grant at p_store_id (a selector only) on an active or trialing tenant and store — the store row re-read FOR SHARE in that grant''s tenant — and whose role''s Invoices level is Create or above and Customers level View or above (store_owner full; manager, technician, sales_staff the owner''s stored level, else the catalog default). Both levels are read unlocked as an early pre-check; then, for manager, technician and sales_staff, after the customer is read and before either sealed answer, the role''s transaction-scoped advisory key pg_advisory_xact_lock_shared(530030, hashtext(tenant || ''/'' || role)) is taken and BOTH levels decided again (plain reads; nothing inserted or row-locked; the session''s clock read again after the wait), and the key is held until the command transaction ends, so a writer of either level — which takes the same key EXCLUSIVE through trg_tenant_role_level_customers_guard (Customers) or trg_tenant_role_level_invoice_guard (Invoices) — cannot commit a change while the save holds the key (a waiting writer may time out and roll back instead), and a narrowing that committed first refuses the save. Writes no role row and no version row on any path. Judges every argument first (invalid_parameter_value, a fixed message naming the field, never the value; the lines one jsonb array of exact objects, amounts in numeric, their sum equal to p_subtotal_cents). Answers one row: (''refused'', NULLs) for any authority refusal, the second decision of either level and a session that expired while the key waited included; (''tenant_mismatch'', NULLs) when the grant''s tenant is not p_expected_tenant; (''customer_not_found'', NULLs) alike for a missing and another tenant''s customer, decided with the key held — the last two and every refusal before any write; else inserts the header and the lines and answers (''applied'', tenant, store, actor, membership). Writes no audit record.';

-- =============================================================================
-- 6) Privileges, and the proof that nothing wider was issued
-- =============================================================================
-- PostgreSQL grants EXECUTE on a new function to PUBLIC by default, so every default is removed explicitly before the one
-- intended grant is issued. The trigger function is granted to nobody. tmpos_app loses its EXECUTE on 031's routine, which
-- stays in its schema, unaltered, for the rollback. tmpos_app already holds USAGE on tmpos_invoice_edit (030). No table grant.
revoke all on function tmpos_invoice_edit.m7b_invoice_draft_create_v3(text, uuid, uuid, uuid, uuid, jsonb, bigint) from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
revoke all on function tmpos_invoice_edit.m7b_customers_level_guard() from public, anon, authenticated, tmpos_app, tmpos_audit_writer;

revoke execute on function tmpos_invoice_edit.m7b_invoice_draft_create_v2(text, uuid, uuid, uuid, uuid, jsonb, bigint) from tmpos_app;

grant execute on function tmpos_invoice_edit.m7b_invoice_draft_create_v3(text, uuid, uuid, uuid, uuid, jsonb, bigint) to tmpos_app;

-- =============================================================================
-- 7) Postcondition
-- =============================================================================
-- Proven rather than asserted, in 030's and 031's form. This file refuses to finish unless, now:
--   (a) schema tmpos_invoice_edit holds exactly 030's two functions, 031's routine and this file's two functions, and no
--       relation or type;
--   (b) the trigger function is plpgsql, SECURITY INVOKER, VOLATILE, returns trigger, pinned to pg_catalog, pg_temp and owned
--       by the applying principal; the routine is plpgsql, SECURITY DEFINER, VOLATILE, pinned to pg_catalog, pg_temp with
--       row_security off, takes 031's arguments and returns 031's TABLE and is owned by the applying principal; both carry a
--       comment;
--   (c) the complete ACL of the routine is exactly two entries, the owner's EXECUTE and a non-grantable EXECUTE to tmpos_app,
--       each granted by the owner; that of the trigger function, of 031's routine and of 028's routine each exactly the owner's
--       one — tmpos_app included, PUBLIC included;
--   (d) tmpos_app CAN execute the routine and 030's edit routine and use the schema (whose ACL and the edit routine's and 030's
--       trigger function's stay exactly 030's), and CANNOT execute 031's or 028's routine or either trigger function;
--       tmpos_audit_writer, anon and authenticated can execute none of the three save routines or the trigger function, by any
--       path;
--   (e) none of the four runtime roles is a MEMBER of the owner of the routine or of the trigger function;
--   (f) tmpos_role.tenant_role_level carries EXACTLY three non-internal triggers, in this name order: this file's — AFTER ROW
--       INSERT, UPDATE and DELETE, enabled ALWAYS, no column list, no WHEN — calling the trigger function, which nothing else
--       calls; 030's guard trigger; and 021's version trigger, each in its exact shape and enabled ALWAYS.
-- Each ACL is read through coalesce(acl, acldefault(kind, owner)), and a role reachable through a membership is followed
-- whatever the membership's options (019's reasons). WHAT THIS DOES NOT PROVE: it is a snapshot at apply time; the runtime
-- LOGIN's grants are enforced at every start by the startup preflight (server/persistence/postgresStartupPreflight.ts).
do $$
declare
  v_bad    text;
  v_me     oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user);
  v_create oid := 'tmpos_invoice_edit.m7b_invoice_draft_create_v3(text, uuid, uuid, uuid, uuid, jsonb, bigint)'::regprocedure;
  v_guard  oid := 'tmpos_invoice_edit.m7b_customers_level_guard()'::regprocedure;
  v_031    oid := 'tmpos_invoice_edit.m7b_invoice_draft_create_v2(text, uuid, uuid, uuid, uuid, jsonb, bigint)'::regprocedure;
  v_028    oid := 'tmpos_invoice_draft.m7b_invoice_draft_create(text, uuid, uuid, uuid, uuid, jsonb, bigint)'::regprocedure;
  v_v2     oid := 'tmpos_invoice_edit.m7b_invoice_draft_update_v2(text, uuid, uuid, uuid, bigint, uuid, jsonb, bigint)'::regprocedure;
  v_030g   oid := 'tmpos_invoice_edit.m7b_invoice_level_guard()'::regprocedure;
begin
  -- (a)
  if (select pg_catalog.string_agg(p.oid::regprocedure::text, ', ' order by p.oid::regprocedure::text)
        from pg_catalog.pg_proc p where p.pronamespace = 'tmpos_invoice_edit'::regnamespace)
     is distinct from
     'tmpos_invoice_edit.m7b_customers_level_guard(), tmpos_invoice_edit.m7b_invoice_draft_create_v2(text,uuid,uuid,uuid,uuid,jsonb,bigint), tmpos_invoice_edit.m7b_invoice_draft_create_v3(text,uuid,uuid,uuid,uuid,jsonb,bigint), tmpos_invoice_edit.m7b_invoice_draft_update_v2(text,uuid,uuid,uuid,bigint,uuid,jsonb,bigint), tmpos_invoice_edit.m7b_invoice_level_guard()'
     or exists (select 1 from pg_catalog.pg_class c where c.relnamespace = 'tmpos_invoice_edit'::regnamespace)
     or exists (select 1 from pg_catalog.pg_type t where t.typnamespace = 'tmpos_invoice_edit'::regnamespace) then
    raise exception 'migration 032 refused: schema tmpos_invoice_edit does not hold exactly migration 030''s two functions, 031''s routine and this file''s two functions'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (b)
  if not exists (select 1 from pg_catalog.pg_proc p join pg_catalog.pg_language l on l.oid = p.prolang
                  where p.oid = v_guard
                    and l.lanname = 'plpgsql' and not p.prosecdef and p.provolatile = 'v'
                    and p.prorettype = 'pg_catalog.trigger'::regtype
                    and p.proconfig = array['search_path=pg_catalog, pg_temp'] and p.proowner = v_me)
     or not exists (select 1 from pg_catalog.pg_proc p join pg_catalog.pg_language l on l.oid = p.prolang
                     where p.oid = v_create
                       and l.lanname = 'plpgsql' and p.prosecdef and p.provolatile = 'v'
                       and p.proconfig = array['search_path=pg_catalog, pg_temp', 'row_security=off'] and p.proowner = v_me)
     or pg_catalog.pg_get_function_arguments(v_create) is distinct from pg_catalog.pg_get_function_arguments(v_031)
     or pg_catalog.pg_get_function_result(v_create) is distinct from pg_catalog.pg_get_function_result(v_031)
     or pg_catalog.obj_description(v_create, 'pg_proc') is null
     or pg_catalog.obj_description(v_guard, 'pg_proc') is null then
    raise exception 'migration 032 refused: the trigger function is not the plpgsql SECURITY INVOKER VOLATILE function section 4 declares, or the save routine is not the plpgsql SECURITY DEFINER VOLATILE routine pinned to pg_catalog, pg_temp with row_security off section 5 declares, with 031''s arguments and RETURNS TABLE, or one carries no comment or is not owned by the applying principal'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (c)
  select pg_catalog.string_agg(pg_catalog.format('%s %s:%s', p.proname, g.grantee::regrole::text, g.privilege_type), ', ')
    into v_bad
    from pg_catalog.pg_proc p,
         pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g
   where p.oid in (v_create, v_guard, v_031, v_028)
     and not (g.privilege_type = 'EXECUTE' and not g.is_grantable and g.grantor = p.proowner
              and (g.grantee = p.proowner or (p.oid = v_create and g.grantee = 'tmpos_app'::regrole)));
  -- The complete ACL, the owner's entry included: the routine exactly two entries (the owner's and tmpos_app's), the others one.
  if v_bad is not null
     or exists (select 1 from pg_catalog.pg_proc p
                 where p.oid in (v_create, v_guard, v_031, v_028)
                   and (select pg_catalog.count(*)
                          from pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g)
                       <> case when p.oid = v_create then 2 else 1 end) then
    raise exception 'migration 032 refused: an unexpected direct grant remains on the save routine, the trigger function, 031''s routine or 028''s, or an entry is missing (%)', coalesce(v_bad, 'none listed')
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if (select pg_catalog.count(*)
        from pg_catalog.pg_proc p,
             pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g
       where p.oid = v_create and g.grantee = 'tmpos_app'::regrole and g.privilege_type = 'EXECUTE' and not g.is_grantable) <> 1 then
    raise exception 'migration 032 refused: tmpos_app does not hold a direct EXECUTE on the save routine'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (d)
  if not pg_catalog.has_function_privilege('tmpos_app', v_create, 'EXECUTE')
     or not pg_catalog.has_function_privilege('tmpos_app', v_v2, 'EXECUTE')
     or not pg_catalog.has_schema_privilege('tmpos_app', 'tmpos_invoice_edit'::regnamespace, 'USAGE')
     or pg_catalog.has_function_privilege('tmpos_app', v_031, 'EXECUTE')
     or pg_catalog.has_function_privilege('tmpos_app', v_028, 'EXECUTE')
     or pg_catalog.has_function_privilege('tmpos_app', v_guard, 'EXECUTE')
     or pg_catalog.has_function_privilege('tmpos_app', v_030g, 'EXECUTE')
     -- 030's grants, exactly: the edit routine's complete ACL is the owner's EXECUTE and tmpos_app's, the trigger function's
     -- the owner's alone, the schema's the owner's USAGE and CREATE and tmpos_app's USAGE — each granted by the owner and
     -- non-grantable, every entry read through coalesce(acl, acldefault), the owner's included (PUBLIC would be one more).
     or exists (select 1
                  from pg_catalog.pg_proc p,
                       pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g
                 where p.oid in (v_v2, v_030g)
                   and not (g.privilege_type = 'EXECUTE' and not g.is_grantable and g.grantor = p.proowner
                            and (g.grantee = p.proowner or (p.oid = v_v2 and g.grantee = 'tmpos_app'::regrole))))
     or (select pg_catalog.count(*)
           from pg_catalog.pg_proc p,
                pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g
          where p.oid = v_v2) <> 2
     or (select pg_catalog.count(*)
           from pg_catalog.pg_proc p,
                pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g
          where p.oid = v_030g) <> 1
     or exists (select 1
                  from pg_catalog.pg_namespace n,
                       pg_catalog.aclexplode(coalesce(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) g
                 where n.oid = 'tmpos_invoice_edit'::regnamespace
                   and not (not g.is_grantable and g.grantor = n.nspowner
                            and ((g.grantee = n.nspowner and g.privilege_type in ('USAGE', 'CREATE'))
                                 or (g.grantee = 'tmpos_app'::regrole and g.privilege_type = 'USAGE'))))
     or (select pg_catalog.count(*)
           from pg_catalog.pg_namespace n,
                pg_catalog.aclexplode(coalesce(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) g
          where n.oid = 'tmpos_invoice_edit'::regnamespace) <> 3 then
    raise exception 'migration 032 refused: tmpos_app must execute the save routine and 030''s edit routine, use schema tmpos_invoice_edit, and execute neither 031''s nor 028''s routine nor a trigger function, and 030''s grants must stay exactly 030''s'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  select pg_catalog.string_agg(distinct r.rolname::text || ' ' || p.proname::text, ', ') into v_bad
    from pg_catalog.pg_roles r
    join pg_catalog.pg_roles x on pg_catalog.pg_has_role(r.oid, x.oid, 'MEMBER')
    cross join pg_catalog.pg_proc p
   where p.oid in (v_create, v_guard, v_031, v_028)
     and (r.rolname = any (array['tmpos_audit_writer', 'anon', 'authenticated']::name[])
          or (r.rolname = 'tmpos_app' and p.oid in (v_guard, v_031, v_028)))
     and pg_catalog.has_function_privilege(x.oid, p.oid, 'EXECUTE');
  if v_bad is not null then
    raise exception 'migration 032 refused: a runtime role can execute a function this file does not grant it (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (e)
  select pg_catalog.string_agg(distinct r.rolname::text, ', ') into v_bad
    from pg_catalog.pg_roles r
    join pg_catalog.pg_proc p on p.oid in (v_create, v_guard)
   where r.rolname = any (array['tmpos_app', 'tmpos_audit_writer', 'anon', 'authenticated']::name[])
     and pg_catalog.pg_has_role(r.oid, p.proowner, 'MEMBER');
  if v_bad is not null then
    raise exception 'migration 032 refused: % is a member of the owner of the save routine or the trigger function', v_bad
      using errcode = 'object_not_in_prerequisite_state',
            hint = 'membership hands a role everything the owner holds, including a direct write of every level and draft';
  end if;

  -- (f) tgtype: ROW 1 + INSERT 4 + DELETE 8 + UPDATE 16 = 29 (this file's and 030's; AFTER sets no bit); ROW 1 + UPDATE 16 = 17
  -- (021's). Same-event row triggers fire in name order (byte order): this file's first, then 030's, then 021's.
  if (select pg_catalog.string_agg(g.tgname::text, ', ' order by g.tgname::text collate "C")
        from pg_catalog.pg_trigger g
       where g.tgrelid = 'tmpos_role.tenant_role_level'::regclass and not g.tgisinternal)
     is distinct from
     'trg_tenant_role_level_customers_guard, trg_tenant_role_level_invoice_guard, trg_tenant_role_level_version_advance'
     or (select pg_catalog.count(*) from pg_catalog.pg_trigger g where g.tgfoid = v_guard) <> 1
     or not exists (select 1 from pg_catalog.pg_trigger g
                     where g.tgrelid = 'tmpos_role.tenant_role_level'::regclass
                       and g.tgname = 'trg_tenant_role_level_customers_guard'
                       and g.tgfoid = v_guard
                       and g.tgtype = 29
                       and g.tgenabled = 'A'
                       and g.tgattr = ''::pg_catalog.int2vector
                       and g.tgqual is null
                       and not g.tgisinternal)
     or not exists (select 1 from pg_catalog.pg_trigger g
                     where g.tgrelid = 'tmpos_role.tenant_role_level'::regclass
                       and g.tgname = 'trg_tenant_role_level_invoice_guard'
                       and g.tgfoid = v_030g
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
    raise exception 'migration 032 refused: tmpos_role.tenant_role_level does not carry exactly this file''s Customers guard trigger, 030''s guard trigger and 021''s version trigger, in that name order, each in its exact shape and enabled ALWAYS'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$$;

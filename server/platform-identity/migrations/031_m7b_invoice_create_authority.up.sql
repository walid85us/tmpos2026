-- Phase 4.0 M7b — holding the Invoices Create authority through both sealed outcomes of the invoice-draft save: 028's save
-- routine re-issued in 030's schema with 030's advisory key taken SHARED before either sealed answer is decided, and 028's
-- routine closed to the runtime role (M7B-INVOICES-P1-R3; DA-210; G-IAM, G-ISOLATION, G-DBROLE; docs/phase-4/05, 08, 10)
-- Migration: 031_m7b_invoice_create_authority (UP)
--
-- SCOPE / TRUTH (binding):
--   - ONE FUNCTION, THREE PRIVILEGE CHANGES. The save routine tmpos_invoice_edit.m7b_invoice_draft_create_v2, in 030's schema
--     beside 030's edit routine and trigger function. The privilege changes: every default EXECUTE on the new routine
--     (PUBLIC's) removed; tmpos_app gains EXECUTE on it (it already holds USAGE on the schema, from 030); tmpos_app loses its
--     EXECUTE on 028's tmpos_invoice_draft.m7b_invoice_draft_create.
--     NO TABLE, COLUMN, INDEX, ROW, ROLE, MEMBERSHIP, POLICY, TYPE, TRIGGER OR SCHEMA; no comment on an earlier object; no
--     privilege on any table. 001-030 stay byte for byte as committed (the migration-files contract's pinned checksums prove
--     that); 028's routine stays where it is, unaltered; 030's schema, trigger, trigger function and edit routine are not
--     altered.
--   - WHY IT EXISTS (DA-210). 028's m7b_invoice_draft_create decides the role's Invoices level at Create (and its Customers
--     level at View) ONCE, UNLOCKED (its step 8, 028 up:661-685), and answers its sealed 'customer_not_found' on an unlocked
--     customer read (its step 10, 028 up:694-703), BEFORE its only locked re-decision (steps 11-12, 028 up:705-740, reached on
--     the applied path alone). An owner's narrowing of the Invoices level below Create that commits after step 8 therefore
--     still let the save seal its 422 and commit its idempotency completion. The stage's contract is 030's: current authority
--     stays valid and protected through every newly sealed outcome. Step 10's answer cannot simply follow 028's locked
--     re-decision: that re-decision INSERTs the role's rows when there are none (lock anchors), and a refusal or a
--     'customer_not_found' may create no configuration row; and a read that finds no row protects nothing about that absence
--     at READ COMMITTED (030's reasoning).
--   - THE GUARD, REUSED, NOT CHANGED: 030's transaction-scoped advisory key per (tenant, role),
--     pg_catalog.pg_advisory_xact_lock_shared(530030, pg_catalog.hashtext(<tenant>::text || '/' || <role>)) — the identical
--     key and the identical expression as 030's trigger, which takes it EXCLUSIVE for every write that can change an Invoices
--     level, and as 030's edit, which takes it SHARED. 030's header gives why it is a key and not a row, why every writer meets
--     it (an ENABLE ALWAYS AFTER ROW trigger) and its availability residuals; this file adds one more SHARED holder.
--   - THE SAVE, tmpos_invoice_edit.m7b_invoice_draft_create_v2: 028's routine with its signature, its RETURNS TABLE, its
--     answers and attributes (plpgsql, SECURITY DEFINER, VOLATILE, search_path pg_catalog then pg_temp, row_security off) and
--     every statement and every raised message of its body character for character, EXCEPT EXACTLY THREE CHANGES:
--       (~) STEP 10 READS, IT DOES NOT ANSWER: the same unlocked existence read of the customer in the derived tenant is kept
--           in a boolean, and the 'customer_not_found' answer moves after step 10b (step 10c), unchanged in shape.
--       (+) STEP 10b, THE GUARD, for manager, technician and sales_staff: the role's key SHARED; the session's clock again (the
--           wait may have been long: expired is ('refused', NULLs)); the Invoices level read again by a plain SELECT and
--           decided exactly as step 8 decides it (the stored level, else the catalog default; below Create is ('refused',
--           NULLs)). Nothing is inserted or row locked. store_owner is Full by the catalog, never stored: no key, no read.
--           Both sealed answers — 'customer_not_found' (10c) and 'applied' — are decided after 10b and committed while the key
--           is held: it is released only by the command transaction's COMMIT or ROLLBACK, i.e. after the runtime's audit
--           record, outbox event and idempotency completion. Step 8 (unlocked) stays as an early pre-check; 10b is the
--           Invoices decision of record. The three statements are SEPARATE and sit in the routine's OUTERMOST block, never
--           inside a BEGIN ... EXCEPTION block (a subtransaction that aborts releases a transaction-scoped advisory lock), and
--           the re-read is a fresh READ COMMITTED snapshot because the routine is VOLATILE and refuses any other isolation
--           (step 0) — 030's step 5b, restated for the save.
--       (-) STEPS 11-12 LOSE THE INVOICES ANCHOR: the Invoices role row's INSERT-if-missing, its FOR SHARE and its not-found
--           refusal are removed. REQUIRED, not cosmetic: a level writer's order is role row FOR UPDATE, version row FOR UPDATE,
--           THEN the key EXCLUSIVE (030's trigger, at its level write); a save holding the key SHARED that then waited for the
--           Invoices role row (or for its anchor's INSERT behind a writer's uncommitted one) would close a cycle. The Customers
--           anchor, its FOR SHARE and the locked re-decision stay exactly: the re-decision now judges 10b's Invoices value
--           (which cannot change while the key is held) and the locked Customers value. Step 13's clock read stays (step 11
--           may still wait, on the Customers row).
--     A new routine, not a replacement of 028's — as 030 superseded 029's edit: the new name carries the new contract,
--     tmpos_app's EXECUTE on the old one is revoked, and 028's routine stays byte for byte in place, so the rollback restores
--     028's exact contract by granting that EXECUTE again. In 030's schema tmpos_invoice_edit, for two reasons: 028's and 029's
--     postconditions and rollbacks pin the exact routine inventory of tmpos_invoice_draft; and 030's rollback ends with a
--     plain DROP SCHEMA tmpos_invoice_edit, which refuses (dependent_objects_still_exist, 2BP01 — and the whole 030 rollback
--     with it) while this routine is in the schema, so 030's guard cannot be removed from under the routine that relies on it.
--     A plpgsql body records no catalog dependency: a routine in any other schema would not stop 030's rollback.
--   - THE ORDERING (the stage's contract). A narrowing that commits before 10b's key is granted is read by 10b's fresh SELECT:
--     the save answers ('refused', NULLs) and the runtime rolls the command transaction back — no completion, draft, line,
--     audit record, event or role row — which is the existing transaction-time refusal (the generic 503, the lease kept). A
--     writer cannot COMMIT an Invoices change while a save holds the key (a waiting writer may instead time out and roll back).
--     A request that completed before a narrowing stays completed; a replay is judged by the chain's unlocked
--     current-authority check as before — this file adds no lock to a replay.
--   - ROLE ROWS. 'customer_not_found', 'tenant_mismatch' and every refusal before step 11 write no role row; the applied path
--     writes the Customers NULL anchor only and no Invoices row any more (a deliberate change: the key protects the Invoices
--     level, and a NULL anchor would take no key). store_owner: no key, no row.
--   - LOCK ORDER (the save; the fence, 016's hold, session, ledger and issuer order of every tenant write is unchanged):
--       fence -> the revalidator (016's hold) -> 016's hold again -> session and ledger rows FOR SHARE -> issuer key row FOR
--       SHARE -> store row FOR SHARE -> [8] the level table, a plain read -> [10] the customer table, a plain read -> [10b] THE
--       KEY, SHARED -> [11] the Customers role row (NULL anchor, FOR SHARE) -> [13] the customer FOR KEY SHARE -> the new header
--       and lines -> (the runtime) audit record, outbox event, completion -> COMMIT.
--     WHY IT CANNOT CYCLE: after its key a save waits only for its role's Customers row (held by 021's Customers setter, 024's
--     customer edit or another save — none of which takes the key), for the customer row (024's FOR UPDATE — no key) and for
--     its own new rows. A writer taking the key EXCLUSIVE holds before it, beyond what every tenant write locks first, only its
--     own pair's Invoices role row and version row (026's setter), which a save never waits for: it never locks an Invoices
--     role row or a version row. 030's THE RULE holds with the save among the SHARED holders: a transaction holding the key
--     SHARED never locks an Invoices role row or version row after taking it. SHARED keys are compatible: a save and an edit
--     of one role do not conflict on the key (a later SHARED request queues only behind a waiting EXCLUSIVE one: CONVOY below).
--   - WHAT THIS DOES NOT DEFEND (doc 08; none of it is claimed closed). 028's and 030's residuals stand for the save, and:
--       * THE CUSTOMERS COREQUISITE of a sealed 'customer_not_found' is still decided unlocked (step 8): a Customers narrowing
--         below View committed after step 8 can still be followed by the sealed 422. Customers writers take no key, and an
--         absent Customers row cannot be locked without an anchor, which a refusal may not create. 028 had the same; this
--         file's DA-210 closure covers the Invoices level only;
--       * MULTI-PAIR WRITERS (030's class), now naming the save: a table-owner transaction that locks a Customers role row or a
--         customer and then writes an Invoices level can deadlock with a save (40P01: availability, no wrong authority answer);
--       * CONVOY: a writer waiting for the key behind a save holds its role's Invoices row FOR UPDATE, and a later save of that
--         role now queues on the key behind the waiting writer (no longer on the Invoices row) — bounded by the command
--         transaction's lock timeout, ending in the existing 503;
--       * the owner can still run 028's routine directly (only tmpos_app's EXECUTE is revoked): it takes no key;
--       * the table owner can DISABLE 030's trigger (030's residual): DA-210 is closed for the runtime save WHILE THAT TRIGGER
--         IS ENABLED.
--   - APPLY: A MAINTENANCE WINDOW, 030's. Before any check and before any change — its first statements after the search path,
--     with nothing read before them, not even the catalog — the file takes ACCESS EXCLUSIVE until COMMIT on 030's seven tables
--     in the writers' order: public.store, tmpos_role.tenant_role_level, tmpos_role_edit.role_level_version,
--     tmpos_customer.customer, tmpos_invoice_draft.invoice_draft, tmpos_invoice_draft.invoice_draft_line, public.audit_event —
--     in one block whose handler turns a missing table or schema into this file's refusal (55000), the block's locks released
--     first. So no draft save or edit, level write, store, customer or audit write is in flight while the grant moves: it
--     committed before this file read anything or waits for its COMMIT. THE COST: every read and write of those seven tables
--     waits until COMMIT, though no row is rewritten.
--   - DEPLOY AND ROLLBACK: FAIL CLOSED BOTH WAYS. It and the runtime that calls create_v2 move together: the startup preflight
--     pins the exact ledger (001-031) and the exact grants (create_v2's EXECUTE in place of 028's), so the 001-030 runtime
--     refuses a 031 database (its EXECUTE is gone) and this runtime refuses a 030 one. ROLL 031 BACK BEFORE 030, and before 029
--     and 028: 030's rollback refuses while 031 is applied (its plain DROP SCHEMA meets this routine, and the whole 030
--     rollback rolls back — the intended atomic refusal), and 029's and 028's rollbacks cannot see this file. The rollback
--     NEVER REFUSES ON DATA: this file adds no table, row or version (an advisory key lives and dies with a transaction), so
--     every draft, line, role row, version row, audit record, outbox row and completion stays; it refuses only on the catalog
--     or the applier's rights. IT RESTORES THE 030-ERA CONTRACT AND THE DA-210 WINDOW for the Invoices level: after it, the save
--     routine tmpos_app can call is 028's again, whose sealed 'customer_not_found' rests on the unlocked decision.
--   - NO SECRET, NO DYNAMIC SQL, NO EXTENSION, NO TEMPORARY OBJECT, NO BACKFILL. Every statement is fixed text, every value a
--     parameter, every relation and routine schema-qualified; the routine pins its search_path to pg_catalog then pg_temp and
--     runs with row_security off.
--
-- Reversible via 031_m7b_invoice_create_authority.down.sql, which never refuses on data and restores 028's grant. Roll 031 back
-- before 030.
--
-- Assumes 001-030 are applied. A future managed apply targets the complete contiguous chain through the newest committed
-- migration — now 001-031 (owner decision D4); this file authorizes no apply.

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
    raise exception 'migration 031 refused: public.store, tmpos_role.tenant_role_level, tmpos_role_edit.role_level_version, tmpos_customer.customer, tmpos_invoice_draft.invoice_draft, tmpos_invoice_draft.invoice_draft_line or public.audit_event is missing (migrations 002, 017, 020, 021 and 028 must be applied first)'
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
  if pg_catalog.to_regprocedure('tmpos_invoice_edit.m7b_invoice_draft_create_v2(text, uuid, uuid, uuid, uuid, jsonb, bigint)') is not null then
    raise exception 'migration 031 refused: tmpos_invoice_edit.m7b_invoice_draft_create_v2 already exists'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- The runtime roles this file grants to and revokes from, checked before any ::regrole cast below can raise undefined_object.
  if (select pg_catalog.count(*) from pg_catalog.pg_roles r
       where r.rolname = any (array['tmpos_app', 'tmpos_audit_writer', 'anon', 'authenticated']::name[])) <> 4 then
    raise exception 'migration 031 refused: the runtime roles tmpos_app, tmpos_audit_writer, anon and authenticated must exist (migration 005 and the Supabase roles)'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- The chain is contiguous: 030 is the newest migration this file sits on, exactly as 030 left it — its schema holding exactly
  -- its two functions and nothing else, with exactly 030's grants, and its trigger and 021's on the level table in their exact
  -- shapes, enabled ALWAYS.
  -- tgtype: ROW 1 + INSERT 4 + DELETE 8 + UPDATE 16 = 29 (030's); ROW 1 + UPDATE 16 = 17 (021's).
  if pg_catalog.to_regnamespace('tmpos_invoice_edit') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_edit.m7b_invoice_draft_update_v2(text, uuid, uuid, uuid, bigint, uuid, jsonb, bigint)') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_edit.m7b_invoice_level_guard()') is null then
    raise exception 'migration 031 refused: migration 030 must be applied first (schema tmpos_invoice_edit, its edit routine and its trigger function)'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if (select pg_catalog.string_agg(p.oid::regprocedure::text, ', ' order by p.oid::regprocedure::text)
        from pg_catalog.pg_proc p where p.pronamespace = 'tmpos_invoice_edit'::regnamespace)
     is distinct from
     'tmpos_invoice_edit.m7b_invoice_draft_update_v2(text,uuid,uuid,uuid,bigint,uuid,jsonb,bigint), tmpos_invoice_edit.m7b_invoice_level_guard()'
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
          where n.oid = 'tmpos_invoice_edit'::regnamespace) <> 3 then
    raise exception 'migration 031 refused: schema tmpos_invoice_edit does not hold exactly migration 030''s two functions and nothing else, or its or their grants are not exactly 030''s'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
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
    raise exception 'migration 031 refused: tmpos_role.tenant_role_level does not carry exactly 021''s version trigger and 030''s guard trigger, each in its exact shape and enabled ALWAYS'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- 028's routine, the contract this file supersedes and its rollback restores.
  if pg_catalog.to_regprocedure('tmpos_invoice_draft.m7b_invoice_draft_create(text, uuid, uuid, uuid, uuid, jsonb, bigint)') is null then
    raise exception 'migration 031 refused: migration 028''s save routine is missing'
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
    raise exception 'migration 031 refused: 016''s hold or admission read, 018''s mint ledger or issuer key, or 002''s tenant or membership table is missing'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- The routine is created in 030's schema and calls 016's hold and admission read as its owner, the principal applying this
  -- file, and reads and writes the schemas below.
  if not (pg_catalog.has_schema_privilege(current_user, 'tmpos_invoice_edit', 'CREATE')
          and pg_catalog.has_function_privilege(current_user, 'tmpos_session.m5_hold_tenant_standing(text, text)', 'EXECUTE')
          and pg_catalog.has_function_privilege(current_user, 'tmpos_session.m5_admit_tenant_session_v2(text, text)', 'EXECUTE')
          and pg_catalog.has_schema_privilege(current_user, 'public', 'USAGE')
          and pg_catalog.has_schema_privilege(current_user, 'tmpos_session', 'USAGE')
          and pg_catalog.has_schema_privilege(current_user, 'tmpos_mint', 'USAGE')
          and pg_catalog.has_schema_privilege(current_user, 'tmpos_role', 'USAGE')
          and pg_catalog.has_schema_privilege(current_user, 'tmpos_customer', 'USAGE')
          and pg_catalog.has_schema_privilege(current_user, 'tmpos_invoice_draft', 'USAGE')) then
    raise exception 'migration 031 refused: the applying principal cannot create in schema tmpos_invoice_edit, execute 016''s hold and admission read, which the routine calls, or use the schemas it reads'
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
    raise exception 'migration 031 refused: the applying principal neither owns nor inherits the owner of a table the save routine reads or writes, or one has forced row security'
      using errcode = 'insufficient_privilege';
  end if;
  -- The revoke below and the rollback's grant are exact only if the applying principal OWNS 028's routine and its COMPLETE ACL
  -- (coalesce(proacl, acldefault), every entry, the owner's included) is exactly two entries: the owner's EXECUTE and tmpos_app's
  -- EXECUTE, each granted by the owner and non-grantable — nothing else, PUBLIC included. Then the rollback's grant restores the
  -- ACL byte for byte, and the revoke is not a silent no-op.
  if not exists (select 1 from pg_catalog.pg_proc p
                  where p.oid = 'tmpos_invoice_draft.m7b_invoice_draft_create(text, uuid, uuid, uuid, uuid, jsonb, bigint)'::regprocedure
                    and p.proowner = v_me)
     or (select pg_catalog.count(*)
           from pg_catalog.pg_proc p,
                pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g
          where p.oid = 'tmpos_invoice_draft.m7b_invoice_draft_create(text, uuid, uuid, uuid, uuid, jsonb, bigint)'::regprocedure) <> 2
     or (select pg_catalog.count(*)
           from pg_catalog.pg_proc p,
                pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g
          where p.oid = 'tmpos_invoice_draft.m7b_invoice_draft_create(text, uuid, uuid, uuid, uuid, jsonb, bigint)'::regprocedure
            and g.grantee = p.proowner and g.privilege_type = 'EXECUTE' and not g.is_grantable
            and g.grantor = p.proowner) <> 1
     or (select pg_catalog.count(*)
           from pg_catalog.pg_proc p,
                pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g
          where p.oid = 'tmpos_invoice_draft.m7b_invoice_draft_create(text, uuid, uuid, uuid, uuid, jsonb, bigint)'::regprocedure
            and g.grantee = 'tmpos_app'::regrole and g.privilege_type = 'EXECUTE' and not g.is_grantable
            and g.grantor = p.proowner) <> 1 then
    raise exception 'migration 031 refused: the applying principal does not own 028''s save routine, or tmpos_app''s EXECUTE on it is not the one non-grantable entry 028 issued'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$$;

-- Under READ COMMITTED the checks above and the postcondition below see every row committed before the locks were granted
-- (017's reason).
do $$
begin
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'migration 031 refused: it must run under READ COMMITTED, so that its checks see every committed row'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$$;

-- =============================================================================
-- 4) The routine
-- =============================================================================
create function tmpos_invoice_edit.m7b_invoice_draft_create_v2(
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
  --      decided again. The writers it orders against are those of the role's Invoices level, which take the same key
  --      EXCLUSIVE (030's trg_tenant_role_level_invoice_guard). Both sealed answers — 'customer_not_found' (step 10c) and
  --      'applied' — are decided after this point and committed while the key is held. Three SEPARATE top-level statements
  --      of the routine's outermost block, never inside a BEGIN ... EXCEPTION block (a subtransaction that aborts releases a
  --      transaction-scoped advisory lock): the key, with 030's exact expression; the clock again, because the wait may have
  --      been long (an expired session is refused); and the Invoices level read again by a PLAIN SELECT, a fresh READ
  --      COMMITTED snapshot taken after the wait, so a level a writer committed before releasing the key is seen, decided
  --      exactly as step 8 decides it. Step 8 stays an early pre-check; this is the Invoices decision of record. No FOR SHARE
  --      or FOR UPDATE on an Invoices role row or a version row after the key (030's lock-order rule), nothing inserted: a
  --      role without a stored level is decided on its catalog default and no row is made for it. store_owner is Full and
  --      never stored: no key, no read.
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
    if coalesce(pg_catalog.array_position(c_levels,
         coalesce(v_invoices, case v_role when 'manager' then 'full' when 'technician' then 'view' when 'sales_staff' then 'create' end)), 0)
       < pg_catalog.array_position(c_levels, 'create') then
      return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid;
      return;
    end if;
  end if;

  -- 10c. Step 10's finding, answered now that the Invoices level is held: nothing written, no role row made.
  if not v_customer_found then
    return query select 'customer_not_found'::text, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;

  -- 11-12. The Customers role row made to exist (NULL: the default) and held FOR SHARE until COMMIT, then both levels decided
  --        again: Customers on its locked value, Invoices on step 10b's (held under the key, so unchanged). An owner's
  --        Customers level edit holding the row FOR UPDATE is waited for and its committed level is what is read; one attempted
  --        later waits for this transaction. A row gone by now refuses. (028's Invoices anchor and FOR SHARE are not here: step 10b
  --        holds the Invoices level, and a lock on an Invoices role row after the key would close a cycle with 026's setter —
  --        030's lock-order rule. The create writes no Invoices role row at all.)
  if v_role in ('manager', 'technician', 'sales_staff') then
    insert into tmpos_role.tenant_role_level (tenant_id, role_id, domain, level, updated_at)
    values (v_tenant, v_role, 'customers', null, pg_catalog.now())
    on conflict (tenant_id, role_id, domain) do nothing;
    select l.level into v_customers
      from tmpos_role.tenant_role_level l
     where l.tenant_id = v_tenant and l.role_id = v_role and l.domain = 'customers'
       for share;
    if not found then
      return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid;
      return;
    end if;
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

  -- 13. Live, on the database clock read again now: step 11 may have waited.
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

comment on function tmpos_invoice_edit.m7b_invoice_draft_create_v2(text, uuid, uuid, uuid, uuid, jsonb, bigint) is
  'Phase 4.0 M7b (migration 031): migration 028''s m7b_invoice_draft_create with the role''s Invoices level held through completion: saves one invoice draft (status draft, USD, version 1) and its 1-50 ordered lines at a store, for a key naming a ledger-minted, live (database clock, read after every lock wait) tenant session minted under the installed issuer key, after 016''s hold and the session, ledger and issuer key rows, whose standing digest is unchanged, whose account status is active or trialing, who holds EXACTLY ONE active store-scope grant at p_store_id (a selector only) on an active or trialing tenant and store — the store row re-read FOR SHARE in that grant''s tenant — and whose role''s Invoices level is Create or above and Customers level View or above (store_owner full; manager, technician, sales_staff the owner''s stored level, else the catalog default). Both levels are read unlocked as an early pre-check; then, for manager, technician and sales_staff, after the customer is read and before either sealed answer, the role''s transaction-scoped advisory key pg_advisory_xact_lock_shared(530030, hashtext(tenant || ''/'' || role)) is taken and the Invoices level decided again (a plain read; nothing inserted or row-locked; the session''s clock read again after the wait), and the key is held until the command transaction ends, so a writer of an Invoices level — which takes the same key EXCLUSIVE through trg_tenant_role_level_invoice_guard — cannot commit an Invoices change while the save holds the key (a waiting writer may time out and roll back instead), and a narrowing that committed first refuses the save. The Customers level is decided again only on the applied path, on the role''s Customers row made to exist (NULL) and held FOR SHARE; no Invoices role row is written. Judges every argument first (invalid_parameter_value, a fixed message naming the field, never the value; the lines one jsonb array of exact objects, amounts in numeric, their sum equal to p_subtotal_cents). Answers one row: (''refused'', NULLs) for any authority refusal, the second Invoices decision and a session that expired while the key waited included; (''tenant_mismatch'', NULLs) when the grant''s tenant is not p_expected_tenant; (''customer_not_found'', NULLs) alike for a missing and another tenant''s customer, decided with the key held — the last two and every refusal up to the key''s decision before any write, with no role row made (a later refusal, on the locked Customers re-decision or the clock read after it, follows only the Customers anchor, which the caller''s rollback removes); else inserts the header and the lines and answers (''applied'', tenant, store, actor, membership). Writes no audit record.';

-- =============================================================================
-- 5) Privileges, and the proof that nothing wider was issued
-- =============================================================================
-- PostgreSQL grants EXECUTE on a new function to PUBLIC by default, so every default is removed explicitly before the one
-- intended grant is issued. tmpos_app loses its EXECUTE on 028's routine, which stays in its schema, unaltered, for the
-- rollback. tmpos_app already holds USAGE on tmpos_invoice_edit (030). No table grant.
revoke all on function tmpos_invoice_edit.m7b_invoice_draft_create_v2(text, uuid, uuid, uuid, uuid, jsonb, bigint) from public, anon, authenticated, tmpos_app, tmpos_audit_writer;

revoke execute on function tmpos_invoice_draft.m7b_invoice_draft_create(text, uuid, uuid, uuid, uuid, jsonb, bigint) from tmpos_app;

grant execute on function tmpos_invoice_edit.m7b_invoice_draft_create_v2(text, uuid, uuid, uuid, uuid, jsonb, bigint) to tmpos_app;

-- =============================================================================
-- 6) Postcondition
-- =============================================================================
-- Proven rather than asserted, in 030's form. This file refuses to finish unless, now:
--   (a) schema tmpos_invoice_edit holds exactly 030's two functions and this file's routine, and no relation or type;
--   (b) the routine is plpgsql, SECURITY DEFINER, VOLATILE, pinned to pg_catalog, pg_temp with row_security off, takes 028's
--       arguments and returns 028's TABLE, carries a comment and is owned by the applying principal;
--   (c) the complete ACL of the routine is exactly two entries, the owner's EXECUTE and a non-grantable EXECUTE to tmpos_app,
--       each granted by the owner; and that of 028's routine now exactly the owner's one — tmpos_app included, PUBLIC included;
--   (d) tmpos_app CAN execute the routine and 030's edit routine and use the schema (whose ACL and the edit routine's stay
--       exactly 030's), and CANNOT execute 028's routine; tmpos_audit_writer, anon and authenticated can execute neither save
--       routine, by any path;
--   (e) none of the four runtime roles is a MEMBER of the routine's owner;
--   (f) tmpos_role.tenant_role_level still carries exactly 021's version trigger and 030's guard trigger, each in its exact
--       shape and enabled ALWAYS.
-- Each ACL is read through coalesce(acl, acldefault(kind, owner)), and a role reachable through a membership is followed
-- whatever the membership's options (019's reasons). WHAT THIS DOES NOT PROVE: it is a snapshot at apply time; the runtime
-- LOGIN's grants are enforced at every start by the startup preflight (server/persistence/postgresStartupPreflight.ts).
do $$
declare
  v_bad    text;
  v_me     oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user);
  v_create oid := 'tmpos_invoice_edit.m7b_invoice_draft_create_v2(text, uuid, uuid, uuid, uuid, jsonb, bigint)'::regprocedure;
  v_v2     oid := 'tmpos_invoice_edit.m7b_invoice_draft_update_v2(text, uuid, uuid, uuid, bigint, uuid, jsonb, bigint)'::regprocedure;
  v_028    oid := 'tmpos_invoice_draft.m7b_invoice_draft_create(text, uuid, uuid, uuid, uuid, jsonb, bigint)'::regprocedure;
begin
  -- (a)
  if (select pg_catalog.string_agg(p.oid::regprocedure::text, ', ' order by p.oid::regprocedure::text)
        from pg_catalog.pg_proc p where p.pronamespace = 'tmpos_invoice_edit'::regnamespace)
     is distinct from
     'tmpos_invoice_edit.m7b_invoice_draft_create_v2(text,uuid,uuid,uuid,uuid,jsonb,bigint), tmpos_invoice_edit.m7b_invoice_draft_update_v2(text,uuid,uuid,uuid,bigint,uuid,jsonb,bigint), tmpos_invoice_edit.m7b_invoice_level_guard()'
     or exists (select 1 from pg_catalog.pg_class c where c.relnamespace = 'tmpos_invoice_edit'::regnamespace)
     or exists (select 1 from pg_catalog.pg_type t where t.typnamespace = 'tmpos_invoice_edit'::regnamespace) then
    raise exception 'migration 031 refused: schema tmpos_invoice_edit does not hold exactly migration 030''s two functions and this file''s routine'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (b)
  if not exists (select 1 from pg_catalog.pg_proc p join pg_catalog.pg_language l on l.oid = p.prolang
                  where p.oid = v_create
                    and l.lanname = 'plpgsql' and p.prosecdef and p.provolatile = 'v'
                    and p.proconfig = array['search_path=pg_catalog, pg_temp', 'row_security=off'] and p.proowner = v_me)
     or pg_catalog.pg_get_function_arguments(v_create) is distinct from pg_catalog.pg_get_function_arguments(v_028)
     or pg_catalog.pg_get_function_result(v_create) is distinct from pg_catalog.pg_get_function_result(v_028)
     or pg_catalog.obj_description(v_create, 'pg_proc') is null then
    raise exception 'migration 031 refused: the save routine is not the plpgsql SECURITY DEFINER VOLATILE routine pinned to pg_catalog, pg_temp with row_security off section 4 declares, with 028''s arguments and RETURNS TABLE, carries no comment, or is not owned by the applying principal'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (c)
  select pg_catalog.string_agg(pg_catalog.format('%s %s:%s', p.proname, g.grantee::regrole::text, g.privilege_type), ', ')
    into v_bad
    from pg_catalog.pg_proc p,
         pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g
   where p.oid in (v_create, v_028)
     and not (g.privilege_type = 'EXECUTE' and not g.is_grantable and g.grantor = p.proowner
              and (g.grantee = p.proowner or (p.oid = v_create and g.grantee = 'tmpos_app'::regrole)));
  -- The complete ACL, the owner's entry included: the routine exactly two entries (the owner's and tmpos_app's), 028's one.
  if v_bad is not null
     or exists (select 1 from pg_catalog.pg_proc p
                 where p.oid in (v_create, v_028)
                   and (select pg_catalog.count(*)
                          from pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g)
                       <> case when p.oid = v_create then 2 else 1 end) then
    raise exception 'migration 031 refused: an unexpected direct grant remains on the save routine or on 028''s routine, or an entry is missing (%)', coalesce(v_bad, 'none listed')
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if (select pg_catalog.count(*)
        from pg_catalog.pg_proc p,
             pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g
       where p.oid = v_create and g.grantee = 'tmpos_app'::regrole and g.privilege_type = 'EXECUTE' and not g.is_grantable) <> 1 then
    raise exception 'migration 031 refused: tmpos_app does not hold a direct EXECUTE on the save routine'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (d)
  if not pg_catalog.has_function_privilege('tmpos_app', v_create, 'EXECUTE')
     or not pg_catalog.has_function_privilege('tmpos_app', v_v2, 'EXECUTE')
     or not pg_catalog.has_schema_privilege('tmpos_app', 'tmpos_invoice_edit'::regnamespace, 'USAGE')
     or pg_catalog.has_function_privilege('tmpos_app', v_028, 'EXECUTE')
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
          where n.oid = 'tmpos_invoice_edit'::regnamespace) <> 3 then
    raise exception 'migration 031 refused: tmpos_app must execute the save routine and 030''s edit routine, use schema tmpos_invoice_edit, and not execute 028''s routine, and 030''s grants must stay exactly 030''s'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  select pg_catalog.string_agg(distinct r.rolname::text || ' ' || p.proname::text, ', ') into v_bad
    from pg_catalog.pg_roles r
    join pg_catalog.pg_roles x on pg_catalog.pg_has_role(r.oid, x.oid, 'MEMBER')
    cross join pg_catalog.pg_proc p
   where p.oid in (v_create, v_028)
     and (r.rolname = any (array['tmpos_audit_writer', 'anon', 'authenticated']::name[])
          or (r.rolname = 'tmpos_app' and p.oid = v_028))
     and pg_catalog.has_function_privilege(x.oid, p.oid, 'EXECUTE');
  if v_bad is not null then
    raise exception 'migration 031 refused: a runtime role can execute a save routine this file does not grant it (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (e)
  select pg_catalog.string_agg(distinct r.rolname::text, ', ') into v_bad
    from pg_catalog.pg_roles r
    join pg_catalog.pg_proc p on p.oid = v_create
   where r.rolname = any (array['tmpos_app', 'tmpos_audit_writer', 'anon', 'authenticated']::name[])
     and pg_catalog.pg_has_role(r.oid, p.proowner, 'MEMBER');
  if v_bad is not null then
    raise exception 'migration 031 refused: % is a member of the owner of the save routine', v_bad
      using errcode = 'object_not_in_prerequisite_state',
            hint = 'membership hands a role everything the owner holds, including a direct write of every level and draft';
  end if;

  -- (f) tgtype: ROW 1 + INSERT 4 + DELETE 8 + UPDATE 16 = 29 (030's); ROW 1 + UPDATE 16 = 17 (021's).
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
    raise exception 'migration 031 refused: tmpos_role.tenant_role_level does not carry exactly 021''s version trigger and 030''s guard trigger'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$$;

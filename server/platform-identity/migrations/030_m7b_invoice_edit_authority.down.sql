-- Phase 4.0 M7b — holding the Invoices Edit authority through every newly sealed outcome of the invoice-draft edit
-- Migration: 030_m7b_invoice_edit_authority (DOWN)
--
-- Removes exactly what the up file created — the trigger trg_tenant_role_level_invoice_guard on tmpos_role.tenant_role_level,
-- the edit routine tmpos_invoice_edit.m7b_invoice_draft_update_v2 with the grant that rides on it, the trigger function
-- tmpos_invoice_edit.m7b_invoice_level_guard() and the schema tmpos_invoice_edit (a plain DROP SCHEMA, which refuses if
-- anything else is in it) — and gives tmpos_app its EXECUTE on 029's tmpos_invoice_draft.m7b_invoice_draft_update again, which
-- the up file revoked. Nothing else is touched — not a draft, a line, a version, a role row, a version row, an audit record,
-- an outbox row or a completion, not 029's routine, trigger or CHECK, not 021's trigger. Rolled back, the database is exactly
-- the 001-029 one for every object this file touched, and the runtime that requires 001-030 refuses to start on it.
--
-- IT REFUSES, CHANGING NOTHING (any refusal rolls the whole file back), ONLY WHEN:
--   * migration 030 is not applied (the schema, either function or the trigger is missing), or a table or schema an earlier
--     migration created and this file locks is missing (002, 017, 020, 021, 028);
--   * 029's edit routine is missing: there is no contract to restore (roll 030 back BEFORE 029);
--   * PostgreSQL refuses a statement of section 3: something other than this file's objects is in tmpos_invoice_edit (a plain
--     DROP SCHEMA) or depends on one of them (nothing is dropped with CASCADE), tmpos_app no longer exists, or the applier
--     lacks the right a statement needs (a DROP needs ownership of what it drops; of a trigger, of its table);
--   * the postcondition (section 4) finds 029's contract inexact: tmpos_role.tenant_role_level carries a non-internal trigger
--     beside 021's one version trigger, or that trigger not in its exact shape, or 021's trigger function serves any other
--     trigger; or 029's routine's complete ACL is not exactly its two entries (the owner's EXECUTE and tmpos_app's, each granted
--     by the owner and non-grantable), which also catches a grant the applier could not make.
--   The last two meet only the catalog: what was changed in it after 030 was applied (030's own postcondition left exactly
--   021's and 030's triggers on that table, 021's function serving one, and 029's routine executable by its owner alone), or
--   an applier without the right a statement needs.
-- IT NEVER REFUSES ON DATA. The up file adds no table, column, row or version — an advisory key lives and dies with a
-- transaction — so there is no state 029 cannot represent: every draft at any version (029's own rollback guards its versions),
-- line, role row, version row, audit record, outbox row and completion stays. WHAT THE ROLLBACK RESTORES IS 029'S CONTRACT AND
-- ITS KNOWN LIMIT: afterwards the edit routine tmpos_app can call is 029's, which decides the Invoices level unlocked and
-- re-decides it locked on the change path only, so its sealed answers can again commit under a level a downgrade has since
-- narrowed (DA-204).
--
-- ROLL 030 BACK BEFORE 029. 029's rollback and every earlier rollback cannot see this file (the edit routine is plpgsql, so no
-- catalog dependency records 029's routine, and 020's rollback drops the level table and with it the trigger, leaving this schema
-- orphaned). Run newest first.
--
-- LOCKS, BEFORE ANY CHECK. In 028's rollback order, the order the runtime's writers take these tables, as 029's rollback does:
-- public.store, tmpos_role.tenant_role_level, tmpos_role_edit.role_level_version, tmpos_customer.customer,
-- tmpos_invoice_draft.invoice_draft, tmpos_invoice_draft.invoice_draft_line, public.audit_event — each ACCESS EXCLUSIVE until
-- COMMIT. They are the first statements after the settings: nothing is read or checked before them, not even the catalog. A
-- running edit or level write therefore either committed before this file read anything or waits until this rollback commits.
-- They are taken in one block whose handler turns a missing table or schema (undefined_table, invalid_schema_name) into this
-- file's refusal (55000), the block's locks released first. The file runs with row_security off.
--
-- The applier's search_path is never relied on: every name below is schema-qualified and SET LOCAL pins resolution to
-- pg_catalog until this transaction ends. Revoking before dropping is redundant — a dropped object keeps no ACL — but it is
-- written out so the rollback states the privilege change it makes.

set local search_path = pg_catalog, pg_temp;
set local row_security = off;

-- =============================================================================
-- 1) The locks, in the writers' order: the first statements after the settings, before any check or any change
-- =============================================================================
-- A LOCK naming a table or schema that is missing raises undefined_table (42P01) or invalid_schema_name (3F000); the
-- block's handler turns either into this file's refusal (55000). The block runs as a subtransaction: once it completes,
-- this transaction keeps its locks until COMMIT; refused, the subtransaction has released the locks it took, and the
-- refusal aborts the file.
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
    raise exception 'migration 030 rollback refused: migration 030 is not applied (a table or schema an earlier migration created and this file locks is missing: public.store, tmpos_role.tenant_role_level, tmpos_role_edit.role_level_version, tmpos_customer.customer, tmpos_invoice_draft.invoice_draft, tmpos_invoice_draft.invoice_draft_line or public.audit_event: migrations 002, 017, 020, 021 and 028)'
      using errcode = 'object_not_in_prerequisite_state';
end
$$;

-- =============================================================================
-- 2) The file is applied, and 029 is still there (read under the locks)
-- =============================================================================
do $$
begin
  if pg_catalog.to_regnamespace('tmpos_invoice_edit') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_edit.m7b_invoice_draft_update_v2(text, uuid, uuid, uuid, bigint, uuid, jsonb, bigint)') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_edit.m7b_invoice_level_guard()') is null
     or not exists (select 1 from pg_catalog.pg_trigger g
                     join pg_catalog.pg_proc p on p.oid = g.tgfoid
                    where g.tgrelid = 'tmpos_role.tenant_role_level'::regclass
                      and g.tgname = 'trg_tenant_role_level_invoice_guard'
                      and p.pronamespace = pg_catalog.to_regnamespace('tmpos_invoice_edit')
                      and p.proname = 'm7b_invoice_level_guard') then
    raise exception 'migration 030 rollback refused: migration 030 is not applied (schema tmpos_invoice_edit, its edit routine, its trigger function or trg_tenant_role_level_invoice_guard is missing)'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if pg_catalog.to_regprocedure('tmpos_invoice_draft.m7b_invoice_draft_update(text, uuid, uuid, uuid, bigint, uuid, jsonb, bigint)') is null then
    raise exception 'migration 030 rollback refused: migration 029''s edit routine is missing, so there is no contract to restore (roll 030 back before 029)'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$$;

-- =============================================================================
-- 3) The trigger, the routine, the trigger function and the schema; 029's grant
-- =============================================================================
drop trigger trg_tenant_role_level_invoice_guard on tmpos_role.tenant_role_level;
revoke execute on function tmpos_invoice_edit.m7b_invoice_draft_update_v2(text, uuid, uuid, uuid, bigint, uuid, jsonb, bigint) from tmpos_app;
drop function tmpos_invoice_edit.m7b_invoice_draft_update_v2(text, uuid, uuid, uuid, bigint, uuid, jsonb, bigint);
drop function tmpos_invoice_edit.m7b_invoice_level_guard();
drop schema tmpos_invoice_edit;

grant execute on function tmpos_invoice_draft.m7b_invoice_draft_update(text, uuid, uuid, uuid, bigint, uuid, jsonb, bigint) to tmpos_app;

-- =============================================================================
-- 4) Postcondition: this file removed its own objects and left 029's contract exactly
-- =============================================================================
do $$
begin
  if pg_catalog.to_regnamespace('tmpos_invoice_edit') is not null
     or pg_catalog.to_regprocedure('tmpos_invoice_edit.m7b_invoice_draft_update_v2(text, uuid, uuid, uuid, bigint, uuid, jsonb, bigint)') is not null
     or pg_catalog.to_regprocedure('tmpos_invoice_edit.m7b_invoice_level_guard()') is not null
     or exists (select 1 from pg_catalog.pg_trigger g
                 where g.tgrelid = 'tmpos_role.tenant_role_level'::regclass and g.tgname = 'trg_tenant_role_level_invoice_guard') then
    raise exception 'migration 030 rollback refused: an object migration 030 created still exists'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- 021's trigger alone, exactly as 021 left it. tgtype: ROW 1 + UPDATE 16 = 17.
  if (select pg_catalog.count(*) from pg_catalog.pg_trigger g
       where g.tgrelid = 'tmpos_role.tenant_role_level'::regclass and not g.tgisinternal) <> 1
     or (select pg_catalog.count(*) from pg_catalog.pg_trigger g
          where g.tgfoid = 'tmpos_role_edit.m7a_role_level_version_advance()'::regprocedure) <> 1
     or not exists (select 1 from pg_catalog.pg_trigger g
                     where g.tgrelid = 'tmpos_role.tenant_role_level'::regclass
                       and g.tgname = 'trg_tenant_role_level_version_advance'
                       and g.tgfoid = 'tmpos_role_edit.m7a_role_level_version_advance()'::regprocedure
                       and g.tgtype = 17
                       and g.tgenabled = 'A'
                       and g.tgattr = ''::pg_catalog.int2vector
                       and g.tgqual is null
                       and not g.tgisinternal) then
    raise exception 'migration 030 rollback refused: tmpos_role.tenant_role_level does not carry exactly 021''s one version trigger again'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- 029's routine, its COMPLETE ACL exactly 029's: two entries, the owner's EXECUTE and tmpos_app's EXECUTE, each granted by the
  -- owner and non-grantable (every entry read through coalesce(proacl, acldefault), the owner's included; PUBLIC would be a third).
  if (select pg_catalog.count(*)
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
            and g.grantor = p.proowner) <> 1
     or not pg_catalog.has_function_privilege('tmpos_app',
              'tmpos_invoice_draft.m7b_invoice_draft_update(text, uuid, uuid, uuid, bigint, uuid, jsonb, bigint)'::regprocedure, 'EXECUTE') then
    raise exception 'migration 030 rollback refused: tmpos_app''s grant on 029''s edit routine is not exactly 029''s again'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$$;

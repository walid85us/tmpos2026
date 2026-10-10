-- Phase 4.0 M7b — holding the Invoices Create authority through both sealed outcomes of the invoice-draft save
-- Migration: 031_m7b_invoice_create_authority (DOWN)
--
-- Removes exactly what the up file created — the save routine tmpos_invoice_edit.m7b_invoice_draft_create_v2 with the grant
-- that rides on it — and gives tmpos_app its EXECUTE on 028's tmpos_invoice_draft.m7b_invoice_draft_create again, which the up
-- file revoked. Nothing else is touched — not a draft, a line, a role row, a version row, an audit record, an outbox row or a
-- completion, not 028's routine, not 030's schema, edit routine, trigger function or trigger, not 021's trigger. Rolled back,
-- the database is exactly the 001-030 one for every object this file touched, and the runtime that requires 001-031 refuses
-- to start on it.
--
-- IT REFUSES, CHANGING NOTHING (any refusal rolls the whole file back), ONLY WHEN:
--   * migration 031 is not applied (the save routine is missing), or a table or schema an earlier migration created and this
--     file locks is missing (002, 017, 020, 021, 028);
--   * 028's save routine is missing: there is no contract to restore (roll 031 back BEFORE 028);
--   * 030's objects are not all in place (schema tmpos_invoice_edit, its edit routine, its trigger function, its trigger): this
--     file restores the 030-era surface and must leave 030 intact (roll 031 back BEFORE 030);
--   * PostgreSQL refuses a statement of section 3: something depends on the routine (nothing is dropped with CASCADE),
--     tmpos_app no longer exists, or the applier lacks the right a statement needs (a DROP needs ownership of what it drops);
--   * the postcondition (section 4) finds the 030-era contract inexact: schema tmpos_invoice_edit does not hold exactly 030's
--     two functions, 030's trigger or 021's is not in its exact shape and enabled ALWAYS, the schema's or its functions'
--     grants are not exactly 030's, or 028's routine's complete ACL is not exactly its two entries (the owner's EXECUTE and tmpos_app's, each
--     granted by the owner and non-grantable), which also catches a grant the applier could not make.
--   The last two meet only the catalog: what was changed in it after 031 was applied, or an applier without the right a
--   statement needs.
-- IT NEVER REFUSES ON DATA. The up file adds no table, column, row or version — an advisory key lives and dies with a
-- transaction — so there is no state 030 cannot represent: every draft, line, role row, version row, audit record, outbox row
-- and completion stays (031's routine makes no Invoices role row; 028's makes its NULL anchor again when it needs one).
-- WHAT THE ROLLBACK RESTORES IS THE 030-ERA CONTRACT AND ITS KNOWN LIMIT: afterwards the save routine tmpos_app can call is
-- 028's, which decides the Invoices level unlocked and answers its sealed 'customer_not_found' before any locked
-- re-decision, so that answer can again commit under a level a narrowing has since withdrawn (DA-210).
--
-- ROLL 031 BACK BEFORE 030, and before 029 and 028. 030's rollback refuses while 031 is applied: its plain DROP SCHEMA
-- tmpos_invoice_edit meets this file's routine (dependent_objects_still_exist), and the whole 030 rollback rolls back. 029's and
-- 028's rollbacks cannot see this file (the routine is plpgsql, so no catalog dependency records 028's tables or routine). Run
-- newest first.
--
-- LOCKS, BEFORE ANY CHECK. 030's seven tables in 030's order, the order the runtime's writers take them: public.store,
-- tmpos_role.tenant_role_level, tmpos_role_edit.role_level_version, tmpos_customer.customer, tmpos_invoice_draft.invoice_draft,
-- tmpos_invoice_draft.invoice_draft_line, public.audit_event — each ACCESS EXCLUSIVE until COMMIT. They are the first
-- statements after the settings: nothing is read or checked before them, not even the catalog. A running save, edit or level
-- write therefore either committed before this file read anything or waits until this rollback commits. They are taken in one
-- block whose handler turns a missing table or schema (undefined_table, invalid_schema_name) into this file's refusal (55000),
-- the block's locks released first. The file runs with row_security off.
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
    raise exception 'migration 031 rollback refused: migration 031 is not applied (a table or schema an earlier migration created and this file locks is missing: public.store, tmpos_role.tenant_role_level, tmpos_role_edit.role_level_version, tmpos_customer.customer, tmpos_invoice_draft.invoice_draft, tmpos_invoice_draft.invoice_draft_line or public.audit_event: migrations 002, 017, 020, 021 and 028)'
      using errcode = 'object_not_in_prerequisite_state';
end
$$;

-- =============================================================================
-- 2) The file is applied, and 028 and 030 are still there (read under the locks)
-- =============================================================================
do $$
begin
  if pg_catalog.to_regprocedure('tmpos_invoice_edit.m7b_invoice_draft_create_v2(text, uuid, uuid, uuid, uuid, jsonb, bigint)') is null then
    raise exception 'migration 031 rollback refused: migration 031 is not applied (tmpos_invoice_edit.m7b_invoice_draft_create_v2 is missing)'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if pg_catalog.to_regprocedure('tmpos_invoice_draft.m7b_invoice_draft_create(text, uuid, uuid, uuid, uuid, jsonb, bigint)') is null then
    raise exception 'migration 031 rollback refused: migration 028''s save routine is missing, so there is no contract to restore (roll 031 back before 028)'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if pg_catalog.to_regnamespace('tmpos_invoice_edit') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_edit.m7b_invoice_draft_update_v2(text, uuid, uuid, uuid, bigint, uuid, jsonb, bigint)') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_edit.m7b_invoice_level_guard()') is null
     or not exists (select 1 from pg_catalog.pg_trigger g
                     join pg_catalog.pg_proc p on p.oid = g.tgfoid
                    where g.tgrelid = 'tmpos_role.tenant_role_level'::regclass
                      and g.tgname = 'trg_tenant_role_level_invoice_guard'
                      and p.pronamespace = pg_catalog.to_regnamespace('tmpos_invoice_edit')
                      and p.proname = 'm7b_invoice_level_guard') then
    raise exception 'migration 031 rollback refused: migration 030 is not intact (schema tmpos_invoice_edit, its edit routine, its trigger function or trg_tenant_role_level_invoice_guard is missing), so there is no 030-era contract to restore (roll 031 back before 030)'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$$;

-- =============================================================================
-- 3) The routine; 028's grant
-- =============================================================================
revoke execute on function tmpos_invoice_edit.m7b_invoice_draft_create_v2(text, uuid, uuid, uuid, uuid, jsonb, bigint) from tmpos_app;
drop function tmpos_invoice_edit.m7b_invoice_draft_create_v2(text, uuid, uuid, uuid, uuid, jsonb, bigint);

grant execute on function tmpos_invoice_draft.m7b_invoice_draft_create(text, uuid, uuid, uuid, uuid, jsonb, bigint) to tmpos_app;

-- =============================================================================
-- 4) Postcondition: this file removed its own object and left the 030-era contract exactly
-- =============================================================================
do $$
begin
  -- 030's schema holds exactly 030's two functions again, and no relation or type.
  if pg_catalog.to_regprocedure('tmpos_invoice_edit.m7b_invoice_draft_create_v2(text, uuid, uuid, uuid, uuid, jsonb, bigint)') is not null
     or (select pg_catalog.string_agg(p.oid::regprocedure::text, ', ' order by p.oid::regprocedure::text)
           from pg_catalog.pg_proc p where p.pronamespace = 'tmpos_invoice_edit'::regnamespace)
        is distinct from
        'tmpos_invoice_edit.m7b_invoice_draft_update_v2(text,uuid,uuid,uuid,bigint,uuid,jsonb,bigint), tmpos_invoice_edit.m7b_invoice_level_guard()'
     or exists (select 1 from pg_catalog.pg_class c where c.relnamespace = 'tmpos_invoice_edit'::regnamespace)
     or exists (select 1 from pg_catalog.pg_type t where t.typnamespace = 'tmpos_invoice_edit'::regnamespace) then
    raise exception 'migration 031 rollback refused: the save routine still exists, or schema tmpos_invoice_edit does not hold exactly migration 030''s two functions'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- 021's trigger and 030's, exactly as 030 left them. tgtype: ROW 1 + INSERT 4 + DELETE 8 + UPDATE 16 = 29; ROW 1 + UPDATE 16 = 17.
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
    raise exception 'migration 031 rollback refused: tmpos_role.tenant_role_level does not carry exactly 021''s version trigger and 030''s guard trigger'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- 030's grants are untouched: tmpos_app can execute 030's edit routine and use the schema, and the schema's and its two
  -- functions' complete ACLs are exactly 030's.
  if not pg_catalog.has_function_privilege('tmpos_app',
           'tmpos_invoice_edit.m7b_invoice_draft_update_v2(text, uuid, uuid, uuid, bigint, uuid, jsonb, bigint)'::regprocedure, 'EXECUTE')
     or not pg_catalog.has_schema_privilege('tmpos_app', 'tmpos_invoice_edit'::regnamespace, 'USAGE')
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
    raise exception 'migration 031 rollback refused: tmpos_app''s grants on schema tmpos_invoice_edit and 030''s edit routine are not exactly 030''s'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- 028's routine, its COMPLETE ACL exactly 028's: two entries, the owner's EXECUTE and tmpos_app's EXECUTE, each granted by the
  -- owner and non-grantable (every entry read through coalesce(proacl, acldefault), the owner's included; PUBLIC would be a third).
  if (select pg_catalog.count(*)
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
            and g.grantor = p.proowner) <> 1
     or not pg_catalog.has_function_privilege('tmpos_app',
              'tmpos_invoice_draft.m7b_invoice_draft_create(text, uuid, uuid, uuid, uuid, jsonb, bigint)'::regprocedure, 'EXECUTE') then
    raise exception 'migration 031 rollback refused: tmpos_app''s grant on 028''s save routine is not exactly 028''s again'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$$;

-- Phase 4.0 M7b — discarding a saved store invoice draft
-- Migration: 033_m7b_invoice_draft_discard (DOWN)
--
-- Removes exactly what the up file created — the rollback-order anchor, the triggers trg_invoice_draft_terminal and
-- trg_invoice_draft_line_terminal and their functions, the discard routine and the two open-only reads with the grants that
-- ride on them, the partial index tmpos_invoice_draft.invoice_draft_open_page_idx and the schema tmpos_invoice_discard (a plain
-- DROP SCHEMA, which refuses if anything else is in it) — and restores the 032-era contract exactly: invoice_draft_status_chk
-- is 028's CHECK (status = 'draft') again (validated, same name), and tmpos_app holds its EXECUTE on 028's
-- tmpos_invoice_draft.m7b_invoice_draft_page and m7b_invoice_draft_get again, which the up file revoked. Nothing else is
-- touched — not a draft, a line, a version, a role row, a version row, an audit record, an outbox row or a completion, not
-- 028's, 029's, 030's, 031's or 032's routines, triggers, functions or grants. Rolled back, the database is exactly the
-- 001-032 one for every object this file touched, and the runtime that requires 001-033 refuses to start on it.
--
-- IT REFUSES, CHANGING NOTHING (any refusal rolls the whole file back):
--   * while migration 033 is not applied (its schema, a function, a trigger, the index or the widened CHECK is missing), or a
--     table or schema an earlier migration created and this file locks is missing (002, 017, 020, 021, 028);
--   * while 028's page or get, or 032's and 030's objects, are missing: there is no 032-era contract to restore (roll 033 back
--     BEFORE 032 and every earlier file);
--   * while ANY invoice draft is not 'draft' (it has been discarded). 028's CHECK cannot hold it, and restoring that CHECK would
--     need the draft deleted or returned to 'draft' — either is a deliberate owner decision on data, never a rollback's side
--     effect (029 down's rule). After the first real discard this rollback is therefore one-way in practice (a discarded draft
--     is also at version 2 or above, which 029's rollback refuses);
--   * PostgreSQL refuses a statement of section 4: something other than this file's objects is in tmpos_invoice_discard (a
--     plain DROP SCHEMA) or depends on one of them (nothing is dropped with CASCADE), tmpos_app no longer exists, or the applier
--     lacks the right a statement needs (a DROP needs ownership of what it drops; of a trigger or an index, of its table);
--   * the postcondition (section 5) finds the 032-era contract inexact: an object of this file still exists, the CHECK is not
--     028's, the draft tables carry a trigger beside 029's one, schema tmpos_invoice_draft holds other relations or routines than
--     028's and 029's, or the complete ACL of 028's page and get is not exactly its two entries (the owner's EXECUTE and
--     tmpos_app's, each granted by the owner and non-grantable) or of 028's create not exactly the owner's one — which also
--     catches a grant the applier could not make.
-- RETAINED EVIDENCE DOES NOT BLOCK IT: every audit record (an edit's included) and every completion stays, untouched; the
-- audit table is append-only (002) and this file deletes nothing.
--
-- ROLL 033 BACK FIRST, before 032 and every earlier file. While 033 is applied, the anchor's recorded dependencies refuse
-- 032's, 030's, 029's and 028's rollbacks (2BP01), and 031's refuses on its own postcondition (032 is still there).
--
-- LOCKS, BEFORE ANY CHECK. 030's seven tables in 030's order, the order the runtime's writers take them: public.store,
-- tmpos_role.tenant_role_level, tmpos_role_edit.role_level_version, tmpos_customer.customer, tmpos_invoice_draft.invoice_draft,
-- tmpos_invoice_draft.invoice_draft_line, public.audit_event — each ACCESS EXCLUSIVE until COMMIT. They are the first
-- statements after the settings: nothing is read or checked before them, not even the catalog. A running discard, read, save,
-- edit or level write therefore either committed before this file read anything — a discard it committed is then visible to
-- the guard's statement, whose snapshot is taken after the locks (READ COMMITTED, 017's reason) — or waits until this rollback
-- commits. They are taken in one block whose handler turns a missing table or schema (undefined_table, invalid_schema_name)
-- into this file's refusal (55000), the block's locks released first. The guard runs with row_security off, so a table whose
-- row security were FORCEd on a non-owner applier makes the rollback fail instead of hiding rows from it.
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
    raise exception 'migration 033 rollback refused: migration 033 is not applied (a table or schema an earlier migration created and this file locks is missing: public.store, tmpos_role.tenant_role_level, tmpos_role_edit.role_level_version, tmpos_customer.customer, tmpos_invoice_draft.invoice_draft, tmpos_invoice_draft.invoice_draft_line or public.audit_event: migrations 002, 017, 020, 021 and 028)'
      using errcode = 'object_not_in_prerequisite_state';
end
$$;

-- =============================================================================
-- 2) The file is applied, and 028, 030 and 032 are still there (read under the locks)
-- =============================================================================
do $$
begin
  if pg_catalog.to_regnamespace('tmpos_invoice_discard') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_discard.m7b_invoice_draft_discard(text, uuid, uuid, uuid, bigint)') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_discard.m7b_invoice_draft_page_v2(text, uuid, uuid, uuid, integer)') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_discard.m7b_invoice_draft_get_v2(text, uuid, uuid, uuid)') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_discard.m7b_invoice_draft_terminal()') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_discard.m7b_invoice_draft_line_terminal()') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_discard.m7b_invoice_discard_prerequisites()') is null
     or pg_catalog.to_regclass('tmpos_invoice_draft.invoice_draft_open_page_idx') is null
     or not exists (select 1 from pg_catalog.pg_trigger g
                     where g.tgrelid = 'tmpos_invoice_draft.invoice_draft'::regclass and g.tgname = 'trg_invoice_draft_terminal'
                       and g.tgfoid = pg_catalog.to_regprocedure('tmpos_invoice_discard.m7b_invoice_draft_terminal()'))
     or not exists (select 1 from pg_catalog.pg_trigger g
                     where g.tgrelid = 'tmpos_invoice_draft.invoice_draft_line'::regclass and g.tgname = 'trg_invoice_draft_line_terminal'
                       and g.tgfoid = pg_catalog.to_regprocedure('tmpos_invoice_discard.m7b_invoice_draft_line_terminal()'))
     or not exists (select 1 from pg_catalog.pg_constraint k
                     where k.conrelid = 'tmpos_invoice_draft.invoice_draft'::regclass and k.conname = 'invoice_draft_status_chk'
                       and pg_catalog.pg_get_constraintdef(k.oid) = 'CHECK ((status = ANY (ARRAY[''draft''::text, ''discarded''::text])))') then
    raise exception 'migration 033 rollback refused: migration 033 is not applied (schema tmpos_invoice_discard, a function, a terminal trigger, the open page index or the widened status CHECK is missing)'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if pg_catalog.to_regprocedure('tmpos_invoice_draft.m7b_invoice_draft_page(text, uuid, uuid, uuid, integer)') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_draft.m7b_invoice_draft_get(text, uuid, uuid, uuid)') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_draft.m7b_invoice_draft_create(text, uuid, uuid, uuid, uuid, jsonb, bigint)') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_draft.m7b_invoice_draft_immutable()') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_edit.m7b_invoice_draft_update_v2(text, uuid, uuid, uuid, bigint, uuid, jsonb, bigint)') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_edit.m7b_invoice_level_guard()') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_edit.m7b_invoice_draft_create_v3(text, uuid, uuid, uuid, uuid, jsonb, bigint)') is null then
    raise exception 'migration 033 rollback refused: migration 028''s routines, 029''s trigger function, or 030''s or 032''s routines are missing, so there is no 032-era contract to restore (roll 033 back before 032)'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$$;

-- =============================================================================
-- 3) The guard: no discarded draft is ever deleted or returned to draft by a rollback
-- =============================================================================
do $$
begin
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'migration 033 rollback refused: it must run under READ COMMITTED, so that its check sees every committed draft'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if exists (select 1 from tmpos_invoice_draft.invoice_draft d where d.status is distinct from 'draft') then
    raise exception 'migration 033 rollback refused: an invoice draft has been discarded, and a rollback never deletes a draft or returns it to draft'
      using errcode = 'object_not_in_prerequisite_state',
            hint = 'deleting a discarded draft or returning it to draft is an owner decision taken deliberately, not a rollback''s side effect';
  end if;
end
$$;

-- =============================================================================
-- 4) The anchor, the triggers, their functions, the routines, the index and the schema; 028's CHECK and grants
-- =============================================================================
drop function tmpos_invoice_discard.m7b_invoice_discard_prerequisites();
drop trigger trg_invoice_draft_line_terminal on tmpos_invoice_draft.invoice_draft_line;
drop trigger trg_invoice_draft_terminal on tmpos_invoice_draft.invoice_draft;
drop function tmpos_invoice_discard.m7b_invoice_draft_line_terminal();
drop function tmpos_invoice_discard.m7b_invoice_draft_terminal();
revoke execute on function tmpos_invoice_discard.m7b_invoice_draft_discard(text, uuid, uuid, uuid, bigint) from tmpos_app;
revoke execute on function tmpos_invoice_discard.m7b_invoice_draft_page_v2(text, uuid, uuid, uuid, integer) from tmpos_app;
revoke execute on function tmpos_invoice_discard.m7b_invoice_draft_get_v2(text, uuid, uuid, uuid) from tmpos_app;
drop function tmpos_invoice_discard.m7b_invoice_draft_discard(text, uuid, uuid, uuid, bigint);
drop function tmpos_invoice_discard.m7b_invoice_draft_page_v2(text, uuid, uuid, uuid, integer);
drop function tmpos_invoice_discard.m7b_invoice_draft_get_v2(text, uuid, uuid, uuid);
drop index tmpos_invoice_draft.invoice_draft_open_page_idx;
revoke usage on schema tmpos_invoice_discard from tmpos_app;
drop schema tmpos_invoice_discard;

-- Validated over every row: the guard proved each is 'draft'.
alter table tmpos_invoice_draft.invoice_draft
  drop constraint invoice_draft_status_chk,
  add constraint invoice_draft_status_chk check (status = 'draft');

grant execute on function tmpos_invoice_draft.m7b_invoice_draft_page(text, uuid, uuid, uuid, integer) to tmpos_app;
grant execute on function tmpos_invoice_draft.m7b_invoice_draft_get(text, uuid, uuid, uuid) to tmpos_app;

-- =============================================================================
-- 5) Postcondition: this file removed its own objects and left the 032-era contract exactly
-- =============================================================================
do $$
begin
  -- The schema is gone, and section 4 dropped its six functions by name with no CASCADE before the plain DROP SCHEMA: none of
  -- them survives anywhere. A function of the same name in an unrelated schema is no object of this file's.
  if pg_catalog.to_regnamespace('tmpos_invoice_discard') is not null
     or pg_catalog.to_regclass('tmpos_invoice_draft.invoice_draft_open_page_idx') is not null then
    raise exception 'migration 033 rollback refused: an object migration 033 created still exists'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- 028's status CHECK, exactly.
  if (select pg_catalog.count(*) from pg_catalog.pg_constraint k
       where k.conrelid = 'tmpos_invoice_draft.invoice_draft'::regclass and k.conname = 'invoice_draft_status_chk'
         and k.contype = 'c' and k.convalidated and pg_catalog.pg_get_constraintdef(k.oid) = 'CHECK ((status = ''draft''::text))') <> 1 then
    raise exception 'migration 033 rollback refused: invoice_draft_status_chk is not 028''s validated CHECK (status = ''draft'') again'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- 029's trigger alone on the drafts, exactly as 029 left it, and none on the lines. tgtype: ROW 1 + BEFORE 2 + UPDATE 16 = 19.
  if (select pg_catalog.count(*) from pg_catalog.pg_trigger g
       where g.tgrelid in ('tmpos_invoice_draft.invoice_draft'::regclass, 'tmpos_invoice_draft.invoice_draft_line'::regclass)
         and not g.tgisinternal) <> 1
     or not exists (select 1 from pg_catalog.pg_trigger g
                     where g.tgrelid = 'tmpos_invoice_draft.invoice_draft'::regclass
                       and g.tgname = 'trg_invoice_draft_immutable'
                       and g.tgfoid = 'tmpos_invoice_draft.m7b_invoice_draft_immutable()'::regprocedure
                       and g.tgtype = 19
                       and g.tgenabled = 'A'
                       and g.tgattr = ''::pg_catalog.int2vector
                       and g.tgqual is null
                       and not g.tgisinternal) then
    raise exception 'migration 033 rollback refused: the draft tables do not carry exactly 029''s one trigger again'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- Schema tmpos_invoice_draft: exactly 028's relations, and exactly 028's three routines and 029's two.
  if (select pg_catalog.string_agg(pg_catalog.format('%s:%s', c.relname, c.relkind), ', ' order by c.relname)
        from pg_catalog.pg_class c where c.relnamespace = 'tmpos_invoice_draft'::regnamespace)
     is distinct from
     'invoice_draft:r, invoice_draft_customer_idx:i, invoice_draft_line:r, invoice_draft_line_pkey:i, invoice_draft_page_idx:i, invoice_draft_pkey:i, invoice_draft_scope_key:i'
     or (select pg_catalog.string_agg(p.oid::regprocedure::text, ', ' order by p.oid::regprocedure::text)
           from pg_catalog.pg_proc p where p.pronamespace = 'tmpos_invoice_draft'::regnamespace)
        is distinct from
        'tmpos_invoice_draft.m7b_invoice_draft_create(text,uuid,uuid,uuid,uuid,jsonb,bigint), tmpos_invoice_draft.m7b_invoice_draft_get(text,uuid,uuid,uuid), tmpos_invoice_draft.m7b_invoice_draft_immutable(), tmpos_invoice_draft.m7b_invoice_draft_page(text,uuid,uuid,uuid,integer), tmpos_invoice_draft.m7b_invoice_draft_update(text,uuid,uuid,uuid,bigint,uuid,jsonb,bigint)' then
    raise exception 'migration 033 rollback refused: schema tmpos_invoice_draft does not hold exactly 028''s relations and 028''s and 029''s routines again'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- 028's page and get, their COMPLETE ACL exactly 028's again: two entries, the owner's EXECUTE and tmpos_app's EXECUTE, each
  -- granted by the owner and non-grantable; and 028's create exactly the owner's one (031 revoked tmpos_app's). Every entry is
  -- read through coalesce(proacl, acldefault), the owner's included; PUBLIC would be one more.
  if exists (select 1 from pg_catalog.pg_proc p
              where p.oid in ('tmpos_invoice_draft.m7b_invoice_draft_page(text, uuid, uuid, uuid, integer)'::regprocedure,
                              'tmpos_invoice_draft.m7b_invoice_draft_get(text, uuid, uuid, uuid)'::regprocedure)
                and ((select pg_catalog.count(*)
                        from pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g) <> 2
                     or (select pg_catalog.count(*)
                           from pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g
                          where g.grantee = p.proowner and g.privilege_type = 'EXECUTE' and not g.is_grantable
                            and g.grantor = p.proowner) <> 1
                     or (select pg_catalog.count(*)
                           from pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g
                          where g.grantee = 'tmpos_app'::regrole and g.privilege_type = 'EXECUTE' and not g.is_grantable
                            and g.grantor = p.proowner) <> 1
                     or not pg_catalog.has_function_privilege('tmpos_app', p.oid, 'EXECUTE')))
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
    raise exception 'migration 033 rollback refused: tmpos_app''s grants on 028''s page and get are not exactly 028''s again, or 028''s create is not closed to everyone but its owner'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$$;

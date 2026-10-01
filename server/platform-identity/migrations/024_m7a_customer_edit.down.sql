-- Phase 4.0 M7a — editing a saved customer
-- Migration: 024_m7a_customer_edit (DOWN)
--
-- Removes exactly what the up file created — the two routines tmpos_customer_edit.m7a_customer_update and
-- m7a_customer_profile with the grants that ride on them, schema tmpos_customer_edit with its USAGE grant, the index
-- idx_audit_event_subject_customer_occurred and the column public.audit_event.subject_customer_id, and the CHECK
-- customer_row_version_chk and the column row_version of tmpos_customer.customer — and gives tmpos_app back EXECUTE on
-- 023's tmpos_customer_contact.m7a_contact_profile, the grant the up file revoked. Issued by the same owner, it is the same
-- ACL item 023 left. Nothing else is touched — not a customer's id, tenant, name, phone, email or creation time, not 017's
-- index or page, not 020's, 022's or 023's other objects, not a role or a grant issued by 001-023. Rolled back, the
-- database is exactly the 001-023 one.
--
-- IT REFUSES WHILE ANY CUSTOMER HAS BEEN EDITED OR ANY AUDIT RECORD NAMES A CUSTOMER, and drops nothing:
--   * a customer whose row_version is above 1 has been edited. Dropping the column and applying the up file again would
--     restart every row at 1, so an editor still holding an old version (a tab opened before the edit) could match again
--     and overwrite the newer change as if it were current. Resetting versions is a deliberate owner decision, never a
--     rollback's side effect;
--   * an audit record whose subject_customer_id is set names the customer its action changed. Dropping the column would
--     erase that evidence from an append-only table (009's rule). Every committed customer edit writes one, so in practice
--     this rollback runs only before the edit has served.
-- Both tables are locked first (ACCESS EXCLUSIVE, which dropping a column takes anyway), so no row can be written between
-- the check and the drop, and the check runs only under READ COMMITTED, where its statement's snapshot is taken after the
-- locks are held (017's reason). It runs with row_security off, so a table whose row security were FORCEd on a non-owner
-- applier makes the rollback fail instead of hiding rows from the check.
--
-- WHAT IT COSTS, STATED. Restoring 023's grant re-opens the unversioned profile read to the runtime role, and runtime code
-- built for 024 has no tmpos_customer_edit routine to call: its startup preflight refuses a 023 database. So the runtime
-- rolls back to the P6 build with this file, and no runtime built for 024 serves in between.
--
-- ROLL 024 BACK BEFORE 023, 022, 021 AND 020 (the ledger's newest-first order). Were 023 rolled back first — its own
-- postcondition refuses while row_version exists, so it cannot be — the grant below would have no routine to restore, and
-- this rollback refuses (its guard) until 023 is applied again.
--
-- The applier's search_path is never relied on: every name below is schema-qualified and SET LOCAL pins resolution to
-- pg_catalog until this transaction ends. Revoking before dropping is redundant — a dropped object keeps no ACL — but it is
-- written out so the rollback states the privilege change it makes.

set local search_path = pg_catalog, pg_temp;
set local row_security = off;

-- =============================================================================
-- 1) The guard: no edited customer's version and no audit subject is ever discarded by a rollback
-- =============================================================================
lock table tmpos_customer.customer in access exclusive mode;
lock table public.audit_event in access exclusive mode;

do $$
begin
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'migration 024 rollback refused: it must run under READ COMMITTED, so that its check sees every committed customer and audit row'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- What this file removes must all be there: a second run after a completed rollback (or a partial state) refuses with a
  -- stated reason instead of failing on a missing column below.
  if pg_catalog.to_regnamespace('tmpos_customer_edit') is null
     or not exists (select 1 from pg_catalog.pg_attribute a
                     where a.attrelid = 'tmpos_customer.customer'::regclass and a.attname = 'row_version' and not a.attisdropped)
     or not exists (select 1 from pg_catalog.pg_attribute a
                     where a.attrelid = 'public.audit_event'::regclass and a.attname = 'subject_customer_id' and not a.attisdropped) then
    raise exception 'migration 024 rollback refused: migration 024 is not applied (schema tmpos_customer_edit, tmpos_customer.customer.row_version or public.audit_event.subject_customer_id is missing)'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- to_regprocedure, never a ::regprocedure literal: a missing routine must refuse here, not fail to parse.
  if pg_catalog.to_regprocedure('tmpos_customer_contact.m7a_contact_profile(text, uuid, uuid)') is null then
    raise exception 'migration 024 rollback refused: migration 023''s profile read is missing, so its grant cannot be given back (roll 024 back before 023)'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if exists (select 1 from tmpos_customer.customer c where c.row_version > 1) then
    raise exception 'migration 024 rollback refused: a customer has been edited (its row_version is above 1), and a rollback never lets an old editor''s version look current again'
      using errcode = 'object_not_in_prerequisite_state',
            hint = 'resetting a customer''s version is an owner decision taken deliberately, not a rollback''s side effect';
  end if;
  -- No column grant on the customer table, to tmpos_app by any membership path or to anyone: one made while 024 was
  -- installed would otherwise survive the rollback (the up file's postcondition (h), checked before anything is dropped).
  if exists (select 1
               from pg_catalog.pg_roles r
               join pg_catalog.pg_roles x on pg_catalog.pg_has_role(r.oid, x.oid, 'MEMBER')
              where r.rolname = 'tmpos_app'
                and pg_catalog.has_any_column_privilege(x.oid, 'tmpos_customer.customer'::regclass, 'SELECT, INSERT, UPDATE, REFERENCES'))
     or exists (select 1 from pg_catalog.pg_attribute a
                 where a.attrelid = 'tmpos_customer.customer'::regclass and a.attacl is not null) then
    raise exception 'migration 024 rollback refused: a column grant exists on tmpos_customer.customer, or tmpos_app reaches a column of it'
      using errcode = 'object_not_in_prerequisite_state',
            hint = 'revoke the column grant deliberately; a rollback never carries a widened grant into the 001-023 database';
  end if;
  if exists (select 1 from public.audit_event a where a.subject_customer_id is not null) then
    raise exception 'migration 024 rollback refused: an audit record names the customer its action targeted'
      using errcode = 'object_not_in_prerequisite_state',
            hint = 'dropping subject_customer_id would erase audit evidence; resolving that state is an owner decision';
  end if;
end
$$;

-- =============================================================================
-- 2) The routines
-- =============================================================================
revoke execute on function tmpos_customer_edit.m7a_customer_update(text, uuid, uuid, bigint, text, boolean, text, boolean, text) from tmpos_app;
revoke execute on function tmpos_customer_edit.m7a_customer_profile(text, uuid, uuid) from tmpos_app;
drop function tmpos_customer_edit.m7a_customer_update(text, uuid, uuid, bigint, text, boolean, text, boolean, text);
drop function tmpos_customer_edit.m7a_customer_profile(text, uuid, uuid);

-- =============================================================================
-- 3) The schema
-- =============================================================================
-- WITHOUT CASCADE: if anything this file did not create lives in it, the drop fails and the whole rollback with it,
-- rather than taking an unknown object down silently.
revoke usage on schema tmpos_customer_edit from tmpos_app;
drop schema tmpos_customer_edit;

-- =============================================================================
-- 4) The grant the up file revoked
-- =============================================================================
grant execute on function tmpos_customer_contact.m7a_contact_profile(text, uuid, uuid) to tmpos_app;

-- =============================================================================
-- 5) The audit subject (no record names one: the guard proved it)
-- =============================================================================
drop index public.idx_audit_event_subject_customer_occurred;
alter table public.audit_event drop column subject_customer_id;

-- =============================================================================
-- 6) The CHECK and the version column (every value in it is 1: the guard proved it)
-- =============================================================================
alter table tmpos_customer.customer
  drop constraint customer_row_version_chk,
  drop column row_version;

-- =============================================================================
-- 7) Postcondition: this file removed its own objects, restored its one grant, and widened nothing
-- =============================================================================
-- It checks that the schema is gone; that the customer table has exactly 017's and 023's columns again and the audit table
-- no subject_customer_id or its index; that 023's profile read carries EXACTLY 023's ACL items again — beyond its owner's,
-- a non-grantable EXECUTE to tmpos_app and nothing else, read through coalesce(acl, acldefault(kind, owner)) — so a grant
-- added to it while 024 was applied refuses the rollback instead of surviving it; that tmpos_app can in fact execute it;
-- that tmpos_app holds no privilege on 017's table by any path; and, by PRESENCE, that 022's read and 023's create are
-- still there.
do $$
declare
  v_bad text;
begin
  if pg_catalog.to_regnamespace('tmpos_customer_edit') is not null then
    raise exception 'migration 024 rollback refused: schema tmpos_customer_edit still exists'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  select pg_catalog.string_agg(a.attname::text, ', ' order by a.attnum) into v_bad
    from pg_catalog.pg_attribute a
   where a.attrelid = 'tmpos_customer.customer'::regclass
     and a.attnum > 0
     and not a.attisdropped;
  if v_bad is distinct from 'customer_id, tenant_id, name, phone, email, created_at' then
    raise exception 'migration 024 rollback refused: tmpos_customer.customer does not have exactly 017''s and 023''s columns again (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if exists (select 1 from pg_catalog.pg_attribute a
              where a.attrelid = 'public.audit_event'::regclass and a.attname = 'subject_customer_id' and not a.attisdropped)
     or pg_catalog.to_regclass('public.idx_audit_event_subject_customer_occurred') is not null then
    raise exception 'migration 024 rollback refused: public.audit_event still has subject_customer_id or its index'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  select pg_catalog.string_agg(pg_catalog.format('%s:%s', g.grantee::regrole::text, g.privilege_type), ', ')
    into v_bad
    from pg_catalog.pg_proc p,
         pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g
   where p.oid = 'tmpos_customer_contact.m7a_contact_profile(text, uuid, uuid)'::regprocedure
     and g.grantee <> p.proowner
     and not (g.grantee = 'tmpos_app'::regrole and g.privilege_type = 'EXECUTE' and not g.is_grantable);
  if v_bad is not null then
    raise exception 'migration 024 rollback refused: a grant beyond 023''s own remains on 023''s profile read (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if not pg_catalog.has_function_privilege('tmpos_app',
           'tmpos_customer_contact.m7a_contact_profile(text, uuid, uuid)'::regprocedure, 'EXECUTE') then
    raise exception 'migration 024 rollback refused: tmpos_app does not hold EXECUTE on 023''s profile read again'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  select pg_catalog.string_agg(distinct r.rolname::text, ', ') into v_bad
    from pg_catalog.pg_roles r
    join pg_catalog.pg_roles x on pg_catalog.pg_has_role(r.oid, x.oid, 'MEMBER')
   where r.rolname = 'tmpos_app'
     and pg_catalog.has_table_privilege(x.oid, 'tmpos_customer.customer'::regclass,
           'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'
           operator(pg_catalog.||) case when pg_catalog.current_setting('server_version_num')::integer >= 170000
                                        then ', MAINTAIN' else '' end);
  if v_bad is not null then
    raise exception 'migration 024 rollback refused: % holds a privilege on tmpos_customer.customer', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if pg_catalog.to_regprocedure('tmpos_customer_detail.m7a_customer_get(text, uuid, uuid)') is null
     or pg_catalog.to_regprocedure('tmpos_customer_contact.m7a_contact_create(text, uuid, text, text, text)') is null then
    raise exception 'migration 024 rollback refused: migration 022''s read or 023''s create is missing (roll 024 back before 023 and 022)'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$$;

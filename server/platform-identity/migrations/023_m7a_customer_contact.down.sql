-- Phase 4.0 M7a — customer contact records
-- Migration: 023_m7a_customer_contact (DOWN)
--
-- Removes exactly what the up file created — the two routines tmpos_customer_contact.m7a_contact_create and
-- m7a_contact_profile with the grants that ride on them, schema tmpos_customer_contact with its USAGE grant, and the
-- CHECKs customer_phone_chk and customer_email_chk and the columns phone, email and created_at of tmpos_customer.customer
-- — and gives tmpos_app back EXECUTE on 020's tmpos_role.m7a_customer_create, the grant the up file revoked. Issued by the
-- same owner, it is the same ACL item 020 left. Nothing else is touched — not a customer's id, tenant or name, not 017's
-- index or page, not 020's or 022's objects, not a role or a grant issued by 001-022. Rolled back, the database is exactly
-- the 001-022 one.
--
-- IT REFUSES WHILE ANY CUSTOMER HOLDS A PHONE, AN EMAIL OR A CREATION TIME, and drops nothing. Those are customer data:
-- dropping the columns would discard them with no trace, and every customer created since the up file applied has a
-- creation time the database wrote. A rollback is never the way to remove customer data: it refuses, and the data stays,
-- until it is removed or cleared deliberately under whatever retention decision governs it. The table is locked first
-- (ACCESS EXCLUSIVE, which dropping a column takes anyway), so no row can be written between the check and the drop, and
-- the check runs only under READ COMMITTED, where its statement's snapshot is taken after the lock is held (017's
-- reason). It runs with row_security off, so a table whose row security were FORCEd on a non-owner applier makes the
-- rollback fail instead of hiding rows from the check.
--
-- WHAT IT COSTS, STATED. Restoring 020's grant re-opens the name-only create the up file closed to the runtime role, and
-- runtime code built for 023 has no tmpos_customer_contact routine to call: its startup preflight refuses a 022 database.
-- So the runtime rolls back to the P5 build with this file, and no runtime built for 023 serves in between.
--
-- ROLL 023 BACK BEFORE 022, 021 AND 020 (the ledger's newest-first order). Were 020 rolled back first, the grant below has
-- no routine to restore, and this rollback refuses (its guard) until 020 is applied again.
--
-- The applier's search_path is never relied on: every name below is schema-qualified and SET LOCAL pins resolution to
-- pg_catalog until this transaction ends. Revoking before dropping is redundant — a dropped object keeps no ACL — but it is
-- written out so the rollback states the privilege change it makes.

set local search_path = pg_catalog, pg_temp;
set local row_security = off;

-- =============================================================================
-- 1) The guard: no contact and no creation time is ever discarded by a rollback
-- =============================================================================
lock table tmpos_customer.customer in access exclusive mode;

do $$
begin
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'migration 023 rollback refused: it must run under READ COMMITTED, so that its check sees every committed customer row'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- to_regprocedure, never a ::regprocedure literal: a missing routine must refuse here, not fail to parse.
  if pg_catalog.to_regprocedure('tmpos_role.m7a_customer_create(text, uuid, text)') is null then
    raise exception 'migration 023 rollback refused: migration 020''s create is missing, so its grant cannot be given back (roll 023 back before 020)'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if exists (select 1 from tmpos_customer.customer c
              where c.phone is not null or c.email is not null or c.created_at is not null) then
    raise exception 'migration 023 rollback refused: a customer holds a phone, an email or a creation time, and a rollback never discards customer data'
      using errcode = 'object_not_in_prerequisite_state',
            hint = 'removing or clearing that data is a retention decision taken deliberately, not a rollback''s side effect';
  end if;
end
$$;

-- =============================================================================
-- 2) The routines
-- =============================================================================
revoke execute on function tmpos_customer_contact.m7a_contact_create(text, uuid, text, text, text) from tmpos_app;
revoke execute on function tmpos_customer_contact.m7a_contact_profile(text, uuid, uuid) from tmpos_app;
drop function tmpos_customer_contact.m7a_contact_create(text, uuid, text, text, text);
drop function tmpos_customer_contact.m7a_contact_profile(text, uuid, uuid);

-- =============================================================================
-- 3) The schema
-- =============================================================================
-- WITHOUT CASCADE: if anything this file did not create lives in it, the drop fails and the whole rollback with it,
-- rather than taking an unknown object down silently.
revoke usage on schema tmpos_customer_contact from tmpos_app;
drop schema tmpos_customer_contact;

-- =============================================================================
-- 4) The grant the up file revoked
-- =============================================================================
grant execute on function tmpos_role.m7a_customer_create(text, uuid, text) to tmpos_app;

-- =============================================================================
-- 5) The CHECKs and the columns (every value in them is NULL: the guard proved it)
-- =============================================================================
alter table tmpos_customer.customer
  drop constraint customer_email_chk,
  drop constraint customer_phone_chk,
  drop column created_at,
  drop column email,
  drop column phone;

-- =============================================================================
-- 6) Postcondition: this file removed its own objects, restored its one grant, and widened nothing
-- =============================================================================
-- It checks that the schema is gone and the table has exactly 017's columns again; that 020's create carries EXACTLY
-- 020's ACL items again — beyond its owner's, a non-grantable EXECUTE to tmpos_app and nothing else, read through
-- coalesce(acl, acldefault(kind, owner)) as 020's own rollback does — so a grant added to it while 023 was applied refuses
-- the rollback instead of surviving it; that tmpos_app can in fact execute it; that tmpos_app holds no privilege on 017's
-- table by any path; and, by PRESENCE, that 022's read is still there.
do $$
declare
  v_bad text;
begin
  if pg_catalog.to_regnamespace('tmpos_customer_contact') is not null then
    raise exception 'migration 023 rollback refused: schema tmpos_customer_contact still exists'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  select pg_catalog.string_agg(a.attname::text, ', ' order by a.attnum) into v_bad
    from pg_catalog.pg_attribute a
   where a.attrelid = 'tmpos_customer.customer'::regclass
     and a.attnum > 0
     and not a.attisdropped;
  if v_bad is distinct from 'customer_id, tenant_id, name' then
    raise exception 'migration 023 rollback refused: tmpos_customer.customer does not have exactly 017''s columns again (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  select pg_catalog.string_agg(pg_catalog.format('%s:%s', g.grantee::regrole::text, g.privilege_type), ', ')
    into v_bad
    from pg_catalog.pg_proc p,
         pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g
   where p.oid = 'tmpos_role.m7a_customer_create(text, uuid, text)'::regprocedure
     and g.grantee <> p.proowner
     and not (g.grantee = 'tmpos_app'::regrole and g.privilege_type = 'EXECUTE' and not g.is_grantable);
  if v_bad is not null then
    raise exception 'migration 023 rollback refused: a grant beyond 020''s own remains on 020''s create (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if not pg_catalog.has_function_privilege('tmpos_app',
           'tmpos_role.m7a_customer_create(text, uuid, text)'::regprocedure, 'EXECUTE') then
    raise exception 'migration 023 rollback refused: tmpos_app does not hold EXECUTE on 020''s create again'
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
    raise exception 'migration 023 rollback refused: % holds a privilege on tmpos_customer.customer', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if pg_catalog.to_regprocedure('tmpos_customer_detail.m7a_customer_get(text, uuid, uuid)') is null then
    raise exception 'migration 023 rollback refused: migration 022''s read is missing (roll 023 back before 022)'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$$;

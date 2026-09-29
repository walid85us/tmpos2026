-- Phase 4.0 M7a — the tenant customer detail read
-- Migration: 022_m7a_customer_detail (DOWN)
--
-- Removes exactly what the up file created — the routine tmpos_customer_detail.m7a_customer_get with the grant that rides
-- on it, and schema tmpos_customer_detail with its USAGE grant. Nothing else is touched — not 017's customer table or
-- page, not 020's or 021's objects, not a role or a grant issued by 001-021. It holds no data, so there is no data guard:
-- nothing it removes could re-issue anything a client holds. Rolled back, the database is exactly the 001-021 one.
--
-- ROLL 022 BACK BEFORE 021 AND 020 (the ledger's newest-first order). This rollback is independent of 021's fail-closed one:
-- it succeeds whether or not 021's rollback would. Were 020 rolled back first, this routine raises at call (fail closed)
-- and this rollback refuses (its postcondition below) until 020 is applied again — 021's rule.
--
-- The applier's search_path is never relied on: every name below is schema-qualified and SET LOCAL pins resolution to
-- pg_catalog until this transaction ends. Revoking before dropping is redundant — a dropped object keeps no ACL — but it is
-- written out so the rollback states the privilege change it makes.

set local search_path = pg_catalog, pg_temp;

-- =============================================================================
-- 1) The routine
-- =============================================================================
revoke execute on function tmpos_customer_detail.m7a_customer_get(text, uuid, uuid) from tmpos_app;
drop function tmpos_customer_detail.m7a_customer_get(text, uuid, uuid);

-- =============================================================================
-- 2) The schema
-- =============================================================================
-- WITHOUT CASCADE: if anything this file did not create lives in it, the drop fails and the whole rollback with it,
-- rather than taking an unknown object down silently.
revoke usage on schema tmpos_customer_detail from tmpos_app;
drop schema tmpos_customer_detail;

-- =============================================================================
-- 3) Postcondition: this file removed its own objects and widened nothing
-- =============================================================================
-- It checks that the schema is gone; that tmpos_app still executes 020's page_v3, the list's read (by presence and
-- privilege — 020's own rollback owns the rest); and that tmpos_app holds no privilege on 017's customer table by any path.
do $$
declare
  v_bad text;
begin
  if pg_catalog.to_regnamespace('tmpos_customer_detail') is not null then
    raise exception 'migration 022 rollback refused: schema tmpos_customer_detail still exists'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- to_regprocedure, never a ::regprocedure literal: a missing routine must refuse here, not fail to parse.
  if pg_catalog.to_regprocedure('tmpos_role.m7a_customer_page_v3(text, uuid, integer)') is null
     or not pg_catalog.has_function_privilege('tmpos_app',
              pg_catalog.to_regprocedure('tmpos_role.m7a_customer_page_v3(text, uuid, integer)'), 'EXECUTE') then
    raise exception 'migration 022 rollback refused: tmpos_app no longer executes 020''s page_v3 (roll 022 back before 020)'
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
    raise exception 'migration 022 rollback refused: % holds a privilege on tmpos_customer.customer', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$$;

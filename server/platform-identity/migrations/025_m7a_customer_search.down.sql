-- Phase 4.0 M7a — the tenant customer name search
-- Migration: 025_m7a_customer_search (DOWN)
--
-- Removes exactly what the up file created — the routine tmpos_customer_search.m7a_customer_search with the grant that rides
-- on it, and schema tmpos_customer_search with its USAGE grant. Nothing else is touched — not 017's customer table, its
-- index, its rows or its page, not 020's, 022's or 024's objects, not a role or a grant issued by 001-024. It holds no
-- data, so there is no data guard: nothing it removes could re-issue anything a client holds (a filtered continuation names
-- a customer id, which the 001-024 database still holds). Rolled back, the database is exactly the 001-024 one, whatever
-- customers exist or were edited.
--
-- ROLL 025 BACK BEFORE 024, 023, 022, 021 AND 020 (the ledger's newest-first order). Were 020 rolled back first, this
-- routine raises at call (fail closed) and this rollback refuses (its postcondition below) until 020 is applied again —
-- 022's rule; were 024 rolled back first, this rollback refuses the same way until 024 is applied again.
--
-- The applier's search_path is never relied on: every name below is schema-qualified and SET LOCAL pins resolution to
-- pg_catalog until this transaction ends. Revoking before dropping is redundant — a dropped object keeps no ACL — but it is
-- written out so the rollback states the privilege change it makes.

set local search_path = pg_catalog, pg_temp;

-- =============================================================================
-- 1) The guard: what this file removes must all be there
-- =============================================================================
-- A second run after a completed rollback (or a partial state) refuses with a stated reason instead of failing on a
-- missing object below (024's form).
do $$
begin
  if pg_catalog.to_regnamespace('tmpos_customer_search') is null
     or pg_catalog.to_regprocedure('tmpos_customer_search.m7a_customer_search(text, uuid, text, uuid, integer)') is null then
    raise exception 'migration 025 rollback refused: migration 025 is not applied (schema tmpos_customer_search or its routine is missing)'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$$;

-- =============================================================================
-- 2) The routine
-- =============================================================================
revoke execute on function tmpos_customer_search.m7a_customer_search(text, uuid, text, uuid, integer) from tmpos_app;
drop function tmpos_customer_search.m7a_customer_search(text, uuid, text, uuid, integer);

-- =============================================================================
-- 3) The schema
-- =============================================================================
-- WITHOUT CASCADE: if anything this file did not create lives in it, the drop fails and the whole rollback with it,
-- rather than taking an unknown object down silently.
revoke usage on schema tmpos_customer_search from tmpos_app;
drop schema tmpos_customer_search;

-- =============================================================================
-- 4) Postcondition: this file removed its own objects and widened nothing — the 001-024 reads stand
-- =============================================================================
-- It checks that the schema is gone; that tmpos_app still executes the 001-024 database's customer reads and edit —
-- 020's page_v3 (the list), 022's read (the detail) and 024's profile read and edit — by presence and privilege (their
-- own rollbacks own the rest); and that tmpos_app holds no privilege on 017's customer table or any of its columns by any
-- path, and no column of it carries a grant.
do $$
declare
  v_bad text;
begin
  if pg_catalog.to_regnamespace('tmpos_customer_search') is not null then
    raise exception 'migration 025 rollback refused: schema tmpos_customer_search still exists'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- to_regprocedure, never a ::regprocedure literal: a missing routine must refuse here, not fail to parse.
  select pg_catalog.string_agg(r.routine, ', ') into v_bad
    from pg_catalog.unnest(array[
           'tmpos_role.m7a_customer_page_v3(text, uuid, integer)',
           'tmpos_customer_detail.m7a_customer_get(text, uuid, uuid)',
           'tmpos_customer_edit.m7a_customer_profile(text, uuid, uuid)',
           'tmpos_customer_edit.m7a_customer_update(text, uuid, uuid, bigint, text, boolean, text, boolean, text)']) as r(routine)
   where pg_catalog.to_regprocedure(r.routine) is null
      or not pg_catalog.has_function_privilege('tmpos_app', pg_catalog.to_regprocedure(r.routine), 'EXECUTE');
  if v_bad is not null then
    raise exception 'migration 025 rollback refused: tmpos_app no longer executes a 001-024 customer routine (%) (roll 025 back before 024, 022 and 020)', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  select pg_catalog.string_agg(distinct r.rolname::text, ', ') into v_bad
    from pg_catalog.pg_roles r
    join pg_catalog.pg_roles x on pg_catalog.pg_has_role(r.oid, x.oid, 'MEMBER')
   where r.rolname = 'tmpos_app'
     and (pg_catalog.has_table_privilege(x.oid, 'tmpos_customer.customer'::regclass,
            'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'
            operator(pg_catalog.||) case when pg_catalog.current_setting('server_version_num')::integer >= 170000
                                         then ', MAINTAIN' else '' end)
          or pg_catalog.has_any_column_privilege(x.oid, 'tmpos_customer.customer'::regclass, 'SELECT, INSERT, UPDATE, REFERENCES'));
  if v_bad is not null then
    raise exception 'migration 025 rollback refused: % holds a privilege on tmpos_customer.customer', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if exists (select 1 from pg_catalog.pg_attribute a
              where a.attrelid = 'tmpos_customer.customer'::regclass and a.attacl is not null) then
    raise exception 'migration 025 rollback refused: a column grant exists on tmpos_customer.customer'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$$;

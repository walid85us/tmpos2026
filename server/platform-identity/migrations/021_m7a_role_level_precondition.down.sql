-- Phase 4.0 M7a — the owner's Customers level edit, conditional on the tenant and version reviewed
-- Migration: 021_m7a_role_level_precondition (DOWN)
--
-- Removes exactly what the up file created — the trigger trg_tenant_role_level_version_advance on 020's table, the three
-- routines with the grants that ride on them, the table tmpos_role_edit.role_level_version, and schema tmpos_role_edit.
-- Nothing else is touched — not 020's schema, routines or table beyond that trigger, not a level, not a role or a grant
-- issued by 001-020. Rolled back, an update of a level moves no version: there is none to move.
--
-- IT REFUSES WHILE ANY VERSION ROW EXISTS. Once a version has been issued, rolling back and re-applying would restart the
-- counter at 0, and a draft still holding a version issued before could then succeed against a different level (ABA). The
-- remedy is a deliberate delete of those rows by the table's owner, who thereby accepts that risk for every draft still
-- open. 020's table and then the version table are locked first (ACCESS EXCLUSIVE, which the DROP TRIGGER and the DROP
-- take anyway) — in the order every writer takes them, the level row before the version row — so no level can be updated
-- and no version written between the check and the drops, and the check runs only under READ COMMITTED, where its
-- statement's snapshot is taken after the locks are held (017's reason). It runs with row_security off, so a table whose
-- row security were FORCEd on a non-owner applier makes the rollback fail instead of hiding rows from the check.
--
-- IT DOES NOT GIVE BACK tmpos_app's EXECUTE ON 020's tmpos_role.m7a_role_level_set, which the up file revoked. Rolled back,
-- the runtime role cannot edit a level at all: no unversioned, tenant-unasserted edit (DA-125) can happen while this file
-- is rolled back, and a later re-apply's version 0 still means "not edited since 021". The cost, stated: the pre-021
-- runtime's startup preflight approves exactly 020's grants, that EXECUTE included, so it refuses to start until an
-- operator deliberately grants it again — which reopens DA-125 (the up file's DEPLOY note). Customer creates and reads,
-- and the levels every decision reads, are unaffected: 020 stays applied and tmpos_app keeps its other three EXECUTEs.
--
-- ROLL 021 BACK BEFORE 020. 020's rollback run first succeeds (no dependency is recorded), this file's routines then raise
-- on the missing objects, and this file's rollback refuses until 020 is applied again.
--
-- The applier's search_path is never relied on: every name below is schema-qualified and SET LOCAL pins resolution to
-- pg_catalog until this transaction ends. Revoking before dropping is redundant — a dropped object keeps no ACL — but it
-- is written out so the rollback states the privilege change it makes.

set local search_path = pg_catalog, pg_temp;
set local row_security = off;

-- =============================================================================
-- 1) The guard: an issued version is never discarded by a rollback
-- =============================================================================
lock table tmpos_role.tenant_role_level in access exclusive mode;
lock table tmpos_role_edit.role_level_version in access exclusive mode;

do $$
begin
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'migration 021 rollback refused: it must run under READ COMMITTED, so that its check sees every committed version'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if exists (select 1 from tmpos_role_edit.role_level_version) then
    raise exception 'migration 021 rollback refused: a role-level version has been issued'
      using errcode = 'object_not_in_prerequisite_state',
            hint = 'the table owner deletes the version rows deliberately, accepting that a re-apply may re-issue a version an open draft holds, then rolls back';
  end if;
end
$$;

-- =============================================================================
-- 2) The trigger (before its function) and the routines
-- =============================================================================
drop trigger trg_tenant_role_level_version_advance on tmpos_role.tenant_role_level;
revoke execute on function tmpos_role_edit.m7a_role_level_states(uuid) from tmpos_app;
revoke execute on function tmpos_role_edit.m7a_role_level_set_v2(text, text, text, text, uuid, bigint) from tmpos_app;
drop function tmpos_role_edit.m7a_role_level_states(uuid);
drop function tmpos_role_edit.m7a_role_level_set_v2(text, text, text, text, uuid, bigint);
drop function tmpos_role_edit.m7a_role_level_version_advance();

-- =============================================================================
-- 3) The table (its primary-key index goes with it)
-- =============================================================================
drop table tmpos_role_edit.role_level_version;

-- =============================================================================
-- 4) The schema
-- =============================================================================
-- WITHOUT CASCADE: if anything this file did not create lives in it, the drop fails and the whole rollback with it,
-- rather than taking an unknown object down silently.
revoke usage on schema tmpos_role_edit from tmpos_app;
drop schema tmpos_role_edit;

-- =============================================================================
-- 5) Postcondition: this file removed its own objects and gave nothing back
-- =============================================================================
-- It checks that the schema this file created is gone (the trigger went before its function, whose drop would otherwise
-- have failed); that no runtime role (tmpos_app included) can execute 020's unconditional edit by any path; and, by
-- PRESENCE, that 020's objects are still there. 020's own rollback owns the rest.
do $$
declare
  v_bad text;
begin
  if pg_catalog.to_regnamespace('tmpos_role_edit') is not null then
    raise exception 'migration 021 rollback refused: schema tmpos_role_edit still exists'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if pg_catalog.to_regclass('tmpos_role.tenant_role_level') is null
     or pg_catalog.to_regprocedure('tmpos_role.m7a_role_levels(uuid, text)') is null
     or pg_catalog.to_regprocedure('tmpos_role.m7a_role_level_set(text, text, text, text)') is null
     or pg_catalog.to_regprocedure('tmpos_role.m7a_customer_create(text, uuid, text)') is null
     or pg_catalog.to_regprocedure('tmpos_role.m7a_customer_page_v3(text, uuid, integer)') is null then
    raise exception 'migration 021 rollback refused: it removed something migration 020 owns (roll 021 back before 020)'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  select pg_catalog.string_agg(distinct r.rolname::text, ', ') into v_bad
    from pg_catalog.pg_roles r
    join pg_catalog.pg_roles x on pg_catalog.pg_has_role(r.oid, x.oid, 'MEMBER')
   where r.rolname = any (array['tmpos_app', 'tmpos_audit_writer', 'anon', 'authenticated']::name[])
     and pg_catalog.has_function_privilege(x.oid,
           'tmpos_role.m7a_role_level_set(text, text, text, text)'::regprocedure, 'EXECUTE');
  if v_bad is not null then
    raise exception 'migration 021 rollback refused: % can execute 020''s unconditional edit tmpos_role.m7a_role_level_set', v_bad
      using errcode = 'object_not_in_prerequisite_state',
            hint = 'the rollback leaves role editing disabled for the runtime; granting that EXECUTE back is a deliberate operator step';
  end if;
end
$$;

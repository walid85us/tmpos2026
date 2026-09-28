-- Phase 4.0 M7a — owner-edited Customers levels
-- Migration: 020_m7a_tenant_role_levels (DOWN)
--
-- Removes exactly what the up file created — the four routines with the grants that ride on them, the table
-- tmpos_role.tenant_role_level, and schema tmpos_role — and gives tmpos_app back the three grants the up file revoked:
-- EXECUTE on 019's tmpos_customer_write.m7a_customer_create, USAGE on schema tmpos_customer_write, and EXECUTE on 018's
-- tmpos_mint.m7a_customer_page_v2. Issued by the same owner, they are the same ACL items 018 and 019 left. Nothing else is
-- touched — not a customer, not 016's, 017's, 018's or 019's objects, not a table, a role or a grant issued by 001-019.
--
-- IT REFUSES WHILE ANY STORED LEVEL DIFFERS FROM ITS ROLE'S CATALOG DEFAULT (manager full, technician view, sales_staff
-- create). The rollback restores 019's and 018's name-based answers, which ARE those defaults: rolled back over a level an
-- owner narrowed, it would silently re-widen that role. A NULL level, or one equal to its default, decides exactly as the
-- restored routines do, so those rows are dropped with the table. The remedy is the owner's, through the product, and it
-- needs the 020 runtime: set each edited role back to its default while that runtime still serves, then roll back. The table is locked first (ACCESS EXCLUSIVE, which the DROP takes
-- anyway), so no level can be written between the check and the drop, and the check runs only under READ COMMITTED, where
-- its statement's snapshot is taken after the lock is held (017's and 018's reason). It runs with row_security off, so a
-- table whose row security were FORCEd on a non-owner applier makes the rollback fail instead of hiding rows from the
-- check. The defaults are restated here as in the up file's routines, and pinned by the same parity test.
--
-- WHAT IT COSTS, STATED. Restoring the three grants re-opens exactly what the up file closed: 019's create and 018's read
-- decide from the role name again, so an owner's future edit is not enforced. Runtime code built for 020 has no
-- tmpos_role routine to call, and its startup preflight refuses. So, in this order (the up file's deploy note): the owner
-- resets every edited role to its default while the 020 runtime still serves, and the check below is confirmed to find no
-- non-default level; the runtime rolls back to the P3 build; then this file runs, with its ledger row. In no order does
-- this file silently re-widen a narrowed role, since the check below refuses until every level is its default (the
-- owner's reset widens deliberately, through the audited route); but a runtime rolled back before the owner's
-- reset cannot start (the P3 build refuses a 020 database) until the 020 runtime is rolled forward again; the owner then
-- resets the levels through it, and the order above is followed.
--
-- ROLL 020 BACK FIRST. Its grants restore objects 018 and 019 own: rolled back out of order (016-019 while 020 is applied,
-- which the database does not prevent), this file refuses until those migrations are applied again.
--
-- The applier's search_path is never relied on: every name below is schema-qualified and SET LOCAL pins resolution to
-- pg_catalog until this transaction ends. Revoking before dropping is redundant — a dropped object keeps no ACL — but it
-- is written out so the rollback states the privilege change it makes.

set local search_path = pg_catalog, pg_temp;
set local row_security = off;

-- =============================================================================
-- 1) The guard: a narrowed or widened level is never discarded by a rollback
-- =============================================================================
lock table tmpos_role.tenant_role_level in access exclusive mode;

do $$
begin
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'migration 020 rollback refused: it must run under READ COMMITTED, so that its check sees every committed level'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if exists (select 1 from tmpos_role.tenant_role_level l
              where l.level is not null
                and l.level is distinct from
                    case l.role_id when 'manager' then 'full' when 'technician' then 'view' when 'sales_staff' then 'create' end) then
    raise exception 'migration 020 rollback refused: a stored Customers level differs from its role''s catalog default'
      using errcode = 'object_not_in_prerequisite_state',
            hint = 'the owner sets each edited role back to its default, then rolls back';
  end if;
end
$$;

-- =============================================================================
-- 2) The routines
-- =============================================================================
revoke execute on function tmpos_role.m7a_role_levels(uuid, text) from tmpos_app;
revoke execute on function tmpos_role.m7a_role_level_set(text, text, text, text) from tmpos_app;
revoke execute on function tmpos_role.m7a_customer_create(text, uuid, text) from tmpos_app;
revoke execute on function tmpos_role.m7a_customer_page_v3(text, uuid, integer) from tmpos_app;
drop function tmpos_role.m7a_role_levels(uuid, text);
drop function tmpos_role.m7a_role_level_set(text, text, text, text);
drop function tmpos_role.m7a_customer_create(text, uuid, text);
drop function tmpos_role.m7a_customer_page_v3(text, uuid, integer);

-- =============================================================================
-- 3) The table (its primary-key index goes with it)
-- =============================================================================
drop table tmpos_role.tenant_role_level;

-- =============================================================================
-- 4) The schema
-- =============================================================================
-- WITHOUT CASCADE: if anything this file did not create lives in it, the drop fails and the whole rollback with it,
-- rather than taking an unknown object down silently.
revoke usage on schema tmpos_role from tmpos_app;
drop schema tmpos_role;

-- =============================================================================
-- 5) The three grants the up file revoked
-- =============================================================================
grant usage on schema tmpos_customer_write to tmpos_app;
grant execute on function tmpos_customer_write.m7a_customer_create(text, uuid, text) to tmpos_app;
grant execute on function tmpos_mint.m7a_customer_page_v2(text, uuid, integer) to tmpos_app;

-- =============================================================================
-- 6) Postcondition: this file removed its own objects, restored its three grants, and nothing else
-- =============================================================================
-- It checks that the schema this file created is gone; that the three objects whose grants it restored carry EXACTLY
-- 019's and 018's ACL items again — beyond their owner's, a non-grantable EXECUTE (or USAGE) to tmpos_app and nothing
-- else, read through coalesce(acl, acldefault(kind, owner)) as 019 does — so a grant added to one while 020 was applied
-- (to PUBLIC, another role, or with grant option) refuses the rollback instead of surviving it; that tmpos_app can in
-- fact reach them (USAGE on schema tmpos_mint included); and, by PRESENCE, that the objects migrations 016-019 own are
-- still there. Each of those migrations' own rollback owns the rest.
do $$
declare
  v_bad text;
begin
  if pg_catalog.to_regnamespace('tmpos_role') is not null then
    raise exception 'migration 020 rollback refused: schema tmpos_role still exists'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  select pg_catalog.string_agg(pg_catalog.format('%s %s:%s', x.what, g.grantee::regrole::text, g.privilege_type), ', ')
    into v_bad
    from (select 'create' as what, p.proacl as acl, pg_catalog.acldefault('f', p.proowner) as dflt, p.proowner as owner,
                 'EXECUTE' as privilege
            from pg_catalog.pg_proc p where p.oid = 'tmpos_customer_write.m7a_customer_create(text, uuid, text)'::regprocedure
          union all
          select 'page_v2', p.proacl, pg_catalog.acldefault('f', p.proowner), p.proowner, 'EXECUTE'
            from pg_catalog.pg_proc p where p.oid = 'tmpos_mint.m7a_customer_page_v2(text, uuid, integer)'::regprocedure
          union all
          select 'schema', n.nspacl, pg_catalog.acldefault('n', n.nspowner), n.nspowner, 'USAGE'
            from pg_catalog.pg_namespace n where n.oid = 'tmpos_customer_write'::regnamespace) x,
         pg_catalog.aclexplode(coalesce(x.acl, x.dflt)) g
   where g.grantee <> x.owner
     and not (g.grantee = 'tmpos_app'::regrole and g.privilege_type = x.privilege and not g.is_grantable);
  if v_bad is not null then
    raise exception 'migration 020 rollback refused: a grant beyond 019''s and 018''s own remains on 019''s create, its schema or 018''s page_v2 (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if not pg_catalog.has_function_privilege('tmpos_app',
           'tmpos_customer_write.m7a_customer_create(text, uuid, text)'::regprocedure, 'EXECUTE')
     or not pg_catalog.has_schema_privilege('tmpos_app', 'tmpos_customer_write'::regnamespace, 'USAGE')
     or not pg_catalog.has_function_privilege('tmpos_app',
           'tmpos_mint.m7a_customer_page_v2(text, uuid, integer)'::regprocedure, 'EXECUTE')
     or not pg_catalog.has_schema_privilege('tmpos_app', 'tmpos_mint'::regnamespace, 'USAGE') then
    raise exception 'migration 020 rollback refused: tmpos_app does not hold EXECUTE on 019''s create and 018''s page_v2 and USAGE on schemas tmpos_customer_write and tmpos_mint again'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if pg_catalog.to_regclass('tmpos_customer.customer') is null
     or pg_catalog.to_regprocedure('tmpos_customer.m7a_customer_page(uuid, text, uuid, text, uuid, uuid, integer)') is null
     or pg_catalog.to_regclass('tmpos_mint.tenant_session') is null
     or pg_catalog.to_regclass('tmpos_mint.issuer_key') is null
     or pg_catalog.to_regprocedure('tmpos_session.m5_admit_tenant_session_v2(text, text)') is null
     or pg_catalog.to_regprocedure('tmpos_session.m5_hold_tenant_standing(text, text)') is null
     or pg_catalog.to_regclass('tmpos_session.session') is null then
    raise exception 'migration 020 rollback refused: it removed something migrations 016-019 own (roll 020 back before them)'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$$;

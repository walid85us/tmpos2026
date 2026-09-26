-- Phase 4.0 M5 — tenant session ordering
-- Migration: 016_m5_tenant_session_ordering (DOWN)
--
-- Removes exactly what the up file created, in reverse order: the five version triggers (two on public.tenant, two on
-- public.store, one on public.user_membership), the hold and the v2 admission read with the grants that ride on them, the
-- two trigger functions, the tenant grant version table, and public.store.access_version. Nothing else is touched — not
-- 011's schema tmpos_session, its session table, its six routines or the EXECUTE tmpos_app holds on its admission read
-- (which serves again once this file is gone), not 010's tenant access version, not 013's or 015's objects, not a row,
-- a role or a grant issued by 001-015.
--
-- IT REFUSES WHILE ANY TENANT SESSION EXISTS, 013's rule for its own audience. The grant version table and the store
-- column are what make a tenant witness non-repeating: dropping them and applying 016 again restarts every store version
-- at one and every grant version at zero, so an old witness could be met again and a session idle across the rollback
-- would be admitted again on its old cookie. The only place a witness lives is a tenant session row (011's
-- tmpos_session.session, audience 'tenant'), so the rollback is safe exactly when there is none. The remedy is not to
-- force this file: it is to end those sessions through the boundary that owns them (each one's logout, or
-- m5_session_revoke_principal) and clear what remains, then roll back. Administrative sessions carry no tenant witness
-- and do not block it. The up file refuses to apply again while a tenant session exists, so a login that read its
-- witness before this lock was taken cannot carry it across the gap either.
--
-- WHAT THE ROLLBACK COSTS EVEN WHEN IT PROCEEDS. Afterwards the tenant boundary's adapter has no v2 read and no hold to
-- call, so every tenant login and protected tenant request is an outage (a bounded 503 that revokes nothing) until 016
-- is applied again; tenant and store status and key writes move no store version and, outside 010's command, no tenant
-- version, and a tenant or store delete moves no grant version. The administrative plane is unaffected.
--
-- The applier's search_path is never relied on: every name below is schema-qualified and SET LOCAL pins resolution to
-- pg_catalog until this transaction ends. Revoking before dropping is redundant — a dropped object keeps no ACL — but it
-- is written out so the rollback states the privilege change it makes.

set local search_path = pg_catalog, pg_temp;

-- =============================================================================
-- 1) Refuse while any tenant session exists
-- =============================================================================
do $$
declare
  v_live bigint;
begin
  if pg_catalog.to_regprocedure('tmpos_session.m5_hold_tenant_standing(text, text)') is null then
    -- Nothing was applied, or it is already rolled back. It does NOT make this file re-runnable: the first statement of
    -- section 2 fails because its trigger is gone, and the whole file with it, having changed nothing.
    return;
  end if;

  -- THE LOCK IS PART OF THE CHECK, as in 011's and 013's rollbacks: a bare count would not stop a tenant login
  -- committing a new session between the count and the drops below. This mode blocks writes to the session table (and
  -- so every login and logout, of either audience) until this transaction ends, and lets reads through. The drops below
  -- then lock the three tables, the opposite of a login's order, as in the up file: a login already holding its standing
  -- can deadlock with this rollback, and PostgreSQL aborts one side, which commits nothing.
  lock table tmpos_session.session in share row exclusive mode;

  select pg_catalog.count(*) into v_live from tmpos_session.session s where s.audience = 'tenant';

  if v_live > 0 then
    raise exception 'migration 016 rollback refused: % tenant session row(s) remain, and their witnesses could be met again once the versions restart', v_live
      using errcode = 'object_not_in_prerequisite_state',
            hint = 'end them through the session boundary (logout, or tmpos_session.m5_session_revoke_principal), clear any rows that remain, then roll back';
  end if;
end
$$;

-- =============================================================================
-- 2) The triggers, then the routines
-- =============================================================================
drop trigger trg_store_tenant_grant_version on public.store;
drop trigger trg_tenant_tenant_grant_version on public.tenant;
drop trigger trg_user_membership_tenant_grant_version on public.user_membership;
drop trigger trg_store_access_version on public.store;
drop trigger trg_tenant_access_version on public.tenant;

revoke execute on function tmpos_session.m5_hold_tenant_standing(text, text) from tmpos_app;
revoke execute on function tmpos_session.m5_admit_tenant_session_v2(text, text) from tmpos_app;
drop function tmpos_session.m5_hold_tenant_standing(text, text);
drop function tmpos_session.m5_admit_tenant_session_v2(text, text);
drop function tmpos_session.m5_tenant_grant_moved();
drop function tmpos_session.m5_access_version_moved();

-- =============================================================================
-- 3) The table, then the column
-- =============================================================================
drop table tmpos_session.tenant_grant_version;

-- Its CHECK constraint goes with the column.
alter table public.store drop column access_version;

-- =============================================================================
-- 4) Postcondition: this file removed its own objects and nothing else
-- =============================================================================
-- It checks PRESENCE, not definition: that what this file created is gone, and that the objects migrations 010-015 own
-- beside it are still there — 011's admission read still granted to tmpos_app among them. Each of those migrations' own
-- rollback owns the rest.
do $$
begin
  if pg_catalog.to_regprocedure('tmpos_session.m5_hold_tenant_standing(text, text)') is not null
     or pg_catalog.to_regprocedure('tmpos_session.m5_admit_tenant_session_v2(text, text)') is not null
     or pg_catalog.to_regprocedure('tmpos_session.m5_tenant_grant_moved()') is not null
     or pg_catalog.to_regprocedure('tmpos_session.m5_access_version_moved()') is not null
     or pg_catalog.to_regclass('tmpos_session.tenant_grant_version') is not null
     or exists (select 1 from pg_catalog.pg_attribute a
                 where a.attrelid = 'public.store'::regclass and a.attname = 'access_version' and not a.attisdropped)
     or exists (select 1 from pg_catalog.pg_trigger g
                 where g.tgname in ('trg_tenant_access_version', 'trg_store_access_version',
                                    'trg_user_membership_tenant_grant_version', 'trg_tenant_tenant_grant_version',
                                    'trg_store_tenant_grant_version')
                   and g.tgrelid in ('public.tenant'::regclass, 'public.store'::regclass,
                                     'public.user_membership'::regclass)) then
    raise exception 'migration 016 rollback refused: one of its routines, its table, its column or its triggers still exists'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if pg_catalog.to_regclass('tmpos_session.session') is null
     or not pg_catalog.has_function_privilege('tmpos_app', 'tmpos_session.m5_admit_tenant_session(text, text)', 'EXECUTE')
     or (select pg_catalog.count(*) from pg_catalog.pg_proc p where p.pronamespace = 'tmpos_session'::regnamespace) <> 6
     or exists (
       select 1
         from pg_catalog.unnest(array[
                'tmpos_session.m5_session_create(text, text, text, text, text, text, bigint, bigint, bigint, bigint, bigint)',
                'tmpos_session.m5_session_get(text, bigint)', 'tmpos_session.m5_session_touch(text, text, bigint)',
                'tmpos_session.m5_session_revoke(text)', 'tmpos_session.m5_session_revoke_principal(text, text)',
                'tmpos_session.m5_admit_tenant_session(text, text)']) as s(signature)
        where pg_catalog.to_regprocedure(s.signature) is null)
     or not exists (select 1 from pg_catalog.pg_attribute a
                     where a.attrelid = 'public.tenant'::regclass and a.attname = 'access_version' and not a.attisdropped)
     or pg_catalog.to_regclass('tmpos_admission.platform_authority_version') is null
     or pg_catalog.to_regprocedure('tmpos_admission.m5_platform_standing_serialize()') is null then
    raise exception 'migration 016 rollback refused: it removed something migrations 010-015 own'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$$;

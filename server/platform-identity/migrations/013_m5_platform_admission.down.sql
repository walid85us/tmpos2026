-- Phase 4.0 M5 — durable platform-administrator admission
-- Migration: 013_m5_platform_admission (DOWN)
--
-- Removes exactly what the up file created: the four version triggers (on public.platform_identity,
-- public.app_user, public.identity_link and public.user_membership), the trigger function, the admission read
-- with the grant that rides on it, the platform authority version table, and the schema tmpos_admission that
-- held them. Nothing else is touched — not migration 012's tmpos_directory, not 011's
-- tmpos_session or any session row, not 007's tmpos_identity, not a table, a role or a grant issued by 001-012.
--
-- IT REFUSES WHILE ANY ADMINISTRATIVE SESSION EXISTS. The version table is what makes an administrative
-- witness non-repeating: dropping it and applying 013 again restarts every counter at zero, so an old witness
-- could be met again and a session idle across the rollback would be admitted again on its old cookie. The
-- only place a witness lives is an administrative session row (011's tmpos_session.session, audience 'admin'),
-- so the rollback is safe exactly when there is none. The remedy is not to force this file: it is to end those
-- sessions through the boundary that owns them (each one's logout, or m5_session_revoke_principal) and clear
-- what remains, then roll back. Tenant sessions carry no platform witness and do not block it. A login that
-- read its witness before this lock was taken can still commit its session row after this file commits; the
-- up file refuses to apply again while such a row exists, so that session cannot outlive the gap.
--
-- WHAT THE ROLLBACK COSTS EVEN WHEN IT PROCEEDS. Afterwards the administrative boundary's admission adapter has
-- no routine to call, so every administrative login and protected request is an outage (a bounded 503 that
-- revokes nothing) until 013 is applied again. The tenant plane is unaffected.
--
-- The applier's search_path is never relied on: every name below is schema-qualified and SET LOCAL pins
-- resolution to pg_catalog until this transaction ends. Revoking before dropping is redundant — a dropped
-- object keeps no ACL — but it is written out so the rollback states the privilege change it makes.

set local search_path = pg_catalog, pg_temp;

-- =============================================================================
-- 1) Refuse while any administrative session exists
-- =============================================================================
do $$
declare
  v_live bigint;
begin
  if pg_catalog.to_regnamespace('tmpos_admission') is null then
    -- Nothing was applied, or it is already rolled back. It does NOT make this file re-runnable: the first
    -- statement of section 2 fails because its triggers are gone, and the whole file with it, having changed
    -- nothing.
    return;
  end if;

  -- THE LOCK IS PART OF THE CHECK, as in 011's rollback: a bare count would not stop an administrative login
  -- committing a new session between the count and the drop below. This mode blocks writes to the session
  -- table (and so every login, of either audience) until this transaction ends, and lets reads through.
  lock table tmpos_session.session in share row exclusive mode;

  select pg_catalog.count(*) into v_live from tmpos_session.session s where s.audience = 'admin';

  if v_live > 0 then
    raise exception 'migration 013 rollback refused: % administrative session row(s) remain, and their witnesses could be met again once the version table is recreated', v_live
      using errcode = 'object_not_in_prerequisite_state',
            hint = 'end them through the session boundary (logout, or tmpos_session.m5_session_revoke_principal), clear any rows that remain, then roll back';
  end if;
end
$$;

-- =============================================================================
-- 2) The triggers, then the routines
-- =============================================================================
drop trigger trg_platform_identity_platform_authority on public.platform_identity;
drop trigger trg_app_user_platform_authority on public.app_user;
drop trigger trg_identity_link_platform_authority on public.identity_link;
drop trigger trg_user_membership_platform_authority on public.user_membership;

revoke execute on function tmpos_admission.m5_admit_platform_session(text, text) from tmpos_app;
drop function tmpos_admission.m5_admit_platform_session(text, text);
drop function tmpos_admission.m5_platform_authority_moved();

-- =============================================================================
-- 3) The table, then the schema
-- =============================================================================
drop table tmpos_admission.platform_authority_version;

-- WITHOUT CASCADE: if anything this file did not create lives in it, the drop fails and the whole rollback
-- with it, rather than taking an unknown object down silently.
revoke usage on schema tmpos_admission from tmpos_app;
drop schema tmpos_admission;

-- =============================================================================
-- 4) Postcondition: this file removed its own objects and nothing else
-- =============================================================================
-- It checks PRESENCE, not definition: that what this file created is gone, and that the objects migrations
-- 007-012 own are still there. Each of those migrations' own rollback owns the rest.
do $$
begin
  if pg_catalog.to_regnamespace('tmpos_admission') is not null
     or exists (select 1 from pg_catalog.pg_trigger g
                 where g.tgname in ('trg_platform_identity_platform_authority', 'trg_app_user_platform_authority',
                                    'trg_identity_link_platform_authority', 'trg_user_membership_platform_authority')
                   and g.tgrelid in ('public.platform_identity'::regclass, 'public.app_user'::regclass,
                                     'public.identity_link'::regclass, 'public.user_membership'::regclass)) then
    raise exception 'migration 013 rollback refused: schema tmpos_admission or one of its triggers still exists'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if pg_catalog.to_regprocedure('tmpos_directory.m5_tenant_directory_page(uuid, text, uuid, text, uuid, integer)') is null
     or pg_catalog.to_regprocedure('tmpos_session.m5_admit_tenant_session(text, text)') is null
     or pg_catalog.to_regclass('tmpos_session.session') is null
     or pg_catalog.to_regprocedure('tmpos_identity.m5_resolve_principal(text, text)') is null then
    raise exception 'migration 013 rollback refused: it removed something migrations 007-012 own'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$$;

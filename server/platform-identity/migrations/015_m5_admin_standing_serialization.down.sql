-- Phase 4.0 M5 — changer-side standing serialization
-- Migration: 015_m5_admin_standing_serialization (DOWN)
--
-- Removes exactly what the up file created: the three serialization triggers (on public.platform_identity,
-- public.identity_link and public.user_membership) and their trigger function. Nothing else is touched — not migration
-- 014's tmpos_rate_limit, not 013's schema tmpos_admission, version table, version triggers or admission read, not a
-- table, a row, a role or a grant issued by 001-014.
--
-- IT NEEDS NO GUARD. Removing the serialization admits no session and repeats no witness: 013 still moves the platform
-- authority version on every anchor, link and platform-grant write, so the next request of an affected session is
-- refused by it. What returns is the window the up file closed — a command or login already under way may commit once
-- more after an anchor was repointed or deleted, or a link or grant inserted for (or re-pointed to) its actor, and a
-- replica-mode grant insert or anchor delete no longer waits at all — exactly as before 015.
--
-- Dropping a trigger locks its table ACCESS EXCLUSIVE until this transaction ends, so a changer in flight finishes first
-- and none starts until the rollback commits. On a store where 015 is absent the first DROP fails, and the whole file with
-- it, having changed nothing.
--
-- The applier's search_path is never relied on: every name below is schema-qualified and SET LOCAL pins resolution to
-- pg_catalog until this transaction ends. The function carries no grant, so there is nothing to revoke first.

set local search_path = pg_catalog, pg_temp;

-- =============================================================================
-- 1) The triggers, then the function
-- =============================================================================
drop trigger trg_platform_identity_standing_serialize on public.platform_identity;
drop trigger trg_identity_link_standing_serialize on public.identity_link;
drop trigger trg_user_membership_standing_serialize on public.user_membership;
drop function tmpos_admission.m5_platform_standing_serialize();

-- =============================================================================
-- 2) Postcondition: this file removed its own objects and nothing else
-- =============================================================================
-- It checks PRESENCE, not definition: that what this file created is gone, and that the objects 009, 013 and 014 own
-- beside it are still there. Each of those migrations' own rollback owns the rest.
do $$
begin
  if pg_catalog.to_regprocedure('tmpos_admission.m5_platform_standing_serialize()') is not null
     or exists (select 1 from pg_catalog.pg_trigger g
                 where g.tgname in ('trg_platform_identity_standing_serialize', 'trg_identity_link_standing_serialize',
                                    'trg_user_membership_standing_serialize')
                   and g.tgrelid in ('public.platform_identity'::regclass, 'public.identity_link'::regclass,
                                     'public.user_membership'::regclass)) then
    raise exception 'migration 015 rollback refused: the serialization function or one of its triggers still exists'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if pg_catalog.to_regprocedure('tmpos_admission.m5_platform_authority_moved()') is null
     or pg_catalog.to_regprocedure('tmpos_admission.m5_admit_platform_session(text, text)') is null
     or (select pg_catalog.count(*) from pg_catalog.pg_trigger g
          where g.tgfoid = 'tmpos_admission.m5_platform_authority_moved()'::regprocedure) <> 4
     or pg_catalog.to_regprocedure('tmpos_command.m5_revalidate_platform_authority(uuid, text, uuid, text)') is null
     or pg_catalog.to_regprocedure('tmpos_rate_limit.m6_rate_limit_reclaim()') is null then
    raise exception 'migration 015 rollback refused: it removed something migrations 009-014 own'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$$;

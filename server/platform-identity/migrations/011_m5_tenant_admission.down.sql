-- Phase 4.0 M5 — the tenant admission boundary
-- Migration: 011_m5_tenant_admission (DOWN)
--
-- Removes exactly what the up file created: the six routines with the grants that ride on them, the
-- session table and its index, and the schema tmpos_session that held them. Nothing else is touched —
-- not migration 010's access version or its lifecycle routine, not 007's schema tmpos_identity, not
-- 006's tmpos_internal, not a table, a role or a grant issued by 001-010.
--
-- IT REFUSES WHILE THE TABLE HOLDS ANY ROW AT ALL. This file destroys durable state:
-- tmpos_session.session is the only record of who is signed in, and dropping it signs everyone out at
-- once, silently, with no way to tell afterwards how many sessions were ended or whose. That is a
-- decision an operator makes deliberately, so the rollback states the condition and stops rather than
-- making it by default. The remedy is not to force this file: it is to end the sessions through the
-- boundary that owns them (each one's logout, or m5_session_revoke_principal) and clear what remains,
-- then roll back.
--
-- WHY "ANY ROW" AND NOT "ANY UNEXPIRED ROW". Judging expiry needs a clock, and the only clock available
-- here is the DATABASE's — while every expires_at in this table was computed from the RUNTIME's. The up
-- file refuses to let any routine judge time against the database clock for exactly this reason: the two
-- need not agree. A database clock running ahead would read a session with real time left as already
-- expired and drop it — the precise silent sign-out this file exists to prevent. An emptiness test needs
-- no clock, cannot be wrong in that direction, and is the operator's own deliberate act either way.
--
-- WHAT THE ROLLBACK COSTS EVEN WHEN IT PROCEEDS. After it, the tenant boundary has no admission adapter
-- and no durable store again, so the production composition refuses to start (productionSessions.ts binds
-- null and names every blocker). That is the posture 010 left behind, and it is a refusal, not a loss.
--
-- ORDER. The routines go first and the table last, because five of them read or write it: dropping the
-- table first would fail on the dependency, and dropping it with CASCADE would silently take its callers
-- with it. Revoking before dropping is redundant — a dropped object keeps no ACL — but it is written out
-- so the rollback states the privilege change it makes rather than implying it.
--
-- The applier's search_path is never relied on: every name below is schema-qualified and SET LOCAL pins
-- resolution to pg_catalog until this transaction ends.

set local search_path = pg_catalog, pg_temp;

-- =============================================================================
-- 1) Refuse while anyone is still signed in
-- =============================================================================
do $$
declare
  v_live bigint;
begin
  if pg_catalog.to_regclass('tmpos_session.session') is null then
    -- Nothing was applied, or it is already rolled back: there is nothing to protect, and nothing to
    -- lock either. The guard comes FIRST because plpgsql plans a statement only when it reaches it, so
    -- the lock below is never planned against a table that does not exist. It does NOT make this file
    -- re-runnable: on a database already rolled back, the first REVOKE in section 2 fails because its
    -- routine is gone, and the whole file with it — closed, having changed nothing.
    return;
  end if;

  -- THE LOCK IS PART OF THE CHECK, NOT AN OPTIMISATION. A bare count takes only ACCESS SHARE, which
  -- does not block a concurrent login from committing a brand-new session between the count and the
  -- DROP later in this same transaction. That session would be invisible to the check and then
  -- destroyed silently — precisely what this file exists to prevent. ACCESS EXCLUSIVE, taken before
  -- the count and held until this transaction ends, makes "no session" true at the count AND still
  -- true at the drop.
  lock table tmpos_session.session in access exclusive mode;

  select pg_catalog.count(*) into v_live from tmpos_session.session;

  if v_live > 0 then
    raise exception 'migration 011 rollback refused: % session row(s) remain, and dropping the table would end them silently', v_live
      using errcode = 'object_not_in_prerequisite_state',
            hint = 'end them through the session boundary (logout, or tmpos_session.m5_session_revoke_principal), clear any rows that remain, then roll back';
  end if;
end
$$;

-- =============================================================================
-- 2) The routines
-- =============================================================================
revoke execute on function tmpos_session.m5_admit_tenant_session(text, text) from tmpos_app;
revoke execute on function tmpos_session.m5_session_revoke_principal(text, text) from tmpos_app;
revoke execute on function tmpos_session.m5_session_revoke(text) from tmpos_app;
revoke execute on function tmpos_session.m5_session_touch(text, text, bigint) from tmpos_app;
revoke execute on function tmpos_session.m5_session_get(text, bigint) from tmpos_app;
revoke execute on function tmpos_session.m5_session_create(text, text, text, text, text, text, bigint, bigint, bigint, bigint, bigint) from tmpos_app;

drop function tmpos_session.m5_admit_tenant_session(text, text);
drop function tmpos_session.m5_session_revoke_principal(text, text);
drop function tmpos_session.m5_session_revoke(text);
drop function tmpos_session.m5_session_touch(text, text, bigint);
drop function tmpos_session.m5_session_get(text, bigint);
drop function tmpos_session.m5_session_create(text, text, text, text, text, text, bigint, bigint, bigint, bigint, bigint);

-- =============================================================================
-- 3) The table, then the schema
-- =============================================================================
-- The index belongs to the table and goes with it; naming it separately would only risk naming it wrongly.
drop table tmpos_session.session;

-- The schema last, and WITHOUT CASCADE: if anything this file did not create lives in it, the drop fails
-- and the whole rollback with it, rather than taking an unknown object down silently.
drop schema tmpos_session;

-- =============================================================================
-- 4) Postcondition: this file removed its own objects and nothing else
-- =============================================================================
-- It checks PRESENCE, not definition: that the schema this file created is gone, and that the objects
-- migrations 007-010 own are still there. It does not re-verify their bodies, owners or security
-- attributes — each of those migrations' own rollback owns that — so it proves "011 took nothing that
-- was not 011's", not "the 010 state is byte-for-byte what it was".
do $$
begin
  if pg_catalog.to_regnamespace('tmpos_session') is not null then
    raise exception 'migration 011 rollback refused: schema tmpos_session still exists'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- What 010 left behind must still be there: this file removes its own objects and nothing else.
  if pg_catalog.to_regprocedure('tmpos_command.m5_tenant_status_change(uuid, bigint, text, text)') is null
     or pg_catalog.to_regprocedure('tmpos_identity.m5_resolve_principal(text, text)') is null
     or not exists (select 1 from pg_catalog.pg_attribute a
                     where a.attrelid = 'public.tenant'::regclass
                       and a.attname = 'access_version' and not a.attisdropped) then
    raise exception 'migration 011 rollback refused: it removed something migrations 007-010 own'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$$;

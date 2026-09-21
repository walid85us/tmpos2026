-- Phase 4.0 M5 — the platform tenant directory
-- Migration: 012_m5_platform_tenant_directory (DOWN)
--
-- Removes exactly what the up file created: the one directory routine with the grant that rides on it, and
-- the schema tmpos_directory that held it. Nothing else is touched — not migration 011's tmpos_session,
-- not 010's access version or its lifecycle routine, not 007's tmpos_identity, not a table, a role or a
-- grant issued by 001-011.
--
-- NOTHING TO PROTECT, SO NOTHING TO REFUSE. The up file created no table and no row: its routine only
-- reads. Rolling it back loses no data. What it costs is stated rather than implied: afterwards the
-- runtime's tenant directory adapter has no routine to call, so every tenant listing is an outage (a
-- bounded 503) until 012 is applied again; the two platform commands are unaffected.
--
-- The applier's search_path is never relied on: every name below is schema-qualified and SET LOCAL pins
-- resolution to pg_catalog until this transaction ends. Revoking before dropping is redundant — a dropped
-- object keeps no ACL — but it is written out so the rollback states the privilege change it makes.

set local search_path = pg_catalog, pg_temp;

-- =============================================================================
-- 1) The routine
-- =============================================================================
revoke execute on function tmpos_directory.m5_tenant_directory_page(uuid, text, uuid, text, uuid, integer) from tmpos_app;
drop function tmpos_directory.m5_tenant_directory_page(uuid, text, uuid, text, uuid, integer);

-- =============================================================================
-- 2) The schema
-- =============================================================================
-- WITHOUT CASCADE: if anything this file did not create lives in it, the drop fails and the whole rollback
-- with it, rather than taking an unknown object down silently.
revoke usage on schema tmpos_directory from tmpos_app;
drop schema tmpos_directory;

-- =============================================================================
-- 3) Postcondition: this file removed its own objects and nothing else
-- =============================================================================
-- It checks PRESENCE, not definition: that the schema this file created is gone, and that the objects
-- migrations 007-011 own are still there. Each of those migrations' own rollback owns the rest.
do $$
begin
  if pg_catalog.to_regnamespace('tmpos_directory') is not null then
    raise exception 'migration 012 rollback refused: schema tmpos_directory still exists'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if pg_catalog.to_regprocedure('tmpos_session.m5_admit_tenant_session(text, text)') is null
     or pg_catalog.to_regprocedure('tmpos_command.m5_tenant_status_change(uuid, bigint, text, text)') is null
     or pg_catalog.to_regprocedure('tmpos_identity.m5_security_version(uuid)') is null
     or not exists (select 1 from pg_catalog.pg_attribute a
                     where a.attrelid = 'public.tenant'::regclass
                       and a.attname = 'row_version' and not a.attisdropped) then
    raise exception 'migration 012 rollback refused: it removed something migrations 007-011 own'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$$;

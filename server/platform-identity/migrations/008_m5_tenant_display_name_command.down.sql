-- Phase 4.0 M5 — the first server-authorized business command: a tenant's display name
-- Migration: 008_m5_tenant_display_name_command (DOWN)
--
-- Removes exactly what the up file created: the operation, with the grant that rides on it, the
-- row-version trigger and its function, the schema tmpos_command that held them, and the column
-- public.tenant.row_version. Nothing else is touched — not a display name, not 006's tmpos_internal,
-- not 007's tmpos_identity, not a table, a role or a grant issued by 001-007.
--
-- IT REFUSES WHILE A VERSION HAS MOVED. Dropping the column loses every tenant's version, and applying
-- 008 again restarts all of them at 1. A client still holding an expected version from before would
-- then match again and overwrite a newer name — a lost update the version exists to prevent. So the
-- rollback refuses (SQLSTATE 55006) while any tenant has moved past version 1, and drops nothing; what
-- to do with that state is an owner decision, not this file's. The table is locked first, so no write
-- can move a version between the check and the drop.
--
-- ORDER. The grant, then the trigger (it depends on its function), then the two functions, then the
-- schema WITHOUT CASCADE — so anything this file did not create there fails the rollback loudly — and
-- the column last. The applier's search_path is never relied on: every name is schema-qualified and
-- SET LOCAL pins resolution to pg_catalog until this transaction ends.

set local search_path = pg_catalog, pg_temp;

lock table public.tenant in access exclusive mode;

do $$
begin
  if exists (select 1 from public.tenant t where t.row_version operator(pg_catalog.>) 1) then
    raise exception 'migration 008 rollback refused: a tenant has moved past row version 1'
      using errcode = 'object_in_use',
            hint = 're-applying 008 would restart every version at 1, so a stale expected version could match again; resolving that state is an owner decision';
  end if;
end
$$;

revoke execute on function tmpos_command.m5_tenant_display_name_update(uuid, bigint, text) from tmpos_app;

drop trigger trg_tenant_row_version on public.tenant;

drop function tmpos_command.m5_tenant_display_name_update(uuid, bigint, text);
drop function tmpos_command.m5_tenant_row_version();

drop schema tmpos_command;

alter table public.tenant drop column row_version;

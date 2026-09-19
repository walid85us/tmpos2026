-- Phase 4.0 M5 — hardening the first server-authorized command
-- Migration: 009_m5_first_command_hardening (DOWN)
--
-- Restores exactly the 008 state: the two routines go, with the grants that ride on them; tmpos_app may call
-- 008's display-name operation again and holds 005's UPDATE of tenant.display_name again; the audit subject
-- column and its index go. Nothing else is touched — not a display name, not a version, not 005-008's other
-- grants, not 006's tmpos_internal, not 007's tmpos_identity.
--
-- IT REFUSES WHILE AN AUDIT RECORD NAMES A SUBJECT. Dropping the column would erase which tenant each such
-- record's action targeted, and audit_event is append-only evidence. So the rollback refuses (SQLSTATE 55006)
-- while any record carries subject_tenant_id, and drops nothing; what to do with that evidence is an owner
-- decision, not this file's. Every committed display-name command writes one, so in practice this rollback
-- runs only before the command has served. The table is locked first, so no record can be written between
-- the check and the drop.
--
-- ORDER. The routines' grants, then the routines, then 008's grant back, then the index and the column, then
-- 005's column grant back. Every name is schema-qualified and SET LOCAL pins resolution to pg_catalog until
-- this transaction ends.

set local search_path = pg_catalog, pg_temp;

lock table public.audit_event in access exclusive mode;

do $$
begin
  if exists (select 1 from public.audit_event a where a.subject_tenant_id is not null) then
    raise exception 'migration 009 rollback refused: an audit record names the tenant its action targeted'
      using errcode = 'object_in_use',
            hint = 'dropping subject_tenant_id would erase audit evidence; resolving that state is an owner decision';
  end if;
end
$$;

revoke execute on function tmpos_command.m5_revalidate_platform_authority(uuid, text, uuid, text) from tmpos_app;
revoke execute on function tmpos_command.m5_tenant_display_name_update_v2(uuid, bigint, text) from tmpos_app;

drop function tmpos_command.m5_revalidate_platform_authority(uuid, text, uuid, text);
drop function tmpos_command.m5_tenant_display_name_update_v2(uuid, bigint, text);

grant execute on function tmpos_command.m5_tenant_display_name_update(uuid, bigint, text) to tmpos_app;

drop index public.idx_audit_event_subject_tenant_occurred;
alter table public.audit_event drop column subject_tenant_id;

grant update (display_name) on table public.tenant to tmpos_app;

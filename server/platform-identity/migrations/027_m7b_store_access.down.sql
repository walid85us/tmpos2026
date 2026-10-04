-- Phase 4.0 M7b — the stores a tenant session may act at
-- Migration: 027_m7b_store_access (DOWN)
--
-- Removes exactly what the up file created — the one routine in schema tmpos_store_access with the grant that rides on it,
-- and the schema with its USAGE grant. Nothing else is touched — not a table, a row, a routine, a grant or a schema of
-- 001-026, and never an audit record. Rolled back, the database is exactly the 001-026 one for every object this file
-- touched; GET /api/v1/stores then has nothing to read, and the runtime that requires 001-027 refuses to start on it.
--
-- IT REFUSES WHILE ANY INVOICE DRAFT OBJECT OF MIGRATION 028 EXISTS — 028's own schema tmpos_invoice_draft (which holds its
-- invoice_draft and invoice_draft_line tables), or the column subject_invoice_draft_id on public.audit_event. Those are
-- exactly the names the M7B-INVOICES-P1 design fixes for 028, matched exactly: a relation that merely shares a table's name
-- in some other schema is not 028's and blocks nothing. 028's store drafts are authorized through the same store grants
-- this file's routine discovers, and the runtime that serves them requires the whole 001-028 chain: rolling 027 back
-- beneath 028 would leave a database no runtime accepts and a rollback order nothing records. ROLL 028 BACK BEFORE 027.
-- This file holds no data of its own, so no other guard is needed.
--
-- ROLL 027 BACK BEFORE 026. 026's rollback run first succeeds or refuses on its own guard (no dependency is recorded), and
-- this file's routine keeps answering, since it calls nothing 019-026 created; this file's rollback then refuses (its
-- postcondition proves 026's objects in place) until 026 is applied again.
--
-- The applier's search_path is never relied on: every name below is schema-qualified and SET LOCAL pins resolution to
-- pg_catalog until this transaction ends. Revoking before dropping is redundant — a dropped object keeps no ACL — but it is
-- written out so the rollback states the privilege change it makes.

set local search_path = pg_catalog, pg_temp;
set local row_security = off;

-- =============================================================================
-- 1) The guard: this file is applied, and nothing of 028 sits above it
-- =============================================================================
do $$
begin
  if pg_catalog.to_regnamespace('tmpos_store_access') is null
     or pg_catalog.to_regprocedure('tmpos_store_access.m7b_store_directory(text)') is null then
    raise exception 'migration 027 rollback refused: migration 027 is not applied (schema tmpos_store_access or its routine is missing)'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if pg_catalog.to_regnamespace('tmpos_invoice_draft') is not null
     or exists (select 1 from pg_catalog.pg_attribute a
                 where a.attrelid = 'public.audit_event'::regclass and a.attname = 'subject_invoice_draft_id' and not a.attisdropped) then
    raise exception 'migration 027 rollback refused: an invoice draft object of migration 028 exists'
      using errcode = 'object_not_in_prerequisite_state',
            hint = 'roll migration 028 back first';
  end if;
end
$$;

-- =============================================================================
-- 2) The routine
-- =============================================================================
revoke execute on function tmpos_store_access.m7b_store_directory(text) from tmpos_app;
drop function tmpos_store_access.m7b_store_directory(text);

-- =============================================================================
-- 3) The schema
-- =============================================================================
-- WITHOUT CASCADE: if anything this file did not create lives in it, the drop fails and the whole rollback with it,
-- rather than taking an unknown object down silently.
revoke usage on schema tmpos_store_access from tmpos_app;
drop schema tmpos_store_access;

-- =============================================================================
-- 4) Postcondition: this file removed its own objects and left 026's in place
-- =============================================================================
-- It checks that the schema this file created is gone and, by PRESENCE and privilege, that 026's routines and schema and
-- tmpos_app's grants on them — and the 016 admission read this file's routine called — are still there (their own rollbacks
-- own them, and own whatever else they contain: this file touched none of it).
do $$
begin
  if pg_catalog.to_regnamespace('tmpos_store_access') is not null then
    raise exception 'migration 027 rollback refused: schema tmpos_store_access still exists'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if pg_catalog.to_regnamespace('tmpos_role_invoice') is null
     or pg_catalog.to_regprocedure('tmpos_role_invoice.m7a_invoice_role_level_states(uuid)') is null
     or pg_catalog.to_regprocedure('tmpos_role_invoice.m7a_invoice_role_level_set(text, text, text, uuid, bigint)') is null
     or pg_catalog.to_regprocedure('tmpos_session.m5_admit_tenant_session_v2(text, text)') is null then
    raise exception 'migration 027 rollback refused: migration 026''s routines or 016''s admission read are missing'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if not pg_catalog.has_function_privilege('tmpos_app', 'tmpos_role_invoice.m7a_invoice_role_level_states(uuid)'::regprocedure, 'EXECUTE')
     or not pg_catalog.has_function_privilege('tmpos_app',
              'tmpos_role_invoice.m7a_invoice_role_level_set(text, text, text, uuid, bigint)'::regprocedure, 'EXECUTE')
     or not pg_catalog.has_schema_privilege('tmpos_app', 'tmpos_role_invoice'::regnamespace, 'USAGE')
     or not pg_catalog.has_function_privilege('tmpos_app', 'tmpos_session.m5_admit_tenant_session_v2(text, text)'::regprocedure, 'EXECUTE') then
    raise exception 'migration 027 rollback refused: tmpos_app no longer holds the 016 and 026 grants it held before this file'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$$;

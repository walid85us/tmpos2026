-- Phase 4.0 M7b — store-owned invoice drafts
-- Migration: 028_m7b_invoice_drafts (DOWN)
--
-- Removes exactly what the up file created — the three routines in schema tmpos_invoice_draft with the grants that ride on
-- them, its two tables with their indexes and constraints, the schema with its USAGE grant, the partial index
-- idx_audit_event_subject_invoice_draft_occurred and the column public.audit_event.subject_invoice_draft_id, and the two
-- UNIQUE constraints store_tenant_store_key (public.store) and customer_tenant_customer_key (tmpos_customer.customer) —
-- and the NULL Invoices role rows only the up file's create could have made. Nothing else is touched — not a routine,
-- grant, schema, table or row of 001-027, not a store, customer or membership, and never an audit record. Rolled back,
-- the database is exactly the 001-027 one for every object this file touched, and the runtime that requires 001-028
-- refuses to start on it.
--
-- IT REFUSES, CHANGING NOTHING:
--   * while migration 028 is not applied (its schema, a table, a routine, the audit column or a UNIQUE is missing), or a
--     table or schema an earlier migration created and this file locks is missing (002, 017, 020, 021);
--   * while ANY draft or line exists: dropping the tables would discard drafts a user saved;
--   * while ANY audit record names a draft (subject_invoice_draft_id set): dropping the column would erase audit evidence
--     (024's rule). Resolving either state is a deliberate owner decision, never a rollback's side effect.
--
-- THE NULL INVOICES ROLE ROWS. The up file's create makes the acting role's Invoices row exist (level NULL: the catalog
-- default) as its lock anchor, and 026's rollback refuses while ANY Invoices row exists — so without this step 027 and 026
-- could not be rolled back after a single draft was ever saved, even once every draft was gone. This file deletes exactly
-- the Invoices rows whose level is NULL and that have NO version row in tmpos_role_edit.role_level_version: an owner's edit
-- always UPDATEs to a level word and its trigger writes a version row, so such a row was never an owner's choice — it is a
-- lock anchor (020's create leaves the same kind of row for Customers, which nothing here touches). An Invoices row with a
-- level or a version stays, and 026's own guard then decides.
--
-- LOCKS, BEFORE ANY CHECK. In the order the runtime's writers take these tables (016's hold reads stores; a create then
-- holds the role rows, Customers then Invoices; an edit's trigger writes the version row; then the customer, the draft and
-- its lines; the audit record last): public.store, tmpos_role.tenant_role_level, tmpos_role_edit.role_level_version,
-- tmpos_customer.customer, tmpos_invoice_draft.invoice_draft, tmpos_invoice_draft.invoice_draft_line, public.audit_event —
-- each ACCESS EXCLUSIVE until COMMIT, so no draft, line, level, version or audit row can be written between the checks and
-- the drops. They are the first statements after the settings: nothing is read or checked before them, not even the
-- catalog. They are taken in one block whose handler turns a missing table or schema (undefined_table,
-- invalid_schema_name) into this file's refusal (55000) — 028 is not applied, or a table or schema an earlier migration
-- created is missing, since the LOCK cannot tell which — the block's locks released first, so a database without 028 (or
-- without one of 002, 017, 020, 021) is refused, never met with a raw error. Every check — that the file is applied, then
-- the guard — runs after them. The data checks run only under READ COMMITTED, where their statements' snapshots are taken
-- after the locks are held (017's reason), with row_security off, so a table whose row security were FORCEd on a non-owner
-- applier makes the rollback fail instead of hiding rows from them.
--
-- ROLL 028 BACK BEFORE 027. 027's rollback refuses while any of this file's objects exist.
--
-- The applier's search_path is never relied on: every name below is schema-qualified and SET LOCAL pins resolution to
-- pg_catalog until this transaction ends. Revoking before dropping is redundant — a dropped object keeps no ACL — but it is
-- written out so the rollback states the privilege change it makes.

set local search_path = pg_catalog, pg_temp;
set local row_security = off;

-- =============================================================================
-- 1) The locks, in the writers' order: the first statements after the settings, before any check or any change
-- =============================================================================
-- A LOCK naming a table or schema that is missing raises undefined_table (42P01) or invalid_schema_name (3F000); the
-- block's handler turns either into this file's refusal (55000). The block runs as a subtransaction: once it completes,
-- this transaction keeps its locks until COMMIT; refused, the subtransaction has released the locks it took, and the
-- refusal aborts the file.
do $$
begin
  lock table public.store in access exclusive mode;
  lock table tmpos_role.tenant_role_level in access exclusive mode;
  lock table tmpos_role_edit.role_level_version in access exclusive mode;
  lock table tmpos_customer.customer in access exclusive mode;
  lock table tmpos_invoice_draft.invoice_draft in access exclusive mode;
  lock table tmpos_invoice_draft.invoice_draft_line in access exclusive mode;
  lock table public.audit_event in access exclusive mode;
exception
  when undefined_table or invalid_schema_name then
    raise exception 'migration 028 rollback refused: migration 028 is not applied (schema tmpos_invoice_draft or one of its tables is missing), or a table or schema an earlier migration created is missing (public.store, tmpos_role.tenant_role_level, tmpos_role_edit.role_level_version, tmpos_customer.customer or public.audit_event: migrations 002, 017, 020 and 021)'
      using errcode = 'object_not_in_prerequisite_state';
end
$$;

-- =============================================================================
-- 2) The file is applied (read under the locks)
-- =============================================================================
do $$
begin
  if pg_catalog.to_regnamespace('tmpos_invoice_draft') is null
     or pg_catalog.to_regclass('tmpos_invoice_draft.invoice_draft') is null
     or pg_catalog.to_regclass('tmpos_invoice_draft.invoice_draft_line') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_draft.m7b_invoice_draft_create(text, uuid, uuid, uuid, uuid, jsonb, bigint)') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_draft.m7b_invoice_draft_page(text, uuid, uuid, uuid, integer)') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_draft.m7b_invoice_draft_get(text, uuid, uuid, uuid)') is null
     or not exists (select 1 from pg_catalog.pg_attribute a
                     where a.attrelid = 'public.audit_event'::regclass and a.attname = 'subject_invoice_draft_id' and not a.attisdropped)
     or not exists (select 1 from pg_catalog.pg_constraint k
                     where k.conrelid = 'public.store'::regclass and k.conname = 'store_tenant_store_key')
     or not exists (select 1 from pg_catalog.pg_constraint k
                     where k.conrelid = 'tmpos_customer.customer'::regclass and k.conname = 'customer_tenant_customer_key') then
    raise exception 'migration 028 rollback refused: migration 028 is not applied (schema tmpos_invoice_draft, a table, a routine, public.audit_event.subject_invoice_draft_id or a UNIQUE constraint is missing)'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$$;

-- =============================================================================
-- 3) The guard: no saved draft and no audit evidence is discarded; then the lock anchors only this file's create made
-- =============================================================================
do $$
begin
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'migration 028 rollback refused: it must run under READ COMMITTED, so that its checks see every committed row'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if exists (select 1 from tmpos_invoice_draft.invoice_draft)
     or exists (select 1 from tmpos_invoice_draft.invoice_draft_line) then
    raise exception 'migration 028 rollback refused: an invoice draft exists'
      using errcode = 'object_not_in_prerequisite_state',
            hint = 'dropping the draft tables would discard saved drafts; resolving that state is an owner decision';
  end if;
  if exists (select 1 from public.audit_event a where a.subject_invoice_draft_id is not null) then
    raise exception 'migration 028 rollback refused: an audit record names an invoice draft'
      using errcode = 'object_not_in_prerequisite_state',
            hint = 'dropping subject_invoice_draft_id would erase audit evidence; resolving that state is an owner decision';
  end if;
end
$$;

-- An Invoices row with no level and no version row: a lock anchor (see the header), never an owner's choice.
delete from tmpos_role.tenant_role_level l
 where l.domain = 'invoices'
   and l.level is null
   and not exists (select 1 from tmpos_role_edit.role_level_version v
                    where v.tenant_id = l.tenant_id and v.role_id = l.role_id and v.domain = l.domain);

-- =============================================================================
-- 4) The routines
-- =============================================================================
revoke execute on function tmpos_invoice_draft.m7b_invoice_draft_create(text, uuid, uuid, uuid, uuid, jsonb, bigint) from tmpos_app;
revoke execute on function tmpos_invoice_draft.m7b_invoice_draft_page(text, uuid, uuid, uuid, integer) from tmpos_app;
revoke execute on function tmpos_invoice_draft.m7b_invoice_draft_get(text, uuid, uuid, uuid) from tmpos_app;
drop function tmpos_invoice_draft.m7b_invoice_draft_create(text, uuid, uuid, uuid, uuid, jsonb, bigint);
drop function tmpos_invoice_draft.m7b_invoice_draft_page(text, uuid, uuid, uuid, integer);
drop function tmpos_invoice_draft.m7b_invoice_draft_get(text, uuid, uuid, uuid);

-- =============================================================================
-- 5) The tables (the lines first: they reference the header), then the schema
-- =============================================================================
-- WITHOUT CASCADE throughout: if anything this file did not create depends on them or lives in the schema, the drop fails
-- and the whole rollback with it, rather than taking an unknown object down silently.
drop table tmpos_invoice_draft.invoice_draft_line;
drop table tmpos_invoice_draft.invoice_draft;
revoke usage on schema tmpos_invoice_draft from tmpos_app;
drop schema tmpos_invoice_draft;

-- =============================================================================
-- 6) The audit subject, and the two UNIQUE constraints nothing references any more
-- =============================================================================
drop index public.idx_audit_event_subject_invoice_draft_occurred;
alter table public.audit_event drop column subject_invoice_draft_id;
alter table tmpos_customer.customer drop constraint customer_tenant_customer_key;
alter table public.store drop constraint store_tenant_store_key;

-- =============================================================================
-- 7) Postcondition: this file removed its own objects and left 027's in place
-- =============================================================================
-- It checks that every object this file created is gone; that tmpos_customer.customer carries exactly 024's constraints and
-- 017's two indexes again and public.store none of this file's; that no Invoices lock anchor of this file's kind remains;
-- and, by PRESENCE and privilege, that 027's routine and schema and tmpos_app's grants on them — and 024's audit subject —
-- are still there (their own rollbacks own them).
do $$
declare
  v_bad text;
begin
  if pg_catalog.to_regnamespace('tmpos_invoice_draft') is not null
     or exists (select 1 from pg_catalog.pg_class c where c.relname in ('invoice_draft', 'invoice_draft_line'))
     or exists (select 1 from pg_catalog.pg_attribute a
                 where a.attrelid = 'public.audit_event'::regclass and a.attname = 'subject_invoice_draft_id' and not a.attisdropped)
     or pg_catalog.to_regclass('public.idx_audit_event_subject_invoice_draft_occurred') is not null
     or exists (select 1 from pg_catalog.pg_constraint k
                 where (k.conrelid = 'public.store'::regclass and k.conname = 'store_tenant_store_key')
                    or (k.conrelid = 'tmpos_customer.customer'::regclass and k.conname = 'customer_tenant_customer_key')) then
    raise exception 'migration 028 rollback refused: an object migration 028 created still exists'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  select pg_catalog.string_agg(pg_catalog.format('%s:%s:%s', c.conname, c.contype, c.convalidated), ', ' order by c.conname)
    into v_bad
    from pg_catalog.pg_constraint c
   where c.conrelid = 'tmpos_customer.customer'::regclass
     and c.contype <> 'n';
  if v_bad is distinct from
       'customer_email_chk:c:t, customer_name_chk:c:t, customer_phone_chk:c:t, customer_pkey:p:t, customer_row_version_chk:c:t, customer_tenant_fkey:f:t' then
    raise exception 'migration 028 rollback refused: tmpos_customer.customer does not carry exactly 017''s, 023''s and 024''s constraints again (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  select pg_catalog.string_agg(i.relname::text, ', ' order by i.relname) into v_bad
    from pg_catalog.pg_index x
    join pg_catalog.pg_class i on i.oid = x.indexrelid
   where x.indrelid = 'tmpos_customer.customer'::regclass;
  if v_bad is distinct from 'customer_pkey, customer_tenant_page_idx' then
    raise exception 'migration 028 rollback refused: tmpos_customer.customer does not carry exactly 017''s two indexes again (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if exists (select 1 from tmpos_role.tenant_role_level l
              where l.domain = 'invoices' and l.level is null
                and not exists (select 1 from tmpos_role_edit.role_level_version v
                                 where v.tenant_id = l.tenant_id and v.role_id = l.role_id and v.domain = l.domain)) then
    raise exception 'migration 028 rollback refused: an Invoices lock anchor of migration 028 remains'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if pg_catalog.to_regnamespace('tmpos_store_access') is null
     or pg_catalog.to_regprocedure('tmpos_store_access.m7b_store_directory(text)') is null
     or not pg_catalog.has_function_privilege('tmpos_app', 'tmpos_store_access.m7b_store_directory(text)'::regprocedure, 'EXECUTE')
     or not pg_catalog.has_schema_privilege('tmpos_app', 'tmpos_store_access'::regnamespace, 'USAGE')
     or not exists (select 1 from pg_catalog.pg_attribute a
                     where a.attrelid = 'public.audit_event'::regclass and a.attname = 'subject_customer_id' and not a.attisdropped) then
    raise exception 'migration 028 rollback refused: migration 027''s routine or tmpos_app''s grants on it, or 024''s audit subject, are missing'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$$;

-- Phase 4.0 M5 — the owner's Invoices level, stored and versioned beside the Customers one
-- Migration: 026_m5_invoice_role_levels (DOWN)
--
-- Removes exactly what the up file created — the two routines in schema tmpos_role_invoice with the grants that ride on them
-- and the schema with its USAGE grant — and restores the two CHECKs it replaced to exactly what 020 and 021 created,
-- check (domain = 'customers'), under the same names. Nothing else is touched — not 020's or 021's routines, grants,
-- schemas, tables or trigger, not a Customers level or version, not a role or a grant issued by 001-025, and never an audit
-- record. Rolled back, the database is exactly the 001-025 one for every object this file touched.
--
-- IT REFUSES WHILE ANY ROW WHOSE DOMAIN IS 'invoices' EXISTS IN EITHER TABLE — a stored Invoices level in 020's
-- tmpos_role.tenant_role_level, or an issued Invoices version in 021's tmpos_role_edit.role_level_version. The narrow CHECKs
-- cannot be restored over such a row, and rolling back and re-applying after the version rows were deleted would restart the
-- counter at 0, so a draft still holding a version issued before could then succeed against a different level (ABA). The
-- remedy is a deliberate delete of those rows by the tables' owner, who thereby accepts that risk for every Invoices draft
-- still open. Both tables are locked first (ACCESS EXCLUSIVE, which the constraint replacement takes anyway), 020's role
-- table and then the version table — in the order every writer takes them — so no level can be updated and no version
-- written between the check and the drops, and the check runs only under READ COMMITTED, where its statement's snapshot is
-- taken after the locks are held (017's reason). It runs with row_security off, so a table whose row security were FORCEd
-- on a non-owner applier makes the rollback fail instead of hiding rows from the check.
--
-- WHY THIS GUARD KEEPS 020's AND 021's GUARDS CORRECT. 020's rollback compares each stored level with its role's catalog
-- default without looking at the domain, and 021's refuses on any version row, whatever its domain. Both run after this file
-- (the ledger's newest-first order), and this file refuses while an Invoices row exists, so neither ever sees one.
--
-- ROLL 026 BACK BEFORE 021 AND 020. 021's rollback run first refuses while an Invoices version exists, and succeeds
-- otherwise (no dependency is recorded); this file's routines then raise on the missing objects — failing closed — and this
-- file's rollback refuses (its postcondition) until they are applied again.
--
-- The applier's search_path is never relied on: every name below is schema-qualified and SET LOCAL pins resolution to
-- pg_catalog until this transaction ends. Revoking before dropping is redundant — a dropped object keeps no ACL — but it is
-- written out so the rollback states the privilege change it makes.

set local search_path = pg_catalog, pg_temp;
set local row_security = off;

-- =============================================================================
-- 1) The guard: an issued Invoices level or version is never discarded by a rollback
-- =============================================================================
lock table tmpos_role.tenant_role_level in access exclusive mode;
lock table tmpos_role_edit.role_level_version in access exclusive mode;

do $$
begin
  if pg_catalog.to_regnamespace('tmpos_role_invoice') is null
     or pg_catalog.to_regprocedure('tmpos_role_invoice.m7a_invoice_role_level_states(uuid)') is null
     or pg_catalog.to_regprocedure('tmpos_role_invoice.m7a_invoice_role_level_set(text, text, text, uuid, bigint)') is null then
    raise exception 'migration 026 rollback refused: migration 026 is not applied (schema tmpos_role_invoice or one of its routines is missing)'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'migration 026 rollback refused: it must run under READ COMMITTED, so that its check sees every committed row'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if exists (select 1 from tmpos_role.tenant_role_level l where l.domain = 'invoices')
     or exists (select 1 from tmpos_role_edit.role_level_version v where v.domain = 'invoices') then
    raise exception 'migration 026 rollback refused: an Invoices role level or version exists'
      using errcode = 'object_not_in_prerequisite_state',
            hint = 'the tables'' owner deletes the Invoices rows deliberately, accepting that a re-apply may re-issue a version an open draft holds, then rolls back';
  end if;
end
$$;

-- =============================================================================
-- 2) The routines
-- =============================================================================
revoke execute on function tmpos_role_invoice.m7a_invoice_role_level_states(uuid) from tmpos_app;
revoke execute on function tmpos_role_invoice.m7a_invoice_role_level_set(text, text, text, uuid, bigint) from tmpos_app;
drop function tmpos_role_invoice.m7a_invoice_role_level_states(uuid);
drop function tmpos_role_invoice.m7a_invoice_role_level_set(text, text, text, uuid, bigint);

-- =============================================================================
-- 3) The schema
-- =============================================================================
-- WITHOUT CASCADE: if anything this file did not create lives in it, the drop fails and the whole rollback with it,
-- rather than taking an unknown object down silently.
revoke usage on schema tmpos_role_invoice from tmpos_app;
drop schema tmpos_role_invoice;

-- =============================================================================
-- 4) The two CHECKs, narrowed back to exactly what 020 and 021 created
-- =============================================================================
-- The guard above proved no row holds another domain, and both tables are still locked, so these validate.
alter table tmpos_role.tenant_role_level
  drop constraint tenant_role_level_domain_chk,
  add constraint tenant_role_level_domain_chk check (domain = 'customers');
alter table tmpos_role_edit.role_level_version
  drop constraint role_level_version_domain_chk,
  add constraint role_level_version_domain_chk check (domain = 'customers');

-- =============================================================================
-- 5) Postcondition: this file removed its own objects and restored the prior state
-- =============================================================================
-- It checks that the schema this file created is gone; that both CHECKs are exactly the ones 020 and 021 create; and, by
-- PRESENCE and privilege, that 020's and 021's objects, tmpos_app's grants on them and on 023's create (the login's one
-- create, which replaced 020's) are still there (their own rollbacks own the rest).
do $$
begin
  if pg_catalog.to_regnamespace('tmpos_role_invoice') is not null then
    raise exception 'migration 026 rollback refused: schema tmpos_role_invoice still exists'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if (select pg_catalog.count(*) from pg_catalog.pg_constraint k
       where k.conrelid = 'tmpos_role.tenant_role_level'::regclass and k.contype = 'c'
         and k.conname = 'tenant_role_level_domain_chk' and k.convalidated
         and pg_catalog.pg_get_constraintdef(k.oid) = 'CHECK ((domain = ''customers''::text))') <> 1
     or (select pg_catalog.count(*) from pg_catalog.pg_constraint k
          where k.conrelid = 'tmpos_role_edit.role_level_version'::regclass and k.contype = 'c'
            and k.conname = 'role_level_version_domain_chk' and k.convalidated
            and pg_catalog.pg_get_constraintdef(k.oid) = 'CHECK ((domain = ''customers''::text))') <> 1
     or (select pg_catalog.count(*) from pg_catalog.pg_constraint k
          where k.conrelid in ('tmpos_role.tenant_role_level'::regclass, 'tmpos_role_edit.role_level_version'::regclass)
            and k.contype = 'c' and pg_catalog.pg_get_constraintdef(k.oid) like '%domain%') <> 2 then
    raise exception 'migration 026 rollback refused: a domain CHECK is not exactly check (domain = ''customers'')'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if pg_catalog.to_regclass('tmpos_role.tenant_role_level') is null
     or pg_catalog.to_regprocedure('tmpos_role.m7a_role_levels(uuid, text)') is null
     or pg_catalog.to_regprocedure('tmpos_role.m7a_customer_create(text, uuid, text)') is null
     or pg_catalog.to_regprocedure('tmpos_role.m7a_customer_page_v3(text, uuid, integer)') is null
     or pg_catalog.to_regclass('tmpos_role_edit.role_level_version') is null
     or pg_catalog.to_regprocedure('tmpos_role_edit.m7a_role_level_states(uuid)') is null
     or pg_catalog.to_regprocedure('tmpos_role_edit.m7a_role_level_set_v2(text, text, text, text, uuid, bigint)') is null
     or pg_catalog.to_regprocedure('tmpos_role_edit.m7a_role_level_version_advance()') is null then
    raise exception 'migration 026 rollback refused: it removed something migration 020 or 021 owns'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if not pg_catalog.has_function_privilege('tmpos_app', 'tmpos_role.m7a_role_levels(uuid, text)'::regprocedure, 'EXECUTE')
     or not pg_catalog.has_function_privilege('tmpos_app', 'tmpos_customer_contact.m7a_contact_create(text, uuid, text, text, text)'::regprocedure, 'EXECUTE')
     or not pg_catalog.has_function_privilege('tmpos_app', 'tmpos_role.m7a_customer_page_v3(text, uuid, integer)'::regprocedure, 'EXECUTE')
     or not pg_catalog.has_function_privilege('tmpos_app', 'tmpos_role_edit.m7a_role_level_states(uuid)'::regprocedure, 'EXECUTE')
     or not pg_catalog.has_function_privilege('tmpos_app',
              'tmpos_role_edit.m7a_role_level_set_v2(text, text, text, text, uuid, bigint)'::regprocedure, 'EXECUTE')
     or not pg_catalog.has_schema_privilege('tmpos_app', 'tmpos_role'::regnamespace, 'USAGE')
     or not pg_catalog.has_schema_privilege('tmpos_app', 'tmpos_role_edit'::regnamespace, 'USAGE') then
    raise exception 'migration 026 rollback refused: tmpos_app no longer holds the 020, 021 and 023 grants it held before this file'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$$;

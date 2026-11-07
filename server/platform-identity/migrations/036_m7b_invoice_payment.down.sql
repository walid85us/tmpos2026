-- Phase 4.0 M7b — recording payments against an issued store invoice
-- Migration: 036_m7b_invoice_payment (DOWN)
--
-- Removes exactly what the up file created — the rollback-order anchor, the four routines with the grants that ride on them,
-- the four guard triggers and their functions, the tables tmpos_invoice_payment.invoice_payment_reversal and invoice_payment
-- (and with them their foreign keys' internal triggers on 034's issued_invoice), the schema (a plain DROP SCHEMA, which refuses
-- if anything else is in it), and public.audit_event's CHECK audit_event_metadata_no_card_data_keys_chk, index
-- idx_audit_event_subject_invoice_payment_occurred and column subject_invoice_payment_id — and restores the 035 catalog
-- exactly: tmpos_app holds its EXECUTE on 035's tmpos_invoice_void.m7b_invoice_void again, which the up file revoked, its ACL
-- exactly 035's two entries. Nothing else is touched — not an issued invoice, a void record, a draft, a customer, a store, an
-- audit record or a completion. Rolled back, the database is exactly the 001-035 one for every object this file touched, and
-- the runtime that requires 001-036 refuses to start on it.
--
-- RUN IT WITH THE TENANT RUNTIME STOPPED, as the apply.
--
-- IT REFUSES, CHANGING NOTHING (any refusal rolls the whole file back):
--   * while migration 036 is not applied (its schema, a routine, a table or the audit column is missing), or a table this file
--     locks is missing, or 035's void is missing (there is no 035 contract to restore: roll 036 back before 035);
--   * while ANY payment, ANY reversal, ANY audit record of action store.invoice_payment.record or store.invoice_payment.reverse,
--     or ANY audit record naming a payment exists: removing them would discard money statements or their audit evidence — an
--     owner decision on data, never a rollback's side effect. No path removes one, so AFTER THE FIRST PAYMENT THIS ROLLBACK IS
--     ONE-WAY (D-PAY-9's interim default);
--   * PostgreSQL refuses a statement of section 4 (nothing is dropped with CASCADE), or the postcondition finds the 035 catalog
--     inexact.
-- RETAINED EVIDENCE: this file removes no row.
--
-- LOCKS, BEFORE ANY CHECK: the up file's, in the writers' order, with the two payment tables before public.audit_event.

set local search_path = pg_catalog, pg_temp;
set local row_security = off;

-- =============================================================================
-- 1) The locks, in the writers' order: the first statements after the settings, before any check or any change
-- =============================================================================
do $$
begin
  lock table public.store in access exclusive mode;
  lock table tmpos_role.tenant_role_level in access exclusive mode;
  lock table tmpos_role_edit.role_level_version in access exclusive mode;
  lock table tmpos_customer.customer in access exclusive mode;
  lock table tmpos_invoice_draft.invoice_draft in access exclusive mode;
  lock table tmpos_invoice_draft.invoice_draft_line in access exclusive mode;
  lock table tmpos_invoice_issue.store_issuing_settings in access exclusive mode;
  lock table tmpos_invoice_issue.store_invoice_counter in access exclusive mode;
  lock table tmpos_invoice_issue.issued_invoice in access exclusive mode;
  lock table tmpos_invoice_issue.issued_invoice_line in access exclusive mode;
  lock table tmpos_invoice_void.issued_invoice_void in access exclusive mode;
  lock table tmpos_invoice_payment.invoice_payment in access exclusive mode;
  lock table tmpos_invoice_payment.invoice_payment_reversal in access exclusive mode;
  lock table public.audit_event in access exclusive mode;
exception
  when undefined_table or invalid_schema_name then
    raise exception 'migration 036 rollback refused: migration 036 is not applied (a table or schema this file locks is missing: public.store, a role, customer, draft or issuing table, tmpos_invoice_void.issued_invoice_void, a table of tmpos_invoice_payment or public.audit_event)'
      using errcode = 'object_not_in_prerequisite_state';
end
$$;

-- =============================================================================
-- 2) The file is applied, and 035's void it restores is there (read under the locks)
-- =============================================================================
do $$
begin
  if pg_catalog.to_regprocedure('tmpos_invoice_payment.m7b_invoice_payment_record(text, uuid, uuid, uuid, uuid, uuid, bigint, text, uuid)') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_payment.m7b_invoice_payment_reverse(text, uuid, uuid, uuid, uuid, bigint, text, uuid)') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_payment.m7b_invoice_void_v2(text, uuid, uuid, uuid, bigint, text)') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_payment.m7b_invoice_payments_get(text, uuid, uuid, uuid, uuid, integer)') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_payment.m7b_invoice_payment_prerequisites()') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_payment.m7b_invoice_payment_guard()') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_payment.m7b_invoice_payment_truncate_guard()') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_payment.m7b_invoice_payment_reversal_guard()') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_payment.m7b_invoice_payment_reversal_truncate_guard()') is null
     or not exists (select 1 from pg_catalog.pg_attribute a
                     where a.attrelid = 'public.audit_event'::regclass and a.attname = 'subject_invoice_payment_id' and not a.attisdropped) then
    raise exception 'migration 036 rollback refused: migration 036 is not applied (a routine, a guard function or the audit column is missing)'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if pg_catalog.to_regprocedure('tmpos_invoice_void.m7b_invoice_void(text, uuid, uuid, uuid, bigint, text)') is null then
    raise exception 'migration 036 rollback refused: migration 035''s void is missing, so there is no 035 catalog to restore'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$$;

-- =============================================================================
-- 3) The guard: no payment, reversal or payment audit evidence is ever discarded by a rollback
-- =============================================================================
do $$
begin
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'migration 036 rollback refused: it must run under READ COMMITTED, so that its checks see every committed row'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if exists (select 1 from tmpos_invoice_payment.invoice_payment) then
    raise exception 'migration 036 rollback refused: a payment record exists, and a rollback never removes one'
      using errcode = 'object_not_in_prerequisite_state',
            hint = 'removing a payment record changes what an invoice shows as recorded; that is an owner decision, not a rollback''s side effect';
  end if;
  if exists (select 1 from tmpos_invoice_payment.invoice_payment_reversal) then
    raise exception 'migration 036 rollback refused: a payment reversal exists, and a rollback never removes one'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if exists (select 1 from public.audit_event a
              where a.action_id in ('store.invoice_payment.record', 'store.invoice_payment.reverse')
                 or a.subject_invoice_payment_id is not null) then
    raise exception 'migration 036 rollback refused: an audit record of a payment action, or naming a payment, exists'
      using errcode = 'object_not_in_prerequisite_state',
            hint = 'rolling back would leave, or lose, audit evidence of a payment the database no longer records; resolving that state is an owner decision';
  end if;
end
$$;

-- =============================================================================
-- 4) 035's void grant, then the anchor, the routines, the triggers and their functions, the tables, the schema, the audit additions
-- =============================================================================
grant execute on function tmpos_invoice_void.m7b_invoice_void(text, uuid, uuid, uuid, bigint, text) to tmpos_app;

drop function tmpos_invoice_payment.m7b_invoice_payment_prerequisites();

revoke execute on function tmpos_invoice_payment.m7b_invoice_payment_record(text, uuid, uuid, uuid, uuid, uuid, bigint, text, uuid) from tmpos_app;
revoke execute on function tmpos_invoice_payment.m7b_invoice_payment_reverse(text, uuid, uuid, uuid, uuid, bigint, text, uuid) from tmpos_app;
revoke execute on function tmpos_invoice_payment.m7b_invoice_void_v2(text, uuid, uuid, uuid, bigint, text) from tmpos_app;
revoke execute on function tmpos_invoice_payment.m7b_invoice_payments_get(text, uuid, uuid, uuid, uuid, integer) from tmpos_app;
drop function tmpos_invoice_payment.m7b_invoice_payment_record(text, uuid, uuid, uuid, uuid, uuid, bigint, text, uuid);
drop function tmpos_invoice_payment.m7b_invoice_payment_reverse(text, uuid, uuid, uuid, uuid, bigint, text, uuid);
drop function tmpos_invoice_payment.m7b_invoice_void_v2(text, uuid, uuid, uuid, bigint, text);
drop function tmpos_invoice_payment.m7b_invoice_payments_get(text, uuid, uuid, uuid, uuid, integer);

drop trigger trg_invoice_payment_reversal_guard on tmpos_invoice_payment.invoice_payment_reversal;
drop trigger trg_invoice_payment_reversal_truncate on tmpos_invoice_payment.invoice_payment_reversal;
drop trigger trg_invoice_payment_guard on tmpos_invoice_payment.invoice_payment;
drop trigger trg_invoice_payment_truncate on tmpos_invoice_payment.invoice_payment;
drop function tmpos_invoice_payment.m7b_invoice_payment_reversal_guard();
drop function tmpos_invoice_payment.m7b_invoice_payment_reversal_truncate_guard();
drop function tmpos_invoice_payment.m7b_invoice_payment_guard();
drop function tmpos_invoice_payment.m7b_invoice_payment_truncate_guard();

-- The foreign keys' internal triggers (on invoice_payment and on 034's issued_invoice) go with the tables.
drop table tmpos_invoice_payment.invoice_payment_reversal;
drop table tmpos_invoice_payment.invoice_payment;

revoke usage on schema tmpos_invoice_payment from tmpos_app;
drop schema tmpos_invoice_payment;

alter table public.audit_event drop constraint audit_event_metadata_no_card_data_keys_chk;
drop index public.idx_audit_event_subject_invoice_payment_occurred;
alter table public.audit_event drop column subject_invoice_payment_id;

-- =============================================================================
-- 5) Postcondition: this file removed its own objects and left the 035 catalog exactly
-- =============================================================================
do $$
declare
  v_void oid := 'tmpos_invoice_void.m7b_invoice_void(text, uuid, uuid, uuid, bigint, text)'::regprocedure;
begin
  if pg_catalog.to_regnamespace('tmpos_invoice_payment') is not null
     or pg_catalog.to_regclass('public.idx_audit_event_subject_invoice_payment_occurred') is not null
     or exists (select 1 from pg_catalog.pg_attribute a
                 where a.attrelid = 'public.audit_event'::regclass and a.attname = 'subject_invoice_payment_id' and not a.attisdropped)
     or exists (select 1 from pg_catalog.pg_constraint k
                 where k.conrelid = 'public.audit_event'::regclass and k.conname = 'audit_event_metadata_no_card_data_keys_chk') then
    raise exception 'migration 036 rollback refused: an object migration 036 created still exists'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- 035's void ACL exactly as 035 left it: the owner's EXECUTE and tmpos_app's, both granted by the owner, non-grantable.
  if (select pg_catalog.string_agg(pg_catalog.format('%s/%s/%s/%s', case when g.grantee = p.proowner then 'owner' else g.grantee::regrole::text end,
                                                     g.privilege_type, g.is_grantable, g.grantor = p.proowner), ';'
                                   order by case when g.grantee = p.proowner then 'owner' else g.grantee::regrole::text end collate "C")
        from pg_catalog.pg_proc p, pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g
       where p.oid = v_void)
     is distinct from 'owner/EXECUTE/f/t;tmpos_app/EXECUTE/f/t' then
    raise exception 'migration 036 rollback refused: migration 035''s void does not carry exactly 035''s grants again'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- The issued header: no foreign key references it but 034's line key and 035's void record's.
  if (select pg_catalog.string_agg(pg_catalog.format('%s.%s', k.conrelid::regclass::text, k.conname), ', ' order by k.conname::text collate "C")
        from pg_catalog.pg_constraint k where k.contype = 'f' and k.confrelid = 'tmpos_invoice_issue.issued_invoice'::regclass)
     is distinct from 'tmpos_invoice_issue.issued_invoice_line.issued_invoice_line_invoice_fkey, tmpos_invoice_void.issued_invoice_void.issued_invoice_void_invoice_fkey' then
    raise exception 'migration 036 rollback refused: 034''s issued header is referenced by a foreign key other than 034''s and 035''s'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$$;

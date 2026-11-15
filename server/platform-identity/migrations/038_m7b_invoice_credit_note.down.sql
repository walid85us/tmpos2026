-- Phase 4.0 M7b — credit notes against an issued store invoice (M7B-CREDITNOTES-P1, CN-P1)
-- Migration: 038_m7b_invoice_credit_note (DOWN)
--
-- Removes exactly what the up file created — schema tmpos_invoice_credit_note with its four tables (the per-store counter rows
-- included: configuration, never money evidence), its sixteen functions and the grants that ride on them; the barrier triggers
-- on tmpos_invoice_payment.invoice_payment and tmpos_invoice_void.issued_invoice_void; the replacement routines record v3,
-- void v3 and payments read v2 in schema tmpos_invoice_payment; and public.audit_event's two indexes and columns
-- subject_invoice_credit_note_id and subject_invoice_credit_note_registration_id — and restores 037's and 036's catalog:
-- tmpos_app holds its EXECUTE on 037's m7b_invoice_payment_record_v2, 036's m7b_invoice_void_v2 and 036's
-- m7b_invoice_payments_get again, each ACL exactly two entries, and the payment, reversal and void tables carry exactly 036's
-- pinned triggers (036 up :143-147, :1900-1913).
--
-- RUN IT WITH THE RUNTIMES STOPPED, as the apply (doc 16, "038 cutover" rollback).
--
-- IT REFUSES, CHANGING NOTHING (any refusal rolls the whole file back):
--   * while migration 038 is not applied, or a routine it restores is missing;
--   * while ANY credit note, withdrawal or credit-note registration, or ANY audit record of action
--     store.invoice_credit_note.register, .issue, .settle or .withdraw or naming either new subject column, exists: removing
--     them would discard money evidence, an unresolved attempt or its audit. AFTER THE FIRST REGISTRATION THIS ROLLBACK IS
--     ONE-WAY: recover forward with a later migration. (Payment-registration audit rows, which exist since 037, do not block it.)
--   * PostgreSQL refuses a statement of section 4 (nothing is dropped with CASCADE), or the postcondition finds 037's catalog
--     inexact.

set local search_path = pg_catalog, pg_temp;
set local row_security = off;

-- =============================================================================
-- 1) The locks, in the writers' order, before any check or change
-- =============================================================================
do $$
begin
  lock table tmpos_invoice_issue.issued_invoice in access exclusive mode;
  lock table tmpos_invoice_void.issued_invoice_void in access exclusive mode;
  lock table tmpos_invoice_payment.invoice_payment in access exclusive mode;
  lock table tmpos_invoice_payment.invoice_payment_reversal in access exclusive mode;
  lock table tmpos_invoice_payment.invoice_payment_registration in access exclusive mode;
  lock table tmpos_invoice_payment.payment_proof_key in access exclusive mode;
  lock table tmpos_invoice_credit_note.invoice_credit_note_registration in access exclusive mode;
  lock table tmpos_invoice_credit_note.invoice_credit_note in access exclusive mode;
  lock table tmpos_invoice_credit_note.invoice_credit_note_withdrawal in access exclusive mode;
  lock table tmpos_invoice_credit_note.invoice_credit_note_counter in access exclusive mode;
  lock table public.audit_event in access exclusive mode;
exception
  when undefined_table or invalid_schema_name then
    raise exception 'migration 038 rollback refused: migration 038 is not applied (a table this file locks is missing)'
      using errcode = 'object_not_in_prerequisite_state';
end
$$;

-- =============================================================================
-- 2) Applied, and the routines it restores are there
-- =============================================================================
do $$
begin
  if pg_catalog.to_regprocedure('tmpos_invoice_payment.m7b_invoice_payment_record_v3(text, uuid, uuid, uuid, uuid, uuid, uuid, bigint, text, text, uuid)') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_payment.m7b_invoice_void_v3(text, uuid, uuid, uuid, bigint, text)') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_payment.m7b_invoice_payments_get_v2(text, uuid, uuid, uuid, uuid, integer)') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_credit_note.m7b_invoice_credit_note_issue(text, uuid, uuid, uuid, uuid, uuid, uuid, bigint, text, text, uuid)') is null
     or (select pg_catalog.count(*) from pg_catalog.pg_attribute a
          where a.attrelid = 'public.audit_event'::regclass and not a.attisdropped
            and a.attname in ('subject_invoice_credit_note_id', 'subject_invoice_credit_note_registration_id')) <> 2 then
    raise exception 'migration 038 rollback refused: migration 038 is not applied (a routine or an audit column is missing)'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if pg_catalog.to_regprocedure('tmpos_invoice_payment.m7b_invoice_payment_record_v2(text, uuid, uuid, uuid, uuid, uuid, uuid, bigint, text, text, uuid)') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_payment.m7b_invoice_void_v2(text, uuid, uuid, uuid, bigint, text)') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_payment.m7b_invoice_payments_get(text, uuid, uuid, uuid, uuid, integer)') is null then
    raise exception 'migration 038 rollback refused: 037''s record v2, 036''s void v2 or 036''s payments read is missing, so there is no 037 catalog to restore'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$$;

-- =============================================================================
-- 3) The guard: no credit note, withdrawal, registration or their audit evidence is ever discarded by a rollback
-- =============================================================================
do $$
begin
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'migration 038 rollback refused: it must run under READ COMMITTED, so that its checks see every committed row'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if exists (select 1 from tmpos_invoice_credit_note.invoice_credit_note)
     or exists (select 1 from tmpos_invoice_credit_note.invoice_credit_note_withdrawal) then
    raise exception 'migration 038 rollback refused: a credit note or a credit-note withdrawal exists, and a rollback never removes one'
      using errcode = 'object_not_in_prerequisite_state',
            hint = 'recover forward with a later migration; never delete or edit the evidence';
  end if;
  if exists (select 1 from tmpos_invoice_credit_note.invoice_credit_note_registration) then
    raise exception 'migration 038 rollback refused: a credit-note registration exists, and a rollback never removes one'
      using errcode = 'object_not_in_prerequisite_state',
            hint = 'recover forward with a later migration; an unresolved attempt is settled through the attempts lookup';
  end if;
  if exists (select 1 from public.audit_event a
              where a.action_id in ('store.invoice_credit_note.register', 'store.invoice_credit_note.issue',
                                    'store.invoice_credit_note.settle', 'store.invoice_credit_note.withdraw')
                 or a.subject_invoice_credit_note_id is not null
                 or a.subject_invoice_credit_note_registration_id is not null) then
    raise exception 'migration 038 rollback refused: an audit record of a credit-note action, or naming a credit note or a credit-note registration, exists'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$$;

-- =============================================================================
-- 4) The retired routines' grants, then the barrier, the replacements, the schema and the audit additions
-- =============================================================================
grant execute on function tmpos_invoice_payment.m7b_invoice_payment_record_v2(text, uuid, uuid, uuid, uuid, uuid, uuid, bigint, text, text, uuid) to tmpos_app;
grant execute on function tmpos_invoice_payment.m7b_invoice_void_v2(text, uuid, uuid, uuid, bigint, text) to tmpos_app;
grant execute on function tmpos_invoice_payment.m7b_invoice_payments_get(text, uuid, uuid, uuid, uuid, integer) to tmpos_app;

drop trigger trg_invoice_payment_credit_note_barrier on tmpos_invoice_payment.invoice_payment;
drop trigger trg_issued_invoice_void_credit_note_barrier on tmpos_invoice_void.issued_invoice_void;

drop function tmpos_invoice_payment.m7b_invoice_payment_record_v3(text, uuid, uuid, uuid, uuid, uuid, uuid, bigint, text, text, uuid);
drop function tmpos_invoice_payment.m7b_invoice_void_v3(text, uuid, uuid, uuid, bigint, text);
drop function tmpos_invoice_payment.m7b_invoice_payments_get_v2(text, uuid, uuid, uuid, uuid, integer);

drop function tmpos_invoice_credit_note.m7b_invoice_credit_note_register(text, uuid, uuid, uuid, uuid, uuid, bigint, text, uuid);
drop function tmpos_invoice_credit_note.m7b_invoice_credit_note_registration_proof(text, uuid, uuid, uuid, uuid, integer);
drop function tmpos_invoice_credit_note.m7b_invoice_credit_note_issue(text, uuid, uuid, uuid, uuid, uuid, uuid, bigint, text, text, uuid);
drop function tmpos_invoice_credit_note.m7b_invoice_credit_note_attempts(text, uuid, uuid, uuid, uuid, integer);
drop function tmpos_invoice_credit_note.m7b_invoice_credit_note_settle(text, uuid, uuid, uuid, uuid, bigint, uuid);
drop function tmpos_invoice_credit_note.m7b_invoice_credit_note_withdraw(text, uuid, uuid, uuid, uuid, bigint, text, uuid);
drop function tmpos_invoice_credit_note.m7b_invoice_credit_notes_list(text, uuid, uuid, uuid, uuid, integer);
drop function tmpos_invoice_credit_note.m7b_invoice_credit_note_registration_proof_message(uuid, uuid, uuid, uuid, uuid, uuid, bytea, bigint, bigint, text);
drop function tmpos_invoice_credit_note.m7b_invoice_credit_note_prerequisites();
drop function tmpos_invoice_credit_note.m7b_invoice_credit_note_payment_barrier();
drop function tmpos_invoice_credit_note.m7b_invoice_credit_note_void_barrier();

-- The tables' own triggers and the foreign keys' internal triggers (on 034's issued_invoice and on public.store) go with the
-- tables; the two credit-note tables reference each other, so they are dropped in one statement.
drop table tmpos_invoice_credit_note.invoice_credit_note_withdrawal;
drop table tmpos_invoice_credit_note.invoice_credit_note, tmpos_invoice_credit_note.invoice_credit_note_registration;
drop table tmpos_invoice_credit_note.invoice_credit_note_counter;
drop function tmpos_invoice_credit_note.m7b_invoice_credit_note_counter_guard();
drop function tmpos_invoice_credit_note.m7b_invoice_credit_note_registration_guard();
drop function tmpos_invoice_credit_note.m7b_invoice_credit_note_guard();
drop function tmpos_invoice_credit_note.m7b_invoice_credit_note_withdrawal_guard();
drop function tmpos_invoice_credit_note.m7b_invoice_credit_note_truncate_guard();
drop schema tmpos_invoice_credit_note;

drop index public.idx_audit_event_subject_invoice_credit_note_occurred;
drop index public.idx_audit_event_subj_invoice_credit_note_registration_occurred;
alter table public.audit_event drop column subject_invoice_credit_note_id;
alter table public.audit_event drop column subject_invoice_credit_note_registration_id;

-- =============================================================================
-- 5) Postcondition: this file removed its own objects and left 037's catalog exactly
-- =============================================================================
do $$
declare
  v_fn oid;
begin
  if pg_catalog.to_regnamespace('tmpos_invoice_credit_note') is not null
     or pg_catalog.to_regclass('public.idx_audit_event_subject_invoice_credit_note_occurred') is not null
     or pg_catalog.to_regclass('public.idx_audit_event_subj_invoice_credit_note_registration_occurred') is not null
     or exists (select 1 from pg_catalog.pg_attribute a
                 where a.attrelid = 'public.audit_event'::regclass and not a.attisdropped
                   and a.attname in ('subject_invoice_credit_note_id', 'subject_invoice_credit_note_registration_id'))
     -- 036's nine functions and 037's fourteen.
     or (select pg_catalog.count(*) from pg_catalog.pg_proc p where p.pronamespace = 'tmpos_invoice_payment'::regnamespace) <> 23 then
    raise exception 'migration 038 rollback refused: an object migration 038 created still exists'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  foreach v_fn in array array[
    'tmpos_invoice_payment.m7b_invoice_payment_record_v2(text, uuid, uuid, uuid, uuid, uuid, uuid, bigint, text, text, uuid)'::regprocedure,
    'tmpos_invoice_payment.m7b_invoice_void_v2(text, uuid, uuid, uuid, bigint, text)'::regprocedure,
    'tmpos_invoice_payment.m7b_invoice_payments_get(text, uuid, uuid, uuid, uuid, integer)'::regprocedure]::oid[]
  loop
    if (select pg_catalog.string_agg(pg_catalog.format('%s/%s/%s/%s', case when g.grantee = p.proowner then 'owner' else g.grantee::regrole::text end,
                                                       g.privilege_type, g.is_grantable, g.grantor = p.proowner), ';'
                                     order by case when g.grantee = p.proowner then 'owner' else g.grantee::regrole::text end collate "C")
          from pg_catalog.pg_proc p, pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g
         where p.oid = v_fn)
       is distinct from 'owner/EXECUTE/f/t;tmpos_app/EXECUTE/f/t' then
      raise exception 'migration 038 rollback refused: a retired routine does not carry exactly its migration''s grants again'
        using errcode = 'object_not_in_prerequisite_state';
    end if;
  end loop;
  -- 036's pinned trigger sets (036 up :1900-1913 for the payment tables, :143-147 for the void table).
  if (select pg_catalog.string_agg(pg_catalog.format('%s:%s:%s:%s:%s', g.tgrelid::regclass::text, g.tgname, g.tgfoid::regprocedure::text, g.tgtype, g.tgenabled), ', '
                                  order by g.tgname::text collate "C")
        from pg_catalog.pg_trigger g
       where g.tgrelid in ('tmpos_invoice_payment.invoice_payment'::regclass, 'tmpos_invoice_payment.invoice_payment_reversal'::regclass)
         and not g.tgisinternal)
     is distinct from
     'tmpos_invoice_payment.invoice_payment:trg_invoice_payment_guard:tmpos_invoice_payment.m7b_invoice_payment_guard():31:A, tmpos_invoice_payment.invoice_payment_reversal:trg_invoice_payment_reversal_guard:tmpos_invoice_payment.m7b_invoice_payment_reversal_guard():31:A, tmpos_invoice_payment.invoice_payment_reversal:trg_invoice_payment_reversal_truncate:tmpos_invoice_payment.m7b_invoice_payment_reversal_truncate_guard():34:A, tmpos_invoice_payment.invoice_payment:trg_invoice_payment_truncate:tmpos_invoice_payment.m7b_invoice_payment_truncate_guard():34:A'
     or (select pg_catalog.string_agg(pg_catalog.format('%s:%s:%s:%s', g.tgname, g.tgfoid::regprocedure::text, g.tgtype, g.tgenabled), ', '
                                     order by g.tgname::text collate "C")
           from pg_catalog.pg_trigger g
          where g.tgrelid = 'tmpos_invoice_void.issued_invoice_void'::regclass and not g.tgisinternal)
        is distinct from 'trg_issued_invoice_void_guard:tmpos_invoice_void.m7b_invoice_void_guard():31:A, trg_issued_invoice_void_truncate:tmpos_invoice_void.m7b_invoice_void_truncate_guard():34:A' then
    raise exception 'migration 038 rollback refused: the payment, reversal or void table does not carry exactly migration 036''s pinned triggers again'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$$;

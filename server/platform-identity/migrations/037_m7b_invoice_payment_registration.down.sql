-- Phase 4.0 M7b — payment registration (PRQ-1, M7B-PAYMENTS-P2)
-- Migration: 037_m7b_invoice_payment_registration (DOWN)
--
-- Removes exactly what the up file created — the six routines with the grants that ride on them, the three helpers, the six
-- triggers and their five functions, the tables invoice_payment_registration, payment_proof_key and
-- payment_proof_key_generation (with the owner's installed key and its generation history: configuration, never money
-- evidence), and public.audit_event's index idx_audit_event_subject_invoice_payment_registration_occurred and column
-- subject_invoice_payment_registration_id — and restores 036's catalog: tmpos_app holds its EXECUTE on 036's
-- m7b_invoice_payment_record again, its ACL exactly 036's two entries. Schema tmpos_invoice_payment stays (036's).
--
-- RUN IT WITH THE TENANT RUNTIME STOPPED, as the apply.
--
-- IT REFUSES, CHANGING NOTHING (any refusal rolls the whole file back):
--   * while migration 037 is not applied, or 036's record is missing;
--   * while ANY registration, or ANY audit record of action store.invoice_payment.register or store.invoice_payment.settle or
--     naming a registration, exists: removing them would discard an unresolved attempt or its audit evidence. No path removes
--     one, so AFTER THE FIRST REGISTRATION THIS ROLLBACK IS ONE-WAY. (No registration means no proof was ever valid, so
--     dropping the generation history revives nothing.)
--   * PostgreSQL refuses a statement of section 4 (nothing is dropped with CASCADE), or the postcondition finds 036's
--     catalog inexact.

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
  lock table tmpos_invoice_payment.payment_proof_key_generation in access exclusive mode;
  lock table public.audit_event in access exclusive mode;
exception
  when undefined_table or invalid_schema_name then
    raise exception 'migration 037 rollback refused: migration 037 is not applied (a table this file locks is missing)'
      using errcode = 'object_not_in_prerequisite_state';
end
$$;

-- =============================================================================
-- 2) Applied, and 036's record is there to restore
-- =============================================================================
do $$
begin
  if pg_catalog.to_regprocedure('tmpos_invoice_payment.m7b_invoice_payment_register(text, uuid, uuid, uuid, uuid, uuid, uuid)') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_payment.m7b_invoice_payment_registration_proof(text, uuid, uuid, uuid, uuid, integer)') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_payment.m7b_invoice_payment_record_v2(text, uuid, uuid, uuid, uuid, uuid, uuid, bigint, text, text, uuid)') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_payment.m7b_invoice_payment_attempts(text, uuid, uuid, uuid, uuid, integer)') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_payment.m7b_invoice_payment_settle(text, uuid, uuid, uuid, uuid, bigint, uuid)') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_payment.m7b_payment_proof_key_probe()') is null
     or not exists (select 1 from pg_catalog.pg_attribute a
                     where a.attrelid = 'public.audit_event'::regclass and a.attname = 'subject_invoice_payment_registration_id'
                       and not a.attisdropped) then
    raise exception 'migration 037 rollback refused: migration 037 is not applied (a routine or the audit column is missing)'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if pg_catalog.to_regprocedure('tmpos_invoice_payment.m7b_invoice_payment_record(text, uuid, uuid, uuid, uuid, uuid, bigint, text, uuid)') is null then
    raise exception 'migration 037 rollback refused: migration 036''s record is missing, so there is no 036 catalog to restore'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$$;

-- =============================================================================
-- 3) The guard: no registration or its audit evidence is ever discarded by a rollback
-- =============================================================================
do $$
begin
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'migration 037 rollback refused: it must run under READ COMMITTED, so that its checks see every committed row'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if exists (select 1 from tmpos_invoice_payment.invoice_payment_registration) then
    raise exception 'migration 037 rollback refused: a payment registration exists, and a rollback never removes one'
      using errcode = 'object_not_in_prerequisite_state',
            hint = 'an unresolved attempt is settled through the attempts list; removing a registration is an owner decision, not a rollback''s side effect';
  end if;
  if exists (select 1 from public.audit_event a
              where a.action_id in ('store.invoice_payment.register', 'store.invoice_payment.settle')
                 or a.subject_invoice_payment_registration_id is not null) then
    raise exception 'migration 037 rollback refused: an audit record of a registration action, or naming a registration, exists'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$$;

-- =============================================================================
-- 4) 036's record grant, then the routines, helpers, triggers, tables and the audit additions
-- =============================================================================
grant execute on function tmpos_invoice_payment.m7b_invoice_payment_record(text, uuid, uuid, uuid, uuid, uuid, bigint, text, uuid) to tmpos_app;

revoke execute on function tmpos_invoice_payment.m7b_invoice_payment_register(text, uuid, uuid, uuid, uuid, uuid, uuid) from tmpos_app;
revoke execute on function tmpos_invoice_payment.m7b_invoice_payment_registration_proof(text, uuid, uuid, uuid, uuid, integer) from tmpos_app;
revoke execute on function tmpos_invoice_payment.m7b_invoice_payment_record_v2(text, uuid, uuid, uuid, uuid, uuid, uuid, bigint, text, text, uuid) from tmpos_app;
revoke execute on function tmpos_invoice_payment.m7b_invoice_payment_attempts(text, uuid, uuid, uuid, uuid, integer) from tmpos_app;
revoke execute on function tmpos_invoice_payment.m7b_invoice_payment_settle(text, uuid, uuid, uuid, uuid, bigint, uuid) from tmpos_app;
revoke execute on function tmpos_invoice_payment.m7b_payment_proof_key_probe() from tmpos_app;
drop function tmpos_invoice_payment.m7b_invoice_payment_register(text, uuid, uuid, uuid, uuid, uuid, uuid);
drop function tmpos_invoice_payment.m7b_invoice_payment_registration_proof(text, uuid, uuid, uuid, uuid, integer);
drop function tmpos_invoice_payment.m7b_invoice_payment_record_v2(text, uuid, uuid, uuid, uuid, uuid, uuid, bigint, text, text, uuid);
drop function tmpos_invoice_payment.m7b_invoice_payment_attempts(text, uuid, uuid, uuid, uuid, integer);
drop function tmpos_invoice_payment.m7b_invoice_payment_settle(text, uuid, uuid, uuid, uuid, bigint, uuid);
drop function tmpos_invoice_payment.m7b_payment_proof_key_probe();
drop function tmpos_invoice_payment.m7b_payment_writer(text, uuid);
drop function tmpos_invoice_payment.m7b_payment_levels_ok(uuid, text);
drop function tmpos_invoice_payment.m7b_payment_registration_proof_message(uuid, uuid, uuid, uuid, uuid, uuid, bytea, bigint);

drop trigger trg_invoice_payment_registration_guard on tmpos_invoice_payment.invoice_payment_registration;
drop trigger trg_invoice_payment_registration_truncate on tmpos_invoice_payment.invoice_payment_registration;
drop trigger trg_payment_proof_key_shape on tmpos_invoice_payment.payment_proof_key;
drop trigger trg_payment_proof_key_install on tmpos_invoice_payment.payment_proof_key;
drop trigger trg_payment_proof_key_generation_guard on tmpos_invoice_payment.payment_proof_key_generation;
drop trigger trg_payment_proof_key_generation_truncate on tmpos_invoice_payment.payment_proof_key_generation;
drop function tmpos_invoice_payment.m7b_invoice_payment_registration_guard();
drop function tmpos_invoice_payment.m7b_invoice_payment_registration_truncate_guard();
drop function tmpos_invoice_payment.m7b_payment_proof_key_shape_guard();
drop function tmpos_invoice_payment.m7b_payment_proof_key_install_guard();
drop function tmpos_invoice_payment.m7b_payment_proof_key_generation_guard();

-- The foreign keys' internal triggers (on 034's issued_invoice and 036's invoice_payment) go with the table.
drop table tmpos_invoice_payment.invoice_payment_registration;
drop table tmpos_invoice_payment.payment_proof_key;
drop table tmpos_invoice_payment.payment_proof_key_generation;

drop index public.idx_audit_event_subject_invoice_payment_registration_occurred;
alter table public.audit_event drop column subject_invoice_payment_registration_id;

-- =============================================================================
-- 5) Postcondition: this file removed its own objects and left 036's catalog exactly
-- =============================================================================
do $$
declare
  v_record oid := 'tmpos_invoice_payment.m7b_invoice_payment_record(text, uuid, uuid, uuid, uuid, uuid, bigint, text, uuid)'::regprocedure;
begin
  if pg_catalog.to_regclass('tmpos_invoice_payment.invoice_payment_registration') is not null
     or pg_catalog.to_regclass('tmpos_invoice_payment.payment_proof_key') is not null
     or pg_catalog.to_regclass('tmpos_invoice_payment.payment_proof_key_generation') is not null
     or pg_catalog.to_regclass('public.idx_audit_event_subject_invoice_payment_registration_occurred') is not null
     or exists (select 1 from pg_catalog.pg_attribute a
                 where a.attrelid = 'public.audit_event'::regclass and a.attname = 'subject_invoice_payment_registration_id'
                   and not a.attisdropped)
     or (select pg_catalog.count(*) from pg_catalog.pg_proc p where p.pronamespace = 'tmpos_invoice_payment'::regnamespace) <> 9 then
    raise exception 'migration 037 rollback refused: an object migration 037 created still exists'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if (select pg_catalog.string_agg(pg_catalog.format('%s/%s/%s/%s', case when g.grantee = p.proowner then 'owner' else g.grantee::regrole::text end,
                                                     g.privilege_type, g.is_grantable, g.grantor = p.proowner), ';'
                                   order by case when g.grantee = p.proowner then 'owner' else g.grantee::regrole::text end collate "C")
        from pg_catalog.pg_proc p, pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g
       where p.oid = v_record)
     is distinct from 'owner/EXECUTE/f/t;tmpos_app/EXECUTE/f/t' then
    raise exception 'migration 037 rollback refused: migration 036''s record does not carry exactly 036''s grants again'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$$;

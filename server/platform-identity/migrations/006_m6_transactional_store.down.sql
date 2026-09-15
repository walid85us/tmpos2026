-- Phase 4.0 M6 — PostgreSQL transactional store
-- Migration: 006_m6_transactional_store (DOWN)
--
-- Removes exactly what the up file created: the two tables (with their indexes, grants and policies)
-- and the store clock. Roles, audit_event and everything 001-005 created are untouched; the audit
-- records of committed commands stay, because audit_event is append-only and is not this file's.
--
-- REFUSES WHILE THE STORE HOLDS WORK IT WOULD DESTROY. Dropping an undelivered event loses it, and
-- dropping an idempotency record still within its retention turns a retry of a completed operation
-- into a second execution. So the rollback runs only on a store that holds neither; draining one is an
-- operator decision this file does not make. The refusal aborts the whole transaction before anything
-- is dropped. Both tables are locked first, so no transaction can add work between the check and the drop —
-- in the order a command takes them (the record, then the outbox), so a command in flight finishes first
-- instead of deadlocking with this rollback.

lock table public.idempotency_record, public.outbox_event in access exclusive mode;

do $$
begin
  if exists (select 1 from public.outbox_event where status in ('pending', 'claimed')) then
    raise exception 'migration 006 rollback refused: the outbox holds undelivered events'
      using errcode = 'object_in_use',
            hint = 'deliver or dead-letter every event first; this rollback never discards one';
  end if;

  if exists (select 1 from public.idempotency_record where expires_at > pg_catalog.clock_timestamp()) then
    raise exception 'migration 006 rollback refused: idempotency records are still within their retention'
      using errcode = 'object_in_use',
            hint = 'wait out the retention period; dropping a retained record would let a retry run again';
  end if;
end
$$;

drop table public.outbox_event;
drop table public.idempotency_record;
drop function public.m6_store_clock();

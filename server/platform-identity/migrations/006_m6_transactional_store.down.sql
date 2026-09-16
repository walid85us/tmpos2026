-- Phase 4.0 M6 — PostgreSQL transactional store
-- Migration: 006_m6_transactional_store (DOWN)
--
-- Removes exactly what the up file created: the two tables (with their indexes and the transition guard's
-- trigger), the nine lifecycle routines (with their grants), the store clock, the guard function and the
-- tmpos_internal schema. Roles,
-- audit_event and everything 001-005 created are untouched; the audit records of committed commands stay,
-- because audit_event is append-only and is not this file's. The schema goes last and without CASCADE: if
-- anything this file did not create lives in it, the drop fails and the whole rollback with it.
--
-- REFUSES WHILE THE STORE HOLDS WORK IT WOULD DESTROY. Dropping an undelivered event loses it, and
-- dropping an idempotency record still within its retention turns a retry of a completed operation
-- into a second execution. So the rollback runs only on a store that holds neither; draining one is an
-- operator decision this file does not make. The refusal aborts the whole transaction before anything
-- is dropped. Both tables are locked first, so no transaction can add work between the check and the drop —
-- in the order a command takes them (the record, then the outbox), so a command in flight finishes first
-- instead of deadlocking with this rollback. The applier's search_path is never relied on: SET LOCAL pins
-- resolution to pg_catalog until this transaction ends, so an operator an earlier schema of that path
-- defines cannot answer the refusal.

set local search_path = pg_catalog, pg_temp;

lock table tmpos_internal.idempotency_record, tmpos_internal.outbox_event in access exclusive mode;

do $$
begin
  if exists (select 1 from tmpos_internal.outbox_event where status in ('pending', 'claimed')) then
    raise exception 'migration 006 rollback refused: the outbox holds undelivered events'
      using errcode = 'object_in_use',
            hint = 'deliver or dead-letter every event first; this rollback never discards one';
  end if;

  if exists (select 1 from tmpos_internal.idempotency_record where expires_at > pg_catalog.clock_timestamp()) then
    raise exception 'migration 006 rollback refused: idempotency records are still within their retention'
      using errcode = 'object_in_use',
            hint = 'wait out the retention period; dropping a retained record would let a retry run again';
  end if;
end
$$;

drop table tmpos_internal.outbox_event;
drop table tmpos_internal.idempotency_record;
drop function tmpos_internal.m6_idempotency_acquire(text, text, text, bigint, bigint);
drop function tmpos_internal.m6_idempotency_complete(text, text, text);
drop function tmpos_internal.m6_command_fence(text, text);
drop function tmpos_internal.m6_command_enqueue(text, text, uuid, text, integer, text, uuid, bigint, text, text, text, uuid, jsonb);
drop function tmpos_internal.m6_outbox_claim(text, integer, bigint);
drop function tmpos_internal.m6_outbox_acknowledge(uuid, text);
drop function tmpos_internal.m6_outbox_retry(uuid, text, bigint);
drop function tmpos_internal.m6_outbox_dead_letter(uuid, text, text);
drop function tmpos_internal.m6_store_probe();
drop function tmpos_internal.outbox_event_transition_guard();
drop function tmpos_internal.m6_store_clock();
drop schema tmpos_internal;

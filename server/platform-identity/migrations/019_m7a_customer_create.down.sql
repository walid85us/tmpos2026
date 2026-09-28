-- Phase 4.0 M7a — tenant customer creation
-- Migration: 019_m7a_customer_create (DOWN)
--
-- Removes exactly what the up file created: the create routine with the grant that rides on it, and schema
-- tmpos_customer_write that held it. Nothing else is touched — not 017's tmpos_customer or its table, not 018's
-- tmpos_mint, not 016's tmpos_session, not a table, a role or a grant issued by 001-018.
--
-- IT DOES NOT REFUSE WHILE CUSTOMERS EXIST, unlike 017's rollback. This file created no table: a customer created through
-- its routine is a row of 017's tmpos_customer.customer, and it stays exactly where it is. Removing the write path deletes
-- no business record, and 017's own rollback keeps refusing while any customer exists. No lock and no isolation guard is
-- needed for the same reason: there is nothing this file owns that holds data. A create already running when the routine
-- is dropped finishes on the code it started with and commits its customer, which is an ordinary customer of 017's table.
--
-- WHAT IT COSTS, STATED. Runtime code built for 019 has no routine to call: every POST /api/v1/customers answers 503. And
-- the startup preflight of BOTH entries (tenant and admin) pins 019's two grants (postgresStartupPreflight.ts
-- APPROVED_ROLE_GRANTS) and 019's ledger row, so after this rollback a restart of either refuses (role_privilege_missing),
-- the admin entry included, which has no customer route — until the code rolls back too. Reads are unaffected while a
-- running process keeps serving.
--
-- ROLL 019 BACK FIRST. Its postcondition requires the objects 016-018 own. Rolled back out of order (016, 017 or 018
-- while 019 is applied, which the database does not prevent: a PL/pgSQL body records no dependency), this file refuses
-- until those migrations are applied again; re-apply them, then roll 019 back.
--
-- The applier's search_path is never relied on: every name below is schema-qualified and SET LOCAL pins resolution to
-- pg_catalog until this transaction ends. Revoking before dropping is redundant — a dropped object keeps no ACL — but it
-- is written out so the rollback states the privilege change it makes.

set local search_path = pg_catalog, pg_temp;

-- =============================================================================
-- 1) The routine
-- =============================================================================
revoke execute on function tmpos_customer_write.m7a_customer_create(text, uuid, text) from tmpos_app;
drop function tmpos_customer_write.m7a_customer_create(text, uuid, text);

-- =============================================================================
-- 2) The schema
-- =============================================================================
-- WITHOUT CASCADE: if anything this file did not create lives in it, the drop fails and the whole rollback with it,
-- rather than taking an unknown object down silently.
revoke usage on schema tmpos_customer_write from tmpos_app;
drop schema tmpos_customer_write;

-- =============================================================================
-- 3) Postcondition: this file removed its own objects and nothing else
-- =============================================================================
-- It checks PRESENCE, not definition, and only of a selection: that the schema this file created is gone, and that the
-- objects of migrations 016-018 the routine used — the customer table and its read among them — are still there. Each of
-- those migrations' own rollback owns the rest.
do $$
begin
  if pg_catalog.to_regnamespace('tmpos_customer_write') is not null then
    raise exception 'migration 019 rollback refused: schema tmpos_customer_write still exists'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if pg_catalog.to_regclass('tmpos_customer.customer') is null
     or pg_catalog.to_regprocedure('tmpos_customer.m7a_customer_page(uuid, text, uuid, text, uuid, uuid, integer)') is null
     or pg_catalog.to_regprocedure('tmpos_mint.m7a_customer_page_v2(text, uuid, integer)') is null
     or pg_catalog.to_regprocedure('tmpos_mint.m7a_session_create(text, text, text, text, text, text, bigint, bigint, bigint, bigint, bigint, bytea)') is null
     or pg_catalog.to_regclass('tmpos_mint.tenant_session') is null
     or pg_catalog.to_regclass('tmpos_mint.issuer_key') is null
     or pg_catalog.to_regprocedure('tmpos_session.m5_admit_tenant_session_v2(text, text)') is null
     or pg_catalog.to_regprocedure('tmpos_session.m5_hold_tenant_standing(text, text)') is null
     or pg_catalog.to_regclass('tmpos_session.session') is null then
    raise exception 'migration 019 rollback refused: it removed something migrations 016-018 own (roll 019 back before them)'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$$;

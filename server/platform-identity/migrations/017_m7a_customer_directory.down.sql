-- Phase 4.0 M7a — the tenant customer directory
-- Migration: 017_m7a_customer_directory (DOWN)
--
-- Removes exactly what the up file created: the customer page routine with the grant that rides on it, the customer
-- table with its index, and the schema tmpos_customer that held them. Nothing else is touched — not migration 016's
-- tmpos_session objects or triggers, not 012's tmpos_directory, not 007's tmpos_identity, not a table, a role or a grant
-- issued by 001-016.
--
-- IT REFUSES WHILE ANY CUSTOMER ROW EXISTS. Unlike 012, whose routine only read, this file's table holds business
-- records, and dropping it would delete every one of them with no trace. A rollback is never the way to remove customer
-- data: it refuses, and the records stay, until they are removed deliberately under whatever retention decision governs
-- them. The table is locked first (ACCESS EXCLUSIVE, which the DROP takes anyway), so no row can be inserted between the
-- check and the drop, and the check runs only under READ COMMITTED: there its statement takes a snapshot AFTER the lock
-- is held, so it sees every committed row, whereas a REPEATABLE READ or SERIALIZABLE transaction could hold a snapshot
-- older than the lock and see an empty table that is not. It also runs with row_security off: the table has row
-- security with no policy, so if that were ever FORCED on an applier that is not a superuser and lacks BYPASSRLS, the
-- check would otherwise see no row at all; with row_security off PostgreSQL refuses such a query instead of filtering
-- it, so the rollback fails rather than dropping records it could not see. With no row, what the rollback costs is stated rather than
-- implied: afterwards the runtime's customer directory adapter has no routine to call, so every customer listing is an
-- outage (a bounded 503) until 017 is applied again.
--
-- LOCKS. Dropping the table also drops its foreign key, whose triggers live on public.tenant, so the DROP takes ACCESS
-- EXCLUSIVE on public.tenant too. Both are taken up front, public.tenant first — the order the page routine reads them
-- in — so the rollback cannot deadlock with a page read. A customer INSERT locks the table first and public.tenant
-- second (its foreign-key check), the opposite order, so it can deadlock with the rollback; PostgreSQL detects that and
-- aborts one side, losing nothing (only tests write customers today). While the rollback runs no login, admission or
-- command can use public.tenant: run it in a maintenance window.
--
-- The applier's search_path is never relied on: every name below is schema-qualified and SET LOCAL pins resolution to
-- pg_catalog until this transaction ends. Revoking before dropping is redundant — a dropped object keeps no ACL — but it
-- is written out so the rollback states the privilege change it makes.

set local search_path = pg_catalog, pg_temp;
set local row_security = off;

-- =============================================================================
-- 1) The guard: no customer record is ever deleted by a rollback
-- =============================================================================
lock table public.tenant in access exclusive mode;
lock table tmpos_customer.customer in access exclusive mode;

do $$
begin
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'migration 017 rollback refused: it must run under READ COMMITTED, so that its check sees every committed customer row'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if exists (select 1 from tmpos_customer.customer) then
    raise exception 'migration 017 rollback refused: tmpos_customer.customer holds customer records, and a rollback never deletes business data'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$$;

-- =============================================================================
-- 2) The routine
-- =============================================================================
revoke execute on function tmpos_customer.m7a_customer_page(uuid, text, uuid, text, uuid, uuid, integer) from tmpos_app;
drop function tmpos_customer.m7a_customer_page(uuid, text, uuid, text, uuid, uuid, integer);

-- =============================================================================
-- 3) The table (its index goes with it)
-- =============================================================================
drop table tmpos_customer.customer;

-- =============================================================================
-- 4) The schema
-- =============================================================================
-- WITHOUT CASCADE: if anything this file did not create lives in it, the drop fails and the whole rollback with it,
-- rather than taking an unknown object down silently.
revoke usage on schema tmpos_customer from tmpos_app;
drop schema tmpos_customer;

-- =============================================================================
-- 5) Postcondition: this file removed its own objects and nothing else
-- =============================================================================
-- It checks PRESENCE, not definition: that the schema this file created is gone, and that the objects migrations 007,
-- 012 and 016 own are still there. Each of those migrations' own rollback owns the rest.
do $$
begin
  if pg_catalog.to_regnamespace('tmpos_customer') is not null then
    raise exception 'migration 017 rollback refused: schema tmpos_customer still exists'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if pg_catalog.to_regprocedure('tmpos_session.m5_admit_tenant_session_v2(text, text)') is null
     or pg_catalog.to_regprocedure('tmpos_session.m5_hold_tenant_standing(text, text)') is null
     or pg_catalog.to_regprocedure('tmpos_directory.m5_tenant_directory_page(uuid, text, uuid, text, uuid, integer)') is null
     or pg_catalog.to_regprocedure('tmpos_identity.m5_security_version(uuid)') is null
     or pg_catalog.to_regclass('public.tenant') is null then
    raise exception 'migration 017 rollback refused: it removed something migrations 007-016 own'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$$;

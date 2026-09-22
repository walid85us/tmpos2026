-- Phase 4.0 M6 — the distributed rate-limit store
-- Migration: 014_m6_distributed_rate_limit (DOWN)
--
-- Removes exactly what the up file created: the consume, probe and reclaim routines (with the grants that ride on
-- them), the key check, the bucket table (with its expiry index), the key-fingerprint table — and so the registered
-- fingerprint — and the schema tmpos_rate_limit that held them. Nothing else is touched: not migration 013's
-- tmpos_admission, not a table, a role or a grant issued by 001-013.
--
-- IT REFUSES WHILE ANY BUCKET IS STILL INSIDE ITS WINDOW. Dropping a live bucket hands its client a fresh allowance
-- the moment the store is back — a login limit reset mid-window is exactly what the limiter exists to prevent — so the
-- rollback runs only on a store whose every window has closed. The remedy is not to force this file: it is to stop the
-- traffic the limiter serves and wait for the longest live window to close (five minutes for the runtime's
-- source-defined limits, one hour at most for any bucket the store admits), then roll back. Expired buckets are
-- dropped with the table; they limit nothing.
--
-- THE LOCKS ARE PART OF THE CHECK: a bare test would not stop a consume opening a window between the test and the
-- drop. Both tables are locked ACCESS EXCLUSIVE, in the order a consume takes them — the fingerprint, then the
-- buckets — so a consume in flight finishes first instead of deadlocking with this rollback, and none starts until
-- this transaction ends. The LOCK is its own statement, before the guard: it takes no snapshot, so at READ COMMITTED
-- the guard's count — a fresh snapshot — sees every consume that committed while the lock was awaited. At a stricter
-- level an earlier statement of the applier's transaction could already have fixed the snapshot and hidden such a
-- window, so the file refuses first unless it runs at READ COMMITTED (the migration executor's plain BEGIN, unless the
-- database's default says otherwise). On a store where 014 is absent the LOCK itself fails, and the whole file with
-- it, having changed nothing.
--
-- WHAT THE ROLLBACK COSTS EVEN WHEN IT PROCEEDS. Afterwards the limiter adapter has no routine to call, so every
-- protected request is a bounded 503 and readiness fails until 014 is applied again — closed, never open. The
-- registered key fingerprint goes with it: the next application registers whichever key reaches it first. That is a
-- deliberate, operator-run migration, never an automatic reset.
--
-- The applier's search_path is never relied on: every name below is schema-qualified and SET LOCAL pins resolution to
-- pg_catalog until this transaction ends. Revoking before dropping is redundant — a dropped object keeps no ACL — but it
-- is written out so the rollback states the privilege change it makes.

set local search_path = pg_catalog, pg_temp;

-- =============================================================================
-- 1) Refuse while any bucket is inside its window
-- =============================================================================
do $$
begin
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'migration 014 rollback refused: it runs only at READ COMMITTED, where its check sees every window opened while its lock was awaited'
      using errcode = 'object_not_in_prerequisite_state',
            hint = 'run the rollback in a READ COMMITTED transaction';
  end if;
end
$$;

lock table tmpos_rate_limit.key_fingerprint, tmpos_rate_limit.bucket in access exclusive mode;

do $$
declare
  v_live bigint;
begin
  select pg_catalog.count(*) into v_live
    from tmpos_rate_limit.bucket b
   where b.expires_at > pg_catalog.clock_timestamp();

  if v_live > 0 then
    raise exception 'migration 014 rollback refused: % rate-limit bucket(s) are still inside their window, and dropping them would hand their clients a fresh allowance', v_live
      using errcode = 'object_in_use',
            hint = 'stop the traffic the limiter serves and wait for the longest live window to close, then roll back; this rollback never discards a live limit';
  end if;
end
$$;

-- =============================================================================
-- 2) The routines
-- =============================================================================
revoke execute on function tmpos_rate_limit.m6_rate_limit_consume(bytea, text, text, text, integer, integer, integer) from tmpos_app;
revoke execute on function tmpos_rate_limit.m6_rate_limit_probe(bytea) from tmpos_app;
revoke execute on function tmpos_rate_limit.m6_rate_limit_reclaim() from tmpos_app;
drop function tmpos_rate_limit.m6_rate_limit_consume(bytea, text, text, text, integer, integer, integer);
drop function tmpos_rate_limit.m6_rate_limit_probe(bytea);
drop function tmpos_rate_limit.m6_rate_limit_reclaim();
drop function tmpos_rate_limit.m6_rate_limit_key_admits(bytea);

-- =============================================================================
-- 3) The tables, then the schema
-- =============================================================================
drop table tmpos_rate_limit.bucket;
drop table tmpos_rate_limit.key_fingerprint;

-- WITHOUT CASCADE: if anything this file did not create lives in it, the drop fails and the whole rollback with it,
-- rather than taking an unknown object down silently.
revoke usage on schema tmpos_rate_limit from tmpos_app;
drop schema tmpos_rate_limit;

-- =============================================================================
-- 4) Postcondition: this file removed its own objects and nothing else
-- =============================================================================
-- It checks PRESENCE, not definition: that what this file created is gone, and that the objects migrations 011-013
-- own are still there. Each of those migrations' own rollback owns the rest.
do $$
begin
  if pg_catalog.to_regnamespace('tmpos_rate_limit') is not null then
    raise exception 'migration 014 rollback refused: schema tmpos_rate_limit still exists'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if pg_catalog.to_regprocedure('tmpos_admission.m5_admit_platform_session(text, text)') is null
     or pg_catalog.to_regprocedure('tmpos_directory.m5_tenant_directory_page(uuid, text, uuid, text, uuid, integer)') is null
     or pg_catalog.to_regclass('tmpos_session.session') is null then
    raise exception 'migration 014 rollback refused: it removed something migrations 011-013 own'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$$;

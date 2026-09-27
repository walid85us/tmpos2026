-- Phase 4.0 M7a — the tenant session mint
-- Migration: 018_m7a_tenant_session_mint (DOWN)
--
-- Removes exactly what the up file created — the three granted routines with the grants that ride on them, the two
-- helpers, the issuer key table, the mint ledger with its index, and schema tmpos_mint — and gives tmpos_app back the two
-- EXECUTE grants the up file revoked: 011's m5_session_create and 017's m7a_customer_page. Issued by the same owner, they
-- are the same ACL items 011 and 017 left. Nothing else is touched — not 011's or 016's tmpos_session objects, not 017's
-- tmpos_customer, not a table, a role or a grant issued by 001-017.
--
-- IT REFUSES WHILE THE KEY OR THE LEDGER HOLDS A ROW. A rollback never silently discards the installed issuer key or the
-- replay ledger: the remedy is a deliberate owner delete, and after it a FRESH key, never the old one, is installed when
-- 018 is applied again (docs/phase-4/10 ADR-33). The emptiness test needs no clock (011's reason). Both tables are locked
-- first (ACCESS EXCLUSIVE, which the DROP takes anyway), so no row can be written between the check and the drop, and the
-- check runs only under READ COMMITTED, where its statement's snapshot is taken after the locks are held (017's reason).
-- It runs with row_security off, so a table whose row security were FORCEd on a non-owner applier makes the rollback fail
-- instead of hiding rows from the check.
--
-- WHAT IT COSTS, STATED. Restoring the two grants re-opens exactly what the up file closed (doc 08 DA-83): tmpos_app can
-- again create any session and list any tenant's customers from a tuple it builds. And runtime code built for 018 has no
-- tmpos_mint.m7a_session_create to call, so every login of either audience answers 503 until the code rolls back too.
--
-- The applier's search_path is never relied on: every name below is schema-qualified and SET LOCAL pins resolution to
-- pg_catalog until this transaction ends. Revoking before dropping is redundant — a dropped object keeps no ACL — but it
-- is written out so the rollback states the privilege change it makes.

set local search_path = pg_catalog, pg_temp;
set local row_security = off;

-- =============================================================================
-- 1) The guard: the key and the ledger are never discarded by a rollback
-- =============================================================================
lock table tmpos_mint.issuer_key in access exclusive mode;
lock table tmpos_mint.tenant_session in access exclusive mode;

do $$
begin
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'migration 018 rollback refused: it must run under READ COMMITTED, so that its check sees every committed key and ledger row'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if exists (select 1 from tmpos_mint.issuer_key) or exists (select 1 from tmpos_mint.tenant_session) then
    raise exception 'migration 018 rollback refused: the issuer key or the mint ledger still holds a row'
      using errcode = 'object_not_in_prerequisite_state',
            hint = 'the owner deletes the installed key and the ledger deliberately, then rolls back';
  end if;
end
$$;

-- =============================================================================
-- 2) The routines
-- =============================================================================
revoke execute on function tmpos_mint.m7a_session_create(text, text, text, text, text, text, bigint, bigint, bigint, bigint, bigint, bytea) from tmpos_app;
revoke execute on function tmpos_mint.m7a_customer_page_v2(text, uuid, integer) from tmpos_app;
revoke execute on function tmpos_mint.m7a_issuer_key_check(bytea) from tmpos_app;
drop function tmpos_mint.m7a_session_create(text, text, text, text, text, text, bigint, bigint, bigint, bigint, bigint, bytea);
drop function tmpos_mint.m7a_customer_page_v2(text, uuid, integer);
drop function tmpos_mint.m7a_issuer_key_check(bytea);
drop function tmpos_mint.mint_message(text, text, text, text, text, text, bigint, bigint, bigint, bigint, bigint);
drop function tmpos_mint.hmac_sha256(bytea, bytea);

-- =============================================================================
-- 3) The tables (the index goes with its table)
-- =============================================================================
drop table tmpos_mint.tenant_session;
drop table tmpos_mint.issuer_key;

-- =============================================================================
-- 4) The schema
-- =============================================================================
-- WITHOUT CASCADE: if anything this file did not create lives in it, the drop fails and the whole rollback with it,
-- rather than taking an unknown object down silently.
revoke usage on schema tmpos_mint from tmpos_app;
drop schema tmpos_mint;

-- =============================================================================
-- 5) The two grants the up file revoked
-- =============================================================================
grant execute on function tmpos_session.m5_session_create(text, text, text, text, text, text, bigint, bigint, bigint, bigint, bigint) to tmpos_app;
grant execute on function tmpos_customer.m7a_customer_page(uuid, text, uuid, text, uuid, uuid, integer) to tmpos_app;

-- =============================================================================
-- 6) Postcondition: this file removed its own objects, restored its two grants, and nothing else
-- =============================================================================
-- It checks PRESENCE, not definition: that the schema this file created is gone, that tmpos_app holds the two grants
-- again, and that the objects migrations 011, 016 and 017 own are still there. Each of those migrations' own rollback
-- owns the rest.
do $$
begin
  if pg_catalog.to_regnamespace('tmpos_mint') is not null then
    raise exception 'migration 018 rollback refused: schema tmpos_mint still exists'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if not pg_catalog.has_function_privilege('tmpos_app',
           'tmpos_session.m5_session_create(text, text, text, text, text, text, bigint, bigint, bigint, bigint, bigint)'::regprocedure, 'EXECUTE')
     or not pg_catalog.has_function_privilege('tmpos_app',
           'tmpos_customer.m7a_customer_page(uuid, text, uuid, text, uuid, uuid, integer)'::regprocedure, 'EXECUTE') then
    raise exception 'migration 018 rollback refused: tmpos_app does not hold EXECUTE on 011''s create and 017''s page again'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if pg_catalog.to_regprocedure('tmpos_session.m5_admit_tenant_session_v2(text, text)') is null
     or pg_catalog.to_regprocedure('tmpos_session.m5_hold_tenant_standing(text, text)') is null
     or pg_catalog.to_regclass('tmpos_session.session') is null
     or pg_catalog.to_regclass('tmpos_customer.customer') is null then
    raise exception 'migration 018 rollback refused: it removed something migrations 011-017 own'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$$;

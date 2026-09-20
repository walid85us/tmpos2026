-- Phase 4.0 M5 — rollback of the tenant lifecycle command (M5-GIAM-D1-P2)
-- Migration: 010_m5_tenant_lifecycle_command (DOWN)
--
-- Restores exactly the state migration 010 found: the lifecycle operation is dropped and the access version
-- column with it, and nothing 005-009 established is touched. 008's two routines, 009's two, 009's audit
-- subject column, 005's grants and every tenant status value already stored stay as they are.
--
-- IT REFUSES WHILE A TENANT IS SUSPENDED (binding). Dropping this migration takes away the only operation
-- that can reactivate a tenant: a row left in 'suspended' would keep that status with nothing able to clear
-- it, and its people would stay locked out with no sanctioned path back. So this file refuses, loudly
-- (55006), while any tenant is suspended, and the operator must reactivate each one through the command
-- first — a remedy that actually clears the refusal, which is the point of naming one.
--
-- What it does NOT refuse, deliberately: an access_version that has MOVED. Reactivating raises the version
-- rather than resetting it — it must, or a session admitted before the suspension would match again — so a
-- version test would be uncleanable by the very remedy above, and a single suspension anywhere would make
-- the chain unrollbackable forever. Rolling back therefore DOES discard the witness: after it, a tenant/store
-- session admitted before the last transition is no longer distinguishable from one admitted after it. That
-- is the cost of removing the mechanism, it is stated here rather than hidden behind an unclearable error,
-- and the operator who rolls back should revoke the tenant sessions issued before it.
--
-- The chain rolls back newest first (owner decision D4): this file runs before 009's and 008's, so
-- tmpos_command still holds 008's and 009's routines when it finishes, and 008's own rollback — which drops
-- the schema WITHOUT CASCADE — stays correct.

-- =============================================================================
-- 0) This transaction's search path
-- =============================================================================
set local search_path = pg_catalog, pg_temp;

-- =============================================================================
-- 1) Refuse while any lifecycle state would be lost
-- =============================================================================
-- The lock is taken FIRST and for the whole transaction, so no command can suspend a tenant between the
-- check and the drop: ACCESS EXCLUSIVE conflicts with the row locks the lifecycle operation takes.
lock table public.tenant in access exclusive mode;

do $$
declare
  v_suspended bigint;
  v_moved bigint;
begin
  if not exists (select 1 from pg_catalog.pg_attribute a
                  where a.attrelid = 'public.tenant'::regclass and a.attname = 'access_version' and not a.attisdropped) then
    -- Already rolled back, or never applied: nothing below has anything to drop.
    return;
  end if;

  select pg_catalog.count(*) into v_suspended from public.tenant t where t.status = 'suspended';
  select pg_catalog.count(*) into v_moved from public.tenant t where t.access_version <> 1;

  if v_suspended > 0 then
    -- object_in_use (55006), as 008's and 009's rollbacks refuse: live state is using what this would drop.
    raise exception 'migration 010 rollback refused: % tenant(s) are suspended, and dropping this migration removes the only operation that can reactivate them', v_suspended
      using errcode = 'object_in_use',
            hint = 'reactivate every suspended tenant through the command first, then roll back';
  end if;

  if v_moved > 0 then
    -- NOT a refusal: reactivating raises the version rather than resetting it, so no sanctioned remedy could
    -- ever clear a version test and the chain would be unrollbackable forever. It IS a loss, so it is said
    -- out loud rather than hidden behind an error nobody can clear.
    raise warning 'migration 010 rollback: % tenant(s) have a moved access version; after this rollback a session admitted before their last transition is no longer distinguishable from one admitted after it', v_moved;
  end if;
end
$$;

-- =============================================================================
-- 2) The lifecycle operation
-- =============================================================================
drop function if exists tmpos_command.m5_tenant_status_change(uuid, bigint, text, text);

-- =============================================================================
-- 3) The tenant access version
-- =============================================================================
-- Its CHECK constraint goes with the column.
alter table public.tenant drop column if exists access_version;

-- =============================================================================
-- 4) Verify — the 009 state is what remains
-- =============================================================================
do $$
declare
  v_count integer;
begin
  if pg_catalog.to_regprocedure('tmpos_command.m5_tenant_status_change(uuid, bigint, text, text)') is not null
     or exists (select 1 from pg_catalog.pg_attribute a
                 where a.attrelid = 'public.tenant'::regclass and a.attname = 'access_version' and not a.attisdropped)
     or exists (select 1 from pg_catalog.pg_constraint k
                 where k.conrelid = 'public.tenant'::regclass and k.conname = 'tenant_access_version_chk') then
    raise exception 'migration 010 rollback refused: the lifecycle operation or its column is still present'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- What 008 and 009 built is untouched: their four routines, and 008's trigger still ENABLE ALWAYS.
  select pg_catalog.count(*)::integer into v_count
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'tmpos_command';
  if v_count <> 4
     or pg_catalog.to_regprocedure('tmpos_command.m5_tenant_display_name_update_v2(uuid, bigint, text)') is null
     or pg_catalog.to_regprocedure('tmpos_command.m5_revalidate_platform_authority(uuid, text, uuid, text)') is null
     or not exists (select 1 from pg_catalog.pg_trigger g
                     where g.tgrelid = 'public.tenant'::regclass
                       and g.tgname = 'trg_tenant_row_version' and g.tgenabled = 'A') then
    raise exception 'migration 010 rollback refused: the 008/009 command surface is not what this file found'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$$;

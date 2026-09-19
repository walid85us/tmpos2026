-- Phase 4.0 M5 — the first server-authorized business command: a tenant's display name
-- (owner decision D1, M5-GIAM-D1-P1; G-IAM, G-IDEMPOT, G-AUDIT; docs/phase-4/10 ADR-20)
-- Migration: 008_m5_tenant_display_name_command (UP)
--
-- SCOPE / TRUTH (binding):
--   - ONE COLUMN, ONE TRIGGER, TWO ROUTINES, ONE SCHEMA. This file adds the tenant's row version to
--     public.tenant, a trigger that alone moves it, and its own internal schema, tmpos_command, holding
--     the trigger's function and the one fixed operation the runtime may call. It creates no table, no
--     type, no role and no role membership, and alters nothing 001-007 created beyond adding that one
--     column and its trigger to public.tenant. Migrations 005, 006 and 007 are untouched, byte for
--     byte, and so are their schemas: nothing here lives in tmpos_internal or tmpos_identity, whose
--     rollbacks drop them WITHOUT CASCADE and whose verify sections enumerate them exactly.
--   - WHY IT EXISTS. The command updates a tenant at an expected version, and public.tenant has no
--     version (002 section tenant). And the runtime role cannot make the write itself: migration 005
--     grants tmpos_app a column UPDATE on display_name and legal_name only under its tenant-scope RLS policy, and
--     the runtime principal never operates at platform scope (005 section 9), so a platform command's
--     UPDATE would match no row at all. The answer migrations 006 and 007 already use is the one here:
--     a SECURITY DEFINER routine owned by the applying principal, EXECUTE to tmpos_app alone, doing one
--     fixed thing and answering one bounded row.
--   - THE ROUTINE DECIDES NOTHING ABOUT WHO. It checks the argument shape, locks the tenant row, and
--     answers not_found, conflict (another version), unchanged (the name is already this one) or
--     applied. Authority is decided before it runs: the runtime's canonical platform authorization at
--     the chain, then the command transaction's revalidation of the trusted context (007 section 3)
--     after the idempotency fence (006) — so no permission policy lives in SQL, as in 007.
--   - THE VERSION BELONGS TO THE TRIGGER. Every UPDATE of a tenant row that changes anything but the
--     version and updated_at moves the version by exactly one; one that changes nothing keeps it;
--     whatever value an UPDATE names for it is overwritten. So the version is a concurrency token for
--     every writer of the row — the command routine, 005's tenant-scope column grant and the owner
--     alike — and no writer can set it. tmpos_app has no privilege on the column (section 6 checks it).
--   - NOTHING IS LOGGED AND NOTHING DISCLOSES. The routine raises nothing for a business answer; it
--     returns one row. A malformed argument is answered 'invalid', never an exception carrying it.
--   - NO SECRET, NO DYNAMIC SQL, NO EXTENSION, NO TEMPORARY OBJECT. Every statement is fixed text, every
--     value a parameter, every name schema-qualified, and each function pins its search_path to
--     pg_catalog then pg_temp.
--
-- Reversible via 008_m5_tenant_display_name_command.down.sql, which refuses while any tenant has
-- moved past version 1 (a re-apply would restart every version at 1, so a stale expected version could
-- match again) and otherwise removes exactly what this file created.
--
-- Assumes 001-007 are applied: public.tenant exists with 002's columns and 005's grants, and the
-- NOLOGIN role tmpos_app exists (005). A future managed apply targets the complete contiguous chain
-- through the newest committed migration (owner decision D4); this file authorizes no apply.

-- =============================================================================
-- 0) This transaction's search path
-- =============================================================================
set local search_path = pg_catalog, pg_temp;

-- =============================================================================
-- 1) The schema
-- =============================================================================
-- Its own, not 006's or 007's: both of those drop their schema WITHOUT CASCADE on rollback and verify
-- its functions as exactly their own, so anything placed there would make them un-rollbackable while
-- this file is applied. Owned by the principal that applies this file; USAGE to tmpos_app alone.
create schema tmpos_command;

comment on schema tmpos_command is
  'Phase 4.0 M5: fixed business-command operations (migration 008). Internal: USAGE to tmpos_app alone, owned by the migration principal. Holds routines only — no table, no type.';

-- Every project role's schema privileges are revoked first, whatever the applying principal's default
-- privileges granted, so USAGE below is the only one any of them holds; section 6 verifies the whole ACL.
revoke all on schema tmpos_command from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
grant usage on schema tmpos_command to tmpos_app;

-- =============================================================================
-- 2) The tenant's row version
-- =============================================================================
-- A constant default adds the column without rewriting the table (PostgreSQL 11+); every existing row
-- starts at 1, the first version a command may expect. The bound is the largest integer the runtime
-- carries exactly (Number.MAX_SAFE_INTEGER), the same bound 006 puts on an event's aggregate version.
alter table public.tenant
  add column row_version bigint not null default 1
    constraint tenant_row_version_chk check (row_version between 1 and 9007199254740991);

comment on column public.tenant.row_version is
  'Phase 4.0 M5 (migration 008): optimistic-concurrency version of the whole tenant row. Moved only by trg_tenant_row_version: +1 on any UPDATE that changes a column other than row_version and updated_at, unchanged otherwise. No role may set it.';

-- =============================================================================
-- 3) The trigger that owns the version
-- =============================================================================
-- SECURITY INVOKER and granted to nobody: a trigger function fires without an EXECUTE grant, and it
-- reads no relation, so it needs no privilege of its own. The comparison is over the whole row as
-- jsonb minus the two columns a write moves on its own (this version, and 002's updated_at, which its
-- own trigger refreshes on every UPDATE), so a column added to public.tenant later is covered too.
create function tmpos_command.m5_tenant_row_version()
returns trigger
language plpgsql
volatile
security invoker
set search_path = pg_catalog, pg_temp
as $$
begin
  if (pg_catalog.to_jsonb(new) operator(pg_catalog.-) 'row_version'::text operator(pg_catalog.-) 'updated_at'::text)
     is distinct from
     (pg_catalog.to_jsonb(old) operator(pg_catalog.-) 'row_version'::text operator(pg_catalog.-) 'updated_at'::text) then
    new.row_version := old.row_version operator(pg_catalog.+) 1;
  else
    new.row_version := old.row_version;
  end if;
  return new;
end
$$;

comment on function tmpos_command.m5_tenant_row_version() is
  'Phase 4.0 M5 (migration 008): BEFORE UPDATE trigger on public.tenant. Moves row_version by exactly one when the row changes, keeps it otherwise, and overwrites any value an UPDATE names for it.';

create trigger trg_tenant_row_version
  before update on public.tenant
  for each row execute function tmpos_command.m5_tenant_row_version();

-- ALWAYS, as 006 does for its guard: the version moves even for a session running as a replica.
alter table public.tenant enable always trigger trg_tenant_row_version;

-- =============================================================================
-- 4) The one fixed operation
-- =============================================================================
-- CALLED ONLY FROM THE COMMAND TRANSACTION, after the idempotency fence and the trusted context's
-- revalidation (server/persistence/postgresTransactionalStore.ts), through the command's mutator
-- (server/persistence/tenantDisplayNameMutator.ts). It takes the target tenant, the version the
-- caller expects and the name, trimmed and validated by the runtime; the shape is re-checked here —
-- including no leading or trailing whitespace — so the routine never writes a value the command
-- contract refuses, even when called directly.
--
-- ORDER (binding): the row is locked FOR UPDATE before anything is compared, so two commands at one
-- expected version serialize on it and at most one moves it — the second re-reads the moved row once
-- the first commits and answers 'conflict'. The version is compared before the name: a caller whose
-- expected version is stale learns 'conflict' even when its name happens to match, so a stale view
-- never reads as current. Only 'applied' writes, and the trigger in section 3 moves the version.
--
-- ANSWERS (one row, always): ('invalid', null) for a malformed argument, ('not_found', null),
-- ('conflict', null), ('unchanged', the current version) or ('applied', the new version).
create function tmpos_command.m5_tenant_display_name_update(
  p_tenant_id uuid,
  p_expected_version bigint,
  p_display_name text)
returns table (o_outcome text, o_version bigint)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_name text;
  v_version bigint;
begin
  -- The argument shape: the runtime's own contract (1-120 Unicode scalar values, no control
  -- character, no line or paragraph separator, and no leading or trailing character that ECMAScript's
  -- String.prototype.trim removes), re-checked. A UTF-8 database stores no lone surrogate.
  if p_tenant_id is null
     or p_expected_version is null
     or p_expected_version operator(pg_catalog.<) 1
     or p_expected_version operator(pg_catalog.>) 9007199254740990
     or p_display_name is null
     or pg_catalog.char_length(p_display_name) operator(pg_catalog.<) 1
     or pg_catalog.char_length(p_display_name) operator(pg_catalog.>) 120
     or p_display_name operator(pg_catalog.~) '[\u0001-\u001f\u007f-\u009f\u2028\u2029]'
     or p_display_name operator(pg_catalog.~) '^[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]|[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]$' then
    return query select 'invalid'::text, null::bigint;
    return;
  end if;

  select t.display_name, t.row_version into v_name, v_version
    from public.tenant t
   where t.tenant_id operator(pg_catalog.=) p_tenant_id
     for update;

  if not found then
    return query select 'not_found'::text, null::bigint;
    return;
  end if;

  if v_version operator(pg_catalog.<>) p_expected_version then
    return query select 'conflict'::text, null::bigint;
    return;
  end if;

  if v_name is not distinct from p_display_name then
    return query select 'unchanged'::text, v_version;
    return;
  end if;

  update public.tenant t
     set display_name = p_display_name
   where t.tenant_id operator(pg_catalog.=) p_tenant_id
  returning t.row_version into v_version;

  return query select 'applied'::text, v_version;
end
$$;

comment on function tmpos_command.m5_tenant_display_name_update(uuid, bigint, text) is
  'Phase 4.0 M5 (migration 008): updates one tenant''s display name at an expected row version, under a FOR UPDATE lock. One row: invalid | not_found | conflict | unchanged (current version) | applied (new version). Decides no authority: the command transaction has already fenced the idempotency lease and revalidated the actor.';

-- =============================================================================
-- 5) Privileges — the operation to the runtime role, nothing else
-- =============================================================================
-- Explicit revokes first, whatever the applying principal's default privileges are (acldefault()
-- grants EXECUTE on a function to PUBLIC). tmpos_app gains EXECUTE on the operation and USAGE on the
-- schema, and nothing on public.tenant beyond what 005 already gave it — in particular nothing on
-- row_version, which section 6 checks.
revoke all on function tmpos_command.m5_tenant_row_version() from public, anon, authenticated, tmpos_app;
revoke all on function tmpos_command.m5_tenant_display_name_update(uuid, bigint, text) from public, anon, authenticated;

grant execute on function tmpos_command.m5_tenant_display_name_update(uuid, bigint, text) to tmpos_app;

-- =============================================================================
-- 6) Verify — these objects are what sections 1-5 say, and nothing else holds them
-- =============================================================================
-- It refuses to finish while:
--   * a role the runtime could hold is a member of the schema's owner in any form — inherited, or
--     SET-only (INHERIT FALSE, SET TRUE), which USAGE does not report but SET ROLE still exploits — since
--     either hands it the owner's reach without a grant;
--   * the schema's ACL grants any role but the owner anything other than tmpos_app's non-grantable USAGE;
--   * tmpos_command holds anything but this file's two functions, or either one is owned by anyone
--     but the schema's owner, is not pinned to pg_catalog then pg_temp, or differs from its section in
--     SECURITY DEFINER or volatility;
--   * a function's ACL carries a direct grant to any role but the owner, other than tmpos_app's
--     non-grantable EXECUTE on the operation;
--   * the trigger is not exactly one BEFORE UPDATE row trigger on public.tenant, enabled ALWAYS,
--     calling section 3's function;
--   * row_version is not a non-null bigint defaulting to 1, or tmpos_app may write it.
do $$
declare
  v_owner oid;
  v_bad text;
  v_count integer;
begin
  select n.nspowner into v_owner from pg_catalog.pg_namespace n where n.nspname = 'tmpos_command';
  if v_owner is null then
    raise exception 'migration 008 refused: the schema tmpos_command does not exist'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  select pg_catalog.string_agg(r.rolname::text, ', ' order by r.rolname) into v_bad
    from pg_catalog.pg_roles r
   where r.rolname in ('tmpos_app', 'tmpos_audit_writer', 'anon', 'authenticated')
     and pg_catalog.pg_has_role(r.oid, v_owner, 'MEMBER');

  if v_bad is not null then
    raise exception 'migration 008 refused: % is a member of the schema owner', v_bad
      using errcode = 'object_not_in_prerequisite_state',
            hint = 'membership would hand the runtime role every privilege the owner holds, including a direct write of every tenant column';
  end if;

  select pg_catalog.string_agg(coalesce(a.grantee::regrole::text, '?') || ':' || a.privilege_type, ', ') into v_bad
    from pg_catalog.pg_namespace n
    cross join pg_catalog.aclexplode(coalesce(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) a
   where n.nspname = 'tmpos_command'
     and a.grantee <> v_owner
     and not (a.grantee = 'tmpos_app'::regrole::oid and a.privilege_type = 'USAGE' and a.is_grantable = false);

  if v_bad is not null then
    raise exception 'migration 008 refused: an unexpected privilege remains on the schema tmpos_command (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state',
            hint = 'only tmpos_app may hold USAGE on the schema, never CREATE and never WITH GRANT OPTION';
  end if;

  select pg_catalog.count(*)::integer into v_count
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'tmpos_command';

  if v_count <> 2 then
    raise exception 'migration 008 refused: tmpos_command holds % functions, not this file''s two', v_count
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  select pg_catalog.string_agg(t.label, ', ' order by t.label) into v_bad
    from (
      select p.proname::text as label
        from pg_catalog.pg_proc p
        join pg_catalog.pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'tmpos_command'
         and (
              p.proname not in ('m5_tenant_row_version', 'm5_tenant_display_name_update')
           or p.proowner <> v_owner
           or p.proconfig is distinct from array['search_path=pg_catalog, pg_temp']::text[]
           or p.prosecdef <> (p.proname = 'm5_tenant_display_name_update')
           or p.provolatile <> 'v'
         )
    ) t;

  if v_bad is not null then
    raise exception 'migration 008 refused: a routine does not match its declaration (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state',
            hint = 'the two functions must be owned by the schema owner, pinned to pg_catalog then pg_temp, VOLATILE, and SECURITY DEFINER exactly for the operation';
  end if;

  select pg_catalog.string_agg(t.label, ', ' order by t.label) into v_bad
    from (
      select p.proname::text || ' -> ' || coalesce(a.grantee::regrole::text, '?') as label
        from pg_catalog.pg_proc p
        join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        cross join pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
       where n.nspname = 'tmpos_command'
         and a.grantee <> v_owner
         and not (
              a.grantee = 'tmpos_app'::regrole::oid
          and a.privilege_type = 'EXECUTE'
          and a.is_grantable = false
          and p.proname = 'm5_tenant_display_name_update'
         )
    ) t;

  if v_bad is not null then
    raise exception 'migration 008 refused: an unexpected direct grant remains on a routine (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state',
            hint = 'only tmpos_app may hold EXECUTE, only on the operation, and never WITH GRANT OPTION';
  end if;

  select pg_catalog.count(*)::integer into v_count
    from pg_catalog.pg_trigger g
    join pg_catalog.pg_proc p on p.oid = g.tgfoid
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where g.tgrelid = 'public.tenant'::regclass
     and not g.tgisinternal
     and n.nspname = 'tmpos_command';

  if v_count <> 1 or not exists (
    select 1
      from pg_catalog.pg_trigger g
      join pg_catalog.pg_proc p on p.oid = g.tgfoid
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where g.tgrelid = 'public.tenant'::regclass
       and g.tgname = 'trg_tenant_row_version'
       and n.nspname = 'tmpos_command'
       and p.proname = 'm5_tenant_row_version'
       and g.tgenabled = 'A'
       -- tgtype bits: ROW (1), BEFORE (2), UPDATE (16) — and no INSERT (4), DELETE (8) or TRUNCATE (32).
       and g.tgtype::integer = 19
  ) then
    raise exception 'migration 008 refused: public.tenant does not carry exactly the row-version trigger section 3 declares'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  if not exists (
    select 1
      from pg_catalog.pg_attribute a
      join pg_catalog.pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
     where a.attrelid = 'public.tenant'::regclass
       and a.attname = 'row_version'
       and not a.attisdropped
       and a.atttypid = 'pg_catalog.int8'::regtype
       and a.attnotnull
       and pg_catalog.pg_get_expr(d.adbin, d.adrelid) = '1'
  ) then
    raise exception 'migration 008 refused: public.tenant.row_version is not the non-null bigint defaulting to 1 that section 2 declares'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  if pg_catalog.has_column_privilege('tmpos_app', 'public.tenant', 'row_version', 'UPDATE')
     or pg_catalog.has_column_privilege('tmpos_app', 'public.tenant', 'row_version', 'INSERT') then
    raise exception 'migration 008 refused: tmpos_app may write public.tenant.row_version'
      using errcode = 'object_not_in_prerequisite_state',
            hint = 'the version is the trigger''s alone; revoke the table-wide or column grant that reaches it';
  end if;
end
$$;

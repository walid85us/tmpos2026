-- Phase 4.0 M5 — the tenant lifecycle command: suspension, reactivation, and the access version that ends
-- a suspended tenant's sessions (M5-GIAM-D1-P2; G-IAM, GAP-13, G-AUDIT; docs/phase-4/10 ADR-22)
-- Migration: 010_m5_tenant_lifecycle_command (UP)
--
-- SCOPE / TRUTH (binding):
--   - ONE ROUTINE, ONE COLUMN, ONE PRIVILEGE GRANT. This file adds one routine to 008's schema,
--     tmpos_command — the fixed operation the tenant status command commits through — and one column,
--     public.tenant.access_version. It grants EXECUTE on that routine to tmpos_app and revokes the default
--     PUBLIC execute; it creates no table, no type, no role and no role membership, and it grants NO column
--     privilege to anyone. Migrations 005, 006, 007, 008 and 009 are untouched, byte for byte.
--   - NOTHING IS REVOKED, BECAUSE NOTHING REACHES THESE COLUMNS. 005 grants tmpos_app exactly
--     `select` on public.tenant and `update (display_name, legal_name)`; 009 revoked the display_name half.
--     No role these migrations own holds any privilege on tenant.status, and access_version is created here
--     with none — so the status of a tenant has never been writable outside a fixed operation, and this file
--     keeps it that way rather than narrowing something. Section 5 proves it rather than asserting it: it
--     refuses to finish while any runtime-holdable role can UPDATE or INSERT either column. legal_name is
--     left exactly as 005 wrote it (DA-29): an unrelated privilege is not removed without proof it is obsolete.
--   - WHY IT JOINS 008's SCHEMA. The routine extends the same command surface 008 and 009 built, and 008's
--     rollback drops tmpos_command WITHOUT CASCADE: while this file is applied, that rollback refuses loudly
--     instead of leaving this routine behind. The chain rolls back newest first (owner decision D4), so
--     010's own rollback always runs before 009's and 008's.
--   - EXACTLY TWO TRANSITIONS. The operation moves a tenant from 'active' to 'suspended' or from 'suspended'
--     to 'active', and refuses every other pair — including a target equal to the status the row already
--     holds, which is an invalid transition and never a no-op. The other four values of 002's
--     tenant_status_chk ('trialing', 'overdue', 'read_only', 'pending_activation') are neither reachable nor
--     a state a transition may start from: a row holding one answers invalid_state and nothing is written.
--     The runtime states the same rule (server/runtime/tenantStatus.ts) and derives the from-status in
--     trusted source; this file is the half that cannot be bypassed.
--   - THE ACCESS VERSION. access_version is the witness a tenant/store session is admitted against. It moves
--     by exactly one on every suspension and every reactivation, in the same statement as the status, and it
--     never returns to a value it has held — so a session admitted before a transition is stale after it,
--     and reactivation cannot revive a session that suspension ended. It is DISTINCT from row_version on
--     purpose: row_version moves on every field edit (008's trigger), and a display-name change must not
--     end anyone's session. No role may write it; only this operation moves it.
--   - ROW_VERSION STILL MOVES EXACTLY ONCE. 008's trg_tenant_row_version (enable always) adds one to
--     row_version on any UPDATE that changes a column other than row_version and updated_at. This
--     operation's single UPDATE changes status and access_version together, so row_version moves once, not
--     twice, and the caller's expected version is the one the command answered with.
--   - NO SECRET, NO DYNAMIC SQL, NO EXTENSION, NO TEMPORARY OBJECT. Every statement is fixed text, every
--     value a parameter, every relation and function schema-qualified, and the routine pins its search_path
--     to pg_catalog then pg_temp.
--
-- Reversible via 010_m5_tenant_lifecycle_command.down.sql, which REFUSES while any tenant is suspended —
-- rolling back removes the only operation that could reactivate one — and otherwise restores exactly the 009
-- state, warning loudly when any access version has moved, because after the rollback a session admitted
-- before that tenant's last transition is no longer distinguishable from one admitted after it.
--
-- Assumes 001-009 are applied. A future managed apply targets the complete contiguous chain through the
-- newest committed migration — now 001-010 (owner decision D4); this file authorizes no apply.

-- =============================================================================
-- 0) This transaction's search path
-- =============================================================================
set local search_path = pg_catalog, pg_temp;

-- =============================================================================
-- 1) Preconditions: what this file builds on
-- =============================================================================
do $$
begin
  if pg_catalog.to_regprocedure('tmpos_command.m5_tenant_display_name_update_v2(uuid, bigint, text)') is null
     or pg_catalog.to_regprocedure('tmpos_command.m5_revalidate_platform_authority(uuid, text, uuid, text)') is null
     or not exists (select 1 from pg_catalog.pg_attribute a
                     where a.attrelid = 'public.tenant'::regclass and a.attname = 'row_version' and not a.attisdropped) then
    raise exception 'migration 010 refused: migrations 008 and 009 must be applied first'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$$;

-- =============================================================================
-- 2) The tenant access version
-- =============================================================================
-- A constant default, so no row is rewritten and no row trigger fires (002's updated_at trigger and 008's
-- row-version trigger are BEFORE UPDATE; ADD COLUMN is neither).
alter table public.tenant
  add column access_version bigint not null default 1
    constraint tenant_access_version_chk check (access_version between 1 and 9007199254740991);

comment on column public.tenant.access_version is
  'Phase 4.0 M5 (migration 010): the tenant access version — the witness a tenant/store session is admitted against. Moved by exactly one by tmpos_command.m5_tenant_status_change on every suspension and every reactivation, and by nothing else; never returns to a value it has held, so a session admitted before a transition is stale after it. Distinct from row_version, which moves on every field edit: a display-name change must end no session. No role holds a privilege on this column.';

-- =============================================================================
-- 3) The tenant lifecycle operation
-- =============================================================================
-- CALLED ONLY FROM THE COMMAND TRANSACTION, after the idempotency fence and after the trusted context has
-- been revalidated on that same transaction (server/persistence/tenantStatusMutator.ts). Its arguments are
-- the command's server-validated target and its transition; the from-status is derived in trusted source
-- from the target, never taken from a request. It decides NO authority: who may call it is settled before it
-- runs, and holding EXECUTE is not permission to suspend anything.
--
-- LOCKS: the tenant row FOR UPDATE, before it is read, and held until the transaction ends — so a competing
-- command waits, and the version this operation compares is the version it writes against. The audit record,
-- the outbox event and the idempotency completion are written by the same transaction while that lock is
-- held (server/persistence/postgresTransactionalStore.ts), so either all of them land or none does.
--
-- ONE ROW OUT: invalid | not_found | conflict | invalid_state | applied (the new row version).
create function tmpos_command.m5_tenant_status_change(
  p_tenant_id uuid,
  p_expected_version bigint,
  p_from_status text,
  p_to_status text
)
returns table (o_outcome text, o_version bigint)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_status text;
  v_version bigint;
begin
  -- The closed transition set, restated here so it holds whatever calls this: exactly the two pairs, a
  -- canonical target, and a version inside the runtime's safe-integer range.
  if p_tenant_id is null
     or p_expected_version is null
     or p_expected_version operator(pg_catalog.<) 1
     or p_expected_version operator(pg_catalog.>) 9007199254740990
     or p_from_status is null
     or p_to_status is null
     or not ((p_from_status operator(pg_catalog.=) 'active' and p_to_status operator(pg_catalog.=) 'suspended')
          or (p_from_status operator(pg_catalog.=) 'suspended' and p_to_status operator(pg_catalog.=) 'active')) then
    return query select 'invalid'::text, null::bigint;
    return;
  end if;

  select t.status, t.row_version into v_status, v_version
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

  -- The row must hold exactly the status this transition starts from. A row already holding the target is
  -- refused here too: asking for the state a tenant is already in is an invalid transition, not a no-op, so
  -- this operation never answers 'unchanged' and the command carries no unchanged response to record.
  if v_status is distinct from p_from_status then
    return query select 'invalid_state'::text, null::bigint;
    return;
  end if;

  -- One statement: the status and the access version move together, and 008's trigger moves row_version
  -- exactly once for the pair.
  update public.tenant t
     set status = p_to_status,
         access_version = t.access_version operator(pg_catalog.+) 1
   where t.tenant_id operator(pg_catalog.=) p_tenant_id
  returning t.row_version into v_version;

  return query select 'applied'::text, v_version;
end
$$;

comment on function tmpos_command.m5_tenant_status_change(uuid, bigint, text, text) is
  'Phase 4.0 M5 (migration 010): the tenant lifecycle operation. Moves one tenant between active and suspended at an expected row version, under a FOR UPDATE lock, raising the access version by exactly one in the same statement. One row: invalid | not_found | conflict | invalid_state | applied (new row version). Refuses every transition but active<->suspended, including a target equal to the current status. Decides no authority.';

-- =============================================================================
-- 4) Privileges
-- =============================================================================
-- Explicit revoke first, whatever the applying principal's default privileges are (acldefault() grants
-- EXECUTE on a function to PUBLIC). No column privilege is granted to anyone, here or anywhere: the status
-- and the access version are reachable only through the operation above.
revoke all on function tmpos_command.m5_tenant_status_change(uuid, bigint, text, text) from public, anon, authenticated;

grant execute on function tmpos_command.m5_tenant_status_change(uuid, bigint, text, text) to tmpos_app;

-- =============================================================================
-- 5) Verify — what sections 2-4 say holds, and nothing else reaches it
-- =============================================================================
-- It refuses to finish while:
--   * a role the runtime could hold (tmpos_app, tmpos_audit_writer, anon, authenticated) is a MEMBER — in any
--     form, SET-only included — of the owner of tmpos_command or of public.tenant: an owner's reach needs no
--     grant, and would be a direct write of every tenant column;
--   * tmpos_command holds anything but 008's two functions, 009's two and this file's one, or one of them is
--     owned by anyone but the schema's owner, is not pinned to pg_catalog then pg_temp, is not VOLATILE, or
--     differs in SECURITY DEFINER (every routine but the row-version trigger's);
--   * this file's routine carries a direct grant to anyone but its owner, other than tmpos_app's
--     non-grantable EXECUTE;
--   * the schema's owner cannot run it (SELECT and UPDATE on public.tenant — a row lock needs UPDATE), or
--     is SUBJECT to that table's row security, which has_table_privilege does not report: a definer the
--     policies restrict would match no row and every call would answer not_found;
--   * either lifecycle column carries ANY direct grant, read from the catalog rather than through
--     has_column_privilege, which follows only inheritable membership and would miss a SET-only path;
--   * any of those four roles, directly, through a membership or through PUBLIC, may UPDATE or INSERT
--     public.tenant.status or public.tenant.access_version, or DELETE a tenant row (a delete-and-re-insert
--     would reset both). The four are the roles these migrations own; who the runtime LOGIN is, and what it
--     is a member of, is role topology verified live against that principal (gate G-DBROLE), exactly as
--     005-009 state;
--   * access_version is not a non-null bigint under its CHECK, or 008's row-version trigger is missing or no
--     longer ENABLE ALWAYS — this operation's single UPDATE depends on it moving row_version exactly once.
do $$
declare
  v_owner oid;
  v_bad text;
  v_count integer;
  v_roles name[] := array['tmpos_app', 'tmpos_audit_writer', 'anon', 'authenticated']::name[];
begin
  select n.nspowner into v_owner from pg_catalog.pg_namespace n where n.nspname = 'tmpos_command';
  if v_owner is null then
    raise exception 'migration 010 refused: the schema tmpos_command does not exist'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  select pg_catalog.string_agg(distinct r.rolname::text, ', ') into v_bad
    from pg_catalog.pg_roles r
    cross join (
      select n.nspowner as owner from pg_catalog.pg_namespace n where n.nspname = 'tmpos_command'
      union
      select c.relowner from pg_catalog.pg_class c where c.oid = 'public.tenant'::regclass
    ) o
   where r.rolname = any (v_roles)
     and pg_catalog.pg_has_role(r.oid, o.owner, 'MEMBER');

  if v_bad is not null then
    raise exception 'migration 010 refused: % is a member of an owner this routine or its table depends on', v_bad
      using errcode = 'object_not_in_prerequisite_state',
            hint = 'membership hands a role everything the owner holds, including a direct write of every tenant column';
  end if;

  -- The schema holds exactly the five routines 008, 009 and this file define, each owned by the schema's
  -- owner, pinned, volatile, and SECURITY DEFINER except the row-version trigger's.
  select pg_catalog.count(*)::integer into v_count
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid operator(pg_catalog.=) p.pronamespace
   where n.nspname operator(pg_catalog.=) 'tmpos_command';
  if v_count operator(pg_catalog.<>) 5 then
    raise exception 'migration 010 refused: tmpos_command holds % routines, not the five 008, 009 and 010 define', v_count
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  select pg_catalog.string_agg(p.proname::text, ', ') into v_bad
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid operator(pg_catalog.=) p.pronamespace
   where n.nspname operator(pg_catalog.=) 'tmpos_command'
     and (p.proowner operator(pg_catalog.<>) v_owner
          or p.proconfig is distinct from array['search_path=pg_catalog, pg_temp']::text[]
          or p.provolatile operator(pg_catalog.<>) 'v'
          or p.prosecdef operator(pg_catalog.<>) (p.proname operator(pg_catalog.<>) 'm5_tenant_row_version')
          or p.proname not in ('m5_tenant_row_version', 'm5_tenant_display_name_update',
                               'm5_revalidate_platform_authority', 'm5_tenant_display_name_update_v2',
                               'm5_tenant_status_change'));
  if v_bad is not null then
    raise exception 'migration 010 refused: % is not owned, pinned and defined as sections 3-4 declare', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- This file's routine answers its owner and tmpos_app, and nobody else; the grant carries no grant option.
  select pg_catalog.string_agg(coalesce(a.grantee::regrole::text, '?') || ':' || a.privilege_type, ', ') into v_bad
    from pg_catalog.pg_proc p
    cross join pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
   where p.oid operator(pg_catalog.=) 'tmpos_command.m5_tenant_status_change(uuid, bigint, text, text)'::regprocedure
     and a.grantee is distinct from v_owner
     and not (a.grantee operator(pg_catalog.=) 'tmpos_app'::regrole::oid
              and a.privilege_type operator(pg_catalog.=) 'EXECUTE'
              and not a.is_grantable);
  if v_bad is not null then
    raise exception 'migration 010 refused: the lifecycle operation is reachable by % beyond its owner and tmpos_app', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- Its owner must be able to run it: the definer's rights are what make the operation the only path.
  if not pg_catalog.has_table_privilege(v_owner::regrole::name, 'public.tenant', 'SELECT')
     or not pg_catalog.has_table_privilege(v_owner::regrole::name, 'public.tenant', 'UPDATE') then
    raise exception 'migration 010 refused: the owner of tmpos_command cannot read and lock public.tenant'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- has_table_privilege ignores ROW SECURITY, and public.tenant has RLS enabled with policies scoped to
  -- tmpos_app (migration 005). A definer that holds the grants but is subject to those policies would match
  -- no row, so every call would answer not_found and this file would have certified an operation that can
  -- never succeed. The owner must therefore be the table's own owner (whom RLS does not restrict unless the
  -- table forces it) or hold BYPASSRLS — and the table must not FORCE row security on its owner.
  if not exists (
    select 1 from pg_catalog.pg_class c
     where c.oid operator(pg_catalog.=) 'public.tenant'::regclass
       and not c.relforcerowsecurity
       and (c.relowner operator(pg_catalog.=) v_owner
            or exists (select 1 from pg_catalog.pg_roles r where r.oid operator(pg_catalog.=) v_owner and r.rolbypassrls))) then
    raise exception 'migration 010 refused: the owner of tmpos_command is subject to public.tenant''s row security, so the operation would match no row'
      using errcode = 'object_not_in_prerequisite_state',
            hint = 'the definer must own public.tenant or hold BYPASSRLS, and the table must not force row security on its owner';
  end if;

  -- The column privileges themselves, read from the catalog rather than through has_column_privilege, which
  -- follows only INHERITABLE membership: a SET-only grant of some third role holding UPDATE on either column
  -- is invisible to that function and visible here. No grantee but the table's owner may appear at all.
  select pg_catalog.string_agg(distinct coalesce(a.grantee::regrole::text, 'PUBLIC') || ':' || x.attname::text || ':' || a.privilege_type, ', ') into v_bad
    from pg_catalog.pg_attribute x
    cross join pg_catalog.aclexplode(x.attacl) a
    join pg_catalog.pg_class c on c.oid operator(pg_catalog.=) x.attrelid
   where x.attrelid operator(pg_catalog.=) 'public.tenant'::regclass
     and x.attname in ('status', 'access_version')
     and not x.attisdropped
     and a.grantee is distinct from c.relowner;
  if v_bad is not null then
    raise exception 'migration 010 refused: a tenant lifecycle column carries a direct grant: %', v_bad
      using errcode = 'object_not_in_prerequisite_state',
            hint = 'neither column may be granted to anyone; only tmpos_command.m5_tenant_status_change writes them';
  end if;

  -- No runtime-holdable role may write either column, by any path, or delete the row that holds them.
  select pg_catalog.string_agg(distinct r.rolname::text || ':' || c.col || ':' || c.priv, ', ') into v_bad
    from pg_catalog.pg_roles r
    cross join (values ('status', 'UPDATE'), ('status', 'INSERT'),
                       ('access_version', 'UPDATE'), ('access_version', 'INSERT')) as c(col, priv)
   where r.rolname = any (v_roles)
     and pg_catalog.has_column_privilege(r.oid, 'public.tenant'::regclass, c.col, c.priv);
  if v_bad is not null then
    raise exception 'migration 010 refused: % may write a tenant lifecycle column directly', v_bad
      using errcode = 'object_not_in_prerequisite_state',
            hint = 'only tmpos_command.m5_tenant_status_change may move a tenant status or its access version';
  end if;

  select pg_catalog.string_agg(distinct r.rolname::text, ', ') into v_bad
    from pg_catalog.pg_roles r
   where r.rolname = any (v_roles)
     and pg_catalog.has_table_privilege(r.oid, 'public.tenant'::regclass, 'DELETE');
  if v_bad is not null then
    raise exception 'migration 010 refused: % may delete a tenant row', v_bad
      using errcode = 'object_not_in_prerequisite_state',
            hint = 'a delete and re-insert would reset the status and the access version alike';
  end if;

  -- The column is exactly what section 2 declares.
  if not exists (
    select 1 from pg_catalog.pg_attribute a
     where a.attrelid operator(pg_catalog.=) 'public.tenant'::regclass
       and a.attname operator(pg_catalog.=) 'access_version'
       and not a.attisdropped
       and a.attnotnull
       and a.atttypid operator(pg_catalog.=) 'bigint'::regtype)
     or not exists (
       select 1 from pg_catalog.pg_constraint k
        where k.conrelid operator(pg_catalog.=) 'public.tenant'::regclass
          and k.conname operator(pg_catalog.=) 'tenant_access_version_chk') then
    raise exception 'migration 010 refused: public.tenant.access_version is not the non-null bigint under the CHECK that section 2 declares'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- 008's trigger still owns row_version, and still fires for every role including the table's owner.
  if not exists (
    select 1 from pg_catalog.pg_trigger g
      join pg_catalog.pg_proc p on p.oid operator(pg_catalog.=) g.tgfoid
     where g.tgrelid operator(pg_catalog.=) 'public.tenant'::regclass
       and g.tgname operator(pg_catalog.=) 'trg_tenant_row_version'
       and g.tgenabled operator(pg_catalog.=) 'A'
       and p.proname operator(pg_catalog.=) 'm5_tenant_row_version') then
    raise exception 'migration 010 refused: 008''s trg_tenant_row_version is missing or no longer ENABLE ALWAYS'
      using errcode = 'object_not_in_prerequisite_state',
            hint = 'the lifecycle operation depends on row_version moving exactly once for its single UPDATE';
  end if;
end
$$;

-- Phase 4.0 M5 — the platform tenant directory: the one bounded read the administration console lists
-- tenants through (M5-GIAM-D1-P3; G-IAM; docs/phase-4/04 §2, §5)
-- Migration: 012_m5_platform_tenant_directory (UP)
--
-- SCOPE / TRUTH (binding):
--   - ONE NEW SCHEMA, ONE ROUTINE, NO TABLE, NO NEW ROLE. This file creates schema tmpos_directory and
--     the one read the platform Tenant Management page lists tenants through. It creates no table, no
--     role, no role membership, no type and no index, and it alters nothing that 001-011 created.
--     Migrations 005-011 are untouched, byte for byte.
--   - WHY A MIGRATION IS NEEDED AT ALL. The runtime role tmpos_app reads public.tenant only under
--     migration 005's row policy, which opens exactly one tenant's row to a tenant- or store-scoped
--     context and nothing at all to a context without one ("the runtime principal never operates at
--     platform scope", 005 section 9). That is deliberate, and this file leaves it exactly as it is. A
--     platform listing therefore cannot be a query the runtime runs: it is a fixed operation the runtime
--     may call, which reads as this schema's owner and answers a bounded page and nothing else.
--   - WHY A NEW SCHEMA AND NOT AN EXISTING ONE. For the reason migration 011 gives for its own: 007's
--     rollback drops tmpos_identity and 008's drops tmpos_command WITHOUT CASCADE, 010's rollback asserts
--     tmpos_command's exact routine inventory, and 011's up file asserts that tmpos_session holds exactly
--     its six routines. A routine added to any of them would make an older rollback fail or an assertion
--     false. A schema this file owns outright leaves every existing rollback exactly as correct as it was.
--   - IT READS ONLY ON BEHALF OF A LIVE PLATFORM GRANT. Holding EXECUTE is not, by itself, an answer:
--     the caller names the authority it acts under — the actor, the security version, the one
--     platform membership and its role, exactly the trusted scope the runtime's canonical platform
--     authorizer selected for the request — and the routine confirms, in the same snapshot as the rows
--     it returns, that this authority still holds: the account exists and its status does not deny
--     ('suspended', 'pending_activation'), its security version is the one named, it holds EXACTLY ONE
--     active platform grant, and that grant is the named membership with the named role. Anything else
--     is one answer, 'denied', whatever failed. It is migration 009's transaction-time check with one
--     difference, stated rather than implied: a read is not a write, so an account limited to reads
--     ('read_only', 'overdue') is not refused here, exactly as the authorizer's read-only cap still lets
--     such an actor hold a View permission.
--   - IT DECIDES NO PERMISSION. Whether that role may view tenants is the canonical permission catalog's
--     decision (server/platform-identity/m5CanonicalPermissions.ts view_tenants), taken by the authorizer
--     before this routine is reached. Restating the catalog in SQL would give the platform two
--     definitions of one permission that could drift apart; this file confirms the grant is live and
--     leaves the decision where it is.
--   - WHAT THE RE-CHECK DOES NOT DEFEND. It refuses stale authority: a withdrawn grant, a moved security
--     version, a suspended account. It is not a boundary against the runtime role itself. tmpos_app also
--     holds EXECUTE on 007's resolver, which answers any provider UID's actor, security version,
--     membership and role, so SQL run as tmpos_app (a leaked runtime credential, an injection) can build a
--     valid tuple for any platform administrator and list every tenant. The HTTP path cannot: it reaches
--     this routine only through the authorizer's trusted scope. Doc 08 records the residual under the
--     runtime-credential controls (G-DBROLE).
--   - WHAT IT RETURNS. For each tenant: its id, its display name as stored (never rewritten), its
--     lifecycle status, and its row version — the version both platform commands take as
--     expectedVersion (migration 008). Nothing else: not the legal name, the plan, the access version
--     (migration 010's session witness), a membership, a role, an audit record, a session or a store.
--   - A STABLE, BOUNDED KEYSET PAGE. Tenants are ordered by (created_at, tenant_id): created_at is set
--     once at insert and no routine or grant moves it, and the id breaks every tie, so the order is total
--     and never changes under a rename or a status change — a page boundary can never make a tenant
--     appear twice. A continuation names the last tenant of the previous page; its position is read in
--     the same snapshot as the page, and a continuation naming no tenant is its own answer rather than a
--     silent restart from the beginning. At most 51 rows per call: the runtime pages 50 at a time and
--     asks for one more to learn whether another page follows.
--   - NO INDEX, AND ITS COST STATED. No index on (created_at, tenant_id) exists and this file adds none, so
--     each page reads public.tenant in full and keeps the first rows of that order: linear in the number of
--     tenants per page, which is negligible at the platform's scale today. The continuation is written as a
--     row comparison, which an index on exactly (created_at, tenant_id) would serve directly, so adding
--     one later changes no answer (doc 08 records the limit).
--   - NO SECRET, NO DYNAMIC SQL, NO EXTENSION, NO TEMPORARY OBJECT, NO TRIGGER, NO LOCK, NO WRITE. Every
--     statement is fixed text, every value a parameter, every relation and routine schema-qualified, and
--     the routine pins its search_path to pg_catalog then pg_temp.
--
-- Reversible via 012_m5_platform_tenant_directory.down.sql, which removes exactly the routine and the
-- schema this file created. There is no data to protect: the routine only reads.
--
-- Assumes 001-011 are applied. A future managed apply targets the complete contiguous chain through the
-- newest committed migration — now 001-012 (owner decision D4); this file authorizes no apply.

-- =============================================================================
-- 0) This transaction's search path
-- =============================================================================
set local search_path = pg_catalog, pg_temp;

-- =============================================================================
-- 1) Preconditions: what this file builds on
-- =============================================================================
do $$
begin
  -- The chain is contiguous: 011 is the newest migration this file sits on.
  if pg_catalog.to_regprocedure('tmpos_session.m5_admit_tenant_session(text, text)') is null then
    raise exception 'migration 012 refused: migration 011 must be applied first'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- 007's security version is the one definition of an account's version; this file compares against it
  -- and never restates it. It is granted to nobody, so it is reachable only by a principal holding its
  -- owner's privileges — which the check below also requires of the principal applying this file.
  if pg_catalog.to_regprocedure('tmpos_identity.m5_security_version(uuid)') is null then
    raise exception 'migration 012 refused: migration 007 must be applied first'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if not pg_catalog.has_function_privilege(current_user, 'tmpos_identity.m5_security_version(uuid)', 'EXECUTE') then
    raise exception 'migration 012 refused: the applying principal cannot execute migration 007''s security version, so the definer below could not confirm an authority'
      using errcode = 'insufficient_privilege';
  end if;
  -- 008's row version is the version this page reports, and the one both platform commands take.
  if not exists (select 1 from pg_catalog.pg_attribute a
                  where a.attrelid = 'public.tenant'::regclass
                    and a.attname = 'row_version' and not a.attisdropped) then
    raise exception 'migration 012 refused: migration 008 must be applied first'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- The runtime privilege role this file grants to.
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'tmpos_app') then
    raise exception 'migration 012 refused: migration 005 must be applied first'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- A SECURITY DEFINER read answers only what its OWNER may see. Migration 005 does not FORCE row level
  -- security, so the owner of these tables reads every row — but only if the principal applying this file
  -- is that owner. Were it not, the routine would see no tenant and no grant: every listing would answer
  -- 'denied' or an empty page, a silent wrong answer rather than a failure. So it is refused here, once,
  -- for each table the routine reads, as 010 and 011 refuse it for their own definers.
  if exists (
    select 1
      from pg_catalog.pg_class c
     where c.oid = any (array['public.tenant'::regclass, 'public.app_user'::regclass, 'public.user_membership'::regclass])
       and (not pg_catalog.pg_has_role(current_user, c.relowner, 'USAGE') or c.relforcerowsecurity)) then
    raise exception 'migration 012 refused: the applying principal does not own public.tenant, public.app_user and public.user_membership without forced row security, so a definer read could not see their rows'
      using errcode = 'insufficient_privilege';
  end if;
end
$$;

-- =============================================================================
-- 2) The schema
-- =============================================================================
create schema tmpos_directory;

comment on schema tmpos_directory is
  'Phase 4.0 M5 (migration 012): the platform tenant directory — the one bounded read the administration console lists tenants through. Owned by this migration; tmpos_app holds USAGE and EXECUTE only.';

revoke all on schema tmpos_directory from public, anon, authenticated;
grant usage on schema tmpos_directory to tmpos_app;

-- =============================================================================
-- 3) The directory page
-- =============================================================================
-- ANSWERS. One of:
--   * ('invalid', null, null, null, null) — a malformed argument: the runtime never sends one, so its
--     adapter reads this as a fault, never as a verdict;
--   * ('denied', null, null, null, null) — the named authority does not hold, whatever part of it failed;
--   * ('cursor_unknown', null, null, null, null) — the continuation names no tenant;
--   * zero or more ('tenant', id, display name, status, row version) rows, at most p_limit, in page order.
-- Each non-tenant answer is the ONLY row, so no caller can mistake a refusal for part of a page.
create function tmpos_directory.m5_tenant_directory_page(
  p_internal_user_id uuid,
  p_security_version text,
  p_membership_id uuid,
  p_role_id text,
  p_after_tenant_id uuid,
  p_limit integer)
returns table (
  o_outcome      text,
  o_tenant_id    uuid,
  o_display_name text,
  o_status       text,
  o_version      bigint
)
language plpgsql
-- STABLE IS LOAD-BEARING. The authority check, the continuation's position and the page are several
-- statements, and they must describe one instant: a STABLE function runs every statement on the calling
-- query's snapshot, so a grant revoked, or a tenant created, while this runs cannot be seen by one
-- statement and missed by the next. It also makes the routine unable to write, which a read never needs.
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_status text;
  v_eligible integer;
  v_after_created timestamptz;
begin
  if p_internal_user_id is null
     or p_security_version is null
     or pg_catalog.length(p_security_version) < 1
     or pg_catalog.length(p_security_version) > 128
     or p_membership_id is null
     or p_role_id is null
     or p_role_id !~ '^[a-z_]{1,64}$'
     or p_limit is null
     or p_limit < 1
     or p_limit > 51 then
    return query select 'invalid'::text, null::uuid, null::text, null::text, null::bigint;
    return;
  end if;

  -- 1. The account: present, and its status one that does not deny. 'read_only' and 'overdue' limit an
  --    account to reads, and this is one.
  select u.status into v_status
    from public.app_user u
   where u.internal_user_id = p_internal_user_id;

  if v_status is null or v_status in ('suspended', 'pending_activation') then
    return query select 'denied'::text, null::uuid, null::text, null::text, null::bigint;
    return;
  end if;

  -- 2. The security version the request was authorized under is still the account's.
  if tmpos_identity.m5_security_version(p_internal_user_id) is distinct from p_security_version then
    return query select 'denied'::text, null::uuid, null::text, null::text, null::bigint;
    return;
  end if;

  -- 3. Exactly one active platform grant: none is unauthorized, two are ambiguous.
  select pg_catalog.count(*)::integer into v_eligible
    from public.user_membership m
   where m.internal_user_id = p_internal_user_id
     and m.status = 'active'
     and m.scope_type = 'platform'
     and m.tenant_id is null
     and m.store_id is null;

  if v_eligible <> 1 then
    return query select 'denied'::text, null::uuid, null::text, null::text, null::bigint;
    return;
  end if;

  -- 4. And that one is exactly the membership and the role the request was authorized under.
  if not exists (
    select 1
      from public.user_membership m
     where m.membership_id = p_membership_id
       and m.internal_user_id = p_internal_user_id
       and m.status = 'active'
       and m.scope_type = 'platform'
       and m.tenant_id is null
       and m.store_id is null
       and m.role_id = p_role_id) then
    return query select 'denied'::text, null::uuid, null::text, null::text, null::bigint;
    return;
  end if;

  -- The continuation's position, read in this same snapshot. Only an authorized caller reaches this, so
  -- 'cursor_unknown' tells nobody anything the page itself would not.
  if p_after_tenant_id is not null then
    select t.created_at into v_after_created
      from public.tenant t
     where t.tenant_id = p_after_tenant_id;
    if not found then
      return query select 'cursor_unknown'::text, null::uuid, null::text, null::text, null::bigint;
      return;
    end if;
  end if;

  return query
    select 'tenant'::text, t.tenant_id, t.display_name, t.status, t.row_version
      from public.tenant t
     where p_after_tenant_id is null
        or (t.created_at, t.tenant_id) > (v_after_created, p_after_tenant_id)
     order by t.created_at, t.tenant_id
     limit p_limit;
end
$$;

comment on function tmpos_directory.m5_tenant_directory_page(uuid, text, uuid, text, uuid, integer) is
  'Phase 4.0 M5 (migration 012): the platform tenant directory — one bounded keyset page of (tenant id, display name, status, row version), ordered by (created_at, tenant_id), returned only while the named platform authority still holds: account not denied, security version equal, exactly one active platform grant and it the named membership and role. Every refusal is one row. Read-only; decides no permission.';

-- =============================================================================
-- 4) Privileges, and the proof that nothing wider was issued
-- =============================================================================
-- PostgreSQL grants EXECUTE on a new function to PUBLIC by default, so the default is removed explicitly
-- before the one intended grant is issued.
revoke all on function tmpos_directory.m5_tenant_directory_page(uuid, text, uuid, text, uuid, integer) from public, anon, authenticated;
grant execute on function tmpos_directory.m5_tenant_directory_page(uuid, text, uuid, text, uuid, integer) to tmpos_app;

-- The postcondition, proven rather than asserted, in the form 011 uses for its own schema. This file
-- refuses to finish unless, at this moment:
--   * the schema holds exactly the one routine this file creates, and that routine is SECURITY DEFINER,
--     STABLE and pinned to the search path above;
--   * the routine carries no direct grant beyond its owner's own and a non-grantable EXECUTE to tmpos_app;
--   * the schema carries no grant beyond its owner's own and a non-grantable USAGE to tmpos_app;
--   * none of the runtime roles is a MEMBER of the owner of the schema or the routine — membership hands
--     a role everything the owner holds, which no ACL shows.
-- Each ACL is read through coalesce(acl, acldefault(kind, owner)), because a NULL ACL means PostgreSQL's
-- built-in default (for a routine, EXECUTE to PUBLIC) and aclexplode(NULL) yields nothing.
--
-- WHAT THIS DOES NOT PROVE. It is a snapshot at apply time, not a standing guarantee: a later DDL
-- statement outside these migrations could add an object to this schema or a grant to this routine.
do $$
declare
  v_bad text;
begin
  if (select pg_catalog.count(*) from pg_catalog.pg_proc p where p.pronamespace = 'tmpos_directory'::regnamespace) <> 1 then
    raise exception 'migration 012 refused: schema tmpos_directory does not hold exactly the one routine this file creates'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  if not exists (
    select 1
      from pg_catalog.pg_proc p
     where p.oid = 'tmpos_directory.m5_tenant_directory_page(uuid, text, uuid, text, uuid, integer)'::regprocedure
       and p.prosecdef
       and p.provolatile = 's'
       and p.proconfig = array['search_path=pg_catalog, pg_temp']) then
    raise exception 'migration 012 refused: the directory routine is not SECURITY DEFINER, STABLE and pinned to pg_catalog, pg_temp'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  select pg_catalog.string_agg(pg_catalog.format('%s %s:%s', p.proname, g.grantee::regrole::text, g.privilege_type), ', ')
    into v_bad
    from pg_catalog.pg_proc p,
         pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g
   where p.pronamespace = 'tmpos_directory'::regnamespace
     and g.grantee <> p.proowner
     and not (g.grantee = 'tmpos_app'::regrole and g.privilege_type = 'EXECUTE' and not g.is_grantable);
  if v_bad is not null then
    raise exception 'migration 012 refused: an unexpected direct grant remains on the directory routine (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  select pg_catalog.string_agg(pg_catalog.format('%s:%s', g.grantee::regrole::text, g.privilege_type), ', ')
    into v_bad
    from pg_catalog.pg_namespace n,
         pg_catalog.aclexplode(coalesce(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) g
   where n.oid = 'tmpos_directory'::regnamespace
     and g.grantee <> n.nspowner
     and not (g.grantee = 'tmpos_app'::regrole and g.privilege_type = 'USAGE' and not g.is_grantable);
  if v_bad is not null then
    raise exception 'migration 012 refused: schema tmpos_directory carries an unexpected grant (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  select pg_catalog.string_agg(distinct r.rolname::text, ', ') into v_bad
    from pg_catalog.pg_roles r
    cross join (
      select n.nspowner as owner from pg_catalog.pg_namespace n where n.nspname = 'tmpos_directory'
      union
      select p.proowner from pg_catalog.pg_proc p where p.pronamespace = 'tmpos_directory'::regnamespace
    ) o
   where r.rolname = any (array['tmpos_app', 'tmpos_audit_writer', 'anon', 'authenticated']::name[])
     and pg_catalog.pg_has_role(r.oid, o.owner, 'MEMBER');
  if v_bad is not null then
    raise exception 'migration 012 refused: % is a member of the owner of schema tmpos_directory or its routine', v_bad
      using errcode = 'object_not_in_prerequisite_state',
            hint = 'membership hands a role everything the owner holds, including every row this routine reads';
  end if;
end
$$;

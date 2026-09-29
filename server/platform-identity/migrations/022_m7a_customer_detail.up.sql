-- Phase 4.0 M7a — the tenant customer detail read: one customer of the tenant a minted tenant session is admitted to, by
-- its id, through one session-bound routine that re-decides the list's authority in the snapshot it reads the customer in
-- (M7A-CUSTOMERS-P4; G-IAM, G-DBROLE; docs/phase-4/10)
-- Migration: 022_m7a_customer_detail (UP)
--
-- SCOPE / TRUTH (binding):
--   - ONE NEW SCHEMA, ONE ROUTINE, TWO GRANTS, NO TABLE, NO ROLE, NO TRIGGER, NO TYPE. This file creates schema
--     tmpos_customer_detail and in it the one routine tmpos_app may execute: m7a_customer_get (GET /api/v1/customers/{id}).
--     It touches no object an earlier migration created and no ACL of one: 001-021 stay byte for byte as committed (the
--     migration-files contract's pinned checksums prove that), and tmpos_app gains no privilege on 017's customer table
--     or 017's page.
--   - WHY A NEW SCHEMA. 017's-021's reason: 020's postcondition pins tmpos_role to exactly four routines and 020's rollback
--     drops it without CASCADE; 021 pins tmpos_role_edit to its three routines and table, and its rollback is forward-only
--     in effect; 020 pins tmpos_customer to 017's page and table. A read routine shares none of those rollbacks.
--   - THE ROUTINE'S AUTHORITY ARGUMENT IS THE SESSION KEY ONLY. Unlike 021's m7a_role_level_states, it takes no bare
--     tenant that selects anything: its tenant is derived from the session inside the database, exactly as 020's
--     m7a_customer_page_v3 derives it (steps 1-5 copied from page_v3: a minted, live, tenant-audience session under the
--     installed issuer key; its principal's standing the one minted; exactly one tenant-scope grant; the role's CURRENT
--     Customers level at View or above — store_owner full; manager, technician, sales_staff the owner's stored level in
--     020's table, else the catalog default; any other role refused). Then 017's rechecks of that derived authority on the
--     same snapshot (the account's status and security version; exactly one eligible active tenant grant, and it that
--     membership, role and tenant; the tenant's status). p_expected_tenant is the runtime's trusted scope's tenant, a
--     PRECONDITION, never a selector: a session whose derived tenant is another answers 'denied' before any customer row
--     is read. A revoked session (011's m5_session_revoke removes its row) finds no row and answers 'denied'.
--   - ONE POINT READ. After every recheck, one probe of 017's primary key for the id, filtered to the derived tenant. A
--     missing id and another tenant's id answer the SAME row from the SAME statement: ('not_found', null, null, null).
--     TIMING, STATED EXACTLY: both run the same statements and one customer_pkey probe; the only difference is that a
--     foreign id's probe visits a heap tuple whose tenant filter then rejects it — a sub-millisecond difference, not a
--     constant-time guarantee (doc 08). Removing it needs an index on 017's table, which this file does not touch.
--   - ANSWERS. Always exactly ONE row (o_outcome, o_tenant_id, o_customer_id, o_name): ('customer', tenant, id, name) |
--     ('not_found', nulls) | ('denied', nulls) | ('invalid', nulls) for a null or malformed argument, which the runtime
--     never sends (its adapter reads it as a fault). It locks nothing and writes nothing: STABLE, so every statement runs
--     on the calling statement's snapshot (017's load-bearing reason), and a narrowing, a revocation or a suspension that
--     commits while it runs is seen by all of its statements or none.
--   - WHAT IT DOES NOT DO. It writes no audit record (the list's owner decision; doc 08 G-AUDIT), no outbox event and no
--     idempotency completion. It reads no field beyond the id and the name.
--   - WHAT THIS DOES NOT DEFEND (doc 08; none of it is claimed closed). 020's page_v3 residuals stand for this read, and:
--       * a holder of tmpos_app plus a live minted key calls m7a_customer_get directly for that key's tenant — the class
--         of page_v3's direct call, no new exposure; ids are random, so enumeration is bounded by the id space and, over
--         HTTP, by the per-client limiter;
--       * a database log that captures bind parameters exposes session keys (G-DBROLE, G-PRIVACY; DA-102);
--       * the rollback order is not enforced by the database: 020's (or 016's, 017's, 018's) rollback run while this file is
--         applied succeeds (a PL/pgSQL body records no dependency), and this routine then RAISES on the missing object at
--         call — failing closed (the runtime answers 503) — and this file's rollback refuses until 020 is applied
--         again. The supported order: 022 down, 021 down, then 020.
--   - DEPLOY AND ROLLBACK. It and the runtime that requires 001-022 move together: the P4 detail runtime's startup preflight
--     pins exactly 001-022 and these two grants, and the previous build refuses a 022 database (its approved grants lack
--     them). Rollback order is 022, then 021, then 020 (the ledger's newest-first order). This file's rollback is
--     independent of 021's fail-closed rollback: rolling back 022 alone returns exactly the 001-021 database.
--   - NO SECRET, NO DYNAMIC SQL, NO EXTENSION, NO TEMPORARY OBJECT. Every statement is fixed text, every value a
--     parameter, every relation and routine schema-qualified; the routine pins its search_path to pg_catalog then
--     pg_temp and runs with row_security off, so were row security ever FORCEd on a table it reads it fails (503) instead
--     of silently refusing. No backfill, no lock beyond the catalog's.
--
-- Reversible via 022_m7a_customer_detail.down.sql, which removes exactly what this file created. Roll 022 back before 021.
--
-- Assumes 001-021 are applied. A future managed apply targets the complete contiguous chain through the newest committed
-- migration — now 001-022 (owner decision D4); this file authorizes no apply.

-- =============================================================================
-- 0) This transaction's search path
-- =============================================================================
set local search_path = pg_catalog, pg_temp;

-- =============================================================================
-- 1) Preconditions: what this file builds on
-- =============================================================================
do $$
begin
  -- The chain is contiguous: 021 is the newest migration this file sits on.
  if pg_catalog.to_regnamespace('tmpos_role_edit') is null then
    raise exception 'migration 022 refused: migration 021 must be applied first'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- The runtime roles this file grants to and revokes from.
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'tmpos_app')
     or not exists (select 1 from pg_catalog.pg_roles where rolname = 'tmpos_audit_writer') then
    raise exception 'migration 022 refused: migration 005 must be applied first'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- Nothing of this file exists yet: it is applied once, over a chain that has never held it.
  if pg_catalog.to_regnamespace('tmpos_customer_detail') is not null then
    raise exception 'migration 022 refused: schema tmpos_customer_detail already exists'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- The definer calls 016's admission read and 007's security version as its owner, the principal applying this file.
  if not (pg_catalog.has_function_privilege(current_user, 'tmpos_session.m5_admit_tenant_session_v2(text, text)', 'EXECUTE')
          and pg_catalog.has_function_privilege(current_user, 'tmpos_identity.m5_security_version(uuid)', 'EXECUTE')) then
    raise exception 'migration 022 refused: the applying principal cannot execute 016''s admission read and 007''s security version, which the definer calls'
      using errcode = 'insufficient_privilege';
  end if;
  -- A SECURITY DEFINER routine reads only what its OWNER may (017's argument): were the applying principal neither the
  -- owner of these tables nor a role inheriting that owner's privileges — or row security FORCEd on one — the routine
  -- would find no session, grant or customer and refuse everything. public.identity_link is read by 007's security
  -- version, which runs as its caller.
  if exists (
    select 1
      from pg_catalog.pg_class c
     where c.oid = any (array['tmpos_session.session'::regclass, 'tmpos_mint.tenant_session'::regclass,
                              'tmpos_mint.issuer_key'::regclass, 'tmpos_customer.customer'::regclass,
                              'tmpos_role.tenant_role_level'::regclass, 'public.app_user'::regclass,
                              'public.user_membership'::regclass, 'public.tenant'::regclass,
                              'public.identity_link'::regclass])
       and (not pg_catalog.pg_has_role(current_user, c.relowner, 'USAGE') or c.relforcerowsecurity)) then
    raise exception 'migration 022 refused: the applying principal neither owns nor inherits the owner of a table the read rests on, or one has forced row security'
      using errcode = 'insufficient_privilege';
  end if;
  -- Each privilege stated, one at a time (019's reason): SELECT only — the routine writes nothing — and USAGE on every
  -- schema it reaches, which object privileges alone do not give.
  if not (pg_catalog.has_table_privilege(current_user, 'tmpos_session.session', 'SELECT')
          and pg_catalog.has_table_privilege(current_user, 'tmpos_mint.tenant_session', 'SELECT')
          and pg_catalog.has_table_privilege(current_user, 'tmpos_mint.issuer_key', 'SELECT')
          and pg_catalog.has_table_privilege(current_user, 'tmpos_customer.customer', 'SELECT')
          and pg_catalog.has_table_privilege(current_user, 'tmpos_role.tenant_role_level', 'SELECT')
          and pg_catalog.has_table_privilege(current_user, 'public.app_user', 'SELECT')
          and pg_catalog.has_table_privilege(current_user, 'public.user_membership', 'SELECT')
          and pg_catalog.has_table_privilege(current_user, 'public.tenant', 'SELECT')
          and pg_catalog.has_table_privilege(current_user, 'public.identity_link', 'SELECT')
          and pg_catalog.has_schema_privilege(current_user, 'tmpos_session', 'USAGE')
          and pg_catalog.has_schema_privilege(current_user, 'tmpos_mint', 'USAGE')
          and pg_catalog.has_schema_privilege(current_user, 'tmpos_identity', 'USAGE')
          and pg_catalog.has_schema_privilege(current_user, 'tmpos_role', 'USAGE')
          and pg_catalog.has_schema_privilege(current_user, 'tmpos_customer', 'USAGE')
          and pg_catalog.has_schema_privilege(current_user, 'public', 'USAGE')) then
    raise exception 'migration 022 refused: the applying principal lacks SELECT on a table the read rests on, or USAGE on a schema it reaches'
      using errcode = 'insufficient_privilege';
  end if;
end
$$;

-- =============================================================================
-- 2) The schema
-- =============================================================================
create schema tmpos_customer_detail;

comment on schema tmpos_customer_detail is
  'Phase 4.0 M7a (migration 022): the tenant customer detail read — the one session-bound routine GET /api/v1/customers/{id} goes through. Owned by this migration; tmpos_app holds USAGE and EXECUTE only.';

revoke all on schema tmpos_customer_detail from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
grant usage on schema tmpos_customer_detail to tmpos_app;

-- =============================================================================
-- 3) The routine
-- =============================================================================
create function tmpos_customer_detail.m7a_customer_get(p_session_key text, p_customer_id uuid, p_expected_tenant uuid)
returns table (
  o_outcome     text,
  o_tenant_id   uuid,
  o_customer_id uuid,
  o_name        text
)
language plpgsql
-- STABLE IS LOAD-BEARING (017's reason): every statement below — the session, the level, 017's rechecks and the customer
-- — runs on the calling statement's snapshot. It locks nothing and can write nothing.
stable
security definer
set search_path = pg_catalog, pg_temp
set row_security = off
as $$
declare
  c_levels    constant text[] := array['none', 'view', 'create', 'edit', 'manage', 'approve', 'full'];
  v_now       bigint := pg_catalog.floor(extract(epoch from pg_catalog.statement_timestamp()) * 1000)::bigint;
  v_session   record;
  v_issuer    bytea;
  v_admission record;
  v_grants    jsonb;
  v_role      text;
  v_level     text;
  v_tenant    uuid;
  v_membership uuid;
  v_status    text;
  v_eligible  integer;
  v_tenant_status text;
  v_name      text;
begin
  if p_session_key is null or p_session_key !~ '^[\x21-\x7e]{1,128}$'
     or p_customer_id is null or p_expected_tenant is null then
    return query select 'invalid'::text, null::uuid, null::uuid, null::text;
    return;
  end if;

  -- 1-4. Exactly 020's page_v3 (see there): a minted, live tenant session under the installed key, its principal's
  --      standing the one minted, exactly one tenant-scope grant. A revoked session has no row.
  select s.audience, s.auth_provider, s.auth_provider_uid, s.expires_at, m.standing_digest, m.issuer_digest,
         m.expires_at as minted_expires_at
    into v_session
    from tmpos_session.session s
    join tmpos_mint.tenant_session m on m.session_key = s.session_key
   where s.session_key = p_session_key;
  if not found
     or v_session.audience is distinct from 'tenant'
     or v_session.expires_at is distinct from v_session.minted_expires_at
     or v_now >= v_session.expires_at then
    return query select 'denied'::text, null::uuid, null::uuid, null::text;
    return;
  end if;

  select pg_catalog.sha256(k.key) into v_issuer from tmpos_mint.issuer_key k where k.singleton;
  if v_issuer is null or v_issuer is distinct from v_session.issuer_digest then
    return query select 'denied'::text, null::uuid, null::uuid, null::text;
    return;
  end if;

  select r.outcome, r.actor_id, r.security_version, r.memberships,
         pg_catalog.sha256(pg_catalog.convert_to(r::text, 'UTF8')) as digest
    into strict v_admission
    from tmpos_session.m5_admit_tenant_session_v2(v_session.auth_provider, v_session.auth_provider_uid) r;
  if v_admission.outcome is distinct from 'resolved' or v_admission.digest is distinct from v_session.standing_digest then
    return query select 'denied'::text, null::uuid, null::uuid, null::text;
    return;
  end if;

  select pg_catalog.jsonb_agg(e.entry) into v_grants
    from pg_catalog.jsonb_array_elements(v_admission.memberships) as e(entry)
   where e.entry ->> 'scopeType' = 'tenant';
  if v_grants is null or pg_catalog.jsonb_array_length(v_grants) <> 1 then
    return query select 'denied'::text, null::uuid, null::uuid, null::text;
    return;
  end if;

  -- 5. Exactly 020's page_v3: the role's effective Customers level must meet View — store_owner Full; an editable role its
  --    stored level, else its catalog default; any other role 'denied'. Unlocked, on this call's snapshot.
  v_role := v_grants -> 0 ->> 'roleId';
  if v_role = 'store_owner' then
    null;
  elsif v_role in ('manager', 'technician', 'sales_staff') then
    select l.level into v_level
      from tmpos_role.tenant_role_level l
     where l.tenant_id = (v_grants -> 0 ->> 'tenantId')::uuid and l.role_id = v_role and l.domain = 'customers';
    if coalesce(pg_catalog.array_position(c_levels,
         coalesce(v_level, case v_role when 'manager' then 'full' when 'technician' then 'view' when 'sales_staff' then 'create' end)), 0)
       < pg_catalog.array_position(c_levels, 'view') then
      return query select 'denied'::text, null::uuid, null::uuid, null::text;
      return;
    end if;
  else
    return query select 'denied'::text, null::uuid, null::uuid, null::text;
    return;
  end if;

  -- The authority derived here, and nothing the caller named. The caller's tenant is a precondition only: a session whose
  -- tenant is another reads nothing — no customer row is visited.
  v_tenant := (v_grants -> 0 ->> 'tenantId')::uuid;
  v_membership := (v_grants -> 0 ->> 'membershipId')::uuid;
  if v_tenant is distinct from p_expected_tenant then
    return query select 'denied'::text, null::uuid, null::uuid, null::text;
    return;
  end if;

  -- 6. 017's page rechecks, copied (017 section 4, its argument guard and steps 1-5), for the derived authority.
  if v_admission.actor_id is null
     or v_admission.security_version is null
     or pg_catalog.length(v_admission.security_version) < 1
     or pg_catalog.length(v_admission.security_version) > 128
     or v_membership is null
     or v_role is null
     or v_role !~ '^[a-z_]{1,64}$'
     or v_tenant is null then
    return query select 'invalid'::text, null::uuid, null::uuid, null::text;
    return;
  end if;

  -- 6.1 The account: present, and its status one that admits access (the positive set; a read admits read_only, overdue).
  select u.status into v_status
    from public.app_user u
   where u.internal_user_id = v_admission.actor_id;

  if v_status is null or v_status not in ('active', 'trialing', 'overdue', 'read_only') then
    return query select 'denied'::text, null::uuid, null::uuid, null::text;
    return;
  end if;

  -- 6.2 The security version the session stands on is still the account's.
  if tmpos_identity.m5_security_version(v_admission.actor_id) is distinct from v_admission.security_version then
    return query select 'denied'::text, null::uuid, null::uuid, null::text;
    return;
  end if;

  -- 6.3 Exactly one active tenant-scope grant on a tenant that is not 'suspended' or 'pending_activation'.
  select pg_catalog.count(*)::integer into v_eligible
    from public.user_membership m
    join public.tenant t on t.tenant_id = m.tenant_id
   where m.internal_user_id = v_admission.actor_id
     and m.status = 'active'
     and m.scope_type = 'tenant'
     and m.store_id is null
     and t.status not in ('suspended', 'pending_activation');

  if v_eligible <> 1 then
    return query select 'denied'::text, null::uuid, null::uuid, null::text;
    return;
  end if;

  -- 6.4 And that one is exactly the membership, the role and the tenant derived above.
  if not exists (
    select 1
      from public.user_membership m
     where m.membership_id = v_membership
       and m.internal_user_id = v_admission.actor_id
       and m.status = 'active'
       and m.scope_type = 'tenant'
       and m.tenant_id = v_tenant
       and m.store_id is null
       and m.role_id = v_role) then
    return query select 'denied'::text, null::uuid, null::uuid, null::text;
    return;
  end if;

  -- 6.5 The tenant's lifecycle still admits access: the positive set, so a status this file does not know denies.
  select t.status into v_tenant_status
    from public.tenant t
   where t.tenant_id = v_tenant;

  if v_tenant_status is null or v_tenant_status not in ('active', 'trialing', 'overdue', 'read_only') then
    return query select 'denied'::text, null::uuid, null::uuid, null::text;
    return;
  end if;

  -- 7. ONE point read, in 017's continuation-lookup shape: the primary key, filtered to the derived tenant. A missing id
  --    and another tenant's id take this same statement and this same branch.
  select c.name into v_name
    from tmpos_customer.customer c
   where c.customer_id = p_customer_id
     and c.tenant_id = v_tenant;
  if not found then
    return query select 'not_found'::text, null::uuid, null::uuid, null::text;
    return;
  end if;

  return query select 'customer'::text, v_tenant, p_customer_id, v_name;
end
$$;

comment on function tmpos_customer_detail.m7a_customer_get(text, uuid, uuid) is
  'Phase 4.0 M7a (migration 022): one customer (tenant id, customer id, name) of the tenant derived from a key naming a ledger-minted, live (database clock), tenant session minted under the installed issuer key whose principal''s standing digest is unchanged, who holds exactly one tenant grant — which must be p_expected_tenant''s, a precondition only — and whose role''s Customers level (store_owner full; manager, technician, sales_staff the owner''s stored level, else the catalog default) is View or above, re-checked as 017''s page re-checks it. ''not_found'' alike for a missing id and another tenant''s; ''denied'' otherwise; ''invalid'' for a null or malformed argument. Always one row. Read-only; locks nothing.';

-- =============================================================================
-- 4) Privileges, and the proof that nothing wider was issued
-- =============================================================================
-- PostgreSQL grants EXECUTE on a new function to PUBLIC by default, so every default is removed explicitly before the one
-- intended grant is issued. Nothing else: no table grant — tmpos_app keeps no privilege on 017's customer table and no
-- EXECUTE on 017's page.
revoke all on function tmpos_customer_detail.m7a_customer_get(text, uuid, uuid) from public, anon, authenticated, tmpos_app, tmpos_audit_writer;

grant execute on function tmpos_customer_detail.m7a_customer_get(text, uuid, uuid) to tmpos_app;

-- The postcondition, proven rather than asserted, in 020's form. This file refuses to finish unless, now:
--   (a) the schema holds exactly the one routine, and no relation of any kind, no standalone type, and no trigger calls a
--       function of it;
--   (b) the routine is plpgsql, SECURITY DEFINER, STABLE, pinned to the search path above and run with row_security off,
--       and it and the schema are owned by the applying principal;
--   (c) the routine carries no grant beyond its owner's and a non-grantable EXECUTE to tmpos_app;
--   (d) the schema carries no grant beyond its owner's and a non-grantable USAGE to tmpos_app;
--   (e) tmpos_app CAN execute the routine and use the schema; tmpos_audit_writer, anon and authenticated CANNOT execute
--       it by any path (PUBLIC, an inherited role, or a role reachable only through SET ROLE);
--   (f) tmpos_app holds no privilege on 017's customer table and cannot execute 017's page, by any path;
--   (g) none of the runtime roles is a MEMBER of the owner of the schema or the routine;
--   (h) by presence: 020's page_v3 and table, and 021's schema, are still there.
-- Each ACL is read through coalesce(acl, acldefault(kind, owner)), and a role reachable through a membership is followed
-- whatever the membership's options (019's reasons).
--
-- WHAT THIS DOES NOT PROVE. It is a snapshot at apply time, not a standing guarantee. The runtime LOGIN is not among the
-- roles named here: its memberships and the two roles' grants are enforced at every start by the startup preflight
-- (server/persistence/postgresStartupPreflight.ts, APPROVED_ROLE_GRANTS).
do $$
declare
  v_bad text;
  v_me  oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user);
begin
  -- (a)
  if (select pg_catalog.count(*) from pg_catalog.pg_proc p where p.pronamespace = 'tmpos_customer_detail'::regnamespace) <> 1
     or pg_catalog.to_regprocedure('tmpos_customer_detail.m7a_customer_get(text, uuid, uuid)') is null
     or exists (select 1 from pg_catalog.pg_class c
                 where c.relnamespace = 'tmpos_customer_detail'::regnamespace
                   and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S', 'c', 'i', 'I'))
     or exists (select 1 from pg_catalog.pg_type t
                 where t.typnamespace = 'tmpos_customer_detail'::regnamespace and t.typrelid = 0 and t.typelem = 0)
     or exists (select 1 from pg_catalog.pg_trigger g join pg_catalog.pg_proc p on p.oid = g.tgfoid
                 where p.pronamespace = 'tmpos_customer_detail'::regnamespace) then
    raise exception 'migration 022 refused: schema tmpos_customer_detail does not hold exactly the one routine this file creates'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (b)
  if not exists (
       select 1
         from pg_catalog.pg_proc p
         join pg_catalog.pg_language l on l.oid = p.prolang
        where p.oid = 'tmpos_customer_detail.m7a_customer_get(text, uuid, uuid)'::regprocedure
          and l.lanname = 'plpgsql'
          and p.prosecdef
          and p.provolatile = 's'
          and p.proconfig = array['search_path=pg_catalog, pg_temp', 'row_security=off']
          and p.proowner = v_me)
     or not exists (select 1 from pg_catalog.pg_namespace n
                     where n.oid = 'tmpos_customer_detail'::regnamespace and n.nspowner = v_me) then
    raise exception 'migration 022 refused: the routine is not a plpgsql STABLE SECURITY DEFINER routine pinned to pg_catalog, pg_temp with row_security off, owned with its schema by the applying principal'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (c)
  select pg_catalog.string_agg(pg_catalog.format('%s %s:%s', p.proname, g.grantee::regrole::text, g.privilege_type), ', ')
    into v_bad
    from pg_catalog.pg_proc p,
         pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g
   where p.pronamespace = 'tmpos_customer_detail'::regnamespace
     and g.grantee <> p.proowner
     and not (g.grantee = 'tmpos_app'::regrole and g.privilege_type = 'EXECUTE' and not g.is_grantable);
  if v_bad is not null then
    raise exception 'migration 022 refused: an unexpected direct grant remains on the tmpos_customer_detail routine (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (d)
  select pg_catalog.string_agg(pg_catalog.format('%s:%s', g.grantee::regrole::text, g.privilege_type), ', ')
    into v_bad
    from pg_catalog.pg_namespace n,
         pg_catalog.aclexplode(coalesce(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) g
   where n.oid = 'tmpos_customer_detail'::regnamespace
     and g.grantee <> n.nspowner
     and not (g.grantee = 'tmpos_app'::regrole and g.privilege_type = 'USAGE' and not g.is_grantable);
  if v_bad is not null then
    raise exception 'migration 022 refused: schema tmpos_customer_detail carries an unexpected grant (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (e)
  if not pg_catalog.has_function_privilege('tmpos_app',
           'tmpos_customer_detail.m7a_customer_get(text, uuid, uuid)'::regprocedure, 'EXECUTE')
     or not pg_catalog.has_schema_privilege('tmpos_app', 'tmpos_customer_detail'::regnamespace, 'USAGE') then
    raise exception 'migration 022 refused: tmpos_app does not hold EXECUTE on the routine and USAGE on schema tmpos_customer_detail'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  select pg_catalog.string_agg(distinct r.rolname::text, ', ') into v_bad
    from pg_catalog.pg_roles r
    join pg_catalog.pg_roles x on pg_catalog.pg_has_role(r.oid, x.oid, 'MEMBER')
   where r.rolname = any (array['tmpos_audit_writer', 'anon', 'authenticated']::name[])
     and pg_catalog.has_function_privilege(x.oid,
           'tmpos_customer_detail.m7a_customer_get(text, uuid, uuid)'::regprocedure, 'EXECUTE');
  if v_bad is not null then
    raise exception 'migration 022 refused: a runtime role other than tmpos_app can execute the tmpos_customer_detail routine (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (f) MAINTAIN only on a server that has it (PostgreSQL 17+), where has_table_privilege would reject it on 16.
  select pg_catalog.string_agg(distinct r.rolname::text, ', ') into v_bad
    from pg_catalog.pg_roles r
    join pg_catalog.pg_roles x on pg_catalog.pg_has_role(r.oid, x.oid, 'MEMBER')
   where r.rolname = 'tmpos_app'
     and (pg_catalog.has_table_privilege(x.oid, 'tmpos_customer.customer'::regclass,
            'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'
            operator(pg_catalog.||) case when pg_catalog.current_setting('server_version_num')::integer >= 170000
                                         then ', MAINTAIN' else '' end)
          or pg_catalog.has_function_privilege(x.oid,
            'tmpos_customer.m7a_customer_page(uuid, text, uuid, text, uuid, uuid, integer)'::regprocedure, 'EXECUTE'));
  if v_bad is not null then
    raise exception 'migration 022 refused: % holds a privilege on tmpos_customer.customer or can execute 017''s page', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (g)
  select pg_catalog.string_agg(distinct r.rolname::text, ', ') into v_bad
    from pg_catalog.pg_roles r
    cross join (
      select n.nspowner as owner from pg_catalog.pg_namespace n where n.nspname = 'tmpos_customer_detail'
      union
      select p.proowner from pg_catalog.pg_proc p where p.pronamespace = 'tmpos_customer_detail'::regnamespace
    ) o
   where r.rolname = any (array['tmpos_app', 'tmpos_audit_writer', 'anon', 'authenticated']::name[])
     and pg_catalog.pg_has_role(r.oid, o.owner, 'MEMBER');
  if v_bad is not null then
    raise exception 'migration 022 refused: % is a member of the owner of schema tmpos_customer_detail or its routine', v_bad
      using errcode = 'object_not_in_prerequisite_state',
            hint = 'membership hands a role everything the owner holds, including a direct read of every customer';
  end if;

  -- (h)
  if pg_catalog.to_regprocedure('tmpos_role.m7a_customer_page_v3(text, uuid, integer)') is null
     or pg_catalog.to_regclass('tmpos_role.tenant_role_level') is null
     or pg_catalog.to_regnamespace('tmpos_role_edit') is null then
    raise exception 'migration 022 refused: migration 020''s page_v3 or role table, or migration 021''s schema, is missing'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$$;

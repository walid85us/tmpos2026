-- Phase 4.0 M7a — the tenant customer directory: the first durable tenant-owned business record and the one bounded
-- read a tenant session lists it through (M7A-CUSTOMERS-P1; G-PERSIST, G-IAM; docs/phase-4/05, docs/phase-4/10 ADR-32)
-- Migration: 017_m7a_customer_directory (UP)
--
-- SCOPE / TRUTH (binding):
--   - ONE NEW SCHEMA, ONE TABLE, ONE PAGE INDEX, ONE ROUTINE, TWO GRANTS, NO ROLE, NO TRIGGER. This file creates schema
--     tmpos_customer, the table tmpos_customer.customer (its primary key and its page index), and the one read
--     GET /api/v1/customers lists customers through. It grants tmpos_app USAGE on the schema and EXECUTE on the routine and nothing else to anyone.
--     It alters nothing that 001-016 created: migrations 005-016 are untouched, byte for byte.
--   - THE MINIMAL CUSTOMER IDENTITY, AND NOTHING MORE. docs/phase-4/05 names `customer` the aggregate root of the
--     Customers domain, owned by the TENANT ("tenant (store-visible)"). No durable customer model existed: the client
--     holds customers in memory only. This file adds exactly what the first read needs — a stable id, the owning tenant
--     and the name — and none of the contact, loyalty, money or lifecycle fields the client type carries. Those arrive
--     with the product decisions that govern them (PII classification, retention, the write commands). No row is
--     created here: records are written only by tests against disposable databases until a write path exists.
--   - WHY A NEW SCHEMA AND NOT AN EXISTING ONE. For the reason 011 and 012 give for their own: older rollbacks drop
--     their schemas WITHOUT CASCADE and older files assert exact routine inventories (016's rollback requires
--     tmpos_session to hold exactly six routines, 012's up file tmpos_directory exactly one). An object added to any of
--     them would make a rollback fail or an assertion false. A schema this file owns outright leaves every existing
--     rollback exactly as correct as it was.
--   - THE RUNTIME ROLE CANNOT READ THE TABLE. tmpos_app holds no privilege on tmpos_customer.customer, and row level
--     security is enabled on it with no policy, so a later grant alone would still show it no row. It does NOT rely on
--     migration 005's session variables (app.tenant_id): the runtime sets those itself, so they prove nothing about which
--     tenant a request was admitted to. The only way in is the routine below, which names its authority explicitly.
--   - THE ROUTINE READS ONLY ON BEHALF OF A LIVE TENANT GRANT, AND ONLY THAT GRANT'S TENANT. The caller names the
--     authority it acts under — the actor, the account security version, the one tenant membership, its role and its
--     tenant, exactly the trusted scope the runtime's tenant authorizer selected for the request — and the routine
--     confirms, in the same snapshot as the rows it returns, that this authority still holds: the account exists and its
--     status admits access ('active', 'trialing', or read-limited 'overdue'/'read_only' — a read is not a write, exactly
--     as the authorizer's read-only cap still lets such an actor hold a View permission); its security version (007) is
--     the one named; it holds EXACTLY ONE active tenant-scope grant on a tenant that is not 'suspended' or
--     'pending_activation' (the grants 007's resolver answers, so the authorizer and this routine count the same set);
--     that grant is the named membership with the named role on the named tenant; and that tenant's status admits access
--     (the same four statuses). Anything else is one answer, 'denied', whatever failed. Every row it returns belongs to
--     that tenant and names it, so the adapter can refuse a row that does not; the tenant is never a free parameter,
--     because it must equal the grant's.
--   - IT DECIDES NO PERMISSION. Whether that role may view customers is the canonical catalog's decision
--     (server/platform-identity/m5CanonicalPermissions.ts view_customers — the Customers domain at View or above), taken
--     by the authorizer before this routine is reached. Restating it here would give one permission two definitions.
--   - WHAT THE RE-CHECK DOES NOT DEFEND. It refuses stale authority: a withdrawn or changed grant, a moved security
--     version, a suspended account or tenant. It is not a boundary against the runtime role itself: tmpos_app holds
--     EXECUTE on 007's resolver, which answers any provider UID's actor, security version, membership and role, so SQL
--     run as tmpos_app (a leaked runtime credential, an injection) can build a valid tuple for a user of any tenant and
--     list that tenant's customers. The HTTP path cannot: it reaches this routine only through the authorizer's trusted
--     scope. Database-enforced isolation against the runtime credential is therefore NOT provided (doc 08 G-DBROLE).
--   - A STABLE, BOUNDED KEYSET PAGE. Customers are ordered by (name, customer_id) under the "C" collation: byte order of
--     the stored text, independent of the database's default collation, with the id breaking every tie, so the order is
--     total and the same on every deployment. A continuation names the last customer of the previous page; its position
--     is read in the same snapshot as the page, and ONLY within the admitted tenant, so a continuation naming no
--     customer of that tenant — unknown, deleted, or another tenant's — is one answer, 'cursor_unknown', and says nothing
--     about any other tenant. A row inserted while a client pages appears on a later page if it sorts after the
--     continuation and not at all otherwise; no row can appear twice. At most 101 rows per call: the runtime pages at
--     most 100 at a time and asks for one more to learn whether another page follows.
--   - NO SECRET, NO DYNAMIC SQL, NO EXTENSION, NO TEMPORARY OBJECT, NO TRIGGER, NO LOCK, NO WRITE IN THE ROUTINE. Every
--     statement is fixed text, every value a parameter, every relation and routine schema-qualified, and the routine
--     pins its search_path to pg_catalog then pg_temp and runs with row_security off: its owner is not subject to the
--     table's row security, so this changes nothing today, but if row security were ever FORCED on the table the
--     routine would fail (an outage the route answers 503) instead of silently answering every tenant an empty page.
--
-- Reversible via 017_m7a_customer_directory.down.sql, which refuses while any customer row exists (a rollback must never
-- silently delete business records) and otherwise removes exactly what this file created. While a customer row exists
-- the chain cannot roll back past 017 at all: 005's rollback drops tmpos_app and 002's drops public.tenant, and both
-- fail while this file's grants and foreign key remain.
--
-- Assumes 001-016 are applied. A future managed apply targets the complete contiguous chain through the newest committed
-- migration — now 001-017 (owner decision D4); this file authorizes no apply.

-- =============================================================================
-- 0) This transaction's search path
-- =============================================================================
set local search_path = pg_catalog, pg_temp;

-- =============================================================================
-- 1) Preconditions: what this file builds on
-- =============================================================================
do $$
begin
  -- The chain is contiguous: 016 is the newest migration this file sits on.
  if pg_catalog.to_regprocedure('tmpos_session.m5_admit_tenant_session_v2(text, text)') is null then
    raise exception 'migration 017 refused: migration 016 must be applied first'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- 007's security version is the one definition of an account's version; this file compares against it and never
  -- restates it. It is granted to nobody, so the principal applying this file must hold its owner's privileges.
  if pg_catalog.to_regprocedure('tmpos_identity.m5_security_version(uuid)') is null then
    raise exception 'migration 017 refused: migration 007 must be applied first'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if not pg_catalog.has_function_privilege(current_user, 'tmpos_identity.m5_security_version(uuid)', 'EXECUTE') then
    raise exception 'migration 017 refused: the applying principal cannot execute migration 007''s security version, so the definer below could not confirm an authority'
      using errcode = 'insufficient_privilege';
  end if;
  -- The runtime privilege role this file grants to.
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'tmpos_app') then
    raise exception 'migration 017 refused: migration 005 must be applied first'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- A SECURITY DEFINER read answers only what its OWNER may see. Migration 005 does not FORCE row level security, so the
  -- owner of these tables reads every row — but only if the principal applying this file is that owner. Were it not,
  -- the routine would see no grant: every listing would answer 'denied', a silent wrong answer rather than a failure.
  if exists (
    select 1
      from pg_catalog.pg_class c
     where c.oid = any (array['public.tenant'::regclass, 'public.app_user'::regclass, 'public.user_membership'::regclass,
                              'public.identity_link'::regclass])
       and (not pg_catalog.pg_has_role(current_user, c.relowner, 'USAGE') or c.relforcerowsecurity)) then
    raise exception 'migration 017 refused: the applying principal does not own public.tenant, public.app_user, public.user_membership and public.identity_link (read by 007''s security version) without forced row security, so a definer read could not see their rows'
      using errcode = 'insufficient_privilege';
  end if;
end
$$;

-- =============================================================================
-- 2) The schema
-- =============================================================================
create schema tmpos_customer;

comment on schema tmpos_customer is
  'Phase 4.0 M7a (migration 017): the tenant customer directory — the durable customer identity (id, owning tenant, name) and the one bounded read a tenant session lists it through. Owned by this migration; tmpos_app holds USAGE and EXECUTE only.';

revoke all on schema tmpos_customer from public, anon, authenticated;
grant usage on schema tmpos_customer to tmpos_app;

-- =============================================================================
-- 3) The customer identity
-- =============================================================================
-- customer_id is a random uuid chosen by whoever writes the row (no sequence: ids must not be enumerable). tenant_id is
-- the owning tenant and never null; the reference is NO ACTION, so a tenant holding customers cannot be deleted — its
-- customers are never removed as a side effect. name is the display name as entered, under the character rules migration
-- 009 gives a tenant display name, with a longer limit (200 characters where 009 allows 120): no C0 control, DEL, C1
-- control, line or paragraph separator; no
-- Bidi_Control character (which could make a list show a name other than the one stored); and no leading or trailing
-- whitespace (which also refuses a name that is whitespace alone). Its collation is fixed to "C" so the page order, the
-- keyset comparison and the index agree on every deployment.
create table tmpos_customer.customer (
  customer_id uuid not null,
  tenant_id   uuid not null,
  name        text collate "C" not null,
  constraint customer_pkey primary key (customer_id),
  constraint customer_tenant_fkey foreign key (tenant_id) references public.tenant (tenant_id),
  constraint customer_name_chk check (
    pg_catalog.char_length(name) between 1 and 200
    and name !~ '[\u0001-\u001f\u007f-\u009f\u2028\u2029]'
    and name !~ '[\u061c\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069]'
    and name !~ '^[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]|[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]$')
);

comment on table tmpos_customer.customer is
  'Phase 4.0 M7a (migration 017): the minimal durable customer identity — id, owning tenant, name. Tenant-owned (docs/phase-4/05). No runtime role holds a privilege on it; it is read only through tmpos_customer.m7a_customer_page.';

-- The page index: one tenant's customers in page order, so each page is a bounded range scan.
create index customer_tenant_page_idx on tmpos_customer.customer (tenant_id, name, customer_id);

alter table tmpos_customer.customer enable row level security;
revoke all on table tmpos_customer.customer from public, anon, authenticated, tmpos_app, tmpos_audit_writer;

-- =============================================================================
-- 4) The customer page
-- =============================================================================
-- ANSWERS. One of:
--   * ('invalid', null, null, null) — a malformed argument: the runtime never sends one, so its adapter reads this as a fault;
--   * ('denied', null, null, null) — the named authority does not hold, whatever part of it failed;
--   * ('cursor_unknown', null, null, null) — the continuation names no customer of the admitted tenant;
--   * zero or more ('customer', tenant id, customer id, name) rows, at most p_limit, in page order — each naming the
--     tenant it belongs to, which is always p_tenant_id.
-- Each non-customer answer is the ONLY row, so no caller can mistake a refusal for part of a page.
create function tmpos_customer.m7a_customer_page(
  p_internal_user_id uuid,
  p_security_version text,
  p_membership_id uuid,
  p_role_id text,
  p_tenant_id uuid,
  p_after_customer_id uuid,
  p_limit integer)
returns table (
  o_outcome     text,
  o_tenant_id   uuid,
  o_customer_id uuid,
  o_name        text
)
language plpgsql
-- STABLE IS LOAD-BEARING. The authority check, the continuation's position and the page are several statements, and
-- they must describe one instant: a STABLE function runs every statement on the calling query's snapshot, so a grant
-- withdrawn, a tenant suspended or a customer inserted while this runs cannot be seen by one statement and missed by
-- the next. It also makes the routine unable to write, which a read never needs.
stable
security definer
set search_path = pg_catalog, pg_temp
set row_security = off
as $$
declare
  v_status text;
  v_eligible integer;
  v_tenant_status text;
  v_after_name text collate "C";
begin
  if p_internal_user_id is null
     or p_security_version is null
     or pg_catalog.length(p_security_version) < 1
     or pg_catalog.length(p_security_version) > 128
     or p_membership_id is null
     or p_role_id is null
     or p_role_id !~ '^[a-z_]{1,64}$'
     or p_tenant_id is null
     or p_limit is null
     or p_limit < 1
     or p_limit > 101 then
    return query select 'invalid'::text, null::uuid, null::uuid, null::text;
    return;
  end if;

  -- 1. The account: present, and its status one that admits access — the positive set, so a status this file does not
  --    know denies. 'read_only' and 'overdue' limit an account to reads, and this is one.
  select u.status into v_status
    from public.app_user u
   where u.internal_user_id = p_internal_user_id;

  if v_status is null or v_status not in ('active', 'trialing', 'overdue', 'read_only') then
    return query select 'denied'::text, null::uuid, null::uuid, null::text;
    return;
  end if;

  -- 2. The security version the request was authorized under is still the account's.
  if tmpos_identity.m5_security_version(p_internal_user_id) is distinct from p_security_version then
    return query select 'denied'::text, null::uuid, null::uuid, null::text;
    return;
  end if;

  -- 3. Exactly one active tenant-scope grant: none is unauthorized, two are ambiguous (the authorizer's own rule). It
  --    counts the grants 007's resolver answers — those on a tenant that exists and is not 'suspended' or
  --    'pending_activation' — so an actor whose other tenant is suspended is decided here as the authorizer decided it.
  select pg_catalog.count(*)::integer into v_eligible
    from public.user_membership m
    join public.tenant t on t.tenant_id = m.tenant_id
   where m.internal_user_id = p_internal_user_id
     and m.status = 'active'
     and m.scope_type = 'tenant'
     and m.store_id is null
     and t.status not in ('suspended', 'pending_activation');

  if v_eligible <> 1 then
    return query select 'denied'::text, null::uuid, null::uuid, null::text;
    return;
  end if;

  -- 4. And that one is exactly the membership, the role and the tenant the request was authorized under.
  if not exists (
    select 1
      from public.user_membership m
     where m.membership_id = p_membership_id
       and m.internal_user_id = p_internal_user_id
       and m.status = 'active'
       and m.scope_type = 'tenant'
       and m.tenant_id = p_tenant_id
       and m.store_id is null
       and m.role_id = p_role_id) then
    return query select 'denied'::text, null::uuid, null::uuid, null::text;
    return;
  end if;

  -- 5. The tenant's lifecycle still admits access: the positive set, so a status this file does not know denies.
  select t.status into v_tenant_status
    from public.tenant t
   where t.tenant_id = p_tenant_id;

  if v_tenant_status is null or v_tenant_status not in ('active', 'trialing', 'overdue', 'read_only') then
    return query select 'denied'::text, null::uuid, null::uuid, null::text;
    return;
  end if;

  -- The first page needs no continuation.
  if p_after_customer_id is null then
    return query
      select 'customer'::text, c.tenant_id, c.customer_id, c.name::text
        from tmpos_customer.customer c
       where c.tenant_id = p_tenant_id
       order by c.name collate "C", c.customer_id
       limit p_limit;
    return;
  end if;

  -- The continuation's position, read in this same snapshot and ONLY within the admitted tenant. Only an authorized
  -- caller reaches this, so 'cursor_unknown' tells nobody anything the page itself would not.
  select c.name into v_after_name
    from tmpos_customer.customer c
   where c.tenant_id = p_tenant_id
     and c.customer_id = p_after_customer_id;
  if not found then
    return query select 'cursor_unknown'::text, null::uuid, null::uuid, null::text;
    return;
  end if;

  return query
    select 'customer'::text, c.tenant_id, c.customer_id, c.name::text
      from tmpos_customer.customer c
     where c.tenant_id = p_tenant_id
       and (c.name collate "C", c.customer_id) > (v_after_name collate "C", p_after_customer_id)
     order by c.name collate "C", c.customer_id
     limit p_limit;
end
$$;

comment on function tmpos_customer.m7a_customer_page(uuid, text, uuid, text, uuid, uuid, integer) is
  'Phase 4.0 M7a (migration 017): the tenant customer directory — one bounded keyset page of (tenant id, customer id, name) of exactly one tenant, ordered by (name collate "C", customer_id), returned only while the named tenant authority still holds: account status admitting access, security version equal, exactly one active tenant-scope grant on a tenant not suspended or pending and it the named membership, role and tenant, tenant status admitting access. Every refusal is one row. Read-only; decides no permission.';

-- =============================================================================
-- 5) Privileges, and the proof that nothing wider was issued
-- =============================================================================
-- PostgreSQL grants EXECUTE on a new function to PUBLIC by default, so the default is removed explicitly before the one
-- intended grant is issued.
revoke all on function tmpos_customer.m7a_customer_page(uuid, text, uuid, text, uuid, uuid, integer) from public, anon, authenticated;
grant execute on function tmpos_customer.m7a_customer_page(uuid, text, uuid, text, uuid, uuid, integer) to tmpos_app;

-- The postcondition, proven rather than asserted, in the form 012 uses for its own schema. This file refuses to finish
-- unless, at this moment:
--   * the schema holds exactly the one routine and the one table this file creates (no view, sequence or standalone
--     type), the routine SECURITY DEFINER, STABLE, pinned to the search path above and run with row_security off, and
--     the table under row level security, not forced, with no policy, so no role that is not its owner can see a row
--     even if it were granted one;
--   * the routine carries no direct grant beyond its owner's own and a non-grantable EXECUTE to tmpos_app;
--   * the table carries no grant beyond its owner's own, and no column grant at all;
--   * the schema carries no grant beyond its owner's own and a non-grantable USAGE to tmpos_app;
--   * tmpos_app does hold that EXECUTE and that USAGE;
--   * none of the runtime roles is a MEMBER of the owner of the schema, the table or the routine — membership hands a
--     role everything the owner holds, which no ACL shows;
--   * none of the runtime roles HOLDS a privilege on the table by any path — a grant to PUBLIC, one inherited through a
--     role, or a predefined role such as pg_read_all_data — which the ACL checks, proving only what was written, cannot
--     see (011's effective-privilege check).
-- Each ACL is read through coalesce(acl, acldefault(kind, owner)), because a NULL ACL means PostgreSQL's built-in default
-- (for a routine, EXECUTE to PUBLIC) and aclexplode(NULL) yields nothing.
--
-- WHAT THIS DOES NOT PROVE. It is a snapshot at apply time, not a standing guarantee: a later DDL statement outside
-- these migrations could add an object to this schema or a grant to this table or routine.
do $$
declare
  v_bad text;
begin
  if (select pg_catalog.count(*) from pg_catalog.pg_proc p where p.pronamespace = 'tmpos_customer'::regnamespace) <> 1
     or (select pg_catalog.count(*) from pg_catalog.pg_class c
          where c.relnamespace = 'tmpos_customer'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S', 'c')) <> 1 then
    raise exception 'migration 017 refused: schema tmpos_customer does not hold exactly the one routine and the one table this file creates'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  if not exists (
    select 1
      from pg_catalog.pg_proc p
     where p.oid = 'tmpos_customer.m7a_customer_page(uuid, text, uuid, text, uuid, uuid, integer)'::regprocedure
       and p.prosecdef
       and p.provolatile = 's'
       and p.proconfig = array['search_path=pg_catalog, pg_temp', 'row_security=off']) then
    raise exception 'migration 017 refused: the customer page routine is not SECURITY DEFINER, STABLE, pinned to pg_catalog, pg_temp and run with row_security off'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  if not exists (select 1 from pg_catalog.pg_class c
                  where c.oid = 'tmpos_customer.customer'::regclass and c.relrowsecurity and not c.relforcerowsecurity)
     or exists (select 1 from pg_catalog.pg_policy p where p.polrelid = 'tmpos_customer.customer'::regclass) then
    raise exception 'migration 017 refused: row level security is not enabled (unforced) on tmpos_customer.customer, or a policy exists on it'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  select pg_catalog.string_agg(pg_catalog.format('%s %s:%s', p.proname, g.grantee::regrole::text, g.privilege_type), ', ')
    into v_bad
    from pg_catalog.pg_proc p,
         pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g
   where p.pronamespace = 'tmpos_customer'::regnamespace
     and g.grantee <> p.proowner
     and not (g.grantee = 'tmpos_app'::regrole and g.privilege_type = 'EXECUTE' and not g.is_grantable);
  if v_bad is not null then
    raise exception 'migration 017 refused: an unexpected direct grant remains on the customer page routine (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  select pg_catalog.string_agg(pg_catalog.format('%s:%s', g.grantee::regrole::text, g.privilege_type), ', ')
    into v_bad
    from pg_catalog.pg_class c,
         pg_catalog.aclexplode(coalesce(c.relacl, pg_catalog.acldefault('r', c.relowner))) g
   where c.oid = 'tmpos_customer.customer'::regclass
     and g.grantee <> c.relowner;
  if v_bad is not null then
    raise exception 'migration 017 refused: an unexpected grant remains on tmpos_customer.customer (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  if exists (select 1 from pg_catalog.pg_attribute a
              where a.attrelid = 'tmpos_customer.customer'::regclass and a.attacl is not null) then
    raise exception 'migration 017 refused: a column grant exists on tmpos_customer.customer'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  select pg_catalog.string_agg(pg_catalog.format('%s:%s', g.grantee::regrole::text, g.privilege_type), ', ')
    into v_bad
    from pg_catalog.pg_namespace n,
         pg_catalog.aclexplode(coalesce(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) g
   where n.oid = 'tmpos_customer'::regnamespace
     and g.grantee <> n.nspowner
     and not (g.grantee = 'tmpos_app'::regrole and g.privilege_type = 'USAGE' and not g.is_grantable);
  if v_bad is not null then
    raise exception 'migration 017 refused: schema tmpos_customer carries an unexpected grant (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  if not pg_catalog.has_function_privilege('tmpos_app',
           'tmpos_customer.m7a_customer_page(uuid, text, uuid, text, uuid, uuid, integer)'::regprocedure, 'EXECUTE')
     or not pg_catalog.has_schema_privilege('tmpos_app', 'tmpos_customer'::regnamespace, 'USAGE') then
    raise exception 'migration 017 refused: tmpos_app does not hold EXECUTE on the customer page routine and USAGE on schema tmpos_customer'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  select pg_catalog.string_agg(distinct r.rolname::text, ', ') into v_bad
    from pg_catalog.pg_roles r
    cross join (
      select n.nspowner as owner from pg_catalog.pg_namespace n where n.nspname = 'tmpos_customer'
      union
      select c.relowner from pg_catalog.pg_class c where c.relnamespace = 'tmpos_customer'::regnamespace
      union
      select p.proowner from pg_catalog.pg_proc p where p.pronamespace = 'tmpos_customer'::regnamespace
    ) o
   where r.rolname = any (array['tmpos_app', 'tmpos_audit_writer', 'anon', 'authenticated']::name[])
     and pg_catalog.pg_has_role(r.oid, o.owner, 'MEMBER');
  if v_bad is not null then
    raise exception 'migration 017 refused: % is a member of the owner of schema tmpos_customer, its table or its routine', v_bad
      using errcode = 'object_not_in_prerequisite_state',
            hint = 'membership hands a role everything the owner holds, including every row this routine reads';
  end if;

  -- MAINTAIN only on a server that has it (PostgreSQL 17+), where has_table_privilege would reject it on 16.
  select pg_catalog.string_agg(r.rolname::text, ', ' order by r.rolname) into v_bad
    from pg_catalog.pg_roles r
   where r.rolname = any (array['tmpos_app', 'tmpos_audit_writer', 'anon', 'authenticated']::name[])
     and pg_catalog.has_table_privilege(r.oid, 'tmpos_customer.customer'::regclass,
           'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'
           operator(pg_catalog.||) case when pg_catalog.current_setting('server_version_num')::integer >= 170000
                                        then ', MAINTAIN' else '' end);
  if v_bad is not null then
    raise exception 'migration 017 refused: % holds an effective privilege on tmpos_customer.customer', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$$;

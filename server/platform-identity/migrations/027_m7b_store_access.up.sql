-- Phase 4.0 M7b — the stores a tenant session may act at: one session-bound discovery routine deriving, from the
-- presenting session's session key alone, every store where the session's actor holds exactly one usable store-scope grant
-- (M7B-INVOICES-P1; G-IAM, G-ISOLATION, G-DBROLE; docs/phase-4/10)
-- Migration: 027_m7b_store_access (UP)
--
-- SCOPE / TRUTH (binding):
--   - ONE NEW SCHEMA, ONE ROUTINE, NO TABLE, NO COLUMN, NO CONSTRAINT, NO ROLE, NO TRIGGER, NO TYPE. This file creates schema
--     tmpos_store_access and in it the one routine tmpos_app may execute: m7b_store_directory, the read behind
--     GET /api/v1/stores (server/runtime/storeDirectory.ts). It alters nothing an earlier migration created: 001-026 stay
--     byte for byte as committed (the migration-files contract's pinned checksums prove that), and no earlier schema,
--     table, routine or grant is touched.
--   - WHY IT EXISTS. The owner's stage brief makes invoice drafts owned by a real STORE, and a store request is authorized
--     only through the actor's OWN active store-scope grant at exactly that store (no tenant-to-store inheritance: no
--     accepted document establishes one, docs/phase-4/04 :37, :58). The shop holds no store id of its own (the session
--     record holds no tenant or store, ADR-33), so it must be told which stores the session may name. This routine is that
--     answer, derived inside the database from the session key alone — never from anything a client sends.
--   - WHAT IT ANSWERS. For a key naming a minted tenant session (joined to 018's mint ledger, of audience tenant, live on the
--     database clock, the mint's expiry unchanged), under the installed issuer key (its digest equal to the one minted),
--     whose principal's 016 v2 admission still digests to the standing the session was minted at, of an account whose
--     status is a READ status (active, trialing, overdue, read_only): one row per store at which that admission names
--     EXACTLY ONE store-scope grant that is still an active public.user_membership row of that actor at that tenant, store
--     and role, whose public.store row is in the grant's tenant (re-checked here, not only by 007's resolver), and whose
--     tenant and store statuses are read statuses. A store with two or more such grants (different roles at one store) is
--     AMBIGUOUS and left out — the runtime authorizer denies it too (server/composition/tenantAuthorization.ts). A tenant-scope
--     grant never contributes a store. Each row: ('store', store id, its tenant id, its SERVED name, read_only), where the
--     served name is the stored store_name when it is 1-256 characters long and NULL otherwise (below), and read_only is
--     true when the account, the tenant or the store is read_only or overdue (server/runtime/tenantState.ts's widest-wins
--     rule). Rows are ordered by the served name in byte order ("C") with NULLs last, then store_id, and at most 200
--     (007's resolver refuses an actor with more than 200 grants, so all of them fit). A valid session with no such store
--     answers NO row. Any other key: one ('denied', NULLs) row; a malformed argument: one ('invalid', NULLs) row.
--   - IT IS A READ. STABLE: every statement runs on the calling statement's snapshot; it locks nothing and writes nothing, so
--     it needs no isolation level of its own. A store's existence proves nothing (tmpos_app may INSERT public.store rows,
--     docs/phase-4/08 DA-29, DA-97): authority comes only from a membership row the runtime cannot write, and public.store
--     is consulted only for its tenant and status.
--   - ONE BAD NAME DEGRADES ITS OWN ENTRY, NEVER THE ANSWER. public.store.store_name carries no CHECK and tmpos_app may UPDATE
--     it (005), so the routine serves a name only when pg_catalog.char_length of it is between 1 and 256 and NULL otherwise
--     (an empty or a longer name, like an absent one), and orders by that served value. That is exactly the runtime's rule
--     (server/runtime/storeDirectory.ts isServableStoreName: null, or 1-256 characters of well-formed UTF-16) on a UTF8
--     database, where no text value can hold a lone surrogate, so the runtime — which still validates every name and the
--     order, as defence in depth and as the backstop on any other encoding — never meets a row it must refuse the whole
--     list for.
--   - WHAT THIS DOES NOT DEFEND (doc 08; none of it is claimed closed). It is 022's read class:
--       * a holder of tmpos_app plus a live minted tenant session key reads that session's actor's usable stores — their ids,
--         tenants, names and read-only flags — with no audit record (the customer reads' owner decision, G-AUDIT);
--       * a database log that captures bind parameters exposes session keys (G-DBROLE, G-PRIVACY; DA-102);
--       * tmpos_app may UPDATE public.store.store_name (005), so the name served is whatever was last written there when
--         it is 1-256 characters long; no control-character or Bidi_Control rule applies to it, unlike a customer name;
--       * the rollback order is not enforced by the database: 026's or an earlier rollback run while this file is applied
--         succeeds or refuses on its own guard, and this routine keeps answering from the tables 001-018 own (it calls
--         nothing 019-026 created). Roll 027 back before 026.
--   - DEPLOY AND ROLLBACK: FORWARD-ONLY IN EFFECT, FAIL CLOSED. It and the runtime that requires 001-027 move together: the
--     runtime's startup preflight pins the exact ledger and the exact grants, so the 001-026 runtime refuses a 027 database
--     (its approved grants lack the EXECUTE and the schema USAGE) and this runtime refuses a 026 one. The rollback holds no
--     data of its own to protect and refuses only while an invoice draft object of migration 028 exists. ROLL 028 BACK
--     BEFORE 027.
--   - NO SECRET, NO DYNAMIC SQL, NO EXTENSION, NO TEMPORARY OBJECT. Every statement is fixed text, every value a parameter,
--     every relation and routine schema-qualified; the routine pins its search_path to pg_catalog then pg_temp and runs with
--     row_security off (020's reason: the owner's reads must not depend on the caller's policies). There is no backfill.
--
-- Reversible via 027_m7b_store_access.down.sql, which refuses while an invoice draft object of migration 028 exists, and
-- otherwise removes exactly what this file created. Roll 028 back before 027, and 027 before 026.
--
-- Assumes 001-026 are applied. A future managed apply targets the complete contiguous chain through the newest committed
-- migration — now 001-027 (owner decision D4); this file authorizes no apply.

-- =============================================================================
-- 0) This transaction's search path
-- =============================================================================
set local search_path = pg_catalog, pg_temp;

-- =============================================================================
-- 1) Preconditions: what this file builds on
-- =============================================================================
do $$
begin
  -- The chain is contiguous: 026 is the newest migration this file sits on.
  if pg_catalog.to_regprocedure('tmpos_role_invoice.m7a_invoice_role_level_states(uuid)') is null
     or pg_catalog.to_regprocedure('tmpos_role_invoice.m7a_invoice_role_level_set(text, text, text, uuid, bigint)') is null then
    raise exception 'migration 027 refused: migration 026 must be applied first'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- The objects the routine reads: 011's session table, 018's mint ledger and issuer key, 016's v2 admission, 002's tables.
  if pg_catalog.to_regclass('tmpos_session.session') is null
     or pg_catalog.to_regclass('tmpos_mint.tenant_session') is null
     or pg_catalog.to_regclass('tmpos_mint.issuer_key') is null
     or pg_catalog.to_regprocedure('tmpos_session.m5_admit_tenant_session_v2(text, text)') is null
     or pg_catalog.to_regclass('public.store') is null
     or pg_catalog.to_regclass('public.tenant') is null
     or pg_catalog.to_regclass('public.user_membership') is null then
    raise exception 'migration 027 refused: the session table, the mint ledger, the issuer key, 016''s admission or 002''s tables are missing'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- The runtime roles this file grants to and revokes from.
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'tmpos_app')
     or not exists (select 1 from pg_catalog.pg_roles where rolname = 'tmpos_audit_writer') then
    raise exception 'migration 027 refused: migration 005 must be applied first'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- Nothing of this file exists yet: it is applied once, over a chain that has never held it.
  if pg_catalog.to_regnamespace('tmpos_store_access') is not null then
    raise exception 'migration 027 refused: schema tmpos_store_access already exists'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- The routine calls 016's admission read as its owner, the principal applying this file.
  if not pg_catalog.has_function_privilege(current_user, 'tmpos_session.m5_admit_tenant_session_v2(text, text)', 'EXECUTE') then
    raise exception 'migration 027 refused: the applying principal cannot execute 016''s admission read, which the routine calls'
      using errcode = 'insufficient_privilege';
  end if;
  -- A SECURITY DEFINER routine reads only what its OWNER may (020's argument), and with row_security off a FORCEd table
  -- would make it fail rather than hide rows: the applier owns or inherits every table read, none forced.
  if exists (
    select 1
      from pg_catalog.pg_class c
     where c.oid = any (array['tmpos_session.session'::regclass, 'tmpos_mint.tenant_session'::regclass,
                              'tmpos_mint.issuer_key'::regclass, 'public.store'::regclass, 'public.tenant'::regclass,
                              'public.user_membership'::regclass])
       and (not pg_catalog.pg_has_role(current_user, c.relowner, 'USAGE') or c.relforcerowsecurity)) then
    raise exception 'migration 027 refused: the applying principal neither owns nor inherits the owner of tmpos_session.session, tmpos_mint.tenant_session, tmpos_mint.issuer_key, public.store, public.tenant and public.user_membership, or one has forced row security'
      using errcode = 'insufficient_privilege';
  end if;
  if not (pg_catalog.has_table_privilege(current_user, 'tmpos_session.session', 'SELECT')
          and pg_catalog.has_table_privilege(current_user, 'tmpos_mint.tenant_session', 'SELECT')
          and pg_catalog.has_table_privilege(current_user, 'tmpos_mint.issuer_key', 'SELECT')
          and pg_catalog.has_table_privilege(current_user, 'public.store', 'SELECT')
          and pg_catalog.has_table_privilege(current_user, 'public.tenant', 'SELECT')
          and pg_catalog.has_table_privilege(current_user, 'public.user_membership', 'SELECT')) then
    raise exception 'migration 027 refused: the applying principal lacks SELECT on a table the routine reads'
      using errcode = 'insufficient_privilege';
  end if;
end
$$;

-- =============================================================================
-- 2) The schema
-- =============================================================================
create schema tmpos_store_access;

comment on schema tmpos_store_access is
  'Phase 4.0 M7b (migration 027): the session-bound store discovery read behind GET /api/v1/stores. Owned by this migration; tmpos_app holds USAGE and EXECUTE only.';

revoke all on schema tmpos_store_access from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
grant usage on schema tmpos_store_access to tmpos_app;

-- =============================================================================
-- 3) The routine
-- =============================================================================
create function tmpos_store_access.m7b_store_directory(p_session_key text)
returns table (
  o_outcome    text,
  o_store_id   uuid,
  o_tenant_id  uuid,
  o_store_name text,
  o_read_only  boolean
)
language plpgsql
-- STABLE IS LOAD-BEARING (017's reason): the session, the admission and the store rows are read on the calling statement's
-- snapshot, so the stores answered are the ones that snapshot's grants and statuses allow. It locks and writes nothing.
stable
security definer
set search_path = pg_catalog, pg_temp
set row_security = off
as $$
declare
  v_now       bigint := pg_catalog.floor(extract(epoch from pg_catalog.statement_timestamp()) * 1000)::bigint;
  v_session   record;
  v_issuer    bytea;
  v_admission record;
begin
  -- 0. The argument: a session key is printable ASCII (sessions.ts); anything else asks nothing.
  if p_session_key is null or p_session_key !~ '^[\x21-\x7e]{1,128}$' then
    return query select 'invalid'::text, null::uuid, null::uuid, null::text, null::boolean;
    return;
  end if;

  -- 1. 022's session read: a minted, live tenant session, its mint's expiry unchanged. A revoked session has no row.
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
    return query select 'denied'::text, null::uuid, null::uuid, null::text, null::boolean;
    return;
  end if;

  -- 2. Minted under the issuer key installed now.
  select pg_catalog.sha256(k.key) into v_issuer from tmpos_mint.issuer_key k where k.singleton;
  if v_issuer is null or v_issuer is distinct from v_session.issuer_digest then
    return query select 'denied'::text, null::uuid, null::uuid, null::text, null::boolean;
    return;
  end if;

  -- 3. The principal's standing is still the one the session was minted at: 016's v2 admission, digested exactly as 018
  --    digested it at mint. Any grant, status or version change since ends this read.
  select r.outcome, r.actor_id, r.account_status, r.memberships,
         pg_catalog.sha256(pg_catalog.convert_to(r::text, 'UTF8')) as digest
    into strict v_admission
    from tmpos_session.m5_admit_tenant_session_v2(v_session.auth_provider, v_session.auth_provider_uid) r;
  if v_admission.outcome is distinct from 'resolved'
     or v_admission.digest is distinct from v_session.standing_digest
     or v_admission.actor_id is null
     or pg_catalog.jsonb_typeof(v_admission.memberships) is distinct from 'array' then
    return query select 'denied'::text, null::uuid, null::uuid, null::text, null::boolean;
    return;
  end if;

  -- 4. The account's status admits a read (the positive set: a status this file does not know denies).
  if v_admission.account_status is null
     or v_admission.account_status not in ('active', 'trialing', 'overdue', 'read_only') then
    return query select 'denied'::text, null::uuid, null::uuid, null::text, null::boolean;
    return;
  end if;

  -- 5. The stores. Every store-scope grant of the admitted standing that is still that actor's active membership row at
  --    exactly that tenant, store and role, whose store row is in the grant's tenant, with a read-status tenant and store.
  --    A store with more than one such grant is ambiguous and is left out; a tenant grant contributes nothing.
  return query
    with grants as (
      select (e.entry ->> 'membershipId')::uuid as membership_id,
             (e.entry ->> 'tenantId')::uuid     as tenant_id,
             (e.entry ->> 'storeId')::uuid      as store_id,
             e.entry ->> 'roleId'               as role_id
        from pg_catalog.jsonb_array_elements(v_admission.memberships) as e(entry)
       where e.entry ->> 'scopeType' = 'store'
    ),
    usable as (
      -- The SERVED name: the stored one when it is 1-256 characters long (the runtime's rule), otherwise NULL.
      select g.store_id, g.tenant_id,
             case when pg_catalog.char_length(st.store_name) between 1 and 256 then st.store_name end as store_name,
             st.status as store_status, t.status as tenant_status
        from grants g
        join public.user_membership um
          on um.membership_id = g.membership_id
         and um.internal_user_id = v_admission.actor_id
         and um.status = 'active'
         and um.scope_type = 'store'
         and um.tenant_id = g.tenant_id
         and um.store_id = g.store_id
         and um.role_id = g.role_id
        join public.store st on st.store_id = g.store_id and st.tenant_id = g.tenant_id
        join public.tenant t on t.tenant_id = g.tenant_id
       where st.status in ('active', 'trialing', 'overdue', 'read_only')
         and t.status in ('active', 'trialing', 'overdue', 'read_only')
    )
    select 'store'::text, u.store_id, u.tenant_id, u.store_name,
           (v_admission.account_status in ('overdue', 'read_only')
            or u.tenant_status in ('overdue', 'read_only')
            or u.store_status in ('overdue', 'read_only'))
      from usable u
     where (select pg_catalog.count(*) from usable x where x.store_id = u.store_id) = 1
     order by u.store_name collate "C" nulls last, u.store_id
     limit 200;
end
$$;

comment on function tmpos_store_access.m7b_store_directory(text) is
  'Phase 4.0 M7b (migration 027): for a key naming a minted, live tenant session under the installed issuer key whose principal''s 016 v2 admission still digests to the minted standing and whose account status is active, trialing, overdue or read_only, one (''store'', store id, tenant id, served name, read_only) row per store where the admission names exactly one store-scope grant that is still that actor''s active membership at that tenant, store and role, whose store row is in that tenant, with tenant and store statuses active, trialing, overdue or read_only; a store with two or more such grants is left out. read_only is true when the account, tenant or store is overdue or read_only. The served name is store_name when its char_length is 1-256, otherwise NULL. Ordered by the served name collate "C" nulls last, then store_id; at most 200 rows; no row when there is none. Otherwise one (''denied'', NULLs) row, or (''invalid'', NULLs) for a malformed key. STABLE: locks and writes nothing.';

-- =============================================================================
-- 4) Privileges, and the proof that nothing wider was issued
-- =============================================================================
-- PostgreSQL grants EXECUTE on a new function to PUBLIC by default, so every default is removed explicitly before the one
-- intended grant is issued.
revoke all on function tmpos_store_access.m7b_store_directory(text) from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
grant execute on function tmpos_store_access.m7b_store_directory(text) to tmpos_app;

-- =============================================================================
-- 5) Postcondition
-- =============================================================================
-- Proven rather than asserted, in 026's form. This file refuses to finish unless, now:
--   (a) the schema holds exactly the one routine, and no relation, index, standalone type or trigger;
--   (b) the routine is plpgsql, SECURITY DEFINER, STABLE, pinned to the search path above and run with row_security off,
--       and it and the schema are owned by the applying principal;
--   (c) the routine carries no grant beyond its owner's and a non-grantable EXECUTE to tmpos_app;
--   (d) the schema carries no grant beyond its owner's and a non-grantable USAGE to tmpos_app;
--   (f) tmpos_app CAN execute the routine and use the schema; tmpos_audit_writer, anon and authenticated CANNOT execute it by
--       any path;
--   (g) none of the runtime roles is a MEMBER of the owner of the schema, the routine, or a table the routine reads;
--   (j) tmpos_app and tmpos_audit_writer are members of NOTHING;
--   (k) anon and authenticated reach neither tmpos_app nor tmpos_audit_writer by any membership.
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
  if (select pg_catalog.count(*) from pg_catalog.pg_proc p where p.pronamespace = 'tmpos_store_access'::regnamespace) <> 1
     or pg_catalog.to_regprocedure('tmpos_store_access.m7b_store_directory(text)') is null
     or exists (select 1 from pg_catalog.pg_class c where c.relnamespace = 'tmpos_store_access'::regnamespace)
     or exists (select 1 from pg_catalog.pg_type t
                 where t.typnamespace = 'tmpos_store_access'::regnamespace and t.typrelid = 0 and t.typelem = 0) then
    raise exception 'migration 027 refused: schema tmpos_store_access does not hold exactly the one routine this file creates'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (b)
  if (select pg_catalog.count(*)
        from pg_catalog.pg_proc p
        join pg_catalog.pg_language l on l.oid = p.prolang
       where p.pronamespace = 'tmpos_store_access'::regnamespace
         and p.proname = 'm7b_store_directory'
         and l.lanname = 'plpgsql'
         and p.prosecdef
         and p.provolatile = 's'
         and p.prorettype <> 'pg_catalog.trigger'::regtype
         and p.proconfig = array['search_path=pg_catalog, pg_temp', 'row_security=off']
         and p.proowner = v_me) <> 1
     or not exists (select 1 from pg_catalog.pg_namespace n where n.oid = 'tmpos_store_access'::regnamespace and n.nspowner = v_me) then
    raise exception 'migration 027 refused: the routine in tmpos_store_access is not a STABLE plpgsql SECURITY DEFINER routine pinned to pg_catalog, pg_temp with row_security off, owned with its schema by the applying principal'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (c)
  select pg_catalog.string_agg(pg_catalog.format('%s %s:%s', p.proname, g.grantee::regrole::text, g.privilege_type), ', ')
    into v_bad
    from pg_catalog.pg_proc p,
         pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g
   where p.pronamespace = 'tmpos_store_access'::regnamespace
     and g.grantee <> p.proowner
     and not (g.grantee = 'tmpos_app'::regrole and g.privilege_type = 'EXECUTE' and not g.is_grantable);
  if v_bad is not null then
    raise exception 'migration 027 refused: an unexpected direct grant remains on the tmpos_store_access routine (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if (select pg_catalog.count(*) from pg_catalog.pg_proc p,
             pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g
       where p.pronamespace = 'tmpos_store_access'::regnamespace
         and g.grantee = 'tmpos_app'::regrole and g.privilege_type = 'EXECUTE' and not g.is_grantable) <> 1 then
    raise exception 'migration 027 refused: tmpos_app does not hold a direct EXECUTE on the tmpos_store_access routine'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (d)
  select pg_catalog.string_agg(pg_catalog.format('%s:%s', g.grantee::regrole::text, g.privilege_type), ', ')
    into v_bad
    from pg_catalog.pg_namespace n,
         pg_catalog.aclexplode(coalesce(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) g
   where n.oid = 'tmpos_store_access'::regnamespace
     and g.grantee <> n.nspowner
     and not (g.grantee = 'tmpos_app'::regrole and g.privilege_type = 'USAGE' and not g.is_grantable);
  if v_bad is not null then
    raise exception 'migration 027 refused: schema tmpos_store_access carries an unexpected grant (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (f)
  if not pg_catalog.has_function_privilege('tmpos_app', 'tmpos_store_access.m7b_store_directory(text)'::regprocedure, 'EXECUTE')
     or not pg_catalog.has_schema_privilege('tmpos_app', 'tmpos_store_access'::regnamespace, 'USAGE') then
    raise exception 'migration 027 refused: tmpos_app does not hold EXECUTE on the routine and USAGE on schema tmpos_store_access'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  select pg_catalog.string_agg(distinct pg_catalog.format('%s: %s', r.rolname, p.oid::regprocedure), ', ') into v_bad
    from pg_catalog.pg_roles r
    join pg_catalog.pg_roles x on pg_catalog.pg_has_role(r.oid, x.oid, 'MEMBER')
    cross join pg_catalog.pg_proc p
   where p.pronamespace = 'tmpos_store_access'::regnamespace
     and r.rolname = any (array['tmpos_audit_writer', 'anon', 'authenticated']::name[])
     and pg_catalog.has_function_privilege(x.oid, p.oid, 'EXECUTE');
  if v_bad is not null then
    raise exception 'migration 027 refused: a runtime role other than tmpos_app can execute the tmpos_store_access routine (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (g)
  select pg_catalog.string_agg(distinct r.rolname::text, ', ') into v_bad
    from pg_catalog.pg_roles r
    cross join (
      select n.nspowner as owner from pg_catalog.pg_namespace n where n.nspname = 'tmpos_store_access'
      union
      select p.proowner from pg_catalog.pg_proc p where p.pronamespace = 'tmpos_store_access'::regnamespace
      union
      select c.relowner from pg_catalog.pg_class c
       where c.oid in ('tmpos_session.session'::regclass, 'tmpos_mint.tenant_session'::regclass, 'tmpos_mint.issuer_key'::regclass,
                       'public.store'::regclass, 'public.tenant'::regclass, 'public.user_membership'::regclass)
    ) o
   where r.rolname = any (array['tmpos_app', 'tmpos_audit_writer', 'anon', 'authenticated']::name[])
     and pg_catalog.pg_has_role(r.oid, o.owner, 'MEMBER');
  if v_bad is not null then
    raise exception 'migration 027 refused: % is a member of the owner of schema tmpos_store_access, its routine, or a table it reads', v_bad
      using errcode = 'object_not_in_prerequisite_state',
            hint = 'membership hands a role everything the owner holds, including a direct read of every session and grant';
  end if;

  -- (j)
  select pg_catalog.string_agg(pg_catalog.format('%s in %s', m.member::regrole, m.roleid::regrole), ', '
                               order by m.member, m.roleid) into v_bad
    from pg_catalog.pg_auth_members m
    join pg_catalog.pg_roles r on r.oid = m.member
   where r.rolname = any (array['tmpos_app', 'tmpos_audit_writer']::name[]);
  if v_bad is not null then
    raise exception 'migration 027 refused: tmpos_app and tmpos_audit_writer must be members of nothing (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (k)
  select pg_catalog.string_agg(pg_catalog.format('%s in %s', r.rolname, t.rolname), ', ' order by r.rolname, t.rolname)
    into v_bad
    from pg_catalog.pg_roles r
    cross join pg_catalog.pg_roles t
   where r.rolname = any (array['anon', 'authenticated']::name[])
     and t.rolname = any (array['tmpos_app', 'tmpos_audit_writer']::name[])
     and pg_catalog.pg_has_role(r.oid, t.oid, 'MEMBER');
  if v_bad is not null then
    raise exception 'migration 027 refused: anon and authenticated must reach neither tmpos_app nor tmpos_audit_writer by membership (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$$;

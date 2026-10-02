-- Phase 4.0 M7a — the tenant customer name search: the customers of the tenant a minted tenant session is admitted to whose
-- name contains a search text, case-insensitively, one bounded keyset page at a time, through one session-bound routine
-- that re-decides the list's authority in the snapshot it reads the page in (M7A-CUSTOMERS-P8; G-IAM, G-DBROLE;
-- docs/phase-4/10)
-- Migration: 025_m7a_customer_search (UP)
--
-- SCOPE / TRUTH (binding):
--   - ONE NEW SCHEMA, ONE ROUTINE, TWO GRANTS, NO TABLE, NO INDEX, NO COLUMN, NO ROLE, NO MEMBERSHIP, NO TRIGGER, NO TYPE.
--     This file creates schema tmpos_customer_search and in it the one routine tmpos_app may execute: m7a_customer_search
--     (GET /api/v1/customers?q=…). It touches no object an earlier migration created and no ACL of one: 001-024 stay byte
--     for byte as committed (the migration-files contract's pinned checksums prove that), and tmpos_app gains no privilege
--     on 017's customer table, its columns or 017's page.
--   - WHY A NEW SCHEMA. 022's reason: 020's postcondition pins tmpos_role to exactly its routines and 020's rollback drops
--     it without CASCADE; 022's and 024's postconditions pin tmpos_customer_detail and tmpos_customer_edit to their own
--     routines, and 024's rollback refuses once a customer is edited. A read routine shares none of those rollbacks.
--   - THE AUTHORITY IS 022'S, COPIED, NOT CALLED. The routine's authority argument is the session key only; its tenant is
--     derived from the session inside the database exactly as 022's m7a_customer_get derives it (steps 1-6.5 below are
--     022's, statement for statement: a minted, live, tenant-audience session under the installed issuer key; its
--     principal's standing the one minted; exactly one tenant-scope grant; the role's CURRENT Customers level at View or
--     above — store_owner full; manager, technician, sales_staff the owner's stored level in 020's table, else the catalog
--     default; any other role refused; then 017's rechecks of that derived authority on the same snapshot: the account's
--     status and security version, exactly one eligible active tenant grant and it that membership, role and tenant, the
--     tenant's status). It calls none of 017's, 018's, 020's or 022's routines: 022's answers one row, and 017's page is
--     revoked from the runtime and answers no search. p_expected_tenant is the runtime's trusted scope's tenant, a
--     PRECONDITION, never a selector: a session whose derived tenant is another answers 'denied' before any customer row is
--     read. A revoked session (011's m5_session_revoke removes its row) finds no row and answers 'denied'.
--   - THE MATCH. A customer matches when its name contains the search text, compared after the ICU root locale's FULL
--     uppercase mapping of both sides (pg_catalog."und-x-icu": 'é' and 'É' match, 'ß' and 'SS' match, 'ı' and 'I' match),
--     by a LIKE whose pattern is the uppercased text with every '\', '%' and '_' escaped, between two '%' — so those three
--     characters are literal and nothing in the text is a wildcard. The comparison itself is in the "C" collation, byte
--     for byte over the uppercased UTF-8. It is NOT a normalization: a name stored decomposed (NFD) does not match its
--     composed (NFC) spelling, and no accent folding is done ('e' does not match 'é'). The routine refuses to apply
--     (section 1) where the ICU collation is absent, so the match is never silently a different one.
--   - THE PAGE. At most p_limit (1-101: the runtime asks one more than its page to know another follows) matching
--     customers of the derived tenant, in 017's page order — (name collate "C", customer_id), a total order, so pages
--     never overlap. A continuation names a customer id: the routine reads THAT customer's CURRENT name within the derived
--     tenant (a missing id and another tenant's id are the same one row ('cursor_unknown', nulls), told only to an
--     authorized caller) and answers the matches strictly after (name, id). The anchor need not match the text: a
--     customer renamed between pages still positions the next one. The first page and a continuation are two statements
--     (017's shape), so a continuation's keyset predicate is an index condition on 017's customer_tenant_page_idx.
--   - ANSWERS. Rows (o_outcome, o_tenant_id, o_customer_id, o_name): ('customer', tenant, id, name) per match, none when
--     nothing matches; or exactly ONE row ('denied', nulls) | ('cursor_unknown', nulls) | ('invalid', nulls) for a null
--     or malformed argument — the key's shape (022's), a null tenant, a null or empty text, a text longer than 200
--     characters or holding a character 017's customer_name_chk refuses anywhere in a name (C0 and C1 controls, DEL,
--     U+2028/U+2029, every Bidi_Control character; its edge-whitespace rule does not apply to a search text), a limit null
--     or outside 1-101 — which the runtime never sends (its adapter reads 'invalid' as a fault). It locks nothing and
--     writes nothing: STABLE, so every statement runs on the calling statement's snapshot (017's load-bearing reason), and
--     a narrowing, a revocation or a suspension that commits while it runs is seen by all of its statements or none.
--   - WHAT IT DOES NOT DO. It writes no audit record (the list's owner decision; doc 08 G-AUDIT), no outbox event and no
--     idempotency completion. It reads no field beyond the id and the name. No message it raises carries the text, a name
--     or a key: it raises nothing of its own.
--   - WHAT THIS DOES NOT DEFEND (doc 08; none of it is claimed closed). 022's and 020's page_v3 residuals stand for this
--     read, and:
--       * COST: no index serves a substring match. Each search reads the derived tenant's customers in page order through
--         customer_tenant_page_idx (a continuation from its position) and uppercases every name it visits until the page
--         is full, so a rare or absent text visits the tenant's whole remaining range: linear in the tenant's customers,
--         bounded by the runtime's statement timeout (CUSTOMER_DIRECTORY_BOUNDS) and, over HTTP, by the per-client limiter.
--         A trigram or expression index is a later decision (it needs an extension or a column, which this file does not
--         touch). The stage measured the statements with EXPLAIN (ANALYZE, BUFFERS) over a synthetic 20,000-customer tenant;
--       * a holder of tmpos_app plus a live minted key calls m7a_customer_search directly for that key's tenant — the class
--         of page_v3's and 022's direct calls, no new exposure; the text reaches no other tenant;
--       * a database log that captures bind parameters exposes session keys and search texts (G-DBROLE, G-PRIVACY; DA-102);
--       * the rollback order is not enforced by the database. 020's rollback run while this file is applied leaves this
--         routine RAISING at call for an editable role (it reads 020's role-level table; the store owner's path never does)
--         — failing closed (the runtime answers 503); 022's, 023's or 024's leaves it working (it reads none of their
--         objects). Either way this file's rollback then refuses (its postcondition requires 020's, 022's and 024's
--         routines) until they are applied again. The supported order: 025 down first, then 024, 023, 022, 021, 020.
--   - DEPLOY AND ROLLBACK. It and the runtime that requires 001-025 move together: the P8 runtime's startup preflight pins
--     exactly 001-025 and these two grants, and the previous build refuses a 025 database (its approved grants lack them).
--     This file holds no data, so its rollback has no data guard: rolling back 025 alone returns exactly the 001-024
--     database, whatever customers exist or were edited.
--   - NO SECRET, NO DYNAMIC SQL, NO EXTENSION, NO TEMPORARY OBJECT. Every statement is fixed text, every value a parameter,
--     every relation, routine and collation schema-qualified; the routine pins its search_path to pg_catalog then pg_temp
--     and runs with row_security off, so were row security ever FORCEd on a table it reads it fails (503) instead of
--     silently refusing. No backfill, no lock beyond the catalog's.
--
-- Reversible via 025_m7a_customer_search.down.sql, which removes exactly what this file created. Roll 025 back before 024.
--
-- Assumes 001-024 are applied. A future managed apply targets the complete contiguous chain through the newest committed
-- migration — now 001-025 (owner decision D4); this file authorizes no apply.

-- =============================================================================
-- 0) This transaction's search path
-- =============================================================================
set local search_path = pg_catalog, pg_temp;

-- =============================================================================
-- 1) Preconditions: what this file builds on
-- =============================================================================
do $$
begin
  -- The chain is contiguous: 024 is the newest migration this file sits on.
  if pg_catalog.to_regprocedure('tmpos_customer_edit.m7a_customer_profile(text, uuid, uuid)') is null
     or pg_catalog.to_regprocedure('tmpos_customer_edit.m7a_customer_update(text, uuid, uuid, bigint, text, boolean, text, boolean, text)') is null then
    raise exception 'migration 025 refused: migration 024 must be applied first'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- The objects the routine restates the authority of: 020's page_v3 and role levels, 022's read.
  if pg_catalog.to_regprocedure('tmpos_role.m7a_customer_page_v3(text, uuid, integer)') is null
     or pg_catalog.to_regclass('tmpos_role.tenant_role_level') is null
     or pg_catalog.to_regprocedure('tmpos_customer_detail.m7a_customer_get(text, uuid, uuid)') is null
     or pg_catalog.to_regclass('tmpos_customer.customer') is null then
    raise exception 'migration 025 refused: migration 020''s page_v3 or role levels, 022''s read or 017''s customer table is missing'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- The match is the ICU root locale's: without that collation the routine could not be created, or would match another way.
  if not exists (select 1 from pg_catalog.pg_collation c
                  where c.collname = 'und-x-icu'
                    and c.collnamespace = 'pg_catalog'::regnamespace
                    and c.collprovider = 'i') then
    raise exception 'migration 025 refused: the ICU root collation pg_catalog."und-x-icu" is absent (a PostgreSQL built with ICU is required)'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- The runtime roles this file grants to and revokes from.
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'tmpos_app')
     or not exists (select 1 from pg_catalog.pg_roles where rolname = 'tmpos_audit_writer') then
    raise exception 'migration 025 refused: migration 005 must be applied first'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- Nothing of this file exists yet: it is applied once, over a chain that has never held it.
  if pg_catalog.to_regnamespace('tmpos_customer_search') is not null then
    raise exception 'migration 025 refused: schema tmpos_customer_search already exists'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- The definer calls 016's admission read and 007's security version as its owner, the principal applying this file.
  if not (pg_catalog.has_function_privilege(current_user, 'tmpos_session.m5_admit_tenant_session_v2(text, text)', 'EXECUTE')
          and pg_catalog.has_function_privilege(current_user, 'tmpos_identity.m5_security_version(uuid)', 'EXECUTE')) then
    raise exception 'migration 025 refused: the applying principal cannot execute 016''s admission read and 007''s security version, which the definer calls'
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
    raise exception 'migration 025 refused: the applying principal neither owns nor inherits the owner of a table the search rests on, or one has forced row security'
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
    raise exception 'migration 025 refused: the applying principal lacks SELECT on a table the search rests on, or USAGE on a schema it reaches'
      using errcode = 'insufficient_privilege';
  end if;
end
$$;

-- =============================================================================
-- 2) The schema
-- =============================================================================
create schema tmpos_customer_search;

comment on schema tmpos_customer_search is
  'Phase 4.0 M7a (migration 025): the tenant customer name search — the one session-bound routine GET /api/v1/customers?q= goes through. Owned by this migration; tmpos_app holds USAGE and EXECUTE only.';

revoke all on schema tmpos_customer_search from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
grant usage on schema tmpos_customer_search to tmpos_app;

-- =============================================================================
-- 3) The routine
-- =============================================================================
create function tmpos_customer_search.m7a_customer_search(
  p_session_key text, p_expected_tenant uuid, p_query text, p_after_customer_id uuid, p_limit integer)
returns table (
  o_outcome     text,
  o_tenant_id   uuid,
  o_customer_id uuid,
  o_name        text
)
language plpgsql
-- STABLE IS LOAD-BEARING (017's and 022's reason): every statement below — the session, the level, 017's rechecks, the
-- continuation's position and the page — runs on the calling statement's snapshot. It locks nothing and can write nothing.
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
  v_pattern   text;
  v_after_name text collate pg_catalog."C";
begin
  -- 0. Every argument, before anything is read. The text: 1-200 characters, none that 017's customer_name_chk refuses
  --    anywhere in a name (its first two clauses, restated: C0 and C1 controls, DEL, U+2028/U+2029, and the Bidi_Control
  --    characters). The limit: 017's page bound.
  if p_session_key is null or p_session_key !~ '^[\x21-\x7e]{1,128}$'
     or p_expected_tenant is null
     or p_query is null
     or pg_catalog.char_length(p_query) < 1
     or pg_catalog.char_length(p_query) > 200
     or p_query ~ '[\u0001-\u001f\u007f-\u009f\u2028\u2029]'
     or p_query ~ '[\u061c\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069]'
     or p_limit is null
     or p_limit < 1
     or p_limit > 101 then
    return query select 'invalid'::text, null::uuid, null::uuid, null::text;
    return;
  end if;

  -- 1-4. Exactly 022's (020's page_v3; see there): a minted, live tenant session under the installed key, its principal's
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

  -- 5. Exactly 022's: the role's effective Customers level must meet View — store_owner Full; an editable role its stored
  --    level, else its catalog default; any other role 'denied'. Unlocked, on this call's snapshot.
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

  -- 6. 017's page rechecks, copied as 022 copies them (017 section 4, its argument guard and steps 1-5), for the derived
  --    authority.
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

  -- 7. The pattern: the text's ICU root full uppercase, its '\' then '%' and '_' escaped (backslash first, so an escape
  --    is never escaped again), between two '%'. Nothing of the text is a wildcard.
  v_pattern := '%' || pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(
                 pg_catalog.upper(p_query collate pg_catalog."und-x-icu"), '\', '\\'), '%', '\%'), '_', '\_') || '%';

  -- 8. The first page needs no continuation: the derived tenant's matches, in page order.
  if p_after_customer_id is null then
    return query
      select 'customer'::text, c.tenant_id, c.customer_id, c.name::text
        from tmpos_customer.customer c
       where c.tenant_id = v_tenant
         and (pg_catalog.upper(c.name collate pg_catalog."und-x-icu") collate pg_catalog."C") like (v_pattern collate pg_catalog."C") escape '\'
       order by c.name collate pg_catalog."C", c.customer_id
       limit p_limit;
    return;
  end if;

  -- 9. The continuation's position: that customer's CURRENT name, read in this same snapshot and ONLY within the derived
  --    tenant (017's lookup). A missing id and another tenant's id are the same row. It need not match the text.
  select c.name into v_after_name
    from tmpos_customer.customer c
   where c.tenant_id = v_tenant
     and c.customer_id = p_after_customer_id;
  if not found then
    return query select 'cursor_unknown'::text, null::uuid, null::uuid, null::text;
    return;
  end if;

  -- 10. The matches strictly after that position, in page order.
  return query
    select 'customer'::text, c.tenant_id, c.customer_id, c.name::text
      from tmpos_customer.customer c
     where c.tenant_id = v_tenant
       and (c.name collate pg_catalog."C", c.customer_id) > (v_after_name collate pg_catalog."C", p_after_customer_id)
       and (pg_catalog.upper(c.name collate pg_catalog."und-x-icu") collate pg_catalog."C") like (v_pattern collate pg_catalog."C") escape '\'
     order by c.name collate pg_catalog."C", c.customer_id
     limit p_limit;
end
$$;

comment on function tmpos_customer_search.m7a_customer_search(text, uuid, text, uuid, integer) is
  'Phase 4.0 M7a (migration 025): one bounded keyset page of (tenant id, customer id, name), in (name collate "C", customer_id) order, of the customers whose name contains p_query after the ICU root locale''s full uppercase of both sides (\, % and _ literal), of the tenant derived from a key naming a ledger-minted, live (database clock), tenant session minted under the installed issuer key whose principal''s standing digest is unchanged, who holds exactly one tenant grant — which must be p_expected_tenant''s, a precondition only — and whose role''s Customers level (store_owner full; manager, technician, sales_staff the owner''s stored level, else the catalog default) is View or above, re-checked as 017''s page re-checks it (022''s decision, restated). After p_after_customer_id''s current (name, id) when given: ''cursor_unknown'' alike for a missing id and another tenant''s. ''denied'' otherwise; ''invalid'' for a null or malformed argument. No row when nothing matches. Read-only; locks nothing.';

-- =============================================================================
-- 4) Privileges, and the proof that nothing wider was issued
-- =============================================================================
-- PostgreSQL grants EXECUTE on a new function to PUBLIC by default, so every default is removed explicitly before the one
-- intended grant is issued. Nothing else: no table or column grant — tmpos_app keeps no privilege on 017's customer table
-- and no EXECUTE on 017's page.
revoke all on function tmpos_customer_search.m7a_customer_search(text, uuid, text, uuid, integer) from public, anon, authenticated, tmpos_app, tmpos_audit_writer;

grant execute on function tmpos_customer_search.m7a_customer_search(text, uuid, text, uuid, integer) to tmpos_app;

-- The postcondition, proven rather than asserted, in 022's form. This file refuses to finish unless, now:
--   (a) the schema holds exactly the one routine, and no relation of any kind, no standalone type, and no trigger calls a
--       function of it;
--   (b) the routine is plpgsql, SECURITY DEFINER, STABLE, pinned to the search path above and run with row_security off,
--       and it and the schema are owned by the applying principal;
--   (c) the routine carries no grant beyond its owner's and a non-grantable EXECUTE to tmpos_app;
--   (d) the schema carries no grant beyond its owner's and a non-grantable USAGE to tmpos_app;
--   (e) tmpos_app CAN execute the routine and use the schema; tmpos_audit_writer, anon and authenticated CANNOT execute
--       it by any path (PUBLIC, an inherited role, or a role reachable only through SET ROLE);
--   (f) tmpos_app holds no privilege on 017's customer table or any of its columns and cannot execute 017's page, by any
--       path; no column of the table carries a grant;
--   (g) none of the runtime roles is a MEMBER of the owner of the schema or the routine;
--   (h) by presence: 020's page_v3 and table, 022's read and 024's two routines are still there.
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
  if (select pg_catalog.count(*) from pg_catalog.pg_proc p where p.pronamespace = 'tmpos_customer_search'::regnamespace) <> 1
     or pg_catalog.to_regprocedure('tmpos_customer_search.m7a_customer_search(text, uuid, text, uuid, integer)') is null
     or exists (select 1 from pg_catalog.pg_class c
                 where c.relnamespace = 'tmpos_customer_search'::regnamespace
                   and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S', 'c', 'i', 'I'))
     or exists (select 1 from pg_catalog.pg_type t
                 where t.typnamespace = 'tmpos_customer_search'::regnamespace and t.typrelid = 0 and t.typelem = 0)
     or exists (select 1 from pg_catalog.pg_trigger g join pg_catalog.pg_proc p on p.oid = g.tgfoid
                 where p.pronamespace = 'tmpos_customer_search'::regnamespace) then
    raise exception 'migration 025 refused: schema tmpos_customer_search does not hold exactly the one routine this file creates'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (b)
  if not exists (
       select 1
         from pg_catalog.pg_proc p
         join pg_catalog.pg_language l on l.oid = p.prolang
        where p.oid = 'tmpos_customer_search.m7a_customer_search(text, uuid, text, uuid, integer)'::regprocedure
          and l.lanname = 'plpgsql'
          and p.prosecdef
          and p.provolatile = 's'
          and p.proconfig = array['search_path=pg_catalog, pg_temp', 'row_security=off']
          and p.proowner = v_me)
     or not exists (select 1 from pg_catalog.pg_namespace n
                     where n.oid = 'tmpos_customer_search'::regnamespace and n.nspowner = v_me) then
    raise exception 'migration 025 refused: the routine is not a plpgsql STABLE SECURITY DEFINER routine pinned to pg_catalog, pg_temp with row_security off, owned with its schema by the applying principal'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (c)
  select pg_catalog.string_agg(pg_catalog.format('%s %s:%s', p.proname, g.grantee::regrole::text, g.privilege_type), ', ')
    into v_bad
    from pg_catalog.pg_proc p,
         pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g
   where p.pronamespace = 'tmpos_customer_search'::regnamespace
     and g.grantee <> p.proowner
     and not (g.grantee = 'tmpos_app'::regrole and g.privilege_type = 'EXECUTE' and not g.is_grantable);
  if v_bad is not null then
    raise exception 'migration 025 refused: an unexpected direct grant remains on the tmpos_customer_search routine (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (d)
  select pg_catalog.string_agg(pg_catalog.format('%s:%s', g.grantee::regrole::text, g.privilege_type), ', ')
    into v_bad
    from pg_catalog.pg_namespace n,
         pg_catalog.aclexplode(coalesce(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) g
   where n.oid = 'tmpos_customer_search'::regnamespace
     and g.grantee <> n.nspowner
     and not (g.grantee = 'tmpos_app'::regrole and g.privilege_type = 'USAGE' and not g.is_grantable);
  if v_bad is not null then
    raise exception 'migration 025 refused: schema tmpos_customer_search carries an unexpected grant (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (e)
  if not pg_catalog.has_function_privilege('tmpos_app',
           'tmpos_customer_search.m7a_customer_search(text, uuid, text, uuid, integer)'::regprocedure, 'EXECUTE')
     or not pg_catalog.has_schema_privilege('tmpos_app', 'tmpos_customer_search'::regnamespace, 'USAGE') then
    raise exception 'migration 025 refused: tmpos_app does not hold EXECUTE on the routine and USAGE on schema tmpos_customer_search'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  select pg_catalog.string_agg(distinct r.rolname::text, ', ') into v_bad
    from pg_catalog.pg_roles r
    join pg_catalog.pg_roles x on pg_catalog.pg_has_role(r.oid, x.oid, 'MEMBER')
   where r.rolname = any (array['tmpos_audit_writer', 'anon', 'authenticated']::name[])
     and pg_catalog.has_function_privilege(x.oid,
           'tmpos_customer_search.m7a_customer_search(text, uuid, text, uuid, integer)'::regprocedure, 'EXECUTE');
  if v_bad is not null then
    raise exception 'migration 025 refused: a runtime role other than tmpos_app can execute the tmpos_customer_search routine (%)', v_bad
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
          or pg_catalog.has_any_column_privilege(x.oid, 'tmpos_customer.customer'::regclass, 'SELECT, INSERT, UPDATE, REFERENCES')
          or pg_catalog.has_function_privilege(x.oid,
            'tmpos_customer.m7a_customer_page(uuid, text, uuid, text, uuid, uuid, integer)'::regprocedure, 'EXECUTE'));
  if v_bad is not null then
    raise exception 'migration 025 refused: % holds a privilege on tmpos_customer.customer or can execute 017''s page', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if exists (select 1 from pg_catalog.pg_attribute a
              where a.attrelid = 'tmpos_customer.customer'::regclass and a.attacl is not null) then
    raise exception 'migration 025 refused: a column grant exists on tmpos_customer.customer'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (g)
  select pg_catalog.string_agg(distinct r.rolname::text, ', ') into v_bad
    from pg_catalog.pg_roles r
    cross join (
      select n.nspowner as owner from pg_catalog.pg_namespace n where n.nspname = 'tmpos_customer_search'
      union
      select p.proowner from pg_catalog.pg_proc p where p.pronamespace = 'tmpos_customer_search'::regnamespace
    ) o
   where r.rolname = any (array['tmpos_app', 'tmpos_audit_writer', 'anon', 'authenticated']::name[])
     and pg_catalog.pg_has_role(r.oid, o.owner, 'MEMBER');
  if v_bad is not null then
    raise exception 'migration 025 refused: % is a member of the owner of schema tmpos_customer_search or its routine', v_bad
      using errcode = 'object_not_in_prerequisite_state',
            hint = 'membership hands a role everything the owner holds, including a direct read of every customer';
  end if;

  -- (h)
  if pg_catalog.to_regprocedure('tmpos_role.m7a_customer_page_v3(text, uuid, integer)') is null
     or pg_catalog.to_regclass('tmpos_role.tenant_role_level') is null
     or pg_catalog.to_regprocedure('tmpos_customer_detail.m7a_customer_get(text, uuid, uuid)') is null
     or pg_catalog.to_regprocedure('tmpos_customer_edit.m7a_customer_profile(text, uuid, uuid)') is null
     or pg_catalog.to_regprocedure('tmpos_customer_edit.m7a_customer_update(text, uuid, uuid, bigint, text, boolean, text, boolean, text)') is null then
    raise exception 'migration 025 refused: migration 020''s page_v3 or role table, 022''s read or 024''s routines are missing'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$$;

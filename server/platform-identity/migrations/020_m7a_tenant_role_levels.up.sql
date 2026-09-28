-- Phase 4.0 M7a — owner-edited Customers levels: a durable per-tenant level for each editable built-in role, written only
-- through a store owner's minted tenant session, and read by every customer decision in the database (M7A-CUSTOMERS-P3-R1;
-- G-IAM, G-DBROLE, DA-83, DA-85; docs/phase-4/10 ADR-34)
-- Migration: 020_m7a_tenant_role_levels (UP)
--
-- SCOPE / TRUTH (binding):
--   - ONE NEW SCHEMA, ONE TABLE, FOUR ROUTINES, THREE REVOKED GRANTS, NO ROLE, NO TRIGGER, NO TYPE. This file creates
--     schema tmpos_role; in it the table tmpos_role.tenant_role_level (one row per tenant, editable role and domain); and
--     the four routines tmpos_app may execute: m7a_role_levels (the levels read every HTTP decision uses),
--     m7a_role_level_set (the owner's edit), m7a_customer_create (019's create, its role allow-list REPLACED by the
--     effective level) and m7a_customer_page_v3 (018's read, plus the effective level). It revokes tmpos_app's EXECUTE on
--     019's tmpos_customer_write.m7a_customer_create and USAGE on its schema, and EXECUTE on 018's
--     tmpos_mint.m7a_customer_page_v2: both decide from the role NAME, so a role an owner narrowed would still create and
--     read through them. Those three ACL changes are its only effect on objects earlier migrations created: 001-019 stay
--     byte for byte as committed (the migration-files contract's pinned checksums prove that), and section 5's check (i)
--     checks 017's, 018's and 019's surfaces by count and exact signature only, not by definition.
--   - WHY A NEW SCHEMA. 017's, 018's and 019's reason: older rollbacks drop their schemas WITHOUT CASCADE, and older files
--     and suites assert exact inventories (017: tmpos_customer one routine; 018: tmpos_mint five; 019: tmpos_customer_write
--     one). A schema this file owns outright leaves each of them as it was.
--   - WHAT IS STORED, AND WHAT IS NOT. No server-authoritative role configuration existed: an owner's edit lived only in
--     the editing browser tab (doc 08 DA-85). This file stores exactly the one domain the server decides, 'customers', for
--     exactly the three roles the catalog lets an owner edit (manager, technician, sales_staff; server/platform-identity/
--     permissionCatalog.ts): storing a level the server does not enforce would read as enforced. A NULL level, or no row,
--     is the catalog default. store_owner is never stored: the catalog's owner short-circuit makes it Full everywhere and
--     not editable, and the create and the read answer Full for it by the literal. Custom roles, other domains, deletion and
--     delegated editing (the client's manage_role_permissions) are NOT supported: 003's CHECK admits four role ids, no
--     server path assigns another, and a delegated editor's authority is itself client-only (owner decisions, doc 08).
--   - ONE DEFINITION OF THE DEFAULTS, RESTATED, PINNED. The catalog's Customers defaults are manager full, technician
--     view, sales_staff create; the tenant ordering is none < view < create < edit < manage < approve < full. Each routine
--     below and the down file restate them, and tests/db/tenantRoleLevelRoutine.integration.test.mjs pins every
--     restatement — the default case, the ordering, the owner literal and the editable set — against the catalog, from
--     the installed routines' source and from both files.
--   - THE RUNTIME ROLE CANNOT READ OR WRITE THE TABLE. tmpos_app, tmpos_audit_writer, anon and authenticated hold no
--     privilege on it; row level security is enabled with no policy, not forced (011's posture). The only ways in are the
--     four routines, which run as the applying principal.
--   - THE EDIT'S ONLY AUTHORITY ARGUMENT IS THE SESSION KEY. m7a_role_level_set derives its editor exactly as 019's create
--     derives its caller — an unlocked live/issuer pre-check; 016's m5_hold_tenant_standing; the session row and its
--     mint-ledger row FOR SHARE; the issuer key row FOR SHARE; the database clock read after every wait; the standing
--     digest minted; an account status and a tenant status in ('active', 'trialing'); EXACTLY ONE tenant-scope grant —
--     and edits only when that grant's role is 'store_owner'. The target (role, domain, level) is validated against the
--     fixed sets; the tenant is the editor's, never a parameter.
--   - EVERY CUSTOMER DECISION READS THE SAME ROWS. The create's decision replaces 019's step 7 allow-list with the
--     effective Customers level at Create or above; the read's adds the effective level at View or above; the runtime's
--     HTTP decision reads the same rows through m7a_role_levels (keyed by the trusted scope's tenant and role, which come
--     from 016's admission answer). store_owner is Full; manager, technician and sales_staff are the stored level else the
--     default; any other role refuses. A read-limited status caps the runtime's decision at View, which meets View, so the
--     read's status rule is 017's, unchanged.
--   - THE ORDER A ROLE EDIT AND A CREATE TAKE (requirement 6). Both take their own 016 hold, session, ledger and issuer
--     rows first, then the ONE role row (tenant, role, 'customers'):
--       * the create: an UNLOCKED pre-read refuses, writing nothing and locking no role row, a key whose effective level
--         is already below Create; otherwise it inserts the row if absent (NULL level), takes it FOR SHARE, refuses if it is
--         gone, and decides on the locked value;
--       * the edit: inserts the row if absent, takes it FOR UPDATE, refuses if it is gone, and updates it.
--     An edit that holds the row first makes the create wait (on the row, or on the edit's uncommitted insert); once it
--     commits, the create's next statement reads the new level under READ COMMITTED and a narrowed role refuses. Each
--     reads the database clock once more after the role row's wait, so a session that expired while waiting refuses. A create
--     that holds the row first makes the edit wait until it commits. The edit touches no session, grant or standing: an
--     already-issued session keeps working, but is decided on the level as it stands at every request. There is no cycle:
--     distinct principals share only FOR SHARE locks in 016's hold, one principal serializes on its account FOR UPDATE,
--     and each transaction then takes the one role row. Every routine that locks requires READ COMMITTED and raises
--     otherwise (019's reason). The read locks nothing (018's STABLE read on one snapshot).
--   - ANSWERS. m7a_role_levels: the explicit non-null stored levels as a jsonb object ({"customers": "view"}) or '{}' — a
--     role with nothing stored, store_owner and any unknown role alike; a NULL argument raises invalid_parameter_value.
--     m7a_role_level_set: one row (o_tenant_id, o_actor_id, o_membership_id, o_level) — the editor's tenant, actor, grant
--     and the level stored, which the runtime compares with its trusted context — or NO row (any refusal). A refusal
--     writes no level: at most, one decided after the role row was made to exist leaves that NULL lock row, which is the
--     default and changes no decision (the runtime rolls back every refusal anyway). m7a_customer_create: 019's columns,
--     answers and SQLSTATEs (its fixed messages name 020, not 019); a refusal writes no customer, and at most the same
--     NULL lock row. m7a_customer_page_v3: 018's page_v2 columns and answers, exactly; a role below View answers
--     'denied', page_v2's answer for an unauthorized key. Every
--     raise carries a FIXED message (018's reason): 'invalid_parameter_value' for a null or malformed argument,
--     'object_not_in_prerequisite_state' outside READ COMMITTED, 'no_data_found' when a write wrote no row (an owner's
--     trigger), the create's 'check_violation' and 'unique_violation', and whatever 016's hold or read raises.
--   - WHAT IT DOES NOT DO. It writes no audit record, no outbox event and no idempotency completion: the runtime's command
--     transaction appends those around both writes (PUT /api/v1/roles/levels, POST /api/v1/customers); this file cannot
--     see whether it does. It records no reason and judges no recent authentication (the runtime's step-up for the edit).
--     It never deletes a row: a level can be set back to its default, not unset.
--   - WHAT THIS DOES NOT DEFEND (doc 08; none of it is claimed closed). 019's residuals stand for this create, and:
--       * a holder of tmpos_app plus a live minted session key calls m7a_customer_create directly and creates customers in
--         that session's tenant with NO audit, idempotency or outbox record, while the key's role holds Customers >= Create
--         (019's residual, now judged on the owner's level) — customer creates are audited ONLY through the HTTP route;
--       * a holder of tmpos_app plus a live minted STORE OWNER key calls m7a_role_level_set directly and changes that
--         tenant's Customers level for any editable role with NO audit, reason, step-up, idempotency or outbox record — a
--         new unaudited IAM-change path; role edits are audited ONLY through the HTTP route (G-AUDIT exception);
--       * every reader of tmpos_mint.issuer_key who also holds tmpos_app mints a session for any principal (018), a store
--         owner's included, and so edits any tenant's levels and creates in any tenant whose level allows it;
--       * LOCK HOLDING: after the pre-checks, a holder of tmpos_app plus any live key whose role's effective level passes
--         the pre-read holds its role row FOR SHARE for as long as it keeps its transaction open (the database ends no
--         transaction at session expiry), so the owner's edit of that role in that tenant waits until its own lock or
--         statement timeout (the runtime answers 503); a live store owner key holding the row FOR UPDATE through the edit
--         delays every create of that role in that tenant the same way — 019's lock-holding class (G-DBROLE, DA-82/DA-115);
--         and since a share locker does not queue behind a waiting FOR UPDATE (PostgreSQL's row locking), creates of one
--         role by two or more principals that keep overlapping, through the HTTP route too, can keep the owner's edit of
--         that role waiting until its lock timeout (503) — availability only: every create is decided on the level
--         committed when it locked the row;
--       * m7a_role_levels answers any tenant's stored levels to tmpos_app, keyed by a tenant id and a role id with no
--         session key — disclosure of the same class as 016's admission read of any principal's grants (DA-97);
--       * the runtime's decision and the database's are two reads of the same rows, in two statements: a narrowing that
--         commits between them is caught by the create's locked re-read, but a widening that commits between them can
--         leave the runtime refusing a create the database would now allow (fail closed);
--       * a database log that captures bind parameters exposes session keys (G-DBROLE, G-PRIVACY);
--       * the rollback order is not enforced by the database: a PL/pgSQL body records no dependency, so 016's, 017's,
--         018's or 019's rollback run while this file is applied succeeds, and these routines then RAISE on the missing
--         object — failing closed — and this file's rollback refuses until the chain is whole again.
--   - DEPLOY AND ROLLBACK MOVE WITH THE RUNTIME. This file is deliberately NOT expand-contract: a window granting both the
--     old routines and the new would keep the name-based allow-list reachable. So it and the runtime that requires 001-020
--     move together: the P3 runtime (its startup preflight pins exactly 001-019 and 019's grants) refuses to start on a
--     020 database, and a 020 runtime refuses on a 019 one. Rollback order: FIRST, while the 020 runtime still serves, the
--     owner sets every edited role back to its default (PUT /api/v1/roles/levels) and the operator confirms that the down
--     file's own check finds no non-default level; THEN the runtime to the P3 build; THEN this file's rollback with its
--     ledger row, which refuses while a stored level differs from its role's default (see the down file). No runtime
--     serves between the last two steps (the P3 build refuses a 020 database). The database does not enforce the order,
--     and in no order does the rollback silently re-widen a narrowed role (it refuses until every level is its default;
--     the owner's reset widens deliberately, through the audited route): rolled back before the
--     runtime switch, once the levels are reset, the 020 runtime fails closed (503) until replaced; the runtime switched
--     before the owner's reset leaves no runtime able to start until the 020 runtime is rolled forward again — closed.
--   - NO SECRET, NO DYNAMIC SQL, NO EXTENSION, NO TEMPORARY OBJECT. Every statement is fixed text, every value a
--     parameter, every relation and routine schema-qualified; every routine pins its search_path to pg_catalog then
--     pg_temp and runs with row_security off, so were row security ever FORCEd on a table one reads or writes it fails
--     (503) instead of silently refusing. Applying it adds a foreign key to public.tenant, which takes SHARE ROW EXCLUSIVE
--     on that table for the apply's duration; there is no backfill. Lock rows grow to at most three per tenant.
--
-- Reversible via 020_m7a_tenant_role_levels.down.sql, which refuses while any stored level differs from its role's
-- catalog default, and otherwise removes exactly what this file created and gives tmpos_app back the three grants this
-- file revokes. Roll 020 back before 016-019.
--
-- Assumes 001-019 are applied. A future managed apply targets the complete contiguous chain through the newest committed
-- migration — now 001-020 (owner decision D4); this file authorizes no apply.

-- =============================================================================
-- 0) This transaction's search path
-- =============================================================================
set local search_path = pg_catalog, pg_temp;

-- =============================================================================
-- 1) Preconditions: what this file builds on
-- =============================================================================
do $$
begin
  -- The chain is contiguous: 019 is the newest migration this file sits on.
  if pg_catalog.to_regprocedure('tmpos_customer_write.m7a_customer_create(text, uuid, text)') is null then
    raise exception 'migration 020 refused: migration 019 must be applied first'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- The runtime roles this file grants to and revokes from.
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'tmpos_app')
     or not exists (select 1 from pg_catalog.pg_roles where rolname = 'tmpos_audit_writer') then
    raise exception 'migration 020 refused: migration 005 must be applied first'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- Nothing of this file exists yet: it is applied once, over a chain that has never held it.
  if pg_catalog.to_regnamespace('tmpos_role') is not null then
    raise exception 'migration 020 refused: schema tmpos_role already exists'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- The definers call 016's hold and admission read and 017's page as their owner, the principal applying this file.
  if not (pg_catalog.has_function_privilege(current_user, 'tmpos_session.m5_hold_tenant_standing(text, text)', 'EXECUTE')
          and pg_catalog.has_function_privilege(current_user, 'tmpos_session.m5_admit_tenant_session_v2(text, text)', 'EXECUTE')
          and pg_catalog.has_function_privilege(current_user,
                'tmpos_customer.m7a_customer_page(uuid, text, uuid, text, uuid, uuid, integer)', 'EXECUTE')) then
    raise exception 'migration 020 refused: the applying principal cannot execute 016''s hold and admission read and 017''s page, which the definers below call'
      using errcode = 'insufficient_privilege';
  end if;
  -- A SECURITY DEFINER routine reads and writes only what its OWNER may (017's argument): were the applying principal
  -- neither the owner of these tables nor a role inheriting that owner's privileges — or row security FORCEd on one —
  -- the routines would find no session and refuse everything, or fail on a write.
  if exists (
    select 1
      from pg_catalog.pg_class c
     where c.oid = any (array['tmpos_session.session'::regclass, 'tmpos_mint.tenant_session'::regclass,
                              'tmpos_mint.issuer_key'::regclass, 'tmpos_customer.customer'::regclass])
       and (not pg_catalog.pg_has_role(current_user, c.relowner, 'USAGE') or c.relforcerowsecurity)) then
    raise exception 'migration 020 refused: the applying principal neither owns nor inherits the owner of tmpos_session.session, tmpos_mint.tenant_session, tmpos_mint.issuer_key and tmpos_customer.customer, or one has forced row security'
      using errcode = 'insufficient_privilege';
  end if;
  -- Each privilege stated, one at a time (019's reason): SELECT and UPDATE on the three rows the create and the edit lock,
  -- INSERT on the customer table, REFERENCES on public.tenant for the new table's foreign key.
  if not (pg_catalog.has_table_privilege(current_user, 'tmpos_session.session', 'SELECT')
          and pg_catalog.has_table_privilege(current_user, 'tmpos_session.session', 'UPDATE')
          and pg_catalog.has_table_privilege(current_user, 'tmpos_mint.tenant_session', 'SELECT')
          and pg_catalog.has_table_privilege(current_user, 'tmpos_mint.tenant_session', 'UPDATE')
          and pg_catalog.has_table_privilege(current_user, 'tmpos_mint.issuer_key', 'SELECT')
          and pg_catalog.has_table_privilege(current_user, 'tmpos_mint.issuer_key', 'UPDATE')
          and pg_catalog.has_table_privilege(current_user, 'tmpos_customer.customer', 'INSERT')
          and pg_catalog.has_table_privilege(current_user, 'public.tenant', 'REFERENCES')) then
    raise exception 'migration 020 refused: the applying principal lacks SELECT or UPDATE on the session table, the mint ledger or the issuer key, INSERT on tmpos_customer.customer or REFERENCES on public.tenant'
      using errcode = 'insufficient_privilege';
  end if;
end
$$;

-- =============================================================================
-- 2) The schema
-- =============================================================================
create schema tmpos_role;

comment on schema tmpos_role is
  'Phase 4.0 M7a (migration 020): owner-edited Customers levels — the per-tenant level of each editable built-in role, and the four routines every customer decision and the owner''s edit go through. Owned by this migration; tmpos_app holds USAGE and EXECUTE only.';

revoke all on schema tmpos_role from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
grant usage on schema tmpos_role to tmpos_app;

-- =============================================================================
-- 3) The table
-- =============================================================================
-- One row per (tenant, editable role, domain). level NULL is the catalog default: a create inserts such a row as the lock
-- it holds, so the row a create and an edit order on always exists once either has run. No row is ever deleted by a
-- routine. The foreign key has no action (017's): a tenant with stored levels is not deleted silently.
create table tmpos_role.tenant_role_level (
  tenant_id  uuid        not null
             constraint tenant_role_level_tenant_fkey references public.tenant (tenant_id),
  role_id    text        not null
             constraint tenant_role_level_role_chk check (role_id in ('manager', 'technician', 'sales_staff')),
  domain     text        not null
             constraint tenant_role_level_domain_chk check (domain = 'customers'),
  level      text
             constraint tenant_role_level_level_chk
             check (level is null or level in ('none', 'view', 'create', 'edit', 'manage', 'approve', 'full')),
  updated_at timestamptz not null,
  constraint tenant_role_level_pkey primary key (tenant_id, role_id, domain)
);

comment on table tmpos_role.tenant_role_level is
  'Phase 4.0 M7a (migration 020): the owner-edited Customers level of each editable built-in role (manager, technician, sales_staff) per tenant; NULL is the catalog default. Written only through m7a_role_level_set (a level) and m7a_customer_create (a NULL lock row). No runtime role holds a privilege on it.';

alter table tmpos_role.tenant_role_level enable row level security;
revoke all on table tmpos_role.tenant_role_level from public, anon, authenticated, tmpos_app, tmpos_audit_writer;

-- =============================================================================
-- 4) The routines
-- =============================================================================

-- 4a) The levels read: what every HTTP decision's authorizer and in-transaction revalidator apply to the selected role.
create function tmpos_role.m7a_role_levels(p_tenant_id uuid, p_role_id text)
returns jsonb
language plpgsql
-- STABLE: one statement, on the calling query's snapshot; it locks and writes nothing.
stable
security definer
set search_path = pg_catalog, pg_temp
set row_security = off
as $$
declare
  v_levels jsonb;
begin
  -- The runtime never sends a null; a null is a fault, never read as "nothing stored".
  if p_tenant_id is null or p_role_id is null then
    raise exception 'migration 020 levels: an argument is null'
      using errcode = 'invalid_parameter_value';
  end if;
  select pg_catalog.jsonb_object_agg(l.domain, l.level) into v_levels
    from tmpos_role.tenant_role_level l
   where l.tenant_id = p_tenant_id
     and l.role_id = p_role_id
     and l.level is not null;
  return coalesce(v_levels, '{}'::jsonb);
end
$$;

comment on function tmpos_role.m7a_role_levels(uuid, text) is
  'Phase 4.0 M7a (migration 020): the explicit non-null stored levels of one tenant''s role, as {"customers": "<level>"}, or {} (nothing stored, store_owner, or an unknown role). Raises invalid_parameter_value for a null argument. Read-only.';

-- 4b) The owner's edit.
create function tmpos_role.m7a_role_level_set(p_session_key text, p_role_id text, p_domain text, p_level text)
returns table (
  o_tenant_id     uuid,
  o_actor_id      uuid,
  o_membership_id uuid,
  o_level         text
)
language plpgsql
-- VOLATILE IS LOAD-BEARING (019's reason): each statement takes a fresh READ COMMITTED snapshot after its locks.
volatile
security definer
set search_path = pg_catalog, pg_temp
set row_security = off
as $$
declare
  v_now            bigint;
  v_provider       text;
  v_uid            text;
  v_expires        bigint;
  v_minted_expires bigint;
  v_minted_issuer  bytea;
  v_session        record;
  v_issuer         bytea;
  v_admission      record;
  v_grants         jsonb;
  v_role           text;
  v_tenant         uuid;
  v_membership     uuid;
begin
  -- 0. The arguments, before any state is read: the key is 011's shape, the target one of the fixed sets.
  if p_session_key is null or p_session_key !~ '^[\x21-\x7e]{1,128}$'
     or p_role_id is null or p_role_id not in ('manager', 'technician', 'sales_staff')
     or p_domain is null or p_domain <> 'customers'
     or p_level is null or p_level not in ('none', 'view', 'create', 'edit', 'manage', 'approve', 'full') then
    raise exception 'migration 020 set: an argument is malformed'
      using errcode = 'invalid_parameter_value';
  end if;
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'migration 020 set: it must run under READ COMMITTED, so that its checks see what committed before its locks'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- 1-6. The editor, derived exactly as 019's create derives its caller (see there for each step's reason): the unlocked
  --      pre-check, 016's hold, the session and ledger rows FOR SHARE, the issuer key row FOR SHARE, the clock after every
  --      wait, the standing digest and a write account status.
  select s.auth_provider, s.auth_provider_uid, s.expires_at, m.expires_at, m.issuer_digest
    into v_provider, v_uid, v_expires, v_minted_expires, v_minted_issuer
    from tmpos_session.session s
    join tmpos_mint.tenant_session m on m.session_key = s.session_key
   where s.session_key = p_session_key
     and s.audience = 'tenant';
  if not found then
    return;
  end if;
  v_now := pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp()) * 1000)::bigint;
  if v_expires is distinct from v_minted_expires or v_now >= v_expires then
    return;
  end if;
  select pg_catalog.sha256(k.key) into v_issuer from tmpos_mint.issuer_key k where k.singleton;
  if v_issuer is null or v_issuer is distinct from v_minted_issuer then
    return;
  end if;

  if tmpos_session.m5_hold_tenant_standing(v_provider, v_uid) is distinct from 'held' then
    return;
  end if;

  select s.expires_at, m.standing_digest, m.issuer_digest, m.expires_at as minted_expires_at
    into v_session
    from tmpos_session.session s
    join tmpos_mint.tenant_session m on m.session_key = s.session_key
   where s.session_key = p_session_key
     and s.audience = 'tenant'
     and s.auth_provider = v_provider
     and s.auth_provider_uid = v_uid
     for share of s, m;
  if not found or v_session.expires_at is distinct from v_session.minted_expires_at then
    return;
  end if;

  select pg_catalog.sha256(k.key) into v_issuer from tmpos_mint.issuer_key k where k.singleton for share;
  if v_issuer is null or v_issuer is distinct from v_session.issuer_digest then
    return;
  end if;

  v_now := pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp()) * 1000)::bigint;
  if v_now >= v_session.expires_at then
    return;
  end if;

  select r.outcome, r.actor_id, r.account_status, r.memberships,
         pg_catalog.sha256(pg_catalog.convert_to(r::text, 'UTF8')) as digest
    into strict v_admission
    from tmpos_session.m5_admit_tenant_session_v2(v_provider, v_uid) r;
  if v_admission.outcome is distinct from 'resolved'
     or v_admission.digest is distinct from v_session.standing_digest
     or v_admission.actor_id is null
     or v_admission.account_status is null
     or v_admission.account_status not in ('active', 'trialing') then
    return;
  end if;

  -- 7. Exactly one tenant-scope grant, on a tenant whose status is a write status, whose role is the catalog's owner.
  --    Only the owner edits: the catalog makes store_owner alone Full everywhere and not editable, and a delegated
  --    editor's authority (the client's manage_role_permissions) exists only in the client, so it is not honoured here.
  select pg_catalog.jsonb_agg(e.entry) into v_grants
    from pg_catalog.jsonb_array_elements(v_admission.memberships) as e(entry)
   where e.entry ->> 'scopeType' = 'tenant';
  if v_grants is null
     or pg_catalog.jsonb_array_length(v_grants) <> 1
     or (v_grants -> 0 ->> 'tenantId') is null
     or (v_grants -> 0 ->> 'membershipId') is null
     or (v_grants -> 0 ->> 'tenantStatus') is null
     or (v_grants -> 0 ->> 'tenantStatus') not in ('active', 'trialing') then
    return;
  end if;
  v_role := v_grants -> 0 ->> 'roleId';
  if v_role is distinct from 'store_owner' then
    return;
  end if;
  v_tenant := (v_grants -> 0 ->> 'tenantId')::uuid;
  v_membership := (v_grants -> 0 ->> 'membershipId')::uuid;

  -- 8. The role row, in the editor's tenant and no other: made to exist, held FOR UPDATE until COMMIT (a create holding
  --    it FOR SHARE, or inserting it uncommitted, is waited for), and changed. Separate statements, each on a snapshot
  --    taken after the previous one's waits. A row gone by the time it is locked (only the table's owner deletes one)
  --    refuses.
  insert into tmpos_role.tenant_role_level (tenant_id, role_id, domain, level, updated_at)
  values (v_tenant, p_role_id, p_domain, null, pg_catalog.now())
  on conflict (tenant_id, role_id, domain) do nothing;
  perform 1 from tmpos_role.tenant_role_level l
   where l.tenant_id = v_tenant and l.role_id = p_role_id and l.domain = p_domain
     for update;
  if not found then
    return;
  end if;
  -- 9. Live, on the database clock read again now: the insert and the lock above may have waited (a create holding the
  --    row), and a session that expired during that wait refuses (step 5's rule, after the last wait).
  v_now := pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp()) * 1000)::bigint;
  if v_now >= v_session.expires_at then
    return;
  end if;
  update tmpos_role.tenant_role_level l
     set level = p_level, updated_at = pg_catalog.now()
   where l.tenant_id = v_tenant and l.role_id = p_role_id and l.domain = p_domain;
  -- A change an owner's trigger suppressed is not an edit: raise, so the caller rolls back.
  if not found then
    raise exception 'migration 020 set: the level was not written'
      using errcode = 'no_data_found';
  end if;

  return query select v_tenant, v_admission.actor_id, v_membership, p_level;
end
$$;

comment on function tmpos_role.m7a_role_level_set(text, text, text, text) is
  'Phase 4.0 M7a (migration 020): sets one editable role''s (manager, technician, sales_staff) Customers level in the editor''s tenant, for a key naming a ledger-minted, live (database clock, read after its lock waits) tenant session minted under the installed issuer key, after 016''s hold and the session, ledger and issuer key rows, whose principal''s standing digest is unchanged, whose account and tenant status are active or trialing, and who holds exactly one tenant grant, as store_owner. Answers the tenant, actor, membership and the level stored, or no row (no level written; at most a NULL lock row, the default). Raises invalid_parameter_value (fixed message) for a malformed argument, object_not_in_prerequisite_state outside READ COMMITTED, no_data_found when the update wrote no row, and whatever 016''s hold or read raises. Writes no audit record.';

-- 4c) The create: 019's, with its step 7 role allow-list replaced by the effective Customers level, and the clock read
--     once more after the role row's wait.
create function tmpos_role.m7a_customer_create(p_session_key text, p_customer_id uuid, p_name text)
returns table (
  o_tenant_id     uuid,
  o_actor_id      uuid,
  o_membership_id uuid
)
language plpgsql
-- VOLATILE IS LOAD-BEARING (019's reason). Do not make it STABLE.
volatile
security definer
set search_path = pg_catalog, pg_temp
set row_security = off
as $$
declare
  -- The tenant ordering (permissionCatalog.ts TENANT_ORDERING), pinned by the parity test.
  c_levels         constant text[] := array['none', 'view', 'create', 'edit', 'manage', 'approve', 'full'];
  v_now            bigint;
  v_provider       text;
  v_uid            text;
  v_expires        bigint;
  v_minted_expires bigint;
  v_minted_issuer  bytea;
  v_session        record;
  v_issuer         bytea;
  v_admission      record;
  v_grants         jsonb;
  v_role           text;
  v_level          text;
  v_tenant         uuid;
  v_membership     uuid;
begin
  -- 0. The arguments, exactly 019's rules and SQLSTATEs (fixed text naming this file).
  if p_session_key is null or p_session_key !~ '^[\x21-\x7e]{1,128}$'
     or p_customer_id is null
     or p_customer_id::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or p_name is null then
    raise exception 'migration 020 create: an argument is malformed'
      using errcode = 'invalid_parameter_value';
  end if;
  if pg_catalog.char_length(p_name) not between 1 and 200 then
    raise exception 'migration 020 create: the name is not one the customer table admits'
      using errcode = 'check_violation';
  end if;
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'migration 020 create: it must run under READ COMMITTED, so that its checks see what committed before its locks'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- 1-6. The caller, derived exactly as 019's create derives it (see there for each step's reason).
  select s.auth_provider, s.auth_provider_uid, s.expires_at, m.expires_at, m.issuer_digest
    into v_provider, v_uid, v_expires, v_minted_expires, v_minted_issuer
    from tmpos_session.session s
    join tmpos_mint.tenant_session m on m.session_key = s.session_key
   where s.session_key = p_session_key
     and s.audience = 'tenant';
  if not found then
    return;
  end if;
  v_now := pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp()) * 1000)::bigint;
  if v_expires is distinct from v_minted_expires or v_now >= v_expires then
    return;
  end if;
  select pg_catalog.sha256(k.key) into v_issuer from tmpos_mint.issuer_key k where k.singleton;
  if v_issuer is null or v_issuer is distinct from v_minted_issuer then
    return;
  end if;

  if tmpos_session.m5_hold_tenant_standing(v_provider, v_uid) is distinct from 'held' then
    return;
  end if;

  select s.expires_at, m.standing_digest, m.issuer_digest, m.expires_at as minted_expires_at
    into v_session
    from tmpos_session.session s
    join tmpos_mint.tenant_session m on m.session_key = s.session_key
   where s.session_key = p_session_key
     and s.audience = 'tenant'
     and s.auth_provider = v_provider
     and s.auth_provider_uid = v_uid
     for share of s, m;
  if not found or v_session.expires_at is distinct from v_session.minted_expires_at then
    return;
  end if;

  select pg_catalog.sha256(k.key) into v_issuer from tmpos_mint.issuer_key k where k.singleton for share;
  if v_issuer is null or v_issuer is distinct from v_session.issuer_digest then
    return;
  end if;

  v_now := pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp()) * 1000)::bigint;
  if v_now >= v_session.expires_at then
    return;
  end if;

  select r.outcome, r.actor_id, r.account_status, r.memberships,
         pg_catalog.sha256(pg_catalog.convert_to(r::text, 'UTF8')) as digest
    into strict v_admission
    from tmpos_session.m5_admit_tenant_session_v2(v_provider, v_uid) r;
  if v_admission.outcome is distinct from 'resolved'
     or v_admission.digest is distinct from v_session.standing_digest
     or v_admission.actor_id is null
     or v_admission.account_status is null
     or v_admission.account_status not in ('active', 'trialing') then
    return;
  end if;

  -- 7. Exactly one tenant-scope grant, on a tenant whose status is a write status (019's rule). The role is decided in 8.
  select pg_catalog.jsonb_agg(e.entry) into v_grants
    from pg_catalog.jsonb_array_elements(v_admission.memberships) as e(entry)
   where e.entry ->> 'scopeType' = 'tenant';
  if v_grants is null
     or pg_catalog.jsonb_array_length(v_grants) <> 1
     or (v_grants -> 0 ->> 'tenantId') is null
     or (v_grants -> 0 ->> 'membershipId') is null
     or (v_grants -> 0 ->> 'tenantStatus') is null
     or (v_grants -> 0 ->> 'tenantStatus') not in ('active', 'trialing') then
    return;
  end if;
  v_role := v_grants -> 0 ->> 'roleId';
  v_tenant := (v_grants -> 0 ->> 'tenantId')::uuid;
  v_membership := (v_grants -> 0 ->> 'membershipId')::uuid;

  -- 8. The role's effective Customers level must meet Create. store_owner is Full (never stored); an editable role is
  --    its stored level, else its catalog default; any other role refuses.
  if v_role = 'store_owner' then
    null;
  elsif v_role in ('manager', 'technician', 'sales_staff') then
    -- (a) Unlocked: a level already below Create refuses here, having written no role row and locked none — so a
    --     refused key never holds the row an owner's edit waits on. It only refuses, on rows committed when it read them.
    select l.level into v_level
      from tmpos_role.tenant_role_level l
     where l.tenant_id = v_tenant and l.role_id = v_role and l.domain = 'customers';
    if coalesce(pg_catalog.array_position(c_levels,
         coalesce(v_level, case v_role when 'manager' then 'full' when 'technician' then 'view' when 'sales_staff' then 'create' end)), 0)
       < pg_catalog.array_position(c_levels, 'create') then
      return;
    end if;
    -- (b) The row made to exist (NULL: the default), so there is always one row to order on; an edit's uncommitted
    --     insert is waited for.
    insert into tmpos_role.tenant_role_level (tenant_id, role_id, domain, level, updated_at)
    values (v_tenant, v_role, 'customers', null, pg_catalog.now())
    on conflict (tenant_id, role_id, domain) do nothing;
    -- (c) Held FOR SHARE until COMMIT: an edit holding it FOR UPDATE is waited for, and its committed level is what this
    --     statement reads; an edit attempted later waits for this transaction. A row gone by now refuses — never the
    --     default, which would widen a role whose narrowing row an owner removed.
    select l.level into v_level
      from tmpos_role.tenant_role_level l
     where l.tenant_id = v_tenant and l.role_id = v_role and l.domain = 'customers'
       for share;
    if not found then
      return;
    end if;
    -- (d) Decided on the locked value.
    if coalesce(pg_catalog.array_position(c_levels,
         coalesce(v_level, case v_role when 'manager' then 'full' when 'technician' then 'view' when 'sales_staff' then 'create' end)), 0)
       < pg_catalog.array_position(c_levels, 'create') then
      return;
    end if;
  else
    return;
  end if;

  -- 9. Live, on the database clock read again now: step 8's insert and lock may have waited (an edit holding the row),
  --    and a session that expired during that wait refuses (step 5's rule, after the last wait).
  v_now := pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp()) * 1000)::bigint;
  if v_now >= v_session.expires_at then
    return;
  end if;

  -- 10. The row, in the derived tenant and no other (019's step 8, its errors raised again with fixed text).
  begin
    insert into tmpos_customer.customer (customer_id, tenant_id, name)
    values (p_customer_id, v_tenant, p_name);
    if not found then
      raise exception 'migration 020 create: the customer row was not written'
        using errcode = 'no_data_found';
    end if;
  exception
    when check_violation then
      raise exception 'migration 020 create: the name is not one the customer table admits'
        using errcode = 'check_violation';
    when unique_violation then
      raise exception 'migration 020 create: the customer id is already taken'
        using errcode = 'unique_violation';
  end;

  return query select v_tenant, v_admission.actor_id, v_membership;
end
$$;

comment on function tmpos_role.m7a_customer_create(text, uuid, text) is
  'Phase 4.0 M7a (migration 020): migration 019''s create, with its role allow-list replaced by the effective Customers level: creates one customer for a key naming a ledger-minted, live, tenant session minted under the installed issuer key, after 016''s hold and the session, ledger and issuer key rows, whose standing digest is unchanged, whose account and tenant status are active or trialing, who holds exactly one tenant grant, and whose role''s Customers level — store_owner full; manager, technician, sales_staff the owner''s stored level, read unlocked and then FOR SHARE, else the catalog default — is Create or above. Answers the derived tenant id, actor id and membership id, or no row (no customer written). Raises with 019''s SQLSTATEs and fixed messages naming migration 020.';

-- 4d) The read: 018's page_v2, plus the effective Customers level at View or above.
create function tmpos_role.m7a_customer_page_v3(p_session_key text, p_after_customer_id uuid, p_limit integer)
returns table (
  o_outcome     text,
  o_tenant_id   uuid,
  o_customer_id uuid,
  o_name        text
)
language plpgsql
-- STABLE IS LOAD-BEARING (018's reason): every statement below, the level read included, runs on the calling query's
-- snapshot. It locks nothing.
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
begin
  if p_session_key is null or p_session_key !~ '^[\x21-\x7e]{1,128}$' then
    return query select 'invalid'::text, null::uuid, null::uuid, null::text;
    return;
  end if;

  -- 1-4. Exactly 018's page_v2 (see there): a minted, live tenant session under the installed key, its principal's
  --      standing the one minted, exactly one tenant-scope grant.
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

  -- 5. The role's effective Customers level must meet View: store_owner Full; an editable role its stored level, else
  --    its catalog default; any other role 'denied'. Unlocked, on this call's snapshot.
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

  -- 6. 017's page, as this routine's owner, for the authority derived here and nothing the caller named.
  return query
    select p.o_outcome, p.o_tenant_id, p.o_customer_id, p.o_name
      from tmpos_customer.m7a_customer_page(v_admission.actor_id, v_admission.security_version,
             (v_grants -> 0 ->> 'membershipId')::uuid, v_role, (v_grants -> 0 ->> 'tenantId')::uuid,
             p_after_customer_id, p_limit) p;
end
$$;

comment on function tmpos_role.m7a_customer_page_v3(text, uuid, integer) is
  'Phase 4.0 M7a (migration 020): migration 018''s page_v2 plus the effective Customers level — for a key naming a ledger-minted, live (database clock), tenant session minted under the installed issuer key whose principal''s standing digest is unchanged, who holds exactly one tenant grant, and whose role''s Customers level (store_owner full; manager, technician, sales_staff the owner''s stored level, else the catalog default) is View or above, 017''s page for the authority derived from 016''s answer. ''denied'' otherwise; ''invalid'' for a malformed key. Read-only; locks nothing.';

-- =============================================================================
-- 5) Privileges, and the proof that nothing wider was issued
-- =============================================================================
-- PostgreSQL grants EXECUTE on a new function to PUBLIC by default, so every default is removed explicitly before the
-- four intended grants are issued.
revoke all on function tmpos_role.m7a_role_levels(uuid, text) from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
revoke all on function tmpos_role.m7a_role_level_set(text, text, text, text) from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
revoke all on function tmpos_role.m7a_customer_create(text, uuid, text) from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
revoke all on function tmpos_role.m7a_customer_page_v3(text, uuid, integer) from public, anon, authenticated, tmpos_app, tmpos_audit_writer;

grant execute on function tmpos_role.m7a_role_levels(uuid, text) to tmpos_app;
grant execute on function tmpos_role.m7a_role_level_set(text, text, text, text) to tmpos_app;
grant execute on function tmpos_role.m7a_customer_create(text, uuid, text) to tmpos_app;
grant execute on function tmpos_role.m7a_customer_page_v3(text, uuid, integer) to tmpos_app;

-- The two name-based paths (019 section 4 and 018 section 8 granted them). Their objects stay, byte for byte, for 020's
-- rollback to grant again; the runtime role no longer reaches them.
revoke execute on function tmpos_customer_write.m7a_customer_create(text, uuid, text) from tmpos_app;
revoke usage on schema tmpos_customer_write from tmpos_app;
revoke execute on function tmpos_mint.m7a_customer_page_v2(text, uuid, integer) from tmpos_app;

-- The postcondition, proven rather than asserted, in 019's form. This file refuses to finish unless, now:
--   (a) the schema holds exactly the four routines, the one table and its primary-key index, and no view, sequence,
--       standalone type or trigger;
--   (b) every routine is plpgsql, SECURITY DEFINER, pinned to the search path above and run with row_security off —
--       the levels read and the page STABLE, the edit and the create VOLATILE — and the routines, the table and the
--       schema are owned by the applying principal;
--   (c) the routines carry no grant beyond their owner's and a non-grantable EXECUTE to tmpos_app;
--   (d) the schema carries no grant beyond its owner's and a non-grantable USAGE to tmpos_app;
--   (e) the table is under row level security, not forced, with no policy, no grant beyond its owner's and no column
--       grant;
--   (f) tmpos_app CAN execute the four and use the schema; tmpos_audit_writer, anon and authenticated CANNOT execute any
--       of them by any path (PUBLIC, an inherited role, or a role reachable only through SET ROLE); and no runtime role
--       (tmpos_app included) can, by any path, execute 019's create or 018's page_v2, or use schema tmpos_customer_write;
--   (g) none of the runtime roles is a MEMBER of the owner of the schema, a routine, the table, or a table the routines'
--       authority and writes rest on (the session table, the mint ledger, the issuer key, the customer table);
--   (h) neither a runtime role nor any role it is a member of HOLDS a privilege on any of those five tables, no column
--       grant exists on one, and each is under row level security, not forced;
--   (i) 017's, 018's and 019's surfaces by count and exact signature, not by definition: tmpos_customer holds exactly
--       017's page and table, tmpos_mint exactly 018's five routines, tmpos_customer_write exactly 019's create; tmpos_app
--       uses schema tmpos_mint and executes 018's mint and key check, and neither 011's create nor 017's page;
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
  if (select pg_catalog.count(*) from pg_catalog.pg_proc p where p.pronamespace = 'tmpos_role'::regnamespace) <> 4
     or pg_catalog.to_regprocedure('tmpos_role.m7a_role_levels(uuid, text)') is null
     or pg_catalog.to_regprocedure('tmpos_role.m7a_role_level_set(text, text, text, text)') is null
     or pg_catalog.to_regprocedure('tmpos_role.m7a_customer_create(text, uuid, text)') is null
     or pg_catalog.to_regprocedure('tmpos_role.m7a_customer_page_v3(text, uuid, integer)') is null
     or (select pg_catalog.count(*) from pg_catalog.pg_class c
          where c.relnamespace = 'tmpos_role'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S', 'c')) <> 1
     or pg_catalog.to_regclass('tmpos_role.tenant_role_level') is null
     or (select pg_catalog.count(*) from pg_catalog.pg_class c
          where c.relnamespace = 'tmpos_role'::regnamespace and c.relkind in ('i', 'I')) <> 1
     or exists (select 1 from pg_catalog.pg_type t
                 where t.typnamespace = 'tmpos_role'::regnamespace and t.typrelid = 0 and t.typelem = 0)
     -- The foreign key's own RI triggers are internal (tgisinternal); any other trigger is not this file's.
     or exists (select 1 from pg_catalog.pg_trigger g join pg_catalog.pg_class c on c.oid = g.tgrelid
                 where c.relnamespace = 'tmpos_role'::regnamespace and not g.tgisinternal) then
    raise exception 'migration 020 refused: schema tmpos_role does not hold exactly the four routines, the table and its index this file creates'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (b)
  if (select pg_catalog.count(*)
        from pg_catalog.pg_proc p
        join pg_catalog.pg_language l on l.oid = p.prolang
       where p.pronamespace = 'tmpos_role'::regnamespace
         and l.lanname = 'plpgsql'
         and p.prosecdef
         and ((p.proname in ('m7a_role_levels', 'm7a_customer_page_v3') and p.provolatile = 's')
              or (p.proname in ('m7a_role_level_set', 'm7a_customer_create') and p.provolatile = 'v'))
         and p.proconfig = array['search_path=pg_catalog, pg_temp', 'row_security=off']
         and p.proowner = v_me) <> 4
     or not exists (select 1 from pg_catalog.pg_namespace n where n.oid = 'tmpos_role'::regnamespace and n.nspowner = v_me)
     or not exists (select 1 from pg_catalog.pg_class c where c.oid = 'tmpos_role.tenant_role_level'::regclass and c.relowner = v_me) then
    raise exception 'migration 020 refused: a routine in tmpos_role is not a plpgsql SECURITY DEFINER routine of the volatility this file gives it, pinned to pg_catalog, pg_temp with row_security off, owned with its schema and table by the applying principal'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (c)
  select pg_catalog.string_agg(pg_catalog.format('%s %s:%s', p.proname, g.grantee::regrole::text, g.privilege_type), ', ')
    into v_bad
    from pg_catalog.pg_proc p,
         pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g
   where p.pronamespace = 'tmpos_role'::regnamespace
     and g.grantee <> p.proowner
     and not (g.grantee = 'tmpos_app'::regrole and g.privilege_type = 'EXECUTE' and not g.is_grantable);
  if v_bad is not null then
    raise exception 'migration 020 refused: an unexpected direct grant remains on a tmpos_role routine (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (d)
  select pg_catalog.string_agg(pg_catalog.format('%s:%s', g.grantee::regrole::text, g.privilege_type), ', ')
    into v_bad
    from pg_catalog.pg_namespace n,
         pg_catalog.aclexplode(coalesce(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) g
   where n.oid = 'tmpos_role'::regnamespace
     and g.grantee <> n.nspowner
     and not (g.grantee = 'tmpos_app'::regrole and g.privilege_type = 'USAGE' and not g.is_grantable);
  if v_bad is not null then
    raise exception 'migration 020 refused: schema tmpos_role carries an unexpected grant (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (e)
  if exists (select 1 from pg_catalog.pg_class c
              where c.oid = 'tmpos_role.tenant_role_level'::regclass
                and (not c.relrowsecurity or c.relforcerowsecurity))
     or exists (select 1 from pg_catalog.pg_policy p where p.polrelid = 'tmpos_role.tenant_role_level'::regclass) then
    raise exception 'migration 020 refused: row level security is not enabled (unforced) on tmpos_role.tenant_role_level, or a policy exists on it'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  select pg_catalog.string_agg(pg_catalog.format('%s:%s', g.grantee::regrole::text, g.privilege_type), ', ')
    into v_bad
    from pg_catalog.pg_class c,
         pg_catalog.aclexplode(coalesce(c.relacl, pg_catalog.acldefault('r', c.relowner))) g
   where c.oid = 'tmpos_role.tenant_role_level'::regclass
     and g.grantee <> c.relowner;
  if v_bad is not null then
    raise exception 'migration 020 refused: an unexpected grant remains on tmpos_role.tenant_role_level (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (f)
  if not pg_catalog.has_function_privilege('tmpos_app', 'tmpos_role.m7a_role_levels(uuid, text)'::regprocedure, 'EXECUTE')
     or not pg_catalog.has_function_privilege('tmpos_app', 'tmpos_role.m7a_role_level_set(text, text, text, text)'::regprocedure, 'EXECUTE')
     or not pg_catalog.has_function_privilege('tmpos_app', 'tmpos_role.m7a_customer_create(text, uuid, text)'::regprocedure, 'EXECUTE')
     or not pg_catalog.has_function_privilege('tmpos_app', 'tmpos_role.m7a_customer_page_v3(text, uuid, integer)'::regprocedure, 'EXECUTE')
     or not pg_catalog.has_schema_privilege('tmpos_app', 'tmpos_role'::regnamespace, 'USAGE') then
    raise exception 'migration 020 refused: tmpos_app does not hold EXECUTE on the four routines and USAGE on schema tmpos_role'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  select pg_catalog.string_agg(distinct pg_catalog.format('%s: %s', r.rolname, p.oid::regprocedure), ', ') into v_bad
    from pg_catalog.pg_roles r
    join pg_catalog.pg_roles x on pg_catalog.pg_has_role(r.oid, x.oid, 'MEMBER')
    cross join pg_catalog.pg_proc p
   where p.pronamespace = 'tmpos_role'::regnamespace
     and r.rolname = any (array['tmpos_audit_writer', 'anon', 'authenticated']::name[])
     and pg_catalog.has_function_privilege(x.oid, p.oid, 'EXECUTE');
  if v_bad is not null then
    raise exception 'migration 020 refused: a runtime role other than tmpos_app can execute a tmpos_role routine (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  select pg_catalog.string_agg(distinct r.rolname::text, ', ') into v_bad
    from pg_catalog.pg_roles r
    join pg_catalog.pg_roles x on pg_catalog.pg_has_role(r.oid, x.oid, 'MEMBER')
   where r.rolname = any (array['tmpos_app', 'tmpos_audit_writer', 'anon', 'authenticated']::name[])
     and (pg_catalog.has_function_privilege(x.oid,
            'tmpos_customer_write.m7a_customer_create(text, uuid, text)'::regprocedure, 'EXECUTE')
          or pg_catalog.has_function_privilege(x.oid,
            'tmpos_mint.m7a_customer_page_v2(text, uuid, integer)'::regprocedure, 'EXECUTE')
          or pg_catalog.has_schema_privilege(x.oid, 'tmpos_customer_write'::regnamespace, 'USAGE'));
  if v_bad is not null then
    raise exception 'migration 020 refused: % can still execute 019''s create or 018''s page_v2, or use schema tmpos_customer_write', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (g)
  select pg_catalog.string_agg(distinct r.rolname::text, ', ') into v_bad
    from pg_catalog.pg_roles r
    cross join (
      select n.nspowner as owner from pg_catalog.pg_namespace n where n.nspname = 'tmpos_role'
      union
      select p.proowner from pg_catalog.pg_proc p where p.pronamespace = 'tmpos_role'::regnamespace
      union
      select c.relowner from pg_catalog.pg_class c
       where c.oid in ('tmpos_role.tenant_role_level'::regclass, 'tmpos_session.session'::regclass,
                       'tmpos_mint.tenant_session'::regclass, 'tmpos_mint.issuer_key'::regclass,
                       'tmpos_customer.customer'::regclass)
    ) o
   where r.rolname = any (array['tmpos_app', 'tmpos_audit_writer', 'anon', 'authenticated']::name[])
     and pg_catalog.pg_has_role(r.oid, o.owner, 'MEMBER');
  if v_bad is not null then
    raise exception 'migration 020 refused: % is a member of the owner of schema tmpos_role, a routine or table in it, or a table its routines rest on', v_bad
      using errcode = 'object_not_in_prerequisite_state',
            hint = 'membership hands a role everything the owner holds, including a direct write of every role level';
  end if;

  -- (h) MAINTAIN only on a server that has it (PostgreSQL 17+), where has_table_privilege would reject it on 16.
  select pg_catalog.string_agg(distinct r.rolname::text || ' on ' || t.oid::regclass::text, ', ') into v_bad
    from pg_catalog.pg_roles r
    join pg_catalog.pg_roles x on pg_catalog.pg_has_role(r.oid, x.oid, 'MEMBER')
    cross join (values ('tmpos_role.tenant_role_level'::regclass), ('tmpos_session.session'::regclass),
                       ('tmpos_mint.tenant_session'::regclass), ('tmpos_mint.issuer_key'::regclass),
                       ('tmpos_customer.customer'::regclass)) as t(oid)
   where r.rolname = any (array['tmpos_app', 'tmpos_audit_writer', 'anon', 'authenticated']::name[])
     and pg_catalog.has_table_privilege(x.oid, t.oid,
           'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'
           operator(pg_catalog.||) case when pg_catalog.current_setting('server_version_num')::integer >= 170000
                                        then ', MAINTAIN' else '' end);
  if v_bad is not null then
    raise exception 'migration 020 refused: % holds an effective privilege on a table the role levels or the customer write rest on', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if exists (select 1 from pg_catalog.pg_attribute a, pg_catalog.aclexplode(a.attacl) g
              where a.attrelid in ('tmpos_role.tenant_role_level'::regclass, 'tmpos_session.session'::regclass,
                                   'tmpos_mint.tenant_session'::regclass, 'tmpos_mint.issuer_key'::regclass,
                                   'tmpos_customer.customer'::regclass)
                and a.attnum > 0 and not a.attisdropped) then
    raise exception 'migration 020 refused: a column grant exists on a table the role levels or the customer write rest on'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if exists (select 1 from pg_catalog.pg_class c
              where c.oid in ('tmpos_role.tenant_role_level'::regclass, 'tmpos_session.session'::regclass,
                              'tmpos_mint.tenant_session'::regclass, 'tmpos_mint.issuer_key'::regclass,
                              'tmpos_customer.customer'::regclass)
                and (not c.relrowsecurity or c.relforcerowsecurity)) then
    raise exception 'migration 020 refused: row level security is not enabled (unforced) on a table the role levels or the customer write rest on'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (i)
  if (select pg_catalog.count(*) from pg_catalog.pg_proc p where p.pronamespace = 'tmpos_customer'::regnamespace) <> 1
     or (select pg_catalog.count(*) from pg_catalog.pg_class c
          where c.relnamespace = 'tmpos_customer'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S', 'c')) <> 1
     or (select pg_catalog.count(*) from pg_catalog.pg_proc p where p.pronamespace = 'tmpos_mint'::regnamespace) <> 5
     or (select pg_catalog.count(*) from pg_catalog.pg_proc p where p.pronamespace = 'tmpos_customer_write'::regnamespace) <> 1
     or pg_catalog.to_regclass('tmpos_customer.customer') is null
     or pg_catalog.to_regprocedure('tmpos_customer.m7a_customer_page(uuid, text, uuid, text, uuid, uuid, integer)') is null
     or pg_catalog.to_regprocedure('tmpos_mint.hmac_sha256(bytea, bytea)') is null
     or pg_catalog.to_regprocedure('tmpos_mint.mint_message(text, text, text, text, text, text, bigint, bigint, bigint, bigint, bigint)') is null
     or pg_catalog.to_regprocedure('tmpos_mint.m7a_session_create(text, text, text, text, text, text, bigint, bigint, bigint, bigint, bigint, bytea)') is null
     or pg_catalog.to_regprocedure('tmpos_mint.m7a_customer_page_v2(text, uuid, integer)') is null
     or pg_catalog.to_regprocedure('tmpos_mint.m7a_issuer_key_check(bytea)') is null
     or pg_catalog.to_regprocedure('tmpos_customer_write.m7a_customer_create(text, uuid, text)') is null then
    raise exception 'migration 020 refused: schema tmpos_customer, tmpos_mint or tmpos_customer_write does not hold what 017, 018 and 019 left'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if not pg_catalog.has_function_privilege('tmpos_app',
           'tmpos_mint.m7a_session_create(text, text, text, text, text, text, bigint, bigint, bigint, bigint, bigint, bytea)'::regprocedure, 'EXECUTE')
     or not pg_catalog.has_function_privilege('tmpos_app', 'tmpos_mint.m7a_issuer_key_check(bytea)'::regprocedure, 'EXECUTE')
     or not pg_catalog.has_schema_privilege('tmpos_app', 'tmpos_mint'::regnamespace, 'USAGE')
     or pg_catalog.has_function_privilege('tmpos_app',
          'tmpos_session.m5_session_create(text, text, text, text, text, text, bigint, bigint, bigint, bigint, bigint)'::regprocedure, 'EXECUTE')
     or pg_catalog.has_function_privilege('tmpos_app',
          'tmpos_customer.m7a_customer_page(uuid, text, uuid, text, uuid, uuid, integer)'::regprocedure, 'EXECUTE') then
    raise exception 'migration 020 refused: tmpos_app''s EXECUTE on 011''s create, 017''s page or 018''s mint and key check is not what 018 left'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (j)
  select pg_catalog.string_agg(pg_catalog.format('%s in %s', m.member::regrole, m.roleid::regrole), ', '
                               order by m.member, m.roleid) into v_bad
    from pg_catalog.pg_auth_members m
    join pg_catalog.pg_roles r on r.oid = m.member
   where r.rolname = any (array['tmpos_app', 'tmpos_audit_writer']::name[]);
  if v_bad is not null then
    raise exception 'migration 020 refused: tmpos_app and tmpos_audit_writer must be members of nothing (%)', v_bad
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
    raise exception 'migration 020 refused: anon and authenticated must reach neither tmpos_app nor tmpos_audit_writer by membership (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$$;

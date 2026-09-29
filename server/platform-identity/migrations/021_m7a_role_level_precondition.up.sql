-- Phase 4.0 M7a — the owner's Customers level edit, made conditional on the tenant and the version the owner reviewed: a
-- per-row edit counter beside 020's levels, a one-snapshot read of every editable role's level and version, and an edit
-- that writes only when both still hold (M7A-CUSTOMERS-P4; DA-125, G-IAM, G-DBROLE; docs/phase-4/10)
-- Migration: 021_m7a_role_level_precondition (UP)
--
-- SCOPE / TRUTH (binding):
--   - ONE NEW SCHEMA, ONE TABLE, THREE ROUTINES, ONE TRIGGER, ONE REVOKED GRANT, NO ROLE, NO TYPE, NO FOREIGN KEY. This
--     file creates schema tmpos_role_edit; in it the table tmpos_role_edit.role_level_version (one row per tenant, editable
--     role and domain whose level row has been updated since this file); the two routines tmpos_app may execute:
--     m7a_role_level_states (the owner's read-back: level and version of the three editable roles, one snapshot) and
--     m7a_role_level_set_v2 (020's edit, conditional on the tenant and the version the owner reviewed); and the trigger
--     function m7a_role_level_version_advance, granted to nobody, which the one trigger this file places on 020's table
--     tmpos_role.tenant_role_level calls. It revokes tmpos_app's EXECUTE on 020's tmpos_role.m7a_role_level_set: that
--     unconditional edit would otherwise stay reachable from the runtime role without the tenant precondition. That ACL
--     change and the trigger are its only effects on objects earlier migrations created: 001-020 stay byte for byte as
--     committed, 020's routines and schema are not altered, 020's table gains only the trigger (whose function lives here,
--     not in tmpos_role), and nothing is added to schema tmpos_role (020's postcondition pins its inventory, and 020's
--     rollback drops that schema without CASCADE; dropping 020's table drops the trigger with it). 020's postcondition,
--     an apply-time proof that admits no trigger on its table, therefore no longer holds once this file is applied.
--   - WHY THE EDIT NEEDS A PRECONDITION (DA-125). 020's edit derives its tenant from the session and writes whatever it is
--     sent. An owner whose single tenant grant moved from A to B and who signs in again sends an A draft on a B session:
--     020 writes B. Two tabs that read one level both write: the later arrival wins, an older permissive draft restoring
--     Create over a newer None. The owner's client now sends the tenant and the version of the read that produced the
--     draft; this file's edit writes only when the session's own tenant IS that tenant and the row's version IS that
--     version. Both are PRECONDITIONS, never selectors: the tenant written is still the one the session's one grant names,
--     and neither value grants anything.
--   - THE VERSION IS A PURE PER-ROW COUNTER, AND EVERY UPDATE OF A LEVEL ROW MOVES IT. No row means version 0. The trigger
--     (AFTER UPDATE, FOR EACH ROW, enabled ALWAYS) sets exactly old + 1, in one upsert under the updated role row's lock,
--     for EVERY update of a row of 020's table by any path — this file's edit, 020's m7a_role_level_set (still the table
--     owner's; and a 020 call that passed its EXECUTE check before this file committed, see APPLY), a raw UPDATE by the
--     table's owner, a session running as a replica — restoring a role's catalog default included (020 stores the default
--     word; it never deletes a row or writes NULL), so an A -> B -> A cycle of levels never recreates a version a stale
--     draft still holds (no ABA). No wall clock, and nothing is seeded at apply: every level stored before this file reads
--     version 0, and no client before this file held a version. A customer create's NULL lock row (020's create) is an
--     INSERT, not an update, and writes no version row, so a never-edited role stays at 0 and no false conflict arises.
--     Versions are inert integers: no foreign key (to 020's table or to public.tenant), bounded by CHECKs alone.
--   - THE EDIT'S ONLY AUTHORITY ARGUMENT IS STILL THE SESSION KEY. m7a_role_level_set_v2 is 020's m7a_role_level_set,
--     steps 0-9 copied exactly (the editor derived from the key: the unlocked live/issuer pre-check; 016's hold; the session
--     and mint-ledger rows FOR SHARE; the issuer key row FOR SHARE; the database clock after every wait; the standing
--     digest; a write account status; exactly one tenant grant, on a write-status tenant, as store_owner), with:
--       7b the TENANT precondition, after the hold and the FOR SHARE locks and BEFORE any insert: a session whose tenant is
--          not p_expected_tenant answers 'tenant_mismatch', writing nothing and locking no role row in either tenant;
--       7c an UNLOCKED version pre-check: a version already different answers 'version_conflict' before the lock row is
--          inserted or locked;
--       8b the AUTHORITATIVE version check on the version row FOR UPDATE, taken after the role row FOR UPDATE — every edit
--          of that role in that tenant is serialized there, and READ COMMITTED gives this statement a snapshot taken after
--          the wait — answering 'version_conflict' when it moved;
--       9  020's clock recheck, moved before 8b: a session that expired while its edit waited on the role row answers
--          020's no-row refusal, never 'version_conflict';
--       10 020's update of the level (the trigger advances the version), then the version row read back and required to be
--          exactly the checked version + 1, and one row ('applied', tenant, actor, membership, level, version).
--     Any other refusal is 020's: NO row. A 'tenant_mismatch' writes nothing; a 'version_conflict' may leave 020's NULL lock
--     row (the default; no decision changes), which the runtime's rollback of every non-applied answer discards.
--   - THE READ-BACK. m7a_role_level_states answers, on one snapshot, a jsonb array of exactly three objects in the order
--     manager, technician, sales_staff: {"roleId", "level" (020's stored level, or null: no row or a NULL lock row),
--     "version" (this file's counter, or 0)}. It locks and writes nothing.
--   - THE ORDER AN EDIT TAKES (020's, extended; no new cycle). The command transaction's idempotency fence and the
--     runtime's revalidation first (016's hold, the session row, the admission re-read, the unlocked levels read); then
--     this edit: 016's hold again, the session and ledger rows FOR SHARE, the issuer key row FOR SHARE, [7b, 7c: no lock],
--     020's role row inserted if absent and FOR UPDATE, the version row FOR UPDATE, the role row's UPDATE, the trigger's
--     upsert of the version row. A create takes the same role row FOR SHARE and never touches the version table; the
--     read-back takes no lock. The version row is only ever locked or written by a transaction that already holds its role
--     row — FOR UPDATE, or through the UPDATE that fired the trigger (020's edit and a raw update included) — so every
--     writer takes the role row before the version row, and the version row adds no wait of its own.
--   - WHAT IT DOES NOT DO. It writes no audit record, no outbox event and no idempotency completion (the runtime's command
--     transaction appends those around the edit, PUT /api/v1/roles/levels), records no reason and judges no recent
--     authentication (the runtime's step-up). It never deletes a version row.
--   - WHAT THIS DOES NOT DEFEND (doc 08; none of it is claimed closed). 020's residuals stand, and:
--       * the TABLE OWNER (the applying principal) still executes 020's m7a_role_level_set, with no tenant precondition
--         (the trigger moves the version, so it cannot make a stale draft succeed); it can also DELETE a level row — a
--         return to the default that is not an update and moves no version — or disable the trigger. Owner-only — no
--         runtime role reaches any of it (the postcondition below proves that by every path) — and outside the product;
--       * a holder of tmpos_app plus a live minted STORE OWNER key calls m7a_role_level_set_v2 directly and changes that
--         tenant's Customers level with NO audit, reason, step-up, idempotency or outbox record, given the tenant and the
--         version, which m7a_role_level_states discloses to it (020's direct-edit class, DA-119, now preconditioned);
--       * m7a_role_level_states answers any tenant's levels and versions to tmpos_app, keyed by a bare tenant id with no
--         session key — the class of 020's m7a_role_levels (DA-121);
--       * LOCK HOLDING: 020's class (DA-120) — a holder of tmpos_app plus a live store owner key that keeps its transaction
--         open holds the role row FOR UPDATE and its version row, delaying every edit and create of that role in that
--         tenant until its lock or statement timeout;
--       * a database log that captures bind parameters exposes session keys (G-DBROLE, G-PRIVACY; DA-102);
--       * the rollback order is not enforced by the database: 020's rollback run while this file is applied succeeds (a
--         PL/pgSQL body records no dependency and there is no foreign key), these routines then RAISE on the missing
--         objects — failing closed — and this file's rollback refuses until 020 is applied again.
--   - APPLY. The file first takes 020's table SHARE ROW EXCLUSIVE until COMMIT, so the apply is ordered after every 020
--     edit and create in flight when it starts. A 020 call whose EXECUTE was checked before the revoke commits and which
--     then waits on that lock still completes after it — but its update fires the trigger committed with the revoke, so
--     it advances the version like any other edit and a draft read before it is refused. The deploy still drains the
--     pre-021 runtime first (below): that call carries no tenant precondition.
--   - DEPLOY AND ROLLBACK: FORWARD-ONLY IN EFFECT, FAIL CLOSED. It and the runtime that requires 001-021 move together:
--     the P4 runtime (its startup preflight pins exactly 001-021 and these grants) refuses a 020 database, and the 020
--     runtime refuses a 021 one (its approved grants include the EXECUTE revoked here). The rollback REFUSES while any
--     version row exists: once a version has been issued, rolling back and re-applying would restart the counter and
--     could re-issue it (ABA). An operator who must roll back deletes those rows deliberately, as the table owner. The
--     rollback does NOT give tmpos_app its EXECUTE on 020's edit back: rolled back, the runtime role cannot edit a level at
--     all, so no unversioned, tenant-unasserted edit happens while rolled back, and version 0 keeps meaning "not edited
--     since 021". The pre-021 runtime therefore refuses to start after the rollback until an operator deliberately
--     re-grants that EXECUTE — which reopens DA-125. Roll 021 back before 020 (020's rollback refuses while a level differs
--     from its default; this one first).
--   - NO SECRET, NO DYNAMIC SQL, NO EXTENSION, NO TEMPORARY OBJECT. Every statement is fixed text, every value a
--     parameter, every relation and routine schema-qualified; all three routines pin their search_path to pg_catalog then
--     pg_temp and run with row_security off (020's reason). There is no backfill. Version rows grow to at most three per
--     tenant.
--
-- Reversible via 021_m7a_role_level_precondition.down.sql, which refuses while any version row exists, and otherwise
-- removes exactly what this file created — and does not re-grant 020's edit (above). Roll 021 back before 020.
--
-- Assumes 001-020 are applied. A future managed apply targets the complete contiguous chain through the newest committed
-- migration — now 001-021 (owner decision D4); this file authorizes no apply.

-- =============================================================================
-- 0) This transaction's search path
-- =============================================================================
set local search_path = pg_catalog, pg_temp;

-- =============================================================================
-- 1) Preconditions: what this file builds on
-- =============================================================================
do $$
begin
  -- The chain is contiguous: 020 is the newest migration this file sits on.
  if pg_catalog.to_regprocedure('tmpos_role.m7a_role_level_set(text, text, text, text)') is null
     or pg_catalog.to_regclass('tmpos_role.tenant_role_level') is null then
    raise exception 'migration 021 refused: migration 020 must be applied first'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- The runtime roles this file grants to and revokes from.
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'tmpos_app')
     or not exists (select 1 from pg_catalog.pg_roles where rolname = 'tmpos_audit_writer') then
    raise exception 'migration 021 refused: migration 005 must be applied first'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- Nothing of this file exists yet: it is applied once, over a chain that has never held it.
  if pg_catalog.to_regnamespace('tmpos_role_edit') is not null then
    raise exception 'migration 021 refused: schema tmpos_role_edit already exists'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- The edit calls 016's hold and admission read as its owner, the principal applying this file.
  if not (pg_catalog.has_function_privilege(current_user, 'tmpos_session.m5_hold_tenant_standing(text, text)', 'EXECUTE')
          and pg_catalog.has_function_privilege(current_user, 'tmpos_session.m5_admit_tenant_session_v2(text, text)', 'EXECUTE')) then
    raise exception 'migration 021 refused: the applying principal cannot execute 016''s hold and admission read, which the edit calls'
      using errcode = 'insufficient_privilege';
  end if;
  -- A SECURITY DEFINER routine reads and writes only what its OWNER may (020's argument).
  if exists (
    select 1
      from pg_catalog.pg_class c
     where c.oid = any (array['tmpos_session.session'::regclass, 'tmpos_mint.tenant_session'::regclass,
                              'tmpos_mint.issuer_key'::regclass, 'tmpos_role.tenant_role_level'::regclass])
       and (not pg_catalog.pg_has_role(current_user, c.relowner, 'USAGE') or c.relforcerowsecurity)) then
    raise exception 'migration 021 refused: the applying principal neither owns nor inherits the owner of tmpos_session.session, tmpos_mint.tenant_session, tmpos_mint.issuer_key and tmpos_role.tenant_role_level, or one has forced row security'
      using errcode = 'insufficient_privilege';
  end if;
  -- Each privilege stated, one at a time (019's reason): SELECT and UPDATE on the three rows the edit locks FOR SHARE, and
  -- SELECT, INSERT and UPDATE on 020's table, which the edit inserts, locks FOR UPDATE and updates.
  if not (pg_catalog.has_table_privilege(current_user, 'tmpos_session.session', 'SELECT')
          and pg_catalog.has_table_privilege(current_user, 'tmpos_session.session', 'UPDATE')
          and pg_catalog.has_table_privilege(current_user, 'tmpos_mint.tenant_session', 'SELECT')
          and pg_catalog.has_table_privilege(current_user, 'tmpos_mint.tenant_session', 'UPDATE')
          and pg_catalog.has_table_privilege(current_user, 'tmpos_mint.issuer_key', 'SELECT')
          and pg_catalog.has_table_privilege(current_user, 'tmpos_mint.issuer_key', 'UPDATE')
          and pg_catalog.has_table_privilege(current_user, 'tmpos_role.tenant_role_level', 'SELECT')
          and pg_catalog.has_table_privilege(current_user, 'tmpos_role.tenant_role_level', 'INSERT')
          and pg_catalog.has_table_privilege(current_user, 'tmpos_role.tenant_role_level', 'UPDATE')) then
    raise exception 'migration 021 refused: the applying principal lacks SELECT or UPDATE on the session table, the mint ledger or the issuer key, or SELECT, INSERT or UPDATE on tmpos_role.tenant_role_level'
      using errcode = 'insufficient_privilege';
  end if;
end
$$;

-- No 020 edit or create commits between here and this file's COMMIT (see APPLY above): SHARE ROW EXCLUSIVE conflicts with
-- the ROW EXCLUSIVE every insert, update and delete of the table takes — a create's INSERT ... ON CONFLICT DO NOTHING of
-- its NULL lock row included — and not with a read's ACCESS SHARE or a FOR SHARE row lock's ROW SHARE. It is also the lock
-- CREATE TRIGGER and ENABLE ALWAYS TRIGGER take below, so the apply never upgrades it.
lock table tmpos_role.tenant_role_level in share row exclusive mode;

-- =============================================================================
-- 2) The schema
-- =============================================================================
create schema tmpos_role_edit;

comment on schema tmpos_role_edit is
  'Phase 4.0 M7a (migration 021): the owner''s Customers level edit conditional on the tenant and version reviewed — the per-row edit counter and the two routines the read-back and the edit go through. Owned by this migration; tmpos_app holds USAGE and EXECUTE only.';

revoke all on schema tmpos_role_edit from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
grant usage on schema tmpos_role_edit to tmpos_app;

-- =============================================================================
-- 3) The table
-- =============================================================================
-- One row per (tenant, editable role, domain) whose level row has been updated since this file; no row is version 0.
-- Written only by the trigger (section 4c), one upsert per updated level row; never deleted by a routine. No foreign key:
-- a version is an inert integer, and a key to 020's table or to public.tenant would tie this file's rollback and 020's to
-- each other's rows.
create table tmpos_role_edit.role_level_version (
  tenant_id uuid   not null,
  role_id   text   not null
            constraint role_level_version_role_chk check (role_id in ('manager', 'technician', 'sales_staff')),
  domain    text   not null
            constraint role_level_version_domain_chk check (domain = 'customers'),
  version   bigint not null
            constraint role_level_version_version_chk check (version > 0),
  constraint role_level_version_pkey primary key (tenant_id, role_id, domain)
);

comment on table tmpos_role_edit.role_level_version is
  'Phase 4.0 M7a (migration 021): the edit counter of each editable built-in role''s (manager, technician, sales_staff) Customers level per tenant; no row is version 0. Written only by the trigger trg_tenant_role_level_version_advance (old + 1 per update of the level row, by any path). No runtime role holds a privilege on it.';

alter table tmpos_role_edit.role_level_version enable row level security;
revoke all on table tmpos_role_edit.role_level_version from public, anon, authenticated, tmpos_app, tmpos_audit_writer;

-- =============================================================================
-- 4) The routines
-- =============================================================================

-- 4a) The read-back: every editable role's stored level and version, on one snapshot.
create function tmpos_role_edit.m7a_role_level_states(p_tenant_id uuid)
returns jsonb
language plpgsql
-- STABLE: one statement, on the calling query's snapshot; it locks and writes nothing.
stable
security definer
set search_path = pg_catalog, pg_temp
set row_security = off
as $$
declare
  v_states jsonb;
begin
  -- The runtime never sends a null; a null is a fault, never read as "nothing stored".
  if p_tenant_id is null then
    raise exception 'migration 021 states: the argument is null'
      using errcode = 'invalid_parameter_value';
  end if;
  select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('roleId', r.role_id, 'level', l.level,
                                                            'version', coalesce(v.version, 0)) order by r.seq)
    into v_states
    from (values (1, 'manager'), (2, 'technician'), (3, 'sales_staff')) as r(seq, role_id)
    left join tmpos_role.tenant_role_level l
           on l.tenant_id = p_tenant_id and l.role_id = r.role_id and l.domain = 'customers'
    left join tmpos_role_edit.role_level_version v
           on v.tenant_id = p_tenant_id and v.role_id = r.role_id and v.domain = 'customers';
  return v_states;
end
$$;

comment on function tmpos_role_edit.m7a_role_level_states(uuid) is
  'Phase 4.0 M7a (migration 021): one tenant''s editable roles, on one snapshot, as a jsonb array in the order manager, technician, sales_staff of {"roleId", "level" (the stored level, or null: none stored or a NULL lock row), "version" (the edit counter, or 0)}. Raises invalid_parameter_value for a null argument. Read-only.';

-- 4b) The owner's edit, conditional on the tenant and the version the owner reviewed.
create function tmpos_role_edit.m7a_role_level_set_v2(p_session_key text, p_role_id text, p_domain text, p_level text,
                                                      p_expected_tenant uuid, p_expected_version bigint)
returns table (
  o_outcome       text,
  o_tenant_id     uuid,
  o_actor_id      uuid,
  o_membership_id uuid,
  o_level         text,
  o_version       bigint
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
  v_version        bigint;
  v_next           bigint;
begin
  -- 0. The arguments, before any state is read: 020's, and both preconditions present (a version is never negative).
  if p_session_key is null or p_session_key !~ '^[\x21-\x7e]{1,128}$'
     or p_role_id is null or p_role_id not in ('manager', 'technician', 'sales_staff')
     or p_domain is null or p_domain <> 'customers'
     or p_level is null or p_level not in ('none', 'view', 'create', 'edit', 'manage', 'approve', 'full')
     or p_expected_tenant is null
     or p_expected_version is null or p_expected_version < 0 then
    raise exception 'migration 021 set: an argument is malformed'
      using errcode = 'invalid_parameter_value';
  end if;
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'migration 021 set: it must run under READ COMMITTED, so that its checks see what committed before its locks'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- 1-6. The editor, exactly as 020's edit derives it (see 019's create for each step's reason): the unlocked pre-check,
  --      016's hold, the session and ledger rows FOR SHARE, the issuer key row FOR SHARE, the clock after every wait, the
  --      standing digest and a write account status.
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

  -- 7. Exactly one tenant-scope grant, on a tenant whose status is a write status, whose role is the catalog's owner
  --    (020's step 7, and its reason).
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

  -- 7b. The tenant the owner reviewed: the session's own tenant, or nothing is written in either tenant and no role row is
  --     inserted or locked. A precondition only: the tenant written below is still v_tenant.
  if v_tenant is distinct from p_expected_tenant then
    return query select 'tenant_mismatch'::text, null::uuid, null::uuid, null::uuid, null::text, null::bigint;
    return;
  end if;

  -- 7c. The version the owner reviewed, unlocked: one already moved refuses before the lock row is inserted or locked.
  select v.version into v_version
    from tmpos_role_edit.role_level_version v
   where v.tenant_id = v_tenant and v.role_id = p_role_id and v.domain = p_domain;
  if coalesce(v_version, 0) <> p_expected_version then
    return query select 'version_conflict'::text, null::uuid, null::uuid, null::uuid, null::text, null::bigint;
    return;
  end if;

  -- 8. 020's step 8: the role row, in the editor's tenant and no other, made to exist and held FOR UPDATE until COMMIT.
  insert into tmpos_role.tenant_role_level (tenant_id, role_id, domain, level, updated_at)
  values (v_tenant, p_role_id, p_domain, null, pg_catalog.now())
  on conflict (tenant_id, role_id, domain) do nothing;
  perform 1 from tmpos_role.tenant_role_level l
   where l.tenant_id = v_tenant and l.role_id = p_role_id and l.domain = p_domain
     for update;
  if not found then
    return;
  end if;

  -- 9. 020's step 9: live, on the database clock read again after the waits above — before the version is judged, so a
  --    session that expired while it waited on the role row gets 020's no-row refusal, not a version conflict.
  v_now := pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp()) * 1000)::bigint;
  if v_now >= v_session.expires_at then
    return;
  end if;

  -- 8b. The version, authoritatively: read (and locked, when it exists) on a snapshot taken after the role row's wait, so
  --     an edit that committed while this one waited is seen. Moved: nothing is written (the lock row above, the default,
  --     is the caller's to roll back).
  v_version := null;
  select v.version into v_version
    from tmpos_role_edit.role_level_version v
   where v.tenant_id = v_tenant and v.role_id = p_role_id and v.domain = p_domain
     for update;
  if coalesce(v_version, 0) <> p_expected_version then
    return query select 'version_conflict'::text, null::uuid, null::uuid, null::uuid, null::text, null::bigint;
    return;
  end if;

  -- 10. The level (020's update). The version moves with it: the trigger (section 4c) fires at the end of this statement
  --     and advances it by one, as it does for every update of the row.
  update tmpos_role.tenant_role_level l
     set level = p_level, updated_at = pg_catalog.now()
   where l.tenant_id = v_tenant and l.role_id = p_role_id and l.domain = p_domain;
  -- A change an owner's trigger suppressed is not an edit: raise, so the caller rolls back.
  if not found then
    raise exception 'migration 021 set: the level was not written'
      using errcode = 'no_data_found';
  end if;
  -- The version read back, on a snapshot taken after the trigger's upsert. Not the checked one's successor — the trigger
  -- disabled, dropped or doubled, which only the table's owner can do — is not an edit: raise, so the caller rolls back.
  v_next := null;
  select v.version into v_next
    from tmpos_role_edit.role_level_version v
   where v.tenant_id = v_tenant and v.role_id = p_role_id and v.domain = p_domain;
  if v_next is distinct from p_expected_version + 1 then
    raise exception 'migration 021 set: the version was not advanced'
      using errcode = 'no_data_found';
  end if;

  return query select 'applied'::text, v_tenant, v_admission.actor_id, v_membership, p_level, v_next;
end
$$;

comment on function tmpos_role_edit.m7a_role_level_set_v2(text, text, text, text, uuid, bigint) is
  'Phase 4.0 M7a (migration 021): migration 020''s m7a_role_level_set, conditional: for a key 020''s edit accepts (a live minted tenant session of a store owner holding exactly one tenant grant), answers ''tenant_mismatch'' (nothing written, no role row locked) when that grant''s tenant is not p_expected_tenant, ''version_conflict'' when the role''s edit counter (0 when none) is not p_expected_version — checked unlocked, then again under the role row FOR UPDATE — and otherwise sets the level, advances the counter by exactly one and answers ''applied'' with the tenant, actor, membership, level and new version. No row on any of 020''s refusals. Raises invalid_parameter_value (fixed message) for a malformed argument, object_not_in_prerequisite_state outside READ COMMITTED, no_data_found when the level was not written or the version not advanced by exactly one, and whatever 016''s hold or read raises. Writes no audit record.';

-- 4c) The counter: every update of a level row, by any path, advances that row's version by exactly one.
-- AFTER, not BEFORE: an AFTER ROW trigger fires only for a row the update actually wrote, so a change another BEFORE
-- trigger suppressed moves no version; it fires at the end of the updating statement, so the edit's next statement reads
-- the advanced version. It runs as its owner (SECURITY DEFINER) because the updater — 020's edit, this file's, or the
-- table's owner — may not itself hold a privilege on the version table. A firing this file does not declare raises
-- rather than guessing (015's rule). An update that moves a row to another key advances the version of both keys: each
-- key's level changed.
create function tmpos_role_edit.m7a_role_level_version_advance()
returns trigger
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set row_security = off
as $$
begin
  if tg_when is distinct from 'AFTER' or tg_level is distinct from 'ROW' or tg_op is distinct from 'UPDATE'
     or tg_table_schema is distinct from 'tmpos_role' or tg_table_name is distinct from 'tenant_role_level' then
    raise exception 'm7a_role_level_version_advance: fired by an undeclared trigger'
      using errcode = 'triggered_action_exception';
  end if;
  insert into tmpos_role_edit.role_level_version as v (tenant_id, role_id, domain, version)
  values (new.tenant_id, new.role_id, new.domain, 1)
  on conflict (tenant_id, role_id, domain) do update set version = v.version + 1;
  if row(old.tenant_id, old.role_id, old.domain) is distinct from row(new.tenant_id, new.role_id, new.domain) then
    insert into tmpos_role_edit.role_level_version as v (tenant_id, role_id, domain, version)
    values (old.tenant_id, old.role_id, old.domain, 1)
    on conflict (tenant_id, role_id, domain) do update set version = v.version + 1;
  end if;
  return null;
end
$$;

comment on function tmpos_role_edit.m7a_role_level_version_advance() is
  'Phase 4.0 M7a (migration 021): AFTER UPDATE row trigger on tmpos_role.tenant_role_level (enabled ALWAYS). Advances tmpos_role_edit.role_level_version for the updated row''s (tenant, role, domain) by exactly one (inserting 1 when none), and the old key''s too when the update moved the row, for every update by any path. Raises triggered_action_exception for any other firing. Granted to nobody.';

-- 4d) The trigger, on 020's table. ALWAYS, as 013's and 015's are: an update by a session running as a replica advances
-- the version too.
create trigger trg_tenant_role_level_version_advance
  after update on tmpos_role.tenant_role_level
  for each row execute function tmpos_role_edit.m7a_role_level_version_advance();
alter table tmpos_role.tenant_role_level enable always trigger trg_tenant_role_level_version_advance;

-- =============================================================================
-- 5) Privileges, and the proof that nothing wider was issued
-- =============================================================================
-- PostgreSQL grants EXECUTE on a new function to PUBLIC by default, so every default is removed explicitly before the two
-- intended grants are issued. The trigger function is granted to nobody: a trigger fires its function without an EXECUTE
-- check.
revoke all on function tmpos_role_edit.m7a_role_level_states(uuid) from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
revoke all on function tmpos_role_edit.m7a_role_level_set_v2(text, text, text, text, uuid, bigint) from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
revoke all on function tmpos_role_edit.m7a_role_level_version_advance() from public, anon, authenticated, tmpos_app, tmpos_audit_writer;

grant execute on function tmpos_role_edit.m7a_role_level_states(uuid) to tmpos_app;
grant execute on function tmpos_role_edit.m7a_role_level_set_v2(text, text, text, text, uuid, bigint) to tmpos_app;

-- 020's unconditional edit (020 section 5 granted it). The object stays, byte for byte; the runtime role no longer
-- reaches it.
revoke execute on function tmpos_role.m7a_role_level_set(text, text, text, text) from tmpos_app;

-- The postcondition, proven rather than asserted, in 020's form. This file refuses to finish unless, now:
--   (a) the schema holds exactly the three routines, the one table and its primary-key index, and no view, sequence,
--       standalone type or trigger, and the table has no foreign key;
--   (b) all three routines are plpgsql, SECURITY DEFINER, pinned to the search path above and run with row_security off
--       — the read STABLE, the edit and the trigger function VOLATILE, the trigger function alone returning trigger — and
--       the routines, the table and the schema are owned by the applying principal;
--   (c) the read and the edit carry no grant beyond their owner's and a non-grantable EXECUTE to tmpos_app; the trigger
--       function none beyond its owner's;
--   (d) the schema carries no grant beyond its owner's and a non-grantable USAGE to tmpos_app;
--   (e) the table is under row level security, not forced, with no policy, no grant beyond its owner's and no column grant;
--   (f) tmpos_app CAN execute the two, use the schema, and still execute 020's levels read, create and page_v3;
--       tmpos_audit_writer, anon and authenticated CANNOT execute any new routine by any path; and NO runtime role
--       (tmpos_app included) can execute the trigger function or 020's m7a_role_level_set by any path (PUBLIC, an
--       inherited role, or a role reachable only through SET ROLE);
--   (g) none of the runtime roles is a MEMBER of the owner of the schema, a routine, the table, or a table the edit rests
--       on (020's role table, the session table, the mint ledger, the issuer key);
--   (h) neither a runtime role nor any role it is a member of HOLDS a privilege on the version table or 020's role table,
--       no column grant exists on either, and each is under row level security, not forced;
--   (j) tmpos_app and tmpos_audit_writer are members of NOTHING;
--   (k) anon and authenticated reach neither tmpos_app nor tmpos_audit_writer by any membership;
--   (l) the trigger function is called by exactly one trigger, section 4d's, on tmpos_role.tenant_role_level: AFTER ROW
--       UPDATE, enabled ALWAYS, with no column list and no WHEN condition, and that table carries no other trigger but a
--       foreign key's internal ones.
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
  if (select pg_catalog.count(*) from pg_catalog.pg_proc p where p.pronamespace = 'tmpos_role_edit'::regnamespace) <> 3
     or pg_catalog.to_regprocedure('tmpos_role_edit.m7a_role_level_states(uuid)') is null
     or pg_catalog.to_regprocedure('tmpos_role_edit.m7a_role_level_set_v2(text, text, text, text, uuid, bigint)') is null
     or pg_catalog.to_regprocedure('tmpos_role_edit.m7a_role_level_version_advance()') is null
     or (select pg_catalog.count(*) from pg_catalog.pg_class c
          where c.relnamespace = 'tmpos_role_edit'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S', 'c')) <> 1
     or pg_catalog.to_regclass('tmpos_role_edit.role_level_version') is null
     or (select pg_catalog.count(*) from pg_catalog.pg_class c
          where c.relnamespace = 'tmpos_role_edit'::regnamespace and c.relkind in ('i', 'I')) <> 1
     or exists (select 1 from pg_catalog.pg_type t
                 where t.typnamespace = 'tmpos_role_edit'::regnamespace and t.typrelid = 0 and t.typelem = 0)
     or exists (select 1 from pg_catalog.pg_trigger g join pg_catalog.pg_class c on c.oid = g.tgrelid
                 where c.relnamespace = 'tmpos_role_edit'::regnamespace)
     or exists (select 1 from pg_catalog.pg_constraint k
                 where k.conrelid = 'tmpos_role_edit.role_level_version'::regclass and k.contype = 'f') then
    raise exception 'migration 021 refused: schema tmpos_role_edit does not hold exactly the three routines, the table and its index this file creates'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (b)
  if (select pg_catalog.count(*)
        from pg_catalog.pg_proc p
        join pg_catalog.pg_language l on l.oid = p.prolang
       where p.pronamespace = 'tmpos_role_edit'::regnamespace
         and l.lanname = 'plpgsql'
         and p.prosecdef
         and ((p.proname = 'm7a_role_level_states' and p.provolatile = 's' and p.prorettype <> 'pg_catalog.trigger'::regtype)
              or (p.proname = 'm7a_role_level_set_v2' and p.provolatile = 'v' and p.prorettype <> 'pg_catalog.trigger'::regtype)
              or (p.proname = 'm7a_role_level_version_advance' and p.provolatile = 'v'
                  and p.prorettype = 'pg_catalog.trigger'::regtype))
         and p.proconfig = array['search_path=pg_catalog, pg_temp', 'row_security=off']
         and p.proowner = v_me) <> 3
     or not exists (select 1 from pg_catalog.pg_namespace n where n.oid = 'tmpos_role_edit'::regnamespace and n.nspowner = v_me)
     or not exists (select 1 from pg_catalog.pg_class c where c.oid = 'tmpos_role_edit.role_level_version'::regclass and c.relowner = v_me) then
    raise exception 'migration 021 refused: a routine in tmpos_role_edit is not a plpgsql SECURITY DEFINER routine of the volatility this file gives it, pinned to pg_catalog, pg_temp with row_security off, owned with its schema and table by the applying principal'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (c)
  select pg_catalog.string_agg(pg_catalog.format('%s %s:%s', p.proname, g.grantee::regrole::text, g.privilege_type), ', ')
    into v_bad
    from pg_catalog.pg_proc p,
         pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g
   where p.pronamespace = 'tmpos_role_edit'::regnamespace
     and g.grantee <> p.proowner
     and not (p.proname <> 'm7a_role_level_version_advance'
              and g.grantee = 'tmpos_app'::regrole and g.privilege_type = 'EXECUTE' and not g.is_grantable);
  if v_bad is not null then
    raise exception 'migration 021 refused: an unexpected direct grant remains on a tmpos_role_edit routine (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (d)
  select pg_catalog.string_agg(pg_catalog.format('%s:%s', g.grantee::regrole::text, g.privilege_type), ', ')
    into v_bad
    from pg_catalog.pg_namespace n,
         pg_catalog.aclexplode(coalesce(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) g
   where n.oid = 'tmpos_role_edit'::regnamespace
     and g.grantee <> n.nspowner
     and not (g.grantee = 'tmpos_app'::regrole and g.privilege_type = 'USAGE' and not g.is_grantable);
  if v_bad is not null then
    raise exception 'migration 021 refused: schema tmpos_role_edit carries an unexpected grant (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (e)
  if exists (select 1 from pg_catalog.pg_class c
              where c.oid = 'tmpos_role_edit.role_level_version'::regclass
                and (not c.relrowsecurity or c.relforcerowsecurity))
     or exists (select 1 from pg_catalog.pg_policy p where p.polrelid = 'tmpos_role_edit.role_level_version'::regclass) then
    raise exception 'migration 021 refused: row level security is not enabled (unforced) on tmpos_role_edit.role_level_version, or a policy exists on it'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  select pg_catalog.string_agg(pg_catalog.format('%s:%s', g.grantee::regrole::text, g.privilege_type), ', ')
    into v_bad
    from pg_catalog.pg_class c,
         pg_catalog.aclexplode(coalesce(c.relacl, pg_catalog.acldefault('r', c.relowner))) g
   where c.oid = 'tmpos_role_edit.role_level_version'::regclass
     and g.grantee <> c.relowner;
  if v_bad is not null then
    raise exception 'migration 021 refused: an unexpected grant remains on tmpos_role_edit.role_level_version (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (f)
  if not pg_catalog.has_function_privilege('tmpos_app', 'tmpos_role_edit.m7a_role_level_states(uuid)'::regprocedure, 'EXECUTE')
     or not pg_catalog.has_function_privilege('tmpos_app',
              'tmpos_role_edit.m7a_role_level_set_v2(text, text, text, text, uuid, bigint)'::regprocedure, 'EXECUTE')
     or not pg_catalog.has_schema_privilege('tmpos_app', 'tmpos_role_edit'::regnamespace, 'USAGE')
     or not pg_catalog.has_function_privilege('tmpos_app', 'tmpos_role.m7a_role_levels(uuid, text)'::regprocedure, 'EXECUTE')
     or not pg_catalog.has_function_privilege('tmpos_app', 'tmpos_role.m7a_customer_create(text, uuid, text)'::regprocedure, 'EXECUTE')
     or not pg_catalog.has_function_privilege('tmpos_app', 'tmpos_role.m7a_customer_page_v3(text, uuid, integer)'::regprocedure, 'EXECUTE')
     or not pg_catalog.has_schema_privilege('tmpos_app', 'tmpos_role'::regnamespace, 'USAGE') then
    raise exception 'migration 021 refused: tmpos_app does not hold EXECUTE on the two routines and USAGE on schema tmpos_role_edit, or no longer holds 020''s levels read, create and page_v3'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  select pg_catalog.string_agg(distinct pg_catalog.format('%s: %s', r.rolname, p.oid::regprocedure), ', ') into v_bad
    from pg_catalog.pg_roles r
    join pg_catalog.pg_roles x on pg_catalog.pg_has_role(r.oid, x.oid, 'MEMBER')
    cross join pg_catalog.pg_proc p
   where p.pronamespace = 'tmpos_role_edit'::regnamespace
     and r.rolname = any (array['tmpos_audit_writer', 'anon', 'authenticated']::name[])
     and pg_catalog.has_function_privilege(x.oid, p.oid, 'EXECUTE');
  if v_bad is not null then
    raise exception 'migration 021 refused: a runtime role other than tmpos_app can execute a tmpos_role_edit routine (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  select pg_catalog.string_agg(distinct r.rolname::text, ', ') into v_bad
    from pg_catalog.pg_roles r
    join pg_catalog.pg_roles x on pg_catalog.pg_has_role(r.oid, x.oid, 'MEMBER')
   where r.rolname = any (array['tmpos_app', 'tmpos_audit_writer', 'anon', 'authenticated']::name[])
     and pg_catalog.has_function_privilege(x.oid,
           'tmpos_role.m7a_role_level_set(text, text, text, text)'::regprocedure, 'EXECUTE');
  if v_bad is not null then
    raise exception 'migration 021 refused: % can still execute 020''s unconditional edit tmpos_role.m7a_role_level_set', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  select pg_catalog.string_agg(distinct r.rolname::text, ', ') into v_bad
    from pg_catalog.pg_roles r
    join pg_catalog.pg_roles x on pg_catalog.pg_has_role(r.oid, x.oid, 'MEMBER')
   where r.rolname = any (array['tmpos_app', 'tmpos_audit_writer', 'anon', 'authenticated']::name[])
     and pg_catalog.has_function_privilege(x.oid,
           'tmpos_role_edit.m7a_role_level_version_advance()'::regprocedure, 'EXECUTE');
  if v_bad is not null then
    raise exception 'migration 021 refused: % can execute the trigger function tmpos_role_edit.m7a_role_level_version_advance', v_bad
      using errcode = 'object_not_in_prerequisite_state',
            hint = 'the trigger function is granted to nobody';
  end if;

  -- (g)
  select pg_catalog.string_agg(distinct r.rolname::text, ', ') into v_bad
    from pg_catalog.pg_roles r
    cross join (
      select n.nspowner as owner from pg_catalog.pg_namespace n where n.nspname = 'tmpos_role_edit'
      union
      select p.proowner from pg_catalog.pg_proc p where p.pronamespace = 'tmpos_role_edit'::regnamespace
      union
      select c.relowner from pg_catalog.pg_class c
       where c.oid in ('tmpos_role_edit.role_level_version'::regclass, 'tmpos_role.tenant_role_level'::regclass,
                       'tmpos_session.session'::regclass, 'tmpos_mint.tenant_session'::regclass,
                       'tmpos_mint.issuer_key'::regclass)
    ) o
   where r.rolname = any (array['tmpos_app', 'tmpos_audit_writer', 'anon', 'authenticated']::name[])
     and pg_catalog.pg_has_role(r.oid, o.owner, 'MEMBER');
  if v_bad is not null then
    raise exception 'migration 021 refused: % is a member of the owner of schema tmpos_role_edit, a routine or table in it, or a table its edit rests on', v_bad
      using errcode = 'object_not_in_prerequisite_state',
            hint = 'membership hands a role everything the owner holds, including a direct write of every version and level';
  end if;

  -- (h) MAINTAIN only on a server that has it (PostgreSQL 17+), where has_table_privilege would reject it on 16.
  select pg_catalog.string_agg(distinct r.rolname::text || ' on ' || t.oid::regclass::text, ', ') into v_bad
    from pg_catalog.pg_roles r
    join pg_catalog.pg_roles x on pg_catalog.pg_has_role(r.oid, x.oid, 'MEMBER')
    cross join (values ('tmpos_role_edit.role_level_version'::regclass), ('tmpos_role.tenant_role_level'::regclass)) as t(oid)
   where r.rolname = any (array['tmpos_app', 'tmpos_audit_writer', 'anon', 'authenticated']::name[])
     and pg_catalog.has_table_privilege(x.oid, t.oid,
           'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'
           operator(pg_catalog.||) case when pg_catalog.current_setting('server_version_num')::integer >= 170000
                                        then ', MAINTAIN' else '' end);
  if v_bad is not null then
    raise exception 'migration 021 refused: % holds an effective privilege on the version table or the role table', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if exists (select 1 from pg_catalog.pg_attribute a, pg_catalog.aclexplode(a.attacl) g
              where a.attrelid in ('tmpos_role_edit.role_level_version'::regclass, 'tmpos_role.tenant_role_level'::regclass)
                and a.attnum > 0 and not a.attisdropped) then
    raise exception 'migration 021 refused: a column grant exists on the version table or the role table'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if exists (select 1 from pg_catalog.pg_class c
              where c.oid in ('tmpos_role_edit.role_level_version'::regclass, 'tmpos_role.tenant_role_level'::regclass)
                and (not c.relrowsecurity or c.relforcerowsecurity)) then
    raise exception 'migration 021 refused: row level security is not enabled (unforced) on the version table or the role table'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (j)
  select pg_catalog.string_agg(pg_catalog.format('%s in %s', m.member::regrole, m.roleid::regrole), ', '
                               order by m.member, m.roleid) into v_bad
    from pg_catalog.pg_auth_members m
    join pg_catalog.pg_roles r on r.oid = m.member
   where r.rolname = any (array['tmpos_app', 'tmpos_audit_writer']::name[]);
  if v_bad is not null then
    raise exception 'migration 021 refused: tmpos_app and tmpos_audit_writer must be members of nothing (%)', v_bad
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
    raise exception 'migration 021 refused: anon and authenticated must reach neither tmpos_app nor tmpos_audit_writer by membership (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (l) tgtype: ROW 1 + UPDATE 16 = 17 (AFTER sets no bit; INSERT, DELETE, TRUNCATE and INSTEAD OF absent).
  if (select pg_catalog.count(*) from pg_catalog.pg_trigger g
       where g.tgfoid = 'tmpos_role_edit.m7a_role_level_version_advance()'::regprocedure) <> 1
     or (select pg_catalog.count(*) from pg_catalog.pg_trigger g
          where g.tgrelid = 'tmpos_role.tenant_role_level'::regclass and not g.tgisinternal) <> 1
     or not exists (select 1 from pg_catalog.pg_trigger g
                     where g.tgrelid = 'tmpos_role.tenant_role_level'::regclass
                       and g.tgname = 'trg_tenant_role_level_version_advance'
                       and g.tgfoid = 'tmpos_role_edit.m7a_role_level_version_advance()'::regprocedure
                       and g.tgtype = 17
                       and g.tgenabled = 'A'
                       and g.tgattr = ''::pg_catalog.int2vector
                       and g.tgqual is null
                       and not g.tgisinternal) then
    raise exception 'migration 021 refused: the version trigger is not exactly the one section 4d declares, or tmpos_role.tenant_role_level carries another trigger'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$$;

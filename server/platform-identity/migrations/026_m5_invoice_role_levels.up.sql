-- Phase 4.0 M5 — the owner's Invoices level, stored and versioned beside the Customers one: the two CHECKs that pinned the
-- level tables to 'customers' widened to 'customers' and 'invoices', and an Invoices-only read-back and edit that are
-- 021's (M5-INVOICES-AUTH-P1; G-IAM, G-DBROLE; docs/phase-4/10)
-- Migration: 026_m5_invoice_role_levels (UP)
--
-- SCOPE / TRUTH (binding):
--   - ONE NEW SCHEMA, TWO ROUTINES, TWO WIDENED CHECKS, NO TABLE, NO COLUMN, NO ROLE, NO TRIGGER, NO TYPE. This file
--     creates schema tmpos_role_invoice and in it the two routines tmpos_app may execute: m7a_invoice_role_level_states
--     (the owner's read-back of the Invoices level and version of the three editable roles, one snapshot) and
--     m7a_invoice_role_level_set (021's m7a_role_level_set_v2 with the domain fixed to 'invoices'). It also replaces, by
--     DROP and ADD under the same names, the one CHECK on 020's tmpos_role.tenant_role_level (tenant_role_level_domain_chk)
--     and the one on 021's tmpos_role_edit.role_level_version (role_level_version_domain_chk): each was
--     check (domain = 'customers'), each becomes check (domain in ('customers', 'invoices')). That is its only effect on
--     objects earlier migrations created: 001-025 stay byte for byte as committed (the migration-files contract's pinned
--     checksums prove that), 020's and 021's routines, grants, schemas, tables and the one trigger on 020's table are not
--     altered, and nothing is added to schema tmpos_role or tmpos_role_edit (020's and 021's postconditions pin their
--     inventories, and their rollbacks drop those schemas without CASCADE). 020's apply-time postcondition and 021's
--     describe the database as it was when they ran; neither is a standing guarantee.
--   - THIS IS AUTHORIZATION CONFIGURATION ONLY. It stores what the owner chose for the Invoices level of manager,
--     technician and sales_staff, and the counter that makes a stale edit refuse. No invoice table, invoice route or invoice
--     decision exists in the server, and this file adds none: a stored Invoices level is read by the runtime's owner-only
--     configuration routes and by the resolver that materializes a tenant session's permissions, and is not, by itself,
--     enforced by any invoice operation. Nothing here may be read as "invoices are server-enforced".
--   - WHY THE ROUTINES ARE INVOICES-ONLY. 021's edit and read-back are hard-wired to 'customers' (an argument other than
--     that raises). Each routine here has the domain written into its text, so an Invoices edit can never write or version
--     a Customers row and a Customers edit never reaches an Invoices one; the owner's one Customers path (021's set_v2 and
--     states, which the runtime keeps calling) is untouched. 020's tmpos_role.m7a_role_levels already answers every stored
--     domain (it aggregates domain to level), so it returns an Invoices level as soon as one is stored; every Customers
--     decision (020's create and page_v3, 022-025's reads, 024's edit) filters domain = 'customers' and is unaffected by
--     an Invoices row.
--   - THE EDIT IS 021's, STATEMENT FOR STATEMENT, with the domain fixed: the editor derived from the session key alone (the
--     unlocked live/issuer pre-check; 016's hold; the session and mint-ledger rows FOR SHARE; the issuer key row FOR SHARE;
--     the database clock after every wait; the standing digest; a write account status; exactly one tenant grant, on a
--     write-status tenant, as store_owner), the tenant precondition (7b: 'tenant_mismatch', nothing written, no role row
--     locked), the unlocked version pre-check (7c: 'version_conflict'), 020's role row inserted if absent and FOR UPDATE,
--     the clock again, the authoritative version check under the version row FOR UPDATE (8b), the level's UPDATE (021's
--     trigger advances the version, which is domain-agnostic: per tenant, role and domain), the version read back and
--     required to be exactly the checked version + 1, and one row ('applied', tenant, actor, membership, level,
--     version). Any other refusal is NO row. The lock order is 021's: 016's hold, the session and ledger rows, the issuer
--     key row, the role row, the version row, the UPDATE, the trigger's upsert — every writer of a role/domain takes the
--     role row before the version row. An Invoices edit and a Customers edit of the same role lock different rows (the key
--     includes the domain), so neither waits on the other.
--   - THE READ-BACK. m7a_invoice_role_level_states answers, on one snapshot, a jsonb array of exactly three objects in the
--     order manager, technician, sales_staff: {"roleId", "level" (the stored Invoices level, or null), "version" (the
--     counter, or 0)}: 021's states with 'invoices'. A reset to the catalog default is an UPDATE to the default word (the
--     runtime never writes NULL), so it advances the version and an older draft is refused (no ABA). No row is version 0:
--     nothing is seeded, so every tenant reads Invoices version 0 and the catalog default until its owner edits.
--   - WHAT IT DOES NOT DO. It writes no audit record, no outbox event and no idempotency completion (the runtime's command
--     transaction appends those around the edit, PUT /api/v1/roles/levels), records no reason and judges no recent
--     authentication (the runtime's step-up). It stores no custom role, no other domain and no other role than the three,
--     deletes nothing, and widens the CHECKs to exactly the two domains the server resolves.
--   - WHAT THIS DOES NOT DEFEND (doc 08; none of it is claimed closed). 020's and 021's residuals stand for the new
--     routines, and:
--       * a holder of tmpos_app plus a live minted STORE OWNER key calls m7a_invoice_role_level_set directly and changes that
--         tenant's Invoices level with NO audit, reason, step-up, idempotency or outbox record, given the tenant and the
--         version, which m7a_invoice_role_level_states discloses to it — the same G-AUDIT exception 021's set_v2 carries
--         (DA-119), now for a second domain;
--       * m7a_invoice_role_level_states answers any tenant's Invoices levels and versions to tmpos_app, keyed by a bare
--         tenant id with no session key — the class of 020's m7a_role_levels and 021's states (DA-121);
--       * LOCK HOLDING: 020's class (DA-120) — a holder of tmpos_app plus a live store owner key that keeps its transaction
--         open holds the Invoices role row FOR UPDATE and its version row, delaying every Invoices edit of that role in that
--         tenant until its lock or statement timeout;
--       * the TABLE OWNER (the applying principal) can still write either table directly, delete a row (a return to the
--         default that is not an update and moves no version) or disable 021's trigger — owner-only, no runtime role reaches
--         any of it (the postcondition below proves it by every path), and outside the product;
--       * a database log that captures bind parameters exposes session keys (G-DBROLE, G-PRIVACY; DA-102);
--       * the rollback order is not enforced by the database: 021's or 020's rollback run while this file is applied
--         succeeds or refuses on its own guard (below), these routines then raise on the missing objects — failing closed —
--         and this file's rollback refuses until they are applied again. Roll 026 back before 021 and 020.
--   - APPLY. The file takes both level tables ACCESS EXCLUSIVE until COMMIT (the lock ALTER TABLE ... DROP/ADD CONSTRAINT
--     takes anyway), 020's role table first, then the version table, in the order every writer takes them, so the apply is
--     ordered after every edit and create in flight when it starts and no row can be written between the checks it makes
--     and the constraints it replaces. Every existing row is a 'customers' row, so the widened CHECKs validate trivially.
--   - DEPLOY AND ROLLBACK: FORWARD-ONLY IN EFFECT, FAIL CLOSED. It and the runtime that requires 001-026 move together:
--     the runtime's startup preflight pins the exact ledger and the exact grants, so the 001-025 runtime refuses a 026
--     database (its approved grants lack the two EXECUTEs and the schema USAGE) and this runtime refuses a 025 one. The
--     rollback REFUSES while any row whose domain is 'invoices' exists in EITHER table — a stored Invoices level, or an
--     issued Invoices version: re-narrowing the CHECKs would fail on it, and rolling back and re-applying over a deleted
--     version row would restart that counter and could re-issue a version a stale draft still holds (ABA). An operator who
--     must roll back deletes those rows deliberately, as the table owner. 020's rollback guard compares a stored level with
--     its role's catalog default without looking at the domain and 021's refuses on ANY version row, Invoices included:
--     both stay correct, because 026's rollback — which must run first — refuses while an Invoices row exists, so by the
--     time 020's or 021's guard runs only Customers rows can remain. Audit records are never touched by any rollback.
--   - NO SECRET, NO DYNAMIC SQL, NO EXTENSION, NO TEMPORARY OBJECT. Every statement is fixed text, every value a parameter,
--     every relation and routine schema-qualified; both routines pin their search_path to pg_catalog then pg_temp and run
--     with row_security off (020's reason). There is no backfill. Invoices rows grow to at most three level rows and three
--     version rows per tenant.
--
-- Reversible via 026_m5_invoice_role_levels.down.sql, which refuses while any Invoices row exists in either table, and
-- otherwise removes exactly what this file created and restores both CHECKs. Roll 026 back before 021 and 020.
--
-- Assumes 001-025 are applied. A future managed apply targets the complete contiguous chain through the newest committed
-- migration — now 001-026 (owner decision D4); this file authorizes no apply.

-- =============================================================================
-- 0) This transaction's search path
-- =============================================================================
set local search_path = pg_catalog, pg_temp;

-- =============================================================================
-- 1) Preconditions: what this file builds on
-- =============================================================================
do $$
begin
  -- The chain is contiguous: 025 is the newest migration this file sits on, and 020's and 021's objects are in place.
  if pg_catalog.to_regprocedure('tmpos_customer_search.m7a_customer_search(text, uuid, text, uuid, integer)') is null then
    raise exception 'migration 026 refused: migration 025 must be applied first'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if pg_catalog.to_regclass('tmpos_role.tenant_role_level') is null
     or pg_catalog.to_regprocedure('tmpos_role.m7a_role_levels(uuid, text)') is null
     or pg_catalog.to_regprocedure('tmpos_role.m7a_customer_create(text, uuid, text)') is null
     or pg_catalog.to_regprocedure('tmpos_role.m7a_customer_page_v3(text, uuid, integer)') is null
     or pg_catalog.to_regclass('tmpos_role_edit.role_level_version') is null
     or pg_catalog.to_regprocedure('tmpos_role_edit.m7a_role_level_states(uuid)') is null
     or pg_catalog.to_regprocedure('tmpos_role_edit.m7a_role_level_set_v2(text, text, text, text, uuid, bigint)') is null
     or pg_catalog.to_regprocedure('tmpos_role_edit.m7a_role_level_version_advance()') is null then
    raise exception 'migration 026 refused: migration 020 or 021 is not applied'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- The runtime roles this file grants to and revokes from.
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'tmpos_app')
     or not exists (select 1 from pg_catalog.pg_roles where rolname = 'tmpos_audit_writer') then
    raise exception 'migration 026 refused: migration 005 must be applied first'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- Nothing of this file exists yet: it is applied once, over a chain that has never held it.
  if pg_catalog.to_regnamespace('tmpos_role_invoice') is not null then
    raise exception 'migration 026 refused: schema tmpos_role_invoice already exists'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- The two CHECKs are exactly the narrow ones 020 and 021 created: a database that holds anything else is not the one this
  -- file was written for, and replacing a constraint it did not expect would hide that.
  if (select pg_catalog.count(*) from pg_catalog.pg_constraint k
       where k.conrelid = 'tmpos_role.tenant_role_level'::regclass and k.contype = 'c'
         and k.conname = 'tenant_role_level_domain_chk' and k.convalidated
         and pg_catalog.pg_get_constraintdef(k.oid) = 'CHECK ((domain = ''customers''::text))') <> 1
     or (select pg_catalog.count(*) from pg_catalog.pg_constraint k
          where k.conrelid = 'tmpos_role_edit.role_level_version'::regclass and k.contype = 'c'
            and k.conname = 'role_level_version_domain_chk' and k.convalidated
            and pg_catalog.pg_get_constraintdef(k.oid) = 'CHECK ((domain = ''customers''::text))') <> 1 then
    raise exception 'migration 026 refused: tenant_role_level_domain_chk or role_level_version_domain_chk is not the check (domain = ''customers'') that 020 and 021 create'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- The edit calls 016's hold and admission read as its owner, the principal applying this file.
  if not (pg_catalog.has_function_privilege(current_user, 'tmpos_session.m5_hold_tenant_standing(text, text)', 'EXECUTE')
          and pg_catalog.has_function_privilege(current_user, 'tmpos_session.m5_admit_tenant_session_v2(text, text)', 'EXECUTE')) then
    raise exception 'migration 026 refused: the applying principal cannot execute 016''s hold and admission read, which the edit calls'
      using errcode = 'insufficient_privilege';
  end if;
  -- A SECURITY DEFINER routine reads and writes only what its OWNER may (020's argument); ALTER TABLE needs the owner too.
  if exists (
    select 1
      from pg_catalog.pg_class c
     where c.oid = any (array['tmpos_session.session'::regclass, 'tmpos_mint.tenant_session'::regclass,
                              'tmpos_mint.issuer_key'::regclass, 'tmpos_role.tenant_role_level'::regclass,
                              'tmpos_role_edit.role_level_version'::regclass])
       and (not pg_catalog.pg_has_role(current_user, c.relowner, 'USAGE') or c.relforcerowsecurity)) then
    raise exception 'migration 026 refused: the applying principal neither owns nor inherits the owner of tmpos_session.session, tmpos_mint.tenant_session, tmpos_mint.issuer_key, tmpos_role.tenant_role_level and tmpos_role_edit.role_level_version, or one has forced row security'
      using errcode = 'insufficient_privilege';
  end if;
  -- Each privilege stated, one at a time (019's reason): SELECT and UPDATE on the three rows the edit locks FOR SHARE,
  -- SELECT, INSERT and UPDATE on 020's table (inserted, locked FOR UPDATE, updated), and SELECT and UPDATE on 021's version
  -- table (read, and locked FOR UPDATE).
  if not (pg_catalog.has_table_privilege(current_user, 'tmpos_session.session', 'SELECT')
          and pg_catalog.has_table_privilege(current_user, 'tmpos_session.session', 'UPDATE')
          and pg_catalog.has_table_privilege(current_user, 'tmpos_mint.tenant_session', 'SELECT')
          and pg_catalog.has_table_privilege(current_user, 'tmpos_mint.tenant_session', 'UPDATE')
          and pg_catalog.has_table_privilege(current_user, 'tmpos_mint.issuer_key', 'SELECT')
          and pg_catalog.has_table_privilege(current_user, 'tmpos_mint.issuer_key', 'UPDATE')
          and pg_catalog.has_table_privilege(current_user, 'tmpos_role.tenant_role_level', 'SELECT')
          and pg_catalog.has_table_privilege(current_user, 'tmpos_role.tenant_role_level', 'INSERT')
          and pg_catalog.has_table_privilege(current_user, 'tmpos_role.tenant_role_level', 'UPDATE')
          and pg_catalog.has_table_privilege(current_user, 'tmpos_role_edit.role_level_version', 'SELECT')
          and pg_catalog.has_table_privilege(current_user, 'tmpos_role_edit.role_level_version', 'UPDATE')) then
    raise exception 'migration 026 refused: the applying principal lacks SELECT or UPDATE on the session table, the mint ledger, the issuer key or the version table, or SELECT, INSERT or UPDATE on tmpos_role.tenant_role_level'
      using errcode = 'insufficient_privilege';
  end if;
end
$$;

-- No level edit, create or version write commits between here and this file's COMMIT (see APPLY above): ACCESS EXCLUSIVE
-- conflicts with every lock, a read's ACCESS SHARE and a FOR SHARE row lock's ROW SHARE included, and is the lock the
-- constraint replacement takes anyway. In the writers' order — the role table before the version table — so it cannot
-- deadlock with an edit that holds a role row and waits for its version row.
lock table tmpos_role.tenant_role_level in access exclusive mode;
lock table tmpos_role_edit.role_level_version in access exclusive mode;

-- Under READ COMMITTED the statements below see every row committed before the locks were granted (017's reason).
do $$
begin
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'migration 026 refused: it must run under READ COMMITTED, so that its checks see every committed row'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$$;

-- =============================================================================
-- 2) The schema
-- =============================================================================
create schema tmpos_role_invoice;

comment on schema tmpos_role_invoice is
  'Phase 4.0 M5 (migration 026): the owner''s Invoices level read-back and edit (authorization configuration only; no invoice table or route). Owned by this migration; tmpos_app holds USAGE and EXECUTE only.';

revoke all on schema tmpos_role_invoice from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
grant usage on schema tmpos_role_invoice to tmpos_app;

-- =============================================================================
-- 3) The two CHECKs, widened to the two domains the server resolves
-- =============================================================================
-- Same names, so 020's and 021's catalog entries keep their identity; the new definition is verified in section 6 and
-- restored exactly by the rollback. Every stored row is a 'customers' row, so the new constraint validates trivially.
alter table tmpos_role.tenant_role_level
  drop constraint tenant_role_level_domain_chk,
  add constraint tenant_role_level_domain_chk check (domain in ('customers', 'invoices'));
alter table tmpos_role_edit.role_level_version
  drop constraint role_level_version_domain_chk,
  add constraint role_level_version_domain_chk check (domain in ('customers', 'invoices'));

-- =============================================================================
-- 4) The routines
-- =============================================================================

-- 4a) The read-back: every editable role's stored Invoices level and version, on one snapshot.
create function tmpos_role_invoice.m7a_invoice_role_level_states(p_tenant_id uuid)
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
    raise exception 'migration 026 states: the argument is null'
      using errcode = 'invalid_parameter_value';
  end if;
  select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('roleId', r.role_id, 'level', l.level,
                                                            'version', coalesce(v.version, 0)) order by r.seq)
    into v_states
    from (values (1, 'manager'), (2, 'technician'), (3, 'sales_staff')) as r(seq, role_id)
    left join tmpos_role.tenant_role_level l
           on l.tenant_id = p_tenant_id and l.role_id = r.role_id and l.domain = 'invoices'
    left join tmpos_role_edit.role_level_version v
           on v.tenant_id = p_tenant_id and v.role_id = r.role_id and v.domain = 'invoices';
  return v_states;
end
$$;

comment on function tmpos_role_invoice.m7a_invoice_role_level_states(uuid) is
  'Phase 4.0 M5 (migration 026): one tenant''s editable roles'' Invoices levels, on one snapshot, as a jsonb array in the order manager, technician, sales_staff of {"roleId", "level" (the stored Invoices level, or null: none stored or a NULL lock row), "version" (the edit counter, or 0)}. Raises invalid_parameter_value for a null argument. Read-only. 021''s m7a_role_level_states with the domain fixed to invoices.';

-- 4b) The owner's Invoices edit, conditional on the tenant and the version the owner reviewed.
create function tmpos_role_invoice.m7a_invoice_role_level_set(p_session_key text, p_role_id text, p_level text,
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
  -- 0. The arguments, before any state is read: 021's (the domain is fixed, not an argument), and both preconditions present (a version is never negative).
  if p_session_key is null or p_session_key !~ '^[\x21-\x7e]{1,128}$'
     or p_role_id is null or p_role_id not in ('manager', 'technician', 'sales_staff')
     or p_level is null or p_level not in ('none', 'view', 'create', 'edit', 'manage', 'approve', 'full')
     or p_expected_tenant is null
     or p_expected_version is null or p_expected_version < 0 then
    raise exception 'migration 026 set: an argument is malformed'
      using errcode = 'invalid_parameter_value';
  end if;
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'migration 026 set: it must run under READ COMMITTED, so that its checks see what committed before its locks'
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
   where v.tenant_id = v_tenant and v.role_id = p_role_id and v.domain = 'invoices';
  if coalesce(v_version, 0) <> p_expected_version then
    return query select 'version_conflict'::text, null::uuid, null::uuid, null::uuid, null::text, null::bigint;
    return;
  end if;

  -- 8. 020's step 8: the role row, in the editor's tenant and no other, made to exist and held FOR UPDATE until COMMIT.
  insert into tmpos_role.tenant_role_level (tenant_id, role_id, domain, level, updated_at)
  values (v_tenant, p_role_id, 'invoices', null, pg_catalog.now())
  on conflict (tenant_id, role_id, domain) do nothing;
  perform 1 from tmpos_role.tenant_role_level l
   where l.tenant_id = v_tenant and l.role_id = p_role_id and l.domain = 'invoices'
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
   where v.tenant_id = v_tenant and v.role_id = p_role_id and v.domain = 'invoices'
     for update;
  if coalesce(v_version, 0) <> p_expected_version then
    return query select 'version_conflict'::text, null::uuid, null::uuid, null::uuid, null::text, null::bigint;
    return;
  end if;

  -- 10. The level (020's update). The version moves with it: 021's trigger fires at the end of this statement
  --     and advances it by one, as it does for every update of the row.
  update tmpos_role.tenant_role_level l
     set level = p_level, updated_at = pg_catalog.now()
   where l.tenant_id = v_tenant and l.role_id = p_role_id and l.domain = 'invoices';
  -- A change an owner's trigger suppressed is not an edit: raise, so the caller rolls back.
  if not found then
    raise exception 'migration 026 set: the level was not written'
      using errcode = 'no_data_found';
  end if;
  -- The version read back, on a snapshot taken after the trigger's upsert. Not the checked one's successor — the trigger
  -- disabled, dropped or doubled, which only the table's owner can do — is not an edit: raise, so the caller rolls back.
  v_next := null;
  select v.version into v_next
    from tmpos_role_edit.role_level_version v
   where v.tenant_id = v_tenant and v.role_id = p_role_id and v.domain = 'invoices';
  if v_next is distinct from p_expected_version + 1 then
    raise exception 'migration 026 set: the version was not advanced'
      using errcode = 'no_data_found';
  end if;

  return query select 'applied'::text, v_tenant, v_admission.actor_id, v_membership, p_level, v_next;
end
$$;

comment on function tmpos_role_invoice.m7a_invoice_role_level_set(text, text, text, uuid, bigint) is
  'Phase 4.0 M5 (migration 026): 021''s m7a_role_level_set_v2 with the domain fixed to invoices: for a key 020''s edit accepts (a live minted tenant session of a store owner holding exactly one tenant grant), answers ''tenant_mismatch'' (nothing written, no role row locked) when that grant''s tenant is not p_expected_tenant, ''version_conflict'' when the Invoices role''s edit counter (0 when none) is not p_expected_version — checked unlocked, then again under the role row FOR UPDATE — and otherwise sets the Invoices level, advances the counter by exactly one and answers ''applied'' with the tenant, actor, membership, level and new version. No row on any of 020''s refusals. Raises invalid_parameter_value (fixed message) for a malformed argument, object_not_in_prerequisite_state outside READ COMMITTED, no_data_found when the level was not written or the version not advanced by exactly one, and whatever 016''s hold or read raises. Never reads or writes a Customers row. Writes no audit record.';

-- =============================================================================
-- 5) Privileges, and the proof that nothing wider was issued
-- =============================================================================
-- PostgreSQL grants EXECUTE on a new function to PUBLIC by default, so every default is removed explicitly before the two
-- intended grants are issued.
revoke all on function tmpos_role_invoice.m7a_invoice_role_level_states(uuid) from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
revoke all on function tmpos_role_invoice.m7a_invoice_role_level_set(text, text, text, uuid, bigint) from public, anon, authenticated, tmpos_app, tmpos_audit_writer;

grant execute on function tmpos_role_invoice.m7a_invoice_role_level_states(uuid) to tmpos_app;
grant execute on function tmpos_role_invoice.m7a_invoice_role_level_set(text, text, text, uuid, bigint) to tmpos_app;

-- =============================================================================
-- 6) Postcondition
-- =============================================================================
-- Proven rather than asserted, in 021's form. This file refuses to finish unless, now:
--   (a) the schema holds exactly the two routines, and no relation, index, standalone type or trigger;
--   (b) both routines are plpgsql, SECURITY DEFINER, pinned to the search path above and run with row_security off — the
--       read STABLE, the edit VOLATILE — and the routines and the schema are owned by the applying principal;
--   (c) each routine carries no grant beyond its owner's and a non-grantable EXECUTE to tmpos_app;
--   (d) the schema carries no grant beyond its owner's and a non-grantable USAGE to tmpos_app;
--   (f) tmpos_app CAN execute the two, use the schema, and still execute 020's levels read and page_v3, 023's create (which
--       replaced 020's create as the login's one create, 023 having revoked that EXECUTE) and 021's read-back and edit; tmpos_audit_writer, anon and authenticated CANNOT execute any new routine by any path;
--   (g) none of the runtime roles is a MEMBER of the owner of the schema, a routine, either level table, or a table the edit
--       rests on (the session table, the mint ledger, the issuer key);
--   (h) neither a runtime role nor any role it is a member of HOLDS a privilege on either level table, no column grant
--       exists on either, and each is under row level security, not forced, with no policy;
--   (j) tmpos_app and tmpos_audit_writer are members of NOTHING;
--   (k) anon and authenticated reach neither tmpos_app nor tmpos_audit_writer by any membership;
--   (l) 020's table still carries exactly 021's one trigger, unchanged;
--   (m) both CHECKs are exactly check (domain in ('customers', 'invoices')) under their old names, validated, and are the
--       only check on the domain.
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
  if (select pg_catalog.count(*) from pg_catalog.pg_proc p where p.pronamespace = 'tmpos_role_invoice'::regnamespace) <> 2
     or pg_catalog.to_regprocedure('tmpos_role_invoice.m7a_invoice_role_level_states(uuid)') is null
     or pg_catalog.to_regprocedure('tmpos_role_invoice.m7a_invoice_role_level_set(text, text, text, uuid, bigint)') is null
     or exists (select 1 from pg_catalog.pg_class c where c.relnamespace = 'tmpos_role_invoice'::regnamespace)
     or exists (select 1 from pg_catalog.pg_type t
                 where t.typnamespace = 'tmpos_role_invoice'::regnamespace and t.typrelid = 0 and t.typelem = 0) then
    raise exception 'migration 026 refused: schema tmpos_role_invoice does not hold exactly the two routines this file creates'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (b)
  if (select pg_catalog.count(*)
        from pg_catalog.pg_proc p
        join pg_catalog.pg_language l on l.oid = p.prolang
       where p.pronamespace = 'tmpos_role_invoice'::regnamespace
         and l.lanname = 'plpgsql'
         and p.prosecdef
         and ((p.proname = 'm7a_invoice_role_level_states' and p.provolatile = 's')
              or (p.proname = 'm7a_invoice_role_level_set' and p.provolatile = 'v'))
         and p.prorettype <> 'pg_catalog.trigger'::regtype
         and p.proconfig = array['search_path=pg_catalog, pg_temp', 'row_security=off']
         and p.proowner = v_me) <> 2
     or not exists (select 1 from pg_catalog.pg_namespace n where n.oid = 'tmpos_role_invoice'::regnamespace and n.nspowner = v_me) then
    raise exception 'migration 026 refused: a routine in tmpos_role_invoice is not a plpgsql SECURITY DEFINER routine of the volatility this file gives it, pinned to pg_catalog, pg_temp with row_security off, owned with its schema by the applying principal'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (c)
  select pg_catalog.string_agg(pg_catalog.format('%s %s:%s', p.proname, g.grantee::regrole::text, g.privilege_type), ', ')
    into v_bad
    from pg_catalog.pg_proc p,
         pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g
   where p.pronamespace = 'tmpos_role_invoice'::regnamespace
     and g.grantee <> p.proowner
     and not (g.grantee = 'tmpos_app'::regrole and g.privilege_type = 'EXECUTE' and not g.is_grantable);
  if v_bad is not null then
    raise exception 'migration 026 refused: an unexpected direct grant remains on a tmpos_role_invoice routine (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if (select pg_catalog.count(*) from pg_catalog.pg_proc p,
             pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g
       where p.pronamespace = 'tmpos_role_invoice'::regnamespace
         and g.grantee = 'tmpos_app'::regrole and g.privilege_type = 'EXECUTE' and not g.is_grantable) <> 2 then
    raise exception 'migration 026 refused: tmpos_app does not hold a direct EXECUTE on each of the two tmpos_role_invoice routines'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (d)
  select pg_catalog.string_agg(pg_catalog.format('%s:%s', g.grantee::regrole::text, g.privilege_type), ', ')
    into v_bad
    from pg_catalog.pg_namespace n,
         pg_catalog.aclexplode(coalesce(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) g
   where n.oid = 'tmpos_role_invoice'::regnamespace
     and g.grantee <> n.nspowner
     and not (g.grantee = 'tmpos_app'::regrole and g.privilege_type = 'USAGE' and not g.is_grantable);
  if v_bad is not null then
    raise exception 'migration 026 refused: schema tmpos_role_invoice carries an unexpected grant (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (f)
  if not pg_catalog.has_function_privilege('tmpos_app', 'tmpos_role_invoice.m7a_invoice_role_level_states(uuid)'::regprocedure, 'EXECUTE')
     or not pg_catalog.has_function_privilege('tmpos_app',
              'tmpos_role_invoice.m7a_invoice_role_level_set(text, text, text, uuid, bigint)'::regprocedure, 'EXECUTE')
     or not pg_catalog.has_schema_privilege('tmpos_app', 'tmpos_role_invoice'::regnamespace, 'USAGE')
     or not pg_catalog.has_function_privilege('tmpos_app', 'tmpos_role_edit.m7a_role_level_states(uuid)'::regprocedure, 'EXECUTE')
     or not pg_catalog.has_function_privilege('tmpos_app',
              'tmpos_role_edit.m7a_role_level_set_v2(text, text, text, text, uuid, bigint)'::regprocedure, 'EXECUTE')
     or not pg_catalog.has_schema_privilege('tmpos_app', 'tmpos_role_edit'::regnamespace, 'USAGE')
     or not pg_catalog.has_function_privilege('tmpos_app', 'tmpos_role.m7a_role_levels(uuid, text)'::regprocedure, 'EXECUTE')
     or not pg_catalog.has_function_privilege('tmpos_app', 'tmpos_customer_contact.m7a_contact_create(text, uuid, text, text, text)'::regprocedure, 'EXECUTE')
     or not pg_catalog.has_function_privilege('tmpos_app', 'tmpos_role.m7a_customer_page_v3(text, uuid, integer)'::regprocedure, 'EXECUTE')
     or not pg_catalog.has_schema_privilege('tmpos_app', 'tmpos_role'::regnamespace, 'USAGE') then
    raise exception 'migration 026 refused: tmpos_app does not hold EXECUTE on the two routines and USAGE on schema tmpos_role_invoice, or no longer holds 020''s levels read and page_v3, 023''s create and 021''s read-back and edit'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  select pg_catalog.string_agg(distinct pg_catalog.format('%s: %s', r.rolname, p.oid::regprocedure), ', ') into v_bad
    from pg_catalog.pg_roles r
    join pg_catalog.pg_roles x on pg_catalog.pg_has_role(r.oid, x.oid, 'MEMBER')
    cross join pg_catalog.pg_proc p
   where p.pronamespace = 'tmpos_role_invoice'::regnamespace
     and r.rolname = any (array['tmpos_audit_writer', 'anon', 'authenticated']::name[])
     and pg_catalog.has_function_privilege(x.oid, p.oid, 'EXECUTE');
  if v_bad is not null then
    raise exception 'migration 026 refused: a runtime role other than tmpos_app can execute a tmpos_role_invoice routine (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (g)
  select pg_catalog.string_agg(distinct r.rolname::text, ', ') into v_bad
    from pg_catalog.pg_roles r
    cross join (
      select n.nspowner as owner from pg_catalog.pg_namespace n where n.nspname = 'tmpos_role_invoice'
      union
      select p.proowner from pg_catalog.pg_proc p where p.pronamespace = 'tmpos_role_invoice'::regnamespace
      union
      select c.relowner from pg_catalog.pg_class c
       where c.oid in ('tmpos_role_edit.role_level_version'::regclass, 'tmpos_role.tenant_role_level'::regclass,
                       'tmpos_session.session'::regclass, 'tmpos_mint.tenant_session'::regclass,
                       'tmpos_mint.issuer_key'::regclass)
    ) o
   where r.rolname = any (array['tmpos_app', 'tmpos_audit_writer', 'anon', 'authenticated']::name[])
     and pg_catalog.pg_has_role(r.oid, o.owner, 'MEMBER');
  if v_bad is not null then
    raise exception 'migration 026 refused: % is a member of the owner of schema tmpos_role_invoice, a routine in it, or a table its edit rests on', v_bad
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
    raise exception 'migration 026 refused: % holds an effective privilege on the version table or the role table', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if exists (select 1 from pg_catalog.pg_attribute a, pg_catalog.aclexplode(a.attacl) g
              where a.attrelid in ('tmpos_role_edit.role_level_version'::regclass, 'tmpos_role.tenant_role_level'::regclass)
                and a.attnum > 0 and not a.attisdropped) then
    raise exception 'migration 026 refused: a column grant exists on the version table or the role table'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if exists (select 1 from pg_catalog.pg_class c
              where c.oid in ('tmpos_role_edit.role_level_version'::regclass, 'tmpos_role.tenant_role_level'::regclass)
                and (not c.relrowsecurity or c.relforcerowsecurity))
     or exists (select 1 from pg_catalog.pg_policy p
                 where p.polrelid in ('tmpos_role_edit.role_level_version'::regclass, 'tmpos_role.tenant_role_level'::regclass)) then
    raise exception 'migration 026 refused: row level security is not enabled (unforced) on the version table or the role table, or a policy exists on one'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (j)
  select pg_catalog.string_agg(pg_catalog.format('%s in %s', m.member::regrole, m.roleid::regrole), ', '
                               order by m.member, m.roleid) into v_bad
    from pg_catalog.pg_auth_members m
    join pg_catalog.pg_roles r on r.oid = m.member
   where r.rolname = any (array['tmpos_app', 'tmpos_audit_writer']::name[]);
  if v_bad is not null then
    raise exception 'migration 026 refused: tmpos_app and tmpos_audit_writer must be members of nothing (%)', v_bad
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
    raise exception 'migration 026 refused: anon and authenticated must reach neither tmpos_app nor tmpos_audit_writer by membership (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (l) 021's trigger, exactly as 021 left it. tgtype: ROW 1 + UPDATE 16 = 17.
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
    raise exception 'migration 026 refused: tmpos_role.tenant_role_level does not carry exactly 021''s one version trigger'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (m) The widened CHECKs: exactly these, validated, and no other check mentions the domain.
  if (select pg_catalog.count(*) from pg_catalog.pg_constraint k
       where k.conrelid = 'tmpos_role.tenant_role_level'::regclass and k.contype = 'c'
         and k.conname = 'tenant_role_level_domain_chk' and k.convalidated
         and pg_catalog.pg_get_constraintdef(k.oid) = 'CHECK ((domain = ANY (ARRAY[''customers''::text, ''invoices''::text])))') <> 1
     or (select pg_catalog.count(*) from pg_catalog.pg_constraint k
          where k.conrelid = 'tmpos_role_edit.role_level_version'::regclass and k.contype = 'c'
            and k.conname = 'role_level_version_domain_chk' and k.convalidated
            and pg_catalog.pg_get_constraintdef(k.oid) = 'CHECK ((domain = ANY (ARRAY[''customers''::text, ''invoices''::text])))') <> 1
     or (select pg_catalog.count(*) from pg_catalog.pg_constraint k
          where k.conrelid in ('tmpos_role.tenant_role_level'::regclass, 'tmpos_role_edit.role_level_version'::regclass)
            and k.contype = 'c' and pg_catalog.pg_get_constraintdef(k.oid) like '%domain%') <> 2 then
    raise exception 'migration 026 refused: the domain CHECKs are not exactly check (domain in (''customers'', ''invoices'')) under their old names'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$$;

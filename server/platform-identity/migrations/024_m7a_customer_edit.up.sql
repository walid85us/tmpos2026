-- Phase 4.0 M7a — editing a saved customer: a row version on each server customer, one session-bound edit of its name,
-- phone and email decided at Customers Edit under the established locking order, one session-bound profile read that
-- answers the version with the values from one snapshot, and a typed audit subject naming the edited customer
-- (M7A-CUSTOMERS-P7; G-IAM, G-DBROLE, G-AUDIT, G-PRIVACY; docs/phase-4/10)
-- Migration: 024_m7a_customer_edit (UP)
--
-- SCOPE / TRUTH (binding):
--   - ONE NEW COLUMN AND ONE CHECK ON 017'S TABLE, ONE NEW COLUMN AND ONE PARTIAL INDEX ON 002'S AUDIT TABLE, ONE NEW
--     SCHEMA, TWO ROUTINES, THREE GRANTS, ONE REVOKED GRANT, NO TABLE, NO ROLE, NO TRIGGER, NO TYPE. This file adds to
--     tmpos_customer.customer the column row_version (bigint, not null, default 1) with the CHECK customer_row_version_chk;
--     adds to public.audit_event the nullable column subject_customer_id with the index
--     idx_audit_event_subject_customer_occurred; creates schema tmpos_customer_edit and in it the two routines tmpos_app may
--     execute: m7a_customer_update (PATCH /api/v1/customers/{id}) and m7a_customer_profile (GET
--     /api/v1/customers/{id}/profile, now with the version); and revokes tmpos_app's EXECUTE on 023's
--     tmpos_customer_contact.m7a_contact_profile, so the runtime's one profile path is this file's (023's own precedent with
--     020's create). Those are its only effects on objects earlier migrations created: 001-023 stay byte for byte as
--     committed (the migration-files contract's pinned checksums prove that), and tmpos_app gains no privilege on 017's
--     table, its columns, 017's page, 020's create or 023's profile read.
--   - THE VERSION. row_version is added with a CONSTANT default, which PostgreSQL stores once in the catalog: no row is
--     rewritten, every existing row reads 1, and every row inserted afterwards (020's three-column insert, 023's create)
--     starts at 1. Its bound is 008's: 1 to 9007199254740991 (the largest integer a JavaScript number holds exactly), and the
--     edit refuses an expected version above 9007199254740990, so the next version is always inside the CHECK and never
--     wraps or restarts. ONLY THE EDIT ROUTINE MOVES IT, by exactly one, in the same statement that writes the new values.
--     There is deliberately NO trigger (008's tenant version has one): 023's create writes the contacts onto the row 020
--     just inserted, in the same transaction and inside a subtransaction, so a "+1 on any change" trigger would start
--     every contact-bearing customer at 2; and an owner's raw UPDATE of the table is the owner's (stated residual below).
--     created_at, ids, tenants, names, phones and emails of existing rows are untouched: no statement here writes a row
--     (tests/db/customerEdit.integration.test.mjs proves every tuple unchanged).
--   - THE EDIT'S ONLY AUTHORITY ARGUMENT IS THE SESSION KEY, AND ITS DECISION IS 020'S, AT EDIT. m7a_customer_update first
--     judges every argument — the key's shape, the id, the expected tenant, the expected version (1-9007199254740990), the
--     name by 017's CHECK, each contact by 023's CHECK and its set flag (a contact that is not being set must be NULL; one
--     being set is NULL to clear it or a value the CHECK admits) — raising invalid_parameter_value with a fixed message
--     naming the field, never the value, before anything is read, locked or written. It then derives the caller exactly as
--     020's tmpos_role.m7a_customer_create does (the steps are restated below, with 020's line ranges: 020 is frozen and its
--     create inserts, so it cannot be called): an unlocked live/issuer pre-check; 016's hold; the session and its mint
--     ledger row FOR SHARE; the issuer key FOR SHARE; the database clock; the standing digest minted; an account status and
--     a tenant status in ('active', 'trialing'); EXACTLY ONE tenant-scope grant. The tenant that grant names must equal
--     p_expected_tenant (the runtime's trusted context; a precondition only, 022's and 021's rule), else no row, before any
--     role row is made to exist. Then the role's effective Customers level — store_owner Full; manager, technician and
--     sales_staff the owner's stored level (020's tmpos_role.tenant_role_level), read unlocked, then made to exist (NULL,
--     the default) and held FOR SHARE and decided on the locked value; any other role refuses — must be EDIT or above
--     (020 decides Create; the catalog's Customers defaults are manager full, technician view, sales_staff create). Every
--     authority refusal answers NO ROW and writes nothing (at most the NULL lock row 020 also leaves; the runtime rolls a
--     refusal back).
--   - THE ROW, AND THE ORDER OF ITS JUDGEMENTS. Only after every authority lock: the customer row of exactly that id in
--     exactly the derived tenant, FOR UPDATE. A missing id and another tenant's id answer the same ('not_found', nulls).
--     The clock is read once more after that wait: a session that expired while waiting answers no row, never a conflict.
--     The stored version is compared with the expected one FIRST: a different one answers ('conflict', nulls) and writes
--     nothing — so a stale no-op conflicts too. Then the targets: the name as sent; each contact as sent when its flag is
--     set, else as stored. All three equal to the stored values (IS NOT DISTINCT FROM) answers ('unchanged', tenant, actor,
--     membership, the expected version) and writes nothing; the row stays locked until the caller's transaction ends.
--     Otherwise one UPDATE writes the three values and row_version = expected + 1, requiring exactly one row and that
--     version read back, and answers ('applied', tenant, actor, membership, expected + 1). created_at, the id and the
--     tenant are never written. Two edits of one version therefore cannot both apply: the second waits on the row lock
--     (or, for one actor, on 016's hold), re-reads the committed row under READ COMMITTED, and conflicts.
--   - THE PROFILE READ ANSWERS VALUES AND VERSION FROM ONE SNAPSHOT. m7a_customer_profile calls 023's
--     tmpos_customer_contact.m7a_contact_profile as its owner — 022's whole decision (the session, its standing, exactly
--     one tenant grant, the role's level at View, 017's rechecks, p_expected_tenant) and the contact read — passes every
--     refusal through with a NULL version, and on 'customer' reads that id's row_version filtered to the tenant 023
--     answered. All three are STABLE, so every read is on the calling statement's one snapshot: a concurrently committed
--     edit can never pair old values with a new version or new values with an old one. Always exactly ONE row. It locks
--     nothing and writes nothing; its access policy is 023's (View), unchanged.
--   - THE AUDIT SUBJECT. A customer edit's audit record names the customer it changed in its own typed column, as 009's
--     subject_tenant_id names a tenant: public.audit_event.subject_customer_id, a plain nullable uuid with no default and no
--     foreign key (002: the audit table is decoupled and append-only), written only by the runtime's command transaction
--     from the command's server-validated target. Adding it rewrites no row and fires no row trigger; 002's append-only
--     trigger stays as it is. The audit writer's table-wide INSERT (005) covers it and nothing else is granted (009's
--     rule): no column grant exists on the table. Never a name, a phone or an email: the record carries none.
--   - WHAT THEY DO NOT DO. Neither routine writes an audit record, an outbox event or an idempotency completion: the
--     runtime's command transaction appends the edit's audit record and completion around it in one transaction, and the
--     read writes none. No message, hint or detail either raises carries a name or a contact.
--   - WHAT THIS DOES NOT DEFEND (doc 08; none of it is claimed closed). 020's create residuals and 022's/023's read
--     residuals stand for these routines, and:
--       * a holder of tmpos_app plus a live minted key whose role meets Edit calls m7a_customer_update directly and edits
--         customers in that key's tenant with NO audit, idempotency or outbox record — customer edits are audited ONLY
--         through the HTTP route (G-AUDIT exception, as 020's create);
--       * LOCK HOLDING (020's class): such a holder keeps the role row FOR SHARE and the customer row FOR UPDATE for as
--         long as it keeps its transaction open, so an owner's level edit of that role, and every other edit of that
--         customer, waits until its lock or statement timeout (503) — availability only;
--       * the table owner's raw UPDATE of the table moves no version: an owner who rewrites a customer by hand leaves an
--         editor's version current (021's owner-only class); the runtime role holds no privilege on the table;
--       * a database log that captures bind parameters exposes session keys, names and contacts (G-DBROLE, G-PRIVACY);
--       * the rollback order is not enforced by the database: 023's, 022's or 020's rollback run while this file is
--         applied fails on its own postconditions or leaves these routines raising at call — failing closed (503) —
--         and this file's rollback refuses until 023 is applied again. The supported order: 024, then 023, 022, 021, 020.
--   - DEPLOY AND ROLLBACK MOVE WITH THE RUNTIME. The P7 runtime's startup preflight pins exactly 001-024 and these grants
--     (and no longer 023's profile read), and the previous build refuses a 024 database (its approved grants hold 023's
--     profile read and lack these). The rollback REFUSES while any customer has been edited (row_version above 1) or any
--     audit record names a customer: dropping the version and re-applying would restart every row at 1, so an editor
--     holding an old version could match again and overwrite a newer change; and dropping the subject column would erase
--     audit evidence. Resetting versions or removing evidence is a deliberate owner decision, never a rollback's side
--     effect. The rollback drops no name, phone, email or creation time.
--   - NO SECRET, NO DYNAMIC SQL, NO EXTENSION, NO TEMPORARY OBJECT. Every statement is fixed text, every value a
--     parameter, every relation and routine schema-qualified; every routine pins its search_path to pg_catalog then
--     pg_temp and runs with row_security off, so were row security ever FORCEd on a table it reads or writes it fails
--     (503) instead of silently refusing. Altering the two tables takes ACCESS EXCLUSIVE on each for the apply's duration;
--     neither is rewritten (a constant default, a nullable column), the CHECK scans the customer table once and the
--     partial index builds over the audit table once.
--
-- Reversible via 024_m7a_customer_edit.down.sql, which refuses while any customer's row_version is above 1 or any audit
-- record names a customer, and otherwise removes exactly what this file created and gives tmpos_app back EXECUTE on 023's
-- profile read. Roll 024 back before 023.
--
-- Assumes 001-023 are applied. A future managed apply targets the complete contiguous chain through the newest committed
-- migration — now 001-024 (owner decision D4); this file authorizes no apply.

-- =============================================================================
-- 0) This transaction's search path
-- =============================================================================
set local search_path = pg_catalog, pg_temp;

-- =============================================================================
-- 1) Preconditions: what this file builds on
-- =============================================================================
do $$
begin
  -- The chain is contiguous: 023 is the newest migration this file sits on.
  if pg_catalog.to_regprocedure('tmpos_customer_contact.m7a_contact_profile(text, uuid, uuid)') is null
     or pg_catalog.to_regprocedure('tmpos_customer_contact.m7a_contact_create(text, uuid, text, text, text)') is null then
    raise exception 'migration 024 refused: migration 023 must be applied first'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- The objects the routines restate or delegate to, and the tables this file alters.
  if pg_catalog.to_regprocedure('tmpos_role.m7a_customer_create(text, uuid, text)') is null
     or pg_catalog.to_regprocedure('tmpos_customer_detail.m7a_customer_get(text, uuid, uuid)') is null
     or pg_catalog.to_regprocedure('tmpos_session.m5_hold_tenant_standing(text, text)') is null
     or pg_catalog.to_regprocedure('tmpos_session.m5_admit_tenant_session_v2(text, text)') is null
     or pg_catalog.to_regclass('tmpos_role.tenant_role_level') is null
     or pg_catalog.to_regclass('tmpos_customer.customer') is null
     or pg_catalog.to_regclass('public.audit_event') is null then
    raise exception 'migration 024 refused: migration 016''s hold or admission read, 017''s customer table, 020''s create or levels, 022''s read or 002''s audit table is missing'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if (select pg_catalog.count(*) from pg_catalog.pg_attribute a
       where a.attrelid = 'tmpos_customer.customer'::regclass
         and a.attname in ('phone', 'email', 'created_at') and not a.attisdropped) <> 3
     or (select pg_catalog.count(*) from pg_catalog.pg_constraint c
          where c.conrelid = 'tmpos_customer.customer'::regclass
            and c.conname in ('customer_name_chk', 'customer_phone_chk', 'customer_email_chk')) <> 3 then
    raise exception 'migration 024 refused: tmpos_customer.customer does not carry 023''s phone, email and created_at columns and 017''s and 023''s CHECKs'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if not exists (select 1 from pg_catalog.pg_attribute a
                  where a.attrelid = 'public.audit_event'::regclass and a.attname = 'subject_tenant_id' and not a.attisdropped) then
    raise exception 'migration 024 refused: public.audit_event has no subject_tenant_id (migration 009 must be applied first)'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- The runtime roles this file grants to and revokes from.
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'tmpos_app')
     or not exists (select 1 from pg_catalog.pg_roles where rolname = 'tmpos_audit_writer') then
    raise exception 'migration 024 refused: migration 005 must be applied first'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- Nothing of this file exists yet: it is applied once, over a chain that has never held it.
  if pg_catalog.to_regnamespace('tmpos_customer_edit') is not null then
    raise exception 'migration 024 refused: schema tmpos_customer_edit already exists'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if exists (select 1 from pg_catalog.pg_attribute a
              where a.attrelid = 'tmpos_customer.customer'::regclass and a.attname = 'row_version' and not a.attisdropped)
     or exists (select 1 from pg_catalog.pg_attribute a
                 where a.attrelid = 'public.audit_event'::regclass and a.attname = 'subject_customer_id' and not a.attisdropped)
     or pg_catalog.to_regclass('public.idx_audit_event_subject_customer_occurred') is not null then
    raise exception 'migration 024 refused: tmpos_customer.customer already has a row_version column, or public.audit_event a subject_customer_id column or its index'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- The definers call 016's hold and admission read and 023's profile read as their owner, the principal applying this file.
  if not (pg_catalog.has_function_privilege(current_user, 'tmpos_session.m5_hold_tenant_standing(text, text)', 'EXECUTE')
          and pg_catalog.has_function_privilege(current_user, 'tmpos_session.m5_admit_tenant_session_v2(text, text)', 'EXECUTE')
          and pg_catalog.has_function_privilege(current_user, 'tmpos_customer_contact.m7a_contact_profile(text, uuid, uuid)', 'EXECUTE')
          and pg_catalog.has_schema_privilege(current_user, 'tmpos_session', 'USAGE')
          and pg_catalog.has_schema_privilege(current_user, 'tmpos_mint', 'USAGE')
          and pg_catalog.has_schema_privilege(current_user, 'tmpos_role', 'USAGE')
          and pg_catalog.has_schema_privilege(current_user, 'tmpos_customer', 'USAGE')
          and pg_catalog.has_schema_privilege(current_user, 'tmpos_customer_contact', 'USAGE')) then
    raise exception 'migration 024 refused: the applying principal cannot execute 016''s hold and admission read and 023''s profile read, which the definers call'
      using errcode = 'insufficient_privilege';
  end if;
  -- Altering the tables needs their owner's privileges, and a SECURITY DEFINER routine reads and writes only what its
  -- OWNER may (017's argument): were the applying principal neither the owner of these tables nor a role inheriting that
  -- owner's privileges — or row security FORCEd on one — the alter would fail, or the routines would find no session and
  -- refuse everything, or fail on a write.
  if exists (
    select 1
      from pg_catalog.pg_class c
     where c.oid = any (array['tmpos_session.session'::regclass, 'tmpos_mint.tenant_session'::regclass,
                              'tmpos_mint.issuer_key'::regclass, 'tmpos_role.tenant_role_level'::regclass,
                              'tmpos_customer.customer'::regclass, 'public.audit_event'::regclass])
       and (not pg_catalog.pg_has_role(current_user, c.relowner, 'USAGE') or c.relforcerowsecurity)) then
    raise exception 'migration 024 refused: the applying principal neither owns nor inherits the owner of the session table, the mint ledger, the issuer key, the role levels, tmpos_customer.customer and public.audit_event, or one has forced row security'
      using errcode = 'insufficient_privilege';
  end if;
  -- Each privilege stated, one at a time (019's reason): SELECT and UPDATE on every row the edit locks, INSERT on the
  -- role levels (020's lock row), UPDATE on the customer table.
  if not (pg_catalog.has_table_privilege(current_user, 'tmpos_session.session', 'SELECT')
          and pg_catalog.has_table_privilege(current_user, 'tmpos_session.session', 'UPDATE')
          and pg_catalog.has_table_privilege(current_user, 'tmpos_mint.tenant_session', 'SELECT')
          and pg_catalog.has_table_privilege(current_user, 'tmpos_mint.tenant_session', 'UPDATE')
          and pg_catalog.has_table_privilege(current_user, 'tmpos_mint.issuer_key', 'SELECT')
          and pg_catalog.has_table_privilege(current_user, 'tmpos_mint.issuer_key', 'UPDATE')
          and pg_catalog.has_table_privilege(current_user, 'tmpos_role.tenant_role_level', 'SELECT')
          and pg_catalog.has_table_privilege(current_user, 'tmpos_role.tenant_role_level', 'INSERT')
          and pg_catalog.has_table_privilege(current_user, 'tmpos_role.tenant_role_level', 'UPDATE')
          and pg_catalog.has_table_privilege(current_user, 'tmpos_customer.customer', 'SELECT')
          and pg_catalog.has_table_privilege(current_user, 'tmpos_customer.customer', 'UPDATE')) then
    raise exception 'migration 024 refused: the applying principal lacks SELECT or UPDATE on the session table, the mint ledger, the issuer key, the role levels or tmpos_customer.customer, or INSERT on the role levels'
      using errcode = 'insufficient_privilege';
  end if;
end
$$;

-- =============================================================================
-- 2) The version column
-- =============================================================================
-- A constant default: stored once in the catalog, so no row is rewritten and every existing row reads 1 (008's form).
alter table tmpos_customer.customer
  add column row_version bigint not null default 1
    constraint customer_row_version_chk check (row_version between 1 and 9007199254740991);

comment on column tmpos_customer.customer.row_version is
  'Phase 4.0 M7a (migration 024): the customer''s edit version — 1 when created (and for every customer that existed when migration 024 applied), moved only by tmpos_customer_edit.m7a_customer_update, by exactly one per applied edit; never by a no-op. Bounded by 9007199254740991. No runtime role may read or set it directly.';

-- =============================================================================
-- 3) The audit record's customer subject (009's subject_tenant_id, for a customer)
-- =============================================================================
-- Adding a nullable column with no default rewrites no row, and fires no row trigger — 002's append-only trigger stays
-- exactly as it is. The audit writer's table-wide INSERT (005) covers it; nothing else is granted.
alter table public.audit_event add column subject_customer_id uuid;

comment on column public.audit_event.subject_customer_id is
  'Phase 4.0 M7a (migration 024): the customer the recorded action targeted (a customer edit). Written by the command transaction from the command''s server-validated target; never from request metadata. Plain column, no FK (audit is decoupled/append-only). Never accompanied by a name, phone or email.';

create index idx_audit_event_subject_customer_occurred on public.audit_event (subject_customer_id, occurred_at desc)
  where subject_customer_id is not null;

-- =============================================================================
-- 4) The schema
-- =============================================================================
create schema tmpos_customer_edit;

comment on schema tmpos_customer_edit is
  'Phase 4.0 M7a (migration 024): customer edits — the session-bound edit and the versioned profile read PATCH /api/v1/customers/{id} and GET /api/v1/customers/{id}/profile go through. Owned by this migration; tmpos_app holds USAGE and EXECUTE only.';

revoke all on schema tmpos_customer_edit from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
grant usage on schema tmpos_customer_edit to tmpos_app;

-- =============================================================================
-- 5) The routines
-- =============================================================================

-- 5a) The edit: every argument judged; 020's derivation of the caller, at Edit; the row, its version, then the values.
create function tmpos_customer_edit.m7a_customer_update(
  p_session_key text, p_customer_id uuid, p_expected_tenant uuid, p_expected_version bigint,
  p_name text, p_set_phone boolean, p_phone text, p_set_email boolean, p_email text)
returns table (
  o_outcome       text,
  o_tenant_id     uuid,
  o_actor_id      uuid,
  o_membership_id uuid,
  o_version       bigint
)
language plpgsql
-- VOLATILE IS LOAD-BEARING (019's and 020's reason): it locks and then re-reads, and each statement must see what
-- committed before its own locks. Do not make it STABLE.
volatile
security definer
set search_path = pg_catalog, pg_temp
set row_security = off
as $$
declare
  -- The tenant ordering (permissionCatalog.ts TENANT_ORDERING), 020's constant, pinned by the parity test.
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
  v_row            record;
  v_phone          text;
  v_email          text;
  v_updated        integer;
  v_written        bigint;
begin
  -- 0. Every argument, before anything is read, locked or written. A refusal names the field, never the value.
  if p_session_key is null or p_session_key !~ '^[\x21-\x7e]{1,128}$'
     or p_customer_id is null
     or p_expected_tenant is null
     or p_set_phone is null
     or p_set_email is null then
    raise exception 'migration 024 update: an argument is malformed'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_expected_version is null or p_expected_version < 1 or p_expected_version > 9007199254740990 then
    raise exception 'migration 024 update: the expected version is not one the customer table can advance'
      using errcode = 'invalid_parameter_value';
  end if;
  -- The name: required (never cleared), and one 017's customer_name_chk admits.
  if p_name is null or not (
       pg_catalog.char_length(p_name) between 1 and 200
       and p_name !~ '[\u0001-\u001f\u007f-\u009f\u2028\u2029]'
       and p_name !~ '[\u061c\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069]'
       and p_name !~ '^[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]|[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]$') then
    raise exception 'migration 024 update: the name is not one the customer table admits'
      using errcode = 'invalid_parameter_value';
  end if;
  -- Each contact: not being set, it must be NULL (nothing is sent for it); being set, NULL clears it, and anything else
  -- must be a value 023's CHECK admits (023's own in-routine judgement, restated).
  if (not p_set_phone and p_phone is not null) or (p_phone is not null and not (
       pg_catalog.char_length(p_phone) between 1 and 64
       and p_phone !~ '[\u0001-\u001f\u007f-\u009f\u2028\u2029]'
       and p_phone !~ '[\u061c\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069]'
       and p_phone !~ '^[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]|[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]$'
       and p_phone ~ '[0-9]')) then
    raise exception 'migration 024 update: the phone is not one the customer table admits'
      using errcode = 'invalid_parameter_value';
  end if;
  if (not p_set_email and p_email is not null) or (p_email is not null and not (
       pg_catalog.char_length(p_email) between 1 and 254
       and p_email !~ '[\u0001-\u001f\u007f-\u009f\u2028\u2029]'
       and p_email !~ '[\u061c\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069]'
       and p_email !~ '^[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]|[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]$'
       and p_email !~ '[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]'
       and p_email ~ '^[^@]+@[^@]+$')) then
    raise exception 'migration 024 update: the email is not one the customer table admits'
      using errcode = 'invalid_parameter_value';
  end if;
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'migration 024 update: it must run under READ COMMITTED, so that its checks see what committed before its locks'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- 1-6. The caller, derived exactly as 020's create derives it (020 up, lines 472-528; see there and 019 for each step's
  --      reason): the unlocked live/issuer pre-check, 016's hold, the session and ledger rows FOR SHARE, the issuer key FOR
  --      SHARE, the clock after those waits, and the standing digest the session was minted under.
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

  -- 7. Exactly one tenant-scope grant, on a tenant whose status is a write status (020 up, lines 530-544).
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

  -- 7b. The runtime's trusted tenant, a precondition only (021's and 022's rule): a session of another tenant refuses here,
  --     before any role row is made to exist or any customer is read.
  if v_tenant is distinct from p_expected_tenant then
    return;
  end if;

  -- 8. The role's effective Customers level must meet EDIT (020 up, lines 546-584, with 'edit' in place of 'create').
  --    store_owner is Full (never stored); an editable role is its stored level, else its catalog default; any other
  --    role refuses.
  if v_role = 'store_owner' then
    null;
  elsif v_role in ('manager', 'technician', 'sales_staff') then
    -- (a) Unlocked: a level already below Edit refuses here, having written no role row and locked none.
    select l.level into v_level
      from tmpos_role.tenant_role_level l
     where l.tenant_id = v_tenant and l.role_id = v_role and l.domain = 'customers';
    if coalesce(pg_catalog.array_position(c_levels,
         coalesce(v_level, case v_role when 'manager' then 'full' when 'technician' then 'view' when 'sales_staff' then 'create' end)), 0)
       < pg_catalog.array_position(c_levels, 'edit') then
      return;
    end if;
    -- (b) The row made to exist (NULL: the default), so there is always one row to order on.
    insert into tmpos_role.tenant_role_level (tenant_id, role_id, domain, level, updated_at)
    values (v_tenant, v_role, 'customers', null, pg_catalog.now())
    on conflict (tenant_id, role_id, domain) do nothing;
    -- (c) Held FOR SHARE until COMMIT: an owner's level edit holding it FOR UPDATE is waited for, and its committed level
    --     is what this statement reads; one attempted later waits for this transaction. A row gone by now refuses.
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
       < pg_catalog.array_position(c_levels, 'edit') then
      return;
    end if;
  else
    return;
  end if;

  -- 9. Live, on the database clock read again now: step 8 may have waited (020 up, lines 586-591).
  v_now := pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp()) * 1000)::bigint;
  if v_now >= v_session.expires_at then
    return;
  end if;

  -- 10. The row, of exactly this id in exactly the derived tenant, locked for the edit — after every authority lock. A
  --     missing id and another tenant's id are the same answer.
  select c.name, c.phone, c.email, c.row_version
    into v_row
    from tmpos_customer.customer c
   where c.customer_id = p_customer_id
     and c.tenant_id = v_tenant
     for update;
  if not found then
    return query select 'not_found'::text, null::uuid, null::uuid, null::uuid, null::bigint;
    return;
  end if;

  -- 11. Live once more: the row lock may have waited (another edit of this customer), and a session that expired while
  --     waiting refuses — never a conflict.
  v_now := pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp()) * 1000)::bigint;
  if v_now >= v_session.expires_at then
    return;
  end if;

  -- 12. The version, before the values: a stale editor conflicts even when its values equal the stored ones.
  if v_row.row_version is distinct from p_expected_version then
    return query select 'conflict'::text, null::uuid, null::uuid, null::uuid, null::bigint;
    return;
  end if;

  -- 13. The targets. All equal to what is stored: nothing is written, and the version stays.
  v_phone := case when p_set_phone then p_phone else v_row.phone end;
  v_email := case when p_set_email then p_email else v_row.email end;
  if p_name is not distinct from v_row.name and v_phone is not distinct from v_row.phone
     and v_email is not distinct from v_row.email then
    return query select 'unchanged'::text, v_tenant, v_admission.actor_id, v_membership, p_expected_version;
    return;
  end if;

  -- 14. The edit: the three values and the next version, in one statement, on exactly the locked row. created_at, the id
  --     and the tenant are never written. The CHECKs restate step 0, so they cannot refuse; were they ever to, the raise
  --     is fixed text, never the row.
  begin
    update tmpos_customer.customer c
       set name = p_name, phone = v_phone, email = v_email, row_version = p_expected_version + 1
     where c.customer_id = p_customer_id
       and c.tenant_id = v_tenant
       and c.row_version = p_expected_version
    returning c.row_version into v_written;
    get diagnostics v_updated = row_count;
  exception
    when check_violation then
      raise exception 'migration 024 update: a value is not one the customer table admits'
        using errcode = 'check_violation';
  end;
  if v_updated <> 1 or v_written is distinct from p_expected_version + 1 then
    raise exception 'migration 024 update: the edit was not written to exactly the locked customer at the next version'
      using errcode = 'no_data_found';
  end if;

  return query select 'applied'::text, v_tenant, v_admission.actor_id, v_membership, v_written;
end
$$;

comment on function tmpos_customer_edit.m7a_customer_update(text, uuid, uuid, bigint, text, boolean, text, boolean, text) is
  'Phase 4.0 M7a (migration 024): edits one customer''s name, phone and email at an expected version, for a key naming a ledger-minted, live (database clock, read after every lock wait) tenant session minted under the installed issuer key, after 016''s hold and the session, ledger and issuer key rows, whose standing digest is unchanged, whose account and tenant status are active or trialing, who holds exactly one tenant grant — on the expected tenant — and whose role''s Customers level (store_owner full; manager, technician, sales_staff the owner''s stored level, read unlocked and then FOR SHARE, else the catalog default) is Edit or above. Judges every argument first (invalid_parameter_value, a fixed message naming the field, never the value). Then locks the customer of that id in that tenant: ''not_found'' alike for a missing and a foreign id; ''conflict'' when its version is not the expected one (before any value is compared); ''unchanged'' with the expected version when every target equals the stored value (nothing written); else writes the values and expected version + 1 and answers ''applied'' with the tenant, actor, membership and new version. Any authority refusal: no row. created_at is never written. Writes no audit record.';

-- 5b) The profile read: 023's read whole, then the version of the one row it answered, on the same snapshot.
create function tmpos_customer_edit.m7a_customer_profile(p_session_key text, p_customer_id uuid, p_expected_tenant uuid)
returns table (
  o_outcome     text,
  o_tenant_id   uuid,
  o_customer_id uuid,
  o_name        text,
  o_phone       text,
  o_email       text,
  o_created_at  text,
  o_version     bigint
)
language plpgsql
-- STABLE IS LOAD-BEARING (017's, 022's and 023's reason): 023's read and the version read below run on the calling
-- statement's snapshot, so the values and the version answered are one row's at one instant. It locks nothing and can
-- write nothing.
stable
security definer
set search_path = pg_catalog, pg_temp
set row_security = off
as $$
declare
  v_profile record;
  v_version bigint;
begin
  -- 1. 023's read, whole: 022's decision (the session, its standing, exactly one tenant grant, the role's current level at
  --    View, 017's rechecks, p_expected_tenant as a precondition) and the contact read. Exactly one row, always.
  select f.o_outcome, f.o_tenant_id, f.o_customer_id, f.o_name, f.o_phone, f.o_email, f.o_created_at
    into v_profile
    from tmpos_customer_contact.m7a_contact_profile(p_session_key, p_customer_id, p_expected_tenant) f;
  if not found then
    raise exception 'migration 024 profile: migration 023''s read answered no row'
      using errcode = 'cardinality_violation';
  end if;
  -- Every refusal passes through as 023 answered it, with no version: 'not_found' alike for a missing and a foreign id,
  -- 'denied', 'invalid'. No version is read.
  if v_profile.o_outcome is distinct from 'customer' then
    return query select v_profile.o_outcome, null::uuid, null::uuid, null::text, null::text, null::text, null::text, null::bigint;
    return;
  end if;

  -- 2. The version of exactly the row 023 answered, filtered to the tenant 023 answered.
  select c.row_version
    into v_version
    from tmpos_customer.customer c
   where c.customer_id = v_profile.o_customer_id
     and c.tenant_id = v_profile.o_tenant_id;
  if not found then
    raise exception 'migration 024 profile: the customer migration 023 answered is not on this snapshot'
      using errcode = 'no_data_found';
  end if;

  return query select 'customer'::text, v_profile.o_tenant_id, v_profile.o_customer_id, v_profile.o_name, v_profile.o_phone,
    v_profile.o_email, v_profile.o_created_at, v_version;
end
$$;

comment on function tmpos_customer_edit.m7a_customer_profile(text, uuid, uuid) is
  'Phase 4.0 M7a (migration 024): migration 023''s m7a_contact_profile answer (tenant id, customer id, name, phone, email, creation time as UTC text or NULL) plus that customer''s row_version, read on the same snapshot, for a key 023''s read answers ''customer'' for. Every other outcome of 023 passes through with nulls and a NULL version: ''not_found'' alike for a missing and a foreign id, ''denied'', ''invalid''. Always one row. Read-only; locks nothing.';

-- =============================================================================
-- 6) Privileges, and the proof that nothing wider was issued
-- =============================================================================
-- PostgreSQL grants EXECUTE on a new function to PUBLIC by default, so every default is removed explicitly before the one
-- intended grant is issued. 023's profile read leaves the runtime role: its only profile path is now 5b. No table or
-- column grant.
revoke all on function tmpos_customer_edit.m7a_customer_update(text, uuid, uuid, bigint, text, boolean, text, boolean, text) from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
revoke all on function tmpos_customer_edit.m7a_customer_profile(text, uuid, uuid) from public, anon, authenticated, tmpos_app, tmpos_audit_writer;

grant execute on function tmpos_customer_edit.m7a_customer_update(text, uuid, uuid, bigint, text, boolean, text, boolean, text) to tmpos_app;
grant execute on function tmpos_customer_edit.m7a_customer_profile(text, uuid, uuid) to tmpos_app;

revoke execute on function tmpos_customer_contact.m7a_contact_profile(text, uuid, uuid) from tmpos_app;

-- The postcondition, proven rather than asserted, in 023's form. This file refuses to finish unless, now:
--   (a) the customer table's columns are exactly 017's three, 023's three and row_version, of the declared types,
--       collations, nullability and defaults; its constraints exactly 017's three, 023's two and this file's CHECK,
--       validated; its indexes exactly 017's two; and every row's row_version is 1 (the column was added with a constant
--       default and no statement here writes a row, so no id, tenant, name, contact or creation time moved — the DB suite
--       proves that no row's tuple changed);
--   (b) public.audit_event.subject_customer_id is a nullable uuid with no default, its partial index exists on that table,
--       the audit writer may insert it (its table-wide grant), and no column of the audit table carries a grant;
--   (c) the schema holds exactly the two routines, and no relation of any kind, no standalone type, and no trigger calls
--       a function of it;
--   (d) the edit is plpgsql, SECURITY DEFINER, VOLATILE, and the profile read plpgsql, SECURITY DEFINER, STABLE, both
--       pinned to the search path above and run with row_security off, and they and the schema are owned by the applying
--       principal;
--   (e) the routines carry no grant beyond their owner's and a non-grantable EXECUTE to tmpos_app;
--   (f) the schema carries no grant beyond its owner's and a non-grantable USAGE to tmpos_app;
--   (g) tmpos_app CAN execute both routines and use the schema; tmpos_audit_writer, anon and authenticated CANNOT execute
--       either by any path (PUBLIC, an inherited role, or a role reachable only through SET ROLE);
--   (h) tmpos_app cannot execute 023's profile read, 020's create or 017's page, and holds no privilege on 017's table or
--       any of its columns, by any path; no column of the table carries a grant;
--   (i) none of the runtime roles is a MEMBER of the owner of the schema or the routines;
--   (j) by presence: 020's create, 022's read and 023's create and profile read are still there.
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
  select pg_catalog.string_agg(pg_catalog.format('%s %s %s %s %s', a.attname, pg_catalog.format_type(a.atttypid, a.atttypmod),
           coalesce(co.collname::text, '-'), a.attnotnull, coalesce(pg_catalog.pg_get_expr(d.adbin, d.adrelid), '-')),
           ', ' order by a.attnum)
    into v_bad
    from pg_catalog.pg_attribute a
    left join pg_catalog.pg_collation co on co.oid = a.attcollation
    left join pg_catalog.pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
   where a.attrelid = 'tmpos_customer.customer'::regclass
     and a.attnum > 0
     and not a.attisdropped;
  if v_bad is distinct from
       'customer_id uuid - t -, tenant_id uuid - t -, name text C t -, phone text C f -, email text C f -, created_at timestamp with time zone - f now(), row_version bigint - t 1' then
    raise exception 'migration 024 refused: tmpos_customer.customer does not have exactly 017''s and 023''s columns and this file''s row_version (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  select pg_catalog.string_agg(pg_catalog.format('%s:%s:%s', c.conname, c.contype, c.convalidated), ', ' order by c.conname)
    into v_bad
    from pg_catalog.pg_constraint c
   where c.conrelid = 'tmpos_customer.customer'::regclass
     and c.contype <> 'n'; -- PostgreSQL 18 records NOT NULL as a constraint too; 017 and this file declared those as columns
  if v_bad is distinct from
       'customer_email_chk:c:t, customer_name_chk:c:t, customer_phone_chk:c:t, customer_pkey:p:t, customer_row_version_chk:c:t, customer_tenant_fkey:f:t' then
    raise exception 'migration 024 refused: tmpos_customer.customer does not carry exactly 017''s and 023''s constraints and this file''s CHECK (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  select pg_catalog.string_agg(i.relname::text, ', ' order by i.relname) into v_bad
    from pg_catalog.pg_index x
    join pg_catalog.pg_class i on i.oid = x.indexrelid
   where x.indrelid = 'tmpos_customer.customer'::regclass;
  if v_bad is distinct from 'customer_pkey, customer_tenant_page_idx' then
    raise exception 'migration 024 refused: tmpos_customer.customer does not carry exactly 017''s two indexes (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if exists (select 1 from tmpos_customer.customer c where c.row_version <> 1) then
    raise exception 'migration 024 refused: a customer has a row_version other than 1'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (b)
  if not exists (
    select 1
      from pg_catalog.pg_attribute a
     where a.attrelid = 'public.audit_event'::regclass
       and a.attname = 'subject_customer_id'
       and not a.attisdropped
       and a.atttypid = 'pg_catalog.uuid'::regtype
       and not a.attnotnull
       and not a.atthasdef)
     or not exists (select 1 from pg_catalog.pg_index x
                     where x.indexrelid = pg_catalog.to_regclass('public.idx_audit_event_subject_customer_occurred')
                       and x.indrelid = 'public.audit_event'::regclass)
     or not pg_catalog.has_column_privilege('tmpos_audit_writer', 'public.audit_event', 'subject_customer_id', 'INSERT')
     or exists (select 1 from pg_catalog.pg_attribute a
                 where a.attrelid = 'public.audit_event'::regclass and a.attacl is not null) then
    raise exception 'migration 024 refused: public.audit_event.subject_customer_id is not the nullable uuid, index and writer reach section 3 declares, or a column of the audit table carries a grant'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (c)
  if (select pg_catalog.count(*) from pg_catalog.pg_proc p where p.pronamespace = 'tmpos_customer_edit'::regnamespace) <> 2
     or pg_catalog.to_regprocedure('tmpos_customer_edit.m7a_customer_update(text, uuid, uuid, bigint, text, boolean, text, boolean, text)') is null
     or pg_catalog.to_regprocedure('tmpos_customer_edit.m7a_customer_profile(text, uuid, uuid)') is null
     or exists (select 1 from pg_catalog.pg_class c
                 where c.relnamespace = 'tmpos_customer_edit'::regnamespace
                   and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S', 'c', 'i', 'I'))
     or exists (select 1 from pg_catalog.pg_type t
                 where t.typnamespace = 'tmpos_customer_edit'::regnamespace and t.typrelid = 0 and t.typelem = 0)
     or exists (select 1 from pg_catalog.pg_trigger g join pg_catalog.pg_proc p on p.oid = g.tgfoid
                 where p.pronamespace = 'tmpos_customer_edit'::regnamespace) then
    raise exception 'migration 024 refused: schema tmpos_customer_edit does not hold exactly the two routines this file creates'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (d)
  if (select pg_catalog.count(*)
        from pg_catalog.pg_proc p
        join pg_catalog.pg_language l on l.oid = p.prolang
       where p.oid in ('tmpos_customer_edit.m7a_customer_update(text, uuid, uuid, bigint, text, boolean, text, boolean, text)'::regprocedure,
                       'tmpos_customer_edit.m7a_customer_profile(text, uuid, uuid)'::regprocedure)
         and l.lanname = 'plpgsql'
         and p.prosecdef
         and p.provolatile = case when p.proname = 'm7a_customer_update' then 'v' else 's' end
         and p.proconfig = array['search_path=pg_catalog, pg_temp', 'row_security=off']
         and p.proowner = v_me) <> 2
     or not exists (select 1 from pg_catalog.pg_namespace n
                     where n.oid = 'tmpos_customer_edit'::regnamespace and n.nspowner = v_me) then
    raise exception 'migration 024 refused: the routines are not plpgsql SECURITY DEFINER routines (the edit VOLATILE, the read STABLE) pinned to pg_catalog, pg_temp with row_security off, owned with their schema by the applying principal'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (e)
  select pg_catalog.string_agg(pg_catalog.format('%s %s:%s', p.proname, g.grantee::regrole::text, g.privilege_type), ', ')
    into v_bad
    from pg_catalog.pg_proc p,
         pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g
   where p.pronamespace = 'tmpos_customer_edit'::regnamespace
     and g.grantee <> p.proowner
     and not (g.grantee = 'tmpos_app'::regrole and g.privilege_type = 'EXECUTE' and not g.is_grantable);
  if v_bad is not null then
    raise exception 'migration 024 refused: an unexpected direct grant remains on a tmpos_customer_edit routine (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (f)
  select pg_catalog.string_agg(pg_catalog.format('%s:%s', g.grantee::regrole::text, g.privilege_type), ', ')
    into v_bad
    from pg_catalog.pg_namespace n,
         pg_catalog.aclexplode(coalesce(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) g
   where n.oid = 'tmpos_customer_edit'::regnamespace
     and g.grantee <> n.nspowner
     and not (g.grantee = 'tmpos_app'::regrole and g.privilege_type = 'USAGE' and not g.is_grantable);
  if v_bad is not null then
    raise exception 'migration 024 refused: schema tmpos_customer_edit carries an unexpected grant (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (g)
  if not pg_catalog.has_function_privilege('tmpos_app',
           'tmpos_customer_edit.m7a_customer_update(text, uuid, uuid, bigint, text, boolean, text, boolean, text)'::regprocedure, 'EXECUTE')
     or not pg_catalog.has_function_privilege('tmpos_app',
           'tmpos_customer_edit.m7a_customer_profile(text, uuid, uuid)'::regprocedure, 'EXECUTE')
     or not pg_catalog.has_schema_privilege('tmpos_app', 'tmpos_customer_edit'::regnamespace, 'USAGE') then
    raise exception 'migration 024 refused: tmpos_app does not hold EXECUTE on both routines and USAGE on schema tmpos_customer_edit'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  select pg_catalog.string_agg(distinct r.rolname::text, ', ') into v_bad
    from pg_catalog.pg_roles r
    join pg_catalog.pg_roles x on pg_catalog.pg_has_role(r.oid, x.oid, 'MEMBER')
    cross join pg_catalog.pg_proc p
   where p.pronamespace = 'tmpos_customer_edit'::regnamespace
     and r.rolname = any (array['tmpos_audit_writer', 'anon', 'authenticated']::name[])
     and pg_catalog.has_function_privilege(x.oid, p.oid, 'EXECUTE');
  if v_bad is not null then
    raise exception 'migration 024 refused: a runtime role other than tmpos_app can execute a tmpos_customer_edit routine (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (h) MAINTAIN only on a server that has it (PostgreSQL 17+), where has_table_privilege would reject it on 16.
  select pg_catalog.string_agg(distinct r.rolname::text, ', ') into v_bad
    from pg_catalog.pg_roles r
    join pg_catalog.pg_roles x on pg_catalog.pg_has_role(r.oid, x.oid, 'MEMBER')
   where r.rolname = 'tmpos_app'
     and (pg_catalog.has_function_privilege(x.oid, 'tmpos_customer_contact.m7a_contact_profile(text, uuid, uuid)'::regprocedure, 'EXECUTE')
          or pg_catalog.has_function_privilege(x.oid, 'tmpos_role.m7a_customer_create(text, uuid, text)'::regprocedure, 'EXECUTE')
          or pg_catalog.has_function_privilege(x.oid,
            'tmpos_customer.m7a_customer_page(uuid, text, uuid, text, uuid, uuid, integer)'::regprocedure, 'EXECUTE')
          or pg_catalog.has_table_privilege(x.oid, 'tmpos_customer.customer'::regclass,
            'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'
            operator(pg_catalog.||) case when pg_catalog.current_setting('server_version_num')::integer >= 170000
                                         then ', MAINTAIN' else '' end)
          or pg_catalog.has_any_column_privilege(x.oid, 'tmpos_customer.customer'::regclass, 'SELECT, INSERT, UPDATE, REFERENCES'));
  if v_bad is not null then
    raise exception 'migration 024 refused: % can execute 023''s profile read, 020''s create or 017''s page, or holds a privilege on tmpos_customer.customer', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if exists (select 1 from pg_catalog.pg_attribute a
              where a.attrelid = 'tmpos_customer.customer'::regclass and a.attacl is not null) then
    raise exception 'migration 024 refused: a column grant exists on tmpos_customer.customer'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (i)
  select pg_catalog.string_agg(distinct r.rolname::text, ', ') into v_bad
    from pg_catalog.pg_roles r
    cross join (
      select n.nspowner as owner from pg_catalog.pg_namespace n where n.nspname = 'tmpos_customer_edit'
      union
      select p.proowner from pg_catalog.pg_proc p where p.pronamespace = 'tmpos_customer_edit'::regnamespace
    ) o
   where r.rolname = any (array['tmpos_app', 'tmpos_audit_writer', 'anon', 'authenticated']::name[])
     and pg_catalog.pg_has_role(r.oid, o.owner, 'MEMBER');
  if v_bad is not null then
    raise exception 'migration 024 refused: % is a member of the owner of schema tmpos_customer_edit or its routines', v_bad
      using errcode = 'object_not_in_prerequisite_state',
            hint = 'membership hands a role everything the owner holds, including a direct write of every customer';
  end if;

  -- (j)
  if pg_catalog.to_regprocedure('tmpos_role.m7a_customer_create(text, uuid, text)') is null
     or pg_catalog.to_regprocedure('tmpos_customer_detail.m7a_customer_get(text, uuid, uuid)') is null
     or pg_catalog.to_regprocedure('tmpos_customer_contact.m7a_contact_create(text, uuid, text, text, text)') is null
     or pg_catalog.to_regprocedure('tmpos_customer_contact.m7a_contact_profile(text, uuid, uuid)') is null then
    raise exception 'migration 024 refused: migration 020''s create, 022''s read or 023''s create or profile read is missing'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$$;

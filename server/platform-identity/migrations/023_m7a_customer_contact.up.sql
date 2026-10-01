-- Phase 4.0 M7a — customer contact records: an optional phone and email on each server customer and a creation time the
-- database writes, set through one session-bound create and read through one session-bound profile read that each
-- delegate their whole authority decision to the routine already deciding it (M7A-CUSTOMERS-P6; G-IAM, G-DBROLE,
-- G-PRIVACY; docs/phase-4/10)
-- Migration: 023_m7a_customer_contact (UP)
--
-- SCOPE / TRUTH (binding):
--   - THREE NEW COLUMNS AND TWO CHECKS ON 017'S TABLE, ONE NEW SCHEMA, TWO ROUTINES, THREE GRANTS, ONE REVOKED GRANT, NO
--     INDEX, NO TABLE, NO ROLE, NO TRIGGER, NO TYPE. This file adds to tmpos_customer.customer the nullable columns phone
--     and email (text, collation "C") and created_at (timestamptz, default now() for rows inserted from now on), with the
--     CHECKs customer_phone_chk and customer_email_chk; creates schema tmpos_customer_contact and in it the two routines
--     tmpos_app may execute: m7a_contact_create (POST /api/v1/customers) and m7a_contact_profile (GET
--     /api/v1/customers/{id}/profile); and revokes tmpos_app's EXECUTE on 020's tmpos_role.m7a_customer_create, so the
--     runtime's one create path is this file's (020's own precedent with 019's create). Those are its only effects on
--     objects earlier migrations created: 001-022 stay byte for byte as committed (the migration-files contract's pinned
--     checksums prove that), and tmpos_app gains no privilege on 017's table, its columns or 017's page.
--   - WHY THE COLUMNS ARE ON 017'S TABLE. A contact is a fact about one customer, read with it by id and written with it
--     in one statement's transaction; a side table would need its own tenant key, rollback and inventory for the same row.
--     The table's postconditions in 017, 019 and 020 count its relations and routines, never its columns, and a column
--     adds neither. A routine or a table added to tmpos_customer, tmpos_role or tmpos_customer_detail would break the
--     exact inventories 017, 020 and 022 pin and their rollbacks (each drops its schema WITHOUT CASCADE): so the two
--     routines live in a schema this file owns outright (017's-022's reason).
--   - LEGACY ROWS: NO CONTACT, AND NO INVENTED TIME. created_at is added with NO default, so every row that exists when
--     this file applies keeps NULL — an unknown creation time — and is never stamped with the migration's time; the
--     default (pg_catalog.now(), the creating transaction's start, as 002's audit_event.occurred_at) is set by a separate
--     statement and applies only to rows inserted afterwards. Ids, names, tenants and the page order (017's index on
--     tenant, name, id) are untouched: no row is rewritten and no index is added or changed. phone and email are NULL on
--     every existing row. The postcondition proves both.
--   - THE CONTACT RULES, RESTATED (the runtime's customerCreate.ts and the shop client are at least as strict). NULL is
--     "not provided"; a stored value is never empty. phone: 1-64 characters (Unicode scalars, char_length), no C0 control
--     (the database cannot hold NUL), DEL, C1 control, line or paragraph separator, no Bidi_Control character (017's set),
--     none of 017's edge-whitespace characters at either edge (the runtime stores the trimmed value), and at least one
--     ASCII digit; internal spaces and punctuation are kept as typed — no country, no E.164, no normalization. email:
--     1-254 characters, the same refused characters and edges, no White_Space character anywhere, and exactly one '@'
--     with a non-empty part on each side; no case folding, no normalization and no claim that the address is reachable or
--     belongs to anyone. Neither is unique, indexed, matched or merged on.
--   - THE CREATE'S ONLY AUTHORITY ARGUMENT IS THE SESSION KEY, AND ITS ONLY DECISION IS 020'S. m7a_contact_create first
--     judges the two contacts (a refusal raises invalid_parameter_value with a fixed message naming the field, never the
--     value, before anything is read, locked or written); then calls 020's tmpos_role.m7a_customer_create with the key,
--     the id and the name, as its owner — the whole authority decision (016's hold, the session, ledger and issuer rows
--     FOR SHARE, the clock after every wait, the standing digest, exactly one tenant grant, the role's current Customers
--     level at Create under its row lock) and the insert, whose created_at the column default writes; answers no row when
--     020 answers none (no customer written); and otherwise writes the two contacts onto exactly that row of exactly the
--     tenant 020 derived, requiring one row updated, and answers 020's row. One source of authority logic: nothing is
--     re-derived here, so the create and the name-only create cannot disagree.
--   - THE PROFILE READ'S ONLY AUTHORITY ARGUMENT IS THE SESSION KEY, AND ITS ONLY DECISION IS 022'S. m7a_contact_profile
--     calls 022's tmpos_customer_detail.m7a_customer_get as its owner — the session, the standing, exactly one tenant
--     grant, the role's current level at View, 017's rechecks, p_expected_tenant as a precondition, the point read — and
--     passes every refusal through ('not_found' alike for a missing and a foreign id; 'denied'; 'invalid'); on 'customer'
--     it reads that id's phone, email and created_at filtered to the tenant 022 derived, on the same snapshot (both are
--     STABLE), and answers ('customer', tenant, id, name, phone, email, created_at as UTC text
--     'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"', or NULL for a legacy row). Always exactly ONE row.
--   - WHAT THEY DO NOT DO. Neither writes an audit record, an outbox event or an idempotency completion: the runtime's
--     command transaction appends the create's around it, with audit metadata {} (no contact ever reaches it), and the
--     read writes none (the list's and the detail's owner decision; doc 08 G-AUDIT). No message, hint or detail they
--     raise carries a contact value.
--   - WHAT THIS DOES NOT DEFEND (doc 08; none of it is claimed closed). 020's create residuals and 022's read residuals
--     stand for these routines (a holder of tmpos_app plus a live minted key creates and reads directly, unaudited, in that
--     key's tenant; bind parameters in a database log expose session keys — and now contacts — G-DBROLE, G-PRIVACY), and:
--       * contacts are personal data stored in clear, retained until a deletion decision exists — none is made here;
--       * the rollback order is not enforced by the database: 022's or 020's rollback run while this file is applied
--         succeeds (a PL/pgSQL body records no dependency), these routines then RAISE on the missing object at call —
--         failing closed (503) — and this file's rollback refuses until 020 is applied again. The supported order: 023,
--         then 022, 021, 020.
--   - DEPLOY AND ROLLBACK MOVE WITH THE RUNTIME. The P6 runtime's startup preflight pins exactly 001-023 and these grants
--     (and no longer 020's create), and the previous build refuses a 023 database (its approved grants hold 020's create
--     and lack these). The rollback REFUSES while any customer holds a phone, an email or a creation time: dropping them
--     would discard customer data, and every customer created after this file has a creation time. Removing that data is a
--     deliberate retention decision, never a rollback's side effect.
--   - NO SECRET, NO DYNAMIC SQL, NO EXTENSION, NO TEMPORARY OBJECT. Every statement is fixed text, every value a
--     parameter, every relation and routine schema-qualified; every routine pins its search_path to pg_catalog then
--     pg_temp and runs with row_security off, so were row security ever FORCEd on a table it reads or writes it fails
--     (503) instead of silently refusing. Altering the table takes ACCESS EXCLUSIVE on it for the apply's duration: the
--     three columns are added without a rewrite (no default on ADD COLUMN) and the CHECKs scan the table once.
--
-- Reversible via 023_m7a_customer_contact.down.sql, which refuses while any customer holds a phone, an email or a creation
-- time, and otherwise removes exactly what this file created and gives tmpos_app back EXECUTE on 020's create. Roll 023 back
-- before 022.
--
-- Assumes 001-022 are applied. A future managed apply targets the complete contiguous chain through the newest committed
-- migration — now 001-023 (owner decision D4); this file authorizes no apply.

-- =============================================================================
-- 0) This transaction's search path
-- =============================================================================
set local search_path = pg_catalog, pg_temp;

-- =============================================================================
-- 1) Preconditions: what this file builds on
-- =============================================================================
do $$
begin
  -- The chain is contiguous: 022 is the newest migration this file sits on.
  if pg_catalog.to_regprocedure('tmpos_customer_detail.m7a_customer_get(text, uuid, uuid)') is null then
    raise exception 'migration 023 refused: migration 022 must be applied first'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- The objects the routines delegate to and the table this file alters.
  if pg_catalog.to_regprocedure('tmpos_role.m7a_customer_create(text, uuid, text)') is null
     or pg_catalog.to_regclass('tmpos_customer.customer') is null then
    raise exception 'migration 023 refused: migration 020''s create or migration 017''s customer table is missing'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- The runtime roles this file grants to and revokes from.
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'tmpos_app')
     or not exists (select 1 from pg_catalog.pg_roles where rolname = 'tmpos_audit_writer') then
    raise exception 'migration 023 refused: migration 005 must be applied first'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- Nothing of this file exists yet: it is applied once, over a chain that has never held it.
  if pg_catalog.to_regnamespace('tmpos_customer_contact') is not null then
    raise exception 'migration 023 refused: schema tmpos_customer_contact already exists'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if exists (select 1 from pg_catalog.pg_attribute a
              where a.attrelid = 'tmpos_customer.customer'::regclass
                and a.attname in ('phone', 'email', 'created_at') and not a.attisdropped) then
    raise exception 'migration 023 refused: tmpos_customer.customer already has a phone, email or created_at column'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- The definers call 020's create and 022's read as their owner, the principal applying this file.
  if not (pg_catalog.has_function_privilege(current_user, 'tmpos_role.m7a_customer_create(text, uuid, text)', 'EXECUTE')
          and pg_catalog.has_function_privilege(current_user, 'tmpos_customer_detail.m7a_customer_get(text, uuid, uuid)', 'EXECUTE')
          and pg_catalog.has_schema_privilege(current_user, 'tmpos_role', 'USAGE')
          and pg_catalog.has_schema_privilege(current_user, 'tmpos_customer_detail', 'USAGE')
          and pg_catalog.has_schema_privilege(current_user, 'tmpos_customer', 'USAGE')) then
    raise exception 'migration 023 refused: the applying principal cannot execute 020''s create and 022''s read, which the definers call'
      using errcode = 'insufficient_privilege';
  end if;
  -- Altering the table needs its owner's privileges, and a SECURITY DEFINER routine reads and writes only what its OWNER
  -- may (017's argument): were the applying principal neither the table's owner nor a role inheriting the owner's
  -- privileges — or row security FORCEd on it — the alter would fail, or the routines would find no row.
  if exists (
    select 1
      from pg_catalog.pg_class c
     where c.oid = 'tmpos_customer.customer'::regclass
       and (not pg_catalog.pg_has_role(current_user, c.relowner, 'USAGE') or c.relforcerowsecurity)) then
    raise exception 'migration 023 refused: the applying principal neither owns nor inherits the owner of tmpos_customer.customer, or it has forced row security'
      using errcode = 'insufficient_privilege';
  end if;
  -- Each privilege stated, one at a time (019's reason): SELECT and UPDATE on the customer table.
  if not (pg_catalog.has_table_privilege(current_user, 'tmpos_customer.customer', 'SELECT')
          and pg_catalog.has_table_privilege(current_user, 'tmpos_customer.customer', 'UPDATE')) then
    raise exception 'migration 023 refused: the applying principal lacks SELECT or UPDATE on tmpos_customer.customer'
      using errcode = 'insufficient_privilege';
  end if;
end
$$;

-- =============================================================================
-- 2) The columns
-- =============================================================================
-- No default in the ADD: every existing row keeps NULL in all three — no contact, an unknown creation time.
alter table tmpos_customer.customer
  add column phone text collate "C",
  add column email text collate "C",
  add column created_at timestamptz;

-- From now on an inserted row's creation time is the database's: the inserting transaction's start (now()).
alter table tmpos_customer.customer alter column created_at set default pg_catalog.now();

-- 017's refused characters (its name CHECK's control/C1/LS/PS and Bidi_Control sets) and its edge-whitespace set,
-- restated; the phone needs an ASCII digit; the email no White_Space anywhere and exactly one '@' between non-empty parts.
alter table tmpos_customer.customer
  add constraint customer_phone_chk check (
    phone is null or (
      pg_catalog.char_length(phone) between 1 and 64
      and phone !~ '[\u0001-\u001f\u007f-\u009f\u2028\u2029]'
      and phone !~ '[\u061c\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069]'
      and phone !~ '^[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]|[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]$'
      and phone ~ '[0-9]')),
  add constraint customer_email_chk check (
    email is null or (
      pg_catalog.char_length(email) between 1 and 254
      and email !~ '[\u0001-\u001f\u007f-\u009f\u2028\u2029]'
      and email !~ '[\u061c\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069]'
      and email !~ '^[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]|[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]$'
      and email !~ '[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]'
      and email ~ '^[^@]+@[^@]+$'));

comment on column tmpos_customer.customer.phone is
  'Phase 4.0 M7a (migration 023): the customer''s optional phone as typed (trimmed, 1-64 characters, at least one ASCII digit, no control or Bidi_Control character); NULL when not provided. Personal data; not unique, not verified.';
comment on column tmpos_customer.customer.email is
  'Phase 4.0 M7a (migration 023): the customer''s optional email as typed (trimmed, 1-254 characters, no whitespace or control character, exactly one @ between non-empty parts); NULL when not provided. Personal data; not unique, not verified.';
comment on column tmpos_customer.customer.created_at is
  'Phase 4.0 M7a (migration 023): when the customer was created, written by the database (the creating transaction''s start); NULL for a customer created before migration 023, whose creation time is unknown.';

-- =============================================================================
-- 3) The schema
-- =============================================================================
create schema tmpos_customer_contact;

comment on schema tmpos_customer_contact is
  'Phase 4.0 M7a (migration 023): customer contact records — the session-bound create and profile read POST /api/v1/customers and GET /api/v1/customers/{id}/profile go through. Owned by this migration; tmpos_app holds USAGE and EXECUTE only.';

revoke all on schema tmpos_customer_contact from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
grant usage on schema tmpos_customer_contact to tmpos_app;

-- =============================================================================
-- 4) The routines
-- =============================================================================

-- 4a) The create: the two contacts judged, then 020's create whole, then the contacts onto the row it inserted.
create function tmpos_customer_contact.m7a_contact_create(
  p_session_key text, p_customer_id uuid, p_name text, p_phone text, p_email text)
returns table (
  o_tenant_id     uuid,
  o_actor_id      uuid,
  o_membership_id uuid
)
language plpgsql
-- VOLATILE IS LOAD-BEARING (019's and 020's reason): 020's create locks and then re-reads, and the update below must
-- see the row 020's insert wrote. Do not make it STABLE.
volatile
security definer
set search_path = pg_catalog, pg_temp
set row_security = off
as $$
declare
  v_answer     record;
  v_answers    integer := 0;
  v_tenant     uuid;
  v_actor      uuid;
  v_membership uuid;
  v_updated    integer;
begin
  -- 0. The contacts, before anything is read, locked or written. NULL is "not provided"; anything else must be a value
  --    the column's CHECK admits, and a refusal names the field and never the value.
  if p_phone is not null and not (
       pg_catalog.char_length(p_phone) between 1 and 64
       and p_phone !~ '[\u0001-\u001f\u007f-\u009f\u2028\u2029]'
       and p_phone !~ '[\u061c\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069]'
       and p_phone !~ '^[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]|[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]$'
       and p_phone ~ '[0-9]') then
    raise exception 'migration 023 create: the phone is not one the customer table admits'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_email is not null and not (
       pg_catalog.char_length(p_email) between 1 and 254
       and p_email !~ '[\u0001-\u001f\u007f-\u009f\u2028\u2029]'
       and p_email !~ '[\u061c\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069]'
       and p_email !~ '^[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]|[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]$'
       and p_email !~ '[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]'
       and p_email ~ '^[^@]+@[^@]+$') then
    raise exception 'migration 023 create: the email is not one the customer table admits'
      using errcode = 'invalid_parameter_value';
  end if;

  -- 1. 020's create, whole: its arguments, its READ COMMITTED rule, the caller derived from the key alone, the role's
  --    current level under its row lock, and the insert in the derived tenant (created_at by the column default). Its
  --    raises are not caught. No row is a refusal: nothing was written, and none is answered here.
  for v_answer in
    select c.o_tenant_id, c.o_actor_id, c.o_membership_id
      from tmpos_role.m7a_customer_create(p_session_key, p_customer_id, p_name) c
  loop
    v_answers := v_answers + 1;
    v_tenant := v_answer.o_tenant_id;
    v_actor := v_answer.o_actor_id;
    v_membership := v_answer.o_membership_id;
  end loop;
  if v_answers = 0 then
    return;
  end if;
  if v_answers <> 1 or v_tenant is null then
    raise exception 'migration 023 create: migration 020''s create did not answer exactly one tenant'
      using errcode = 'cardinality_violation';
  end if;

  -- 2. The contacts, onto exactly the row 020 inserted, in exactly the tenant 020 derived. The CHECKs restate step 0, so
  --    they cannot refuse; were they ever to, the raise is fixed text, never the row.
  begin
    update tmpos_customer.customer c
       set phone = p_phone, email = p_email
     where c.customer_id = p_customer_id
       and c.tenant_id = v_tenant;
    get diagnostics v_updated = row_count;
  exception
    when check_violation then
      raise exception 'migration 023 create: a contact is not one the customer table admits'
        using errcode = 'check_violation';
  end;
  if v_updated <> 1 then
    raise exception 'migration 023 create: the contacts were not written to exactly the created customer'
      using errcode = 'no_data_found';
  end if;

  return query select v_tenant, v_actor, v_membership;
end
$$;

comment on function tmpos_customer_contact.m7a_contact_create(text, uuid, text, text, text) is
  'Phase 4.0 M7a (migration 023): creates one customer with an optional phone and email. Judges both contacts first (NULL or a value the column CHECKs admit; invalid_parameter_value with a fixed message naming the field, never the value), then delegates the whole authority decision and the insert to migration 020''s tmpos_role.m7a_customer_create (created_at by the column default), then writes the contacts onto exactly that row in exactly the tenant 020 derived. Answers 020''s tenant id, actor id and membership id, or no row (no customer written). Raises with 020''s SQLSTATEs and its own fixed messages. Writes no audit record.';

-- 4b) The profile read: 022's read whole, then the contact fields of the one row it answered, on the same snapshot.
create function tmpos_customer_contact.m7a_contact_profile(p_session_key text, p_customer_id uuid, p_expected_tenant uuid)
returns table (
  o_outcome     text,
  o_tenant_id   uuid,
  o_customer_id uuid,
  o_name        text,
  o_phone       text,
  o_email       text,
  o_created_at  text
)
language plpgsql
-- STABLE IS LOAD-BEARING (017's and 022's reason): 022's read and the contact read below run on the calling statement's
-- snapshot, so the row 022 answered is the row read here. It locks nothing and can write nothing.
stable
security definer
set search_path = pg_catalog, pg_temp
set row_security = off
as $$
declare
  v_detail  record;
  v_phone   text;
  v_email   text;
  v_created timestamptz;
begin
  -- 1. 022's read, whole: the session, its standing, exactly one tenant grant, the role's current level at View, 017's
  --    rechecks, p_expected_tenant as a precondition, and one point read. Exactly one row, always.
  select g.o_outcome, g.o_tenant_id, g.o_customer_id, g.o_name
    into v_detail
    from tmpos_customer_detail.m7a_customer_get(p_session_key, p_customer_id, p_expected_tenant) g;
  if not found then
    raise exception 'migration 023 profile: migration 022''s read answered no row'
      using errcode = 'cardinality_violation';
  end if;
  -- Every refusal passes through as 022 answered it: 'not_found' alike for a missing and a foreign id, 'denied',
  -- 'invalid'. No contact row is visited.
  if v_detail.o_outcome is distinct from 'customer' then
    return query select v_detail.o_outcome, null::uuid, null::uuid, null::text, null::text, null::text, null::text;
    return;
  end if;

  -- 2. The contact fields of exactly the row 022 answered, filtered to the tenant 022 derived.
  select c.phone, c.email, c.created_at
    into v_phone, v_email, v_created
    from tmpos_customer.customer c
   where c.customer_id = v_detail.o_customer_id
     and c.tenant_id = v_detail.o_tenant_id;
  if not found then
    raise exception 'migration 023 profile: the customer migration 022 answered is not on this snapshot'
      using errcode = 'no_data_found';
  end if;

  return query select 'customer'::text, v_detail.o_tenant_id, v_detail.o_customer_id, v_detail.o_name, v_phone, v_email,
    case when v_created is null then null::text
         else pg_catalog.to_char(v_created at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end;
end
$$;

comment on function tmpos_customer_contact.m7a_contact_profile(text, uuid, uuid) is
  'Phase 4.0 M7a (migration 023): one customer''s profile (tenant id, customer id, name, phone, email, creation time as UTC text YYYY-MM-DDTHH24:MI:SS.MSZ or NULL when unknown) for a key migration 022''s m7a_customer_get answers ''customer'' for — the same session, standing, grant, level, expected-tenant and 017 rechecks, on the same snapshot. Every other outcome of 022 passes through with nulls: ''not_found'' alike for a missing and a foreign id, ''denied'', ''invalid''. Always one row. Read-only; locks nothing.';

-- =============================================================================
-- 5) Privileges, and the proof that nothing wider was issued
-- =============================================================================
-- PostgreSQL grants EXECUTE on a new function to PUBLIC by default, so every default is removed explicitly before the one
-- intended grant is issued. 020's create leaves the runtime role: its only create path is now 4a. No table or column grant.
revoke all on function tmpos_customer_contact.m7a_contact_create(text, uuid, text, text, text) from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
revoke all on function tmpos_customer_contact.m7a_contact_profile(text, uuid, uuid) from public, anon, authenticated, tmpos_app, tmpos_audit_writer;

grant execute on function tmpos_customer_contact.m7a_contact_create(text, uuid, text, text, text) to tmpos_app;
grant execute on function tmpos_customer_contact.m7a_contact_profile(text, uuid, uuid) to tmpos_app;

revoke execute on function tmpos_role.m7a_customer_create(text, uuid, text) from tmpos_app;

-- The postcondition, proven rather than asserted, in 022's form. This file refuses to finish unless, now:
--   (a) the customer table's columns are exactly 017's three and this file's three, of the declared types, collations,
--       nullability and defaults; its constraints exactly 017's three and this file's two CHECKs, validated; its
--       indexes exactly 017's two; and no row holds a phone, an email or a creation time (every row that existed keeps
--       NULL, and none was inserted since);
--   (b) the schema holds exactly the two routines, and no relation of any kind, no standalone type, and no trigger calls
--       a function of it;
--   (c) the create is plpgsql, SECURITY DEFINER, VOLATILE, and the profile read plpgsql, SECURITY DEFINER, STABLE, both
--       pinned to the search path above and run with row_security off, and they and the schema are owned by the applying
--       principal;
--   (d) the routines carry no grant beyond their owner's and a non-grantable EXECUTE to tmpos_app;
--   (e) the schema carries no grant beyond its owner's and a non-grantable USAGE to tmpos_app;
--   (f) tmpos_app CAN execute both routines and use the schema; tmpos_audit_writer, anon and authenticated CANNOT execute
--       either by any path (PUBLIC, an inherited role, or a role reachable only through SET ROLE);
--   (g) tmpos_app cannot execute 020's create or 017's page, and holds no privilege on 017's table or any of its columns,
--       by any path; no column of the table carries a grant;
--   (h) none of the runtime roles is a MEMBER of the owner of the schema or the routines;
--   (i) by presence: 020's create and page_v3, and 022's read, are still there.
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
       'customer_id uuid - t -, tenant_id uuid - t -, name text C t -, phone text C f -, email text C f -, created_at timestamp with time zone - f now()' then
    raise exception 'migration 023 refused: tmpos_customer.customer does not have exactly 017''s columns and this file''s phone, email and created_at (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  select pg_catalog.string_agg(pg_catalog.format('%s:%s:%s', c.conname, c.contype, c.convalidated), ', ' order by c.conname)
    into v_bad
    from pg_catalog.pg_constraint c
   where c.conrelid = 'tmpos_customer.customer'::regclass
     and c.contype <> 'n'; -- PostgreSQL 18 records NOT NULL as a constraint too; 017 declared those as columns
  if v_bad is distinct from
       'customer_email_chk:c:t, customer_name_chk:c:t, customer_phone_chk:c:t, customer_pkey:p:t, customer_tenant_fkey:f:t' then
    raise exception 'migration 023 refused: tmpos_customer.customer does not carry exactly 017''s constraints and this file''s two CHECKs (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  select pg_catalog.string_agg(i.relname::text, ', ' order by i.relname) into v_bad
    from pg_catalog.pg_index x
    join pg_catalog.pg_class i on i.oid = x.indexrelid
   where x.indrelid = 'tmpos_customer.customer'::regclass;
  if v_bad is distinct from 'customer_pkey, customer_tenant_page_idx' then
    raise exception 'migration 023 refused: tmpos_customer.customer does not carry exactly 017''s two indexes (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if exists (select 1 from tmpos_customer.customer c
              where c.phone is not null or c.email is not null or c.created_at is not null) then
    raise exception 'migration 023 refused: a customer holds a phone, an email or a creation time the apply did not leave NULL'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (b)
  if (select pg_catalog.count(*) from pg_catalog.pg_proc p where p.pronamespace = 'tmpos_customer_contact'::regnamespace) <> 2
     or pg_catalog.to_regprocedure('tmpos_customer_contact.m7a_contact_create(text, uuid, text, text, text)') is null
     or pg_catalog.to_regprocedure('tmpos_customer_contact.m7a_contact_profile(text, uuid, uuid)') is null
     or exists (select 1 from pg_catalog.pg_class c
                 where c.relnamespace = 'tmpos_customer_contact'::regnamespace
                   and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S', 'c', 'i', 'I'))
     or exists (select 1 from pg_catalog.pg_type t
                 where t.typnamespace = 'tmpos_customer_contact'::regnamespace and t.typrelid = 0 and t.typelem = 0)
     or exists (select 1 from pg_catalog.pg_trigger g join pg_catalog.pg_proc p on p.oid = g.tgfoid
                 where p.pronamespace = 'tmpos_customer_contact'::regnamespace) then
    raise exception 'migration 023 refused: schema tmpos_customer_contact does not hold exactly the two routines this file creates'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (c)
  if (select pg_catalog.count(*)
        from pg_catalog.pg_proc p
        join pg_catalog.pg_language l on l.oid = p.prolang
       where p.oid in ('tmpos_customer_contact.m7a_contact_create(text, uuid, text, text, text)'::regprocedure,
                       'tmpos_customer_contact.m7a_contact_profile(text, uuid, uuid)'::regprocedure)
         and l.lanname = 'plpgsql'
         and p.prosecdef
         and p.provolatile = case when p.proname = 'm7a_contact_create' then 'v' else 's' end
         and p.proconfig = array['search_path=pg_catalog, pg_temp', 'row_security=off']
         and p.proowner = v_me) <> 2
     or not exists (select 1 from pg_catalog.pg_namespace n
                     where n.oid = 'tmpos_customer_contact'::regnamespace and n.nspowner = v_me) then
    raise exception 'migration 023 refused: the routines are not plpgsql SECURITY DEFINER routines (the create VOLATILE, the read STABLE) pinned to pg_catalog, pg_temp with row_security off, owned with their schema by the applying principal'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (d)
  select pg_catalog.string_agg(pg_catalog.format('%s %s:%s', p.proname, g.grantee::regrole::text, g.privilege_type), ', ')
    into v_bad
    from pg_catalog.pg_proc p,
         pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g
   where p.pronamespace = 'tmpos_customer_contact'::regnamespace
     and g.grantee <> p.proowner
     and not (g.grantee = 'tmpos_app'::regrole and g.privilege_type = 'EXECUTE' and not g.is_grantable);
  if v_bad is not null then
    raise exception 'migration 023 refused: an unexpected direct grant remains on a tmpos_customer_contact routine (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (e)
  select pg_catalog.string_agg(pg_catalog.format('%s:%s', g.grantee::regrole::text, g.privilege_type), ', ')
    into v_bad
    from pg_catalog.pg_namespace n,
         pg_catalog.aclexplode(coalesce(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) g
   where n.oid = 'tmpos_customer_contact'::regnamespace
     and g.grantee <> n.nspowner
     and not (g.grantee = 'tmpos_app'::regrole and g.privilege_type = 'USAGE' and not g.is_grantable);
  if v_bad is not null then
    raise exception 'migration 023 refused: schema tmpos_customer_contact carries an unexpected grant (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (f)
  if not pg_catalog.has_function_privilege('tmpos_app',
           'tmpos_customer_contact.m7a_contact_create(text, uuid, text, text, text)'::regprocedure, 'EXECUTE')
     or not pg_catalog.has_function_privilege('tmpos_app',
           'tmpos_customer_contact.m7a_contact_profile(text, uuid, uuid)'::regprocedure, 'EXECUTE')
     or not pg_catalog.has_schema_privilege('tmpos_app', 'tmpos_customer_contact'::regnamespace, 'USAGE') then
    raise exception 'migration 023 refused: tmpos_app does not hold EXECUTE on both routines and USAGE on schema tmpos_customer_contact'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  select pg_catalog.string_agg(distinct r.rolname::text, ', ') into v_bad
    from pg_catalog.pg_roles r
    join pg_catalog.pg_roles x on pg_catalog.pg_has_role(r.oid, x.oid, 'MEMBER')
    cross join pg_catalog.pg_proc p
   where p.pronamespace = 'tmpos_customer_contact'::regnamespace
     and r.rolname = any (array['tmpos_audit_writer', 'anon', 'authenticated']::name[])
     and pg_catalog.has_function_privilege(x.oid, p.oid, 'EXECUTE');
  if v_bad is not null then
    raise exception 'migration 023 refused: a runtime role other than tmpos_app can execute a tmpos_customer_contact routine (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (g) MAINTAIN only on a server that has it (PostgreSQL 17+), where has_table_privilege would reject it on 16.
  select pg_catalog.string_agg(distinct r.rolname::text, ', ') into v_bad
    from pg_catalog.pg_roles r
    join pg_catalog.pg_roles x on pg_catalog.pg_has_role(r.oid, x.oid, 'MEMBER')
   where r.rolname = 'tmpos_app'
     and (pg_catalog.has_function_privilege(x.oid, 'tmpos_role.m7a_customer_create(text, uuid, text)'::regprocedure, 'EXECUTE')
          or pg_catalog.has_function_privilege(x.oid,
            'tmpos_customer.m7a_customer_page(uuid, text, uuid, text, uuid, uuid, integer)'::regprocedure, 'EXECUTE')
          or pg_catalog.has_table_privilege(x.oid, 'tmpos_customer.customer'::regclass,
            'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'
            operator(pg_catalog.||) case when pg_catalog.current_setting('server_version_num')::integer >= 170000
                                         then ', MAINTAIN' else '' end)
          or pg_catalog.has_any_column_privilege(x.oid, 'tmpos_customer.customer'::regclass, 'SELECT, INSERT, UPDATE, REFERENCES'));
  if v_bad is not null then
    raise exception 'migration 023 refused: % can execute 020''s create or 017''s page, or holds a privilege on tmpos_customer.customer', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if exists (select 1 from pg_catalog.pg_attribute a
              where a.attrelid = 'tmpos_customer.customer'::regclass and a.attacl is not null) then
    raise exception 'migration 023 refused: a column grant exists on tmpos_customer.customer'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (h)
  select pg_catalog.string_agg(distinct r.rolname::text, ', ') into v_bad
    from pg_catalog.pg_roles r
    cross join (
      select n.nspowner as owner from pg_catalog.pg_namespace n where n.nspname = 'tmpos_customer_contact'
      union
      select p.proowner from pg_catalog.pg_proc p where p.pronamespace = 'tmpos_customer_contact'::regnamespace
    ) o
   where r.rolname = any (array['tmpos_app', 'tmpos_audit_writer', 'anon', 'authenticated']::name[])
     and pg_catalog.pg_has_role(r.oid, o.owner, 'MEMBER');
  if v_bad is not null then
    raise exception 'migration 023 refused: % is a member of the owner of schema tmpos_customer_contact or its routines', v_bad
      using errcode = 'object_not_in_prerequisite_state',
            hint = 'membership hands a role everything the owner holds, including a direct read of every customer''s contacts';
  end if;

  -- (i)
  if pg_catalog.to_regprocedure('tmpos_role.m7a_customer_create(text, uuid, text)') is null
     or pg_catalog.to_regprocedure('tmpos_role.m7a_customer_page_v3(text, uuid, integer)') is null
     or pg_catalog.to_regprocedure('tmpos_customer_detail.m7a_customer_get(text, uuid, uuid)') is null then
    raise exception 'migration 023 refused: migration 020''s create or page_v3, or migration 022''s read, is missing'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$$;

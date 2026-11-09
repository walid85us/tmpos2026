-- Phase 4.0 M7b — payment registration (PRQ-1, M7B-PAYMENTS-P2): a durable, per-staff-member unresolved slot that a payment
-- record must name, a commit- and flush-qualified proof that only the database can issue, a version-checked settlement, the
-- staff member's own recovery list, and the owner-installed proof key bound to a non-secret, strictly increasing generation
-- (docs/phase-4/15; design R1-R4 with the owner's overrides).
-- Migration: 037_m7b_invoice_payment_registration (UP)
--
-- SCOPE / TRUTH (binding):
--   - IN SCHEMA tmpos_invoice_payment (036's): THREE TABLES, FOURTEEN FUNCTIONS, SIX TRIGGERS, ONE AUDIT COLUMN WITH ITS INDEX,
--     AND TMPOS_APP LOSES ITS EXECUTE ON 036's m7b_invoice_payment_record (the nine-argument v1, which stays in place,
--     unaltered, for the rollback): a payment can then only be recorded through a registration.
--       * invoice_payment_registration — one row per registered attempt: the runtime's registration id, scope, the derived
--         actor, the client's attempt id, sha256 of the session key, the key generation, the registering top-level
--         transaction (pg_current_xact_id(), never xmin), the database time, then the payment id and the settlement time,
--         each set once. UNIQUE (invoice, tenant, store, registered_by, attempt_id): the attempt is the caller's own; a
--         PARTIAL UNIQUE slot (tenant, store, invoice, registered_by) WHERE acknowledged_at IS NULL: at most one unresolved
--         attempt per staff member per invoice. States, derived: open (both NULL), recorded (payment only), withdrawn
--         (settlement only), confirmed (both). Its ALWAYS guard admits only open inserts and the three transitions.
--       * payment_proof_key — the singleton proof key (32 to 64 bytes) and its non-secret generation, INSTALLED BY THE OWNER
--         OUT OF BAND (018's issuer-key convention), never by a migration; payment_proof_key_generation — every generation
--         ever installed with sha256 of its bytes zero-padded to the 64-byte HMAC block, append-only. The key's ALWAYS
--         BEFORE trigger checks every column with fixed text (no NOT NULL or CHECK failure echoes the bytes); its ALWAYS AFTER
--         trigger refuses a generation not above every earlier one and bytes whose padded digest was ever installed, then
--         records the new generation: a retired key's bytes (zero bytes appended included) are never accepted again, and an
--         old registration's generation is never current again.
--       * the routines (EXECUTE to tmpos_app): m7b_invoice_payment_register, m7b_invoice_payment_registration_proof,
--         m7b_invoice_payment_record_v2, m7b_invoice_payment_attempts, m7b_invoice_payment_settle and
--         m7b_payment_proof_key_probe; granted to nobody: the helpers m7b_payment_writer, m7b_payment_levels_ok and
--         m7b_payment_registration_proof_message and the five trigger functions.
--       * public.audit_event gains subject_invoice_payment_registration_id (nullable, no default) and its partial index.
--   - THE PROOF. HMAC-SHA-256 (018's tmpos_mint.hmac_sha256) under the installed key of a fixed-width message: UTF-8
--     'tmpos-m7b-payment-registration-proof:v1', a NUL byte, the registration, actor, tenant, store, invoice and attempt
--     uuids (16 bytes each, in that order), the 32-byte session digest and the 8-byte generation. Served only by the proof
--     routine, as 64 lowercase hex digits, and only when the registration is COMMITTED (another transaction's, read under
--     READ COMMITTED; the registering transaction, savepoints included, is refused by pg_current_xact_id_if_assigned()),
--     OPEN, of the caller and the caller's current session, under the CURRENT generation, AND DURABLE: after that read the
--     routine samples L := pg_current_wal_insert_lsn(), converts it to end-of-record form only at an exact first usable
--     byte (segment: L - 40 first, then page: L - 24; alignment 8 only, else refused), requires fsync on, and waits at most
--     the caller's p_wait_ms (0 to 1000; 20 ms steps) for pg_current_wal_flush_lsn() >= L_end, else answers ('not_durable',
--     NULLs): no proof, nothing written, and the caller's transaction COMMITS — the xid-less WAL its own reads may have written
--     (a HOT prune) is flushed only once it commits; COMMIT is a transaction boundary, not a flush. The caller may then try
--     once more in a FRESH transaction, under the same rule. The proof is
--     never stored, returned by any other routine, or written to an audit row; the record compares sha256 of the decoded
--     proof with sha256 of the recomputed MAC (018 :341). Every definer that reads the key or a session key runs with
--     #print_strict_params off and debug_print_parse, debug_print_rewritten and debug_print_plan off.
--   - THE RECORD v2 checks the whole scope before any state word or write: the caller's registration of this attempt, this
--     registration id, this session, another (committed) transaction, the current generation and the proof — any mismatch is
--     036's uniform 'not_found'. Then already_recorded (this registration recorded), invalid_state (withdrawn, then voided),
--     amount_exceeds_remaining, invalid_state (the attempt id already taken on the invoice by a payment); else ONE payment, the registration's
--     payment id, and ONE audit record, in one transaction.
--   - KEY UNAVAILABLE: register, proof and record v2 raise (55000, fixed text) before any write; the list, the settlement and
--     the probe never read the key bytes and keep working.
--   - LOCK ORDER (036's): fence -> 016's hold -> session and mint-ledger rows FOR SHARE -> issuer key FOR SHARE -> membership
--     and store row FOR SHARE -> levels (plain) -> THE ISSUED HEADER FOR UPDATE -> key 530030 SHARED -> levels (plain) ->
--     (register, record) the proof key row FOR SHARE -> the session's expiry (after the last lock wait) -> the registration
--     row(s) -> the writes -> the audit insert. Every
--     writer of a registration row holds its invoice's header first. The proof routine and the list take no row lock (the
--     proof routine must not write WAL before it samples L).
--   - APPLY: a maintenance window, the tenant runtime stopped; READ COMMITTED; 036 exactly for what this file revokes and
--     reads; none of this file's objects. ROLLBACK: 037's down refuses while any registration or registration audit record
--     exists (one-way after the first registration); roll 037 back before 036 (036's down then fails on the payment
--     foreign key and the schema's extra objects).
--   - NOT DEFENDED (as 036): direct calls skip idempotency, CSRF and the rate limit (DA-118) but every write is routine-
--     audited; the owner, a superuser, a dump or a replica can read the key; crash durability is claimed for a single
--     primary with fsync on only (D-R4-1): an asynchronous standby failover is outside it.
--   - NO SECRET, NO DYNAMIC SQL, NO EXTENSION, NO TEMPORARY OBJECT, NO BACKFILL. Every name is schema-qualified; every routine
--     and trigger function pins its search_path.
--
-- Reversible via 037_m7b_invoice_payment_registration.down.sql. Assumes 001-036 are applied.

-- =============================================================================
-- 1) This transaction's settings
-- =============================================================================
set local search_path = pg_catalog, pg_temp;
set local row_security = off;

-- =============================================================================
-- 2) The locks, in the writers' order, before any check or change
-- =============================================================================
do $$
begin
  lock table tmpos_invoice_issue.issued_invoice in access exclusive mode;
  lock table tmpos_invoice_void.issued_invoice_void in access exclusive mode;
  lock table tmpos_invoice_payment.invoice_payment in access exclusive mode;
  lock table tmpos_invoice_payment.invoice_payment_reversal in access exclusive mode;
  lock table public.audit_event in access exclusive mode;
exception
  when undefined_table or invalid_schema_name then
    raise exception 'migration 037 refused: 034''s issued invoices, 035''s void records, 036''s payment tables or public.audit_event is missing (migrations 034, 035 and 036 must be applied first)'
      using errcode = 'object_not_in_prerequisite_state';
end
$$;

-- =============================================================================
-- 3) Preconditions
-- =============================================================================
do $$
declare
  v_me     oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user);
  v_record oid;
begin
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'migration 037 refused: it must run under READ COMMITTED, so that its checks see every committed row'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if (select pg_catalog.count(*) from pg_catalog.pg_roles r
       where r.rolname = any (array['tmpos_app', 'tmpos_audit_writer', 'anon', 'authenticated']::name[])) <> 4 then
    raise exception 'migration 037 refused: the runtime roles tmpos_app, tmpos_audit_writer, anon and authenticated must exist'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if pg_catalog.to_regclass('tmpos_invoice_payment.invoice_payment_registration') is not null
     or pg_catalog.to_regclass('tmpos_invoice_payment.payment_proof_key') is not null
     or pg_catalog.to_regclass('tmpos_invoice_payment.payment_proof_key_generation') is not null
     or exists (select 1 from pg_catalog.pg_proc p
                 where p.pronamespace = 'tmpos_invoice_payment'::regnamespace
                   and p.proname in ('m7b_invoice_payment_register', 'm7b_invoice_payment_registration_proof',
                                     'm7b_invoice_payment_record_v2', 'm7b_invoice_payment_attempts', 'm7b_invoice_payment_settle',
                                     'm7b_payment_proof_key_probe', 'm7b_payment_writer', 'm7b_payment_levels_ok',
                                     'm7b_payment_registration_proof_message'))
     or exists (select 1 from pg_catalog.pg_attribute a
                 where a.attrelid = 'public.audit_event'::regclass and a.attname = 'subject_invoice_payment_registration_id'
                   and not a.attisdropped) then
    raise exception 'migration 037 refused: an object of this file already exists'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- 036, exactly, for what this file revokes (its record's ACL must be exactly the owner's and tmpos_app's EXECUTE, so the
  -- revoke is no silent no-op and the rollback's grant restores it byte for byte) and builds on.
  v_record := pg_catalog.to_regprocedure('tmpos_invoice_payment.m7b_invoice_payment_record(text, uuid, uuid, uuid, uuid, uuid, bigint, text, uuid)');
  if v_record is null
     or pg_catalog.to_regclass('tmpos_invoice_payment.invoice_payment_scope_key') is null
     or pg_catalog.to_regclass('tmpos_invoice_issue.issued_invoice_scope_key') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_issue.m7b_issue_store_reader(text, uuid, uuid, boolean, text)') is null
     or pg_catalog.to_regprocedure('tmpos_mint.hmac_sha256(bytea, bytea)') is null
     or pg_catalog.to_regprocedure('tmpos_session.m5_hold_tenant_standing(text, text)') is null
     or pg_catalog.to_regprocedure('tmpos_session.m5_admit_tenant_session_v2(text, text)') is null
     or not exists (select 1 from pg_catalog.pg_namespace n where n.oid = 'tmpos_invoice_payment'::regnamespace and n.nspowner = v_me)
     or (select pg_catalog.count(*)
           from pg_catalog.pg_proc p, pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g
          where p.oid = v_record) <> 2
     or (select pg_catalog.count(*)
           from pg_catalog.pg_proc p, pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g
          where p.oid = v_record and g.privilege_type = 'EXECUTE' and not g.is_grantable and g.grantor = p.proowner
            and g.grantee in (p.proowner, 'tmpos_app'::regrole)) <> 2 then
    raise exception 'migration 037 refused: migration 036 is not applied exactly (its record and its ACL, its payment scope key, or schema tmpos_invoice_payment owned by the applying principal), or 034''s store reader, 018''s HMAC or 016''s hold or admission read is missing'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if not (pg_catalog.has_function_privilege(current_user, 'tmpos_session.m5_hold_tenant_standing(text, text)', 'EXECUTE')
          and pg_catalog.has_function_privilege(current_user, 'tmpos_session.m5_admit_tenant_session_v2(text, text)', 'EXECUTE')
          and pg_catalog.has_function_privilege(current_user, 'tmpos_invoice_issue.m7b_issue_store_reader(text, uuid, uuid, boolean, text)', 'EXECUTE')
          and pg_catalog.has_function_privilege(current_user, 'tmpos_mint.hmac_sha256(bytea, bytea)', 'EXECUTE')
          and pg_catalog.has_function_privilege(current_user, 'pg_catalog.pg_control_init()', 'EXECUTE')
          and pg_catalog.has_function_privilege(current_user, 'pg_catalog.pg_current_wal_insert_lsn()', 'EXECUTE')
          and pg_catalog.has_function_privilege(current_user, 'pg_catalog.pg_current_wal_flush_lsn()', 'EXECUTE')
          and pg_catalog.has_schema_privilege(current_user, 'tmpos_session', 'USAGE')
          and pg_catalog.has_schema_privilege(current_user, 'tmpos_mint', 'USAGE')
          and pg_catalog.has_schema_privilege(current_user, 'tmpos_role', 'USAGE')
          and pg_catalog.has_schema_privilege(current_user, 'tmpos_invoice_issue', 'USAGE')
          and pg_catalog.has_schema_privilege(current_user, 'tmpos_invoice_void', 'USAGE')
          and pg_catalog.has_table_privilege(current_user, 'public.audit_event', 'INSERT')
          and pg_catalog.has_table_privilege(current_user, 'public.audit_event', 'SELECT')) then
    raise exception 'migration 037 refused: the applying principal cannot execute 016''s hold and admission read, 034''s store reader, 018''s HMAC or the WAL position and control functions, use the schemas they read, or insert into and read public.audit_event'
      using errcode = 'insufficient_privilege';
  end if;
  if exists (
    select 1
      from pg_catalog.pg_class c
     where c.oid = any (array['tmpos_session.session'::regclass, 'tmpos_mint.tenant_session'::regclass,
                              'tmpos_mint.issuer_key'::regclass, 'tmpos_role.tenant_role_level'::regclass,
                              'public.store'::regclass, 'public.user_membership'::regclass,
                              'tmpos_invoice_issue.issued_invoice'::regclass, 'tmpos_invoice_void.issued_invoice_void'::regclass,
                              'tmpos_invoice_payment.invoice_payment'::regclass,
                              'tmpos_invoice_payment.invoice_payment_reversal'::regclass, 'public.audit_event'::regclass])
       and (not pg_catalog.pg_has_role(current_user, c.relowner, 'USAGE') or c.relforcerowsecurity)) then
    raise exception 'migration 037 refused: the applying principal neither owns nor inherits the owner of a table the definers read, lock or insert into, or one has forced row security'
      using errcode = 'insufficient_privilege';
  end if;
end
$$;

-- =============================================================================
-- 4) The tables
-- =============================================================================
create table tmpos_invoice_payment.invoice_payment_registration (
  registration_id uuid        not null,
  tenant_id       uuid        not null,
  store_id        uuid        not null,
  invoice_id      uuid        not null,
  registered_by   uuid        not null,
  attempt_id      uuid        not null,
  session_digest  bytea       not null,
  key_generation  bigint      not null,
  registered_xact xid8        not null,
  registered_at   timestamptz not null,
  payment_id      uuid,
  acknowledged_at timestamptz,
  constraint invoice_payment_registration_pkey primary key (registration_id),
  -- The attempt is the caller's own: another staff member's attempt id registers exactly as a fresh one (R2 §2).
  constraint invoice_payment_registration_attempt_key unique (invoice_id, tenant_id, store_id, registered_by, attempt_id),
  -- A payment settles at most one registration.
  constraint invoice_payment_registration_payment_key unique (payment_id),
  constraint invoice_payment_registration_invoice_fkey foreign key (invoice_id, tenant_id, store_id)
    references tmpos_invoice_issue.issued_invoice (invoice_id, tenant_id, store_id) on delete restrict on update restrict,
  constraint invoice_payment_registration_payment_fkey foreign key (payment_id, invoice_id, tenant_id, store_id)
    references tmpos_invoice_payment.invoice_payment (payment_id, invoice_id, tenant_id, store_id) on delete restrict on update restrict,
  constraint invoice_payment_registration_session_digest_chk check (pg_catalog.octet_length(session_digest) = 32),
  constraint invoice_payment_registration_key_generation_chk check (key_generation between 1 and 9007199254740991)
);

-- The durable unresolved slot: at most one unsettled (open or recorded-unconfirmed) registration per staff member per invoice.
create unique index invoice_payment_registration_slot_key
  on tmpos_invoice_payment.invoice_payment_registration (tenant_id, store_id, invoice_id, registered_by)
  where acknowledged_at is null;
-- The staff member's list, in its keyset order.
create index invoice_payment_registration_list_idx
  on tmpos_invoice_payment.invoice_payment_registration (tenant_id, store_id, registered_by, registered_at, invoice_id, attempt_id);

comment on table tmpos_invoice_payment.invoice_payment_registration is
  'Phase 4.0 M7b (migration 037): one row per registered payment attempt of one staff member on one issued invoice — the runtime''s registration id, scope, the derived actor, the client''s attempt id, sha256 of the session key, the proof key generation, the registering top-level transaction and time; then the payment id and the settlement time, each set once. States: open, recorded, withdrawn, confirmed. Unique per (invoice, tenant, store, actor, attempt); at most one unsettled row per (tenant, store, invoice, actor). Written only by 037''s register, record v2 and settle. No amount, key, proof, body or card field. No runtime role holds a privilege on it.';
comment on column tmpos_invoice_payment.invoice_payment_registration.session_digest is
  'Phase 4.0 M7b (migration 037): sha256 of the registering session key (itself a digest, never a credential). Never returned.';
comment on column tmpos_invoice_payment.invoice_payment_registration.registered_xact is
  'Phase 4.0 M7b (migration 037): pg_current_xact_id() of the registering top-level transaction (never xmin, which is a subtransaction''s inside a savepoint): the proof and the record refuse inside it.';

create table tmpos_invoice_payment.payment_proof_key (
  singleton  boolean not null default true
             constraint payment_proof_key_pkey primary key
             constraint payment_proof_key_singleton_chk check (singleton),
  key        bytea   not null
             constraint payment_proof_key_length_chk check (pg_catalog.octet_length(key) between 32 and 64),
  generation bigint  not null
             constraint payment_proof_key_generation_chk check (generation between 1 and 9007199254740991)
);

comment on table tmpos_invoice_payment.payment_proof_key is
  'Phase 4.0 M7b (migration 037): the payment registration proof key — at most one row, 32-64 bytes, and its non-secret generation; installed, rotated and removed by the owner out of band (018''s issuer-key convention), never by a migration. A generation must exceed every earlier one and bytes ever installed are never accepted again (trg_payment_proof_key_install). No runtime role holds a privilege on it.';

create table tmpos_invoice_payment.payment_proof_key_generation (
  generation   bigint      not null
               constraint payment_proof_key_generation_pkey primary key,
  key_digest   bytea       not null
               constraint payment_proof_key_generation_digest_key unique
               constraint payment_proof_key_generation_digest_chk check (pg_catalog.octet_length(key_digest) = 32),
  installed_at timestamptz not null
);

comment on table tmpos_invoice_payment.payment_proof_key_generation is
  'Phase 4.0 M7b (migration 037): append-only — every proof key generation ever installed with sha256 of its bytes zero-padded to the 64-byte HMAC block and the time; the high-water mark and the retired-key list the key''s install trigger checks. Never updated, deleted or truncated. No runtime role holds a privilege on it.';

alter table tmpos_invoice_payment.invoice_payment_registration enable row level security;
alter table tmpos_invoice_payment.payment_proof_key enable row level security;
alter table tmpos_invoice_payment.payment_proof_key_generation enable row level security;
revoke all on table tmpos_invoice_payment.invoice_payment_registration from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
revoke all on table tmpos_invoice_payment.payment_proof_key from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
revoke all on table tmpos_invoice_payment.payment_proof_key_generation from public, anon, authenticated, tmpos_app, tmpos_audit_writer;

-- =============================================================================
-- 5) The guards (SECURITY INVOKER, granted to nobody, ENABLE ALWAYS)
-- =============================================================================
create function tmpos_invoice_payment.m7b_invoice_payment_registration_guard()
returns trigger
language plpgsql
volatile
security invoker
set search_path = pg_catalog, pg_temp
set row_security = off
as $$
begin
  if tg_when is distinct from 'BEFORE' or tg_level is distinct from 'ROW'
     or tg_op not in ('INSERT', 'UPDATE', 'DELETE')
     or tg_table_schema is distinct from 'tmpos_invoice_payment' or tg_table_name is distinct from 'invoice_payment_registration' then
    raise exception 'm7b_invoice_payment_registration_guard: fired by an undeclared trigger'
      using errcode = 'triggered_action_exception';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'migration 037: a payment registration is never deleted'
      using errcode = 'restrict_violation';
  end if;
  if tg_op = 'INSERT' then
    -- Every mandatory column here, with a fixed message: no NOT NULL or CHECK failure may echo the row (the session digest).
    if new.registration_id is null or new.tenant_id is null or new.store_id is null or new.invoice_id is null
       or new.registered_by is null or new.attempt_id is null or new.registered_xact is null or new.registered_at is null
       or new.session_digest is null or pg_catalog.octet_length(new.session_digest) <> 32
       or new.key_generation is null or new.key_generation not between 1 and 9007199254740991 then
      raise exception 'migration 037: a payment registration carries every mandatory column, a 32-byte session digest and a generation in range'
        using errcode = 'restrict_violation';
    end if;
    if new.payment_id is not null or new.acknowledged_at is not null then
      raise exception 'migration 037: a payment registration is inserted open'
        using errcode = 'restrict_violation';
    end if;
    -- Checked here too because a replica session skips the foreign key's trigger.
    if not exists (select 1 from tmpos_invoice_issue.issued_invoice i
                    where i.invoice_id = new.invoice_id and i.tenant_id = new.tenant_id and i.store_id = new.store_id) then
      raise exception 'migration 037: a payment registration names an issued invoice of its own tenant and store'
        using errcode = 'restrict_violation';
    end if;
    return new;
  end if;
  if (new.registration_id, new.tenant_id, new.store_id, new.invoice_id, new.registered_by, new.attempt_id, new.session_digest,
      new.key_generation, new.registered_xact, new.registered_at)
     is distinct from
     (old.registration_id, old.tenant_id, old.store_id, old.invoice_id, old.registered_by, old.attempt_id, old.session_digest,
      old.key_generation, old.registered_xact, old.registered_at) then
    raise exception 'migration 037: only a payment registration''s payment and settlement ever change'
      using errcode = 'restrict_violation';
  end if;
  if old.payment_id is null and old.acknowledged_at is null and new.payment_id is not null and new.acknowledged_at is null then
    -- open -> recorded: the payment is this registration's own — same scope, same attempt, recorded by the same actor.
    if not exists (select 1 from tmpos_invoice_payment.invoice_payment p
                    where p.payment_id = new.payment_id and p.invoice_id = new.invoice_id and p.tenant_id = new.tenant_id
                      and p.store_id = new.store_id and p.attempt_id = new.attempt_id and p.recorded_by = new.registered_by) then
      raise exception 'migration 037: a payment registration records only its own attempt''s payment'
        using errcode = 'restrict_violation';
    end if;
    return new;
  end if;
  if old.acknowledged_at is null and new.acknowledged_at is not null and new.payment_id is not distinct from old.payment_id then
    -- open -> withdrawn, or recorded -> confirmed.
    if new.acknowledged_at < old.registered_at then
      raise exception 'migration 037: a payment registration is settled at or after its registration'
        using errcode = 'restrict_violation';
    end if;
    return new;
  end if;
  raise exception 'migration 037: a payment registration moves only open to recorded, open to withdrawn or recorded to confirmed'
    using errcode = 'restrict_violation';
end
$$;

comment on function tmpos_invoice_payment.m7b_invoice_payment_registration_guard() is
  'Phase 4.0 M7b (migration 037): BEFORE INSERT OR UPDATE OR DELETE row trigger on invoice_payment_registration (enabled ALWAYS). Refuses (restrict_violation, fixed message) every delete; an insert missing a mandatory column, with a session digest not 32 bytes or a generation out of range (so no NOT NULL or CHECK failure echoes the row), or not open, or not naming an issued invoice of its scope; an update that changes anything but payment_id and acknowledged_at, or that is not open -> recorded (its own attempt''s payment, same scope and actor), open -> withdrawn or recorded -> confirmed (settled at or after registration). triggered_action_exception for any other firing. Granted to nobody.';

create function tmpos_invoice_payment.m7b_invoice_payment_registration_truncate_guard()
returns trigger
language plpgsql
volatile
security invoker
set search_path = pg_catalog, pg_temp
as $$
begin
  if tg_when is distinct from 'BEFORE' or tg_level is distinct from 'STATEMENT' or tg_op is distinct from 'TRUNCATE'
     or tg_table_schema is distinct from 'tmpos_invoice_payment' or tg_table_name is distinct from 'invoice_payment_registration' then
    raise exception 'm7b_invoice_payment_registration_truncate_guard: fired by an undeclared trigger'
      using errcode = 'triggered_action_exception';
  end if;
  raise exception 'migration 037: payment registrations are never truncated'
    using errcode = 'restrict_violation';
end
$$;

comment on function tmpos_invoice_payment.m7b_invoice_payment_registration_truncate_guard() is
  'Phase 4.0 M7b (migration 037): BEFORE TRUNCATE statement trigger on invoice_payment_registration (enabled ALWAYS); always raises restrict_violation. Granted to nobody.';

-- AFTER, so an owner's upsert fires it once, for the row actually written; it raises to undo the statement. Installs serialize
-- on the history table's SHARE ROW EXCLUSIVE lock, so the high-water read sees every committed install.
create function tmpos_invoice_payment.m7b_payment_proof_key_install_guard()
returns trigger
language plpgsql
volatile
security invoker
set search_path = pg_catalog, pg_temp
set row_security = off
set debug_print_parse = off
set debug_print_rewritten = off
set debug_print_plan = off
as $$
#print_strict_params off
declare
  v_high   bigint;
  v_digest bytea;
begin
  if tg_when is distinct from 'AFTER' or tg_level is distinct from 'ROW' or tg_op not in ('INSERT', 'UPDATE')
     or tg_table_schema is distinct from 'tmpos_invoice_payment' or tg_table_name is distinct from 'payment_proof_key' then
    raise exception 'm7b_payment_proof_key_install_guard: fired by an undeclared trigger'
      using errcode = 'triggered_action_exception';
  end if;
  lock table tmpos_invoice_payment.payment_proof_key_generation in share row exclusive mode;
  select pg_catalog.max(g.generation) into v_high from tmpos_invoice_payment.payment_proof_key_generation g;
  if new.generation <= coalesce(v_high, 0) then
    raise exception 'migration 037: a payment proof key is installed only under a generation above every earlier one'
      using errcode = 'restrict_violation';
  end if;
  -- Over the 64-byte zero-padded HMAC block (018's hmac_sha256 pads, 018:202): the same key with zero bytes appended is the same key.
  v_digest := pg_catalog.sha256(new.key || pg_catalog.decode(pg_catalog.repeat('00', 64 - pg_catalog.octet_length(new.key)), 'hex'));
  if exists (select 1 from tmpos_invoice_payment.payment_proof_key_generation g where g.key_digest = v_digest) then
    raise exception 'migration 037: a payment proof key that was ever installed is never installed again'
      using errcode = 'restrict_violation';
  end if;
  insert into tmpos_invoice_payment.payment_proof_key_generation (generation, key_digest, installed_at)
  values (new.generation, v_digest, pg_catalog.clock_timestamp());
  return null;
end
$$;

comment on function tmpos_invoice_payment.m7b_payment_proof_key_install_guard() is
  'Phase 4.0 M7b (migration 037): AFTER INSERT OR UPDATE row trigger on payment_proof_key (enabled ALWAYS). Under a SHARE ROW EXCLUSIVE lock on payment_proof_key_generation, refuses (restrict_violation, fixed message) a generation not above every generation ever installed and key bytes whose sha256 was ever installed, then records (generation, sha256 of the key zero-padded to the 64-byte HMAC block, time) — so the same bytes with zero bytes appended, the same HMAC key, are refused too. Removing the key is not guarded: it makes register, proof and record fail closed. Granted to nobody.';

-- BEFORE, so it runs ahead of every NOT NULL and CHECK constraint: a failing constraint's DETAIL would echo the row, the key.
create function tmpos_invoice_payment.m7b_payment_proof_key_shape_guard()
returns trigger
language plpgsql
volatile
security invoker
set search_path = pg_catalog, pg_temp
set row_security = off
set debug_print_parse = off
set debug_print_rewritten = off
set debug_print_plan = off
as $$
#print_strict_params off
begin
  if tg_when is distinct from 'BEFORE' or tg_level is distinct from 'ROW' or tg_op not in ('INSERT', 'UPDATE')
     or tg_table_schema is distinct from 'tmpos_invoice_payment' or tg_table_name is distinct from 'payment_proof_key' then
    raise exception 'm7b_payment_proof_key_shape_guard: fired by an undeclared trigger'
      using errcode = 'triggered_action_exception';
  end if;
  if new.singleton is distinct from true
     or new.key is null or pg_catalog.octet_length(new.key) not between 32 and 64
     or new.generation is null or new.generation not between 1 and 9007199254740991 then
    raise exception 'migration 037: a payment proof key is the one row, 32 to 64 bytes, under a generation from 1 to 2^53 - 1'
      using errcode = 'restrict_violation';
  end if;
  return new;
end
$$;

comment on function tmpos_invoice_payment.m7b_payment_proof_key_shape_guard() is
  'Phase 4.0 M7b (migration 037): BEFORE INSERT OR UPDATE row trigger on payment_proof_key (enabled ALWAYS). Refuses (restrict_violation, fixed message, no value) a row that is not the singleton, a key that is missing or not 32 to 64 bytes, and a generation that is missing or not 1 to 2^53 - 1, before any NOT NULL or CHECK constraint could echo the row. Granted to nobody.';

create function tmpos_invoice_payment.m7b_payment_proof_key_generation_guard()
returns trigger
language plpgsql
volatile
security invoker
set search_path = pg_catalog, pg_temp
as $$
begin
  if tg_when is distinct from 'BEFORE' or tg_op not in ('UPDATE', 'DELETE', 'TRUNCATE')
     or tg_table_schema is distinct from 'tmpos_invoice_payment' or tg_table_name is distinct from 'payment_proof_key_generation' then
    raise exception 'm7b_payment_proof_key_generation_guard: fired by an undeclared trigger'
      using errcode = 'triggered_action_exception';
  end if;
  raise exception 'migration 037: an installed payment proof key generation is never changed or removed'
    using errcode = 'restrict_violation';
end
$$;

comment on function tmpos_invoice_payment.m7b_payment_proof_key_generation_guard() is
  'Phase 4.0 M7b (migration 037): BEFORE UPDATE OR DELETE row trigger and BEFORE TRUNCATE statement trigger on payment_proof_key_generation (enabled ALWAYS); always raises restrict_violation. Granted to nobody.';

create trigger trg_invoice_payment_registration_guard
  before insert or update or delete on tmpos_invoice_payment.invoice_payment_registration
  for each row execute function tmpos_invoice_payment.m7b_invoice_payment_registration_guard();
alter table tmpos_invoice_payment.invoice_payment_registration enable always trigger trg_invoice_payment_registration_guard;
create trigger trg_invoice_payment_registration_truncate
  before truncate on tmpos_invoice_payment.invoice_payment_registration
  for each statement execute function tmpos_invoice_payment.m7b_invoice_payment_registration_truncate_guard();
alter table tmpos_invoice_payment.invoice_payment_registration enable always trigger trg_invoice_payment_registration_truncate;
create trigger trg_payment_proof_key_shape
  before insert or update on tmpos_invoice_payment.payment_proof_key
  for each row execute function tmpos_invoice_payment.m7b_payment_proof_key_shape_guard();
alter table tmpos_invoice_payment.payment_proof_key enable always trigger trg_payment_proof_key_shape;
create trigger trg_payment_proof_key_install
  after insert or update on tmpos_invoice_payment.payment_proof_key
  for each row execute function tmpos_invoice_payment.m7b_payment_proof_key_install_guard();
alter table tmpos_invoice_payment.payment_proof_key enable always trigger trg_payment_proof_key_install;
create trigger trg_payment_proof_key_generation_guard
  before update or delete on tmpos_invoice_payment.payment_proof_key_generation
  for each row execute function tmpos_invoice_payment.m7b_payment_proof_key_generation_guard();
alter table tmpos_invoice_payment.payment_proof_key_generation enable always trigger trg_payment_proof_key_generation_guard;
create trigger trg_payment_proof_key_generation_truncate
  before truncate on tmpos_invoice_payment.payment_proof_key_generation
  for each statement execute function tmpos_invoice_payment.m7b_payment_proof_key_generation_guard();
alter table tmpos_invoice_payment.payment_proof_key_generation enable always trigger trg_payment_proof_key_generation_truncate;

-- =============================================================================
-- 6) The audit record's registration subject (public.audit_event)
-- =============================================================================
alter table public.audit_event
  add column subject_invoice_payment_registration_id uuid;

comment on column public.audit_event.subject_invoice_payment_registration_id is
  'Phase 4.0 M7b (migration 037): the payment registration the action registered, recorded against or settled. Written by 037''s register, record v2 and settle routines themselves, in the same transaction as the change, never from request metadata. Plain column, no FK.';

create index idx_audit_event_subject_invoice_payment_registration_occurred
  on public.audit_event (subject_invoice_payment_registration_id, occurred_at desc)
  where subject_invoice_payment_registration_id is not null;

-- =============================================================================
-- 7) The helpers (granted to nobody; not definers)
-- =============================================================================
-- 036's record, steps 1 and 2, statement for statement (016's hold, the session, mint-ledger, issuer-key and store rows FOR
-- SHARE, EXACTLY ONE store grant at p_store_id, still its active membership, the levels read UNLOCKED): one row (tenant,
-- actor, membership, role, session expiry) when admitted, NO ROW otherwise. The caller still checks expectedTenant, locks
-- the header, takes key 530030 and re-reads the levels (m7b_payment_levels_ok), then the session expiry.
create function tmpos_invoice_payment.m7b_payment_writer(p_session_key text, p_store_id uuid)
returns table (o_tenant_id uuid, o_actor_id uuid, o_membership_id uuid, o_role text, o_expires_at bigint)
language plpgsql
volatile
security invoker
set search_path = pg_catalog, pg_temp
set row_security = off
as $$
#print_strict_params off
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
  v_store          record;
begin
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
     or v_admission.account_status not in ('active', 'trialing')
     or pg_catalog.jsonb_typeof(v_admission.memberships) is distinct from 'array' then
    return;
  end if;
  select pg_catalog.jsonb_agg(e.entry) into v_grants
    from pg_catalog.jsonb_array_elements(v_admission.memberships) as e(entry)
   where e.entry ->> 'scopeType' = 'store'
     and e.entry ->> 'storeId' = p_store_id::text;
  if v_grants is null
     or pg_catalog.jsonb_array_length(v_grants) <> 1
     or (v_grants -> 0 ->> 'tenantId') is null
     or (v_grants -> 0 ->> 'membershipId') is null
     or (v_grants -> 0 ->> 'roleId') is null
     or (v_grants -> 0 ->> 'tenantStatus') is null
     or (v_grants -> 0 ->> 'tenantStatus') not in ('active', 'trialing')
     or (v_grants -> 0 ->> 'storeStatus') is null
     or (v_grants -> 0 ->> 'storeStatus') not in ('active', 'trialing') then
    return;
  end if;
  v_role := v_grants -> 0 ->> 'roleId';
  v_tenant := (v_grants -> 0 ->> 'tenantId')::uuid;
  v_membership := (v_grants -> 0 ->> 'membershipId')::uuid;
  if not exists (
    select 1
      from public.user_membership um
     where um.membership_id = v_membership
       and um.internal_user_id = v_admission.actor_id
       and um.status = 'active'
       and um.scope_type = 'store'
       and um.tenant_id = v_tenant
       and um.store_id = p_store_id
       and um.role_id = v_role) then
    return;
  end if;
  select st.tenant_id, st.status into v_store
    from public.store st
   where st.store_id = p_store_id
     for share;
  if not found
     or v_store.tenant_id is distinct from v_tenant
     or v_store.status is null
     or v_store.status not in ('active', 'trialing') then
    return;
  end if;
  if not (v_role = 'store_owner' or tmpos_invoice_payment.m7b_payment_levels_ok(v_tenant, v_role)) then
    return;
  end if;
  return query select v_tenant, v_admission.actor_id, v_membership, v_role, v_session.expires_at;
end
$$;

comment on function tmpos_invoice_payment.m7b_payment_writer(text, uuid) is
  'Phase 4.0 M7b (migration 037): 036''s record caller derivation (steps 1 and 2) for 037''s writes: one row (tenant, actor, membership, role, session expiry) for a ledger-minted, live tenant session under the installed issuer key, 016''s hold, an unchanged standing, an active or trialing account, EXACTLY ONE store grant at p_store_id on an active or trialing tenant and store, still its active membership, the store row FOR SHARE, and Invoices >= Approve AND Customers >= View (store_owner Full) read unlocked; no row otherwise. Granted to nobody.';

-- The levels, PLAIN reads: an editable role's Invoices at Approve or above AND Customers at View or above (stored, else the
-- catalog default); any other role is false (store_owner is Full and never asks).
create function tmpos_invoice_payment.m7b_payment_levels_ok(p_tenant uuid, p_role text)
returns boolean
language plpgsql
stable
security invoker
set search_path = pg_catalog, pg_temp
set row_security = off
as $$
declare
  c_levels    constant text[] := array['none', 'view', 'create', 'edit', 'manage', 'approve', 'full'];
  v_invoices  text;
  v_customers text;
begin
  if p_role is null or p_role not in ('manager', 'technician', 'sales_staff') then
    return false;
  end if;
  select l.level into v_invoices
    from tmpos_role.tenant_role_level l
   where l.tenant_id = p_tenant and l.role_id = p_role and l.domain = 'invoices';
  select l.level into v_customers
    from tmpos_role.tenant_role_level l
   where l.tenant_id = p_tenant and l.role_id = p_role and l.domain = 'customers';
  return coalesce(pg_catalog.array_position(c_levels,
           coalesce(v_invoices, case p_role when 'manager' then 'full' when 'technician' then 'view' when 'sales_staff' then 'create' end)), 0)
         >= pg_catalog.array_position(c_levels, 'approve')
     and coalesce(pg_catalog.array_position(c_levels,
           coalesce(v_customers, case p_role when 'manager' then 'full' when 'technician' then 'view' when 'sales_staff' then 'create' end)), 0)
         >= pg_catalog.array_position(c_levels, 'view');
end
$$;

comment on function tmpos_invoice_payment.m7b_payment_levels_ok(uuid, text) is
  'Phase 4.0 M7b (migration 037): true when an editable role''s Invoices level is Approve or above AND its Customers level View or above (stored, else the catalog default: manager full, technician view, sales_staff create); false for any other role. Plain reads. Granted to nobody.';

-- The proof message: fixed-width fields after a versioned prefix and a NUL, so it cannot be read two ways.
create function tmpos_invoice_payment.m7b_payment_registration_proof_message(
  p_registration_id uuid, p_actor_id uuid, p_tenant_id uuid, p_store_id uuid, p_invoice_id uuid, p_attempt_id uuid,
  p_session_digest bytea, p_generation bigint)
returns bytea
language sql
immutable
strict
security invoker
set search_path = pg_catalog, pg_temp
as $$
  select pg_catalog.convert_to('tmpos-m7b-payment-registration-proof:v1', 'UTF8') operator(pg_catalog.||) pg_catalog.decode('00', 'hex')
         operator(pg_catalog.||) pg_catalog.uuid_send(p_registration_id) operator(pg_catalog.||) pg_catalog.uuid_send(p_actor_id)
         operator(pg_catalog.||) pg_catalog.uuid_send(p_tenant_id) operator(pg_catalog.||) pg_catalog.uuid_send(p_store_id)
         operator(pg_catalog.||) pg_catalog.uuid_send(p_invoice_id) operator(pg_catalog.||) pg_catalog.uuid_send(p_attempt_id)
         operator(pg_catalog.||) p_session_digest operator(pg_catalog.||) pg_catalog.int8send(p_generation)
   where pg_catalog.octet_length(p_session_digest) = 32
$$;

comment on function tmpos_invoice_payment.m7b_payment_registration_proof_message(uuid, uuid, uuid, uuid, uuid, uuid, bytea, bigint) is
  'Phase 4.0 M7b (migration 037): the proof message — UTF-8 ''tmpos-m7b-payment-registration-proof:v1'', a NUL, the registration, actor, tenant, store, invoice and attempt uuids (uuid_send, 16 bytes each), the 32-byte session digest and the generation (int8send); NULL for a NULL argument or a digest of another length. Granted to nobody.';

-- =============================================================================
-- 8) Register
-- =============================================================================
create function tmpos_invoice_payment.m7b_invoice_payment_register(
  p_session_key text, p_store_id uuid, p_invoice_id uuid, p_expected_tenant uuid, p_registration_id uuid, p_attempt_id uuid,
  p_correlation_id uuid)
returns table (
  o_outcome         text,
  o_tenant_id       uuid,
  o_store_id        uuid,
  o_actor_id        uuid,
  o_membership_id   uuid,
  o_registration_id uuid,
  o_invoice_id      uuid,
  o_audit_event_id  uuid
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set row_security = off
set debug_print_parse = off
set debug_print_rewritten = off
set debug_print_plan = off
as $$
#print_strict_params off
declare
  v_tenant     uuid;
  v_actor      uuid;
  v_membership uuid;
  v_role       text;
  v_expires    bigint;
  v_now        bigint;
  v_generation bigint;
  v_clock      timestamptz;
  v_written    integer;
  v_event      uuid;
begin
  -- 0. Every argument, before anything is read. A refusal carries a fixed message, never the value.
  if p_session_key is null or p_session_key !~ '^[\x21-\x7e]{1,128}$'
     or p_store_id is null or p_invoice_id is null or p_expected_tenant is null
     or p_registration_id is null or p_attempt_id is null then
    raise exception 'migration 037 register: an argument is malformed'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_correlation_id is null or p_correlation_id::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception 'migration 037 register: the correlation id is not a version-4 uuid'
      using errcode = 'invalid_parameter_value';
  end if;
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'migration 037 register: it must run under READ COMMITTED, so that its checks see what committed before its locks'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- 1-2. The caller (036's derivation).
  select w.o_tenant_id, w.o_actor_id, w.o_membership_id, w.o_role, w.o_expires_at
    into v_tenant, v_actor, v_membership, v_role, v_expires
    from tmpos_invoice_payment.m7b_payment_writer(p_session_key, p_store_id) w;
  if not found then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;
  -- 3. expectedTenant, a precondition only.
  if v_tenant is distinct from p_expected_tenant then
    return query select 'tenant_mismatch'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;
  -- 4. THE ISSUED HEADER FOR UPDATE: every writer of this invoice's registrations and payments serializes here.
  perform 1 from tmpos_invoice_issue.issued_invoice i
   where i.invoice_id = p_invoice_id and i.tenant_id = v_tenant and i.store_id = p_store_id
     for update;
  if not found then
    return query select 'not_found'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;
  -- 5. Key 530030 SHARED until COMMIT, then the levels again (outermost block: an aborted subtransaction would release it).
  if v_role <> 'store_owner' then
    perform pg_catalog.pg_advisory_xact_lock_shared(530030, pg_catalog.hashtext(v_tenant::text || '/' || v_role));
    if not tmpos_invoice_payment.m7b_payment_levels_ok(v_tenant, v_role) then
      return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid;
      return;
    end if;
  end if;
  -- 6. The proof key's generation, FOR SHARE until COMMIT (a rotation waits): no key, no registration (fail closed).
  select k.generation into v_generation from tmpos_invoice_payment.payment_proof_key k where k.singleton for share;
  if v_generation is null then
    raise exception 'migration 037 register: the payment proof key is not installed'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- 7. After the last lock wait (the key's FOR SHARE above): the session's expiry.
  v_now := pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp()) * 1000)::bigint;
  if v_now >= v_expires then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;
  -- 8. SEPARATE STATEMENTS on the caller's own rows only, in order.
  if exists (select 1 from tmpos_invoice_payment.invoice_payment_registration g
              where g.invoice_id = p_invoice_id and g.tenant_id = v_tenant and g.store_id = p_store_id
                and g.registered_by = v_actor and g.attempt_id = p_attempt_id and g.payment_id is not null) then
    return query select 'already_recorded'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;
  if exists (select 1 from tmpos_invoice_payment.invoice_payment_registration g
              where g.invoice_id = p_invoice_id and g.tenant_id = v_tenant and g.store_id = p_store_id
                and g.registered_by = v_actor and g.acknowledged_at is null) then
    return query select 'conflict'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;
  if exists (select 1 from tmpos_invoice_payment.invoice_payment_registration g
              where g.invoice_id = p_invoice_id and g.tenant_id = v_tenant and g.store_id = p_store_id
                and g.registered_by = v_actor and g.attempt_id = p_attempt_id) then
    return query select 'invalid_state'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;
  if exists (select 1 from tmpos_invoice_void.issued_invoice_void v where v.invoice_id = p_invoice_id) then
    return query select 'invalid_state'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;

  -- 9. The registration, open, bound to this session, this generation and THIS top-level transaction.
  v_clock := pg_catalog.clock_timestamp();
  begin
    insert into tmpos_invoice_payment.invoice_payment_registration
      (registration_id, tenant_id, store_id, invoice_id, registered_by, attempt_id, session_digest, key_generation,
       registered_xact, registered_at)
    values (p_registration_id, v_tenant, p_store_id, p_invoice_id, v_actor, p_attempt_id,
            pg_catalog.sha256(pg_catalog.convert_to(p_session_key, 'UTF8')), v_generation, pg_catalog.pg_current_xact_id(), v_clock);
    get diagnostics v_written = row_count;
  exception
    when unique_violation or check_violation or foreign_key_violation or not_null_violation or restrict_violation then
      raise exception 'migration 037 register: the registration is not one the registration table admits'
        using errcode = 'integrity_constraint_violation';
  end;
  if v_written is distinct from 1
     or not exists (select 1 from tmpos_invoice_payment.invoice_payment_registration g
                     where g.registration_id = p_registration_id and g.tenant_id = v_tenant and g.store_id = p_store_id
                       and g.invoice_id = p_invoice_id and g.registered_by = v_actor and g.attempt_id = p_attempt_id
                       and g.key_generation = v_generation and g.registered_at = v_clock
                       and g.payment_id is null and g.acknowledged_at is null) then
    raise exception 'migration 037 register: the registration was not written as judged'
      using errcode = 'no_data_found';
  end if;

  -- 10. ONE audit record, read back.
  v_event := null;
  begin
    insert into public.audit_event
      (request_id, trace_id, actor_internal_user_id, actor_auth_provider, on_behalf_of_internal_user_id, scope_type, tenant_id,
       store_id, action_id, required_permission, decision, reason_code, human_readable_reason, result_status, source_of_truth,
       evaluated_by, evidence_level, metadata, subject_invoice_payment_registration_id)
    values (p_correlation_id::text, null, v_actor, null, null, 'store', v_tenant, p_store_id,
            'store.invoice_payment.register', 'record_invoice_payments', 'allow', 'invoice_payment_attempt_registered',
            'Payment attempt registered against an issued invoice.',
            'succeeded', 'invoice_payment_routine', 'm7b_invoice_payment_routine@v2', 'durable_compliance_event', '{}'::jsonb,
            p_registration_id)
    returning event_id into v_event;
    get diagnostics v_written = row_count;
  exception
    when unique_violation or check_violation or foreign_key_violation or not_null_violation or restrict_violation then
      raise exception 'migration 037 register: the audit record is not one the audit table admits'
        using errcode = 'integrity_constraint_violation';
  end;
  if v_written is distinct from 1 or v_event is null
     or not exists (select 1 from public.audit_event a
                     where a.event_id = v_event and a.request_id = p_correlation_id::text
                       and a.action_id = 'store.invoice_payment.register' and a.actor_internal_user_id = v_actor
                       and a.tenant_id = v_tenant and a.store_id = p_store_id
                       and a.subject_invoice_payment_registration_id = p_registration_id) then
    raise exception 'migration 037 register: the audit record was not written exactly once'
      using errcode = 'no_data_found';
  end if;

  return query select 'applied'::text, v_tenant, p_store_id, v_actor, v_membership, p_registration_id, p_invoice_id, v_event;
end
$$;

comment on function tmpos_invoice_payment.m7b_invoice_payment_register(text, uuid, uuid, uuid, uuid, uuid, uuid) is
  'Phase 4.0 M7b (migration 037): registers one payment attempt of the caller (036''s record authority, m7b_payment_writer) on one issued invoice. Answers (''refused'', NULLs); (''tenant_mismatch''); (''not_found'') alike for a missing or foreign invoice; then, the header FOR UPDATE, key 530030 and the levels again, a live session and the proof key generation FOR SHARE, on the caller''s own rows only: (''already_recorded'') for this attempt recorded, (''conflict'') while any own registration on the invoice is unsettled, (''invalid_state'') for this attempt withdrawn or a voided invoice — nothing written; else one open registration (sha256 of the session key, the current generation, pg_current_xact_id(), clock_timestamp()) and ONE audit record, (''applied'', tenant, store, actor, membership, registration, invoice, audit event id). Raises invalid_parameter_value for a malformed argument, object_not_in_prerequisite_state outside READ COMMITTED or without an installed proof key, integrity_constraint_violation for a constraint refusal (all fixed text). Never answers a proof.';

-- =============================================================================
-- 9) The proof (commit- and flush-qualified)
-- =============================================================================
-- VOLATILE: it samples WAL positions and waits. It takes NO row lock and assigns no transaction id: its own WAL in a partly
-- filled page would hold the flush below L until its commit (the gate suite's PDG-08). Writes nothing. Its own READS can write
-- WAL: a heap page short of free space is pruned by its next reader (an xid-less Heap2 PRUNE), and PostgreSQL requests that
-- record's flush only when the reading transaction COMMITS (a rollback never does). So the wait, bounded by p_wait_ms, ends in
-- an ANSWER ('not_durable', NULLs), not a raise: the caller commits, and a fresh transaction may ask once more.
create function tmpos_invoice_payment.m7b_invoice_payment_registration_proof(
  p_session_key text, p_store_id uuid, p_invoice_id uuid, p_expected_tenant uuid, p_registration_id uuid, p_wait_ms integer)
returns table (
  o_outcome         text,
  o_tenant_id       uuid,
  o_store_id        uuid,
  o_invoice_id      uuid,
  o_registration_id uuid,
  o_attempt_id      uuid,
  o_proof           text
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set row_security = off
set debug_print_parse = off
set debug_print_rewritten = off
set debug_print_plan = off
as $$
#print_strict_params off
declare
  v_budget     interval;
  v_reader     record;
  v_key        bytea;
  v_generation bigint;
  v_digest     bytea;
  v_row        record;
  v_align      integer;
  v_block      numeric;
  v_segment    numeric;
  v_offset     numeric;
  v_l          pg_lsn;
  v_l_end      pg_lsn;
  v_start      timestamptz;
  v_mac        bytea;
begin
  if p_session_key is null or p_session_key !~ '^[\x21-\x7e]{1,128}$'
     or p_store_id is null or p_invoice_id is null or p_expected_tenant is null or p_registration_id is null
     or p_wait_ms is null or p_wait_ms < 0 or p_wait_ms > 1000 then
    raise exception 'migration 037 proof: an argument is malformed'
      using errcode = 'invalid_parameter_value';
  end if;
  v_budget := p_wait_ms * interval '1 millisecond';
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'migration 037 proof: it must run under READ COMMITTED, so that it reads only committed registrations'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- 1. The caller: 034's lock-free store reader at write statuses, Invoices Approve and Customers View (expectedTenant folded in).
  select r.o_tenant_id, r.o_actor_id into v_reader
    from tmpos_invoice_issue.m7b_issue_store_reader(p_session_key, p_expected_tenant, p_store_id, true, 'approve') r;
  if not found then
    return query select 'denied'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::text;
    return;
  end if;
  -- 2. The key, a plain read (no lock): none installed fails closed.
  select k.key, k.generation into v_key, v_generation from tmpos_invoice_payment.payment_proof_key k where k.singleton;
  if v_key is null then
    raise exception 'migration 037 proof: the payment proof key is not installed'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- 3. The COMMITTED, OPEN registration of this caller, scope and generation (another transaction's: READ COMMITTED sees
  --    nothing uncommitted), then the session and the transaction, compared outside the WHERE.
  select g.attempt_id, g.session_digest, g.registered_xact into v_row
    from tmpos_invoice_payment.invoice_payment_registration g
   where g.registration_id = p_registration_id and g.invoice_id = p_invoice_id and g.tenant_id = v_reader.o_tenant_id
     and g.store_id = p_store_id and g.registered_by = v_reader.o_actor_id
     and g.payment_id is null and g.acknowledged_at is null and g.key_generation = v_generation;
  if not found then
    return query select 'not_found'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::text;
    return;
  end if;
  v_digest := pg_catalog.sha256(pg_catalog.convert_to(p_session_key, 'UTF8'));
  if v_row.session_digest is distinct from v_digest
     or v_row.registered_xact is not distinct from pg_catalog.pg_current_xact_id_if_assigned() then
    return query select 'not_found'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::text;
    return;
  end if;
  -- 4. DURABILITY (the gate suite's rule, exactly): fsync on; the verified page-header layout; L sampled only now, converted to
  --    end-of-record form only at an exact first usable byte (segment first, then page); flush >= L_end within p_wait_ms
  --    (checked at least once, so 0 is the strict comparison without a wait), else the answer 'not_durable'.
  if pg_catalog.current_setting('fsync') is distinct from 'on' then
    raise exception 'migration 037 proof: fsync is off, so no flush is durable'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  select c.max_data_alignment, c.wal_block_size, c.bytes_per_wal_segment into v_align, v_block, v_segment
    from pg_catalog.pg_control_init() c;
  if v_align is distinct from 8 or v_block is null or v_segment is null then
    raise exception 'migration 037 proof: unverified WAL page header layout'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  v_l := pg_catalog.pg_current_wal_insert_lsn();
  v_offset := v_l operator(pg_catalog.-) '0/0'::pg_lsn;
  if v_offset % v_segment = 40 then
    v_l_end := v_l operator(pg_catalog.-) 40::numeric;
  elsif v_offset % v_block = 24 then
    v_l_end := v_l operator(pg_catalog.-) 24::numeric;
  else
    v_l_end := v_l;
  end if;
  v_start := pg_catalog.clock_timestamp();
  loop
    exit when pg_catalog.pg_current_wal_flush_lsn() operator(pg_catalog.>=) v_l_end;
    if pg_catalog.clock_timestamp() - v_start >= v_budget then
      return query select 'not_durable'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::text;
      return;
    end if;
    -- 20 ms steps, the last one cut to what is left of p_wait_ms: the wait never overruns the caller's budget.
    perform pg_catalog.pg_sleep(least(0.02, extract(epoch from v_budget - (pg_catalog.clock_timestamp() - v_start))));
  end loop;
  -- 5. The proof.
  v_mac := tmpos_mint.hmac_sha256(v_key, tmpos_invoice_payment.m7b_payment_registration_proof_message(
             p_registration_id, v_reader.o_actor_id, v_reader.o_tenant_id, p_store_id, p_invoice_id, v_row.attempt_id,
             v_digest, v_generation));
  if v_mac is null or pg_catalog.octet_length(v_mac) <> 32 then
    raise exception 'migration 037 proof: the proof could not be computed'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  return query select 'proof'::text, v_reader.o_tenant_id, p_store_id, p_invoice_id, p_registration_id, v_row.attempt_id,
                      pg_catalog.encode(v_mac, 'hex');
end
$$;

comment on function tmpos_invoice_payment.m7b_invoice_payment_registration_proof(text, uuid, uuid, uuid, uuid, integer) is
  'Phase 4.0 M7b (migration 037): the proof for one COMMITTED, OPEN registration of the caller (034''s store reader: write statuses, Invoices Approve, Customers View, expectedTenant), of this store and invoice, under the current key generation, from the session that registered it and outside the registering transaction. (''denied'', NULLs) for every authority refusal; (''not_found'', NULLs) alike for every other mismatch; else, once pg_current_wal_flush_lsn() reaches the end-of-record form of the insert position sampled after that read (checked at once, then for at most p_wait_ms (0 to 1000) ms; fsync on, alignment 8), (''proof'', tenant, store, invoice, registration, attempt, 64 lowercase hex digits of HMAC-SHA-256); (''not_durable'', NULLs) when the flush has not reached it within p_wait_ms — nothing written, and the caller commits before any fresh attempt. Raises object_not_in_prerequisite_state (fixed text, nothing written) without a key, with fsync off or an unverified WAL layout, and outside READ COMMITTED; invalid_parameter_value for a malformed argument (p_wait_ms null or outside 0 to 1000 included). Locks no row; writes nothing.';

-- =============================================================================
-- 10) The record, v2: only through a committed, durable registration and its proof
-- =============================================================================
create function tmpos_invoice_payment.m7b_invoice_payment_record_v2(
  p_session_key text, p_store_id uuid, p_invoice_id uuid, p_expected_tenant uuid, p_payment_id uuid, p_registration_id uuid,
  p_attempt_id uuid, p_amount_cents bigint, p_method text, p_proof text, p_correlation_id uuid)
returns table (
  o_outcome        text,
  o_tenant_id      uuid,
  o_store_id       uuid,
  o_actor_id       uuid,
  o_membership_id  uuid,
  o_payment_id     uuid,
  o_invoice_id     uuid,
  o_audit_event_id uuid
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set row_security = off
set debug_print_parse = off
set debug_print_rewritten = off
set debug_print_plan = off
as $$
#print_strict_params off
declare
  c_methods       constant text[] := array['cash', 'external_card_terminal'];
  c_method_labels constant text[] := array['Cash', 'Card on a separate terminal'];
  v_tenant        uuid;
  v_actor         uuid;
  v_membership    uuid;
  v_role          text;
  v_expires       bigint;
  v_now           bigint;
  v_total         bigint;
  v_key           bytea;
  v_generation    bigint;
  v_digest        bytea;
  v_reg           record;
  v_applied       numeric;
  v_recorded_at   timestamptz;
  v_written       integer;
  v_check         record;
  v_event         uuid;
begin
  -- 0. Every argument, before anything is read.
  if p_session_key is null or p_session_key !~ '^[\x21-\x7e]{1,128}$'
     or p_store_id is null or p_invoice_id is null or p_expected_tenant is null
     or p_payment_id is null or p_registration_id is null or p_attempt_id is null then
    raise exception 'migration 037 record: an argument is malformed'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_amount_cents is null or p_amount_cents < 1 or p_amount_cents > 9007199254740991 then
    raise exception 'migration 037 record: the amount is out of range'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_method is null or not (p_method = any (c_methods)) then
    raise exception 'migration 037 record: the method is not one of the closed list'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_proof is null or p_proof !~ '^[0-9a-f]{64}$' then
    raise exception 'migration 037 record: the proof is malformed'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_correlation_id is null or p_correlation_id::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception 'migration 037 record: the correlation id is not a version-4 uuid'
      using errcode = 'invalid_parameter_value';
  end if;
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'migration 037 record: it must run under READ COMMITTED, so that its checks see what committed before its locks'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- 1-2. The caller; 3. expectedTenant; 4. the header FOR UPDATE; 5. key 530030 and the levels again (036's).
  select w.o_tenant_id, w.o_actor_id, w.o_membership_id, w.o_role, w.o_expires_at
    into v_tenant, v_actor, v_membership, v_role, v_expires
    from tmpos_invoice_payment.m7b_payment_writer(p_session_key, p_store_id) w;
  if not found then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;
  if v_tenant is distinct from p_expected_tenant then
    return query select 'tenant_mismatch'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;
  select i.total_cents into v_total
    from tmpos_invoice_issue.issued_invoice i
   where i.invoice_id = p_invoice_id and i.tenant_id = v_tenant and i.store_id = p_store_id
     for update;
  if not found then
    return query select 'not_found'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;
  if v_role <> 'store_owner' then
    perform pg_catalog.pg_advisory_xact_lock_shared(530030, pg_catalog.hashtext(v_tenant::text || '/' || v_role));
    if not tmpos_invoice_payment.m7b_payment_levels_ok(v_tenant, v_role) then
      return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid;
      return;
    end if;
  end if;
  -- 6. The key FOR SHARE (a rotation waits for this COMMIT): none installed fails closed before any registration is read.
  select k.key, k.generation into v_key, v_generation from tmpos_invoice_payment.payment_proof_key k where k.singleton for share;
  if v_key is null then
    raise exception 'migration 037 record: the payment proof key is not installed'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- 7. After the last lock wait (the key's FOR SHARE above): the session's expiry.
  v_now := pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp()) * 1000)::bigint;
  if v_now >= v_expires then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;

  -- 8. THE WHOLE SCOPE BEFORE ANY STATE WORD: the caller's registration of THIS attempt, locked; this registration id, this
  --    session, another (committed) transaction, the current generation and the proof — else 036's uniform not_found.
  select g.registration_id, g.session_digest, g.key_generation, g.registered_xact, g.payment_id, g.acknowledged_at
    into v_reg
    from tmpos_invoice_payment.invoice_payment_registration g
   where g.invoice_id = p_invoice_id and g.tenant_id = v_tenant and g.store_id = p_store_id
     and g.registered_by = v_actor and g.attempt_id = p_attempt_id
     for update;
  if not found then
    return query select 'not_found'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;
  v_digest := pg_catalog.sha256(pg_catalog.convert_to(p_session_key, 'UTF8'));
  if v_reg.registration_id is distinct from p_registration_id
     or v_reg.session_digest is distinct from v_digest
     or v_reg.registered_xact is not distinct from pg_catalog.pg_current_xact_id()
     or v_reg.key_generation is distinct from v_generation
     or pg_catalog.sha256(tmpos_mint.hmac_sha256(v_key, tmpos_invoice_payment.m7b_payment_registration_proof_message(
          v_reg.registration_id, v_actor, v_tenant, p_store_id, p_invoice_id, p_attempt_id, v_digest, v_generation)))
        is distinct from pg_catalog.sha256(pg_catalog.decode(p_proof, 'hex')) then
    return query select 'not_found'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;

  -- 9. The state, each a separate check after every lock; nothing written by any of them.
  if v_reg.payment_id is not null then
    return query select 'already_recorded'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;
  if v_reg.acknowledged_at is not null then
    return query select 'invalid_state'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;
  if exists (select 1 from tmpos_invoice_void.issued_invoice_void v where v.invoice_id = p_invoice_id) then
    return query select 'invalid_state'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;
  select coalesce(pg_catalog.sum(p.amount_cents), 0) into v_applied
    from tmpos_invoice_payment.invoice_payment p
   where p.invoice_id = p_invoice_id and p.tenant_id = v_tenant and p.store_id = p_store_id
     and not exists (select 1 from tmpos_invoice_payment.invoice_payment_reversal r where r.payment_id = p.payment_id);
  if v_applied + p_amount_cents::numeric > v_total::numeric then
    return query select 'amount_exceeds_remaining'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;
  -- Then (R2/R3 order: voided, amount, attempt) the attempt id taken on this invoice by any payment (036's permanent key; another staff member's included).
  if exists (select 1 from tmpos_invoice_payment.invoice_payment p
              where p.invoice_id = p_invoice_id and p.tenant_id = v_tenant and p.store_id = p_store_id
                and p.attempt_id = p_attempt_id) then
    return query select 'invalid_state'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;

  -- 10. ONE payment (036's insert), then the registration's payment id.
  v_recorded_at := pg_catalog.clock_timestamp();
  begin
    insert into tmpos_invoice_payment.invoice_payment
      (payment_id, tenant_id, store_id, invoice_id, attempt_id, amount_cents, method, recorded_at, recorded_by)
    values (p_payment_id, v_tenant, p_store_id, p_invoice_id, p_attempt_id, p_amount_cents, p_method, v_recorded_at, v_actor);
    get diagnostics v_written = row_count;
  exception
    when unique_violation or check_violation or foreign_key_violation or not_null_violation or restrict_violation then
      raise exception 'migration 037 record: the payment is not one the payment table admits'
        using errcode = 'integrity_constraint_violation';
  end;
  if v_written is distinct from 1 then
    raise exception 'migration 037 record: the payment was not written to exactly the locked invoice'
      using errcode = 'no_data_found';
  end if;
  select p.tenant_id, p.store_id, p.invoice_id, p.attempt_id, p.amount_cents, p.method, p.recorded_at, p.recorded_by
    into v_check
    from tmpos_invoice_payment.invoice_payment p
   where p.payment_id = p_payment_id;
  if not found
     or v_check.tenant_id is distinct from v_tenant or v_check.store_id is distinct from p_store_id
     or v_check.invoice_id is distinct from p_invoice_id or v_check.attempt_id is distinct from p_attempt_id
     or v_check.amount_cents is distinct from p_amount_cents or v_check.method is distinct from p_method
     or v_check.recorded_at is distinct from v_recorded_at or v_check.recorded_by is distinct from v_actor then
    raise exception 'migration 037 record: the payment is not the one judged'
      using errcode = 'no_data_found';
  end if;
  begin
    update tmpos_invoice_payment.invoice_payment_registration g
       set payment_id = p_payment_id
     where g.registration_id = p_registration_id and g.payment_id is null and g.acknowledged_at is null;
    get diagnostics v_written = row_count;
  exception
    when unique_violation or check_violation or foreign_key_violation or not_null_violation or restrict_violation then
      raise exception 'migration 037 record: the registration does not admit this payment'
        using errcode = 'integrity_constraint_violation';
  end;
  if v_written is distinct from 1 then
    raise exception 'migration 037 record: the registration was not settled by exactly this payment'
      using errcode = 'no_data_found';
  end if;

  -- 11. ONE audit record (036's values; the registration as a second subject), read back.
  v_event := null;
  begin
    insert into public.audit_event
      (request_id, trace_id, actor_internal_user_id, actor_auth_provider, on_behalf_of_internal_user_id, scope_type, tenant_id,
       store_id, action_id, required_permission, decision, reason_code, human_readable_reason, result_status, source_of_truth,
       evaluated_by, evidence_level, metadata, subject_invoice_payment_id, subject_invoice_payment_registration_id)
    values (p_correlation_id::text, null, v_actor, null, null, 'store', v_tenant, p_store_id,
            'store.invoice_payment.record', 'record_invoice_payments', 'allow', 'invoice_payment_recorded_' || p_method,
            'Payment recorded against an issued invoice. Method: '
              || c_method_labels[pg_catalog.array_position(c_methods, p_method)] || '.',
            'succeeded', 'invoice_payment_routine', 'm7b_invoice_payment_routine@v2', 'durable_compliance_event', '{}'::jsonb,
            p_payment_id, p_registration_id)
    returning event_id into v_event;
    get diagnostics v_written = row_count;
  exception
    when unique_violation or check_violation or foreign_key_violation or not_null_violation or restrict_violation then
      raise exception 'migration 037 record: the audit record is not one the audit table admits'
        using errcode = 'integrity_constraint_violation';
  end;
  if v_written is distinct from 1 or v_event is null
     or not exists (select 1 from public.audit_event a
                     where a.event_id = v_event and a.request_id = p_correlation_id::text
                       and a.action_id = 'store.invoice_payment.record' and a.actor_internal_user_id = v_actor
                       and a.tenant_id = v_tenant and a.store_id = p_store_id and a.subject_invoice_payment_id = p_payment_id
                       and a.subject_invoice_payment_registration_id = p_registration_id) then
    raise exception 'migration 037 record: the audit record was not written exactly once'
      using errcode = 'no_data_found';
  end if;

  return query select 'applied'::text, v_tenant, p_store_id, v_actor, v_membership, p_payment_id, p_invoice_id, v_event;
end
$$;

comment on function tmpos_invoice_payment.m7b_invoice_payment_record_v2(text, uuid, uuid, uuid, uuid, uuid, uuid, bigint, text, text, uuid) is
  'Phase 4.0 M7b (migration 037): records one payment through the caller''s registration of p_attempt_id on one issued invoice. 036''s record authority and order (''refused''; ''tenant_mismatch''; ''not_found'' for a missing or foreign invoice; the header FOR UPDATE, key 530030 and the levels again, a live session), then the proof key FOR SHARE, then the registration FOR UPDATE: (''not_found'', NULLs) — the same answer — unless it exists and is registration p_registration_id, of this session, of another committed transaction, under the current generation, and p_proof is its proof. Then (''already_recorded'') for this registration recorded; (''invalid_state'') for it withdrawn, a voided invoice or the attempt id already taken on the invoice; (''amount_exceeds_remaining'') — nothing written by any; else ONE payment, the registration''s payment_id, and ONE audit record (036''s values, the registration as a second subject): (''applied'', tenant, store, actor, membership, payment, invoice, audit event id). Raises invalid_parameter_value for a malformed argument or proof, object_not_in_prerequisite_state outside READ COMMITTED or without a key, integrity_constraint_violation for a constraint refusal (all fixed text).';

-- =============================================================================
-- 11) The staff member's attempts (the recovery list)
-- =============================================================================
create function tmpos_invoice_payment.m7b_invoice_payment_attempts(
  p_session_key text, p_store_id uuid, p_expected_tenant uuid, p_after_invoice_id uuid, p_after_attempt_id uuid, p_limit integer)
returns table (
  o_outcome        text,
  o_tenant_id      uuid,
  o_store_id       uuid,
  o_invoice_id     uuid,
  o_invoice_number bigint,
  o_attempt_id     uuid,
  o_state          text,
  o_version        bigint,
  o_registered_at  text,
  o_settled_at     text,
  o_payment_id     uuid,
  o_amount_cents   bigint,
  o_method         text,
  o_recorded_at    text,
  o_reversed_at    text,
  o_reason_code    text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
set row_security = off
set debug_print_parse = off
set debug_print_rewritten = off
set debug_print_plan = off
as $$
#print_strict_params off
declare
  c_format   constant text := 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';
  v_reader   record;
  v_after_at timestamptz;
begin
  if p_session_key is null or p_session_key !~ '^[\x21-\x7e]{1,128}$'
     or p_store_id is null or p_expected_tenant is null
     or (p_after_invoice_id is null) <> (p_after_attempt_id is null) then
    raise exception 'migration 037 attempts: an argument is malformed'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 51 then
    raise exception 'migration 037 attempts: the limit is out of range'
      using errcode = 'invalid_parameter_value';
  end if;
  -- 034's lock-free store reader at read statuses, Invoices Approve and Customers View: register's levels.
  select r.o_tenant_id, r.o_actor_id into v_reader
    from tmpos_invoice_issue.m7b_issue_store_reader(p_session_key, p_expected_tenant, p_store_id, false, 'approve') r;
  if not found then
    return query select 'denied'::text, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid, null::text, null::bigint,
                        null::text, null::text, null::uuid, null::bigint, null::text, null::text, null::text, null::text;
    return;
  end if;
  if p_after_invoice_id is not null then
    select g.registered_at into v_after_at
      from tmpos_invoice_payment.invoice_payment_registration g
     where g.tenant_id = v_reader.o_tenant_id and g.store_id = p_store_id and g.registered_by = v_reader.o_actor_id
       and g.invoice_id = p_after_invoice_id and g.attempt_id = p_after_attempt_id;
    if not found then
      return query select 'cursor_unknown'::text, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid, null::text, null::bigint,
                          null::text, null::text, null::uuid, null::bigint, null::text, null::text, null::text, null::text;
      return;
    end if;
  end if;
  -- Every unsettled row whatever its age, and rows settled in the last 24 hours (display only). Never the registration id,
  -- the session digest, the generation or the transaction.
  return query
    select 'attempt'::text, g.tenant_id, g.store_id, g.invoice_id, i.number, g.attempt_id,
           case when g.payment_id is null and g.acknowledged_at is null then 'open'
                when g.acknowledged_at is null then 'recorded'
                when g.payment_id is null then 'withdrawn'
                else 'confirmed' end,
           case when g.acknowledged_at is not null then 3::bigint when g.payment_id is not null then 2::bigint else 1::bigint end,
           pg_catalog.to_char(g.registered_at at time zone 'UTC', c_format),
           pg_catalog.to_char(g.acknowledged_at at time zone 'UTC', c_format),
           p.payment_id, p.amount_cents, p.method::text,
           pg_catalog.to_char(p.recorded_at at time zone 'UTC', c_format),
           pg_catalog.to_char(r.reversed_at at time zone 'UTC', c_format),
           r.reason_code::text
      from tmpos_invoice_payment.invoice_payment_registration g
      join tmpos_invoice_issue.issued_invoice i
        on i.invoice_id = g.invoice_id and i.tenant_id = g.tenant_id and i.store_id = g.store_id
      left join tmpos_invoice_payment.invoice_payment p on p.payment_id = g.payment_id
      left join tmpos_invoice_payment.invoice_payment_reversal r on r.payment_id = p.payment_id
     where g.tenant_id = v_reader.o_tenant_id and g.store_id = p_store_id and g.registered_by = v_reader.o_actor_id
       and (g.acknowledged_at is null or g.acknowledged_at > pg_catalog.statement_timestamp() - interval '24 hours')
       and (p_after_invoice_id is null
            or (g.registered_at, g.invoice_id, g.attempt_id) > (v_after_at, p_after_invoice_id, p_after_attempt_id))
     order by g.registered_at, g.invoice_id, g.attempt_id
     limit p_limit;
end
$$;

comment on function tmpos_invoice_payment.m7b_invoice_payment_attempts(text, uuid, uuid, uuid, uuid, integer) is
  'Phase 4.0 M7b (migration 037): one page (1-51, keyset (registered_at, invoice_id, attempt_id) after the caller''s own row (p_after_invoice_id, p_after_attempt_id), else ''cursor_unknown'') of the caller''s registrations at one store under 034''s store reader (read statuses, Invoices Approve, Customers View, expectedTenant): every unsettled one whatever its age and those settled in the last 24 hours, each (''attempt'', tenant, store, invoice, invoice number, attempt, state open|recorded|withdrawn|confirmed, version 1|2|3|3, registered_at, settled_at, and for a recorded one its payment id, amount, method, recorded_at and any reversal; UTC text with microseconds). No row for an empty page; (''denied'', NULLs) for every authority refusal. Never the registration id, session digest, generation or transaction. Never reads the proof key. STABLE; locks nothing.';

-- =============================================================================
-- 12) Settle (version-checked; never reads the proof key)
-- =============================================================================
create function tmpos_invoice_payment.m7b_invoice_payment_settle(
  p_session_key text, p_store_id uuid, p_invoice_id uuid, p_expected_tenant uuid, p_attempt_id uuid, p_expected_version bigint,
  p_correlation_id uuid)
returns table (
  o_outcome        text,
  o_tenant_id      uuid,
  o_store_id       uuid,
  o_actor_id       uuid,
  o_membership_id  uuid,
  o_version        bigint,
  o_invoice_id     uuid,
  o_audit_event_id uuid
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set row_security = off
set debug_print_parse = off
set debug_print_rewritten = off
set debug_print_plan = off
as $$
#print_strict_params off
declare
  v_tenant     uuid;
  v_actor      uuid;
  v_membership uuid;
  v_role       text;
  v_expires    bigint;
  v_now        bigint;
  v_reg        record;
  v_reason     text;
  v_clock      timestamptz;
  v_written    integer;
  v_event      uuid;
begin
  if p_session_key is null or p_session_key !~ '^[\x21-\x7e]{1,128}$'
     or p_store_id is null or p_invoice_id is null or p_expected_tenant is null or p_attempt_id is null
     or p_expected_version is null or p_expected_version not in (1, 2) then
    raise exception 'migration 037 settle: an argument is malformed'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_correlation_id is null or p_correlation_id::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception 'migration 037 settle: the correlation id is not a version-4 uuid'
      using errcode = 'invalid_parameter_value';
  end if;
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'migration 037 settle: it must run under READ COMMITTED, so that its checks see what committed before its locks'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  select w.o_tenant_id, w.o_actor_id, w.o_membership_id, w.o_role, w.o_expires_at
    into v_tenant, v_actor, v_membership, v_role, v_expires
    from tmpos_invoice_payment.m7b_payment_writer(p_session_key, p_store_id) w;
  if not found then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid, null::uuid;
    return;
  end if;
  if v_tenant is distinct from p_expected_tenant then
    return query select 'tenant_mismatch'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid, null::uuid;
    return;
  end if;
  perform 1 from tmpos_invoice_issue.issued_invoice i
   where i.invoice_id = p_invoice_id and i.tenant_id = v_tenant and i.store_id = p_store_id
     for update;
  if not found then
    return query select 'not_found'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid, null::uuid;
    return;
  end if;
  if v_role <> 'store_owner' then
    perform pg_catalog.pg_advisory_xact_lock_shared(530030, pg_catalog.hashtext(v_tenant::text || '/' || v_role));
    if not tmpos_invoice_payment.m7b_payment_levels_ok(v_tenant, v_role) then
      return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid, null::uuid;
      return;
    end if;
  end if;
  v_now := pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp()) * 1000)::bigint;
  if v_now >= v_expires then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid, null::uuid;
    return;
  end if;

  -- The caller's own registration of this attempt, locked (a foreign one is absent: same answer).
  select g.registration_id, g.payment_id, g.acknowledged_at into v_reg
    from tmpos_invoice_payment.invoice_payment_registration g
   where g.invoice_id = p_invoice_id and g.tenant_id = v_tenant and g.store_id = p_store_id
     and g.registered_by = v_actor and g.attempt_id = p_attempt_id
     for update;
  if not found then
    return query select 'not_found'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid, null::uuid;
    return;
  end if;
  -- Version 1 = "I saw it open", 2 = "I saw it recorded"; a repeat of the same settlement is unchanged; anything else conflicts.
  if v_reg.acknowledged_at is not null then
    if (v_reg.payment_id is null and p_expected_version = 1) or (v_reg.payment_id is not null and p_expected_version = 2) then
      return query select 'unchanged'::text, v_tenant, p_store_id, v_actor, v_membership, 3::bigint, p_invoice_id, null::uuid;
      return;
    end if;
    return query select 'conflict'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid, null::uuid;
    return;
  end if;
  if (v_reg.payment_id is null) <> (p_expected_version = 1) then
    return query select 'conflict'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid, null::uuid;
    return;
  end if;
  v_reason := case when v_reg.payment_id is null then 'invoice_payment_attempt_withdrawn' else 'invoice_payment_attempt_confirmed' end;

  v_clock := pg_catalog.clock_timestamp();
  begin
    update tmpos_invoice_payment.invoice_payment_registration g
       set acknowledged_at = v_clock
     where g.registration_id = v_reg.registration_id and g.acknowledged_at is null;
    get diagnostics v_written = row_count;
  exception
    when unique_violation or check_violation or foreign_key_violation or not_null_violation or restrict_violation then
      raise exception 'migration 037 settle: the registration does not admit this settlement'
        using errcode = 'integrity_constraint_violation';
  end;
  if v_written is distinct from 1 then
    raise exception 'migration 037 settle: the registration was not settled exactly once'
      using errcode = 'no_data_found';
  end if;

  v_event := null;
  begin
    insert into public.audit_event
      (request_id, trace_id, actor_internal_user_id, actor_auth_provider, on_behalf_of_internal_user_id, scope_type, tenant_id,
       store_id, action_id, required_permission, decision, reason_code, human_readable_reason, result_status, source_of_truth,
       evaluated_by, evidence_level, metadata, subject_invoice_payment_registration_id)
    values (p_correlation_id::text, null, v_actor, null, null, 'store', v_tenant, p_store_id,
            'store.invoice_payment.settle', 'record_invoice_payments', 'allow', v_reason,
            case when v_reg.payment_id is null then 'Payment attempt withdrawn: no payment was recorded for it.'
                 else 'Recorded payment confirmed by the staff member who registered it.' end,
            'succeeded', 'invoice_payment_routine', 'm7b_invoice_payment_routine@v2', 'durable_compliance_event', '{}'::jsonb,
            v_reg.registration_id)
    returning event_id into v_event;
    get diagnostics v_written = row_count;
  exception
    when unique_violation or check_violation or foreign_key_violation or not_null_violation or restrict_violation then
      raise exception 'migration 037 settle: the audit record is not one the audit table admits'
        using errcode = 'integrity_constraint_violation';
  end;
  if v_written is distinct from 1 or v_event is null
     or not exists (select 1 from public.audit_event a
                     where a.event_id = v_event and a.request_id = p_correlation_id::text
                       and a.action_id = 'store.invoice_payment.settle' and a.actor_internal_user_id = v_actor
                       and a.tenant_id = v_tenant and a.store_id = p_store_id
                       and a.subject_invoice_payment_registration_id = v_reg.registration_id) then
    raise exception 'migration 037 settle: the audit record was not written exactly once'
      using errcode = 'no_data_found';
  end if;

  return query select 'applied'::text, v_tenant, p_store_id, v_actor, v_membership, 3::bigint, p_invoice_id, v_event;
end
$$;

comment on function tmpos_invoice_payment.m7b_invoice_payment_settle(text, uuid, uuid, uuid, uuid, bigint, uuid) is
  'Phase 4.0 M7b (migration 037): settles the caller''s own registration of p_attempt_id on one issued invoice, version-checked: 1 withdraws an open one, 2 confirms a recorded one. 036''s record authority and order (''refused''; ''tenant_mismatch''; ''not_found'' for a missing or foreign invoice; the header FOR UPDATE, key 530030 and the levels again, a live session), then the registration FOR UPDATE: (''not_found'') when the caller has none; (''unchanged'', ..., 3) for a repeat of the same settlement, no audit; (''conflict'', NULLs) when its state is not the one the version names; else sets acknowledged_at (clock_timestamp()), releasing the slot, and writes ONE audit record: (''applied'', tenant, store, actor, membership, 3, invoice, audit event id). Raises invalid_parameter_value for a malformed argument or a version outside 1-2, object_not_in_prerequisite_state outside READ COMMITTED, integrity_constraint_violation for a constraint refusal (all fixed text). Never reads the proof key.';

-- =============================================================================
-- 13) The key-presence probe (the startup preflight's)
-- =============================================================================
create function tmpos_invoice_payment.m7b_payment_proof_key_probe()
returns table (o_present boolean, o_generation bigint)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
set row_security = off
as $$
declare
  v_generation bigint;
begin
  select k.generation into v_generation from tmpos_invoice_payment.payment_proof_key k where k.singleton;
  return query select v_generation is not null, v_generation;
end
$$;

comment on function tmpos_invoice_payment.m7b_payment_proof_key_probe() is
  'Phase 4.0 M7b (migration 037): whether a payment proof key is installed, and its non-secret generation (NULL when none). Never the key bytes or a digest of them. STABLE; locks nothing.';

-- =============================================================================
-- 14) Privileges
-- =============================================================================
-- PostgreSQL grants EXECUTE on a new function to PUBLIC by default: every default is removed before the six intended grants.
revoke all on function tmpos_invoice_payment.m7b_invoice_payment_registration_guard() from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
revoke all on function tmpos_invoice_payment.m7b_invoice_payment_registration_truncate_guard() from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
revoke all on function tmpos_invoice_payment.m7b_payment_proof_key_install_guard() from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
revoke all on function tmpos_invoice_payment.m7b_payment_proof_key_shape_guard() from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
revoke all on function tmpos_invoice_payment.m7b_payment_proof_key_generation_guard() from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
revoke all on function tmpos_invoice_payment.m7b_payment_writer(text, uuid) from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
revoke all on function tmpos_invoice_payment.m7b_payment_levels_ok(uuid, text) from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
revoke all on function tmpos_invoice_payment.m7b_payment_registration_proof_message(uuid, uuid, uuid, uuid, uuid, uuid, bytea, bigint) from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
revoke all on function tmpos_invoice_payment.m7b_invoice_payment_register(text, uuid, uuid, uuid, uuid, uuid, uuid) from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
revoke all on function tmpos_invoice_payment.m7b_invoice_payment_registration_proof(text, uuid, uuid, uuid, uuid, integer) from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
revoke all on function tmpos_invoice_payment.m7b_invoice_payment_record_v2(text, uuid, uuid, uuid, uuid, uuid, uuid, bigint, text, text, uuid) from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
revoke all on function tmpos_invoice_payment.m7b_invoice_payment_attempts(text, uuid, uuid, uuid, uuid, integer) from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
revoke all on function tmpos_invoice_payment.m7b_invoice_payment_settle(text, uuid, uuid, uuid, uuid, bigint, uuid) from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
revoke all on function tmpos_invoice_payment.m7b_payment_proof_key_probe() from public, anon, authenticated, tmpos_app, tmpos_audit_writer;

-- 036's record, past the registration, is no longer the runtime's; it stays in place, unaltered, for the rollback.
revoke execute on function tmpos_invoice_payment.m7b_invoice_payment_record(text, uuid, uuid, uuid, uuid, uuid, bigint, text, uuid) from tmpos_app;

grant execute on function tmpos_invoice_payment.m7b_invoice_payment_register(text, uuid, uuid, uuid, uuid, uuid, uuid) to tmpos_app;
grant execute on function tmpos_invoice_payment.m7b_invoice_payment_registration_proof(text, uuid, uuid, uuid, uuid, integer) to tmpos_app;
grant execute on function tmpos_invoice_payment.m7b_invoice_payment_record_v2(text, uuid, uuid, uuid, uuid, uuid, uuid, bigint, text, text, uuid) to tmpos_app;
grant execute on function tmpos_invoice_payment.m7b_invoice_payment_attempts(text, uuid, uuid, uuid, uuid, integer) to tmpos_app;
grant execute on function tmpos_invoice_payment.m7b_invoice_payment_settle(text, uuid, uuid, uuid, uuid, bigint, uuid) to tmpos_app;
grant execute on function tmpos_invoice_payment.m7b_payment_proof_key_probe() to tmpos_app;

-- =============================================================================
-- 15) Postcondition
-- =============================================================================
-- (a) every function this file created has its declared language, security, volatility, settings, owner and comment;
-- (b) the complete ACL of the six routines is exactly the owner's EXECUTE and tmpos_app's; of every other function this file
--     created, and of 036's record, exactly the owner's; tmpos_app reaches none of them else, nor 018's HMAC or 034's reader;
--     tmpos_audit_writer, anon and authenticated none of them by any path;
-- (c) no runtime role holds any privilege on the three tables by any path; row security enabled, unforced, without policy;
-- (d) the six triggers exactly, ENABLE ALWAYS; (e) the audit column (nullable uuid, no default) and its index.
do $$
declare
  v_bad      text;
  v_me       oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user);
  c_definer  constant text[] := array['search_path=pg_catalog, pg_temp', 'row_security=off', 'debug_print_parse=off',
                                      'debug_print_rewritten=off', 'debug_print_plan=off'];
  v_routines oid[] := array[
    'tmpos_invoice_payment.m7b_invoice_payment_register(text, uuid, uuid, uuid, uuid, uuid, uuid)'::regprocedure,
    'tmpos_invoice_payment.m7b_invoice_payment_registration_proof(text, uuid, uuid, uuid, uuid, integer)'::regprocedure,
    'tmpos_invoice_payment.m7b_invoice_payment_record_v2(text, uuid, uuid, uuid, uuid, uuid, uuid, bigint, text, text, uuid)'::regprocedure,
    'tmpos_invoice_payment.m7b_invoice_payment_attempts(text, uuid, uuid, uuid, uuid, integer)'::regprocedure,
    'tmpos_invoice_payment.m7b_invoice_payment_settle(text, uuid, uuid, uuid, uuid, bigint, uuid)'::regprocedure,
    'tmpos_invoice_payment.m7b_payment_proof_key_probe()'::regprocedure]::oid[];
  v_others   oid[] := array[
    'tmpos_invoice_payment.m7b_invoice_payment_registration_guard()'::regprocedure,
    'tmpos_invoice_payment.m7b_invoice_payment_registration_truncate_guard()'::regprocedure,
    'tmpos_invoice_payment.m7b_payment_proof_key_install_guard()'::regprocedure,
    'tmpos_invoice_payment.m7b_payment_proof_key_shape_guard()'::regprocedure,
    'tmpos_invoice_payment.m7b_payment_proof_key_generation_guard()'::regprocedure,
    'tmpos_invoice_payment.m7b_payment_writer(text, uuid)'::regprocedure,
    'tmpos_invoice_payment.m7b_payment_levels_ok(uuid, text)'::regprocedure,
    'tmpos_invoice_payment.m7b_payment_registration_proof_message(uuid, uuid, uuid, uuid, uuid, uuid, bytea, bigint)'::regprocedure,
    'tmpos_invoice_payment.m7b_invoice_payment_record(text, uuid, uuid, uuid, uuid, uuid, bigint, text, uuid)'::regprocedure]::oid[];
  v_tables   oid[] := array['tmpos_invoice_payment.invoice_payment_registration'::regclass,
                            'tmpos_invoice_payment.payment_proof_key'::regclass,
                            'tmpos_invoice_payment.payment_proof_key_generation'::regclass]::oid[];
begin
  -- (a)
  select pg_catalog.string_agg(p.proname::text, ', ' order by p.proname) into v_bad
    from pg_catalog.pg_proc p join pg_catalog.pg_language l on l.oid = p.prolang
   where p.oid = any (v_routines || v_others[1:8])
     and not (p.proowner = v_me
              and pg_catalog.obj_description(p.oid, 'pg_proc') is not null
              and case
                    when p.proname in ('m7b_invoice_payment_register', 'm7b_invoice_payment_registration_proof',
                                       'm7b_invoice_payment_record_v2', 'm7b_invoice_payment_settle') then
                      l.lanname = 'plpgsql' and p.prosecdef and p.provolatile = 'v' and p.proretset and p.proconfig = c_definer
                    when p.proname = 'm7b_invoice_payment_attempts' then
                      l.lanname = 'plpgsql' and p.prosecdef and p.provolatile = 's' and p.proretset and p.proconfig = c_definer
                    when p.proname = 'm7b_payment_proof_key_probe' then
                      l.lanname = 'plpgsql' and p.prosecdef and p.provolatile = 's' and p.proretset
                      and p.proconfig = array['search_path=pg_catalog, pg_temp', 'row_security=off']
                    when p.proname in ('m7b_payment_proof_key_install_guard', 'm7b_payment_proof_key_shape_guard') then
                      l.lanname = 'plpgsql' and not p.prosecdef and p.prorettype = 'pg_catalog.trigger'::regtype
                      and p.proconfig = c_definer
                    when p.proname = 'm7b_invoice_payment_registration_guard' then
                      l.lanname = 'plpgsql' and not p.prosecdef and p.prorettype = 'pg_catalog.trigger'::regtype
                      and p.proconfig = array['search_path=pg_catalog, pg_temp', 'row_security=off']
                    when p.proname in ('m7b_invoice_payment_registration_truncate_guard', 'm7b_payment_proof_key_generation_guard') then
                      l.lanname = 'plpgsql' and not p.prosecdef and p.prorettype = 'pg_catalog.trigger'::regtype
                      and p.proconfig = array['search_path=pg_catalog, pg_temp']
                    when p.proname in ('m7b_payment_writer', 'm7b_payment_levels_ok') then
                      l.lanname = 'plpgsql' and not p.prosecdef
                      and p.proconfig = array['search_path=pg_catalog, pg_temp', 'row_security=off']
                    when p.proname = 'm7b_payment_registration_proof_message' then
                      l.lanname = 'sql' and not p.prosecdef and p.provolatile = 'i' and p.proisstrict
                      and p.proconfig = array['search_path=pg_catalog, pg_temp']
                    else false
                  end);
  if v_bad is not null then
    raise exception 'migration 037 refused: a function of this file is not the one its section declares (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (b)
  select pg_catalog.string_agg(pg_catalog.format('%s %s:%s', p.proname, g.grantee::regrole::text, g.privilege_type), ', ')
    into v_bad
    from pg_catalog.pg_proc p, pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g
   where p.oid = any (v_routines || v_others)
     and not (g.privilege_type = 'EXECUTE' and not g.is_grantable and g.grantor = p.proowner
              and (g.grantee = p.proowner or (p.oid = any (v_routines) and g.grantee = 'tmpos_app'::regrole)));
  if v_bad is not null
     or exists (select 1 from pg_catalog.pg_proc p
                 where p.oid = any (v_routines || v_others)
                   and (select pg_catalog.count(*) from pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g)
                       <> case when p.oid = any (v_routines) then 2 else 1 end) then
    raise exception 'migration 037 refused: an unexpected grant remains on a function of this file or on 036''s record, or an entry is missing (%)', coalesce(v_bad, 'none listed')
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  select pg_catalog.string_agg(distinct r.rolname::text || ' ' || f.oid::regprocedure::text, ', ') into v_bad
    from pg_catalog.pg_roles r
    join pg_catalog.pg_roles x on pg_catalog.pg_has_role(r.oid, x.oid, 'MEMBER')
    cross join pg_catalog.unnest(v_routines || v_others
                                 || array['tmpos_mint.hmac_sha256(bytea, bytea)'::regprocedure,
                                          'tmpos_invoice_issue.m7b_issue_store_reader(text, uuid, uuid, boolean, text)'::regprocedure]::oid[]) f(oid)
   where (r.rolname = any (array['tmpos_audit_writer', 'anon', 'authenticated']::name[])
          or (r.rolname = 'tmpos_app' and not (f.oid = any (v_routines))))
     and pg_catalog.has_function_privilege(x.oid, f.oid, 'EXECUTE');
  if v_bad is not null
     or exists (select 1 from pg_catalog.unnest(v_routines) f(oid) where not pg_catalog.has_function_privilege('tmpos_app', f.oid, 'EXECUTE')) then
    raise exception 'migration 037 refused: a runtime role can execute a function this file does not grant it (036''s record included), or tmpos_app cannot execute a routine (%)', coalesce(v_bad, 'none listed')
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (c)
  select pg_catalog.string_agg(distinct r.rolname::text, ', ') into v_bad
    from pg_catalog.pg_roles r
    join pg_catalog.pg_roles x on pg_catalog.pg_has_role(r.oid, x.oid, 'MEMBER')
    cross join pg_catalog.unnest(v_tables) t(oid)
   where r.rolname = any (array['tmpos_app', 'tmpos_audit_writer', 'anon', 'authenticated']::name[])
     and (pg_catalog.has_table_privilege(x.oid, t.oid,
            'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'
            operator(pg_catalog.||) case when pg_catalog.current_setting('server_version_num')::integer >= 170000
                                         then ', MAINTAIN' else '' end)
          or pg_catalog.has_any_column_privilege(x.oid, t.oid, 'SELECT, INSERT, UPDATE, REFERENCES'));
  if v_bad is not null
     or (select pg_catalog.count(*) from pg_catalog.pg_class c
          where c.oid = any (v_tables) and c.relrowsecurity and not c.relforcerowsecurity and c.relowner = v_me
            and pg_catalog.obj_description(c.oid, 'pg_class') is not null) <> 3
     or exists (select 1 from pg_catalog.pg_policy y where y.polrelid = any (v_tables))
     or exists (select 1 from pg_catalog.pg_class c, pg_catalog.aclexplode(coalesce(c.relacl, pg_catalog.acldefault('r', c.relowner))) g
                 where c.oid = any (v_tables) and g.grantee <> c.relowner)
     or exists (select 1 from pg_catalog.pg_attribute t where t.attrelid = any (v_tables) and t.attacl is not null) then
    raise exception 'migration 037 refused: % holds a privilege on a table of this file, or row security is not enabled without policy and unforced, or a table is not the applying principal''s', coalesce(v_bad, 'a role')
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (d) tgtype: ROW 1 + BEFORE 2 + INSERT 4 + DELETE 8 + UPDATE 16 = 31; BEFORE 2 + TRUNCATE 32 = 34; ROW 1 + INSERT 4 +
  --     UPDATE 16 (AFTER) = 21; ROW 1 + BEFORE 2 + DELETE 8 + UPDATE 16 = 27; ROW 1 + BEFORE 2 + INSERT 4 + UPDATE 16 = 23.
  if (select pg_catalog.string_agg(pg_catalog.format('%s:%s:%s:%s', g.tgname, g.tgfoid::regprocedure::text, g.tgtype, g.tgenabled), ', '
                                  order by g.tgname::text collate "C")
        from pg_catalog.pg_trigger g where g.tgrelid = any (v_tables) and not g.tgisinternal)
     is distinct from
     'trg_invoice_payment_registration_guard:tmpos_invoice_payment.m7b_invoice_payment_registration_guard():31:A, trg_invoice_payment_registration_truncate:tmpos_invoice_payment.m7b_invoice_payment_registration_truncate_guard():34:A, trg_payment_proof_key_generation_guard:tmpos_invoice_payment.m7b_payment_proof_key_generation_guard():27:A, trg_payment_proof_key_generation_truncate:tmpos_invoice_payment.m7b_payment_proof_key_generation_guard():34:A, trg_payment_proof_key_install:tmpos_invoice_payment.m7b_payment_proof_key_install_guard():21:A, trg_payment_proof_key_shape:tmpos_invoice_payment.m7b_payment_proof_key_shape_guard():23:A' then
    raise exception 'migration 037 refused: a trigger of this file''s tables is not exactly the one declared'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (e)
  if (select pg_catalog.count(*) from pg_catalog.pg_attribute a
       where a.attrelid = 'public.audit_event'::regclass and a.attname = 'subject_invoice_payment_registration_id' and not a.attisdropped
         and a.atttypid = 'pg_catalog.uuid'::regtype and not a.attnotnull and not a.atthasdef and a.attacl is null) <> 1
     or pg_catalog.to_regclass('public.idx_audit_event_subject_invoice_payment_registration_occurred') is null
     or not pg_catalog.has_column_privilege('tmpos_audit_writer', 'public.audit_event', 'subject_invoice_payment_registration_id', 'INSERT') then
    raise exception 'migration 037 refused: the audit table''s registration subject or its index is not the one section 6 declares'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$$;

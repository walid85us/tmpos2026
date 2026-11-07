-- Phase 4.0 M7b — recording payments against an issued store invoice: append-only manual payment records and whole-record
-- reversals in a schema of their own, their ENABLE ALWAYS guards, two session-bound routines that write their own audit record,
-- a replacement invoice void that refuses while a payment is active, a payments read on one snapshot, the audit table's payment
-- subject and card-data key guard, and the rollback-order anchor that keeps 035 from rolling back under it
-- (M7B-PAYMENTS-P1; owner decisions D-PAY-1..10 with amendments A1, A2, A3; ADR-52; docs/phase-4/15 §12; DA-118, DA-119,
-- DA-132; G-IAM, G-AUDIT, G-PCI)
-- Migration: 036_m7b_invoice_payment (UP)
--
-- SCOPE / TRUTH (binding):
--   - ONE SCHEMA, TWO TABLES, NINE FUNCTIONS, FOUR TRIGGERS, SIX TMPOS_APP PRIVILEGE CHANGES, ONE AUDIT COLUMN WITH ITS INDEX,
--     ONE AUDIT CHECK. Schema tmpos_invoice_payment (owned by the applying principal; USAGE to tmpos_app alone, beside its
--     owner's) holds the tables invoice_payment and invoice_payment_reversal (row security on, no policy, NO privilege for any
--     runtime role); the routines m7b_invoice_payment_record, m7b_invoice_payment_reverse, m7b_invoice_void_v2 and
--     m7b_invoice_payments_get (the only four granted, EXECUTE to tmpos_app); and, granted to nobody, the four trigger
--     functions and the anchor m7b_invoice_payment_prerequisites. tmpos_app gains USAGE on the schema and EXECUTE on the four
--     routines and LOSES its EXECUTE on 035's tmpos_invoice_void.m7b_invoice_void, which stays in place, unaltered (A2: the
--     void cannot reach past the payment check through the older entry point). public.audit_event gains the nullable column
--     subject_invoice_payment_id, its partial index and the CHECK audit_event_metadata_no_card_data_keys_chk (docs/phase-4/05
--     line 38: CVV/CVC, track1/2 and PIN block); 002's CHECK and every existing column are unchanged. NO ROLE, MEMBERSHIP,
--     POLICY OR TYPE; no row of any existing table written; no 001-035 routine, trigger, CHECK or index altered. The two
--     foreign keys add PostgreSQL's internal RESTRICT triggers on 034's issued_invoice and on invoice_payment, and a dependency
--     that blocks 034's drop.
--   - THE AMOUNT (D-PAY-1 A, A1). Never stored. For an issued invoice: due = 034's total_cents (the version-1 Total, unchanged),
--     applied = the sum of the amounts of its payments that have no reversal, remaining = due - applied, all in numeric. For a
--     voided invoice: due, applied and remaining are 0 and its history stays. The issued row, its snapshot and its "never an
--     amount due" comment are unchanged; issuing itself creates no payment record, receivable or stored balance.
--   - THE RECORDS (section 5). invoice_payment: one row per recorded payment; a composite foreign key onto 034's
--     issued_invoice_scope_key; amount_cents 1 to 9007199254740991; method 'cash' or 'external_card_terminal' (D-PAY-3 A; no
--     reference, card or free-text field exists anywhere); UNIQUE (invoice_id, tenant_id, store_id, attempt_id) — an attempt is
--     recorded at most once per invoice, permanently. invoice_payment_reversal: at most one per payment, a composite foreign key
--     onto the payment's scope key; reason_code one of six closed codes (no free text). Times are the database clock after the
--     routine's last lock; the actors are plain uuids no read returns. No stored balance, status, effective or back-dated time,
--     tendered amount or change.
--   - THE ROUTINES (sections 8 to 11): m7b_invoice_payment_record and m7b_invoice_payment_reverse decide in the order their own
--     comments give (docs/phase-4/15 §12.4) and write their payment or reversal and ONE AUDIT RECORD (D-PAY-8 A) after their
--     last refusal, raising unless exactly one audit row was written and read back; m7b_invoice_void_v2 is 035's void with one
--     more separate check ('payments_recorded', A2 and A3) and writes no audit record, as 035's; m7b_invoice_payments_get is
--     the read, on one snapshot, under 035's v2 get's authority. Each check after a lock wait is its own statement under READ
--     COMMITTED: under REPEATABLE READ the sum would judge the snapshot taken before the wait, so every write routine refuses
--     any other isolation level before anything is read.
--   - THE AUDIT RECORD proves neither the actor (an issuer-key holder can mint a session for anyone: DA-93, DA-94) nor the
--     correlation id (request_id has no uniqueness rule). It fixes audit coupling for payments only.
--   - THE GUARDS (ENABLE ALWAYS, SECURITY INVOKER, pinned, granted to nobody; refusals restrict_violation with fixed text): each
--     table's row guard refuses every update and delete and admits an insert only in its own scope and time; each table's
--     truncate guard refuses every truncate. NOT COVERED (033's to 035's boundary): the table owner disabling or dropping a
--     trigger, a replaced function, DDL and a superuser.
--   - LOCK ORDER. Record and reverse: fence -> 016's hold -> session and mint-ledger rows FOR SHARE -> issuer key FOR SHARE ->
--     membership (read) and store row FOR SHARE -> the level table, plain read -> THE ISSUED HEADER FOR UPDATE (035's step-4
--     slot) -> (reverse) the payment, plain read -> key 530030 SHARED (editable roles) -> the levels, plain read -> the payment
--     or reversal reads -> the insert (its foreign-key check takes FOR KEY SHARE on the header this transaction already holds
--     FOR UPDATE, or on a payment row nothing locks exclusively: payment rows are never updated) -> the audit insert -> (the
--     runtime) completion -> COMMIT. The void v2: 035's order, with plain payment reads after the header lock. This is the
--     argument 035's header (:98-101) asks to redo for a table referencing issued_invoice: every insert into invoice_payment
--     comes from the record routine, which holds the header FOR UPDATE first, so records, reversals and voids of one invoice
--     serialize on its header and no new wait cycle is introduced. DEADLOCK FREEDOM IS NOT CLAIMED OR PROVEN: composed owner
--     sessions, direct definer calls (DA-118), migrations' ACCESS EXCLUSIVE locks and future writers are outside the argument.
--   - APPLY: a maintenance window — ACCESS EXCLUSIVE until COMMIT, before anything is read, in the writers' order; then READ
--     COMMITTED, 035's objects this file relies on exactly as 035 left them, none of this file's objects, the runtime roles, and
--     the applier's reach (EXECUTE on 016's hold and admission read and on 035's v2 get; owner, or a member of the owner, of
--     every table the definers read, lock or insert into, none with forced row security; INSERT and SELECT on
--     public.audit_event), else a fixed-text refusal (55000, 42501). Object checks only: no ledger clause (R-GATE-2).
--   - OPERATIONS: APPLY AND ROLLBACK RUN WITH THE TENANT RUNTIME STOPPED. A 035-built runtime left running across the apply
--     answers 503 on a void (it no longer executes 035's void); a 036-built runtime across the rollback meets dropped routines
--     (503). The startup preflight pins the ledger (001-036) and the grants and refuses a mismatched start either way.
--   - ROLL 036 BACK FIRST: while it is applied 035's down fails closed (2BP01 on the anchor's dependencies) and 034's too (the
--     payment foreign key). 036's down refuses, changing nothing, while any payment, reversal or payment audit record exists:
--     AFTER THE FIRST PAYMENT THE ROLLBACK IS ONE-WAY.
--   - WHAT THIS DOES NOT DEFEND (docs/phase-4/15 §7, narrowed; none claimed closed): direct calls of the record and reverse
--     routines skip idempotency completion, CSRF, the rate limit and the chain's step-up (DA-118, widened in audited form); the
--     replacement void stays unaudited on a direct call; the payments read joins DA-132's direct-read class; a direct level set
--     changes who can record and reverse (DA-119); forged audit rows through tmpos_audit_writer (G-AUDIT, DA-114); the table
--     owner's paths above; retention and privacy of payment records (DA-187). A recording is a staff assertion, never a
--     verified receipt of funds.
--   - NO SECRET, NO DYNAMIC SQL, NO EXTENSION, NO TEMPORARY OBJECT, NO BACKFILL. Every name is schema-qualified; every routine
--     and trigger function pins its search_path.
--
-- Reversible via 036_m7b_invoice_payment.down.sql. Assumes 001-035 are applied; this file authorizes no managed apply.

-- =============================================================================
-- 1) This transaction's settings
-- =============================================================================
set local search_path = pg_catalog, pg_temp;
set local row_security = off;

-- =============================================================================
-- 2) The locks, in the writers' order: the first statements after the settings, before any check or any change
-- =============================================================================
do $$
begin
  lock table public.store in access exclusive mode;
  lock table tmpos_role.tenant_role_level in access exclusive mode;
  lock table tmpos_role_edit.role_level_version in access exclusive mode;
  lock table tmpos_customer.customer in access exclusive mode;
  lock table tmpos_invoice_draft.invoice_draft in access exclusive mode;
  lock table tmpos_invoice_draft.invoice_draft_line in access exclusive mode;
  lock table tmpos_invoice_issue.store_issuing_settings in access exclusive mode;
  lock table tmpos_invoice_issue.store_invoice_counter in access exclusive mode;
  lock table tmpos_invoice_issue.issued_invoice in access exclusive mode;
  lock table tmpos_invoice_issue.issued_invoice_line in access exclusive mode;
  lock table tmpos_invoice_void.issued_invoice_void in access exclusive mode;
  lock table public.audit_event in access exclusive mode;
exception
  when undefined_table or invalid_schema_name then
    raise exception 'migration 036 refused: public.store, tmpos_role.tenant_role_level, tmpos_role_edit.role_level_version, tmpos_customer.customer, a draft table, a table of tmpos_invoice_issue, tmpos_invoice_void.issued_invoice_void or public.audit_event is missing (migrations 002, 017, 020, 021, 028, 034 and 035 must be applied first)'
      using errcode = 'object_not_in_prerequisite_state';
end
$$;

-- =============================================================================
-- 3) Preconditions: READ COMMITTED, then the database exactly at 035 for every object this file relies on
-- =============================================================================
do $$
begin
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'migration 036 refused: it must run under READ COMMITTED, so that its checks see every committed row'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$$;

do $$
declare
  v_me   oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user);
  v_void oid;
begin
  if pg_catalog.to_regnamespace('tmpos_invoice_payment') is not null then
    raise exception 'migration 036 refused: schema tmpos_invoice_payment already exists'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if (select pg_catalog.count(*) from pg_catalog.pg_roles r
       where r.rolname = any (array['tmpos_app', 'tmpos_audit_writer', 'anon', 'authenticated']::name[])) <> 4 then
    raise exception 'migration 036 refused: the runtime roles tmpos_app, tmpos_audit_writer, anon and authenticated must exist (migration 005 and the platform''s two client roles)'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- 035, exactly, for what this file builds on and revokes: its void (whose complete ACL must be exactly 035's two entries, so
  -- the revoke below is no silent no-op and the rollback's grant restores it byte for byte), its v2 get (which the payments
  -- read calls), its void table with its two ALWAYS guards (which the record and the v2 void read) and its anchor.
  v_void := pg_catalog.to_regprocedure('tmpos_invoice_void.m7b_invoice_void(text, uuid, uuid, uuid, bigint, text)');
  if v_void is null
     or pg_catalog.to_regprocedure('tmpos_invoice_void.m7b_issued_invoice_get_v2(text, uuid, uuid, uuid)') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_void.m7b_invoice_void_prerequisites()') is null
     or pg_catalog.to_regclass('tmpos_invoice_void.issued_invoice_void') is null
     or (select pg_catalog.string_agg(pg_catalog.format('%s:%s:%s:%s', g.tgname, g.tgfoid::regprocedure::text, g.tgtype, g.tgenabled), ', '
                                     order by g.tgname::text collate "C")
           from pg_catalog.pg_trigger g
          where g.tgrelid = 'tmpos_invoice_void.issued_invoice_void'::regclass and not g.tgisinternal)
        is distinct from 'trg_issued_invoice_void_guard:tmpos_invoice_void.m7b_invoice_void_guard():31:A, trg_issued_invoice_void_truncate:tmpos_invoice_void.m7b_invoice_void_truncate_guard():34:A'
     or pg_catalog.pg_get_function_result(v_void)
        is distinct from 'TABLE(o_outcome text, o_tenant_id uuid, o_store_id uuid, o_actor_id uuid, o_membership_id uuid, o_version bigint, o_invoice_id uuid)'
     or pg_catalog.pg_get_function_result('tmpos_invoice_void.m7b_issued_invoice_get_v2(text, uuid, uuid, uuid)'::regprocedure)
        is distinct from 'TABLE(o_outcome text, o_tenant_id uuid, o_store_id uuid, o_invoice_id uuid, o_number bigint, o_snapshot_version integer, o_issued_at text, o_source_draft_id uuid, o_source_draft_version bigint, o_settings_version bigint, o_legal_name text, o_store_name text, o_postal_address text, o_tax_registration_id text, o_customer_id uuid, o_customer_name text, o_customer_version bigint, o_currency text, o_line_count integer, o_subtotal_cents bigint, o_tax_mode text, o_tax_rate integer, o_tax_cents bigint, o_total_cents bigint, o_position integer, o_description text, o_quantity bigint, o_unit_price_cents bigint, o_line_total_cents bigint, o_status text, o_voided_at text, o_reason_code text)'
     or (select pg_catalog.count(*) from pg_catalog.pg_proc p
          where p.oid in (v_void, 'tmpos_invoice_void.m7b_issued_invoice_get_v2(text, uuid, uuid, uuid)'::regprocedure)
            and p.proowner = v_me and p.prosecdef) <> 2
     or (select pg_catalog.count(*)
           from pg_catalog.pg_proc p, pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g
          where p.oid = v_void) <> 2
     or (select pg_catalog.count(*)
           from pg_catalog.pg_proc p, pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g
          where p.oid = v_void and g.privilege_type = 'EXECUTE' and not g.is_grantable and g.grantor = p.proowner
            and g.grantee in (p.proowner, 'tmpos_app'::regrole)) <> 2 then
    raise exception 'migration 036 refused: migration 035 is not applied exactly (its void and its ACL, its v2 get, its void table with its two guards, or its anchor)'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- 034's issued header, exactly what the routines read and lock: the scope key the foreign key targets, the issue time, the
  -- Total and the currency, and its three ALWAYS triggers (its immutability, on which the guards' lock-free reads rest).
  if (select pg_catalog.count(*) from pg_catalog.pg_constraint k
       where k.conrelid = 'tmpos_invoice_issue.issued_invoice'::regclass and k.conname = 'issued_invoice_scope_key'
         and k.contype = 'u' and k.convalidated
         and pg_catalog.pg_get_constraintdef(k.oid) = 'UNIQUE (invoice_id, tenant_id, store_id)') <> 1
     or (select pg_catalog.count(*) from pg_catalog.pg_attribute a
          where a.attrelid = 'tmpos_invoice_issue.issued_invoice'::regclass and not a.attisdropped and a.attnotnull
            and ((a.attname = 'issued_at' and a.atttypid = 'pg_catalog.timestamptz'::regtype)
                 or (a.attname = 'total_cents' and a.atttypid = 'pg_catalog.int8'::regtype)
                 or (a.attname = 'currency' and a.atttypid = 'pg_catalog.text'::regtype))) <> 3
     or (select pg_catalog.string_agg(pg_catalog.format('%s:%s:%s', g.tgname, g.tgtype, g.tgenabled), ', ' order by g.tgname::text collate "C")
           from pg_catalog.pg_trigger g
          where g.tgrelid = 'tmpos_invoice_issue.issued_invoice'::regclass and not g.tgisinternal)
        is distinct from 'trg_issued_invoice_commit_check:5:A, trg_issued_invoice_guard:31:A, trg_issued_invoice_truncate:34:A' then
    raise exception 'migration 036 refused: migration 034''s issued header is not as 034 left it (its scope key, issue time, Total, currency or three triggers)'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- The audit table: none of this file's additions yet, and every column the payment routines write present.
  if exists (select 1 from pg_catalog.pg_attribute a
              where a.attrelid = 'public.audit_event'::regclass and a.attname = 'subject_invoice_payment_id' and not a.attisdropped)
     or pg_catalog.to_regclass('public.idx_audit_event_subject_invoice_payment_occurred') is not null
     or exists (select 1 from pg_catalog.pg_constraint k
                 where k.conrelid = 'public.audit_event'::regclass and k.conname = 'audit_event_metadata_no_card_data_keys_chk')
     or (select pg_catalog.count(*) from pg_catalog.pg_attribute a
          where a.attrelid = 'public.audit_event'::regclass and not a.attisdropped
            and a.attname = any (array['event_id', 'request_id', 'trace_id', 'occurred_at', 'actor_internal_user_id', 'actor_auth_provider',
                                       'on_behalf_of_internal_user_id', 'scope_type', 'tenant_id', 'store_id', 'action_id',
                                       'required_permission', 'decision', 'reason_code', 'human_readable_reason', 'result_status',
                                       'source_of_truth', 'evaluated_by', 'evidence_level', 'metadata']::name[])) <> 20 then
    raise exception 'migration 036 refused: public.audit_event already carries an addition of this file, or lacks a column the payment routines write'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- The CHECK added in section 7 validates every existing row: refuse here with fixed text rather than fail on one there.
  if exists (select 1 from public.audit_event a where a.metadata ?| array['cvv', 'cvc', 'track1', 'track2', 'pinBlock']) then
    raise exception 'migration 036 refused: an existing audit record''s metadata carries a card-data key the new CHECK refuses'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- The objects the routines restate, call, read or lock (035's void's), and the session row's sign-in time (011).
  if pg_catalog.to_regprocedure('tmpos_session.m5_hold_tenant_standing(text, text)') is null
     or pg_catalog.to_regprocedure('tmpos_session.m5_admit_tenant_session_v2(text, text)') is null
     or pg_catalog.to_regclass('tmpos_session.session') is null
     or pg_catalog.to_regclass('tmpos_mint.tenant_session') is null
     or pg_catalog.to_regclass('tmpos_mint.issuer_key') is null
     or pg_catalog.to_regclass('public.tenant') is null
     or pg_catalog.to_regclass('public.user_membership') is null
     or not exists (select 1 from pg_catalog.pg_attribute a
                     where a.attrelid = 'tmpos_session.session'::regclass and a.attname = 'authenticated_at'
                       and not a.attisdropped and a.atttypid = 'pg_catalog.int8'::regtype) then
    raise exception 'migration 036 refused: 016''s hold or admission read, 011''s session sign-in time, 018''s mint ledger or issuer key, or 002''s tenant or membership table is missing'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if not (pg_catalog.has_function_privilege(current_user, 'tmpos_session.m5_hold_tenant_standing(text, text)', 'EXECUTE')
          and pg_catalog.has_function_privilege(current_user, 'tmpos_session.m5_admit_tenant_session_v2(text, text)', 'EXECUTE')
          and pg_catalog.has_function_privilege(current_user, 'tmpos_invoice_void.m7b_issued_invoice_get_v2(text, uuid, uuid, uuid)', 'EXECUTE')
          and pg_catalog.has_schema_privilege(current_user, 'public', 'USAGE')
          and pg_catalog.has_schema_privilege(current_user, 'tmpos_session', 'USAGE')
          and pg_catalog.has_schema_privilege(current_user, 'tmpos_mint', 'USAGE')
          and pg_catalog.has_schema_privilege(current_user, 'tmpos_role', 'USAGE')
          and pg_catalog.has_schema_privilege(current_user, 'tmpos_invoice_issue', 'USAGE')
          and pg_catalog.has_schema_privilege(current_user, 'tmpos_invoice_void', 'USAGE')
          -- D-PAY-8 A: the routines' owner (the applying principal) inserts the audit record and reads it back.
          and pg_catalog.has_table_privilege(current_user, 'public.audit_event', 'INSERT')
          and pg_catalog.has_table_privilege(current_user, 'public.audit_event', 'SELECT')) then
    raise exception 'migration 036 refused: the applying principal cannot execute 016''s hold and admission read or 035''s v2 get, use the schemas they read, or insert into and read public.audit_event'
      using errcode = 'insufficient_privilege';
  end if;
  if exists (
    select 1
      from pg_catalog.pg_class c
     where c.oid = any (array['tmpos_session.session'::regclass, 'tmpos_mint.tenant_session'::regclass,
                              'tmpos_mint.issuer_key'::regclass, 'tmpos_role.tenant_role_level'::regclass,
                              'public.store'::regclass, 'public.tenant'::regclass, 'public.user_membership'::regclass,
                              'tmpos_invoice_issue.issued_invoice'::regclass, 'tmpos_invoice_issue.issued_invoice_line'::regclass,
                              'tmpos_invoice_void.issued_invoice_void'::regclass, 'public.audit_event'::regclass])
       and (not pg_catalog.pg_has_role(current_user, c.relowner, 'USAGE') or c.relforcerowsecurity)) then
    raise exception 'migration 036 refused: the applying principal neither owns nor inherits the owner of a table the definers read, lock or insert into, or one has forced row security'
      using errcode = 'insufficient_privilege';
  end if;
end
$$;

-- =============================================================================
-- 4) The schema
-- =============================================================================
create schema tmpos_invoice_payment;

comment on schema tmpos_invoice_payment is
  'Phase 4.0 M7b (migration 036): recording payments against issued invoices — the append-only payment and reversal records, their guards, the record and reverse routines (each writing its own audit record), the replacement void, the payments read and the rollback-order anchor. Owned by this migration; tmpos_app holds USAGE and EXECUTE on the four routines only.';

revoke all on schema tmpos_invoice_payment from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
grant usage on schema tmpos_invoice_payment to tmpos_app;

-- =============================================================================
-- 5) The records
-- =============================================================================
create table tmpos_invoice_payment.invoice_payment (
  payment_id   uuid        not null,
  tenant_id    uuid        not null,
  store_id     uuid        not null,
  invoice_id   uuid        not null,
  attempt_id   uuid        not null,
  amount_cents bigint      not null,
  method       text        collate "C" not null,
  recorded_at  timestamptz not null,
  recorded_by  uuid        not null,
  constraint invoice_payment_pkey primary key (payment_id),
  -- An attempt is recorded at most once per invoice, permanently (D-PAY-7 A); its index also serves every per-invoice read.
  constraint invoice_payment_attempt_key unique (invoice_id, tenant_id, store_id, attempt_id),
  -- The reversal's reference target: a reversal names its payment in exactly that payment's invoice, tenant and store.
  constraint invoice_payment_scope_key unique (payment_id, invoice_id, tenant_id, store_id),
  constraint invoice_payment_invoice_fkey foreign key (invoice_id, tenant_id, store_id)
    references tmpos_invoice_issue.issued_invoice (invoice_id, tenant_id, store_id) on delete restrict on update restrict,
  constraint invoice_payment_amount_chk check (amount_cents between 1 and 9007199254740991),
  -- The closed list (D-PAY-3 A), in its order; no reference or card field exists.
  constraint invoice_payment_method_chk check (method in ('cash', 'external_card_terminal'))
);

comment on table tmpos_invoice_payment.invoice_payment is
  'Phase 4.0 M7b (migration 036): append-only — one row per payment a store team member recorded against one issued invoice of its tenant and store: the runtime''s payment id, the client''s attempt id (unique per invoice, permanently), the amount in USD integer cents, the method, the database time and the recording actor. A staff assertion, never a processor authorization, capture, settlement or verified receipt. Insert only (no update, delete or truncate). Written only by m7b_invoice_payment_record. No read returns recorded_by. No runtime role holds a privilege on it.';
comment on column tmpos_invoice_payment.invoice_payment.recorded_by is
  'Phase 4.0 M7b (migration 036): the recording actor''s internal_user_id. Plain uuid, no FK. No read returns it.';
comment on column tmpos_invoice_payment.invoice_payment.recorded_at is
  'Phase 4.0 M7b (migration 036): the database clock (clock_timestamp()) after the record routine''s last lock; never before the invoice''s issued_at; no back-dating; UTC is authoritative.';

create table tmpos_invoice_payment.invoice_payment_reversal (
  payment_id  uuid        not null,
  tenant_id   uuid        not null,
  store_id    uuid        not null,
  invoice_id  uuid        not null,
  reason_code text        collate "C" not null,
  reversed_at timestamptz not null,
  reversed_by uuid        not null,
  constraint invoice_payment_reversal_pkey primary key (payment_id),
  constraint invoice_payment_reversal_payment_fkey foreign key (payment_id, invoice_id, tenant_id, store_id)
    references tmpos_invoice_payment.invoice_payment (payment_id, invoice_id, tenant_id, store_id) on delete restrict on update restrict,
  -- The closed list (D-PAY-4 A), in its order; no free text.
  constraint invoice_payment_reversal_reason_code_chk check (
    reason_code in ('recorded_in_error', 'wrong_amount', 'wrong_method', 'wrong_invoice', 'duplicate', 'other'))
);

comment on table tmpos_invoice_payment.invoice_payment_reversal is
  'Phase 4.0 M7b (migration 036): append-only — at most one row per recorded payment, stating that the recording was a mistake, with its closed reason code, the database time and the reversing actor. It moves no money and is not a refund; the payment row stays. Insert only. Written only by m7b_invoice_payment_reverse. No read returns reversed_by. No runtime role holds a privilege on it.';
comment on column tmpos_invoice_payment.invoice_payment_reversal.reversed_by is
  'Phase 4.0 M7b (migration 036): the reversing actor''s internal_user_id. Plain uuid, no FK. No read returns it.';
comment on column tmpos_invoice_payment.invoice_payment_reversal.reversed_at is
  'Phase 4.0 M7b (migration 036): the database clock (clock_timestamp()) after the reverse routine''s last lock; never before the payment''s recorded_at; UTC is authoritative.';

alter table tmpos_invoice_payment.invoice_payment enable row level security;
alter table tmpos_invoice_payment.invoice_payment_reversal enable row level security;
revoke all on table tmpos_invoice_payment.invoice_payment from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
revoke all on table tmpos_invoice_payment.invoice_payment_reversal from public, anon, authenticated, tmpos_app, tmpos_audit_writer;

-- =============================================================================
-- 6) The guards
-- =============================================================================
-- SECURITY INVOKER and granted to nobody (a trigger function fires without an EXECUTE grant); BEFORE, so a refused write
-- changes nothing; row_security off where a relation is read: a writer whose row security would hide the parent fails.
create function tmpos_invoice_payment.m7b_invoice_payment_guard()
returns trigger
language plpgsql
volatile
security invoker
set search_path = pg_catalog, pg_temp
set row_security = off
as $$
declare
  v_issued_at timestamptz;
begin
  if tg_when is distinct from 'BEFORE' or tg_level is distinct from 'ROW'
     or tg_op not in ('INSERT', 'UPDATE', 'DELETE')
     or tg_table_schema is distinct from 'tmpos_invoice_payment' or tg_table_name is distinct from 'invoice_payment' then
    raise exception 'm7b_invoice_payment_guard: fired by an undeclared trigger'
      using errcode = 'triggered_action_exception';
  end if;
  if tg_op <> 'INSERT' then
    raise exception 'migration 036: a payment record is never updated or deleted'
      using errcode = 'restrict_violation';
  end if;
  -- WITHOUT A ROW LOCK: 034's ALWAYS guards keep a committed issued header unchanged and undeleted; the record routine already
  -- holds it FOR UPDATE; the foreign key's own check takes FOR KEY SHARE where it fires. Checked here too because a session
  -- running as a replica skips the foreign key's trigger.
  select i.issued_at into v_issued_at
    from tmpos_invoice_issue.issued_invoice i
   where i.invoice_id = new.invoice_id and i.tenant_id = new.tenant_id and i.store_id = new.store_id;
  if not found then
    raise exception 'migration 036: a payment record names an issued invoice of its own tenant and store'
      using errcode = 'restrict_violation';
  end if;
  if new.recorded_at is null or new.recorded_at < v_issued_at then
    raise exception 'migration 036: a payment record is stamped at or after its invoice''s issue'
      using errcode = 'restrict_violation';
  end if;
  return new;
end
$$;

comment on function tmpos_invoice_payment.m7b_invoice_payment_guard() is
  'Phase 4.0 M7b (migration 036): BEFORE INSERT OR UPDATE OR DELETE row trigger on tmpos_invoice_payment.invoice_payment (enabled ALWAYS). Refuses (restrict_violation, fixed message) every update and delete, and an insert unless an issued invoice with the same invoice id, tenant and store exists (read without a row lock, row_security off) and recorded_at is present and not before its issued_at. triggered_action_exception for any other firing. Granted to nobody.';

create function tmpos_invoice_payment.m7b_invoice_payment_truncate_guard()
returns trigger
language plpgsql
volatile
security invoker
set search_path = pg_catalog, pg_temp
as $$
begin
  if tg_when is distinct from 'BEFORE' or tg_level is distinct from 'STATEMENT' or tg_op is distinct from 'TRUNCATE'
     or tg_table_schema is distinct from 'tmpos_invoice_payment' or tg_table_name is distinct from 'invoice_payment' then
    raise exception 'm7b_invoice_payment_truncate_guard: fired by an undeclared trigger'
      using errcode = 'triggered_action_exception';
  end if;
  raise exception 'migration 036: payment records are never truncated'
    using errcode = 'restrict_violation';
end
$$;

comment on function tmpos_invoice_payment.m7b_invoice_payment_truncate_guard() is
  'Phase 4.0 M7b (migration 036): BEFORE TRUNCATE statement trigger on tmpos_invoice_payment.invoice_payment (enabled ALWAYS); always raises restrict_violation (fixed message). triggered_action_exception for any other firing. Granted to nobody.';

create function tmpos_invoice_payment.m7b_invoice_payment_reversal_guard()
returns trigger
language plpgsql
volatile
security invoker
set search_path = pg_catalog, pg_temp
set row_security = off
as $$
declare
  v_recorded_at timestamptz;
begin
  if tg_when is distinct from 'BEFORE' or tg_level is distinct from 'ROW'
     or tg_op not in ('INSERT', 'UPDATE', 'DELETE')
     or tg_table_schema is distinct from 'tmpos_invoice_payment' or tg_table_name is distinct from 'invoice_payment_reversal' then
    raise exception 'm7b_invoice_payment_reversal_guard: fired by an undeclared trigger'
      using errcode = 'triggered_action_exception';
  end if;
  if tg_op <> 'INSERT' then
    raise exception 'migration 036: a payment reversal is never updated or deleted'
      using errcode = 'restrict_violation';
  end if;
  -- WITHOUT A ROW LOCK: the payment guard keeps a committed payment unchanged and undeleted; the reverse routine already holds
  -- its invoice's header FOR UPDATE. Checked here too because a replica session skips the foreign key's trigger.
  select p.recorded_at into v_recorded_at
    from tmpos_invoice_payment.invoice_payment p
   where p.payment_id = new.payment_id and p.invoice_id = new.invoice_id
     and p.tenant_id = new.tenant_id and p.store_id = new.store_id;
  if not found then
    raise exception 'migration 036: a payment reversal names a payment of its own invoice, tenant and store'
      using errcode = 'restrict_violation';
  end if;
  if new.reversed_at is null or new.reversed_at < v_recorded_at then
    raise exception 'migration 036: a payment reversal is stamped at or after its payment''s recording'
      using errcode = 'restrict_violation';
  end if;
  return new;
end
$$;

comment on function tmpos_invoice_payment.m7b_invoice_payment_reversal_guard() is
  'Phase 4.0 M7b (migration 036): BEFORE INSERT OR UPDATE OR DELETE row trigger on tmpos_invoice_payment.invoice_payment_reversal (enabled ALWAYS). Refuses (restrict_violation, fixed message) every update and delete, and an insert unless a payment with the same payment id, invoice, tenant and store exists (read without a row lock, row_security off) and reversed_at is present and not before its recorded_at. triggered_action_exception for any other firing. Granted to nobody.';

create function tmpos_invoice_payment.m7b_invoice_payment_reversal_truncate_guard()
returns trigger
language plpgsql
volatile
security invoker
set search_path = pg_catalog, pg_temp
as $$
begin
  if tg_when is distinct from 'BEFORE' or tg_level is distinct from 'STATEMENT' or tg_op is distinct from 'TRUNCATE'
     or tg_table_schema is distinct from 'tmpos_invoice_payment' or tg_table_name is distinct from 'invoice_payment_reversal' then
    raise exception 'm7b_invoice_payment_reversal_truncate_guard: fired by an undeclared trigger'
      using errcode = 'triggered_action_exception';
  end if;
  raise exception 'migration 036: payment reversals are never truncated'
    using errcode = 'restrict_violation';
end
$$;

comment on function tmpos_invoice_payment.m7b_invoice_payment_reversal_truncate_guard() is
  'Phase 4.0 M7b (migration 036): BEFORE TRUNCATE statement trigger on tmpos_invoice_payment.invoice_payment_reversal (enabled ALWAYS); always raises restrict_violation (fixed message). triggered_action_exception for any other firing. Granted to nobody.';

create trigger trg_invoice_payment_guard
  before insert or update or delete on tmpos_invoice_payment.invoice_payment
  for each row execute function tmpos_invoice_payment.m7b_invoice_payment_guard();
alter table tmpos_invoice_payment.invoice_payment enable always trigger trg_invoice_payment_guard;
create trigger trg_invoice_payment_truncate
  before truncate on tmpos_invoice_payment.invoice_payment
  for each statement execute function tmpos_invoice_payment.m7b_invoice_payment_truncate_guard();
alter table tmpos_invoice_payment.invoice_payment enable always trigger trg_invoice_payment_truncate;
create trigger trg_invoice_payment_reversal_guard
  before insert or update or delete on tmpos_invoice_payment.invoice_payment_reversal
  for each row execute function tmpos_invoice_payment.m7b_invoice_payment_reversal_guard();
alter table tmpos_invoice_payment.invoice_payment_reversal enable always trigger trg_invoice_payment_reversal_guard;
create trigger trg_invoice_payment_reversal_truncate
  before truncate on tmpos_invoice_payment.invoice_payment_reversal
  for each statement execute function tmpos_invoice_payment.m7b_invoice_payment_reversal_truncate_guard();
alter table tmpos_invoice_payment.invoice_payment_reversal enable always trigger trg_invoice_payment_reversal_truncate;

-- =============================================================================
-- 7) The audit record's payment subject and the card-data key guard (public.audit_event)
-- =============================================================================
-- A nullable column with no default rewrites no row and fires no row trigger; the audit writer's table-wide INSERT (005) covers
-- it; nothing else is granted. The CHECK is added beside 002's, which is unchanged; section 3 proved no row violates it.
alter table public.audit_event
  add column subject_invoice_payment_id uuid;

comment on column public.audit_event.subject_invoice_payment_id is
  'Phase 4.0 M7b (migration 036): the recorded payment the action recorded or reversed (store-scope, its only subject). Written by tmpos_invoice_payment''s record and reverse routines themselves, in the same transaction as the payment record, never from request metadata. Plain column, no FK (audit is decoupled/append-only). Never accompanied by an amount, customer, seller or line value.';

create index idx_audit_event_subject_invoice_payment_occurred on public.audit_event (subject_invoice_payment_id, occurred_at desc)
  where subject_invoice_payment_id is not null;

-- docs/phase-4/05 line 38: the documented no-cardholder-data boundary (05 §5) enforced on audit metadata for CVV/CVC, track
-- 1 and 2, and the PIN block, beside 002's PAN and card-number keys.
alter table public.audit_event
  add constraint audit_event_metadata_no_card_data_keys_chk
  check (not (metadata ?| array['cvv', 'cvc', 'track1', 'track2', 'pinBlock']));

-- =============================================================================
-- 8) The record
-- =============================================================================
create function tmpos_invoice_payment.m7b_invoice_payment_record(
  p_session_key text, p_store_id uuid, p_invoice_id uuid, p_expected_tenant uuid, p_payment_id uuid, p_attempt_id uuid,
  p_amount_cents bigint, p_method text, p_correlation_id uuid)
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
-- VOLATILE IS LOAD-BEARING (033's reason): it locks and then re-reads, and each statement must see what committed before its
-- own locks — steps 7 to 9 above all. Do not make it STABLE.
volatile
security definer
set search_path = pg_catalog, pg_temp
set row_security = off
as $$
declare
  -- The tenant ordering (permissionCatalog.ts TENANT_ORDERING), 020's constant, pinned by the parity test.
  c_levels         constant text[] := array['none', 'view', 'create', 'edit', 'manage', 'approve', 'full'];
  -- The closed methods (D-PAY-3 A), in their order, and their labels.
  c_methods        constant text[] := array['cash', 'external_card_terminal'];
  c_method_labels  constant text[] := array['Cash', 'Card on a separate terminal'];
  v_now            bigint;
  v_clock          timestamptz;
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
  v_invoices       text;
  v_customers      text;
  v_header         record;
  v_applied        numeric;
  v_recorded_at    timestamptz;
  v_written        integer;
  v_check          record;
  v_event          uuid;
begin
  -- 0. Every argument, before anything is read, locked or written. A refusal carries a fixed message, never the value.
  if p_session_key is null or p_session_key !~ '^[\x21-\x7e]{1,128}$'
     or p_store_id is null
     or p_invoice_id is null
     or p_expected_tenant is null
     or p_payment_id is null
     or p_attempt_id is null then
    raise exception 'migration 036 record: an argument is malformed'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_amount_cents is null or p_amount_cents < 1 or p_amount_cents > 9007199254740991 then
    raise exception 'migration 036 record: the amount is out of range'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_method is null or not (p_method = any (c_methods)) then
    raise exception 'migration 036 record: the method is not one of the closed list'
      using errcode = 'invalid_parameter_value';
  end if;
  -- The correlation id is the audit record's request id: a version-4 uuid, as the runtime's (shape only; never proof).
  if p_correlation_id is null or p_correlation_id::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception 'migration 036 record: the correlation id is not a version-4 uuid'
      using errcode = 'invalid_parameter_value';
  end if;
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'migration 036 record: it must run under READ COMMITTED, so that its checks see what committed before its locks'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- 1. The caller, derived exactly as 035's void derives it (035 up :507-622, statement for statement; it restates 034's
  --    issue, never through 034's unlocked m7b_issue_store_reader).
  select s.auth_provider, s.auth_provider_uid, s.expires_at, m.expires_at, m.issuer_digest
    into v_provider, v_uid, v_expires, v_minted_expires, v_minted_issuer
    from tmpos_session.session s
    join tmpos_mint.tenant_session m on m.session_key = s.session_key
   where s.session_key = p_session_key
     and s.audience = 'tenant';
  if not found then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;
  v_now := pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp()) * 1000)::bigint;
  if v_expires is distinct from v_minted_expires or v_now >= v_expires then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;
  select pg_catalog.sha256(k.key) into v_issuer from tmpos_mint.issuer_key k where k.singleton;
  if v_issuer is null or v_issuer is distinct from v_minted_issuer then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;

  if tmpos_session.m5_hold_tenant_standing(v_provider, v_uid) is distinct from 'held' then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;

  -- The session row's authenticated_at is read here, under the row's FOR SHARE lock, for step 6.
  select s.expires_at, s.authenticated_at, m.standing_digest, m.issuer_digest, m.expires_at as minted_expires_at
    into v_session
    from tmpos_session.session s
    join tmpos_mint.tenant_session m on m.session_key = s.session_key
   where s.session_key = p_session_key
     and s.audience = 'tenant'
     and s.auth_provider = v_provider
     and s.auth_provider_uid = v_uid
     for share of s, m;
  if not found or v_session.expires_at is distinct from v_session.minted_expires_at then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;

  select pg_catalog.sha256(k.key) into v_issuer from tmpos_mint.issuer_key k where k.singleton for share;
  if v_issuer is null or v_issuer is distinct from v_session.issuer_digest then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;

  v_now := pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp()) * 1000)::bigint;
  if v_now >= v_session.expires_at then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid;
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
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;

  --    EXACTLY ONE store-scope grant naming p_store_id — a selector among the actor's own grants, never proof — on a tenant
  --    and a store whose statuses are write statuses. A tenant grant and a grant at another store never count.
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
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;
  v_role := v_grants -> 0 ->> 'roleId';
  v_tenant := (v_grants -> 0 ->> 'tenantId')::uuid;
  v_membership := (v_grants -> 0 ->> 'membershipId')::uuid;
  --    Still that actor's active membership row at exactly that tenant, store and role (016's hold holds it).
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
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;
  --    The store row, re-read FOR SHARE (016's hold already holds it): in that grant's tenant, with a write status.
  select st.tenant_id, st.status into v_store
    from public.store st
   where st.store_id = p_store_id
     for share;
  if not found
     or v_store.tenant_id is distinct from v_tenant
     or v_store.status is null
     or v_store.status not in ('active', 'trialing') then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;
  -- 2. The role's levels, UNLOCKED: Invoices at Approve or above AND Customers at View or above (D-PAY-6 A). store_owner is
  --    Full (never stored); an editable role is its stored level, else its catalog default; any other role refuses.
  if v_role = 'store_owner' then
    null;
  elsif v_role in ('manager', 'technician', 'sales_staff') then
    select l.level into v_invoices
      from tmpos_role.tenant_role_level l
     where l.tenant_id = v_tenant and l.role_id = v_role and l.domain = 'invoices';
    select l.level into v_customers
      from tmpos_role.tenant_role_level l
     where l.tenant_id = v_tenant and l.role_id = v_role and l.domain = 'customers';
    if coalesce(pg_catalog.array_position(c_levels,
         coalesce(v_invoices, case v_role when 'manager' then 'full' when 'technician' then 'view' when 'sales_staff' then 'create' end)), 0)
       < pg_catalog.array_position(c_levels, 'approve')
       or coalesce(pg_catalog.array_position(c_levels,
         coalesce(v_customers, case v_role when 'manager' then 'full' when 'technician' then 'view' when 'sales_staff' then 'create' end)), 0)
       < pg_catalog.array_position(c_levels, 'view') then
      return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid;
      return;
    end if;
  else
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;

  -- 3. The request's expectedTenant against the tenant derived from the grant — a precondition only.
  if v_tenant is distinct from p_expected_tenant then
    return query select 'tenant_mismatch'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;

  -- 4. THE ISSUED HEADER, locked FOR UPDATE until COMMIT, by id, derived tenant and path store ONLY (035's step-4 slot):
  --    missing, another store's and another tenant's are one answer. Records, reversals and voids of this invoice serialize here.
  select i.invoice_id, i.tenant_id, i.store_id, i.total_cents, i.currency
    into v_header
    from tmpos_invoice_issue.issued_invoice i
   where i.invoice_id = p_invoice_id
     and i.tenant_id = v_tenant
     and i.store_id = p_store_id
     for update;
  if not found then
    return query select 'not_found'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;

  -- 5. THE GUARD (030's key, as 034's issue holds it): SHARED until COMMIT, then BOTH levels read again by plain SELECTs.
  --    Separate top-level statements of the outermost block, never inside a BEGIN ... EXCEPTION block (a subtransaction that
  --    aborts releases a transaction-scoped advisory lock). store_owner takes no key and no read.
  if v_role in ('manager', 'technician', 'sales_staff') then
    perform pg_catalog.pg_advisory_xact_lock_shared(530030, pg_catalog.hashtext(v_tenant::text || '/' || v_role));
    select l.level into v_invoices
      from tmpos_role.tenant_role_level l
     where l.tenant_id = v_tenant and l.role_id = v_role and l.domain = 'invoices';
    select l.level into v_customers
      from tmpos_role.tenant_role_level l
     where l.tenant_id = v_tenant and l.role_id = v_role and l.domain = 'customers';
    if coalesce(pg_catalog.array_position(c_levels,
         coalesce(v_invoices, case v_role when 'manager' then 'full' when 'technician' then 'view' when 'sales_staff' then 'create' end)), 0)
       < pg_catalog.array_position(c_levels, 'approve')
       or coalesce(pg_catalog.array_position(c_levels,
         coalesce(v_customers, case v_role when 'manager' then 'full' when 'technician' then 'view' when 'sales_staff' then 'create' end)), 0)
       < pg_catalog.array_position(c_levels, 'view') then
      return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid;
      return;
    end if;
  end if;

  -- 6. AFTER THE LAST LOCK WAIT, on the database clock: the session's expiry (no recent sign-in for a record: D-PAY-6 A).
  v_clock := pg_catalog.clock_timestamp();
  v_now := pg_catalog.floor(extract(epoch from v_clock) * 1000)::bigint;
  if v_now >= v_session.expires_at then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;

  -- 7. A SEPARATE STATEMENT after every lock: this attempt already recorded on this invoice (reversed or not), first
  --    (D-PAY-7 A). A different invoice is a different attempt; nothing here reads another invoice's payments.
  if exists (select 1 from tmpos_invoice_payment.invoice_payment p
              where p.invoice_id = p_invoice_id and p.tenant_id = v_tenant and p.store_id = p_store_id
                and p.attempt_id = p_attempt_id) then
    return query select 'already_recorded'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;

  -- 8. A SEPARATE STATEMENT: a voided invoice takes no payment (D-PAY-5 A).
  if exists (select 1 from tmpos_invoice_void.issued_invoice_void v where v.invoice_id = p_invoice_id) then
    return query select 'invalid_state'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;

  -- 9. A SEPARATE STATEMENT: the unreversed sum plus this amount, in numeric (no overflow), against the immutable Total
  --    (D-PAY-2 A). Under READ COMMITTED it sees every payment that committed while step 4 waited.
  select coalesce(pg_catalog.sum(p.amount_cents), 0) into v_applied
    from tmpos_invoice_payment.invoice_payment p
   where p.invoice_id = p_invoice_id and p.tenant_id = v_tenant and p.store_id = p_store_id
     and not exists (select 1 from tmpos_invoice_payment.invoice_payment_reversal r where r.payment_id = p.payment_id);
  if v_applied + p_amount_cents::numeric > v_header.total_cents::numeric then
    return query select 'amount_exceeds_remaining'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;

  -- 10. The payment: one insert, its tenant and store the locked header's. Every constraint violation is fixed text.
  v_recorded_at := pg_catalog.clock_timestamp();
  begin
    insert into tmpos_invoice_payment.invoice_payment
      (payment_id, tenant_id, store_id, invoice_id, attempt_id, amount_cents, method, recorded_at, recorded_by)
    values (p_payment_id, v_header.tenant_id, v_header.store_id, p_invoice_id, p_attempt_id, p_amount_cents, p_method,
            v_recorded_at, v_admission.actor_id);
    get diagnostics v_written = row_count;
  exception
    when unique_violation or check_violation or foreign_key_violation or not_null_violation or restrict_violation then
      raise exception 'migration 036 record: the payment is not one the payment table admits'
        using errcode = 'integrity_constraint_violation';
  end;
  if v_written is distinct from 1 then
    raise exception 'migration 036 record: the payment was not written to exactly the locked invoice'
      using errcode = 'no_data_found';
  end if;
  select p.tenant_id, p.store_id, p.invoice_id, p.attempt_id, p.amount_cents, p.method, p.recorded_at, p.recorded_by
    into v_check
    from tmpos_invoice_payment.invoice_payment p
   where p.payment_id = p_payment_id;
  if not found
     or v_check.tenant_id is distinct from v_tenant
     or v_check.store_id is distinct from p_store_id
     or v_check.invoice_id is distinct from p_invoice_id
     or v_check.attempt_id is distinct from p_attempt_id
     or v_check.amount_cents is distinct from p_amount_cents
     or v_check.method is distinct from p_method
     or v_check.recorded_at is distinct from v_recorded_at
     or v_check.recorded_by is distinct from v_admission.actor_id then
    raise exception 'migration 036 record: the payment is not the one judged'
      using errcode = 'no_data_found';
  end if;

  -- 11. THE AUDIT RECORD (D-PAY-8 A), after the last refusal, in this transaction: every value but the correlation id derived
  --     here. Exactly one row, or the payment rolls back with it: a BEFORE INSERT trigger answering NULL would drop it silently.
  v_event := null;
  begin
    insert into public.audit_event
      (request_id, trace_id, actor_internal_user_id, actor_auth_provider, on_behalf_of_internal_user_id, scope_type, tenant_id,
       store_id, action_id, required_permission, decision, reason_code, human_readable_reason, result_status, source_of_truth,
       evaluated_by, evidence_level, metadata, subject_invoice_payment_id)
    values (p_correlation_id::text, null, v_admission.actor_id, null, null, 'store', v_tenant, p_store_id,
            'store.invoice_payment.record', 'record_invoice_payments', 'allow', 'invoice_payment_recorded_' || p_method,
            'Payment recorded against an issued invoice. Method: '
              || c_method_labels[pg_catalog.array_position(c_methods, p_method)] || '.',
            'succeeded', 'invoice_payment_routine', 'm7b_invoice_payment_routine@v1', 'durable_compliance_event', '{}'::jsonb,
            p_payment_id)
    returning event_id into v_event;
    get diagnostics v_written = row_count;
  exception
    when unique_violation or check_violation or foreign_key_violation or not_null_violation or restrict_violation then
      raise exception 'migration 036 record: the audit record is not one the audit table admits'
        using errcode = 'integrity_constraint_violation';
  end;
  if v_written is distinct from 1 or v_event is null
     or not exists (select 1 from public.audit_event a
                     where a.event_id = v_event and a.request_id = p_correlation_id::text
                       and a.action_id = 'store.invoice_payment.record' and a.actor_internal_user_id = v_admission.actor_id
                       and a.tenant_id = v_tenant and a.store_id = p_store_id and a.subject_invoice_payment_id = p_payment_id) then
    raise exception 'migration 036 record: the audit record was not written exactly once'
      using errcode = 'no_data_found';
  end if;

  -- 12. Applied.
  return query select 'applied'::text, v_tenant, p_store_id, v_admission.actor_id, v_membership, p_payment_id, p_invoice_id, v_event;
end
$$;

comment on function tmpos_invoice_payment.m7b_invoice_payment_record(text, uuid, uuid, uuid, uuid, uuid, bigint, text, uuid) is
  'Phase 4.0 M7b (migration 036): records one payment against one issued invoice of a store, for 035''s void''s caller derivation (a ledger-minted, live tenant session under the installed issuer key, 016''s hold, an unchanged standing, an active or trialing account, EXACTLY ONE store grant at p_store_id on an active or trialing tenant and store, still its active membership, the store row FOR SHARE) and a role whose Invoices level is Approve or above AND Customers level View or above (store_owner Full) — read unlocked, then again after the issued header is locked FOR UPDATE under pg_advisory_xact_lock_shared(530030, hashtext(tenant || ''/'' || role)) for an editable role — and a live session after the last lock wait. Answers one row: (''refused'', NULLs); (''tenant_mismatch'', NULLs); (''not_found'', NULLs) alike for a missing, another store''s and another tenant''s invoice; then, the header locked, each a separate read: (''already_recorded'', NULLs) for an attempt already recorded on this invoice, (''invalid_state'', NULLs) for a voided invoice, (''amount_exceeds_remaining'', NULLs) when the unreversed sum plus the amount exceeds the Total — every one with nothing written; else writes one payment (clock_timestamp(), the actor) and one audit record (the derived actor, scope, permission, action and fixed text; the correlation id as request_id; exactly one row, read back) and answers (''applied'', tenant, store, actor, membership, payment, invoice, audit event id). Raises invalid_parameter_value (fixed message) for a malformed argument, an amount outside 1..9007199254740991, a method outside the closed list or a correlation id that is not a version-4 uuid, object_not_in_prerequisite_state outside READ COMMITTED, integrity_constraint_violation (fixed text) for a constraint refusal. Writes no outbox or idempotency record.';

-- =============================================================================
-- 9) The reversal
-- =============================================================================
create function tmpos_invoice_payment.m7b_invoice_payment_reverse(
  p_session_key text, p_store_id uuid, p_invoice_id uuid, p_payment_id uuid, p_expected_tenant uuid, p_expected_version bigint,
  p_reason_code text, p_correlation_id uuid)
returns table (
  o_outcome        text,
  o_tenant_id      uuid,
  o_store_id       uuid,
  o_actor_id       uuid,
  o_membership_id  uuid,
  o_version        bigint,
  o_payment_id     uuid,
  o_audit_event_id uuid
)
language plpgsql
-- VOLATILE IS LOAD-BEARING (033's reason): steps 5 and 8 must see what committed before the routine's own locks.
volatile
security definer
set search_path = pg_catalog, pg_temp
set row_security = off
as $$
declare
  c_levels         constant text[] := array['none', 'view', 'create', 'edit', 'manage', 'approve', 'full'];
  -- The closed reversal reasons (D-PAY-4 A), in their order, and their labels.
  c_reasons        constant text[] := array['recorded_in_error', 'wrong_amount', 'wrong_method', 'wrong_invoice', 'duplicate', 'other'];
  c_reason_labels  constant text[] := array['Recorded by mistake', 'Wrong amount', 'Wrong method', 'Wrong invoice',
                                             'Payment recorded twice', 'Other reason'];
  v_now            bigint;
  v_clock          timestamptz;
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
  v_invoices       text;
  v_customers      text;
  v_header         record;
  v_payment        record;
  v_reversed_at    timestamptz;
  v_written        integer;
  v_check          record;
  v_event          uuid;
begin
  -- 0. Every argument, before anything is read, locked or written.
  if p_session_key is null or p_session_key !~ '^[\x21-\x7e]{1,128}$'
     or p_store_id is null
     or p_invoice_id is null
     or p_payment_id is null
     or p_expected_tenant is null then
    raise exception 'migration 036 reverse: an argument is malformed'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_expected_version is null or p_expected_version < 1 or p_expected_version > 9007199254740990 then
    raise exception 'migration 036 reverse: the expected version is out of range'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_reason_code is null or not (p_reason_code = any (c_reasons)) then
    raise exception 'migration 036 reverse: the reason code is not one of the closed list'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_correlation_id is null or p_correlation_id::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception 'migration 036 reverse: the correlation id is not a version-4 uuid'
      using errcode = 'invalid_parameter_value';
  end if;
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'migration 036 reverse: it must run under READ COMMITTED, so that its checks see what committed before its locks'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- 1. The caller, derived exactly as 035's void derives it (035 up :507-622, statement for statement; it restates 034's
  --    issue, never through 034's unlocked m7b_issue_store_reader).
  select s.auth_provider, s.auth_provider_uid, s.expires_at, m.expires_at, m.issuer_digest
    into v_provider, v_uid, v_expires, v_minted_expires, v_minted_issuer
    from tmpos_session.session s
    join tmpos_mint.tenant_session m on m.session_key = s.session_key
   where s.session_key = p_session_key
     and s.audience = 'tenant';
  if not found then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid, null::uuid;
    return;
  end if;
  v_now := pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp()) * 1000)::bigint;
  if v_expires is distinct from v_minted_expires or v_now >= v_expires then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid, null::uuid;
    return;
  end if;
  select pg_catalog.sha256(k.key) into v_issuer from tmpos_mint.issuer_key k where k.singleton;
  if v_issuer is null or v_issuer is distinct from v_minted_issuer then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid, null::uuid;
    return;
  end if;

  if tmpos_session.m5_hold_tenant_standing(v_provider, v_uid) is distinct from 'held' then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid, null::uuid;
    return;
  end if;

  -- The session row's authenticated_at is read here, under the row's FOR SHARE lock, for step 6.
  select s.expires_at, s.authenticated_at, m.standing_digest, m.issuer_digest, m.expires_at as minted_expires_at
    into v_session
    from tmpos_session.session s
    join tmpos_mint.tenant_session m on m.session_key = s.session_key
   where s.session_key = p_session_key
     and s.audience = 'tenant'
     and s.auth_provider = v_provider
     and s.auth_provider_uid = v_uid
     for share of s, m;
  if not found or v_session.expires_at is distinct from v_session.minted_expires_at then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid, null::uuid;
    return;
  end if;

  select pg_catalog.sha256(k.key) into v_issuer from tmpos_mint.issuer_key k where k.singleton for share;
  if v_issuer is null or v_issuer is distinct from v_session.issuer_digest then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid, null::uuid;
    return;
  end if;

  v_now := pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp()) * 1000)::bigint;
  if v_now >= v_session.expires_at then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid, null::uuid;
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
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid, null::uuid;
    return;
  end if;

  --    EXACTLY ONE store-scope grant naming p_store_id — a selector among the actor's own grants, never proof — on a tenant
  --    and a store whose statuses are write statuses. A tenant grant and a grant at another store never count.
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
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid, null::uuid;
    return;
  end if;
  v_role := v_grants -> 0 ->> 'roleId';
  v_tenant := (v_grants -> 0 ->> 'tenantId')::uuid;
  v_membership := (v_grants -> 0 ->> 'membershipId')::uuid;
  --    Still that actor's active membership row at exactly that tenant, store and role (016's hold holds it).
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
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid, null::uuid;
    return;
  end if;
  --    The store row, re-read FOR SHARE (016's hold already holds it): in that grant's tenant, with a write status.
  select st.tenant_id, st.status into v_store
    from public.store st
   where st.store_id = p_store_id
     for share;
  if not found
     or v_store.tenant_id is distinct from v_tenant
     or v_store.status is null
     or v_store.status not in ('active', 'trialing') then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid, null::uuid;
    return;
  end if;
  -- 2. The role's levels, UNLOCKED: Invoices at Approve or above AND Customers at View or above (D-PAY-6 A). store_owner is
  --    Full (never stored); an editable role is its stored level, else its catalog default; any other role refuses.
  if v_role = 'store_owner' then
    null;
  elsif v_role in ('manager', 'technician', 'sales_staff') then
    select l.level into v_invoices
      from tmpos_role.tenant_role_level l
     where l.tenant_id = v_tenant and l.role_id = v_role and l.domain = 'invoices';
    select l.level into v_customers
      from tmpos_role.tenant_role_level l
     where l.tenant_id = v_tenant and l.role_id = v_role and l.domain = 'customers';
    if coalesce(pg_catalog.array_position(c_levels,
         coalesce(v_invoices, case v_role when 'manager' then 'full' when 'technician' then 'view' when 'sales_staff' then 'create' end)), 0)
       < pg_catalog.array_position(c_levels, 'approve')
       or coalesce(pg_catalog.array_position(c_levels,
         coalesce(v_customers, case v_role when 'manager' then 'full' when 'technician' then 'view' when 'sales_staff' then 'create' end)), 0)
       < pg_catalog.array_position(c_levels, 'view') then
      return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid, null::uuid;
      return;
    end if;
  else
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid, null::uuid;
    return;
  end if;

  -- 3. The request's expectedTenant against the tenant derived from the grant — a precondition only.
  if v_tenant is distinct from p_expected_tenant then
    return query select 'tenant_mismatch'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid, null::uuid;
    return;
  end if;

  -- 4. THE PATH INVOICE'S ISSUED HEADER, locked FOR UPDATE until COMMIT (035's step-4 slot), by id, derived tenant and path
  --    store ONLY: missing, another store's and another tenant's are one answer.
  select i.invoice_id, i.tenant_id, i.store_id
    into v_header
    from tmpos_invoice_issue.issued_invoice i
   where i.invoice_id = p_invoice_id
     and i.tenant_id = v_tenant
     and i.store_id = p_store_id
     for update;
  if not found then
    return query select 'not_found'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid, null::uuid;
    return;
  end if;

  -- 5. The payment, by (payment, invoice, tenant, store) — a separate read after the header lock: a payment of another invoice,
  --    store or tenant, or none, is the same answer.
  select p.payment_id, p.recorded_at
    into v_payment
    from tmpos_invoice_payment.invoice_payment p
   where p.payment_id = p_payment_id
     and p.invoice_id = p_invoice_id
     and p.tenant_id = v_tenant
     and p.store_id = p_store_id;
  if not found then
    return query select 'not_found'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid, null::uuid;
    return;
  end if;

  -- 5. THE GUARD (030's key, as 034's issue holds it): SHARED until COMMIT, then BOTH levels read again by plain SELECTs.
  --    Separate top-level statements of the outermost block, never inside a BEGIN ... EXCEPTION block (a subtransaction that
  --    aborts releases a transaction-scoped advisory lock). store_owner takes no key and no read.
  if v_role in ('manager', 'technician', 'sales_staff') then
    perform pg_catalog.pg_advisory_xact_lock_shared(530030, pg_catalog.hashtext(v_tenant::text || '/' || v_role));
    select l.level into v_invoices
      from tmpos_role.tenant_role_level l
     where l.tenant_id = v_tenant and l.role_id = v_role and l.domain = 'invoices';
    select l.level into v_customers
      from tmpos_role.tenant_role_level l
     where l.tenant_id = v_tenant and l.role_id = v_role and l.domain = 'customers';
    if coalesce(pg_catalog.array_position(c_levels,
         coalesce(v_invoices, case v_role when 'manager' then 'full' when 'technician' then 'view' when 'sales_staff' then 'create' end)), 0)
       < pg_catalog.array_position(c_levels, 'approve')
       or coalesce(pg_catalog.array_position(c_levels,
         coalesce(v_customers, case v_role when 'manager' then 'full' when 'technician' then 'view' when 'sales_staff' then 'create' end)), 0)
       < pg_catalog.array_position(c_levels, 'view') then
      return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid, null::uuid;
      return;
    end if;
  end if;

  -- 7. AFTER THE LAST LOCK WAIT, on one reading of the database clock: the session's expiry, then the recent sign-in from the
  --    session row's authenticated_at — NULL, more than 5000 ms in the future (sessions.ts MAX_CLOCK_SKEW_MS), or older than
  --    600000 ms (RECENT_AUTH_MAX_AGE_MS; exactly at the bound it still holds) refuse. 035's step 6, restated.
  v_clock := pg_catalog.clock_timestamp();
  v_now := pg_catalog.floor(extract(epoch from v_clock) * 1000)::bigint;
  if v_now >= v_session.expires_at
     or v_session.authenticated_at is null
     or pg_catalog.to_timestamp(v_session.authenticated_at / 1000.0) > v_clock + interval '5000 milliseconds'
     or v_clock > pg_catalog.to_timestamp((v_session.authenticated_at + 600000) / 1000.0) then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid, null::uuid;
    return;
  end if;

  -- 8. A SEPARATE STATEMENT after every lock: a reversal of this payment exists — terminal, whatever version is named.
  if exists (select 1 from tmpos_invoice_payment.invoice_payment_reversal r where r.payment_id = p_payment_id) then
    return query select 'invalid_state'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid, null::uuid;
    return;
  end if;

  -- 9. The payment's lifecycle version: 1 while active.
  if p_expected_version is distinct from 1::bigint then
    return query select 'conflict'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid, null::uuid;
    return;
  end if;

  -- 10. The reversal: one insert, its scope the payment's.
  v_reversed_at := pg_catalog.clock_timestamp();
  begin
    insert into tmpos_invoice_payment.invoice_payment_reversal
      (payment_id, tenant_id, store_id, invoice_id, reason_code, reversed_at, reversed_by)
    values (p_payment_id, v_header.tenant_id, v_header.store_id, p_invoice_id, p_reason_code, v_reversed_at, v_admission.actor_id);
    get diagnostics v_written = row_count;
  exception
    when unique_violation or check_violation or foreign_key_violation or not_null_violation or restrict_violation then
      raise exception 'migration 036 reverse: the reversal is not one the reversal table admits'
        using errcode = 'integrity_constraint_violation';
  end;
  if v_written is distinct from 1 then
    raise exception 'migration 036 reverse: the reversal was not written to exactly the locked payment'
      using errcode = 'no_data_found';
  end if;
  select r.tenant_id, r.store_id, r.invoice_id, r.reason_code, r.reversed_at, r.reversed_by
    into v_check
    from tmpos_invoice_payment.invoice_payment_reversal r
   where r.payment_id = p_payment_id;
  if not found
     or v_check.tenant_id is distinct from v_tenant
     or v_check.store_id is distinct from p_store_id
     or v_check.invoice_id is distinct from p_invoice_id
     or v_check.reason_code is distinct from p_reason_code
     or v_check.reversed_at is distinct from v_reversed_at
     or v_check.reversed_by is distinct from v_admission.actor_id then
    raise exception 'migration 036 reverse: the reversal is not the one judged'
      using errcode = 'no_data_found';
  end if;

  -- 11. THE AUDIT RECORD (D-PAY-8 A), exactly one row or nothing commits.
  v_event := null;
  begin
    insert into public.audit_event
      (request_id, trace_id, actor_internal_user_id, actor_auth_provider, on_behalf_of_internal_user_id, scope_type, tenant_id,
       store_id, action_id, required_permission, decision, reason_code, human_readable_reason, result_status, source_of_truth,
       evaluated_by, evidence_level, metadata, subject_invoice_payment_id)
    values (p_correlation_id::text, null, v_admission.actor_id, null, null, 'store', v_tenant, p_store_id,
            'store.invoice_payment.reverse', 'reverse_invoice_payments', 'allow', 'invoice_payment_reversed_' || p_reason_code,
            'Recorded payment reversed. Reason: '
              || c_reason_labels[pg_catalog.array_position(c_reasons, p_reason_code)] || '.',
            'succeeded', 'invoice_payment_routine', 'm7b_invoice_payment_routine@v1', 'durable_compliance_event', '{}'::jsonb,
            p_payment_id)
    returning event_id into v_event;
    get diagnostics v_written = row_count;
  exception
    when unique_violation or check_violation or foreign_key_violation or not_null_violation or restrict_violation then
      raise exception 'migration 036 reverse: the audit record is not one the audit table admits'
        using errcode = 'integrity_constraint_violation';
  end;
  if v_written is distinct from 1 or v_event is null
     or not exists (select 1 from public.audit_event a
                     where a.event_id = v_event and a.request_id = p_correlation_id::text
                       and a.action_id = 'store.invoice_payment.reverse' and a.actor_internal_user_id = v_admission.actor_id
                       and a.tenant_id = v_tenant and a.store_id = p_store_id and a.subject_invoice_payment_id = p_payment_id) then
    raise exception 'migration 036 reverse: the audit record was not written exactly once'
      using errcode = 'no_data_found';
  end if;

  -- 12. Applied: the payment's lifecycle version moves 1 -> 2.
  return query select 'applied'::text, v_tenant, p_store_id, v_admission.actor_id, v_membership, p_expected_version + 1, p_payment_id,
    v_event;
end
$$;

comment on function tmpos_invoice_payment.m7b_invoice_payment_reverse(text, uuid, uuid, uuid, uuid, bigint, text, uuid) is
  'Phase 4.0 M7b (migration 036): reverses one recorded payment of one issued invoice of a store (a reversal record; the payment stays; no money moves), for 035''s void''s caller derivation and a role whose Invoices level is Approve or above AND Customers level View or above (store_owner Full) — read unlocked, then again after the issued header is locked FOR UPDATE under pg_advisory_xact_lock_shared(530030, hashtext(tenant || ''/'' || role)) for an editable role — and, after the last lock wait on the database clock, a live session whose authenticated_at is present, at most 5000 ms in the future and at most 600000 ms old. Answers one row: (''refused'', NULLs); (''tenant_mismatch'', NULLs); (''not_found'', NULLs) alike for a missing, another store''s or another tenant''s invoice and for a payment that is not of that invoice, tenant and store; then (''invalid_state'', NULLs) for a payment already reversed (a separate read after every lock), (''conflict'', NULLs) for an expected version other than 1 — every one with nothing written; else writes one reversal record (reason code, clock_timestamp(), the actor) and one audit record (exactly one row, read back) and answers (''applied'', tenant, store, actor, membership, p_expected_version + 1, payment, audit event id). Raises invalid_parameter_value (fixed message) for a malformed argument, a version outside 1..9007199254740990, a reason outside the closed list or a correlation id that is not a version-4 uuid, object_not_in_prerequisite_state outside READ COMMITTED, integrity_constraint_violation (fixed text) for a constraint refusal. Writes no outbox or idempotency record.';

-- =============================================================================
-- 10) The void, replaced: 035's with the payment check (A2, A3)
-- =============================================================================
create function tmpos_invoice_payment.m7b_invoice_void_v2(
  p_session_key text, p_store_id uuid, p_invoice_id uuid, p_expected_tenant uuid, p_expected_version bigint,
  p_reason_code text)
returns table (
  o_outcome       text,
  o_tenant_id     uuid,
  o_store_id      uuid,
  o_actor_id      uuid,
  o_membership_id uuid,
  o_version       bigint,
  o_invoice_id    uuid
)
language plpgsql
-- VOLATILE IS LOAD-BEARING (033's reason): steps 7 and 7b must see what committed before its own locks.
volatile
security definer
set search_path = pg_catalog, pg_temp
set row_security = off
as $$
declare
  -- The tenant ordering (permissionCatalog.ts TENANT_ORDERING), 020's constant, pinned by the parity test.
  c_levels         constant text[] := array['none', 'view', 'create', 'edit', 'manage', 'approve', 'full'];
  -- The closed reason codes (035's contract §2), in their order.
  c_reasons        constant text[] := array['issued_in_error', 'wrong_customer', 'wrong_lines_or_amounts',
                                            'wrong_seller_details', 'duplicate', 'other'];
  v_now            bigint;
  v_clock          timestamptz;
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
  v_invoices       text;
  v_customers      text;
  v_header         record;
  v_voided_at      timestamptz;
  v_written        integer;
  v_check          record;
begin
  -- 0. Every argument, before anything is read, locked or written. A refusal carries a fixed message, never the value.
  if p_session_key is null or p_session_key !~ '^[\x21-\x7e]{1,128}$'
     or p_store_id is null
     or p_invoice_id is null
     or p_expected_tenant is null then
    raise exception 'migration 036 void: an argument is malformed'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_expected_version is null or p_expected_version < 1 or p_expected_version > 9007199254740990 then
    raise exception 'migration 036 void: the expected version is out of range'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_reason_code is null or not (p_reason_code = any (c_reasons)) then
    raise exception 'migration 036 void: the reason code is not one of the closed list'
      using errcode = 'invalid_parameter_value';
  end if;
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'migration 036 void: it must run under READ COMMITTED, so that its checks see what committed before its locks'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- 1. The caller, derived exactly as 035's void derives it (035 up :507-622, statement for statement; never through
  --    034's unlocked m7b_issue_store_reader).
  select s.auth_provider, s.auth_provider_uid, s.expires_at, m.expires_at, m.issuer_digest
    into v_provider, v_uid, v_expires, v_minted_expires, v_minted_issuer
    from tmpos_session.session s
    join tmpos_mint.tenant_session m on m.session_key = s.session_key
   where s.session_key = p_session_key
     and s.audience = 'tenant';
  if not found then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid;
    return;
  end if;
  v_now := pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp()) * 1000)::bigint;
  if v_expires is distinct from v_minted_expires or v_now >= v_expires then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid;
    return;
  end if;
  select pg_catalog.sha256(k.key) into v_issuer from tmpos_mint.issuer_key k where k.singleton;
  if v_issuer is null or v_issuer is distinct from v_minted_issuer then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid;
    return;
  end if;

  if tmpos_session.m5_hold_tenant_standing(v_provider, v_uid) is distinct from 'held' then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid;
    return;
  end if;

  -- The session row's authenticated_at is read here, under the row's FOR SHARE lock, for step 6.
  select s.expires_at, s.authenticated_at, m.standing_digest, m.issuer_digest, m.expires_at as minted_expires_at
    into v_session
    from tmpos_session.session s
    join tmpos_mint.tenant_session m on m.session_key = s.session_key
   where s.session_key = p_session_key
     and s.audience = 'tenant'
     and s.auth_provider = v_provider
     and s.auth_provider_uid = v_uid
     for share of s, m;
  if not found or v_session.expires_at is distinct from v_session.minted_expires_at then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid;
    return;
  end if;

  select pg_catalog.sha256(k.key) into v_issuer from tmpos_mint.issuer_key k where k.singleton for share;
  if v_issuer is null or v_issuer is distinct from v_session.issuer_digest then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid;
    return;
  end if;

  v_now := pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp()) * 1000)::bigint;
  if v_now >= v_session.expires_at then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid;
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
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid;
    return;
  end if;

  --    EXACTLY ONE store-scope grant naming p_store_id — a selector among the actor's own grants, never proof — on a tenant
  --    and a store whose statuses are write statuses. A tenant grant and a grant at another store never count.
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
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid;
    return;
  end if;
  v_role := v_grants -> 0 ->> 'roleId';
  v_tenant := (v_grants -> 0 ->> 'tenantId')::uuid;
  v_membership := (v_grants -> 0 ->> 'membershipId')::uuid;
  --    Still that actor's active membership row at exactly that tenant, store and role (016's hold holds it).
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
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid;
    return;
  end if;
  --    The store row, re-read FOR SHARE (016's hold already holds it): in that grant's tenant, with a write status.
  select st.tenant_id, st.status into v_store
    from public.store st
   where st.store_id = p_store_id
     for share;
  if not found
     or v_store.tenant_id is distinct from v_tenant
     or v_store.status is null
     or v_store.status not in ('active', 'trialing') then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid;
    return;
  end if;

  -- 2. The role's levels, UNLOCKED: Invoices at Approve or above AND Customers at View or above (D-VOID-2). store_owner is
  --    Full (never stored); an editable role is its stored level, else its catalog default; any other role refuses.
  if v_role = 'store_owner' then
    null;
  elsif v_role in ('manager', 'technician', 'sales_staff') then
    select l.level into v_invoices
      from tmpos_role.tenant_role_level l
     where l.tenant_id = v_tenant and l.role_id = v_role and l.domain = 'invoices';
    select l.level into v_customers
      from tmpos_role.tenant_role_level l
     where l.tenant_id = v_tenant and l.role_id = v_role and l.domain = 'customers';
    if coalesce(pg_catalog.array_position(c_levels,
         coalesce(v_invoices, case v_role when 'manager' then 'full' when 'technician' then 'view' when 'sales_staff' then 'create' end)), 0)
       < pg_catalog.array_position(c_levels, 'approve')
       or coalesce(pg_catalog.array_position(c_levels,
         coalesce(v_customers, case v_role when 'manager' then 'full' when 'technician' then 'view' when 'sales_staff' then 'create' end)), 0)
       < pg_catalog.array_position(c_levels, 'view') then
      return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid;
      return;
    end if;
  else
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid;
    return;
  end if;

  -- 3. The request's expectedTenant against the tenant derived from the grant — a precondition only.
  if v_tenant is distinct from p_expected_tenant then
    return query select 'tenant_mismatch'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid;
    return;
  end if;

  -- 4. THE ISSUED HEADER, locked FOR UPDATE until COMMIT, filtered by id, derived tenant and path store ONLY: missing, another
  --    store's and another tenant's are one answer. A waiter re-reads the header a concurrent void left locked; a locking read
  --    fires no row trigger, so 034's guard is not touched.
  select i.invoice_id, i.tenant_id, i.store_id
    into v_header
    from tmpos_invoice_issue.issued_invoice i
   where i.invoice_id = p_invoice_id
     and i.tenant_id = v_tenant
     and i.store_id = p_store_id
     for update;
  if not found then
    return query select 'not_found'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid;
    return;
  end if;

  -- 5. THE GUARD (030's key, as 034's issue holds it): SHARED until COMMIT, then BOTH levels read again by plain SELECTs.
  --    Separate top-level statements of the outermost block, never inside a BEGIN ... EXCEPTION block (a subtransaction that
  --    aborts releases a transaction-scoped advisory lock). store_owner takes no key and no read.
  if v_role in ('manager', 'technician', 'sales_staff') then
    perform pg_catalog.pg_advisory_xact_lock_shared(530030, pg_catalog.hashtext(v_tenant::text || '/' || v_role));
    select l.level into v_invoices
      from tmpos_role.tenant_role_level l
     where l.tenant_id = v_tenant and l.role_id = v_role and l.domain = 'invoices';
    select l.level into v_customers
      from tmpos_role.tenant_role_level l
     where l.tenant_id = v_tenant and l.role_id = v_role and l.domain = 'customers';
    if coalesce(pg_catalog.array_position(c_levels,
         coalesce(v_invoices, case v_role when 'manager' then 'full' when 'technician' then 'view' when 'sales_staff' then 'create' end)), 0)
       < pg_catalog.array_position(c_levels, 'approve')
       or coalesce(pg_catalog.array_position(c_levels,
         coalesce(v_customers, case v_role when 'manager' then 'full' when 'technician' then 'view' when 'sales_staff' then 'create' end)), 0)
       < pg_catalog.array_position(c_levels, 'view') then
      return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid;
      return;
    end if;
  end if;

  -- 6. AFTER THE LAST LOCK WAIT, on one reading of the database clock: the session's expiry, then the recent sign-in from the
  --    session row's authenticated_at — NULL, more than 5000 ms in the future (sessions.ts MAX_CLOCK_SKEW_MS), or older than
  --    600000 ms (RECENT_AUTH_MAX_AGE_MS; authenticationFresh's comparator, so exactly at the bound it still holds) refuse.
  --    A wait past the window never passes on an earlier decision.
  v_clock := pg_catalog.clock_timestamp();
  v_now := pg_catalog.floor(extract(epoch from v_clock) * 1000)::bigint;
  if v_now >= v_session.expires_at
     or v_session.authenticated_at is null
     or pg_catalog.to_timestamp(v_session.authenticated_at / 1000.0) > v_clock + interval '5000 milliseconds'
     or v_clock > pg_catalog.to_timestamp((v_session.authenticated_at + 600000) / 1000.0) then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid;
    return;
  end if;

  -- 7. A SEPARATE STATEMENT after every lock (READ COMMITTED: it sees a void that committed while step 4 waited). A voided
  --    invoice is terminal, whatever version is named.
  if exists (select 1 from tmpos_invoice_void.issued_invoice_void v where v.invoice_id = p_invoice_id) then
    return query select 'invalid_state'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid;
    return;
  end if;

  -- 7b. A SEPARATE STATEMENT after every lock (A2, A3): a payment of this invoice with no reversal. Under READ COMMITTED it
  --     sees a payment that committed while step 4 waited; the record routine takes the same header first, so none can
  --     commit after this read and before this void's COMMIT.
  if exists (select 1 from tmpos_invoice_payment.invoice_payment p
              where p.invoice_id = p_invoice_id and p.tenant_id = v_tenant and p.store_id = p_store_id
                and not exists (select 1 from tmpos_invoice_payment.invoice_payment_reversal r where r.payment_id = p.payment_id)) then
    return query select 'payments_recorded'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid;
    return;
  end if;

  -- 8. The lifecycle version: 1 while issued (contract §3).
  if p_expected_version is distinct from 1::bigint then
    return query select 'conflict'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid;
    return;
  end if;

  -- 9. The write: one void record, its tenant and store the locked header's. Every constraint violation is fixed text, never
  --    a row value.
  v_voided_at := pg_catalog.clock_timestamp();
  begin
    insert into tmpos_invoice_void.issued_invoice_void (invoice_id, tenant_id, store_id, reason_code, voided_at, voided_by)
    values (p_invoice_id, v_header.tenant_id, v_header.store_id, p_reason_code, v_voided_at, v_admission.actor_id);
    get diagnostics v_written = row_count;
  exception
    when unique_violation or check_violation or foreign_key_violation or not_null_violation or restrict_violation then
      raise exception 'migration 036 void: the void record is not one the void table admits'
        using errcode = 'integrity_constraint_violation';
  end;
  if v_written is distinct from 1 then
    raise exception 'migration 036 void: the void was not written to exactly the locked invoice'
      using errcode = 'no_data_found';
  end if;
  select v.tenant_id, v.store_id, v.reason_code, v.voided_at, v.voided_by
    into v_check
    from tmpos_invoice_void.issued_invoice_void v
   where v.invoice_id = p_invoice_id;
  if not found
     or v_check.tenant_id is distinct from v_tenant
     or v_check.store_id is distinct from p_store_id
     or v_check.reason_code is distinct from p_reason_code
     or v_check.voided_at is distinct from v_voided_at
     or v_check.voided_by is distinct from v_admission.actor_id then
    raise exception 'migration 036 void: the void record is not the one judged'
      using errcode = 'no_data_found';
  end if;

  -- 10. Applied: the lifecycle version moves 1 -> 2.
  return query select 'applied'::text, v_tenant, p_store_id, v_admission.actor_id, v_membership, p_expected_version + 1,
    p_invoice_id;
end
$$;

comment on function tmpos_invoice_payment.m7b_invoice_void_v2(text, uuid, uuid, uuid, bigint, text) is
  'Phase 4.0 M7b (migration 036): migration 035''s m7b_invoice_void, argument for argument, word for word and step for step (its caller derivation, levels, tenant precondition, the issued header FOR UPDATE, key 530030 and the levels re-read, the session''s expiry and recent sign-in after the last wait, ''invalid_state'' for an invoice already voided), with one more separate read after every lock and before the version: (''payments_recorded'', NULLs) while any payment of the invoice has no reversal (amendments A2, A3) — nothing written; then (''conflict'', NULLs) for an expected version other than 1, else one void record in 035''s table and (''applied'', tenant, store, actor, membership, p_expected_version + 1, invoice id). Raises as 035''s. Writes no audit, outbox or idempotency record (DA-118 for the void, unchanged). tmpos_app no longer executes 035''s m7b_invoice_void.';

-- =============================================================================
-- 11) The payments read
-- =============================================================================
create function tmpos_invoice_payment.m7b_invoice_payments_get(
  p_session_key text, p_expected_tenant uuid, p_expected_store uuid, p_invoice_id uuid, p_after_payment_id uuid, p_limit integer)
returns table (
  o_outcome         text,
  o_tenant_id       uuid,
  o_store_id        uuid,
  o_invoice_id      uuid,
  o_status          text,
  o_currency        text,
  o_total_cents     bigint,
  o_due_cents       bigint,
  o_applied_cents   bigint,
  o_remaining_cents bigint,
  o_payment_status  text,
  o_payment_id      uuid,
  o_attempt_id      uuid,
  o_amount_cents    bigint,
  o_method          text,
  o_recorded_at     text,
  o_reversed_at     text,
  o_reason_code     text
)
language plpgsql
-- STABLE IS LOAD-BEARING: every statement here, 035's v2 get included, sees the calling query's one snapshot, so the invoice's
-- status, the totals, the word and the page are never a mixture of before and after a concurrent record, reversal or void.
stable
security definer
set search_path = pg_catalog, pg_temp
set row_security = off
as $$
declare
  v_head    record;
  -- The cursor's position as two scalars (NULL until a cursor is read): a RECORD variable never assigned would raise at the
  -- page statement however the predicate short-circuits, so a first page (no cursor) could not be read.
  v_after_at timestamptz;
  v_after_id uuid;
  v_active  numeric;
  v_due     numeric;
  v_applied numeric;
  v_word    text;
begin
  if p_limit is null or p_limit < 1 or p_limit > 51 then
    raise exception 'migration 036 read: the limit is out of range'
      using errcode = 'invalid_parameter_value';
  end if;
  -- 035's v2 get decides the authority (view_issued_invoices' levels), its words and its raises; only its first row is read.
  select r.o_outcome, r.o_tenant_id, r.o_store_id, r.o_invoice_id, r.o_currency, r.o_total_cents, r.o_status
    into v_head
    from tmpos_invoice_void.m7b_issued_invoice_get_v2(p_session_key, p_expected_tenant, p_expected_store, p_invoice_id)
           with ordinality as r
   order by r.ordinality
   limit 1;
  if not found or v_head.o_outcome is null then
    raise exception 'migration 036 read: the issued read answered no row'
      using errcode = 'data_corrupted';
  end if;
  if v_head.o_outcome in ('denied', 'not_found') then
    return query select v_head.o_outcome, null::uuid, null::uuid, null::uuid, null::text, null::text, null::bigint, null::bigint,
      null::bigint, null::bigint, null::text, null::uuid, null::uuid, null::bigint, null::text, null::text, null::text, null::text;
    return;
  end if;
  if v_head.o_outcome is distinct from 'line' or v_head.o_status not in ('issued', 'voided') or v_head.o_total_cents is null
     or v_head.o_total_cents < 0 then
    raise exception 'migration 036 read: the issued read answered an unexpected row'
      using errcode = 'data_corrupted';
  end if;
  if p_after_payment_id is not null then
    select p.recorded_at, p.payment_id into v_after_at, v_after_id
      from tmpos_invoice_payment.invoice_payment p
     where p.payment_id = p_after_payment_id and p.invoice_id = v_head.o_invoice_id
       and p.tenant_id = v_head.o_tenant_id and p.store_id = v_head.o_store_id;
    if not found then
      return query select 'cursor_unknown'::text, null::uuid, null::uuid, null::uuid, null::text, null::text, null::bigint,
        null::bigint, null::bigint, null::bigint, null::text, null::uuid, null::uuid, null::bigint, null::text, null::text,
        null::text, null::text;
      return;
    end if;
  end if;
  -- The amounts over the invoice's COMPLETE history, never one page, in numeric.
  select coalesce(pg_catalog.sum(p.amount_cents), 0) into v_active
    from tmpos_invoice_payment.invoice_payment p
   where p.invoice_id = v_head.o_invoice_id and p.tenant_id = v_head.o_tenant_id and p.store_id = v_head.o_store_id
     and not exists (select 1 from tmpos_invoice_payment.invoice_payment_reversal r where r.payment_id = p.payment_id);
  if v_head.o_status = 'voided' then
    -- A2 holds by construction (a void needs no active payment, a payment needs an unvoided invoice, both under the header).
    if v_active <> 0 then
      raise exception 'migration 036 read: a voided invoice holds an unreversed payment'
        using errcode = 'data_corrupted';
    end if;
    v_due := 0; v_applied := 0; v_word := 'voided';
  else
    if v_active > v_head.o_total_cents::numeric then
      raise exception 'migration 036 read: the unreversed payments exceed the invoice''s Total'
        using errcode = 'data_corrupted';
    end if;
    v_due := v_head.o_total_cents; v_applied := v_active;
    v_word := case when v_due = 0 then 'nothing_due'
                   when v_applied = 0 then 'no_payment_recorded'
                   when v_applied = v_due then 'recorded_in_full'
                   else 'recorded_partly' end;
  end if;
  return query
    select 'payments'::text, v_head.o_tenant_id, v_head.o_store_id, v_head.o_invoice_id, v_head.o_status, v_head.o_currency,
           v_head.o_total_cents, v_due::bigint, v_applied::bigint, (v_due - v_applied)::bigint, v_word,
           p.payment_id, p.attempt_id, p.amount_cents, p.method::text,
           pg_catalog.to_char(p.recorded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
           case when r.payment_id is not null
                then pg_catalog.to_char(r.reversed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end,
           r.reason_code::text
      from tmpos_invoice_payment.invoice_payment p
      left join tmpos_invoice_payment.invoice_payment_reversal r on r.payment_id = p.payment_id
     where p.invoice_id = v_head.o_invoice_id and p.tenant_id = v_head.o_tenant_id and p.store_id = v_head.o_store_id
       and (p_after_payment_id is null or (p.recorded_at, p.payment_id) > (v_after_at, v_after_id))
     order by p.recorded_at, p.payment_id
     limit p_limit;
  if not found then
    return query select 'payments'::text, v_head.o_tenant_id, v_head.o_store_id, v_head.o_invoice_id, v_head.o_status,
      v_head.o_currency, v_head.o_total_cents, v_due::bigint, v_applied::bigint, (v_due - v_applied)::bigint, v_word,
      null::uuid, null::uuid, null::bigint, null::text, null::text, null::text, null::text;
  end if;
end
$$;

comment on function tmpos_invoice_payment.m7b_invoice_payments_get(text, uuid, uuid, uuid, uuid, integer) is
  'Phase 4.0 M7b (migration 036): one issued invoice''s payments, on one snapshot, under migration 035''s m7b_issued_invoice_get_v2 (called inside it: its authority — Invoices View and Customers View at the store, read-only included — its ''denied'' and ''not_found'' words, alike for a missing, another store''s and another tenant''s invoice, and its raises). Answers (''cursor_unknown'', NULLs) when p_after_payment_id is not a payment of the invoice; else ''payments'' rows, oldest first by (recorded_at, payment_id), at most p_limit (1-51), after the cursor, each carrying the invoice id, its status (issued or voided), currency, Total, due, applied, remaining and status word (voided, nothing_due, no_payment_recorded, recorded_in_full, recorded_partly) over the COMPLETE history, and the payment''s id, attempt id, amount, method, recorded_at and, when reversed, reversed_at and reason (UTC text with microseconds); one row with NULL payment columns for an empty page. A voided invoice''s due, applied and remaining are 0. Raises data_corrupted rather than hide an unreversed payment on a voided invoice or an applied sum above the Total. Never recorded_by, reversed_by or an audit field. STABLE; locks nothing.';

-- =============================================================================
-- 12) The rollback-order anchor
-- =============================================================================
-- A SQL-standard body records a dependency for every reg* constant: 035's void and v2 get only, as 035's anchor names only
-- 034's (the existing suites roll older migrations back beneath later ones). 035's rollback drops both: refused (2BP01) while
-- this exists.
create function tmpos_invoice_payment.m7b_invoice_payment_prerequisites()
returns boolean
language sql
stable
security invoker
set search_path = pg_catalog, pg_temp
begin atomic
  select 'tmpos_invoice_void.m7b_invoice_void(text, uuid, uuid, uuid, bigint, text)'::pg_catalog.regprocedure is not null
     and 'tmpos_invoice_void.m7b_issued_invoice_get_v2(text, uuid, uuid, uuid)'::pg_catalog.regprocedure is not null;
end;

comment on function tmpos_invoice_payment.m7b_invoice_payment_prerequisites() is
  'Phase 4.0 M7b (migration 036): the rollback-order anchor. A SQL-standard body naming, as reg* constants, migration 035''s m7b_invoice_void and m7b_issued_invoice_get_v2, and no other migration''s function, so their recorded dependencies refuse (2BP01) 035''s rollback while migration 036 is applied (the payment foreign key refuses 034''s drop of issued_invoice too): roll 036 back first. Never called; answers true. Granted to nobody.';

-- =============================================================================
-- 13) Privileges
-- =============================================================================
-- PostgreSQL grants EXECUTE on a new function to PUBLIC by default: every default is removed before the four intended grants.
revoke all on function tmpos_invoice_payment.m7b_invoice_payment_guard() from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
revoke all on function tmpos_invoice_payment.m7b_invoice_payment_truncate_guard() from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
revoke all on function tmpos_invoice_payment.m7b_invoice_payment_reversal_guard() from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
revoke all on function tmpos_invoice_payment.m7b_invoice_payment_reversal_truncate_guard() from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
revoke all on function tmpos_invoice_payment.m7b_invoice_payment_record(text, uuid, uuid, uuid, uuid, uuid, bigint, text, uuid) from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
revoke all on function tmpos_invoice_payment.m7b_invoice_payment_reverse(text, uuid, uuid, uuid, uuid, bigint, text, uuid) from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
revoke all on function tmpos_invoice_payment.m7b_invoice_void_v2(text, uuid, uuid, uuid, bigint, text) from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
revoke all on function tmpos_invoice_payment.m7b_invoice_payments_get(text, uuid, uuid, uuid, uuid, integer) from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
revoke all on function tmpos_invoice_payment.m7b_invoice_payment_prerequisites() from public, anon, authenticated, tmpos_app, tmpos_audit_writer;

-- A2: the older void, past the payment check, is no longer the runtime's; it stays in its schema, unaltered, for the rollback.
revoke execute on function tmpos_invoice_void.m7b_invoice_void(text, uuid, uuid, uuid, bigint, text) from tmpos_app;

grant execute on function tmpos_invoice_payment.m7b_invoice_payment_record(text, uuid, uuid, uuid, uuid, uuid, bigint, text, uuid) to tmpos_app;
grant execute on function tmpos_invoice_payment.m7b_invoice_payment_reverse(text, uuid, uuid, uuid, uuid, bigint, text, uuid) to tmpos_app;
grant execute on function tmpos_invoice_payment.m7b_invoice_void_v2(text, uuid, uuid, uuid, bigint, text) to tmpos_app;
grant execute on function tmpos_invoice_payment.m7b_invoice_payments_get(text, uuid, uuid, uuid, uuid, integer) to tmpos_app;

-- =============================================================================
-- 14) Postcondition
-- =============================================================================
-- Proven rather than asserted. This file refuses to finish unless, now:
--   (a) schema tmpos_invoice_payment holds exactly this file's nine functions and its two tables with their indexes, is owned
--       by the applying principal, and its complete ACL is the owner's USAGE and CREATE and a non-grantable USAGE to tmpos_app;
--   (b) every function has its declared language, security, volatility, settings, owner and comment;
--   (c) the complete ACL of each of the four routines is exactly the owner's EXECUTE and tmpos_app's; of every other function
--       of the schema exactly the owner's; of 035's void exactly the owner's;
--   (d) tmpos_app executes the four routines and nothing else of the schema, nor 035's void; tmpos_audit_writer, anon and
--       authenticated none of them by any path; no runtime role holds any privilege on either table by any path; row security
--       is enabled, not forced, without policy, on both; no table or column carries a grant beyond its owner's;
--   (e) none of the four runtime roles is a member of the owner of the schema, a function or a table;
--   (f) the four triggers exactly, ENABLE ALWAYS, each trigger function serving exactly one trigger;
--   (g) the tables' columns, keys, CHECKs and foreign keys are exactly section 5's;
--   (h) the anchor records exactly one dependency on each of the two 035 functions and on nothing else;
--   (i) public.audit_event carries the new column (nullable uuid, no default), its index and its CHECK exactly, and
--       tmpos_audit_writer's INSERT reaches the column.
do $$
declare
  v_bad      text;
  v_me       oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user);
  v_record   oid := 'tmpos_invoice_payment.m7b_invoice_payment_record(text, uuid, uuid, uuid, uuid, uuid, bigint, text, uuid)'::regprocedure;
  v_reverse  oid := 'tmpos_invoice_payment.m7b_invoice_payment_reverse(text, uuid, uuid, uuid, uuid, bigint, text, uuid)'::regprocedure;
  v_void2    oid := 'tmpos_invoice_payment.m7b_invoice_void_v2(text, uuid, uuid, uuid, bigint, text)'::regprocedure;
  v_read     oid := 'tmpos_invoice_payment.m7b_invoice_payments_get(text, uuid, uuid, uuid, uuid, integer)'::regprocedure;
  v_anchor   oid := 'tmpos_invoice_payment.m7b_invoice_payment_prerequisites()'::regprocedure;
  v_void035  oid := 'tmpos_invoice_void.m7b_invoice_void(text, uuid, uuid, uuid, bigint, text)'::regprocedure;
  v_get035   oid := 'tmpos_invoice_void.m7b_issued_invoice_get_v2(text, uuid, uuid, uuid)'::regprocedure;
  v_routines oid[];
  v_pay      oid := 'tmpos_invoice_payment.invoice_payment'::regclass;
  v_rev      oid := 'tmpos_invoice_payment.invoice_payment_reversal'::regclass;
begin
  v_routines := array[v_record, v_reverse, v_void2, v_read]::oid[];

  -- (a)
  if (select pg_catalog.string_agg(p.oid::regprocedure::text, ', ' order by p.oid::regprocedure::text collate "C")
        from pg_catalog.pg_proc p where p.pronamespace = 'tmpos_invoice_payment'::regnamespace)
     is distinct from
     'tmpos_invoice_payment.m7b_invoice_payment_guard(), tmpos_invoice_payment.m7b_invoice_payment_prerequisites(), tmpos_invoice_payment.m7b_invoice_payment_record(text,uuid,uuid,uuid,uuid,uuid,bigint,text,uuid), tmpos_invoice_payment.m7b_invoice_payment_reversal_guard(), tmpos_invoice_payment.m7b_invoice_payment_reversal_truncate_guard(), tmpos_invoice_payment.m7b_invoice_payment_reverse(text,uuid,uuid,uuid,uuid,bigint,text,uuid), tmpos_invoice_payment.m7b_invoice_payment_truncate_guard(), tmpos_invoice_payment.m7b_invoice_payments_get(text,uuid,uuid,uuid,uuid,integer), tmpos_invoice_payment.m7b_invoice_void_v2(text,uuid,uuid,uuid,bigint,text)'
     or (select pg_catalog.string_agg(pg_catalog.format('%s:%s', c.relname, c.relkind), ', ' order by c.relname collate "C")
           from pg_catalog.pg_class c where c.relnamespace = 'tmpos_invoice_payment'::regnamespace)
        is distinct from 'invoice_payment:r, invoice_payment_attempt_key:i, invoice_payment_pkey:i, invoice_payment_reversal:r, invoice_payment_reversal_pkey:i, invoice_payment_scope_key:i'
     or exists (select 1 from pg_catalog.pg_type t
                 where t.typnamespace = 'tmpos_invoice_payment'::regnamespace and t.typrelid = 0 and t.typelem = 0)
     or not exists (select 1 from pg_catalog.pg_namespace n where n.oid = 'tmpos_invoice_payment'::regnamespace and n.nspowner = v_me)
     or exists (select 1 from pg_catalog.pg_class c where c.oid in (v_pay, v_rev) and (c.relowner <> v_me
                  or pg_catalog.obj_description(c.oid, 'pg_class') is null))
     or pg_catalog.obj_description('tmpos_invoice_payment'::regnamespace, 'pg_namespace') is null then
    raise exception 'migration 036 refused: schema tmpos_invoice_payment does not hold exactly this file''s functions and relations, or it or a table is not owned by the applying principal or carries no comment'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if (select pg_catalog.string_agg(pg_catalog.format('%s:%s:%s:%s', case when g.grantee = n.nspowner then 'owner' else g.grantee::regrole::text end,
                                                     g.privilege_type, g.is_grantable, g.grantor = n.nspowner), ', '
                                   order by case when g.grantee = n.nspowner then 'owner' else g.grantee::regrole::text end collate "C",
                                            g.privilege_type collate "C")
        from pg_catalog.pg_namespace n, pg_catalog.aclexplode(coalesce(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) g
       where n.oid = 'tmpos_invoice_payment'::regnamespace)
     is distinct from 'owner:CREATE:f:t, owner:USAGE:f:t, tmpos_app:USAGE:f:t' then
    raise exception 'migration 036 refused: schema tmpos_invoice_payment carries an unexpected grant or lacks an expected one'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (b)
  select pg_catalog.string_agg(p.proname::text, ', ' order by p.proname) into v_bad
    from pg_catalog.pg_proc p join pg_catalog.pg_language l on l.oid = p.prolang
   where p.pronamespace = 'tmpos_invoice_payment'::regnamespace
     and not (p.proowner = v_me
              and pg_catalog.obj_description(p.oid, 'pg_proc') is not null
              and case
                    when p.oid in (v_record, v_reverse, v_void2) then
                      l.lanname = 'plpgsql' and p.prosecdef and p.provolatile = 'v' and p.proretset
                      and p.proconfig = array['search_path=pg_catalog, pg_temp', 'row_security=off']
                    when p.oid = v_read then
                      l.lanname = 'plpgsql' and p.prosecdef and p.provolatile = 's' and p.proretset
                      and p.proconfig = array['search_path=pg_catalog, pg_temp', 'row_security=off']
                    when p.oid = v_anchor then
                      l.lanname = 'sql' and not p.prosecdef and p.provolatile = 's' and p.prosqlbody is not null
                      and p.prorettype = 'pg_catalog.bool'::regtype and p.proconfig = array['search_path=pg_catalog, pg_temp']
                    when p.proname in ('m7b_invoice_payment_guard', 'm7b_invoice_payment_reversal_guard') then
                      l.lanname = 'plpgsql' and not p.prosecdef and p.provolatile = 'v' and p.prorettype = 'pg_catalog.trigger'::regtype
                      and p.proconfig = array['search_path=pg_catalog, pg_temp', 'row_security=off']
                    when p.proname in ('m7b_invoice_payment_truncate_guard', 'm7b_invoice_payment_reversal_truncate_guard') then
                      l.lanname = 'plpgsql' and not p.prosecdef and p.provolatile = 'v' and p.prorettype = 'pg_catalog.trigger'::regtype
                      and p.proconfig = array['search_path=pg_catalog, pg_temp']
                    else false
                  end);
  if v_bad is not null
     or pg_catalog.pg_get_function_arguments(v_void2) is distinct from pg_catalog.pg_get_function_arguments(v_void035)
     or pg_catalog.pg_get_function_result(v_void2) is distinct from pg_catalog.pg_get_function_result(v_void035)
     or pg_catalog.pg_get_function_result(v_record)
        is distinct from 'TABLE(o_outcome text, o_tenant_id uuid, o_store_id uuid, o_actor_id uuid, o_membership_id uuid, o_payment_id uuid, o_invoice_id uuid, o_audit_event_id uuid)'
     or pg_catalog.pg_get_function_result(v_reverse)
        is distinct from 'TABLE(o_outcome text, o_tenant_id uuid, o_store_id uuid, o_actor_id uuid, o_membership_id uuid, o_version bigint, o_payment_id uuid, o_audit_event_id uuid)'
     or pg_catalog.pg_get_function_result(v_read)
        is distinct from 'TABLE(o_outcome text, o_tenant_id uuid, o_store_id uuid, o_invoice_id uuid, o_status text, o_currency text, o_total_cents bigint, o_due_cents bigint, o_applied_cents bigint, o_remaining_cents bigint, o_payment_status text, o_payment_id uuid, o_attempt_id uuid, o_amount_cents bigint, o_method text, o_recorded_at text, o_reversed_at text, o_reason_code text)' then
    raise exception 'migration 036 refused: a function of schema tmpos_invoice_payment is not the one its section declares (%)', coalesce(v_bad, 'a signature')
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (c)
  select pg_catalog.string_agg(pg_catalog.format('%s %s:%s', p.proname, g.grantee::regrole::text, g.privilege_type), ', ')
    into v_bad
    from pg_catalog.pg_proc p, pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g
   where (p.pronamespace = 'tmpos_invoice_payment'::regnamespace or p.oid = v_void035)
     and not (g.privilege_type = 'EXECUTE' and not g.is_grantable and g.grantor = p.proowner
              and (g.grantee = p.proowner or (p.oid = any (v_routines) and g.grantee = 'tmpos_app'::regrole)));
  if v_bad is not null
     or exists (select 1 from pg_catalog.pg_proc p
                 where (p.pronamespace = 'tmpos_invoice_payment'::regnamespace or p.oid = v_void035)
                   and (select pg_catalog.count(*) from pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g)
                       <> case when p.oid = any (v_routines) then 2 else 1 end) then
    raise exception 'migration 036 refused: an unexpected grant remains on a function of schema tmpos_invoice_payment or on 035''s void, or an entry is missing (%)', coalesce(v_bad, 'none listed')
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (d)
  select pg_catalog.string_agg(distinct r.rolname::text || ' ' || p.proname::text, ', ') into v_bad
    from pg_catalog.pg_roles r
    join pg_catalog.pg_roles x on pg_catalog.pg_has_role(r.oid, x.oid, 'MEMBER')
    cross join pg_catalog.pg_proc p
   where (p.pronamespace = 'tmpos_invoice_payment'::regnamespace or p.oid = v_void035)
     and (r.rolname = any (array['tmpos_audit_writer', 'anon', 'authenticated']::name[])
          or (r.rolname = 'tmpos_app' and not (p.oid = any (v_routines))))
     and pg_catalog.has_function_privilege(x.oid, p.oid, 'EXECUTE');
  if v_bad is not null
     or exists (select 1 from pg_catalog.unnest(v_routines) f(oid) where not pg_catalog.has_function_privilege('tmpos_app', f.oid, 'EXECUTE'))
     or not pg_catalog.has_function_privilege('tmpos_app', v_get035, 'EXECUTE') then
    raise exception 'migration 036 refused: a runtime role can execute a function this file does not grant it (035''s void included), or tmpos_app cannot execute a routine (%)', coalesce(v_bad, 'none listed')
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  select pg_catalog.string_agg(distinct r.rolname::text, ', ') into v_bad
    from pg_catalog.pg_roles r
    join pg_catalog.pg_roles x on pg_catalog.pg_has_role(r.oid, x.oid, 'MEMBER')
    cross join (values (v_pay), (v_rev)) t(oid)
   where r.rolname = any (array['tmpos_app', 'tmpos_audit_writer', 'anon', 'authenticated']::name[])
     and (pg_catalog.has_table_privilege(x.oid, t.oid,
            'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'
            operator(pg_catalog.||) case when pg_catalog.current_setting('server_version_num')::integer >= 170000
                                         then ', MAINTAIN' else '' end)
          or pg_catalog.has_any_column_privilege(x.oid, t.oid, 'SELECT, INSERT, UPDATE, REFERENCES'));
  if v_bad is not null
     or (select pg_catalog.count(*) from pg_catalog.pg_class c where c.oid in (v_pay, v_rev) and c.relrowsecurity and not c.relforcerowsecurity) <> 2
     or exists (select 1 from pg_catalog.pg_policy y where y.polrelid in (v_pay, v_rev))
     or exists (select 1 from pg_catalog.pg_class c, pg_catalog.aclexplode(coalesce(c.relacl, pg_catalog.acldefault('r', c.relowner))) g
                 where c.oid in (v_pay, v_rev) and g.grantee <> c.relowner)
     or exists (select 1 from pg_catalog.pg_attribute t where t.attrelid in (v_pay, v_rev) and t.attacl is not null) then
    raise exception 'migration 036 refused: % holds a privilege on a payment table, or row security is not enabled without policy and unforced, or a table or column carries a grant', coalesce(v_bad, 'a role')
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (e)
  select pg_catalog.string_agg(distinct r.rolname::text, ', ') into v_bad
    from pg_catalog.pg_roles r
    cross join (
      select n.nspowner as owner from pg_catalog.pg_namespace n where n.oid = 'tmpos_invoice_payment'::regnamespace
      union
      select p.proowner from pg_catalog.pg_proc p where p.pronamespace = 'tmpos_invoice_payment'::regnamespace
      union
      select c.relowner from pg_catalog.pg_class c where c.relnamespace = 'tmpos_invoice_payment'::regnamespace
    ) o
   where r.rolname = any (array['tmpos_app', 'tmpos_audit_writer', 'anon', 'authenticated']::name[])
     and pg_catalog.pg_has_role(r.oid, o.owner, 'MEMBER');
  if v_bad is not null then
    raise exception 'migration 036 refused: % is a member of the owner of schema tmpos_invoice_payment or of an object in it', v_bad
      using errcode = 'object_not_in_prerequisite_state',
            hint = 'membership hands a role everything the owner holds, including a direct write of every payment record';
  end if;

  -- (f) tgtype: ROW 1 + BEFORE 2 + INSERT 4 + DELETE 8 + UPDATE 16 = 31; BEFORE 2 + TRUNCATE 32 (statement) = 34.
  if (select pg_catalog.string_agg(pg_catalog.format('%s:%s:%s:%s:%s', g.tgrelid::regclass::text, g.tgname, g.tgfoid::regprocedure::text, g.tgtype, g.tgenabled), ', '
                                  order by g.tgname::text collate "C")
        from pg_catalog.pg_trigger g where g.tgrelid in (v_pay, v_rev) and not g.tgisinternal)
     is distinct from
     'tmpos_invoice_payment.invoice_payment:trg_invoice_payment_guard:tmpos_invoice_payment.m7b_invoice_payment_guard():31:A, tmpos_invoice_payment.invoice_payment_reversal:trg_invoice_payment_reversal_guard:tmpos_invoice_payment.m7b_invoice_payment_reversal_guard():31:A, tmpos_invoice_payment.invoice_payment_reversal:trg_invoice_payment_reversal_truncate:tmpos_invoice_payment.m7b_invoice_payment_reversal_truncate_guard():34:A, tmpos_invoice_payment.invoice_payment:trg_invoice_payment_truncate:tmpos_invoice_payment.m7b_invoice_payment_truncate_guard():34:A'
     or exists (select 1 from pg_catalog.pg_trigger g
                 where g.tgrelid in (v_pay, v_rev) and not g.tgisinternal
                   and (not (g.tgattr = ''::pg_catalog.int2vector) or g.tgqual is not null or g.tgconstraint <> 0))
     or exists (select 1 from pg_catalog.pg_proc p
                 where p.pronamespace = 'tmpos_invoice_payment'::regnamespace and p.prorettype = 'pg_catalog.trigger'::regtype
                   and (select pg_catalog.count(*) from pg_catalog.pg_trigger g where g.tgfoid = p.oid) <> 1) then
    raise exception 'migration 036 refused: a trigger of the payment tables is not exactly the one declared'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (g)
  if (select pg_catalog.string_agg(pg_catalog.format('%s:%s:%s:%s:%s', a.attname, pg_catalog.format_type(a.atttypid, a.atttypmod),
                                                     a.attnotnull, a.atthasdef, coalesce(co.collname::text, '')), ', ' order by a.attnum)
        from pg_catalog.pg_attribute a left join pg_catalog.pg_collation co on co.oid = a.attcollation
       where a.attrelid = v_pay and a.attnum > 0 and not a.attisdropped)
     is distinct from 'payment_id:uuid:t:f:, tenant_id:uuid:t:f:, store_id:uuid:t:f:, invoice_id:uuid:t:f:, attempt_id:uuid:t:f:, amount_cents:bigint:t:f:, method:text:t:f:C, recorded_at:timestamp with time zone:t:f:, recorded_by:uuid:t:f:'
     or (select pg_catalog.string_agg(pg_catalog.format('%s:%s:%s:%s:%s', a.attname, pg_catalog.format_type(a.atttypid, a.atttypmod),
                                                        a.attnotnull, a.atthasdef, coalesce(co.collname::text, '')), ', ' order by a.attnum)
           from pg_catalog.pg_attribute a left join pg_catalog.pg_collation co on co.oid = a.attcollation
          where a.attrelid = v_rev and a.attnum > 0 and not a.attisdropped)
        is distinct from 'payment_id:uuid:t:f:, tenant_id:uuid:t:f:, store_id:uuid:t:f:, invoice_id:uuid:t:f:, reason_code:text:t:f:C, reversed_at:timestamp with time zone:t:f:, reversed_by:uuid:t:f:'
     -- Every key, CHECK and foreign key by its definition, so a widened CHECK of the same name is refused too: 035's (g) contype filter (c, p, u, x, t) plus 'f', since this list pins the foreign keys; NOT NULL rows (contype 'n' from PostgreSQL 18) stay out, attnotnull above pins them.
     or (select pg_catalog.string_agg(pg_catalog.format('%s.%s:%s:%s', k.conrelid::regclass::text, k.conname, k.contype, pg_catalog.pg_get_constraintdef(k.oid)), ' | '
                                     order by k.conrelid::regclass::text collate "C", k.conname::text collate "C")
           from pg_catalog.pg_constraint k where k.conrelid in (v_pay, v_rev) and k.contype in ('c', 'p', 'u', 'f', 'x', 't'))
        is distinct from
        'tmpos_invoice_payment.invoice_payment.invoice_payment_amount_chk:c:CHECK (((amount_cents >= 1) AND (amount_cents <= ''9007199254740991''::bigint))) | tmpos_invoice_payment.invoice_payment.invoice_payment_attempt_key:u:UNIQUE (invoice_id, tenant_id, store_id, attempt_id) | tmpos_invoice_payment.invoice_payment.invoice_payment_invoice_fkey:f:FOREIGN KEY (invoice_id, tenant_id, store_id) REFERENCES tmpos_invoice_issue.issued_invoice(invoice_id, tenant_id, store_id) ON UPDATE RESTRICT ON DELETE RESTRICT | tmpos_invoice_payment.invoice_payment.invoice_payment_method_chk:c:CHECK ((method = ANY (ARRAY[''cash''::text, ''external_card_terminal''::text]))) | tmpos_invoice_payment.invoice_payment.invoice_payment_pkey:p:PRIMARY KEY (payment_id) | tmpos_invoice_payment.invoice_payment.invoice_payment_scope_key:u:UNIQUE (payment_id, invoice_id, tenant_id, store_id) | tmpos_invoice_payment.invoice_payment_reversal.invoice_payment_reversal_payment_fkey:f:FOREIGN KEY (payment_id, invoice_id, tenant_id, store_id) REFERENCES tmpos_invoice_payment.invoice_payment(payment_id, invoice_id, tenant_id, store_id) ON UPDATE RESTRICT ON DELETE RESTRICT | tmpos_invoice_payment.invoice_payment_reversal.invoice_payment_reversal_pkey:p:PRIMARY KEY (payment_id) | tmpos_invoice_payment.invoice_payment_reversal.invoice_payment_reversal_reason_code_chk:c:CHECK ((reason_code = ANY (ARRAY[''recorded_in_error''::text, ''wrong_amount''::text, ''wrong_method''::text, ''wrong_invoice''::text, ''duplicate''::text, ''other''::text])))'
     or exists (select 1 from pg_catalog.pg_constraint k where k.conrelid in (v_pay, v_rev) and (not k.convalidated or k.condeferrable))
     or (select pg_catalog.count(*) from pg_catalog.pg_constraint k
          where k.conrelid = v_pay and k.contype = 'f' and k.confrelid = 'tmpos_invoice_issue.issued_invoice'::regclass
            and k.conindid = pg_catalog.to_regclass('tmpos_invoice_issue.issued_invoice_scope_key')
            and k.confdeltype = 'r' and k.confupdtype = 'r') <> 1
     or (select pg_catalog.count(*) from pg_catalog.pg_constraint k
          where k.conrelid = v_rev and k.contype = 'f' and k.confrelid = v_pay
            and k.conindid = pg_catalog.to_regclass('tmpos_invoice_payment.invoice_payment_scope_key')
            and k.confdeltype = 'r' and k.confupdtype = 'r') <> 1 then
    raise exception 'migration 036 refused: a payment table''s columns, keys, CHECKs or foreign keys are not exactly section 5''s'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (h) One NORMAL dependency row per object named.
  if (select pg_catalog.string_agg(d.refobjid::regprocedure::text, ', ' order by d.refobjid::regprocedure::text collate "C")
        from pg_catalog.pg_depend d
       where d.classid = 'pg_catalog.pg_proc'::regclass and d.objid = v_anchor and d.objsubid = 0
         and d.refclassid in ('pg_catalog.pg_proc'::regclass, 'pg_catalog.pg_class'::regclass)
         and d.refobjsubid = 0 and d.deptype = 'n')
     is distinct from 'tmpos_invoice_void.m7b_invoice_void(text,uuid,uuid,uuid,bigint,text), tmpos_invoice_void.m7b_issued_invoice_get_v2(text,uuid,uuid,uuid)' then
    raise exception 'migration 036 refused: the rollback-order anchor does not record exactly one dependency on each 035 function it names'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (i)
  if (select pg_catalog.count(*) from pg_catalog.pg_attribute a
       where a.attrelid = 'public.audit_event'::regclass and a.attname = 'subject_invoice_payment_id' and not a.attisdropped
         and a.atttypid = 'pg_catalog.uuid'::regtype and not a.attnotnull and not a.atthasdef and a.attacl is null) <> 1
     or pg_catalog.col_description('public.audit_event'::regclass,
          (select a.attnum from pg_catalog.pg_attribute a
            where a.attrelid = 'public.audit_event'::regclass and a.attname = 'subject_invoice_payment_id' and not a.attisdropped)) is null
     or pg_catalog.pg_get_indexdef(pg_catalog.to_regclass('public.idx_audit_event_subject_invoice_payment_occurred'))
        is distinct from 'CREATE INDEX idx_audit_event_subject_invoice_payment_occurred ON public.audit_event USING btree (subject_invoice_payment_id, occurred_at DESC) WHERE (subject_invoice_payment_id IS NOT NULL)'
     or not exists (select 1 from pg_catalog.pg_constraint k
                     where k.conrelid = 'public.audit_event'::regclass and k.conname = 'audit_event_metadata_no_card_data_keys_chk'
                       and k.contype = 'c' and k.convalidated)
     or not pg_catalog.has_column_privilege('tmpos_audit_writer', 'public.audit_event', 'subject_invoice_payment_id', 'INSERT') then
    raise exception 'migration 036 refused: the audit table''s payment subject, its index or the card-data CHECK is not the one section 7 declares'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$$;

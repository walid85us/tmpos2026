-- Phase 4.0 M7b — credit notes against an issued store invoice (M7B-CREDITNOTES-P1, CN-P1): append-only credit notes and
-- whole withdrawals in a schema of their own, a per-store credit-note number series, a durable per-staff registration slot with
-- a commit- and flush-qualified proof (037's owner-installed key under a distinct label), the issue, withdraw, settle and
-- lookup routines (each mutation writing its own audit record), the credit-note list, the credit-aware replacements of 037's
-- record v2, 036's void v2 and 036's payments read, and the insert-time barrier that closes the cutover seam
-- (docs/phase-4/16, adopted bundle §12: D-CN-1..12 A, CN-A1-A, CN-A2, CN-A3, amount and reason bound, proof key reused).
-- Migration: 038_m7b_invoice_credit_note (UP)
--
-- SCOPE / TRUTH (binding):
--   - SCHEMA tmpos_invoice_credit_note (owned by the applying principal; USAGE to tmpos_app alone, beside its owner's): FOUR
--     TABLES, all row security on, no policy, NO privilege for any runtime role, each behind ENABLE ALWAYS guards:
--       * invoice_credit_note — one row per issued credit note: the runtime's credit note id, scope (a composite foreign key onto
--         034's issued_invoice_scope_key), the client's attempt id (UNIQUE per invoice, tenant and store, permanently), its
--         registration (UNIQUE), the store's credit-note number (UNIQUE per tenant and store, from 1), gross, tax and net cents
--         (gross 1 to 2^53 - 1, tax and net >= 0, gross = tax + net), a closed reason, the database time and the issuing actor.
--       * invoice_credit_note_withdrawal — at most one per credit note (its id the primary key, a composite foreign key onto the
--         credit note's scope), a closed reason, the database time and the withdrawing actor.
--       * invoice_credit_note_counter — one row per store (tenant, store): the last number taken; one row at 0 for every store
--         existing at apply; the issue inserts the row of a later store before its clock read (D-CN-6: the one write a refusal
--         may commit). A row, not a sequence: a rolled-back issue consumes no number.
--       * invoice_credit_note_registration — 037's registration for credit notes, with the BOUND gross and reason: open
--         (version 1) and issued (2) hold the per-staff slot; released and confirmed (3) are terminal.
--     Routines (SECURITY DEFINER, EXECUTE to tmpos_app): m7b_invoice_credit_note_register, _registration_proof, _issue,
--     _attempts, _settle, _withdraw and m7b_invoice_credit_notes_list; granted to nobody: the proof message, the guards, the
--     barrier trigger functions and the anchor m7b_invoice_credit_note_prerequisites.
--   - IN SCHEMA tmpos_invoice_payment (036's), the replacements, EXECUTE to tmpos_app: m7b_invoice_payment_record_v3 (037's
--     record v2, statement for statement, whose cap also counts active credit notes: CN-A2), m7b_invoice_void_v3 (036's void
--     v2 plus 'credit_notes_recorded' after 'payments_recorded': CN-A3) and m7b_invoice_payments_get_v2 (036's read plus
--     o_credited_cents after o_due_cents, two status words and the CN-35 raises: CN-A1-A). tmpos_app LOSES its EXECUTE on 037's
--     m7b_invoice_payment_record_v2, 036's m7b_invoice_void_v2 and 036's m7b_invoice_payments_get, which stay in place,
--     unaltered, for the rollback (CN-I4).
--   - THE BARRIER (038 cutover (c)): ENABLE ALWAYS BEFORE INSERT row triggers on tmpos_invoice_payment.invoice_payment and
--     tmpos_invoice_void.issued_invoice_void, SECURITY DEFINER, VOLATILE: each takes the issued header FOR UPDATE (a no-op for a
--     routine that holds it) and re-reads in separate statements; the payment's refuses active credits + unreversed payments +
--     the new amount above the Total, the void's refuses while any credit note is active, and either refuses anything but READ
--     COMMITTED — all restrict_violation, which 036's and 037's routines answer as 23000 with fixed text. They fire whatever
--     routine inserts: a call admitted before this file committed, and the routines' owner, included.
--   - public.audit_event gains subject_invoice_credit_note_id and subject_invoice_credit_note_registration_id (nullable uuid,
--     no default) with their partial indexes. No CHECK or guard on audit_event enumerates kinds or subject columns (002, 005,
--     036): none to extend.
--   - THE MONEY (D-CN-2 A). For an issued invoice: total = 034's total_cents; credited = the gross of its credit notes with no
--     withdrawal; paid = its payments with no reversal; remaining = total - credited - paid, numeric, never stored. I-CN:
--     credited + paid <= total; the two increasing writers (record v3, the credit-note issue) check it under the header FOR
--     UPDATE, under READ COMMITTED, with both sums re-read in separate statements after the lock.
--   - THE TAX SPLIT (D-CN-4 A, interim, not tax-validated): t = clamp(div(2 * tax * (aG + G) + T, 2 * T) - aT, 0, G) in numeric,
--     net = G - t; tax mode none: t = 0; aG and aT the gross and tax of the invoice's active credit notes; computed after the
--     bound under the header lock; the invariants (active credit tax <= the invoice's tax, active credit net <= the subtotal)
--     re-checked, data_corrupted with fixed text otherwise.
--   - AUTHORITY (D-CN-7 A). Every credit-note routine, recovery included, requires role store_owner from the session's single
--     store-scope grant at the path store, on write statuses (active, trialing) for the writers (037's m7b_payment_writer) and
--     the proof, read statuses for the lookup (034's store reader); a manager is refused. Over HTTP the read_only limitation
--     denies the non-view recover key (m5CanonicalPermissions.ts), so a read-only or overdue tenant's owner reaches the lookup
--     only by a direct call, as with the payment lookup. The list reads under 035's v2 get
--     (view_issued_invoices' levels) and shows staff names only to the store-scope store owner.
--   - ORDER (D-CN-9 A), the issue: arguments; READ COMMITTED (55000); the caller, the role and write statuses ('refused');
--     expectedTenant ('tenant_mismatch'); THE HEADER FOR UPDATE ('not_found'); the proof key FOR SHARE; the registration FOR
--     UPDATE; the counter row (inserted if absent) FOR UPDATE; ONE clock_timestamp() reading: expiry and the 10-minute recent
--     sign-in ('refused'); the scope (registration, session digest, generation, not this transaction, proof: 'not_found'); then,
--     each its own statement: already_issued, invalid_state (released), conflict (bound values), already_issued (attempt taken),
--     invalid_state (voided), amount_exceeds_remaining; then the counter by one, the credit note, the registration's link and
--     ONE audit record. The store owner takes no key 530030 (036): every other role is refused before key 530030, the header
--     and any credit-note lock (037's writer has already taken 016's hold and its FOR SHARE locks).
--   - LOCK ORDER (036's, 037's): fence -> 016's hold -> session and mint-ledger rows FOR SHARE -> issuer key FOR SHARE ->
--     membership and store row FOR SHARE -> THE ISSUED HEADER FOR UPDATE -> (register, issue) the proof key FOR SHARE ->
--     (issue, settle) the registration FOR UPDATE -> (issue) the store's counter FOR UPDATE -> the clock -> the writes -> the
--     audit insert. Every writer of a credit note, withdrawal or credit-note registration holds its invoice's header first.
--   - APPLY: a maintenance window, the runtimes stopped (doc 16 "038 cutover" runbook); SHARE ROW EXCLUSIVE on public.store (the
--     counter's foreign key, taken early) and ACCESS EXCLUSIVE on the issued header,
--     the void, payment, reversal, payment registration and proof key tables and the audit table FIRST; READ COMMITTED; 037
--     and 036 exactly for what this file revokes and builds on; none of this file's objects; the applier owns or inherits the
--     owner of every table the definers read, lock or insert into. It locks NONE of app_user, platform_identity, the session
--     tables, tenant_session or issuer_key (CN-34s1). Object checks only: no ledger clause (R-GATE-2).
--   - ROLLBACK: 038's down refuses, changing nothing, while any credit note, withdrawal, credit-note registration, or audit
--     record of a credit-note kind or naming either new column exists: AFTER THE FIRST REGISTRATION THE ROLLBACK IS ONE-WAY.
--     Roll 038 back before 037: the anchor names 037's objects (R-GATE-1), so 037's down fails (2BP01) while this is applied.
--   - NOT DEFENDED (doc 16 §7): direct calls skip idempotency, CSRF, the rate limit and the chain's step-up (DA-118, widened in
--     audited form); the void v3 is unaudited on a direct call; the reads join DA-132; an issuer-key holder mints any principal
--     (DA-93, DA-94); forged audit rows through tmpos_audit_writer (DA-114); refusals leave no durable trace; the table owner
--     disabling a trigger, DDL and a superuser.
--   - NO SECRET, NO DYNAMIC SQL, NO EXTENSION, NO TEMPORARY OBJECT. The only rows written: one counter row at 0 per existing
--     store. Every name is schema-qualified; every routine and trigger function pins its search_path.
--
-- Reversible via 038_m7b_invoice_credit_note.down.sql. Assumes 001-037 are applied.

-- =============================================================================
-- 1) This transaction's settings
-- =============================================================================
set local search_path = pg_catalog, pg_temp;
set local row_security = off;

-- =============================================================================
-- 2) The locks, in the writers' order, before any check or change (none on app_user, platform_identity, the session tables,
--    tenant_session or issuer_key: a call held at 016's hold must not block this apply, CN-34s1)
-- =============================================================================
do $$
begin
  -- SHARE ROW EXCLUSIVE (the counter's foreign key needs it): no conflict with the ROW SHARE of a call's store row FOR SHARE.
  lock table public.store in share row exclusive mode;
  lock table tmpos_invoice_issue.issued_invoice in access exclusive mode;
  lock table tmpos_invoice_void.issued_invoice_void in access exclusive mode;
  lock table tmpos_invoice_payment.invoice_payment in access exclusive mode;
  lock table tmpos_invoice_payment.invoice_payment_reversal in access exclusive mode;
  lock table tmpos_invoice_payment.invoice_payment_registration in access exclusive mode;
  lock table tmpos_invoice_payment.payment_proof_key in access exclusive mode;
  lock table public.audit_event in access exclusive mode;
exception
  when undefined_table or invalid_schema_name then
    raise exception 'migration 038 refused: 034''s issued invoices, 035''s void records, 036''s payment tables, 037''s registration or proof key table or public.audit_event is missing (migrations 034 to 037 must be applied first)'
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
  v_void   oid;
  v_get    oid;
begin
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'migration 038 refused: it must run under READ COMMITTED, so that its checks see every committed row'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if (select pg_catalog.count(*) from pg_catalog.pg_roles r
       where r.rolname = any (array['tmpos_app', 'tmpos_audit_writer', 'anon', 'authenticated']::name[])) <> 4 then
    raise exception 'migration 038 refused: the runtime roles tmpos_app, tmpos_audit_writer, anon and authenticated must exist'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if pg_catalog.to_regnamespace('tmpos_invoice_credit_note') is not null
     or exists (select 1 from pg_catalog.pg_proc p
                 where p.pronamespace = 'tmpos_invoice_payment'::regnamespace
                   and p.proname in ('m7b_invoice_payment_record_v3', 'm7b_invoice_void_v3', 'm7b_invoice_payments_get_v2'))
     or exists (select 1 from pg_catalog.pg_attribute a
                 where a.attrelid = 'public.audit_event'::regclass
                   and a.attname in ('subject_invoice_credit_note_id', 'subject_invoice_credit_note_registration_id')
                   and not a.attisdropped)
     or pg_catalog.to_regclass('public.idx_audit_event_subject_invoice_credit_note_occurred') is not null
     or pg_catalog.to_regclass('public.idx_audit_event_subj_invoice_credit_note_registration_occurred') is not null then
    raise exception 'migration 038 refused: an object of this file already exists'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- 037 and 036, exactly, for what this file revokes (each ACL exactly the owner's and tmpos_app's EXECUTE, so the revoke is no
  -- silent no-op and the rollback's grant restores it byte for byte) and builds on.
  v_record := pg_catalog.to_regprocedure('tmpos_invoice_payment.m7b_invoice_payment_record_v2(text, uuid, uuid, uuid, uuid, uuid, uuid, bigint, text, text, uuid)');
  v_void := pg_catalog.to_regprocedure('tmpos_invoice_payment.m7b_invoice_void_v2(text, uuid, uuid, uuid, bigint, text)');
  v_get := pg_catalog.to_regprocedure('tmpos_invoice_payment.m7b_invoice_payments_get(text, uuid, uuid, uuid, uuid, integer)');
  if v_record is null or v_void is null or v_get is null
     or pg_catalog.to_regprocedure('tmpos_invoice_payment.m7b_payment_writer(text, uuid)') is null
     or pg_catalog.to_regclass('tmpos_invoice_issue.issued_invoice_scope_key') is null
     or pg_catalog.to_regclass('tmpos_invoice_payment.invoice_payment_registration') is null
     or pg_catalog.to_regclass('tmpos_invoice_payment.payment_proof_key') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_issue.m7b_issue_store_reader(text, uuid, uuid, boolean, text)') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_void.m7b_issued_invoice_get_v2(text, uuid, uuid, uuid)') is null
     or pg_catalog.to_regprocedure('tmpos_mint.hmac_sha256(bytea, bytea)') is null
     or pg_catalog.to_regprocedure('tmpos_session.m5_hold_tenant_standing(text, text)') is null
     or pg_catalog.to_regprocedure('tmpos_session.m5_admit_tenant_session_v2(text, text)') is null
     or not exists (select 1 from pg_catalog.pg_attribute a
                     where a.attrelid = 'tmpos_session.session'::regclass and a.attname = 'authenticated_at'
                       and not a.attisdropped and a.atttypid = 'pg_catalog.int8'::regtype)
     or not exists (select 1 from pg_catalog.pg_attribute a
                     where a.attrelid = 'public.app_user'::regclass and a.attname = 'display_name' and not a.attisdropped)
     or not exists (select 1 from pg_catalog.pg_namespace n where n.oid = 'tmpos_invoice_payment'::regnamespace and n.nspowner = v_me)
     or (select pg_catalog.count(*)
           from pg_catalog.pg_proc p, pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g
          where p.oid in (v_record, v_void, v_get)) <> 6
     or (select pg_catalog.count(*)
           from pg_catalog.pg_proc p, pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g
          where p.oid in (v_record, v_void, v_get) and g.privilege_type = 'EXECUTE' and not g.is_grantable
            and g.grantor = p.proowner and g.grantee in (p.proowner, 'tmpos_app'::regrole)) <> 6 then
    raise exception 'migration 038 refused: migrations 036 and 037 are not applied exactly (037''s record v2, 036''s void v2 or payments read and their ACLs, 037''s writer, registration or proof key, or schema tmpos_invoice_payment owned by the applying principal), or 034''s store reader, 035''s v2 get, 018''s HMAC, 016''s hold or admission read, 011''s sign-in time or 002''s display name is missing'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- The payment, reversal and void tables carry exactly 036's pinned triggers (036 up :143-147, :1900-1913), so the rollback
  -- restores exactly those sets.
  if (select pg_catalog.string_agg(pg_catalog.format('%s:%s:%s:%s:%s', g.tgrelid::regclass::text, g.tgname, g.tgfoid::regprocedure::text, g.tgtype, g.tgenabled), ', '
                                  order by g.tgname::text collate "C")
        from pg_catalog.pg_trigger g
       where g.tgrelid in ('tmpos_invoice_payment.invoice_payment'::regclass, 'tmpos_invoice_payment.invoice_payment_reversal'::regclass)
         and not g.tgisinternal)
     is distinct from
     'tmpos_invoice_payment.invoice_payment:trg_invoice_payment_guard:tmpos_invoice_payment.m7b_invoice_payment_guard():31:A, tmpos_invoice_payment.invoice_payment_reversal:trg_invoice_payment_reversal_guard:tmpos_invoice_payment.m7b_invoice_payment_reversal_guard():31:A, tmpos_invoice_payment.invoice_payment_reversal:trg_invoice_payment_reversal_truncate:tmpos_invoice_payment.m7b_invoice_payment_reversal_truncate_guard():34:A, tmpos_invoice_payment.invoice_payment:trg_invoice_payment_truncate:tmpos_invoice_payment.m7b_invoice_payment_truncate_guard():34:A'
     or (select pg_catalog.string_agg(pg_catalog.format('%s:%s:%s:%s', g.tgname, g.tgfoid::regprocedure::text, g.tgtype, g.tgenabled), ', '
                                     order by g.tgname::text collate "C")
           from pg_catalog.pg_trigger g
          where g.tgrelid = 'tmpos_invoice_void.issued_invoice_void'::regclass and not g.tgisinternal)
        is distinct from 'trg_issued_invoice_void_guard:tmpos_invoice_void.m7b_invoice_void_guard():31:A, trg_issued_invoice_void_truncate:tmpos_invoice_void.m7b_invoice_void_truncate_guard():34:A' then
    raise exception 'migration 038 refused: the payment, reversal or void table does not carry exactly migration 036''s pinned triggers'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if not (pg_catalog.has_function_privilege(current_user, 'tmpos_session.m5_hold_tenant_standing(text, text)', 'EXECUTE')
          and pg_catalog.has_function_privilege(current_user, 'tmpos_session.m5_admit_tenant_session_v2(text, text)', 'EXECUTE')
          and pg_catalog.has_function_privilege(current_user, 'tmpos_invoice_issue.m7b_issue_store_reader(text, uuid, uuid, boolean, text)', 'EXECUTE')
          and pg_catalog.has_function_privilege(current_user, 'tmpos_invoice_void.m7b_issued_invoice_get_v2(text, uuid, uuid, uuid)', 'EXECUTE')
          and pg_catalog.has_function_privilege(current_user, 'tmpos_invoice_payment.m7b_payment_writer(text, uuid)', 'EXECUTE')
          and pg_catalog.has_function_privilege(current_user, 'tmpos_mint.hmac_sha256(bytea, bytea)', 'EXECUTE')
          and pg_catalog.has_function_privilege(current_user, 'pg_catalog.pg_control_init()', 'EXECUTE')
          and pg_catalog.has_function_privilege(current_user, 'pg_catalog.pg_current_wal_insert_lsn()', 'EXECUTE')
          and pg_catalog.has_function_privilege(current_user, 'pg_catalog.pg_current_wal_flush_lsn()', 'EXECUTE')
          and pg_catalog.has_database_privilege(current_user, pg_catalog.current_database(), 'CREATE')
          and pg_catalog.has_schema_privilege(current_user, 'public', 'USAGE')
          and pg_catalog.has_schema_privilege(current_user, 'tmpos_session', 'USAGE')
          and pg_catalog.has_schema_privilege(current_user, 'tmpos_mint', 'USAGE')
          and pg_catalog.has_schema_privilege(current_user, 'tmpos_role', 'USAGE')
          and pg_catalog.has_schema_privilege(current_user, 'tmpos_invoice_issue', 'USAGE')
          and pg_catalog.has_schema_privilege(current_user, 'tmpos_invoice_void', 'USAGE')
          -- D-CN-8 A: the routines' owner (the applying principal) inserts the audit record and reads it back.
          and pg_catalog.has_table_privilege(current_user, 'public.audit_event', 'INSERT')
          and pg_catalog.has_table_privilege(current_user, 'public.audit_event', 'SELECT')) then
    raise exception 'migration 038 refused: the applying principal cannot execute 016''s hold and admission read, 034''s store reader, 035''s v2 get, 037''s writer, 018''s HMAC or the WAL position and control functions, create a schema, use the schemas they read, or insert into and read public.audit_event'
      using errcode = 'insufficient_privilege';
  end if;
  if exists (
    select 1
      from pg_catalog.pg_class c
     where c.oid = any (array['tmpos_session.session'::regclass, 'tmpos_mint.tenant_session'::regclass,
                              'tmpos_mint.issuer_key'::regclass, 'tmpos_role.tenant_role_level'::regclass,
                              'public.store'::regclass, 'public.tenant'::regclass, 'public.user_membership'::regclass,
                              'public.app_user'::regclass,
                              'tmpos_invoice_issue.issued_invoice'::regclass, 'tmpos_invoice_void.issued_invoice_void'::regclass,
                              'tmpos_invoice_payment.invoice_payment'::regclass,
                              'tmpos_invoice_payment.invoice_payment_reversal'::regclass,
                              'tmpos_invoice_payment.invoice_payment_registration'::regclass,
                              'tmpos_invoice_payment.payment_proof_key'::regclass, 'public.audit_event'::regclass])
       and (not pg_catalog.pg_has_role(current_user, c.relowner, 'USAGE') or c.relforcerowsecurity)) then
    raise exception 'migration 038 refused: the applying principal neither owns nor inherits the owner of a table the definers read, lock or insert into, or one has forced row security'
      using errcode = 'insufficient_privilege';
  end if;
end
$$;

-- =============================================================================
-- 4) The schema
-- =============================================================================
create schema tmpos_invoice_credit_note;

comment on schema tmpos_invoice_credit_note is
  'Phase 4.0 M7b (migration 038): credit notes against issued invoices — the append-only credit note, withdrawal, counter and registration tables, their guards, the register, proof, issue, attempts, settle and withdraw routines (each mutation writing its own audit record), the list, the cutover barrier''s trigger functions and the rollback-order anchor. tmpos_app holds USAGE and EXECUTE on the seven routines only.';

revoke all on schema tmpos_invoice_credit_note from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
grant usage on schema tmpos_invoice_credit_note to tmpos_app;

-- =============================================================================
-- 5) The tables
-- =============================================================================
create table tmpos_invoice_credit_note.invoice_credit_note_counter (
  tenant_id   uuid   not null,
  store_id    uuid   not null,
  last_number bigint not null,
  constraint invoice_credit_note_counter_pkey primary key (tenant_id, store_id),
  constraint invoice_credit_note_counter_store_fkey foreign key (tenant_id, store_id) references public.store (tenant_id, store_id)
    on delete restrict on update restrict,
  constraint invoice_credit_note_counter_last_number_chk check (last_number between 0 and 9007199254740991)
);

comment on table tmpos_invoice_credit_note.invoice_credit_note_counter is
  'Phase 4.0 M7b (migration 038): one store''s credit-note number counter (D-CN-6 A, a series of its own from 1), created at 0 for every store existing at apply and by the issue routine for a later store, before its clock read; advanced by exactly one by each issue, in the issuing transaction (a row, not a sequence: a rolled-back issue consumes no number). Never deleted. No runtime role holds a privilege on it.';

create table tmpos_invoice_credit_note.invoice_credit_note_registration (
  registration_id uuid        not null,
  tenant_id       uuid        not null,
  store_id        uuid        not null,
  invoice_id      uuid        not null,
  registered_by   uuid        not null,
  attempt_id      uuid        not null,
  gross_cents     bigint      not null,
  reason_code     text        collate "C" not null,
  session_digest  bytea       not null,
  key_generation  bigint      not null,
  registered_xact xid8        not null,
  registered_at   timestamptz not null,
  credit_note_id  uuid,
  acknowledged_at timestamptz,
  constraint invoice_credit_note_registration_pkey primary key (registration_id),
  -- The attempt is the caller's own: another staff member's attempt id registers as a fresh one (caught at issue).
  constraint invoice_credit_note_registration_attempt_key unique (invoice_id, tenant_id, store_id, registered_by, attempt_id),
  -- A credit note settles at most one registration.
  constraint invoice_credit_note_registration_credit_note_key unique (credit_note_id),
  constraint invoice_credit_note_registration_invoice_fkey foreign key (invoice_id, tenant_id, store_id)
    references tmpos_invoice_issue.issued_invoice (invoice_id, tenant_id, store_id) on delete restrict on update restrict,
  constraint invoice_credit_note_registration_gross_chk check (gross_cents between 1 and 9007199254740991),
  constraint invoice_credit_note_registration_reason_code_chk check (
    reason_code in ('pricing_error', 'service_issue', 'goodwill', 'billing_error')),
  constraint invoice_credit_note_registration_session_digest_chk check (pg_catalog.octet_length(session_digest) = 32),
  constraint invoice_credit_note_registration_key_generation_chk check (key_generation between 1 and 9007199254740991)
);

-- The durable unresolved slot: at most one unsettled (open or issued-unconfirmed) registration per staff member per invoice.
create unique index invoice_credit_note_registration_slot_key
  on tmpos_invoice_credit_note.invoice_credit_note_registration (tenant_id, store_id, invoice_id, registered_by)
  where acknowledged_at is null;
-- The staff member's lookup, in its keyset order.
create index invoice_credit_note_registration_list_idx
  on tmpos_invoice_credit_note.invoice_credit_note_registration (tenant_id, store_id, registered_by, registered_at, invoice_id, attempt_id);

comment on table tmpos_invoice_credit_note.invoice_credit_note_registration is
  'Phase 4.0 M7b (migration 038): one row per registered credit-note attempt of one staff member on one issued invoice — the runtime''s registration id, scope, the derived actor, the client''s attempt id, the BOUND gross and reason, sha256 of the session key, the proof key generation (037''s key), the registering top-level transaction and time; then the credit note id and the settlement time, each set once. States: open, issued, released, confirmed. Unique per (invoice, tenant, store, actor, attempt); at most one unsettled row per (tenant, store, invoice, actor). Written only by 038''s register, issue and settle. No runtime role holds a privilege on it.';
comment on column tmpos_invoice_credit_note.invoice_credit_note_registration.session_digest is
  'Phase 4.0 M7b (migration 038): sha256 of the registering session key (itself a digest, never a credential). Never returned.';
comment on column tmpos_invoice_credit_note.invoice_credit_note_registration.registered_xact is
  'Phase 4.0 M7b (migration 038): pg_current_xact_id() of the registering top-level transaction: the proof and the issue refuse inside it.';

create table tmpos_invoice_credit_note.invoice_credit_note (
  credit_note_id     uuid        not null,
  tenant_id          uuid        not null,
  store_id           uuid        not null,
  invoice_id         uuid        not null,
  attempt_id         uuid        not null,
  registration_id    uuid        not null,
  credit_note_number bigint      not null,
  gross_cents        bigint      not null,
  tax_cents          bigint      not null,
  net_cents          bigint      not null,
  reason_code        text        collate "C" not null,
  issued_at          timestamptz not null,
  issued_by          uuid        not null,
  constraint invoice_credit_note_pkey primary key (credit_note_id),
  -- An attempt is issued at most once per invoice, permanently (D-CN-9 duplicates); its index serves every per-invoice read.
  constraint invoice_credit_note_attempt_key unique (invoice_id, tenant_id, store_id, attempt_id),
  constraint invoice_credit_note_registration_key unique (registration_id),
  constraint invoice_credit_note_number_key unique (tenant_id, store_id, credit_note_number),
  -- The withdrawal's and the registration's reference target.
  constraint invoice_credit_note_scope_key unique (credit_note_id, invoice_id, tenant_id, store_id),
  constraint invoice_credit_note_invoice_fkey foreign key (invoice_id, tenant_id, store_id)
    references tmpos_invoice_issue.issued_invoice (invoice_id, tenant_id, store_id) on delete restrict on update restrict,
  constraint invoice_credit_note_registration_fkey foreign key (registration_id)
    references tmpos_invoice_credit_note.invoice_credit_note_registration (registration_id) on delete restrict on update restrict,
  constraint invoice_credit_note_number_chk check (credit_note_number between 1 and 9007199254740991),
  constraint invoice_credit_note_gross_chk check (gross_cents between 1 and 9007199254740991),
  constraint invoice_credit_note_split_chk check (tax_cents >= 0 and net_cents >= 0 and gross_cents = tax_cents + net_cents),
  constraint invoice_credit_note_reason_code_chk check (reason_code in ('pricing_error', 'service_issue', 'goodwill', 'billing_error'))
);

comment on table tmpos_invoice_credit_note.invoice_credit_note is
  'Phase 4.0 M7b (migration 038): append-only — one row per credit note issued against one issued invoice of its tenant and store: the runtime''s id, the client''s attempt id (unique per invoice, permanently), its registration, the store''s credit-note number (series from 1, shown with the prefix CN-), the gross (what lowers the remaining amount), its tax and net split (D-CN-4 A, interim, fixed at issue), the closed reason, the database time and the issuing actor. It returns no money and edits no invoice. Insert only. Written only by m7b_invoice_credit_note_issue. Provisional shape (D-CN-10): a later additive migration, never an edit of this file. No runtime role holds a privilege on it.';
comment on column tmpos_invoice_credit_note.invoice_credit_note.issued_by is
  'Phase 4.0 M7b (migration 038): the issuing actor''s internal_user_id. Plain uuid, no FK. Only the list returns it, as a display name, to the store-scope store owner.';
comment on column tmpos_invoice_credit_note.invoice_credit_note.issued_at is
  'Phase 4.0 M7b (migration 038): the database clock (clock_timestamp()) after the issue routine''s last lock; never before the invoice''s issued_at; no back-dating; UTC is authoritative.';

alter table tmpos_invoice_credit_note.invoice_credit_note_registration
  add constraint invoice_credit_note_registration_credit_note_fkey foreign key (credit_note_id, invoice_id, tenant_id, store_id)
    references tmpos_invoice_credit_note.invoice_credit_note (credit_note_id, invoice_id, tenant_id, store_id)
    on delete restrict on update restrict;

create table tmpos_invoice_credit_note.invoice_credit_note_withdrawal (
  credit_note_id uuid        not null,
  tenant_id      uuid        not null,
  store_id       uuid        not null,
  invoice_id     uuid        not null,
  reason_code    text        collate "C" not null,
  withdrawn_at   timestamptz not null,
  withdrawn_by   uuid        not null,
  constraint invoice_credit_note_withdrawal_pkey primary key (credit_note_id),
  constraint invoice_credit_note_withdrawal_credit_note_fkey foreign key (credit_note_id, invoice_id, tenant_id, store_id)
    references tmpos_invoice_credit_note.invoice_credit_note (credit_note_id, invoice_id, tenant_id, store_id)
    on delete restrict on update restrict,
  constraint invoice_credit_note_withdrawal_reason_code_chk check (reason_code in ('entered_in_error', 'wrong_amount', 'wrong_invoice'))
);

comment on table tmpos_invoice_credit_note.invoice_credit_note_withdrawal is
  'Phase 4.0 M7b (migration 038): append-only — at most one row per credit note, withdrawing it whole (D-CN-5 A) with its closed reason, the database time and the withdrawing actor. The credit note row and its number stay. Insert only. Written only by m7b_invoice_credit_note_withdraw. No runtime role holds a privilege on it.';
comment on column tmpos_invoice_credit_note.invoice_credit_note_withdrawal.withdrawn_by is
  'Phase 4.0 M7b (migration 038): the withdrawing actor''s internal_user_id. Plain uuid, no FK. Only the list returns it, as a display name, to the store-scope store owner.';

alter table tmpos_invoice_credit_note.invoice_credit_note_counter enable row level security;
alter table tmpos_invoice_credit_note.invoice_credit_note_registration enable row level security;
alter table tmpos_invoice_credit_note.invoice_credit_note enable row level security;
alter table tmpos_invoice_credit_note.invoice_credit_note_withdrawal enable row level security;
revoke all on table tmpos_invoice_credit_note.invoice_credit_note_counter from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
revoke all on table tmpos_invoice_credit_note.invoice_credit_note_registration from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
revoke all on table tmpos_invoice_credit_note.invoice_credit_note from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
revoke all on table tmpos_invoice_credit_note.invoice_credit_note_withdrawal from public, anon, authenticated, tmpos_app, tmpos_audit_writer;

-- =============================================================================
-- 6) The guards (SECURITY INVOKER, granted to nobody, ENABLE ALWAYS; refusals restrict_violation with fixed text)
-- =============================================================================
create function tmpos_invoice_credit_note.m7b_invoice_credit_note_counter_guard()
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
     or tg_table_schema is distinct from 'tmpos_invoice_credit_note' or tg_table_name is distinct from 'invoice_credit_note_counter' then
    raise exception 'm7b_invoice_credit_note_counter_guard: fired by an undeclared trigger'
      using errcode = 'triggered_action_exception';
  end if;
  if tg_op = 'INSERT' then
    if new.last_number is distinct from 0::bigint
       or not exists (select 1 from public.store s where s.store_id = new.store_id and s.tenant_id = new.tenant_id) then
      raise exception 'migration 038: a store''s credit-note counter is created at 0, for a store of its tenant'
        using errcode = 'restrict_violation';
    end if;
    return new;
  elsif tg_op = 'DELETE' then
    raise exception 'migration 038: a store''s credit-note counter is never deleted'
      using errcode = 'restrict_violation';
  end if;
  if new.tenant_id is distinct from old.tenant_id
     or new.store_id is distinct from old.store_id
     or new.last_number is distinct from old.last_number + 1 then
    raise exception 'migration 038: a store''s credit-note counter moves by exactly one'
      using errcode = 'restrict_violation';
  end if;
  return new;
end
$$;

comment on function tmpos_invoice_credit_note.m7b_invoice_credit_note_counter_guard() is
  'Phase 4.0 M7b (migration 038): BEFORE INSERT OR UPDATE OR DELETE row trigger on invoice_credit_note_counter (enabled ALWAYS). Refuses (restrict_violation, fixed message) an insert not at 0 or not for a store of its tenant, an update that changes the tenant or store or does not step by exactly one, and every delete; triggered_action_exception for any other firing. A number is used only when a credit note names it (the credit note''s guard). Granted to nobody.';

create function tmpos_invoice_credit_note.m7b_invoice_credit_note_registration_guard()
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
     or tg_table_schema is distinct from 'tmpos_invoice_credit_note' or tg_table_name is distinct from 'invoice_credit_note_registration' then
    raise exception 'm7b_invoice_credit_note_registration_guard: fired by an undeclared trigger'
      using errcode = 'triggered_action_exception';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'migration 038: a credit-note registration is never deleted'
      using errcode = 'restrict_violation';
  end if;
  if tg_op = 'INSERT' then
    -- Every mandatory column here, with a fixed message: no NOT NULL or CHECK failure may echo the row (the session digest).
    if new.registration_id is null or new.tenant_id is null or new.store_id is null or new.invoice_id is null
       or new.registered_by is null or new.attempt_id is null or new.registered_xact is null or new.registered_at is null
       or new.gross_cents is null or new.gross_cents not between 1 and 9007199254740991
       or new.reason_code is null or new.reason_code not in ('pricing_error', 'service_issue', 'goodwill', 'billing_error')
       or new.session_digest is null or pg_catalog.octet_length(new.session_digest) <> 32
       or new.key_generation is null or new.key_generation not between 1 and 9007199254740991 then
      raise exception 'migration 038: a credit-note registration carries every mandatory column, a gross and reason in range, a 32-byte session digest and a generation in range'
        using errcode = 'restrict_violation';
    end if;
    if new.credit_note_id is not null or new.acknowledged_at is not null then
      raise exception 'migration 038: a credit-note registration is inserted open'
        using errcode = 'restrict_violation';
    end if;
    -- Checked here too because a replica session skips the foreign key's trigger.
    if not exists (select 1 from tmpos_invoice_issue.issued_invoice i
                    where i.invoice_id = new.invoice_id and i.tenant_id = new.tenant_id and i.store_id = new.store_id) then
      raise exception 'migration 038: a credit-note registration names an issued invoice of its own tenant and store'
        using errcode = 'restrict_violation';
    end if;
    return new;
  end if;
  if (new.registration_id, new.tenant_id, new.store_id, new.invoice_id, new.registered_by, new.attempt_id, new.gross_cents,
      new.reason_code, new.session_digest, new.key_generation, new.registered_xact, new.registered_at)
     is distinct from
     (old.registration_id, old.tenant_id, old.store_id, old.invoice_id, old.registered_by, old.attempt_id, old.gross_cents,
      old.reason_code, old.session_digest, old.key_generation, old.registered_xact, old.registered_at) then
    raise exception 'migration 038: only a credit-note registration''s credit note and settlement ever change'
      using errcode = 'restrict_violation';
  end if;
  if old.credit_note_id is null and old.acknowledged_at is null and new.credit_note_id is not null and new.acknowledged_at is null then
    -- open -> issued: the credit note is this registration's own — same scope, attempt, registration, issuer and bound values.
    if not exists (select 1 from tmpos_invoice_credit_note.invoice_credit_note c
                    where c.credit_note_id = new.credit_note_id and c.invoice_id = new.invoice_id and c.tenant_id = new.tenant_id
                      and c.store_id = new.store_id and c.attempt_id = new.attempt_id and c.registration_id = new.registration_id
                      and c.issued_by = new.registered_by and c.gross_cents = new.gross_cents
                      and c.reason_code = new.reason_code) then
      raise exception 'migration 038: a credit-note registration is issued only by its own attempt''s credit note'
        using errcode = 'restrict_violation';
    end if;
    return new;
  end if;
  if old.acknowledged_at is null and new.acknowledged_at is not null and new.credit_note_id is not distinct from old.credit_note_id then
    -- open -> released, or issued -> confirmed.
    if new.acknowledged_at < old.registered_at then
      raise exception 'migration 038: a credit-note registration is settled at or after its registration'
        using errcode = 'restrict_violation';
    end if;
    return new;
  end if;
  raise exception 'migration 038: a credit-note registration moves only open to issued, open to released or issued to confirmed'
    using errcode = 'restrict_violation';
end
$$;

comment on function tmpos_invoice_credit_note.m7b_invoice_credit_note_registration_guard() is
  'Phase 4.0 M7b (migration 038): BEFORE INSERT OR UPDATE OR DELETE row trigger on invoice_credit_note_registration (enabled ALWAYS). Refuses (restrict_violation, fixed message) every delete; an insert missing a mandatory column, with a gross or reason out of range, a session digest not 32 bytes or a generation out of range (so no NOT NULL or CHECK failure echoes the row), or not open, or not naming an issued invoice of its scope; an update that changes anything but credit_note_id and acknowledged_at, or that is not open -> issued (its own attempt''s credit note: same scope, registration, issuer, gross and reason), open -> released or issued -> confirmed (settled at or after registration). triggered_action_exception for any other firing. Granted to nobody.';

create function tmpos_invoice_credit_note.m7b_invoice_credit_note_guard()
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
     or tg_table_schema is distinct from 'tmpos_invoice_credit_note' or tg_table_name is distinct from 'invoice_credit_note' then
    raise exception 'm7b_invoice_credit_note_guard: fired by an undeclared trigger'
      using errcode = 'triggered_action_exception';
  end if;
  if tg_op <> 'INSERT' then
    raise exception 'migration 038: a credit note is never updated or deleted'
      using errcode = 'restrict_violation';
  end if;
  -- WITHOUT A ROW LOCK: 034's ALWAYS guards keep a committed issued header unchanged and undeleted; the issue routine already
  -- holds it FOR UPDATE. Checked here too because a replica session skips the foreign key's trigger.
  select i.issued_at into v_issued_at
    from tmpos_invoice_issue.issued_invoice i
   where i.invoice_id = new.invoice_id and i.tenant_id = new.tenant_id and i.store_id = new.store_id;
  if not found then
    raise exception 'migration 038: a credit note names an issued invoice of its own tenant and store'
      using errcode = 'restrict_violation';
  end if;
  if new.issued_at is null or new.issued_at < v_issued_at then
    raise exception 'migration 038: a credit note is stamped at or after its invoice''s issue'
      using errcode = 'restrict_violation';
  end if;
  -- Its open registration, of the same scope, attempt, issuer and bound values.
  if not exists (select 1 from tmpos_invoice_credit_note.invoice_credit_note_registration g
                  where g.registration_id = new.registration_id and g.invoice_id = new.invoice_id and g.tenant_id = new.tenant_id
                    and g.store_id = new.store_id and g.attempt_id = new.attempt_id and g.registered_by = new.issued_by
                    and g.gross_cents = new.gross_cents and g.reason_code = new.reason_code
                    and g.credit_note_id is null and g.acknowledged_at is null) then
    raise exception 'migration 038: a credit note is issued only through its own open registration'
      using errcode = 'restrict_violation';
  end if;
  -- The number the store's counter just took.
  if not exists (select 1 from tmpos_invoice_credit_note.invoice_credit_note_counter k
                  where k.tenant_id = new.tenant_id and k.store_id = new.store_id and k.last_number = new.credit_note_number) then
    raise exception 'migration 038: a credit note carries the number its store''s counter just took'
      using errcode = 'restrict_violation';
  end if;
  return new;
end
$$;

comment on function tmpos_invoice_credit_note.m7b_invoice_credit_note_guard() is
  'Phase 4.0 M7b (migration 038): BEFORE INSERT OR UPDATE OR DELETE row trigger on invoice_credit_note (enabled ALWAYS). Refuses (restrict_violation, fixed message) every update and delete, and an insert unless an issued invoice of the same id, tenant and store exists, issued_at is present and not before its issued_at, its registration is open with the same scope, attempt, issuer, gross and reason, and its number is its store counter''s last number (read without a row lock, row_security off). triggered_action_exception for any other firing. Granted to nobody.';

create function tmpos_invoice_credit_note.m7b_invoice_credit_note_withdrawal_guard()
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
     or tg_table_schema is distinct from 'tmpos_invoice_credit_note' or tg_table_name is distinct from 'invoice_credit_note_withdrawal' then
    raise exception 'm7b_invoice_credit_note_withdrawal_guard: fired by an undeclared trigger'
      using errcode = 'triggered_action_exception';
  end if;
  if tg_op <> 'INSERT' then
    raise exception 'migration 038: a credit-note withdrawal is never updated or deleted'
      using errcode = 'restrict_violation';
  end if;
  select c.issued_at into v_issued_at
    from tmpos_invoice_credit_note.invoice_credit_note c
   where c.credit_note_id = new.credit_note_id and c.invoice_id = new.invoice_id
     and c.tenant_id = new.tenant_id and c.store_id = new.store_id;
  if not found then
    raise exception 'migration 038: a credit-note withdrawal names a credit note of its own invoice, tenant and store'
      using errcode = 'restrict_violation';
  end if;
  if new.withdrawn_at is null or new.withdrawn_at < v_issued_at then
    raise exception 'migration 038: a credit-note withdrawal is stamped at or after its credit note''s issue'
      using errcode = 'restrict_violation';
  end if;
  return new;
end
$$;

comment on function tmpos_invoice_credit_note.m7b_invoice_credit_note_withdrawal_guard() is
  'Phase 4.0 M7b (migration 038): BEFORE INSERT OR UPDATE OR DELETE row trigger on invoice_credit_note_withdrawal (enabled ALWAYS). Refuses (restrict_violation, fixed message) every update and delete, and an insert unless a credit note of the same id, invoice, tenant and store exists (read without a row lock, row_security off) and withdrawn_at is present and not before its issued_at. triggered_action_exception for any other firing. Granted to nobody.';

create function tmpos_invoice_credit_note.m7b_invoice_credit_note_truncate_guard()
returns trigger
language plpgsql
volatile
security invoker
set search_path = pg_catalog, pg_temp
as $$
begin
  if tg_when is distinct from 'BEFORE' or tg_level is distinct from 'STATEMENT' or tg_op is distinct from 'TRUNCATE'
     or tg_table_schema is distinct from 'tmpos_invoice_credit_note'
     or tg_table_name not in ('invoice_credit_note_counter', 'invoice_credit_note_registration', 'invoice_credit_note',
                              'invoice_credit_note_withdrawal') then
    raise exception 'm7b_invoice_credit_note_truncate_guard: fired by an undeclared trigger'
      using errcode = 'triggered_action_exception';
  end if;
  raise exception 'migration 038: credit notes, their withdrawals, counters and registrations are never truncated'
    using errcode = 'restrict_violation';
end
$$;

comment on function tmpos_invoice_credit_note.m7b_invoice_credit_note_truncate_guard() is
  'Phase 4.0 M7b (migration 038): BEFORE TRUNCATE statement trigger on the four tables of tmpos_invoice_credit_note (enabled ALWAYS); always raises restrict_violation (fixed message). triggered_action_exception for any other firing. Granted to nobody.';

create trigger trg_invoice_credit_note_counter_guard
  before insert or update or delete on tmpos_invoice_credit_note.invoice_credit_note_counter
  for each row execute function tmpos_invoice_credit_note.m7b_invoice_credit_note_counter_guard();
alter table tmpos_invoice_credit_note.invoice_credit_note_counter enable always trigger trg_invoice_credit_note_counter_guard;
create trigger trg_invoice_credit_note_counter_truncate
  before truncate on tmpos_invoice_credit_note.invoice_credit_note_counter
  for each statement execute function tmpos_invoice_credit_note.m7b_invoice_credit_note_truncate_guard();
alter table tmpos_invoice_credit_note.invoice_credit_note_counter enable always trigger trg_invoice_credit_note_counter_truncate;
create trigger trg_invoice_credit_note_registration_guard
  before insert or update or delete on tmpos_invoice_credit_note.invoice_credit_note_registration
  for each row execute function tmpos_invoice_credit_note.m7b_invoice_credit_note_registration_guard();
alter table tmpos_invoice_credit_note.invoice_credit_note_registration enable always trigger trg_invoice_credit_note_registration_guard;
create trigger trg_invoice_credit_note_registration_truncate
  before truncate on tmpos_invoice_credit_note.invoice_credit_note_registration
  for each statement execute function tmpos_invoice_credit_note.m7b_invoice_credit_note_truncate_guard();
alter table tmpos_invoice_credit_note.invoice_credit_note_registration enable always trigger trg_invoice_credit_note_registration_truncate;
create trigger trg_invoice_credit_note_guard
  before insert or update or delete on tmpos_invoice_credit_note.invoice_credit_note
  for each row execute function tmpos_invoice_credit_note.m7b_invoice_credit_note_guard();
alter table tmpos_invoice_credit_note.invoice_credit_note enable always trigger trg_invoice_credit_note_guard;
create trigger trg_invoice_credit_note_truncate
  before truncate on tmpos_invoice_credit_note.invoice_credit_note
  for each statement execute function tmpos_invoice_credit_note.m7b_invoice_credit_note_truncate_guard();
alter table tmpos_invoice_credit_note.invoice_credit_note enable always trigger trg_invoice_credit_note_truncate;
create trigger trg_invoice_credit_note_withdrawal_guard
  before insert or update or delete on tmpos_invoice_credit_note.invoice_credit_note_withdrawal
  for each row execute function tmpos_invoice_credit_note.m7b_invoice_credit_note_withdrawal_guard();
alter table tmpos_invoice_credit_note.invoice_credit_note_withdrawal enable always trigger trg_invoice_credit_note_withdrawal_guard;
create trigger trg_invoice_credit_note_withdrawal_truncate
  before truncate on tmpos_invoice_credit_note.invoice_credit_note_withdrawal
  for each statement execute function tmpos_invoice_credit_note.m7b_invoice_credit_note_truncate_guard();
alter table tmpos_invoice_credit_note.invoice_credit_note_withdrawal enable always trigger trg_invoice_credit_note_withdrawal_truncate;

-- One counter row at 0 for every store existing now (D-CN-6); a later store's row is inserted by its first issue.
insert into tmpos_invoice_credit_note.invoice_credit_note_counter (tenant_id, store_id, last_number)
select s.tenant_id, s.store_id, 0 from public.store s;

-- =============================================================================
-- 7) The cutover barrier (038 cutover (c)): insert-time, whatever routine inserts
-- =============================================================================
-- SECURITY DEFINER (the owner's reach, whoever inserts) and VOLATILE: under READ COMMITTED each statement takes a fresh
-- snapshot, so a sum read after the header lock sees every credit note, payment and reversal that committed before it.
create function tmpos_invoice_credit_note.m7b_invoice_credit_note_payment_barrier()
returns trigger
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set row_security = off
as $$
declare
  v_total    bigint;
  v_credited numeric;
  v_paid     numeric;
begin
  if tg_when is distinct from 'BEFORE' or tg_level is distinct from 'ROW' or tg_op is distinct from 'INSERT'
     or tg_table_schema is distinct from 'tmpos_invoice_payment' or tg_table_name is distinct from 'invoice_payment' then
    raise exception 'm7b_invoice_credit_note_payment_barrier: fired by an undeclared trigger'
      using errcode = 'triggered_action_exception';
  end if;
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'migration 038: a payment is recorded only under READ COMMITTED'
      using errcode = 'restrict_violation';
  end if;
  -- The header FOR UPDATE: a no-op for a routine that already holds it; a waiter for anyone else.
  select i.total_cents into v_total
    from tmpos_invoice_issue.issued_invoice i
   where i.invoice_id = new.invoice_id and i.tenant_id = new.tenant_id and i.store_id = new.store_id
     for update;
  if not found then
    raise exception 'migration 038: a payment record names an issued invoice of its own tenant and store'
      using errcode = 'restrict_violation';
  end if;
  select coalesce(pg_catalog.sum(c.gross_cents), 0) into v_credited
    from tmpos_invoice_credit_note.invoice_credit_note c
   where c.invoice_id = new.invoice_id and c.tenant_id = new.tenant_id and c.store_id = new.store_id
     and not exists (select 1 from tmpos_invoice_credit_note.invoice_credit_note_withdrawal w where w.credit_note_id = c.credit_note_id);
  select coalesce(pg_catalog.sum(p.amount_cents), 0) into v_paid
    from tmpos_invoice_payment.invoice_payment p
   where p.invoice_id = new.invoice_id and p.tenant_id = new.tenant_id and p.store_id = new.store_id
     and not exists (select 1 from tmpos_invoice_payment.invoice_payment_reversal r where r.payment_id = p.payment_id);
  if new.amount_cents is null or v_credited + v_paid + new.amount_cents::numeric > v_total::numeric then
    raise exception 'migration 038: the payment would exceed what remains of the invoice''s Total after its active credit notes'
      using errcode = 'restrict_violation';
  end if;
  return new;
end
$$;

comment on function tmpos_invoice_credit_note.m7b_invoice_credit_note_payment_barrier() is
  'Phase 4.0 M7b (migration 038): BEFORE INSERT row trigger on tmpos_invoice_payment.invoice_payment (enabled ALWAYS), SECURITY DEFINER, VOLATILE — the cutover barrier (doc 16, 038 cutover (c)). Refuses (restrict_violation, fixed message) anything but READ COMMITTED; then takes the issued header FOR UPDATE and, in separate statements, refuses a payment whose amount plus the invoice''s active credit notes plus its unreversed payments exceeds the Total. Fires for every inserter (036''s record, 037''s record v2 admitted before 038, the routines'' owner). triggered_action_exception for any other firing. Granted to nobody.';

create function tmpos_invoice_credit_note.m7b_invoice_credit_note_void_barrier()
returns trigger
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set row_security = off
as $$
begin
  if tg_when is distinct from 'BEFORE' or tg_level is distinct from 'ROW' or tg_op is distinct from 'INSERT'
     or tg_table_schema is distinct from 'tmpos_invoice_void' or tg_table_name is distinct from 'issued_invoice_void' then
    raise exception 'm7b_invoice_credit_note_void_barrier: fired by an undeclared trigger'
      using errcode = 'triggered_action_exception';
  end if;
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'migration 038: an invoice is voided only under READ COMMITTED'
      using errcode = 'restrict_violation';
  end if;
  perform 1
    from tmpos_invoice_issue.issued_invoice i
   where i.invoice_id = new.invoice_id and i.tenant_id = new.tenant_id and i.store_id = new.store_id
     for update;
  if not found then
    raise exception 'migration 038: a void names an issued invoice of its own tenant and store'
      using errcode = 'restrict_violation';
  end if;
  if exists (select 1 from tmpos_invoice_credit_note.invoice_credit_note c
              where c.invoice_id = new.invoice_id and c.tenant_id = new.tenant_id and c.store_id = new.store_id
                and not exists (select 1 from tmpos_invoice_credit_note.invoice_credit_note_withdrawal w
                                 where w.credit_note_id = c.credit_note_id)) then
    raise exception 'migration 038: an invoice with an active credit note is not voided'
      using errcode = 'restrict_violation';
  end if;
  return new;
end
$$;

comment on function tmpos_invoice_credit_note.m7b_invoice_credit_note_void_barrier() is
  'Phase 4.0 M7b (migration 038): BEFORE INSERT row trigger on tmpos_invoice_void.issued_invoice_void (enabled ALWAYS), SECURITY DEFINER, VOLATILE — the cutover barrier (doc 16, 038 cutover (c)). Refuses (restrict_violation, fixed message) anything but READ COMMITTED; then takes the issued header FOR UPDATE and, in a separate statement, refuses a void while any credit note of the invoice has no withdrawal. Fires for every inserter (035''s void, 036''s void v2 admitted before 038, the routines'' owner). triggered_action_exception for any other firing. Granted to nobody.';

create trigger trg_invoice_payment_credit_note_barrier
  before insert on tmpos_invoice_payment.invoice_payment
  for each row execute function tmpos_invoice_credit_note.m7b_invoice_credit_note_payment_barrier();
alter table tmpos_invoice_payment.invoice_payment enable always trigger trg_invoice_payment_credit_note_barrier;
create trigger trg_issued_invoice_void_credit_note_barrier
  before insert on tmpos_invoice_void.issued_invoice_void
  for each row execute function tmpos_invoice_credit_note.m7b_invoice_credit_note_void_barrier();
alter table tmpos_invoice_void.issued_invoice_void enable always trigger trg_issued_invoice_void_credit_note_barrier;

-- =============================================================================
-- 8) The audit record's credit-note and credit-note registration subjects (public.audit_event)
-- =============================================================================
alter table public.audit_event
  add column subject_invoice_credit_note_id uuid;
alter table public.audit_event
  add column subject_invoice_credit_note_registration_id uuid;

comment on column public.audit_event.subject_invoice_credit_note_id is
  'Phase 4.0 M7b (migration 038): the credit note the action issued or withdrew. Written by 038''s issue and withdraw routines themselves, in the same transaction as the change, never from request metadata. Plain column, no FK. Never accompanied by an amount, customer, seller or line value.';
comment on column public.audit_event.subject_invoice_credit_note_registration_id is
  'Phase 4.0 M7b (migration 038): the credit-note registration the action registered, issued against or settled. Written by 038''s register, issue and settle routines themselves, in the same transaction as the change, never from request metadata. Plain column, no FK.';

create index idx_audit_event_subject_invoice_credit_note_occurred
  on public.audit_event (subject_invoice_credit_note_id, occurred_at desc)
  where subject_invoice_credit_note_id is not null;
create index idx_audit_event_subj_invoice_credit_note_registration_occurred
  on public.audit_event (subject_invoice_credit_note_registration_id, occurred_at desc)
  where subject_invoice_credit_note_registration_id is not null;

-- =============================================================================
-- 9) The proof message (granted to nobody)
-- =============================================================================
-- Fixed-width fields after a versioned prefix and a NUL, then the reason as the LAST field (its only variable-length one), so
-- it cannot be read two ways. The label differs from 037's: a payment proof is never a credit-note proof, nor the reverse.
create function tmpos_invoice_credit_note.m7b_invoice_credit_note_registration_proof_message(
  p_registration_id uuid, p_actor_id uuid, p_tenant_id uuid, p_store_id uuid, p_invoice_id uuid, p_attempt_id uuid,
  p_session_digest bytea, p_generation bigint, p_gross_cents bigint, p_reason text)
returns bytea
language sql
immutable
strict
security invoker
set search_path = pg_catalog, pg_temp
as $$
  select pg_catalog.convert_to('tmpos-m7b-invoice-credit-note-registration-proof:v1', 'UTF8') operator(pg_catalog.||) pg_catalog.decode('00', 'hex')
         operator(pg_catalog.||) pg_catalog.uuid_send(p_registration_id) operator(pg_catalog.||) pg_catalog.uuid_send(p_actor_id)
         operator(pg_catalog.||) pg_catalog.uuid_send(p_tenant_id) operator(pg_catalog.||) pg_catalog.uuid_send(p_store_id)
         operator(pg_catalog.||) pg_catalog.uuid_send(p_invoice_id) operator(pg_catalog.||) pg_catalog.uuid_send(p_attempt_id)
         operator(pg_catalog.||) p_session_digest operator(pg_catalog.||) pg_catalog.int8send(p_generation)
         operator(pg_catalog.||) pg_catalog.int8send(p_gross_cents) operator(pg_catalog.||) pg_catalog.convert_to(p_reason, 'UTF8')
   where pg_catalog.octet_length(p_session_digest) = 32
$$;

comment on function tmpos_invoice_credit_note.m7b_invoice_credit_note_registration_proof_message(uuid, uuid, uuid, uuid, uuid, uuid, bytea, bigint, bigint, text) is
  'Phase 4.0 M7b (migration 038): the credit-note proof message — UTF-8 ''tmpos-m7b-invoice-credit-note-registration-proof:v1'', a NUL, the registration, actor, tenant, store, invoice and attempt uuids (uuid_send, 16 bytes each), the 32-byte session digest, the generation (int8send), the bound gross (int8send) and, last, the bound reason (UTF-8). NULL for a NULL argument or a digest of another length. Granted to nobody.';

-- =============================================================================
-- 10) Register (D-CN-9 A; 037's register with the bound gross and reason, the store-owner role and the recent sign-in)
-- =============================================================================
create function tmpos_invoice_credit_note.m7b_invoice_credit_note_register(
  p_session_key text, p_store_id uuid, p_invoice_id uuid, p_expected_tenant uuid, p_registration_id uuid, p_attempt_id uuid,
  p_gross_cents bigint, p_reason text, p_correlation_id uuid)
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
  v_auth       bigint;
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
    raise exception 'migration 038 register: an argument is malformed'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_gross_cents is null or p_gross_cents < 1 or p_gross_cents > 9007199254740991 then
    raise exception 'migration 038 register: the amount is out of range'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_reason is null or p_reason not in ('pricing_error', 'service_issue', 'goodwill', 'billing_error') then
    raise exception 'migration 038 register: the reason is not one of the closed list'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_correlation_id is null or p_correlation_id::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception 'migration 038 register: the correlation id is not a version-4 uuid'
      using errcode = 'invalid_parameter_value';
  end if;
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'migration 038 register: it must run under READ COMMITTED, so that its checks see what committed before its locks'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- 1. The caller (037's derivation: write statuses), the store-scope store owner only (D-CN-7 A).
  select w.o_tenant_id, w.o_actor_id, w.o_membership_id, w.o_role, w.o_expires_at
    into v_tenant, v_actor, v_membership, v_role, v_expires
    from tmpos_invoice_payment.m7b_payment_writer(p_session_key, p_store_id) w;
  if not found or v_role is distinct from 'store_owner' then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;
  -- The session row's sign-in time, under the FOR SHARE the writer took.
  select s.authenticated_at into v_auth from tmpos_session.session s where s.session_key = p_session_key;
  -- 2. expectedTenant, a precondition only.
  if v_tenant is distinct from p_expected_tenant then
    return query select 'tenant_mismatch'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;
  -- 3. THE ISSUED HEADER FOR UPDATE: every writer of this invoice's registrations, credit notes and payments serializes here.
  perform 1 from tmpos_invoice_issue.issued_invoice i
   where i.invoice_id = p_invoice_id and i.tenant_id = v_tenant and i.store_id = p_store_id
     for update;
  if not found then
    return query select 'not_found'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;
  -- 4. The proof key's generation, FOR SHARE until COMMIT (a rotation waits): no key, no registration (fail closed).
  select k.generation into v_generation from tmpos_invoice_payment.payment_proof_key k where k.singleton for share;
  if v_generation is null then
    raise exception 'migration 038 register: the payment proof key is not installed'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- 5. After the last lock wait, ONE reading of the database clock: the session's expiry and the recent sign-in (036's reversal
  --    step 7: NULL, more than 5000 ms in the future or older than 600000 ms refuse).
  v_clock := pg_catalog.clock_timestamp();
  v_now := pg_catalog.floor(extract(epoch from v_clock) * 1000)::bigint;
  if v_now >= v_expires
     or v_auth is null
     or pg_catalog.to_timestamp(v_auth / 1000.0) > v_clock + interval '5000 milliseconds'
     or v_clock > pg_catalog.to_timestamp((v_auth + 600000) / 1000.0) then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;
  -- 6. SEPARATE STATEMENTS on the caller's own rows only, in order (037's register).
  if exists (select 1 from tmpos_invoice_credit_note.invoice_credit_note_registration g
              where g.invoice_id = p_invoice_id and g.tenant_id = v_tenant and g.store_id = p_store_id
                and g.registered_by = v_actor and g.attempt_id = p_attempt_id and g.credit_note_id is not null) then
    return query select 'already_issued'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;
  if exists (select 1 from tmpos_invoice_credit_note.invoice_credit_note_registration g
              where g.invoice_id = p_invoice_id and g.tenant_id = v_tenant and g.store_id = p_store_id
                and g.registered_by = v_actor and g.acknowledged_at is null) then
    return query select 'conflict'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;
  if exists (select 1 from tmpos_invoice_credit_note.invoice_credit_note_registration g
              where g.invoice_id = p_invoice_id and g.tenant_id = v_tenant and g.store_id = p_store_id
                and g.registered_by = v_actor and g.attempt_id = p_attempt_id) then
    return query select 'invalid_state'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;
  if exists (select 1 from tmpos_invoice_void.issued_invoice_void v where v.invoice_id = p_invoice_id) then
    return query select 'invalid_state'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;

  -- 7. The registration, open, bound to this session, generation, top-level transaction, gross and reason.
  v_clock := pg_catalog.clock_timestamp();
  begin
    insert into tmpos_invoice_credit_note.invoice_credit_note_registration
      (registration_id, tenant_id, store_id, invoice_id, registered_by, attempt_id, gross_cents, reason_code, session_digest,
       key_generation, registered_xact, registered_at)
    values (p_registration_id, v_tenant, p_store_id, p_invoice_id, v_actor, p_attempt_id, p_gross_cents, p_reason,
            pg_catalog.sha256(pg_catalog.convert_to(p_session_key, 'UTF8')), v_generation, pg_catalog.pg_current_xact_id(), v_clock);
    get diagnostics v_written = row_count;
  exception
    when unique_violation or check_violation or foreign_key_violation or not_null_violation or restrict_violation then
      raise exception 'migration 038 register: the registration is not one the registration table admits'
        using errcode = 'integrity_constraint_violation';
  end;
  if v_written is distinct from 1
     or not exists (select 1 from tmpos_invoice_credit_note.invoice_credit_note_registration g
                     where g.registration_id = p_registration_id and g.tenant_id = v_tenant and g.store_id = p_store_id
                       and g.invoice_id = p_invoice_id and g.registered_by = v_actor and g.attempt_id = p_attempt_id
                       and g.gross_cents = p_gross_cents and g.reason_code = p_reason
                       and g.key_generation = v_generation and g.registered_at = v_clock
                       and g.credit_note_id is null and g.acknowledged_at is null) then
    raise exception 'migration 038 register: the registration was not written as judged'
      using errcode = 'no_data_found';
  end if;

  -- 8. ONE audit record, read back.
  v_event := null;
  begin
    insert into public.audit_event
      (request_id, trace_id, actor_internal_user_id, actor_auth_provider, on_behalf_of_internal_user_id, scope_type, tenant_id,
       store_id, action_id, required_permission, decision, reason_code, human_readable_reason, result_status, source_of_truth,
       evaluated_by, evidence_level, metadata, subject_invoice_credit_note_registration_id)
    values (p_correlation_id::text, null, v_actor, null, null, 'store', v_tenant, p_store_id,
            'store.invoice_credit_note.register', 'issue_invoice_credit_notes', 'allow', 'invoice_credit_note_attempt_registered',
            'Credit note attempt registered against an issued invoice.',
            'succeeded', 'invoice_credit_note_routine', 'm7b_invoice_credit_note_routine@v1', 'durable_compliance_event', '{}'::jsonb,
            p_registration_id)
    returning event_id into v_event;
    get diagnostics v_written = row_count;
  exception
    when unique_violation or check_violation or foreign_key_violation or not_null_violation or restrict_violation then
      raise exception 'migration 038 register: the audit record is not one the audit table admits'
        using errcode = 'integrity_constraint_violation';
  end;
  if v_written is distinct from 1 or v_event is null
     or not exists (select 1 from public.audit_event a
                     where a.event_id = v_event and a.request_id = p_correlation_id::text
                       and a.action_id = 'store.invoice_credit_note.register' and a.actor_internal_user_id = v_actor
                       and a.tenant_id = v_tenant and a.store_id = p_store_id
                       and a.subject_invoice_credit_note_registration_id = p_registration_id) then
    raise exception 'migration 038 register: the audit record was not written exactly once'
      using errcode = 'no_data_found';
  end if;

  return query select 'applied'::text, v_tenant, p_store_id, v_actor, v_membership, p_registration_id, p_invoice_id, v_event;
end
$$;

comment on function tmpos_invoice_credit_note.m7b_invoice_credit_note_register(text, uuid, uuid, uuid, uuid, uuid, bigint, text, uuid) is
  'Phase 4.0 M7b (migration 038): registers one credit-note attempt of the caller on one issued invoice, binding its gross and reason. Answers (''refused'', NULLs) unless the caller is the store-scope store_owner at p_store_id on write statuses (037''s m7b_payment_writer); (''tenant_mismatch''); (''not_found'') alike for a missing or foreign invoice; then, the header FOR UPDATE and the proof key generation FOR SHARE, on one clock reading (''refused'') for an expired session or a sign-in older than 10 minutes; then, on the caller''s own rows only: (''already_issued'') for this attempt issued, (''conflict'') while any own registration on the invoice is unsettled, (''invalid_state'') for this attempt released or a voided invoice — nothing written; else one open registration and ONE audit record (store.invoice_credit_note.register), (''applied'', tenant, store, actor, membership, registration, invoice, audit event id). Raises invalid_parameter_value for a malformed argument, gross or reason, object_not_in_prerequisite_state outside READ COMMITTED or without an installed proof key, integrity_constraint_violation for a constraint refusal (all fixed text).';

-- =============================================================================
-- 11) The proof (037's, commit- and flush-qualified, durability identical)
-- =============================================================================
create function tmpos_invoice_credit_note.m7b_invoice_credit_note_registration_proof(
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
    raise exception 'migration 038 proof: an argument is malformed'
      using errcode = 'invalid_parameter_value';
  end if;
  v_budget := p_wait_ms * interval '1 millisecond';
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'migration 038 proof: it must run under READ COMMITTED, so that it reads only committed registrations'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- 1. The caller: 034's lock-free store reader at write statuses (expectedTenant folded in), the store-scope store owner only.
  select r.o_tenant_id, r.o_actor_id, r.o_role into v_reader
    from tmpos_invoice_issue.m7b_issue_store_reader(p_session_key, p_expected_tenant, p_store_id, true, 'approve') r;
  if not found or v_reader.o_role is distinct from 'store_owner' then
    return query select 'denied'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::text;
    return;
  end if;
  -- 2. The key, a plain read (no lock): none installed fails closed.
  select k.key, k.generation into v_key, v_generation from tmpos_invoice_payment.payment_proof_key k where k.singleton;
  if v_key is null then
    raise exception 'migration 038 proof: the payment proof key is not installed'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- 3. The COMMITTED, OPEN registration of this caller, scope and generation, then the session and the transaction.
  select g.attempt_id, g.session_digest, g.registered_xact, g.gross_cents, g.reason_code into v_row
    from tmpos_invoice_credit_note.invoice_credit_note_registration g
   where g.registration_id = p_registration_id and g.invoice_id = p_invoice_id and g.tenant_id = v_reader.o_tenant_id
     and g.store_id = p_store_id and g.registered_by = v_reader.o_actor_id
     and g.credit_note_id is null and g.acknowledged_at is null and g.key_generation = v_generation;
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
  -- 4. DURABILITY (037's rule, exactly).
  if pg_catalog.current_setting('fsync') is distinct from 'on' then
    raise exception 'migration 038 proof: fsync is off, so no flush is durable'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  select c.max_data_alignment, c.wal_block_size, c.bytes_per_wal_segment into v_align, v_block, v_segment
    from pg_catalog.pg_control_init() c;
  if v_align is distinct from 8 or v_block is null or v_segment is null then
    raise exception 'migration 038 proof: unverified WAL page header layout'
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
    perform pg_catalog.pg_sleep(least(0.02, extract(epoch from v_budget - (pg_catalog.clock_timestamp() - v_start))));
  end loop;
  -- 5. The proof, over the registration's bound gross and reason.
  v_mac := tmpos_mint.hmac_sha256(v_key, tmpos_invoice_credit_note.m7b_invoice_credit_note_registration_proof_message(
             p_registration_id, v_reader.o_actor_id, v_reader.o_tenant_id, p_store_id, p_invoice_id, v_row.attempt_id,
             v_digest, v_generation, v_row.gross_cents, v_row.reason_code));
  if v_mac is null or pg_catalog.octet_length(v_mac) <> 32 then
    raise exception 'migration 038 proof: the proof could not be computed'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  return query select 'proof'::text, v_reader.o_tenant_id, p_store_id, p_invoice_id, p_registration_id, v_row.attempt_id,
                      pg_catalog.encode(v_mac, 'hex');
end
$$;

comment on function tmpos_invoice_credit_note.m7b_invoice_credit_note_registration_proof(text, uuid, uuid, uuid, uuid, integer) is
  'Phase 4.0 M7b (migration 038): the proof for one COMMITTED, OPEN credit-note registration of the caller (034''s store reader at write statuses with expectedTenant, role store_owner), of this store and invoice, under the current key generation, from the session that registered it and outside the registering transaction. (''denied'', NULLs) for every authority refusal; (''not_found'', NULLs) alike for every other mismatch; else, once the flush reaches the end-of-record form of the insert position sampled after that read (037''s rule exactly: fsync on, alignment 8, p_wait_ms 0 to 1000), (''proof'', tenant, store, invoice, registration, attempt, 64 lowercase hex digits of HMAC-SHA-256 under 037''s key over the credit-note message, which binds the gross and reason); (''not_durable'', NULLs) otherwise — nothing written, and the caller commits before any fresh attempt. Raises object_not_in_prerequisite_state (fixed text) without a key, with fsync off or an unverified WAL layout, and outside READ COMMITTED; invalid_parameter_value for a malformed argument. Locks no row; writes nothing.';

-- =============================================================================
-- 12) Issue (D-CN-9 A: waits first, then one clock reading, then each check in the precedence list's order)
-- =============================================================================
create function tmpos_invoice_credit_note.m7b_invoice_credit_note_issue(
  p_session_key text, p_store_id uuid, p_invoice_id uuid, p_expected_tenant uuid, p_credit_note_id uuid, p_registration_id uuid,
  p_attempt_id uuid, p_gross_cents bigint, p_reason text, p_proof text, p_correlation_id uuid)
returns table (
  o_outcome        text,
  o_tenant_id      uuid,
  o_store_id       uuid,
  o_actor_id       uuid,
  o_membership_id  uuid,
  o_credit_note_id uuid,
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
  c_reasons       constant text[] := array['pricing_error', 'service_issue', 'goodwill', 'billing_error'];
  c_reason_labels constant text[] := array['Pricing error', 'Service issue', 'Goodwill', 'Billing error'];
  v_tenant        uuid;
  v_actor         uuid;
  v_membership    uuid;
  v_role          text;
  v_expires       bigint;
  v_auth          bigint;
  v_now           bigint;
  v_clock         timestamptz;
  v_header        record;
  v_key           bytea;
  v_generation    bigint;
  v_reg           record;
  v_reg_found     boolean;
  v_last          bigint;
  v_digest        bytea;
  v_ag            numeric;
  v_at            numeric;
  v_paid          numeric;
  v_g             numeric;
  v_t             numeric;
  v_written       integer;
  v_check         record;
  v_event         uuid;
begin
  -- 0. Every argument, before anything is read.
  if p_session_key is null or p_session_key !~ '^[\x21-\x7e]{1,128}$'
     or p_store_id is null or p_invoice_id is null or p_expected_tenant is null
     or p_credit_note_id is null or p_registration_id is null or p_attempt_id is null then
    raise exception 'migration 038 issue: an argument is malformed'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_gross_cents is null or p_gross_cents < 1 or p_gross_cents > 9007199254740991 then
    raise exception 'migration 038 issue: the amount is out of range'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_reason is null or not (p_reason = any (c_reasons)) then
    raise exception 'migration 038 issue: the reason is not one of the closed list'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_proof is null or p_proof !~ '^[0-9a-f]{64}$' then
    raise exception 'migration 038 issue: the proof is malformed'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_correlation_id is null or p_correlation_id::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception 'migration 038 issue: the correlation id is not a version-4 uuid'
      using errcode = 'invalid_parameter_value';
  end if;
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'migration 038 issue: it must run under READ COMMITTED, so that its checks see what committed before its locks'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- 2. The caller, the role and the write statuses ('refused'); expectedTenant ('tenant_mismatch'); the header ('not_found').
  select w.o_tenant_id, w.o_actor_id, w.o_membership_id, w.o_role, w.o_expires_at
    into v_tenant, v_actor, v_membership, v_role, v_expires
    from tmpos_invoice_payment.m7b_payment_writer(p_session_key, p_store_id) w;
  if not found or v_role is distinct from 'store_owner' then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;
  select s.authenticated_at into v_auth from tmpos_session.session s where s.session_key = p_session_key;
  if v_tenant is distinct from p_expected_tenant then
    return query select 'tenant_mismatch'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;
  select i.invoice_id, i.tenant_id, i.store_id, i.subtotal_cents, i.tax_mode, i.tax_cents, i.total_cents
    into v_header
    from tmpos_invoice_issue.issued_invoice i
   where i.invoice_id = p_invoice_id and i.tenant_id = v_tenant and i.store_id = p_store_id
     for update;
  if not found then
    return query select 'not_found'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;

  -- 3. The waits: the proof key FOR SHARE (a rotation waits; none installed fails closed), the caller's registration of THIS
  --    attempt FOR UPDATE, the store's counter row (inserted at 0 if this store has none: the one write a refusal may commit,
  --    D-CN-6) FOR UPDATE. Locking the counter consumes no number.
  select k.key, k.generation into v_key, v_generation from tmpos_invoice_payment.payment_proof_key k where k.singleton for share;
  if v_key is null then
    raise exception 'migration 038 issue: the payment proof key is not installed'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  select g.registration_id, g.session_digest, g.key_generation, g.registered_xact, g.gross_cents, g.reason_code,
         g.credit_note_id, g.acknowledged_at
    into v_reg
    from tmpos_invoice_credit_note.invoice_credit_note_registration g
   where g.invoice_id = p_invoice_id and g.tenant_id = v_tenant and g.store_id = p_store_id
     and g.registered_by = v_actor and g.attempt_id = p_attempt_id
     for update;
  v_reg_found := found;
  begin
    insert into tmpos_invoice_credit_note.invoice_credit_note_counter (tenant_id, store_id, last_number)
    values (v_tenant, p_store_id, 0)
    on conflict (tenant_id, store_id) do nothing;
  exception
    when unique_violation or check_violation or foreign_key_violation or not_null_violation or restrict_violation then
      raise exception 'migration 038 issue: the store''s credit-note counter is not one the counter table admits'
        using errcode = 'integrity_constraint_violation';
  end;
  select k.last_number into v_last
    from tmpos_invoice_credit_note.invoice_credit_note_counter k
   where k.tenant_id = v_tenant and k.store_id = p_store_id
     for update;
  if not found then
    raise exception 'migration 038 issue: the store has no credit-note counter'
      using errcode = 'data_corrupted';
  end if;

  --    Then ONE reading of the database clock, after the last wait: the session's expiry and the recent sign-in (036's
  --    reversal step 7).
  v_clock := pg_catalog.clock_timestamp();
  v_now := pg_catalog.floor(extract(epoch from v_clock) * 1000)::bigint;
  if v_now >= v_expires
     or v_auth is null
     or pg_catalog.to_timestamp(v_auth / 1000.0) > v_clock + interval '5000 milliseconds'
     or v_clock > pg_catalog.to_timestamp((v_auth + 600000) / 1000.0) then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;

  -- 4. THE SCOPE, together: the registration id, this session, the current generation, another (committed) transaction and the
  --    proof over the registration's BOUND values — any mismatch is the one 'not_found'.
  v_digest := pg_catalog.sha256(pg_catalog.convert_to(p_session_key, 'UTF8'));
  if not v_reg_found
     or v_reg.registration_id is distinct from p_registration_id
     or v_reg.session_digest is distinct from v_digest
     or v_reg.registered_xact is not distinct from pg_catalog.pg_current_xact_id()
     or v_reg.key_generation is distinct from v_generation
     or pg_catalog.sha256(tmpos_mint.hmac_sha256(v_key, tmpos_invoice_credit_note.m7b_invoice_credit_note_registration_proof_message(
          v_reg.registration_id, v_actor, v_tenant, p_store_id, p_invoice_id, p_attempt_id, v_digest, v_generation,
          v_reg.gross_cents, v_reg.reason_code)))
        is distinct from pg_catalog.sha256(pg_catalog.decode(p_proof, 'hex')) then
    return query select 'not_found'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;

  -- 5. The state, each its own statement after every lock; nothing written by any of them.
  if v_reg.credit_note_id is not null then
    return query select 'already_issued'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;
  if v_reg.acknowledged_at is not null then
    return query select 'invalid_state'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;
  if v_reg.gross_cents is distinct from p_gross_cents or v_reg.reason_code is distinct from p_reason then
    return query select 'conflict'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;
  if exists (select 1 from tmpos_invoice_credit_note.invoice_credit_note c
              where c.invoice_id = p_invoice_id and c.tenant_id = v_tenant and c.store_id = p_store_id
                and c.attempt_id = p_attempt_id) then
    return query select 'already_issued'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;
  if exists (select 1 from tmpos_invoice_void.issued_invoice_void v where v.invoice_id = p_invoice_id) then
    return query select 'invalid_state'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;
  -- The bound (I-CN): active credits, then unreversed payments, each a separate statement, plus G against the Total.
  select coalesce(pg_catalog.sum(c.gross_cents), 0), coalesce(pg_catalog.sum(c.tax_cents), 0) into v_ag, v_at
    from tmpos_invoice_credit_note.invoice_credit_note c
   where c.invoice_id = p_invoice_id and c.tenant_id = v_tenant and c.store_id = p_store_id
     and not exists (select 1 from tmpos_invoice_credit_note.invoice_credit_note_withdrawal w where w.credit_note_id = c.credit_note_id);
  select coalesce(pg_catalog.sum(p.amount_cents), 0) into v_paid
    from tmpos_invoice_payment.invoice_payment p
   where p.invoice_id = p_invoice_id and p.tenant_id = v_tenant and p.store_id = p_store_id
     and not exists (select 1 from tmpos_invoice_payment.invoice_payment_reversal r where r.payment_id = p.payment_id);
  v_g := p_gross_cents::numeric;
  if v_ag + v_paid + v_g > v_header.total_cents::numeric then
    return query select 'amount_exceeds_remaining'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;

  -- 6. The split (D-CN-4 A), after the bound (so T > 0): t = clamp(div(2 tax (aG + G) + T, 2 T) - aT, 0, G), net = G - t; tax
  --    mode none: t = 0. Then the invariants it guarantees by construction, re-checked: a failure is corruption, not a refusal.
  if v_header.tax_mode = 'none' then
    v_t := 0;
  else
    v_t := least(greatest(pg_catalog.div(2 * v_header.tax_cents::numeric * (v_ag + v_g) + v_header.total_cents::numeric,
                                         2 * v_header.total_cents::numeric) - v_at, 0), v_g);
  end if;
  if v_header.total_cents is null or v_header.total_cents <= 0 or v_header.subtotal_cents is null
     or (v_header.tax_mode = 'none' and (v_t <> 0 or v_at <> 0 or v_header.tax_cents is not null))
     or (v_header.tax_mode <> 'none' and v_header.tax_cents is null)
     or v_at + v_t > coalesce(v_header.tax_cents, 0)::numeric
     or (v_ag + v_g) - (v_at + v_t) > v_header.subtotal_cents::numeric
     or v_t < 0 or v_t > v_g then
    raise exception 'migration 038 issue: the credit notes'' tax split breaks an invariant of the invoice'
      using errcode = 'data_corrupted';
  end if;

  -- 7. The counter by exactly one, the credit note at that number, the registration's link — every constraint fixed text.
  if v_last >= 9007199254740991 then
    raise exception 'migration 038 issue: the store''s credit-note numbers are exhausted'
      using errcode = 'program_limit_exceeded';
  end if;
  v_clock := pg_catalog.clock_timestamp();
  begin
    update tmpos_invoice_credit_note.invoice_credit_note_counter k
       set last_number = k.last_number + 1
     where k.tenant_id = v_tenant and k.store_id = p_store_id and k.last_number = v_last;
    get diagnostics v_written = row_count;
    if v_written is distinct from 1 then
      raise exception 'migration 038 issue: the counter did not move by exactly one'
        using errcode = 'no_data_found';
    end if;
    insert into tmpos_invoice_credit_note.invoice_credit_note
      (credit_note_id, tenant_id, store_id, invoice_id, attempt_id, registration_id, credit_note_number, gross_cents, tax_cents,
       net_cents, reason_code, issued_at, issued_by)
    values (p_credit_note_id, v_header.tenant_id, v_header.store_id, p_invoice_id, p_attempt_id, p_registration_id, v_last + 1,
            p_gross_cents, v_t::bigint, (v_g - v_t)::bigint, p_reason, v_clock, v_actor);
    get diagnostics v_written = row_count;
    if v_written is distinct from 1 then
      raise exception 'migration 038 issue: the credit note was not written to exactly the locked invoice'
        using errcode = 'no_data_found';
    end if;
    update tmpos_invoice_credit_note.invoice_credit_note_registration g
       set credit_note_id = p_credit_note_id
     where g.registration_id = p_registration_id and g.credit_note_id is null and g.acknowledged_at is null;
    get diagnostics v_written = row_count;
  exception
    when unique_violation or check_violation or foreign_key_violation or not_null_violation or restrict_violation then
      raise exception 'migration 038 issue: the credit note is not one the credit-note tables admit'
        using errcode = 'integrity_constraint_violation';
  end;
  if v_written is distinct from 1 then
    raise exception 'migration 038 issue: the registration was not issued by exactly this credit note'
      using errcode = 'no_data_found';
  end if;
  select c.tenant_id, c.store_id, c.invoice_id, c.attempt_id, c.registration_id, c.credit_note_number, c.gross_cents, c.tax_cents,
         c.net_cents, c.reason_code, c.issued_at, c.issued_by
    into v_check
    from tmpos_invoice_credit_note.invoice_credit_note c
   where c.credit_note_id = p_credit_note_id;
  if not found
     or v_check.tenant_id is distinct from v_tenant or v_check.store_id is distinct from p_store_id
     or v_check.invoice_id is distinct from p_invoice_id or v_check.attempt_id is distinct from p_attempt_id
     or v_check.registration_id is distinct from p_registration_id or v_check.credit_note_number is distinct from v_last + 1
     or v_check.gross_cents is distinct from p_gross_cents or v_check.tax_cents::numeric is distinct from v_t
     or v_check.net_cents::numeric is distinct from v_g - v_t or v_check.reason_code is distinct from p_reason
     or v_check.issued_at is distinct from v_clock or v_check.issued_by is distinct from v_actor then
    raise exception 'migration 038 issue: the credit note is not the one judged'
      using errcode = 'no_data_found';
  end if;

  -- 8. ONE audit record naming both subjects, read back: exactly one row, or nothing commits.
  v_event := null;
  begin
    insert into public.audit_event
      (request_id, trace_id, actor_internal_user_id, actor_auth_provider, on_behalf_of_internal_user_id, scope_type, tenant_id,
       store_id, action_id, required_permission, decision, reason_code, human_readable_reason, result_status, source_of_truth,
       evaluated_by, evidence_level, metadata, subject_invoice_credit_note_id, subject_invoice_credit_note_registration_id)
    values (p_correlation_id::text, null, v_actor, null, null, 'store', v_tenant, p_store_id,
            'store.invoice_credit_note.issue', 'issue_invoice_credit_notes', 'allow', 'invoice_credit_note_issued_' || p_reason,
            'Credit note issued against an issued invoice. Reason: '
              || c_reason_labels[pg_catalog.array_position(c_reasons, p_reason)] || '.',
            'succeeded', 'invoice_credit_note_routine', 'm7b_invoice_credit_note_routine@v1', 'durable_compliance_event', '{}'::jsonb,
            p_credit_note_id, p_registration_id)
    returning event_id into v_event;
    get diagnostics v_written = row_count;
  exception
    when unique_violation or check_violation or foreign_key_violation or not_null_violation or restrict_violation then
      raise exception 'migration 038 issue: the audit record is not one the audit table admits'
        using errcode = 'integrity_constraint_violation';
  end;
  if v_written is distinct from 1 or v_event is null
     or not exists (select 1 from public.audit_event a
                     where a.event_id = v_event and a.request_id = p_correlation_id::text
                       and a.action_id = 'store.invoice_credit_note.issue' and a.actor_internal_user_id = v_actor
                       and a.tenant_id = v_tenant and a.store_id = p_store_id and a.subject_invoice_credit_note_id = p_credit_note_id
                       and a.subject_invoice_credit_note_registration_id = p_registration_id) then
    raise exception 'migration 038 issue: the audit record was not written exactly once'
      using errcode = 'no_data_found';
  end if;

  return query select 'applied'::text, v_tenant, p_store_id, v_actor, v_membership, p_credit_note_id, p_invoice_id, v_event;
end
$$;

comment on function tmpos_invoice_credit_note.m7b_invoice_credit_note_issue(text, uuid, uuid, uuid, uuid, uuid, uuid, bigint, text, text, uuid) is
  'Phase 4.0 M7b (migration 038): issues one credit note through the caller''s registration of p_attempt_id on one issued invoice (D-CN-9 A). (''refused'') unless the store-scope store_owner at p_store_id on write statuses; (''tenant_mismatch''); (''not_found'') for a missing or foreign invoice; then the header FOR UPDATE, the proof key FOR SHARE, the registration FOR UPDATE and the store''s counter (inserted at 0 if absent) FOR UPDATE; one clock reading: (''refused'') for an expired session or a sign-in older than 10 minutes; (''not_found'') unless the registration exists and is p_registration_id, of this session, of another committed transaction, under the current generation, and p_proof is its proof (over its bound gross and reason); then (''already_issued'') for it issued, (''invalid_state'') for it released, (''conflict'') for a gross or reason other than the bound ones, (''already_issued'') for the attempt id taken by any credit note on the invoice, (''invalid_state'') for a voided invoice, (''amount_exceeds_remaining'') for active credits + unreversed payments + gross above the Total — nothing written by any (but a new counter row); else the split t = clamp(div(2 tax (aG + G) + T, 2 T) - aT, 0, G) (0 under none; invariants re-checked, data_corrupted), the counter by one, ONE credit note at that number, the registration issued and ONE audit record naming both subjects: (''applied'', tenant, store, actor, membership, credit note, invoice, audit event id). Raises invalid_parameter_value for a malformed argument, gross, reason or proof, object_not_in_prerequisite_state outside READ COMMITTED or without a key, integrity_constraint_violation for a constraint refusal (all fixed text).';

-- =============================================================================
-- 13) The owner's attempts (the recovery lookup)
-- =============================================================================
create function tmpos_invoice_credit_note.m7b_invoice_credit_note_attempts(
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
  o_gross_cents    bigint,
  o_reason_code    text,
  o_credit_note_id uuid,
  o_issued_at      text,
  o_withdrawn_at   text
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
    raise exception 'migration 038 attempts: an argument is malformed'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 51 then
    raise exception 'migration 038 attempts: the limit is out of range'
      using errcode = 'invalid_parameter_value';
  end if;
  -- 034's lock-free store reader at read statuses (037's attempts), the store-scope store owner only.
  select r.o_tenant_id, r.o_actor_id, r.o_role into v_reader
    from tmpos_invoice_issue.m7b_issue_store_reader(p_session_key, p_expected_tenant, p_store_id, false, 'approve') r;
  if not found or v_reader.o_role is distinct from 'store_owner' then
    return query select 'denied'::text, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid, null::text, null::bigint,
                        null::text, null::text, null::bigint, null::text, null::uuid, null::text, null::text;
    return;
  end if;
  if p_after_invoice_id is not null then
    select g.registered_at into v_after_at
      from tmpos_invoice_credit_note.invoice_credit_note_registration g
     where g.tenant_id = v_reader.o_tenant_id and g.store_id = p_store_id and g.registered_by = v_reader.o_actor_id
       and g.invoice_id = p_after_invoice_id and g.attempt_id = p_after_attempt_id;
    if not found then
      return query select 'cursor_unknown'::text, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid, null::text, null::bigint,
                          null::text, null::text, null::bigint, null::text, null::uuid, null::text, null::text;
      return;
    end if;
  end if;
  -- Every unsettled row whatever its age, and rows settled in the last 24 hours. Never the registration id, the session
  -- digest, the generation or the transaction.
  return query
    select 'attempt'::text, g.tenant_id, g.store_id, g.invoice_id, i.number, g.attempt_id,
           case when g.credit_note_id is null and g.acknowledged_at is null then 'open'
                when g.acknowledged_at is null then 'issued'
                when g.credit_note_id is null then 'released'
                else 'confirmed' end,
           case when g.acknowledged_at is not null then 3::bigint when g.credit_note_id is not null then 2::bigint else 1::bigint end,
           pg_catalog.to_char(g.registered_at at time zone 'UTC', c_format),
           pg_catalog.to_char(g.acknowledged_at at time zone 'UTC', c_format),
           g.gross_cents, g.reason_code::text, c.credit_note_id,
           pg_catalog.to_char(c.issued_at at time zone 'UTC', c_format),
           pg_catalog.to_char(w.withdrawn_at at time zone 'UTC', c_format)
      from tmpos_invoice_credit_note.invoice_credit_note_registration g
      join tmpos_invoice_issue.issued_invoice i
        on i.invoice_id = g.invoice_id and i.tenant_id = g.tenant_id and i.store_id = g.store_id
      left join tmpos_invoice_credit_note.invoice_credit_note c on c.credit_note_id = g.credit_note_id
      left join tmpos_invoice_credit_note.invoice_credit_note_withdrawal w on w.credit_note_id = c.credit_note_id
     where g.tenant_id = v_reader.o_tenant_id and g.store_id = p_store_id and g.registered_by = v_reader.o_actor_id
       and (g.acknowledged_at is null or g.acknowledged_at > pg_catalog.statement_timestamp() - interval '24 hours')
       and (p_after_invoice_id is null
            or (g.registered_at, g.invoice_id, g.attempt_id) > (v_after_at, p_after_invoice_id, p_after_attempt_id))
     order by g.registered_at, g.invoice_id, g.attempt_id
     limit p_limit;
end
$$;

comment on function tmpos_invoice_credit_note.m7b_invoice_credit_note_attempts(text, uuid, uuid, uuid, uuid, integer) is
  'Phase 4.0 M7b (migration 038): one page (1-51, keyset (registered_at, invoice_id, attempt_id) after the caller''s own row (p_after_invoice_id, p_after_attempt_id), else ''cursor_unknown'') of the caller''s credit-note registrations at one store, under 034''s store reader at read statuses with expectedTenant and role store_owner: every unsettled one whatever its age and those settled in the last 24 hours, each (''attempt'', tenant, store, invoice, invoice number, attempt, state open|issued|released|confirmed, version 1|2|3|3, registered_at, settled_at, the bound gross and reason, and for an issued one its credit note id, issued_at and any withdrawn_at; UTC text with microseconds). No row for an empty page; (''denied'', NULLs) for every authority refusal. Never the registration id, session digest, generation or transaction. Never reads the proof key. STABLE; locks nothing.';

-- =============================================================================
-- 14) Settle (version-checked; never reads the proof key; no recent sign-in: recover_invoice_credit_notes is not sensitive)
-- =============================================================================
create function tmpos_invoice_credit_note.m7b_invoice_credit_note_settle(
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
  v_reg_found  boolean;
  v_reason     text;
  v_clock      timestamptz;
  v_written    integer;
  v_event      uuid;
begin
  if p_session_key is null or p_session_key !~ '^[\x21-\x7e]{1,128}$'
     or p_store_id is null or p_invoice_id is null or p_expected_tenant is null or p_attempt_id is null
     or p_expected_version is null or p_expected_version not in (1, 2) then
    raise exception 'migration 038 settle: an argument is malformed'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_correlation_id is null or p_correlation_id::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception 'migration 038 settle: the correlation id is not a version-4 uuid'
      using errcode = 'invalid_parameter_value';
  end if;
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'migration 038 settle: it must run under READ COMMITTED, so that its checks see what committed before its locks'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  select w.o_tenant_id, w.o_actor_id, w.o_membership_id, w.o_role, w.o_expires_at
    into v_tenant, v_actor, v_membership, v_role, v_expires
    from tmpos_invoice_payment.m7b_payment_writer(p_session_key, p_store_id) w;
  if not found or v_role is distinct from 'store_owner' then
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
  -- The caller's own registration of this attempt, locked (a foreign one is absent: the same answer) — the last wait.
  select g.registration_id, g.credit_note_id, g.acknowledged_at into v_reg
    from tmpos_invoice_credit_note.invoice_credit_note_registration g
   where g.invoice_id = p_invoice_id and g.tenant_id = v_tenant and g.store_id = p_store_id
     and g.registered_by = v_actor and g.attempt_id = p_attempt_id
     for update;
  v_reg_found := found;
  -- After the last lock wait: the session's expiry.
  v_now := pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp()) * 1000)::bigint;
  if v_now >= v_expires then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid, null::uuid;
    return;
  end if;
  if not v_reg_found then
    return query select 'not_found'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid, null::uuid;
    return;
  end if;
  -- Version 1 = "I saw it open" (release), 2 = "I saw it issued" (confirm); a repeat of the same settlement is unchanged.
  if v_reg.acknowledged_at is not null then
    if (v_reg.credit_note_id is null and p_expected_version = 1) or (v_reg.credit_note_id is not null and p_expected_version = 2) then
      return query select 'unchanged'::text, v_tenant, p_store_id, v_actor, v_membership, 3::bigint, p_invoice_id, null::uuid;
      return;
    end if;
    return query select 'conflict'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid, null::uuid;
    return;
  end if;
  if (v_reg.credit_note_id is null) <> (p_expected_version = 1) then
    return query select 'conflict'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid, null::uuid;
    return;
  end if;
  v_reason := case when v_reg.credit_note_id is null then 'invoice_credit_note_attempt_released' else 'invoice_credit_note_attempt_confirmed' end;

  v_clock := pg_catalog.clock_timestamp();
  begin
    update tmpos_invoice_credit_note.invoice_credit_note_registration g
       set acknowledged_at = v_clock
     where g.registration_id = v_reg.registration_id and g.acknowledged_at is null;
    get diagnostics v_written = row_count;
  exception
    when unique_violation or check_violation or foreign_key_violation or not_null_violation or restrict_violation then
      raise exception 'migration 038 settle: the registration does not admit this settlement'
        using errcode = 'integrity_constraint_violation';
  end;
  if v_written is distinct from 1 then
    raise exception 'migration 038 settle: the registration was not settled exactly once'
      using errcode = 'no_data_found';
  end if;

  v_event := null;
  begin
    insert into public.audit_event
      (request_id, trace_id, actor_internal_user_id, actor_auth_provider, on_behalf_of_internal_user_id, scope_type, tenant_id,
       store_id, action_id, required_permission, decision, reason_code, human_readable_reason, result_status, source_of_truth,
       evaluated_by, evidence_level, metadata, subject_invoice_credit_note_registration_id)
    values (p_correlation_id::text, null, v_actor, null, null, 'store', v_tenant, p_store_id,
            'store.invoice_credit_note.settle', 'recover_invoice_credit_notes', 'allow', v_reason,
            case when v_reg.credit_note_id is null then 'Credit note attempt released: no credit note was issued for it.'
                 else 'Issued credit note confirmed by the staff member who registered it.' end,
            'succeeded', 'invoice_credit_note_routine', 'm7b_invoice_credit_note_routine@v1', 'durable_compliance_event', '{}'::jsonb,
            v_reg.registration_id)
    returning event_id into v_event;
    get diagnostics v_written = row_count;
  exception
    when unique_violation or check_violation or foreign_key_violation or not_null_violation or restrict_violation then
      raise exception 'migration 038 settle: the audit record is not one the audit table admits'
        using errcode = 'integrity_constraint_violation';
  end;
  if v_written is distinct from 1 or v_event is null
     or not exists (select 1 from public.audit_event a
                     where a.event_id = v_event and a.request_id = p_correlation_id::text
                       and a.action_id = 'store.invoice_credit_note.settle' and a.actor_internal_user_id = v_actor
                       and a.tenant_id = v_tenant and a.store_id = p_store_id
                       and a.subject_invoice_credit_note_registration_id = v_reg.registration_id) then
    raise exception 'migration 038 settle: the audit record was not written exactly once'
      using errcode = 'no_data_found';
  end if;

  return query select 'applied'::text, v_tenant, p_store_id, v_actor, v_membership, 3::bigint, p_invoice_id, v_event;
end
$$;

comment on function tmpos_invoice_credit_note.m7b_invoice_credit_note_settle(text, uuid, uuid, uuid, uuid, bigint, uuid) is
  'Phase 4.0 M7b (migration 038): settles the caller''s own credit-note registration of p_attempt_id on one issued invoice, version-checked: 1 releases an open one, 2 confirms an issued one. (''refused'') unless the store-scope store_owner on write statuses; (''tenant_mismatch''); (''not_found'') for a missing or foreign invoice; then the header FOR UPDATE and the registration FOR UPDATE; (''refused'') for an expired session (no recent sign-in: recover_invoice_credit_notes is not sensitive); (''not_found'') when the caller has none; (''unchanged'', ..., 3) for a repeat of the same settlement, no audit; (''conflict'', NULLs) when its state is not the one the version names; else sets acknowledged_at (clock_timestamp()), releasing the slot, and writes ONE audit record (store.invoice_credit_note.settle): (''applied'', tenant, store, actor, membership, 3, invoice, audit event id). Raises invalid_parameter_value for a malformed argument or a version outside 1-2, object_not_in_prerequisite_state outside READ COMMITTED, integrity_constraint_violation for a constraint refusal (all fixed text). Never reads the proof key.';

-- =============================================================================
-- 15) Withdraw (D-CN-9 "Withdrawal order", as 036's reversal)
-- =============================================================================
create function tmpos_invoice_credit_note.m7b_invoice_credit_note_withdraw(
  p_session_key text, p_store_id uuid, p_invoice_id uuid, p_expected_tenant uuid, p_credit_note_id uuid, p_expected_version bigint,
  p_reason text, p_correlation_id uuid)
returns table (
  o_outcome        text,
  o_tenant_id      uuid,
  o_store_id       uuid,
  o_actor_id       uuid,
  o_membership_id  uuid,
  o_credit_note_id uuid,
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
  c_reasons       constant text[] := array['entered_in_error', 'wrong_amount', 'wrong_invoice'];
  c_reason_labels constant text[] := array['Entered by mistake', 'Wrong amount', 'Wrong invoice'];
  v_tenant        uuid;
  v_actor         uuid;
  v_membership    uuid;
  v_role          text;
  v_expires       bigint;
  v_auth          bigint;
  v_now           bigint;
  v_clock         timestamptz;
  v_written       integer;
  v_check         record;
  v_event         uuid;
begin
  if p_session_key is null or p_session_key !~ '^[\x21-\x7e]{1,128}$'
     or p_store_id is null or p_invoice_id is null or p_expected_tenant is null or p_credit_note_id is null then
    raise exception 'migration 038 withdraw: an argument is malformed'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_expected_version is null or p_expected_version < 1 or p_expected_version > 9007199254740991 then
    raise exception 'migration 038 withdraw: the expected version is out of range'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_reason is null or not (p_reason = any (c_reasons)) then
    raise exception 'migration 038 withdraw: the reason is not one of the closed list'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_correlation_id is null or p_correlation_id::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception 'migration 038 withdraw: the correlation id is not a version-4 uuid'
      using errcode = 'invalid_parameter_value';
  end if;
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'migration 038 withdraw: it must run under READ COMMITTED, so that its checks see what committed before its locks'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- 1. The caller (store-scope store owner, write statuses); expectedTenant; the header FOR UPDATE.
  select w.o_tenant_id, w.o_actor_id, w.o_membership_id, w.o_role, w.o_expires_at
    into v_tenant, v_actor, v_membership, v_role, v_expires
    from tmpos_invoice_payment.m7b_payment_writer(p_session_key, p_store_id) w;
  if not found or v_role is distinct from 'store_owner' then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;
  select s.authenticated_at into v_auth from tmpos_session.session s where s.session_key = p_session_key;
  if v_tenant is distinct from p_expected_tenant then
    return query select 'tenant_mismatch'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;
  perform 1 from tmpos_invoice_issue.issued_invoice i
   where i.invoice_id = p_invoice_id and i.tenant_id = v_tenant and i.store_id = p_store_id
     for update;
  if not found then
    return query select 'not_found'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;
  -- 2. The credit note by (id, invoice, tenant, store): another invoice's, store's or tenant's, or none, is the same answer.
  if not exists (select 1 from tmpos_invoice_credit_note.invoice_credit_note c
                  where c.credit_note_id = p_credit_note_id and c.invoice_id = p_invoice_id
                    and c.tenant_id = v_tenant and c.store_id = p_store_id) then
    return query select 'not_found'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;
  -- 3. After the last lock wait, ONE clock reading: the session's expiry and the recent sign-in (036's reversal step 7).
  v_clock := pg_catalog.clock_timestamp();
  v_now := pg_catalog.floor(extract(epoch from v_clock) * 1000)::bigint;
  if v_now >= v_expires
     or v_auth is null
     or pg_catalog.to_timestamp(v_auth / 1000.0) > v_clock + interval '5000 milliseconds'
     or v_clock > pg_catalog.to_timestamp((v_auth + 600000) / 1000.0) then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;
  -- 4. Already withdrawn: terminal, whatever version is named.
  if exists (select 1 from tmpos_invoice_credit_note.invoice_credit_note_withdrawal w where w.credit_note_id = p_credit_note_id) then
    return query select 'invalid_state'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;
  -- 5. The credit note's lifecycle version: 1 while active.
  if p_expected_version is distinct from 1::bigint then
    return query select 'conflict'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;

  -- 6. The withdrawal: one insert, its scope the credit note's.
  v_clock := pg_catalog.clock_timestamp();
  begin
    insert into tmpos_invoice_credit_note.invoice_credit_note_withdrawal
      (credit_note_id, tenant_id, store_id, invoice_id, reason_code, withdrawn_at, withdrawn_by)
    values (p_credit_note_id, v_tenant, p_store_id, p_invoice_id, p_reason, v_clock, v_actor);
    get diagnostics v_written = row_count;
  exception
    when unique_violation or check_violation or foreign_key_violation or not_null_violation or restrict_violation then
      raise exception 'migration 038 withdraw: the withdrawal is not one the withdrawal table admits'
        using errcode = 'integrity_constraint_violation';
  end;
  if v_written is distinct from 1 then
    raise exception 'migration 038 withdraw: the withdrawal was not written to exactly the locked credit note'
      using errcode = 'no_data_found';
  end if;
  select w.tenant_id, w.store_id, w.invoice_id, w.reason_code, w.withdrawn_at, w.withdrawn_by into v_check
    from tmpos_invoice_credit_note.invoice_credit_note_withdrawal w
   where w.credit_note_id = p_credit_note_id;
  if not found
     or v_check.tenant_id is distinct from v_tenant or v_check.store_id is distinct from p_store_id
     or v_check.invoice_id is distinct from p_invoice_id or v_check.reason_code is distinct from p_reason
     or v_check.withdrawn_at is distinct from v_clock or v_check.withdrawn_by is distinct from v_actor then
    raise exception 'migration 038 withdraw: the withdrawal is not the one judged'
      using errcode = 'no_data_found';
  end if;

  -- 7. ONE audit record, read back.
  v_event := null;
  begin
    insert into public.audit_event
      (request_id, trace_id, actor_internal_user_id, actor_auth_provider, on_behalf_of_internal_user_id, scope_type, tenant_id,
       store_id, action_id, required_permission, decision, reason_code, human_readable_reason, result_status, source_of_truth,
       evaluated_by, evidence_level, metadata, subject_invoice_credit_note_id)
    values (p_correlation_id::text, null, v_actor, null, null, 'store', v_tenant, p_store_id,
            'store.invoice_credit_note.withdraw', 'withdraw_invoice_credit_notes', 'allow', 'invoice_credit_note_withdrawn_' || p_reason,
            'Credit note withdrawn. Reason: ' || c_reason_labels[pg_catalog.array_position(c_reasons, p_reason)] || '.',
            'succeeded', 'invoice_credit_note_routine', 'm7b_invoice_credit_note_routine@v1', 'durable_compliance_event', '{}'::jsonb,
            p_credit_note_id)
    returning event_id into v_event;
    get diagnostics v_written = row_count;
  exception
    when unique_violation or check_violation or foreign_key_violation or not_null_violation or restrict_violation then
      raise exception 'migration 038 withdraw: the audit record is not one the audit table admits'
        using errcode = 'integrity_constraint_violation';
  end;
  if v_written is distinct from 1 or v_event is null
     or not exists (select 1 from public.audit_event a
                     where a.event_id = v_event and a.request_id = p_correlation_id::text
                       and a.action_id = 'store.invoice_credit_note.withdraw' and a.actor_internal_user_id = v_actor
                       and a.tenant_id = v_tenant and a.store_id = p_store_id and a.subject_invoice_credit_note_id = p_credit_note_id) then
    raise exception 'migration 038 withdraw: the audit record was not written exactly once'
      using errcode = 'no_data_found';
  end if;

  return query select 'applied'::text, v_tenant, p_store_id, v_actor, v_membership, p_credit_note_id, p_invoice_id, v_event;
end
$$;

comment on function tmpos_invoice_credit_note.m7b_invoice_credit_note_withdraw(text, uuid, uuid, uuid, uuid, bigint, text, uuid) is
  'Phase 4.0 M7b (migration 038): withdraws one credit note whole (D-CN-5 A). (''refused'') unless the store-scope store_owner on write statuses; (''tenant_mismatch''); (''not_found'') for a missing or foreign invoice; the header FOR UPDATE; (''not_found'') for a credit note not of this invoice, tenant and store; one clock reading: (''refused'') for an expired session or a sign-in older than 10 minutes; (''invalid_state'') when already withdrawn; (''conflict'') for an expected version other than 1 — nothing written; else ONE withdrawal and ONE audit record (store.invoice_credit_note.withdraw): (''applied'', tenant, store, actor, membership, credit note, invoice, audit event id). Raises invalid_parameter_value for a malformed argument, version or reason, object_not_in_prerequisite_state outside READ COMMITTED, integrity_constraint_violation for a constraint refusal (all fixed text).';

-- =============================================================================
-- 16) The list (one snapshot; staff names to the store-scope store owner only)
-- =============================================================================
create function tmpos_invoice_credit_note.m7b_invoice_credit_notes_list(
  p_session_key text, p_expected_tenant uuid, p_expected_store uuid, p_invoice_id uuid, p_after_credit_note_id uuid, p_limit integer)
returns table (
  o_outcome                 text,
  o_tenant_id               uuid,
  o_store_id                uuid,
  o_invoice_id              uuid,
  o_names_visible           boolean,
  o_credit_note_id          uuid,
  o_credit_note_number      bigint,
  o_gross_cents             bigint,
  o_tax_cents               bigint,
  o_net_cents               bigint,
  o_reason_code             text,
  o_issued_at               text,
  o_issued_by_name          text,
  o_withdrawn_at            text,
  o_withdrawal_reason_code  text,
  o_withdrawn_by_name       text
)
language plpgsql
-- STABLE IS LOAD-BEARING (036's payments read): every statement here, 035's v2 get included, sees the calling query's one
-- snapshot, so the page is never a mixture of before and after a concurrent issue or withdrawal.
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
  v_head     record;
  v_names    boolean;
  v_after_at timestamptz;
  v_after_id uuid;
begin
  if p_limit is null or p_limit < 1 or p_limit > 51 then
    raise exception 'migration 038 list: the limit is out of range'
      using errcode = 'invalid_parameter_value';
  end if;
  -- 035's v2 get decides the authority (view_issued_invoices' levels), its words and its raises; only its first row is read.
  select r.o_outcome, r.o_tenant_id, r.o_store_id, r.o_invoice_id
    into v_head
    from tmpos_invoice_void.m7b_issued_invoice_get_v2(p_session_key, p_expected_tenant, p_expected_store, p_invoice_id)
           with ordinality as r
   order by r.ordinality
   limit 1;
  if not found or v_head.o_outcome is null then
    raise exception 'migration 038 list: the issued read answered no row'
      using errcode = 'data_corrupted';
  end if;
  if v_head.o_outcome in ('denied', 'not_found') then
    return query select v_head.o_outcome, null::uuid, null::uuid, null::uuid, null::boolean, null::uuid, null::bigint, null::bigint,
      null::bigint, null::bigint, null::text, null::text, null::text, null::text, null::text, null::text;
    return;
  end if;
  if v_head.o_outcome is distinct from 'line' then
    raise exception 'migration 038 list: the issued read answered an unexpected row'
      using errcode = 'data_corrupted';
  end if;
  -- Names only for the store-scope store owner (D-CN-7 A), derived from the same key by 034's store reader.
  v_names := exists (select 1 from tmpos_invoice_issue.m7b_issue_store_reader(p_session_key, p_expected_tenant, p_expected_store, false, 'view') r
                      where r.o_role = 'store_owner');
  if p_after_credit_note_id is not null then
    select c.issued_at, c.credit_note_id into v_after_at, v_after_id
      from tmpos_invoice_credit_note.invoice_credit_note c
     where c.credit_note_id = p_after_credit_note_id and c.invoice_id = v_head.o_invoice_id
       and c.tenant_id = v_head.o_tenant_id and c.store_id = v_head.o_store_id;
    if not found then
      return query select 'cursor_unknown'::text, null::uuid, null::uuid, null::uuid, null::boolean, null::uuid, null::bigint,
        null::bigint, null::bigint, null::bigint, null::text, null::text, null::text, null::text, null::text, null::text;
      return;
    end if;
  end if;
  return query
    select 'credit_notes'::text, v_head.o_tenant_id, v_head.o_store_id, v_head.o_invoice_id, v_names,
           c.credit_note_id, c.credit_note_number, c.gross_cents, c.tax_cents, c.net_cents, c.reason_code::text,
           pg_catalog.to_char(c.issued_at at time zone 'UTC', c_format),
           case when v_names then ui.display_name::text end,
           pg_catalog.to_char(w.withdrawn_at at time zone 'UTC', c_format),
           w.reason_code::text,
           case when v_names and w.credit_note_id is not null then uw.display_name::text end
      from tmpos_invoice_credit_note.invoice_credit_note c
      left join tmpos_invoice_credit_note.invoice_credit_note_withdrawal w on w.credit_note_id = c.credit_note_id
      left join public.app_user ui on ui.internal_user_id = c.issued_by
      left join public.app_user uw on uw.internal_user_id = w.withdrawn_by
     where c.invoice_id = v_head.o_invoice_id and c.tenant_id = v_head.o_tenant_id and c.store_id = v_head.o_store_id
       and (p_after_credit_note_id is null or (c.issued_at, c.credit_note_id) > (v_after_at, v_after_id))
     order by c.issued_at, c.credit_note_id
     limit p_limit;
  if not found then
    return query select 'credit_notes'::text, v_head.o_tenant_id, v_head.o_store_id, v_head.o_invoice_id, v_names, null::uuid,
      null::bigint, null::bigint, null::bigint, null::bigint, null::text, null::text, null::text, null::text, null::text, null::text;
  end if;
end
$$;

comment on function tmpos_invoice_credit_note.m7b_invoice_credit_notes_list(text, uuid, uuid, uuid, uuid, integer) is
  'Phase 4.0 M7b (migration 038): one issued invoice''s credit notes, on one snapshot, under migration 035''s m7b_issued_invoice_get_v2 (its authority — view_issued_invoices'' levels — its ''denied'' and ''not_found'' words, alike for a missing, another store''s and another tenant''s invoice, and its raises). Answers (''cursor_unknown'', NULLs) when p_after_credit_note_id is not a credit note of the invoice; else ''credit_notes'' rows, oldest first by (issued_at, credit_note_id), at most p_limit (1-51), after the cursor, each carrying the invoice id, o_names_visible (true only for the store-scope store_owner), the credit note''s id, number, gross, tax, net, reason, issued_at and, when withdrawn, withdrawn_at and its reason (UTC text with microseconds), and the issuing and withdrawing staff display names only when o_names_visible (else NULL; the server omits the fields); one row with NULL credit-note columns for an empty page. Never an actor id or email. STABLE; locks nothing.';

-- =============================================================================
-- 17) The record, v3: 037's record v2 with a cap that counts active credit notes (CN-A2)
-- =============================================================================
create function tmpos_invoice_payment.m7b_invoice_payment_record_v3(
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
  v_credited      numeric;
  v_recorded_at   timestamptz;
  v_written       integer;
  v_check         record;
  v_event         uuid;
begin
  -- 0. Every argument, before anything is read.
  if p_session_key is null or p_session_key !~ '^[\x21-\x7e]{1,128}$'
     or p_store_id is null or p_invoice_id is null or p_expected_tenant is null
     or p_payment_id is null or p_registration_id is null or p_attempt_id is null then
    raise exception 'migration 038 record: an argument is malformed'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_amount_cents is null or p_amount_cents < 1 or p_amount_cents > 9007199254740991 then
    raise exception 'migration 038 record: the amount is out of range'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_method is null or not (p_method = any (c_methods)) then
    raise exception 'migration 038 record: the method is not one of the closed list'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_proof is null or p_proof !~ '^[0-9a-f]{64}$' then
    raise exception 'migration 038 record: the proof is malformed'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_correlation_id is null or p_correlation_id::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception 'migration 038 record: the correlation id is not a version-4 uuid'
      using errcode = 'invalid_parameter_value';
  end if;
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'migration 038 record: it must run under READ COMMITTED, so that its checks see what committed before its locks'
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
    raise exception 'migration 038 record: the payment proof key is not installed'
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
  -- CN-A2 (migration 038): the cap counts the invoice's active credit notes too — a separate statement after every lock.
  select coalesce(pg_catalog.sum(c.gross_cents), 0) into v_credited
    from tmpos_invoice_credit_note.invoice_credit_note c
   where c.invoice_id = p_invoice_id and c.tenant_id = v_tenant and c.store_id = p_store_id
     and not exists (select 1 from tmpos_invoice_credit_note.invoice_credit_note_withdrawal w where w.credit_note_id = c.credit_note_id);
  select coalesce(pg_catalog.sum(p.amount_cents), 0) into v_applied
    from tmpos_invoice_payment.invoice_payment p
   where p.invoice_id = p_invoice_id and p.tenant_id = v_tenant and p.store_id = p_store_id
     and not exists (select 1 from tmpos_invoice_payment.invoice_payment_reversal r where r.payment_id = p.payment_id);
  if v_credited + v_applied + p_amount_cents::numeric > v_total::numeric then
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
      raise exception 'migration 038 record: the payment is not one the payment table admits'
        using errcode = 'integrity_constraint_violation';
  end;
  if v_written is distinct from 1 then
    raise exception 'migration 038 record: the payment was not written to exactly the locked invoice'
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
    raise exception 'migration 038 record: the payment is not the one judged'
      using errcode = 'no_data_found';
  end if;
  begin
    update tmpos_invoice_payment.invoice_payment_registration g
       set payment_id = p_payment_id
     where g.registration_id = p_registration_id and g.payment_id is null and g.acknowledged_at is null;
    get diagnostics v_written = row_count;
  exception
    when unique_violation or check_violation or foreign_key_violation or not_null_violation or restrict_violation then
      raise exception 'migration 038 record: the registration does not admit this payment'
        using errcode = 'integrity_constraint_violation';
  end;
  if v_written is distinct from 1 then
    raise exception 'migration 038 record: the registration was not settled by exactly this payment'
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
      raise exception 'migration 038 record: the audit record is not one the audit table admits'
        using errcode = 'integrity_constraint_violation';
  end;
  if v_written is distinct from 1 or v_event is null
     or not exists (select 1 from public.audit_event a
                     where a.event_id = v_event and a.request_id = p_correlation_id::text
                       and a.action_id = 'store.invoice_payment.record' and a.actor_internal_user_id = v_actor
                       and a.tenant_id = v_tenant and a.store_id = p_store_id and a.subject_invoice_payment_id = p_payment_id
                       and a.subject_invoice_payment_registration_id = p_registration_id) then
    raise exception 'migration 038 record: the audit record was not written exactly once'
      using errcode = 'no_data_found';
  end if;

  return query select 'applied'::text, v_tenant, p_store_id, v_actor, v_membership, p_payment_id, p_invoice_id, v_event;
end
$$;

comment on function tmpos_invoice_payment.m7b_invoice_payment_record_v3(text, uuid, uuid, uuid, uuid, uuid, uuid, bigint, text, text, uuid) is
  'Phase 4.0 M7b (migration 038): migration 037''s m7b_invoice_payment_record_v2, argument for argument, word for word and step for step (the same registration table, proof key, proof label and message, outcome words and audit values), with ONE change (CN-A2): the cap reads, in separate statements after every lock, the invoice''s active credit notes (gross of those with no withdrawal) and its unreversed payments, and answers (''amount_exceeds_remaining'', NULLs) when credited + applied + the amount exceeds the Total. Raises as 037''s. tmpos_app no longer executes 037''s record v2.';

-- =============================================================================
-- 18) The void, v3: 036's void v2 with the credit-note check (CN-A3)
-- =============================================================================
create function tmpos_invoice_payment.m7b_invoice_void_v3(
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
    raise exception 'migration 038 void: an argument is malformed'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_expected_version is null or p_expected_version < 1 or p_expected_version > 9007199254740990 then
    raise exception 'migration 038 void: the expected version is out of range'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_reason_code is null or not (p_reason_code = any (c_reasons)) then
    raise exception 'migration 038 void: the reason code is not one of the closed list'
      using errcode = 'invalid_parameter_value';
  end if;
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'migration 038 void: it must run under READ COMMITTED, so that its checks see what committed before its locks'
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

  -- 7c. A SEPARATE STATEMENT after every lock, after 'payments_recorded' (CN-A3, migration 038): a credit note of this invoice
  --     with no withdrawal. The issue routine takes the same header first, so none can commit after this read and before this
  --     void's COMMIT.
  if exists (select 1 from tmpos_invoice_credit_note.invoice_credit_note c
              where c.invoice_id = p_invoice_id and c.tenant_id = v_tenant and c.store_id = p_store_id
                and not exists (select 1 from tmpos_invoice_credit_note.invoice_credit_note_withdrawal w
                                 where w.credit_note_id = c.credit_note_id)) then
    return query select 'credit_notes_recorded'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid;
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
      raise exception 'migration 038 void: the void record is not one the void table admits'
        using errcode = 'integrity_constraint_violation';
  end;
  if v_written is distinct from 1 then
    raise exception 'migration 038 void: the void was not written to exactly the locked invoice'
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
    raise exception 'migration 038 void: the void record is not the one judged'
      using errcode = 'no_data_found';
  end if;

  -- 10. Applied: the lifecycle version moves 1 -> 2.
  return query select 'applied'::text, v_tenant, p_store_id, v_admission.actor_id, v_membership, p_expected_version + 1,
    p_invoice_id;
end
$$;

comment on function tmpos_invoice_payment.m7b_invoice_void_v3(text, uuid, uuid, uuid, bigint, text) is
  'Phase 4.0 M7b (migration 038): migration 036''s m7b_invoice_void_v2, argument for argument, word for word and step for step, with one more separate read after every lock, after ''payments_recorded'' and before the version (CN-A3): (''credit_notes_recorded'', NULLs) while any credit note of the invoice has no withdrawal — nothing written. Raises as 036''s. Writes no audit, outbox or idempotency record (DA-118 for the void, unchanged). tmpos_app no longer executes 036''s m7b_invoice_void_v2.';

-- =============================================================================
-- 19) The payments read, v2: 036's read with the credited amount (CN-A1-A)
-- =============================================================================
create function tmpos_invoice_payment.m7b_invoice_payments_get_v2(
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
  o_credited_cents  bigint,
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
  v_credit  numeric;
  v_credited numeric;
  v_due     numeric;
  v_applied numeric;
  v_word    text;
begin
  if p_limit is null or p_limit < 1 or p_limit > 51 then
    raise exception 'migration 038 read: the limit is out of range'
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
    raise exception 'migration 038 read: the issued read answered no row'
      using errcode = 'data_corrupted';
  end if;
  if v_head.o_outcome in ('denied', 'not_found') then
    return query select v_head.o_outcome, null::uuid, null::uuid, null::uuid, null::text, null::text, null::bigint, null::bigint,
      null::bigint, null::bigint, null::bigint, null::text, null::uuid, null::uuid, null::bigint, null::text, null::text, null::text, null::text;
    return;
  end if;
  if v_head.o_outcome is distinct from 'line' or v_head.o_status not in ('issued', 'voided') or v_head.o_total_cents is null
     or v_head.o_total_cents < 0 then
    raise exception 'migration 038 read: the issued read answered an unexpected row'
      using errcode = 'data_corrupted';
  end if;
  if p_after_payment_id is not null then
    select p.recorded_at, p.payment_id into v_after_at, v_after_id
      from tmpos_invoice_payment.invoice_payment p
     where p.payment_id = p_after_payment_id and p.invoice_id = v_head.o_invoice_id
       and p.tenant_id = v_head.o_tenant_id and p.store_id = v_head.o_store_id;
    if not found then
      return query select 'cursor_unknown'::text, null::uuid, null::uuid, null::uuid, null::text, null::text, null::bigint,
        null::bigint, null::bigint, null::bigint, null::bigint, null::text, null::uuid, null::uuid, null::bigint, null::text, null::text,
        null::text, null::text;
      return;
    end if;
  end if;
  -- The amounts over the invoice's COMPLETE history, never one page, in numeric: the unreversed payments, then (CN-A1-A) the
  -- gross of the credit notes with no withdrawal.
  select coalesce(pg_catalog.sum(p.amount_cents), 0) into v_active
    from tmpos_invoice_payment.invoice_payment p
   where p.invoice_id = v_head.o_invoice_id and p.tenant_id = v_head.o_tenant_id and p.store_id = v_head.o_store_id
     and not exists (select 1 from tmpos_invoice_payment.invoice_payment_reversal r where r.payment_id = p.payment_id);
  select coalesce(pg_catalog.sum(c.gross_cents), 0) into v_credit
    from tmpos_invoice_credit_note.invoice_credit_note c
   where c.invoice_id = v_head.o_invoice_id and c.tenant_id = v_head.o_tenant_id and c.store_id = v_head.o_store_id
     and not exists (select 1 from tmpos_invoice_credit_note.invoice_credit_note_withdrawal w where w.credit_note_id = c.credit_note_id);
  if v_head.o_status = 'voided' then
    -- A2 and D-CN-3 hold by construction (a void needs no active payment or credit note; a payment and a credit note need an
    -- unvoided invoice; all under the header). CN-35: raise rather than hide either.
    if v_active <> 0 then
      raise exception 'migration 038 read: a voided invoice holds an unreversed payment'
        using errcode = 'data_corrupted';
    end if;
    if v_credit <> 0 then
      raise exception 'migration 038 read: a voided invoice holds an active credit note'
        using errcode = 'data_corrupted';
    end if;
    v_due := 0; v_credited := 0; v_applied := 0; v_word := 'voided';
  else
    if v_credit + v_active > v_head.o_total_cents::numeric then
      raise exception 'migration 038 read: the active credit notes and unreversed payments exceed the invoice''s Total'
        using errcode = 'data_corrupted';
    end if;
    v_due := v_head.o_total_cents; v_credited := v_credit; v_applied := v_active;
    -- D-CN-2's precedence: voided, nothing_due, then by remaining and by which of credited and paid is above 0.
    v_word := case when v_due = 0 then 'nothing_due'
                   when v_due - v_credited - v_applied > 0 and v_applied = 0 then 'no_payment_recorded'
                   when v_due - v_credited - v_applied > 0 then 'recorded_partly'
                   when v_credited > 0 and v_applied > 0 then 'settled_by_payment_and_credit'
                   when v_credited > 0 then 'credited_in_full'
                   else 'recorded_in_full' end;
  end if;
  return query
    select 'payments'::text, v_head.o_tenant_id, v_head.o_store_id, v_head.o_invoice_id, v_head.o_status, v_head.o_currency,
           v_head.o_total_cents, v_due::bigint, v_credited::bigint, v_applied::bigint, (v_due - v_credited - v_applied)::bigint, v_word,
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
      v_head.o_currency, v_head.o_total_cents, v_due::bigint, v_credited::bigint, v_applied::bigint,
      (v_due - v_credited - v_applied)::bigint, v_word,
      null::uuid, null::uuid, null::bigint, null::text, null::text, null::text, null::text;
  end if;
end
$$;

comment on function tmpos_invoice_payment.m7b_invoice_payments_get_v2(text, uuid, uuid, uuid, uuid, integer) is
  'Phase 4.0 M7b (migration 038): migration 036''s m7b_invoice_payments_get, argument for argument and word for word (035''s v2 get''s authority, ''denied'', ''not_found'', ''cursor_unknown'', ''payments'' rows, the page), with CN-A1-A: one more column, o_credited_cents, immediately after o_due_cents — the gross of the invoice''s credit notes with no withdrawal; due = the Total (0 if voided), applied = the unreversed payments, remaining = due - credited - applied, all over the COMPLETE history (0, 0, 0, 0 when voided); the status word, by D-CN-2''s precedence, one of voided, nothing_due, no_payment_recorded, recorded_partly, recorded_in_full, credited_in_full, settled_by_payment_and_credit. Raises data_corrupted (CN-35) for a voided invoice with an unreversed payment or an active credit note, and for active credits + unreversed payments above the Total. STABLE (one snapshot); locks nothing.';

-- =============================================================================
-- 20) The rollback-order anchor (R-GATE-1: 037's objects only)
-- =============================================================================
-- A SQL-standard body records a dependency for every reg* constant: 037's record v2, its writer and its proof key table, as
-- 036's anchor names only 035's. 037's rollback drops all three: refused (2BP01) while this exists.
create function tmpos_invoice_credit_note.m7b_invoice_credit_note_prerequisites()
returns boolean
language sql
stable
security invoker
set search_path = pg_catalog, pg_temp
begin atomic
  select 'tmpos_invoice_payment.m7b_invoice_payment_record_v2(text, uuid, uuid, uuid, uuid, uuid, uuid, bigint, text, text, uuid)'::pg_catalog.regprocedure is not null
     and 'tmpos_invoice_payment.m7b_payment_writer(text, uuid)'::pg_catalog.regprocedure is not null
     and 'tmpos_invoice_payment.payment_proof_key'::pg_catalog.regclass is not null;
end;

comment on function tmpos_invoice_credit_note.m7b_invoice_credit_note_prerequisites() is
  'Phase 4.0 M7b (migration 038): the rollback-order anchor. A SQL-standard body naming, as reg* constants, migration 037''s m7b_invoice_payment_record_v2, m7b_payment_writer and payment_proof_key, and no other migration''s object (R-GATE-1), so their recorded dependencies refuse (2BP01) 037''s rollback while migration 038 is applied: roll 038 back first. Never called; answers true. Granted to nobody.';

-- =============================================================================
-- 21) Privileges
-- =============================================================================
-- PostgreSQL grants EXECUTE on a new function to PUBLIC by default: every default is removed before the ten intended grants.
revoke all on function tmpos_invoice_credit_note.m7b_invoice_credit_note_counter_guard() from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
revoke all on function tmpos_invoice_credit_note.m7b_invoice_credit_note_registration_guard() from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
revoke all on function tmpos_invoice_credit_note.m7b_invoice_credit_note_guard() from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
revoke all on function tmpos_invoice_credit_note.m7b_invoice_credit_note_withdrawal_guard() from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
revoke all on function tmpos_invoice_credit_note.m7b_invoice_credit_note_truncate_guard() from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
revoke all on function tmpos_invoice_credit_note.m7b_invoice_credit_note_payment_barrier() from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
revoke all on function tmpos_invoice_credit_note.m7b_invoice_credit_note_void_barrier() from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
revoke all on function tmpos_invoice_credit_note.m7b_invoice_credit_note_registration_proof_message(uuid, uuid, uuid, uuid, uuid, uuid, bytea, bigint, bigint, text) from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
revoke all on function tmpos_invoice_credit_note.m7b_invoice_credit_note_prerequisites() from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
revoke all on function tmpos_invoice_credit_note.m7b_invoice_credit_note_register(text, uuid, uuid, uuid, uuid, uuid, bigint, text, uuid) from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
revoke all on function tmpos_invoice_credit_note.m7b_invoice_credit_note_registration_proof(text, uuid, uuid, uuid, uuid, integer) from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
revoke all on function tmpos_invoice_credit_note.m7b_invoice_credit_note_issue(text, uuid, uuid, uuid, uuid, uuid, uuid, bigint, text, text, uuid) from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
revoke all on function tmpos_invoice_credit_note.m7b_invoice_credit_note_attempts(text, uuid, uuid, uuid, uuid, integer) from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
revoke all on function tmpos_invoice_credit_note.m7b_invoice_credit_note_settle(text, uuid, uuid, uuid, uuid, bigint, uuid) from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
revoke all on function tmpos_invoice_credit_note.m7b_invoice_credit_note_withdraw(text, uuid, uuid, uuid, uuid, bigint, text, uuid) from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
revoke all on function tmpos_invoice_credit_note.m7b_invoice_credit_notes_list(text, uuid, uuid, uuid, uuid, integer) from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
revoke all on function tmpos_invoice_payment.m7b_invoice_payment_record_v3(text, uuid, uuid, uuid, uuid, uuid, uuid, bigint, text, text, uuid) from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
revoke all on function tmpos_invoice_payment.m7b_invoice_void_v3(text, uuid, uuid, uuid, bigint, text) from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
revoke all on function tmpos_invoice_payment.m7b_invoice_payments_get_v2(text, uuid, uuid, uuid, uuid, integer) from public, anon, authenticated, tmpos_app, tmpos_audit_writer;

-- CN-I4: 037's record v2, 036's void v2 and 036's payments read count no credit; they stay in place, unaltered, for the rollback.
revoke execute on function tmpos_invoice_payment.m7b_invoice_payment_record_v2(text, uuid, uuid, uuid, uuid, uuid, uuid, bigint, text, text, uuid) from tmpos_app;
revoke execute on function tmpos_invoice_payment.m7b_invoice_void_v2(text, uuid, uuid, uuid, bigint, text) from tmpos_app;
revoke execute on function tmpos_invoice_payment.m7b_invoice_payments_get(text, uuid, uuid, uuid, uuid, integer) from tmpos_app;

grant execute on function tmpos_invoice_credit_note.m7b_invoice_credit_note_register(text, uuid, uuid, uuid, uuid, uuid, bigint, text, uuid) to tmpos_app;
grant execute on function tmpos_invoice_credit_note.m7b_invoice_credit_note_registration_proof(text, uuid, uuid, uuid, uuid, integer) to tmpos_app;
grant execute on function tmpos_invoice_credit_note.m7b_invoice_credit_note_issue(text, uuid, uuid, uuid, uuid, uuid, uuid, bigint, text, text, uuid) to tmpos_app;
grant execute on function tmpos_invoice_credit_note.m7b_invoice_credit_note_attempts(text, uuid, uuid, uuid, uuid, integer) to tmpos_app;
grant execute on function tmpos_invoice_credit_note.m7b_invoice_credit_note_settle(text, uuid, uuid, uuid, uuid, bigint, uuid) to tmpos_app;
grant execute on function tmpos_invoice_credit_note.m7b_invoice_credit_note_withdraw(text, uuid, uuid, uuid, uuid, bigint, text, uuid) to tmpos_app;
grant execute on function tmpos_invoice_credit_note.m7b_invoice_credit_notes_list(text, uuid, uuid, uuid, uuid, integer) to tmpos_app;
grant execute on function tmpos_invoice_payment.m7b_invoice_payment_record_v3(text, uuid, uuid, uuid, uuid, uuid, uuid, bigint, text, text, uuid) to tmpos_app;
grant execute on function tmpos_invoice_payment.m7b_invoice_void_v3(text, uuid, uuid, uuid, bigint, text) to tmpos_app;
grant execute on function tmpos_invoice_payment.m7b_invoice_payments_get_v2(text, uuid, uuid, uuid, uuid, integer) to tmpos_app;

-- =============================================================================
-- 22) Postcondition
-- =============================================================================
-- (a) every function this file created has its declared language, security, volatility, settings, owner and comment;
-- (b) the complete ACL of the ten routines is exactly the owner's EXECUTE and tmpos_app's; of every other function this file
--     created, and of 037's record v2, 036's void v2 and 036's payments read, exactly the owner's; tmpos_app reaches none of
--     them else; tmpos_audit_writer, anon and authenticated none of them by any path; the schema's ACL is the owner's and
--     tmpos_app's USAGE;
-- (c) no runtime role holds any privilege on the four tables by any path; row security enabled, unforced, without policy;
-- (d) the twelve triggers exactly, ENABLE ALWAYS, and the payment, reversal and void tables' sets 036's plus the barrier;
-- (e) the two audit columns (nullable uuid, no default, the writer's INSERT) and their indexes.
do $$
declare
  v_bad      text;
  v_me       oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user);
  c_definer  constant text[] := array['search_path=pg_catalog, pg_temp', 'row_security=off', 'debug_print_parse=off',
                                      'debug_print_rewritten=off', 'debug_print_plan=off'];
  v_routines oid[] := array[
    'tmpos_invoice_credit_note.m7b_invoice_credit_note_register(text, uuid, uuid, uuid, uuid, uuid, bigint, text, uuid)'::regprocedure,
    'tmpos_invoice_credit_note.m7b_invoice_credit_note_registration_proof(text, uuid, uuid, uuid, uuid, integer)'::regprocedure,
    'tmpos_invoice_credit_note.m7b_invoice_credit_note_issue(text, uuid, uuid, uuid, uuid, uuid, uuid, bigint, text, text, uuid)'::regprocedure,
    'tmpos_invoice_credit_note.m7b_invoice_credit_note_attempts(text, uuid, uuid, uuid, uuid, integer)'::regprocedure,
    'tmpos_invoice_credit_note.m7b_invoice_credit_note_settle(text, uuid, uuid, uuid, uuid, bigint, uuid)'::regprocedure,
    'tmpos_invoice_credit_note.m7b_invoice_credit_note_withdraw(text, uuid, uuid, uuid, uuid, bigint, text, uuid)'::regprocedure,
    'tmpos_invoice_credit_note.m7b_invoice_credit_notes_list(text, uuid, uuid, uuid, uuid, integer)'::regprocedure,
    'tmpos_invoice_payment.m7b_invoice_payment_record_v3(text, uuid, uuid, uuid, uuid, uuid, uuid, bigint, text, text, uuid)'::regprocedure,
    'tmpos_invoice_payment.m7b_invoice_void_v3(text, uuid, uuid, uuid, bigint, text)'::regprocedure,
    'tmpos_invoice_payment.m7b_invoice_payments_get_v2(text, uuid, uuid, uuid, uuid, integer)'::regprocedure]::oid[];
  v_others   oid[] := array[
    'tmpos_invoice_credit_note.m7b_invoice_credit_note_counter_guard()'::regprocedure,
    'tmpos_invoice_credit_note.m7b_invoice_credit_note_registration_guard()'::regprocedure,
    'tmpos_invoice_credit_note.m7b_invoice_credit_note_guard()'::regprocedure,
    'tmpos_invoice_credit_note.m7b_invoice_credit_note_withdrawal_guard()'::regprocedure,
    'tmpos_invoice_credit_note.m7b_invoice_credit_note_truncate_guard()'::regprocedure,
    'tmpos_invoice_credit_note.m7b_invoice_credit_note_payment_barrier()'::regprocedure,
    'tmpos_invoice_credit_note.m7b_invoice_credit_note_void_barrier()'::regprocedure,
    'tmpos_invoice_credit_note.m7b_invoice_credit_note_registration_proof_message(uuid, uuid, uuid, uuid, uuid, uuid, bytea, bigint, bigint, text)'::regprocedure,
    'tmpos_invoice_credit_note.m7b_invoice_credit_note_prerequisites()'::regprocedure]::oid[];
  v_retired  oid[] := array[
    'tmpos_invoice_payment.m7b_invoice_payment_record_v2(text, uuid, uuid, uuid, uuid, uuid, uuid, bigint, text, text, uuid)'::regprocedure,
    'tmpos_invoice_payment.m7b_invoice_void_v2(text, uuid, uuid, uuid, bigint, text)'::regprocedure,
    'tmpos_invoice_payment.m7b_invoice_payments_get(text, uuid, uuid, uuid, uuid, integer)'::regprocedure]::oid[];
  v_tables   oid[] := array['tmpos_invoice_credit_note.invoice_credit_note_counter'::regclass,
                            'tmpos_invoice_credit_note.invoice_credit_note_registration'::regclass,
                            'tmpos_invoice_credit_note.invoice_credit_note'::regclass,
                            'tmpos_invoice_credit_note.invoice_credit_note_withdrawal'::regclass]::oid[];
begin
  -- (a)
  select pg_catalog.string_agg(p.proname::text, ', ' order by p.proname) into v_bad
    from pg_catalog.pg_proc p join pg_catalog.pg_language l on l.oid = p.prolang
   where p.oid = any (v_routines || v_others)
     and not (p.proowner = v_me
              and pg_catalog.obj_description(p.oid, 'pg_proc') is not null
              and case
                    when p.proname in ('m7b_invoice_credit_note_register', 'm7b_invoice_credit_note_registration_proof',
                                       'm7b_invoice_credit_note_issue', 'm7b_invoice_credit_note_settle',
                                       'm7b_invoice_credit_note_withdraw', 'm7b_invoice_payment_record_v3') then
                      l.lanname = 'plpgsql' and p.prosecdef and p.provolatile = 'v' and p.proretset and p.proconfig = c_definer
                    when p.proname in ('m7b_invoice_credit_note_attempts', 'm7b_invoice_credit_notes_list') then
                      l.lanname = 'plpgsql' and p.prosecdef and p.provolatile = 's' and p.proretset and p.proconfig = c_definer
                    when p.proname = 'm7b_invoice_void_v3' then
                      l.lanname = 'plpgsql' and p.prosecdef and p.provolatile = 'v' and p.proretset
                      and p.proconfig = array['search_path=pg_catalog, pg_temp', 'row_security=off']
                    when p.proname = 'm7b_invoice_payments_get_v2' then
                      l.lanname = 'plpgsql' and p.prosecdef and p.provolatile = 's' and p.proretset
                      and p.proconfig = array['search_path=pg_catalog, pg_temp', 'row_security=off']
                    when p.proname in ('m7b_invoice_credit_note_payment_barrier', 'm7b_invoice_credit_note_void_barrier') then
                      l.lanname = 'plpgsql' and p.prosecdef and p.provolatile = 'v' and p.prorettype = 'pg_catalog.trigger'::regtype
                      and p.proconfig = array['search_path=pg_catalog, pg_temp', 'row_security=off']
                    when p.proname in ('m7b_invoice_credit_note_counter_guard', 'm7b_invoice_credit_note_registration_guard',
                                       'm7b_invoice_credit_note_guard', 'm7b_invoice_credit_note_withdrawal_guard') then
                      l.lanname = 'plpgsql' and not p.prosecdef and p.provolatile = 'v' and p.prorettype = 'pg_catalog.trigger'::regtype
                      and p.proconfig = array['search_path=pg_catalog, pg_temp', 'row_security=off']
                    when p.proname = 'm7b_invoice_credit_note_truncate_guard' then
                      l.lanname = 'plpgsql' and not p.prosecdef and p.prorettype = 'pg_catalog.trigger'::regtype
                      and p.proconfig = array['search_path=pg_catalog, pg_temp']
                    when p.proname = 'm7b_invoice_credit_note_registration_proof_message' then
                      l.lanname = 'sql' and not p.prosecdef and p.provolatile = 'i' and p.proisstrict
                      and p.proconfig = array['search_path=pg_catalog, pg_temp']
                    when p.proname = 'm7b_invoice_credit_note_prerequisites' then
                      l.lanname = 'sql' and not p.prosecdef and p.provolatile = 's'
                      and p.proconfig = array['search_path=pg_catalog, pg_temp']
                    else false
                  end);
  if v_bad is not null or (select pg_catalog.count(*) from pg_catalog.pg_proc p where p.oid = any (v_routines || v_others)) <> 19
     or (select pg_catalog.count(*) from pg_catalog.pg_proc p where p.pronamespace = 'tmpos_invoice_credit_note'::regnamespace) <> 16 then
    raise exception 'migration 038 refused: a function of this file is not the one its section declares (%)', coalesce(v_bad, 'count')
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (b)
  select pg_catalog.string_agg(pg_catalog.format('%s %s:%s', p.proname, g.grantee::regrole::text, g.privilege_type), ', ')
    into v_bad
    from pg_catalog.pg_proc p, pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g
   where p.oid = any (v_routines || v_others || v_retired)
     and not (g.privilege_type = 'EXECUTE' and not g.is_grantable and g.grantor = p.proowner
              and (g.grantee = p.proowner or (p.oid = any (v_routines) and g.grantee = 'tmpos_app'::regrole)));
  if v_bad is not null
     or exists (select 1 from pg_catalog.pg_proc p
                 where p.oid = any (v_routines || v_others || v_retired)
                   and (select pg_catalog.count(*) from pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g)
                       <> case when p.oid = any (v_routines) then 2 else 1 end) then
    raise exception 'migration 038 refused: an unexpected grant remains on a function of this file or on a retired routine, or an entry is missing (%)', coalesce(v_bad, 'none listed')
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  select pg_catalog.string_agg(distinct r.rolname::text || ' ' || f.oid::regprocedure::text, ', ') into v_bad
    from pg_catalog.pg_roles r
    join pg_catalog.pg_roles x on pg_catalog.pg_has_role(r.oid, x.oid, 'MEMBER')
    cross join pg_catalog.unnest(v_routines || v_others || v_retired) f(oid)
   where (r.rolname = any (array['tmpos_audit_writer', 'anon', 'authenticated']::name[])
          or (r.rolname = 'tmpos_app' and not (f.oid = any (v_routines))))
     and pg_catalog.has_function_privilege(x.oid, f.oid, 'EXECUTE');
  if v_bad is not null
     or exists (select 1 from pg_catalog.unnest(v_routines) f(oid) where not pg_catalog.has_function_privilege('tmpos_app', f.oid, 'EXECUTE')) then
    raise exception 'migration 038 refused: a runtime role can execute a function this file does not grant it (the retired routines included), or tmpos_app cannot execute a routine (%)', coalesce(v_bad, 'none listed')
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if (select pg_catalog.string_agg(pg_catalog.format('%s/%s/%s', case when g.grantee = n.nspowner then 'owner' else g.grantee::regrole::text end,
                                                     g.privilege_type, g.is_grantable), ';'
                                   order by case when g.grantee = n.nspowner then 'owner' else g.grantee::regrole::text end collate "C", g.privilege_type)
        from pg_catalog.pg_namespace n, pg_catalog.aclexplode(coalesce(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) g
       where n.oid = 'tmpos_invoice_credit_note'::regnamespace)
     is distinct from 'owner/CREATE/f;owner/USAGE/f;tmpos_app/USAGE/f'
     or not exists (select 1 from pg_catalog.pg_namespace n where n.oid = 'tmpos_invoice_credit_note'::regnamespace and n.nspowner = v_me) then
    raise exception 'migration 038 refused: schema tmpos_invoice_credit_note is not the applying principal''s with exactly tmpos_app''s USAGE beside the owner''s'
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
            and pg_catalog.obj_description(c.oid, 'pg_class') is not null) <> 4
     or exists (select 1 from pg_catalog.pg_policy y where y.polrelid = any (v_tables))
     or exists (select 1 from pg_catalog.pg_class c, pg_catalog.aclexplode(coalesce(c.relacl, pg_catalog.acldefault('r', c.relowner))) g
                 where c.oid = any (v_tables) and g.grantee <> c.relowner)
     or exists (select 1 from pg_catalog.pg_attribute t where t.attrelid = any (v_tables) and t.attacl is not null) then
    raise exception 'migration 038 refused: % holds a privilege on a table of this file, or row security is not enabled without policy and unforced, or a table is not the applying principal''s', coalesce(v_bad, 'a role')
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (d) tgtype: ROW 1 + BEFORE 2 + INSERT 4 + DELETE 8 + UPDATE 16 = 31; BEFORE 2 + TRUNCATE 32 = 34; ROW 1 + BEFORE 2 + INSERT 4 = 7.
  if (select pg_catalog.string_agg(pg_catalog.format('%s:%s:%s:%s:%s', g.tgrelid::regclass::text, g.tgname, g.tgfoid::regprocedure::text, g.tgtype, g.tgenabled), ', '
                                  order by g.tgname::text collate "C")
        from pg_catalog.pg_trigger g where g.tgrelid = any (v_tables) and not g.tgisinternal)
     is distinct from
     'tmpos_invoice_credit_note.invoice_credit_note_counter:trg_invoice_credit_note_counter_guard:tmpos_invoice_credit_note.m7b_invoice_credit_note_counter_guard():31:A, tmpos_invoice_credit_note.invoice_credit_note_counter:trg_invoice_credit_note_counter_truncate:tmpos_invoice_credit_note.m7b_invoice_credit_note_truncate_guard():34:A, tmpos_invoice_credit_note.invoice_credit_note:trg_invoice_credit_note_guard:tmpos_invoice_credit_note.m7b_invoice_credit_note_guard():31:A, tmpos_invoice_credit_note.invoice_credit_note_registration:trg_invoice_credit_note_registration_guard:tmpos_invoice_credit_note.m7b_invoice_credit_note_registration_guard():31:A, tmpos_invoice_credit_note.invoice_credit_note_registration:trg_invoice_credit_note_registration_truncate:tmpos_invoice_credit_note.m7b_invoice_credit_note_truncate_guard():34:A, tmpos_invoice_credit_note.invoice_credit_note:trg_invoice_credit_note_truncate:tmpos_invoice_credit_note.m7b_invoice_credit_note_truncate_guard():34:A, tmpos_invoice_credit_note.invoice_credit_note_withdrawal:trg_invoice_credit_note_withdrawal_guard:tmpos_invoice_credit_note.m7b_invoice_credit_note_withdrawal_guard():31:A, tmpos_invoice_credit_note.invoice_credit_note_withdrawal:trg_invoice_credit_note_withdrawal_truncate:tmpos_invoice_credit_note.m7b_invoice_credit_note_truncate_guard():34:A'
     or (select pg_catalog.string_agg(pg_catalog.format('%s:%s:%s:%s:%s', g.tgrelid::regclass::text, g.tgname, g.tgfoid::regprocedure::text, g.tgtype, g.tgenabled), ', '
                                     order by g.tgname::text collate "C")
           from pg_catalog.pg_trigger g
          where g.tgrelid in ('tmpos_invoice_payment.invoice_payment'::regclass, 'tmpos_invoice_payment.invoice_payment_reversal'::regclass,
                              'tmpos_invoice_void.issued_invoice_void'::regclass)
            and not g.tgisinternal)
        is distinct from
        'tmpos_invoice_payment.invoice_payment:trg_invoice_payment_credit_note_barrier:tmpos_invoice_credit_note.m7b_invoice_credit_note_payment_barrier():7:A, tmpos_invoice_payment.invoice_payment:trg_invoice_payment_guard:tmpos_invoice_payment.m7b_invoice_payment_guard():31:A, tmpos_invoice_payment.invoice_payment_reversal:trg_invoice_payment_reversal_guard:tmpos_invoice_payment.m7b_invoice_payment_reversal_guard():31:A, tmpos_invoice_payment.invoice_payment_reversal:trg_invoice_payment_reversal_truncate:tmpos_invoice_payment.m7b_invoice_payment_reversal_truncate_guard():34:A, tmpos_invoice_payment.invoice_payment:trg_invoice_payment_truncate:tmpos_invoice_payment.m7b_invoice_payment_truncate_guard():34:A, tmpos_invoice_void.issued_invoice_void:trg_issued_invoice_void_credit_note_barrier:tmpos_invoice_credit_note.m7b_invoice_credit_note_void_barrier():7:A, tmpos_invoice_void.issued_invoice_void:trg_issued_invoice_void_guard:tmpos_invoice_void.m7b_invoice_void_guard():31:A, tmpos_invoice_void.issued_invoice_void:trg_issued_invoice_void_truncate:tmpos_invoice_void.m7b_invoice_void_truncate_guard():34:A' then
    raise exception 'migration 038 refused: a trigger of this file''s tables, or the payment, reversal or void table''s trigger set, is not exactly the one declared'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (e)
  if (select pg_catalog.count(*) from pg_catalog.pg_attribute a
       where a.attrelid = 'public.audit_event'::regclass and not a.attisdropped
         and a.attname in ('subject_invoice_credit_note_id', 'subject_invoice_credit_note_registration_id')
         and a.atttypid = 'pg_catalog.uuid'::regtype and not a.attnotnull and not a.atthasdef and a.attacl is null) <> 2
     or pg_catalog.to_regclass('public.idx_audit_event_subject_invoice_credit_note_occurred') is null
     or pg_catalog.to_regclass('public.idx_audit_event_subj_invoice_credit_note_registration_occurred') is null
     or not pg_catalog.has_column_privilege('tmpos_audit_writer', 'public.audit_event', 'subject_invoice_credit_note_id', 'INSERT')
     or not pg_catalog.has_column_privilege('tmpos_audit_writer', 'public.audit_event', 'subject_invoice_credit_note_registration_id', 'INSERT') then
    raise exception 'migration 038 refused: an audit subject of this file or its index is not the one section 8 declares'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

end
$$;

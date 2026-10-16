-- Phase 4.0 M7b — issuing a saved store invoice draft: per-store issuing settings with a per-store number counter, the
-- immutable issued invoice and its lines (snapshot contract version 1), the draft's terminal 'issued' state under 033's CHECK
-- and trigger names, two audit subjects, six session-bound routines and the rollback-order anchor that keeps 033 from
-- rolling back under it (M7B-INVOICES-ISSUE-P1; ADR-50; docs/phase-4/12 §10; DA-118, DA-119, DA-186; G-IAM, G-AUDIT)
-- Migration: 034_m7b_invoice_issue (UP)
--
-- SCOPE / TRUTH (binding):
--   - ONE SCHEMA, FOUR TABLES, EIGHTEEN FUNCTIONS, NINE TRIGGERS ON THE NEW TABLES, ONE CHECK REPLACED, ONE TRIGGER REBOUND,
--     TWO AUDIT COLUMNS. Schema tmpos_invoice_issue (owned by the applying principal; USAGE to tmpos_app alone, beside its owner's)
--     holds: the tables store_issuing_settings, store_invoice_counter, issued_invoice and issued_invoice_line (row security
--     on, no policy, NO privilege for any runtime role); the routines m7b_issuing_settings_get, m7b_issuing_settings_set,
--     m7b_invoice_issue_preview, m7b_invoice_issue, m7b_issued_invoice_page and m7b_issued_invoice_get (the only six granted,
--     EXECUTE to tmpos_app); and, granted to nobody, the CHECK helpers m7b_issue_text_ok, m7b_issue_postal_address_ok and
--     m7b_invoice_tax_cents, the read-authority helper m7b_issue_store_reader, the trigger functions and the anchor
--     m7b_invoice_issue_prerequisites. tmpos_invoice_draft.invoice_draft's invoice_draft_status_chk is replaced under its own
--     name by CHECK (status in ('draft', 'discarded', 'issued')); trg_invoice_draft_terminal keeps its name, events, timing,
--     ENABLE ALWAYS state and 033's comment text, bound to m7b_invoice_draft_terminal_v2. public.audit_event gains the
--     nullable subject_issued_invoice_id and subject_store_id (no FK, a partial index each). NO ROLE, MEMBERSHIP, POLICY OR
--     TYPE; no privilege on any table; no row of any existing table written; no index, relation or trigger added on the draft
--     tables (their foreign-key triggers are internal); no existing routine, grant or 033 function altered or removed.
--   - THE STATE MACHINE. 033's rules verbatim plus exactly one transition: 'draft' -> 'issued' at version + 1 with nothing
--     else of the header changed, admitted only while the draft's issued invoice at the reviewed version exists. 'issued' is
--     terminal like 'discarded': 033's line trigger already refuses every line write under a non-open header, 030's edit and
--     033's discard answer 'invalid_state', and 033's reads serve open drafts only.
--   - THE ISSUE, m7b_invoice_issue(key, store, draft, expected tenant, expected version, expected settings version,
--     expected customer version, invoice id): plpgsql, SECURITY DEFINER, VOLATILE, READ COMMITTED only. Its caller
--     derivation is 033's discard's verbatim (016's hold, session and ledger FOR SHARE, issuer key FOR SHARE, the standing
--     digest, exactly one store grant at the store with write statuses, its membership row, the store row FOR SHARE); then:
--       levels unlocked (Invoices >= approve AND Customers >= view; store_owner Full; any other role 'refused') ->
--       'tenant_mismatch' -> the draft header FOR UPDATE by id, tenant and store ('not_found') -> the clock -> for manager,
--       technician and sales_staff 030's key pg_advisory_xact_lock_shared(530030, hashtext(tenant || '/' || role)), the
--       clock, both levels re-read by plain SELECTs ('refused') -> not 'draft': 'invalid_state' -> the settings row FOR SHARE
--       by store ('issuing_not_configured') -> draft version: 'conflict' -> settings version: 'conflict' -> the customer FOR
--       SHARE by tenant and id, its row_version: 'conflict' -> the lines re-checked, tax = div(S * R + 50000, 100000), total
--       above 2^53 - 1: 'amount_out_of_range' -> the counter FOR UPDATE (absent: a fault that raises) -> at 2^53 - 1:
--       'amount_out_of_range' -> clock_timestamp() as issued_at (and the session's liveness on it) -> header, lines,
--       counter + 1, draft 'issued' at version + 1 -> verification reads -> ('applied', tenant, store, actor, membership,
--       version, invoice id, customer id, number). NOTHING IS WRITTEN BEFORE THE LAST REFUSAL (DA-36). The key and the
--       re-reads are top-level statements, never inside an exception block; the writes run in one exception block that maps
--       every constraint violation to fixed text, so no row value reaches a driver message.
--   - THE SETTINGS WRITE, m7b_issuing_settings_set: the owner rule (exactly one tenant grant, store_owner, write statuses,
--     its membership row), 'tenant_mismatch', the store row FOR SHARE in that tenant with a write status ('not_found'), the
--     per-store key pg_advisory_xact_lock(530034, hashtext(store id)) EXCLUSIVE, the settings row FOR UPDATE, then the version
--     ('conflict'; a first write when settings exist included), then version 1 with the counter at 0, or version + 1. Every
--     accepted write is a new version (no no-op). It never locks the counter after creating it.
--   - THE FOUR READS are STABLE (one snapshot), lock nothing, decide their own authority from the session key and answer one
--     'denied' for every refusal: the page and the get a store grant at the store, read statuses, Invoices >= view AND
--     Customers >= view; the preview the issue's authority; the settings get the owner rule and a store of the session's
--     tenant in a read status (no store grant consulted). A malformed argument raises.
--   - THE GUARDS (all ENABLE ALWAYS, so a session running as a replica meets them too; SECURITY INVOKER — the deferred commit
--     check aside, SECURITY DEFINER — pinned, granted to nobody): settings insert at version 1, update by exactly +1 keeping tenant, store and creation time, no delete; the
--     counter inserted at 0 beside its settings, advanced by exactly +1 only to an issued invoice's number, no delete; an
--     issued header inserted only over its source draft still open at the reviewed version (same customer, currency, line
--     count, subtotal), the settings and the customer at their recorded versions with the recorded values, and the number
--     the counter's next; an issued line only under such a header, at a position within its line count, equal to the
--     draft's line there; no update or delete of either; a BEFORE TRUNCATE statement trigger on each of the four tables; and
--     a deferred constraint trigger on issued_invoice that requires at COMMIT every line (count and sum), the draft
--     'issued' at the reviewed version + 1 and the counter at the number. The issued header's tax CHECK tests every NULL
--     explicitly and re-derives the tax with m7b_invoice_tax_cents, so no path stores a tax that differs from the formula.
--     Foreign keys are ON DELETE RESTRICT ON UPDATE RESTRICT, so no tenant, store, customer or draft deletion can cascade
--     through an issued row. NOT COVERED (033's boundary): the table owner disabling or dropping a trigger, a replaced
--     function, DDL and a superuser.
--   - LOCK ORDER. Issue: fence -> 016's hold -> session and ledger -> issuer key -> membership and store rows -> draft header
--     FOR UPDATE -> key 530030 SHARED -> settings FOR SHARE -> customer FOR SHARE -> counter FOR UPDATE -> COMMIT; it waits
--     on nothing after the counter. Settings write: owner prefix -> store row FOR SHARE -> key 530034 EXCLUSIVE -> settings
--     FOR UPDATE. Edit and discard: the same prefix and the header before key 530030; level writers: role row -> key
--     EXCLUSIVE; the customer edit: Customers role row FOR SHARE -> customer FOR UPDATE, no key. No writer takes both the
--     settings and the customer, the re-reads under the key take no row lock: no cycle.
--   - APPLY: 033's maintenance window — ACCESS EXCLUSIVE until COMMIT on 033's seven tables in the writers' order before
--     anything is read; then the exact 033 catalog this file changes is required (the CHECK text, the terminal trigger's
--     binding, shape, mode and comment, 033's six functions).
--   - DEPLOY AND ROLLBACK: FAIL CLOSED BOTH WAYS. The startup preflight pins the ledger (001-034) and the grants, so the
--     001-033 runtime refuses a 034 database and the 034 runtime a 033 one. ROLL 034 BACK FIRST: while it is applied 033's
--     down refuses at its own prerequisites (55000: the terminal trigger is not bound to 033's function, the CHECK is not
--     033's) and, past them, at this file's anchor (2BP01). 034's down refuses, changing nothing, while any settings,
--     counter, issued invoice, issued line, issued draft or audit record naming an issued invoice or a store exists.
--   - WHAT THIS DOES NOT DEFEND (doc 12 §10.10; none claimed closed): DA-118 (a runtime-role holder with a live store key can
--     call the issue directly — consuming the store's next number under an invoice id of its choosing — without the
--     route's audit record, idempotency completion or HTTP checks); DA-119 (a live store-owner key can call the settings
--     write directly with no audit, reason, recent sign-in or idempotency; direct level sets change who can issue); forged
--     audit rows through tmpos_audit_writer (G-AUDIT; one naming a store makes this down refuse: fails safe); the table
--     owner's paths above; retention, privacy, void, G-BACKUP and DA-60/G-PERF for the new per-store serialization point.
--   - NO SECRET, NO DYNAMIC SQL, NO EXTENSION, NO TEMPORARY OBJECT, NO BACKFILL. Every name is schema-qualified; every routine
--     and trigger function pins its search_path.
--
-- Reversible via 034_m7b_invoice_issue.down.sql, which refuses while any issuing data exists and otherwise restores the
-- 033 catalog exactly. Roll 034 back before 033.
--
-- Assumes 001-033 are applied. A future managed apply targets the complete contiguous chain through the newest committed
-- migration — now 001-034; this file authorizes no apply.

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
  lock table public.audit_event in access exclusive mode;
exception
  when undefined_table or invalid_schema_name then
    raise exception 'migration 034 refused: public.store, tmpos_role.tenant_role_level, tmpos_role_edit.role_level_version, tmpos_customer.customer, tmpos_invoice_draft.invoice_draft, tmpos_invoice_draft.invoice_draft_line or public.audit_event is missing (migrations 002, 017, 020, 021 and 028 must be applied first)'
      using errcode = 'object_not_in_prerequisite_state';
end
$$;

-- =============================================================================
-- 3) Preconditions: the database is exactly at 033 for every object this file changes
-- =============================================================================
do $$
begin
  if pg_catalog.to_regnamespace('tmpos_invoice_issue') is not null
     or exists (select 1 from pg_catalog.pg_attribute a
                 where a.attrelid = 'public.audit_event'::regclass
                   and a.attname in ('subject_issued_invoice_id', 'subject_store_id') and not a.attisdropped)
     or pg_catalog.to_regclass('public.idx_audit_event_subject_issued_invoice_occurred') is not null
     or pg_catalog.to_regclass('public.idx_audit_event_subject_store_occurred') is not null then
    raise exception 'migration 034 refused: schema tmpos_invoice_issue or an audit subject column or index of this file already exists'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if (select pg_catalog.count(*) from pg_catalog.pg_roles r
       where r.rolname = any (array['tmpos_app', 'tmpos_audit_writer', 'anon', 'authenticated']::name[])) <> 4 then
    raise exception 'migration 034 refused: the runtime roles tmpos_app, tmpos_audit_writer, anon and authenticated must exist (migration 005 and the platform''s two client roles)'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- 033, exactly: its six functions, its CHECK, its two triggers in their exact shape, mode and comment, and the drafts'
  -- non-internal trigger sets. tgtype: ROW 1 + BEFORE 2 + INSERT 4 + DELETE 8 + UPDATE 16 = 31.
  if pg_catalog.to_regprocedure('tmpos_invoice_discard.m7b_invoice_draft_discard(text, uuid, uuid, uuid, bigint)') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_discard.m7b_invoice_draft_page_v2(text, uuid, uuid, uuid, integer)') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_discard.m7b_invoice_draft_get_v2(text, uuid, uuid, uuid)') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_discard.m7b_invoice_draft_terminal()') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_discard.m7b_invoice_draft_line_terminal()') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_discard.m7b_invoice_discard_prerequisites()') is null
     or (select pg_catalog.count(*) from pg_catalog.pg_constraint k
          where k.conrelid = 'tmpos_invoice_draft.invoice_draft'::regclass and k.conname = 'invoice_draft_status_chk' and k.contype = 'c'
            and k.convalidated
            and pg_catalog.pg_get_constraintdef(k.oid) = 'CHECK ((status = ANY (ARRAY[''draft''::text, ''discarded''::text])))') <> 1
     or (select pg_catalog.string_agg(g.tgname::text, ', ' order by g.tgname::text collate "C")
           from pg_catalog.pg_trigger g
          where g.tgrelid = 'tmpos_invoice_draft.invoice_draft'::regclass and not g.tgisinternal)
        is distinct from 'trg_invoice_draft_immutable, trg_invoice_draft_terminal'
     or (select pg_catalog.string_agg(g.tgname::text, ', ' order by g.tgname::text collate "C")
           from pg_catalog.pg_trigger g
          where g.tgrelid = 'tmpos_invoice_draft.invoice_draft_line'::regclass and not g.tgisinternal)
        is distinct from 'trg_invoice_draft_line_terminal'
     or not exists (select 1 from pg_catalog.pg_trigger g
                     where g.tgrelid = 'tmpos_invoice_draft.invoice_draft'::regclass
                       and g.tgname = 'trg_invoice_draft_terminal'
                       and g.tgfoid = pg_catalog.to_regprocedure('tmpos_invoice_discard.m7b_invoice_draft_terminal()')
                       and g.tgtype = 31 and g.tgenabled = 'A' and g.tgattr = ''::pg_catalog.int2vector and g.tgqual is null
                       and pg_catalog.obj_description(g.oid, 'pg_trigger') = 'Phase 4.0 M7b (migration 033): the terminal discarded state of an invoice draft header (tmpos_invoice_discard.m7b_invoice_draft_terminal). Enabled ALWAYS.')
     or not exists (select 1 from pg_catalog.pg_trigger g
                     where g.tgrelid = 'tmpos_invoice_draft.invoice_draft_line'::regclass
                       and g.tgname = 'trg_invoice_draft_line_terminal'
                       and g.tgfoid = pg_catalog.to_regprocedure('tmpos_invoice_discard.m7b_invoice_draft_line_terminal()')
                       and g.tgtype = 31 and g.tgenabled = 'A' and g.tgattr = ''::pg_catalog.int2vector and g.tgqual is null) then
    raise exception 'migration 034 refused: migration 033 is not applied exactly (its functions, its widened status CHECK, or its terminal triggers in their exact shape, mode and comment)'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- The keys the foreign keys reference (028), the customer version (024), and the objects the routines read or lock.
  if (select pg_catalog.count(*) from pg_catalog.pg_constraint k
       where k.contype = 'u' and k.convalidated
         and ((k.conrelid = 'tmpos_invoice_draft.invoice_draft'::regclass and k.conname = 'invoice_draft_scope_key'
               and pg_catalog.pg_get_constraintdef(k.oid) = 'UNIQUE (draft_id, tenant_id, store_id)')
              or (k.conrelid = 'public.store'::regclass and k.conname = 'store_tenant_store_key'
                  and pg_catalog.pg_get_constraintdef(k.oid) = 'UNIQUE (tenant_id, store_id)')
              or (k.conrelid = 'tmpos_customer.customer'::regclass and k.conname = 'customer_tenant_customer_key'
                  and pg_catalog.pg_get_constraintdef(k.oid) = 'UNIQUE (tenant_id, customer_id)'))) <> 3
     or not exists (select 1 from pg_catalog.pg_attribute a
                     where a.attrelid = 'tmpos_customer.customer'::regclass and a.attname = 'row_version' and not a.attisdropped
                       and a.atttypid = 'pg_catalog.int8'::regtype and a.attnotnull)
     or pg_catalog.to_regprocedure('tmpos_session.m5_hold_tenant_standing(text, text)') is null
     or pg_catalog.to_regprocedure('tmpos_session.m5_admit_tenant_session_v2(text, text)') is null
     or pg_catalog.to_regclass('tmpos_session.session') is null
     or pg_catalog.to_regclass('tmpos_mint.tenant_session') is null
     or pg_catalog.to_regclass('tmpos_mint.issuer_key') is null
     or pg_catalog.to_regclass('public.tenant') is null
     or pg_catalog.to_regclass('public.user_membership') is null then
    raise exception 'migration 034 refused: 028''s unique keys, 024''s customer row_version, 016''s hold or admission read, 018''s mint ledger or issuer key, or 002''s tenant or membership table is missing'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if not (pg_catalog.has_function_privilege(current_user, 'tmpos_session.m5_hold_tenant_standing(text, text)', 'EXECUTE')
          and pg_catalog.has_function_privilege(current_user, 'tmpos_session.m5_admit_tenant_session_v2(text, text)', 'EXECUTE')
          and pg_catalog.has_schema_privilege(current_user, 'public', 'USAGE')
          and pg_catalog.has_schema_privilege(current_user, 'tmpos_session', 'USAGE')
          and pg_catalog.has_schema_privilege(current_user, 'tmpos_mint', 'USAGE')
          and pg_catalog.has_schema_privilege(current_user, 'tmpos_role', 'USAGE')
          and pg_catalog.has_schema_privilege(current_user, 'tmpos_customer', 'USAGE')
          and pg_catalog.has_schema_privilege(current_user, 'tmpos_invoice_draft', 'USAGE')) then
    raise exception 'migration 034 refused: the applying principal cannot execute 016''s hold and admission read, which the routines call, or use the schemas they read'
      using errcode = 'insufficient_privilege';
  end if;
  -- 033's argument: a definer routine reads and writes only what its owner may, and replacing the CHECK, rebinding the
  -- trigger and adding the audit columns need ownership of those tables.
  if exists (
    select 1
      from pg_catalog.pg_class c
     where c.oid = any (array['tmpos_session.session'::regclass, 'tmpos_mint.tenant_session'::regclass,
                              'tmpos_mint.issuer_key'::regclass, 'tmpos_role.tenant_role_level'::regclass,
                              'public.store'::regclass, 'public.tenant'::regclass, 'public.user_membership'::regclass,
                              'tmpos_customer.customer'::regclass, 'public.audit_event'::regclass,
                              'tmpos_invoice_draft.invoice_draft'::regclass, 'tmpos_invoice_draft.invoice_draft_line'::regclass])
       and (not pg_catalog.pg_has_role(current_user, c.relowner, 'USAGE') or c.relforcerowsecurity)) then
    raise exception 'migration 034 refused: the applying principal neither owns nor inherits the owner of a table the routines read or write, or one has forced row security'
      using errcode = 'insufficient_privilege';
  end if;
end
$$;

do $$
begin
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'migration 034 refused: it must run under READ COMMITTED, so that its checks see every committed row'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$$;

-- =============================================================================
-- 4) The schema
-- =============================================================================
create schema tmpos_invoice_issue;

comment on schema tmpos_invoice_issue is
  'Phase 4.0 M7b (migration 034): issuing a saved invoice draft — per-store issuing settings and number counter, the immutable issued invoice and its lines, their guards, the six session-bound routines and the rollback-order anchor. Owned by this migration; tmpos_app holds USAGE and EXECUTE on the six routines only.';

revoke all on schema tmpos_invoice_issue from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
grant usage on schema tmpos_invoice_issue to tmpos_app;

-- =============================================================================
-- 5) The CHECK helpers (IMMUTABLE, SQL-standard bodies, granted to nobody)
-- =============================================================================
-- 009's and 017's text rule set (char_length bounds; no C0, DEL, C1, U+2028, U+2029; each Bidi_Control character listed —
-- a range in a bracket expression is collation-sensitive; no edge white space). NULL is never admitted. The visible-character
-- rule is the runtime's alone (028's boundary).
create function tmpos_invoice_issue.m7b_issue_text_ok(p_value text, p_max integer)
returns boolean
language sql
immutable
parallel safe
security invoker
set search_path = pg_catalog, pg_temp
return p_value is not null and p_max is not null
   and pg_catalog.char_length(p_value) between 1 and p_max
   and p_value !~ '[\u0001-\u001f\u007f-\u009f\u2028\u2029]'
   and p_value !~ '[\u061c\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069]'
   and p_value !~ '^[\u0009-\u000d \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]|[\u0009-\u000d \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]$';

comment on function tmpos_invoice_issue.m7b_issue_text_ok(text, integer) is
  'Phase 4.0 M7b (migration 034): true exactly when the value is non-NULL, 1 to p_max characters, holds no C0 or C1 control, DEL, U+2028, U+2029 or Bidi_Control character and has no leading or trailing white space (009''s and 017''s rule set). Used by the CHECKs and the settings write. Granted to nobody.';

-- The postal address: 1 to 8 lines joined by single LFs (LF the only control admitted, and only between lines: no leading,
-- trailing or doubled LF, at most 7), each line passing the shared rule at 1 to 120 characters; 967 characters at most.
create function tmpos_invoice_issue.m7b_issue_postal_address_ok(p_value text)
returns boolean
language sql
immutable
parallel safe
security invoker
set search_path = pg_catalog, pg_temp
return p_value is not null
   and pg_catalog.char_length(p_value) between 1 and 967
   and pg_catalog.char_length(p_value) - pg_catalog.char_length(pg_catalog.replace(p_value, E'\n', '')) <= 7
   and coalesce((select pg_catalog.bool_and(tmpos_invoice_issue.m7b_issue_text_ok(l.line, 120))
                   from pg_catalog.unnest(pg_catalog.string_to_array(p_value, E'\n')) as l(line)), false);

comment on function tmpos_invoice_issue.m7b_issue_postal_address_ok(text) is
  'Phase 4.0 M7b (migration 034): true exactly when the value is non-NULL, at most 967 characters, holds at most 7 LFs and every LF-separated line (string_to_array) passes m7b_issue_text_ok at 1 to 120 characters — so no leading, trailing or doubled LF, no CR and no other control. Granted to nobody.';

-- The tax, exact: floor((S x R + 50,000) / 100,000) in numeric, R in thousandths of a percent (doc 12 §10.8).
create function tmpos_invoice_issue.m7b_invoice_tax_cents(p_subtotal bigint, p_rate integer)
returns numeric
language sql
immutable
strict
parallel safe
security invoker
set search_path = pg_catalog, pg_temp
return pg_catalog.div(p_subtotal::numeric * p_rate + 50000, 100000);

comment on function tmpos_invoice_issue.m7b_invoice_tax_cents(bigint, integer) is
  'Phase 4.0 M7b (migration 034): the tax of a subtotal at a rate in thousandths of a percent, div(S x R + 50000, 100000) in exact numeric (half-cent ties round up). Used by the issued header''s CHECK and the issue. Granted to nobody.';

-- =============================================================================
-- 6) The tables
-- =============================================================================
create table tmpos_invoice_issue.store_issuing_settings (
  tenant_id           uuid        not null,
  store_id            uuid        not null,
  version             bigint      not null,
  legal_name          text        collate "C" not null,
  store_name          text        collate "C" not null,
  postal_address      text        collate "C" not null,
  tax_registration_id text        collate "C",
  tax_mode            text        collate "C" not null,
  tax_rate            integer,
  created_at          timestamptz not null default pg_catalog.now(),
  updated_at          timestamptz not null default pg_catalog.now(),
  constraint store_issuing_settings_pkey primary key (store_id),
  constraint store_issuing_settings_store_fkey foreign key (tenant_id, store_id) references public.store (tenant_id, store_id)
    on delete restrict on update restrict,
  constraint store_issuing_settings_version_chk check (version between 1 and 9007199254740991),
  constraint store_issuing_settings_legal_name_chk check (tmpos_invoice_issue.m7b_issue_text_ok(legal_name, 200)),
  constraint store_issuing_settings_store_name_chk check (tmpos_invoice_issue.m7b_issue_text_ok(store_name, 120)),
  constraint store_issuing_settings_postal_address_chk check (tmpos_invoice_issue.m7b_issue_postal_address_ok(postal_address)),
  constraint store_issuing_settings_tax_registration_chk check (
    tax_registration_id is null or tmpos_invoice_issue.m7b_issue_text_ok(tax_registration_id, 64)),
  constraint store_issuing_settings_tax_chk check (
    (tax_mode = 'exclusive_rate' and tax_rate is not null and tax_rate between 0 and 100000)
    or (tax_mode = 'none' and tax_rate is null))
);

comment on table tmpos_invoice_issue.store_issuing_settings is
  'Phase 4.0 M7b (migration 034): one store''s issuing settings (legal seller name, invoice-facing store name, postal address, optional tax registration id, tax mode and rate), versioned from 1 by exactly one per accepted write; never deleted. Written only by m7b_issuing_settings_set. No runtime role holds a privilege on it.';

create table tmpos_invoice_issue.store_invoice_counter (
  tenant_id   uuid   not null,
  store_id    uuid   not null,
  last_number bigint not null,
  constraint store_invoice_counter_pkey primary key (store_id),
  constraint store_invoice_counter_settings_fkey foreign key (store_id)
    references tmpos_invoice_issue.store_issuing_settings (store_id) on delete restrict on update restrict,
  constraint store_invoice_counter_store_fkey foreign key (tenant_id, store_id) references public.store (tenant_id, store_id)
    on delete restrict on update restrict,
  constraint store_invoice_counter_last_number_chk check (last_number between 0 and 9007199254740991)
);

comment on table tmpos_invoice_issue.store_invoice_counter is
  'Phase 4.0 M7b (migration 034): one store''s invoice number counter, created at 0 with the store''s first settings and advanced by exactly one by each issue, in the issuing transaction (a row, not a sequence: a rolled-back issue consumes no number); never deleted. No runtime role holds a privilege on it.';

create table tmpos_invoice_issue.issued_invoice (
  invoice_id           uuid        not null,
  tenant_id            uuid        not null,
  store_id             uuid        not null,
  number               bigint      not null,
  snapshot_version     smallint    not null,
  source_draft_id      uuid        not null,
  source_draft_version bigint      not null,
  settings_version     bigint      not null,
  customer_id          uuid        not null,
  customer_version     bigint      not null,
  customer_name        text        collate "C" not null,
  legal_name           text        collate "C" not null,
  store_name           text        collate "C" not null,
  postal_address       text        collate "C" not null,
  tax_registration_id  text        collate "C",
  currency             text        collate "C" not null,
  line_count           integer     not null,
  subtotal_cents       bigint      not null,
  tax_mode             text        collate "C" not null,
  tax_rate             integer,
  tax_cents            bigint,
  total_cents          bigint      not null,
  issued_at            timestamptz not null,
  issued_by            uuid        not null,
  constraint issued_invoice_pkey primary key (invoice_id),
  -- What a line's composite foreign key references: its header in exactly its scope.
  constraint issued_invoice_scope_key unique (invoice_id, tenant_id, store_id),
  -- One invoice per draft, forever, independent of idempotency.
  constraint issued_invoice_source_draft_key unique (source_draft_id),
  -- One number per store; its btree also serves the page (newest number first, a backward scan).
  constraint issued_invoice_number_key unique (tenant_id, store_id, number),
  constraint issued_invoice_draft_fkey foreign key (source_draft_id, tenant_id, store_id)
    references tmpos_invoice_draft.invoice_draft (draft_id, tenant_id, store_id) on delete restrict on update restrict,
  constraint issued_invoice_store_fkey foreign key (tenant_id, store_id) references public.store (tenant_id, store_id)
    on delete restrict on update restrict,
  constraint issued_invoice_customer_fkey foreign key (tenant_id, customer_id)
    references tmpos_customer.customer (tenant_id, customer_id) on delete restrict on update restrict,
  constraint issued_invoice_number_chk check (number between 1 and 9007199254740991),
  constraint issued_invoice_snapshot_version_chk check (snapshot_version = 1),
  constraint issued_invoice_source_draft_version_chk check (source_draft_version between 1 and 9007199254740990),
  constraint issued_invoice_settings_version_chk check (settings_version between 1 and 9007199254740991),
  constraint issued_invoice_customer_version_chk check (customer_version between 1 and 9007199254740991),
  constraint issued_invoice_customer_name_chk check (tmpos_invoice_issue.m7b_issue_text_ok(customer_name, 200)),
  constraint issued_invoice_legal_name_chk check (tmpos_invoice_issue.m7b_issue_text_ok(legal_name, 200)),
  constraint issued_invoice_store_name_chk check (tmpos_invoice_issue.m7b_issue_text_ok(store_name, 120)),
  constraint issued_invoice_postal_address_chk check (tmpos_invoice_issue.m7b_issue_postal_address_ok(postal_address)),
  constraint issued_invoice_tax_registration_chk check (
    tax_registration_id is null or tmpos_invoice_issue.m7b_issue_text_ok(tax_registration_id, 64)),
  constraint issued_invoice_currency_chk check (currency = 'USD'),
  constraint issued_invoice_line_count_chk check (line_count between 1 and 50),
  constraint issued_invoice_subtotal_chk check (subtotal_cents between 0 and 9007199254740991),
  constraint issued_invoice_total_chk check (total_cents between 0 and 9007199254740991),
  -- Every branch tests its NULLs explicitly (a CHECK that evaluates to NULL passes); the tax is re-derived by the formula.
  constraint issued_invoice_tax_chk check (
    (tax_mode = 'exclusive_rate'
     and tax_rate is not null and tax_rate between 0 and 100000
     and tax_cents is not null and tax_cents between 0 and 9007199254740991
     and tax_cents::numeric = tmpos_invoice_issue.m7b_invoice_tax_cents(subtotal_cents, tax_rate)
     and total_cents::numeric = subtotal_cents::numeric + tax_cents::numeric)
    or (tax_mode = 'none' and tax_rate is null and tax_cents is null and total_cents = subtotal_cents))
);

comment on table tmpos_invoice_issue.issued_invoice is
  'Phase 4.0 M7b (migration 034): one issued invoice, snapshot contract version 1 — what the store invoiced at issue time, its Total the subtotal plus the tax (or the subtotal under none), never an amount due, a balance or a payment status; USD integer cents. Insert only (no update, delete or truncate). Written only by m7b_invoice_issue. No runtime role holds a privilege on it.';
comment on column tmpos_invoice_issue.issued_invoice.issued_by is
  'Phase 4.0 M7b (migration 034): the issuing actor''s internal_user_id. Plain uuid, no FK. No read returns it.';
comment on column tmpos_invoice_issue.issued_invoice.issued_at is
  'Phase 4.0 M7b (migration 034): the database clock (clock_timestamp()) after the counter''s lock; UTC is authoritative.';

create table tmpos_invoice_issue.issued_invoice_line (
  invoice_id       uuid    not null,
  tenant_id        uuid    not null,
  store_id         uuid    not null,
  position         integer not null,
  description      text    collate "C" not null,
  quantity         bigint  not null,
  unit_price_cents bigint  not null,
  line_total_cents bigint  not null,
  constraint issued_invoice_line_pkey primary key (invoice_id, position),
  constraint issued_invoice_line_invoice_fkey foreign key (invoice_id, tenant_id, store_id)
    references tmpos_invoice_issue.issued_invoice (invoice_id, tenant_id, store_id) on delete restrict on update restrict,
  constraint issued_invoice_line_position_chk check (position between 1 and 50),
  constraint issued_invoice_line_description_chk check (tmpos_invoice_issue.m7b_issue_text_ok(description, 256)),
  constraint issued_invoice_line_quantity_chk check (quantity between 1 and 9007199254740991),
  constraint issued_invoice_line_unit_price_chk check (unit_price_cents between 0 and 9007199254740991),
  constraint issued_invoice_line_total_chk check (
    line_total_cents between 0 and 9007199254740991
    and line_total_cents::numeric = quantity::numeric * unit_price_cents::numeric)
);

comment on table tmpos_invoice_issue.issued_invoice_line is
  'Phase 4.0 M7b (migration 034): one line of an issued invoice, a copy of its source draft''s line at the same position, in exactly its header''s tenant and store. Insert only. No runtime role holds a privilege on it.';

-- A customer's issued invoices (the foreign key's referencing side, as 028's invoice_draft_customer_idx).
create index issued_invoice_customer_idx on tmpos_invoice_issue.issued_invoice (tenant_id, customer_id);

alter table tmpos_invoice_issue.store_issuing_settings enable row level security;
alter table tmpos_invoice_issue.store_invoice_counter enable row level security;
alter table tmpos_invoice_issue.issued_invoice enable row level security;
alter table tmpos_invoice_issue.issued_invoice_line enable row level security;
revoke all on table tmpos_invoice_issue.store_issuing_settings from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
revoke all on table tmpos_invoice_issue.store_invoice_counter from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
revoke all on table tmpos_invoice_issue.issued_invoice from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
revoke all on table tmpos_invoice_issue.issued_invoice_line from public, anon, authenticated, tmpos_app, tmpos_audit_writer;

-- =============================================================================
-- 7) The guards on the four tables
-- =============================================================================
-- SECURITY INVOKER and granted to nobody (a trigger function fires without an EXECUTE grant); BEFORE ROW, so a refused write
-- changes nothing; a firing this file does not declare raises; each refusal is restrict_violation with fixed text, never a
-- value of the row. row_security off where a relation is read: a writer whose row security would hide a row fails.
create function tmpos_invoice_issue.m7b_issuing_settings_guard()
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
     or tg_table_schema is distinct from 'tmpos_invoice_issue' or tg_table_name is distinct from 'store_issuing_settings' then
    raise exception 'm7b_issuing_settings_guard: fired by an undeclared trigger'
      using errcode = 'triggered_action_exception';
  end if;
  if tg_op = 'INSERT' then
    -- The store in that tenant, checked here too: a session running as a replica skips the foreign key's own trigger.
    if new.version is distinct from 1::bigint
       or not exists (select 1 from public.store st where st.store_id = new.store_id and st.tenant_id = new.tenant_id) then
      raise exception 'migration 034: a store''s issuing settings are created at version 1, for a store of their tenant'
        using errcode = 'restrict_violation';
    end if;
    return new;
  elsif tg_op = 'DELETE' then
    raise exception 'migration 034: a store''s issuing settings are never deleted'
      using errcode = 'restrict_violation';
  end if;
  if new.tenant_id is distinct from old.tenant_id
     or new.store_id is distinct from old.store_id
     or new.created_at is distinct from old.created_at
     or new.version is distinct from old.version + 1 then
    raise exception 'migration 034: a store''s issuing settings move by exactly one version, in the same tenant and store'
      using errcode = 'restrict_violation';
  end if;
  return new;
end
$$;

comment on function tmpos_invoice_issue.m7b_issuing_settings_guard() is
  'Phase 4.0 M7b (migration 034): BEFORE INSERT OR UPDATE OR DELETE row trigger on tmpos_invoice_issue.store_issuing_settings (enabled ALWAYS). Raises restrict_violation (fixed message) for an insert not at version 1 or not for a store of its tenant (read with row_security off, so a replica session that skips the foreign key meets it too), an update that does not step the version by exactly one or changes the tenant, store or creation time, and every delete; triggered_action_exception for any other firing. Granted to nobody.';

create function tmpos_invoice_issue.m7b_invoice_counter_guard()
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
     or tg_table_schema is distinct from 'tmpos_invoice_issue' or tg_table_name is distinct from 'store_invoice_counter' then
    raise exception 'm7b_invoice_counter_guard: fired by an undeclared trigger'
      using errcode = 'triggered_action_exception';
  end if;
  if tg_op = 'INSERT' then
    if new.last_number is distinct from 0::bigint
       or not exists (select 1 from tmpos_invoice_issue.store_issuing_settings s
                       where s.store_id = new.store_id and s.tenant_id = new.tenant_id) then
      raise exception 'migration 034: a store''s invoice counter is created at 0, beside its issuing settings'
        using errcode = 'restrict_violation';
    end if;
    return new;
  elsif tg_op = 'DELETE' then
    raise exception 'migration 034: a store''s invoice counter is never deleted'
      using errcode = 'restrict_violation';
  end if;
  if new.tenant_id is distinct from old.tenant_id
     or new.store_id is distinct from old.store_id
     or new.last_number is distinct from old.last_number + 1
     or not exists (select 1 from tmpos_invoice_issue.issued_invoice i
                     where i.tenant_id = new.tenant_id and i.store_id = new.store_id and i.number = new.last_number) then
    raise exception 'migration 034: a store''s invoice counter moves by exactly one, to the number of an issued invoice of that store'
      using errcode = 'restrict_violation';
  end if;
  return new;
end
$$;

comment on function tmpos_invoice_issue.m7b_invoice_counter_guard() is
  'Phase 4.0 M7b (migration 034): BEFORE INSERT OR UPDATE OR DELETE row trigger on tmpos_invoice_issue.store_invoice_counter (enabled ALWAYS). Raises restrict_violation (fixed message) for an insert not at 0 or without the store''s settings in its tenant, an update that does not step by exactly one to the number of an issued invoice of that store or changes the tenant or store, and every delete; triggered_action_exception for any other firing. Granted to nobody.';

-- The issued header: inserted only over its sources as the issue locked them, in the issue's own lock order (the draft, the
-- settings, the customer FOR SHARE; the counter FOR UPDATE). Inside the issue every row is already the writer's: no wait.
create function tmpos_invoice_issue.m7b_issued_invoice_guard()
returns trigger
language plpgsql
volatile
security invoker
set search_path = pg_catalog, pg_temp
set row_security = off
as $$
declare
  v_draft    record;
  v_settings record;
  v_customer record;
  v_counter  record;
begin
  if tg_when is distinct from 'BEFORE' or tg_level is distinct from 'ROW'
     or tg_op not in ('INSERT', 'UPDATE', 'DELETE')
     or tg_table_schema is distinct from 'tmpos_invoice_issue' or tg_table_name is distinct from 'issued_invoice' then
    raise exception 'm7b_issued_invoice_guard: fired by an undeclared trigger'
      using errcode = 'triggered_action_exception';
  end if;
  if tg_op <> 'INSERT' then
    raise exception 'migration 034: an issued invoice is never updated or deleted'
      using errcode = 'restrict_violation';
  end if;
  select d.status, d.version, d.customer_id, d.currency, d.line_count, d.subtotal_cents into v_draft
    from tmpos_invoice_draft.invoice_draft d
   where d.draft_id = new.source_draft_id and d.tenant_id = new.tenant_id and d.store_id = new.store_id
     for share;
  if not found
     or v_draft.status is distinct from 'draft'
     or v_draft.version is distinct from new.source_draft_version
     or v_draft.customer_id is distinct from new.customer_id
     or v_draft.currency is distinct from new.currency
     or v_draft.line_count is distinct from new.line_count
     or v_draft.subtotal_cents is distinct from new.subtotal_cents then
    raise exception 'migration 034: an issued invoice is made only from its source draft, open at the reviewed version'
      using errcode = 'restrict_violation';
  end if;
  select s.tenant_id, s.version, s.legal_name, s.store_name, s.postal_address, s.tax_registration_id, s.tax_mode, s.tax_rate
    into v_settings
    from tmpos_invoice_issue.store_issuing_settings s
   where s.store_id = new.store_id
     for share;
  if not found
     or v_settings.tenant_id is distinct from new.tenant_id
     or v_settings.version is distinct from new.settings_version
     or v_settings.legal_name is distinct from new.legal_name
     or v_settings.store_name is distinct from new.store_name
     or v_settings.postal_address is distinct from new.postal_address
     or v_settings.tax_registration_id is distinct from new.tax_registration_id
     or v_settings.tax_mode is distinct from new.tax_mode
     or v_settings.tax_rate is distinct from new.tax_rate then
    raise exception 'migration 034: an issued invoice records its store''s issuing settings at the reviewed version'
      using errcode = 'restrict_violation';
  end if;
  select c.row_version, c.name into v_customer
    from tmpos_customer.customer c
   where c.tenant_id = new.tenant_id and c.customer_id = new.customer_id
     for share;
  if not found
     or v_customer.row_version is distinct from new.customer_version
     or v_customer.name is distinct from new.customer_name then
    raise exception 'migration 034: an issued invoice records its customer at the reviewed version'
      using errcode = 'restrict_violation';
  end if;
  select k.tenant_id, k.last_number into v_counter
    from tmpos_invoice_issue.store_invoice_counter k
   where k.store_id = new.store_id
     for update;
  if not found
     or v_counter.tenant_id is distinct from new.tenant_id
     or v_counter.last_number + 1 is distinct from new.number then
    raise exception 'migration 034: an issued invoice takes its store''s next number'
      using errcode = 'restrict_violation';
  end if;
  return new;
end
$$;

comment on function tmpos_invoice_issue.m7b_issued_invoice_guard() is
  'Phase 4.0 M7b (migration 034): BEFORE INSERT OR UPDATE OR DELETE row trigger on tmpos_invoice_issue.issued_invoice (enabled ALWAYS). Refuses (restrict_violation, fixed message) every update and delete, and an insert unless its source draft (FOR SHARE) is open at source_draft_version with the same customer, currency, line count and subtotal, the store''s settings (FOR SHARE) are at settings_version with every recorded seller and tax value, the customer (FOR SHARE) is at customer_version with the recorded name, and the number is the store counter''s (FOR UPDATE) next. triggered_action_exception for any other firing. Granted to nobody.';

create function tmpos_invoice_issue.m7b_issued_invoice_line_guard()
returns trigger
language plpgsql
volatile
security invoker
set search_path = pg_catalog, pg_temp
set row_security = off
as $$
declare
  v_header record;
  v_status text;
  v_line   record;
begin
  if tg_when is distinct from 'BEFORE' or tg_level is distinct from 'ROW'
     or tg_op not in ('INSERT', 'UPDATE', 'DELETE')
     or tg_table_schema is distinct from 'tmpos_invoice_issue' or tg_table_name is distinct from 'issued_invoice_line' then
    raise exception 'm7b_issued_invoice_line_guard: fired by an undeclared trigger'
      using errcode = 'triggered_action_exception';
  end if;
  if tg_op <> 'INSERT' then
    raise exception 'migration 034: a line of an issued invoice is never updated or deleted'
      using errcode = 'restrict_violation';
  end if;
  select i.source_draft_id, i.line_count into v_header
    from tmpos_invoice_issue.issued_invoice i
   where i.invoice_id = new.invoice_id and i.tenant_id = new.tenant_id and i.store_id = new.store_id
     for share;
  if not found or new.position is null or new.position < 1 or new.position > v_header.line_count then
    raise exception 'migration 034: a line of an issued invoice lies within its header''s line count'
      using errcode = 'restrict_violation';
  end if;
  select d.status into v_status
    from tmpos_invoice_draft.invoice_draft d
   where d.draft_id = v_header.source_draft_id and d.tenant_id = new.tenant_id and d.store_id = new.store_id
     for share;
  select l.description, l.quantity, l.unit_price_cents, l.line_total_cents into v_line
    from tmpos_invoice_draft.invoice_draft_line l
   where l.draft_id = v_header.source_draft_id and l.tenant_id = new.tenant_id and l.store_id = new.store_id
     and l.position = new.position;
  if v_status is distinct from 'draft'
     or not found
     or v_line.description is distinct from new.description
     or v_line.quantity is distinct from new.quantity
     or v_line.unit_price_cents is distinct from new.unit_price_cents
     or v_line.line_total_cents is distinct from new.line_total_cents then
    raise exception 'migration 034: a line of an issued invoice is its open source draft''s line at the same position'
      using errcode = 'restrict_violation';
  end if;
  return new;
end
$$;

comment on function tmpos_invoice_issue.m7b_issued_invoice_line_guard() is
  'Phase 4.0 M7b (migration 034): BEFORE INSERT OR UPDATE OR DELETE row trigger on tmpos_invoice_issue.issued_invoice_line (enabled ALWAYS). Refuses (restrict_violation, fixed message) every update and delete, and an insert unless its header exists in its tenant and store, the position is within the header''s line count, the source draft is still open and its line at that position has the same description, quantity, unit price and line total (each read FOR SHARE). triggered_action_exception for any other firing. Granted to nobody.';

create function tmpos_invoice_issue.m7b_issue_truncate_guard()
returns trigger
language plpgsql
volatile
security invoker
set search_path = pg_catalog, pg_temp
as $$
begin
  if tg_when is distinct from 'BEFORE' or tg_level is distinct from 'STATEMENT' or tg_op is distinct from 'TRUNCATE'
     or tg_table_schema is distinct from 'tmpos_invoice_issue'
     or tg_table_name not in ('store_issuing_settings', 'store_invoice_counter', 'issued_invoice', 'issued_invoice_line') then
    raise exception 'm7b_issue_truncate_guard: fired by an undeclared trigger'
      using errcode = 'triggered_action_exception';
  end if;
  raise exception 'migration 034: issuing settings, counters and issued invoices are never truncated'
    using errcode = 'restrict_violation';
end
$$;

comment on function tmpos_invoice_issue.m7b_issue_truncate_guard() is
  'Phase 4.0 M7b (migration 034): BEFORE TRUNCATE statement trigger on each of the four tables of tmpos_invoice_issue (enabled ALWAYS); always raises restrict_violation (fixed message). triggered_action_exception for any other firing. Granted to nobody.';

-- At COMMIT (deferred): the issue is complete — every line, the draft issued at the next version, the counter at the number
-- (at least the number: the counter guard ties every step to an issued number). SECURITY DEFINER (021's version trigger's form): a
-- deferred trigger fires at COMMIT as the transaction's current user — the runtime login, which holds no privilege on these
-- tables — not inside the definer routine. A trigger function cannot be called except as a trigger; granted to nobody.
create function tmpos_invoice_issue.m7b_issued_invoice_commit_check()
returns trigger
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set row_security = off
as $$
declare
  v_lines   record;
  v_draft   record;
  v_counter bigint;
begin
  if tg_when is distinct from 'AFTER' or tg_level is distinct from 'ROW' or tg_op is distinct from 'INSERT'
     or tg_table_schema is distinct from 'tmpos_invoice_issue' or tg_table_name is distinct from 'issued_invoice' then
    raise exception 'm7b_issued_invoice_commit_check: fired by an undeclared trigger'
      using errcode = 'triggered_action_exception';
  end if;
  select pg_catalog.count(*)::integer as n, pg_catalog.min(l.position) as lo, pg_catalog.max(l.position) as hi,
         coalesce(pg_catalog.sum(l.line_total_cents::numeric), -1) as total
    into v_lines
    from tmpos_invoice_issue.issued_invoice_line l
   where l.invoice_id = new.invoice_id and l.tenant_id = new.tenant_id and l.store_id = new.store_id;
  select d.status, d.version into v_draft
    from tmpos_invoice_draft.invoice_draft d
   where d.draft_id = new.source_draft_id and d.tenant_id = new.tenant_id and d.store_id = new.store_id;
  select k.last_number into v_counter
    from tmpos_invoice_issue.store_invoice_counter k
   where k.store_id = new.store_id and k.tenant_id = new.tenant_id;
  if v_lines.n is distinct from new.line_count or v_lines.lo is distinct from 1 or v_lines.hi is distinct from new.line_count
     or v_lines.total is distinct from new.subtotal_cents::numeric
     or v_draft.status is distinct from 'issued' or v_draft.version is distinct from new.source_draft_version + 1
     or v_counter is null or v_counter < new.number then
    raise exception 'migration 034: an issued invoice commits only with all of its lines, its draft issued at the next version and its store''s counter at or past its number'
      using errcode = 'restrict_violation';
  end if;
  return null;
end
$$;

comment on function tmpos_invoice_issue.m7b_issued_invoice_commit_check() is
  'Phase 4.0 M7b (migration 034): AFTER INSERT row constraint trigger on tmpos_invoice_issue.issued_invoice, DEFERRABLE INITIALLY DEFERRED (enabled ALWAYS); SECURITY DEFINER, because it fires at COMMIT as the transaction''s current user. At COMMIT raises restrict_violation (fixed message) unless the invoice has exactly line_count lines at positions 1..line_count summing to its subtotal, its source draft is issued at source_draft_version + 1, and its store''s counter is at its number. triggered_action_exception for any other firing. Granted to nobody.';

create trigger trg_store_issuing_settings_guard
  before insert or update or delete on tmpos_invoice_issue.store_issuing_settings
  for each row execute function tmpos_invoice_issue.m7b_issuing_settings_guard();
alter table tmpos_invoice_issue.store_issuing_settings enable always trigger trg_store_issuing_settings_guard;
create trigger trg_store_issuing_settings_truncate
  before truncate on tmpos_invoice_issue.store_issuing_settings
  for each statement execute function tmpos_invoice_issue.m7b_issue_truncate_guard();
alter table tmpos_invoice_issue.store_issuing_settings enable always trigger trg_store_issuing_settings_truncate;

create trigger trg_store_invoice_counter_guard
  before insert or update or delete on tmpos_invoice_issue.store_invoice_counter
  for each row execute function tmpos_invoice_issue.m7b_invoice_counter_guard();
alter table tmpos_invoice_issue.store_invoice_counter enable always trigger trg_store_invoice_counter_guard;
create trigger trg_store_invoice_counter_truncate
  before truncate on tmpos_invoice_issue.store_invoice_counter
  for each statement execute function tmpos_invoice_issue.m7b_issue_truncate_guard();
alter table tmpos_invoice_issue.store_invoice_counter enable always trigger trg_store_invoice_counter_truncate;

create trigger trg_issued_invoice_guard
  before insert or update or delete on tmpos_invoice_issue.issued_invoice
  for each row execute function tmpos_invoice_issue.m7b_issued_invoice_guard();
alter table tmpos_invoice_issue.issued_invoice enable always trigger trg_issued_invoice_guard;
create trigger trg_issued_invoice_truncate
  before truncate on tmpos_invoice_issue.issued_invoice
  for each statement execute function tmpos_invoice_issue.m7b_issue_truncate_guard();
alter table tmpos_invoice_issue.issued_invoice enable always trigger trg_issued_invoice_truncate;
create constraint trigger trg_issued_invoice_commit_check
  after insert on tmpos_invoice_issue.issued_invoice
  deferrable initially deferred
  for each row execute function tmpos_invoice_issue.m7b_issued_invoice_commit_check();
alter table tmpos_invoice_issue.issued_invoice enable always trigger trg_issued_invoice_commit_check;

create trigger trg_issued_invoice_line_guard
  before insert or update or delete on tmpos_invoice_issue.issued_invoice_line
  for each row execute function tmpos_invoice_issue.m7b_issued_invoice_line_guard();
alter table tmpos_invoice_issue.issued_invoice_line enable always trigger trg_issued_invoice_line_guard;
create trigger trg_issued_invoice_line_truncate
  before truncate on tmpos_invoice_issue.issued_invoice_line
  for each statement execute function tmpos_invoice_issue.m7b_issue_truncate_guard();
alter table tmpos_invoice_issue.issued_invoice_line enable always trigger trg_issued_invoice_line_truncate;

-- =============================================================================
-- 8) The draft's 'issued' state: 033's CHECK widened and its terminal trigger rebound, under the same names
-- =============================================================================
-- One statement, validated over every existing row (033 left them 'draft' or 'discarded'); no row is rewritten.
alter table tmpos_invoice_draft.invoice_draft
  drop constraint invoice_draft_status_chk,
  add constraint invoice_draft_status_chk check (status in ('draft', 'discarded', 'issued'));

-- 033's m7b_invoice_draft_terminal() rules and messages verbatim (the tests pin the texts), plus exactly one branch:
-- draft -> issued at the next version with nothing else changed, only while the draft's issued invoice at the reviewed
-- version exists. 033's function is not edited; 033's line trigger already refuses every line write under a non-open header.
create function tmpos_invoice_issue.m7b_invoice_draft_terminal_v2()
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
     or tg_table_schema is distinct from 'tmpos_invoice_draft' or tg_table_name is distinct from 'invoice_draft' then
    raise exception 'm7b_invoice_draft_terminal_v2: fired by an undeclared trigger'
      using errcode = 'triggered_action_exception';
  end if;
  if tg_op = 'INSERT' then
    -- A draft is saved open; no path creates one already discarded.
    if new.status is distinct from 'draft' then
      raise exception 'migration 033: an invoice draft is saved open (status draft) only'
        using errcode = 'restrict_violation';
    end if;
    return new;
  elsif tg_op = 'DELETE' then
    -- A discarded or issued draft is kept; an open draft stays deletable by the table owner, as before.
    if old.status = 'issued' then
      raise exception 'migration 034: an issued invoice draft is never deleted'
        using errcode = 'restrict_violation';
    elsif old.status is distinct from 'draft' then
      raise exception 'migration 033: a discarded invoice draft is never deleted'
        using errcode = 'restrict_violation';
    end if;
    return old;
  end if;
  -- An UPDATE.
  if old.status = 'issued' then
    -- Terminal: no update of any kind, a no-op and a return to 'draft' included.
    raise exception 'migration 034: an issued invoice draft is terminal and admits no update'
      using errcode = 'restrict_violation';
  elsif old.status is distinct from 'draft' then
    raise exception 'migration 033: a discarded invoice draft is terminal and admits no update'
      using errcode = 'restrict_violation';
  end if;
  if new.status = 'draft' then
    -- An open draft stays open: an edit (029's trigger governs it).
    return new;
  end if;
  if new.status = 'discarded'
     and new.version = old.version + 1
     and new.customer_id is not distinct from old.customer_id
     and new.currency is not distinct from old.currency
     and new.line_count is not distinct from old.line_count
     and new.subtotal_cents is not distinct from old.subtotal_cents then
    return new;
  end if;
  -- 034: issued, only over the draft's issued invoice at the reviewed version.
  if new.status = 'issued'
     and new.version = old.version + 1
     and new.customer_id is not distinct from old.customer_id
     and new.currency is not distinct from old.currency
     and new.line_count is not distinct from old.line_count
     and new.subtotal_cents is not distinct from old.subtotal_cents
     and exists (select 1 from tmpos_invoice_issue.issued_invoice i
                  where i.source_draft_id = old.draft_id and i.tenant_id = old.tenant_id and i.store_id = old.store_id
                    and i.source_draft_version = old.version) then
    return new;
  end if;
  if new.status = 'issued' then
    raise exception 'migration 034: an open invoice draft moves to issued only at the next version, with nothing else changed, over its issued invoice'
      using errcode = 'restrict_violation';
  end if;
  raise exception 'migration 033: an open invoice draft moves only to discarded, at the next version, with nothing else changed'
    using errcode = 'restrict_violation';
end
$$;

comment on function tmpos_invoice_issue.m7b_invoice_draft_terminal_v2() is
  'Phase 4.0 M7b (migration 034): migration 033''s m7b_invoice_draft_terminal with exactly one transition added — BEFORE INSERT OR UPDATE OR DELETE row trigger on tmpos_invoice_draft.invoice_draft (trg_invoice_draft_terminal, enabled ALWAYS). 033''s rules and fixed messages verbatim for open and discarded drafts (an insert is open; a non-open header admits no update or delete; open -> discarded at version + 1 with nothing else changed), plus open -> issued at version + 1 with nothing else changed while an issued invoice of that draft, tenant and store at source_draft_version = the old version exists (read with row_security off); an issued draft and a refused move to issued raise 034''s own fixed messages. Granted to nobody.';

drop trigger trg_invoice_draft_terminal on tmpos_invoice_draft.invoice_draft;

create trigger trg_invoice_draft_terminal
  before insert or update or delete on tmpos_invoice_draft.invoice_draft
  for each row execute function tmpos_invoice_issue.m7b_invoice_draft_terminal_v2();

-- ALWAYS, as 033 left it: a write by a session running as a replica meets it too.
alter table tmpos_invoice_draft.invoice_draft enable always trigger trg_invoice_draft_terminal;

-- 033's comment text, exactly (034's down restores the 033 binding under the same text).
comment on trigger trg_invoice_draft_terminal on tmpos_invoice_draft.invoice_draft is
  'Phase 4.0 M7b (migration 033): the terminal discarded state of an invoice draft header (tmpos_invoice_discard.m7b_invoice_draft_terminal). Enabled ALWAYS.';

-- =============================================================================
-- 9) The audit record's issued-invoice and store subjects (028's subject_invoice_draft_id, for these)
-- =============================================================================
-- Nullable columns with no default rewrite no row and fire no row trigger. The audit writer's table-wide INSERT (005)
-- covers them; nothing else is granted.
alter table public.audit_event
  add column subject_issued_invoice_id uuid,
  add column subject_store_id uuid;

comment on column public.audit_event.subject_issued_invoice_id is
  'Phase 4.0 M7b (migration 034): the issued invoice the recorded action created (a store-scope issue, beside the draft and customer subjects). Written by the command transaction from the routine''s verified answer; never from request metadata. Plain column, no FK (audit is decoupled/append-only). Never accompanied by a seller, customer or line value.';
comment on column public.audit_event.subject_store_id is
  'Phase 4.0 M7b (migration 034): the store whose issuing settings the recorded action wrote (a tenant-scope settings write). Written by the command transaction from the server-validated target; never from request metadata. Plain column, no FK. Never accompanied by seller text.';

create index idx_audit_event_subject_issued_invoice_occurred on public.audit_event (subject_issued_invoice_id, occurred_at desc)
  where subject_issued_invoice_id is not null;
create index idx_audit_event_subject_store_occurred on public.audit_event (subject_store_id, occurred_at desc)
  where subject_store_id is not null;

-- =============================================================================
-- 10) The store-scope read authority (the preview's, the page's and the get's), one helper granted to nobody
-- =============================================================================
-- 033's page derivation (steps 1-5) with both levels: a minted, live tenant session under the installed issuer key, its
-- standing unchanged, EXACTLY ONE store grant at p_store_id on p_expected_tenant (a precondition only), still the actor's
-- active membership, its store in its tenant and its tenant in an admitted status, and Invoices >= p_invoices AND
-- Customers >= view. p_write admits only active and trialing (the issue's statuses); otherwise read statuses. One row when
-- admitted, NO ROW otherwise. STABLE: on the calling statement's snapshot; locks nothing.
create function tmpos_invoice_issue.m7b_issue_store_reader(
  p_session_key text, p_expected_tenant uuid, p_store_id uuid, p_write boolean, p_invoices text)
returns table (o_tenant_id uuid, o_actor_id uuid, o_membership_id uuid, o_role text)
language plpgsql
stable
security invoker
set search_path = pg_catalog, pg_temp
set row_security = off
as $$
declare
  c_levels    constant text[] := array['none', 'view', 'create', 'edit', 'manage', 'approve', 'full'];
  v_statuses  text[];
  v_now       bigint := pg_catalog.floor(extract(epoch from pg_catalog.statement_timestamp()) * 1000)::bigint;
  v_session   record;
  v_issuer    bytea;
  v_admission record;
  v_grants    jsonb;
  v_role      text;
  v_tenant    uuid;
  v_membership uuid;
  v_invoices  text;
  v_customers text;
begin
  if p_session_key is null or p_expected_tenant is null or p_store_id is null or p_write is null
     or p_invoices is null or p_invoices not in ('view', 'approve') then
    return;
  end if;
  v_statuses := case when p_write then array['active', 'trialing']
                     else array['active', 'trialing', 'overdue', 'read_only'] end;
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
    return;
  end if;
  select pg_catalog.sha256(k.key) into v_issuer from tmpos_mint.issuer_key k where k.singleton;
  if v_issuer is null or v_issuer is distinct from v_session.issuer_digest then
    return;
  end if;
  select r.outcome, r.actor_id, r.account_status, r.memberships,
         pg_catalog.sha256(pg_catalog.convert_to(r::text, 'UTF8')) as digest
    into strict v_admission
    from tmpos_session.m5_admit_tenant_session_v2(v_session.auth_provider, v_session.auth_provider_uid) r;
  if v_admission.outcome is distinct from 'resolved'
     or v_admission.digest is distinct from v_session.standing_digest
     or v_admission.actor_id is null
     or v_admission.account_status is null
     or not (v_admission.account_status = any (v_statuses))
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
     or not (coalesce(v_grants -> 0 ->> 'tenantStatus', '') = any (v_statuses))
     or not (coalesce(v_grants -> 0 ->> 'storeStatus', '') = any (v_statuses)) then
    return;
  end if;
  v_role := v_grants -> 0 ->> 'roleId';
  v_tenant := (v_grants -> 0 ->> 'tenantId')::uuid;
  v_membership := (v_grants -> 0 ->> 'membershipId')::uuid;
  if v_tenant is distinct from p_expected_tenant
     or not exists (
       select 1
         from public.user_membership um
         join public.store st on st.store_id = um.store_id and st.tenant_id = um.tenant_id
         join public.tenant t on t.tenant_id = um.tenant_id
        where um.membership_id = v_membership
          and um.internal_user_id = v_admission.actor_id
          and um.status = 'active'
          and um.scope_type = 'store'
          and um.tenant_id = v_tenant
          and um.store_id = p_store_id
          and um.role_id = v_role
          and st.status = any (v_statuses)
          and t.status = any (v_statuses)) then
    return;
  end if;
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
       < pg_catalog.array_position(c_levels, p_invoices)
       or coalesce(pg_catalog.array_position(c_levels,
         coalesce(v_customers, case v_role when 'manager' then 'full' when 'technician' then 'view' when 'sales_staff' then 'create' end)), 0)
       < pg_catalog.array_position(c_levels, 'view') then
      return;
    end if;
  else
    return;
  end if;
  return query select v_tenant, v_admission.actor_id, v_membership, v_role;
end
$$;

comment on function tmpos_invoice_issue.m7b_issue_store_reader(text, uuid, uuid, boolean, text) is
  'Phase 4.0 M7b (migration 034): the store-scope read authority of the preview, page and get — 033''s page derivation with both levels: one row (tenant, actor, membership, role) for a key naming a minted, live tenant session under the installed issuer key with an unchanged standing, whose account, grant tenant and store, membership store and tenant statuses are active or trialing (p_write) or also overdue or read_only, who holds EXACTLY ONE store-scope grant at p_store_id on p_expected_tenant, still its active membership, and whose role''s Invoices level is at least p_invoices (view or approve) and Customers level at least view (store_owner Full; an editable role its stored level, else its catalog default; any other role none). No row otherwise. STABLE; locks nothing. Granted to nobody.';

-- =============================================================================
-- 11) The settings read and write
-- =============================================================================
create function tmpos_invoice_issue.m7b_issuing_settings_get(p_session_key text, p_expected_tenant uuid, p_store_id uuid)
returns table (
  o_outcome             text,
  o_tenant_id           uuid,
  o_store_id            uuid,
  o_version             bigint,
  o_legal_name          text,
  o_store_name          text,
  o_postal_address      text,
  o_tax_registration_id text,
  o_tax_mode            text,
  o_tax_rate            integer
)
language plpgsql
-- STABLE IS LOAD-BEARING (017's reason): every statement runs on the calling statement's snapshot. It locks nothing.
stable
security definer
set search_path = pg_catalog, pg_temp
set row_security = off
as $$
declare
  v_now        bigint := pg_catalog.floor(extract(epoch from pg_catalog.statement_timestamp()) * 1000)::bigint;
  v_admitted   boolean := false;
  v_session    record;
  v_issuer     bytea;
  v_admission  record;
  v_grants     jsonb;
  v_tenant     uuid;
  v_membership uuid;
  v_settings   record;
begin
  if p_session_key is null or p_session_key !~ '^[\x21-\x7e]{1,128}$'
     or p_expected_tenant is null or p_store_id is null then
    raise exception 'migration 034 settings read: an argument is malformed'
      using errcode = 'invalid_parameter_value';
  end if;

  -- The owner rule (026's derivation, read-only): a minted, live tenant session under the installed key, its standing
  -- unchanged, an active or trialing account, exactly one tenant grant on an active or trialing tenant whose role is
  -- store_owner, still its active membership, on p_expected_tenant (a precondition only). Any failure: 'denied'.
  <<authority>>
  begin
    select s.audience, s.auth_provider, s.auth_provider_uid, s.expires_at, m.standing_digest, m.issuer_digest,
           m.expires_at as minted_expires_at
      into v_session
      from tmpos_session.session s
      join tmpos_mint.tenant_session m on m.session_key = s.session_key
     where s.session_key = p_session_key;
    exit authority when not found
      or v_session.audience is distinct from 'tenant'
      or v_session.expires_at is distinct from v_session.minted_expires_at
      or v_now >= v_session.expires_at;
    select pg_catalog.sha256(k.key) into v_issuer from tmpos_mint.issuer_key k where k.singleton;
    exit authority when v_issuer is null or v_issuer is distinct from v_session.issuer_digest;
    select r.outcome, r.actor_id, r.account_status, r.memberships,
           pg_catalog.sha256(pg_catalog.convert_to(r::text, 'UTF8')) as digest
      into strict v_admission
      from tmpos_session.m5_admit_tenant_session_v2(v_session.auth_provider, v_session.auth_provider_uid) r;
    exit authority when v_admission.outcome is distinct from 'resolved'
      or v_admission.digest is distinct from v_session.standing_digest
      or v_admission.actor_id is null
      or v_admission.account_status is null
      or v_admission.account_status not in ('active', 'trialing')
      or pg_catalog.jsonb_typeof(v_admission.memberships) is distinct from 'array';
    select pg_catalog.jsonb_agg(e.entry) into v_grants
      from pg_catalog.jsonb_array_elements(v_admission.memberships) as e(entry)
     where e.entry ->> 'scopeType' = 'tenant';
    exit authority when v_grants is null
      or pg_catalog.jsonb_array_length(v_grants) <> 1
      or (v_grants -> 0 ->> 'tenantId') is null
      or (v_grants -> 0 ->> 'membershipId') is null
      or (v_grants -> 0 ->> 'tenantStatus') is null
      or (v_grants -> 0 ->> 'tenantStatus') not in ('active', 'trialing')
      or (v_grants -> 0 ->> 'roleId') is distinct from 'store_owner';
    v_tenant := (v_grants -> 0 ->> 'tenantId')::uuid;
    v_membership := (v_grants -> 0 ->> 'membershipId')::uuid;
    exit authority when v_tenant is distinct from p_expected_tenant
      or not exists (
        select 1
          from public.user_membership um
          join public.tenant t on t.tenant_id = um.tenant_id
         where um.membership_id = v_membership
           and um.internal_user_id = v_admission.actor_id
           and um.status = 'active'
           and um.scope_type = 'tenant'
           and um.tenant_id = v_tenant
           and um.role_id = 'store_owner'
           and t.status in ('active', 'trialing'));
    v_admitted := true;
  end;
  if not v_admitted then
    return query select 'denied'::text, null::uuid, null::uuid, null::bigint, null::text, null::text, null::text, null::text,
      null::text, null::integer;
    return;
  end if;

  -- A store of the session's tenant in a read status: a missing store, another tenant's and one not readable are one answer.
  if not exists (select 1 from public.store st
                  where st.store_id = p_store_id and st.tenant_id = v_tenant
                    and st.status in ('active', 'trialing', 'overdue', 'read_only')) then
    return query select 'not_found'::text, null::uuid, null::uuid, null::bigint, null::text, null::text, null::text, null::text,
      null::text, null::integer;
    return;
  end if;

  select s.version, s.legal_name, s.store_name, s.postal_address, s.tax_registration_id, s.tax_mode, s.tax_rate
    into v_settings
    from tmpos_invoice_issue.store_issuing_settings s
   where s.store_id = p_store_id and s.tenant_id = v_tenant;
  if not found then
    return query select 'none'::text, v_tenant, p_store_id, 0::bigint, null::text, null::text, null::text, null::text,
      null::text, null::integer;
    return;
  end if;
  return query select 'settings'::text, v_tenant, p_store_id, v_settings.version, v_settings.legal_name::text,
    v_settings.store_name::text, v_settings.postal_address::text, v_settings.tax_registration_id::text,
    v_settings.tax_mode::text, v_settings.tax_rate;
end
$$;

comment on function tmpos_invoice_issue.m7b_issuing_settings_get(text, uuid, uuid) is
  'Phase 4.0 M7b (migration 034): one store''s issuing settings for the owner rule — a key naming a minted, live tenant session under the installed issuer key with an unchanged standing, an active or trialing account, exactly one tenant-scope grant whose role is store_owner on an active or trialing tenant, still its active membership, on p_expected_tenant (a precondition only); no store grant is consulted. (''denied'', NULLs) for every refusal; (''not_found'', NULLs) alike for a missing store, another tenant''s and one not active, trialing, overdue or read_only; (''none'', tenant, store, 0, NULLs) when the store has no settings; else (''settings'', tenant, store, version, legal name, store name, postal address, tax registration id, tax mode, tax rate). Raises invalid_parameter_value (fixed message) for a malformed argument. STABLE; locks nothing.';

create function tmpos_invoice_issue.m7b_issuing_settings_set(
  p_session_key text, p_store_id uuid, p_expected_tenant uuid, p_expected_version bigint,
  p_legal_name text, p_store_name text, p_postal_address text, p_tax_registration_id text, p_tax_mode text,
  p_tax_rate integer)
returns table (
  o_outcome       text,
  o_tenant_id     uuid,
  o_store_id      uuid,
  o_actor_id      uuid,
  o_membership_id uuid,
  o_version       bigint
)
language plpgsql
-- VOLATILE IS LOAD-BEARING (019's reason): it locks and then re-reads, and each statement must see what committed before its
-- own locks. Do not make it STABLE.
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
  v_tenant         uuid;
  v_membership     uuid;
  v_store          record;
  v_current        bigint;
  v_written        bigint;
  v_counter        integer := 0;
  v_check          record;
begin
  -- 0. Every argument, before anything is read, locked or written; each refusal a fixed message naming the field, never
  --    the value.
  if p_session_key is null or p_session_key !~ '^[\x21-\x7e]{1,128}$'
     or p_store_id is null
     or p_expected_tenant is null then
    raise exception 'migration 034 settings: an argument is malformed'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_expected_version is null or p_expected_version < 0 or p_expected_version > 9007199254740990 then
    raise exception 'migration 034 settings: the expected version is not one the settings can advance'
      using errcode = 'invalid_parameter_value';
  end if;
  if not tmpos_invoice_issue.m7b_issue_text_ok(p_legal_name, 200) then
    raise exception 'migration 034 settings: the legal name is malformed'
      using errcode = 'invalid_parameter_value';
  end if;
  if not tmpos_invoice_issue.m7b_issue_text_ok(p_store_name, 120) then
    raise exception 'migration 034 settings: the store name is malformed'
      using errcode = 'invalid_parameter_value';
  end if;
  if not tmpos_invoice_issue.m7b_issue_postal_address_ok(p_postal_address) then
    raise exception 'migration 034 settings: the postal address is malformed'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_tax_registration_id is not null and not tmpos_invoice_issue.m7b_issue_text_ok(p_tax_registration_id, 64) then
    raise exception 'migration 034 settings: the tax registration id is malformed'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_tax_mode is null
     or not ((p_tax_mode = 'exclusive_rate' and p_tax_rate is not null and p_tax_rate between 0 and 100000)
             or (p_tax_mode = 'none' and p_tax_rate is null)) then
    raise exception 'migration 034 settings: the tax setting is malformed'
      using errcode = 'invalid_parameter_value';
  end if;
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'migration 034 settings: it must run under READ COMMITTED, so that its checks see what committed before its locks'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- 1. The owner, derived as 026's set derives it: the unlocked pre-check, 016's hold, the session and ledger rows FOR SHARE,
  --    the issuer key FOR SHARE, the clock after those waits, the standing digest, a write account status.
  select s.auth_provider, s.auth_provider_uid, s.expires_at, m.expires_at, m.issuer_digest
    into v_provider, v_uid, v_expires, v_minted_expires, v_minted_issuer
    from tmpos_session.session s
    join tmpos_mint.tenant_session m on m.session_key = s.session_key
   where s.session_key = p_session_key
     and s.audience = 'tenant';
  if not found then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint;
    return;
  end if;
  v_now := pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp()) * 1000)::bigint;
  if v_expires is distinct from v_minted_expires or v_now >= v_expires then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint;
    return;
  end if;
  select pg_catalog.sha256(k.key) into v_issuer from tmpos_mint.issuer_key k where k.singleton;
  if v_issuer is null or v_issuer is distinct from v_minted_issuer then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint;
    return;
  end if;

  if tmpos_session.m5_hold_tenant_standing(v_provider, v_uid) is distinct from 'held' then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint;
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
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint;
    return;
  end if;

  select pg_catalog.sha256(k.key) into v_issuer from tmpos_mint.issuer_key k where k.singleton for share;
  if v_issuer is null or v_issuer is distinct from v_session.issuer_digest then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint;
    return;
  end if;

  v_now := pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp()) * 1000)::bigint;
  if v_now >= v_session.expires_at then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint;
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
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint;
    return;
  end if;

  -- 2. The owner rule (026's step 7): exactly one tenant-scope grant, on a tenant with a write status, whose role is
  --    store_owner; a store or platform grant never counts. 2a: still that actor's active membership row.
  select pg_catalog.jsonb_agg(e.entry) into v_grants
    from pg_catalog.jsonb_array_elements(v_admission.memberships) as e(entry)
   where e.entry ->> 'scopeType' = 'tenant';
  if v_grants is null
     or pg_catalog.jsonb_array_length(v_grants) <> 1
     or (v_grants -> 0 ->> 'tenantId') is null
     or (v_grants -> 0 ->> 'membershipId') is null
     or (v_grants -> 0 ->> 'tenantStatus') is null
     or (v_grants -> 0 ->> 'tenantStatus') not in ('active', 'trialing')
     or (v_grants -> 0 ->> 'roleId') is distinct from 'store_owner' then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint;
    return;
  end if;
  v_tenant := (v_grants -> 0 ->> 'tenantId')::uuid;
  v_membership := (v_grants -> 0 ->> 'membershipId')::uuid;
  if not exists (
    select 1
      from public.user_membership um
     where um.membership_id = v_membership
       and um.internal_user_id = v_admission.actor_id
       and um.status = 'active'
       and um.scope_type = 'tenant'
       and um.tenant_id = v_tenant
       and um.role_id = 'store_owner') then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint;
    return;
  end if;

  -- 3. The tenant the owner reviewed (a precondition only).
  if v_tenant is distinct from p_expected_tenant then
    return query select 'tenant_mismatch'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint;
    return;
  end if;

  -- 4. The store row FOR SHARE in the owner's tenant, a write status: a missing store, another tenant's and one not active
  --    or trialing are one answer. The clock again after the wait.
  select st.status into v_store
    from public.store st
   where st.store_id = p_store_id
     and st.tenant_id = v_tenant
     for share;
  if not found or v_store.status is null or v_store.status not in ('active', 'trialing') then
    return query select 'not_found'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint;
    return;
  end if;
  v_now := pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp()) * 1000)::bigint;
  if v_now >= v_session.expires_at then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint;
    return;
  end if;

  -- 5. The store's settings key, EXCLUSIVE until COMMIT (class 530034), so two first writes serialize before either reads the
  --    row: the second then sees the first's row and conflicts (never a uniqueness error). A top-level statement, never inside
  --    an exception block. The clock again after the wait.
  perform pg_catalog.pg_advisory_xact_lock(530034, pg_catalog.hashtext(p_store_id::text));
  v_now := pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp()) * 1000)::bigint;
  if v_now >= v_session.expires_at then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint;
    return;
  end if;

  -- 6. The settings row FOR UPDATE by key only, its version decided after the lock: 0 means none yet.
  select s.version into v_current
    from tmpos_invoice_issue.store_issuing_settings s
   where s.store_id = p_store_id
     for update;
  if not found then
    v_current := 0;
  end if;
  v_now := pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp()) * 1000)::bigint;
  if v_now >= v_session.expires_at then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint;
    return;
  end if;
  if v_current is distinct from p_expected_version then
    return query select 'conflict'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint;
    return;
  end if;

  -- 7. The write: version 1 and the counter at 0, or version + 1. Every accepted write is a new version. The CHECKs restate
  --    step 0, so they cannot refuse; were one ever to, the raise is fixed text, never the row.
  begin
    if p_expected_version = 0 then
      insert into tmpos_invoice_issue.store_issuing_settings
        (tenant_id, store_id, version, legal_name, store_name, postal_address, tax_registration_id, tax_mode, tax_rate)
      values
        (v_tenant, p_store_id, 1, p_legal_name, p_store_name, p_postal_address, p_tax_registration_id, p_tax_mode, p_tax_rate)
      returning version into v_written;
      insert into tmpos_invoice_issue.store_invoice_counter (tenant_id, store_id, last_number)
      values (v_tenant, p_store_id, 0);
      get diagnostics v_counter = row_count;
    else
      update tmpos_invoice_issue.store_issuing_settings s
         set version = s.version + 1, legal_name = p_legal_name, store_name = p_store_name,
             postal_address = p_postal_address, tax_registration_id = p_tax_registration_id, tax_mode = p_tax_mode,
             tax_rate = p_tax_rate, updated_at = pg_catalog.now()
       where s.store_id = p_store_id
         and s.tenant_id = v_tenant
         and s.version = p_expected_version
      returning s.version into v_written;
      v_counter := 1;
    end if;
  exception
    when unique_violation or check_violation or foreign_key_violation or not_null_violation or restrict_violation then
      raise exception 'migration 034 settings: the settings are not ones the settings table admits'
        using errcode = 'integrity_constraint_violation';
  end;
  if v_written is distinct from p_expected_version + 1 or v_counter <> 1 then
    raise exception 'migration 034 settings: the settings were not written at the next version'
      using errcode = 'no_data_found';
  end if;

  -- 8. The verification read: the settings at the next version, and the store's counter.
  select s.version, s.tenant_id, (select k.last_number from tmpos_invoice_issue.store_invoice_counter k
                                   where k.store_id = s.store_id and k.tenant_id = s.tenant_id) as last_number
    into v_check
    from tmpos_invoice_issue.store_issuing_settings s
   where s.store_id = p_store_id;
  if not found or v_check.version is distinct from p_expected_version + 1 or v_check.tenant_id is distinct from v_tenant
     or v_check.last_number is null then
    raise exception 'migration 034 settings: the settings written are not the ones judged'
      using errcode = 'no_data_found';
  end if;

  return query select 'applied'::text, v_tenant, p_store_id, v_admission.actor_id, v_membership, v_written;
end
$$;

comment on function tmpos_invoice_issue.m7b_issuing_settings_set(text, uuid, uuid, bigint, text, text, text, text, text, integer) is
  'Phase 4.0 M7b (migration 034): writes one store''s issuing settings at an expected version (0: none yet) for the owner rule — a key naming a ledger-minted, live (database clock, read after every lock wait) tenant session under the installed issuer key, after 016''s hold and the session, ledger and issuer key rows, whose standing digest is unchanged, whose account status is active or trialing, who holds exactly one tenant-scope grant whose role is store_owner on an active or trialing tenant, still its active membership. Judges every argument first (invalid_parameter_value, a fixed message naming the field, never the value). Answers one row: (''refused'', NULLs) for any authority refusal; (''tenant_mismatch'', NULLs); (''not_found'', NULLs) alike for a missing store, another tenant''s and one not active or trialing (the store row FOR SHARE); then, under the store''s key pg_advisory_xact_lock(530034, hashtext(store id)) and the settings row FOR UPDATE: (''conflict'', NULLs) when the stored version (0 when none) is not the expected one — each with nothing written; else creates version 1 and the store''s counter at 0, or writes version + 1 (every accepted write is a new version), and answers (''applied'', tenant, store, actor, membership, version). Writes no audit record.';

-- =============================================================================
-- 12) The preview and the issue
-- =============================================================================
create function tmpos_invoice_issue.m7b_invoice_issue_preview(
  p_session_key text, p_expected_tenant uuid, p_expected_store uuid, p_draft_id uuid)
returns table (
  o_outcome             text,
  o_tenant_id           uuid,
  o_store_id            uuid,
  o_draft_id            uuid,
  o_draft_version       bigint,
  o_customer_id         uuid,
  o_customer_name       text,
  o_customer_version    bigint,
  o_settings_version    bigint,
  o_legal_name          text,
  o_store_name          text,
  o_postal_address      text,
  o_tax_registration_id text,
  o_tax_mode            text,
  o_tax_rate            integer,
  o_currency            text,
  o_line_count          integer,
  o_subtotal_cents      bigint,
  o_tax_cents           bigint,
  o_total_cents         bigint,
  o_position            integer,
  o_description         text,
  o_quantity            bigint,
  o_unit_price_cents    bigint,
  o_line_total_cents    bigint
)
language plpgsql
-- STABLE IS LOAD-BEARING (017's reason): the authority, the draft, its lines, the settings, the counter and the customer are
-- read on one snapshot. It locks nothing, allocates no number and can write nothing.
stable
security definer
set search_path = pg_catalog, pg_temp
set row_security = off
as $$
declare
  c_max      constant numeric := 9007199254740991;
  v_reader   record;
  v_draft    record;
  v_settings record;
  v_lines    record;
  v_last     bigint;
  v_customer record;
  v_tax      numeric;
  v_total    numeric;
begin
  if p_session_key is null or p_session_key !~ '^[\x21-\x7e]{1,128}$'
     or p_expected_tenant is null or p_expected_store is null or p_draft_id is null then
    raise exception 'migration 034 preview: an argument is malformed'
      using errcode = 'invalid_parameter_value';
  end if;

  -- The issue's authority, unlocked: write statuses, Invoices >= approve AND Customers >= view.
  select r.o_tenant_id as tenant_id into v_reader
    from tmpos_invoice_issue.m7b_issue_store_reader(p_session_key, p_expected_tenant, p_expected_store, true, 'approve') r;
  if not found then
    return query select 'denied'::text, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid, null::text, null::bigint,
      null::bigint, null::text, null::text, null::text, null::text, null::text, null::integer, null::text, null::integer,
      null::bigint, null::bigint, null::bigint, null::integer, null::text, null::bigint, null::bigint, null::bigint;
    return;
  end if;

  -- An open draft of exactly this tenant and store: a missing, another store's or tenant's and a non-open one are one answer.
  select d.version, d.customer_id, d.currency, d.line_count, d.subtotal_cents into v_draft
    from tmpos_invoice_draft.invoice_draft d
   where d.draft_id = p_draft_id and d.tenant_id = v_reader.tenant_id and d.store_id = p_expected_store
     and d.status = 'draft';
  if not found then
    return query select 'not_found'::text, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid, null::text, null::bigint,
      null::bigint, null::text, null::text, null::text, null::text, null::text, null::integer, null::text, null::integer,
      null::bigint, null::bigint, null::bigint, null::integer, null::text, null::bigint, null::bigint, null::bigint;
    return;
  end if;
  -- A version that cannot step.
  if v_draft.version >= 9007199254740991 then
    return query select 'invalid_state'::text, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid, null::text, null::bigint,
      null::bigint, null::text, null::text, null::text, null::text, null::text, null::integer, null::text, null::integer,
      null::bigint, null::bigint, null::bigint, null::integer, null::text, null::bigint, null::bigint, null::bigint;
    return;
  end if;

  select s.version, s.legal_name, s.store_name, s.postal_address, s.tax_registration_id, s.tax_mode, s.tax_rate
    into v_settings
    from tmpos_invoice_issue.store_issuing_settings s
   where s.store_id = p_expected_store and s.tenant_id = v_reader.tenant_id;
  if not found then
    return query select 'issuing_not_configured'::text, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid, null::text,
      null::bigint, null::bigint, null::text, null::text, null::text, null::text, null::text, null::integer, null::text,
      null::integer, null::bigint, null::bigint, null::bigint, null::integer, null::text, null::bigint, null::bigint, null::bigint;
    return;
  end if;

  -- The draft's own amounts, re-checked: n lines at 1..n summing to the subtotal (028's domain; a mismatch is a fault).
  select pg_catalog.count(*)::integer as n, pg_catalog.min(l.position) as lo, pg_catalog.max(l.position) as hi,
         coalesce(pg_catalog.sum(l.line_total_cents::numeric), -1) as total
    into v_lines
    from tmpos_invoice_draft.invoice_draft_line l
   where l.draft_id = p_draft_id and l.tenant_id = v_reader.tenant_id and l.store_id = p_expected_store;
  if v_lines.n is distinct from v_draft.line_count or v_lines.lo is distinct from 1 or v_lines.hi is distinct from v_draft.line_count
     or v_lines.total is distinct from v_draft.subtotal_cents::numeric then
    raise exception 'migration 034 preview: the draft''s lines are not its header''s'
      using errcode = 'data_corrupted';
  end if;
  if v_settings.tax_mode = 'exclusive_rate' then
    v_tax := tmpos_invoice_issue.m7b_invoice_tax_cents(v_draft.subtotal_cents, v_settings.tax_rate);
    v_total := v_draft.subtotal_cents::numeric + v_tax;
  else
    v_tax := null;
    v_total := v_draft.subtotal_cents::numeric;
  end if;
  select k.last_number into v_last
    from tmpos_invoice_issue.store_invoice_counter k
   where k.store_id = p_expected_store and k.tenant_id = v_reader.tenant_id;
  if not found then
    raise exception 'migration 034 preview: the store has issuing settings but no invoice counter'
      using errcode = 'data_corrupted';
  end if;
  if v_total > c_max or v_last >= c_max then
    return query select 'amount_out_of_range'::text, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid, null::text,
      null::bigint, null::bigint, null::text, null::text, null::text, null::text, null::text, null::integer, null::text,
      null::integer, null::bigint, null::bigint, null::bigint, null::integer, null::text, null::bigint, null::bigint, null::bigint;
    return;
  end if;

  select c.name, c.row_version into v_customer
    from tmpos_customer.customer c
   where c.tenant_id = v_reader.tenant_id and c.customer_id = v_draft.customer_id;
  if not found then
    raise exception 'migration 034 preview: the draft''s customer is not in its tenant'
      using errcode = 'data_corrupted';
  end if;

  return query
    select 'line'::text, v_reader.tenant_id, p_expected_store, p_draft_id, v_draft.version, v_draft.customer_id,
           v_customer.name::text, v_customer.row_version, v_settings.version, v_settings.legal_name::text,
           v_settings.store_name::text, v_settings.postal_address::text, v_settings.tax_registration_id::text,
           v_settings.tax_mode::text, v_settings.tax_rate, v_draft.currency::text, v_draft.line_count, v_draft.subtotal_cents,
           v_tax::bigint, v_total::bigint, l.position, l.description::text, l.quantity, l.unit_price_cents, l.line_total_cents
      from tmpos_invoice_draft.invoice_draft_line l
     where l.draft_id = p_draft_id and l.tenant_id = v_reader.tenant_id and l.store_id = p_expected_store
     order by l.position;
end
$$;

comment on function tmpos_invoice_issue.m7b_invoice_issue_preview(text, uuid, uuid, uuid) is
  'Phase 4.0 M7b (migration 034): what issuing one open draft would record, on one snapshot, under the issue''s authority (m7b_issue_store_reader: write statuses, Invoices approve, Customers view) — no lock, no number. (''denied'', NULLs) for every authority refusal; then in order (''not_found'', NULLs) alike for a missing, another store''s or tenant''s and a non-open draft; (''invalid_state'', NULLs) for a draft at version 9007199254740991; (''issuing_not_configured'', NULLs) for a store without settings; (''amount_out_of_range'', NULLs) for a total above 9007199254740991 or a counter at it; else one (''line'', ...) row per line in position order carrying the draft, customer, settings and amounts (tax NULL under none). Raises invalid_parameter_value (fixed message) for a malformed argument, data_corrupted for an inconsistent draft or a missing counter. STABLE.';

create function tmpos_invoice_issue.m7b_invoice_issue(
  p_session_key text, p_store_id uuid, p_draft_id uuid, p_expected_tenant uuid, p_expected_version bigint,
  p_expected_settings_version bigint, p_expected_customer_version bigint, p_invoice_id uuid)
returns table (
  o_outcome       text,
  o_tenant_id     uuid,
  o_store_id      uuid,
  o_actor_id      uuid,
  o_membership_id uuid,
  o_version       bigint,
  o_invoice_id    uuid,
  o_customer_id   uuid,
  o_number        bigint
)
language plpgsql
-- VOLATILE IS LOAD-BEARING (033's reason): it locks and then re-reads, and each statement must see what committed before its
-- own locks. Do not make it STABLE.
volatile
security definer
set search_path = pg_catalog, pg_temp
set row_security = off
as $$
declare
  -- The tenant ordering (permissionCatalog.ts TENANT_ORDERING), 020's constant, pinned by the parity test.
  c_levels         constant text[] := array['none', 'view', 'create', 'edit', 'manage', 'approve', 'full'];
  c_max            constant numeric := 9007199254740991;
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
  v_invoices       text;
  v_customers      text;
  v_header         record;
  v_settings       record;
  v_customer       record;
  v_lines          record;
  v_tax            numeric;
  v_total          numeric;
  v_counter        record;
  v_number         bigint;
  v_issued_at      timestamptz;
  v_lines_written  integer;
  v_counter_moved  integer;
  v_written        bigint;
  v_updated        integer;
  v_check          record;
begin
  -- 0. Every argument, before anything is read, locked or written. A refusal carries a fixed message, never the value.
  if p_session_key is null or p_session_key !~ '^[\x21-\x7e]{1,128}$'
     or p_store_id is null
     or p_draft_id is null
     or p_expected_tenant is null
     or p_invoice_id is null then
    raise exception 'migration 034 issue: an argument is malformed'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_expected_version is null or p_expected_version < 1 or p_expected_version > 9007199254740990 then
    raise exception 'migration 034 issue: the expected version is not one the draft table can advance'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_expected_settings_version is null or p_expected_settings_version < 1 or p_expected_settings_version > 9007199254740991
     or p_expected_customer_version is null or p_expected_customer_version < 1 or p_expected_customer_version > 9007199254740991 then
    raise exception 'migration 034 issue: the expected settings or customer version is out of range'
      using errcode = 'invalid_parameter_value';
  end if;
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'migration 034 issue: it must run under READ COMMITTED, so that its checks see what committed before its locks'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- 1. The caller, derived exactly as 033's discard derives it.
  select s.auth_provider, s.auth_provider_uid, s.expires_at, m.expires_at, m.issuer_digest
    into v_provider, v_uid, v_expires, v_minted_expires, v_minted_issuer
    from tmpos_session.session s
    join tmpos_mint.tenant_session m on m.session_key = s.session_key
   where s.session_key = p_session_key
     and s.audience = 'tenant';
  if not found then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid, null::uuid, null::bigint;
    return;
  end if;
  v_now := pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp()) * 1000)::bigint;
  if v_expires is distinct from v_minted_expires or v_now >= v_expires then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid, null::uuid, null::bigint;
    return;
  end if;
  select pg_catalog.sha256(k.key) into v_issuer from tmpos_mint.issuer_key k where k.singleton;
  if v_issuer is null or v_issuer is distinct from v_minted_issuer then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid, null::uuid, null::bigint;
    return;
  end if;

  if tmpos_session.m5_hold_tenant_standing(v_provider, v_uid) is distinct from 'held' then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid, null::uuid, null::bigint;
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
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid, null::uuid, null::bigint;
    return;
  end if;

  select pg_catalog.sha256(k.key) into v_issuer from tmpos_mint.issuer_key k where k.singleton for share;
  if v_issuer is null or v_issuer is distinct from v_session.issuer_digest then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid, null::uuid, null::bigint;
    return;
  end if;

  v_now := pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp()) * 1000)::bigint;
  if v_now >= v_session.expires_at then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid, null::uuid, null::bigint;
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
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid, null::uuid, null::bigint;
    return;
  end if;

  -- 2. EXACTLY ONE store-scope grant naming p_store_id — a selector among the actor's own grants, never proof — on a tenant
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
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid, null::uuid, null::bigint;
    return;
  end if;
  v_role := v_grants -> 0 ->> 'roleId';
  v_tenant := (v_grants -> 0 ->> 'tenantId')::uuid;
  v_membership := (v_grants -> 0 ->> 'membershipId')::uuid;
  -- 2a. Still that actor's active membership row at exactly that tenant, store and role (016's hold holds it).
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
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid, null::uuid, null::bigint;
    return;
  end if;
  -- 2b. The store row, re-read FOR SHARE (016's hold already holds it): in that grant's tenant, with a write status.
  select st.tenant_id, st.status into v_store
    from public.store st
   where st.store_id = p_store_id
     for share;
  if not found
     or v_store.tenant_id is distinct from v_tenant
     or v_store.status is null
     or v_store.status not in ('active', 'trialing') then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid, null::uuid, null::bigint;
    return;
  end if;

  -- 3. The role's levels, UNLOCKED: Invoices at Approve or above AND Customers at View or above (doc 12 §10.2). store_owner is
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
      return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid, null::uuid, null::bigint;
      return;
    end if;
  else
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid, null::uuid, null::bigint;
    return;
  end if;

  -- 4. The request's expectedTenant against the tenant derived from the grant — a precondition only.
  if v_tenant is distinct from p_expected_tenant then
    return query select 'tenant_mismatch'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid, null::uuid, null::bigint;
    return;
  end if;

  -- 5. The header, locked FOR UPDATE until COMMIT, filtered by id, derived tenant and store ONLY (never the version or the
  --    status: a waiter re-evaluates the row a concurrent edit, discard or issue committed). Then the clock again.
  select d.status, d.version, d.customer_id, d.currency, d.line_count, d.subtotal_cents
    into v_header
    from tmpos_invoice_draft.invoice_draft d
   where d.draft_id = p_draft_id
     and d.tenant_id = v_tenant
     and d.store_id = p_store_id
     for update;
  if not found then
    return query select 'not_found'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid, null::uuid, null::bigint;
    return;
  end if;
  v_now := pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp()) * 1000)::bigint;
  if v_now >= v_session.expires_at then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid, null::uuid, null::bigint;
    return;
  end if;

  -- 5b. THE GUARD (030's key, as 032's save holds it): SHARED until COMMIT, then the clock, then BOTH levels read again by
  --     plain SELECTs. Separate top-level statements of the outermost block, never inside a BEGIN ... EXCEPTION block (a
  --     subtransaction that aborts releases a transaction-scoped advisory lock). store_owner takes no key and no read.
  if v_role in ('manager', 'technician', 'sales_staff') then
    perform pg_catalog.pg_advisory_xact_lock_shared(530030, pg_catalog.hashtext(v_tenant::text || '/' || v_role));
    v_now := pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp()) * 1000)::bigint;
    if v_now >= v_session.expires_at then
      return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid, null::uuid, null::bigint;
      return;
    end if;
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
      return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid, null::uuid, null::bigint;
      return;
    end if;
  end if;

  -- 6. Only an open draft is issued: 'discarded' and 'issued' are terminal, whatever version is named.
  if v_header.status is distinct from 'draft' then
    return query select 'invalid_state'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid, null::uuid, null::bigint;
    return;
  end if;

  -- 7. The store's issuing settings FOR SHARE, by key only (never by version): the newest committed row is re-read under the
  --    lock. None: 'issuing_not_configured'. Then the clock again.
  select s.tenant_id, s.version, s.legal_name, s.store_name, s.postal_address, s.tax_registration_id, s.tax_mode, s.tax_rate
    into v_settings
    from tmpos_invoice_issue.store_issuing_settings s
   where s.store_id = p_store_id
     for share;
  if not found then
    return query select 'issuing_not_configured'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid, null::uuid, null::bigint;
    return;
  end if;
  if v_settings.tenant_id is distinct from v_tenant then
    raise exception 'migration 034 issue: the store''s issuing settings are not in its tenant'
      using errcode = 'data_corrupted';
  end if;
  v_now := pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp()) * 1000)::bigint;
  if v_now >= v_session.expires_at then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid, null::uuid, null::bigint;
    return;
  end if;

  -- 8. The draft version, then the settings version: a stale review conflicts.
  if v_header.version is distinct from p_expected_version then
    return query select 'conflict'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid, null::uuid, null::bigint;
    return;
  end if;
  if v_settings.version is distinct from p_expected_settings_version then
    return query select 'conflict'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid, null::uuid, null::bigint;
    return;
  end if;

  -- 9. The draft's customer FOR SHARE, by key only, in the derived tenant; then the clock; then its version. The draft's
  --    foreign key guarantees the row: a missing one is a fault.
  select c.name, c.row_version into v_customer
    from tmpos_customer.customer c
   where c.tenant_id = v_tenant
     and c.customer_id = v_header.customer_id
     for share;
  if not found then
    raise exception 'migration 034 issue: the draft''s customer is not in its tenant'
      using errcode = 'data_corrupted';
  end if;
  v_now := pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp()) * 1000)::bigint;
  if v_now >= v_session.expires_at then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid, null::uuid, null::bigint;
    return;
  end if;
  if v_customer.row_version is distinct from p_expected_customer_version then
    return query select 'conflict'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid, null::uuid, null::bigint;
    return;
  end if;

  -- 10. The amounts, exact: the draft's lines re-checked (n lines at 1..n summing to the subtotal; the header lock freezes
  --     them), the tax by the CHECK's own formula, the total within 2^53 - 1 — decided before the counter.
  select pg_catalog.count(*)::integer as n, pg_catalog.min(l.position) as lo, pg_catalog.max(l.position) as hi,
         coalesce(pg_catalog.sum(l.line_total_cents::numeric), -1) as total
    into v_lines
    from tmpos_invoice_draft.invoice_draft_line l
   where l.draft_id = p_draft_id and l.tenant_id = v_tenant and l.store_id = p_store_id;
  if v_lines.n is distinct from v_header.line_count or v_lines.lo is distinct from 1 or v_lines.hi is distinct from v_header.line_count
     or v_lines.total is distinct from v_header.subtotal_cents::numeric then
    raise exception 'migration 034 issue: the draft''s lines are not its header''s'
      using errcode = 'data_corrupted';
  end if;
  if v_settings.tax_mode = 'exclusive_rate' then
    v_tax := tmpos_invoice_issue.m7b_invoice_tax_cents(v_header.subtotal_cents, v_settings.tax_rate);
    v_total := v_header.subtotal_cents::numeric + v_tax;
  else
    v_tax := null;
    v_total := v_header.subtotal_cents::numeric;
  end if;
  if v_total > c_max then
    return query select 'amount_out_of_range'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid, null::uuid, null::bigint;
    return;
  end if;

  -- 11. The store's counter FOR UPDATE: from here to COMMIT this issue waits on no draft, customer, settings or authority row.
  --     Settings without a counter are a fault. Exhausted: 'amount_out_of_range', the only refusal after the counter besides
  --     the session's liveness on the clock read now, which is also the issue time.
  select k.tenant_id, k.last_number into v_counter
    from tmpos_invoice_issue.store_invoice_counter k
   where k.store_id = p_store_id
     for update;
  if not found or v_counter.tenant_id is distinct from v_tenant then
    raise exception 'migration 034 issue: the store has issuing settings but no invoice counter'
      using errcode = 'data_corrupted';
  end if;
  if v_counter.last_number >= c_max then
    return query select 'amount_out_of_range'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid, null::uuid, null::bigint;
    return;
  end if;
  v_issued_at := pg_catalog.clock_timestamp();
  if pg_catalog.floor(extract(epoch from v_issued_at) * 1000)::bigint >= v_session.expires_at then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid, null::uuid, null::bigint;
    return;
  end if;
  v_number := v_counter.last_number + 1;

  -- 12. The writes, in the order the guards admit: the header, its lines (copied from the draft's by position), the counter
  --     by one, the draft to 'issued' at the next version. Every constraint violation is fixed text, never a row value.
  begin
    insert into tmpos_invoice_issue.issued_invoice
      (invoice_id, tenant_id, store_id, number, snapshot_version, source_draft_id, source_draft_version, settings_version,
       customer_id, customer_version, customer_name, legal_name, store_name, postal_address, tax_registration_id, currency,
       line_count, subtotal_cents, tax_mode, tax_rate, tax_cents, total_cents, issued_at, issued_by)
    values
      (p_invoice_id, v_tenant, p_store_id, v_number, 1, p_draft_id, v_header.version, v_settings.version,
       v_header.customer_id, v_customer.row_version, v_customer.name, v_settings.legal_name, v_settings.store_name,
       v_settings.postal_address, v_settings.tax_registration_id, v_header.currency, v_header.line_count,
       v_header.subtotal_cents, v_settings.tax_mode, v_settings.tax_rate, v_tax::bigint, v_total::bigint, v_issued_at,
       v_admission.actor_id);
    insert into tmpos_invoice_issue.issued_invoice_line
      (invoice_id, tenant_id, store_id, position, description, quantity, unit_price_cents, line_total_cents)
    select p_invoice_id, v_tenant, p_store_id, l.position, l.description, l.quantity, l.unit_price_cents, l.line_total_cents
      from tmpos_invoice_draft.invoice_draft_line l
     where l.draft_id = p_draft_id and l.tenant_id = v_tenant and l.store_id = p_store_id
     order by l.position;
    get diagnostics v_lines_written = row_count;
    update tmpos_invoice_issue.store_invoice_counter k
       set last_number = k.last_number + 1
     where k.store_id = p_store_id
       and k.tenant_id = v_tenant
       and k.last_number = v_counter.last_number;
    get diagnostics v_counter_moved = row_count;
    update tmpos_invoice_draft.invoice_draft d
       set status = 'issued', version = d.version + 1
     where d.draft_id = p_draft_id
       and d.tenant_id = v_tenant
       and d.store_id = p_store_id
       and d.version = p_expected_version
       and d.status = 'draft'
    returning d.version into v_written;
    get diagnostics v_updated = row_count;
  exception
    when unique_violation or check_violation or foreign_key_violation or not_null_violation or restrict_violation
         or numeric_value_out_of_range then
      raise exception 'migration 034 issue: the invoice is not one the issued tables admit'
        using errcode = 'integrity_constraint_violation';
  end;
  if v_lines_written is distinct from v_header.line_count or v_counter_moved <> 1 or v_updated <> 1
     or v_written is distinct from p_expected_version + 1 then
    raise exception 'migration 034 issue: the issue was not written to exactly the locked draft, its lines and its store''s counter'
      using errcode = 'no_data_found';
  end if;

  -- 13. The verification reads: the header at the number, every line, the counter at the number, the draft issued.
  select i.number, i.total_cents,
         (select pg_catalog.count(*)::integer from tmpos_invoice_issue.issued_invoice_line l where l.invoice_id = i.invoice_id) as n,
         (select k.last_number from tmpos_invoice_issue.store_invoice_counter k where k.store_id = i.store_id) as last_number,
         (select d.status from tmpos_invoice_draft.invoice_draft d where d.draft_id = i.source_draft_id) as status
    into v_check
    from tmpos_invoice_issue.issued_invoice i
   where i.invoice_id = p_invoice_id and i.tenant_id = v_tenant and i.store_id = p_store_id and i.source_draft_id = p_draft_id;
  if not found or v_check.number is distinct from v_number or v_check.n is distinct from v_header.line_count
     or v_check.last_number is distinct from v_number or v_check.status is distinct from 'issued'
     or v_check.total_cents::numeric is distinct from v_total then
    raise exception 'migration 034 issue: the issued invoice is not the one judged'
      using errcode = 'no_data_found';
  end if;

  return query select 'applied'::text, v_tenant, p_store_id, v_admission.actor_id, v_membership, v_written, p_invoice_id,
    v_header.customer_id, v_number;
end
$$;

comment on function tmpos_invoice_issue.m7b_invoice_issue(text, uuid, uuid, uuid, bigint, bigint, bigint, uuid) is
  'Phase 4.0 M7b (migration 034): issues one open invoice draft at a store as an immutable invoice (snapshot version 1) under the store''s next number, for 033''s discard''s caller derivation (a ledger-minted, live tenant session under the installed issuer key, 016''s hold, the session, ledger and issuer key rows, an unchanged standing, an active or trialing account, EXACTLY ONE store grant at p_store_id on an active or trialing tenant and store, still its active membership, the store row FOR SHARE) and a role whose Invoices level is Approve or above AND Customers level View or above (store_owner Full) — read unlocked, then again after the draft header is locked FOR UPDATE under pg_advisory_xact_lock_shared(530030, hashtext(tenant || ''/'' || role)) for an editable role. Answers one row: (''refused'', NULLs) for any authority refusal or a session that expired while a lock waited; (''tenant_mismatch'', NULLs); (''not_found'', NULLs) alike for a missing, another store''s and another tenant''s draft; then, the header locked: (''invalid_state'', NULLs) for a non-open draft; (''issuing_not_configured'', NULLs) for a store without settings (FOR SHARE); (''conflict'', NULLs) for a stale draft, settings or customer (FOR SHARE) version; (''amount_out_of_range'', NULLs) for a total above 9007199254740991 or, under the counter FOR UPDATE, an exhausted counter — every one with nothing written; else writes the header, its lines, the counter + 1 and the draft issued at version + 1 and answers (''applied'', tenant, store, actor, membership, new draft version, invoice id, customer id, number). Raises invalid_parameter_value (fixed message) for a malformed argument, integrity_constraint_violation (fixed text) for any constraint refusal of the writes, data_corrupted for missing settings counter or customer. Writes no audit, outbox or idempotency record.';

-- =============================================================================
-- 13) The issued reads
-- =============================================================================
create function tmpos_invoice_issue.m7b_issued_invoice_page(
  p_session_key text, p_expected_tenant uuid, p_expected_store uuid, p_after_invoice_id uuid, p_source_draft_id uuid,
  p_limit integer)
returns table (
  o_outcome          text,
  o_tenant_id        uuid,
  o_store_id         uuid,
  o_invoice_id       uuid,
  o_number           bigint,
  o_source_draft_id  uuid,
  o_customer_id      uuid,
  o_customer_name    text,
  o_currency         text,
  o_total_cents      bigint,
  o_issued_at        text,
  o_snapshot_version integer
)
language plpgsql
-- STABLE IS LOAD-BEARING (017's reason): one snapshot; locks nothing.
stable
security definer
set search_path = pg_catalog, pg_temp
set row_security = off
as $$
declare
  v_reader record;
  v_after  bigint;
begin
  if p_session_key is null or p_session_key !~ '^[\x21-\x7e]{1,128}$'
     or p_expected_tenant is null or p_expected_store is null
     or p_limit is null or p_limit < 1 or p_limit > 51
     or (p_after_invoice_id is not null and p_source_draft_id is not null) then
    raise exception 'migration 034 page: an argument is malformed'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Read statuses, Invoices >= view AND Customers >= view.
  select r.o_tenant_id as tenant_id into v_reader
    from tmpos_invoice_issue.m7b_issue_store_reader(p_session_key, p_expected_tenant, p_expected_store, false, 'view') r;
  if not found then
    return query select 'denied'::text, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid, null::uuid, null::text,
      null::text, null::bigint, null::text, null::integer;
    return;
  end if;

  -- The "find issued invoice" filter: the issued invoice of that draft in this tenant and store, if any. An unknown, another
  -- store's or tenant's, an open and a discarded draft id all give no row.
  if p_source_draft_id is not null then
    return query
      select 'invoice'::text, i.tenant_id, i.store_id, i.invoice_id, i.number, i.source_draft_id, i.customer_id,
             i.customer_name::text, i.currency::text, i.total_cents,
             pg_catalog.to_char(i.issued_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), i.snapshot_version::integer
        from tmpos_invoice_issue.issued_invoice i
       where i.tenant_id = v_reader.tenant_id and i.store_id = p_expected_store and i.source_draft_id = p_source_draft_id;
    return;
  end if;

  -- The anchor a continuation names, re-read INSIDE this tenant and store: missing, another store's and another tenant's are
  -- one answer. Its number never leaves the database.
  if p_after_invoice_id is not null then
    select i.number into v_after
      from tmpos_invoice_issue.issued_invoice i
     where i.invoice_id = p_after_invoice_id and i.tenant_id = v_reader.tenant_id and i.store_id = p_expected_store;
    if not found then
      return query select 'cursor_unknown'::text, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid, null::uuid,
        null::text, null::text, null::bigint, null::text, null::integer;
      return;
    end if;
  end if;

  -- Newest number first (issued_invoice_number_key, scanned backward), strictly after the anchor.
  return query
    select 'invoice'::text, i.tenant_id, i.store_id, i.invoice_id, i.number, i.source_draft_id, i.customer_id,
           i.customer_name::text, i.currency::text, i.total_cents,
           pg_catalog.to_char(i.issued_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), i.snapshot_version::integer
      from tmpos_invoice_issue.issued_invoice i
     where i.tenant_id = v_reader.tenant_id
       and i.store_id = p_expected_store
       and (v_after is null or i.number < v_after)
     order by i.number desc
     limit p_limit;
end
$$;

comment on function tmpos_invoice_issue.m7b_issued_invoice_page(text, uuid, uuid, uuid, uuid, integer) is
  'Phase 4.0 M7b (migration 034): one page (at most p_limit, 1-51) of one store''s issued invoices, newest number first, each (''invoice'', tenant, store, invoice id, number, source draft id, customer id, customer name, currency, total cents, issued_at as UTC text with microseconds, snapshot version), under m7b_issue_store_reader''s read authority (read statuses, Invoices view, Customers view). A continuation names an anchor invoice re-read inside that tenant and store (''cursor_unknown'' otherwise); p_source_draft_id instead serves at most the one invoice issued from that draft in this tenant and store (no row for an unknown, foreign, open or discarded draft). No row for an empty page; (''denied'', NULLs) for every authority refusal. Raises invalid_parameter_value (fixed message) for a malformed argument or both selectors. STABLE; locks nothing.';

create function tmpos_invoice_issue.m7b_issued_invoice_get(
  p_session_key text, p_expected_tenant uuid, p_expected_store uuid, p_invoice_id uuid)
returns table (
  o_outcome              text,
  o_tenant_id            uuid,
  o_store_id             uuid,
  o_invoice_id           uuid,
  o_number               bigint,
  o_snapshot_version     integer,
  o_issued_at            text,
  o_source_draft_id      uuid,
  o_source_draft_version bigint,
  o_settings_version     bigint,
  o_legal_name           text,
  o_store_name           text,
  o_postal_address       text,
  o_tax_registration_id  text,
  o_customer_id          uuid,
  o_customer_name        text,
  o_customer_version     bigint,
  o_currency             text,
  o_line_count           integer,
  o_subtotal_cents       bigint,
  o_tax_mode             text,
  o_tax_rate             integer,
  o_tax_cents            bigint,
  o_total_cents          bigint,
  o_position             integer,
  o_description          text,
  o_quantity             bigint,
  o_unit_price_cents     bigint,
  o_line_total_cents     bigint
)
language plpgsql
-- STABLE IS LOAD-BEARING (017's reason): the header and its lines on one snapshot; locks nothing.
stable
security definer
set search_path = pg_catalog, pg_temp
set row_security = off
as $$
declare
  v_reader record;
begin
  if p_session_key is null or p_session_key !~ '^[\x21-\x7e]{1,128}$'
     or p_expected_tenant is null or p_expected_store is null or p_invoice_id is null then
    raise exception 'migration 034 get: an argument is malformed'
      using errcode = 'invalid_parameter_value';
  end if;

  select r.o_tenant_id as tenant_id into v_reader
    from tmpos_invoice_issue.m7b_issue_store_reader(p_session_key, p_expected_tenant, p_expected_store, false, 'view') r;
  if not found then
    return query select 'denied'::text, null::uuid, null::uuid, null::uuid, null::bigint, null::integer, null::text, null::uuid,
      null::bigint, null::bigint, null::text, null::text, null::text, null::text, null::uuid, null::text, null::bigint, null::text,
      null::integer, null::bigint, null::text, null::integer, null::bigint, null::bigint, null::integer, null::text, null::bigint,
      null::bigint, null::bigint;
    return;
  end if;

  if not exists (select 1 from tmpos_invoice_issue.issued_invoice i
                  where i.invoice_id = p_invoice_id and i.tenant_id = v_reader.tenant_id and i.store_id = p_expected_store) then
    return query select 'not_found'::text, null::uuid, null::uuid, null::uuid, null::bigint, null::integer, null::text, null::uuid,
      null::bigint, null::bigint, null::text, null::text, null::text, null::text, null::uuid, null::text, null::bigint, null::text,
      null::integer, null::bigint, null::text, null::integer, null::bigint, null::bigint, null::integer, null::text, null::bigint,
      null::bigint, null::bigint;
    return;
  end if;

  -- The snapshot, one row per line in position order; the issuing actor is never a column.
  return query
    select 'line'::text, i.tenant_id, i.store_id, i.invoice_id, i.number, i.snapshot_version::integer,
           pg_catalog.to_char(i.issued_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), i.source_draft_id,
           i.source_draft_version, i.settings_version, i.legal_name::text, i.store_name::text, i.postal_address::text,
           i.tax_registration_id::text, i.customer_id, i.customer_name::text, i.customer_version, i.currency::text,
           i.line_count, i.subtotal_cents, i.tax_mode::text, i.tax_rate, i.tax_cents, i.total_cents,
           l.position, l.description::text, l.quantity, l.unit_price_cents, l.line_total_cents
      from tmpos_invoice_issue.issued_invoice i
      join tmpos_invoice_issue.issued_invoice_line l
        on l.invoice_id = i.invoice_id and l.tenant_id = i.tenant_id and l.store_id = i.store_id
     where i.invoice_id = p_invoice_id and i.tenant_id = v_reader.tenant_id and i.store_id = p_expected_store
     order by l.position;
end
$$;

comment on function tmpos_invoice_issue.m7b_issued_invoice_get(text, uuid, uuid, uuid) is
  'Phase 4.0 M7b (migration 034): one issued invoice of exactly one tenant and store with its lines — one (''line'', ...) row per line in position order carrying the whole snapshot (number, snapshot version, issued_at as UTC text, source draft and version, settings version and seller values, customer id, name and version, currency, line count, subtotal, tax mode, rate and amount, total) and never the issuing actor — under m7b_issue_store_reader''s read authority. (''not_found'', NULLs) alike for a missing and a foreign id; (''denied'', NULLs) for every authority refusal. Raises invalid_parameter_value (fixed message) for a malformed argument. STABLE; locks nothing.';

-- =============================================================================
-- 14) The rollback-order anchor
-- =============================================================================
-- A SQL-standard body records a dependency for every reg* constant: 033's two terminal functions (the down rebinds the header
-- trigger to 033's; the line trigger is what freezes an issued draft's lines) and the three 033 routines whose open-only
-- answers issuing relies on. DROP of any of them without CASCADE — 033's rollback — is refused (2BP01) while this exists.
create function tmpos_invoice_issue.m7b_invoice_issue_prerequisites()
returns boolean
language sql
stable
security invoker
set search_path = pg_catalog, pg_temp
begin atomic
  select 'tmpos_invoice_discard.m7b_invoice_draft_terminal()'::pg_catalog.regprocedure is not null
     and 'tmpos_invoice_discard.m7b_invoice_draft_line_terminal()'::pg_catalog.regprocedure is not null
     and 'tmpos_invoice_discard.m7b_invoice_draft_discard(text, uuid, uuid, uuid, bigint)'::pg_catalog.regprocedure is not null
     and 'tmpos_invoice_discard.m7b_invoice_draft_page_v2(text, uuid, uuid, uuid, integer)'::pg_catalog.regprocedure is not null
     and 'tmpos_invoice_discard.m7b_invoice_draft_get_v2(text, uuid, uuid, uuid)'::pg_catalog.regprocedure is not null;
end;

comment on function tmpos_invoice_issue.m7b_invoice_issue_prerequisites() is
  'Phase 4.0 M7b (migration 034): the rollback-order anchor. A SQL-standard body naming, as reg* constants, migration 033''s m7b_invoice_draft_terminal, m7b_invoice_draft_line_terminal, m7b_invoice_draft_discard, m7b_invoice_draft_page_v2 and m7b_invoice_draft_get_v2, so their recorded dependencies refuse (2BP01) 033''s rollback while migration 034 is applied (033''s rollback also refuses at its own prerequisites, 55000): roll 034 back first. Never called; answers true. Granted to nobody.';

-- =============================================================================
-- 15) Privileges
-- =============================================================================
-- PostgreSQL grants EXECUTE on a new function to PUBLIC by default: every default is removed before the six intended grants.
revoke all on function tmpos_invoice_issue.m7b_issue_text_ok(text, integer) from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
revoke all on function tmpos_invoice_issue.m7b_issue_postal_address_ok(text) from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
revoke all on function tmpos_invoice_issue.m7b_invoice_tax_cents(bigint, integer) from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
revoke all on function tmpos_invoice_issue.m7b_issuing_settings_guard() from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
revoke all on function tmpos_invoice_issue.m7b_invoice_counter_guard() from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
revoke all on function tmpos_invoice_issue.m7b_issued_invoice_guard() from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
revoke all on function tmpos_invoice_issue.m7b_issued_invoice_line_guard() from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
revoke all on function tmpos_invoice_issue.m7b_issue_truncate_guard() from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
revoke all on function tmpos_invoice_issue.m7b_issued_invoice_commit_check() from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
revoke all on function tmpos_invoice_issue.m7b_invoice_draft_terminal_v2() from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
revoke all on function tmpos_invoice_issue.m7b_issue_store_reader(text, uuid, uuid, boolean, text) from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
revoke all on function tmpos_invoice_issue.m7b_issuing_settings_get(text, uuid, uuid) from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
revoke all on function tmpos_invoice_issue.m7b_issuing_settings_set(text, uuid, uuid, bigint, text, text, text, text, text, integer) from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
revoke all on function tmpos_invoice_issue.m7b_invoice_issue_preview(text, uuid, uuid, uuid) from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
revoke all on function tmpos_invoice_issue.m7b_invoice_issue(text, uuid, uuid, uuid, bigint, bigint, bigint, uuid) from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
revoke all on function tmpos_invoice_issue.m7b_issued_invoice_page(text, uuid, uuid, uuid, uuid, integer) from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
revoke all on function tmpos_invoice_issue.m7b_issued_invoice_get(text, uuid, uuid, uuid) from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
revoke all on function tmpos_invoice_issue.m7b_invoice_issue_prerequisites() from public, anon, authenticated, tmpos_app, tmpos_audit_writer;

grant execute on function tmpos_invoice_issue.m7b_issuing_settings_get(text, uuid, uuid) to tmpos_app;
grant execute on function tmpos_invoice_issue.m7b_issuing_settings_set(text, uuid, uuid, bigint, text, text, text, text, text, integer) to tmpos_app;
grant execute on function tmpos_invoice_issue.m7b_invoice_issue_preview(text, uuid, uuid, uuid) to tmpos_app;
grant execute on function tmpos_invoice_issue.m7b_invoice_issue(text, uuid, uuid, uuid, bigint, bigint, bigint, uuid) to tmpos_app;
grant execute on function tmpos_invoice_issue.m7b_issued_invoice_page(text, uuid, uuid, uuid, uuid, integer) to tmpos_app;
grant execute on function tmpos_invoice_issue.m7b_issued_invoice_get(text, uuid, uuid, uuid) to tmpos_app;

-- =============================================================================
-- 16) Postcondition
-- =============================================================================
-- Proven rather than asserted, in 033's form. This file refuses to finish unless, now:
--   (a) schema tmpos_invoice_issue holds exactly this file's eighteen functions, four tables and their indexes and no other
--       relation or type, is owned by the applying principal, and its complete ACL is the owner's USAGE and CREATE and a
--       non-grantable USAGE to tmpos_app;
--   (b) every function has its declared language, security, volatility, settings, owner and comment, the six routines their
--       exact arguments and RETURNS TABLE;
--   (c) the complete ACL of each of the six routines is exactly the owner's EXECUTE and tmpos_app's non-grantable EXECUTE;
--       of every other function exactly the owner's;
--   (d) tmpos_app can execute the six and nothing else of the schema; tmpos_audit_writer, anon and authenticated nothing, by
--       any path; no runtime role holds any privilege on a new table by any path (MAINTAIN included where the server has
--       it); row security is enabled and not forced on each;
--   (e) none of the four runtime roles is a member of the owner of the schema, a function or a table in it;
--   (f) every trigger of the four tables is exactly this file's, in its exact shape and ENABLE ALWAYS; the draft header carries
--       exactly 029's trigger and trg_invoice_draft_terminal (bound to the v2 function, tgtype 31, ALWAYS, 033's comment), the
--       lines exactly 033's line trigger, unchanged;
--   (g) invoice_draft_status_chk is exactly the widened CHECK, validated, and tmpos_invoice_draft holds exactly 033's relations;
--   (h) the two audit columns are nullable uuids without a default, each with its partial index, writable by the audit writer,
--       and no column of the audit table carries a grant;
--   (i) every foreign key of the new tables is ON DELETE RESTRICT ON UPDATE RESTRICT, and the commit check is deferrable,
--       initially deferred;
--   (j) the anchor records exactly one dependency on each of the five 033 functions it names.
do $$
declare
  v_bad      text;
  v_me       oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user);
  v_routines oid[] := array[
    'tmpos_invoice_issue.m7b_issuing_settings_get(text, uuid, uuid)'::regprocedure,
    'tmpos_invoice_issue.m7b_issuing_settings_set(text, uuid, uuid, bigint, text, text, text, text, text, integer)'::regprocedure,
    'tmpos_invoice_issue.m7b_invoice_issue_preview(text, uuid, uuid, uuid)'::regprocedure,
    'tmpos_invoice_issue.m7b_invoice_issue(text, uuid, uuid, uuid, bigint, bigint, bigint, uuid)'::regprocedure,
    'tmpos_invoice_issue.m7b_issued_invoice_page(text, uuid, uuid, uuid, uuid, integer)'::regprocedure,
    'tmpos_invoice_issue.m7b_issued_invoice_get(text, uuid, uuid, uuid)'::regprocedure]::oid[];
  v_tables   oid[] := array[
    'tmpos_invoice_issue.store_issuing_settings'::regclass, 'tmpos_invoice_issue.store_invoice_counter'::regclass,
    'tmpos_invoice_issue.issued_invoice'::regclass, 'tmpos_invoice_issue.issued_invoice_line'::regclass]::oid[];
  v_v2       oid := 'tmpos_invoice_issue.m7b_invoice_draft_terminal_v2()'::regprocedure;
  v_anchor   oid := 'tmpos_invoice_issue.m7b_invoice_issue_prerequisites()'::regprocedure;
begin
  -- (a)
  if (select pg_catalog.string_agg(p.oid::regprocedure::text, ', ' order by p.oid::regprocedure::text collate "C")
        from pg_catalog.pg_proc p where p.pronamespace = 'tmpos_invoice_issue'::regnamespace)
     is distinct from
     'tmpos_invoice_issue.m7b_invoice_counter_guard(), tmpos_invoice_issue.m7b_invoice_draft_terminal_v2(), tmpos_invoice_issue.m7b_invoice_issue(text,uuid,uuid,uuid,bigint,bigint,bigint,uuid), tmpos_invoice_issue.m7b_invoice_issue_prerequisites(), tmpos_invoice_issue.m7b_invoice_issue_preview(text,uuid,uuid,uuid), tmpos_invoice_issue.m7b_invoice_tax_cents(bigint,integer), tmpos_invoice_issue.m7b_issue_postal_address_ok(text), tmpos_invoice_issue.m7b_issue_store_reader(text,uuid,uuid,boolean,text), tmpos_invoice_issue.m7b_issue_text_ok(text,integer), tmpos_invoice_issue.m7b_issue_truncate_guard(), tmpos_invoice_issue.m7b_issued_invoice_commit_check(), tmpos_invoice_issue.m7b_issued_invoice_get(text,uuid,uuid,uuid), tmpos_invoice_issue.m7b_issued_invoice_guard(), tmpos_invoice_issue.m7b_issued_invoice_line_guard(), tmpos_invoice_issue.m7b_issued_invoice_page(text,uuid,uuid,uuid,uuid,integer), tmpos_invoice_issue.m7b_issuing_settings_get(text,uuid,uuid), tmpos_invoice_issue.m7b_issuing_settings_guard(), tmpos_invoice_issue.m7b_issuing_settings_set(text,uuid,uuid,bigint,text,text,text,text,text,integer)'
     or (select pg_catalog.string_agg(pg_catalog.format('%s:%s', c.relname, c.relkind), ', ' order by c.relname collate "C")
           from pg_catalog.pg_class c where c.relnamespace = 'tmpos_invoice_issue'::regnamespace)
        is distinct from
        'issued_invoice:r, issued_invoice_customer_idx:i, issued_invoice_line:r, issued_invoice_line_pkey:i, issued_invoice_number_key:i, issued_invoice_pkey:i, issued_invoice_scope_key:i, issued_invoice_source_draft_key:i, store_invoice_counter:r, store_invoice_counter_pkey:i, store_issuing_settings:r, store_issuing_settings_pkey:i'
     or exists (select 1 from pg_catalog.pg_type t
                 where t.typnamespace = 'tmpos_invoice_issue'::regnamespace and t.typrelid = 0 and t.typelem = 0)
     or not exists (select 1 from pg_catalog.pg_namespace n where n.oid = 'tmpos_invoice_issue'::regnamespace and n.nspowner = v_me)
     or exists (select 1 from pg_catalog.pg_class c where c.oid = any (v_tables) and c.relowner <> v_me) then
    raise exception 'migration 034 refused: schema tmpos_invoice_issue does not hold exactly this file''s functions and relations, or it or a table is not owned by the applying principal'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  select pg_catalog.string_agg(pg_catalog.format('%s:%s', g.grantee::regrole::text, g.privilege_type), ', ')
    into v_bad
    from pg_catalog.pg_namespace n,
         pg_catalog.aclexplode(coalesce(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) g
   where n.oid = 'tmpos_invoice_issue'::regnamespace
     and not (not g.is_grantable and g.grantor = n.nspowner
              and ((g.grantee = n.nspowner and g.privilege_type in ('USAGE', 'CREATE'))
                   or (g.grantee = 'tmpos_app'::regrole and g.privilege_type = 'USAGE')));
  if v_bad is not null
     or (select pg_catalog.count(*)
           from pg_catalog.pg_namespace n,
                pg_catalog.aclexplode(coalesce(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) g
          where n.oid = 'tmpos_invoice_issue'::regnamespace) <> 3
     or not pg_catalog.has_schema_privilege('tmpos_app', 'tmpos_invoice_issue'::regnamespace, 'USAGE') then
    raise exception 'migration 034 refused: schema tmpos_invoice_issue carries an unexpected grant or lacks an expected one (%), or tmpos_app cannot use it', coalesce(v_bad, 'none listed')
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (b)
  select pg_catalog.string_agg(p.proname::text, ', ' order by p.proname) into v_bad
    from pg_catalog.pg_proc p join pg_catalog.pg_language l on l.oid = p.prolang
   where p.pronamespace = 'tmpos_invoice_issue'::regnamespace
     and not (p.proowner = v_me
              and pg_catalog.obj_description(p.oid, 'pg_proc') is not null
              and case
                    when p.oid = any (v_routines) then
                      l.lanname = 'plpgsql' and p.prosecdef
                      and p.provolatile = case when p.proname in ('m7b_issuing_settings_set', 'm7b_invoice_issue') then 'v' else 's' end
                      and p.proconfig = array['search_path=pg_catalog, pg_temp', 'row_security=off']
                    when p.proname in ('m7b_issue_text_ok', 'm7b_issue_postal_address_ok', 'm7b_invoice_tax_cents') then
                      l.lanname = 'sql' and not p.prosecdef and p.provolatile = 'i' and p.prosqlbody is not null
                      and p.proisstrict = (p.proname = 'm7b_invoice_tax_cents')
                      and p.proconfig = array['search_path=pg_catalog, pg_temp']
                    when p.proname = 'm7b_invoice_issue_prerequisites' then
                      l.lanname = 'sql' and not p.prosecdef and p.provolatile = 's' and p.prosqlbody is not null
                      and p.prorettype = 'pg_catalog.bool'::regtype
                      and p.proconfig = array['search_path=pg_catalog, pg_temp']
                    when p.proname = 'm7b_issue_store_reader' then
                      l.lanname = 'plpgsql' and not p.prosecdef and p.provolatile = 's'
                      and p.proconfig = array['search_path=pg_catalog, pg_temp', 'row_security=off']
                    else
                      l.lanname = 'plpgsql' and p.prosecdef = (p.proname = 'm7b_issued_invoice_commit_check') and p.provolatile = 'v'
                      and p.prorettype = 'pg_catalog.trigger'::regtype
                      and p.proconfig = case when p.proname = 'm7b_issue_truncate_guard'
                                             then array['search_path=pg_catalog, pg_temp']
                                             else array['search_path=pg_catalog, pg_temp', 'row_security=off'] end
                  end);
  if v_bad is not null
     or pg_catalog.obj_description('tmpos_invoice_issue'::regnamespace, 'pg_namespace') is null
     or pg_catalog.pg_get_function_arguments('tmpos_invoice_issue.m7b_issuing_settings_get(text, uuid, uuid)'::regprocedure)
        is distinct from 'p_session_key text, p_expected_tenant uuid, p_store_id uuid'
     or pg_catalog.pg_get_function_result('tmpos_invoice_issue.m7b_issuing_settings_get(text, uuid, uuid)'::regprocedure)
        is distinct from 'TABLE(o_outcome text, o_tenant_id uuid, o_store_id uuid, o_version bigint, o_legal_name text, o_store_name text, o_postal_address text, o_tax_registration_id text, o_tax_mode text, o_tax_rate integer)'
     or pg_catalog.pg_get_function_arguments('tmpos_invoice_issue.m7b_issuing_settings_set(text, uuid, uuid, bigint, text, text, text, text, text, integer)'::regprocedure)
        is distinct from 'p_session_key text, p_store_id uuid, p_expected_tenant uuid, p_expected_version bigint, p_legal_name text, p_store_name text, p_postal_address text, p_tax_registration_id text, p_tax_mode text, p_tax_rate integer'
     or pg_catalog.pg_get_function_result('tmpos_invoice_issue.m7b_issuing_settings_set(text, uuid, uuid, bigint, text, text, text, text, text, integer)'::regprocedure)
        is distinct from 'TABLE(o_outcome text, o_tenant_id uuid, o_store_id uuid, o_actor_id uuid, o_membership_id uuid, o_version bigint)'
     or pg_catalog.pg_get_function_arguments('tmpos_invoice_issue.m7b_invoice_issue_preview(text, uuid, uuid, uuid)'::regprocedure)
        is distinct from 'p_session_key text, p_expected_tenant uuid, p_expected_store uuid, p_draft_id uuid'
     or pg_catalog.pg_get_function_result('tmpos_invoice_issue.m7b_invoice_issue_preview(text, uuid, uuid, uuid)'::regprocedure)
        is distinct from 'TABLE(o_outcome text, o_tenant_id uuid, o_store_id uuid, o_draft_id uuid, o_draft_version bigint, o_customer_id uuid, o_customer_name text, o_customer_version bigint, o_settings_version bigint, o_legal_name text, o_store_name text, o_postal_address text, o_tax_registration_id text, o_tax_mode text, o_tax_rate integer, o_currency text, o_line_count integer, o_subtotal_cents bigint, o_tax_cents bigint, o_total_cents bigint, o_position integer, o_description text, o_quantity bigint, o_unit_price_cents bigint, o_line_total_cents bigint)'
     or pg_catalog.pg_get_function_arguments('tmpos_invoice_issue.m7b_invoice_issue(text, uuid, uuid, uuid, bigint, bigint, bigint, uuid)'::regprocedure)
        is distinct from 'p_session_key text, p_store_id uuid, p_draft_id uuid, p_expected_tenant uuid, p_expected_version bigint, p_expected_settings_version bigint, p_expected_customer_version bigint, p_invoice_id uuid'
     or pg_catalog.pg_get_function_result('tmpos_invoice_issue.m7b_invoice_issue(text, uuid, uuid, uuid, bigint, bigint, bigint, uuid)'::regprocedure)
        is distinct from 'TABLE(o_outcome text, o_tenant_id uuid, o_store_id uuid, o_actor_id uuid, o_membership_id uuid, o_version bigint, o_invoice_id uuid, o_customer_id uuid, o_number bigint)'
     or pg_catalog.pg_get_function_arguments('tmpos_invoice_issue.m7b_issued_invoice_page(text, uuid, uuid, uuid, uuid, integer)'::regprocedure)
        is distinct from 'p_session_key text, p_expected_tenant uuid, p_expected_store uuid, p_after_invoice_id uuid, p_source_draft_id uuid, p_limit integer'
     or pg_catalog.pg_get_function_result('tmpos_invoice_issue.m7b_issued_invoice_page(text, uuid, uuid, uuid, uuid, integer)'::regprocedure)
        is distinct from 'TABLE(o_outcome text, o_tenant_id uuid, o_store_id uuid, o_invoice_id uuid, o_number bigint, o_source_draft_id uuid, o_customer_id uuid, o_customer_name text, o_currency text, o_total_cents bigint, o_issued_at text, o_snapshot_version integer)'
     or pg_catalog.pg_get_function_arguments('tmpos_invoice_issue.m7b_issued_invoice_get(text, uuid, uuid, uuid)'::regprocedure)
        is distinct from 'p_session_key text, p_expected_tenant uuid, p_expected_store uuid, p_invoice_id uuid'
     or pg_catalog.pg_get_function_result('tmpos_invoice_issue.m7b_issued_invoice_get(text, uuid, uuid, uuid)'::regprocedure)
        is distinct from 'TABLE(o_outcome text, o_tenant_id uuid, o_store_id uuid, o_invoice_id uuid, o_number bigint, o_snapshot_version integer, o_issued_at text, o_source_draft_id uuid, o_source_draft_version bigint, o_settings_version bigint, o_legal_name text, o_store_name text, o_postal_address text, o_tax_registration_id text, o_customer_id uuid, o_customer_name text, o_customer_version bigint, o_currency text, o_line_count integer, o_subtotal_cents bigint, o_tax_mode text, o_tax_rate integer, o_tax_cents bigint, o_total_cents bigint, o_position integer, o_description text, o_quantity bigint, o_unit_price_cents bigint, o_line_total_cents bigint)' then
    raise exception 'migration 034 refused: a function of schema tmpos_invoice_issue is not the one its section declares (language, security, volatility, settings, owner, comment, arguments or result: %)', coalesce(v_bad, 'a signature')
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (c)
  select pg_catalog.string_agg(pg_catalog.format('%s %s:%s', p.proname, g.grantee::regrole::text, g.privilege_type), ', ')
    into v_bad
    from pg_catalog.pg_proc p,
         pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g
   where p.pronamespace = 'tmpos_invoice_issue'::regnamespace
     and not (g.privilege_type = 'EXECUTE' and not g.is_grantable and g.grantor = p.proowner
              and (g.grantee = p.proowner or (p.oid = any (v_routines) and g.grantee = 'tmpos_app'::regrole)));
  if v_bad is not null
     or exists (select 1 from pg_catalog.pg_proc p
                 where p.pronamespace = 'tmpos_invoice_issue'::regnamespace
                   and (select pg_catalog.count(*)
                          from pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g)
                       <> case when p.oid = any (v_routines) then 2 else 1 end) then
    raise exception 'migration 034 refused: an unexpected grant remains on a function of schema tmpos_invoice_issue, or an entry is missing (%)', coalesce(v_bad, 'none listed')
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (d)
  select pg_catalog.string_agg(distinct r.rolname::text || ' ' || p.proname::text, ', ') into v_bad
    from pg_catalog.pg_roles r
    join pg_catalog.pg_roles x on pg_catalog.pg_has_role(r.oid, x.oid, 'MEMBER')
    cross join pg_catalog.pg_proc p
   where p.pronamespace = 'tmpos_invoice_issue'::regnamespace
     and (r.rolname = any (array['tmpos_audit_writer', 'anon', 'authenticated']::name[])
          or (r.rolname = 'tmpos_app' and not (p.oid = any (v_routines))))
     and pg_catalog.has_function_privilege(x.oid, p.oid, 'EXECUTE');
  if v_bad is not null
     or exists (select 1 from pg_catalog.unnest(v_routines) f(oid)
                 where not pg_catalog.has_function_privilege('tmpos_app', f.oid, 'EXECUTE')) then
    raise exception 'migration 034 refused: a runtime role can execute a function this file does not grant it, or tmpos_app cannot execute a routine (%)', coalesce(v_bad, 'none listed')
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  select pg_catalog.string_agg(distinct r.rolname::text, ', ') into v_bad
    from pg_catalog.pg_roles r
    join pg_catalog.pg_roles x on pg_catalog.pg_has_role(r.oid, x.oid, 'MEMBER')
    cross join pg_catalog.unnest(v_tables) as t(oid)
   where r.rolname = any (array['tmpos_app', 'tmpos_audit_writer', 'anon', 'authenticated']::name[])
     and (pg_catalog.has_table_privilege(x.oid, t.oid,
            'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'
            operator(pg_catalog.||) case when pg_catalog.current_setting('server_version_num')::integer >= 170000
                                         then ', MAINTAIN' else '' end)
          or pg_catalog.has_any_column_privilege(x.oid, t.oid, 'SELECT, INSERT, UPDATE, REFERENCES'));
  if v_bad is not null
     or exists (select 1 from pg_catalog.pg_class c
                 where c.oid = any (v_tables) and (not c.relrowsecurity or c.relforcerowsecurity))
     or exists (select 1 from pg_catalog.pg_policy y where y.polrelid = any (v_tables)) then
    raise exception 'migration 034 refused: % holds a privilege on a table of schema tmpos_invoice_issue, or a table''s row security is not enabled without policy and unforced', coalesce(v_bad, 'no role')
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- Exact ACLs, 028's form: no grantee but the owner on any new table (a default ACL would otherwise pass the checks above for
  -- any role they do not name), and no column-level grant at all.
  select pg_catalog.string_agg(pg_catalog.format('%s %s:%s', c.relname, g.grantee::regrole::text, g.privilege_type), ', ')
    into v_bad
    from pg_catalog.pg_class c,
         pg_catalog.aclexplode(coalesce(c.relacl, pg_catalog.acldefault('r', c.relowner))) g
   where c.oid = any (v_tables)
     and g.grantee <> c.relowner;
  if v_bad is not null
     or exists (select 1 from pg_catalog.pg_attribute t where t.attrelid = any (v_tables) and t.attacl is not null) then
    raise exception 'migration 034 refused: a table of schema tmpos_invoice_issue carries a grant beyond its owner''s, or a column carries a grant (%)', coalesce(v_bad, 'a column grant')
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (e)
  select pg_catalog.string_agg(distinct r.rolname::text, ', ') into v_bad
    from pg_catalog.pg_roles r
    cross join (
      select n.nspowner as owner from pg_catalog.pg_namespace n where n.oid = 'tmpos_invoice_issue'::regnamespace
      union
      select p.proowner from pg_catalog.pg_proc p where p.pronamespace = 'tmpos_invoice_issue'::regnamespace
      union
      select c.relowner from pg_catalog.pg_class c where c.relnamespace = 'tmpos_invoice_issue'::regnamespace
    ) o
   where r.rolname = any (array['tmpos_app', 'tmpos_audit_writer', 'anon', 'authenticated']::name[])
     and pg_catalog.pg_has_role(r.oid, o.owner, 'MEMBER');
  if v_bad is not null then
    raise exception 'migration 034 refused: % is a member of the owner of schema tmpos_invoice_issue or of an object in it', v_bad
      using errcode = 'object_not_in_prerequisite_state',
            hint = 'membership hands a role everything the owner holds, including a direct write of every issued invoice';
  end if;

  -- (f) tgtype: ROW 1 + BEFORE 2 + INSERT 4 + DELETE 8 + UPDATE 16 = 31; BEFORE 2 + TRUNCATE 32 (statement) = 34; the commit
  -- check ROW 1 + INSERT 4 = 5 (AFTER).
  select pg_catalog.string_agg(pg_catalog.format('%s.%s:%s:%s:%s', g.tgrelid::regclass::text, g.tgname, g.tgfoid::regprocedure::text,
                                                 g.tgtype, g.tgenabled), ', '
                               order by g.tgrelid::regclass::text collate "C", g.tgname::text collate "C")
    into v_bad
    from pg_catalog.pg_trigger g
   where g.tgrelid = any (v_tables) and not g.tgisinternal;
  if v_bad is distinct from
     'tmpos_invoice_issue.issued_invoice.trg_issued_invoice_commit_check:tmpos_invoice_issue.m7b_issued_invoice_commit_check():5:A, tmpos_invoice_issue.issued_invoice.trg_issued_invoice_guard:tmpos_invoice_issue.m7b_issued_invoice_guard():31:A, tmpos_invoice_issue.issued_invoice.trg_issued_invoice_truncate:tmpos_invoice_issue.m7b_issue_truncate_guard():34:A, tmpos_invoice_issue.issued_invoice_line.trg_issued_invoice_line_guard:tmpos_invoice_issue.m7b_issued_invoice_line_guard():31:A, tmpos_invoice_issue.issued_invoice_line.trg_issued_invoice_line_truncate:tmpos_invoice_issue.m7b_issue_truncate_guard():34:A, tmpos_invoice_issue.store_invoice_counter.trg_store_invoice_counter_guard:tmpos_invoice_issue.m7b_invoice_counter_guard():31:A, tmpos_invoice_issue.store_invoice_counter.trg_store_invoice_counter_truncate:tmpos_invoice_issue.m7b_issue_truncate_guard():34:A, tmpos_invoice_issue.store_issuing_settings.trg_store_issuing_settings_guard:tmpos_invoice_issue.m7b_issuing_settings_guard():31:A, tmpos_invoice_issue.store_issuing_settings.trg_store_issuing_settings_truncate:tmpos_invoice_issue.m7b_issue_truncate_guard():34:A'
     or exists (select 1 from pg_catalog.pg_trigger g
                 where g.tgrelid = any (v_tables) and not g.tgisinternal
                   and (not (g.tgattr = ''::pg_catalog.int2vector) or g.tgqual is not null))
     or (select pg_catalog.count(*) from pg_catalog.pg_trigger g where g.tgfoid = v_v2) <> 1
     or (select pg_catalog.string_agg(g.tgname::text, ', ' order by g.tgname::text collate "C")
           from pg_catalog.pg_trigger g
          where g.tgrelid = 'tmpos_invoice_draft.invoice_draft'::regclass and not g.tgisinternal)
        is distinct from 'trg_invoice_draft_immutable, trg_invoice_draft_terminal'
     or (select pg_catalog.string_agg(g.tgname::text, ', ' order by g.tgname::text collate "C")
           from pg_catalog.pg_trigger g
          where g.tgrelid = 'tmpos_invoice_draft.invoice_draft_line'::regclass and not g.tgisinternal)
        is distinct from 'trg_invoice_draft_line_terminal'
     or not exists (select 1 from pg_catalog.pg_trigger g
                     where g.tgrelid = 'tmpos_invoice_draft.invoice_draft'::regclass
                       and g.tgname = 'trg_invoice_draft_terminal'
                       and g.tgfoid = v_v2 and g.tgtype = 31 and g.tgenabled = 'A'
                       and g.tgattr = ''::pg_catalog.int2vector and g.tgqual is null and not g.tgisinternal
                       and pg_catalog.obj_description(g.oid, 'pg_trigger') = 'Phase 4.0 M7b (migration 033): the terminal discarded state of an invoice draft header (tmpos_invoice_discard.m7b_invoice_draft_terminal). Enabled ALWAYS.')
     or not exists (select 1 from pg_catalog.pg_trigger g
                     where g.tgrelid = 'tmpos_invoice_draft.invoice_draft'::regclass
                       and g.tgname = 'trg_invoice_draft_immutable'
                       and g.tgfoid = 'tmpos_invoice_draft.m7b_invoice_draft_immutable()'::regprocedure
                       and g.tgtype = 19 and g.tgenabled = 'A' and g.tgattr = ''::pg_catalog.int2vector and g.tgqual is null)
     or not exists (select 1 from pg_catalog.pg_trigger g
                     where g.tgrelid = 'tmpos_invoice_draft.invoice_draft_line'::regclass
                       and g.tgname = 'trg_invoice_draft_line_terminal'
                       and g.tgfoid = 'tmpos_invoice_discard.m7b_invoice_draft_line_terminal()'::regprocedure
                       and g.tgtype = 31 and g.tgenabled = 'A' and g.tgattr = ''::pg_catalog.int2vector and g.tgqual is null)
     or exists (select 1 from pg_catalog.pg_trigger g
                 where g.tgfoid = 'tmpos_invoice_discard.m7b_invoice_draft_terminal()'::regprocedure) then
    raise exception 'migration 034 refused: a trigger of the issuing tables or of the drafts is not exactly the one this file declares (%)', coalesce(v_bad, 'the drafts'' triggers')
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (g)
  if (select pg_catalog.count(*) from pg_catalog.pg_constraint k
       where k.conrelid = 'tmpos_invoice_draft.invoice_draft'::regclass and k.conname = 'invoice_draft_status_chk' and k.contype = 'c'
         and k.convalidated
         and pg_catalog.pg_get_constraintdef(k.oid) = 'CHECK ((status = ANY (ARRAY[''draft''::text, ''discarded''::text, ''issued''::text])))') <> 1
     or (select pg_catalog.string_agg(pg_catalog.format('%s:%s', c.relname, c.relkind), ', ' order by c.relname)
           from pg_catalog.pg_class c where c.relnamespace = 'tmpos_invoice_draft'::regnamespace)
        is distinct from
        'invoice_draft:r, invoice_draft_customer_idx:i, invoice_draft_line:r, invoice_draft_line_pkey:i, invoice_draft_open_page_idx:i, invoice_draft_page_idx:i, invoice_draft_pkey:i, invoice_draft_scope_key:i' then
    raise exception 'migration 034 refused: invoice_draft_status_chk is not the widened CHECK, or schema tmpos_invoice_draft does not hold exactly 033''s relations'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (h)
  if (select pg_catalog.count(*) from pg_catalog.pg_attribute a
       where a.attrelid = 'public.audit_event'::regclass
         and a.attname in ('subject_issued_invoice_id', 'subject_store_id') and not a.attisdropped
         and a.atttypid = 'pg_catalog.uuid'::regtype and not a.attnotnull and not a.atthasdef) <> 2
     or pg_catalog.pg_get_indexdef(pg_catalog.to_regclass('public.idx_audit_event_subject_issued_invoice_occurred'))
        is distinct from 'CREATE INDEX idx_audit_event_subject_issued_invoice_occurred ON public.audit_event USING btree (subject_issued_invoice_id, occurred_at DESC) WHERE (subject_issued_invoice_id IS NOT NULL)'
     or pg_catalog.pg_get_indexdef(pg_catalog.to_regclass('public.idx_audit_event_subject_store_occurred'))
        is distinct from 'CREATE INDEX idx_audit_event_subject_store_occurred ON public.audit_event USING btree (subject_store_id, occurred_at DESC) WHERE (subject_store_id IS NOT NULL)'
     or not pg_catalog.has_column_privilege('tmpos_audit_writer', 'public.audit_event', 'subject_issued_invoice_id', 'INSERT')
     or not pg_catalog.has_column_privilege('tmpos_audit_writer', 'public.audit_event', 'subject_store_id', 'INSERT')
     or exists (select 1 from pg_catalog.pg_attribute a
                 where a.attrelid = 'public.audit_event'::regclass and a.attacl is not null) then
    raise exception 'migration 034 refused: the audit subjects are not the nullable uuids, indexes and writer reach section 9 declares, or a column of the audit table carries a grant'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (i)
  if (select pg_catalog.count(*) from pg_catalog.pg_constraint k
       where k.conrelid = any (v_tables) and k.contype = 'f' and k.confdeltype = 'r' and k.confupdtype = 'r' and k.convalidated) <> 7
     or exists (select 1 from pg_catalog.pg_constraint k
                 where k.conrelid = any (v_tables) and k.contype = 'f' and (k.confdeltype <> 'r' or k.confupdtype <> 'r'))
     or not exists (select 1 from pg_catalog.pg_trigger g
                     where g.tgrelid = 'tmpos_invoice_issue.issued_invoice'::regclass
                       and g.tgname = 'trg_issued_invoice_commit_check' and g.tgdeferrable and g.tginitdeferred
                       and g.tgconstraint <> 0) then
    raise exception 'migration 034 refused: a foreign key of the issuing tables is not ON DELETE RESTRICT ON UPDATE RESTRICT, or the commit check is not deferred'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (j)
  if (select pg_catalog.string_agg(d.refobjid::regprocedure::text, ', ' order by d.refobjid::regprocedure::text collate "C")
        from pg_catalog.pg_depend d
       where d.classid = 'pg_catalog.pg_proc'::regclass and d.objid = v_anchor and d.objsubid = 0
         and d.refclassid in ('pg_catalog.pg_proc'::regclass, 'pg_catalog.pg_class'::regclass)
         and d.refobjsubid = 0 and d.deptype = 'n')
     is distinct from
     'tmpos_invoice_discard.m7b_invoice_draft_discard(text,uuid,uuid,uuid,bigint), tmpos_invoice_discard.m7b_invoice_draft_get_v2(text,uuid,uuid,uuid), tmpos_invoice_discard.m7b_invoice_draft_line_terminal(), tmpos_invoice_discard.m7b_invoice_draft_page_v2(text,uuid,uuid,uuid,integer), tmpos_invoice_discard.m7b_invoice_draft_terminal()' then
    raise exception 'migration 034 refused: the rollback-order anchor does not record exactly one dependency on each 033 function it names'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$$;

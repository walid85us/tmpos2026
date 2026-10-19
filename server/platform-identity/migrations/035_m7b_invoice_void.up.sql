-- Phase 4.0 M7b — voiding an issued store invoice: an append-only void record per issued invoice in a schema of its own, its
-- ENABLE ALWAYS guards, one session-bound void routine that decides Invoices Approve with Customers View and a recent sign-in
-- on the database clock, lifecycle-aware v2 issued reads that replace 034's for the runtime login, and the rollback-order
-- anchor that keeps 034 from rolling back under it (M7B-INVOICES-VOID-P1; owner decisions D-VOID-1..6; ADR-51;
-- docs/phase-4/13 §5 A, C, D, H; DA-118, DA-119; G-IAM, G-AUDIT)
-- Migration: 035_m7b_invoice_void (UP)
--
-- SCOPE / TRUTH (binding):
--   - ONE SCHEMA, ONE TABLE, SIX FUNCTIONS, TWO TRIGGERS, SIX TMPOS_APP PRIVILEGE CHANGES, ONE COLUMN COMMENT RE-WORDED.
--     Schema tmpos_invoice_void (owned by the applying principal; USAGE to tmpos_app alone, beside its owner's) holds: the
--     table issued_invoice_void (row security
--     on, no policy, NO privilege for any runtime role); the routines m7b_invoice_void, m7b_issued_invoice_page_v2 and
--     m7b_issued_invoice_get_v2 (the only three granted, EXECUTE to tmpos_app); and, granted to nobody, the trigger functions
--     m7b_invoice_void_guard and m7b_invoice_void_truncate_guard and the anchor m7b_invoice_void_prerequisites. tmpos_app gains
--     USAGE on the schema and EXECUTE on the three routines and LOSES its EXECUTE on 034's m7b_issued_invoice_page and
--     m7b_issued_invoice_get, which stay in place, unaltered (033's precedent for its reads). NO ROLE, MEMBERSHIP, POLICY OR
--     TYPE; no column added to any existing table; no row of any existing table written; no 001-034 routine, trigger, CHECK
--     or index altered. The one foreign key adds PostgreSQL's two internal RESTRICT triggers on 034's issued_invoice (034's
--     own checks filter internal triggers out) and a dependency that blocks 034's drop. The comment on 034's audit column
--     public.audit_event.subject_issued_invoice_id is re-worded to name the void beside the issue (the column, its index and
--     its grants unchanged); the down restores 034's exact text.
--   - THE LIFECYCLE (D-VOID-1, contract §3). An issued invoice is 'issued' until a void record names it, then 'voided',
--     terminally: no path changes or removes a void record, so there is no unvoid. Its lifecycle version is 1 while issued
--     and 2 once voided — derived from the record's presence, never stored. The number, the snapshot (snapshot_version 1),
--     the lines, the counter and the source draft are never read for writing or changed: a void records no refund, credit,
--     tax reversal or erasure.
--   - THE RECORD, tmpos_invoice_void.issued_invoice_void(invoice_id PK, tenant_id, store_id, reason_code, voided_at, voided_by):
--     one row per voided invoice, the primary key the "at most one void" backstop (the routine decides it first, under its
--     lock); a composite foreign key (invoice_id, tenant_id, store_id) onto 034's issued_invoice_scope_key, ON DELETE
--     RESTRICT ON UPDATE RESTRICT; reason_code one of the six closed codes (contract §2, in that order: issued_in_error,
--     wrong_customer, wrong_lines_or_amounts, wrong_seller_details, duplicate, other — no free text exists anywhere);
--     voided_at the database clock after the routine's last lock; voided_by the derived actor (plain uuid, no FK, no read
--     returns it).
--   - THE VOID, m7b_invoice_void(key, store, invoice, expected tenant, expected version, reason code): plpgsql, SECURITY
--     DEFINER, VOLATILE, READ COMMITTED only. THE ORDER OF DECISIONS:
--       0. every argument (invalid_parameter_value, fixed text, never the value: the session key's shape and the store,
--          invoice and expected tenant together, as 034 words it; the expected version, 1 to 9007199254740990; the reason
--          code, one of the six), then READ COMMITTED (55000);
--       1. the caller, derived as 034's issue derives it, 034 up :1668-1784 restated statement for statement (no 034 helper
--          does the locked derivation; 034's STABLE, unlocked m7b_issue_store_reader is never called; the one addition is
--          the session row's authenticated_at in the FOR SHARE read): the
--          unlocked live/issuer pre-check, 016's hold, the session and mint-ledger rows FOR SHARE (the session row's
--          authenticated_at read here), the issuer key FOR SHARE, the clock, the standing digest, an active or trialing
--          account, EXACTLY ONE store grant at p_store_id on an active or trialing tenant and store, still the actor's
--          active membership, the store row FOR SHARE -> 'refused';
--       2. the levels, UNLOCKED: Invoices >= approve AND Customers >= view (store_owner Full; manager, technician, sales_staff
--          the stored level, else the catalog default; any other role) -> 'refused';
--       3. the grant's tenant is not p_expected_tenant -> 'tenant_mismatch';
--       4. THE ISSUED HEADER FOR UPDATE by invoice id, derived tenant and path store only -> missing, another store's and
--          another tenant's alike 'not_found' (a locking read fires none of 034's row triggers);
--       5. for manager, technician and sales_staff: 030's key pg_advisory_xact_lock_shared(530030, hashtext(tenant || '/' ||
--          role)) exactly as 034's issue takes it, then both levels re-read by plain SELECTs -> 'refused'. Top-level
--          statements of the outermost block, never inside an exception block;
--       6. AFTER THE LAST LOCK WAIT, on one clock_timestamp(): the session's expiry (as 034's issue re-checks it after its
--          locks) and the recent sign-in from the session row's authenticated_at (bigint epoch ms) -> 'refused' when it is
--          NULL, later than the clock + 5000 ms (sessions.ts MAX_CLOCK_SKEW_MS) or older than 600000 ms (RECENT_AUTH_MAX_AGE_MS,
--          postgresSessionStore.ts authenticationFresh's comparator: exactly at the bound it still holds);
--       7. A SEPARATE STATEMENT, after every lock: a void record of p_invoice_id exists -> 'invalid_state' (terminal state
--          before version, 034's issue's precedence). Under READ COMMITTED it sees a void that committed while step 4 waited;
--          folded into step 4's statement it would judge the pre-wait snapshot and fall through to the primary key;
--       8. p_expected_version is not 1 -> 'conflict';
--       9. clock_timestamp() as voided_at; ONE insert (tenant and store the header's) inside one exception block that maps
--          every constraint refusal to fixed text; the row count and a verification read;
--      10. ('applied', tenant, store, actor, membership, p_expected_version + 1 = 2, invoice id).
--     NOTHING IS WRITTEN BEFORE THE LAST REFUSAL (DA-36). It reads or locks no draft, settings, customer, counter or line row,
--     and writes no audit, outbox or idempotency row: the runtime writes the one audit record and the completion in the same
--     command transaction (D-VOID-4). SEALED AND ROLLED BACK (the update-mode kernel): 'applied' (200), 'invalid_state' (409)
--     and 'conflict' (409 write_conflict, unreachable through HTTP: the planner pins version 1) are sealed; 'not_found' (404),
--     'tenant_mismatch' (409) and 'refused' (503) roll the command transaction back, the lease kept.
--   - THE READS. m7b_issued_invoice_page_v2 and m7b_issued_invoice_get_v2 are SQL-standard bodies (BEGIN ATOMIC), STABLE,
--     SECURITY DEFINER, that select 034's own page and get WITH ORDINALITY, left-join the void record on all three keys and
--     order by the ordinality: exactly 034's answer row for row and in 034's order — its authority, words, limits, cursor,
--     sourceDraft branch and raises are 034's own, not restated — plus the lifecycle columns: the page's o_status ('issued'
--     or 'voided' on an 'invoice' row, NULL on a refusal row); the get's o_status, o_voided_at (034's o_issued_at encoding)
--     and o_reason_code on every 'line' row, all three NULL on a refusal row and ('issued', NULL, NULL) for a never-voided
--     invoice. One statement, one snapshot: an invoice is seen issued or voided, never a mixture. Neither returns voided_by.
--   - THE GUARDS (ENABLE ALWAYS, so a session running as a replica meets them too; SECURITY INVOKER, pinned, granted to
--     nobody; refusals restrict_violation with fixed text, never a value of the row; an undeclared firing raises
--     triggered_action_exception): trg_issued_invoice_void_guard, BEFORE INSERT OR UPDATE OR DELETE FOR EACH ROW, refuses
--     every update and delete (a no-op included) and admits an insert only for an issued invoice of the same tenant and
--     store with voided_at present and not before its issued_at — the header read WITHOUT a row lock: 034's ALWAYS guards
--     refuse every update, delete and truncate of an issued header, so a committed header once seen stays as seen, the
--     routine already holds it FOR UPDATE, and the foreign key's own check takes FOR KEY SHARE where it fires (a lock here
--     would add a wait and nothing else; in a replica session, where the foreign key does not fire, this read still runs);
--     trg_issued_invoice_void_truncate, BEFORE TRUNCATE FOR EACH STATEMENT, refuses every truncate. NOT COVERED (033's and
--     034's boundary): the table owner disabling or dropping a trigger, a replaced function, DDL and a superuser.
--   - LOCK ORDER. The void: fence -> 016's hold -> session and mint-ledger rows FOR SHARE -> issuer key FOR SHARE ->
--     membership (read) and store row FOR SHARE -> [3] the level table, plain read -> THE ISSUED HEADER FOR UPDATE (the slot
--     where 034's issue takes the draft header) -> [5] key 530030 SHARED (editable roles) -> the levels, plain read -> the
--     void table, plain read -> the void INSERT (its foreign-key check takes FOR KEY SHARE on the header this transaction
--     already holds FOR UPDATE: no wait) -> (the runtime) audit record, completion -> COMMIT. It never reads or locks a draft,
--     settings, customer, counter or line row. THE PER-PATH ARGUMENT (doc 13 §5 C): the prefix is the issue's, in the same
--     order; no existing writer locks a committed issued header (034's line guard takes FOR SHARE only on the issue's own
--     uncommitted header), so only another void of the same invoice waits on this header, before either takes the key; 034's
--     RESTRICT foreign keys lock issued headers FOR KEY SHARE only on a delete or key update of a draft, store or customer
--     row, which no routine performs; key 530030 SHARED is compatible with the issue's, the edit's, the discard's and the
--     save's; its EXCLUSIVE holders (030's and 032's level-writer triggers) hold only their role and version rows and never
--     wait on an issued header. FOR UPDATE (not FOR NO KEY UPDATE) also blocks FOR KEY SHARE: today the only key referencing
--     an issued header besides this file's is 034's line key, checked only on the issue's own uncommitted header; a future
--     table referencing issued_invoice would queue its inserts behind a void's transaction, and this argument must then be
--     redone. DEADLOCK FREEDOM IS NOT CLAIMED OR PROVEN: composed owner sessions, direct definer calls
--     (DA-118), migrations' ACCESS EXCLUSIVE locks and future writers are outside the argument; a deadlock (40P01) or a wait
--     past the runtime's lock timeout raises, rolls back and answers 503 with the lease kept.
--   - APPLY: a maintenance window — ACCESS EXCLUSIVE until COMMIT, before anything is read, on public.store first, then 034's
--     role, customer and draft tables, then 034's four issuing tables in 034's order (issued_invoice among them), then
--     public.audit_event last (a void writer takes the store row, the issued header, the void record, then the audit record);
--     then READ COMMITTED, 034's objects this file relies on exactly as 034 left them (the scope
--     key, the page and get with their signatures and tmpos_app's EXECUTE, the audit column's comment), none of this file's
--     objects, the runtime roles, and the applier's reach (EXECUTE on 034's page and get and on 016's hold and admission
--     read; owner, or a member of the owner, of every table the definers read or lock, none with forced row security), else
--     a fixed-text refusal (55000, 42501). Changes no existing row. Object checks only, as 034's: no ledger clause — the
--     trusted executor and the startup preflight own the ledger (a suite's raw re-apply runs this over a shorter one).
--   - OPERATIONS: APPLY AND ROLLBACK RUN WITH THE TENANT RUNTIME STOPPED, as 034's did. A 034-built runtime left running across
--     the apply answers 503 on the issued reads (tmpos_app no longer executes 034's page and get: it fails closed and never
--     conceals a void); a 035-built runtime left running across the rollback meets dropped v2 functions (503). The startup
--     preflight refuses a mismatched start either way.
--   - DEPLOY AND ROLLBACK: FAIL CLOSED BOTH WAYS. The startup preflight pins the ledger (001-035) and the grants (034's page
--     and get EXECUTE gone, this schema's USAGE and three EXECUTE lines added), so a 034-built runtime refuses a 035 database
--     and a 035-built runtime a 034 one. ROLL 035 BACK FIRST: while it is applied 034's down fails closed and rolls back
--     whole — 55000 at 034's own data guard while any issuing data exists, otherwise 2BP01 at its drops (this file's foreign
--     key onto issued_invoice, the v2 reads' and the anchor's recorded dependencies on 034's page and get). 035's down
--     refuses, changing nothing, while any void record or any audit record of action store.invoice.void exists, and no path
--     deletes a void record: AFTER THE FIRST VOID THE ROLLBACK IS ONE-WAY.
--   - THE CLOCK. voided_at >= issued_at holds in normal operation (the void's clock is read after the issue committed). A
--     database clock stepped backwards — or a failover to a host whose clock is behind — makes a void of an invoice issued
--     just before fail closed at the guard (integrity_constraint_violation: 503, nothing written) until the clock passes the
--     invoice's issued_at; the sign-in window is judged on the same clock.
--   - WHAT THIS DOES NOT DEFEND (doc 13 §5 I; none claimed closed): DA-118's shape for the void — a runtime-role holder with a
--     live store key whose sign-in is fresh can call m7b_invoice_void directly, voiding an invoice without the route's audit
--     record, idempotency completion or HTTP checks (the routine's own authority and sign-in checks still bind it); the fixed
--     routines executable by tmpos_app remain a direct-call trust limitation (DA-118/119), not newly proven application
--     authorization; forged audit rows through tmpos_audit_writer (G-AUDIT; one of action store.invoice.void makes this
--     down refuse: fails safe); the table owner's paths above; retention and privacy of void records (no erasure).
--   - NO SECRET, NO DYNAMIC SQL, NO EXTENSION, NO TEMPORARY OBJECT, NO BACKFILL. Every name is schema-qualified; every routine
--     and trigger function pins its search_path.
--
-- Reversible via 035_m7b_invoice_void.down.sql, which refuses while any void record or void audit record exists and otherwise
-- restores the 034 catalog exactly, tmpos_app's EXECUTE on 034's page and get included. Roll 035 back before 034.
--
-- Assumes 001-034 are applied. A future managed apply targets the complete contiguous chain through the newest committed
-- migration — now 001-035; this file authorizes no apply.

-- =============================================================================
-- 1) This transaction's settings
-- =============================================================================
set local search_path = pg_catalog, pg_temp;
set local row_security = off;

-- =============================================================================
-- 2) The locks, in the writers' order: the first statements after the settings, before any check or any change
-- =============================================================================
-- public.store first (every void writer takes its store row FOR SHARE before anything this file locks), 034's role, customer
-- and draft tables in 034's order, 034's four issuing tables in 034's order, public.audit_event last (the command
-- transaction writes the audit record after the void). Nothing is read or checked before them, not even the catalog. A LOCK
-- naming a missing table or schema raises undefined_table or invalid_schema_name; the block's handler turns either into this
-- file's refusal (55000), the block's locks released first.
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
  lock table public.audit_event in access exclusive mode;
exception
  when undefined_table or invalid_schema_name then
    raise exception 'migration 035 refused: public.store, tmpos_role.tenant_role_level, tmpos_role_edit.role_level_version, tmpos_customer.customer, tmpos_invoice_draft.invoice_draft, tmpos_invoice_draft.invoice_draft_line, public.audit_event or a table of tmpos_invoice_issue is missing (migrations 002, 017, 020, 021, 028 and 034 must be applied first)'
      using errcode = 'object_not_in_prerequisite_state';
end
$$;

-- =============================================================================
-- 3) Preconditions: READ COMMITTED, then the database exactly at 034 for every object this file relies on
-- =============================================================================
-- Under READ COMMITTED the checks below and the postcondition see every row committed before the locks were granted (017's
-- reason).
do $$
begin
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'migration 035 refused: it must run under READ COMMITTED, so that its checks see every committed row'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$$;

do $$
declare
  v_me oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user);
begin
  -- Nothing of this file exists yet: it is applied once, over a chain that has never held it.
  if pg_catalog.to_regnamespace('tmpos_invoice_void') is not null then
    raise exception 'migration 035 refused: schema tmpos_invoice_void already exists'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- The runtime roles this file grants to and revokes from, checked before any ::regrole cast below can raise.
  if (select pg_catalog.count(*) from pg_catalog.pg_roles r
       where r.rolname = any (array['tmpos_app', 'tmpos_audit_writer', 'anon', 'authenticated']::name[])) <> 4 then
    raise exception 'migration 035 refused: the runtime roles tmpos_app, tmpos_audit_writer, anon and authenticated must exist (migration 005 and the platform''s two client roles)'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- 034, exactly, for what this file builds on: the issued header with its scope key and issue time, its three triggers in
  -- their exact shape and mode (the header's immutability, on which the guard's lock-free read rests), and its page and get
  -- with their exact arguments and results, owned by the applying principal, each with its complete ACL exactly 034's two
  -- entries (the owner's EXECUTE and tmpos_app's, granted by the owner, non-grantable) — so the revokes below are not silent
  -- no-ops and the rollback's grants restore the ACLs byte for byte. tgtype: ROW 1 + BEFORE 2 + INSERT 4 + DELETE 8 + UPDATE
  -- 16 = 31; BEFORE 2 + TRUNCATE 32 = 34; the commit check ROW 1 + INSERT 4 = 5 (AFTER).
  if pg_catalog.to_regprocedure('tmpos_invoice_issue.m7b_issued_invoice_page(text, uuid, uuid, uuid, uuid, integer)') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_issue.m7b_issued_invoice_get(text, uuid, uuid, uuid)') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_issue.m7b_issued_invoice_guard()') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_issue.m7b_issue_truncate_guard()') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_issue.m7b_issued_invoice_commit_check()') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_issue.m7b_invoice_issue_prerequisites()') is null
     or (select pg_catalog.count(*) from pg_catalog.pg_constraint k
          where k.conrelid = 'tmpos_invoice_issue.issued_invoice'::regclass and k.conname = 'issued_invoice_scope_key'
            and k.contype = 'u' and k.convalidated
            and pg_catalog.pg_get_constraintdef(k.oid) = 'UNIQUE (invoice_id, tenant_id, store_id)') <> 1
     or not exists (select 1 from pg_catalog.pg_attribute a
                     where a.attrelid = 'tmpos_invoice_issue.issued_invoice'::regclass and a.attname = 'issued_at'
                       and not a.attisdropped and a.atttypid = 'pg_catalog.timestamptz'::regtype and a.attnotnull)
     or (select pg_catalog.string_agg(pg_catalog.format('%s:%s:%s:%s', g.tgname, g.tgfoid::regprocedure::text, g.tgtype, g.tgenabled), ', '
                                     order by g.tgname::text collate "C")
           from pg_catalog.pg_trigger g
          where g.tgrelid = 'tmpos_invoice_issue.issued_invoice'::regclass and not g.tgisinternal
            and g.tgattr = ''::pg_catalog.int2vector and g.tgqual is null)
        is distinct from 'trg_issued_invoice_commit_check:tmpos_invoice_issue.m7b_issued_invoice_commit_check():5:A, trg_issued_invoice_guard:tmpos_invoice_issue.m7b_issued_invoice_guard():31:A, trg_issued_invoice_truncate:tmpos_invoice_issue.m7b_issue_truncate_guard():34:A'
     or (select pg_catalog.count(*) from pg_catalog.pg_trigger g
          where g.tgrelid = 'tmpos_invoice_issue.issued_invoice'::regclass and not g.tgisinternal) <> 3 then
    raise exception 'migration 035 refused: migration 034 is not applied exactly (the issued header''s scope key, issue time or triggers in their exact shape and mode, or the issued reads)'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if pg_catalog.pg_get_function_arguments('tmpos_invoice_issue.m7b_issued_invoice_page(text, uuid, uuid, uuid, uuid, integer)'::regprocedure)
        is distinct from 'p_session_key text, p_expected_tenant uuid, p_expected_store uuid, p_after_invoice_id uuid, p_source_draft_id uuid, p_limit integer'
     or pg_catalog.pg_get_function_result('tmpos_invoice_issue.m7b_issued_invoice_page(text, uuid, uuid, uuid, uuid, integer)'::regprocedure)
        is distinct from 'TABLE(o_outcome text, o_tenant_id uuid, o_store_id uuid, o_invoice_id uuid, o_number bigint, o_source_draft_id uuid, o_customer_id uuid, o_customer_name text, o_currency text, o_total_cents bigint, o_issued_at text, o_snapshot_version integer)'
     or pg_catalog.pg_get_function_arguments('tmpos_invoice_issue.m7b_issued_invoice_get(text, uuid, uuid, uuid)'::regprocedure)
        is distinct from 'p_session_key text, p_expected_tenant uuid, p_expected_store uuid, p_invoice_id uuid'
     or pg_catalog.pg_get_function_result('tmpos_invoice_issue.m7b_issued_invoice_get(text, uuid, uuid, uuid)'::regprocedure)
        is distinct from 'TABLE(o_outcome text, o_tenant_id uuid, o_store_id uuid, o_invoice_id uuid, o_number bigint, o_snapshot_version integer, o_issued_at text, o_source_draft_id uuid, o_source_draft_version bigint, o_settings_version bigint, o_legal_name text, o_store_name text, o_postal_address text, o_tax_registration_id text, o_customer_id uuid, o_customer_name text, o_customer_version bigint, o_currency text, o_line_count integer, o_subtotal_cents bigint, o_tax_mode text, o_tax_rate integer, o_tax_cents bigint, o_total_cents bigint, o_position integer, o_description text, o_quantity bigint, o_unit_price_cents bigint, o_line_total_cents bigint)'
     or (select pg_catalog.count(*) from pg_catalog.pg_proc p
          where p.oid in ('tmpos_invoice_issue.m7b_issued_invoice_page(text, uuid, uuid, uuid, uuid, integer)'::regprocedure,
                          'tmpos_invoice_issue.m7b_issued_invoice_get(text, uuid, uuid, uuid)'::regprocedure)
            and p.proowner = v_me and p.prosecdef and p.provolatile = 's') <> 2
     or exists (select 1 from pg_catalog.pg_proc p
                 where p.oid in ('tmpos_invoice_issue.m7b_issued_invoice_page(text, uuid, uuid, uuid, uuid, integer)'::regprocedure,
                                 'tmpos_invoice_issue.m7b_issued_invoice_get(text, uuid, uuid, uuid)'::regprocedure)
                   and ((select pg_catalog.count(*)
                           from pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g) <> 2
                        or (select pg_catalog.count(*)
                              from pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g
                             where g.grantee = p.proowner and g.privilege_type = 'EXECUTE' and not g.is_grantable
                               and g.grantor = p.proowner) <> 1
                        or (select pg_catalog.count(*)
                              from pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g
                             where g.grantee = 'tmpos_app'::regrole and g.privilege_type = 'EXECUTE' and not g.is_grantable
                               and g.grantor = p.proowner) <> 1)) then
    raise exception 'migration 035 refused: 034''s issued page or get is not exactly as 034 left it (arguments, result, attributes, owned by the applying principal, its ACL the owner''s EXECUTE and tmpos_app''s alone)'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- 034's comment on the audit subject this file re-words (section 9), exactly — so the rollback restores it byte for byte.
  if pg_catalog.col_description('public.audit_event'::regclass,
       (select a.attnum from pg_catalog.pg_attribute a
         where a.attrelid = 'public.audit_event'::regclass and a.attname = 'subject_issued_invoice_id' and not a.attisdropped))
     is distinct from 'Phase 4.0 M7b (migration 034): the issued invoice the recorded action created (a store-scope issue, beside the draft and customer subjects). Written by the command transaction from the routine''s verified answer; never from request metadata. Plain column, no FK (audit is decoupled/append-only). Never accompanied by a seller, customer or line value.' then
    raise exception 'migration 035 refused: public.audit_event.subject_issued_invoice_id does not carry 034''s comment exactly'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- The objects the void routine restates, reads or locks (034's issue's), and the session row's sign-in time (011).
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
    raise exception 'migration 035 refused: 016''s hold or admission read, 011''s session sign-in time, 018''s mint ledger or issuer key, or 002''s tenant or membership table is missing'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if not (pg_catalog.has_function_privilege(current_user, 'tmpos_session.m5_hold_tenant_standing(text, text)', 'EXECUTE')
          and pg_catalog.has_function_privilege(current_user, 'tmpos_session.m5_admit_tenant_session_v2(text, text)', 'EXECUTE')
          and pg_catalog.has_function_privilege(current_user, 'tmpos_invoice_issue.m7b_issued_invoice_page(text, uuid, uuid, uuid, uuid, integer)', 'EXECUTE')
          and pg_catalog.has_function_privilege(current_user, 'tmpos_invoice_issue.m7b_issued_invoice_get(text, uuid, uuid, uuid)', 'EXECUTE')
          and pg_catalog.has_schema_privilege(current_user, 'public', 'USAGE')
          and pg_catalog.has_schema_privilege(current_user, 'tmpos_session', 'USAGE')
          and pg_catalog.has_schema_privilege(current_user, 'tmpos_mint', 'USAGE')
          and pg_catalog.has_schema_privilege(current_user, 'tmpos_role', 'USAGE')
          and pg_catalog.has_schema_privilege(current_user, 'tmpos_invoice_issue', 'USAGE')) then
    raise exception 'migration 035 refused: the applying principal cannot execute 034''s issued page and get, which the v2 reads call, or 016''s hold and admission read, which the void calls, or use the schemas they read'
      using errcode = 'insufficient_privilege';
  end if;
  -- 033's argument: a definer routine reads and writes only what its owner may, the foreign key needs REFERENCES on the
  -- issued header and section 9's comment needs ownership of the audit table — ownership of each table the definers read or
  -- lock covers all three.
  if exists (
    select 1
      from pg_catalog.pg_class c
     where c.oid = any (array['tmpos_session.session'::regclass, 'tmpos_mint.tenant_session'::regclass,
                              'tmpos_mint.issuer_key'::regclass, 'tmpos_role.tenant_role_level'::regclass,
                              'public.store'::regclass, 'public.tenant'::regclass, 'public.user_membership'::regclass,
                              'tmpos_invoice_issue.issued_invoice'::regclass, 'tmpos_invoice_issue.issued_invoice_line'::regclass,
                              'public.audit_event'::regclass])
       and (not pg_catalog.pg_has_role(current_user, c.relowner, 'USAGE') or c.relforcerowsecurity)) then
    raise exception 'migration 035 refused: the applying principal neither owns nor inherits the owner of a table the definers read or lock, or one has forced row security'
      using errcode = 'insufficient_privilege';
  end if;
end
$$;

-- =============================================================================
-- 4) The schema
-- =============================================================================
create schema tmpos_invoice_void;

comment on schema tmpos_invoice_void is
  'Phase 4.0 M7b (migration 035): voiding an issued invoice — the append-only void record, its guards, the void routine, the lifecycle-aware issued reads and the rollback-order anchor. Owned by this migration; tmpos_app holds USAGE and EXECUTE on the three routines only.';

revoke all on schema tmpos_invoice_void from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
grant usage on schema tmpos_invoice_void to tmpos_app;

-- =============================================================================
-- 5) The void record
-- =============================================================================
-- No index beside the primary key: the reads join by it, the routine and the guard look up by it.
create table tmpos_invoice_void.issued_invoice_void (
  invoice_id  uuid        not null,
  tenant_id   uuid        not null,
  store_id    uuid        not null,
  reason_code text        collate "C" not null,
  voided_at   timestamptz not null,
  voided_by   uuid        not null,
  constraint issued_invoice_void_pkey primary key (invoice_id),
  -- Onto 034's issued_invoice_scope_key: the voided invoice in exactly its tenant and store; no deletion or key change of an
  -- issued header can cascade through or orphan a void record.
  constraint issued_invoice_void_invoice_fkey foreign key (invoice_id, tenant_id, store_id)
    references tmpos_invoice_issue.issued_invoice (invoice_id, tenant_id, store_id) on delete restrict on update restrict,
  -- The closed list (contract §2), in its order; no free text.
  constraint issued_invoice_void_reason_code_chk check (
    reason_code in ('issued_in_error', 'wrong_customer', 'wrong_lines_or_amounts', 'wrong_seller_details', 'duplicate', 'other'))
);

comment on table tmpos_invoice_void.issued_invoice_void is
  'Phase 4.0 M7b (migration 035): append-only — one row per voided issued invoice, naming it in exactly its tenant and store, with its closed reason code, the database time of the void and the voiding actor. Its presence is the invoice''s terminal voided state (lifecycle version 2); the issued invoice, its number, snapshot and source draft are unchanged. Insert only (no update, delete or truncate). Written only by m7b_invoice_void. No read returns voided_by. No runtime role holds a privilege on it.';
comment on column tmpos_invoice_void.issued_invoice_void.voided_by is
  'Phase 4.0 M7b (migration 035): the voiding actor''s internal_user_id. Plain uuid, no FK. No read returns it.';
comment on column tmpos_invoice_void.issued_invoice_void.voided_at is
  'Phase 4.0 M7b (migration 035): the database clock (clock_timestamp()) after the void routine''s last lock; never before the invoice''s issued_at; UTC is authoritative.';

alter table tmpos_invoice_void.issued_invoice_void enable row level security;
revoke all on table tmpos_invoice_void.issued_invoice_void from public, anon, authenticated, tmpos_app, tmpos_audit_writer;

-- =============================================================================
-- 6) The guards
-- =============================================================================
-- SECURITY INVOKER and granted to nobody (a trigger function fires without an EXECUTE grant); BEFORE, so a refused write
-- changes nothing; row_security off where a relation is read: a writer whose row security would hide the header fails.
create function tmpos_invoice_void.m7b_invoice_void_guard()
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
     or tg_table_schema is distinct from 'tmpos_invoice_void' or tg_table_name is distinct from 'issued_invoice_void' then
    raise exception 'm7b_invoice_void_guard: fired by an undeclared trigger'
      using errcode = 'triggered_action_exception';
  end if;
  if tg_op <> 'INSERT' then
    raise exception 'migration 035: a void record is never updated or deleted'
      using errcode = 'restrict_violation';
  end if;
  -- WITHOUT A ROW LOCK: 034's ALWAYS guards refuse every update, delete and truncate of an issued header, so a committed
  -- header once seen stays as seen; the void routine already holds it FOR UPDATE; the foreign key's own check takes FOR KEY
  -- SHARE where it fires. Checked here too because a session running as a replica skips the foreign key's trigger.
  select i.issued_at into v_issued_at
    from tmpos_invoice_issue.issued_invoice i
   where i.invoice_id = new.invoice_id and i.tenant_id = new.tenant_id and i.store_id = new.store_id;
  if not found then
    raise exception 'migration 035: a void record names an issued invoice of its own tenant and store'
      using errcode = 'restrict_violation';
  end if;
  if new.voided_at is null or new.voided_at < v_issued_at then
    raise exception 'migration 035: a void record is stamped at or after its invoice''s issue'
      using errcode = 'restrict_violation';
  end if;
  return new;
end
$$;

comment on function tmpos_invoice_void.m7b_invoice_void_guard() is
  'Phase 4.0 M7b (migration 035): BEFORE INSERT OR UPDATE OR DELETE row trigger on tmpos_invoice_void.issued_invoice_void (enabled ALWAYS). Refuses (restrict_violation, fixed message) every update and delete, and an insert unless an issued invoice with the same invoice id, tenant and store exists (read without a row lock, row_security off: 034''s ALWAYS guards keep a committed issued header unchanged and undeleted) and voided_at is present and not before its issued_at. triggered_action_exception for any other firing. Granted to nobody.';

create function tmpos_invoice_void.m7b_invoice_void_truncate_guard()
returns trigger
language plpgsql
volatile
security invoker
set search_path = pg_catalog, pg_temp
as $$
begin
  if tg_when is distinct from 'BEFORE' or tg_level is distinct from 'STATEMENT' or tg_op is distinct from 'TRUNCATE'
     or tg_table_schema is distinct from 'tmpos_invoice_void' or tg_table_name is distinct from 'issued_invoice_void' then
    raise exception 'm7b_invoice_void_truncate_guard: fired by an undeclared trigger'
      using errcode = 'triggered_action_exception';
  end if;
  raise exception 'migration 035: void records are never truncated'
    using errcode = 'restrict_violation';
end
$$;

comment on function tmpos_invoice_void.m7b_invoice_void_truncate_guard() is
  'Phase 4.0 M7b (migration 035): BEFORE TRUNCATE statement trigger on tmpos_invoice_void.issued_invoice_void (enabled ALWAYS); always raises restrict_violation (fixed message). triggered_action_exception for any other firing. Granted to nobody.';

create trigger trg_issued_invoice_void_guard
  before insert or update or delete on tmpos_invoice_void.issued_invoice_void
  for each row execute function tmpos_invoice_void.m7b_invoice_void_guard();
alter table tmpos_invoice_void.issued_invoice_void enable always trigger trg_issued_invoice_void_guard;
create trigger trg_issued_invoice_void_truncate
  before truncate on tmpos_invoice_void.issued_invoice_void
  for each statement execute function tmpos_invoice_void.m7b_invoice_void_truncate_guard();
alter table tmpos_invoice_void.issued_invoice_void enable always trigger trg_issued_invoice_void_truncate;

-- =============================================================================
-- 7) The void
-- =============================================================================
create function tmpos_invoice_void.m7b_invoice_void(
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
-- VOLATILE IS LOAD-BEARING (033's reason): it locks and then re-reads, and each statement must see what committed before its
-- own locks — step 7 above all. Do not make it STABLE.
volatile
security definer
set search_path = pg_catalog, pg_temp
set row_security = off
as $$
declare
  -- The tenant ordering (permissionCatalog.ts TENANT_ORDERING), 020's constant, pinned by the parity test.
  c_levels         constant text[] := array['none', 'view', 'create', 'edit', 'manage', 'approve', 'full'];
  -- The closed reason codes (contract §2), in their order.
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
    raise exception 'migration 035 void: an argument is malformed'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_expected_version is null or p_expected_version < 1 or p_expected_version > 9007199254740990 then
    raise exception 'migration 035 void: the expected version is out of range'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_reason_code is null or not (p_reason_code = any (c_reasons)) then
    raise exception 'migration 035 void: the reason code is not one of the closed list'
      using errcode = 'invalid_parameter_value';
  end if;
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'migration 035 void: it must run under READ COMMITTED, so that its checks see what committed before its locks'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- 1. The caller, derived exactly as 034's issue derives it (034 up :1668-1781, statement for statement; never through
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
      raise exception 'migration 035 void: the void record is not one the void table admits'
        using errcode = 'integrity_constraint_violation';
  end;
  if v_written is distinct from 1 then
    raise exception 'migration 035 void: the void was not written to exactly the locked invoice'
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
    raise exception 'migration 035 void: the void record is not the one judged'
      using errcode = 'no_data_found';
  end if;

  -- 10. Applied: the lifecycle version moves 1 -> 2.
  return query select 'applied'::text, v_tenant, p_store_id, v_admission.actor_id, v_membership, p_expected_version + 1,
    p_invoice_id;
end
$$;

comment on function tmpos_invoice_void.m7b_invoice_void(text, uuid, uuid, uuid, bigint, text) is
  'Phase 4.0 M7b (migration 035): voids one issued invoice of a store (a terminal void record; the invoice, its number, snapshot and source draft unchanged), for 034''s issue''s caller derivation (a ledger-minted, live tenant session under the installed issuer key, 016''s hold, the session, ledger and issuer key rows, an unchanged standing, an active or trialing account, EXACTLY ONE store grant at p_store_id on an active or trialing tenant and store, still its active membership, the store row FOR SHARE) and a role whose Invoices level is Approve or above AND Customers level View or above (store_owner Full) — read unlocked, then again after the issued header is locked FOR UPDATE under pg_advisory_xact_lock_shared(530030, hashtext(tenant || ''/'' || role)) for an editable role — and, after the last lock wait on the database clock, a live session whose authenticated_at is present, at most 5000 ms in the future and at most 600000 ms old. Answers one row: (''refused'', NULLs) for any authority, liveness or sign-in refusal; (''tenant_mismatch'', NULLs); (''not_found'', NULLs) alike for a missing, another store''s and another tenant''s invoice; then, the header locked: (''invalid_state'', NULLs) for an invoice already voided (a separate read after every lock), (''conflict'', NULLs) for an expected version other than 1 — every one with nothing written; else writes one void record (reason code, clock_timestamp(), the actor) and answers (''applied'', tenant, store, actor, membership, p_expected_version + 1, invoice id). Raises invalid_parameter_value (fixed message) for a malformed argument, a version outside 1..9007199254740990 or a reason code outside the closed list, object_not_in_prerequisite_state outside READ COMMITTED, integrity_constraint_violation (fixed text) for a constraint refusal of the write. Reads or locks no draft, settings, customer, counter or line row; writes no audit, outbox or idempotency record.';

-- =============================================================================
-- 8) The lifecycle-aware issued reads (034's page and get, wrapped)
-- =============================================================================
-- SQL-standard bodies: one statement each over 034's own read WITH ORDINALITY, so the authority, words, limits, cursor and
-- raises are 034's (never restated), the row order is 034's, and PostgreSQL records each body's dependency on 034's routine
-- and on the void table. STABLE, one snapshot; lock nothing.
create function tmpos_invoice_void.m7b_issued_invoice_page_v2(
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
  o_snapshot_version integer,
  o_status           text
)
language sql
-- STABLE IS LOAD-BEARING (017's reason): 034's page and the void record on one snapshot; locks nothing.
stable
security definer
set search_path = pg_catalog, pg_temp
set row_security = off
begin atomic
  select r.o_outcome, r.o_tenant_id, r.o_store_id, r.o_invoice_id, r.o_number, r.o_source_draft_id, r.o_customer_id,
         r.o_customer_name, r.o_currency, r.o_total_cents, r.o_issued_at, r.o_snapshot_version,
         case when r.o_outcome = 'invoice' then case when v.invoice_id is null then 'issued' else 'voided' end end
    from tmpos_invoice_issue.m7b_issued_invoice_page(p_session_key, p_expected_tenant, p_expected_store, p_after_invoice_id,
                                                     p_source_draft_id, p_limit) with ordinality as r
    left join tmpos_invoice_void.issued_invoice_void v
      on v.invoice_id = r.o_invoice_id and v.tenant_id = r.o_tenant_id and v.store_id = r.o_store_id
   order by r.ordinality;
end;

comment on function tmpos_invoice_void.m7b_issued_invoice_page_v2(text, uuid, uuid, uuid, uuid, integer) is
  'Phase 4.0 M7b (migration 035): migration 034''s m7b_issued_invoice_page answer, row for row and in its order (its authority, ''denied'' and ''cursor_unknown'' words, ''invoice'' rows newest number first, limit 1-51, the sourceDraft branch, its raises), each row with one more column o_status: ''voided'' on an ''invoice'' row whose invoice, tenant and store a void record names, ''issued'' on any other ''invoice'' row, NULL on a refusal row. A SQL-standard body over 034''s page WITH ORDINALITY; adds no authority of its own; never returns the voiding actor. STABLE; locks nothing.';

create function tmpos_invoice_void.m7b_issued_invoice_get_v2(
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
  o_line_total_cents     bigint,
  o_status               text,
  o_voided_at            text,
  o_reason_code          text
)
language sql
-- STABLE IS LOAD-BEARING (017's reason): 034's header and lines and the void record on one snapshot; locks nothing.
stable
security definer
set search_path = pg_catalog, pg_temp
set row_security = off
begin atomic
  select r.o_outcome, r.o_tenant_id, r.o_store_id, r.o_invoice_id, r.o_number, r.o_snapshot_version, r.o_issued_at,
         r.o_source_draft_id, r.o_source_draft_version, r.o_settings_version, r.o_legal_name, r.o_store_name,
         r.o_postal_address, r.o_tax_registration_id, r.o_customer_id, r.o_customer_name, r.o_customer_version, r.o_currency,
         r.o_line_count, r.o_subtotal_cents, r.o_tax_mode, r.o_tax_rate, r.o_tax_cents, r.o_total_cents, r.o_position,
         r.o_description, r.o_quantity, r.o_unit_price_cents, r.o_line_total_cents,
         case when r.o_outcome = 'line' then case when v.invoice_id is null then 'issued' else 'voided' end end,
         case when r.o_outcome = 'line' and v.invoice_id is not null
              then pg_catalog.to_char(v.voided_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end,
         case when r.o_outcome = 'line' and v.invoice_id is not null then v.reason_code::text end
    from tmpos_invoice_issue.m7b_issued_invoice_get(p_session_key, p_expected_tenant, p_expected_store, p_invoice_id)
           with ordinality as r
    left join tmpos_invoice_void.issued_invoice_void v
      on v.invoice_id = r.o_invoice_id and v.tenant_id = r.o_tenant_id and v.store_id = r.o_store_id
   order by r.ordinality;
end;

comment on function tmpos_invoice_void.m7b_issued_invoice_get_v2(text, uuid, uuid, uuid) is
  'Phase 4.0 M7b (migration 035): migration 034''s m7b_issued_invoice_get answer, row for row and in its order (its authority, ''denied'' and ''not_found'' words, one ''line'' row per line in position order with the whole snapshot, its raises), each row with three more columns: on every ''line'' row of a voided invoice (a void record naming its invoice, tenant and store) (''voided'', voided_at as UTC text with microseconds in o_issued_at''s encoding, the reason code), on every ''line'' row of any other invoice (''issued'', NULL, NULL), on a refusal row NULLs. A SQL-standard body over 034''s get WITH ORDINALITY; adds no authority of its own; never returns the voiding actor. STABLE; locks nothing.';

-- =============================================================================
-- 9) The audit record's issued-invoice subject, re-worded to name the void
-- =============================================================================
-- 034's column, index and grants unchanged; only its comment, which 034 wrote for the issue alone. The rollback restores
-- 034's text exactly (section 3 proved it is 034's now).
comment on column public.audit_event.subject_issued_invoice_id is
  'Phase 4.0 M7b (migrations 034 and 035): the issued invoice the recorded action created (a store-scope issue, beside the draft and customer subjects) or voided (a store-scope void, its only subject). Written by the command transaction from the routine''s verified answer; never from request metadata. Plain column, no FK (audit is decoupled/append-only). Never accompanied by a seller, customer or line value.';

-- =============================================================================
-- 10) The rollback-order anchor
-- =============================================================================
-- A SQL-standard body records a dependency for every reg* constant: the two 034 functions this file wraps — only 034's, as
-- 034's anchor names only 033's (the existing suites roll older migrations, 016 among them, back beneath later ones). DROP of
-- either without CASCADE — 034's rollback — is refused (2BP01) while this exists; the foreign key refuses the drop of 034's
-- issued_invoice likewise.
create function tmpos_invoice_void.m7b_invoice_void_prerequisites()
returns boolean
language sql
stable
security invoker
set search_path = pg_catalog, pg_temp
begin atomic
  select 'tmpos_invoice_issue.m7b_issued_invoice_page(text, uuid, uuid, uuid, uuid, integer)'::pg_catalog.regprocedure is not null
     and 'tmpos_invoice_issue.m7b_issued_invoice_get(text, uuid, uuid, uuid)'::pg_catalog.regprocedure is not null;
end;

comment on function tmpos_invoice_void.m7b_invoice_void_prerequisites() is
  'Phase 4.0 M7b (migration 035): the rollback-order anchor. A SQL-standard body naming, as reg* constants, migration 034''s m7b_issued_invoice_page and m7b_issued_invoice_get (which the v2 reads wrap), and no other migration''s function, so their recorded dependencies refuse (2BP01) 034''s rollback while migration 035 is applied (the void record''s foreign key refuses the drop of issued_invoice too): roll 035 back first. Never called; answers true. Granted to nobody.';

-- =============================================================================
-- 11) Privileges
-- =============================================================================
-- PostgreSQL grants EXECUTE on a new function to PUBLIC by default: every default is removed before the three intended grants.
-- tmpos_app loses its EXECUTE on 034's page and get, which stay in their schema, unaltered, for the rollback.
revoke all on function tmpos_invoice_void.m7b_invoice_void_guard() from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
revoke all on function tmpos_invoice_void.m7b_invoice_void_truncate_guard() from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
revoke all on function tmpos_invoice_void.m7b_invoice_void(text, uuid, uuid, uuid, bigint, text) from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
revoke all on function tmpos_invoice_void.m7b_issued_invoice_page_v2(text, uuid, uuid, uuid, uuid, integer) from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
revoke all on function tmpos_invoice_void.m7b_issued_invoice_get_v2(text, uuid, uuid, uuid) from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
revoke all on function tmpos_invoice_void.m7b_invoice_void_prerequisites() from public, anon, authenticated, tmpos_app, tmpos_audit_writer;

revoke execute on function tmpos_invoice_issue.m7b_issued_invoice_page(text, uuid, uuid, uuid, uuid, integer) from tmpos_app;
revoke execute on function tmpos_invoice_issue.m7b_issued_invoice_get(text, uuid, uuid, uuid) from tmpos_app;

grant execute on function tmpos_invoice_void.m7b_invoice_void(text, uuid, uuid, uuid, bigint, text) to tmpos_app;
grant execute on function tmpos_invoice_void.m7b_issued_invoice_page_v2(text, uuid, uuid, uuid, uuid, integer) to tmpos_app;
grant execute on function tmpos_invoice_void.m7b_issued_invoice_get_v2(text, uuid, uuid, uuid) to tmpos_app;

-- =============================================================================
-- 12) Postcondition
-- =============================================================================
-- Proven rather than asserted, in 034's form. This file refuses to finish unless, now:
--   (a) schema tmpos_invoice_void holds exactly this file's six functions, its table and the table's primary-key index and
--       no other relation or type, is owned by the applying principal, and its complete ACL is the owner's USAGE and CREATE
--       and a non-grantable USAGE to tmpos_app;
--   (b) every function has its declared language, security, volatility, settings, owner and comment, the three routines
--       their exact arguments and RETURNS TABLE;
--   (c) the complete ACL of each of the three routines is exactly the owner's EXECUTE and tmpos_app's non-grantable EXECUTE;
--       of every other function of the schema exactly the owner's; of 034's page and get exactly the owner's; of 034's
--       other four routines exactly 034's two entries;
--   (d) tmpos_app can execute the three and nothing else of the schema, and no longer 034's page or get; tmpos_audit_writer,
--       anon and authenticated none of these, by any path; no runtime role holds any privilege on the table by any path
--       (MAINTAIN included where the server has it); row security is enabled, not forced, without policy; the table's ACL
--       is exactly its owner's default one and no column carries a grant;
--   (e) none of the four runtime roles is a member of the owner of the schema, a function or the table;
--   (f) the table's triggers are exactly this file's two, in their exact shape and ENABLE ALWAYS, each trigger function
--       serving exactly one trigger; 034's issued header still carries exactly 034's three;
--   (g) the table's columns, NOT NULLs, collation, primary key and reason CHECK are exactly section 5's;
--   (h) its one foreign key is exactly section 5's, ON DELETE RESTRICT ON UPDATE RESTRICT, validated, on 034's scope key;
--   (i) the anchor records exactly one dependency on each of the two 034 functions it names and on nothing else, and each
--       v2 read on 034's read it wraps and on the void table;
--   (j) public.audit_event.subject_issued_invoice_id carries section 9's comment exactly.
do $$
declare
  v_bad      text;
  v_me       oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user);
  v_void     oid := 'tmpos_invoice_void.m7b_invoice_void(text, uuid, uuid, uuid, bigint, text)'::regprocedure;
  v_page     oid := 'tmpos_invoice_void.m7b_issued_invoice_page_v2(text, uuid, uuid, uuid, uuid, integer)'::regprocedure;
  v_get      oid := 'tmpos_invoice_void.m7b_issued_invoice_get_v2(text, uuid, uuid, uuid)'::regprocedure;
  v_guard    oid := 'tmpos_invoice_void.m7b_invoice_void_guard()'::regprocedure;
  v_truncate oid := 'tmpos_invoice_void.m7b_invoice_void_truncate_guard()'::regprocedure;
  v_anchor   oid := 'tmpos_invoice_void.m7b_invoice_void_prerequisites()'::regprocedure;
  v_routines oid[];
  v_table    oid := 'tmpos_invoice_void.issued_invoice_void'::regclass;
  v_page034  oid := 'tmpos_invoice_issue.m7b_issued_invoice_page(text, uuid, uuid, uuid, uuid, integer)'::regprocedure;
  v_get034   oid := 'tmpos_invoice_issue.m7b_issued_invoice_get(text, uuid, uuid, uuid)'::regprocedure;
  v_kept034  oid[] := array[
    'tmpos_invoice_issue.m7b_issuing_settings_get(text, uuid, uuid)'::regprocedure,
    'tmpos_invoice_issue.m7b_issuing_settings_set(text, uuid, uuid, bigint, text, text, text, text, text, integer)'::regprocedure,
    'tmpos_invoice_issue.m7b_invoice_issue_preview(text, uuid, uuid, uuid)'::regprocedure,
    'tmpos_invoice_issue.m7b_invoice_issue(text, uuid, uuid, uuid, bigint, bigint, bigint, uuid)'::regprocedure]::oid[];
begin
  v_routines := array[v_void, v_page, v_get]::oid[];

  -- (a)
  if (select pg_catalog.string_agg(p.oid::regprocedure::text, ', ' order by p.oid::regprocedure::text collate "C")
        from pg_catalog.pg_proc p where p.pronamespace = 'tmpos_invoice_void'::regnamespace)
     is distinct from
     'tmpos_invoice_void.m7b_invoice_void(text,uuid,uuid,uuid,bigint,text), tmpos_invoice_void.m7b_invoice_void_guard(), tmpos_invoice_void.m7b_invoice_void_prerequisites(), tmpos_invoice_void.m7b_invoice_void_truncate_guard(), tmpos_invoice_void.m7b_issued_invoice_get_v2(text,uuid,uuid,uuid), tmpos_invoice_void.m7b_issued_invoice_page_v2(text,uuid,uuid,uuid,uuid,integer)'
     or (select pg_catalog.string_agg(pg_catalog.format('%s:%s', c.relname, c.relkind), ', ' order by c.relname collate "C")
           from pg_catalog.pg_class c where c.relnamespace = 'tmpos_invoice_void'::regnamespace)
        is distinct from 'issued_invoice_void:r, issued_invoice_void_pkey:i'
     or exists (select 1 from pg_catalog.pg_type t
                 where t.typnamespace = 'tmpos_invoice_void'::regnamespace and t.typrelid = 0 and t.typelem = 0)
     or not exists (select 1 from pg_catalog.pg_namespace n where n.oid = 'tmpos_invoice_void'::regnamespace and n.nspowner = v_me)
     or not exists (select 1 from pg_catalog.pg_class c where c.oid = v_table and c.relowner = v_me)
     or pg_catalog.obj_description('tmpos_invoice_void'::regnamespace, 'pg_namespace') is null
     or pg_catalog.obj_description(v_table, 'pg_class') is null then
    raise exception 'migration 035 refused: schema tmpos_invoice_void does not hold exactly this file''s functions and relations, or it or the table is not owned by the applying principal or carries no comment'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  select pg_catalog.string_agg(pg_catalog.format('%s:%s', g.grantee::regrole::text, g.privilege_type), ', ')
    into v_bad
    from pg_catalog.pg_namespace n,
         pg_catalog.aclexplode(coalesce(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) g
   where n.oid = 'tmpos_invoice_void'::regnamespace
     and not (not g.is_grantable and g.grantor = n.nspowner
              and ((g.grantee = n.nspowner and g.privilege_type in ('USAGE', 'CREATE'))
                   or (g.grantee = 'tmpos_app'::regrole and g.privilege_type = 'USAGE')));
  if v_bad is not null
     or (select pg_catalog.count(*)
           from pg_catalog.pg_namespace n,
                pg_catalog.aclexplode(coalesce(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) g
          where n.oid = 'tmpos_invoice_void'::regnamespace) <> 3
     or not pg_catalog.has_schema_privilege('tmpos_app', 'tmpos_invoice_void'::regnamespace, 'USAGE') then
    raise exception 'migration 035 refused: schema tmpos_invoice_void carries an unexpected grant or lacks an expected one (%), or tmpos_app cannot use it', coalesce(v_bad, 'none listed')
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (b)
  select pg_catalog.string_agg(p.proname::text, ', ' order by p.proname) into v_bad
    from pg_catalog.pg_proc p join pg_catalog.pg_language l on l.oid = p.prolang
   where p.pronamespace = 'tmpos_invoice_void'::regnamespace
     and not (p.proowner = v_me
              and pg_catalog.obj_description(p.oid, 'pg_proc') is not null
              and case
                    when p.oid = v_void then
                      l.lanname = 'plpgsql' and p.prosecdef and p.provolatile = 'v' and p.proretset
                      and p.proconfig = array['search_path=pg_catalog, pg_temp', 'row_security=off']
                    when p.oid in (v_page, v_get) then
                      l.lanname = 'sql' and p.prosecdef and p.provolatile = 's' and p.proretset and p.prosqlbody is not null
                      and p.proconfig = array['search_path=pg_catalog, pg_temp', 'row_security=off']
                    when p.oid = v_anchor then
                      l.lanname = 'sql' and not p.prosecdef and p.provolatile = 's' and p.prosqlbody is not null
                      and p.prorettype = 'pg_catalog.bool'::regtype
                      and p.proconfig = array['search_path=pg_catalog, pg_temp']
                    when p.oid = v_guard then
                      l.lanname = 'plpgsql' and not p.prosecdef and p.provolatile = 'v'
                      and p.prorettype = 'pg_catalog.trigger'::regtype
                      and p.proconfig = array['search_path=pg_catalog, pg_temp', 'row_security=off']
                    when p.oid = v_truncate then
                      l.lanname = 'plpgsql' and not p.prosecdef and p.provolatile = 'v'
                      and p.prorettype = 'pg_catalog.trigger'::regtype
                      and p.proconfig = array['search_path=pg_catalog, pg_temp']
                    else false
                  end);
  if v_bad is not null
     or pg_catalog.pg_get_function_arguments(v_void)
        is distinct from 'p_session_key text, p_store_id uuid, p_invoice_id uuid, p_expected_tenant uuid, p_expected_version bigint, p_reason_code text'
     or pg_catalog.pg_get_function_result(v_void)
        is distinct from 'TABLE(o_outcome text, o_tenant_id uuid, o_store_id uuid, o_actor_id uuid, o_membership_id uuid, o_version bigint, o_invoice_id uuid)'
     or pg_catalog.pg_get_function_arguments(v_page) is distinct from pg_catalog.pg_get_function_arguments(v_page034)
     or pg_catalog.pg_get_function_result(v_page)
        is distinct from 'TABLE(o_outcome text, o_tenant_id uuid, o_store_id uuid, o_invoice_id uuid, o_number bigint, o_source_draft_id uuid, o_customer_id uuid, o_customer_name text, o_currency text, o_total_cents bigint, o_issued_at text, o_snapshot_version integer, o_status text)'
     or pg_catalog.pg_get_function_arguments(v_get) is distinct from pg_catalog.pg_get_function_arguments(v_get034)
     or pg_catalog.pg_get_function_result(v_get)
        is distinct from 'TABLE(o_outcome text, o_tenant_id uuid, o_store_id uuid, o_invoice_id uuid, o_number bigint, o_snapshot_version integer, o_issued_at text, o_source_draft_id uuid, o_source_draft_version bigint, o_settings_version bigint, o_legal_name text, o_store_name text, o_postal_address text, o_tax_registration_id text, o_customer_id uuid, o_customer_name text, o_customer_version bigint, o_currency text, o_line_count integer, o_subtotal_cents bigint, o_tax_mode text, o_tax_rate integer, o_tax_cents bigint, o_total_cents bigint, o_position integer, o_description text, o_quantity bigint, o_unit_price_cents bigint, o_line_total_cents bigint, o_status text, o_voided_at text, o_reason_code text)' then
    raise exception 'migration 035 refused: a function of schema tmpos_invoice_void is not the one its section declares (language, security, volatility, settings, owner, comment, arguments or result: %)', coalesce(v_bad, 'a signature')
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (c)
  select pg_catalog.string_agg(pg_catalog.format('%s %s:%s', p.proname, g.grantee::regrole::text, g.privilege_type), ', ')
    into v_bad
    from pg_catalog.pg_proc p,
         pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g
   where (p.pronamespace = 'tmpos_invoice_void'::regnamespace or p.oid in (v_page034, v_get034) or p.oid = any (v_kept034))
     and not (g.privilege_type = 'EXECUTE' and not g.is_grantable and g.grantor = p.proowner
              and (g.grantee = p.proowner
                   or ((p.oid = any (v_routines) or p.oid = any (v_kept034)) and g.grantee = 'tmpos_app'::regrole)));
  if v_bad is not null
     or exists (select 1 from pg_catalog.pg_proc p
                 where (p.pronamespace = 'tmpos_invoice_void'::regnamespace or p.oid in (v_page034, v_get034) or p.oid = any (v_kept034))
                   and (select pg_catalog.count(*)
                          from pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g)
                       <> case when p.oid = any (v_routines) or p.oid = any (v_kept034) then 2 else 1 end) then
    raise exception 'migration 035 refused: an unexpected grant remains on a function of schema tmpos_invoice_void or on 034''s routines, or an entry is missing (%)', coalesce(v_bad, 'none listed')
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (d)
  select pg_catalog.string_agg(distinct r.rolname::text || ' ' || p.proname::text, ', ') into v_bad
    from pg_catalog.pg_roles r
    join pg_catalog.pg_roles x on pg_catalog.pg_has_role(r.oid, x.oid, 'MEMBER')
    cross join pg_catalog.pg_proc p
   where (p.pronamespace = 'tmpos_invoice_void'::regnamespace or p.oid in (v_page034, v_get034))
     and (r.rolname = any (array['tmpos_audit_writer', 'anon', 'authenticated']::name[])
          or (r.rolname = 'tmpos_app' and not (p.oid = any (v_routines))))
     and pg_catalog.has_function_privilege(x.oid, p.oid, 'EXECUTE');
  if v_bad is not null
     or exists (select 1 from pg_catalog.unnest(v_routines || v_kept034) f(oid)
                 where not pg_catalog.has_function_privilege('tmpos_app', f.oid, 'EXECUTE')) then
    raise exception 'migration 035 refused: a runtime role can execute a function this file does not grant it (034''s page or get included), or tmpos_app cannot execute a routine (%)', coalesce(v_bad, 'none listed')
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  select pg_catalog.string_agg(distinct r.rolname::text, ', ') into v_bad
    from pg_catalog.pg_roles r
    join pg_catalog.pg_roles x on pg_catalog.pg_has_role(r.oid, x.oid, 'MEMBER')
   where r.rolname = any (array['tmpos_app', 'tmpos_audit_writer', 'anon', 'authenticated']::name[])
     and (pg_catalog.has_table_privilege(x.oid, v_table,
            'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'
            operator(pg_catalog.||) case when pg_catalog.current_setting('server_version_num')::integer >= 170000
                                         then ', MAINTAIN' else '' end)
          or pg_catalog.has_any_column_privilege(x.oid, v_table, 'SELECT, INSERT, UPDATE, REFERENCES'));
  if v_bad is not null
     or not exists (select 1 from pg_catalog.pg_class c where c.oid = v_table and c.relrowsecurity and not c.relforcerowsecurity)
     or exists (select 1 from pg_catalog.pg_policy y where y.polrelid = v_table) then
    raise exception 'migration 035 refused: % holds a privilege on the void table, or its row security is not enabled without policy and unforced', coalesce(v_bad, 'no role')
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- Exact ACL, 028's form: no grantee but the owner on the table, and no column-level grant at all; and the complete ACL
  -- is exactly the owner's default one, entry for entry — so no altered default privilege took the definer owner's own
  -- SELECT or INSERT away either.
  select pg_catalog.string_agg(pg_catalog.format('%s:%s', g.grantee::regrole::text, g.privilege_type), ', ')
    into v_bad
    from pg_catalog.pg_class c,
         pg_catalog.aclexplode(coalesce(c.relacl, pg_catalog.acldefault('r', c.relowner))) g
   where c.oid = v_table
     and g.grantee <> c.relowner;
  if v_bad is not null
     or (select pg_catalog.string_agg(pg_catalog.format('%s:%s:%s:%s', g.grantee, g.grantor, g.privilege_type, g.is_grantable), ','
                                     order by g.privilege_type collate "C")
           from pg_catalog.pg_class c, pg_catalog.aclexplode(coalesce(c.relacl, pg_catalog.acldefault('r', c.relowner))) g
          where c.oid = v_table)
        is distinct from
        (select pg_catalog.string_agg(pg_catalog.format('%s:%s:%s:%s', g.grantee, g.grantor, g.privilege_type, g.is_grantable), ','
                                     order by g.privilege_type collate "C")
           from pg_catalog.pg_class c, pg_catalog.aclexplode(pg_catalog.acldefault('r', c.relowner)) g
          where c.oid = v_table)
     or exists (select 1 from pg_catalog.pg_attribute t where t.attrelid = v_table and t.attacl is not null) then
    raise exception 'migration 035 refused: the void table carries a grant beyond its owner''s, its owner''s own privileges are not the default ones, or a column carries a grant (%)', coalesce(v_bad, 'an owner entry or a column grant')
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (e)
  select pg_catalog.string_agg(distinct r.rolname::text, ', ') into v_bad
    from pg_catalog.pg_roles r
    cross join (
      select n.nspowner as owner from pg_catalog.pg_namespace n where n.oid = 'tmpos_invoice_void'::regnamespace
      union
      select p.proowner from pg_catalog.pg_proc p where p.pronamespace = 'tmpos_invoice_void'::regnamespace
      union
      select c.relowner from pg_catalog.pg_class c where c.relnamespace = 'tmpos_invoice_void'::regnamespace
    ) o
   where r.rolname = any (array['tmpos_app', 'tmpos_audit_writer', 'anon', 'authenticated']::name[])
     and pg_catalog.pg_has_role(r.oid, o.owner, 'MEMBER');
  if v_bad is not null then
    raise exception 'migration 035 refused: % is a member of the owner of schema tmpos_invoice_void or of an object in it', v_bad
      using errcode = 'object_not_in_prerequisite_state',
            hint = 'membership hands a role everything the owner holds, including a direct write of every void record';
  end if;

  -- (f) tgtype: ROW 1 + BEFORE 2 + INSERT 4 + DELETE 8 + UPDATE 16 = 31; BEFORE 2 + TRUNCATE 32 (statement) = 34.
  select pg_catalog.string_agg(pg_catalog.format('%s:%s:%s:%s', g.tgname, g.tgfoid::regprocedure::text, g.tgtype, g.tgenabled), ', '
                               order by g.tgname::text collate "C")
    into v_bad
    from pg_catalog.pg_trigger g
   where g.tgrelid = v_table and not g.tgisinternal;
  if v_bad is distinct from
     'trg_issued_invoice_void_guard:tmpos_invoice_void.m7b_invoice_void_guard():31:A, trg_issued_invoice_void_truncate:tmpos_invoice_void.m7b_invoice_void_truncate_guard():34:A'
     or exists (select 1 from pg_catalog.pg_trigger g
                 where g.tgrelid = v_table and not g.tgisinternal
                   and (not (g.tgattr = ''::pg_catalog.int2vector) or g.tgqual is not null or g.tgconstraint <> 0))
     or (select pg_catalog.count(*) from pg_catalog.pg_trigger g where g.tgfoid = v_guard) <> 1
     or (select pg_catalog.count(*) from pg_catalog.pg_trigger g where g.tgfoid = v_truncate) <> 1
     or (select pg_catalog.string_agg(pg_catalog.format('%s:%s:%s', g.tgname, g.tgtype, g.tgenabled), ', ' order by g.tgname::text collate "C")
           from pg_catalog.pg_trigger g
          where g.tgrelid = 'tmpos_invoice_issue.issued_invoice'::regclass and not g.tgisinternal)
        is distinct from 'trg_issued_invoice_commit_check:5:A, trg_issued_invoice_guard:31:A, trg_issued_invoice_truncate:34:A' then
    raise exception 'migration 035 refused: a trigger of the void table, or of 034''s issued header, is not exactly the one declared (%)', coalesce(v_bad, 'none listed')
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (g)
  if (select pg_catalog.string_agg(pg_catalog.format('%s:%s:%s:%s:%s', a.attname, pg_catalog.format_type(a.atttypid, a.atttypmod),
                                                     a.attnotnull, a.atthasdef, coalesce(co.collname::text, '')), ', ' order by a.attnum)
        from pg_catalog.pg_attribute a
        left join pg_catalog.pg_collation co on co.oid = a.attcollation
       where a.attrelid = v_table and a.attnum > 0 and not a.attisdropped)
     is distinct from
     'invoice_id:uuid:t:f:, tenant_id:uuid:t:f:, store_id:uuid:t:f:, reason_code:text:t:f:C, voided_at:timestamp with time zone:t:f:, voided_by:uuid:t:f:'
     or (select pg_catalog.string_agg(pg_catalog.format('%s:%s:%s', k.conname, k.contype, pg_catalog.pg_get_constraintdef(k.oid)), ' | '
                                     order by k.conname::text collate "C")
           from pg_catalog.pg_constraint k
          where k.conrelid = v_table and k.contype in ('c', 'p', 'u', 'x', 't') and k.convalidated)
        is distinct from
        'issued_invoice_void_pkey:p:PRIMARY KEY (invoice_id) | issued_invoice_void_reason_code_chk:c:CHECK ((reason_code = ANY (ARRAY[''issued_in_error''::text, ''wrong_customer''::text, ''wrong_lines_or_amounts''::text, ''wrong_seller_details''::text, ''duplicate''::text, ''other''::text])))'
     or exists (select 1 from pg_catalog.pg_constraint k
                 where k.conrelid = v_table and k.contype in ('c', 'p', 'u', 'x', 't') and not k.convalidated) then
    raise exception 'migration 035 refused: the void table''s columns, primary key or reason CHECK are not exactly section 5''s'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (h)
  if (select pg_catalog.count(*) from pg_catalog.pg_constraint k where k.conrelid = v_table and k.contype = 'f') <> 1
     or not exists (select 1 from pg_catalog.pg_constraint k
                     where k.conrelid = v_table and k.contype = 'f' and k.conname = 'issued_invoice_void_invoice_fkey'
                       and k.confrelid = 'tmpos_invoice_issue.issued_invoice'::regclass
                       and k.confdeltype = 'r' and k.confupdtype = 'r' and k.confmatchtype = 's' and k.convalidated
                       and not k.condeferrable
                       and k.conindid = pg_catalog.to_regclass('tmpos_invoice_issue.issued_invoice_scope_key')
                       and pg_catalog.pg_get_constraintdef(k.oid) = 'FOREIGN KEY (invoice_id, tenant_id, store_id) REFERENCES tmpos_invoice_issue.issued_invoice(invoice_id, tenant_id, store_id) ON UPDATE RESTRICT ON DELETE RESTRICT') then
    raise exception 'migration 035 refused: the void table''s foreign key is not exactly section 5''s (onto 034''s scope key, ON DELETE RESTRICT ON UPDATE RESTRICT, validated)'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (i) One NORMAL dependency row per object named (schema and language rows aside).
  if (select pg_catalog.string_agg(d.refobjid::regprocedure::text, ', ' order by d.refobjid::regprocedure::text collate "C")
        from pg_catalog.pg_depend d
       where d.classid = 'pg_catalog.pg_proc'::regclass and d.objid = v_anchor and d.objsubid = 0
         and d.refclassid in ('pg_catalog.pg_proc'::regclass, 'pg_catalog.pg_class'::regclass)
         and d.refobjsubid = 0 and d.deptype = 'n')
     is distinct from
     'tmpos_invoice_issue.m7b_issued_invoice_get(text,uuid,uuid,uuid), tmpos_invoice_issue.m7b_issued_invoice_page(text,uuid,uuid,uuid,uuid,integer)'
     or (select pg_catalog.count(*) from pg_catalog.pg_depend d
          where d.classid = 'pg_catalog.pg_proc'::regclass and d.objid = v_page and d.refclassid = 'pg_catalog.pg_proc'::regclass
            and d.refobjid = v_page034 and d.deptype = 'n') <> 1
     or (select pg_catalog.count(*) from pg_catalog.pg_depend d
          where d.classid = 'pg_catalog.pg_proc'::regclass and d.objid = v_get and d.refclassid = 'pg_catalog.pg_proc'::regclass
            and d.refobjid = v_get034 and d.deptype = 'n') <> 1
     or not exists (select 1 from pg_catalog.pg_depend d
                     where d.classid = 'pg_catalog.pg_proc'::regclass and d.objid = v_page
                       and d.refclassid = 'pg_catalog.pg_class'::regclass and d.refobjid = v_table and d.deptype = 'n')
     or not exists (select 1 from pg_catalog.pg_depend d
                     where d.classid = 'pg_catalog.pg_proc'::regclass and d.objid = v_get
                       and d.refclassid = 'pg_catalog.pg_class'::regclass and d.refobjid = v_table and d.deptype = 'n') then
    raise exception 'migration 035 refused: the rollback-order anchor does not record exactly one dependency on each function it names, or a v2 read does not record its dependency on 034''s read or the void table'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (j)
  if pg_catalog.col_description('public.audit_event'::regclass,
       (select a.attnum from pg_catalog.pg_attribute a
         where a.attrelid = 'public.audit_event'::regclass and a.attname = 'subject_issued_invoice_id' and not a.attisdropped))
     is distinct from 'Phase 4.0 M7b (migrations 034 and 035): the issued invoice the recorded action created (a store-scope issue, beside the draft and customer subjects) or voided (a store-scope void, its only subject). Written by the command transaction from the routine''s verified answer; never from request metadata. Plain column, no FK (audit is decoupled/append-only). Never accompanied by a seller, customer or line value.' then
    raise exception 'migration 035 refused: public.audit_event.subject_issued_invoice_id does not carry section 9''s comment'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$$;

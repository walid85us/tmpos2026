-- Phase 4.0 M7b — discarding a saved store invoice draft: a terminal 'discarded' state, a session-bound discard routine that
-- decides the role's Invoices level at Manage under migration 030's advisory key, open-only page and get routines, database
-- guards of the terminal state on the header and on its lines, a partial index for the open-only page, and a rollback-order
-- anchor that keeps 032-028 from rolling back under it (M7B-INVOICES-DISCARD-P1; owner decisions D-DIS-1 to D-DIS-5; DA-186;
-- G-IAM, G-ISOLATION, G-DBROLE; docs/phase-4/05, 08, 10, 11)
-- Migration: 033_m7b_invoice_draft_discard (UP)
--
-- SCOPE / TRUTH (binding):
--   - ONE SCHEMA, SIX FUNCTIONS, TWO TRIGGERS, ONE INDEX, ONE CHECK REPLACED, SIX PRIVILEGE CHANGES. Schema
--     tmpos_invoice_discard (owned by the applying principal; USAGE granted to tmpos_app alone, beside its owner's own) holds
--     exactly: the discard routine m7b_invoice_draft_discard; the open-only reads m7b_invoice_draft_page_v2 and
--     m7b_invoice_draft_get_v2; the trigger functions m7b_invoice_draft_terminal() and m7b_invoice_draft_line_terminal(); and
--     the rollback-order anchor m7b_invoice_discard_prerequisites(). The triggers trg_invoice_draft_terminal (on
--     tmpos_invoice_draft.invoice_draft) and trg_invoice_draft_line_terminal (on tmpos_invoice_draft.invoice_draft_line) are
--     BEFORE INSERT OR UPDATE OR DELETE, FOR EACH ROW, ENABLE ALWAYS. The partial index invoice_draft_open_page_idx serves the
--     open-only page. 028's invoice_draft_status_chk is replaced under its own name by CHECK (status in ('draft',
--     'discarded')). The privilege changes: tmpos_app gains USAGE on the schema and EXECUTE on the three routines, and loses
--     its EXECUTE on 028's tmpos_invoice_draft.m7b_invoice_draft_page and m7b_invoice_draft_get, which stay in place, unaltered.
--     NO TABLE, COLUMN, ROW, ROLE, MEMBERSHIP, POLICY OR TYPE; no privilege on any table; no UPDATE or DELETE of any row. 001-032
--     stay byte for byte as committed (the migration-files contract's pinned checksums prove that); 028's, 029's, 030's, 031's
--     and 032's routines, triggers and trigger functions are not altered.
--   - THE STATE MACHINE (D-DIS-1, D-DIS-3). 'draft' (028) and 'discarded' (new, terminal). The only transition is 'draft' ->
--     'discarded', at the version the request names, stepping it by exactly one; nothing else of the header changes (customer,
--     currency, line count, subtotal; 029's trigger keeps the id, tenant, store, creation time and creator) and no line
--     changes. A discarded draft admits no edit (030's edit answers 'invalid_state' at its step 6), no second discard, no
--     return to 'draft', no update of any kind, no change to its lines and no delete. Nothing is deleted: the header, its
--     lines, its id, its version counter and every audit record stay (logical discard; not erasure, not issuing).
--   - THE DISCARD, tmpos_invoice_discard.m7b_invoice_draft_discard(p_session_key, p_store_id, p_draft_id, p_expected_tenant,
--     p_expected_version): plpgsql, SECURITY DEFINER, VOLATILE, search_path pg_catalog then pg_temp, row_security off, READ
--     COMMITTED only. Its caller derivation (steps 1-2, 2a, 2b), its tenant precondition (4), its header lock (5), its guard
--     (5b) and its state and version decisions (6, 7) are 030's update_v2's, every code line character for character, the
--     Invoices threshold Manage in place of Edit (steps 3 and 5b). THE ORDER OF DECISIONS:
--       0. every argument (invalid_parameter_value, a fixed message, never the value: one for the session key, store, draft
--          and expected tenant together, as 030 words it; one for the expected version, 1 to 9007199254740990), then READ
--          COMMITTED (55000);
--       1-2. the caller: 016's hold, the session and ledger rows FOR SHARE, the issuer key FOR SHARE, the clock, the standing
--          digest, an active or trialing account, EXACTLY ONE store grant at p_store_id (a selector only) on an active or
--          trialing tenant and store, still that actor's active membership, the store row FOR SHARE -> any failure 'refused';
--       3. the role's Invoices level, UNLOCKED: store_owner Full; manager, technician, sales_staff the stored level, else the
--          catalog default (manager Full, technician View, sales_staff Create); any other role refused; below Manage ->
--          'refused' (D-DIS-2: Edit alone does not discard; Full does);
--       4. the grant's tenant is not p_expected_tenant -> 'tenant_mismatch';
--       5. the header FOR UPDATE by id, derived tenant and store — never by version or status: missing, another store's and
--          another tenant's -> 'not_found'; the clock again (an expired session -> 'refused');
--       5b. for manager, technician and sales_staff: 030's key pg_advisory_xact_lock_shared(530030, hashtext(tenant || '/' ||
--          role)), the clock again, the Invoices level read again by a plain SELECT -> below Manage 'refused'. store_owner
--          takes no key (Full by the catalog, never stored);
--       6. the status is not 'draft' -> 'invalid_state' (BEFORE the version: D-DIS-3's precedence);
--       7. the version is not p_expected_version -> 'conflict';
--       8. ONE header UPDATE: status 'discarded', version + 1, on exactly the locked draft at that version and status; a
--          verification read; -> ('applied', tenant, store, actor, membership, the new version).
--     Every answer but 'applied' is reached with NOTHING written (DA-36): no header, line, customer, role row, version row,
--     audit record, outbox row or idempotency row. The applied path writes the header alone. The routine writes no audit,
--     outbox or idempotency row: the runtime writes the audit record and the completion in the same command transaction.
--     SEALED AND ROLLED BACK (the runtime's update-mode kernel): 'applied' (200), 'conflict' (409 write_conflict) and
--     'invalid_state' (409 invalid_state) are sealed with the idempotency completion; 'not_found' (404), 'tenant_mismatch'
--     (the chain's 409) and 'refused' (503) roll the command transaction back, the lease kept.
--   - AUTHORITY HELD TO THE END (030's guard, reused, not changed). Every sealed answer of the discard ('invalid_state',
--     'conflict', 'applied') is decided after step 5b and committed while the role's key is held SHARED; every writer of an
--     Invoices level (030's trigger) and of a Customers level (032's trigger) takes the same key EXCLUSIVE, so no narrowing can
--     commit between the decision and the command's COMMIT, and a narrowing that committed first refuses the discard. A
--     discard therefore also delays the owner's Customers-level writes of that role until it ends: availability only.
--   - LOCK ORDER (the fence, 016's hold, session and ledger, issuer order of every tenant write is unchanged):
--       the discard:      fence -> 016's hold -> session and ledger rows FOR SHARE -> issuer key row FOR SHARE -> store row FOR
--                         SHARE -> [3] the level table, plain read (ACCESS SHARE to COMMIT) -> draft header FOR UPDATE -> [5b]
--                         THE KEY, SHARED -> the level, plain read -> the header UPDATE -> (the runtime) audit record,
--                         completion -> COMMIT. It never waits for a role row, a version row, a customer or a line.
--       030's edit (v2):  ... -> draft header FOR UPDATE -> [5b] THE KEY, SHARED -> the replacement customer FOR KEY SHARE -> the
--                         lines (whose trigger below re-takes the header FOR SHARE the edit already holds FOR UPDATE: no wait).
--       032's save (v3):  ... -> [10b] THE KEY, SHARED -> the customer FOR KEY SHARE -> the new header and its lines (the line
--                         trigger's FOR SHARE meets the header the save itself inserted: no wait).
--       level writers:    role row FOR UPDATE -> version row FOR UPDATE -> the level UPDATE -> [030's or 032's trigger] THE KEY,
--                         EXCLUSIVE -> 021's version upsert. Never a draft header or a line.
--     WHY IT CANNOT CYCLE: the discard is 030's edit without the customer and the lines, so 030's argument holds unchanged: after
--     its key it waits for nothing (its UPDATE writes the header it already holds FOR UPDATE); two discards, or a discard and an
--     edit, of one draft serialize on the header BEFORE either takes the key; a writer waiting for the key holds only its own
--     pair's role and version rows, which no discard locks; SHARED keys are compatible. An owner's line write takes the header
--     FOR SHARE (the line trigger) and waits for a discard holding it; the discard never waits for a line.
--   - THE GUARDS (terminal state at the database). trg_invoice_draft_terminal, BEFORE INSERT OR UPDATE OR DELETE on the header:
--     an INSERT must be an open draft; an UPDATE of a non-draft header is refused whatever it changes (even a no-op); an UPDATE
--     of an open draft that stays open passes (029's trigger still governs it); an UPDATE of an open draft to 'discarded' must
--     step the version by exactly one and change no customer, currency, line count or subtotal; every other transition is
--     refused; a DELETE of a non-draft header is refused (an open draft stays deletable by the table owner, as today).
--     trg_invoice_draft_line_terminal, BEFORE INSERT OR UPDATE OR DELETE on the lines: the header of the NEW row (INSERT,
--     UPDATE) and of the OLD row (UPDATE, DELETE) is read FOR SHARE — so an owner's line write serializes against a concurrent
--     discard and re-reads the committed status — and a header that is not 'draft' refuses the write. Both raise
--     restrict_violation with fixed text and never the row. Both are SECURITY INVOKER (a trigger function fires without an
--     EXECUTE grant), pinned to pg_catalog then pg_temp, granted to nobody; the line trigger's function runs with row_security
--     off, so a writer whose row security would hide the header fails instead of passing. 029's trigger and function are left
--     as they are; the header carries both triggers, 029's first by name.
--     ENFORCEMENT BOUNDARY: tmpos_app and tmpos_audit_writer hold no privilege on either table (028), so the runtime reaches a
--     row only through the definer routines; the triggers bind every row write by every role, the table owner's and a session
--     running as a replica included (ENABLE ALWAYS). NOT COVERED — the same boundary as 029's trigger: TRUNCATE (owner only;
--     it fires no row trigger), ALTER TABLE ... DISABLE TRIGGER or DROP TRIGGER by the table owner or a member of its role, a
--     replaced function, and a superuser. THE SAME GUARDS MEET A DATA-ONLY LOAD: a data-only restore or replay, or a logical
--     replication table copy, into a schema already at 033 is refused at its first discarded header (an insert must be an
--     open draft), and the line table's load then fails too (its header is not readable) — as 006's outbox guard already
--     refuses a non-pending outbox row. Retained drafts load through a full-schema restore (triggers are post-data), or with
--     both triggers disabled by the table owner for the load and each re-enabled explicitly ENABLE ALWAYS: a restore's own
--     re-enable is a plain ENABLE (origin only), and the startup preflight does not read tgenabled (an input to G-BACKUP).
--   - THE OPEN-ONLY READS (D-DIS-3). m7b_invoice_draft_page_v2 and m7b_invoice_draft_get_v2 are 028's page and get with their
--     arguments, RETURNS TABLE, answers and attributes (plpgsql, SECURITY DEFINER, STABLE, search_path pg_catalog then pg_temp,
--     row_security off) and every statement and raised message of their bodies character for character, EXCEPT EXACTLY ONE
--     PREDICATE EACH: the page's served rows and the get's point read add status = 'draft'. A discarded draft is never served:
--     absent from every page, and a get of it answers exactly 028's 'not_found' row (a missing draft, another store's, another
--     tenant's and a discarded one are one answer). The page's cursor-anchor lookup stays STATUS-BLIND: a continuation naming
--     a draft discarded since its page was served still pages from that draft's place in the order. The page's literal
--     predicate is the partial index's, so the planner can serve the open page from it: its cost stays independent of the
--     discarded rows that accumulate. tmpos_app loses EXECUTE on 028's two reads (bodies untouched), as 031 and 032 revoked
--     their predecessors: no runtime path serves a discarded draft.
--   - THE ROLLBACK-ORDER ANCHOR. 033's objects live in a schema of their own (030's and 029's rollbacks pin the exact routine
--     inventories of tmpos_invoice_edit and tmpos_invoice_draft), and a plpgsql body records no catalog dependency (031 up), so
--     without help 032's, 030's, 029's and 028's rollbacks could run while this file is applied. The anchor
--     m7b_invoice_discard_prerequisites() is a SQL-standard body (BEGIN ATOMIC) naming, as reg* constants, the predecessors the
--     discard contract is built over: 032's create_v3, 030's guard function and edit routine, 029's immutability function, and
--     028's two tables. PostgreSQL records a dependency for each reg* constant of a stored SQL-standard body; a predecessor's
--     rollback that drops one of them (none uses CASCADE) is then refused (dependent_objects_still_exist, 2BP01) and rolls back
--     whole — the refusal class 032's rollback header already lists. 031's rollback refuses while 032 is applied (its
--     postcondition). The postcondition below proves each dependency row is recorded. It is granted to nobody and called by
--     nothing; it answers true.
--   - THE PARTIAL INDEX. invoice_draft_open_page_idx on (tenant_id, store_id, created_at desc, draft_id desc) WHERE status =
--     'draft': 028's page index restricted to open drafts. Built inside this file's maintenance window (below).
--   - APPLY: A MAINTENANCE WINDOW, 030's. Before any check and before any change — its first statements after the settings,
--     with nothing read before them, not even the catalog — the file takes ACCESS EXCLUSIVE until COMMIT on 030's seven tables
--     in the writers' order: public.store, tmpos_role.tenant_role_level, tmpos_role_edit.role_level_version,
--     tmpos_customer.customer, tmpos_invoice_draft.invoice_draft, tmpos_invoice_draft.invoice_draft_line, public.audit_event —
--     in one block whose handler turns a missing table or schema into this file's refusal (55000), the block's locks released
--     first. So no draft save, edit, read or level write is in flight while the CHECK, the index and the triggers go in and the
--     grants move. THE COST: every read and write of those seven tables waits until COMMIT; the CHECK is validated over every
--     header (no row is rewritten) and the index is built over every header.
--   - DEPLOY AND ROLLBACK: FAIL CLOSED BOTH WAYS. It and the runtime that calls the discard and the v2 reads move together: the
--     startup preflight pins the exact ledger (001-033) and the exact grants (the three routines' EXECUTE and the schema's
--     USAGE, 028's two reads' EXECUTE gone), so the 001-032 runtime refuses a 033 database (its read EXECUTE is gone) and this
--     runtime refuses a 032 one. ROLL 033 BACK FIRST, before 032 and every earlier file: while it is applied, 032's, 030's,
--     029's and 028's rollbacks are refused by the anchor's dependencies (2BP01) and 031's by its own postcondition. The
--     rollback REFUSES ON DATA, changing nothing, while any draft is not 'draft': it never deletes a draft or returns one to
--     'draft' — either is an owner decision on data, never a rollback's side effect (029 down). After the first real discard
--     the rollback is therefore one-way in practice, and a discarded draft is at version 2 or above, which 029's rollback
--     refuses too. On a database with no discarded draft it restores the 032-era contract exactly: 028's CHECK, tmpos_app's
--     EXECUTE on 028's two reads, no schema, trigger or index of this file.
--   - WHAT THIS DOES NOT DEFEND (doc 08; none of it is claimed closed). 030's and 032's residuals stand for the discard (ANY
--     DATABASE LOGIN can hold the guard key: availability only; CONVOY behind a waiting writer; two (tenant, role) pairs whose
--     hashes collide are serialized; MULTI-PAIR owner writers can deadlock: 40P01, availability), and:
--       * the TABLE OWNER, or a member of the owner role, can DISABLE either terminal trigger or 030's and 032's guards, replace
--         a function, TRUNCATE the tables or alter them by DDL: the terminal state and the held authority are enforced for every
--         row write WHILE THE TRIGGERS ARE ENABLED;
--       * the owner can still run 028's page and get directly (only tmpos_app's EXECUTE is revoked): they serve a discarded
--         draft too (its status column 'discarded');
--       * an OWNER'S DIRECT LINE WRITE racing an edit of the same open draft can deadlock: the owner's UPDATE or DELETE locks its
--         line before the line trigger reads the header FOR SHARE, while the edit holds the header FOR UPDATE before it
--         replaces the lines. PostgreSQL detects it (40P01) and aborts one side: availability, table-owner paths only (the
--         runtime writes lines only through the definer routines, which take the header first);
--       * a discard is not erasure: the header, its lines, the customer reference and every audit record stay, and no retention
--         period is implied (DA-187).
--   - NO SECRET, NO DYNAMIC SQL, NO EXTENSION, NO TEMPORARY OBJECT, NO BACKFILL. Every statement is fixed text, every value a
--     parameter, every relation and routine schema-qualified; the routines pin their search_path to pg_catalog then pg_temp and
--     run with row_security off; the trigger functions and the anchor pin their search_path.
--
-- Reversible via 033_m7b_invoice_draft_discard.down.sql, which refuses while any draft is discarded and otherwise restores
-- the 032-era contract. Roll 033 back before 032.
--
-- Assumes 001-032 are applied. A future managed apply targets the complete contiguous chain through the newest committed
-- migration — now 001-033 (owner decision D4); this file authorizes no apply.

-- =============================================================================
-- 1) This transaction's settings
-- =============================================================================
set local search_path = pg_catalog, pg_temp;
set local row_security = off;

-- =============================================================================
-- 2) The locks, in the writers' order: the first statements after the settings, before any check or any change
-- =============================================================================
-- 030's seven tables, in 030's order. Nothing is read or checked before them, not even the catalog. A LOCK naming a table or
-- schema that is missing raises undefined_table (42P01) or invalid_schema_name (3F000); the block's handler turns either into
-- this file's refusal (55000). The block runs as a subtransaction: once it completes, this transaction keeps its locks until
-- COMMIT; refused, the subtransaction has released the locks it took, and the refusal aborts the file.
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
    raise exception 'migration 033 refused: public.store, tmpos_role.tenant_role_level, tmpos_role_edit.role_level_version, tmpos_customer.customer, tmpos_invoice_draft.invoice_draft, tmpos_invoice_draft.invoice_draft_line or public.audit_event is missing (migrations 002, 017, 020, 021 and 028 must be applied first)'
      using errcode = 'object_not_in_prerequisite_state';
end
$$;

-- =============================================================================
-- 3) Preconditions: what this file builds on
-- =============================================================================
do $$
declare
  v_me oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user);
begin
  -- Nothing of this file exists yet: it is applied once, over a chain that has never held it.
  if pg_catalog.to_regnamespace('tmpos_invoice_discard') is not null
     or pg_catalog.to_regclass('tmpos_invoice_draft.invoice_draft_open_page_idx') is not null
     or exists (select 1 from pg_catalog.pg_trigger g
                 where g.tgrelid in ('tmpos_invoice_draft.invoice_draft'::regclass, 'tmpos_invoice_draft.invoice_draft_line'::regclass)
                   and g.tgname in ('trg_invoice_draft_terminal', 'trg_invoice_draft_line_terminal'))
     or exists (select 1 from pg_catalog.pg_constraint k
                 where k.conrelid = 'tmpos_invoice_draft.invoice_draft'::regclass and k.conname = 'invoice_draft_status_chk'
                   and pg_catalog.pg_get_constraintdef(k.oid) is distinct from 'CHECK ((status = ''draft''::text))') then
    raise exception 'migration 033 refused: schema tmpos_invoice_discard, the index invoice_draft_open_page_idx, a terminal trigger or the widened status CHECK already exists'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- The runtime roles this file grants to and revokes from, checked before any ::regrole cast below can raise undefined_object.
  if (select pg_catalog.count(*) from pg_catalog.pg_roles r
       where r.rolname = any (array['tmpos_app', 'tmpos_audit_writer', 'anon', 'authenticated']::name[])) <> 4 then
    raise exception 'migration 033 refused: the runtime roles tmpos_app, tmpos_audit_writer, anon and authenticated must exist (migration 005 and the platform''s two client roles)'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- The chain is contiguous: 032 is the newest migration this file sits on — its save routine, its Customers guard function and
  -- its trigger; 030's schema, edit routine, guard function and trigger; 029's immutability function, its trigger (exactly as
  -- 029 left it, the only trigger on the drafts) and its widened version CHECK; 028's tables, its three routines and its status
  -- CHECK, exactly.
  if pg_catalog.to_regprocedure('tmpos_invoice_edit.m7b_invoice_draft_create_v3(text, uuid, uuid, uuid, uuid, jsonb, bigint)') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_edit.m7b_customers_level_guard()') is null
     or not exists (select 1 from pg_catalog.pg_trigger g
                     where g.tgrelid = 'tmpos_role.tenant_role_level'::regclass and g.tgname = 'trg_tenant_role_level_customers_guard'
                       and g.tgfoid = pg_catalog.to_regprocedure('tmpos_invoice_edit.m7b_customers_level_guard()') and g.tgenabled = 'A')
     or pg_catalog.to_regprocedure('tmpos_invoice_edit.m7b_invoice_draft_update_v2(text, uuid, uuid, uuid, bigint, uuid, jsonb, bigint)') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_edit.m7b_invoice_level_guard()') is null
     or not exists (select 1 from pg_catalog.pg_trigger g
                     where g.tgrelid = 'tmpos_role.tenant_role_level'::regclass and g.tgname = 'trg_tenant_role_level_invoice_guard'
                       and g.tgfoid = pg_catalog.to_regprocedure('tmpos_invoice_edit.m7b_invoice_level_guard()') and g.tgenabled = 'A') then
    raise exception 'migration 033 refused: migration 032 must be applied first (its save routine, its Customers guard and trigger, and 030''s edit routine, guard and trigger)'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- tgtype: ROW 1 + BEFORE 2 + UPDATE 16 = 19 (029's).
  if pg_catalog.to_regprocedure('tmpos_invoice_draft.m7b_invoice_draft_immutable()') is null
     or (select pg_catalog.count(*) from pg_catalog.pg_trigger g
          where g.tgrelid = 'tmpos_invoice_draft.invoice_draft'::regclass and not g.tgisinternal) <> 1
     or exists (select 1 from pg_catalog.pg_trigger g
                 where g.tgrelid = 'tmpos_invoice_draft.invoice_draft_line'::regclass and not g.tgisinternal)
     or not exists (select 1 from pg_catalog.pg_trigger g
                     where g.tgrelid = 'tmpos_invoice_draft.invoice_draft'::regclass
                       and g.tgname = 'trg_invoice_draft_immutable'
                       and g.tgfoid = pg_catalog.to_regprocedure('tmpos_invoice_draft.m7b_invoice_draft_immutable()')
                       and g.tgtype = 19
                       and g.tgenabled = 'A'
                       and g.tgattr = ''::pg_catalog.int2vector
                       and g.tgqual is null)
     or (select pg_catalog.count(*) from pg_catalog.pg_constraint k
          where k.conrelid = 'tmpos_invoice_draft.invoice_draft'::regclass and k.conname = 'invoice_draft_version_chk' and k.convalidated
            and pg_catalog.pg_get_constraintdef(k.oid) = 'CHECK (((version >= 1) AND (version <= ''9007199254740991''::bigint)))') <> 1 then
    raise exception 'migration 033 refused: migration 029''s immutability trigger is not the only trigger on the drafts in its exact shape, a trigger is on the lines, or 029''s widened version CHECK is missing'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if pg_catalog.to_regprocedure('tmpos_invoice_draft.m7b_invoice_draft_create(text, uuid, uuid, uuid, uuid, jsonb, bigint)') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_draft.m7b_invoice_draft_page(text, uuid, uuid, uuid, integer)') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_draft.m7b_invoice_draft_get(text, uuid, uuid, uuid)') is null
     or pg_catalog.to_regclass('tmpos_invoice_draft.invoice_draft_page_idx') is null
     or (select pg_catalog.count(*) from pg_catalog.pg_constraint k
          where k.conrelid = 'tmpos_invoice_draft.invoice_draft'::regclass and k.conname = 'invoice_draft_status_chk' and k.contype = 'c'
            and k.convalidated and pg_catalog.pg_get_constraintdef(k.oid) = 'CHECK ((status = ''draft''::text))') <> 1 then
    raise exception 'migration 033 refused: migration 028''s three routines, its page index or its status CHECK is not exactly as 028 left it'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- The objects the routines restate, read or lock.
  if pg_catalog.to_regprocedure('tmpos_session.m5_hold_tenant_standing(text, text)') is null
     or pg_catalog.to_regprocedure('tmpos_session.m5_admit_tenant_session_v2(text, text)') is null
     or pg_catalog.to_regclass('tmpos_session.session') is null
     or pg_catalog.to_regclass('tmpos_mint.tenant_session') is null
     or pg_catalog.to_regclass('tmpos_mint.issuer_key') is null
     or pg_catalog.to_regclass('public.tenant') is null
     or pg_catalog.to_regclass('public.user_membership') is null then
    raise exception 'migration 033 refused: 016''s hold or admission read, 018''s mint ledger or issuer key, or 002''s tenant or membership table is missing'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- The routines call 016's hold and admission read as their owner, the principal applying this file, and read and write the
  -- schemas below.
  if not (pg_catalog.has_function_privilege(current_user, 'tmpos_session.m5_hold_tenant_standing(text, text)', 'EXECUTE')
          and pg_catalog.has_function_privilege(current_user, 'tmpos_session.m5_admit_tenant_session_v2(text, text)', 'EXECUTE')
          and pg_catalog.has_schema_privilege(current_user, 'public', 'USAGE')
          and pg_catalog.has_schema_privilege(current_user, 'tmpos_session', 'USAGE')
          and pg_catalog.has_schema_privilege(current_user, 'tmpos_mint', 'USAGE')
          and pg_catalog.has_schema_privilege(current_user, 'tmpos_role', 'USAGE')
          and pg_catalog.has_schema_privilege(current_user, 'tmpos_invoice_draft', 'USAGE')
          and pg_catalog.has_schema_privilege(current_user, 'tmpos_invoice_edit', 'USAGE')) then
    raise exception 'migration 033 refused: the applying principal cannot execute 016''s hold and admission read, which the routines call, or use the schemas they read'
      using errcode = 'insufficient_privilege';
  end if;
  -- A SECURITY DEFINER routine reads and writes only what its owner may (017's argument): were the applying principal neither
  -- the owner nor a role inheriting the owner of every table the routines read or write — or row security FORCEd on one — the
  -- routines would find no session and refuse everything, or fail on a write. Owning (or inheriting the owner of) the draft
  -- tables is also what creating their triggers, enabling them ALWAYS, replacing the CHECK and building the index need.
  if exists (
    select 1
      from pg_catalog.pg_class c
     where c.oid = any (array['tmpos_session.session'::regclass, 'tmpos_mint.tenant_session'::regclass,
                              'tmpos_mint.issuer_key'::regclass, 'tmpos_role.tenant_role_level'::regclass,
                              'public.store'::regclass, 'public.tenant'::regclass,
                              'public.user_membership'::regclass, 'tmpos_invoice_draft.invoice_draft'::regclass,
                              'tmpos_invoice_draft.invoice_draft_line'::regclass])
       and (not pg_catalog.pg_has_role(current_user, c.relowner, 'USAGE') or c.relforcerowsecurity)) then
    raise exception 'migration 033 refused: the applying principal neither owns nor inherits the owner of a table the routines read or write, or one has forced row security'
      using errcode = 'insufficient_privilege';
  end if;
  -- The revokes below and the rollback's grants are exact only if the applying principal OWNS 028's two reads and the COMPLETE
  -- ACL of each (coalesce(proacl, acldefault), every entry, the owner's included) is exactly two entries: the owner's EXECUTE and
  -- tmpos_app's EXECUTE, each granted by the owner and non-grantable — nothing else, PUBLIC included. Then the rollback's grants
  -- restore the ACLs byte for byte, and the revokes are not silent no-ops.
  if (select pg_catalog.count(*) from pg_catalog.pg_proc p
       where p.oid in ('tmpos_invoice_draft.m7b_invoice_draft_page(text, uuid, uuid, uuid, integer)'::regprocedure,
                       'tmpos_invoice_draft.m7b_invoice_draft_get(text, uuid, uuid, uuid)'::regprocedure)
         and p.proowner = v_me) <> 2
     or exists (select 1 from pg_catalog.pg_proc p
                 where p.oid in ('tmpos_invoice_draft.m7b_invoice_draft_page(text, uuid, uuid, uuid, integer)'::regprocedure,
                                 'tmpos_invoice_draft.m7b_invoice_draft_get(text, uuid, uuid, uuid)'::regprocedure)
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
    raise exception 'migration 033 refused: the applying principal does not own 028''s page and get, or tmpos_app''s EXECUTE on one is not the one non-grantable entry 028 issued'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$$;

-- Under READ COMMITTED the checks above and the postcondition below see every row committed before the locks were granted
-- (017's reason).
do $$
begin
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'migration 033 refused: it must run under READ COMMITTED, so that its checks see every committed row'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$$;

-- =============================================================================
-- 4) The schema
-- =============================================================================
create schema tmpos_invoice_discard;

comment on schema tmpos_invoice_discard is
  'Phase 4.0 M7b (migration 033): discarding a saved invoice draft — the discard routine, the open-only page and get the runtime reads drafts through, the two terminal-state trigger functions and the rollback-order anchor. Owned by this migration; tmpos_app holds USAGE and EXECUTE on the discard and the two reads only.';

revoke all on schema tmpos_invoice_discard from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
grant usage on schema tmpos_invoice_discard to tmpos_app;

-- =============================================================================
-- 5) The status: 'draft' or 'discarded', under the same constraint name
-- =============================================================================
-- One statement: the old CHECK dropped and the new one added, validated over every existing row (028 left them all 'draft').
alter table tmpos_invoice_draft.invoice_draft
  drop constraint invoice_draft_status_chk,
  add constraint invoice_draft_status_chk check (status in ('draft', 'discarded'));

-- =============================================================================
-- 6) The open page's partial index
-- =============================================================================
-- 028's page index restricted to open drafts: the open-only page (section 9) carries this exact predicate.
create index invoice_draft_open_page_idx on tmpos_invoice_draft.invoice_draft (tenant_id, store_id, created_at desc, draft_id desc)
  where status = 'draft';

comment on index tmpos_invoice_draft.invoice_draft_open_page_idx is
  'Phase 4.0 M7b (migration 033): the open-only page''s order, inside one tenant and store, over open drafts only, so the page''s cost stays independent of discarded rows.';

-- =============================================================================
-- 7) The terminal state at the database: the header's and the lines' triggers
-- =============================================================================
-- SECURITY INVOKER and granted to nobody: a trigger function fires without an EXECUTE grant. A firing this file does not
-- declare raises rather than guessing (015's rule). BEFORE ROW, so a refused write changes nothing. Each refusal is
-- restrict_violation with fixed text, never a value of the row.
create function tmpos_invoice_discard.m7b_invoice_draft_terminal()
returns trigger
language plpgsql
volatile
security invoker
set search_path = pg_catalog, pg_temp
as $$
begin
  if tg_when is distinct from 'BEFORE' or tg_level is distinct from 'ROW'
     or tg_op not in ('INSERT', 'UPDATE', 'DELETE')
     or tg_table_schema is distinct from 'tmpos_invoice_draft' or tg_table_name is distinct from 'invoice_draft' then
    raise exception 'm7b_invoice_draft_terminal: fired by an undeclared trigger'
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
    -- A discarded draft is kept (logical discard); an open draft stays deletable by the table owner, as before.
    if old.status is distinct from 'draft' then
      raise exception 'migration 033: a discarded invoice draft is never deleted'
        using errcode = 'restrict_violation';
    end if;
    return old;
  end if;
  -- An UPDATE.
  if old.status is distinct from 'draft' then
    -- Terminal: no update of any kind, a no-op and a return to 'draft' included.
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
  raise exception 'migration 033: an open invoice draft moves only to discarded, at the next version, with nothing else changed'
    using errcode = 'restrict_violation';
end
$$;

comment on function tmpos_invoice_discard.m7b_invoice_draft_terminal() is
  'Phase 4.0 M7b (migration 033): BEFORE INSERT OR UPDATE OR DELETE row trigger on tmpos_invoice_draft.invoice_draft (enabled ALWAYS). Raises restrict_violation (fixed message) when an insert is not an open draft (status draft); when an update meets a header that is not open (a discarded draft is terminal: no update at all, a no-op and a return to draft included); when an update of an open draft sets any status but draft or discarded, or moves it to discarded without stepping the version by exactly one or while changing the customer, currency, line count or subtotal; and when a delete meets a header that is not open. Raises triggered_action_exception for any other firing. Reads no relation. Granted to nobody.';

create trigger trg_invoice_draft_terminal
  before insert or update or delete on tmpos_invoice_draft.invoice_draft
  for each row execute function tmpos_invoice_discard.m7b_invoice_draft_terminal();

-- ALWAYS, as 029's is: a write by a session running as a replica meets it too.
alter table tmpos_invoice_draft.invoice_draft enable always trigger trg_invoice_draft_terminal;

comment on trigger trg_invoice_draft_terminal on tmpos_invoice_draft.invoice_draft is
  'Phase 4.0 M7b (migration 033): the terminal discarded state of an invoice draft header (tmpos_invoice_discard.m7b_invoice_draft_terminal). Enabled ALWAYS.';

-- The line trigger reads its header(s) FOR SHARE: an owner's line write waits for a discard that holds the header and then
-- re-reads the committed status (READ COMMITTED re-evaluates a locked row). Inside the edit and the save the header is already
-- the writer's own (held FOR UPDATE, or inserted by it): no wait. row_security off: a writer whose row security would hide
-- the header fails here instead of passing; a header that is not found refuses the write too (the foreign key guarantees one).
create function tmpos_invoice_discard.m7b_invoice_draft_line_terminal()
returns trigger
language plpgsql
volatile
security invoker
set search_path = pg_catalog, pg_temp
set row_security = off
as $$
declare
  v_ids    uuid[];
  v_found  integer;
  v_closed integer;
begin
  if tg_when is distinct from 'BEFORE' or tg_level is distinct from 'ROW'
     or tg_op not in ('INSERT', 'UPDATE', 'DELETE')
     or tg_table_schema is distinct from 'tmpos_invoice_draft' or tg_table_name is distinct from 'invoice_draft_line' then
    raise exception 'm7b_invoice_draft_line_terminal: fired by an undeclared trigger'
      using errcode = 'triggered_action_exception';
  end if;
  if tg_op = 'INSERT' then
    v_ids := array[new.draft_id];
  elsif tg_op = 'DELETE' then
    v_ids := array[old.draft_id];
  elsif old.draft_id is distinct from new.draft_id then
    v_ids := array[old.draft_id, new.draft_id];
  else
    v_ids := array[old.draft_id];
  end if;
  -- One statement, the headers locked in id order.
  select pg_catalog.count(*)::integer, (pg_catalog.count(*) filter (where h.status is distinct from 'draft'))::integer
    into v_found, v_closed
    from (select d.status
            from tmpos_invoice_draft.invoice_draft d
           where d.draft_id = any (v_ids)
           order by d.draft_id
             for share of d) h;
  if v_found is distinct from pg_catalog.cardinality(v_ids) then
    raise exception 'migration 033: an invoice draft line''s header is not readable'
      using errcode = 'restrict_violation';
  end if;
  if v_closed <> 0 then
    raise exception 'migration 033: a line of a discarded invoice draft never changes'
      using errcode = 'restrict_violation';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end
$$;

comment on function tmpos_invoice_discard.m7b_invoice_draft_line_terminal() is
  'Phase 4.0 M7b (migration 033): BEFORE INSERT OR UPDATE OR DELETE row trigger on tmpos_invoice_draft.invoice_draft_line (enabled ALWAYS). Reads the header of the new line (insert, update) and of the old line (update, delete) FOR SHARE, in id order, with row_security off, and raises restrict_violation (fixed message) when one is not open (a line of a discarded draft never changes, is never added and never deleted) or is not found. Raises triggered_action_exception for any other firing. Granted to nobody.';

create trigger trg_invoice_draft_line_terminal
  before insert or update or delete on tmpos_invoice_draft.invoice_draft_line
  for each row execute function tmpos_invoice_discard.m7b_invoice_draft_line_terminal();

-- ALWAYS: a write by a session running as a replica meets it too.
alter table tmpos_invoice_draft.invoice_draft_line enable always trigger trg_invoice_draft_line_terminal;

comment on trigger trg_invoice_draft_line_terminal on tmpos_invoice_draft.invoice_draft_line is
  'Phase 4.0 M7b (migration 033): the terminal discarded state of an invoice draft''s lines (tmpos_invoice_discard.m7b_invoice_draft_line_terminal). Enabled ALWAYS.';

-- =============================================================================
-- 8) The discard
-- =============================================================================
create function tmpos_invoice_discard.m7b_invoice_draft_discard(
  p_session_key text, p_store_id uuid, p_draft_id uuid, p_expected_tenant uuid, p_expected_version bigint)
returns table (
  o_outcome       text,
  o_tenant_id     uuid,
  o_store_id      uuid,
  o_actor_id      uuid,
  o_membership_id uuid,
  o_version       bigint
)
language plpgsql
-- VOLATILE IS LOAD-BEARING (019's, 020's, 024's, 028's and 030's reason): it locks and then re-reads, and each statement must
-- see what committed before its own locks. Do not make it STABLE.
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
  v_tenant         uuid;
  v_membership     uuid;
  v_store          record;
  v_invoices       text;
  v_header         record;
  v_written        bigint;
  v_updated        integer;
  v_check          record;
begin
  -- 0. Every argument, before anything is read, locked or written. A refusal carries a fixed message, never the value: one
  -- for the four identities together (030's wording), one for the version.
  if p_session_key is null or p_session_key !~ '^[\x21-\x7e]{1,128}$'
     or p_store_id is null
     or p_draft_id is null
     or p_expected_tenant is null then
    raise exception 'migration 033 discard: an argument is malformed'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_expected_version is null or p_expected_version < 1 or p_expected_version > 9007199254740990 then
    raise exception 'migration 033 discard: the expected version is not one the draft table can advance'
      using errcode = 'invalid_parameter_value';
  end if;
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'migration 033 discard: it must run under READ COMMITTED, so that its checks see what committed before its locks'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- 1. The caller, derived exactly as 030's edit derives it (030 up, step 1, itself 028's create, steps 1-6; 024 and 019 give
  --    each step's reason): the unlocked live/issuer pre-check, 016's hold, the session and ledger rows FOR SHARE, the issuer
  --    key FOR SHARE, the clock after those waits, the standing digest the session was minted under, a write account status.
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

  -- 2. EXACTLY ONE store-scope grant naming p_store_id — a selector among the actor's own grants, never proof — on a tenant
  --    and a store whose statuses are write statuses (028's step 7). A tenant grant and a grant at another store never count.
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
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint;
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
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint;
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
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint;
    return;
  end if;

  -- 3. The role's Invoices level, UNLOCKED, at Manage or above (D-DIS-2): an early pre-check, refusing before the header is
  --    locked (the decision of record is step 5b's). store_owner is Full (never stored); an editable role is its stored
  --    level, else its catalog default; any other role refuses. Nothing is written or locked by a refusal here.
  if v_role = 'store_owner' then
    null;
  elsif v_role in ('manager', 'technician', 'sales_staff') then
    select l.level into v_invoices
      from tmpos_role.tenant_role_level l
     where l.tenant_id = v_tenant and l.role_id = v_role and l.domain = 'invoices';
    if coalesce(pg_catalog.array_position(c_levels,
         coalesce(v_invoices, case v_role when 'manager' then 'full' when 'technician' then 'view' when 'sales_staff' then 'create' end)), 0)
       < pg_catalog.array_position(c_levels, 'manage') then
      return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint;
      return;
    end if;
  else
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint;
    return;
  end if;

  -- 4. The request's expectedTenant (caller-supplied, never authority) against the tenant derived from the grant — a
  --    precondition only (021's and 022's rule): nothing written, nothing locked beyond the derivation's rows.
  if v_tenant is distinct from p_expected_tenant then
    return query select 'tenant_mismatch'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint;
    return;
  end if;

  -- 5. The header, locked FOR UPDATE until COMMIT in ONE statement, filtered by id, derived tenant and store ONLY (never the
  --    version or the status: under READ COMMITTED a waiter re-evaluates its WHERE on the row a concurrent edit or discard
  --    committed, and a version or status filter there would turn that change into 'not_found' instead of 'conflict' or
  --    'invalid_state'). A missing id, another store's and another tenant's take this same statement and answer — before
  --    the role's key is taken (step 5b).
  select d.status, d.version, d.customer_id, d.line_count
    into v_header
    from tmpos_invoice_draft.invoice_draft d
   where d.draft_id = p_draft_id
     and d.tenant_id = v_tenant
     and d.store_id = p_store_id
     for update;
  if not found then
    return query select 'not_found'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint;
    return;
  end if;
  -- Live, on the database clock read again now: the header lock may have waited (an edit or another discard of this draft).
  v_now := pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp()) * 1000)::bigint;
  if v_now >= v_session.expires_at then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint;
    return;
  end if;

  -- 5b. THE GUARD (030's step 5b, at Manage): the role's key taken SHARED and held until COMMIT, then the level decided
  --     again. The header is locked, so every other edit and discard of this draft is out; what is left to order against is
  --     a writer of the role's Invoices or Customers level, which takes the same key EXCLUSIVE (030's and 032's triggers).
  --     Every answer below — the sealed 'invalid_state' and 'conflict' and the discard itself — is decided after this point
  --     and committed while the key is held. Three SEPARATE top-level statements of the routine's outermost block, never
  --     inside a BEGIN ... EXCEPTION block (a subtransaction that aborts releases a transaction-scoped advisory lock): the
  --     key; the clock again, because the wait may have been long (an expired session is refused); and the level read again
  --     by a PLAIN SELECT, a fresh READ COMMITTED snapshot taken after the wait, so a level a writer committed before
  --     releasing the key is seen. No FOR SHARE or FOR UPDATE on a role or version row after the key (030's lock-order rule),
  --     nothing inserted: a role without a stored level is decided on its catalog default and no row is made for it. The
  --     plain SELECT's ACCESS SHARE on the table, held to COMMIT, is what orders a TRUNCATE. store_owner is Full and never
  --     stored: no key, no read.
  if v_role in ('manager', 'technician', 'sales_staff') then
    perform pg_catalog.pg_advisory_xact_lock_shared(530030, pg_catalog.hashtext(v_tenant::text || '/' || v_role));
    v_now := pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp()) * 1000)::bigint;
    if v_now >= v_session.expires_at then
      return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint;
      return;
    end if;
    select l.level into v_invoices
      from tmpos_role.tenant_role_level l
     where l.tenant_id = v_tenant and l.role_id = v_role and l.domain = 'invoices';
    if coalesce(pg_catalog.array_position(c_levels,
         coalesce(v_invoices, case v_role when 'manager' then 'full' when 'technician' then 'view' when 'sales_staff' then 'create' end)), 0)
       < pg_catalog.array_position(c_levels, 'manage') then
      return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint;
      return;
    end if;
  end if;

  -- 6. Only an open draft is discarded: 'discarded' is terminal. Decided BEFORE the version (D-DIS-3): a request against an
  --    already-discarded draft is 'invalid_state' whatever version it names.
  if v_header.status is distinct from 'draft' then
    return query select 'invalid_state'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint;
    return;
  end if;

  -- 7. The version: a stale discard conflicts — it would discard a change its operator has not seen (D-DIS-3).
  if v_header.version is distinct from p_expected_version then
    return query select 'conflict'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint;
    return;
  end if;

  -- 8. The discard: ONE statement on exactly the locked draft at the expected version, still open. Only the status and the
  --    version are written; draft_id, the tenant, the store, the customer, the currency, the line count, the subtotal,
  --    created_at, created_by and every line stay. The triggers admit exactly this transition, so no constraint can refuse
  --    it; were one ever to, the raise is fixed text, never the row.
  begin
    update tmpos_invoice_draft.invoice_draft d
       set status = 'discarded', version = d.version + 1
     where d.draft_id = p_draft_id
       and d.tenant_id = v_tenant
       and d.store_id = p_store_id
       and d.version = p_expected_version
       and d.status = 'draft'
    returning d.version into v_written;
    get diagnostics v_updated = row_count;
  exception
    when check_violation or restrict_violation or not_null_violation then
      raise exception 'migration 033 discard: the draft is not one the draft table admits'
        using errcode = 'integrity_constraint_violation';
  end;
  if v_updated <> 1 or v_written is distinct from p_expected_version + 1 then
    raise exception 'migration 033 discard: the discard was not written to exactly the locked draft at the next version'
      using errcode = 'no_data_found';
  end if;

  -- 9. The verification read: the locked draft is discarded at the next version.
  select d.status, d.version into v_check
    from tmpos_invoice_draft.invoice_draft d
   where d.draft_id = p_draft_id
     and d.tenant_id = v_tenant
     and d.store_id = p_store_id;
  if not found or v_check.status is distinct from 'discarded' or v_check.version is distinct from p_expected_version + 1 then
    raise exception 'migration 033 discard: the discarded draft is not the one judged'
      using errcode = 'no_data_found';
  end if;

  return query select 'applied'::text, v_tenant, p_store_id, v_admission.actor_id, v_membership, v_written;
end
$$;

comment on function tmpos_invoice_discard.m7b_invoice_draft_discard(text, uuid, uuid, uuid, bigint) is
  'Phase 4.0 M7b (migration 033): discards one saved invoice draft (draft -> discarded, terminal, version + 1, nothing else changed and nothing deleted) at an expected version, at a store, for a key naming a ledger-minted, live (database clock, read after every lock wait) tenant session minted under the installed issuer key, after 016''s hold and the session, ledger and issuer key rows, whose standing digest is unchanged, whose account status is active or trialing, who holds EXACTLY ONE active store-scope grant at p_store_id (a selector only) on an active or trialing tenant and store — the store row re-read FOR SHARE in that grant''s tenant — and whose role''s Invoices level is Manage or above (store_owner full; manager, technician, sales_staff the owner''s stored level, else the catalog default). That level is read unlocked as an early pre-check and decided again after the draft header is locked FOR UPDATE and the role''s transaction-scoped advisory key pg_advisory_xact_lock_shared(530030, hashtext(tenant || ''/'' || role)) is taken (a plain read; nothing inserted or row-locked; the session''s clock read again after the wait), and the key is held until the command transaction ends, so a writer of the role''s Invoices or Customers level — which takes the same key EXCLUSIVE — cannot commit a change while the discard holds the key, and a narrowing that committed first refuses the discard. Judges every argument first (invalid_parameter_value, a fixed message that never carries the value: one for the session key, store, draft and expected tenant together, as 030 words it, and one for the expected version, 1 to 9007199254740990). Answers one row: (''refused'', NULLs) for any authority refusal, the second level decision and a session that expired while the header or the key waited included; (''tenant_mismatch'', NULLs) when the grant''s tenant is not p_expected_tenant; (''not_found'', NULLs) alike for a missing, another store''s and another tenant''s draft, before the key; then, the header locked and the key held: (''invalid_state'', NULLs) for a draft that is not open, whatever version is named; (''conflict'', NULLs) for any other version — every one of these with nothing written; else writes status discarded and version + 1 and answers (''applied'', tenant, store, actor, membership, new version). Writes no line, customer, role or version row, and no audit, outbox or idempotency record.';

-- =============================================================================
-- 9) The open-only reads: 028's page and get, each with one predicate added
-- =============================================================================
-- 9a) The page: 028's 7b with its served rows filtered to open drafts; the cursor anchor stays status-blind.
create function tmpos_invoice_discard.m7b_invoice_draft_page_v2(
  p_session_key text, p_expected_tenant uuid, p_expected_store uuid, p_after_draft_id uuid, p_limit integer)
returns table (
  o_outcome        text,
  o_tenant_id      uuid,
  o_store_id       uuid,
  o_draft_id       uuid,
  o_customer_id    uuid,
  o_status         text,
  o_currency       text,
  o_line_count     integer,
  o_subtotal_cents bigint,
  o_created_at     text
)
language plpgsql
-- STABLE IS LOAD-BEARING (017's reason): every statement — the session, the grant, the level, the anchor and the page — runs
-- on the calling statement's snapshot. It locks nothing and can write nothing.
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
  v_tenant    uuid;
  v_membership uuid;
  v_level     text;
  v_after     timestamptz;
begin
  if p_session_key is null or p_session_key !~ '^[\x21-\x7e]{1,128}$'
     or p_expected_tenant is null or p_expected_store is null
     or p_limit is null or p_limit < 1 or p_limit > 51 then
    return query select 'invalid'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::text, null::text, null::integer,
      null::bigint, null::text;
    return;
  end if;

  -- 1-3. 027's read (see there): a minted, live tenant session under the installed key, its principal's standing the one
  --      minted, an account whose status admits a read. A revoked session has no row.
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
    return query select 'denied'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::text, null::text, null::integer,
      null::bigint, null::text;
    return;
  end if;
  select pg_catalog.sha256(k.key) into v_issuer from tmpos_mint.issuer_key k where k.singleton;
  if v_issuer is null or v_issuer is distinct from v_session.issuer_digest then
    return query select 'denied'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::text, null::text, null::integer,
      null::bigint, null::text;
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
     or v_admission.account_status not in ('active', 'trialing', 'overdue', 'read_only')
     or pg_catalog.jsonb_typeof(v_admission.memberships) is distinct from 'array' then
    return query select 'denied'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::text, null::text, null::integer,
      null::bigint, null::text;
    return;
  end if;

  -- 4. Exactly one store-scope grant naming the expected store, with read statuses, still the actor's active membership
  --    row, its store row in its tenant with a read status and its tenant row a read status; the grant's tenant must be
  --    the expected one (a precondition only).
  select pg_catalog.jsonb_agg(e.entry) into v_grants
    from pg_catalog.jsonb_array_elements(v_admission.memberships) as e(entry)
   where e.entry ->> 'scopeType' = 'store'
     and e.entry ->> 'storeId' = p_expected_store::text;
  if v_grants is null
     or pg_catalog.jsonb_array_length(v_grants) <> 1
     or (v_grants -> 0 ->> 'tenantId') is null
     or (v_grants -> 0 ->> 'membershipId') is null
     or (v_grants -> 0 ->> 'roleId') is null
     or coalesce(v_grants -> 0 ->> 'tenantStatus', '') not in ('active', 'trialing', 'overdue', 'read_only')
     or coalesce(v_grants -> 0 ->> 'storeStatus', '') not in ('active', 'trialing', 'overdue', 'read_only') then
    return query select 'denied'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::text, null::text, null::integer,
      null::bigint, null::text;
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
          and um.store_id = p_expected_store
          and um.role_id = v_role
          and st.status in ('active', 'trialing', 'overdue', 'read_only')
          and t.status in ('active', 'trialing', 'overdue', 'read_only')) then
    return query select 'denied'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::text, null::text, null::integer,
      null::bigint, null::text;
    return;
  end if;

  -- 5. The role's Invoices level must meet View: store_owner Full; an editable role its stored level, else its catalog
  --    default; any other role 'denied'. Unlocked, on this call's snapshot.
  if v_role = 'store_owner' then
    null;
  elsif v_role in ('manager', 'technician', 'sales_staff') then
    select l.level into v_level
      from tmpos_role.tenant_role_level l
     where l.tenant_id = v_tenant and l.role_id = v_role and l.domain = 'invoices';
    if coalesce(pg_catalog.array_position(c_levels,
         coalesce(v_level, case v_role when 'manager' then 'full' when 'technician' then 'view' when 'sales_staff' then 'create' end)), 0)
       < pg_catalog.array_position(c_levels, 'view') then
      return query select 'denied'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::text, null::text, null::integer,
        null::bigint, null::text;
      return;
    end if;
  else
    return query select 'denied'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::text, null::text, null::integer,
      null::bigint, null::text;
    return;
  end if;

  -- 6. The anchor a continuation names, re-read INSIDE the derived tenant and the expected store: missing, another store's
  --    and another tenant's are one answer. Its created_at never leaves the database. STATUS-BLIND (033): a continuation
  --    naming a draft discarded since its page was served still pages from that draft's place in the order.
  if p_after_draft_id is not null then
    select d.created_at into v_after
      from tmpos_invoice_draft.invoice_draft d
     where d.draft_id = p_after_draft_id
       and d.tenant_id = v_tenant
       and d.store_id = p_expected_store;
    if not found then
      return query select 'cursor_unknown'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::text, null::text,
        null::integer, null::bigint, null::text;
      return;
    end if;
  end if;

  -- 7. The page: open drafts only (033: a discarded draft is never served; the literal predicate is the partial index's,
  --    invoice_draft_open_page_idx), newest first, the id breaking equal times, strictly after the anchor in that order.
  return query
    select 'draft'::text, d.tenant_id, d.store_id, d.draft_id, d.customer_id, d.status::text, d.currency::text, d.line_count,
           d.subtotal_cents,
           pg_catalog.to_char(d.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
      from tmpos_invoice_draft.invoice_draft d
     where d.tenant_id = v_tenant
       and d.store_id = p_expected_store
       and d.status = 'draft'
       and (p_after_draft_id is null or (d.created_at, d.draft_id) < (v_after, p_after_draft_id))
     order by d.created_at desc, d.draft_id desc
     limit p_limit;
end
$$;

comment on function tmpos_invoice_discard.m7b_invoice_draft_page_v2(text, uuid, uuid, uuid, integer) is
  'Phase 4.0 M7b (migration 033): migration 028''s m7b_invoice_draft_page serving open drafts only: one page (at most p_limit, 1-51) of the OPEN (status draft) drafts of exactly one tenant and store, newest first by (created_at desc, draft_id desc), each row (''draft'', tenant, store, draft id, customer id, status, currency, line count, subtotal cents, created_at as UTC text with microseconds), for a key naming a ledger-minted, live tenant session under the installed issuer key whose standing digest is unchanged, whose account status admits a read, who holds EXACTLY ONE store-scope grant at p_expected_store — still its active membership, its store in its tenant, account, tenant and store active, trialing, overdue or read_only — on p_expected_tenant (a precondition only), and whose role''s Invoices level is View or above. A continuation names an anchor draft id, re-read inside that tenant and store whatever its status (''cursor_unknown'' alike for a missing, another store''s and another tenant''s; a discarded anchor still pages). A discarded draft is never served. No row for a store with no open draft; otherwise (''denied'', NULLs) or (''invalid'', NULLs). Read-only; locks nothing.';

-- 9b) The get: 028's 7c with its point read filtered to an open draft; a discarded draft answers 028's not_found.
create function tmpos_invoice_discard.m7b_invoice_draft_get_v2(
  p_session_key text, p_expected_tenant uuid, p_expected_store uuid, p_draft_id uuid)
returns table (
  o_outcome          text,
  o_tenant_id        uuid,
  o_store_id         uuid,
  o_draft_id         uuid,
  o_customer_id      uuid,
  o_status           text,
  o_currency         text,
  o_version          bigint,
  o_created_at       text,
  o_line_count       integer,
  o_subtotal_cents   bigint,
  o_position         integer,
  o_description      text,
  o_quantity         bigint,
  o_unit_price_cents bigint,
  o_line_total_cents bigint
)
language plpgsql
-- STABLE IS LOAD-BEARING (017's reason): the header and its lines are read on the calling statement's one snapshot, so they
-- are one draft's at one instant. It locks nothing and can write nothing.
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
  v_tenant    uuid;
  v_membership uuid;
  v_level     text;
  v_draft     record;
begin
  if p_session_key is null or p_session_key !~ '^[\x21-\x7e]{1,128}$'
     or p_expected_tenant is null or p_expected_store is null or p_draft_id is null then
    return query select 'invalid'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::text, null::text, null::bigint,
      null::text, null::integer, null::bigint, null::integer, null::text, null::bigint, null::bigint, null::bigint;
    return;
  end if;

  -- 1-5. Exactly the page's derivation (7b, steps 1-5).
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
    return query select 'denied'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::text, null::text, null::bigint,
      null::text, null::integer, null::bigint, null::integer, null::text, null::bigint, null::bigint, null::bigint;
    return;
  end if;
  select pg_catalog.sha256(k.key) into v_issuer from tmpos_mint.issuer_key k where k.singleton;
  if v_issuer is null or v_issuer is distinct from v_session.issuer_digest then
    return query select 'denied'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::text, null::text, null::bigint,
      null::text, null::integer, null::bigint, null::integer, null::text, null::bigint, null::bigint, null::bigint;
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
     or v_admission.account_status not in ('active', 'trialing', 'overdue', 'read_only')
     or pg_catalog.jsonb_typeof(v_admission.memberships) is distinct from 'array' then
    return query select 'denied'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::text, null::text, null::bigint,
      null::text, null::integer, null::bigint, null::integer, null::text, null::bigint, null::bigint, null::bigint;
    return;
  end if;
  select pg_catalog.jsonb_agg(e.entry) into v_grants
    from pg_catalog.jsonb_array_elements(v_admission.memberships) as e(entry)
   where e.entry ->> 'scopeType' = 'store'
     and e.entry ->> 'storeId' = p_expected_store::text;
  if v_grants is null
     or pg_catalog.jsonb_array_length(v_grants) <> 1
     or (v_grants -> 0 ->> 'tenantId') is null
     or (v_grants -> 0 ->> 'membershipId') is null
     or (v_grants -> 0 ->> 'roleId') is null
     or coalesce(v_grants -> 0 ->> 'tenantStatus', '') not in ('active', 'trialing', 'overdue', 'read_only')
     or coalesce(v_grants -> 0 ->> 'storeStatus', '') not in ('active', 'trialing', 'overdue', 'read_only') then
    return query select 'denied'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::text, null::text, null::bigint,
      null::text, null::integer, null::bigint, null::integer, null::text, null::bigint, null::bigint, null::bigint;
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
          and um.store_id = p_expected_store
          and um.role_id = v_role
          and st.status in ('active', 'trialing', 'overdue', 'read_only')
          and t.status in ('active', 'trialing', 'overdue', 'read_only')) then
    return query select 'denied'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::text, null::text, null::bigint,
      null::text, null::integer, null::bigint, null::integer, null::text, null::bigint, null::bigint, null::bigint;
    return;
  end if;
  if v_role = 'store_owner' then
    null;
  elsif v_role in ('manager', 'technician', 'sales_staff') then
    select l.level into v_level
      from tmpos_role.tenant_role_level l
     where l.tenant_id = v_tenant and l.role_id = v_role and l.domain = 'invoices';
    if coalesce(pg_catalog.array_position(c_levels,
         coalesce(v_level, case v_role when 'manager' then 'full' when 'technician' then 'view' when 'sales_staff' then 'create' end)), 0)
       < pg_catalog.array_position(c_levels, 'view') then
      return query select 'denied'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::text, null::text, null::bigint,
        null::text, null::integer, null::bigint, null::integer, null::text, null::bigint, null::bigint, null::bigint;
      return;
    end if;
  else
    return query select 'denied'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::text, null::text, null::bigint,
      null::text, null::integer, null::bigint, null::integer, null::text, null::bigint, null::bigint, null::bigint;
    return;
  end if;

  -- 6. ONE point read: the key, filtered to the derived tenant AND the expected store AND an open draft (033). A missing id,
  --    another store's, another tenant's and a discarded draft take this same statement and this same branch.
  select d.draft_id, d.customer_id, d.status, d.currency, d.version, d.line_count, d.subtotal_cents,
         pg_catalog.to_char(d.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at
    into v_draft
    from tmpos_invoice_draft.invoice_draft d
   where d.draft_id = p_draft_id
     and d.tenant_id = v_tenant
     and d.store_id = p_expected_store
     and d.status = 'draft';
  if not found then
    return query select 'not_found'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::text, null::text, null::bigint,
      null::text, null::integer, null::bigint, null::integer, null::text, null::bigint, null::bigint, null::bigint;
    return;
  end if;

  -- 7. Its lines, in order, each row carrying the header.
  return query
    select 'draft'::text, v_tenant, p_expected_store, v_draft.draft_id, v_draft.customer_id, v_draft.status::text,
           v_draft.currency::text, v_draft.version, v_draft.created_at, v_draft.line_count, v_draft.subtotal_cents,
           l.position, l.description::text, l.quantity, l.unit_price_cents, l.line_total_cents
      from tmpos_invoice_draft.invoice_draft_line l
     where l.draft_id = p_draft_id
       and l.tenant_id = v_tenant
       and l.store_id = p_expected_store
     order by l.position;
end
$$;

comment on function tmpos_invoice_discard.m7b_invoice_draft_get_v2(text, uuid, uuid, uuid) is
  'Phase 4.0 M7b (migration 033): migration 028''s m7b_invoice_draft_get serving open drafts only: one OPEN (status draft) draft of exactly one tenant and store with its lines — one row per line in position order, each (''draft'', tenant, store, draft id, customer id, status, currency, version, created_at as UTC text with microseconds, line count, subtotal cents, position, description, quantity, unit price cents, line total cents) — under 028''s page derivation (a minted, live, unchanged-standing tenant session; exactly one store grant at p_expected_store on p_expected_tenant, a precondition only; read statuses; Invoices View). (''not_found'', NULLs) alike for a missing draft, another store''s or tenant''s, and a discarded one; otherwise (''denied'', NULLs) or (''invalid'', NULLs). Read-only; locks nothing.';

-- =============================================================================
-- 10) The rollback-order anchor
-- =============================================================================
-- A SQL-standard body is stored parsed, and PostgreSQL records a dependency for every reg* constant in it: each name below is a
-- predecessor this file's contract is built over, and DROP FUNCTION or DROP TABLE of it without CASCADE — the predecessors'
-- rollbacks — is refused (2BP01) while this function exists. It is never called; it answers true.
create function tmpos_invoice_discard.m7b_invoice_discard_prerequisites()
returns boolean
language sql
stable
security invoker
set search_path = pg_catalog, pg_temp
begin atomic
  select 'tmpos_invoice_edit.m7b_invoice_draft_create_v3(text, uuid, uuid, uuid, uuid, jsonb, bigint)'::pg_catalog.regprocedure is not null
     and 'tmpos_invoice_edit.m7b_invoice_level_guard()'::pg_catalog.regprocedure is not null
     and 'tmpos_invoice_edit.m7b_invoice_draft_update_v2(text, uuid, uuid, uuid, bigint, uuid, jsonb, bigint)'::pg_catalog.regprocedure is not null
     and 'tmpos_invoice_draft.m7b_invoice_draft_immutable()'::pg_catalog.regprocedure is not null
     and 'tmpos_invoice_draft.invoice_draft'::pg_catalog.regclass is not null
     and 'tmpos_invoice_draft.invoice_draft_line'::pg_catalog.regclass is not null;
end;

comment on function tmpos_invoice_discard.m7b_invoice_discard_prerequisites() is
  'Phase 4.0 M7b (migration 033): the rollback-order anchor. A SQL-standard body naming, as reg* constants, migration 032''s tmpos_invoice_edit.m7b_invoice_draft_create_v3, 030''s m7b_invoice_level_guard and m7b_invoice_draft_update_v2, 029''s tmpos_invoice_draft.m7b_invoice_draft_immutable and 028''s two draft tables, so their recorded dependencies refuse (2BP01) each of those migrations'' rollbacks while migration 033 is applied: roll 033 back first. Never called; answers true. Granted to nobody.';

-- =============================================================================
-- 11) Privileges, and the proof that nothing wider was issued
-- =============================================================================
-- PostgreSQL grants EXECUTE on a new function to PUBLIC by default, so every default is removed explicitly before the intended
-- grants are issued. The trigger functions and the anchor are granted to nobody. tmpos_app loses its EXECUTE on 028's page and
-- get, which stay in their schema, unaltered, for the rollback. No table grant.
revoke all on function tmpos_invoice_discard.m7b_invoice_draft_discard(text, uuid, uuid, uuid, bigint) from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
revoke all on function tmpos_invoice_discard.m7b_invoice_draft_page_v2(text, uuid, uuid, uuid, integer) from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
revoke all on function tmpos_invoice_discard.m7b_invoice_draft_get_v2(text, uuid, uuid, uuid) from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
revoke all on function tmpos_invoice_discard.m7b_invoice_draft_terminal() from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
revoke all on function tmpos_invoice_discard.m7b_invoice_draft_line_terminal() from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
revoke all on function tmpos_invoice_discard.m7b_invoice_discard_prerequisites() from public, anon, authenticated, tmpos_app, tmpos_audit_writer;

revoke execute on function tmpos_invoice_draft.m7b_invoice_draft_page(text, uuid, uuid, uuid, integer) from tmpos_app;
revoke execute on function tmpos_invoice_draft.m7b_invoice_draft_get(text, uuid, uuid, uuid) from tmpos_app;

grant execute on function tmpos_invoice_discard.m7b_invoice_draft_discard(text, uuid, uuid, uuid, bigint) to tmpos_app;
grant execute on function tmpos_invoice_discard.m7b_invoice_draft_page_v2(text, uuid, uuid, uuid, integer) to tmpos_app;
grant execute on function tmpos_invoice_discard.m7b_invoice_draft_get_v2(text, uuid, uuid, uuid) to tmpos_app;

-- =============================================================================
-- 12) Postcondition
-- =============================================================================
-- Proven rather than asserted, in 030's and 032's form. This file refuses to finish unless, now:
--   (a) schema tmpos_invoice_discard holds exactly the six functions this file creates and no relation or type, and is owned by
--       the applying principal; its complete ACL is exactly the owner's USAGE and CREATE and a non-grantable USAGE to
--       tmpos_app, each granted by the owner;
--   (b) the discard is plpgsql, SECURITY DEFINER, VOLATILE; the two reads plpgsql, SECURITY DEFINER, STABLE, with 028's page's
--       and get's exact arguments and RETURNS TABLE; all three pinned to pg_catalog, pg_temp with row_security off; the two
--       trigger functions plpgsql, SECURITY INVOKER, VOLATILE, returning trigger, pinned to pg_catalog, pg_temp (the line one
--       with row_security off too); the anchor a SQL-standard body, SECURITY INVOKER, pinned to pg_catalog, pg_temp; all six
--       owned by the applying principal and commented;
--   (c) the complete ACL of each of the three routines is exactly two entries, the owner's EXECUTE and a non-grantable EXECUTE to
--       tmpos_app, each granted by the owner; that of the trigger functions, the anchor, 028's page and get and 028's create
--       each exactly the owner's one — tmpos_app included, PUBLIC included;
--   (d) tmpos_app CAN execute the three routines and use the schema, and CANNOT execute a trigger function, the anchor or 028's
--       page, get or create; tmpos_audit_writer, anon and authenticated can execute none of these, by any path; no runtime role
--       holds any privilege on either draft table, by any path;
--   (e) none of the four runtime roles is a MEMBER of the owner of the schema or of a function in it;
--   (f) the header carries EXACTLY 029's trigger and this file's, in that name order, each in its exact shape and enabled
--       ALWAYS; the lines carry exactly this file's; each trigger function serves exactly one trigger;
--   (g) invoice_draft_status_chk is exactly CHECK (status in ('draft', 'discarded')), validated; the partial index is exactly
--       section 6's, valid, with its predicate; tmpos_invoice_draft holds exactly 028's relations and that index;
--   (h) the anchor's dependencies are recorded: exactly one pg_depend row on each of the six predecessors section 10 names.
-- Each ACL is read through coalesce(acl, acldefault(kind, owner)), and a role reachable through a membership is followed
-- whatever the membership's options (019's reasons). WHAT THIS DOES NOT PROVE: it is a snapshot at apply time; the runtime
-- LOGIN's grants are enforced at every start by the startup preflight (server/persistence/postgresStartupPreflight.ts).
do $$
declare
  v_bad     text;
  v_me      oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user);
  v_discard oid := 'tmpos_invoice_discard.m7b_invoice_draft_discard(text, uuid, uuid, uuid, bigint)'::regprocedure;
  v_page    oid := 'tmpos_invoice_discard.m7b_invoice_draft_page_v2(text, uuid, uuid, uuid, integer)'::regprocedure;
  v_get     oid := 'tmpos_invoice_discard.m7b_invoice_draft_get_v2(text, uuid, uuid, uuid)'::regprocedure;
  v_header  oid := 'tmpos_invoice_discard.m7b_invoice_draft_terminal()'::regprocedure;
  v_line    oid := 'tmpos_invoice_discard.m7b_invoice_draft_line_terminal()'::regprocedure;
  v_anchor  oid := 'tmpos_invoice_discard.m7b_invoice_discard_prerequisites()'::regprocedure;
  v_page028 oid := 'tmpos_invoice_draft.m7b_invoice_draft_page(text, uuid, uuid, uuid, integer)'::regprocedure;
  v_get028  oid := 'tmpos_invoice_draft.m7b_invoice_draft_get(text, uuid, uuid, uuid)'::regprocedure;
  v_new028  oid := 'tmpos_invoice_draft.m7b_invoice_draft_create(text, uuid, uuid, uuid, uuid, jsonb, bigint)'::regprocedure;
begin
  -- (a)
  if (select pg_catalog.string_agg(p.oid::regprocedure::text, ', ' order by p.oid::regprocedure::text)
        from pg_catalog.pg_proc p where p.pronamespace = 'tmpos_invoice_discard'::regnamespace)
     is distinct from
     'tmpos_invoice_discard.m7b_invoice_discard_prerequisites(), tmpos_invoice_discard.m7b_invoice_draft_discard(text,uuid,uuid,uuid,bigint), tmpos_invoice_discard.m7b_invoice_draft_get_v2(text,uuid,uuid,uuid), tmpos_invoice_discard.m7b_invoice_draft_line_terminal(), tmpos_invoice_discard.m7b_invoice_draft_page_v2(text,uuid,uuid,uuid,integer), tmpos_invoice_discard.m7b_invoice_draft_terminal()'
     or exists (select 1 from pg_catalog.pg_class c where c.relnamespace = 'tmpos_invoice_discard'::regnamespace)
     or exists (select 1 from pg_catalog.pg_type t
                 where t.typnamespace = 'tmpos_invoice_discard'::regnamespace and t.typrelid = 0 and t.typelem = 0)
     or not exists (select 1 from pg_catalog.pg_namespace n where n.oid = 'tmpos_invoice_discard'::regnamespace and n.nspowner = v_me) then
    raise exception 'migration 033 refused: schema tmpos_invoice_discard does not hold exactly the six functions this file creates, or is not owned by the applying principal'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  select pg_catalog.string_agg(pg_catalog.format('%s:%s', g.grantee::regrole::text, g.privilege_type), ', ')
    into v_bad
    from pg_catalog.pg_namespace n,
         pg_catalog.aclexplode(coalesce(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) g
   where n.oid = 'tmpos_invoice_discard'::regnamespace
     and not (not g.is_grantable and g.grantor = n.nspowner
              and ((g.grantee = n.nspowner and g.privilege_type in ('USAGE', 'CREATE'))
                   or (g.grantee = 'tmpos_app'::regrole and g.privilege_type = 'USAGE')));
  -- The complete ACL, the owner's entries included: exactly the owner's USAGE and CREATE and tmpos_app's USAGE, three rows.
  if v_bad is not null
     or (select pg_catalog.count(*)
           from pg_catalog.pg_namespace n,
                pg_catalog.aclexplode(coalesce(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) g
          where n.oid = 'tmpos_invoice_discard'::regnamespace) <> 3
     or not pg_catalog.has_schema_privilege('tmpos_app', 'tmpos_invoice_discard'::regnamespace, 'USAGE') then
    raise exception 'migration 033 refused: schema tmpos_invoice_discard carries an unexpected grant or lacks an expected one (%), or tmpos_app cannot use it', coalesce(v_bad, 'none listed')
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (b)
  if not exists (select 1 from pg_catalog.pg_proc p join pg_catalog.pg_language l on l.oid = p.prolang
                  where p.oid = v_discard
                    and l.lanname = 'plpgsql' and p.prosecdef and p.provolatile = 'v'
                    and p.proconfig = array['search_path=pg_catalog, pg_temp', 'row_security=off'] and p.proowner = v_me
                    and pg_catalog.pg_get_function_arguments(p.oid) = 'p_session_key text, p_store_id uuid, p_draft_id uuid, p_expected_tenant uuid, p_expected_version bigint'
                    and pg_catalog.pg_get_function_result(p.oid) = 'TABLE(o_outcome text, o_tenant_id uuid, o_store_id uuid, o_actor_id uuid, o_membership_id uuid, o_version bigint)')
     or (select pg_catalog.count(*) from pg_catalog.pg_proc p join pg_catalog.pg_language l on l.oid = p.prolang
          where p.oid in (v_page, v_get)
            and l.lanname = 'plpgsql' and p.prosecdef and p.provolatile = 's'
            and p.proconfig = array['search_path=pg_catalog, pg_temp', 'row_security=off'] and p.proowner = v_me) <> 2
     or pg_catalog.pg_get_function_arguments(v_page) is distinct from pg_catalog.pg_get_function_arguments(v_page028)
     or pg_catalog.pg_get_function_result(v_page) is distinct from pg_catalog.pg_get_function_result(v_page028)
     or pg_catalog.pg_get_function_arguments(v_get) is distinct from pg_catalog.pg_get_function_arguments(v_get028)
     or pg_catalog.pg_get_function_result(v_get) is distinct from pg_catalog.pg_get_function_result(v_get028)
     or not exists (select 1 from pg_catalog.pg_proc p join pg_catalog.pg_language l on l.oid = p.prolang
                     where p.oid = v_header
                       and l.lanname = 'plpgsql' and not p.prosecdef and p.provolatile = 'v'
                       and p.prorettype = 'pg_catalog.trigger'::regtype
                       and p.proconfig = array['search_path=pg_catalog, pg_temp'] and p.proowner = v_me)
     or not exists (select 1 from pg_catalog.pg_proc p join pg_catalog.pg_language l on l.oid = p.prolang
                     where p.oid = v_line
                       and l.lanname = 'plpgsql' and not p.prosecdef and p.provolatile = 'v'
                       and p.prorettype = 'pg_catalog.trigger'::regtype
                       and p.proconfig = array['search_path=pg_catalog, pg_temp', 'row_security=off'] and p.proowner = v_me)
     or not exists (select 1 from pg_catalog.pg_proc p join pg_catalog.pg_language l on l.oid = p.prolang
                     where p.oid = v_anchor
                       and l.lanname = 'sql' and not p.prosecdef and p.prosqlbody is not null
                       and p.prorettype = 'pg_catalog.bool'::regtype
                       and p.proconfig = array['search_path=pg_catalog, pg_temp'] and p.proowner = v_me)
     or exists (select 1 from pg_catalog.pg_proc p
                 where p.oid in (v_discard, v_page, v_get, v_header, v_line, v_anchor)
                   and pg_catalog.obj_description(p.oid, 'pg_proc') is null)
     or pg_catalog.obj_description('tmpos_invoice_discard'::regnamespace, 'pg_namespace') is null then
    raise exception 'migration 033 refused: a function of schema tmpos_invoice_discard is not the one its section declares (language, security, volatility, settings, arguments, result, owner), or it or the schema carries no comment'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (c)
  select pg_catalog.string_agg(pg_catalog.format('%s %s:%s', p.proname, g.grantee::regrole::text, g.privilege_type), ', ')
    into v_bad
    from pg_catalog.pg_proc p,
         pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g
   where p.oid in (v_discard, v_page, v_get, v_header, v_line, v_anchor, v_page028, v_get028, v_new028)
     and not (g.privilege_type = 'EXECUTE' and not g.is_grantable and g.grantor = p.proowner
              and (g.grantee = p.proowner or (p.oid in (v_discard, v_page, v_get) and g.grantee = 'tmpos_app'::regrole)));
  -- The complete ACL, the owner's entry included: the three routines exactly two entries (the owner's and tmpos_app's), the
  -- others exactly one.
  if v_bad is not null
     or exists (select 1 from pg_catalog.pg_proc p
                 where p.oid in (v_discard, v_page, v_get, v_header, v_line, v_anchor, v_page028, v_get028, v_new028)
                   and (select pg_catalog.count(*)
                          from pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g)
                       <> case when p.oid in (v_discard, v_page, v_get) then 2 else 1 end) then
    raise exception 'migration 033 refused: an unexpected direct grant remains on a function of schema tmpos_invoice_discard or on 028''s routines, or an entry is missing (%)', coalesce(v_bad, 'none listed')
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if (select pg_catalog.count(*)
        from pg_catalog.pg_proc p,
             pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g
       where p.oid in (v_discard, v_page, v_get) and g.grantee = 'tmpos_app'::regrole and g.privilege_type = 'EXECUTE'
         and not g.is_grantable) <> 3 then
    raise exception 'migration 033 refused: tmpos_app does not hold a direct EXECUTE on each of the discard and the two reads'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (d)
  if not pg_catalog.has_function_privilege('tmpos_app', v_discard, 'EXECUTE')
     or not pg_catalog.has_function_privilege('tmpos_app', v_page, 'EXECUTE')
     or not pg_catalog.has_function_privilege('tmpos_app', v_get, 'EXECUTE')
     or not pg_catalog.has_schema_privilege('tmpos_app', 'tmpos_invoice_discard'::regnamespace, 'USAGE') then
    raise exception 'migration 033 refused: tmpos_app must execute the discard and the two reads and use schema tmpos_invoice_discard'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  select pg_catalog.string_agg(distinct r.rolname::text || ' ' || p.proname::text, ', ') into v_bad
    from pg_catalog.pg_roles r
    join pg_catalog.pg_roles x on pg_catalog.pg_has_role(r.oid, x.oid, 'MEMBER')
    cross join pg_catalog.pg_proc p
   where p.oid in (v_discard, v_page, v_get, v_header, v_line, v_anchor, v_page028, v_get028, v_new028)
     and (r.rolname = any (array['tmpos_audit_writer', 'anon', 'authenticated']::name[])
          or (r.rolname = 'tmpos_app' and p.oid in (v_header, v_line, v_anchor, v_page028, v_get028, v_new028)))
     and pg_catalog.has_function_privilege(x.oid, p.oid, 'EXECUTE');
  if v_bad is not null then
    raise exception 'migration 033 refused: a runtime role can execute a function this file does not grant it (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- MAINTAIN only on a server that has it (PostgreSQL 17+), where has_table_privilege would reject it on 16 (028's form).
  select pg_catalog.string_agg(distinct r.rolname::text, ', ') into v_bad
    from pg_catalog.pg_roles r
    join pg_catalog.pg_roles x on pg_catalog.pg_has_role(r.oid, x.oid, 'MEMBER')
    cross join (values ('tmpos_invoice_draft.invoice_draft'::regclass), ('tmpos_invoice_draft.invoice_draft_line'::regclass)) as t(oid)
   where r.rolname = any (array['tmpos_app', 'tmpos_audit_writer', 'anon', 'authenticated']::name[])
     and (pg_catalog.has_table_privilege(x.oid, t.oid,
            'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'
            operator(pg_catalog.||) case when pg_catalog.current_setting('server_version_num')::integer >= 170000
                                         then ', MAINTAIN' else '' end)
          or pg_catalog.has_any_column_privilege(x.oid, t.oid, 'SELECT, INSERT, UPDATE, REFERENCES'));
  if v_bad is not null then
    raise exception 'migration 033 refused: % holds a privilege on a draft table', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (e)
  select pg_catalog.string_agg(distinct r.rolname::text, ', ') into v_bad
    from pg_catalog.pg_roles r
    cross join (
      select n.nspowner as owner from pg_catalog.pg_namespace n where n.oid = 'tmpos_invoice_discard'::regnamespace
      union
      select p.proowner from pg_catalog.pg_proc p where p.pronamespace = 'tmpos_invoice_discard'::regnamespace
    ) o
   where r.rolname = any (array['tmpos_app', 'tmpos_audit_writer', 'anon', 'authenticated']::name[])
     and pg_catalog.pg_has_role(r.oid, o.owner, 'MEMBER');
  if v_bad is not null then
    raise exception 'migration 033 refused: % is a member of the owner of schema tmpos_invoice_discard or of a function in it', v_bad
      using errcode = 'object_not_in_prerequisite_state',
            hint = 'membership hands a role everything the owner holds, including a direct write of every draft';
  end if;

  -- (f) tgtype: ROW 1 + BEFORE 2 + INSERT 4 + DELETE 8 + UPDATE 16 = 31 (this file's two); ROW 1 + BEFORE 2 + UPDATE 16 = 19
  -- (029's). Same-event BEFORE row triggers fire in name order: 029's first, then this file's.
  if (select pg_catalog.string_agg(g.tgname::text, ', ' order by g.tgname::text collate "C")
        from pg_catalog.pg_trigger g
       where g.tgrelid = 'tmpos_invoice_draft.invoice_draft'::regclass and not g.tgisinternal)
     is distinct from 'trg_invoice_draft_immutable, trg_invoice_draft_terminal'
     or (select pg_catalog.string_agg(g.tgname::text, ', ' order by g.tgname::text collate "C")
           from pg_catalog.pg_trigger g
          where g.tgrelid = 'tmpos_invoice_draft.invoice_draft_line'::regclass and not g.tgisinternal)
        is distinct from 'trg_invoice_draft_line_terminal'
     or (select pg_catalog.count(*) from pg_catalog.pg_trigger g where g.tgfoid = v_header) <> 1
     or (select pg_catalog.count(*) from pg_catalog.pg_trigger g where g.tgfoid = v_line) <> 1
     or not exists (select 1 from pg_catalog.pg_trigger g
                     where g.tgrelid = 'tmpos_invoice_draft.invoice_draft'::regclass
                       and g.tgname = 'trg_invoice_draft_terminal'
                       and g.tgfoid = v_header
                       and g.tgtype = 31
                       and g.tgenabled = 'A'
                       and g.tgattr = ''::pg_catalog.int2vector
                       and g.tgqual is null
                       and not g.tgisinternal)
     or not exists (select 1 from pg_catalog.pg_trigger g
                     where g.tgrelid = 'tmpos_invoice_draft.invoice_draft_line'::regclass
                       and g.tgname = 'trg_invoice_draft_line_terminal'
                       and g.tgfoid = v_line
                       and g.tgtype = 31
                       and g.tgenabled = 'A'
                       and g.tgattr = ''::pg_catalog.int2vector
                       and g.tgqual is null
                       and not g.tgisinternal)
     or not exists (select 1 from pg_catalog.pg_trigger g
                     where g.tgrelid = 'tmpos_invoice_draft.invoice_draft'::regclass
                       and g.tgname = 'trg_invoice_draft_immutable'
                       and g.tgfoid = 'tmpos_invoice_draft.m7b_invoice_draft_immutable()'::regprocedure
                       and g.tgtype = 19
                       and g.tgenabled = 'A'
                       and g.tgattr = ''::pg_catalog.int2vector
                       and g.tgqual is null
                       and not g.tgisinternal) then
    raise exception 'migration 033 refused: the draft header does not carry exactly 029''s trigger and this file''s, or the lines exactly this file''s, each in its exact shape and enabled ALWAYS'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (g)
  if (select pg_catalog.count(*) from pg_catalog.pg_constraint k
       where k.conrelid = 'tmpos_invoice_draft.invoice_draft'::regclass and k.conname = 'invoice_draft_status_chk' and k.contype = 'c'
         and k.convalidated
         and pg_catalog.pg_get_constraintdef(k.oid) = 'CHECK ((status = ANY (ARRAY[''draft''::text, ''discarded''::text])))') <> 1
     or not exists (select 1 from pg_catalog.pg_index x
                     where x.indexrelid = pg_catalog.to_regclass('tmpos_invoice_draft.invoice_draft_open_page_idx')
                       and x.indrelid = 'tmpos_invoice_draft.invoice_draft'::regclass
                       and x.indisvalid and x.indisready and not x.indisunique
                       and pg_catalog.pg_get_indexdef(x.indexrelid) = 'CREATE INDEX invoice_draft_open_page_idx ON tmpos_invoice_draft.invoice_draft USING btree (tenant_id, store_id, created_at DESC, draft_id DESC) WHERE (status = ''draft''::text)')
     or pg_catalog.obj_description(pg_catalog.to_regclass('tmpos_invoice_draft.invoice_draft_open_page_idx'), 'pg_class') is null
     or (select pg_catalog.string_agg(pg_catalog.format('%s:%s', c.relname, c.relkind), ', ' order by c.relname)
           from pg_catalog.pg_class c where c.relnamespace = 'tmpos_invoice_draft'::regnamespace)
        is distinct from
        'invoice_draft:r, invoice_draft_customer_idx:i, invoice_draft_line:r, invoice_draft_line_pkey:i, invoice_draft_open_page_idx:i, invoice_draft_page_idx:i, invoice_draft_pkey:i, invoice_draft_scope_key:i' then
    raise exception 'migration 033 refused: invoice_draft_status_chk, the partial index or the relations of schema tmpos_invoice_draft are not exactly what this file declares'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (h) One NORMAL dependency row per predecessor the anchor names (its schema and language rows aside).
  if (select pg_catalog.string_agg(case when d.refclassid = 'pg_catalog.pg_proc'::regclass
                                        then d.refobjid::regprocedure::text else d.refobjid::regclass::text end, ', '
                                   order by case when d.refclassid = 'pg_catalog.pg_proc'::regclass
                                                 then d.refobjid::regprocedure::text else d.refobjid::regclass::text end)
        from pg_catalog.pg_depend d
       where d.classid = 'pg_catalog.pg_proc'::regclass and d.objid = v_anchor and d.objsubid = 0
         and d.refclassid in ('pg_catalog.pg_proc'::regclass, 'pg_catalog.pg_class'::regclass)
         and d.refobjsubid = 0 and d.deptype = 'n')
     is distinct from
     'tmpos_invoice_draft.invoice_draft, tmpos_invoice_draft.invoice_draft_line, tmpos_invoice_draft.m7b_invoice_draft_immutable(), tmpos_invoice_edit.m7b_invoice_draft_create_v3(text,uuid,uuid,uuid,uuid,jsonb,bigint), tmpos_invoice_edit.m7b_invoice_draft_update_v2(text,uuid,uuid,uuid,bigint,uuid,jsonb,bigint), tmpos_invoice_edit.m7b_invoice_level_guard()' then
    raise exception 'migration 033 refused: the rollback-order anchor does not record exactly one dependency on each predecessor it names'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$$;

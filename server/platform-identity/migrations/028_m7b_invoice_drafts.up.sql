-- Phase 4.0 M7b — store-owned invoice drafts: two private tables a draft and its ordered lines live in, scoped to a real
-- store of a tenant and naming a customer of that same tenant through composite foreign keys; one session-bound create
-- decided on the actor's own store grant at exactly that store and its role's Invoices and Customers levels under the
-- established locking order; two session-bound reads (a store's page of drafts, newest first, and one draft with its lines);
-- and a typed audit subject naming the draft a command created (M7B-INVOICES-P1; G-IAM, G-ISOLATION, G-DBROLE, G-AUDIT;
-- docs/phase-4/10)
-- Migration: 028_m7b_invoice_drafts (UP)
--
-- SCOPE / TRUTH (binding):
--   - ONE NEW SCHEMA; TWO TABLES WITH THEIR TWO PRIMARY KEYS, THE HEADER'S SCOPE KEY AND TWO INDEXES BEYOND THOSE; THREE
--     ROUTINES; FOUR GRANTS, ALL TO tmpos_app (EXECUTE ON EACH ROUTINE AND USAGE ON THE SCHEMA); TWO NEW UNIQUE CONSTRAINTS ON
--     EARLIER TABLES; ONE NEW COLUMN AND ONE PARTIAL INDEX ON 002'S AUDIT TABLE; NO ROLE, NO TRIGGER, NO TYPE, NO POLICY. This
--     file adds to public.store (002) the constraint store_tenant_store_key, UNIQUE (tenant_id, store_id); adds to
--     tmpos_customer.customer (017) the constraint customer_tenant_customer_key, UNIQUE (tenant_id, customer_id); adds to
--     public.audit_event the nullable column subject_invoice_draft_id with the index
--     idx_audit_event_subject_invoice_draft_occurred; and creates schema tmpos_invoice_draft holding the tables invoice_draft
--     and invoice_draft_line (the names 027's rollback guard fixes) and the three routines tmpos_app may execute:
--     m7b_invoice_draft_create (POST /api/v1/stores/{storeId}/invoice-drafts), m7b_invoice_draft_page (GET
--     /api/v1/stores/{storeId}/invoice-drafts) and m7b_invoice_draft_get (GET /api/v1/stores/{storeId}/invoice-drafts/{id}).
--     Those are its only effects on objects earlier migrations created: 001-027 stay byte for byte as committed (the
--     migration-files contract's pinned checksums prove that), no earlier routine, grant, schema or row is altered, and
--     tmpos_app gains no privilege on any table — this file's, 002's store, 017's customer table or the audit table.
--   - WHY IT EXISTS. The owner's stage brief makes invoice drafts owned by a REAL STORE within a tenant: save, list and reopen
--     (read-only), USD as integer cents, status 'draft' only, customers staying tenant-owned. A store request is authorized
--     only through the actor's OWN active store-scope grant at exactly that store (no tenant-to-store inheritance: no accepted
--     document establishes one, docs/phase-4/04 :37, :58; the store-scope rule 027 and the runtime authorizer already apply).
--     The store id a request names is a SELECTOR among the actor's own grants, never proof: a missing store, a foreign store
--     and a store the actor holds nothing at are one refusal.
--   - THE TABLES. invoice_draft: draft_id (the runtime's new v4 id, the key), tenant_id, store_id, customer_id, status
--     (CHECK = 'draft'), currency (CHECK = 'USD'), version (CHECK = 1), line_count (1-50), subtotal_cents (0 to
--     9007199254740991, the largest integer a JavaScript number holds exactly), created_at (timestamptz, NOT NULL, the
--     inserting transaction's now() — never a value of the runtime's) and created_by (the creating actor's app-owned
--     internal_user_id: a plain uuid with no foreign key, as the audit record's actor column). invoice_draft_line: draft_id,
--     tenant_id, store_id, position (1-50; the key is (draft_id, position)), description (1-256 characters with 017's three
--     plain-text CHECKs: no C0/C1 control, line or paragraph separator; no Bidi_Control; no edge whitespace), quantity (1 to
--     9007199254740991), unit_price_cents (0 to 9007199254740991) and line_total_cents (= quantity x unit_price_cents
--     computed in numeric, at most 9007199254740991). The scope is a DATABASE invariant, never only the routine's:
--     (tenant_id, store_id) references public.store (tenant_id, store_id) and (tenant_id, customer_id) references
--     tmpos_customer.customer (tenant_id, customer_id) — each through the NEW UNIQUE constraint this file adds, since neither
--     table had one (a foreign key on customer_id alone would not prove the tenant) — and every line's (draft_id, tenant_id,
--     store_id) references its header's UNIQUE (draft_id, tenant_id, store_id), so a line can never sit under another scope.
--     No foreign key cascades. A header's line count and subtotal are fixed by the one create (below) and re-verified there:
--     no CHECK queries another row. List index: (tenant_id, store_id, created_at desc, draft_id desc), the page's own order;
--     customer index: (tenant_id, customer_id). Row security is ENABLED with NO policy and the runtime roles hold NO
--     privilege on either table: they are reached only through the three routines.
--   - THE CREATE'S ONLY AUTHORITY ARGUMENT IS THE SESSION KEY; p_store_id IS A SELECTOR. m7b_invoice_draft_create first judges
--     every argument — the key's shape, the ids, the expected tenant, the subtotal's range, and the lines: ONE jsonb array of
--     1-50 objects each holding exactly description, quantity and unitPriceCents, the description a JSON string the line
--     table's CHECKs admit, the quantity a whole number 1 to 9007199254740991 and the unit price a whole number 0 to
--     9007199254740991 (both as the plain digits JSON carries an integer in), every line total and their sum within
--     9007199254740991 in numeric arithmetic, and that sum equal to p_subtotal_cents (the runtime's own BigInt sum) — raising
--     invalid_parameter_value with a FIXED message naming the field, never the value, before anything is read, locked or
--     written. It then derives the caller exactly as 024's edit does (restated: 024 is frozen and edits): an unlocked
--     live/issuer pre-check; 016's hold (the account FOR UPDATE; its links, grants, tenants and stores FOR SHARE); the
--     session and its mint-ledger row FOR SHARE; the issuer key FOR SHARE; the database clock; the standing digest minted;
--     an account status in ('active', 'trialing'). Then, in R3's order, with no write on any refusal:
--       7. EXACTLY ONE store-scope grant of that standing naming p_store_id — none and two or more (two roles at one store:
--          ambiguous) refuse; a tenant-scope grant never counts — whose tenantStatus and storeStatus are 'active' or
--          'trialing'; still that actor's active public.user_membership row at that tenant, store and role (027's re-check);
--          and the store row itself, re-read FOR SHARE (016's hold took it), in that grant's tenant with status 'active' or
--          'trialing'. A store row's existence proves nothing (tmpos_app may INSERT public.store rows, doc 08 DA-29/DA-97):
--          authority comes only from the membership row, and the store row is consulted for its tenant and status.
--       8. The role's levels, UNLOCKED: Invoices at Create or above AND Customers at View or above (store_owner Full on both;
--          manager, technician, sales_staff the tenant owner's stored level, else the catalog default — manager full,
--          technician view, sales_staff create, for both domains; any other role refuses). One permission, one decision:
--          the runtime authorizer and revalidator decide the same pair (m5CanonicalPermissions.ts create_invoice_drafts and
--          its corequisite). Below either: ('refused', NULLs).
--       9. p_expected_tenant must be that grant's tenant: else ('tenant_mismatch', NULLs), nothing written, before any role row
--          is made to exist. It is the REQUEST's expectedTenant — a value the caller supplies, compared with the tenant derived
--          from the grant as a precondition only (021's and 022's rule), never authority: the create's authority comes from the
--          session key alone and its selector p_store_id, which the runtime binds from its revalidated trusted store.
--      10. The customer, UNLOCKED and filtered to that tenant: a missing id and another tenant's id are the same
--          ('customer_not_found', NULLs), decided BEFORE ANY WRITE — the runtime seals that answer as its completion and
--          commits it (DA-36: a sealed answer commits whatever was written before it, so nothing may have been).
--      11. The role rows made to exist (NULL, the default; INSERT ... ON CONFLICT DO NOTHING, never an UPDATE — 021's trigger
--          moves a version on an UPDATE only) and held FOR SHARE in a FIXED order, customers then invoices (store_owner
--          none), so a create and an owner's level edit of either domain serialize on the row the edit holds FOR UPDATE.
--      12. Re-decided on the locked values: a level an edit narrowed before these locks refuses ('refused'; the runtime
--          rolls the whole transaction back, the NULL rows included).
--      13. The clock again (the waits above may have outlived the session), then the customer FOR KEY SHARE in that tenant
--          — one that vanished since step 10 raises — and the clock once more.
--      14. The header and every line INSERTed, each inside a block that re-raises a constraint error with a FIXED message
--          (no description, id or amount reaches a log line), then verified: exactly line_count lines at positions 1..n
--          whose totals sum to the header's subtotal. Answer ('applied', tenant, store, actor, membership): the runtime
--          compares all four with its trusted context and rolls back on any difference (the application's obligation: no
--          check in this file can make it).
--     LOCK ORDER (every tenant write's, then this file's): fence -> 016's hold (account FOR UPDATE; links, grants, tenants,
--     stores FOR SHARE) -> session and ledger rows -> issuer key row -> store row (FOR SHARE, already held) -> Customers role
--     row -> Invoices role row -> customer row (FOR KEY SHARE) -> the draft and its lines. A status change of the store, a
--     grant's suspension or a level edit that commits FIRST refuses the create; one attempted while the create holds these
--     locks waits for its COMMIT. A customer edit (024) holds that customer FOR UPDATE, which conflicts with KEY SHARE: the
--     two serialize on the row (availability only).
--   - THE READS. m7b_invoice_draft_page and m7b_invoice_draft_get are STABLE: every statement runs on the calling statement's
--     snapshot, they lock nothing and write nothing. Both derive the caller as 027's read does (the minted, live session
--     under the installed issuer key, the 016 standing it was minted at, an account whose status admits a read) and then
--     exactly one store-scope grant naming p_expected_store — a grant still the actor's active membership row, whose store row
--     is in its tenant — with account, tenant and store statuses in ('active', 'trialing', 'overdue', 'read_only') (a read
--     admits read-only), the grant's tenant equal to p_expected_tenant (both arguments are the runtime's TRUSTED context's,
--     never the request's; else 'denied'), and the role's Invoices level at View or above (else 'denied'). The page answers
--     one row per draft of exactly that tenant and store, newest first by (created_at desc, draft_id desc), at most p_limit
--     (1-51: the runtime asks one more than it serves), each row naming the derived tenant and store; a continuation names
--     the anchor draft's id ONLY, and the routine re-reads that anchor's created_at INSIDE the tenant and store — an anchor
--     that is missing, another store's or another tenant's is one 'cursor_unknown' — so no timestamp ever round-trips the
--     runtime, microsecond precision is kept, and equal created_at values (one transaction's now()) are ordered by the id
--     and neither dropped nor repeated. The get answers one row per line of exactly that draft in exactly that tenant and
--     store, ordered by position, each carrying the header; a missing id, another store's and another tenant's are ONE
--     statement and ONE answer ('not_found'). created_at is rendered as UTC 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"' (microseconds).
--     A refusal is always the routine's only row, its other columns NULL; a store with no draft answers no row.
--   - WHAT THEY DO NOT DO. None writes an audit record, an outbox event or an idempotency completion: the runtime's command
--     transaction appends the create's audit record (scope 'store', the draft as its subject_invoice_draft_id), its outbox
--     event (invoice_draft.created, identifiers and a count only) and its completion around it in one transaction; the reads
--     write none (the customer reads' owner decision, G-AUDIT). No message, hint or detail any of them raises carries a
--     description, an id or an amount. A draft names its customer by id only: no name, phone or email is copied.
--   - THE AUDIT SUBJECT. A draft create's audit record names the draft in its own typed column, as 024's subject_customer_id
--     names a customer: public.audit_event.subject_invoice_draft_id, a plain nullable uuid with no default and no foreign key
--     (002: the audit table is decoupled and append-only), written only by the runtime's command transaction from the
--     command's server-generated aggregate id. Adding it rewrites no row and fires no row trigger; the audit writer's
--     table-wide INSERT (005) covers it and nothing else is granted.
--   - WHAT THIS DOES NOT DEFEND (doc 08; none of it is claimed closed). 024's write residuals and 027's read residuals stand
--     for these routines, and:
--       * a holder of tmpos_app plus a live minted key whose store grant meets Invoices Create and Customers View calls
--         m7b_invoice_draft_create directly and saves drafts at that store with NO audit, idempotency or outbox record —
--         drafts are audited ONLY through the HTTP route (G-AUDIT exception, as 020's create);
--       * LOCK HOLDING (020's class, DA-120): such a holder keeps the store row, both role rows FOR SHARE and the customer
--         FOR KEY SHARE for as long as it keeps its transaction open, so a store status change, an owner's level edit of that
--         role and an edit of that customer wait until its lock or statement timeout (503) — availability only;
--       * the TABLE OWNER (the applying principal) can still write either table directly; no runtime role reaches either
--         by any path (the postcondition proves it);
--       * a 201-versus-422 answer reveals to a store role holding Customers View whether a guessed customer uuid exists in
--         the store's tenant (recorded as a residual and an owner decision: DA-87 Option B, store-scope customer reads);
--       * LIFECYCLE CONSEQUENCES (owner decisions later): a store holding drafts cannot be moved to another tenant, and a
--         tenant, store or customer holding drafts cannot be deleted — the foreign keys refuse (no CASCADE);
--       * a database log that captures bind parameters exposes session keys and line descriptions (G-DBROLE, G-PRIVACY);
--       * the rollback order is enforced only as far as the earlier files' own checks reach: 027's rollback refuses while this
--         file's objects exist, 017's cannot drop the customer table this file's foreign key references, and 026's refuses
--         while an Invoices row (this file's create makes them) exists. An older rollback this file's objects do not block can
--         COMPLETE while it is applied — 023's and 024's, which these routines do not depend on, leave them working — and this
--         file's own rollback is then refused until that file is re-applied (its postcondition pins 017's, 023's and 024's
--         customer constraints, and a LOCK on a table that is gone raises); where such a rollback removes a table these
--         routines read, they raise at call (503). Every path fails closed, never open. Roll 028 back before 027.
--   - APPLY: A MAINTENANCE WINDOW. Before any check and before any change — its first statements after the search path, with
--     nothing read before them, not even the catalog — the file takes ACCESS EXCLUSIVE until COMMIT on every table of the
--     creators' order that exists before it (design R7: the order every writer of them takes them — 016's hold reads a
--     grant's store first; a create then holds the role rows, Customers then Invoices; an owner's level edit writes their
--     version row; then the customer; the audit record last): public.store, tmpos_role.tenant_role_level,
--     tmpos_role_edit.role_level_version, tmpos_customer.customer, public.audit_event — its rollback's seven less the two
--     draft tables, which do not exist yet. They are taken in one block whose handler turns a missing table or schema
--     (undefined_table, invalid_schema_name) into this file's own refusal, the block's locks released first, so a chain
--     that lacks one is refused (55000), never met with a raw error. So an owner's level edit, every store, customer and
--     audit write, and every earlier file's rollback that locks any of the five either committed before this file read
--     anything or waits for its COMMIT, and no write lands between its checks and its changes. It alters three of the five
--     (store, customer, audit). Its routines read tmpos_role.tenant_role_level and, for the lock anchors, insert into it; none
--     names tmpos_role_edit.role_level_version, which the file locks only because R7's one order covers every writer of the
--     five (an owner's level edit writes a version row; this file's own rollback reads them to tell an anchor from an
--     owner's choice). The cost: every read and write of those five tables waits until COMMIT — store, role-level, customer
--     and audit traffic, so in effect every tenant request — each UNIQUE builds a btree over its whole table under that
--     lock, the audit column rewrites no row, and the partial index builds over the audit table once.
--   - DEPLOY AND ROLLBACK: FORWARD-ONLY IN EFFECT, FAIL CLOSED. It and the runtime that requires 001-028 move together: the
--     runtime's startup preflight pins the exact ledger and the exact grants, so the 001-027 runtime refuses a 028 database
--     (its approved grants lack the three EXECUTEs and the schema USAGE) and this runtime refuses a 027 one. The rollback
--     REFUSES while any draft or line exists or any audit record names a draft (024's owner-decision hint: dropping the
--     column would erase audit evidence, and dropping the tables would discard saved drafts); otherwise it removes exactly
--     what this file created — and the NULL Invoices role rows only this file's create could have made (an Invoices row
--     with no level and no version row), which would otherwise block 026's rollback — restoring 027's state.
--   - NO SECRET, NO DYNAMIC SQL, NO EXTENSION, NO TEMPORARY OBJECT. Every statement is fixed text, every value a parameter,
--     every relation and routine schema-qualified; every routine pins its search_path to pg_catalog then pg_temp and runs
--     with row_security off, so were row security ever FORCEd on a table it reads or writes it fails (503) instead of
--     silently refusing. There is no backfill.
--
-- Reversible via 028_m7b_invoice_drafts.down.sql, which refuses while any draft or line exists or any audit record names a
-- draft, and otherwise removes exactly what this file created. Roll 028 back before 027.
--
-- Assumes 001-027 are applied. A future managed apply targets the complete contiguous chain through the newest committed
-- migration — now 001-028 (owner decision D4); this file authorizes no apply.

-- =============================================================================
-- 1) This transaction's search path
-- =============================================================================
set local search_path = pg_catalog, pg_temp;

-- =============================================================================
-- 2) The locks, in the creators' order: the first statements after the search path, before any check or any change
-- =============================================================================
-- Design R7's order — the order every writer of these tables takes them (the header's APPLY), the rollback's seven less the
-- two draft tables that do not exist yet. Nothing is read or checked before them, not even the catalog. A LOCK naming a
-- table or schema that is missing raises undefined_table (42P01) or invalid_schema_name (3F000); the block's handler turns
-- either into this file's refusal (55000). The block runs as a subtransaction: once it completes, this transaction keeps
-- its locks until COMMIT, so everything below, the preconditions included, runs on a state no level edit, store, customer or
-- audit write, or locking earlier rollback can change before this file commits; refused, the subtransaction has released
-- the locks it took, and the refusal aborts the file.
do $$
begin
  lock table public.store in access exclusive mode;
  lock table tmpos_role.tenant_role_level in access exclusive mode;
  lock table tmpos_role_edit.role_level_version in access exclusive mode;
  lock table tmpos_customer.customer in access exclusive mode;
  lock table public.audit_event in access exclusive mode;
exception
  when undefined_table or invalid_schema_name then
    raise exception 'migration 028 refused: public.store, tmpos_role.tenant_role_level, tmpos_role_edit.role_level_version, tmpos_customer.customer or public.audit_event is missing (migrations 002, 017, 020 and 021 must be applied first)'
      using errcode = 'object_not_in_prerequisite_state';
end
$$;

-- =============================================================================
-- 3) Preconditions: what this file builds on
-- =============================================================================
do $$
begin
  -- The chain is contiguous: 027 is the newest migration this file sits on.
  if pg_catalog.to_regnamespace('tmpos_store_access') is null
     or pg_catalog.to_regprocedure('tmpos_store_access.m7b_store_directory(text)') is null then
    raise exception 'migration 028 refused: migration 027 must be applied first'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- The objects the routines restate, read, lock or reference, and the tables this file alters.
  if pg_catalog.to_regprocedure('tmpos_session.m5_hold_tenant_standing(text, text)') is null
     or pg_catalog.to_regprocedure('tmpos_session.m5_admit_tenant_session_v2(text, text)') is null
     or pg_catalog.to_regclass('tmpos_session.session') is null
     or pg_catalog.to_regclass('tmpos_mint.tenant_session') is null
     or pg_catalog.to_regclass('tmpos_mint.issuer_key') is null
     or pg_catalog.to_regclass('tmpos_role.tenant_role_level') is null
     or pg_catalog.to_regclass('tmpos_role_edit.role_level_version') is null
     or pg_catalog.to_regclass('tmpos_customer.customer') is null
     or pg_catalog.to_regclass('public.store') is null
     or pg_catalog.to_regclass('public.tenant') is null
     or pg_catalog.to_regclass('public.user_membership') is null
     or pg_catalog.to_regclass('public.audit_event') is null
     or pg_catalog.to_regprocedure('tmpos_role_invoice.m7a_invoice_role_level_set(text, text, text, uuid, bigint)') is null then
    raise exception 'migration 028 refused: 016''s hold or admission read, 018''s mint ledger or issuer key, 020''s or 021''s level tables, 017''s customer table, 002''s tables or 026''s Invoices edit is missing'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if not exists (select 1 from pg_catalog.pg_attribute a
                  where a.attrelid = 'public.audit_event'::regclass and a.attname = 'subject_customer_id' and not a.attisdropped) then
    raise exception 'migration 028 refused: public.audit_event has no subject_customer_id (migration 024 must be applied first)'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- The runtime roles this file grants to and revokes from.
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'tmpos_app')
     or not exists (select 1 from pg_catalog.pg_roles where rolname = 'tmpos_audit_writer') then
    raise exception 'migration 028 refused: migration 005 must be applied first'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- Nothing of this file exists yet: it is applied once, over a chain that has never held it. The relation names are
  -- refused in ANY schema, as this file's rollback postcondition refuses them — stricter than 027's rollback guard, which
  -- reads them in schema tmpos_invoice_draft alone (a same-named relation elsewhere does not block it).
  if pg_catalog.to_regnamespace('tmpos_invoice_draft') is not null
     or exists (select 1 from pg_catalog.pg_class c where c.relname in ('invoice_draft', 'invoice_draft_line'))
     or exists (select 1 from pg_catalog.pg_attribute a
                 where a.attrelid = 'public.audit_event'::regclass and a.attname = 'subject_invoice_draft_id' and not a.attisdropped)
     or pg_catalog.to_regclass('public.idx_audit_event_subject_invoice_draft_occurred') is not null
     or exists (select 1 from pg_catalog.pg_constraint k
                 where (k.conrelid = 'public.store'::regclass and k.conname = 'store_tenant_store_key')
                    or (k.conrelid = 'tmpos_customer.customer'::regclass and k.conname = 'customer_tenant_customer_key')) then
    raise exception 'migration 028 refused: schema tmpos_invoice_draft, a relation named invoice_draft or invoice_draft_line, public.audit_event.subject_invoice_draft_id or its index, or one of the two UNIQUE constraints already exists'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- The create calls 016's hold and admission read as its owner, the principal applying this file.
  if not (pg_catalog.has_function_privilege(current_user, 'tmpos_session.m5_hold_tenant_standing(text, text)', 'EXECUTE')
          and pg_catalog.has_function_privilege(current_user, 'tmpos_session.m5_admit_tenant_session_v2(text, text)', 'EXECUTE')
          and pg_catalog.has_schema_privilege(current_user, 'tmpos_session', 'USAGE')
          and pg_catalog.has_schema_privilege(current_user, 'tmpos_mint', 'USAGE')
          and pg_catalog.has_schema_privilege(current_user, 'tmpos_role', 'USAGE')
          and pg_catalog.has_schema_privilege(current_user, 'tmpos_customer', 'USAGE')) then
    raise exception 'migration 028 refused: the applying principal cannot execute 016''s hold and admission read, which the routines call, or use the schemas they read'
      using errcode = 'insufficient_privilege';
  end if;
  -- Altering and referencing the tables needs their owner's privileges, and a SECURITY DEFINER routine reads and writes only
  -- what its OWNER may (017's argument): were the applying principal neither the owner of these tables nor a role inheriting
  -- that owner's privileges — or row security FORCEd on one — the alters or the foreign keys would fail, or the routines
  -- would find no session and refuse everything, or fail on a write.
  if exists (
    select 1
      from pg_catalog.pg_class c
     where c.oid = any (array['tmpos_session.session'::regclass, 'tmpos_mint.tenant_session'::regclass,
                              'tmpos_mint.issuer_key'::regclass, 'tmpos_role.tenant_role_level'::regclass,
                              'tmpos_customer.customer'::regclass, 'public.store'::regclass, 'public.tenant'::regclass,
                              'public.user_membership'::regclass, 'public.audit_event'::regclass])
       and (not pg_catalog.pg_has_role(current_user, c.relowner, 'USAGE') or c.relforcerowsecurity)) then
    raise exception 'migration 028 refused: the applying principal neither owns nor inherits the owner of the session table, the mint ledger, the issuer key, the role levels, tmpos_customer.customer, public.store, public.tenant, public.user_membership and public.audit_event, or one has forced row security'
      using errcode = 'insufficient_privilege';
  end if;
  -- Each privilege stated, one at a time (019's reason): SELECT and UPDATE on every row the create locks, INSERT on the role
  -- levels (the NULL lock rows), REFERENCES on the two tables this file's foreign keys name.
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
          and pg_catalog.has_table_privilege(current_user, 'tmpos_customer.customer', 'UPDATE')
          and pg_catalog.has_table_privilege(current_user, 'tmpos_customer.customer', 'REFERENCES')
          and pg_catalog.has_table_privilege(current_user, 'public.store', 'SELECT')
          and pg_catalog.has_table_privilege(current_user, 'public.store', 'UPDATE')
          and pg_catalog.has_table_privilege(current_user, 'public.store', 'REFERENCES')
          and pg_catalog.has_table_privilege(current_user, 'public.tenant', 'SELECT')
          and pg_catalog.has_table_privilege(current_user, 'public.user_membership', 'SELECT')) then
    raise exception 'migration 028 refused: the applying principal lacks a privilege the routines or the foreign keys need on the session table, the mint ledger, the issuer key, the role levels, tmpos_customer.customer, public.store, public.tenant or public.user_membership'
      using errcode = 'insufficient_privilege';
  end if;
end
$$;

-- =============================================================================
-- 4) The two referenced UNIQUE constraints (a composite foreign key needs one on exactly its columns)
-- =============================================================================
-- Each is implied by the table's key (store_id, customer_id alone are unique), so no existing row can violate it; the
-- btree each builds is the maintenance cost the header states.
alter table public.store add constraint store_tenant_store_key unique (tenant_id, store_id);
alter table tmpos_customer.customer add constraint customer_tenant_customer_key unique (tenant_id, customer_id);

-- =============================================================================
-- 5) The audit record's draft subject (024's subject_customer_id, for a draft)
-- =============================================================================
-- Adding a nullable column with no default rewrites no row, and fires no row trigger — 002's append-only trigger stays
-- exactly as it is. The audit writer's table-wide INSERT (005) covers it; nothing else is granted.
alter table public.audit_event add column subject_invoice_draft_id uuid;

comment on column public.audit_event.subject_invoice_draft_id is
  'Phase 4.0 M7b (migration 028): the invoice draft the recorded action created (a store-scope draft create). Written by the command transaction from the command''s server-generated aggregate id; never from request metadata. Plain column, no FK (audit is decoupled/append-only). Never accompanied by a description, an amount or a customer''s details.';

create index idx_audit_event_subject_invoice_draft_occurred on public.audit_event (subject_invoice_draft_id, occurred_at desc)
  where subject_invoice_draft_id is not null;

-- =============================================================================
-- 6) The schema and its two tables
-- =============================================================================
create schema tmpos_invoice_draft;

comment on schema tmpos_invoice_draft is
  'Phase 4.0 M7b (migration 028): store-owned invoice drafts — the two tables and the session-bound create, page and get routines POST/GET /api/v1/stores/{storeId}/invoice-drafts[/{id}] go through. Owned by this migration; tmpos_app holds USAGE and EXECUTE only.';

revoke all on schema tmpos_invoice_draft from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
grant usage on schema tmpos_invoice_draft to tmpos_app;

create table tmpos_invoice_draft.invoice_draft (
  draft_id       uuid        not null,
  tenant_id      uuid        not null,
  store_id       uuid        not null,
  customer_id    uuid        not null,
  status         text        collate "C" not null,
  currency       text        collate "C" not null,
  version        bigint      not null,
  line_count     integer     not null,
  subtotal_cents bigint      not null,
  created_at     timestamptz not null default pg_catalog.now(),
  created_by     uuid        not null,
  constraint invoice_draft_pkey primary key (draft_id),
  -- What a line's composite foreign key references: its header in exactly its scope.
  constraint invoice_draft_scope_key unique (draft_id, tenant_id, store_id),
  constraint invoice_draft_store_fkey foreign key (tenant_id, store_id) references public.store (tenant_id, store_id),
  constraint invoice_draft_customer_fkey foreign key (tenant_id, customer_id) references tmpos_customer.customer (tenant_id, customer_id),
  constraint invoice_draft_status_chk check (status = 'draft'),
  constraint invoice_draft_currency_chk check (currency = 'USD'),
  constraint invoice_draft_version_chk check (version = 1),
  constraint invoice_draft_line_count_chk check (line_count between 1 and 50),
  constraint invoice_draft_subtotal_chk check (subtotal_cents between 0 and 9007199254740991)
);

comment on table tmpos_invoice_draft.invoice_draft is
  'Phase 4.0 M7b (migration 028): one saved invoice draft of a store (status draft, USD, version 1), naming a customer of the store''s tenant by id. Written only by m7b_invoice_draft_create; read only by its page and get routines. No runtime role holds a privilege on it.';
comment on column tmpos_invoice_draft.invoice_draft.created_at is
  'Phase 4.0 M7b (migration 028): the creating transaction''s now() (the column default; never a value of the runtime''s). Rendered to the runtime with microseconds.';
comment on column tmpos_invoice_draft.invoice_draft.created_by is
  'Phase 4.0 M7b (migration 028): the creating actor''s app-owned internal_user_id. Plain uuid, no FK (the audit record''s actor column''s form).';

create table tmpos_invoice_draft.invoice_draft_line (
  draft_id         uuid    not null,
  tenant_id        uuid    not null,
  store_id         uuid    not null,
  position         integer not null,
  description      text    collate "C" not null,
  quantity         bigint  not null,
  unit_price_cents bigint  not null,
  line_total_cents bigint  not null,
  constraint invoice_draft_line_pkey primary key (draft_id, position),
  constraint invoice_draft_line_draft_fkey foreign key (draft_id, tenant_id, store_id)
    references tmpos_invoice_draft.invoice_draft (draft_id, tenant_id, store_id),
  constraint invoice_draft_line_position_chk check (position between 1 and 50),
  -- 017's customer_name_chk, at 256 characters: no C0 or C1 control, line or paragraph separator; no Bidi_Control; no
  -- edge whitespace. NUL and a lone surrogate cannot be stored in text at all; the runtime refuses both, and also requires
  -- a visible character (its runtime-only checks, server/runtime/invoiceDrafts.ts).
  constraint invoice_draft_line_description_chk check (
    pg_catalog.char_length(description) between 1 and 256
    and description !~ '[\u0001-\u001f\u007f-\u009f\u2028\u2029]'
    and description !~ '[\u061c\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069]'
    and description !~ '^[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]|[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]$'),
  constraint invoice_draft_line_quantity_chk check (quantity between 1 and 9007199254740991),
  constraint invoice_draft_line_unit_price_chk check (unit_price_cents between 0 and 9007199254740991),
  constraint invoice_draft_line_total_chk check (
    line_total_cents between 0 and 9007199254740991
    and line_total_cents::numeric = quantity::numeric * unit_price_cents::numeric)
);

comment on table tmpos_invoice_draft.invoice_draft_line is
  'Phase 4.0 M7b (migration 028): one ordered plain-text line of an invoice draft, in exactly its header''s tenant and store (composite foreign key). Its total is quantity x unit price in numeric. Written only by m7b_invoice_draft_create. No runtime role holds a privilege on it.';

-- The page's own order, inside one tenant and store; and a customer's drafts (the foreign key's referencing side).
create index invoice_draft_page_idx on tmpos_invoice_draft.invoice_draft (tenant_id, store_id, created_at desc, draft_id desc);
create index invoice_draft_customer_idx on tmpos_invoice_draft.invoice_draft (tenant_id, customer_id);

-- Reached only through the routines: row security on with no policy, and no privilege for any runtime role.
alter table tmpos_invoice_draft.invoice_draft enable row level security;
alter table tmpos_invoice_draft.invoice_draft_line enable row level security;
revoke all on table tmpos_invoice_draft.invoice_draft from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
revoke all on table tmpos_invoice_draft.invoice_draft_line from public, anon, authenticated, tmpos_app, tmpos_audit_writer;

-- =============================================================================
-- 7) The routines
-- =============================================================================

-- 7a) The create: every argument judged; the caller derived; one store grant at the store; the levels; the precondition;
--     the customer; the locks; the rows.
create function tmpos_invoice_draft.m7b_invoice_draft_create(
  p_session_key text, p_store_id uuid, p_draft_id uuid, p_expected_tenant uuid, p_customer_id uuid,
  p_lines jsonb, p_subtotal_cents bigint)
returns table (
  o_outcome       text,
  o_tenant_id     uuid,
  o_store_id      uuid,
  o_actor_id      uuid,
  o_membership_id uuid
)
language plpgsql
-- VOLATILE IS LOAD-BEARING (019's, 020's and 024's reason): it locks and then re-reads, and each statement must see what
-- committed before its own locks. Do not make it STABLE.
volatile
security definer
set search_path = pg_catalog, pg_temp
set row_security = off
as $$
declare
  -- The tenant ordering (permissionCatalog.ts TENANT_ORDERING), 020's constant, pinned by the parity test.
  c_levels         constant text[] := array['none', 'view', 'create', 'edit', 'manage', 'approve', 'full'];
  -- The largest integer a JavaScript number holds exactly: every amount's bound.
  c_max            constant numeric := 9007199254740991;
  v_count          integer;
  v_line           record;
  v_text           text;
  v_quantity       text;
  v_price          text;
  v_total          numeric;
  v_sum            numeric := 0;
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
  v_check          record;
begin
  -- 0. Every argument, before anything is read, locked or written. A refusal names the field, never the value.
  if p_session_key is null or p_session_key !~ '^[\x21-\x7e]{1,128}$'
     or p_store_id is null
     or p_draft_id is null
     or p_expected_tenant is null
     or p_customer_id is null then
    raise exception 'migration 028 create: an argument is malformed'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_subtotal_cents is null or p_subtotal_cents < 0 or p_subtotal_cents > c_max then
    raise exception 'migration 028 create: the subtotal is not a whole number from 0 to 9007199254740991'
      using errcode = 'invalid_parameter_value';
  end if;
  -- The lines: one array of 1-50 objects, each exactly {description, quantity, unitPriceCents}, judged one by one in
  -- order. Amounts are the plain digits a JSON integer is written in, bounded before any cast; every product and the
  -- running sum are numeric, so nothing overflows or rounds.
  if p_lines is null or pg_catalog.jsonb_typeof(p_lines) is distinct from 'array' then
    raise exception 'migration 028 create: the lines are not an array'
      using errcode = 'invalid_parameter_value';
  end if;
  v_count := pg_catalog.jsonb_array_length(p_lines);
  if v_count < 1 or v_count > 50 then
    raise exception 'migration 028 create: there are not 1 to 50 lines'
      using errcode = 'invalid_parameter_value';
  end if;
  for v_line in select e.entry from pg_catalog.jsonb_array_elements(p_lines) as e(entry) loop
    if pg_catalog.jsonb_typeof(v_line.entry) is distinct from 'object'
       or (select pg_catalog.array_agg(k.key order by k.key collate "C") from pg_catalog.jsonb_object_keys(v_line.entry) as k(key))
          is distinct from array['description', 'quantity', 'unitPriceCents']::text[] then
      raise exception 'migration 028 create: a line is not exactly a description, a quantity and a unit price'
        using errcode = 'invalid_parameter_value';
    end if;
    if pg_catalog.jsonb_typeof(v_line.entry -> 'description') is distinct from 'string'
       or pg_catalog.jsonb_typeof(v_line.entry -> 'quantity') is distinct from 'number'
       or pg_catalog.jsonb_typeof(v_line.entry -> 'unitPriceCents') is distinct from 'number' then
      raise exception 'migration 028 create: a line field has the wrong type'
        using errcode = 'invalid_parameter_value';
    end if;
    -- The description: one the line table's CHECK admits (restated, so the insert below cannot refuse it).
    v_text := v_line.entry ->> 'description';
    if not (
         pg_catalog.char_length(v_text) between 1 and 256
         and v_text !~ '[\u0001-\u001f\u007f-\u009f\u2028\u2029]'
         and v_text !~ '[\u061c\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069]'
         and v_text !~ '^[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]|[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]$') then
      raise exception 'migration 028 create: a line description is not one the line table admits'
        using errcode = 'invalid_parameter_value';
    end if;
    v_quantity := v_line.entry ->> 'quantity';
    if v_quantity !~ '^[1-9][0-9]{0,15}$' or v_quantity::numeric > c_max then
      raise exception 'migration 028 create: a line quantity is not a whole number from 1 to 9007199254740991'
        using errcode = 'invalid_parameter_value';
    end if;
    v_price := v_line.entry ->> 'unitPriceCents';
    if v_price !~ '^(0|[1-9][0-9]{0,15})$' or v_price::numeric > c_max then
      raise exception 'migration 028 create: a line unit price is not a whole number of cents from 0 to 9007199254740991'
        using errcode = 'invalid_parameter_value';
    end if;
    v_total := v_quantity::numeric * v_price::numeric;
    if v_total > c_max then
      raise exception 'migration 028 create: a line total is above 9007199254740991'
        using errcode = 'invalid_parameter_value';
    end if;
    v_sum := v_sum + v_total;
    if v_sum > c_max then
      raise exception 'migration 028 create: the lines'' sum is above 9007199254740991'
        using errcode = 'invalid_parameter_value';
    end if;
  end loop;
  if v_sum <> p_subtotal_cents::numeric then
    raise exception 'migration 028 create: the subtotal is not the sum of the line totals'
      using errcode = 'invalid_parameter_value';
  end if;
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'migration 028 create: it must run under READ COMMITTED, so that its checks see what committed before its locks'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- 1-6. The caller, derived exactly as 024's edit derives it (024 up, steps 1-6; see there and 019 for each step's
  --      reason): the unlocked live/issuer pre-check, 016's hold, the session and ledger rows FOR SHARE, the issuer key FOR
  --      SHARE, the clock after those waits, the standing digest the session was minted under, a write account status.
  select s.auth_provider, s.auth_provider_uid, s.expires_at, m.expires_at, m.issuer_digest
    into v_provider, v_uid, v_expires, v_minted_expires, v_minted_issuer
    from tmpos_session.session s
    join tmpos_mint.tenant_session m on m.session_key = s.session_key
   where s.session_key = p_session_key
     and s.audience = 'tenant';
  if not found then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;
  v_now := pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp()) * 1000)::bigint;
  if v_expires is distinct from v_minted_expires or v_now >= v_expires then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;
  select pg_catalog.sha256(k.key) into v_issuer from tmpos_mint.issuer_key k where k.singleton;
  if v_issuer is null or v_issuer is distinct from v_minted_issuer then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;

  if tmpos_session.m5_hold_tenant_standing(v_provider, v_uid) is distinct from 'held' then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid;
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
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;

  select pg_catalog.sha256(k.key) into v_issuer from tmpos_mint.issuer_key k where k.singleton for share;
  if v_issuer is null or v_issuer is distinct from v_session.issuer_digest then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;

  v_now := pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp()) * 1000)::bigint;
  if v_now >= v_session.expires_at then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid;
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
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;

  -- 7. EXACTLY ONE store-scope grant naming p_store_id — a selector among the actor's own grants, never proof — on a tenant
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
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;
  v_role := v_grants -> 0 ->> 'roleId';
  v_tenant := (v_grants -> 0 ->> 'tenantId')::uuid;
  v_membership := (v_grants -> 0 ->> 'membershipId')::uuid;
  -- 7a. Still that actor's active membership row at exactly that tenant, store and role (027's re-check; 016's hold holds it).
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
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;
  -- 7b. The store row, re-read FOR SHARE (016's hold already holds it): in that grant's tenant, with a write status.
  select st.tenant_id, st.status into v_store
    from public.store st
   where st.store_id = p_store_id
     for share;
  if not found
     or v_store.tenant_id is distinct from v_tenant
     or v_store.status is null
     or v_store.status not in ('active', 'trialing') then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;

  -- 8. The role's levels, UNLOCKED: Invoices at Create or above AND Customers at View or above. store_owner is Full (never
  --    stored); an editable role is its stored level, else its catalog default (the same for both domains); any other role
  --    refuses. Nothing is written or locked by a refusal here.
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
       < pg_catalog.array_position(c_levels, 'create')
       or coalesce(pg_catalog.array_position(c_levels,
         coalesce(v_customers, case v_role when 'manager' then 'full' when 'technician' then 'view' when 'sales_staff' then 'create' end)), 0)
       < pg_catalog.array_position(c_levels, 'view') then
      return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid;
      return;
    end if;
  else
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;

  -- 9. The request's expectedTenant (caller-supplied, never authority) against the tenant derived from the grant — a
  --    precondition only (021's and 022's rule): nothing written, no role row made to exist.
  if v_tenant is distinct from p_expected_tenant then
    return query select 'tenant_mismatch'::text, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;

  -- 10. The customer, UNLOCKED, filtered to the derived tenant: a missing id and another tenant's id are one answer, decided
  --     before any write (DA-36: the runtime seals it and commits only its completion).
  if not exists (
    select 1
      from tmpos_customer.customer c
     where c.customer_id = p_customer_id
       and c.tenant_id = v_tenant) then
    return query select 'customer_not_found'::text, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;

  -- 11-12. The role rows made to exist (NULL: the default) and held FOR SHARE until COMMIT, Customers then Invoices — a fixed
  --        order — then decided again on the locked values. An owner's level edit holding a row FOR UPDATE is waited for and
  --        its committed level is what is read; one attempted later waits for this transaction. A row gone by now refuses.
  if v_role in ('manager', 'technician', 'sales_staff') then
    insert into tmpos_role.tenant_role_level (tenant_id, role_id, domain, level, updated_at)
    values (v_tenant, v_role, 'customers', null, pg_catalog.now())
    on conflict (tenant_id, role_id, domain) do nothing;
    select l.level into v_customers
      from tmpos_role.tenant_role_level l
     where l.tenant_id = v_tenant and l.role_id = v_role and l.domain = 'customers'
       for share;
    if not found then
      return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid;
      return;
    end if;
    insert into tmpos_role.tenant_role_level (tenant_id, role_id, domain, level, updated_at)
    values (v_tenant, v_role, 'invoices', null, pg_catalog.now())
    on conflict (tenant_id, role_id, domain) do nothing;
    select l.level into v_invoices
      from tmpos_role.tenant_role_level l
     where l.tenant_id = v_tenant and l.role_id = v_role and l.domain = 'invoices'
       for share;
    if not found then
      return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid;
      return;
    end if;
    if coalesce(pg_catalog.array_position(c_levels,
         coalesce(v_invoices, case v_role when 'manager' then 'full' when 'technician' then 'view' when 'sales_staff' then 'create' end)), 0)
       < pg_catalog.array_position(c_levels, 'create')
       or coalesce(pg_catalog.array_position(c_levels,
         coalesce(v_customers, case v_role when 'manager' then 'full' when 'technician' then 'view' when 'sales_staff' then 'create' end)), 0)
       < pg_catalog.array_position(c_levels, 'view') then
      return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid;
      return;
    end if;
  end if;

  -- 13. Live, on the database clock read again now: step 11 may have waited.
  v_now := pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp()) * 1000)::bigint;
  if v_now >= v_session.expires_at then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;
  -- The customer, held FOR KEY SHARE in the derived tenant until COMMIT (the foreign key's own lock, taken first). Step 10
  -- found it; a customer gone since is a fault, never an answer.
  perform 1
     from tmpos_customer.customer c
    where c.customer_id = p_customer_id
      and c.tenant_id = v_tenant
      for key share;
  if not found then
    raise exception 'migration 028 create: the customer is no longer in the tenant'
      using errcode = 'no_data_found';
  end if;
  v_now := pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp()) * 1000)::bigint;
  if v_now >= v_session.expires_at then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid;
    return;
  end if;

  -- 14. The header and the lines. The CHECKs restate step 0, so they cannot refuse; were any constraint ever to (a reused
  --     id included), the raise is fixed text, never the row.
  begin
    insert into tmpos_invoice_draft.invoice_draft
      (draft_id, tenant_id, store_id, customer_id, status, currency, version, line_count, subtotal_cents, created_by)
    values
      (p_draft_id, v_tenant, p_store_id, p_customer_id, 'draft', 'USD', 1, v_count, p_subtotal_cents, v_admission.actor_id);
  exception
    when unique_violation or check_violation or foreign_key_violation or not_null_violation then
      raise exception 'migration 028 create: the draft is not one the draft table admits'
        using errcode = 'integrity_constraint_violation';
  end;
  begin
    insert into tmpos_invoice_draft.invoice_draft_line
      (draft_id, tenant_id, store_id, position, description, quantity, unit_price_cents, line_total_cents)
    select p_draft_id, v_tenant, p_store_id, e.ordinality::integer, e.entry ->> 'description',
           (e.entry ->> 'quantity')::bigint, (e.entry ->> 'unitPriceCents')::bigint,
           ((e.entry ->> 'quantity')::numeric * (e.entry ->> 'unitPriceCents')::numeric)::bigint
      from pg_catalog.jsonb_array_elements(p_lines) with ordinality as e(entry, ordinality);
  exception
    when unique_violation or check_violation or foreign_key_violation or not_null_violation or numeric_value_out_of_range then
      raise exception 'migration 028 create: a line is not one the line table admits'
        using errcode = 'integrity_constraint_violation';
  end;

  -- 15. Exactly the lines step 0 judged: n rows at positions 1..n whose totals sum to the header's subtotal.
  select pg_catalog.count(*)::integer as n, pg_catalog.min(l.position) as lo, pg_catalog.max(l.position) as hi,
         coalesce(pg_catalog.sum(l.line_total_cents::numeric), -1) as total
    into v_check
    from tmpos_invoice_draft.invoice_draft_line l
   where l.draft_id = p_draft_id and l.tenant_id = v_tenant and l.store_id = p_store_id;
  if v_check.n is distinct from v_count or v_check.lo is distinct from 1 or v_check.hi is distinct from v_count
     or v_check.total is distinct from p_subtotal_cents::numeric then
    raise exception 'migration 028 create: the lines written are not exactly the lines judged'
      using errcode = 'no_data_found';
  end if;

  return query select 'applied'::text, v_tenant, p_store_id, v_admission.actor_id, v_membership;
end
$$;

comment on function tmpos_invoice_draft.m7b_invoice_draft_create(text, uuid, uuid, uuid, uuid, jsonb, bigint) is
  'Phase 4.0 M7b (migration 028): saves one invoice draft (status draft, USD, version 1) and its 1-50 ordered lines at a store, for a key naming a ledger-minted, live (database clock, read after every lock wait) tenant session minted under the installed issuer key, after 016''s hold and the session, ledger and issuer key rows, whose standing digest is unchanged, whose account status is active or trialing, who holds EXACTLY ONE active store-scope grant at p_store_id (a selector only) on an active or trialing tenant and store — the store row re-read FOR SHARE in that grant''s tenant — and whose role''s Invoices level is Create or above and Customers level View or above (store_owner full; manager, technician, sales_staff the owner''s stored level, read unlocked and then FOR SHARE, Customers then Invoices, else the catalog default). Judges every argument first (invalid_parameter_value, a fixed message naming the field, never the value; the lines one jsonb array of exact objects, amounts in numeric, their sum equal to p_subtotal_cents). Answers one row: (''refused'', NULLs) for any authority refusal; (''tenant_mismatch'', NULLs) when the grant''s tenant is not p_expected_tenant; (''customer_not_found'', NULLs) alike for a missing and another tenant''s customer — all three before any write; else inserts the header and the lines and answers (''applied'', tenant, store, actor, membership). Writes no audit record.';

-- 7b) The page: the caller derived as 027's read derives it, one store grant at the expected store, Invoices View; then the
--     drafts of exactly that tenant and store, newest first, after the anchor the continuation names.
create function tmpos_invoice_draft.m7b_invoice_draft_page(
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
  --    and another tenant's are one answer. Its created_at never leaves the database.
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

  -- 7. The page: newest first, the id breaking equal times, strictly after the anchor in that order.
  return query
    select 'draft'::text, d.tenant_id, d.store_id, d.draft_id, d.customer_id, d.status::text, d.currency::text, d.line_count,
           d.subtotal_cents,
           pg_catalog.to_char(d.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
      from tmpos_invoice_draft.invoice_draft d
     where d.tenant_id = v_tenant
       and d.store_id = p_expected_store
       and (p_after_draft_id is null or (d.created_at, d.draft_id) < (v_after, p_after_draft_id))
     order by d.created_at desc, d.draft_id desc
     limit p_limit;
end
$$;

comment on function tmpos_invoice_draft.m7b_invoice_draft_page(text, uuid, uuid, uuid, integer) is
  'Phase 4.0 M7b (migration 028): one page (at most p_limit, 1-51) of the drafts of exactly one tenant and store, newest first by (created_at desc, draft_id desc), each row (''draft'', tenant, store, draft id, customer id, status, currency, line count, subtotal cents, created_at as UTC text with microseconds), for a key naming a ledger-minted, live tenant session under the installed issuer key whose standing digest is unchanged, whose account status admits a read, who holds EXACTLY ONE store-scope grant at p_expected_store — still its active membership, its store in its tenant, account, tenant and store active, trialing, overdue or read_only — on p_expected_tenant (a precondition only), and whose role''s Invoices level is View or above. A continuation names an anchor draft id, re-read inside that tenant and store (''cursor_unknown'' alike for a missing, another store''s and another tenant''s). No row for a store with no draft; otherwise (''denied'', NULLs) or (''invalid'', NULLs). Read-only; locks nothing.';

-- 7c) The get: the page's derivation, then ONE point read of the draft in exactly that tenant and store, and its lines.
create function tmpos_invoice_draft.m7b_invoice_draft_get(
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

  -- 6. ONE point read: the key, filtered to the derived tenant AND the expected store. A missing id, another store's and
  --    another tenant's take this same statement and this same branch.
  select d.draft_id, d.customer_id, d.status, d.currency, d.version, d.line_count, d.subtotal_cents,
         pg_catalog.to_char(d.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at
    into v_draft
    from tmpos_invoice_draft.invoice_draft d
   where d.draft_id = p_draft_id
     and d.tenant_id = v_tenant
     and d.store_id = p_expected_store;
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

comment on function tmpos_invoice_draft.m7b_invoice_draft_get(text, uuid, uuid, uuid) is
  'Phase 4.0 M7b (migration 028): one draft of exactly one tenant and store with its lines — one row per line in position order, each (''draft'', tenant, store, draft id, customer id, status, currency, version, created_at as UTC text with microseconds, line count, subtotal cents, position, description, quantity, unit price cents, line total cents) — under the page''s derivation (a minted, live, unchanged-standing tenant session; exactly one store grant at p_expected_store on p_expected_tenant, a precondition only; read statuses; Invoices View). (''not_found'', NULLs) alike for a missing draft and another store''s or tenant''s; otherwise (''denied'', NULLs) or (''invalid'', NULLs). Read-only; locks nothing.';

-- =============================================================================
-- 8) Privileges, and the proof that nothing wider was issued
-- =============================================================================
-- PostgreSQL grants EXECUTE on a new function to PUBLIC by default, so every default is removed explicitly before the one
-- intended grant is issued. No table or column grant.
revoke all on function tmpos_invoice_draft.m7b_invoice_draft_create(text, uuid, uuid, uuid, uuid, jsonb, bigint) from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
revoke all on function tmpos_invoice_draft.m7b_invoice_draft_page(text, uuid, uuid, uuid, integer) from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
revoke all on function tmpos_invoice_draft.m7b_invoice_draft_get(text, uuid, uuid, uuid) from public, anon, authenticated, tmpos_app, tmpos_audit_writer;

grant execute on function tmpos_invoice_draft.m7b_invoice_draft_create(text, uuid, uuid, uuid, uuid, jsonb, bigint) to tmpos_app;
grant execute on function tmpos_invoice_draft.m7b_invoice_draft_page(text, uuid, uuid, uuid, integer) to tmpos_app;
grant execute on function tmpos_invoice_draft.m7b_invoice_draft_get(text, uuid, uuid, uuid) to tmpos_app;

-- =============================================================================
-- 9) Postcondition
-- =============================================================================
-- Proven rather than asserted, in 024's form. This file refuses to finish unless, now:
--   (a) public.store carries store_tenant_store_key and tmpos_customer.customer customer_tenant_customer_key, each a
--       validated UNIQUE on exactly (tenant_id, store_id) / (tenant_id, customer_id);
--   (b) public.audit_event.subject_invoice_draft_id is a nullable uuid with no default, its partial index exists on that
--       table, the audit writer may insert it (its table-wide grant), and no column of the audit table carries a grant;
--   (c) the schema holds exactly the two tables, their two primary keys, the header's scope key and the two indexes beyond
--       those, and the three routines — no other relation, no standalone type, and no trigger calls a function of it;
--   (d) each table has exactly the declared columns (types, collations, nullability, defaults) and constraints, all
--       validated, row security enabled and not forced, no policy, and no grant beyond its owner's on it or any column;
--   (e) the create is plpgsql, SECURITY DEFINER, VOLATILE, and both reads plpgsql, SECURITY DEFINER, STABLE, all pinned to
--       the search path above and run with row_security off, and they, the tables and the schema are owned by the applying
--       principal;
--   (f) the routines carry no grant beyond their owner's and a non-grantable EXECUTE to tmpos_app, and the schema none
--       beyond its owner's and a non-grantable USAGE to tmpos_app;
--   (g) tmpos_app CAN execute all three routines and use the schema; tmpos_audit_writer, anon and authenticated CANNOT
--       execute any of them by any path; no runtime role holds any privilege on either table by any path;
--   (h) none of the runtime roles is a MEMBER of the owner of the schema, its routines, its tables, or a table they read.
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
  if (select pg_catalog.count(*) from pg_catalog.pg_constraint k
       where k.conrelid = 'public.store'::regclass and k.conname = 'store_tenant_store_key' and k.contype = 'u'
         and k.convalidated and pg_catalog.pg_get_constraintdef(k.oid) = 'UNIQUE (tenant_id, store_id)') <> 1
     or (select pg_catalog.count(*) from pg_catalog.pg_constraint k
          where k.conrelid = 'tmpos_customer.customer'::regclass and k.conname = 'customer_tenant_customer_key' and k.contype = 'u'
            and k.convalidated and pg_catalog.pg_get_constraintdef(k.oid) = 'UNIQUE (tenant_id, customer_id)') <> 1 then
    raise exception 'migration 028 refused: public.store or tmpos_customer.customer does not carry this file''s UNIQUE constraint'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (b)
  if not exists (
    select 1
      from pg_catalog.pg_attribute a
     where a.attrelid = 'public.audit_event'::regclass
       and a.attname = 'subject_invoice_draft_id'
       and not a.attisdropped
       and a.atttypid = 'pg_catalog.uuid'::regtype
       and not a.attnotnull
       and not a.atthasdef)
     or not exists (select 1 from pg_catalog.pg_index x
                     where x.indexrelid = pg_catalog.to_regclass('public.idx_audit_event_subject_invoice_draft_occurred')
                       and x.indrelid = 'public.audit_event'::regclass)
     or not pg_catalog.has_column_privilege('tmpos_audit_writer', 'public.audit_event', 'subject_invoice_draft_id', 'INSERT')
     or exists (select 1 from pg_catalog.pg_attribute a
                 where a.attrelid = 'public.audit_event'::regclass and a.attacl is not null) then
    raise exception 'migration 028 refused: public.audit_event.subject_invoice_draft_id is not the nullable uuid, index and writer reach section 5 declares, or a column of the audit table carries a grant'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (c)
  select pg_catalog.string_agg(pg_catalog.format('%s:%s', c.relname, c.relkind), ', ' order by c.relname) into v_bad
    from pg_catalog.pg_class c
   where c.relnamespace = 'tmpos_invoice_draft'::regnamespace;
  if v_bad is distinct from
       'invoice_draft:r, invoice_draft_customer_idx:i, invoice_draft_line:r, invoice_draft_line_pkey:i, invoice_draft_page_idx:i, invoice_draft_pkey:i, invoice_draft_scope_key:i' then
    raise exception 'migration 028 refused: schema tmpos_invoice_draft does not hold exactly the two tables and their indexes (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if (select pg_catalog.count(*) from pg_catalog.pg_proc p where p.pronamespace = 'tmpos_invoice_draft'::regnamespace) <> 3
     or pg_catalog.to_regprocedure('tmpos_invoice_draft.m7b_invoice_draft_create(text, uuid, uuid, uuid, uuid, jsonb, bigint)') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_draft.m7b_invoice_draft_page(text, uuid, uuid, uuid, integer)') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_draft.m7b_invoice_draft_get(text, uuid, uuid, uuid)') is null
     or exists (select 1 from pg_catalog.pg_type t
                 where t.typnamespace = 'tmpos_invoice_draft'::regnamespace and t.typrelid = 0 and t.typelem = 0)
     or exists (select 1 from pg_catalog.pg_trigger g join pg_catalog.pg_proc p on p.oid = g.tgfoid
                 where p.pronamespace = 'tmpos_invoice_draft'::regnamespace)
     or exists (select 1 from pg_catalog.pg_trigger g
                 where g.tgrelid in ('tmpos_invoice_draft.invoice_draft'::regclass, 'tmpos_invoice_draft.invoice_draft_line'::regclass)
                   and not g.tgisinternal) then
    raise exception 'migration 028 refused: schema tmpos_invoice_draft does not hold exactly the three routines this file creates, or a type or trigger exists'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (d)
  select pg_catalog.string_agg(pg_catalog.format('%s %s %s %s %s', a.attname, pg_catalog.format_type(a.atttypid, a.atttypmod),
           coalesce(co.collname::text, '-'), a.attnotnull, coalesce(pg_catalog.pg_get_expr(d.adbin, d.adrelid), '-')),
           ', ' order by a.attnum)
    into v_bad
    from pg_catalog.pg_attribute a
    left join pg_catalog.pg_collation co on co.oid = a.attcollation
    left join pg_catalog.pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
   where a.attrelid = 'tmpos_invoice_draft.invoice_draft'::regclass
     and a.attnum > 0
     and not a.attisdropped;
  if v_bad is distinct from
       'draft_id uuid - t -, tenant_id uuid - t -, store_id uuid - t -, customer_id uuid - t -, status text C t -, currency text C t -, version bigint - t -, line_count integer - t -, subtotal_cents bigint - t -, created_at timestamp with time zone - t now(), created_by uuid - t -' then
    raise exception 'migration 028 refused: tmpos_invoice_draft.invoice_draft does not have exactly the declared columns (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  select pg_catalog.string_agg(pg_catalog.format('%s %s %s %s %s', a.attname, pg_catalog.format_type(a.atttypid, a.atttypmod),
           coalesce(co.collname::text, '-'), a.attnotnull, coalesce(pg_catalog.pg_get_expr(d.adbin, d.adrelid), '-')),
           ', ' order by a.attnum)
    into v_bad
    from pg_catalog.pg_attribute a
    left join pg_catalog.pg_collation co on co.oid = a.attcollation
    left join pg_catalog.pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
   where a.attrelid = 'tmpos_invoice_draft.invoice_draft_line'::regclass
     and a.attnum > 0
     and not a.attisdropped;
  if v_bad is distinct from
       'draft_id uuid - t -, tenant_id uuid - t -, store_id uuid - t -, position integer - t -, description text C t -, quantity bigint - t -, unit_price_cents bigint - t -, line_total_cents bigint - t -' then
    raise exception 'migration 028 refused: tmpos_invoice_draft.invoice_draft_line does not have exactly the declared columns (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  select pg_catalog.string_agg(pg_catalog.format('%s:%s:%s', c.conname, c.contype, c.convalidated), ', ' order by c.conname)
    into v_bad
    from pg_catalog.pg_constraint c
   where c.conrelid in ('tmpos_invoice_draft.invoice_draft'::regclass, 'tmpos_invoice_draft.invoice_draft_line'::regclass)
     and c.contype <> 'n'; -- PostgreSQL 18 records NOT NULL as a constraint too; this file declared those as columns
  if v_bad is distinct from
       'invoice_draft_currency_chk:c:t, invoice_draft_customer_fkey:f:t, invoice_draft_line_count_chk:c:t, invoice_draft_line_description_chk:c:t, invoice_draft_line_draft_fkey:f:t, invoice_draft_line_pkey:p:t, invoice_draft_line_position_chk:c:t, invoice_draft_line_quantity_chk:c:t, invoice_draft_line_total_chk:c:t, invoice_draft_line_unit_price_chk:c:t, invoice_draft_pkey:p:t, invoice_draft_scope_key:u:t, invoice_draft_status_chk:c:t, invoice_draft_store_fkey:f:t, invoice_draft_subtotal_chk:c:t, invoice_draft_version_chk:c:t' then
    raise exception 'migration 028 refused: the draft tables do not carry exactly the declared constraints (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- No foreign key of this file cascades, sets null or defers: each is NO ACTION, immediate.
  if exists (select 1 from pg_catalog.pg_constraint c
              where c.conrelid in ('tmpos_invoice_draft.invoice_draft'::regclass, 'tmpos_invoice_draft.invoice_draft_line'::regclass)
                and c.contype = 'f'
                and (c.confupdtype <> 'a' or c.confdeltype <> 'a' or c.condeferrable)) then
    raise exception 'migration 028 refused: a foreign key of the draft tables cascades, sets a value or is deferrable'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if (select pg_catalog.count(*) from pg_catalog.pg_class c
       where c.oid in ('tmpos_invoice_draft.invoice_draft'::regclass, 'tmpos_invoice_draft.invoice_draft_line'::regclass)
         and c.relrowsecurity and not c.relforcerowsecurity and c.relowner = v_me) <> 2
     or exists (select 1 from pg_catalog.pg_policy p
                 where p.polrelid in ('tmpos_invoice_draft.invoice_draft'::regclass, 'tmpos_invoice_draft.invoice_draft_line'::regclass))
     or exists (select 1 from pg_catalog.pg_attribute a
                 where a.attrelid in ('tmpos_invoice_draft.invoice_draft'::regclass, 'tmpos_invoice_draft.invoice_draft_line'::regclass)
                   and a.attacl is not null) then
    raise exception 'migration 028 refused: a draft table is not owned by the applying principal with row security enabled and not forced and no policy, or a column carries a grant'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  select pg_catalog.string_agg(pg_catalog.format('%s %s:%s', c.relname, g.grantee::regrole::text, g.privilege_type), ', ')
    into v_bad
    from pg_catalog.pg_class c,
         pg_catalog.aclexplode(coalesce(c.relacl, pg_catalog.acldefault('r', c.relowner))) g
   where c.oid in ('tmpos_invoice_draft.invoice_draft'::regclass, 'tmpos_invoice_draft.invoice_draft_line'::regclass)
     and g.grantee <> c.relowner;
  if v_bad is not null then
    raise exception 'migration 028 refused: a draft table carries a grant beyond its owner''s (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (e)
  if (select pg_catalog.count(*)
        from pg_catalog.pg_proc p
        join pg_catalog.pg_language l on l.oid = p.prolang
       where p.pronamespace = 'tmpos_invoice_draft'::regnamespace
         and l.lanname = 'plpgsql'
         and p.prosecdef
         and p.provolatile = case when p.proname = 'm7b_invoice_draft_create' then 'v' else 's' end
         and p.proconfig = array['search_path=pg_catalog, pg_temp', 'row_security=off']
         and p.proowner = v_me) <> 3
     or not exists (select 1 from pg_catalog.pg_namespace n
                     where n.oid = 'tmpos_invoice_draft'::regnamespace and n.nspowner = v_me) then
    raise exception 'migration 028 refused: the routines are not plpgsql SECURITY DEFINER routines (the create VOLATILE, the reads STABLE) pinned to pg_catalog, pg_temp with row_security off, owned with their schema by the applying principal'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (f)
  select pg_catalog.string_agg(pg_catalog.format('%s %s:%s', p.proname, g.grantee::regrole::text, g.privilege_type), ', ')
    into v_bad
    from pg_catalog.pg_proc p,
         pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g
   where p.pronamespace = 'tmpos_invoice_draft'::regnamespace
     and g.grantee <> p.proowner
     and not (g.grantee = 'tmpos_app'::regrole and g.privilege_type = 'EXECUTE' and not g.is_grantable);
  if v_bad is not null then
    raise exception 'migration 028 refused: an unexpected direct grant remains on a tmpos_invoice_draft routine (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  select pg_catalog.string_agg(pg_catalog.format('%s:%s', g.grantee::regrole::text, g.privilege_type), ', ')
    into v_bad
    from pg_catalog.pg_namespace n,
         pg_catalog.aclexplode(coalesce(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) g
   where n.oid = 'tmpos_invoice_draft'::regnamespace
     and g.grantee <> n.nspowner
     and not (g.grantee = 'tmpos_app'::regrole and g.privilege_type = 'USAGE' and not g.is_grantable);
  if v_bad is not null then
    raise exception 'migration 028 refused: schema tmpos_invoice_draft carries an unexpected grant (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (g) MAINTAIN only on a server that has it (PostgreSQL 17+), where has_table_privilege would reject it on 16.
  if (select pg_catalog.count(*) from pg_catalog.pg_proc p
       where p.pronamespace = 'tmpos_invoice_draft'::regnamespace
         and pg_catalog.has_function_privilege('tmpos_app', p.oid, 'EXECUTE')) <> 3
     or not pg_catalog.has_schema_privilege('tmpos_app', 'tmpos_invoice_draft'::regnamespace, 'USAGE') then
    raise exception 'migration 028 refused: tmpos_app does not hold EXECUTE on the three routines and USAGE on schema tmpos_invoice_draft'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  select pg_catalog.string_agg(distinct r.rolname::text, ', ') into v_bad
    from pg_catalog.pg_roles r
    join pg_catalog.pg_roles x on pg_catalog.pg_has_role(r.oid, x.oid, 'MEMBER')
    cross join pg_catalog.pg_proc p
   where p.pronamespace = 'tmpos_invoice_draft'::regnamespace
     and r.rolname = any (array['tmpos_audit_writer', 'anon', 'authenticated']::name[])
     and pg_catalog.has_function_privilege(x.oid, p.oid, 'EXECUTE');
  if v_bad is not null then
    raise exception 'migration 028 refused: a runtime role other than tmpos_app can execute a tmpos_invoice_draft routine (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;
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
    raise exception 'migration 028 refused: % holds a privilege on a draft table', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (h)
  select pg_catalog.string_agg(distinct r.rolname::text, ', ') into v_bad
    from pg_catalog.pg_roles r
    cross join (
      select n.nspowner as owner from pg_catalog.pg_namespace n where n.nspname = 'tmpos_invoice_draft'
      union
      select p.proowner from pg_catalog.pg_proc p where p.pronamespace = 'tmpos_invoice_draft'::regnamespace
      union
      select c.relowner from pg_catalog.pg_class c
       where c.oid in ('tmpos_invoice_draft.invoice_draft'::regclass, 'tmpos_invoice_draft.invoice_draft_line'::regclass,
                       'tmpos_session.session'::regclass, 'tmpos_mint.tenant_session'::regclass, 'tmpos_mint.issuer_key'::regclass,
                       'tmpos_role.tenant_role_level'::regclass, 'tmpos_customer.customer'::regclass, 'public.store'::regclass,
                       'public.tenant'::regclass, 'public.user_membership'::regclass)
    ) o
   where r.rolname = any (array['tmpos_app', 'tmpos_audit_writer', 'anon', 'authenticated']::name[])
     and pg_catalog.pg_has_role(r.oid, o.owner, 'MEMBER');
  if v_bad is not null then
    raise exception 'migration 028 refused: % is a member of the owner of schema tmpos_invoice_draft, its routines, its tables or a table they read', v_bad
      using errcode = 'object_not_in_prerequisite_state',
            hint = 'membership hands a role everything the owner holds, including a direct write of every draft';
  end if;
end
$$;

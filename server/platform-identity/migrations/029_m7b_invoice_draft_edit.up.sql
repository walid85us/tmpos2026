-- Phase 4.0 M7b — editing a saved store invoice draft: the draft's version admitted above 1, one row trigger that keeps a
-- draft's identity, scope, creation time and creator fixed and its version moving by at most one, and one session-bound
-- edit that replaces a draft's customer and its complete ordered lines at an expected version, decided on the actor's own
-- store grant at exactly that store and its role's Invoices level at Edit under the established locking order
-- (M7B-INVOICES-P2; G-IAM, G-ISOLATION, G-DBROLE, G-AUDIT; docs/phase-4/10)
-- Migration: 029_m7b_invoice_draft_edit (UP)
--
-- SCOPE / TRUTH (binding):
--   - ONE CHECK REPLACED UNDER ITS OWN NAME; ONE TRIGGER WITH ITS TRIGGER FUNCTION; ONE ROUTINE; ONE GRANT (EXECUTE ON THE
--     ROUTINE TO tmpos_app); THREE COMMENTS REWORDED. NO TABLE, COLUMN, INDEX, SCHEMA, ROLE, MEMBERSHIP, TYPE OR POLICY; NO
--     TABLE OR SCHEMA PRIVILEGE. tmpos_invoice_draft.invoice_draft's invoice_draft_version_chk, CHECK (version = 1) at 028,
--     becomes CHECK (version between 1 and 9007199254740991); the trigger trg_invoice_draft_immutable (BEFORE UPDATE, FOR EACH
--     ROW, ENABLE ALWAYS) calls tmpos_invoice_draft.m7b_invoice_draft_immutable(); the routine
--     tmpos_invoice_draft.m7b_invoice_draft_update serves PATCH /api/v1/stores/{storeId}/invoice-drafts/{id}; the comments on
--     the two draft tables name the edit as a writer, and the comment on public.audit_event.subject_invoice_draft_id covers
--     an edit's audit record. Those are its only effects on objects
--     earlier migrations created: 001-028 stay byte for byte as committed (the migration-files contract's pinned checksums
--     prove that), 028's three routines, its tables' columns and every other constraint stay exactly as they are, no row is
--     written, and tmpos_app gains no privilege on any table.
--   - WHY IT EXISTS. The owner's stage brief lets a store role at Invoices Edit or above (persisted, server-decided) replace a
--     saved draft's customer and its complete ordered lines, at the version it read; currency, status, the draft's id,
--     tenant, store, creation time and creator never change, and there is no modified-at column (none is added: no new
--     timestamp policy). The runtime seals the answer, writes the audit record and the outbox event around this routine in
--     its one command transaction; this file writes neither.
--   - THE VERSION. 028 pinned it to 1; it is now 1 to 9007199254740991 (the largest integer a JavaScript number holds
--     exactly, 024's customer bound), and only this file's routine moves it: by exactly one, in the one UPDATE that writes the
--     edit. An expected version is 1 to 9007199254740990, so a draft at 9007199254740991 can never be edited (every expected
--     version a caller can send conflicts) and the version never wraps, resets or overflows.
--   - THE TRIGGER (D8). BEFORE UPDATE, FOR EACH ROW, on the header table only, ENABLE ALWAYS (013's, 008's and 021's form: a
--     plain trigger is skipped by a session running with session_replication_role = replica). It raises restrict_violation
--     with a fixed message when an UPDATE — by any path, the table owner's included — changes draft_id, tenant_id, store_id,
--     created_at or created_by, or sets version to anything but its old value or its old value plus one. status and currency
--     stay pinned by 028's CHECKs. SECURITY INVOKER, reads no relation, pinned search_path, granted to nobody (a trigger
--     function fires without EXECUTE). The routine's UPDATE never names an immutable column and steps the version by one, so
--     it never trips it. No existing trigger is disabled or replaced.
--   - THE EDIT'S ONLY AUTHORITY ARGUMENT IS THE SESSION KEY; p_store_id AND p_draft_id ARE SELECTORS. m7b_invoice_draft_update
--     first judges every argument — the create's step 0 restated with this file's messages (the key's shape, the ids, the
--     expected tenant, the subtotal's range, the lines: ONE jsonb array of 1-50 objects each exactly {description, quantity,
--     unitPriceCents}, the description one the line table's CHECK admits, the quantity a whole number 1 to 9007199254740991
--     and the unit price 0 to 9007199254740991 as JSON's plain digits, every line total and their sum within
--     9007199254740991 in numeric, that sum equal to p_subtotal_cents) and the expected version 1 to 9007199254740990 —
--     raising invalid_parameter_value with a FIXED message naming the field, never the value, before anything is read, locked
--     or written; and it refuses (object_not_in_prerequisite_state) outside READ COMMITTED. Then, with nothing written before
--     any answer but 'applied' — save step 10's lock anchor, whose INSERT can precede a step-10 refusal the runtime rolls
--     back with it (DA-36, below):
--       1-2. The caller and its one store grant at p_store_id, exactly as 028's create derives them (its steps 1-7: the
--            unlocked live/issuer pre-check, 016's hold, the session and ledger rows FOR SHARE, the issuer key FOR SHARE, the
--            database clock, the unchanged standing digest, an active or trialing account; exactly one store-scope grant
--            naming p_store_id on an active or trialing tenant and store, still the actor's active membership row, the store
--            row re-read FOR SHARE in that grant's tenant with a write status). Any refusal: ('refused', NULLs).
--          3. The role's Invoices level, UNLOCKED, at Edit or above (store_owner Full; manager, technician, sales_staff the
--             tenant owner's stored level, else the catalog default — manager full, technician view, sales_staff create; any
--             other role refuses): else ('refused', NULLs). One permission, one decision: the runtime authorizer and
--             revalidator decide the same threshold (m5CanonicalPermissions.ts edit_invoice_drafts, no corequisite). The
--             Customers level is not read: the edit does not decide it.
--          4. p_expected_tenant (the REQUEST's expectedTenant, a precondition only, never authority) must be the grant's
--             tenant: else ('tenant_mismatch', NULLs).
--          5. The header, LOCKED FOR UPDATE in ONE statement that reads its status, version, customer and line count, filtered
--             by p_draft_id, the derived tenant and p_store_id ONLY — never by the version: under READ COMMITTED a waiter
--             re-evaluates its WHERE on the row a concurrent edit committed, and a version filter there would turn that edit
--             into 'not_found' instead of 'conflict'. A missing draft, another store's and another tenant's are ONE answer:
--             ('not_found', NULLs). The clock again (the lock may have waited): expired is ('refused', NULLs).
--          6. A status other than 'draft' (unreachable while 028's CHECK pins it): ('invalid_state', NULLs).
--          7. A version other than p_expected_version — whatever the lines and customer sent, so a stale no-op conflicts too:
--             ('conflict', NULLs).
--          8. The replacement customer, FOR KEY SHARE in the derived tenant (the foreign key's own lock): a missing id and
--             another tenant's are the draft's same answer, ('not_found', NULLs). The clock again.
--          9. THE NO-OP: the customer equal AND the stored lines equal p_lines element by element in order (same count; each
--             position's description, quantity and unit price) — ('unchanged', tenant, store, actor, membership, the current
--             version), NOTHING written: equal totals with other lines, or the same lines reordered, are a change.
--         10. THE CHANGE PATH ONLY: the role's Invoices row made to exist (NULL, the default; INSERT ... ON CONFLICT DO
--             NOTHING, 028's statement) and held FOR SHARE (store_owner has no role row and skips this), then the level decided
--             again on the locked value: below Edit is ('refused', NULLs). The clock again. The Customers row is not taken.
--         11. The lines DELETEd (scoped by draft, tenant and store), the new ones INSERTed at positions 1..n, then the header
--             UPDATEd — customer, line count, subtotal and version + 1 — on exactly the locked draft at p_expected_version,
--             exactly one row; a constraint error is re-raised with a FIXED message (no description, id or amount reaches a
--             log line).
--         12. Verified as the create verifies: exactly n lines at positions 1..n whose totals sum to the header's subtotal.
--         13. ('applied', tenant, store, actor, membership, the new version): the runtime compares the four identities with
--             its trusted context and the version with its expected version + 1, and rolls back on any difference.
--     DA-36: every sealed answer ('conflict', 'invalid_state', 'unchanged') and every answer the runtime rolls back
--     ('not_found', 'refused', 'tenant_mismatch') before step 10 is reached with NOTHING written by this routine — not even
--     a role row (the role row is made to exist only in step 10). The one write any answer but 'applied' can follow is step
--     10's own lock anchor (a NULL row; its INSERT writes only when the role had no row), and step 10 can then answer
--     ('refused', NULLs) three ways: the level read on the LOCKED row is below Edit, the row is gone by the FOR SHARE re-read,
--     or the session expired while that lock waited. Each is an answer the runtime rolls back, the anchor with it.
--     WHAT DECIDES THE SEALED ANSWERS. 'conflict', 'invalid_state' and 'unchanged' rest on step 3's UNLOCKED level decision
--     (and the runtime revalidator's, before the routine): an owner's narrowing of the Invoices level that commits after
--     step 3 — while the edit waits on the header, say — still gets the sealed 'conflict' or 'unchanged' with NOTHING
--     written, because neither changes the draft. Only the change path (step 10) re-decides on the locked role row, so only a
--     write can be refused by a narrowing that commits after the unlocked decision.
--     LOCK ORDER (every tenant write's, then this file's): fence -> 016's hold (account FOR UPDATE; links, grants, tenants,
--     stores FOR SHARE) -> session and ledger rows -> issuer key row -> store row (FOR SHARE, already held) -> the draft
--     header (FOR UPDATE) -> the replacement customer (FOR KEY SHARE) -> [change path] the Invoices role row (FOR SHARE) ->
--     the lines. It differs from the save's (028: role rows, then the customer, then the draft). WHY IT CANNOT DEADLOCK: the
--     only lock that conflicts with the edit's role-row FOR SHARE is an owner's level edit's FOR UPDATE (026, 020/021), and
--     that edit never waits on a draft header, a customer or a line; the only lock that conflicts with the customer FOR KEY
--     SHARE is a customer edit's FOR UPDATE (024), which never touches a draft; the save never waits on an existing draft's
--     header (it inserts a new one); two edits of one draft serialize on the header, each having taken nothing a header
--     holder waits for; and everything before the header is the established order every tenant write takes. No cycle. Note:
--     016's hold takes the actor's account FOR UPDATE, so two edits by ONE actor serialize there, before the header.
--     A status change of the store, a grant's suspension or an owner's narrowing of the role's Invoices level that commits
--     FIRST refuses the edit (the narrowing through step 10's locked re-decision); one attempted while the edit holds these
--     locks waits for its COMMIT.
--   - WHAT IT DOES NOT DO. It writes no audit record, outbox event or idempotency completion: the runtime's command
--     transaction appends the edit's audit record (scope 'store', action store.invoice_draft.update, the draft as its
--     subject_invoice_draft_id), its outbox event (invoice_draft.updated, identifiers and a count only) and its completion
--     around it in one transaction, and only for 'applied'. No message, hint or detail it raises carries a description, an
--     id or an amount. The draft names its customer by id only.
--   - WHAT THIS DOES NOT DEFEND (doc 08; none of it is claimed closed). 028's residuals stand for this routine, and:
--       * a holder of tmpos_app plus a live minted key whose store grant meets Invoices Edit calls m7b_invoice_draft_update
--         directly and edits drafts at that store with NO audit, idempotency or outbox record — edits are audited ONLY through
--         the HTTP route (G-AUDIT exception, as 028's create);
--       * LOCK HOLDING (DA-120's class): such a holder keeps the draft header FOR UPDATE, the customer FOR KEY SHARE and the
--         role row FOR SHARE for as long as it keeps its transaction open — availability only;
--       * a role at Invoices Edit without Customers View learns whether a guessed customer uuid is in the store's tenant
--         only through a current-version edit that, when it succeeds, changes the draft and is audited (D1's residual);
--       * the TABLE OWNER can still write either table directly, within the trigger's and the CHECKs' bounds;
--       * a database log that captures bind parameters exposes session keys and line descriptions (G-DBROLE, G-PRIVACY).
--   - APPLY: A MAINTENANCE WINDOW. Before any check and before any change — its first statements after the search path, with
--     nothing read before them, not even the catalog — the file takes ACCESS EXCLUSIVE until COMMIT on every table of 028's
--     rollback order, the order the runtime's writers take them (R7): public.store, tmpos_role.tenant_role_level,
--     tmpos_role_edit.role_level_version, tmpos_customer.customer, tmpos_invoice_draft.invoice_draft,
--     tmpos_invoice_draft.invoice_draft_line, public.audit_event — in one block whose handler turns a missing table or schema
--     into this file's refusal (55000), the block's locks released first. So every draft save and read, level edit, store,
--     customer and audit write, and every earlier file's rollback that locks any of the seven either committed before this
--     file read anything or waits for its COMMIT. THE COST: every read and write of those seven tables waits until COMMIT —
--     in effect every tenant request; replacing the CHECK re-validates it over every draft row (validated, never NOT VALID)
--     and creating the trigger takes the header table's lock anyway; no row is rewritten and no index is built. Acceptable
--     while drafts are synthetic and few; on a large table the window grows with the row count.
--   - DEPLOY AND ROLLBACK: FORWARD-ONLY IN EFFECT, FAIL CLOSED. It and the runtime that requires 001-029 move together: the
--     runtime's startup preflight pins the exact ledger and the exact grants, so the 001-028 runtime refuses a 029 database
--     (its approved grants lack the new EXECUTE) and this runtime refuses a 028 one. The rollback REFUSES while any draft's
--     version is above 1 (an edited draft: restoring CHECK (version = 1) would need a reset, which a rollback never does);
--     retained edit audit records and invoice_draft.updated outbox rows do not block it (its own header gives the reason).
--   - NO SECRET, NO DYNAMIC SQL, NO EXTENSION, NO TEMPORARY OBJECT. Every statement is fixed text, every value a parameter,
--     every relation and routine schema-qualified; the routine pins its search_path to pg_catalog then pg_temp and runs with
--     row_security off; the trigger function pins its search_path. There is no backfill.
--
-- Reversible via 029_m7b_invoice_draft_edit.down.sql, which refuses while any draft's version is above 1, and otherwise
-- removes exactly what this file created and restores 028's CHECK and comment. Roll 029 back before 028.
--
-- Assumes 001-028 are applied. A future managed apply targets the complete contiguous chain through the newest committed
-- migration — now 001-029 (owner decision D4); this file authorizes no apply.

-- =============================================================================
-- 1) This transaction's search path
-- =============================================================================
set local search_path = pg_catalog, pg_temp;

-- =============================================================================
-- 2) The locks, in the writers' order: the first statements after the search path, before any check or any change
-- =============================================================================
-- 028's rollback order (R7). Nothing is read or checked before them, not even the catalog. A LOCK naming a table or schema
-- that is missing raises undefined_table (42P01) or invalid_schema_name (3F000); the block's handler turns either into this
-- file's refusal (55000). The block runs as a subtransaction: once it completes, this transaction keeps its locks until
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
    raise exception 'migration 029 refused: public.store, tmpos_role.tenant_role_level, tmpos_role_edit.role_level_version, tmpos_customer.customer, tmpos_invoice_draft.invoice_draft, tmpos_invoice_draft.invoice_draft_line or public.audit_event is missing (migrations 002, 017, 020, 021 and 028 must be applied first)'
      using errcode = 'object_not_in_prerequisite_state';
end
$$;

-- =============================================================================
-- 3) Preconditions: what this file builds on
-- =============================================================================
do $$
begin
  -- Nothing of this file exists yet: it is applied once, over a chain that has never held it.
  if exists (select 1 from pg_catalog.pg_proc p
              where p.pronamespace = 'tmpos_invoice_draft'::regnamespace
                and p.proname in ('m7b_invoice_draft_update', 'm7b_invoice_draft_immutable'))
     or exists (select 1 from pg_catalog.pg_trigger g
                 where g.tgrelid in ('tmpos_invoice_draft.invoice_draft'::regclass, 'tmpos_invoice_draft.invoice_draft_line'::regclass)
                   and not g.tgisinternal) then
    raise exception 'migration 029 refused: the edit routine, the trigger function or a trigger on the draft tables already exists'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- The chain is contiguous: 028 is the newest migration this file sits on, with exactly its version contract.
  if pg_catalog.to_regprocedure('tmpos_invoice_draft.m7b_invoice_draft_create(text, uuid, uuid, uuid, uuid, jsonb, bigint)') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_draft.m7b_invoice_draft_page(text, uuid, uuid, uuid, integer)') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_draft.m7b_invoice_draft_get(text, uuid, uuid, uuid)') is null
     or not exists (select 1 from pg_catalog.pg_attribute a
                     where a.attrelid = 'public.audit_event'::regclass and a.attname = 'subject_invoice_draft_id' and not a.attisdropped)
     or (select pg_catalog.count(*) from pg_catalog.pg_constraint k
          where k.conrelid = 'tmpos_invoice_draft.invoice_draft'::regclass and k.conname = 'invoice_draft_version_chk'
            and k.contype = 'c' and k.convalidated and pg_catalog.pg_get_constraintdef(k.oid) = 'CHECK ((version = 1))') <> 1 then
    raise exception 'migration 029 refused: migration 028 must be applied first (its three routines, its audit subject and its CHECK (version = 1))'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- The objects the routine restates, reads or locks.
  if pg_catalog.to_regprocedure('tmpos_session.m5_hold_tenant_standing(text, text)') is null
     or pg_catalog.to_regprocedure('tmpos_session.m5_admit_tenant_session_v2(text, text)') is null
     or pg_catalog.to_regclass('tmpos_session.session') is null
     or pg_catalog.to_regclass('tmpos_mint.tenant_session') is null
     or pg_catalog.to_regclass('tmpos_mint.issuer_key') is null
     or pg_catalog.to_regclass('public.tenant') is null
     or pg_catalog.to_regclass('public.user_membership') is null then
    raise exception 'migration 029 refused: 016''s hold or admission read, 018''s mint ledger or issuer key, or 002''s tenant or membership table is missing'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- The runtime roles this file grants to and revokes from.
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'tmpos_app')
     or not exists (select 1 from pg_catalog.pg_roles where rolname = 'tmpos_audit_writer') then
    raise exception 'migration 029 refused: migration 005 must be applied first'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- The routine calls 016's hold and admission read as its owner, the principal applying this file.
  if not (pg_catalog.has_function_privilege(current_user, 'tmpos_session.m5_hold_tenant_standing(text, text)', 'EXECUTE')
          and pg_catalog.has_function_privilege(current_user, 'tmpos_session.m5_admit_tenant_session_v2(text, text)', 'EXECUTE')
          and pg_catalog.has_schema_privilege(current_user, 'tmpos_session', 'USAGE')
          and pg_catalog.has_schema_privilege(current_user, 'tmpos_mint', 'USAGE')
          and pg_catalog.has_schema_privilege(current_user, 'tmpos_role', 'USAGE')
          and pg_catalog.has_schema_privilege(current_user, 'tmpos_customer', 'USAGE')
          and pg_catalog.has_schema_privilege(current_user, 'tmpos_invoice_draft', 'CREATE')) then
    raise exception 'migration 029 refused: the applying principal cannot execute 016''s hold and admission read, which the routine calls, use the schemas it reads, or create in schema tmpos_invoice_draft'
      using errcode = 'insufficient_privilege';
  end if;
  -- Altering the header table and a SECURITY DEFINER routine that writes the draft tables need their owner's privileges
  -- (017's argument): were the applying principal neither the owner nor a role inheriting the owner of every table the
  -- routine reads or writes — or row security FORCEd on one — the alter would fail, or the routine would find no session
  -- and refuse everything, or fail on a write.
  if exists (
    select 1
      from pg_catalog.pg_class c
     where c.oid = any (array['tmpos_session.session'::regclass, 'tmpos_mint.tenant_session'::regclass,
                              'tmpos_mint.issuer_key'::regclass, 'tmpos_role.tenant_role_level'::regclass,
                              'tmpos_customer.customer'::regclass, 'public.store'::regclass, 'public.tenant'::regclass,
                              'public.user_membership'::regclass, 'public.audit_event'::regclass,
                              'tmpos_invoice_draft.invoice_draft'::regclass, 'tmpos_invoice_draft.invoice_draft_line'::regclass])
       and (not pg_catalog.pg_has_role(current_user, c.relowner, 'USAGE') or c.relforcerowsecurity)) then
    raise exception 'migration 029 refused: the applying principal neither owns nor inherits the owner of a table the edit routine reads or writes, or one has forced row security'
      using errcode = 'insufficient_privilege';
  end if;
end
$$;

-- =============================================================================
-- 4) The version: 1 to 9007199254740991, under the same constraint name
-- =============================================================================
-- One statement: the old CHECK dropped and the new one added, validated over every existing row (028 left them all at 1).
alter table tmpos_invoice_draft.invoice_draft
  drop constraint invoice_draft_version_chk,
  add constraint invoice_draft_version_chk check (version between 1 and 9007199254740991);

-- 028's two table comments said the create alone writes them and the version is 1; both stop being true here.
comment on table tmpos_invoice_draft.invoice_draft is
  'Phase 4.0 M7b (migration 028; edit, migration 029): one saved invoice draft of a store (status draft, USD, version 1 when saved, moved by exactly one per edit), naming a customer of the store''s tenant by id. Written only by m7b_invoice_draft_create and m7b_invoice_draft_update; read by its page and get routines and, locked FOR UPDATE, by m7b_invoice_draft_update; trg_invoice_draft_immutable keeps its id, tenant, store, creation time and creator fixed. No runtime role holds a privilege on it.';
comment on table tmpos_invoice_draft.invoice_draft_line is
  'Phase 4.0 M7b (migration 028; edit, migration 029): one ordered plain-text line of an invoice draft, in exactly its header''s tenant and store (composite foreign key). Its total is quantity x unit price in numeric. Written only by m7b_invoice_draft_create and m7b_invoice_draft_update (which replaces a draft''s lines whole). No runtime role holds a privilege on it.';

-- =============================================================================
-- 5) The trigger (D8): a draft's identity, scope, creation time and creator never change; its version moves by at most one
-- =============================================================================
-- SECURITY INVOKER and granted to nobody: a trigger function fires without an EXECUTE grant, and it reads no relation, so it
-- needs no privilege of its own (008's form). A firing this file does not declare raises rather than guessing (021's rule).
create function tmpos_invoice_draft.m7b_invoice_draft_immutable()
returns trigger
language plpgsql
volatile
security invoker
set search_path = pg_catalog, pg_temp
as $$
begin
  if tg_when is distinct from 'BEFORE' or tg_level is distinct from 'ROW' or tg_op is distinct from 'UPDATE'
     or tg_table_schema is distinct from 'tmpos_invoice_draft' or tg_table_name is distinct from 'invoice_draft' then
    raise exception 'm7b_invoice_draft_immutable: fired by an undeclared trigger'
      using errcode = 'triggered_action_exception';
  end if;
  if new.draft_id is distinct from old.draft_id
     or new.tenant_id is distinct from old.tenant_id
     or new.store_id is distinct from old.store_id
     or new.created_at is distinct from old.created_at
     or new.created_by is distinct from old.created_by then
    raise exception 'migration 029: an invoice draft''s id, tenant, store, creation time and creator never change'
      using errcode = 'restrict_violation';
  end if;
  if new.version is distinct from old.version and new.version is distinct from old.version + 1 then
    raise exception 'migration 029: an invoice draft''s version stays or advances by exactly one'
      using errcode = 'restrict_violation';
  end if;
  return new;
end
$$;

comment on function tmpos_invoice_draft.m7b_invoice_draft_immutable() is
  'Phase 4.0 M7b (migration 029): BEFORE UPDATE row trigger on tmpos_invoice_draft.invoice_draft (enabled ALWAYS). Raises restrict_violation (fixed message) when an update by any path changes draft_id, tenant_id, store_id, created_at or created_by, or sets version to anything but its old value or old value + 1; triggered_action_exception for any other firing. Reads no relation. Granted to nobody.';

create trigger trg_invoice_draft_immutable
  before update on tmpos_invoice_draft.invoice_draft
  for each row execute function tmpos_invoice_draft.m7b_invoice_draft_immutable();

-- ALWAYS, as 008's, 013's and 021's are: an update by a session running as a replica meets it too.
alter table tmpos_invoice_draft.invoice_draft enable always trigger trg_invoice_draft_immutable;

-- =============================================================================
-- 6) The routine
-- =============================================================================
create function tmpos_invoice_draft.m7b_invoice_draft_update(
  p_session_key text, p_store_id uuid, p_draft_id uuid, p_expected_tenant uuid, p_expected_version bigint,
  p_customer_id uuid, p_lines jsonb, p_subtotal_cents bigint)
returns table (
  o_outcome       text,
  o_tenant_id     uuid,
  o_store_id      uuid,
  o_actor_id      uuid,
  o_membership_id uuid,
  o_version       bigint
)
language plpgsql
-- VOLATILE IS LOAD-BEARING (019's, 020's, 024's and 028's reason): it locks and then re-reads, and each statement must see
-- what committed before its own locks. Do not make it STABLE.
volatile
security definer
set search_path = pg_catalog, pg_temp
set row_security = off
as $$
declare
  -- The tenant ordering (permissionCatalog.ts TENANT_ORDERING), 020's constant, pinned by the parity test.
  c_levels         constant text[] := array['none', 'view', 'create', 'edit', 'manage', 'approve', 'full'];
  -- The largest integer a JavaScript number holds exactly: every amount's bound and the version's.
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
  v_header         record;
  v_written        bigint;
  v_updated        integer;
  v_check          record;
begin
  -- 0. Every argument, before anything is read, locked or written. A refusal names the field, never the value.
  if p_session_key is null or p_session_key !~ '^[\x21-\x7e]{1,128}$'
     or p_store_id is null
     or p_draft_id is null
     or p_expected_tenant is null
     or p_customer_id is null then
    raise exception 'migration 029 update: an argument is malformed'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_expected_version is null or p_expected_version < 1 or p_expected_version > 9007199254740990 then
    raise exception 'migration 029 update: the expected version is not one the draft table can advance'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_subtotal_cents is null or p_subtotal_cents < 0 or p_subtotal_cents > c_max then
    raise exception 'migration 029 update: the subtotal is not a whole number from 0 to 9007199254740991'
      using errcode = 'invalid_parameter_value';
  end if;
  -- The lines: 028's create step 0, restated (028 is frozen).
  if p_lines is null or pg_catalog.jsonb_typeof(p_lines) is distinct from 'array' then
    raise exception 'migration 029 update: the lines are not an array'
      using errcode = 'invalid_parameter_value';
  end if;
  v_count := pg_catalog.jsonb_array_length(p_lines);
  if v_count < 1 or v_count > 50 then
    raise exception 'migration 029 update: there are not 1 to 50 lines'
      using errcode = 'invalid_parameter_value';
  end if;
  for v_line in select e.entry from pg_catalog.jsonb_array_elements(p_lines) as e(entry) loop
    if pg_catalog.jsonb_typeof(v_line.entry) is distinct from 'object'
       or (select pg_catalog.array_agg(k.key order by k.key collate "C") from pg_catalog.jsonb_object_keys(v_line.entry) as k(key))
          is distinct from array['description', 'quantity', 'unitPriceCents']::text[] then
      raise exception 'migration 029 update: a line is not exactly a description, a quantity and a unit price'
        using errcode = 'invalid_parameter_value';
    end if;
    if pg_catalog.jsonb_typeof(v_line.entry -> 'description') is distinct from 'string'
       or pg_catalog.jsonb_typeof(v_line.entry -> 'quantity') is distinct from 'number'
       or pg_catalog.jsonb_typeof(v_line.entry -> 'unitPriceCents') is distinct from 'number' then
      raise exception 'migration 029 update: a line field has the wrong type'
        using errcode = 'invalid_parameter_value';
    end if;
    -- The description: one the line table's CHECK admits (restated, so the insert below cannot refuse it).
    v_text := v_line.entry ->> 'description';
    if not (
         pg_catalog.char_length(v_text) between 1 and 256
         and v_text !~ '[\u0001-\u001f\u007f-\u009f\u2028\u2029]'
         and v_text !~ '[\u061c\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069]'
         and v_text !~ '^[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]|[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]$') then
      raise exception 'migration 029 update: a line description is not one the line table admits'
        using errcode = 'invalid_parameter_value';
    end if;
    v_quantity := v_line.entry ->> 'quantity';
    if v_quantity !~ '^[1-9][0-9]{0,15}$' or v_quantity::numeric > c_max then
      raise exception 'migration 029 update: a line quantity is not a whole number from 1 to 9007199254740991'
        using errcode = 'invalid_parameter_value';
    end if;
    v_price := v_line.entry ->> 'unitPriceCents';
    if v_price !~ '^(0|[1-9][0-9]{0,15})$' or v_price::numeric > c_max then
      raise exception 'migration 029 update: a line unit price is not a whole number of cents from 0 to 9007199254740991'
        using errcode = 'invalid_parameter_value';
    end if;
    v_total := v_quantity::numeric * v_price::numeric;
    if v_total > c_max then
      raise exception 'migration 029 update: a line total is above 9007199254740991'
        using errcode = 'invalid_parameter_value';
    end if;
    v_sum := v_sum + v_total;
    if v_sum > c_max then
      raise exception 'migration 029 update: the lines'' sum is above 9007199254740991'
        using errcode = 'invalid_parameter_value';
    end if;
  end loop;
  if v_sum <> p_subtotal_cents::numeric then
    raise exception 'migration 029 update: the subtotal is not the sum of the line totals'
      using errcode = 'invalid_parameter_value';
  end if;
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'migration 029 update: it must run under READ COMMITTED, so that its checks see what committed before its locks'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- 1. The caller, derived exactly as 028's create derives it (028 up, steps 1-6; 024 and 019 give each step's reason): the
  --    unlocked live/issuer pre-check, 016's hold, the session and ledger rows FOR SHARE, the issuer key FOR SHARE, the clock
  --    after those waits, the standing digest the session was minted under, a write account status.
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

  -- 3. The role's Invoices level, UNLOCKED, at Edit or above. store_owner is Full (never stored); an editable role is its
  --    stored level, else its catalog default; any other role refuses. Nothing is written or locked by a refusal here.
  if v_role = 'store_owner' then
    null;
  elsif v_role in ('manager', 'technician', 'sales_staff') then
    select l.level into v_invoices
      from tmpos_role.tenant_role_level l
     where l.tenant_id = v_tenant and l.role_id = v_role and l.domain = 'invoices';
    if coalesce(pg_catalog.array_position(c_levels,
         coalesce(v_invoices, case v_role when 'manager' then 'full' when 'technician' then 'view' when 'sales_staff' then 'create' end)), 0)
       < pg_catalog.array_position(c_levels, 'edit') then
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
  --    version: see the header). A missing id, another store's and another tenant's take this same statement and answer.
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
  -- Live, on the database clock read again now: the header lock may have waited (another edit of this draft).
  v_now := pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp()) * 1000)::bigint;
  if v_now >= v_session.expires_at then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint;
    return;
  end if;

  -- 6. Only a draft is editable (028's CHECK pins every row to 'draft' today).
  if v_header.status is distinct from 'draft' then
    return query select 'invalid_state'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint;
    return;
  end if;

  -- 7. The version, before the values: a stale editor conflicts even when what it sends equals what is stored.
  if v_header.version is distinct from p_expected_version then
    return query select 'conflict'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint;
    return;
  end if;

  -- 8. The replacement customer, held FOR KEY SHARE in the derived tenant until COMMIT (the foreign key's own lock, taken
  --    first): a missing id and another tenant's are the draft's answer.
  perform 1
     from tmpos_customer.customer c
    where c.customer_id = p_customer_id
      and c.tenant_id = v_tenant
      for key share;
  if not found then
    return query select 'not_found'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint;
    return;
  end if;
  v_now := pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp()) * 1000)::bigint;
  if v_now >= v_session.expires_at then
    return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint;
    return;
  end if;

  -- 9. The no-op: the same customer and, position by position, the same lines — as many stored as sent, and every sent line
  --    equal to the stored line at its position (positions are the line table's key, so that is the whole stored list).
  --    Nothing is written; the deciding locks stay held until the runtime's completion commits.
  if v_header.customer_id = p_customer_id
     and (select pg_catalog.count(*) from tmpos_invoice_draft.invoice_draft_line l
           where l.draft_id = p_draft_id and l.tenant_id = v_tenant and l.store_id = p_store_id) = v_count
     and not exists (
       select 1
         from pg_catalog.jsonb_array_elements(p_lines) with ordinality as e(entry, ordinality)
         left join tmpos_invoice_draft.invoice_draft_line l
           on l.draft_id = p_draft_id and l.tenant_id = v_tenant and l.store_id = p_store_id
          and l.position = e.ordinality::integer
        where l.position is null
           or l.description is distinct from (e.entry ->> 'description')
           or l.quantity is distinct from (e.entry ->> 'quantity')::bigint
           or l.unit_price_cents is distinct from (e.entry ->> 'unitPriceCents')::bigint) then
    return query select 'unchanged'::text, v_tenant, p_store_id, v_admission.actor_id, v_membership, v_header.version;
    return;
  end if;

  -- 10. The change path only: the role's Invoices row made to exist (NULL: the default) and held FOR SHARE until COMMIT, then
  --     decided again on the locked value. An owner's level edit holding the row FOR UPDATE is waited for and its committed
  --     level is what is read; one attempted later waits for this transaction. A row gone by now refuses.
  if v_role in ('manager', 'technician', 'sales_staff') then
    insert into tmpos_role.tenant_role_level (tenant_id, role_id, domain, level, updated_at)
    values (v_tenant, v_role, 'invoices', null, pg_catalog.now())
    on conflict (tenant_id, role_id, domain) do nothing;
    select l.level into v_invoices
      from tmpos_role.tenant_role_level l
     where l.tenant_id = v_tenant and l.role_id = v_role and l.domain = 'invoices'
       for share;
    if not found then
      return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint;
      return;
    end if;
    if coalesce(pg_catalog.array_position(c_levels,
         coalesce(v_invoices, case v_role when 'manager' then 'full' when 'technician' then 'view' when 'sales_staff' then 'create' end)), 0)
       < pg_catalog.array_position(c_levels, 'edit') then
      return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint;
      return;
    end if;
    v_now := pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp()) * 1000)::bigint;
    if v_now >= v_session.expires_at then
      return query select 'refused'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::bigint;
      return;
    end if;
  end if;

  -- 11. The edit: the lines replaced, then the header, on exactly the locked draft. draft_id, the tenant, the store, status,
  --     currency, created_at and created_by are never written. The CHECKs restate step 0, so they cannot refuse; were any
  --     constraint ever to, the raise is fixed text, never the row.
  begin
    delete from tmpos_invoice_draft.invoice_draft_line l
     where l.draft_id = p_draft_id and l.tenant_id = v_tenant and l.store_id = p_store_id;
    insert into tmpos_invoice_draft.invoice_draft_line
      (draft_id, tenant_id, store_id, position, description, quantity, unit_price_cents, line_total_cents)
    select p_draft_id, v_tenant, p_store_id, e.ordinality::integer, e.entry ->> 'description',
           (e.entry ->> 'quantity')::bigint, (e.entry ->> 'unitPriceCents')::bigint,
           ((e.entry ->> 'quantity')::numeric * (e.entry ->> 'unitPriceCents')::numeric)::bigint
      from pg_catalog.jsonb_array_elements(p_lines) with ordinality as e(entry, ordinality);
  exception
    when unique_violation or check_violation or foreign_key_violation or not_null_violation or numeric_value_out_of_range then
      raise exception 'migration 029 update: a line is not one the line table admits'
        using errcode = 'integrity_constraint_violation';
  end;
  begin
    update tmpos_invoice_draft.invoice_draft d
       set customer_id = p_customer_id, line_count = v_count, subtotal_cents = p_subtotal_cents, version = d.version + 1
     where d.draft_id = p_draft_id
       and d.tenant_id = v_tenant
       and d.store_id = p_store_id
       and d.version = p_expected_version
    returning d.version into v_written;
    get diagnostics v_updated = row_count;
  exception
    when check_violation or foreign_key_violation or not_null_violation then
      raise exception 'migration 029 update: the draft is not one the draft table admits'
        using errcode = 'integrity_constraint_violation';
  end;
  if v_updated <> 1 or v_written is distinct from p_expected_version + 1 then
    raise exception 'migration 029 update: the edit was not written to exactly the locked draft at the next version'
      using errcode = 'no_data_found';
  end if;

  -- 12. Exactly the lines step 0 judged: n rows at positions 1..n whose totals sum to the header's subtotal.
  select pg_catalog.count(*)::integer as n, pg_catalog.min(l.position) as lo, pg_catalog.max(l.position) as hi,
         coalesce(pg_catalog.sum(l.line_total_cents::numeric), -1) as total
    into v_check
    from tmpos_invoice_draft.invoice_draft_line l
   where l.draft_id = p_draft_id and l.tenant_id = v_tenant and l.store_id = p_store_id;
  if v_check.n is distinct from v_count or v_check.lo is distinct from 1 or v_check.hi is distinct from v_count
     or v_check.total is distinct from p_subtotal_cents::numeric then
    raise exception 'migration 029 update: the lines written are not exactly the lines judged'
      using errcode = 'no_data_found';
  end if;

  return query select 'applied'::text, v_tenant, p_store_id, v_admission.actor_id, v_membership, v_written;
end
$$;

comment on function tmpos_invoice_draft.m7b_invoice_draft_update(text, uuid, uuid, uuid, bigint, uuid, jsonb, bigint) is
  'Phase 4.0 M7b (migration 029): replaces one saved invoice draft''s customer and its 1-50 ordered lines at an expected version, at a store, for a key naming a ledger-minted, live (database clock, read after every lock wait) tenant session minted under the installed issuer key, after 016''s hold and the session, ledger and issuer key rows, whose standing digest is unchanged, whose account status is active or trialing, who holds EXACTLY ONE active store-scope grant at p_store_id (a selector only) on an active or trialing tenant and store — the store row re-read FOR SHARE in that grant''s tenant — and whose role''s Invoices level is Edit or above (store_owner full; manager, technician, sales_staff the owner''s stored level, else the catalog default; read unlocked, and on the change path again FOR SHARE). Judges every argument first (invalid_parameter_value, a fixed message naming the field, never the value; the expected version 1 to 9007199254740990). Answers one row: (''refused'', NULLs) for any authority refusal; (''tenant_mismatch'', NULLs) when the grant''s tenant is not p_expected_tenant; then, the draft locked FOR UPDATE: (''not_found'', NULLs) alike for a missing, another store''s and another tenant''s draft and for a missing or another tenant''s customer; (''invalid_state'', NULLs) for a status other than draft; (''conflict'', NULLs) for any other version; (''unchanged'', tenant, store, actor, membership, version) when the customer and the ordered lines equal the stored ones — all of these with nothing written; on the change path the role''s Invoices row is made to exist (a NULL lock anchor, only when the role has none) and held FOR SHARE, and a refusal there (''refused'', NULLs: the locked level below Edit, the row gone, or the session expired while that lock waited) can follow that anchor''s INSERT, an answer the runtime rolls back with it; else replaces the lines, writes the customer, line count, subtotal and version + 1 and answers (''applied'', tenant, store, actor, membership, new version). Never writes the id, tenant, store, status, currency, created_at or created_by. Writes no audit record.';

-- =============================================================================
-- 7) The audit subject's comment: it now names an edited draft too
-- =============================================================================
comment on column public.audit_event.subject_invoice_draft_id is
  'Phase 4.0 M7b (migration 028; edit, migration 029): the invoice draft the recorded action created or edited (a store-scope draft create or edit). Written by the command transaction from the command''s aggregate id (server-generated for a create; the path''s draft id, bound through the trusted store, for an edit); never from request metadata. Plain column, no FK (audit is decoupled/append-only). Never accompanied by a description, an amount or a customer''s details.';

-- =============================================================================
-- 8) Privileges, and the proof that nothing wider was issued
-- =============================================================================
-- PostgreSQL grants EXECUTE on a new function to PUBLIC by default, so every default is removed explicitly before the one
-- intended grant is issued. The trigger function is granted to nobody. No table, column or schema grant.
revoke all on function tmpos_invoice_draft.m7b_invoice_draft_update(text, uuid, uuid, uuid, bigint, uuid, jsonb, bigint) from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
revoke all on function tmpos_invoice_draft.m7b_invoice_draft_immutable() from public, anon, authenticated, tmpos_app, tmpos_audit_writer;

grant execute on function tmpos_invoice_draft.m7b_invoice_draft_update(text, uuid, uuid, uuid, bigint, uuid, jsonb, bigint) to tmpos_app;

-- =============================================================================
-- 9) Postcondition
-- =============================================================================
-- Proven rather than asserted, in 028's form. This file refuses to finish unless, now:
--   (a) invoice_draft_version_chk is the one validated CHECK (version between 1 and 9007199254740991) of that name;
--   (b) trg_invoice_draft_immutable is the only non-internal trigger on either draft table: BEFORE UPDATE FOR EACH ROW
--       (tgtype 19), ENABLE ALWAYS, no column list, no WHEN, calling the trigger function, which is plpgsql, SECURITY
--       INVOKER, VOLATILE, pinned to pg_catalog, pg_temp, owned by the applying principal;
--   (c) the edit routine is plpgsql, SECURITY DEFINER, VOLATILE, pinned to pg_catalog, pg_temp with row_security off, owned by
--       the applying principal, and the schema holds exactly 028's three routines, it and the trigger function;
--   (d) the edit routine carries no grant beyond its owner's and a non-grantable EXECUTE to tmpos_app, and the trigger
--       function none beyond its owner's; tmpos_app CAN execute the routine; tmpos_audit_writer, anon and authenticated
--       cannot execute it, and no runtime role can execute the trigger function, by any path;
--   (e) neither draft table carries a grant beyond its owner's, on it or a column, and no runtime role holds any privilege on
--       either by any path; and none of them is a MEMBER of the owner of either new function;
--   (f) the two draft tables' comments are the ones section 4 wrote, and the audit subject's the one section 7 wrote.
-- Each ACL is read through coalesce(acl, acldefault(kind, owner)), and a role reachable through a membership is followed
-- whatever the membership's options (019's reasons). WHAT THIS DOES NOT PROVE: it is a snapshot at apply time; the runtime
-- LOGIN's grants are enforced at every start by the startup preflight (server/persistence/postgresStartupPreflight.ts).
do $$
declare
  v_bad text;
  v_me  oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user);
begin
  -- (a)
  if (select pg_catalog.count(*) from pg_catalog.pg_constraint k
       where k.conrelid = 'tmpos_invoice_draft.invoice_draft'::regclass and k.conname = 'invoice_draft_version_chk') <> 1
     or not exists (select 1 from pg_catalog.pg_constraint k
                     where k.conrelid = 'tmpos_invoice_draft.invoice_draft'::regclass and k.conname = 'invoice_draft_version_chk'
                       and k.contype = 'c' and k.convalidated
                       and pg_catalog.pg_get_constraintdef(k.oid) = 'CHECK (((version >= 1) AND (version <= ''9007199254740991''::bigint)))') then
    raise exception 'migration 029 refused: invoice_draft_version_chk is not the validated CHECK (version between 1 and 9007199254740991) section 4 declares'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (b)
  if (select pg_catalog.count(*) from pg_catalog.pg_trigger g
       where g.tgrelid in ('tmpos_invoice_draft.invoice_draft'::regclass, 'tmpos_invoice_draft.invoice_draft_line'::regclass)
         and not g.tgisinternal) <> 1
     or (select pg_catalog.count(*) from pg_catalog.pg_trigger g
          where g.tgfoid = 'tmpos_invoice_draft.m7b_invoice_draft_immutable()'::regprocedure) <> 1
     or not exists (select 1 from pg_catalog.pg_trigger g
                     where g.tgrelid = 'tmpos_invoice_draft.invoice_draft'::regclass
                       and g.tgname = 'trg_invoice_draft_immutable'
                       and g.tgfoid = 'tmpos_invoice_draft.m7b_invoice_draft_immutable()'::regprocedure
                       -- tgtype bits: ROW (1), BEFORE (2), UPDATE (16) — and no INSERT (4), DELETE (8) or TRUNCATE (32).
                       and g.tgtype = 19
                       and g.tgenabled = 'A'
                       and g.tgattr = ''::pg_catalog.int2vector
                       and g.tgqual is null
                       and not g.tgisinternal)
     or not exists (select 1 from pg_catalog.pg_proc p join pg_catalog.pg_language l on l.oid = p.prolang
                     where p.oid = 'tmpos_invoice_draft.m7b_invoice_draft_immutable()'::regprocedure
                       and l.lanname = 'plpgsql' and not p.prosecdef and p.provolatile = 'v'
                       and p.proconfig = array['search_path=pg_catalog, pg_temp'] and p.proowner = v_me) then
    raise exception 'migration 029 refused: the draft tables do not carry exactly the one ENABLE ALWAYS BEFORE UPDATE row trigger section 5 declares, or its function is not the plpgsql SECURITY INVOKER function it declares'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (c)
  if not exists (select 1 from pg_catalog.pg_proc p join pg_catalog.pg_language l on l.oid = p.prolang
                  where p.oid = pg_catalog.to_regprocedure('tmpos_invoice_draft.m7b_invoice_draft_update(text, uuid, uuid, uuid, bigint, uuid, jsonb, bigint)')
                    and l.lanname = 'plpgsql' and p.prosecdef and p.provolatile = 'v'
                    and p.proconfig = array['search_path=pg_catalog, pg_temp', 'row_security=off'] and p.proowner = v_me)
     or (select pg_catalog.string_agg(p.oid::regprocedure::text, ', ' order by p.oid::regprocedure::text)
           from pg_catalog.pg_proc p where p.pronamespace = 'tmpos_invoice_draft'::regnamespace)
        is distinct from
        'tmpos_invoice_draft.m7b_invoice_draft_create(text,uuid,uuid,uuid,uuid,jsonb,bigint), tmpos_invoice_draft.m7b_invoice_draft_get(text,uuid,uuid,uuid), tmpos_invoice_draft.m7b_invoice_draft_immutable(), tmpos_invoice_draft.m7b_invoice_draft_page(text,uuid,uuid,uuid,integer), tmpos_invoice_draft.m7b_invoice_draft_update(text,uuid,uuid,uuid,bigint,uuid,jsonb,bigint)' then
    raise exception 'migration 029 refused: the edit routine is not the plpgsql SECURITY DEFINER VOLATILE routine pinned to pg_catalog, pg_temp with row_security off section 6 declares, or schema tmpos_invoice_draft does not hold exactly 028''s three routines, it and the trigger function'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (d)
  select pg_catalog.string_agg(pg_catalog.format('%s %s:%s', p.proname, g.grantee::regrole::text, g.privilege_type), ', ')
    into v_bad
    from pg_catalog.pg_proc p,
         pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g
   where p.oid in ('tmpos_invoice_draft.m7b_invoice_draft_update(text, uuid, uuid, uuid, bigint, uuid, jsonb, bigint)'::regprocedure,
                   'tmpos_invoice_draft.m7b_invoice_draft_immutable()'::regprocedure)
     and g.grantee <> p.proowner
     and not (p.proname = 'm7b_invoice_draft_update' and g.grantee = 'tmpos_app'::regrole and g.privilege_type = 'EXECUTE'
              and not g.is_grantable);
  if v_bad is not null then
    raise exception 'migration 029 refused: an unexpected direct grant remains on the edit routine or the trigger function (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if not pg_catalog.has_function_privilege('tmpos_app',
           'tmpos_invoice_draft.m7b_invoice_draft_update(text, uuid, uuid, uuid, bigint, uuid, jsonb, bigint)'::regprocedure, 'EXECUTE') then
    raise exception 'migration 029 refused: tmpos_app does not hold EXECUTE on the edit routine'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  select pg_catalog.string_agg(distinct r.rolname::text || ' ' || p.proname::text, ', ') into v_bad
    from pg_catalog.pg_roles r
    join pg_catalog.pg_roles x on pg_catalog.pg_has_role(r.oid, x.oid, 'MEMBER')
    cross join pg_catalog.pg_proc p
   where p.oid in ('tmpos_invoice_draft.m7b_invoice_draft_update(text, uuid, uuid, uuid, bigint, uuid, jsonb, bigint)'::regprocedure,
                   'tmpos_invoice_draft.m7b_invoice_draft_immutable()'::regprocedure)
     and (r.rolname = any (array['tmpos_audit_writer', 'anon', 'authenticated']::name[])
          or (r.rolname = 'tmpos_app' and p.proname = 'm7b_invoice_draft_immutable'))
     and pg_catalog.has_function_privilege(x.oid, p.oid, 'EXECUTE');
  if v_bad is not null then
    raise exception 'migration 029 refused: a runtime role can execute a function this file does not grant it (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (e) MAINTAIN only on a server that has it (PostgreSQL 17+), where has_table_privilege would reject it on 16.
  select pg_catalog.string_agg(pg_catalog.format('%s %s:%s', c.relname, g.grantee::regrole::text, g.privilege_type), ', ')
    into v_bad
    from pg_catalog.pg_class c,
         pg_catalog.aclexplode(coalesce(c.relacl, pg_catalog.acldefault('r', c.relowner))) g
   where c.oid in ('tmpos_invoice_draft.invoice_draft'::regclass, 'tmpos_invoice_draft.invoice_draft_line'::regclass)
     and g.grantee <> c.relowner;
  if v_bad is not null
     or exists (select 1 from pg_catalog.pg_attribute a
                 where a.attrelid in ('tmpos_invoice_draft.invoice_draft'::regclass, 'tmpos_invoice_draft.invoice_draft_line'::regclass)
                   and a.attacl is not null) then
    raise exception 'migration 029 refused: a draft table or a column of one carries a grant beyond its owner''s (%)', v_bad
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
    raise exception 'migration 029 refused: % holds a privilege on a draft table', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  select pg_catalog.string_agg(distinct r.rolname::text, ', ') into v_bad
    from pg_catalog.pg_roles r
    cross join pg_catalog.pg_proc p
   where p.oid in ('tmpos_invoice_draft.m7b_invoice_draft_update(text, uuid, uuid, uuid, bigint, uuid, jsonb, bigint)'::regprocedure,
                   'tmpos_invoice_draft.m7b_invoice_draft_immutable()'::regprocedure)
     and r.rolname = any (array['tmpos_app', 'tmpos_audit_writer', 'anon', 'authenticated']::name[])
     and pg_catalog.pg_has_role(r.oid, p.proowner, 'MEMBER');
  if v_bad is not null then
    raise exception 'migration 029 refused: % is a member of the owner of the edit routine or the trigger function', v_bad
      using errcode = 'object_not_in_prerequisite_state',
            hint = 'membership hands a role everything the owner holds, including a direct write of every draft';
  end if;

  -- (f)
  if pg_catalog.obj_description('tmpos_invoice_draft.invoice_draft'::regclass, 'pg_class') is distinct from
       'Phase 4.0 M7b (migration 028; edit, migration 029): one saved invoice draft of a store (status draft, USD, version 1 when saved, moved by exactly one per edit), naming a customer of the store''s tenant by id. Written only by m7b_invoice_draft_create and m7b_invoice_draft_update; read by its page and get routines and, locked FOR UPDATE, by m7b_invoice_draft_update; trg_invoice_draft_immutable keeps its id, tenant, store, creation time and creator fixed. No runtime role holds a privilege on it.'
     or pg_catalog.obj_description('tmpos_invoice_draft.invoice_draft_line'::regclass, 'pg_class') is distinct from
       'Phase 4.0 M7b (migration 028; edit, migration 029): one ordered plain-text line of an invoice draft, in exactly its header''s tenant and store (composite foreign key). Its total is quantity x unit price in numeric. Written only by m7b_invoice_draft_create and m7b_invoice_draft_update (which replaces a draft''s lines whole). No runtime role holds a privilege on it.' then
    raise exception 'migration 029 refused: the draft tables'' comments are not the ones section 4 wrote'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if pg_catalog.col_description('public.audit_event'::regclass,
       (select a.attnum from pg_catalog.pg_attribute a
         where a.attrelid = 'public.audit_event'::regclass and a.attname = 'subject_invoice_draft_id' and not a.attisdropped)::integer)
     is distinct from
     'Phase 4.0 M7b (migration 028; edit, migration 029): the invoice draft the recorded action created or edited (a store-scope draft create or edit). Written by the command transaction from the command''s aggregate id (server-generated for a create; the path''s draft id, bound through the trusted store, for an edit); never from request metadata. Plain column, no FK (audit is decoupled/append-only). Never accompanied by a description, an amount or a customer''s details.' then
    raise exception 'migration 029 refused: the comment on public.audit_event.subject_invoice_draft_id is not the one section 7 wrote'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$$;

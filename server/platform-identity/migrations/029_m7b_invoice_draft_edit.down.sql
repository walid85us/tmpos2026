-- Phase 4.0 M7b — editing a saved store invoice draft
-- Migration: 029_m7b_invoice_draft_edit (DOWN)
--
-- Removes exactly what the up file created — the routine tmpos_invoice_draft.m7b_invoice_draft_update with the grant that
-- rides on it, the trigger trg_invoice_draft_immutable and its function tmpos_invoice_draft.m7b_invoice_draft_immutable() —
-- and restores 028's contract exactly: invoice_draft_version_chk is CHECK (version = 1) again (validated, same name), and the
-- two draft tables' comments and public.audit_event.subject_invoice_draft_id's comment are 028's text again. Nothing else is
-- touched — not a draft, a line, a version, a role row, an audit record or an outbox row, not 028's three routines, tables,
-- schema or grants. Rolled back, the database is exactly the 001-028 one for every object this file touched, and the runtime
-- that requires 001-029 refuses to start on it.
--
-- IT REFUSES, CHANGING NOTHING:
--   * while migration 029 is not applied (the routine, the trigger, its function or the widened CHECK is missing), or a
--     table or schema an earlier migration created and this file locks is missing (002, 017, 020, 021, 028);
--   * while ANY draft's version is above 1. Such a draft has been edited: 028's contract (CHECK (version = 1), and 028's
--     runtime parsers, which accept version 1 only) cannot hold it, and restoring that CHECK would need its version reset —
--     re-applied, the up file would let an editor still holding version 1 match again and overwrite the newer change as if
--     it were current (024's reason). Resetting a version, or deleting an edited draft, is a deliberate owner decision,
--     never a rollback's side effect. This is the ONLY state that makes 028's contract unrestorable.
--
-- WHAT DOES NOT BLOCK IT: RETAINED EDIT EVIDENCE. An edit's audit record (action store.invoice_draft.update, its
-- subject_invoice_draft_id naming the draft) and its invoice_draft.updated outbox row stay, untouched, as evidence: the audit
-- table is append-only (002's trg_audit_event_reject_mutation) and this file deletes neither. They do not make 028's
-- contract unsafe — 028's routines and runtime never read the audit table or the outbox, and no publisher exists (no
-- delivery of an updated event can be expected of a 028 runtime) — so a guard on them would protect nothing. It would
-- instead refuse every later rollback below 029 on a database that once held an edit, including every CI step that rolls
-- back below 029 on the one shared CI database after an edit suite ran there (a test's teardown can at most null an audit
-- subject; it can never delete the row). 028's own rollback still refuses while an audit record names a draft (its rule).
--
-- LOCKS, BEFORE ANY CHECK. In 028's rollback order, the order the runtime's writers take these tables (016's hold reads
-- stores; a save or an edit holds role rows; an owner's level edit writes their version row; then the customer, the draft
-- and its lines; the audit record last): public.store, tmpos_role.tenant_role_level, tmpos_role_edit.role_level_version,
-- tmpos_customer.customer, tmpos_invoice_draft.invoice_draft, tmpos_invoice_draft.invoice_draft_line, public.audit_event —
-- each ACCESS EXCLUSIVE until COMMIT. They are the first statements after the settings: nothing is read or checked before
-- them, not even the catalog. A running edit therefore either committed before this file read anything — its version step
-- is then visible to the guard's statement, whose snapshot is taken after the locks (READ COMMITTED, 017's reason) — or
-- waits until this rollback commits and then finds no edit routine. They are taken in one block whose handler turns a
-- missing table or schema (undefined_table, invalid_schema_name) into this file's refusal (55000), the block's locks
-- released first. The guard runs with row_security off, so a table whose row security were FORCEd on a non-owner applier
-- makes the rollback fail instead of hiding rows from it.
--
-- ROLL 029 BACK BEFORE 028. 028's rollback cannot drop its schema while this file's routine and trigger function are in it.
--
-- The applier's search_path is never relied on: every name below is schema-qualified and SET LOCAL pins resolution to
-- pg_catalog until this transaction ends. Revoking before dropping is redundant — a dropped object keeps no ACL — but it is
-- written out so the rollback states the privilege change it makes.

set local search_path = pg_catalog, pg_temp;
set local row_security = off;

-- =============================================================================
-- 1) The locks, in the writers' order: the first statements after the settings, before any check or any change
-- =============================================================================
-- A LOCK naming a table or schema that is missing raises undefined_table (42P01) or invalid_schema_name (3F000); the
-- block's handler turns either into this file's refusal (55000). The block runs as a subtransaction: once it completes,
-- this transaction keeps its locks until COMMIT; refused, the subtransaction has released the locks it took, and the
-- refusal aborts the file.
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
    raise exception 'migration 029 rollback refused: migration 029 is not applied (schema tmpos_invoice_draft or one of its tables is missing: migration 028 is not applied either), or a table or schema an earlier migration created is missing (public.store, tmpos_role.tenant_role_level, tmpos_role_edit.role_level_version, tmpos_customer.customer or public.audit_event: migrations 002, 017, 020 and 021)'
      using errcode = 'object_not_in_prerequisite_state';
end
$$;

-- =============================================================================
-- 2) The file is applied (read under the locks)
-- =============================================================================
do $$
begin
  if pg_catalog.to_regprocedure('tmpos_invoice_draft.m7b_invoice_draft_update(text, uuid, uuid, uuid, bigint, uuid, jsonb, bigint)') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_draft.m7b_invoice_draft_immutable()') is null
     or not exists (select 1 from pg_catalog.pg_trigger g
                     where g.tgrelid = 'tmpos_invoice_draft.invoice_draft'::regclass and g.tgname = 'trg_invoice_draft_immutable')
     or not exists (select 1 from pg_catalog.pg_constraint k
                     where k.conrelid = 'tmpos_invoice_draft.invoice_draft'::regclass and k.conname = 'invoice_draft_version_chk'
                       and pg_catalog.pg_get_constraintdef(k.oid) = 'CHECK (((version >= 1) AND (version <= ''9007199254740991''::bigint)))') then
    raise exception 'migration 029 rollback refused: migration 029 is not applied (the edit routine, the trigger, its function or the widened version CHECK is missing)'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$$;

-- =============================================================================
-- 3) The guard: no edited draft's version is ever discarded or reset by a rollback
-- =============================================================================
do $$
begin
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'migration 029 rollback refused: it must run under READ COMMITTED, so that its check sees every committed draft'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if exists (select 1 from tmpos_invoice_draft.invoice_draft d where d.version > 1) then
    raise exception 'migration 029 rollback refused: an invoice draft has been edited (its version is above 1), and a rollback never resets a version or discards an edit'
      using errcode = 'object_not_in_prerequisite_state',
            hint = 'resetting a draft''s version or deleting an edited draft is an owner decision taken deliberately, not a rollback''s side effect';
  end if;
end
$$;

-- =============================================================================
-- 4) The routine, the trigger and its function
-- =============================================================================
revoke execute on function tmpos_invoice_draft.m7b_invoice_draft_update(text, uuid, uuid, uuid, bigint, uuid, jsonb, bigint) from tmpos_app;
drop function tmpos_invoice_draft.m7b_invoice_draft_update(text, uuid, uuid, uuid, bigint, uuid, jsonb, bigint);
drop trigger trg_invoice_draft_immutable on tmpos_invoice_draft.invoice_draft;
drop function tmpos_invoice_draft.m7b_invoice_draft_immutable();

-- =============================================================================
-- 5) 028's version contract and comments, exactly
-- =============================================================================
-- Validated over every row: the guard proved each is at version 1.
alter table tmpos_invoice_draft.invoice_draft
  drop constraint invoice_draft_version_chk,
  add constraint invoice_draft_version_chk check (version = 1);

comment on table tmpos_invoice_draft.invoice_draft is
  'Phase 4.0 M7b (migration 028): one saved invoice draft of a store (status draft, USD, version 1), naming a customer of the store''s tenant by id. Written only by m7b_invoice_draft_create; read only by its page and get routines. No runtime role holds a privilege on it.';
comment on table tmpos_invoice_draft.invoice_draft_line is
  'Phase 4.0 M7b (migration 028): one ordered plain-text line of an invoice draft, in exactly its header''s tenant and store (composite foreign key). Its total is quantity x unit price in numeric. Written only by m7b_invoice_draft_create. No runtime role holds a privilege on it.';
comment on column public.audit_event.subject_invoice_draft_id is
  'Phase 4.0 M7b (migration 028): the invoice draft the recorded action created (a store-scope draft create). Written by the command transaction from the command''s server-generated aggregate id; never from request metadata. Plain column, no FK (audit is decoupled/append-only). Never accompanied by a description, an amount or a customer''s details.';

-- =============================================================================
-- 6) Postcondition: this file removed its own objects and left 028's contract exactly
-- =============================================================================
do $$
begin
  if pg_catalog.to_regprocedure('tmpos_invoice_draft.m7b_invoice_draft_update(text, uuid, uuid, uuid, bigint, uuid, jsonb, bigint)') is not null
     or exists (select 1 from pg_catalog.pg_proc p
                 where p.pronamespace = 'tmpos_invoice_draft'::regnamespace
                   and p.proname in ('m7b_invoice_draft_update', 'm7b_invoice_draft_immutable'))
     or exists (select 1 from pg_catalog.pg_trigger g
                 where g.tgrelid in ('tmpos_invoice_draft.invoice_draft'::regclass, 'tmpos_invoice_draft.invoice_draft_line'::regclass)
                   and not g.tgisinternal) then
    raise exception 'migration 029 rollback refused: an object migration 029 created still exists'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if (select pg_catalog.count(*) from pg_catalog.pg_proc p where p.pronamespace = 'tmpos_invoice_draft'::regnamespace) <> 3
     or pg_catalog.to_regprocedure('tmpos_invoice_draft.m7b_invoice_draft_create(text, uuid, uuid, uuid, uuid, jsonb, bigint)') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_draft.m7b_invoice_draft_page(text, uuid, uuid, uuid, integer)') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_draft.m7b_invoice_draft_get(text, uuid, uuid, uuid)') is null then
    raise exception 'migration 029 rollback refused: schema tmpos_invoice_draft does not hold exactly 028''s three routines again'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if (select pg_catalog.count(*) from pg_catalog.pg_constraint k
       where k.conrelid = 'tmpos_invoice_draft.invoice_draft'::regclass and k.conname = 'invoice_draft_version_chk'
         and k.contype = 'c' and k.convalidated and pg_catalog.pg_get_constraintdef(k.oid) = 'CHECK ((version = 1))') <> 1 then
    raise exception 'migration 029 rollback refused: invoice_draft_version_chk is not 028''s validated CHECK (version = 1) again'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if pg_catalog.col_description('public.audit_event'::regclass,
       (select a.attnum from pg_catalog.pg_attribute a
         where a.attrelid = 'public.audit_event'::regclass and a.attname = 'subject_invoice_draft_id' and not a.attisdropped)::integer)
     is distinct from
     'Phase 4.0 M7b (migration 028): the invoice draft the recorded action created (a store-scope draft create). Written by the command transaction from the command''s server-generated aggregate id; never from request metadata. Plain column, no FK (audit is decoupled/append-only). Never accompanied by a description, an amount or a customer''s details.' then
    raise exception 'migration 029 rollback refused: the comment on public.audit_event.subject_invoice_draft_id is not 028''s again'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if pg_catalog.obj_description('tmpos_invoice_draft.invoice_draft'::regclass, 'pg_class') is distinct from
       'Phase 4.0 M7b (migration 028): one saved invoice draft of a store (status draft, USD, version 1), naming a customer of the store''s tenant by id. Written only by m7b_invoice_draft_create; read only by its page and get routines. No runtime role holds a privilege on it.'
     or pg_catalog.obj_description('tmpos_invoice_draft.invoice_draft_line'::regclass, 'pg_class') is distinct from
       'Phase 4.0 M7b (migration 028): one ordered plain-text line of an invoice draft, in exactly its header''s tenant and store (composite foreign key). Its total is quantity x unit price in numeric. Written only by m7b_invoice_draft_create. No runtime role holds a privilege on it.' then
    raise exception 'migration 029 rollback refused: the draft tables'' comments are not 028''s again'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- 028's grants, exactly (its postcondition (f) and (g)): each of the three routines EXECUTE-able by tmpos_app, and no
  -- grant on any routine of the schema beyond its owner's and a non-grantable EXECUTE to tmpos_app; the schema's USAGE.
  if (select pg_catalog.count(*) from pg_catalog.pg_proc p
       where p.pronamespace = 'tmpos_invoice_draft'::regnamespace
         and pg_catalog.has_function_privilege('tmpos_app', p.oid, 'EXECUTE')) <> 3
     or exists (select 1
                  from pg_catalog.pg_proc p,
                       pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g
                 where p.pronamespace = 'tmpos_invoice_draft'::regnamespace
                   and g.grantee <> p.proowner
                   and not (g.grantee = 'tmpos_app'::regrole and g.privilege_type = 'EXECUTE' and not g.is_grantable))
     or not pg_catalog.has_schema_privilege('tmpos_app', 'tmpos_invoice_draft'::regnamespace, 'USAGE') then
    raise exception 'migration 029 rollback refused: tmpos_app''s grants on 028''s three routines or schema are not exactly 028''s'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$$;

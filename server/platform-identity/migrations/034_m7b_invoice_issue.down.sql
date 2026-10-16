-- Phase 4.0 M7b — issuing a saved store invoice draft
-- Migration: 034_m7b_invoice_issue (DOWN)
--
-- Removes exactly what the up file created — the rollback-order anchor, the four tables of tmpos_invoice_issue with their
-- triggers, the eighteen functions with the grants that ride on them, the audit columns subject_issued_invoice_id and
-- subject_store_id with their indexes, and the schema (a plain DROP SCHEMA, which refuses if anything else is in it) — and
-- restores the 033 catalog exactly: invoice_draft_status_chk is 033's CHECK (status in ('draft', 'discarded')) again
-- (validated, same name), and trg_invoice_draft_terminal is bound to 033's tmpos_invoice_discard.m7b_invoice_draft_terminal()
-- again, BEFORE INSERT OR UPDATE OR DELETE FOR EACH ROW, ENABLE ALWAYS, with 033's comment. Nothing else is touched — not a
-- draft, a line, a customer, a store, an audit record or a completion, not 028's to 033's routines, triggers, functions or
-- grants. Rolled back, the database is exactly the 001-033 one for every object this file touched, and the runtime that
-- requires 001-034 refuses to start on it.
--
-- IT REFUSES, CHANGING NOTHING (any refusal rolls the whole file back):
--   * while migration 034 is not applied (a table it locks, its schema, a function, the rebound trigger, the widened CHECK or
--     an audit column is missing), or a table an earlier migration created and this file locks is missing;
--   * while ANY store issuing settings, store invoice counter, issued invoice or issued invoice line exists, ANY invoice draft
--     is 'issued', or ANY audit record names an issued invoice or a store (subject_issued_invoice_id or subject_store_id set):
--     dropping them would discard issued documents, their numbering or audit evidence — an owner decision on data, never a
--     rollback's side effect. After the first real settings write this rollback is therefore one-way in practice;
--   * PostgreSQL refuses a statement of section 4 (something else is in the schema or depends on one of its objects; nothing
--     is dropped with CASCADE), or the postcondition (section 5) finds the 033 catalog inexact.
-- RETAINED EVIDENCE: this file deletes no row; the guard refuses instead.
--
-- LOCKS, BEFORE ANY CHECK: 033's seven tables in the writers' order, then the four issuing tables, each ACCESS EXCLUSIVE until
-- COMMIT, in one block whose handler turns a missing table or schema into this file's refusal (55000). Every writer of the
-- issuing tables takes public.store first, so no runtime transaction can hold a later table while waiting for an earlier one.
--
-- ROLL 034 BACK FIRST: while it is applied 033's rollback refuses at its own prerequisites (55000) and at 034's anchor (2BP01).

set local search_path = pg_catalog, pg_temp;
set local row_security = off;

-- =============================================================================
-- 1) The locks, in the writers' order: the first statements after the settings, before any check or any change
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
  lock table tmpos_invoice_issue.store_issuing_settings in access exclusive mode;
  lock table tmpos_invoice_issue.store_invoice_counter in access exclusive mode;
  lock table tmpos_invoice_issue.issued_invoice in access exclusive mode;
  lock table tmpos_invoice_issue.issued_invoice_line in access exclusive mode;
exception
  when undefined_table or invalid_schema_name then
    raise exception 'migration 034 rollback refused: migration 034 is not applied (a table or schema this file locks is missing: public.store, tmpos_role.tenant_role_level, tmpos_role_edit.role_level_version, tmpos_customer.customer, tmpos_invoice_draft.invoice_draft, tmpos_invoice_draft.invoice_draft_line, public.audit_event or a table of tmpos_invoice_issue)'
      using errcode = 'object_not_in_prerequisite_state';
end
$$;

-- =============================================================================
-- 2) The file is applied, and 033's functions it restores are there (read under the locks)
-- =============================================================================
do $$
begin
  if pg_catalog.to_regprocedure('tmpos_invoice_issue.m7b_issue_text_ok(text, integer)') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_issue.m7b_issue_postal_address_ok(text)') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_issue.m7b_invoice_tax_cents(bigint, integer)') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_issue.m7b_issuing_settings_guard()') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_issue.m7b_invoice_counter_guard()') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_issue.m7b_issued_invoice_guard()') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_issue.m7b_issued_invoice_line_guard()') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_issue.m7b_issue_truncate_guard()') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_issue.m7b_issued_invoice_commit_check()') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_issue.m7b_invoice_draft_terminal_v2()') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_issue.m7b_issue_store_reader(text, uuid, uuid, boolean, text)') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_issue.m7b_issuing_settings_get(text, uuid, uuid)') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_issue.m7b_issuing_settings_set(text, uuid, uuid, bigint, text, text, text, text, text, integer)') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_issue.m7b_invoice_issue_preview(text, uuid, uuid, uuid)') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_issue.m7b_invoice_issue(text, uuid, uuid, uuid, bigint, bigint, bigint, uuid)') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_issue.m7b_issued_invoice_page(text, uuid, uuid, uuid, uuid, integer)') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_issue.m7b_issued_invoice_get(text, uuid, uuid, uuid)') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_issue.m7b_invoice_issue_prerequisites()') is null
     or not exists (select 1 from pg_catalog.pg_trigger g
                     where g.tgrelid = 'tmpos_invoice_draft.invoice_draft'::regclass and g.tgname = 'trg_invoice_draft_terminal'
                       and g.tgfoid = pg_catalog.to_regprocedure('tmpos_invoice_issue.m7b_invoice_draft_terminal_v2()')
                       and g.tgtype = 31 and g.tgenabled = 'A' and g.tgattr = ''::pg_catalog.int2vector and g.tgqual is null)
     or (select pg_catalog.count(*) from pg_catalog.pg_trigger g
          where not g.tgisinternal
            and (g.tgrelid::regclass::text, g.tgname::text) in (
              ('tmpos_invoice_issue.store_issuing_settings', 'trg_store_issuing_settings_guard'),
              ('tmpos_invoice_issue.store_issuing_settings', 'trg_store_issuing_settings_truncate'),
              ('tmpos_invoice_issue.store_invoice_counter', 'trg_store_invoice_counter_guard'),
              ('tmpos_invoice_issue.store_invoice_counter', 'trg_store_invoice_counter_truncate'),
              ('tmpos_invoice_issue.issued_invoice', 'trg_issued_invoice_guard'),
              ('tmpos_invoice_issue.issued_invoice', 'trg_issued_invoice_truncate'),
              ('tmpos_invoice_issue.issued_invoice', 'trg_issued_invoice_commit_check'),
              ('tmpos_invoice_issue.issued_invoice_line', 'trg_issued_invoice_line_guard'),
              ('tmpos_invoice_issue.issued_invoice_line', 'trg_issued_invoice_line_truncate'))) <> 9
     or not exists (select 1 from pg_catalog.pg_constraint k
                     where k.conrelid = 'tmpos_invoice_draft.invoice_draft'::regclass and k.conname = 'invoice_draft_status_chk'
                       and pg_catalog.pg_get_constraintdef(k.oid) = 'CHECK ((status = ANY (ARRAY[''draft''::text, ''discarded''::text, ''issued''::text])))')
     or (select pg_catalog.count(*) from pg_catalog.pg_attribute a
          where a.attrelid = 'public.audit_event'::regclass
            and a.attname in ('subject_issued_invoice_id', 'subject_store_id') and not a.attisdropped) <> 2
     or pg_catalog.to_regclass('public.idx_audit_event_subject_issued_invoice_occurred') is null
     or pg_catalog.to_regclass('public.idx_audit_event_subject_store_occurred') is null then
    raise exception 'migration 034 rollback refused: migration 034 is not applied (a function or trigger of tmpos_invoice_issue, the rebound terminal trigger in its exact shape and mode, the widened status CHECK or an audit subject column or index is missing)'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if pg_catalog.to_regprocedure('tmpos_invoice_discard.m7b_invoice_draft_terminal()') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_discard.m7b_invoice_draft_line_terminal()') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_discard.m7b_invoice_draft_discard(text, uuid, uuid, uuid, bigint)') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_discard.m7b_invoice_draft_page_v2(text, uuid, uuid, uuid, integer)') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_discard.m7b_invoice_draft_get_v2(text, uuid, uuid, uuid)') is null then
    raise exception 'migration 034 rollback refused: migration 033''s functions are missing, so there is no 033 catalog to restore'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$$;

-- =============================================================================
-- 3) The guard: no issuing data or audit evidence is ever discarded by a rollback
-- =============================================================================
do $$
begin
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'migration 034 rollback refused: it must run under READ COMMITTED, so that its checks see every committed row'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if exists (select 1 from tmpos_invoice_issue.store_issuing_settings)
     or exists (select 1 from tmpos_invoice_issue.store_invoice_counter)
     or exists (select 1 from tmpos_invoice_issue.issued_invoice)
     or exists (select 1 from tmpos_invoice_issue.issued_invoice_line)
     or exists (select 1 from tmpos_invoice_draft.invoice_draft d where d.status = 'issued') then
    raise exception 'migration 034 rollback refused: issuing settings, an invoice counter, an issued invoice or an issued draft exists, and a rollback never deletes them'
      using errcode = 'object_not_in_prerequisite_state',
            hint = 'deleting issuing settings, numbering or issued documents is an owner decision taken deliberately, not a rollback''s side effect';
  end if;
  if exists (select 1 from public.audit_event a where a.subject_issued_invoice_id is not null or a.subject_store_id is not null) then
    raise exception 'migration 034 rollback refused: an audit record names an issued invoice or a store'
      using errcode = 'object_not_in_prerequisite_state',
            hint = 'dropping subject_issued_invoice_id or subject_store_id would erase audit evidence; resolving that state is an owner decision';
  end if;
end
$$;

-- =============================================================================
-- 4) The anchor, 033's trigger binding and CHECK, the tables, the functions, the audit subjects and the schema
-- =============================================================================
drop function tmpos_invoice_issue.m7b_invoice_issue_prerequisites();

drop trigger trg_invoice_draft_terminal on tmpos_invoice_draft.invoice_draft;
create trigger trg_invoice_draft_terminal
  before insert or update or delete on tmpos_invoice_draft.invoice_draft
  for each row execute function tmpos_invoice_discard.m7b_invoice_draft_terminal();
alter table tmpos_invoice_draft.invoice_draft enable always trigger trg_invoice_draft_terminal;
comment on trigger trg_invoice_draft_terminal on tmpos_invoice_draft.invoice_draft is
  'Phase 4.0 M7b (migration 033): the terminal discarded state of an invoice draft header (tmpos_invoice_discard.m7b_invoice_draft_terminal). Enabled ALWAYS.';

-- Validated over every row: the guard proved none is 'issued'.
alter table tmpos_invoice_draft.invoice_draft
  drop constraint invoice_draft_status_chk,
  add constraint invoice_draft_status_chk check (status in ('draft', 'discarded'));

-- The lines first (they reference the header), then the header, the counter (it references the settings), the settings.
-- Their triggers go with them; the internal foreign-key triggers on the drafts, the stores and the customers too.
drop table tmpos_invoice_issue.issued_invoice_line;
drop table tmpos_invoice_issue.issued_invoice;
drop table tmpos_invoice_issue.store_invoice_counter;
drop table tmpos_invoice_issue.store_issuing_settings;

revoke execute on function tmpos_invoice_issue.m7b_issuing_settings_get(text, uuid, uuid) from tmpos_app;
revoke execute on function tmpos_invoice_issue.m7b_issuing_settings_set(text, uuid, uuid, bigint, text, text, text, text, text, integer) from tmpos_app;
revoke execute on function tmpos_invoice_issue.m7b_invoice_issue_preview(text, uuid, uuid, uuid) from tmpos_app;
revoke execute on function tmpos_invoice_issue.m7b_invoice_issue(text, uuid, uuid, uuid, bigint, bigint, bigint, uuid) from tmpos_app;
revoke execute on function tmpos_invoice_issue.m7b_issued_invoice_page(text, uuid, uuid, uuid, uuid, integer) from tmpos_app;
revoke execute on function tmpos_invoice_issue.m7b_issued_invoice_get(text, uuid, uuid, uuid) from tmpos_app;
drop function tmpos_invoice_issue.m7b_issuing_settings_get(text, uuid, uuid);
drop function tmpos_invoice_issue.m7b_issuing_settings_set(text, uuid, uuid, bigint, text, text, text, text, text, integer);
drop function tmpos_invoice_issue.m7b_invoice_issue_preview(text, uuid, uuid, uuid);
drop function tmpos_invoice_issue.m7b_invoice_issue(text, uuid, uuid, uuid, bigint, bigint, bigint, uuid);
drop function tmpos_invoice_issue.m7b_issued_invoice_page(text, uuid, uuid, uuid, uuid, integer);
drop function tmpos_invoice_issue.m7b_issued_invoice_get(text, uuid, uuid, uuid);
drop function tmpos_invoice_issue.m7b_issue_store_reader(text, uuid, uuid, boolean, text);
drop function tmpos_invoice_issue.m7b_invoice_draft_terminal_v2();
drop function tmpos_invoice_issue.m7b_issued_invoice_commit_check();
drop function tmpos_invoice_issue.m7b_issue_truncate_guard();
drop function tmpos_invoice_issue.m7b_issued_invoice_line_guard();
drop function tmpos_invoice_issue.m7b_issued_invoice_guard();
drop function tmpos_invoice_issue.m7b_invoice_counter_guard();
drop function tmpos_invoice_issue.m7b_issuing_settings_guard();
drop function tmpos_invoice_issue.m7b_invoice_tax_cents(bigint, integer);
drop function tmpos_invoice_issue.m7b_issue_postal_address_ok(text);
drop function tmpos_invoice_issue.m7b_issue_text_ok(text, integer);

drop index public.idx_audit_event_subject_issued_invoice_occurred;
drop index public.idx_audit_event_subject_store_occurred;
alter table public.audit_event
  drop column subject_issued_invoice_id,
  drop column subject_store_id;

revoke usage on schema tmpos_invoice_issue from tmpos_app;
drop schema tmpos_invoice_issue;

-- =============================================================================
-- 5) Postcondition: this file removed its own objects and left the 033 catalog exactly
-- =============================================================================
do $$
declare
  v_terminal oid := 'tmpos_invoice_discard.m7b_invoice_draft_terminal()'::regprocedure;
begin
  if pg_catalog.to_regnamespace('tmpos_invoice_issue') is not null
     or exists (select 1 from pg_catalog.pg_attribute a
                 where a.attrelid = 'public.audit_event'::regclass
                   and a.attname in ('subject_issued_invoice_id', 'subject_store_id') and not a.attisdropped)
     or pg_catalog.to_regclass('public.idx_audit_event_subject_issued_invoice_occurred') is not null
     or pg_catalog.to_regclass('public.idx_audit_event_subject_store_occurred') is not null
     or exists (select 1 from pg_catalog.pg_attribute a
                 where a.attrelid = 'public.audit_event'::regclass and a.attacl is not null) then
    raise exception 'migration 034 rollback refused: an object migration 034 created still exists, or a column of the audit table carries a grant'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- 033's status CHECK, exactly.
  if (select pg_catalog.count(*) from pg_catalog.pg_constraint k
       where k.conrelid = 'tmpos_invoice_draft.invoice_draft'::regclass and k.conname = 'invoice_draft_status_chk' and k.contype = 'c'
         and k.convalidated
         and pg_catalog.pg_get_constraintdef(k.oid) = 'CHECK ((status = ANY (ARRAY[''draft''::text, ''discarded''::text])))') <> 1 then
    raise exception 'migration 034 rollback refused: invoice_draft_status_chk is not 033''s validated CHECK again'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- 033's triggers, exactly: the header carries 029's and 033's terminal trigger (bound to 033's function, tgtype ROW 1 +
  -- BEFORE 2 + INSERT 4 + DELETE 8 + UPDATE 16 = 31, ALWAYS, no column list, no WHEN, 033's comment); the lines 033's alone;
  -- no other trigger of the drafts is non-internal, and no foreign key of 034's references them.
  if (select pg_catalog.string_agg(g.tgname::text, ', ' order by g.tgname::text collate "C")
        from pg_catalog.pg_trigger g
       where g.tgrelid = 'tmpos_invoice_draft.invoice_draft'::regclass and not g.tgisinternal)
     is distinct from 'trg_invoice_draft_immutable, trg_invoice_draft_terminal'
     or (select pg_catalog.string_agg(g.tgname::text, ', ' order by g.tgname::text collate "C")
           from pg_catalog.pg_trigger g
          where g.tgrelid = 'tmpos_invoice_draft.invoice_draft_line'::regclass and not g.tgisinternal)
        is distinct from 'trg_invoice_draft_line_terminal'
     or (select pg_catalog.count(*) from pg_catalog.pg_trigger g where g.tgfoid = v_terminal) <> 1
     or not exists (select 1 from pg_catalog.pg_trigger g
                     where g.tgrelid = 'tmpos_invoice_draft.invoice_draft'::regclass
                       and g.tgname = 'trg_invoice_draft_terminal'
                       and g.tgfoid = v_terminal and g.tgtype = 31 and g.tgenabled = 'A'
                       and g.tgattr = ''::pg_catalog.int2vector and g.tgqual is null and not g.tgisinternal
                       and pg_catalog.obj_description(g.oid, 'pg_trigger') = 'Phase 4.0 M7b (migration 033): the terminal discarded state of an invoice draft header (tmpos_invoice_discard.m7b_invoice_draft_terminal). Enabled ALWAYS.')
     or not exists (select 1 from pg_catalog.pg_trigger g
                     where g.tgrelid = 'tmpos_invoice_draft.invoice_draft_line'::regclass
                       and g.tgname = 'trg_invoice_draft_line_terminal'
                       and g.tgfoid = 'tmpos_invoice_discard.m7b_invoice_draft_line_terminal()'::regprocedure
                       and g.tgtype = 31 and g.tgenabled = 'A'
                       and g.tgattr = ''::pg_catalog.int2vector and g.tgqual is null and not g.tgisinternal)
     or not exists (select 1 from pg_catalog.pg_trigger g
                     where g.tgrelid = 'tmpos_invoice_draft.invoice_draft'::regclass
                       and g.tgname = 'trg_invoice_draft_immutable'
                       and g.tgfoid = 'tmpos_invoice_draft.m7b_invoice_draft_immutable()'::regprocedure
                       and g.tgtype = 19 and g.tgenabled = 'A'
                       and g.tgattr = ''::pg_catalog.int2vector and g.tgqual is null and not g.tgisinternal)
     or exists (select 1 from pg_catalog.pg_constraint k
                 where k.contype = 'f'
                   and k.confrelid in ('tmpos_invoice_draft.invoice_draft'::regclass, 'public.store'::regclass,
                                       'tmpos_customer.customer'::regclass)
                   and k.conname in ('issued_invoice_draft_fkey', 'issued_invoice_store_fkey', 'issued_invoice_customer_fkey',
                                     'store_issuing_settings_store_fkey', 'store_invoice_counter_store_fkey')) then
    raise exception 'migration 034 rollback refused: the draft tables do not carry exactly 033''s triggers again, bound, shaped, enabled and commented as 033 left them'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- Schema tmpos_invoice_draft: exactly 033's relations.
  if (select pg_catalog.string_agg(pg_catalog.format('%s:%s', c.relname, c.relkind), ', ' order by c.relname)
        from pg_catalog.pg_class c where c.relnamespace = 'tmpos_invoice_draft'::regnamespace)
     is distinct from
     'invoice_draft:r, invoice_draft_customer_idx:i, invoice_draft_line:r, invoice_draft_line_pkey:i, invoice_draft_open_page_idx:i, invoice_draft_page_idx:i, invoice_draft_pkey:i, invoice_draft_scope_key:i' then
    raise exception 'migration 034 rollback refused: schema tmpos_invoice_draft does not hold exactly 033''s relations again'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- 033's functions, their complete ACLs as 033 left them, entry by entry (grantee, privilege, grantability, granted by the
  -- owner): the discard and the two reads the owner's EXECUTE and tmpos_app's, the trigger functions and the anchor the
  -- owner's alone. Read through coalesce(proacl, acldefault), the owner's entry included; PUBLIC would be one more.
  if (select pg_catalog.string_agg(pg_catalog.format('%s:%s', p.oid::regprocedure::text,
                                     (select pg_catalog.string_agg(pg_catalog.format('%s/%s/%s/%s',
                                               case when g.grantee = p.proowner then 'owner' else g.grantee::regrole::text end,
                                               g.privilege_type, g.is_grantable, g.grantor = p.proowner), ';'
                                             order by case when g.grantee = p.proowner then 'owner' else g.grantee::regrole::text end collate "C",
                                                      g.privilege_type collate "C")
                                        from pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g)),
                                   ', ' order by p.oid::regprocedure::text collate "C")
        from pg_catalog.pg_proc p where p.pronamespace = 'tmpos_invoice_discard'::regnamespace)
     is distinct from
     'tmpos_invoice_discard.m7b_invoice_discard_prerequisites():owner/EXECUTE/f/t, tmpos_invoice_discard.m7b_invoice_draft_discard(text,uuid,uuid,uuid,bigint):owner/EXECUTE/f/t;tmpos_app/EXECUTE/f/t, tmpos_invoice_discard.m7b_invoice_draft_get_v2(text,uuid,uuid,uuid):owner/EXECUTE/f/t;tmpos_app/EXECUTE/f/t, tmpos_invoice_discard.m7b_invoice_draft_line_terminal():owner/EXECUTE/f/t, tmpos_invoice_discard.m7b_invoice_draft_page_v2(text,uuid,uuid,uuid,integer):owner/EXECUTE/f/t;tmpos_app/EXECUTE/f/t, tmpos_invoice_discard.m7b_invoice_draft_terminal():owner/EXECUTE/f/t'
     or not pg_catalog.has_function_privilege('tmpos_app', 'tmpos_invoice_discard.m7b_invoice_draft_discard(text, uuid, uuid, uuid, bigint)', 'EXECUTE')
     or not pg_catalog.has_function_privilege('tmpos_app', 'tmpos_invoice_discard.m7b_invoice_draft_page_v2(text, uuid, uuid, uuid, integer)', 'EXECUTE')
     or not pg_catalog.has_function_privilege('tmpos_app', 'tmpos_invoice_discard.m7b_invoice_draft_get_v2(text, uuid, uuid, uuid)', 'EXECUTE') then
    raise exception 'migration 034 rollback refused: migration 033''s functions or their grants are not exactly as 033 left them'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$$;

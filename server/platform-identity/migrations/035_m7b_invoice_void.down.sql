-- Phase 4.0 M7b — voiding an issued store invoice
-- Migration: 035_m7b_invoice_void (DOWN)
--
-- Removes exactly what the up file created — the rollback-order anchor, the void routine and the two v2 reads with the grants
-- that ride on them, the two guard triggers and their functions, the table tmpos_invoice_void.issued_invoice_void (and with it
-- its foreign key's two internal triggers on 034's issued_invoice) and the schema (a plain DROP SCHEMA, which refuses if
-- anything else is in it) — and restores the 034 catalog exactly: tmpos_app holds its EXECUTE on 034's
-- tmpos_invoice_issue.m7b_issued_invoice_page and m7b_issued_invoice_get again, which the up file revoked, each ACL exactly 034's
-- two entries, and public.audit_event.subject_issued_invoice_id carries 034's comment again, word for word. Nothing else is
-- touched — not an issued invoice, a line, a counter, settings, a draft, a customer, a store, an audit record or a
-- completion, not 034's routines, triggers, functions or other grants. Rolled back, the database is exactly the 001-034 one
-- for every object this file touched, and the runtime that requires 001-035 refuses to start on it.
--
-- RUN IT WITH THE TENANT RUNTIME STOPPED, as the apply: a 035-built runtime left running meets dropped v2 functions (503).
--
-- IT REFUSES, CHANGING NOTHING (any refusal rolls the whole file back):
--   * while migration 035 is not applied (its schema, a function, the table, a guard trigger in its shape and mode or the
--     foreign key is missing), or a table this file locks is missing, or 034's page or get is missing (there is no 034
--     contract to restore: roll 035 back before 034);
--   * while ANY void record exists, or ANY audit record of action store.invoice.void: dropping them would discard which
--     invoices are void, or leave audit evidence of a void the catalog no longer records — an owner decision on data, never a
--     rollback's side effect. No path deletes a void record, so AFTER THE FIRST VOID THIS ROLLBACK IS ONE-WAY (the void's
--     audit record also names an issued invoice, which 034's rollback refuses on);
--   * PostgreSQL refuses a statement of section 4 (something else is in the schema or depends on one of its objects; nothing
--     is dropped with CASCADE), or the postcondition (section 5) finds the 034 catalog inexact.
-- RETAINED EVIDENCE: this file deletes no row; the guard refuses instead.
--
-- LOCKS, BEFORE ANY CHECK: the up file's, in the writers' order — public.store first, 034's role, customer and draft tables,
-- 034's four issuing tables (issued_invoice among them), then the void table, then public.audit_event last — each ACCESS
-- EXCLUSIVE until COMMIT, in one block whose handler turns a missing table or schema into this file's refusal (55000). Every
-- writer of the void table takes its store row FOR SHARE first, then the issued header, the void record and the audit record.
--
-- ROLL 035 BACK BEFORE 034: while 035 is applied 034's rollback fails closed — 55000 at its data guard while any issuing data
-- exists, otherwise 2BP01 on the dependencies (this file's foreign key onto issued_invoice, the v2 reads' and anchor's recorded
-- dependencies on 034's page and get).

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
  lock table tmpos_invoice_issue.store_issuing_settings in access exclusive mode;
  lock table tmpos_invoice_issue.store_invoice_counter in access exclusive mode;
  lock table tmpos_invoice_issue.issued_invoice in access exclusive mode;
  lock table tmpos_invoice_issue.issued_invoice_line in access exclusive mode;
  lock table tmpos_invoice_void.issued_invoice_void in access exclusive mode;
  lock table public.audit_event in access exclusive mode;
exception
  when undefined_table or invalid_schema_name then
    raise exception 'migration 035 rollback refused: migration 035 is not applied (a table or schema this file locks is missing: public.store, tmpos_role.tenant_role_level, tmpos_role_edit.role_level_version, tmpos_customer.customer, tmpos_invoice_draft.invoice_draft, tmpos_invoice_draft.invoice_draft_line, public.audit_event, a table of tmpos_invoice_issue or tmpos_invoice_void.issued_invoice_void)'
      using errcode = 'object_not_in_prerequisite_state';
end
$$;

-- =============================================================================
-- 2) The file is applied, and 034's reads it restores are there (read under the locks)
-- =============================================================================
do $$
begin
  if pg_catalog.to_regnamespace('tmpos_invoice_void') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_void.m7b_invoice_void(text, uuid, uuid, uuid, bigint, text)') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_void.m7b_issued_invoice_page_v2(text, uuid, uuid, uuid, uuid, integer)') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_void.m7b_issued_invoice_get_v2(text, uuid, uuid, uuid)') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_void.m7b_invoice_void_guard()') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_void.m7b_invoice_void_truncate_guard()') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_void.m7b_invoice_void_prerequisites()') is null
     or (select pg_catalog.string_agg(pg_catalog.format('%s:%s:%s:%s', g.tgname, g.tgfoid::regprocedure::text, g.tgtype, g.tgenabled), ', '
                                     order by g.tgname::text collate "C")
           from pg_catalog.pg_trigger g
          where g.tgrelid = 'tmpos_invoice_void.issued_invoice_void'::regclass and not g.tgisinternal)
        is distinct from 'trg_issued_invoice_void_guard:tmpos_invoice_void.m7b_invoice_void_guard():31:A, trg_issued_invoice_void_truncate:tmpos_invoice_void.m7b_invoice_void_truncate_guard():34:A'
     or not exists (select 1 from pg_catalog.pg_constraint k
                     where k.conrelid = 'tmpos_invoice_void.issued_invoice_void'::regclass and k.contype = 'f'
                       and k.conname = 'issued_invoice_void_invoice_fkey'
                       and k.confrelid = 'tmpos_invoice_issue.issued_invoice'::regclass) then
    raise exception 'migration 035 rollback refused: migration 035 is not applied (schema tmpos_invoice_void, a function, a guard trigger in its exact shape and mode, or the void record''s foreign key is missing)'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if pg_catalog.to_regprocedure('tmpos_invoice_issue.m7b_issued_invoice_page(text, uuid, uuid, uuid, uuid, integer)') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_issue.m7b_issued_invoice_get(text, uuid, uuid, uuid)') is null then
    raise exception 'migration 035 rollback refused: migration 034''s issued page or get is missing, so there is no 034 catalog to restore'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$$;

-- =============================================================================
-- 3) The guard: no void record or void audit evidence is ever discarded by a rollback
-- =============================================================================
do $$
begin
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'migration 035 rollback refused: it must run under READ COMMITTED, so that its checks see every committed row'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if exists (select 1 from tmpos_invoice_void.issued_invoice_void) then
    raise exception 'migration 035 rollback refused: a void record exists, and a rollback never deletes one'
      using errcode = 'object_not_in_prerequisite_state',
            hint = 'deleting a void record returns a voided invoice to issued; that is an owner decision taken deliberately, not a rollback''s side effect';
  end if;
  if exists (select 1 from public.audit_event a where a.action_id = 'store.invoice.void') then
    raise exception 'migration 035 rollback refused: an audit record of action store.invoice.void exists'
      using errcode = 'object_not_in_prerequisite_state',
            hint = 'rolling back would leave audit evidence of a void the database no longer records; resolving that state is an owner decision';
  end if;
end
$$;

-- =============================================================================
-- 4) 034's read grants, then the anchor, the routines, the triggers and their functions, the table and the schema
-- =============================================================================
grant execute on function tmpos_invoice_issue.m7b_issued_invoice_page(text, uuid, uuid, uuid, uuid, integer) to tmpos_app;
grant execute on function tmpos_invoice_issue.m7b_issued_invoice_get(text, uuid, uuid, uuid) to tmpos_app;

-- 034's comment on the audit subject, exactly (034 up section 9).
comment on column public.audit_event.subject_issued_invoice_id is
  'Phase 4.0 M7b (migration 034): the issued invoice the recorded action created (a store-scope issue, beside the draft and customer subjects). Written by the command transaction from the routine''s verified answer; never from request metadata. Plain column, no FK (audit is decoupled/append-only). Never accompanied by a seller, customer or line value.';

drop function tmpos_invoice_void.m7b_invoice_void_prerequisites();

revoke execute on function tmpos_invoice_void.m7b_invoice_void(text, uuid, uuid, uuid, bigint, text) from tmpos_app;
revoke execute on function tmpos_invoice_void.m7b_issued_invoice_page_v2(text, uuid, uuid, uuid, uuid, integer) from tmpos_app;
revoke execute on function tmpos_invoice_void.m7b_issued_invoice_get_v2(text, uuid, uuid, uuid) from tmpos_app;
drop function tmpos_invoice_void.m7b_invoice_void(text, uuid, uuid, uuid, bigint, text);
drop function tmpos_invoice_void.m7b_issued_invoice_page_v2(text, uuid, uuid, uuid, uuid, integer);
drop function tmpos_invoice_void.m7b_issued_invoice_get_v2(text, uuid, uuid, uuid);

drop trigger trg_issued_invoice_void_guard on tmpos_invoice_void.issued_invoice_void;
drop trigger trg_issued_invoice_void_truncate on tmpos_invoice_void.issued_invoice_void;
drop function tmpos_invoice_void.m7b_invoice_void_guard();
drop function tmpos_invoice_void.m7b_invoice_void_truncate_guard();

-- The foreign key's internal triggers on 034's issued_invoice go with the table.
drop table tmpos_invoice_void.issued_invoice_void;

revoke usage on schema tmpos_invoice_void from tmpos_app;
drop schema tmpos_invoice_void;

-- =============================================================================
-- 5) Postcondition: this file removed its own objects and left the 034 catalog exactly
-- =============================================================================
do $$
declare
  v_issued oid := 'tmpos_invoice_issue.issued_invoice'::regclass;
  v_line   oid := 'tmpos_invoice_issue.issued_invoice_line'::regclass;
begin
  if pg_catalog.to_regnamespace('tmpos_invoice_void') is not null then
    raise exception 'migration 035 rollback refused: an object migration 035 created still exists'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- 034's comment on the audit subject, exactly.
  if pg_catalog.col_description('public.audit_event'::regclass,
       (select a.attnum from pg_catalog.pg_attribute a
         where a.attrelid = 'public.audit_event'::regclass and a.attname = 'subject_issued_invoice_id' and not a.attisdropped))
     is distinct from 'Phase 4.0 M7b (migration 034): the issued invoice the recorded action created (a store-scope issue, beside the draft and customer subjects). Written by the command transaction from the routine''s verified answer; never from request metadata. Plain column, no FK (audit is decoupled/append-only). Never accompanied by a seller, customer or line value.' then
    raise exception 'migration 035 rollback refused: public.audit_event.subject_issued_invoice_id does not carry 034''s comment again'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- Schema tmpos_invoice_issue: exactly 034's functions and relations.
  if (select pg_catalog.string_agg(p.oid::regprocedure::text, ', ' order by p.oid::regprocedure::text collate "C")
        from pg_catalog.pg_proc p where p.pronamespace = 'tmpos_invoice_issue'::regnamespace)
     is distinct from
     'tmpos_invoice_issue.m7b_invoice_counter_guard(), tmpos_invoice_issue.m7b_invoice_draft_terminal_v2(), tmpos_invoice_issue.m7b_invoice_issue(text,uuid,uuid,uuid,bigint,bigint,bigint,uuid), tmpos_invoice_issue.m7b_invoice_issue_prerequisites(), tmpos_invoice_issue.m7b_invoice_issue_preview(text,uuid,uuid,uuid), tmpos_invoice_issue.m7b_invoice_tax_cents(bigint,integer), tmpos_invoice_issue.m7b_issue_postal_address_ok(text), tmpos_invoice_issue.m7b_issue_store_reader(text,uuid,uuid,boolean,text), tmpos_invoice_issue.m7b_issue_text_ok(text,integer), tmpos_invoice_issue.m7b_issue_truncate_guard(), tmpos_invoice_issue.m7b_issued_invoice_commit_check(), tmpos_invoice_issue.m7b_issued_invoice_get(text,uuid,uuid,uuid), tmpos_invoice_issue.m7b_issued_invoice_guard(), tmpos_invoice_issue.m7b_issued_invoice_line_guard(), tmpos_invoice_issue.m7b_issued_invoice_page(text,uuid,uuid,uuid,uuid,integer), tmpos_invoice_issue.m7b_issuing_settings_get(text,uuid,uuid), tmpos_invoice_issue.m7b_issuing_settings_guard(), tmpos_invoice_issue.m7b_issuing_settings_set(text,uuid,uuid,bigint,text,text,text,text,text,integer)'
     or (select pg_catalog.string_agg(pg_catalog.format('%s:%s', c.relname, c.relkind), ', ' order by c.relname collate "C")
           from pg_catalog.pg_class c where c.relnamespace = 'tmpos_invoice_issue'::regnamespace)
        is distinct from
        'issued_invoice:r, issued_invoice_customer_idx:i, issued_invoice_line:r, issued_invoice_line_pkey:i, issued_invoice_number_key:i, issued_invoice_pkey:i, issued_invoice_scope_key:i, issued_invoice_source_draft_key:i, store_invoice_counter:r, store_invoice_counter_pkey:i, store_issuing_settings:r, store_issuing_settings_pkey:i' then
    raise exception 'migration 035 rollback refused: schema tmpos_invoice_issue does not hold exactly 034''s functions and relations'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- The issued header: exactly 034's three triggers, ALWAYS; no foreign key references it but 034's own line key; every
  -- internal trigger on it belongs to a foreign key of 034's issued tables (none left by this file's).
  if (select pg_catalog.string_agg(pg_catalog.format('%s:%s:%s:%s', g.tgname, g.tgfoid::regprocedure::text, g.tgtype, g.tgenabled), ', '
                                  order by g.tgname::text collate "C")
        from pg_catalog.pg_trigger g
       where g.tgrelid = v_issued and not g.tgisinternal)
     is distinct from 'trg_issued_invoice_commit_check:tmpos_invoice_issue.m7b_issued_invoice_commit_check():5:A, trg_issued_invoice_guard:tmpos_invoice_issue.m7b_issued_invoice_guard():31:A, trg_issued_invoice_truncate:tmpos_invoice_issue.m7b_issue_truncate_guard():34:A'
     or (select pg_catalog.string_agg(pg_catalog.format('%s.%s', k.conrelid::regclass::text, k.conname), ', ' order by k.conname::text collate "C")
           from pg_catalog.pg_constraint k where k.contype = 'f' and k.confrelid = v_issued)
        is distinct from 'tmpos_invoice_issue.issued_invoice_line.issued_invoice_line_invoice_fkey'
     or exists (select 1 from pg_catalog.pg_trigger g
                 where g.tgrelid = v_issued and g.tgisinternal
                   and not exists (select 1 from pg_catalog.pg_constraint k
                                    where k.oid = g.tgconstraint and k.contype = 'f' and k.conrelid in (v_issued, v_line))) then
    raise exception 'migration 035 rollback refused: 034''s issued header does not carry exactly 034''s triggers and foreign keys again'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- 034's functions, their complete ACLs as 034 left them, entry by entry (grantee, privilege, grantability, granted by the
  -- owner): the six routines the owner's EXECUTE and tmpos_app's, every other function the owner's alone. Read through
  -- coalesce(proacl, acldefault), the owner's entry included; PUBLIC would be one more.
  if (select pg_catalog.string_agg(pg_catalog.format('%s:%s', p.oid::regprocedure::text,
                                     (select pg_catalog.string_agg(pg_catalog.format('%s/%s/%s/%s',
                                               case when g.grantee = p.proowner then 'owner' else g.grantee::regrole::text end,
                                               g.privilege_type, g.is_grantable, g.grantor = p.proowner), ';'
                                             order by case when g.grantee = p.proowner then 'owner' else g.grantee::regrole::text end collate "C",
                                                      g.privilege_type collate "C")
                                        from pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g)),
                                   ', ' order by p.oid::regprocedure::text collate "C")
        from pg_catalog.pg_proc p where p.pronamespace = 'tmpos_invoice_issue'::regnamespace)
     is distinct from
     'tmpos_invoice_issue.m7b_invoice_counter_guard():owner/EXECUTE/f/t, tmpos_invoice_issue.m7b_invoice_draft_terminal_v2():owner/EXECUTE/f/t, tmpos_invoice_issue.m7b_invoice_issue(text,uuid,uuid,uuid,bigint,bigint,bigint,uuid):owner/EXECUTE/f/t;tmpos_app/EXECUTE/f/t, tmpos_invoice_issue.m7b_invoice_issue_prerequisites():owner/EXECUTE/f/t, tmpos_invoice_issue.m7b_invoice_issue_preview(text,uuid,uuid,uuid):owner/EXECUTE/f/t;tmpos_app/EXECUTE/f/t, tmpos_invoice_issue.m7b_invoice_tax_cents(bigint,integer):owner/EXECUTE/f/t, tmpos_invoice_issue.m7b_issue_postal_address_ok(text):owner/EXECUTE/f/t, tmpos_invoice_issue.m7b_issue_store_reader(text,uuid,uuid,boolean,text):owner/EXECUTE/f/t, tmpos_invoice_issue.m7b_issue_text_ok(text,integer):owner/EXECUTE/f/t, tmpos_invoice_issue.m7b_issue_truncate_guard():owner/EXECUTE/f/t, tmpos_invoice_issue.m7b_issued_invoice_commit_check():owner/EXECUTE/f/t, tmpos_invoice_issue.m7b_issued_invoice_get(text,uuid,uuid,uuid):owner/EXECUTE/f/t;tmpos_app/EXECUTE/f/t, tmpos_invoice_issue.m7b_issued_invoice_guard():owner/EXECUTE/f/t, tmpos_invoice_issue.m7b_issued_invoice_line_guard():owner/EXECUTE/f/t, tmpos_invoice_issue.m7b_issued_invoice_page(text,uuid,uuid,uuid,uuid,integer):owner/EXECUTE/f/t;tmpos_app/EXECUTE/f/t, tmpos_invoice_issue.m7b_issuing_settings_get(text,uuid,uuid):owner/EXECUTE/f/t;tmpos_app/EXECUTE/f/t, tmpos_invoice_issue.m7b_issuing_settings_guard():owner/EXECUTE/f/t, tmpos_invoice_issue.m7b_issuing_settings_set(text,uuid,uuid,bigint,text,text,text,text,text,integer):owner/EXECUTE/f/t;tmpos_app/EXECUTE/f/t'
     or not pg_catalog.has_function_privilege('tmpos_app', 'tmpos_invoice_issue.m7b_issued_invoice_page(text, uuid, uuid, uuid, uuid, integer)', 'EXECUTE')
     or not pg_catalog.has_function_privilege('tmpos_app', 'tmpos_invoice_issue.m7b_issued_invoice_get(text, uuid, uuid, uuid)', 'EXECUTE') then
    raise exception 'migration 035 rollback refused: migration 034''s functions or their grants are not exactly as 034 left them'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$$;

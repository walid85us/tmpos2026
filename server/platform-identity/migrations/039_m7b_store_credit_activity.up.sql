-- Phase 4.0 M7b — the store-wide credit-activity read (M7B-CREDITACTIVITY, docs/phase-4/18 §6 and §9.1, adopted as design
-- 2026-11-18: D-CA-1..18): one STABLE definer routine that pages every credit note of one store, newest number first, with its
-- withdrawal and the issuing and withdrawing staff display names, to the store-scope store owner of that store.
-- Migration: 039_m7b_store_credit_activity (UP)
--
-- SCOPE / TRUTH (binding):
--   - IN SCHEMA tmpos_invoice_credit_note (038's), TWO FUNCTIONS and nothing else: no table, column, trigger, index or row, and
--     no LOCK TABLE (only the locks CREATE FUNCTION, GRANT and the catalog checks take):
--       * m7b_store_credit_activity — SECURITY DEFINER, STABLE, EXECUTE to tmpos_app alone. Order (doc 18 §6.2): the arguments
--         (invalid_parameter_value, fixed text); 034's lock-free store reader at read statuses with Invoices at View, then role
--         store_owner, else ONE ('denied', NULLs) row; only then the cursor anchor, inside the reader's tenant and the
--         expected store, else ONE ('cursor_unknown', NULLs) row; then at most p_limit (1-51) ('credit_note', ...) rows,
--         credit_note_number descending, strictly below the anchor's number. No row for an empty page.
--       * m7b_store_credit_activity_prerequisites — the rollback-order anchor, granted to nobody.
--   - THE ROWS: tenant, store, credit note id and number, invoice id and number, gross, reason, issued_at, the issuing staff
--     display name, and when withdrawn its time, reason and the withdrawing staff display name (UTC text with microseconds, 038's
--     list format). Never an actor id, an email, a registration, attempt or session value, customer data, tax or net.
--   - NO WRITE: no row written, no audit record, no row lock (no FOR UPDATE or FOR SHARE), no advisory lock. Like any query it
--     holds ACCESS SHARE on the tables it reads until its transaction ends. STABLE: one snapshot per call.
--   - APPLY: the runtimes stopped (doc 18 §9.5, D-CA-7 A); READ COMMITTED; 038's schema, tables, list and attempts lookup,
--     034's store reader and 016's admission read (which the SECURITY INVOKER reader calls with the definer's rights) exist;
--     none of this file's objects exist; every table the definer or the reader reads exists as an ordinary table; the applier
--     owns the schema, can execute the reader and the admission read, and owns or inherits the owner of every such table.
--     Missing objects are refused with fixed text, never a cast error. Object checks only: no ledger clause (R-GATE-2).
--   - ROLLBACK: 039's down drops exactly the two functions; it refuses, changing nothing, while 039 is not applied. It runs
--     ONLY ON DISPOSABLE DATABASES (D-CA-18 C): production recovery is forward-only, by a new migration at the next free
--     number. Roll 039 back before 038: the anchor names 038's objects (R-GATE-1), so 038's down fails (2BP01) while this is
--     applied.
--   - NOT DEFENDED (doc 18 §11): a direct call skips CSRF, the per-client rate limit and the HTTP read-only limitation (DA-132,
--     which stays OPEN); the table owner, DDL and a superuser.
--   - NO SECRET, NO DYNAMIC SQL, NO EXTENSION, NO TEMPORARY OBJECT. Every name is schema-qualified; every routine pins its
--     search_path.
--
-- Reversible via 039_m7b_store_credit_activity.down.sql. Assumes 001-038 are applied.

-- =============================================================================
-- 1) This transaction's settings
-- =============================================================================
set local search_path = pg_catalog, pg_temp;
set local row_security = off;

-- =============================================================================
-- 2) Preconditions
-- =============================================================================
do $$
declare
  v_me     oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user);
  -- The definer's own reads and 034's store reader's (SECURITY INVOKER, so it reads as the definer's owner: 038's list). A
  -- missing one is a NULL here, never a cast error, and counts as a refusal below.
  v_tables oid[] := array[pg_catalog.to_regclass('tmpos_invoice_credit_note.invoice_credit_note'),
                          pg_catalog.to_regclass('tmpos_invoice_credit_note.invoice_credit_note_withdrawal'),
                          pg_catalog.to_regclass('tmpos_invoice_issue.issued_invoice'), pg_catalog.to_regclass('public.app_user'),
                          pg_catalog.to_regclass('tmpos_session.session'), pg_catalog.to_regclass('tmpos_mint.tenant_session'),
                          pg_catalog.to_regclass('tmpos_mint.issuer_key'), pg_catalog.to_regclass('tmpos_role.tenant_role_level'),
                          pg_catalog.to_regclass('public.store'), pg_catalog.to_regclass('public.tenant'),
                          pg_catalog.to_regclass('public.user_membership')]::oid[];
begin
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'migration 039 refused: it must run under READ COMMITTED, so that its checks see every committed row'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if (select pg_catalog.count(*) from pg_catalog.pg_roles r
       where r.rolname = any (array['tmpos_app', 'tmpos_audit_writer', 'anon', 'authenticated']::name[])) <> 4 then
    raise exception 'migration 039 refused: the runtime roles tmpos_app, tmpos_audit_writer, anon and authenticated must exist'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if pg_catalog.to_regnamespace('tmpos_invoice_credit_note') is null
     or pg_catalog.to_regclass('tmpos_invoice_credit_note.invoice_credit_note') is null
     or pg_catalog.to_regclass('tmpos_invoice_credit_note.invoice_credit_note_withdrawal') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_credit_note.m7b_invoice_credit_notes_list(text, uuid, uuid, uuid, uuid, integer)') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_credit_note.m7b_invoice_credit_note_attempts(text, uuid, uuid, uuid, uuid, integer)') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_issue.m7b_issue_store_reader(text, uuid, uuid, boolean, text)') is null
     or pg_catalog.to_regprocedure('tmpos_session.m5_admit_tenant_session_v2(text, text)') is null
     or pg_catalog.to_regclass('tmpos_invoice_issue.issued_invoice') is null
     or not exists (select 1 from pg_catalog.pg_attribute a
                     where a.attrelid = pg_catalog.to_regclass('public.app_user') and a.attname = 'display_name'
                       and not a.attisdropped)
     or not exists (select 1 from pg_catalog.pg_namespace n
                     where n.nspname = 'tmpos_invoice_credit_note' and n.nspowner = v_me) then
    raise exception 'migration 039 refused: migration 038 is not applied (its schema, owned by the applying principal, its credit-note or withdrawal table, its list or its attempts lookup is missing), or 034''s store reader or issued header, 016''s admission read or 002''s display name is missing'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- Each relation the definer or the reader reads is an ordinary table, so a view under a table's name cannot pass.
  if exists (select 1
               from pg_catalog.unnest(v_tables) t(relid)
               left join pg_catalog.pg_class c on c.oid = t.relid
              where c.oid is null or c.relkind not in ('r', 'p')) then
    raise exception 'migration 039 refused: a table the definer or 034''s store reader reads is missing or is not an ordinary table'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if exists (select 1 from pg_catalog.pg_proc p
              where p.pronamespace = 'tmpos_invoice_credit_note'::regnamespace
                and p.proname in ('m7b_store_credit_activity', 'm7b_store_credit_activity_prerequisites')) then
    raise exception 'migration 039 refused: an object of this file already exists'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if not (pg_catalog.has_function_privilege(current_user, 'tmpos_invoice_issue.m7b_issue_store_reader(text, uuid, uuid, boolean, text)', 'EXECUTE')
          and pg_catalog.has_function_privilege(current_user, 'tmpos_session.m5_admit_tenant_session_v2(text, text)', 'EXECUTE')
          and pg_catalog.has_schema_privilege(current_user, 'public', 'USAGE')
          and pg_catalog.has_schema_privilege(current_user, 'tmpos_session', 'USAGE')
          and pg_catalog.has_schema_privilege(current_user, 'tmpos_mint', 'USAGE')
          and pg_catalog.has_schema_privilege(current_user, 'tmpos_role', 'USAGE')
          and pg_catalog.has_schema_privilege(current_user, 'tmpos_invoice_issue', 'USAGE')) then
    raise exception 'migration 039 refused: the applying principal cannot execute 034''s store reader or 016''s admission read, or use the schemas they and the routine read'
      using errcode = 'insufficient_privilege';
  end if;
  -- v_tables (above): a NULL entry finds no pg_class row and refuses.
  if exists (
    select 1
      from pg_catalog.unnest(v_tables) t(relid)
      left join pg_catalog.pg_class c on c.oid = t.relid
     where c.oid is null or not pg_catalog.pg_has_role(current_user, c.relowner, 'USAGE') or c.relforcerowsecurity) then
    raise exception 'migration 039 refused: the applying principal neither owns nor inherits the owner of a table the definer reads, or one has forced row security'
      using errcode = 'insufficient_privilege';
  end if;
end
$$;

-- =============================================================================
-- 3) The store-wide credit-activity read
-- =============================================================================
create function tmpos_invoice_credit_note.m7b_store_credit_activity(
  p_session_key text, p_expected_tenant uuid, p_expected_store uuid, p_after_credit_note_id uuid, p_limit integer)
returns table (
  o_outcome                text,
  o_tenant_id              uuid,
  o_store_id               uuid,
  o_credit_note_id         uuid,
  o_credit_note_number     bigint,
  o_invoice_id             uuid,
  o_invoice_number         bigint,
  o_gross_cents            bigint,
  o_reason_code            text,
  o_issued_at              text,
  o_issued_by_name         text,
  o_withdrawn_at           text,
  o_withdrawal_reason_code text,
  o_withdrawn_by_name      text
)
language plpgsql
-- STABLE IS LOAD-BEARING (038's list): every statement here, the store reader included, sees the calling query's one
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
  c_format       constant text := 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';
  v_reader       record;
  v_after_number bigint;
begin
  if p_session_key is null or p_session_key !~ '^[\x21-\x7e]{1,128}$'
     or p_expected_tenant is null or p_expected_store is null then
    raise exception 'migration 039 store credit activity: an argument is malformed'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 51 then
    raise exception 'migration 039 store credit activity: the limit is out of range'
      using errcode = 'invalid_parameter_value';
  end if;
  -- 034's lock-free store reader at read statuses with Invoices at View (038's list's name check), the store-scope store
  -- owner only.
  select r.o_tenant_id, r.o_actor_id, r.o_role into v_reader
    from tmpos_invoice_issue.m7b_issue_store_reader(p_session_key, p_expected_tenant, p_expected_store, false, 'view') r;
  if not found or v_reader.o_role is distinct from 'store_owner' then
    return query select 'denied'::text, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid, null::bigint, null::bigint,
                        null::text, null::text, null::text, null::text, null::text, null::text;
    return;
  end if;
  -- The cursor only after the authority, and only inside the reader's tenant and the expected store: never an oracle.
  if p_after_credit_note_id is not null then
    select c.credit_note_number into v_after_number
      from tmpos_invoice_credit_note.invoice_credit_note c
     where c.credit_note_id = p_after_credit_note_id
       and c.tenant_id = v_reader.o_tenant_id and c.store_id = p_expected_store;
    if not found then
      return query select 'cursor_unknown'::text, null::uuid, null::uuid, null::uuid, null::bigint, null::uuid, null::bigint,
                          null::bigint, null::text, null::text, null::text, null::text, null::text, null::text;
      return;
    end if;
  end if;
  -- credit_note_number is unique per tenant and store (038's invoice_credit_note_number_key): a total order, no tie-breaker.
  return query
    select 'credit_note'::text, c.tenant_id, c.store_id, c.credit_note_id, c.credit_note_number, c.invoice_id, i.number,
           c.gross_cents, c.reason_code::text,
           pg_catalog.to_char(c.issued_at at time zone 'UTC', c_format),
           ui.display_name::text,
           pg_catalog.to_char(w.withdrawn_at at time zone 'UTC', c_format),
           w.reason_code::text,
           case when w.credit_note_id is not null then uw.display_name::text end
      from tmpos_invoice_credit_note.invoice_credit_note c
      join tmpos_invoice_issue.issued_invoice i
        on i.invoice_id = c.invoice_id and i.tenant_id = c.tenant_id and i.store_id = c.store_id
      left join tmpos_invoice_credit_note.invoice_credit_note_withdrawal w on w.credit_note_id = c.credit_note_id
      left join public.app_user ui on ui.internal_user_id = c.issued_by
      left join public.app_user uw on uw.internal_user_id = w.withdrawn_by
     where c.tenant_id = v_reader.o_tenant_id and c.store_id = p_expected_store
       and (p_after_credit_note_id is null or c.credit_note_number < v_after_number)
     order by c.credit_note_number desc
     limit p_limit;
end
$$;

comment on function tmpos_invoice_credit_note.m7b_store_credit_activity(text, uuid, uuid, uuid, integer) is
  'Phase 4.0 M7b (migration 039): one page of one store''s credit notes, active or withdrawn, on one snapshot, under 034''s store reader at read statuses (Invoices at View) with expectedTenant and role store_owner: (''denied'', NULLs) for every authority refusal, checked before the cursor; (''cursor_unknown'', NULLs) when p_after_credit_note_id is not a credit note of the reader''s tenant and p_expected_store; else at most p_limit (1-51) (''credit_note'', tenant, store, credit note id, number, invoice id, invoice number, gross, reason, issued_at, the issuing staff display name, and when withdrawn withdrawn_at, its reason and the withdrawing staff display name; UTC text with microseconds) rows, credit_note_number descending, below the cursor''s number. No row for an empty page. Never an actor id, email, registration, attempt, session value, customer data, tax or net. Raises invalid_parameter_value for a malformed argument or limit (fixed text). STABLE; writes nothing; takes no row or advisory lock.';

-- =============================================================================
-- 4) The rollback-order anchor (R-GATE-1: 038's objects only)
-- =============================================================================
-- A SQL-standard body records a dependency for every reg* constant: 038's credit-note and withdrawal tables and its list.
-- 038's rollback drops all three: refused (2BP01) while this exists.
create function tmpos_invoice_credit_note.m7b_store_credit_activity_prerequisites()
returns boolean
language sql
stable
security invoker
set search_path = pg_catalog, pg_temp
begin atomic
  select 'tmpos_invoice_credit_note.invoice_credit_note'::pg_catalog.regclass is not null
     and 'tmpos_invoice_credit_note.invoice_credit_note_withdrawal'::pg_catalog.regclass is not null
     and 'tmpos_invoice_credit_note.m7b_invoice_credit_notes_list(text, uuid, uuid, uuid, uuid, integer)'::pg_catalog.regprocedure is not null;
end;

comment on function tmpos_invoice_credit_note.m7b_store_credit_activity_prerequisites() is
  'Phase 4.0 M7b (migration 039): the rollback-order anchor. A SQL-standard body naming, as reg* constants, migration 038''s invoice_credit_note, invoice_credit_note_withdrawal and m7b_invoice_credit_notes_list, and no other migration''s object (R-GATE-1), so their recorded dependencies refuse (2BP01) 038''s rollback while migration 039 is applied: roll 039 back first. Never called; answers true. Granted to nobody.';

-- =============================================================================
-- 5) Privileges
-- =============================================================================
-- PostgreSQL grants EXECUTE on a new function to PUBLIC by default: every default is removed before the one intended grant.
revoke all on function tmpos_invoice_credit_note.m7b_store_credit_activity_prerequisites() from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
revoke all on function tmpos_invoice_credit_note.m7b_store_credit_activity(text, uuid, uuid, uuid, integer) from public, anon, authenticated, tmpos_app, tmpos_audit_writer;
grant execute on function tmpos_invoice_credit_note.m7b_store_credit_activity(text, uuid, uuid, uuid, integer) to tmpos_app;

-- =============================================================================
-- 6) Postcondition
-- =============================================================================
-- (a) both functions have their declared language, security, volatility, settings, owner and comment;
-- (b) the routine's complete ACL is exactly the owner's EXECUTE and tmpos_app's, the anchor's exactly the owner's;
--     tmpos_audit_writer, anon and authenticated reach neither by any path, tmpos_app not the anchor.
do $$
declare
  v_bad      text;
  v_me       oid := (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user);
  v_routine  oid := 'tmpos_invoice_credit_note.m7b_store_credit_activity(text, uuid, uuid, uuid, integer)'::regprocedure;
  v_anchor   oid := 'tmpos_invoice_credit_note.m7b_store_credit_activity_prerequisites()'::regprocedure;
begin
  -- (a)
  if (select pg_catalog.count(*) from pg_catalog.pg_proc p join pg_catalog.pg_language l on l.oid = p.prolang
       where p.proowner = v_me and pg_catalog.obj_description(p.oid, 'pg_proc') is not null
         and ((p.oid = v_routine and l.lanname = 'plpgsql' and p.prosecdef and p.provolatile = 's' and p.proretset
               and p.proconfig = array['search_path=pg_catalog, pg_temp', 'row_security=off', 'debug_print_parse=off',
                                       'debug_print_rewritten=off', 'debug_print_plan=off'])
              or (p.oid = v_anchor and l.lanname = 'sql' and not p.prosecdef and p.provolatile = 's'
                  and p.proconfig = array['search_path=pg_catalog, pg_temp']))) <> 2
     or (select pg_catalog.count(*) from pg_catalog.pg_proc p
          where p.pronamespace = 'tmpos_invoice_credit_note'::regnamespace
            and p.proname in ('m7b_store_credit_activity', 'm7b_store_credit_activity_prerequisites')) <> 2 then
    raise exception 'migration 039 refused: a function of this file is not the one its section declares'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- (b)
  select pg_catalog.string_agg(pg_catalog.format('%s %s:%s', p.proname, g.grantee::regrole::text, g.privilege_type), ', ')
    into v_bad
    from pg_catalog.pg_proc p, pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g
   where p.oid in (v_routine, v_anchor)
     and not (g.privilege_type = 'EXECUTE' and not g.is_grantable and g.grantor = p.proowner
              and (g.grantee = p.proowner or (p.oid = v_routine and g.grantee = 'tmpos_app'::regrole)));
  if v_bad is not null
     or exists (select 1 from pg_catalog.pg_proc p
                 where p.oid in (v_routine, v_anchor)
                   and (select pg_catalog.count(*) from pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g)
                       <> case when p.oid = v_routine then 2 else 1 end) then
    raise exception 'migration 039 refused: an unexpected grant remains on a function of this file, or an entry is missing (%)', coalesce(v_bad, 'none listed')
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  select pg_catalog.string_agg(distinct r.rolname::text || ' ' || f.oid::regprocedure::text, ', ') into v_bad
    from pg_catalog.pg_roles r
    join pg_catalog.pg_roles x on pg_catalog.pg_has_role(r.oid, x.oid, 'MEMBER')
    cross join pg_catalog.unnest(array[v_routine, v_anchor]) f(oid)
   where (r.rolname = any (array['tmpos_audit_writer', 'anon', 'authenticated']::name[])
          or (r.rolname = 'tmpos_app' and f.oid = v_anchor))
     and pg_catalog.has_function_privilege(x.oid, f.oid, 'EXECUTE');
  if v_bad is not null or not pg_catalog.has_function_privilege('tmpos_app', v_routine, 'EXECUTE') then
    raise exception 'migration 039 refused: a runtime role can execute a function this file does not grant it, or tmpos_app cannot execute the routine (%)', coalesce(v_bad, 'none listed')
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$$;

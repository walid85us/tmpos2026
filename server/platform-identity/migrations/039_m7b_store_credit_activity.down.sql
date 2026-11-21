-- Phase 4.0 M7b — the store-wide credit-activity read (M7B-CREDITACTIVITY, docs/phase-4/18 §9.2)
-- Migration: 039_m7b_store_credit_activity (DOWN)
--
-- Removes exactly what the up file created — tmpos_invoice_credit_note.m7b_store_credit_activity and its rollback-order anchor
-- m7b_store_credit_activity_prerequisites, with the grants that ride on them — and nothing else, leaving 038's objects in
-- place: afterwards 038's own down is possible again under its own one-way rule (doc 16 D16:383-384). Running 038's down is
-- NOT part of this rollback.
--
-- RUN IT ONLY ON A DISPOSABLE DATABASE (doc 18 D-CA-18 C): its own tests and the rollback rehearsal (doc 18 §9.3.7). It is
-- never run on a managed database; production recovery is forward-only, by a new migration at the next free number.
--
-- RUN IT WITH THE RUNTIMES STOPPED, as the apply (doc 18 §9.5), in one transaction.
--
-- IT REFUSES, CHANGING NOTHING (any refusal rolls the whole file back):
--   * while migration 039 is not applied (either of its functions is missing);
--   * PostgreSQL refuses a drop of section 2 (nothing is dropped with CASCADE);
--   * 038's catalog is not unchanged (doc 18 §9.2, "038's tables are unchanged"): section 2, in one statement, reads the
--     definition of schema tmpos_invoice_credit_note (owner, ACL, comment), of every relation in it (kind, owner, ACL,
--     persistence, access method, tablespace, replica identity, row security, options, comment; every column with its type,
--     nullability, identity, generation, collation, default, storage, compression, statistics target, ACL and comment; every
--     constraint, index, policy, rule and statistics object, each with its comment), of every trigger on those relations or
--     calling a 038 routine, and of every 038 routine (the schema's functions other than this file's two, and 038's three replacements in
--     tmpos_invoice_payment: full definition, owner, ACL, comment), once before its two drops and once after them, and
--     refuses unless the two reads are identical;
--   * the postcondition (section 3) fails:
--     - a function of this file remains;
--     - against 038's approved baseline: one of 038's four tables is missing, is not an ordinary table (relkind 'r' or 'p')
--       or is not owned by the owner of schema tmpos_invoice_credit_note; one of the ten routines 038 grants tmpos_app is
--       missing, is not owned by that schema owner, is not SECURITY DEFINER or does not have the volatility 038 declared
--       (STABLE: the attempts lookup, the list and the payments read v2; VOLATILE: the other seven); one of 038's other nine
--       functions is missing; or one of these nineteen does not carry exactly its approved ACL — the ten: the owner's EXECUTE
--       and tmpos_app's (the 038 lines of postgresStartupPreflight.ts APPROVED_ROLE_GRANTS); the nine: the owner's EXECUTE
--       alone (038 up :2729-2737, its postcondition (b) :2769-2772).
-- No DDL follows section 3. WHAT SECTION 2 DOES NOT READ: the row data of 038's tables, and 038's two audit_event columns and
-- their indexes (not 038's tables); its two drops, without CASCADE, can change neither.
-- It refuses on no data: 039 writes no row, so there is no evidence to protect.

set local search_path = pg_catalog, pg_temp;
set local row_security = off;

-- =============================================================================
-- 1) Applied
-- =============================================================================
do $$
begin
  if pg_catalog.to_regprocedure('tmpos_invoice_credit_note.m7b_store_credit_activity(text, uuid, uuid, uuid, integer)') is null
     or pg_catalog.to_regprocedure('tmpos_invoice_credit_note.m7b_store_credit_activity_prerequisites()') is null then
    raise exception 'migration 039 rollback refused: migration 039 is not applied (a function it created is missing)'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$$;

-- =============================================================================
-- 2) The routine and the anchor, between two reads of 038's catalog in this one statement
-- =============================================================================
do $$
declare
  -- One element per definition, sorted; names select the objects. A constant query, run twice: before the drops and after them.
  c_record constant text := $record$
    with cn as (select n.oid, n.nspowner, n.nspacl from pg_catalog.pg_namespace n where n.nspname = 'tmpos_invoice_credit_note'),
         rel as (select c.oid, c.relname, c.relkind, c.relowner, c.relacl, c.relpersistence, c.relam, c.reltablespace, c.relreplident,
                        c.relrowsecurity, c.relforcerowsecurity, c.reloptions
                   from pg_catalog.pg_class c join cn on c.relnamespace = cn.oid),
         fn as (select p.oid, p.proowner, p.proacl
                  from pg_catalog.pg_proc p join cn on p.pronamespace = cn.oid
                 where p.proname not in ('m7b_store_credit_activity', 'm7b_store_credit_activity_prerequisites')
                union all
                select p.oid, p.proowner, p.proacl
                  from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'tmpos_invoice_payment'
                   and p.proname in ('m7b_invoice_payment_record_v3', 'm7b_invoice_void_v3', 'm7b_invoice_payments_get_v2')),
         rec (line) as (
           select pg_catalog.format('schema|%L|%L|%L', cn.nspowner::pg_catalog.regrole, cn.nspacl,
                                    pg_catalog.obj_description(cn.oid, 'pg_namespace'))
             from cn
           union all
           select pg_catalog.format('relation|%s|%s|%L|%L|%s|%s|%s|%s|%s|%s|%L|%L', c.relname, c.relkind, c.relowner::pg_catalog.regrole,
                                    c.relacl, c.relpersistence, c.relam, c.reltablespace, c.relreplident, c.relrowsecurity,
                                    c.relforcerowsecurity, c.reloptions, pg_catalog.obj_description(c.oid, 'pg_class'))
             from rel c
           union all
           select pg_catalog.format('column|%s|%s|%s|%s|%s|%L|%L|%L|%L|%s|%L|%s|%L|%L', c.relname, a.attnum, a.attname,
                                    pg_catalog.format_type(a.atttypid, a.atttypmod), a.attnotnull, a.attidentity, a.attgenerated,
                                    a.attcollation::pg_catalog.regcollation, pg_catalog.pg_get_expr(d.adbin, d.adrelid), a.attstorage,
                                    a.attcompression, a.attstattarget, a.attacl, pg_catalog.col_description(c.oid, a.attnum))
             from rel c
             join pg_catalog.pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
             left join pg_catalog.pg_attrdef d on d.adrelid = c.oid and d.adnum = a.attnum
           union all
           select pg_catalog.format('constraint|%s|%s|%s|%L|%s|%s|%s|%L', c.relname, k.conname, k.contype,
                                    pg_catalog.pg_get_constraintdef(k.oid), k.condeferrable, k.condeferred, k.convalidated,
                                    pg_catalog.obj_description(k.oid, 'pg_constraint'))
             from rel c join pg_catalog.pg_constraint k on k.conrelid = c.oid
           union all
           select pg_catalog.format('index|%s|%L|%s|%s', c.relname, pg_catalog.pg_get_indexdef(i.indexrelid), i.indisclustered,
                                    i.indisreplident)
             from rel c join pg_catalog.pg_index i on i.indrelid = c.oid
           union all
           select pg_catalog.format('policy|%s|%s|%s|%s|%L|%L|%L|%L', c.relname, o.polname, o.polcmd, o.polpermissive,
                                    o.polroles::pg_catalog.regrole[], pg_catalog.pg_get_expr(o.polqual, o.polrelid),
                                    pg_catalog.pg_get_expr(o.polwithcheck, o.polrelid), pg_catalog.obj_description(o.oid, 'pg_policy'))
             from rel c join pg_catalog.pg_policy o on o.polrelid = c.oid
           union all
           select pg_catalog.format('rule|%s|%s|%s|%L|%L', c.relname, r.rulename, r.ev_enabled, pg_catalog.pg_get_ruledef(r.oid),
                                    pg_catalog.obj_description(r.oid, 'pg_rewrite'))
             from rel c join pg_catalog.pg_rewrite r on r.ev_class = c.oid
           union all
           select pg_catalog.format('statistics|%s|%L|%L|%s|%L', c.relname, pg_catalog.pg_get_statisticsobjdef(s.oid),
                                    s.stxowner::pg_catalog.regrole, s.stxstattarget, pg_catalog.obj_description(s.oid, 'pg_statistic_ext'))
             from rel c join pg_catalog.pg_statistic_ext s on s.stxrelid = c.oid
           union all
           select pg_catalog.format('trigger|%s|%s|%s|%L|%L', t.tgrelid::pg_catalog.regclass, t.tgname, t.tgenabled,
                                    pg_catalog.pg_get_triggerdef(t.oid), pg_catalog.obj_description(t.oid, 'pg_trigger'))
             from pg_catalog.pg_trigger t
            where not t.tgisinternal and (t.tgrelid in (select c.oid from rel c) or t.tgfoid in (select f.oid from fn f))
           union all
           select pg_catalog.format('routine|%s|%L|%L|%L|%L', f.oid::pg_catalog.regprocedure, f.proowner::pg_catalog.regrole, f.proacl,
                                    pg_catalog.obj_description(f.oid, 'pg_proc'), pg_catalog.pg_get_functiondef(f.oid))
             from fn f)
    select pg_catalog.array_agg(r.line order by r.line collate "C") from rec r
  $record$;
  v_before text[];
  v_after  text[];
begin
  execute c_record into v_before;

  drop function tmpos_invoice_credit_note.m7b_store_credit_activity(text, uuid, uuid, uuid, integer);
  drop function tmpos_invoice_credit_note.m7b_store_credit_activity_prerequisites();

  execute c_record into v_after;
  if v_before is null or v_after is distinct from v_before then
    raise exception 'migration 039 rollback refused: a definition of migration 038''s schema, tables, triggers or routines changed during this rollback'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$$;

-- =============================================================================
-- 3) Postcondition (doc 18 §9.2): this file's objects gone, 038 on its approved baseline
-- =============================================================================
do $$
declare
  v_fn       oid;
  v_owner    oid := (select n.nspowner from pg_catalog.pg_namespace n where n.nspname = 'tmpos_invoice_credit_note');
  v_tables   oid[] := array[pg_catalog.to_regclass('tmpos_invoice_credit_note.invoice_credit_note_counter'),
                            pg_catalog.to_regclass('tmpos_invoice_credit_note.invoice_credit_note_registration'),
                            pg_catalog.to_regclass('tmpos_invoice_credit_note.invoice_credit_note'),
                            pg_catalog.to_regclass('tmpos_invoice_credit_note.invoice_credit_note_withdrawal')]::oid[];
  -- 038's ten routines tmpos_app executes (038 up :2754-2763: the seven credit-note routines and the three replacements in
  -- tmpos_invoice_payment), by the volatility 038 declares and its postcondition pins (038 up :2819-2830).
  v_stable   oid[] := array[
    pg_catalog.to_regprocedure('tmpos_invoice_credit_note.m7b_invoice_credit_note_attempts(text, uuid, uuid, uuid, uuid, integer)'),
    pg_catalog.to_regprocedure('tmpos_invoice_credit_note.m7b_invoice_credit_notes_list(text, uuid, uuid, uuid, uuid, integer)'),
    pg_catalog.to_regprocedure('tmpos_invoice_payment.m7b_invoice_payments_get_v2(text, uuid, uuid, uuid, uuid, integer)')]::oid[];
  v_volatile oid[] := array[
    pg_catalog.to_regprocedure('tmpos_invoice_credit_note.m7b_invoice_credit_note_issue(text, uuid, uuid, uuid, uuid, uuid, uuid, bigint, text, text, uuid)'),
    pg_catalog.to_regprocedure('tmpos_invoice_credit_note.m7b_invoice_credit_note_register(text, uuid, uuid, uuid, uuid, uuid, bigint, text, uuid)'),
    pg_catalog.to_regprocedure('tmpos_invoice_credit_note.m7b_invoice_credit_note_registration_proof(text, uuid, uuid, uuid, uuid, integer)'),
    pg_catalog.to_regprocedure('tmpos_invoice_credit_note.m7b_invoice_credit_note_settle(text, uuid, uuid, uuid, uuid, bigint, uuid)'),
    pg_catalog.to_regprocedure('tmpos_invoice_credit_note.m7b_invoice_credit_note_withdraw(text, uuid, uuid, uuid, uuid, bigint, text, uuid)'),
    pg_catalog.to_regprocedure('tmpos_invoice_payment.m7b_invoice_payment_record_v3(text, uuid, uuid, uuid, uuid, uuid, uuid, bigint, text, text, uuid)'),
    pg_catalog.to_regprocedure('tmpos_invoice_payment.m7b_invoice_void_v3(text, uuid, uuid, uuid, bigint, text)')]::oid[];
  -- 038's other nine functions, each the owner's alone (038 up :2729-2737; its postcondition (b), :2769-2772).
  v_owners   oid[] := array[
    pg_catalog.to_regprocedure('tmpos_invoice_credit_note.m7b_invoice_credit_note_counter_guard()'),
    pg_catalog.to_regprocedure('tmpos_invoice_credit_note.m7b_invoice_credit_note_registration_guard()'),
    pg_catalog.to_regprocedure('tmpos_invoice_credit_note.m7b_invoice_credit_note_guard()'),
    pg_catalog.to_regprocedure('tmpos_invoice_credit_note.m7b_invoice_credit_note_withdrawal_guard()'),
    pg_catalog.to_regprocedure('tmpos_invoice_credit_note.m7b_invoice_credit_note_truncate_guard()'),
    pg_catalog.to_regprocedure('tmpos_invoice_credit_note.m7b_invoice_credit_note_payment_barrier()'),
    pg_catalog.to_regprocedure('tmpos_invoice_credit_note.m7b_invoice_credit_note_void_barrier()'),
    pg_catalog.to_regprocedure('tmpos_invoice_credit_note.m7b_invoice_credit_note_registration_proof_message(uuid, uuid, uuid, uuid, uuid, uuid, bytea, bigint, bigint, text)'),
    pg_catalog.to_regprocedure('tmpos_invoice_credit_note.m7b_invoice_credit_note_prerequisites()')]::oid[];
begin
  if v_owner is null
     or exists (select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'tmpos_invoice_credit_note'
                   and p.proname in ('m7b_store_credit_activity', 'm7b_store_credit_activity_prerequisites')) then
    raise exception 'migration 039 rollback refused: a function migration 039 created still exists, or 038''s schema is missing'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- A missing table or routine is a NULL in its array, matches no row and refuses.
  if (select pg_catalog.count(*) from pg_catalog.pg_class c
       where c.oid = any (v_tables) and c.relkind in ('r', 'p') and c.relowner = v_owner) <> 4 then
    raise exception 'migration 039 rollback refused: a table of migration 038 is missing, is not an ordinary table or is not owned by the owner of schema tmpos_invoice_credit_note'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if (select pg_catalog.count(*) from pg_catalog.pg_proc p
       where ((p.oid = any (v_stable) and p.provolatile = 's') or (p.oid = any (v_volatile) and p.provolatile = 'v'))
         and p.proowner = v_owner and p.prosecdef) <> 10 then
    raise exception 'migration 039 rollback refused: a routine of migration 038 is missing, is not owned by the owner of schema tmpos_invoice_credit_note, is not SECURITY DEFINER or does not have the volatility 038 declared'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if (select pg_catalog.count(*) from pg_catalog.pg_proc p where p.oid = any (v_owners)) <> 9 then
    raise exception 'migration 039 rollback refused: a function of migration 038 is missing'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- Each with exactly its approved ACL: the ten, the owner's and tmpos_app's EXECUTE (postgresStartupPreflight.ts
  -- APPROVED_ROLE_GRANTS); the nine, the owner's alone.
  foreach v_fn in array v_stable || v_volatile || v_owners
  loop
    if (select pg_catalog.string_agg(pg_catalog.format('%s/%s/%s/%s', case when g.grantee = p.proowner then 'owner' else g.grantee::regrole::text end,
                                                       g.privilege_type, g.is_grantable, g.grantor = p.proowner), ';'
                                     order by case when g.grantee = p.proowner then 'owner' else g.grantee::regrole::text end collate "C")
          from pg_catalog.pg_proc p, pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g
         where p.oid = v_fn)
       is distinct from case when v_fn = any (v_owners) then 'owner/EXECUTE/f/t' else 'owner/EXECUTE/f/t;tmpos_app/EXECUTE/f/t' end then
      raise exception 'migration 039 rollback refused: a routine of migration 038 does not carry exactly its approved grants'
        using errcode = 'object_not_in_prerequisite_state';
    end if;
  end loop;
end
$$;

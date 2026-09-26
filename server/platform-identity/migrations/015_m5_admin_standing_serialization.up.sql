-- Phase 4.0 M5 — changer-side standing serialization: every change to an administrator's standing waits for a command
-- or login that holds the actor's account, in replica mode too (M5-ADMIN-REVOKE-P1; G-IAM, G-CPLOGIN; docs/phase-4/04 §2, §5)
-- Migration: 015_m5_admin_standing_serialization (UP)
--
-- SCOPE / TRUTH (binding):
--   - ONE TRIGGER FUNCTION, THREE TRIGGERS, NO TABLE, NO GRANT, NO ROLE, NO DATA CHANGE. This file creates the trigger
--     function tmpos_admission.m5_platform_standing_serialize — in migration 013's schema, beside the version trigger it
--     orders itself before — and fires it BEFORE ROW from public.platform_identity (UPDATE, DELETE), public.identity_link
--     (INSERT, UPDATE) and public.user_membership (INSERT, UPDATE). It creates no table, no type, no role and no sequence,
--     grants nothing to anyone, moves no row and touches no session. Its only change to objects earlier migrations created
--     is those three triggers: migrations 001-014 are untouched, byte for byte.
--   - WHY A MIGRATION IS NEEDED AT ALL. A command (009's m5_revalidate_platform_authority) and an administrative login
--     hold the actor's account row FOR UPDATE, its identity links and every grant FOR SHARE, until they COMMIT; they read
--     the actor's standing under those locks. A change to that standing that must lock one of those rows is therefore
--     either committed before the read and seen, or waits for the COMMIT: an account write (the row itself), a grant or a
--     link of the actor disabled, removed or changed (its row). Every other change moves the witness an administrative
--     session is bound to (013) without touching one of those rows, and so needs a lock on the account that 009's
--     FOR UPDATE refuses:
--       (i)   the ANCHOR repointed — an UPDATE of public.platform_identity's auth_provider or auth_provider_uid. No key of
--             app_user moves, and the account's foreign key names only internal_user_id, so the write never reaches it;
--       (ii)  a LINK inserted for the actor, or an existing link re-pointed to it. public.identity_link's foreign keys name
--             public.platform_identity, not public.app_user, so their checks lock anchor rows only (009's header names
--             this gap);
--       (iii) a GRANT inserted for the actor, or an existing grant re-pointed to it, and the ANCHOR deleted. In an
--             ordinary session the grant's foreign key takes FOR KEY SHARE on the account and the anchor's cascade
--             deletes it, so both already wait — the argument 009's header rests on. But a session running as a REPLICA
--             (session_replication_role = replica) runs no foreign-key check and no cascade at all, so there neither
--             waits.
--     None can be closed from the runtime side: its role holds no privilege on public.platform_identity, and an anchor
--     lock taken after the account deadlocks with an anchor DELETE, whose cascade reaches the account from the other end.
--     So the CHANGER serializes itself instead: before its row is written, it takes FOR KEY SHARE on the account row of
--     each actor the write moves, and so waits for the command or login that holds it, and is seen by any that starts
--     after it commits. Nothing else in 001-014 could do this.
--   - WHY FOR KEY SHARE ON THE ACCOUNT. It is the weakest row lock there is, and it conflicts with FOR UPDATE alone:
--     009's hold, and a DELETE or key change of the account itself. An ordinary account write — its status, its display
--     name — takes FOR NO KEY UPDATE and is not blocked by it, nor does it block one; 007's tenant-plane revalidation
--     holds the account FOR SHARE, which it does not conflict with either; two changers of one account share it. It is
--     exactly the lock a grant's foreign key takes on the account, so every gap closes by the argument 009 already makes.
--   - WHY BEFORE. A BEFORE ROW trigger runs after its own row is locked (an UPDATE or a DELETE) or before it exists (an
--     INSERT), and before 013's AFTER ROW trigger upserts the actor's version row and before any foreign-key check or
--     cascade runs at the end of the statement, so every changer takes its rows in one order: its own row, then the
--     account (here), then the version row (013) and whatever its foreign keys reach. The runtime never locks
--     public.platform_identity or the version row, and takes the account before the links and grants, so no changer
--     waiting here holds a row the command it waits for will ask for next, whatever order its foreign-key checks later
--     run in. A missing account is nothing to lock: resolution refuses an actor that has none.
--   - WHAT EACH WRITE LOCKS.
--       * public.platform_identity UPDATE that changes internal_user_id, auth_provider or auth_provider_uid: the accounts
--         of the actor before and after the write (one actor, unless the primary key itself moves), in uuid order, so two
--         changers of one pair take them alike. The anchor row is in no lock set the runtime holds, so taking the account
--         after it reverses no order. Its email and display name mirror the provider's profile, decide nothing (013), and
--         lock nothing here: the identity sync never waits on a command.
--       * public.platform_identity DELETE: the account of the actor it removes — the lock its cascade would take at the
--         end of the statement, taken first, and taken in replica mode, where no cascade runs.
--       * public.identity_link and public.user_membership INSERT: the account of the actor the row names.
--       * public.identity_link and public.user_membership UPDATE that changes internal_user_id: the account of the actor
--         the row now names, and NOT the one it named. The row is that previous actor's own link or grant — 009 holds it
--         FOR SHARE once it holds that actor's account, and the changer already holds it (its UPDATE locked it) — so a
--         command of the previous actor already serializes on the row, and locking that actor's account after it would
--         reverse 009's order (account, then links and grants) into a deadlock. Any other UPDATE of either table changes a
--         row 009 holds and needs nothing here; so does a DELETE of either, and so does every write to public.app_user.
--       * public.platform_identity INSERT: nothing — there is no account yet.
--   - EVERY SCOPE OF GRANT, NOT ONLY THE PLATFORM'S. The admission witness reads platform grants only, but 009 locks every
--     grant of the actor, and 007's resolution — which admission calls — refuses an actor holding more than 200 usable
--     grants across every scope, so a tenant or store grant inserted for the actor can change what admission answers.
--     Locking for every scope adds no wait in an ordinary session (the foreign key takes the same lock there) and no
--     cycle: the only lock it conflicts with is 009's FOR UPDATE, which is taken first in every runtime transaction.
--   - ROW SECURITY. The lock is taken by the function's owner (SECURITY DEFINER, as 009's routine is), and it can lock
--     only rows it can see. public.app_user has row security enabled with no policy, so this relies — exactly as 009's
--     definer does — on that owner being the table's owner and on FORCE ROW LEVEL SECURITY being off: forced, the owner
--     would see no row and the lock would silently serialize nothing. Section 4 refuses to finish otherwise.
--   - ALWAYS, as 013's triggers are: a session running as a replica serializes too — the one mode in which the foreign-key
--     checks and cascades above do not run at all, and the reason this file places triggers on grants and anchor deletes.
--   - CONCURRENCY. The only new wait is a changer of these three tables on an account row. A changer waits no longer than
--     the command or login it waits for, which the runtime bounds by its own deadline; and a changer transaction that
--     already holds another row of the same actor that 009 locks (its account, a link or a grant, written earlier in the
--     same transaction) can still meet a command in the opposite order, as 009 and 013 already say: PostgreSQL detects
--     the deadlock and aborts one side, which commits nothing and may be retried. No routine of 001-014 writes any of the
--     three tables, so no runtime command or login gains a lock it did not already take. Applying this file (and rolling
--     it back) holds a SHARE ROW EXCLUSIVE lock or stronger on public.platform_identity, public.identity_link and
--     public.user_membership until its transaction ends: writes to them — the identity sync, provisioning — wait for it;
--     reads go through.
--   - THE RUNTIME NEVER CALLS IT. The function is granted to nobody, tmpos_app included: a trigger function fires without
--     an EXECUTE grant and cannot be called directly. It runs as its owner because a writer of the three tables need not
--     hold the UPDATE privilege on public.app_user that a row lock requires; it reads only the row it is handed, writes
--     nothing and returns that row unchanged, so running as the owner grants the writer nothing. Section 4 proves it.
--   - NO SECRET, NO DYNAMIC SQL, NO EXTENSION, NO TEMPORARY OBJECT. Every statement is fixed text, every relation and
--     routine schema-qualified, and the routine pins its search_path to pg_catalog then pg_temp.
--
-- Reversible via 015_m5_admin_standing_serialization.down.sql, which removes exactly the three triggers and the function.
-- It needs no guard: removing the serialization admits no session and repeats no witness — 013 still moves the version
-- on every such write, and the next request of an affected session is refused by it — it only lets a command or login
-- already under way commit once more after such a change, as before this file. 013's rollback cannot run beneath this
-- file: it drops schema tmpos_admission without CASCADE, which refuses while this function lives there.
--
-- Assumes 001-014 are applied. A future managed apply targets the complete contiguous chain through the newest committed
-- migration — now 001-015 (owner decision D4); this file authorizes no apply.

-- =============================================================================
-- 0) This transaction's search path
-- =============================================================================
set local search_path = pg_catalog, pg_temp;

-- =============================================================================
-- 1) Preconditions: what this file builds on
-- =============================================================================
do $$
begin
  -- The chain is contiguous: 014 is the newest migration this file sits on.
  if pg_catalog.to_regprocedure('tmpos_rate_limit.m6_rate_limit_reclaim()') is null then
    raise exception 'migration 015 refused: migration 014 must be applied first'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- 013's schema holds this function, beside the version trigger it orders itself before.
  if pg_catalog.to_regprocedure('tmpos_admission.m5_platform_authority_moved()') is null then
    raise exception 'migration 015 refused: migration 013 must be applied first'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- The function this file creates is owned by whoever applies it, and section 4 requires every routine of the schema to
  -- be the schema owner's, as 013 does: a member of that owner, even one that may act as it, would create it under its
  -- own name. Refused here, before anything is created, rather than at the postcondition.
  if (select n.nspowner from pg_catalog.pg_namespace n where n.nspname = 'tmpos_admission')
     is distinct from (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user) then
    raise exception 'migration 015 refused: the applying principal does not own schema tmpos_admission, so the trigger function it creates would not pass the ownership postcondition'
      using errcode = 'insufficient_privilege',
            hint = 'apply as the role that owns schema tmpos_admission (the one that applied migration 013)';
  end if;
  -- 009's hold on the account is what the changers here are made to wait behind.
  if pg_catalog.to_regprocedure('tmpos_command.m5_revalidate_platform_authority(uuid, text, uuid, text)') is null then
    raise exception 'migration 015 refused: migration 009 must be applied first'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- The runtime role section 4 withholds the function from (005).
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'tmpos_app') then
    raise exception 'migration 015 refused: migration 005 must be applied first'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- The triggers are placed on three tables and lock rows of a fourth, which only their owner may be relied on to do;
  -- and they must be this principal's, so no one else's trigger answers for the order.
  if exists (
    select 1
      from pg_catalog.pg_class c
     where c.oid in ('public.platform_identity'::regclass, 'public.identity_link'::regclass,
                     'public.user_membership'::regclass, 'public.app_user'::regclass)
       and not pg_catalog.pg_has_role(current_user, c.relowner, 'USAGE')) then
    raise exception 'migration 015 refused: the applying principal does not own public.platform_identity, public.identity_link, public.user_membership and public.app_user, so it cannot place the triggers or take the account locks they need'
      using errcode = 'insufficient_privilege';
  end if;
end
$$;

-- =============================================================================
-- 2) The trigger function
-- =============================================================================
-- A field of OLD or NEW is read only inside an IF branch whose table and TG_OP guarantee it, 013's rule: an IF condition
-- is one SQL expression, and SQL promises no left-to-right short circuit. Any firing this file does not declare — another
-- table, another event, AFTER, or FOR EACH STATEMENT — raises rather than guessing: a BEFORE trigger that returned the
-- wrong row would silently cancel or alter a write. A DELETE returns OLD, every other firing NEW: a BEFORE DELETE
-- trigger that returned NEW (null) would skip the delete.
create function tmpos_admission.m5_platform_standing_serialize()
returns trigger
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_first  uuid;  -- an actor whose account the write must wait behind (null: none)
  v_second uuid;  -- a second one, only when an anchor's primary key moves from one actor to another (null: none)
begin
  if tg_when is distinct from 'BEFORE' or tg_level is distinct from 'ROW' or tg_table_schema is distinct from 'public' then
    raise exception 'm5_platform_standing_serialize: fired by an undeclared trigger'
      using errcode = 'triggered_action_exception';
  end if;

  if tg_table_name = 'platform_identity' and tg_op = 'UPDATE' then
    if row(new.internal_user_id, new.auth_provider, new.auth_provider_uid)
       is distinct from row(old.internal_user_id, old.auth_provider, old.auth_provider_uid) then
      v_first := old.internal_user_id;
      v_second := new.internal_user_id;
    end if;
  elsif tg_table_name = 'platform_identity' and tg_op = 'DELETE' then
    v_first := old.internal_user_id;
  elsif tg_table_name in ('identity_link', 'user_membership') and tg_op = 'INSERT' then
    v_first := new.internal_user_id;
  elsif tg_table_name in ('identity_link', 'user_membership') and tg_op = 'UPDATE' then
    if new.internal_user_id is distinct from old.internal_user_id then
      v_first := new.internal_user_id;
    end if;
  else
    raise exception 'm5_platform_standing_serialize: fired by an undeclared trigger'
      using errcode = 'triggered_action_exception';
  end if;

  -- The account rows, in uuid order (the locking step runs above the sort), each FOR KEY SHARE. A null names nobody.
  if v_first is not null or v_second is not null then
    perform 1
       from public.app_user u
      where u.internal_user_id operator(pg_catalog.=) any (array[v_first, v_second])
      order by u.internal_user_id
        for key share;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end
$$;

comment on function tmpos_admission.m5_platform_standing_serialize() is
  'Phase 4.0 M5 (migration 015): BEFORE row trigger on public.platform_identity (UPDATE, DELETE), public.identity_link and public.user_membership (INSERT, UPDATE). Takes FOR KEY SHARE on the account (public.app_user) of each actor an anchor change or delete, or a link or grant insert or re-point, moves — the accounts before and after an anchor change; the account an anchor delete removes; the account a link or grant now names — in uuid order, so the write waits for a command or login holding that account FOR UPDATE (009), in replica mode too. Writes nothing; returns the row unchanged. Granted to nobody.';

-- =============================================================================
-- 3) The triggers
-- =============================================================================
create trigger trg_platform_identity_standing_serialize
  before update or delete on public.platform_identity
  for each row execute function tmpos_admission.m5_platform_standing_serialize();
create trigger trg_identity_link_standing_serialize
  before insert or update on public.identity_link
  for each row execute function tmpos_admission.m5_platform_standing_serialize();
create trigger trg_user_membership_standing_serialize
  before insert or update on public.user_membership
  for each row execute function tmpos_admission.m5_platform_standing_serialize();

-- ALWAYS, as 013's are: a changer running as a replica waits too.
alter table public.platform_identity enable always trigger trg_platform_identity_standing_serialize;
alter table public.identity_link enable always trigger trg_identity_link_standing_serialize;
alter table public.user_membership enable always trigger trg_user_membership_standing_serialize;

-- =============================================================================
-- 4) Privileges, and the proof that nothing wider was issued
-- =============================================================================
-- PostgreSQL grants EXECUTE on a new function to PUBLIC by default; the trigger function is granted to nobody.
revoke all on function tmpos_admission.m5_platform_standing_serialize() from public, anon, authenticated, tmpos_app;

-- The postcondition, proven rather than asserted, in the form 013 and 014 use. This file refuses to finish unless, at
-- this moment:
--   * schema tmpos_admission holds exactly 013's two routines and this file's one;
--   * this file's routine is owned by the schema's owner, plpgsql, returns trigger, SECURITY DEFINER, VOLATILE and
--     pinned to the search path above;
--   * it carries no grant beyond its owner's, no runtime-facing role can execute it by any path, and none is a member of
--     its owner;
--   * it can see every account row: public.app_user does not FORCE ROW LEVEL SECURITY, and the routine's owner acts as
--     that table's owner (or bypasses row security);
--   * it is called by exactly the three triggers section 3 declares — BEFORE ROW UPDATE or DELETE on
--     public.platform_identity, BEFORE ROW INSERT or UPDATE on public.identity_link and on public.user_membership — each
--     enabled ALWAYS, with no column list and no WHEN condition, and by no other.
-- The ACL is read through coalesce(acl, acldefault(kind, owner)), because a NULL ACL means PostgreSQL's built-in default
-- (for a routine, EXECUTE to PUBLIC) and aclexplode(NULL) yields nothing.
--
-- WHAT THIS DOES NOT PROVE. It is a snapshot at apply time, not a standing guarantee: a later DDL statement outside these
-- migrations could add a grant, disable a trigger or force row security (only the owner of its table can).
do $$
declare
  v_owner oid;
  v_fn oid := 'tmpos_admission.m5_platform_standing_serialize()'::regprocedure;
  v_bad text;
  v_roles name[] := array['tmpos_app', 'tmpos_audit_writer', 'anon', 'authenticated']::name[];
begin
  select n.nspowner into v_owner from pg_catalog.pg_namespace n where n.nspname = 'tmpos_admission';

  select pg_catalog.string_agg(p.proname::text, ', ' order by p.proname) into v_bad
    from pg_catalog.pg_proc p
   where p.pronamespace = 'tmpos_admission'::regnamespace
     and p.proname not in ('m5_admit_platform_session', 'm5_platform_authority_moved', 'm5_platform_standing_serialize');
  if v_bad is not null
     or (select pg_catalog.count(*) from pg_catalog.pg_proc p where p.pronamespace = 'tmpos_admission'::regnamespace) <> 3 then
    raise exception 'migration 015 refused: schema tmpos_admission does not hold exactly 013''s two routines and this file''s one'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  if not exists (
    select 1
      from pg_catalog.pg_proc p
     where p.oid = v_fn
       and p.proowner = v_owner
       and p.prosecdef
       and p.provolatile = 'v'
       and p.proconfig is not distinct from array['search_path=pg_catalog, pg_temp']::text[]
       and p.prorettype = 'pg_catalog.trigger'::regtype
       and p.prolang = (select l.oid from pg_catalog.pg_language l where l.lanname = 'plpgsql')) then
    raise exception 'migration 015 refused: m5_platform_standing_serialize does not match its declaration'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  select pg_catalog.string_agg(pg_catalog.format('%s:%s', g.grantee::regrole::text, g.privilege_type), ', ')
    into v_bad
    from pg_catalog.pg_proc p,
         pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g
   where p.oid = v_fn
     and g.grantee <> p.proowner;
  if v_bad is not null then
    raise exception 'migration 015 refused: an unexpected direct grant remains on m5_platform_standing_serialize (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state',
            hint = 'the trigger function is granted to nobody';
  end if;

  select pg_catalog.string_agg(r.rolname::text, ', ' order by r.rolname) into v_bad
    from pg_catalog.pg_roles r
   where r.rolname = any (v_roles)
     and (pg_catalog.has_function_privilege(r.oid, v_fn, 'EXECUTE') or pg_catalog.pg_has_role(r.oid, v_owner, 'MEMBER'));
  if v_bad is not null then
    raise exception 'migration 015 refused: % can execute m5_platform_standing_serialize or is a member of its owner', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- Row security: the owner-run lock must see every account row, or it serializes nothing and says nothing.
  if exists (
    select 1
      from pg_catalog.pg_class c, pg_catalog.pg_proc p, pg_catalog.pg_roles r
     where c.oid = 'public.app_user'::regclass
       and p.oid = v_fn
       and r.oid = p.proowner
       and (c.relforcerowsecurity
            or not (pg_catalog.pg_has_role(p.proowner, c.relowner, 'USAGE') or r.rolbypassrls))) then
    raise exception 'migration 015 refused: row level security would hide public.app_user rows from m5_platform_standing_serialize (FORCE ROW LEVEL SECURITY is set, or the routine''s owner does not act as the table''s owner)'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- The triggers: exactly three call the function, each this file's, BEFORE ROW (tgtype ROW 1 + BEFORE 2, then DELETE 8
  -- + UPDATE 16 for the anchor = 27, INSERT 4 + UPDATE 16 for the link and the grant = 23; TRUNCATE and INSTEAD OF
  -- absent), enabled ALWAYS, with no column list and no WHEN condition that could narrow them.
  if (select pg_catalog.count(*) from pg_catalog.pg_trigger g where g.tgfoid = v_fn) <> 3
     or (select pg_catalog.count(*)
           from pg_catalog.pg_trigger g
           join (values ('public.platform_identity'::regclass, 'trg_platform_identity_standing_serialize'::name, 27::int2),
                        ('public.identity_link'::regclass, 'trg_identity_link_standing_serialize'::name, 23::int2),
                        ('public.user_membership'::regclass, 'trg_user_membership_standing_serialize'::name, 23::int2))
                as d(rel, tgname, tgtype)
             on g.tgrelid = d.rel and g.tgname = d.tgname
          where g.tgfoid = v_fn
            and g.tgtype = d.tgtype
            and g.tgenabled = 'A'
            and g.tgattr = ''::pg_catalog.int2vector
            and g.tgqual is null
            and not g.tgisinternal) <> 3 then
    raise exception 'migration 015 refused: the serialization triggers are not exactly the three section 3 declares'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$$;

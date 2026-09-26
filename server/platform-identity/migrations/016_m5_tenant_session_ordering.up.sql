-- Phase 4.0 M5 — tenant session ordering: a monotonic tenant witness for every standing change, and the hold a tenant
-- login takes on the actor's standing until it commits (M5-TENANT-SESSION-P1; G-IAM, DA-41; docs/phase-4/10 ADR-31)
-- Migration: 016_m5_tenant_session_ordering (UP)
--
-- SCOPE / TRUTH (binding):
--   - ONE COLUMN, ONE TABLE, TWO TRIGGER FUNCTIONS, FIVE TRIGGERS, TWO ROUTINES, TWO GRANTS, NO ROLE. This file adds
--     public.store.access_version; the per-actor tenant grant version tmpos_session.tenant_grant_version; the trigger
--     function that moves a tenant's or a store's access version, fired BEFORE UPDATE from public.tenant and BEFORE INSERT
--     or UPDATE from public.store; the trigger function that moves the grant version, fired AFTER every write to
--     public.user_membership and AFTER every DELETE from public.tenant and public.store; the second tenant admission read,
--     m5_admit_tenant_session_v2; and m5_hold_tenant_standing, the lock a tenant login holds. It grants EXECUTE on the two
--     routines to tmpos_app and nothing else to anyone. It creates no role, no type and no schema: everything lands in
--     011's tmpos_session, whose rollback drops that schema WITHOUT CASCADE and so refuses while this file is applied. Its
--     only changes to objects earlier migrations created are that column and those five triggers: migrations 001-015 are
--     untouched, byte for byte. 011's m5_admit_tenant_session stays, and stays granted.
--   - WHY A MIGRATION IS NEEDED AT ALL. A tenant session is bound to 011's witness — 007's filtered standing plus each
--     grant's tenant access version (010) — and refused the moment it moves, so it must move on EVERY change to that
--     standing and never return to a value it has held. Four changes return it (doc 08 DA-41): a grant disabled and
--     re-enabled, and a store suspended and reactivated, leave 007's answer byte-identical, and no store carries a version;
--     a tenant status written by anyone but 010's command moves no access version; and an account or link changed and
--     changed back as a replica, or an anchor repointed and back, leaves 007's timestamp digest where it was. So do a store
--     moved to another tenant and back (007 drops its grants while it is away), a tenant's or a store's key changed as a
--     replica — and back, or with a row inserted again under the old one — and a tenant or store row deleted and inserted
--     again as a replica, where no cascade takes the grants that name it. Nor is a login ordered against a revocation: its
--     admission is read in one transaction and its session written in another, so a standing change committed between
--     them still yields a committed session. Nothing in 001-015 gives either.
--   - WHAT MOVES WHAT.
--       * public.tenant.access_version and public.store.access_version: +1 on EVERY UPDATE that changes the row's status
--         or, for a store, its tenant_id, whoever makes it, as a replica too; any other change of the version is refused.
--         010's command sets the version to itself plus one with the status, which this trigger assigns again: it still
--         moves exactly once. A store INSERT starts at one, whatever it names.
--       * A KEY NEVER CHANGES: an UPDATE of a tenant's tenant_id or a store's store_id is refused, whoever makes it, as a
--         replica too. A version cannot follow its key: the row moved to a new key takes its version with it, and a row
--         inserted under the old one — a store at one, a tenant at whatever its INSERT names — would answer a grant still
--         naming that key with the version it was admitted at. A key is retired by deleting its row, which moves the grant
--         version of every actor holding a grant that names it (below).
--       * tmpos_session.tenant_grant_version: +1 for each actor whose TENANT- or STORE-scope grant a write inserts,
--         deletes (cascades from a tenant, a store or an account included) or changes in any column but updated_at — the
--         actor on each side of the write, once when both sides name one actor. A platform grant moves 013's version.
--         And +1, once per actor, for each actor holding a tenant- or store-scope grant of any status that names a tenant
--         or a store being DELETED: as a replica no cascade takes those grants, and they would return with a row inserted
--         again under that key. In an ordinary session the cascade has already removed them, each moving its actor, so
--         this move finds none (were it to find one, a second move would be harmless).
--       * the account, its links and its anchor move 013's platform authority version, which v2 answers beside the grant
--         version, so the tenant witness moves for them too, and a replica-mode round trip no longer returns it.
--   - WHY NO FOREIGN KEY on the grant version, 013's reasoning: the counter outlives the account it counts, so an actor
--     deleted and recreated under the same internal_user_id continues from its last value rather than meeting an old
--     witness at one. Nothing reads it but v2, keyed by the actor.
--   - THE RUNTIME NEVER MOVES A VERSION. tmpos_app receives EXECUTE on v2 and on the hold, nothing on the table or a
--     trigger function, and no way to UPDATE a tenant's or a store's status, version or key or a store's tenant, to INSERT
--     a tenant, to DELETE or TRUNCATE a tenant or a store, or to TRUNCATE public.user_membership or place a trigger of its
--     own on any of the three. 005's table-wide
--     SELECT and INSERT on public.store stay, and reach the new column: reading a version grants nothing, and a row the
--     runtime inserts starts at one whatever its INSERT names (the trigger overwrites it, as 008 overwrites row_version),
--     so it can place no store at the bound, where its first suspension would raise for good. It is a new store no grant
--     names yet, so no witness carries it; the grant that later names it moves the grant version. Section 8 proves the
--     rest.
--   - WHAT v2 ANSWERS. Exactly 011's read — the same refusal row, the same call to 007 INTO STRICT, the same order, the
--     same RAISE for a tenant grant with no readable tenant access version — plus a store access version on each grant
--     (null exactly when the grant names no store, a RAISE when it names one this routine cannot read), the actor's
--     platform authority version and its tenant grant version, all in one snapshot. It decides no authority.
--   - THE HOLD (ADR-31, the linearization point). A tenant login or recent sign-in commits its session in ONE transaction
--     whose first step is m5_hold_tenant_standing: the actor's account FOR UPDATE, then its links, EVERY grant (any scope,
--     any status), every tenant a grant names and every store a grant names, each FOR SHARE in key order; then, in a later
--     statement of the same READ COMMITTED transaction — a snapshot taken after every lock was granted — it re-reads v2
--     and commits only if the witness is the one the login was admitted at. A standing change committed before that read
--     is seen; one not yet committed waits for the COMMIT: an account write (its row), a link or grant of the actor
--     changed or removed (its row), one inserted or re-pointed to the actor (its foreign key's KEY SHARE, and 015's
--     trigger as a replica), an anchor changed or removed (015's trigger), a tenant or store written — 010's command
--     included — or deleted (its row, or the cascade). The hold reads nothing it answers with and decides nothing:
--     'absent' when no anchor or no account resolves, 'held' otherwise.
--   - CONCURRENCY. The grant trigger upserts one row per actor, so two transactions changing one actor's tenant or store
--     grants serialize on it; beside 013's row it is always taken second. A tenant or store deleted as a replica takes the
--     rows of the actors it moves in internal_user_id order; in an ordinary session the cascade moves them one grant at a
--     time in its own order, as any multi-row grant write does, so two such writes naming the same actors in opposite
--     orders can deadlock, and PostgreSQL aborts one, which commits nothing. A writer that in one transaction changes a
--     tenant or store row and then a grant of the same actor — or any multi-row write in the opposite order to the
--     hold's — can deadlock with a login holding that grant and waiting for that row; PostgreSQL aborts one side, which
--     commits nothing: the login answers 503, or the writer's change is rolled back while the login's standing was
--     current. No routine of 001-015 writes public.user_membership, and the only runtime write to public.tenant or
--     public.store that waits here is 010's status command, which now waits for a login holding that tenant (a runtime
--     store INSERT, started at one, waits for no login: its foreign key's KEY SHARE admits the hold's FOR SHARE).
--     Applying this file (and rolling it back) holds SHARE ROW EXCLUSIVE on 011's session table until its transaction
--     ends — every login and logout of either audience waits; reads go through — and ACCESS EXCLUSIVE on public.store
--     for the column. It takes the session table
--     first, as 013 does, and the three tables after it, the opposite of a login's order (a command's is the same as
--     this file's): a login that already holds its standing when this file starts can deadlock with it, and PostgreSQL
--     aborts one side, which commits nothing — the login answers 503, or this file is run again.
--   - WHAT THIS DOES NOT CLOSE. The owner can still write the version table, or disable or drop these triggers (only the
--     owner of their table can), and with them the refusal of a key change. Both are owner writes, outside every role
--     these migrations grant. 010's and 013's
--     rollbacks do not see this file: the chain rolls back newest first (owner decision D4), and beneath it every tenant
--     update, or every v2 read, raises.
--   - NO SECRET, NO DYNAMIC SQL, NO EXTENSION, NO TEMPORARY OBJECT. Every statement is fixed text, every value a
--     parameter, every relation and routine schema-qualified, and every routine pins its search_path to pg_catalog then
--     pg_temp.
--
-- Reversible via 016_m5_tenant_session_ordering.down.sql, which REFUSES while any tenant session exists — those rows are
-- the only place a witness lives, and a rollback followed by a re-application restarts every store version at one and
-- every grant version at zero, where an old witness could be met again — and otherwise removes exactly what this file
-- created. This file refuses likewise (section 1), so a session committed by a login racing the rollback cannot cross it.
--
-- Assumes 001-015 are applied. A future managed apply targets the complete contiguous chain through the newest committed
-- migration — now 001-016 (owner decision D4); this file authorizes no apply.

-- =============================================================================
-- 0) This transaction's search path
-- =============================================================================
set local search_path = pg_catalog, pg_temp;

-- =============================================================================
-- 1) Preconditions: what this file builds on
-- =============================================================================
do $$
declare
  v_live bigint;
begin
  -- The chain is contiguous: 015 is the newest migration this file sits on.
  if pg_catalog.to_regprocedure('tmpos_admission.m5_platform_standing_serialize()') is null then
    raise exception 'migration 016 refused: migration 015 must be applied first'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- 011's schema, session table and admission read, which v2 restates.
  if pg_catalog.to_regclass('tmpos_session.session') is null
     or pg_catalog.to_regprocedure('tmpos_session.m5_admit_tenant_session(text, text)') is null then
    raise exception 'migration 016 refused: migration 011 must be applied first'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- 013's platform authority version, which v2 answers, and which this file's owner must be able to read.
  if pg_catalog.to_regclass('tmpos_admission.platform_authority_version') is null then
    raise exception 'migration 016 refused: migration 013 must be applied first'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if not pg_catalog.has_table_privilege(current_user, 'tmpos_admission.platform_authority_version', 'SELECT') then
    raise exception 'migration 016 refused: the applying principal cannot read migration 013''s platform authority version, so v2 could not answer it'
      using errcode = 'insufficient_privilege';
  end if;
  -- 010's tenant access version, which the trigger below now moves on every status change.
  if not exists (select 1 from pg_catalog.pg_attribute a
                  where a.attrelid = 'public.tenant'::regclass and a.attname = 'access_version' and not a.attisdropped) then
    raise exception 'migration 016 refused: migration 010 must be applied first'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- 007's resolution is the one definition of an actor's grants; v2 runs as this file's owner and calls it.
  if pg_catalog.to_regprocedure('tmpos_identity.m5_resolve_principal(text, text)') is null
     or not pg_catalog.has_function_privilege(current_user, 'tmpos_identity.m5_resolve_principal(text, text)', 'EXECUTE') then
    raise exception 'migration 016 refused: the applying principal cannot execute migration 007''s resolution, so v2 could not answer'
      using errcode = 'insufficient_privilege';
  end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'tmpos_app') then
    raise exception 'migration 016 refused: migration 005 must be applied first'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- Section 7 requires every routine of tmpos_session to be the schema owner's, as 011 made them: a member of that owner
  -- would create these under its own name. Refused here, before anything is created, as 015 does for its schema.
  if (select n.nspowner from pg_catalog.pg_namespace n where n.nspname = 'tmpos_session')
     is distinct from (select r.oid from pg_catalog.pg_roles r where r.rolname = current_user) then
    raise exception 'migration 016 refused: the applying principal does not own schema tmpos_session, so the routines it creates would not pass the ownership postcondition'
      using errcode = 'insufficient_privilege',
            hint = 'apply as the role that owns schema tmpos_session (the one that applied migration 011)';
  end if;
  -- The triggers are placed on three tables, the column added to one, and the hold locks and reads rows of six, which
  -- only their owner may be relied on to do; and they must be this principal's, so no one else's trigger answers.
  if exists (
    select 1
      from pg_catalog.pg_class c
     where c.oid in ('public.tenant'::regclass, 'public.store'::regclass, 'public.user_membership'::regclass,
                     'public.app_user'::regclass, 'public.identity_link'::regclass, 'public.platform_identity'::regclass,
                     'tmpos_session.session'::regclass)
       and not pg_catalog.pg_has_role(current_user, c.relowner, 'USAGE')) then
    raise exception 'migration 016 refused: the applying principal does not own public.tenant, public.store, public.user_membership, public.app_user, public.identity_link, public.platform_identity and tmpos_session.session'
      using errcode = 'insufficient_privilege';
  end if;
  -- FORCEd row security hides a table's rows from its owner too: the hold would lock nothing and v2 would read no version,
  -- so each would answer as though the actor held nothing. Refused here, as 010, 011 and 015 refuse it for their definers.
  if exists (
    select 1
      from pg_catalog.pg_class c
     where c.oid in ('public.tenant'::regclass, 'public.store'::regclass, 'public.user_membership'::regclass,
                     'public.app_user'::regclass, 'public.identity_link'::regclass, 'public.platform_identity'::regclass,
                     'tmpos_admission.platform_authority_version'::regclass)
       and c.relforcerowsecurity) then
    raise exception 'migration 016 refused: a table the hold or v2 reads forces row level security on its owner, so a definer would see none of its rows'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- NO TENANT SESSION MAY CROSS AN APPLICATION OF THIS FILE, 013's rule for its own audience. A witness is non-repeating
  -- only within one application: rolled back and applied again, every store version restarts at one and every grant
  -- version at zero, and while 016 is absent no write moves either. The rollback refuses while a tenant session exists,
  -- but a login that read its witness before the rollback can commit its row once the rollback's lock is released — so
  -- the application refuses too, under the same lock. Tenant sessions carry no platform witness of their own before this
  -- file, and the production entry composes no tenant boundary, so a first application normally finds none.
  lock table tmpos_session.session in share row exclusive mode;
  select pg_catalog.count(*) into v_live from tmpos_session.session s where s.audience = 'tenant';
  if v_live > 0 then
    raise exception 'migration 016 refused: % tenant session row(s) exist, and a witness issued before this application could be met again once its versions restart', v_live
      using errcode = 'object_not_in_prerequisite_state',
            hint = 'end them through the session boundary (logout, or tmpos_session.m5_session_revoke_principal), clear any rows that remain, then apply';
  end if;
end
$$;

-- =============================================================================
-- 2) The store access version
-- =============================================================================
-- 010's column, for a store. A constant default, so no row is rewritten and no row trigger fires; every existing store
-- starts at 1, which no session has been admitted against (no witness named a store version before this file).
alter table public.store
  add column access_version bigint not null default 1
    constraint store_access_version_chk check (access_version between 1 and 9007199254740991);

comment on column public.store.access_version is
  'Phase 4.0 M5 (migration 016): the store access version — the witness a store session is admitted against. Set to 1 by trg_store_access_version on every INSERT, whatever it names; moved by exactly one on every UPDATE that changes the store''s status or its tenant_id, and by nothing else (an UPDATE of its store_id is refused: a key never changes); a row never returns to a value it has held. No role may UPDATE it; tmpos_app keeps 005''s table-wide SELECT and INSERT.';

-- =============================================================================
-- 3) The trigger that moves the tenant and store access versions
-- =============================================================================
-- SECURITY INVOKER and granted to nobody, as 008's row-version trigger: it fires without an EXECUTE grant and reads no
-- relation. Any firing this file does not declare raises rather than guessing: a BEFORE trigger that returned the wrong
-- row would silently alter a write. It runs before 008's row-version trigger and 002's updated_at trigger (BEFORE triggers
-- fire in name order), and it changes access_version only when status or a store's tenant changed — a change of the row
-- itself — so 008's still moves row_version once; a change of the row's key it refuses outright. A field of OLD or NEW is
-- read only inside a branch whose table and TG_OP guarantee it.
create function tmpos_session.m5_access_version_moved()
returns trigger
language plpgsql
volatile
security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
  v_rekeyed boolean;  -- the UPDATE changed the row's key: a tenant's tenant_id, a store's store_id
  v_moved   boolean;  -- the UPDATE changed the row's status or, for a store, its tenant
begin
  if tg_when is distinct from 'BEFORE' or tg_level is distinct from 'ROW' or tg_table_schema is distinct from 'public'
     or not ((tg_table_name = 'tenant' and tg_op = 'UPDATE') or (tg_table_name = 'store' and tg_op in ('INSERT', 'UPDATE'))) then
    raise exception 'm5_access_version_moved: fired by an undeclared trigger'
      using errcode = 'triggered_action_exception';
  end if;

  -- A new store starts at one, whatever its INSERT named, as 008 overwrites any value named for row_version: no grant
  -- names it yet, and a version its writer chose could sit at the bound, where its first suspension would raise for good.
  if tg_op = 'INSERT' then
    new.access_version := 1;
    return new;
  end if;

  -- A store moved to another tenant and back would return 007's grants unchanged — so the move itself is a change of
  -- standing, as a status change is.
  if tg_table_name = 'tenant' then
    v_rekeyed := new.tenant_id is distinct from old.tenant_id;
    v_moved := new.status is distinct from old.status;
  else
    v_rekeyed := new.store_id is distinct from old.store_id;
    v_moved := new.status is distinct from old.status or new.tenant_id is distinct from old.tenant_id;
  end if;

  -- A KEY NEVER CHANGES. The row moved takes its version to the new key, and a row inserted under the old one starts
  -- again — a store at one, a tenant at whatever its INSERT names — so a grant still naming that key would read, from a
  -- row it was never admitted against, the version it was admitted at. As a replica no foreign key stops the move; this does.
  if v_rekeyed then
    raise exception 'm5_access_version_moved: a %.% row''s key never changes', tg_table_schema, tg_table_name
      using errcode = 'check_violation';
  end if;

  if v_moved then
    -- The CHECK would refuse the value too; this names the cause instead of a constraint.
    if old.access_version operator(pg_catalog.>=) 9007199254740991 then
      raise exception 'm5_access_version_moved: the % access version is at its bound', tg_table_name
        using errcode = 'numeric_value_out_of_range';
    end if;
    -- Whatever the UPDATE named for it, as 008 overwrites any value named for row_version.
    new.access_version := old.access_version operator(pg_catalog.+) 1;
  elsif new.access_version is distinct from old.access_version then
    raise exception 'm5_access_version_moved: the % access version moves only with its status or, for a store, its tenant', tg_table_name
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;

comment on function tmpos_session.m5_access_version_moved() is
  'Phase 4.0 M5 (migration 016): BEFORE UPDATE row trigger on public.tenant and BEFORE INSERT OR UPDATE row trigger on public.store. Sets a new store''s access_version to 1, whatever the INSERT named; moves access_version by exactly one on every UPDATE that changes status or a store''s tenant_id, whatever value the UPDATE named for it; refuses every UPDATE of the row''s key (a tenant''s tenant_id, a store''s store_id), and any other change of access_version. Reads no relation. Granted to nobody.';

create trigger trg_tenant_access_version
  before update on public.tenant
  for each row execute function tmpos_session.m5_access_version_moved();
create trigger trg_store_access_version
  before insert or update on public.store
  for each row execute function tmpos_session.m5_access_version_moved();

-- ALWAYS, as 008's and 013's are: a status written by a session running as a replica moves the version too.
alter table public.tenant enable always trigger trg_tenant_access_version;
alter table public.store enable always trigger trg_store_access_version;

-- =============================================================================
-- 4) The tenant grant version
-- =============================================================================
-- 013's platform authority version, for tenant- and store-scope grants. An actor with no row has version 0, which v2
-- reports as such; the first change writes 1. The bound is the runtime's safe-integer range.
create table tmpos_session.tenant_grant_version (
  internal_user_id uuid   primary key,
  grant_version    bigint not null
                   constraint tenant_grant_version_range_chk check (grant_version between 1 and 9007199254740991)
);

comment on table tmpos_session.tenant_grant_version is
  'Phase 4.0 M5 (migration 016): per-actor counter that only increases, moved by m5_tenant_grant_moved on every change to the actor''s tenant- or store-scope grants and on every delete of a tenant or store one of them names. No foreign key: it outlives the account it counts. Written only by that trigger function; read only by m5_admit_tenant_session_v2. No runtime role holds a privilege on it.';

revoke all on table tmpos_session.tenant_grant_version from public, anon, authenticated;

-- RLS with no policy, the posture 011 and 013 give their tables: the second layer for the day a later migration grants
-- a privilege here by mistake. The trigger and v2 run as the owner, whom RLS does not restrict (it is not forced).
alter table tmpos_session.tenant_grant_version enable row level security;

-- =============================================================================
-- 5) The trigger that moves it
-- =============================================================================
-- SECURITY DEFINER because it writes a table no writer of public.user_membership, public.tenant or public.store holds a
-- privilege on, and granted to nobody. It can only ever make a tenant session END — never admit one. On a grant it reads
-- nothing but the row it is handed, under 013's rules: an UPDATE that changes nothing but updated_at moves nothing, and a
-- field of OLD or NEW is read only inside an IF branch whose table and TG_OP guarantee it. A cascaded delete fires it like
-- any other (a tenant's, a store's or an account's), and ALWAYS makes a replica's write fire it too.
--
-- On a tenant or store DELETE it reads the grants that name the deleted key, any scope but platform, any status: as a
-- replica no cascade removes them, so a row inserted again under that key would return them with the witness they had.
-- Each actor moves once, in internal_user_id order. In an ordinary session the cascade has run first (a foreign key's
-- action triggers precede this one by name) and moved each actor as it removed the grant, so it finds none; were it to
-- find one, a second move would be harmless.
create function tmpos_session.m5_tenant_grant_moved()
returns trigger
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_before uuid;  -- the actor whose tenant or store grant the write changed, as the row stood before it (null: none)
  v_after  uuid;  -- the same, as the row stands after it (null: none)
begin
  if tg_when is distinct from 'AFTER' or tg_level is distinct from 'ROW' or tg_table_schema is distinct from 'public'
     or not (tg_table_name = 'user_membership'
             or (tg_table_name in ('tenant', 'store') and tg_op = 'DELETE')) then
    raise exception 'm5_tenant_grant_moved: fired by an undeclared trigger'
      using errcode = 'triggered_action_exception';
  end if;

  if tg_table_name = 'tenant' then
    insert into tmpos_session.tenant_grant_version as v (internal_user_id, grant_version)
    select distinct m.internal_user_id, 1::bigint
      from public.user_membership m
     where m.scope_type in ('tenant', 'store')
       and m.tenant_id operator(pg_catalog.=) old.tenant_id
     order by m.internal_user_id
    on conflict (internal_user_id)
      do update set grant_version = v.grant_version operator(pg_catalog.+) 1;
    return null;
  elsif tg_table_name = 'store' then
    insert into tmpos_session.tenant_grant_version as v (internal_user_id, grant_version)
    select distinct m.internal_user_id, 1::bigint
      from public.user_membership m
     where m.scope_type in ('tenant', 'store')
       and m.store_id operator(pg_catalog.=) old.store_id
     order by m.internal_user_id
    on conflict (internal_user_id)
      do update set grant_version = v.grant_version operator(pg_catalog.+) 1;
    return null;
  end if;

  if tg_op = 'UPDATE' then
    if (pg_catalog.to_jsonb(new) operator(pg_catalog.-) 'updated_at'::text)
       is not distinct from
       (pg_catalog.to_jsonb(old) operator(pg_catalog.-) 'updated_at'::text) then
      return null;
    end if;
  end if;

  if tg_op in ('UPDATE', 'DELETE') then
    if old.scope_type in ('tenant', 'store') then
      v_before := old.internal_user_id;
    end if;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    if new.scope_type in ('tenant', 'store') then
      v_after := new.internal_user_id;
    end if;
  end if;

  -- Once per actor: twice only when the write moved the grant from one actor to another.
  if v_before is not null then
    insert into tmpos_session.tenant_grant_version as v (internal_user_id, grant_version)
    values (v_before, 1)
    on conflict (internal_user_id)
      do update set grant_version = v.grant_version operator(pg_catalog.+) 1;
  end if;
  if v_after is not null and v_after is distinct from v_before then
    insert into tmpos_session.tenant_grant_version as v (internal_user_id, grant_version)
    values (v_after, 1)
    on conflict (internal_user_id)
      do update set grant_version = v.grant_version operator(pg_catalog.+) 1;
  end if;

  return null;
end
$$;

comment on function tmpos_session.m5_tenant_grant_moved() is
  'Phase 4.0 M5 (migration 016): AFTER row trigger on public.user_membership, and AFTER DELETE row trigger on public.tenant and public.store. Moves the tenant grant version of each actor whose tenant- or store-scope grant a write created, removed or changed (a change to updated_at alone moves nothing; a platform-scope grant moves 013''s version instead), and of each actor holding a tenant- or store-scope grant, of any status, that names a deleted tenant or store — once per actor. Granted to nobody.';

create trigger trg_user_membership_tenant_grant_version
  after insert or update or delete on public.user_membership
  for each row execute function tmpos_session.m5_tenant_grant_moved();
create trigger trg_tenant_tenant_grant_version
  after delete on public.tenant
  for each row execute function tmpos_session.m5_tenant_grant_moved();
create trigger trg_store_tenant_grant_version
  after delete on public.store
  for each row execute function tmpos_session.m5_tenant_grant_moved();

alter table public.user_membership enable always trigger trg_user_membership_tenant_grant_version;
alter table public.tenant enable always trigger trg_tenant_tenant_grant_version;
alter table public.store enable always trigger trg_store_tenant_grant_version;

-- =============================================================================
-- 6) The tenant admission read, v2
-- =============================================================================
-- ONE ROW OUT: 011's answer, each membership also carrying 'storeAccessVersion' (decimal text, null exactly when the
-- grant names no store), plus the actor's platform authority version (013) and tenant grant version (section 4) as
-- decimal text, 0 for an actor with no row. The runtime compares every value for equality and parses none.
--
-- IT DECIDES NO AUTHORITY, AND FAILS CLOSED, as 011's read: every refusal is one identical row, and a grant naming a
-- tenant or a store whose version this routine cannot read RAISES — a fault in the database, reported as the outage it
-- is, never a refusal the boundary would act on by ending every session the principal holds.
create function tmpos_session.m5_admit_tenant_session_v2(p_auth_provider text, p_auth_provider_uid text)
returns table (
  outcome           text,
  actor_id          uuid,
  account_status    text,
  limitation        text,
  security_version  text,
  memberships       jsonb,
  authority_version text,
  grant_version     text
)
language plpgsql
-- STABLE IS LOAD-BEARING, 011's reason: 007's resolution, the version joins and the two counters are separate
-- statements, and a STABLE function runs every one on the calling query's snapshot. Do not relax it.
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_resolved record;
  v_memberships jsonb;
  v_tenants integer;
  v_stores integer;
  v_authority bigint;
  v_grants bigint;
begin
  -- STRICT, 011's reason: a broken 007 must raise, never read as REFUSED and mass-revoke.
  select r.outcome, r.actor_id, r.account_status, r.limitation, r.security_version, r.memberships
    into strict v_resolved
    from tmpos_identity.m5_resolve_principal(p_auth_provider, p_auth_provider_uid) r;

  if v_resolved.outcome is distinct from 'resolved' then
    return query select 'refused'::text, null::uuid, null::text, null::text, null::text, null::jsonb, null::text, null::text;
    return;
  end if;

  -- Each membership as 007 wrote it, with both witnesses added, ordered by membership id AS A UUID (011 section 5).
  select coalesce(
           pg_catalog.jsonb_agg(
             m.entry operator(pg_catalog.||) pg_catalog.jsonb_build_object(
               'tenantAccessVersion',
               case when m.entry operator(pg_catalog.->>) 'tenantId' is null then null
                    else (select t.access_version::text
                            from public.tenant t
                           where t.tenant_id = (m.entry operator(pg_catalog.->>) 'tenantId')::uuid)
               end,
               'storeAccessVersion',
               case when m.entry operator(pg_catalog.->>) 'storeId' is null then null
                    else (select s.access_version::text
                            from public.store s
                           where s.store_id = (m.entry operator(pg_catalog.->>) 'storeId')::uuid)
               end)
             order by (m.entry operator(pg_catalog.->>) 'membershipId')::uuid),
           '[]'::jsonb)
    into v_memberships
    from pg_catalog.jsonb_array_elements(v_resolved.memberships) as m(entry);

  select pg_catalog.count(*) filter (where x.entry operator(pg_catalog.->>) 'tenantId' is not null
                                       and x.entry operator(pg_catalog.->>) 'tenantAccessVersion' is null)::integer,
         pg_catalog.count(*) filter (where x.entry operator(pg_catalog.->>) 'storeId' is not null
                                       and x.entry operator(pg_catalog.->>) 'storeAccessVersion' is null)::integer
    into v_tenants, v_stores
    from pg_catalog.jsonb_array_elements(v_memberships) as x(entry);

  -- A GRANT WITH NO WITNESS IS A FAULT, NOT A VERDICT (011 section 5): 007 resolved it against that row in this same
  -- snapshot, so a missing version means this routine sees less of the table than 007's does.
  if v_tenants > 0 then
    raise exception 'migration 016 admission failed: % tenant grant(s) carry no access version, which means this routine cannot read public.tenant', v_tenants
      using errcode = 'insufficient_privilege',
            hint = 'check that this routine''s owner still has privileges of public.tenant''s owner, as the owner of 007''s resolver does';
  end if;
  if v_stores > 0 then
    raise exception 'migration 016 admission failed: % store grant(s) carry no store access version, which means this routine cannot read public.store', v_stores
      using errcode = 'insufficient_privilege',
            hint = 'check that this routine''s owner still has privileges of public.store''s owner, as the owner of 007''s resolver does';
  end if;

  select v.authority_version into v_authority
    from tmpos_admission.platform_authority_version v
   where v.internal_user_id operator(pg_catalog.=) v_resolved.actor_id;
  select g.grant_version into v_grants
    from tmpos_session.tenant_grant_version g
   where g.internal_user_id operator(pg_catalog.=) v_resolved.actor_id;

  return query select 'resolved'::text, v_resolved.actor_id, v_resolved.account_status, v_resolved.limitation,
                      v_resolved.security_version, v_memberships,
                      coalesce(v_authority, 0)::text, coalesce(v_grants, 0)::text;
end
$$;

comment on function tmpos_session.m5_admit_tenant_session_v2(text, text) is
  'Phase 4.0 M5 (migration 016): the tenant boundary''s admission read — 011''s answer with each membership''s store access version added, plus the actor''s platform authority version (013) and tenant grant version, in one snapshot. One row; every refusal identical; raises when it cannot read a tenant''s or a store''s access version or 007 answers other than one row. Read-only, takes no lock, and decides no authority.';

-- =============================================================================
-- 7) The hold
-- =============================================================================
-- CALLED ONLY FIRST IN THE TRANSACTION THAT COMMITS A TENANT SESSION (server/persistence/postgresSessionStore.ts
-- establish, through the standing check the transaction root composes), for the provider reference the login verified.
-- It resolves the one anchor (001's unique provider reference) and locks, in one fixed order, the account FOR UPDATE —
-- the lock a grant's foreign key and 015's triggers wait behind — then every link, every grant of any scope and status,
-- every tenant any grant names and every store any grant names, each FOR SHARE in key order (the locking step runs above
-- each sort). FOR SHARE conflicts with an UPDATE or DELETE of the row, and with 010's FOR UPDATE, and with nothing a
-- reader takes. VOLATILE, so each statement reads the rows the one before it waited for. It answers only 'absent' (no
-- anchor, or no account) or 'held', and never what it saw: the caller's next statement re-reads v2 and decides.
create function tmpos_session.m5_hold_tenant_standing(p_auth_provider text, p_auth_provider_uid text)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_actor uuid;
begin
  select pi.internal_user_id into v_actor
    from public.platform_identity pi
   where pi.auth_provider operator(pg_catalog.=) p_auth_provider
     and pi.auth_provider_uid operator(pg_catalog.=) p_auth_provider_uid;
  if v_actor is null then
    return 'absent';
  end if;

  perform 1 from public.app_user u where u.internal_user_id operator(pg_catalog.=) v_actor for update;
  if not found then
    return 'absent';
  end if;

  perform 1 from public.identity_link l
   where l.internal_user_id operator(pg_catalog.=) v_actor
   order by l.link_id
     for share;
  perform 1 from public.user_membership m
   where m.internal_user_id operator(pg_catalog.=) v_actor
   order by m.membership_id
     for share;
  perform 1 from public.tenant t
   where t.tenant_id in (select g.tenant_id from public.user_membership g where g.internal_user_id operator(pg_catalog.=) v_actor)
   order by t.tenant_id
     for share of t;
  perform 1 from public.store s
   where s.store_id in (select g.store_id from public.user_membership g where g.internal_user_id operator(pg_catalog.=) v_actor)
   order by s.store_id
     for share of s;

  return 'held';
end
$$;

comment on function tmpos_session.m5_hold_tenant_standing(text, text) is
  'Phase 4.0 M5 (migration 016): the first step of the transaction that commits a tenant session. Locks the actor''s account FOR UPDATE, then its identity links, every grant, and every tenant and store a grant names FOR SHARE, in key order, until that transaction ends. Answers absent (no anchor or no account) or held; reads nothing it answers with and decides nothing.';

-- =============================================================================
-- 8) Privileges, and the proof that nothing wider was issued
-- =============================================================================
-- PostgreSQL grants EXECUTE on a new function to PUBLIC by default, so every default is removed explicitly before the
-- two intended grants are issued. The trigger functions are granted to nobody, tmpos_app included.
revoke all on function tmpos_session.m5_access_version_moved() from public, anon, authenticated, tmpos_app;
revoke all on function tmpos_session.m5_tenant_grant_moved() from public, anon, authenticated, tmpos_app;
revoke all on function tmpos_session.m5_admit_tenant_session_v2(text, text) from public, anon, authenticated;
revoke all on function tmpos_session.m5_hold_tenant_standing(text, text) from public, anon, authenticated;
grant execute on function tmpos_session.m5_admit_tenant_session_v2(text, text) to tmpos_app;
grant execute on function tmpos_session.m5_hold_tenant_standing(text, text) to tmpos_app;

-- The postcondition, proven rather than asserted, in the form 011, 013 and 015 use. This file refuses to finish unless,
-- at this moment:
--   * schema tmpos_session holds exactly 011's six routines and this file's four, by signature; each of this file's is
--     the schema owner's, plpgsql, pinned to the search path above, SECURITY DEFINER but the access-version trigger's,
--     STABLE for v2 and VOLATILE otherwise;
--   * the trigger functions carry no grant beyond their owner's, and every other routine of the schema none beyond its
--     owner's and a non-grantable EXECUTE to tmpos_app;
--   * no runtime-facing role is a member of the owner of the schema, the table, a routine, or the three tables the
--     triggers are on — and no role any of them can act as, inherited or through SET ROLE alone, can execute a trigger
--     function or, tmpos_app aside, any routine here;
--   * the grant version table and each of its columns carry no direct grant beyond the owner's, no role the runtime can
--     act as holds an effective privilege on it, and its row security is on; the schema grants only tmpos_app's USAGE;
--   * store.status and store.access_version carry no column grant, and no role the runtime can act as may UPDATE either
--     column of public.store or public.tenant, or DELETE a row of either (a delete and re-insert resets the version);
--   * nor may it UPDATE a tenant's tenant_id or a store's store_id or tenant_id, INSERT a tenant (on any column: one is
--     enough to insert a row), or TRUNCATE or place a TRIGGER on public.tenant, public.store or public.user_membership;
--   * store.access_version is the non-null bigint under its CHECK;
--   * every definer can see every row it reads: no such table forces row security, and the routines' owner acts as each
--     table's owner (or bypasses row security) — else the hold would lock nothing and v2 would read a version of 0;
--   * exactly two triggers call the access-version function — BEFORE ROW UPDATE on public.tenant, BEFORE ROW INSERT or
--     UPDATE on public.store — and exactly three call the grant function — AFTER ROW INSERT, UPDATE and DELETE on
--     public.user_membership, AFTER ROW DELETE on public.tenant and on public.store — each enabled ALWAYS, with no column
--     list and no WHEN condition.
-- Each ACL is read through coalesce(acl, acldefault(kind, owner)), because a NULL ACL means PostgreSQL's built-in default
-- (for a routine, EXECUTE to PUBLIC) and aclexplode(NULL) yields nothing.
--
-- WHAT THIS DOES NOT PROVE. It is a snapshot at apply time, not a standing guarantee: a later DDL statement outside these
-- migrations could add a grant, disable a trigger or force row security (only the owner of its table can).
do $$
declare
  v_owner oid;
  v_bad text;
  v_roles name[] := array['tmpos_app', 'tmpos_audit_writer', 'anon', 'authenticated']::name[];
  v_reach oid[];
  v_mine name[] := array['m5_access_version_moved', 'm5_tenant_grant_moved', 'm5_admit_tenant_session_v2',
                         'm5_hold_tenant_standing']::name[];
  v_read regclass[] := array['public.tenant', 'public.store', 'public.user_membership', 'public.app_user',
                             'public.identity_link', 'public.platform_identity',
                             'tmpos_admission.platform_authority_version', 'tmpos_session.tenant_grant_version']::regclass[];
begin
  select n.nspowner into v_owner from pg_catalog.pg_namespace n where n.nspname = 'tmpos_session';

  -- By signature, not by name: an overload beside one of these, or in place of one, is not one of these.
  if (select pg_catalog.count(*) from pg_catalog.pg_proc p where p.pronamespace = 'tmpos_session'::regnamespace) <> 10
     or exists (
       select 1
         from pg_catalog.unnest(array[
                'tmpos_session.m5_session_create(text, text, text, text, text, text, bigint, bigint, bigint, bigint, bigint)',
                'tmpos_session.m5_session_get(text, bigint)', 'tmpos_session.m5_session_touch(text, text, bigint)',
                'tmpos_session.m5_session_revoke(text)', 'tmpos_session.m5_session_revoke_principal(text, text)',
                'tmpos_session.m5_admit_tenant_session(text, text)', 'tmpos_session.m5_access_version_moved()',
                'tmpos_session.m5_tenant_grant_moved()', 'tmpos_session.m5_admit_tenant_session_v2(text, text)',
                'tmpos_session.m5_hold_tenant_standing(text, text)']) as s(signature)
        where pg_catalog.to_regprocedure(s.signature) is null) then
    raise exception 'migration 016 refused: schema tmpos_session does not hold exactly 011''s six routines and this file''s four'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  select pg_catalog.string_agg(p.proname::text, ', ' order by p.proname) into v_bad
    from pg_catalog.pg_proc p
   where p.pronamespace = 'tmpos_session'::regnamespace
     and p.proname = any (v_mine)
     and (p.proowner <> v_owner
          or p.prolang <> (select l.oid from pg_catalog.pg_language l where l.lanname = 'plpgsql')
          or p.prosecdef is distinct from (p.proname <> 'm5_access_version_moved')
          or p.proconfig is distinct from array['search_path=pg_catalog, pg_temp']::text[]
          or p.provolatile <> (case when p.proname = 'm5_admit_tenant_session_v2' then 's' else 'v' end)::"char"
          or p.prorettype <> (case p.proname when 'm5_admit_tenant_session_v2' then 'pg_catalog.record'
                                             when 'm5_hold_tenant_standing' then 'pg_catalog.text'
                                             else 'pg_catalog.trigger' end)::regtype);
  if v_bad is not null then
    raise exception 'migration 016 refused: a routine does not match its declaration (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- Every routine of the schema, 011's included: tmpos_app's non-grantable EXECUTE on all but the trigger functions.
  select pg_catalog.string_agg(pg_catalog.format('%s %s:%s', p.proname, g.grantee::regrole::text, g.privilege_type), ', ')
    into v_bad
    from pg_catalog.pg_proc p,
         pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g
   where p.pronamespace = 'tmpos_session'::regnamespace
     and g.grantee <> p.proowner
     and not (p.proname not in ('m5_access_version_moved', 'm5_tenant_grant_moved')
              and g.grantee = 'tmpos_app'::regrole and g.privilege_type = 'EXECUTE' and not g.is_grantable);
  if v_bad is not null then
    raise exception 'migration 016 refused: an unexpected direct grant remains on a routine (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state',
            hint = 'only tmpos_app may hold EXECUTE, never on a trigger function, and never WITH GRANT OPTION';
  end if;

  select pg_catalog.string_agg(distinct r.rolname::text, ', ') into v_bad
    from pg_catalog.pg_roles r
    cross join (
      select v_owner as owner
      union
      select c.relowner from pg_catalog.pg_class c
       where c.oid in ('tmpos_session.tenant_grant_version'::regclass, 'public.tenant'::regclass,
                       'public.store'::regclass, 'public.user_membership'::regclass)
      union
      select p.proowner from pg_catalog.pg_proc p where p.pronamespace = 'tmpos_session'::regnamespace and p.proname = any (v_mine)
    ) o
   where r.rolname = any (v_roles)
     and pg_catalog.pg_has_role(r.oid, o.owner, 'MEMBER');
  if v_bad is not null then
    raise exception 'migration 016 refused: % is a member of an owner this file''s objects depend on', v_bad
      using errcode = 'object_not_in_prerequisite_state',
            hint = 'membership hands a role everything the owner holds, including a direct write of every version';
  end if;

  -- EVERY ROLE A RUNTIME-FACING ROLE CAN ACT AS: itself, and each role it is a member of, inherited or through SET ROLE
  -- alone. pg_has_role(MEMBER) follows both; the has_*_privilege functions follow only the inherited path (010 names
  -- this), so each effective check below is made for every role in this set, not only for the four.
  select pg_catalog.array_agg(distinct m.oid) into v_reach
    from pg_catalog.pg_roles r, pg_catalog.pg_roles m
   where r.rolname = any (v_roles)
     and pg_catalog.pg_has_role(r.oid, m.oid, 'MEMBER');

  select pg_catalog.string_agg(pg_catalog.format('%s %s', r.rolname, p.proname), ', ' order by r.rolname, p.proname) into v_bad
    from pg_catalog.pg_roles r, pg_catalog.pg_proc p
   where r.oid = any (v_reach)
     and p.pronamespace = 'tmpos_session'::regnamespace
     and not (r.rolname = 'tmpos_app' and p.proname not in ('m5_access_version_moved', 'm5_tenant_grant_moved'))
     and pg_catalog.has_function_privilege(r.oid, p.oid, 'EXECUTE');
  if v_bad is not null then
    raise exception 'migration 016 refused: a runtime-facing role can execute a routine it was not granted (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  select pg_catalog.string_agg(x.detail, ', ')
    into v_bad
    from (
      select pg_catalog.format('table %s:%s', g.grantee::regrole::text, g.privilege_type) as detail
        from pg_catalog.pg_class c,
             pg_catalog.aclexplode(coalesce(c.relacl, pg_catalog.acldefault('r', c.relowner))) g
       where c.oid = 'tmpos_session.tenant_grant_version'::regclass
         and g.grantee <> c.relowner
      union all
      select pg_catalog.format('column %s %s:%s', a.attname, g.grantee::regrole::text, g.privilege_type)
        from pg_catalog.pg_attribute a,
             pg_catalog.aclexplode(a.attacl) g
       where a.attrelid = 'tmpos_session.tenant_grant_version'::regclass
         and not a.attisdropped
         and g.grantee <> v_owner
    ) x;
  if v_bad is not null then
    raise exception 'migration 016 refused: tmpos_session.tenant_grant_version carries a direct grant (%), but only the trigger may write it and only v2 may read it', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  select pg_catalog.string_agg(r.rolname::text, ', ' order by r.rolname) into v_bad
    from pg_catalog.pg_roles r
   where r.oid = any (v_reach)
     and pg_catalog.has_table_privilege(r.oid, 'tmpos_session.tenant_grant_version'::regclass,
           'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'
           operator(pg_catalog.||) case when pg_catalog.current_setting('server_version_num')::integer >= 170000
                                        then ', MAINTAIN' else '' end);
  if v_bad is not null then
    raise exception 'migration 016 refused: % holds an effective privilege on tmpos_session.tenant_grant_version', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  if not (select c.relrowsecurity from pg_catalog.pg_class c where c.oid = 'tmpos_session.tenant_grant_version'::regclass) then
    raise exception 'migration 016 refused: row level security is not enabled on tmpos_session.tenant_grant_version'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  select pg_catalog.string_agg(pg_catalog.format('%s:%s', g.grantee::regrole::text, g.privilege_type), ', ')
    into v_bad
    from pg_catalog.pg_namespace n,
         pg_catalog.aclexplode(coalesce(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) g
   where n.oid = 'tmpos_session'::regnamespace
     and g.grantee <> n.nspowner
     and not (g.grantee = 'tmpos_app'::regrole and g.privilege_type = 'USAGE' and not g.is_grantable);
  if v_bad is not null then
    raise exception 'migration 016 refused: schema tmpos_session carries an unexpected grant (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- The lifecycle columns: the catalog first (a column grant lives in attacl), then every role the runtime can act as.
  select pg_catalog.string_agg(distinct coalesce(g.grantee::regrole::text, 'PUBLIC') || ':' || x.attname::text || ':' || g.privilege_type, ', ')
    into v_bad
    from pg_catalog.pg_attribute x
    cross join pg_catalog.aclexplode(x.attacl) g
    join pg_catalog.pg_class c on c.oid = x.attrelid
   where x.attrelid = 'public.store'::regclass
     and x.attname in ('status', 'access_version')
     and not x.attisdropped
     and g.grantee is distinct from c.relowner;
  if v_bad is not null then
    raise exception 'migration 016 refused: a store lifecycle column carries a direct grant: %', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  select pg_catalog.string_agg(distinct r.rolname::text || ':' || c.tbl::text || '.' || c.col || ':' || c.priv, ', ') into v_bad
    from pg_catalog.pg_roles r
    cross join (values ('public.tenant'::regclass, 'status', 'UPDATE'), ('public.tenant'::regclass, 'access_version', 'UPDATE'),
                       ('public.store'::regclass, 'status', 'UPDATE'), ('public.store'::regclass, 'access_version', 'UPDATE'))
               as c(tbl, col, priv)
   where r.oid = any (v_reach)
     and pg_catalog.has_column_privilege(r.oid, c.tbl, c.col, c.priv);
  if v_bad is not null then
    raise exception 'migration 016 refused: % may write a lifecycle column directly', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  select pg_catalog.string_agg(distinct r.rolname::text, ', ') into v_bad
    from pg_catalog.pg_roles r
   where r.oid = any (v_reach)
     and (pg_catalog.has_table_privilege(r.oid, 'public.tenant'::regclass, 'DELETE')
          or pg_catalog.has_table_privilege(r.oid, 'public.store'::regclass, 'DELETE'));
  if v_bad is not null then
    raise exception 'migration 016 refused: % may delete a tenant or store row', v_bad
      using errcode = 'object_not_in_prerequisite_state',
            hint = 'a delete and re-insert would reset the status and the access version alike';
  end if;

  -- The paths around the versions, for the same roles: a key moved (the trigger refuses it too) or a store re-parented
  -- (which moves its version, but is no write of the runtime's); a tenant inserted, whose version no trigger sets, so it
  -- may be named at the bound, and whose one column grant is enough to insert a row; a TRUNCATE, which fires no row
  -- trigger; and a TRIGGER, which lets a role place its own after these to rewrite the row they have just versioned.
  -- has_column_privilege is satisfied by a table-wide grant too. Named as text, so the refusal reads the same whatever
  -- search path runs it.
  select pg_catalog.string_agg(distinct r.rolname::text || ':' || c.tbl || coalesce('.' || c.col, '') || ':' || c.priv, ', ')
    into v_bad
    from pg_catalog.pg_roles r
    cross join (values ('public.tenant', 'tenant_id', 'UPDATE'), ('public.store', 'store_id', 'UPDATE'),
                       ('public.store', 'tenant_id', 'UPDATE'), ('public.tenant', null, 'INSERT'),
                       ('public.tenant', null, 'TRUNCATE'), ('public.store', null, 'TRUNCATE'),
                       ('public.user_membership', null, 'TRUNCATE'), ('public.tenant', null, 'TRIGGER'),
                       ('public.store', null, 'TRIGGER'), ('public.user_membership', null, 'TRIGGER'))
               as c(tbl, col, priv)
   where r.oid = any (v_reach)
     and case when c.col is not null then pg_catalog.has_column_privilege(r.oid, c.tbl, c.col, c.priv)
              when c.priv = 'INSERT' then pg_catalog.has_any_column_privilege(r.oid, c.tbl, c.priv)
              else pg_catalog.has_table_privilege(r.oid, c.tbl, c.priv) end;
  if v_bad is not null then
    raise exception 'migration 016 refused: % may change a key or a store''s tenant, insert a tenant, or truncate or place a trigger on a table the versions guard', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_attribute a
     where a.attrelid = 'public.store'::regclass
       and a.attname = 'access_version'
       and not a.attisdropped
       and a.attnotnull
       and a.atttypid = 'bigint'::regtype)
     or not exists (
       select 1 from pg_catalog.pg_constraint k
        where k.conrelid = 'public.store'::regclass and k.conname = 'store_access_version_chk') then
    raise exception 'migration 016 refused: public.store.access_version is not the non-null bigint under the CHECK that section 2 declares'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  select pg_catalog.string_agg(c.oid::regclass::text, ', ' order by c.oid::regclass::text) into v_bad
    from pg_catalog.pg_class c, pg_catalog.pg_roles r
   where c.oid = any (v_read)
     and r.oid = v_owner
     and (c.relforcerowsecurity or not (pg_catalog.pg_has_role(v_owner, c.relowner, 'USAGE') or r.rolbypassrls));
  if v_bad is not null then
    raise exception 'migration 016 refused: row level security would hide rows of % from this file''s definers (FORCE ROW LEVEL SECURITY is set, or their owner does not act as the table''s owner)', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- The triggers (tgtype ROW 1 + BEFORE 2 + UPDATE 16 = 19; ROW 1 + BEFORE 2 + INSERT 4 + UPDATE 16 = 23; ROW 1 + INSERT 4
  -- + DELETE 8 + UPDATE 16 = 29 and ROW 1 + DELETE 8 = 9, AFTER being the absence of BEFORE; TRUNCATE and INSTEAD OF
  -- absent), enabled ALWAYS, with no column list and no WHEN condition.
  if (select pg_catalog.count(*) from pg_catalog.pg_trigger g
       where g.tgfoid in ('tmpos_session.m5_access_version_moved()'::regprocedure,
                          'tmpos_session.m5_tenant_grant_moved()'::regprocedure)) <> 5
     or (select pg_catalog.count(*)
           from pg_catalog.pg_trigger g
           join (values ('public.tenant'::regclass, 'trg_tenant_access_version'::name,
                         'tmpos_session.m5_access_version_moved()'::regprocedure, 19::int2),
                        ('public.store'::regclass, 'trg_store_access_version'::name,
                         'tmpos_session.m5_access_version_moved()'::regprocedure, 23::int2),
                        ('public.user_membership'::regclass, 'trg_user_membership_tenant_grant_version'::name,
                         'tmpos_session.m5_tenant_grant_moved()'::regprocedure, 29::int2),
                        ('public.tenant'::regclass, 'trg_tenant_tenant_grant_version'::name,
                         'tmpos_session.m5_tenant_grant_moved()'::regprocedure, 9::int2),
                        ('public.store'::regclass, 'trg_store_tenant_grant_version'::name,
                         'tmpos_session.m5_tenant_grant_moved()'::regprocedure, 9::int2))
                as d(rel, tgname, fn, tgtype)
             on g.tgrelid = d.rel and g.tgname = d.tgname and g.tgfoid = d.fn
          where g.tgtype = d.tgtype
            and g.tgenabled = 'A'
            and g.tgattr = ''::pg_catalog.int2vector
            and g.tgqual is null
            and not g.tgisinternal) <> 5 then
    raise exception 'migration 016 refused: the version triggers are not exactly the five sections 3 and 5 declare'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$$;

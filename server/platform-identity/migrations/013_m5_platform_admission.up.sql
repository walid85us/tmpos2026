-- Phase 4.0 M5 — durable platform-administrator admission: the witness an administrative session is bound to,
-- and the one read that answers it (M5-GIAM-D1-P4; G-IAM, G-CPLOGIN; docs/phase-4/04 §2, §5)
-- Migration: 013_m5_platform_admission (UP)
--
-- SCOPE / TRUTH (binding):
--   - ONE NEW SCHEMA, ONE TABLE, FOUR TRIGGERS ON ONE FUNCTION, TWO ROUTINES, NO NEW ROLE. This file creates
--     schema tmpos_admission, a per-actor counter (the platform authority version), the trigger function that
--     moves it with one trigger on each of the four tables that decide an administrator's standing
--     (public.platform_identity, public.app_user, public.identity_link, public.user_membership), and the one
--     read the administrative session boundary is admitted through. It creates no role, no role membership
--     and no type. Its only change to objects earlier migrations created is those four triggers; migrations
--     005-012 are untouched, byte for byte.
--   - WHY A MIGRATION IS NEEDED AT ALL. An administrative session is bound to a witness and refused the
--     moment the witness moves, so the witness must move on EVERY change to the standing it was admitted
--     under — and must never return to a value it has held, or a session idle across a revocation and a
--     restoration would be admitted again on its old cookie. Nothing in 001-012 gives that. Migration 007's
--     security version deliberately excludes memberships (007 section 1), so it never moves for a platform
--     GRANT; and what it does cover — the account's status and its identity links — it digests from row
--     timestamps, which return to their old values when an exported row is re-inserted with them, or when a
--     row is changed and changed back by a session that runs as a replica (002's updated_at triggers do not
--     fire there). It does not cover the identity ANCHOR at all: a provider reference repointed to another
--     uid and back leaves it unchanged. A witness built from the grant row itself would not do either: the
--     membership id and role return unchanged when a grant is disabled and re-enabled, and its timestamps
--     are reproduced by the same re-insert — the most natural way to "restore" a grant. So this file adds the
--     narrowest MONOTONIC version that closes the gap: one counter per actor that only ever increases, moved
--     by the database itself on every change to that actor's standing, whoever makes it.
--   - WHAT MOVES THE VERSION. Any INSERT and any DELETE of the actor's platform_identity, app_user or
--     identity_link row, or of a user_membership row that is at platform scope before or after the write;
--     any UPDATE of such a row that changes a column other than updated_at — except platform_identity, where
--     only the anchor counts (internal_user_id, auth_provider, auth_provider_uid): its email and display
--     name mirror the provider's profile, decide nothing, and are refreshed by the identity sync. So a grant
--     created, removed, disabled, re-enabled, re-roled, re-scoped or moved to another actor moves it; so
--     does an account status change, a link added, removed or changed, and a provider reference repointed.
--     In ordinary operation none of the latter ends a session that 007's version would not already end —
--     every UPDATE of app_user or identity_link moves their updated_at — it only makes the witness
--     impossible to reproduce. A tenant- or store-scope grant never moves it. One tenant-plane fact does
--     reach administrative admission, through 007 and not through this counter: 007 refuses an actor holding
--     more than 200 usable grants across every scope, and this read passes that refusal on (docs/phase-4/08).
--   - WHY NO FOREIGN KEY. The counter outlives the account it counts: an actor deleted and recreated under
--     the same internal_user_id continues from its last value instead of starting again at one, where an
--     old witness could be met again. Nothing reads the table but this file's routine, keyed by the actor.
--   - THE RUNTIME NEVER TOUCHES THE TABLE. tmpos_app receives USAGE on the schema and EXECUTE on the
--     admission read, and nothing on the table, the trigger function or any column. Section 6 proves it.
--   - WHAT THE READ ANSWERS, AND WHAT IT REFUSES TO INVENT. m5_admit_platform_session answers for a provider
--     reference the authentication boundary has already verified. It takes no actor, grant, role or
--     version from its caller: it calls 007's resolution routine — the single definition of which grants an
--     actor holds — keeps the PLATFORM-scope grants only, and adds the actor's platform authority version, in
--     one snapshot. It decides nothing: whether that standing admits a session (exactly one platform grant,
--     an eligible account, a catalogued role) is decided in trusted source
--     (server/composition/platformAuthorization.ts), so no permission policy lives in SQL.
--   - CONCURRENCY. The trigger upserts one row per actor, so two transactions changing the SAME actor's
--     account, anchor, links or platform grants serialize on it. Two transactions that reach the same actors'
--     rows in opposite orders — one actor's rows across the four tables, or grants moved between two actors
--     in opposite directions — can now deadlock where they could not before; PostgreSQL detects it and aborts
--     one, which commits nothing and may be retried. No routine of 001-012 writes any of the four tables, so
--     no runtime command gains a lock it did not already take; only provisioning and operator writes do.
--     Applying this file (section 1) and rolling it back each hold a SHARE ROW EXCLUSIVE lock on 011's session
--     table until their transaction ends, so every write to it — each login, logout and revocation, of either
--     audience — waits for them; reads go through.
--   - NO SECRET, NO DYNAMIC SQL, NO EXTENSION, NO TEMPORARY OBJECT. Every statement is fixed text, every
--     value a parameter, every relation and routine schema-qualified, and every routine pins its
--     search_path to pg_catalog then pg_temp.
--
-- Reversible via 013_m5_platform_admission.down.sql, which REFUSES while any administrative session exists —
-- those rows are the only place a witness lives, and a counter dropped and recreated starts again at zero,
-- where an old witness could be met again — and otherwise removes exactly what this file created. This file
-- refuses likewise (section 1), so a session committed by a login racing the rollback cannot cross it either.
--
-- Assumes 001-012 are applied. A future managed apply targets the complete contiguous chain through the
-- newest committed migration — now 001-013 (owner decision D4); this file authorizes no apply.

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
  -- The chain is contiguous: 012 is the newest migration this file sits on.
  if pg_catalog.to_regprocedure('tmpos_directory.m5_tenant_directory_page(uuid, text, uuid, text, uuid, integer)') is null then
    raise exception 'migration 013 refused: migration 012 must be applied first'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- 007's resolution is the one definition of an actor's grants; this file keeps part of its answer and never
  -- restates it. The routine below runs as this file's owner, so that owner must be able to call it.
  if pg_catalog.to_regprocedure('tmpos_identity.m5_resolve_principal(text, text)') is null then
    raise exception 'migration 013 refused: migration 007 must be applied first'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if not pg_catalog.has_function_privilege(current_user, 'tmpos_identity.m5_resolve_principal(text, text)', 'EXECUTE') then
    raise exception 'migration 013 refused: the applying principal cannot execute migration 007''s resolution, so the admission read could not answer'
      using errcode = 'insufficient_privilege';
  end if;
  -- The session table the rollback guard reads (011), and the runtime role this file grants to (005).
  if pg_catalog.to_regclass('tmpos_session.session') is null then
    raise exception 'migration 013 refused: migration 011 must be applied first'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- The guard at the end of this block locks and counts that table, which only its owner may be relied on to do.
  if not pg_catalog.pg_has_role(current_user,
       (select c.relowner from pg_catalog.pg_class c where c.oid = 'tmpos_session.session'::regclass), 'USAGE') then
    raise exception 'migration 013 refused: the applying principal does not own tmpos_session.session, so it cannot hold the lock that keeps an administrative session from crossing this application'
      using errcode = 'insufficient_privilege';
  end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'tmpos_app') then
    raise exception 'migration 013 refused: migration 005 must be applied first'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- The triggers are created on the four tables that decide an administrator's standing, which only their
  -- owner may do; and they must be this principal's, so no one else's trigger answers for the version.
  if exists (
    select 1
      from pg_catalog.pg_class c
     where c.oid in ('public.platform_identity'::regclass, 'public.app_user'::regclass,
                     'public.identity_link'::regclass, 'public.user_membership'::regclass)
       and not pg_catalog.pg_has_role(current_user, c.relowner, 'USAGE')) then
    raise exception 'migration 013 refused: the applying principal does not own public.platform_identity, public.app_user, public.identity_link and public.user_membership, so it cannot place the triggers that move the version'
      using errcode = 'insufficient_privilege';
  end if;
  -- NO ADMINISTRATIVE SESSION MAY CROSS AN APPLICATION OF THIS FILE. A witness is non-repeating only within one
  -- application: rolled back and applied again, every counter restarts at zero, and while 013 is absent no
  -- write moves one. The rollback refuses while an administrative session exists, but a login that read its
  -- witness before the rollback can still commit its session row once the rollback's lock is released — and a
  -- grant withdrawn and restored in the gap would then leave that witness intact. So the application refuses
  -- too, under the same lock, and the remedy is the rollback's: end those sessions, then apply. Before this
  -- file the administrative boundary had no durable admission and its production composition refused, so a
  -- first application normally finds none.
  lock table tmpos_session.session in share row exclusive mode;
  select pg_catalog.count(*) into v_live from tmpos_session.session s where s.audience = 'admin';
  if v_live > 0 then
    raise exception 'migration 013 refused: % administrative session row(s) exist, and a witness issued before this application could be met again once its counters restart', v_live
      using errcode = 'object_not_in_prerequisite_state',
            hint = 'end them through the session boundary (logout, or tmpos_session.m5_session_revoke_principal), clear any rows that remain, then apply';
  end if;
end
$$;

-- =============================================================================
-- 2) The schema
-- =============================================================================
create schema tmpos_admission;

comment on schema tmpos_admission is
  'Phase 4.0 M5 (migration 013): durable platform-administrator admission — the per-actor platform authority version and the one read the administrative session boundary is admitted through. Owned by this migration; tmpos_app holds USAGE and EXECUTE on the read only, and no privilege on the table.';

revoke all on schema tmpos_admission from public, anon, authenticated;
grant usage on schema tmpos_admission to tmpos_app;

-- =============================================================================
-- 3) The platform authority version
-- =============================================================================
-- One row per actor whose standing has ever changed since this file was applied. An actor with no row has
-- version 0, which the read reports as such; the first change writes 1. The bound is the runtime's
-- safe-integer range, so a value that could not round-trip through the runtime's number type is refused by
-- the database rather than silently truncated — not a limit any actor could reach.
create table tmpos_admission.platform_authority_version (
  internal_user_id  uuid   primary key,
  authority_version bigint not null
                    constraint platform_authority_version_range_chk check (authority_version between 1 and 9007199254740991)
);

comment on table tmpos_admission.platform_authority_version is
  'Phase 4.0 M5 (migration 013): per-actor counter that only increases, moved by m5_platform_authority_moved on every change to the actor''s identity anchor, account, identity links or platform-scope grants. No foreign key: it outlives the account it counts. Written only by that trigger function; read only by m5_admit_platform_session. tmpos_app holds no privilege on it.';

revoke all on table tmpos_admission.platform_authority_version from public, anon, authenticated;

-- RLS with no policy, the posture 006 and 011 give their own tables: section 6 already refuses while any
-- role holds a privilege here, and this is the second layer for the day a later migration grants one by
-- mistake. The two routines run as the owner, whom RLS does not restrict (it is not forced).
alter table tmpos_admission.platform_authority_version enable row level security;

-- =============================================================================
-- 4) The trigger that moves it
-- =============================================================================
-- SECURITY DEFINER because it writes a table no writer of the four tables holds a privilege on, and granted to
-- nobody: a trigger function fires without an EXECUTE grant and cannot be called directly. It reads nothing but
-- the row it is handed, and it can only ever make an administrative session END — never admit one — so running
-- it as the owner for any writer grants that writer nothing.
--
-- An UPDATE that changes nothing but updated_at (which 002's and 004's own triggers refresh on every UPDATE)
-- moves no version, the comparison 008 uses for its row version: a no-op write should not sign anyone out.
-- Every other column counts, including one a later migration adds — except on platform_identity, where only
-- the anchor does (see the header). A field of OLD or NEW is read only inside an IF branch whose TG_OP, and
-- whose table, guarantee it: an IF condition is one SQL expression, and SQL promises no left-to-right
-- short circuit for AND or OR, so no guard shares a condition with the field it guards.
create function tmpos_admission.m5_platform_authority_moved()
returns trigger
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_before uuid;  -- the actor whose standing the write changed, as the row stood before it (null: none)
  v_after  uuid;  -- the same, as the row stands after it (null: none)
begin
  if tg_op = 'UPDATE' then
    if tg_table_name = 'platform_identity' then
      if row(new.internal_user_id, new.auth_provider, new.auth_provider_uid)
         is not distinct from row(old.internal_user_id, old.auth_provider, old.auth_provider_uid) then
        return null;
      end if;
    elsif (pg_catalog.to_jsonb(new) operator(pg_catalog.-) 'updated_at'::text)
          is not distinct from
          (pg_catalog.to_jsonb(old) operator(pg_catalog.-) 'updated_at'::text) then
      return null;
    end if;
  end if;

  -- The anchor, the account or a link moves its actor on every write that got here; a grant only when it is
  -- at platform scope on that side of the write.
  if tg_op in ('UPDATE', 'DELETE') then
    if tg_table_name <> 'user_membership' then
      v_before := old.internal_user_id;
    elsif old.scope_type = 'platform' then
      v_before := old.internal_user_id;
    end if;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    if tg_table_name <> 'user_membership' then
      v_after := new.internal_user_id;
    elsif new.scope_type = 'platform' then
      v_after := new.internal_user_id;
    end if;
  end if;

  -- Once per actor: twice only when the write moved the row from one actor to another.
  if v_before is not null then
    insert into tmpos_admission.platform_authority_version as v (internal_user_id, authority_version)
    values (v_before, 1)
    on conflict (internal_user_id)
      do update set authority_version = v.authority_version operator(pg_catalog.+) 1;
  end if;
  if v_after is not null and v_after is distinct from v_before then
    insert into tmpos_admission.platform_authority_version as v (internal_user_id, authority_version)
    values (v_after, 1)
    on conflict (internal_user_id)
      do update set authority_version = v.authority_version operator(pg_catalog.+) 1;
  end if;

  return null;
end
$$;

comment on function tmpos_admission.m5_platform_authority_moved() is
  'Phase 4.0 M5 (migration 013): AFTER row trigger on public.platform_identity, public.app_user, public.identity_link and public.user_membership. Moves the platform authority version of each actor whose identity anchor, account, identity link or platform-scope grant a write created, removed or changed (a change to updated_at alone, or to a platform_identity column outside the anchor, moves nothing). Granted to nobody.';

create trigger trg_platform_identity_platform_authority
  after insert or update or delete on public.platform_identity
  for each row execute function tmpos_admission.m5_platform_authority_moved();
create trigger trg_app_user_platform_authority
  after insert or update or delete on public.app_user
  for each row execute function tmpos_admission.m5_platform_authority_moved();
create trigger trg_identity_link_platform_authority
  after insert or update or delete on public.identity_link
  for each row execute function tmpos_admission.m5_platform_authority_moved();
create trigger trg_user_membership_platform_authority
  after insert or update or delete on public.user_membership
  for each row execute function tmpos_admission.m5_platform_authority_moved();

-- ALWAYS, as 006 and 008 do for theirs: the version moves even for a session running as a replica — the one
-- mode in which 002's and 004's updated_at triggers do not fire.
alter table public.platform_identity enable always trigger trg_platform_identity_platform_authority;
alter table public.app_user enable always trigger trg_app_user_platform_authority;
alter table public.identity_link enable always trigger trg_identity_link_platform_authority;
alter table public.user_membership enable always trigger trg_user_membership_platform_authority;

-- =============================================================================
-- 5) The platform admission read
-- =============================================================================
-- ONE ROW OUT: 007's resolution with its memberships narrowed to the PLATFORM-scope grants, plus the actor's
-- platform authority version as decimal text (the runtime compares it for equality and never parses it).
--
-- IT DECIDES NO AUTHORITY. Holding EXECUTE on this routine is not permission to act as anyone: it answers what
-- the database already says about a provider reference the authentication boundary verified. An actor with no
-- platform grant, or with two, is answered as it stands ('resolved' with that array), and the runtime refuses it.
--
-- FAIL CLOSED. Every refusal 007 makes is the same single row here, so no caller learns whether a provider
-- reference or an actor exists.
create function tmpos_admission.m5_admit_platform_session(p_auth_provider text, p_auth_provider_uid text)
returns table (
  outcome           text,
  actor_id          uuid,
  account_status    text,
  limitation        text,
  security_version  text,
  memberships       jsonb,
  authority_version text
)
language plpgsql
-- STABLE IS LOAD-BEARING, as in 011: 007's resolution and the version read are two statements, and a STABLE
-- function runs both on the calling query's snapshot. A grant withdrawn between them could otherwise be absent
-- from the first read while the second still showed the version from before the withdrawal — or the reverse.
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_resolved record;
  v_platform jsonb;
  v_version bigint;
begin
  -- STRICT, for 011's reason: 007 answers exactly one row, and if it ever answered none a plain SELECT INTO
  -- would read as REFUSED — which the boundary acts on by ending every session the principal holds. A broken
  -- routine raises instead, and the adapter reports the outage it is.
  select r.outcome, r.actor_id, r.account_status, r.limitation, r.security_version, r.memberships
    into strict v_resolved
    from tmpos_identity.m5_resolve_principal(p_auth_provider, p_auth_provider_uid) r;

  if v_resolved.outcome is distinct from 'resolved' then
    return query select 'refused'::text, null::uuid, null::text, null::text, null::text, null::jsonb, null::text;
    return;
  end if;

  -- The platform grants only, ordered by membership id AS A UUID — byte order, which no collation can move
  -- (011 section 5 explains why ordering the text would not do).
  select coalesce(
           pg_catalog.jsonb_agg(m.entry order by (m.entry operator(pg_catalog.->>) 'membershipId')::uuid),
           '[]'::jsonb)
    into v_platform
    from pg_catalog.jsonb_array_elements(v_resolved.memberships) as m(entry)
   where m.entry operator(pg_catalog.->>) 'scopeType' operator(pg_catalog.=) 'platform';

  select v.authority_version into v_version
    from tmpos_admission.platform_authority_version v
   where v.internal_user_id operator(pg_catalog.=) v_resolved.actor_id;

  return query select 'resolved'::text, v_resolved.actor_id, v_resolved.account_status, v_resolved.limitation,
                      v_resolved.security_version, v_platform, coalesce(v_version, 0)::text;
end
$$;

comment on function tmpos_admission.m5_admit_platform_session(text, text) is
  'Phase 4.0 M5 (migration 013): the administrative boundary''s admission read — 007''s resolved principal narrowed to its platform-scope grants, with the actor''s platform authority version, in one snapshot. One row; every refusal identical; raises when 007 answers other than one row. Read-only, takes no lock, returns no provider reference, and decides no authority.';

-- =============================================================================
-- 6) Privileges, and the proof that nothing wider was issued
-- =============================================================================
-- PostgreSQL grants EXECUTE on a new function to PUBLIC by default, so every default is removed explicitly
-- before the one intended grant is issued. The trigger function is granted to nobody, tmpos_app included.
revoke all on function tmpos_admission.m5_platform_authority_moved() from public, anon, authenticated, tmpos_app;
revoke all on function tmpos_admission.m5_admit_platform_session(text, text) from public, anon, authenticated;
grant execute on function tmpos_admission.m5_admit_platform_session(text, text) to tmpos_app;

-- The postcondition, proven rather than asserted, in the form 011 and 012 use. This file refuses to finish
-- unless, at this moment:
--   * the schema holds exactly this file's two routines, each owned by the schema's owner, SECURITY DEFINER
--     and pinned to the search path above, the trigger function VOLATILE and the read STABLE;
--   * the trigger function carries no direct grant beyond its owner's, and the read none beyond its owner's and
--     a non-grantable EXECUTE to tmpos_app;
--   * the table and every column of it carry no direct grant beyond the owner's, and none of the runtime roles
--     holds an effective privilege on it by any path (a grant to PUBLIC, an inherited role, a predefined role);
--   * the schema carries no grant beyond its owner's and a non-grantable USAGE to tmpos_app;
--   * none of the runtime roles is a MEMBER of the owner of the schema, the table or a routine;
--   * the trigger function is called by exactly the four triggers section 4 declares — one on each of
--     public.platform_identity, public.app_user, public.identity_link and public.user_membership, AFTER, FOR
--     EACH ROW, on INSERT, UPDATE and DELETE, enabled ALWAYS — and by no other; and the table's row security
--     is on.
-- Each ACL is read through coalesce(acl, acldefault(kind, owner)), because a NULL ACL means PostgreSQL's
-- built-in default (for a routine, EXECUTE to PUBLIC) and aclexplode(NULL) yields nothing.
--
-- WHAT THIS DOES NOT PROVE. It is a snapshot at apply time, not a standing guarantee: a later DDL statement
-- outside these migrations could add an object to this schema, a grant to these objects, or disable a
-- trigger (only the owner of its table can).
do $$
declare
  v_owner oid;
  v_bad text;
  v_roles name[] := array['tmpos_app', 'tmpos_audit_writer', 'anon', 'authenticated']::name[];
begin
  select n.nspowner into v_owner from pg_catalog.pg_namespace n where n.nspname = 'tmpos_admission';

  if (select pg_catalog.count(*) from pg_catalog.pg_proc p where p.pronamespace = 'tmpos_admission'::regnamespace) <> 2 then
    raise exception 'migration 013 refused: schema tmpos_admission does not hold exactly the two routines this file creates'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  select pg_catalog.string_agg(p.proname::text, ', ' order by p.proname) into v_bad
    from pg_catalog.pg_proc p
   where p.pronamespace = 'tmpos_admission'::regnamespace
     and (
          p.proname not in ('m5_platform_authority_moved', 'm5_admit_platform_session')
       or p.proowner <> v_owner
       or not p.prosecdef
       or p.proconfig is distinct from array['search_path=pg_catalog, pg_temp']::text[]
       or (p.proname = 'm5_platform_authority_moved' and p.provolatile <> 'v')
       or (p.proname = 'm5_admit_platform_session' and p.provolatile <> 's')
     );
  if v_bad is not null then
    raise exception 'migration 013 refused: a routine does not match its declaration (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  select pg_catalog.string_agg(pg_catalog.format('%s %s:%s', p.proname, g.grantee::regrole::text, g.privilege_type), ', ')
    into v_bad
    from pg_catalog.pg_proc p,
         pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) g
   where p.pronamespace = 'tmpos_admission'::regnamespace
     and g.grantee <> p.proowner
     and not (p.proname = 'm5_admit_platform_session'
              and g.grantee = 'tmpos_app'::regrole and g.privilege_type = 'EXECUTE' and not g.is_grantable);
  if v_bad is not null then
    raise exception 'migration 013 refused: an unexpected direct grant remains on a routine (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state',
            hint = 'only tmpos_app may hold EXECUTE, only on the admission read, and never WITH GRANT OPTION';
  end if;

  select pg_catalog.string_agg(x.detail, ', ')
    into v_bad
    from (
      select pg_catalog.format('table %s:%s', g.grantee::regrole::text, g.privilege_type) as detail
        from pg_catalog.pg_class c,
             pg_catalog.aclexplode(coalesce(c.relacl, pg_catalog.acldefault('r', c.relowner))) g
       where c.oid = 'tmpos_admission.platform_authority_version'::regclass
         and g.grantee <> c.relowner
      union all
      select pg_catalog.format('column %s %s:%s', a.attname, g.grantee::regrole::text, g.privilege_type)
        from pg_catalog.pg_attribute a,
             pg_catalog.aclexplode(a.attacl) g
       where a.attrelid = 'tmpos_admission.platform_authority_version'::regclass
         and not a.attisdropped
         and g.grantee <> v_owner
    ) x;
  if v_bad is not null then
    raise exception 'migration 013 refused: tmpos_admission.platform_authority_version carries a direct grant (%), but only the trigger may write it and only the read may read it', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  select pg_catalog.string_agg(r.rolname::text, ', ' order by r.rolname) into v_bad
    from pg_catalog.pg_roles r
   where r.rolname = any (v_roles)
     and pg_catalog.has_table_privilege(r.oid, 'tmpos_admission.platform_authority_version'::regclass,
           'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'
           operator(pg_catalog.||) case when pg_catalog.current_setting('server_version_num')::integer >= 170000
                                        then ', MAINTAIN' else '' end);
  if v_bad is not null then
    raise exception 'migration 013 refused: % holds an effective privilege on tmpos_admission.platform_authority_version', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  select pg_catalog.string_agg(pg_catalog.format('%s:%s', g.grantee::regrole::text, g.privilege_type), ', ')
    into v_bad
    from pg_catalog.pg_namespace n,
         pg_catalog.aclexplode(coalesce(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) g
   where n.oid = 'tmpos_admission'::regnamespace
     and g.grantee <> n.nspowner
     and not (g.grantee = 'tmpos_app'::regrole and g.privilege_type = 'USAGE' and not g.is_grantable);
  if v_bad is not null then
    raise exception 'migration 013 refused: schema tmpos_admission carries an unexpected grant (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  select pg_catalog.string_agg(distinct r.rolname::text, ', ') into v_bad
    from pg_catalog.pg_roles r
    cross join (
      select v_owner as owner
      union
      select c.relowner from pg_catalog.pg_class c where c.oid = 'tmpos_admission.platform_authority_version'::regclass
      union
      select p.proowner from pg_catalog.pg_proc p where p.pronamespace = 'tmpos_admission'::regnamespace
    ) o
   where r.rolname = any (v_roles)
     and pg_catalog.pg_has_role(r.oid, o.owner, 'MEMBER');
  if v_bad is not null then
    raise exception 'migration 013 refused: % is a member of an owner this schema, its table or its routines depend on', v_bad
      using errcode = 'object_not_in_prerequisite_state',
            hint = 'membership hands a role everything the owner holds, including a direct write of every version';
  end if;

  -- The triggers: exactly four call the function, one per table, each this file's, AFTER ROW on INSERT, UPDATE
  -- and DELETE (tgtype 29 = ROW 1 + INSERT 4 + DELETE 8 + UPDATE 16; BEFORE, TRUNCATE and INSTEAD OF absent),
  -- enabled ALWAYS, with no column list and no WHEN condition that could narrow it.
  if (select pg_catalog.count(*) from pg_catalog.pg_trigger g
       where g.tgfoid = 'tmpos_admission.m5_platform_authority_moved()'::regprocedure) <> 4
     or (select pg_catalog.count(*)
           from pg_catalog.pg_trigger g
           join (values ('public.platform_identity'::regclass, 'trg_platform_identity_platform_authority'::name),
                        ('public.app_user'::regclass, 'trg_app_user_platform_authority'::name),
                        ('public.identity_link'::regclass, 'trg_identity_link_platform_authority'::name),
                        ('public.user_membership'::regclass, 'trg_user_membership_platform_authority'::name))
                as d(rel, tgname)
             on g.tgrelid = d.rel and g.tgname = d.tgname
          where g.tgfoid = 'tmpos_admission.m5_platform_authority_moved()'::regprocedure
            and g.tgtype = 29
            and g.tgenabled = 'A'
            and g.tgattr = ''::pg_catalog.int2vector
            and g.tgqual is null
            and not g.tgisinternal) <> 4 then
    raise exception 'migration 013 refused: the version triggers are not exactly the four section 4 declares'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  if not (select c.relrowsecurity from pg_catalog.pg_class c where c.oid = 'tmpos_admission.platform_authority_version'::regclass) then
    raise exception 'migration 013 refused: row level security is not enabled on tmpos_admission.platform_authority_version'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$$;

-- Phase 4.0 M5 — hardening the first server-authorized command: exact transaction-time authority, the
-- display name's bidirectional-control rule, the audit record's direct subject, and the legacy direct write
-- (M5-GIAM-D1-P1-R1; G-IAM, G-AUDIT, G-CPLOGIN; docs/phase-4/10 ADR-21)
-- Migration: 009_m5_first_command_hardening (UP)
--
-- SCOPE / TRUTH (binding):
--   - TWO ROUTINES, ONE COLUMN, ONE INDEX, THREE PRIVILEGE CHANGES. This file adds two routines to 008's
--     schema, tmpos_command — the platform authority a command transaction re-reads, and the display-name
--     operation that supersedes 008's — a subject column and its index to public.audit_event, and it moves
--     three privileges: tmpos_app loses 005's UPDATE of tenant.display_name, loses EXECUTE on 008's
--     operation, and gains EXECUTE on the two routines. It creates no table, no type, no role and no role
--     membership. Migrations 005, 006, 007 and 008 are untouched, byte for byte; 007's routines and every
--     grant 005-008 made outside those three stay as they were.
--   - WHY IT JOINS 008's SCHEMA. Both routines extend 008's command surface, and 008's rollback drops
--     tmpos_command WITHOUT CASCADE: while this file is applied, that rollback refuses loudly instead of
--     leaving these routines behind over a dropped version column. The chain rolls back newest first (owner
--     decision D4), so 009's own rollback always runs before 008's. Nothing is placed in tmpos_identity,
--     whose rollback and verify section enumerate exactly 007's three functions.
--   - (1) EXACT AUTHORITY. 007's revalidation accepts the FIRST active grant at the scope (ORDER BY ... LIMIT
--     1), so a grant added, duplicated or re-issued after the request was authorized still passes, although
--     the runtime's initial authorization refuses an actor with two platform grants (principals.ts
--     selectScope). m5_revalidate_platform_authority re-reads the same authority the authorizer decided on:
--     the actor's account (not denied, not read-only), the security version, EXACTLY ONE eligible active
--     platform grant, and that grant being the very membership and role the request was authorized under.
--     The permission itself stays in trusted source, re-decided on the role's current definition by the
--     revalidator the composition root composes (server/composition/platformAuthorization.ts).
--   - (2) THE BIDI RULE. A display name may not carry a Bidi_Control character (U+061C, U+200E, U+200F,
--     U+202A-U+202E, U+2066-U+2069): they make a name render other than it reads. Each is listed on its own — a
--     range in a bracket expression is collation-sensitive, and this class must mean the same under every collation.
--     The runtime refuses them
--     (server/runtime/tenantDisplayName.ts), and m5_tenant_display_name_update_v2 re-checks them, exactly as
--     008's operation re-checks every other rule; it is 008's operation otherwise. 008's operation stays
--     (its rollback owns it) but the runtime role may no longer call it, so no path writes a name the rule
--     refuses. Stored names are not rewritten.
--   - (3) THE AUDIT SUBJECT. A platform-scope audit record carries no tenant_id (005's scope-consistency
--     check), so the display-name command's record reached the tenant it changed only through the
--     correlation ID its outbox event shares. subject_tenant_id is the smallest typed subject: the tenant a
--     record's action targeted, independent of the scope it was authorized at, written by the command
--     transaction from the command's server-validated target. Plain uuid, no foreign key — audit_event is
--     decoupled by design (002) — and nullable, so every earlier writer and row is unchanged. The audit
--     writer's table-wide INSERT (005) covers it; nothing else is granted.
--   - (4) THE LEGACY WRITE. 005 grants tmpos_app UPDATE (display_name, legal_name) on public.tenant under
--     its tenant-scope RLS policy, and that policy trusts two settings any session may set itself
--     (app.scope_type, app.tenant_id). So every runtime login could rename a tenant outside the command —
--     no expected version, audit record, event or idempotency record. The display_name half is revoked;
--     the legal_name half serves no command yet and is left as 005 wrote it (an unrelated privilege is not
--     removed without proof that it is obsolete).
--   - NO SECRET, NO DYNAMIC SQL, NO EXTENSION, NO TEMPORARY OBJECT. Every statement is fixed text, every
--     value a parameter, every relation and function schema-qualified, and each routine pins its
--     search_path to pg_catalog then pg_temp.
--
-- Reversible via 009_m5_first_command_hardening.down.sql, which refuses while any audit record names a
-- subject (dropping the column would destroy audit evidence) and otherwise restores exactly the 008 state.
--
-- Assumes 001-008 are applied. A future managed apply targets the complete contiguous chain through the
-- newest committed migration — now 001-009 (owner decision D4); this file authorizes no apply.

-- =============================================================================
-- 0) This transaction's search path
-- =============================================================================
set local search_path = pg_catalog, pg_temp;

-- =============================================================================
-- 1) Preconditions: what this file builds on
-- =============================================================================
do $$
begin
  if pg_catalog.to_regprocedure('tmpos_command.m5_tenant_display_name_update(uuid, bigint, text)') is null
     or pg_catalog.to_regprocedure('tmpos_identity.m5_security_version(uuid)') is null
     or pg_catalog.to_regclass('public.audit_event') is null
     or not exists (select 1 from pg_catalog.pg_attribute a
                     where a.attrelid = 'public.tenant'::regclass and a.attname = 'row_version' and not a.attisdropped) then
    raise exception 'migration 009 refused: migrations 007 and 008 must be applied first'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$$;

-- =============================================================================
-- 2) The legacy direct write
-- =============================================================================
revoke update (display_name) on table public.tenant from tmpos_app;

-- =============================================================================
-- 3) The audit record's direct subject
-- =============================================================================
-- Adding a nullable column with no default rewrites no row, and fires no row trigger — 002's append-only
-- trigger stays exactly as it is.
alter table public.audit_event add column subject_tenant_id uuid;

comment on column public.audit_event.subject_tenant_id is
  'Phase 4.0 M5 (migration 009): the tenant the recorded action targeted, independent of scope_type/tenant_id (the scope it was authorized at). Written by the command transaction from the command''s server-validated target; never from request metadata. Plain column, no FK (audit is decoupled/append-only).';

create index idx_audit_event_subject_tenant_occurred on public.audit_event (subject_tenant_id, occurred_at desc)
  where subject_tenant_id is not null;

-- =============================================================================
-- 4) The exact platform authority
-- =============================================================================
-- CALLED ONLY FROM THE COMMAND TRANSACTION, after the idempotency fence and before any business state, by the
-- revalidator the transaction composition root hands the store (server/persistence/postgresPrincipalResolver.ts
-- revalidatePlatformAuthority). Its arguments are the trusted scope the canonical authorizer decided on — the
-- app-owned actor, the security version, and the membership and role it selected — never a request value.
--
-- LOCKS (binding), in one fixed order: the account FOR UPDATE, then the identity links FOR SHARE, then EVERY
-- membership row of the actor FOR SHARE in membership_id order. FOR UPDATE on the account is what makes a
-- grant ADDED concurrently deterministic: an INSERT into user_membership, or an UPDATE re-pointing a row at this
-- actor, takes a KEY SHARE lock on the account for its foreign key, which conflicts with FOR UPDATE alone — so
-- it waits until this transaction ends, and one committed before this statement is seen. The membership locks
-- do the same for a grant disabled, re-scoped, re-roled or re-activated. Under READ COMMITTED every change that
-- could REMOVE or REDIRECT this actor's authority — its account status, any of its grants, and the lifecycle of
-- any link it already has — therefore either precedes the check and is seen, or follows the command's COMMIT. A
-- link INSERTED concurrently is the one change that may still land in between: it grants nothing, it only moves
-- the security version, and the next request is refused by it. Two commands of one actor serialize on the
-- account; the fixed order keeps them from deadlocking, and a deadlock with an unrelated writer that takes these
-- rows in the opposite order is detected by PostgreSQL, which aborts one side — the command then commits nothing.
--
-- THE DECISION, each step the same as the initial authorization's (007 m5_resolve_principal, then
-- principals.ts selectScope and the read-only cap of the canonical decision):
--   1. the account exists and its status neither denies ('suspended', 'pending_activation') nor limits it to
--      reads ('read_only', 'overdue') — a command is a write. The two lists are the resolver's own (007 section 2
--      and authorizationConstants.ts), restated so both halves decide alike over 002's closed status domain
--      ('active', 'trialing', 'overdue', 'suspended', 'read_only', 'pending_activation'); a migration that widens
--      that domain must classify the new value here and in the resolver together, or the halves diverge;
--   2. the security version equals the one the request was authorized under (007's helper, recomputed under
--      the locks above);
--   3. the actor holds EXACTLY ONE active platform grant — none is unauthorized, two are ambiguous, whatever
--      their order;
--   4. that grant IS p_membership_id, held by this actor, at platform scope, with role p_role_id — equality on
--      every column, so a different membership never answers for the authorized one.
-- ANSWERS (one row, always): 'valid', or 'invalid' — one value for every failure.
create function tmpos_command.m5_revalidate_platform_authority(
  p_internal_user_id uuid,
  p_security_version text,
  p_membership_id uuid,
  p_role_id text)
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_status text;
  v_eligible integer;
begin
  if p_internal_user_id is null
     or p_security_version is null
     or pg_catalog.length(p_security_version) < 1
     or pg_catalog.length(p_security_version) > 128
     or p_membership_id is null
     or p_role_id is null
     or p_role_id !~ '^[a-z_]{1,64}$' then
    return query select 'invalid'::text;
    return;
  end if;

  -- 1. The account, locked FOR UPDATE (see LOCKS above).
  select u.status into v_status
    from public.app_user u
   where u.internal_user_id = p_internal_user_id
     for update;

  if v_status is null or v_status in ('suspended', 'pending_activation', 'read_only', 'overdue') then
    return query select 'invalid'::text;
    return;
  end if;

  -- 2. The identity links, then the security version recomputed under the locks.
  perform 1 from public.identity_link l where l.internal_user_id = p_internal_user_id order by l.link_id for share;

  if tmpos_identity.m5_security_version(p_internal_user_id) is distinct from p_security_version then
    return query select 'invalid'::text;
    return;
  end if;

  -- 3. Every grant of the actor, locked; then exactly one eligible active platform grant.
  perform 1 from public.user_membership m where m.internal_user_id = p_internal_user_id order by m.membership_id for share;

  select pg_catalog.count(*)::integer into v_eligible
    from public.user_membership m
   where m.internal_user_id = p_internal_user_id
     and m.status = 'active'
     and m.scope_type = 'platform'
     and m.tenant_id is null
     and m.store_id is null;

  if v_eligible <> 1 then
    return query select 'invalid'::text;
    return;
  end if;

  -- 4. The one is exactly the membership and the role authorized.
  if not exists (
    select 1
      from public.user_membership m
     where m.membership_id = p_membership_id
       and m.internal_user_id = p_internal_user_id
       and m.status = 'active'
       and m.scope_type = 'platform'
       and m.tenant_id is null
       and m.store_id is null
       and m.role_id = p_role_id) then
    return query select 'invalid'::text;
    return;
  end if;

  return query select 'valid'::text;
end
$$;

comment on function tmpos_command.m5_revalidate_platform_authority(uuid, text, uuid, text) is
  'Phase 4.0 M5 (migration 009): re-reads, inside the committing transaction, exactly the platform authority a command was authorized under — account not denied or read-only, security version equal, exactly one active platform grant, and that grant the authorized membership with the authorized role — locking the account FOR UPDATE and every grant FOR SHARE so a concurrent change waits. One row: valid | invalid. Supersedes 007''s first-match revalidation for platform commands.';

-- =============================================================================
-- 5) The display-name operation, with the bidirectional-control rule
-- =============================================================================
-- 008's m5_tenant_display_name_update, with one more refusal: a Bidi_Control character anywhere in the name.
-- Everything else — the argument shape, the FOR UPDATE lock, the version compared before the name, the answers
-- and the trigger that moves the version — is 008's, unchanged, and 008's section 4 documents it.
--
-- ANSWERS (one row, always): ('invalid', null) for a malformed argument, ('not_found', null),
-- ('conflict', null), ('unchanged', the current version) or ('applied', the new version).
create function tmpos_command.m5_tenant_display_name_update_v2(
  p_tenant_id uuid,
  p_expected_version bigint,
  p_display_name text)
returns table (o_outcome text, o_version bigint)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_name text;
  v_version bigint;
begin
  -- The runtime's contract (1-120 Unicode scalar values; no control character; no line or paragraph
  -- separator; no Bidi_Control character; no leading or trailing character that ECMAScript's
  -- String.prototype.trim removes), re-checked. A UTF-8 database stores no lone surrogate.
  if p_tenant_id is null
     or p_expected_version is null
     or p_expected_version operator(pg_catalog.<) 1
     or p_expected_version operator(pg_catalog.>) 9007199254740990
     or p_display_name is null
     or pg_catalog.char_length(p_display_name) operator(pg_catalog.<) 1
     or pg_catalog.char_length(p_display_name) operator(pg_catalog.>) 120
     or p_display_name operator(pg_catalog.~) '[\u0001-\u001f\u007f-\u009f\u2028\u2029]'
     or p_display_name operator(pg_catalog.~) '[\u061c\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069]'
     or p_display_name operator(pg_catalog.~) '^[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]|[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]$' then
    return query select 'invalid'::text, null::bigint;
    return;
  end if;

  select t.display_name, t.row_version into v_name, v_version
    from public.tenant t
   where t.tenant_id operator(pg_catalog.=) p_tenant_id
     for update;

  if not found then
    return query select 'not_found'::text, null::bigint;
    return;
  end if;

  if v_version operator(pg_catalog.<>) p_expected_version then
    return query select 'conflict'::text, null::bigint;
    return;
  end if;

  if v_name is not distinct from p_display_name then
    return query select 'unchanged'::text, v_version;
    return;
  end if;

  update public.tenant t
     set display_name = p_display_name
   where t.tenant_id operator(pg_catalog.=) p_tenant_id
  returning t.row_version into v_version;

  return query select 'applied'::text, v_version;
end
$$;

comment on function tmpos_command.m5_tenant_display_name_update_v2(uuid, bigint, text) is
  'Phase 4.0 M5 (migration 009): 008''s display-name operation with the Bidi_Control refusal the runtime applies. Updates one tenant''s display name at an expected row version, under a FOR UPDATE lock. One row: invalid | not_found | conflict | unchanged (current version) | applied (new version). Decides no authority.';

-- =============================================================================
-- 6) Privileges
-- =============================================================================
-- Explicit revokes first, whatever the applying principal's default privileges are (acldefault() grants
-- EXECUTE on a function to PUBLIC). tmpos_app gains EXECUTE on the two routines and loses it on 008's
-- operation, which the v2 operation supersedes.
revoke all on function tmpos_command.m5_revalidate_platform_authority(uuid, text, uuid, text) from public, anon, authenticated;
revoke all on function tmpos_command.m5_tenant_display_name_update_v2(uuid, bigint, text) from public, anon, authenticated;

grant execute on function tmpos_command.m5_revalidate_platform_authority(uuid, text, uuid, text) to tmpos_app;
grant execute on function tmpos_command.m5_tenant_display_name_update_v2(uuid, bigint, text) to tmpos_app;

revoke execute on function tmpos_command.m5_tenant_display_name_update(uuid, bigint, text) from tmpos_app;

-- =============================================================================
-- 7) Verify — what sections 2-6 say holds, and nothing else reaches it
-- =============================================================================
-- It refuses to finish while:
--   * a role the runtime could hold (tmpos_app, tmpos_audit_writer, anon, authenticated) is a MEMBER — in any
--     form, SET-only included — of the owner of tmpos_command, of tmpos_identity, or of public.tenant,
--     app_user, identity_link, user_membership or audit_event: an owner's reach needs no grant. (007's own
--     guard asks USAGE, which a SET-only membership does not report; this is the exact check, at this point
--     in the chain.);
--   * tmpos_command's ACL grants anyone but its owner anything other than tmpos_app's non-grantable USAGE;
--   * tmpos_command holds anything but 008's two functions and this file's two, or one is owned by anyone
--     but the schema's owner, is not pinned to pg_catalog then pg_temp, is not VOLATILE, or differs in
--     SECURITY DEFINER (every routine but the row-version trigger's);
--   * a function in tmpos_command carries a direct grant to anyone but its owner, other than tmpos_app's
--     non-grantable EXECUTE on this file's two routines — so 008's operation answers the runtime no longer;
--   * the schema's owner cannot run the routines (SELECT and UPDATE on public.app_user, identity_link,
--     user_membership and tenant — row locks need UPDATE — and EXECUTE on 007's version helper);
--   * any of those four roles, directly, through a membership or through PUBLIC, may UPDATE or INSERT
--     public.tenant.display_name, or DELETE a tenant row (a delete-and-re-insert would rename one too). The four
--     are the roles these migrations own; who the runtime LOGIN is, and what it is a member of, is role topology
--     verified live against that principal (gate G-DBROLE), exactly as 005-008 state;
--   * audit_event.subject_tenant_id is not a nullable uuid with no default, its index is missing, or the audit
--     writer may not insert it.
do $$
declare
  v_owner oid;
  v_bad text;
  v_count integer;
  v_count_bad text;
  v_roles name[] := array['tmpos_app', 'tmpos_audit_writer', 'anon', 'authenticated']::name[];
begin
  select n.nspowner into v_owner from pg_catalog.pg_namespace n where n.nspname = 'tmpos_command';
  if v_owner is null then
    raise exception 'migration 009 refused: the schema tmpos_command does not exist'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  select pg_catalog.string_agg(distinct r.rolname::text, ', ') into v_bad
    from pg_catalog.pg_roles r
    cross join (
      select n.nspowner as owner from pg_catalog.pg_namespace n where n.nspname in ('tmpos_command', 'tmpos_identity')
      union
      select c.relowner from pg_catalog.pg_class c
       where c.oid in ('public.tenant'::regclass, 'public.app_user'::regclass, 'public.identity_link'::regclass,
                       'public.user_membership'::regclass, 'public.audit_event'::regclass)
    ) o
   where r.rolname = any (v_roles)
     and pg_catalog.pg_has_role(r.oid, o.owner, 'MEMBER');

  if v_bad is not null then
    raise exception 'migration 009 refused: % is a member of an owner these routines or tables depend on', v_bad
      using errcode = 'object_not_in_prerequisite_state',
            hint = 'membership hands a role everything the owner holds, including a direct write of every tenant column and a direct read of every identity row';
  end if;

  select pg_catalog.string_agg(coalesce(a.grantee::regrole::text, '?') || ':' || a.privilege_type, ', ') into v_bad
    from pg_catalog.pg_namespace n
    cross join pg_catalog.aclexplode(coalesce(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) a
   where n.nspname = 'tmpos_command'
     and a.grantee <> v_owner
     and not (a.grantee = 'tmpos_app'::regrole::oid and a.privilege_type = 'USAGE' and a.is_grantable = false);

  if v_bad is not null then
    raise exception 'migration 009 refused: an unexpected privilege remains on the schema tmpos_command (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  select pg_catalog.count(*)::integer into v_count
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'tmpos_command';

  if v_count <> 4 then
    raise exception 'migration 009 refused: tmpos_command holds % functions, not 008''s two and this file''s two', v_count
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  select pg_catalog.string_agg(t.label, ', ' order by t.label) into v_bad
    from (
      select p.proname::text as label
        from pg_catalog.pg_proc p
        join pg_catalog.pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'tmpos_command'
         and (
              p.proname not in ('m5_tenant_row_version', 'm5_tenant_display_name_update',
                                'm5_tenant_display_name_update_v2', 'm5_revalidate_platform_authority')
           or p.proowner <> v_owner
           or p.proconfig is distinct from array['search_path=pg_catalog, pg_temp']::text[]
           or p.prosecdef <> (p.proname <> 'm5_tenant_row_version')
           or p.provolatile <> 'v'
         )
    ) t;

  if v_bad is not null then
    raise exception 'migration 009 refused: a routine does not match its declaration (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  select pg_catalog.string_agg(t.label, ', ' order by t.label) into v_bad
    from (
      select p.proname::text || ' -> ' || coalesce(a.grantee::regrole::text, '?') as label
        from pg_catalog.pg_proc p
        join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        cross join pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
       where n.nspname = 'tmpos_command'
         and a.grantee <> v_owner
         and not (
              a.grantee = 'tmpos_app'::regrole::oid
          and a.privilege_type = 'EXECUTE'
          and a.is_grantable = false
          and p.proname in ('m5_tenant_display_name_update_v2', 'm5_revalidate_platform_authority')
         )
    ) t;

  if v_bad is not null then
    raise exception 'migration 009 refused: an unexpected direct grant remains on a routine (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state',
            hint = 'only tmpos_app may hold EXECUTE, only on the platform authority and the v2 operation, and never WITH GRANT OPTION';
  end if;

  if not (pg_catalog.has_table_privilege(v_owner, 'public.app_user', 'SELECT')
      and pg_catalog.has_table_privilege(v_owner, 'public.app_user', 'UPDATE')
      and pg_catalog.has_table_privilege(v_owner, 'public.identity_link', 'SELECT')
      and pg_catalog.has_table_privilege(v_owner, 'public.identity_link', 'UPDATE')
      and pg_catalog.has_table_privilege(v_owner, 'public.user_membership', 'SELECT')
      and pg_catalog.has_table_privilege(v_owner, 'public.user_membership', 'UPDATE')
      and pg_catalog.has_table_privilege(v_owner, 'public.tenant', 'SELECT')
      and pg_catalog.has_table_privilege(v_owner, 'public.tenant', 'UPDATE')
      and pg_catalog.has_function_privilege(v_owner, 'tmpos_identity.m5_security_version(uuid)', 'EXECUTE')) then
    raise exception 'migration 009 refused: the owner of tmpos_command cannot run its routines'
      using errcode = 'object_not_in_prerequisite_state',
            hint = 'apply 007, 008 and 009 as the principal that owns the identity and tenant relations';
  end if;

  select pg_catalog.string_agg(r.rolname::text || ':' || x.privilege, ', ' order by r.rolname, x.privilege) into v_bad
    from pg_catalog.pg_roles r
    cross join (values ('UPDATE'), ('INSERT')) x(privilege)
   where r.rolname = any (v_roles)
     and pg_catalog.has_column_privilege(r.oid, 'public.tenant', 'display_name', x.privilege);

  -- DELETE is table-level, so it has no column form: a role that could delete and re-insert a tenant row would
  -- change a display name without the operation, so it is refused here beside the column privileges.
  select pg_catalog.string_agg(r.rolname::text || ':DELETE', ', ' order by r.rolname) into v_count_bad
    from pg_catalog.pg_roles r
   where r.rolname = any (v_roles)
     and pg_catalog.has_table_privilege(r.oid, 'public.tenant', 'DELETE');

  if v_count_bad is not null then
    v_bad := coalesce(v_bad || ', ', '') || v_count_bad;
  end if;

  if v_bad is not null then
    raise exception 'migration 009 refused: a runtime role may still write public.tenant.display_name (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state',
            hint = 'a display name changes only through the command operation; revoke the table-wide, column or PUBLIC grant that reaches it';
  end if;

  if not exists (
    select 1
      from pg_catalog.pg_attribute a
     where a.attrelid = 'public.audit_event'::regclass
       and a.attname = 'subject_tenant_id'
       and not a.attisdropped
       and a.atttypid = 'pg_catalog.uuid'::regtype
       and not a.attnotnull
       and not a.atthasdef)
     or pg_catalog.to_regclass('public.idx_audit_event_subject_tenant_occurred') is null
     or not pg_catalog.has_column_privilege('tmpos_audit_writer', 'public.audit_event', 'subject_tenant_id', 'INSERT') then
    raise exception 'migration 009 refused: public.audit_event.subject_tenant_id is not the nullable uuid, index and writer grant section 3 declares'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$$;

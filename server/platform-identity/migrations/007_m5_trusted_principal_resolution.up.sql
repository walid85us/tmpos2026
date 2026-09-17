-- Phase 4.0 M5 — the trusted principal-resolution and transaction-revalidation boundary
-- (M5 phase (i); G-DBROLE, G-CPLOGIN, G-AUDIT; docs/phase-4/04 §5, docs/phase-4/10 ADR-18)
-- Migration: 007_m5_trusted_principal_resolution (UP)
--
-- SCOPE / TRUTH (binding):
--   - THREE ROUTINES, NO TABLE, NO COLUMN, NO ROLE. This file creates its own internal schema,
--     tmpos_identity, and puts one helper and two entry routines in it. It creates no relation,
--     alters no relation created by 001-006, creates no type, creates no role and issues no role
--     membership. Migrations 005 and 006 are untouched, byte for byte — including 006's schema,
--     whose rollback and closed object inventory stay exactly as 006 wrote them (section 0b).
--   - WHY IT EXISTS. Migration 005 grants the runtime role tmpos_app no privilege at all on
--     platform_identity, app_user or identity_link (005 section 8 grants it tenant, store,
--     user_membership and tenant_feature_entitlement only). So the runtime cannot resolve a
--     provider-verified principal to its app-owned internal_user_id, and every existing reader does
--     it through the OWNER connection instead (authorizationRepository.ts getIdentityByProviderUid /
--     getAppUser default executor), which bypasses Row-Level Security. That owner read is the open
--     half of G-DBROLE. These routines replace it: they run as the schema's owner, return a bounded
--     answer, and hand the runtime role no privilege on any identity relation.
--   - READ-ONLY. Neither entry routine writes a row anywhere. m5_resolve_principal is STABLE and
--     takes no lock. m5_revalidate_principal_context is VOLATILE only because it takes FOR SHARE row
--     locks, which is how a revocation racing a command is made deterministic (section 3).
--   - NO RAW PROVIDER IDENTITY LEAVES. The provider reference is an ARGUMENT only. No return column,
--     no exception message and no hint contains auth_provider_uid, an email, a display name or any
--     part of them, and nothing here is logged. The security version is a digest that is not computed
--     over any provider reference at all.
--   - NON-DISCLOSING REFUSAL. Both routines always return exactly one row. Every refusal — an unknown
--     provider reference, an ambiguous identity, an account that may not sign in, a scope that is not
--     the actor's — returns the SAME bounded value, so no caller learns whether a particular provider
--     UID, user, tenant or store exists.
--   - NO BUSINESS RULE IS INVENTED. The account-status precedence is the one already implemented and
--     already documented: 'suspended' and 'pending_activation' deny before any role grant
--     (authorizationConstants.ts STATUS_DENY_BEFORE_ROLE), 'read_only' and 'overdue' limit to
--     read-only, everything else is normal (authorizationResolver.ts statusDisposition). Scope
--     consistency is 002's own user_membership_scope_consistency_chk. No permission is defined here:
--     a role id is returned and the permission catalog in trusted source decides, so no permission
--     policy lives in SQL.
--   - NO SECRET, NO DYNAMIC SQL, NO EXTENSION, NO TEMPORARY OBJECT. Every statement is fixed text,
--     every value is a parameter, every relation, function, operator and type is schema-qualified,
--     and each routine pins its own search_path to pg_catalog then pg_temp, so no object an attacking
--     session places on its path can answer for one of pg_catalog's.
--
-- Reversible via 007_m5_trusted_principal_resolution.down.sql, which revokes the two grants and drops
-- exactly these three functions and this schema — and nothing else, so everything 001-006 created
-- survives it intact.
--
-- Assumes 001-005 are applied: platform_identity, app_user, tenant, store, user_membership and
-- identity_link exist in public, and the NOLOGIN role tmpos_app exists (005).

-- =============================================================================
-- 0) This transaction's search path
-- =============================================================================
-- The applier's search_path is never relied on: every relation, function and operator below is
-- schema-qualified, and SET LOCAL pins resolution to pg_catalog until this transaction ends, so an
-- operator or function that an earlier schema of the applier's path defines answers neither a routine
-- body below nor section 5's check.
set local search_path = pg_catalog, pg_temp;

-- =============================================================================
-- 0b) The schema
-- =============================================================================
-- ITS OWN SCHEMA, NOT 006's. These routines could have lived in tmpos_internal, but 006's rollback
-- ends in `drop schema tmpos_internal` WITHOUT CASCADE, precisely so it fails loudly if anything it
-- did not create still lives there, and its verify section enumerates that schema's functions as
-- exactly its own eleven. Putting identity resolution inside it would make 006 un-rollbackable while
-- 007 is applied and would turn 006's closed inventory into an open one. A separate schema keeps both
-- migrations independently reversible and each one's inventory closed.
--
-- It belongs to the principal that applies this file, never to the runtime login, and only tmpos_app
-- is granted USAGE on it. No table, no type, no default privilege: three routines and nothing else.
create schema tmpos_identity;

comment on schema tmpos_identity is
  'Phase 4.0 M5: trusted principal resolution and transaction-local revalidation (migration 007). Internal: USAGE to tmpos_app alone, owned by the migration principal. Holds routines only — no table, no type.';

revoke all on schema tmpos_identity from public, anon, authenticated;
grant usage on schema tmpos_identity to tmpos_app;

-- =============================================================================
-- 1) The security version
-- =============================================================================
-- A principal's security version is a digest of the state that decides whether THIS person may hold a
-- session at all: the account's status and the lifecycle of every identity link that anchors it. It
-- changes when the account is suspended, activated, put read-only or restored, and when a link is
-- disabled, revoked or re-created — each of those writes bumps the row's updated_at through the
-- triggers 002 and 004 already install. A session carries the version it was admitted at, and the
-- runtime revokes it the moment the version it reads back differs (server/runtime/sessions.ts).
--
-- WHAT IT DELIBERATELY DOES NOT COVER: membership and role grants. Revoking a membership must
-- invalidate a command WITHOUT revoking every session the person holds elsewhere, so section 3
-- re-reads the membership itself instead of folding it into this digest.
--
-- Times enter as epoch MICROSECONDS, an integer: a timestamptz rendered as text would depend on the
-- session's DateStyle and TimeZone, so two readers of one unchanged row could disagree. Every
-- component is coalesced, because one null would make the whole concatenation null and every
-- principal would then share one version. The digest is over a versioned prefix, so a later format
-- change cannot collide with this one. SHA-256 hex is 64 lowercase hex characters, which satisfies
-- the runtime's admission-version rule (1-128 printable ASCII, no space) with no further shaping.
--
-- SECURITY INVOKER, and granted to nobody: it is reached only from the two SECURITY DEFINER routines
-- below, which already run as this schema's owner. The runtime role cannot call it.
create function tmpos_identity.m5_security_version(p_internal_user_id uuid)
returns text
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
  select pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(
      'm5.sv.v1|'
      || coalesce(u.status, '-')
      || '|' || coalesce((extract(epoch from u.updated_at) * 1000000)::bigint::text, '-')
      || '|' || coalesce((
           select pg_catalog.string_agg(
                    l.status || ':' || (extract(epoch from l.updated_at) * 1000000)::bigint::text,
                    ',' order by l.link_id)
             from public.identity_link l
            where l.internal_user_id = u.internal_user_id), '-'),
      'UTF8')),
    'hex')
  from public.app_user u
  where u.internal_user_id = p_internal_user_id
$$;

comment on function tmpos_identity.m5_security_version(uuid) is
  'Phase 4.0 M5: a principal''s security version — a SHA-256 digest of the account status and identity-link lifecycle that decide whether the person may hold a session. Membership grants are deliberately excluded; migration 007 section 3 re-reads those. Returns no row for an unknown actor. Reached only from the two SECURITY DEFINER routines of migration 007.';

-- =============================================================================
-- 2) m5_resolve_principal — a provider-verified reference to the trusted actor
-- =============================================================================
-- The only input is the provider reference the authentication boundary has ALREADY verified. It is
-- never an authority by itself: this routine decides, against durable state, whether it names an
-- account that may act, and what that account is.
--
-- Exactly one row comes back, always with the same shape:
--   outcome          'resolved' or 'refused' — and nothing else distinguishes the refusals
--   actor_id         the app-owned internal_user_id, or null
--   account_status   the durable app_user.status, or null
--   limitation       'none' or 'read_only' (status read_only/overdue), or null
--   security_version section 1's digest, or null
--   memberships      a jsonb ARRAY of the actor's usable grants, or null
--
-- IT REFUSES, IDENTICALLY, WHEN:
--   * the provider or the reference is absent, over-long, or not one of the two providers the audit
--     contract admits (002 audit_event_actor_provider_chk: 'supabase', 'firebase');
--   * no platform_identity row carries that reference;
--   * more than one does — which 001's unique (auth_provider, auth_provider_uid) forbids, so it can
--     only mean the constraint is gone, and a resolution under a missing uniqueness guarantee is not
--     one this routine will make;
--   * more than one ACTIVE identity_link claims that same provider reference — 004's partial unique
--     indexes forbid it, so finding it means the uniqueness guarantee is not in force;
--   * no app_user row exists for the anchor, so there is no app-owned account behind the reference;
--   * the account's status denies before any role is consulted ('suspended', 'pending_activation');
--   * the actor holds more than 200 usable memberships, so the answer would be unbounded.
--
-- A DISABLED OR REVOKED LINK DOES NOT REFUSE ON ITS OWN. 004 keeps disabled and revoked links as
-- history and enforces uniqueness only among active ones; a person whose second provider was unlinked
-- still signs in with the first. Their lifecycle is in the security version instead, so unlinking
-- still revokes every session the person holds.
--
-- MEMBERSHIPS ARE USABLE GRANTS, NOT ROWS. A membership appears only when it is itself active AND the
-- scope it names is whole: a tenant grant needs its tenant to exist and not be in a denying status; a
-- store grant needs both, and needs the store to belong to the membership's own tenant. A membership
-- naming a store under a different tenant is exactly the inconsistency that must never grant, so it is
-- left out — it is never repaired and never widened. Each entry carries the tenant's and the store's
-- status so the caller can apply the same read-only limiting the resolver already applies, without a
-- second read of state that could have changed in between.
create function tmpos_identity.m5_resolve_principal(p_auth_provider text, p_auth_provider_uid text)
returns table (outcome text, actor_id uuid, account_status text, limitation text, security_version text, memberships jsonb)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_actor uuid;
  v_status text;
  v_matches integer;
  v_active_links integer;
  v_memberships jsonb;
  v_membership_count integer;
begin
  -- Refused, and nothing is read: the caller learns nothing from a malformed argument that it could
  -- not have learned from the argument itself.
  if p_auth_provider is null or p_auth_provider not in ('firebase', 'supabase')
     or p_auth_provider_uid is null
     or pg_catalog.length(p_auth_provider_uid) = 0
     or pg_catalog.length(p_auth_provider_uid) > 255 then
    return query select 'refused'::text, null::uuid, null::text, null::text, null::text, null::jsonb;
    return;
  end if;

  -- The anchor. Counted as well as selected: a duplicate means 001's uniqueness is not in force, and
  -- this routine does not resolve an identity under that condition.
  select pg_catalog.count(*)::integer, (pg_catalog.array_agg(pi.internal_user_id))[1]
    into v_matches, v_actor
    from public.platform_identity pi
   where pi.auth_provider = p_auth_provider
     and pi.auth_provider_uid = p_auth_provider_uid;

  if v_matches <> 1 or v_actor is null then
    return query select 'refused'::text, null::uuid, null::text, null::text, null::text, null::jsonb;
    return;
  end if;

  -- Ambiguous anchoring: more than one ACTIVE link claims THIS provider reference. 004's partial
  -- unique indexes forbid that among active links, so finding it means the constraint is not in
  -- force — and an identity is not resolved under a missing uniqueness guarantee. Note what is NOT
  -- refused: one person may hold several active links to DIFFERENT provider references (004 permits
  -- it, and every one of them anchors the same internal_user_id), so counting a person's links would
  -- lock out a legitimately multi-linked account for no gain.
  select pg_catalog.count(*)::integer into v_active_links
    from public.identity_link l
   where l.status = 'active'
     and ((p_auth_provider = 'firebase' and l.firebase_auth_provider_uid = p_auth_provider_uid)
       or (p_auth_provider = 'supabase' and l.supabase_auth_provider_uid = p_auth_provider_uid));

  if v_active_links > 1 then
    return query select 'refused'::text, null::uuid, null::text, null::text, null::text, null::jsonb;
    return;
  end if;

  -- The app-owned account and its server-authoritative status, which precedes every role grant.
  select u.status into v_status from public.app_user u where u.internal_user_id = v_actor;

  if v_status is null or v_status in ('suspended', 'pending_activation') then
    return query select 'refused'::text, null::uuid, null::text, null::text, null::text, null::jsonb;
    return;
  end if;

  -- The usable grants, ordered so one unchanged state always produces one unchanged answer.
  select coalesce(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'membershipId', g.membership_id,
               'scopeType',    g.scope_type,
               'tenantId',     g.tenant_id,
               'storeId',      g.store_id,
               'roleId',       g.role_id,
               'tenantStatus', g.tenant_status,
               'storeStatus',  g.store_status)
             order by g.membership_id),
           '[]'::jsonb),
         pg_catalog.count(*)::integer
    into v_memberships, v_membership_count
    from (
      select m.membership_id, m.scope_type, m.tenant_id, m.store_id, m.role_id,
             t.status as tenant_status, s.status as store_status
        from public.user_membership m
        left join public.tenant t on t.tenant_id = m.tenant_id
        left join public.store  s on s.store_id  = m.store_id
       where m.internal_user_id = v_actor
         and m.status = 'active'
         and (
              (m.scope_type = 'platform' and m.tenant_id is null and m.store_id is null)
           or (m.scope_type = 'tenant'
               and m.tenant_id is not null and m.store_id is null
               and t.tenant_id is not null and t.status not in ('suspended', 'pending_activation'))
           or (m.scope_type = 'store'
               and m.tenant_id is not null and m.store_id is not null
               and t.tenant_id is not null and s.store_id is not null
               and s.tenant_id = m.tenant_id
               and t.status not in ('suspended', 'pending_activation')
               and s.status not in ('suspended', 'pending_activation'))
         )
    ) g;

  -- A bounded answer or none: 200 usable grants is far above any real principal and far below a
  -- payload that could burden the caller's validation.
  if v_membership_count > 200 then
    return query select 'refused'::text, null::uuid, null::text, null::text, null::text, null::jsonb;
    return;
  end if;

  return query
    select 'resolved'::text,
           v_actor,
           v_status,
           case when v_status in ('read_only', 'overdue') then 'read_only' else 'none' end,
           tmpos_identity.m5_security_version(v_actor),
           v_memberships;
end
$$;

comment on function tmpos_identity.m5_resolve_principal(text, text) is
  'Phase 4.0 M5: resolves a provider-verified reference to the app-owned actor, its status, its security version and its usable membership grants. Always one row; every refusal is identical, so no caller learns whether a provider UID, user, tenant or store exists. Read-only, takes no lock, and returns no provider reference.';

-- =============================================================================
-- 3) m5_revalidate_principal_context — the same authority, re-read inside the command's transaction
-- =============================================================================
-- A command is planned from a context resolved earlier, on another connection, before the idempotency
-- lease was even granted. Between then and the commit the account can be suspended, the link revoked,
-- the membership withdrawn, the tenant or the store suspended. This routine is how the committing
-- transaction re-reads all of it, so no command commits on authority that no longer exists.
--
-- ORDER (binding): the caller invokes this AFTER the idempotency fence has answered and BEFORE it
-- reads or writes any business state. A stale or lost lease therefore still refuses first and learns
-- nothing about the identity, and a revoked actor never reaches a mutator.
--
-- IT TAKES NO PROVIDER REFERENCE. The command transaction carries the app-owned internal_user_id and
-- the version, never a provider UID, a token or a cookie.
--
-- CONCURRENCY (the documented rule). Every row the decision rests on is read FOR SHARE, in ONE fixed
-- order — app_user, identity_link, tenant, store, user_membership. Under READ COMMITTED that makes the race
-- deterministic in both directions: a revocation that committed before this statement is seen and
-- refuses the command, and a revocation that has not committed yet blocks on these locks until this
-- transaction commits or rolls back, so it can never slip in between this check and the COMMIT. The
-- fixed order is what keeps two concurrent commands on one actor from deadlocking.
--
-- Exactly one row comes back: ('valid', the role id still granted at that exact scope) or
-- ('invalid', null) — one value for every failure, so nothing distinguishes a suspended account from
-- a withdrawn membership from a scope that was never the actor's. The PERMISSION is not decided here:
-- the role id goes back to the permission catalog in trusted source, so no permission policy lives in
-- SQL and there is one catalog rather than two.
create function tmpos_identity.m5_revalidate_principal_context(
  p_internal_user_id uuid,
  p_security_version text,
  p_scope_type text,
  p_tenant_id uuid,
  p_store_id uuid)
returns table (outcome text, granted_role_id text)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_status text;
  v_tenant_status text;
  v_store_status text;
  v_store_tenant uuid;
  v_role text;
begin
  -- The argument shape, including 002's own scope consistency: platform carries neither id, tenant
  -- carries a tenant only, store carries both.
  if p_internal_user_id is null
     or p_security_version is null
     or pg_catalog.length(p_security_version) = 0
     or pg_catalog.length(p_security_version) > 128
     or p_scope_type is null
     or p_scope_type not in ('platform', 'tenant', 'store')
     or (p_scope_type = 'platform' and (p_tenant_id is not null or p_store_id is not null))
     or (p_scope_type = 'tenant'   and (p_tenant_id is null or p_store_id is not null))
     or (p_scope_type = 'store'    and (p_tenant_id is null or p_store_id is null)) then
    return query select 'invalid'::text, null::text;
    return;
  end if;

  -- 1. The account, locked against a concurrent status change.
  select u.status into v_status
    from public.app_user u
   where u.internal_user_id = p_internal_user_id
     for share;

  if v_status is null or v_status in ('suspended', 'pending_activation') then
    return query select 'invalid'::text, null::text;
    return;
  end if;

  -- 2. The identity links, locked too. The version digest is computed from them as well as from the
  --    account, so leaving them unlocked would make only ONE of the two revocation levers the version
  --    covers deterministic: a suspension would block, while a link revoked concurrently could commit
  --    after this check. Locked here, between the account and the scope, so the order stays fixed.
  perform 1 from public.identity_link l where l.internal_user_id = p_internal_user_id for share;

  -- 3. The security version, compared exactly. Recomputed now, under the locks taken above, so a
  --    status change or a link lifecycle change committed since the context was resolved shows up here.
  if tmpos_identity.m5_security_version(p_internal_user_id) is distinct from p_security_version then
    return query select 'invalid'::text, null::text;
    return;
  end if;

  -- 4. The tenant, then the store — each locked, each checked for a status that still permits action,
  --    and the store checked against the tenant the scope names.
  if p_tenant_id is not null then
    select t.status into v_tenant_status from public.tenant t where t.tenant_id = p_tenant_id for share;
    if v_tenant_status is null or v_tenant_status in ('suspended', 'pending_activation') then
      return query select 'invalid'::text, null::text;
      return;
    end if;
  end if;

  if p_store_id is not null then
    select s.status, s.tenant_id into v_store_status, v_store_tenant
      from public.store s where s.store_id = p_store_id for share;
    if v_store_status is null or v_store_tenant is distinct from p_tenant_id
       or v_store_status in ('suspended', 'pending_activation') then
      return query select 'invalid'::text, null::text;
      return;
    end if;
  end if;

  -- 5. The grant itself, at EXACTLY the scope the command names — never a broader one. A platform
  --    membership does not answer for a tenant command, and a tenant membership does not answer for a
  --    store command: the scope columns are compared with IS NOT DISTINCT FROM, so a null matches only
  --    a null. Locked last, so a withdrawal cannot commit between this read and the command's COMMIT.
  select m.role_id into v_role
    from public.user_membership m
   where m.internal_user_id = p_internal_user_id
     and m.status = 'active'
     and m.scope_type = p_scope_type
     and m.tenant_id is not distinct from p_tenant_id
     and m.store_id is not distinct from p_store_id
   order by m.membership_id
   limit 1
     for share;

  if v_role is null then
    return query select 'invalid'::text, null::text;
    return;
  end if;

  return query select 'valid'::text, v_role;
end
$$;

comment on function tmpos_identity.m5_revalidate_principal_context(uuid, text, text, uuid, uuid) is
  'Phase 4.0 M5: re-reads an actor''s authority inside the committing transaction, after the idempotency fence and before any business state — account status, security version, tenant/store status and the active membership at exactly that scope — each row FOR SHARE in a fixed order so a concurrent revocation is deterministic. Returns the still-granted role id; the permission itself is decided by the catalog in trusted source.';

-- =============================================================================
-- 4) Privileges — the two entry routines to the runtime role, nothing else
-- =============================================================================
-- Explicit revokes first, whatever the applying principal's default privileges are, because
-- acldefault() grants EXECUTE on a function to PUBLIC: a function nobody revoked is a function
-- everybody may call. Section 5 then refuses to finish while any grant beyond the two below remains.
--
-- WHAT IS NOT GRANTED, AND WHY IT MATTERS. tmpos_app gains no privilege on platform_identity,
-- app_user, identity_link, tenant, store or user_membership beyond what migration 005 already gave
-- it, and none at all on the version helper. It cannot read an identity row, cannot enumerate one,
-- and cannot compute a version for an actor it has not resolved. Every answer it can obtain is one of
-- the two bounded rows above.
revoke all on function tmpos_identity.m5_security_version(uuid) from public, anon, authenticated, tmpos_app;
revoke all on function tmpos_identity.m5_resolve_principal(text, text) from public, anon, authenticated;
revoke all on function tmpos_identity.m5_revalidate_principal_context(uuid, text, text, uuid, uuid) from public, anon, authenticated;

grant execute on function tmpos_identity.m5_resolve_principal(text, text) to tmpos_app;
grant execute on function tmpos_identity.m5_revalidate_principal_context(uuid, text, text, uuid, uuid) to tmpos_app;

-- =============================================================================
-- 5) Verify — these three functions are what sections 1-4 say, and nothing else holds them
-- =============================================================================
-- This schema is 007's alone, so the check enumerates it: every function in tmpos_identity must be
-- one of this file's three, and nothing else may live here. It refuses to finish while:
--   * a function in this schema is not exactly one of the three, is present more than once, is owned
--     by anyone but the schema's owner, is not pinned to pg_catalog then pg_temp, or differs from the section that declares it in
--     SECURITY DEFINER (the two entry routines are; the version helper is not) or in volatility (the
--     helper and the resolver are STABLE — a routine that could write is not a read-only resolver —
--     and the revalidator is VOLATILE because it locks);
--   * the ACL of any of the three carries a direct grant to any role but the owner, other than
--     tmpos_app's EXECUTE on the two entry routines — or grants tmpos_app that EXECUTE with the right
--     to grant it on, which would let the runtime role widen its own reach.
-- An ACL never set is read as its built-in default, so a function nobody revoked from PUBLIC is
-- caught here too. Every comparison is between exact types, so no operator on the applying session's
-- path can outrank pg_catalog's own.
do $$
declare
  v_owner oid;
  v_bad text;
  v_count integer;
begin
  select n.nspowner into v_owner from pg_catalog.pg_namespace n where n.nspname = 'tmpos_identity';
  if v_owner is null then
    raise exception 'migration 007 refused: the schema tmpos_internal does not exist'
      using errcode = 'object_not_in_prerequisite_state',
            hint = 'apply migration 006 before 007';
  end if;

  -- Membership in the schema's owner hands a role everything the owner holds without a grant of its
  -- own — including direct SELECT on every identity relation these routines exist to keep out of the
  -- runtime's reach. Migration 006 refuses in that state; so does this one, because this is the file
  -- that adds two owner-privileged entry points.
  select pg_catalog.string_agg(r.rolname::text, ', ' order by r.rolname) into v_bad
    from pg_catalog.pg_roles r
   where r.rolname in ('tmpos_app', 'tmpos_audit_writer', 'anon', 'authenticated')
     and pg_catalog.pg_has_role(r.oid, v_owner, 'USAGE');

  if v_bad is not null then
    raise exception 'migration 007 refused: % is a member of the schema owner', v_bad
      using errcode = 'object_not_in_prerequisite_state',
            hint = 'membership would hand the runtime role every privilege the owner holds, including direct reads of the identity relations these routines exist to keep out of its reach';
  end if;

  select pg_catalog.count(*)::integer into v_count
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'tmpos_identity';

  if v_count <> 3 then
    raise exception 'migration 007 refused: tmpos_identity holds % functions, not this file''s three', v_count
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  select pg_catalog.string_agg(t.label, ', ' order by t.label) into v_bad
    from (
      select p.proname::text as label
        from pg_catalog.pg_proc p
        join pg_catalog.pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'tmpos_identity'
         and p.proname in ('m5_security_version', 'm5_resolve_principal', 'm5_revalidate_principal_context')
         and (
              p.proowner <> v_owner
           or p.proconfig is distinct from array['search_path=pg_catalog, pg_temp']::text[]
           or p.prosecdef <> (p.proname <> 'm5_security_version')
           or (p.proname = 'm5_revalidate_principal_context' and p.provolatile <> 'v')
           or (p.proname <> 'm5_revalidate_principal_context' and p.provolatile <> 's')
         )
    ) t;

  if v_bad is not null then
    raise exception 'migration 007 refused: a routine does not match its declaration (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state',
            hint = 'the three routines must be owned by the schema owner, pinned to pg_catalog then pg_temp, and carry the security and volatility attributes sections 1-3 declare';
  end if;

  select pg_catalog.string_agg(t.label, ', ' order by t.label) into v_bad
    from (
      select p.proname::text || ' -> ' || coalesce(a.grantee::regrole::text, '?') as label
        from pg_catalog.pg_proc p
        join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        cross join pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
       where n.nspname = 'tmpos_identity'
         and p.proname in ('m5_security_version', 'm5_resolve_principal', 'm5_revalidate_principal_context')
         and a.grantee <> v_owner
         and not (
              a.grantee = 'tmpos_app'::regrole::oid
          and a.privilege_type = 'EXECUTE'
          and a.is_grantable = false
          and p.proname in ('m5_resolve_principal', 'm5_revalidate_principal_context')
         )
    ) t;

  if v_bad is not null then
    raise exception 'migration 007 refused: an unexpected direct grant remains on a routine (%)', v_bad
      using errcode = 'object_not_in_prerequisite_state',
            hint = 'only tmpos_app may hold EXECUTE, only on the two entry routines, and never WITH GRANT OPTION';
  end if;
end
$$;

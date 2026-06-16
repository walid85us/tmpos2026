-- =============================================================================
-- Phase 1.5 M11.1 — DEV Bootstrap: platform owner + minimal tenant/store
-- =============================================================================
-- DEV ONLY. OWNER-RUN. SQL EDITOR. REQUIRES 003 APPLIED FIRST.
-- DO NOT APPLY TO PRODUCTION. DO NOT COMMIT REAL VALUES INTO THIS TEMPLATE.
--
-- This is an EXAMPLE TEMPLATE, not an applied migration. It lives OUTSIDE
-- server/platform-identity/migrations/ so the migration runner never discovers or
-- applies it. The owner copies it into the Supabase SQL Editor, replaces the
-- REPLACE_* placeholders, and runs it manually against the DEV project only.
--
-- PRECONDITION: migration 003_platform_role_vocabulary_alignment must be applied
-- first, otherwise the platform membership role_id = 'system_owner' violates the
-- (legacy) CHECK and the insert is rejected.
--
-- WHAT IT DOES: creates the minimum durable rows a future read-only resolver/live
-- diagnostic needs — one app_user (active), one tenant, one store, a platform
-- owner membership, and (optionally) tenant/store owner memberships and a tiny
-- example entitlement set.
--
-- SAFETY (binding):
--   - Contains NO connection string, NO service role key, NO password, NO token,
--     NO raw JWT. None of those belong in a seed.
--   - Inserts NO audit_event rows (no durable audit writer exists yet; audit is
--     append-only and owned by a future milestone).
--   - Trusts NO client claim and NO provider user_metadata. Identity is resolved
--     server-side from the durable platform_identity table only.
--   - Fail-closed: every insert is keyed off a platform_identity lookup. If the
--     lookup matches no row, nothing is inserted.
--
-- IDEMPOTENT: deterministic DEV UUID literals + ON CONFLICT DO NOTHING. Re-running
-- changes nothing. No schema is modified; no new columns/slugs are introduced.
--
-- -----------------------------------------------------------------------------
-- PLACEHOLDERS to replace before running (DEV values only):
--   REPLACE_AUTH_PROVIDER      e.g. supabase
--   REPLACE_AUTH_PROVIDER_UID  the provider subject (uid) of the DEV test user
-- The pair (auth_provider, auth_provider_uid) is UNIQUE on platform_identity, so
-- the lookup below can match at most one row (no ambiguity).
--
-- DETERMINISTIC DEV UUID LITERALS (example values — keep stable across re-runs):
--   tenant_id = 11111111-1111-4111-8111-111111111111
--   store_id  = 22222222-2222-4222-8222-222222222222
-- =============================================================================

-- 1) app_user (status active), keyed to the durable identity. Inserts nothing if
--    the identity lookup matches no row (fail-closed).
insert into public.app_user (internal_user_id, status, display_name)
select pi.internal_user_id, 'active', pi.display_name
from public.platform_identity pi
where pi.auth_provider = 'REPLACE_AUTH_PROVIDER'
  and pi.auth_provider_uid = 'REPLACE_AUTH_PROVIDER_UID'
on conflict (internal_user_id) do nothing;

-- 2) tenant (deterministic DEV UUID, active, example plan).
insert into public.tenant (tenant_id, display_name, plan_key, status)
values ('11111111-1111-4111-8111-111111111111'::uuid, 'DEV Bootstrap Tenant', 'starter', 'active')
on conflict (tenant_id) do nothing;

-- 3) store (deterministic DEV UUID, child of the tenant, active).
insert into public.store (store_id, tenant_id, store_name, status)
values ('22222222-2222-4222-8222-222222222222'::uuid,
        '11111111-1111-4111-8111-111111111111'::uuid,
        'DEV Bootstrap Store', 'active')
on conflict (store_id) do nothing;

-- 4a) Platform owner membership (canonical role_id = 'system_owner').
insert into public.user_membership (internal_user_id, tenant_id, store_id, scope_type, role_id, status)
select pi.internal_user_id, null, null, 'platform', 'system_owner', 'active'
from public.platform_identity pi
where pi.auth_provider = 'REPLACE_AUTH_PROVIDER'
  and pi.auth_provider_uid = 'REPLACE_AUTH_PROVIDER_UID'
on conflict on constraint user_membership_unique_grant do nothing;

-- 4b) OPTIONAL tenant owner membership (uncomment to also exercise the tenant path).
-- insert into public.user_membership (internal_user_id, tenant_id, store_id, scope_type, role_id, status)
-- select pi.internal_user_id, '11111111-1111-4111-8111-111111111111'::uuid, null, 'tenant', 'store_owner', 'active'
-- from public.platform_identity pi
-- where pi.auth_provider = 'REPLACE_AUTH_PROVIDER'
--   and pi.auth_provider_uid = 'REPLACE_AUTH_PROVIDER_UID'
-- on conflict on constraint user_membership_unique_grant do nothing;

-- 4c) OPTIONAL store owner membership (uncomment to also exercise the store path).
-- insert into public.user_membership (internal_user_id, tenant_id, store_id, scope_type, role_id, status)
-- select pi.internal_user_id,
--        '11111111-1111-4111-8111-111111111111'::uuid,
--        '22222222-2222-4222-8222-222222222222'::uuid,
--        'store', 'store_owner', 'active'
-- from public.platform_identity pi
-- where pi.auth_provider = 'REPLACE_AUTH_PROVIDER'
--   and pi.auth_provider_uid = 'REPLACE_AUTH_PROVIDER_UID'
-- on conflict on constraint user_membership_unique_grant do nothing;

-- 5) OPTIONAL tiny example entitlement set (source 'manual'). Do NOT seed every
--    feature — the feature_key catalog lives in code; plan-derived materialization
--    is a later milestone. Two illustrative keys only.
insert into public.tenant_feature_entitlement (tenant_id, feature_key, enabled, source)
values
  ('11111111-1111-4111-8111-111111111111'::uuid, 'shipping_provider_configuration', true, 'manual'),
  ('11111111-1111-4111-8111-111111111111'::uuid, 'pickup_requests', true, 'manual')
on conflict (tenant_id, feature_key) do nothing;

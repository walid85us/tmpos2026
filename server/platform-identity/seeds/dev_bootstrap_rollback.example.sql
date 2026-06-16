-- =============================================================================
-- Phase 1.5 M11.1 — DEV Bootstrap ROLLBACK (cleanup)
-- =============================================================================
-- DEV ONLY. OWNER-RUN. SQL EDITOR. DO NOT APPLY TO PRODUCTION.
--
-- Reverses dev_bootstrap_platform_owner.example.sql. Deletes only the rows that
-- seed created, using the same deterministic DEV UUID literals and the same
-- platform_identity lookup.
--
-- SAFETY (binding):
--   - NEVER deletes audit_event. This file does not touch audit_event at all.
--   - Do NOT run if any audit/compliance records depend on this data — audit rows
--     are decoupled (no FK) and survive this cleanup by design, but a fuller
--     compliance review is still the owner's responsibility before deletion.
--   - For DEV cleanup only. Contains NO connection string, service role key,
--     password, token, or raw JWT.
--
-- Deletes in FK-safe order: user_membership → tenant_feature_entitlement → store
-- → tenant → app_user.
--
-- PLACEHOLDERS to replace (must match the seed):
--   REPLACE_AUTH_PROVIDER, REPLACE_AUTH_PROVIDER_UID
-- =============================================================================

-- 1) memberships (platform + the seeded tenant/store).
delete from public.user_membership
where internal_user_id in (
        select pi.internal_user_id from public.platform_identity pi
        where pi.auth_provider = 'REPLACE_AUTH_PROVIDER'
          and pi.auth_provider_uid = 'REPLACE_AUTH_PROVIDER_UID')
  and (scope_type = 'platform'
       or tenant_id = '11111111-1111-4111-8111-111111111111'::uuid
       or store_id = '22222222-2222-4222-8222-222222222222'::uuid);

-- 2) entitlements for the seeded tenant.
delete from public.tenant_feature_entitlement
where tenant_id = '11111111-1111-4111-8111-111111111111'::uuid;

-- 3) store.
delete from public.store
where store_id = '22222222-2222-4222-8222-222222222222'::uuid;

-- 4) tenant.
delete from public.tenant
where tenant_id = '11111111-1111-4111-8111-111111111111'::uuid;

-- 5) app_user.
delete from public.app_user
where internal_user_id in (
        select pi.internal_user_id from public.platform_identity pi
        where pi.auth_provider = 'REPLACE_AUTH_PROVIDER'
          and pi.auth_provider_uid = 'REPLACE_AUTH_PROVIDER_UID');

-- Phase 1.5 M11.1 — Platform Role Vocabulary Alignment
-- Migration: 003_platform_role_vocabulary_alignment (UP)
--
-- SCOPE / TRUTH (binding):
--   - FILE-ONLY NOW. This migration is NOT applied by any runtime. Application is a
--     separate, owner-approved step (Supabase SQL Editor paste, or the guarded
--     scripts/supabase-migrate.ts apply). DEV first; PRODUCTION untouched.
--   - This migration ONLY aligns the platform-scope role vocabulary on
--     public.user_membership. It touches NO other table. It inserts NO bootstrap
--     rows. It inserts NO audit_event rows. It uses NO secrets.
--   - It does NOT edit 002 (already applied to DEV). Applied migrations are
--     immutable; the schema is evolved forward via this new 003 only.
--
-- WHY: the durable 002 CHECK constrained platform role_id to a placeholder
-- vocabulary (platform_owner|platform_admin|platform_ops|platform_support|
-- platform_readonly) that exists NOWHERE in the live frontend engine, the M9
-- contract, or the M11 resolver. The canonical vocabulary used everywhere else is
-- system_owner|support_admin|billing_admin|operations_admin|security_admin. This
-- migration aligns the DB to that canonical vocabulary (DB → contract, not the
-- reverse), so a future platform owner membership can be stored as 'system_owner'.
--
-- DESIGN:
--   - platform_admin and platform_readonly are NOT auto-mapped. They have no honest
--     canonical target (platform_admin is ambiguous; read-only is modeled by
--     account/status, not a role). If any such row exists at apply time, the new
--     CHECK below FAILS LOUDLY, forcing manual review instead of a silent re-grant.
--   - Order matters: DROP the old CHECK first, THEN forward-map the three
--     unambiguous legacy roles, THEN ADD the canonical CHECK. (Mapping before the
--     drop would violate the still-active legacy CHECK.)
--   - Idempotent / safe to re-run: DROP ... IF EXISTS; UPDATEs are no-ops once the
--     legacy values are gone; the CHECK is re-added after the drop.

-- 1) Remove the legacy platform-role CHECK so the forward-map UPDATEs are legal.
alter table public.user_membership
  drop constraint if exists user_membership_role_scope_chk;

-- 2) Forward-map ONLY the three unambiguous legacy platform roles (platform scope).
--    Re-running is a no-op once the legacy values no longer exist.
update public.user_membership set role_id = 'system_owner'     where scope_type = 'platform' and role_id = 'platform_owner';
update public.user_membership set role_id = 'support_admin'     where scope_type = 'platform' and role_id = 'platform_support';
update public.user_membership set role_id = 'operations_admin'  where scope_type = 'platform' and role_id = 'platform_ops';
-- NOT mapped (by design): platform_admin, platform_readonly. Any surviving such row
-- makes the ADD CONSTRAINT below fail loudly — that loud failure is the intended
-- fail-closed behaviour (manual review required). DEV is empty (M10.1, 0 rows).

-- 3) Add the canonical role/scope CHECK. Platform scope = the five canonical roles;
--    tenant/store scope = the unchanged tenant roles. The scope-consistency CHECK
--    from 002 (user_membership_scope_consistency_chk) is intentionally LEFT ALONE.
alter table public.user_membership
  add constraint user_membership_role_scope_chk check (
    (scope_type = 'platform' and role_id in
      ('system_owner', 'support_admin', 'billing_admin', 'operations_admin', 'security_admin'))
    or (scope_type in ('tenant', 'store') and role_id in
      ('store_owner', 'manager', 'technician', 'sales_staff'))
  );

-- 4) Document the canonical vocabulary on the column.
comment on column public.user_membership.role_id is
  'Text role id. Platform scope (canonical): system_owner|support_admin|billing_admin|operations_admin|security_admin. Tenant/store scope: store_owner|manager|technician|sales_staff. Read-only behaviour is modeled by account/status (app_user.status / tenant.status / store.status = read_only), NOT by a platform_readonly role. Aligned to the M9 contract + frontend engine in Phase 1.5 M11.1 (migration 003).';

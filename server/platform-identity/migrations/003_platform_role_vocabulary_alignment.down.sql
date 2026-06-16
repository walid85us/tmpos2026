-- Phase 1.5 M11.1 — Platform Role Vocabulary Alignment
-- Migration: 003_platform_role_vocabulary_alignment (DOWN / rollback)
--
-- ⚠ DEV ROLLBACK ONLY.
--   - Reverts the canonical platform-role CHECK back to the legacy 002 vocabulary.
--   - NEVER run against production without a verified backup and a compliance
--     review.
--   - NEVER deletes audit_event (append-only compliance evidence). This file does
--     not touch audit_event at all.
--   - FAILS LOUDLY if billing_admin or security_admin platform rows exist: those
--     canonical roles have NO legacy equivalent, so the restored legacy CHECK
--     rejects them. That is intended — reverting such rows is a manual decision.
--
-- Idempotent / safe to re-run: DROP ... IF EXISTS; UPDATEs are no-ops once values
-- are reversed; the legacy CHECK is re-added after the drop.

-- 1) Remove the canonical CHECK so the reverse-map UPDATEs are legal.
alter table public.user_membership
  drop constraint if exists user_membership_role_scope_chk;

-- 2) Reverse-map ONLY the three unambiguous canonical roles (platform scope).
update public.user_membership set role_id = 'platform_owner'   where scope_type = 'platform' and role_id = 'system_owner';
update public.user_membership set role_id = 'platform_support' where scope_type = 'platform' and role_id = 'support_admin';
update public.user_membership set role_id = 'platform_ops'     where scope_type = 'platform' and role_id = 'operations_admin';
-- NOT reverse-mapped (no legacy equivalent): billing_admin, security_admin. Any
-- surviving such platform row makes the legacy ADD CONSTRAINT below fail loudly —
-- intended fail-closed behaviour requiring manual review.

-- 3) Restore the legacy 002 role/scope CHECK. Tenant/store roles are unchanged.
--    The scope-consistency CHECK from 002 is intentionally LEFT ALONE.
alter table public.user_membership
  add constraint user_membership_role_scope_chk check (
    (scope_type = 'platform' and role_id in
      ('platform_owner', 'platform_admin', 'platform_ops', 'platform_support', 'platform_readonly'))
    or (scope_type in ('tenant', 'store') and role_id in
      ('store_owner', 'manager', 'technician', 'sales_staff'))
  );

-- 4) Restore the legacy column comment.
comment on column public.user_membership.role_id is
  'Text role id. Platform scope: platform_owner|platform_admin|platform_ops|platform_support|platform_readonly. Tenant/store scope: store_owner|manager|technician|sales_staff.';

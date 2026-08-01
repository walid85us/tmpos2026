-- Phase 4.0 M3 S2 — Database Principal Separation + Tenant/Store RLS Foundation
-- Migration: 005_principal_separation_rls_foundation (DOWN / rollback)
--
-- ⚠ DEV ROLLBACK ONLY. This removes the tenant/store isolation layer.
--   - Rolling 005 back returns the database to "owner-only, RLS enabled, no policies" — the
--     001-004 posture. That posture is safe ONLY while no non-owner principal exists. If a
--     LOGIN role has been granted membership in tmpos_app or tmpos_audit_writer, revoke that
--     membership and retire the role BEFORE running this file: DROP ROLE below will otherwise
--     fail, which is the intended loud failure rather than a silent partial rollback.
--   - This file reverses ONLY objects that 005 created. It drops no table, disables no RLS,
--     removes no 001-004 constraint, and re-grants nothing to public, anon or authenticated.
--   - It does NOT delete audit_event rows. Audit is append-only compliance evidence; dropping
--     the scope constraint relaxes what may be written from here on, and nothing more.
--
-- Objects are reversed in DEPENDENCY-SAFE order: policies name the roles, and grants are held
-- by them, so both must be gone before either role can be dropped.

-- 1) Policies — they reference the privilege roles by name.
drop policy if exists tmpos_app_tenant_scope on public.tenant;
drop policy if exists tmpos_app_store_scope on public.store;
drop policy if exists tmpos_app_membership_scope on public.user_membership;
drop policy if exists tmpos_app_entitlement_scope on public.tenant_feature_entitlement;
drop policy if exists tmpos_audit_writer_append on public.audit_event;

-- 2) Table and schema grants held by the privilege roles.
--    Guarded by the SAME existence predicate as the role drops in step 5. A bare REVOKE naming
--    an absent role raises SQLSTATE 42704 and aborts — which would make the "clean no-op on a
--    database where the roles were never created" promise above unreachable, and would abort a
--    rollback of a partially-applied 005 before it could undo anything. Roles are CLUSTER-wide,
--    so their absence here is a case that really occurs.
--    REVOKE ALL also removes column-level privileges, so the column-scoped UPDATE grants that
--    005 issues on tenant and store need no separate statement.
do $$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'tmpos_app') then
    execute 'revoke all on table public.tenant from tmpos_app';
    execute 'revoke all on table public.store from tmpos_app';
    execute 'revoke all on table public.user_membership from tmpos_app';
    execute 'revoke all on table public.tenant_feature_entitlement from tmpos_app';
    execute 'revoke usage on schema public from tmpos_app';
  end if;

  if exists (select 1 from pg_catalog.pg_roles where rolname = 'tmpos_audit_writer') then
    execute 'revoke all on table public.audit_event from tmpos_audit_writer';
    execute 'revoke usage on schema public from tmpos_audit_writer';
  end if;
end
$$;

-- 3) Default privileges.
--    Exactly ONE of the three up-migration statements changed a PostgreSQL built-in default:
--    EXECUTE on future FUNCTIONS is granted to PUBLIC out of the box, and 005 revoked it.
--    Restoring that built-in default is the faithful reversal of an S2-owned change; it is not
--    a 001-004 protection and it grants nothing on any table.
--    The TABLES and SEQUENCES statements asserted a posture PostgreSQL already holds (no
--    default grant to PUBLIC at all), so there is nothing to restore for them — re-granting
--    would CREATE access that never existed, which is why no such statement appears here.
alter default privileges in schema public grant execute on functions to public;

-- 4) The S2-owned audit scope constraint.
alter table public.audit_event drop constraint if exists audit_event_scope_consistency_chk;

-- 5) The privilege roles, last. Both statements are guarded so a rollback on a database where
--    the roles were never created is a clean no-op rather than an error.
--
--    DROP OWNED BY is deliberately NOT used here. It would drop every object the role owns and
--    strip every privilege it holds ANYWHERE in this database — including state that predates
--    005. The up migration tolerates a pre-existing role (roles are cluster-wide, so one may
--    exist for reasons this database cannot see), so a blanket DROP OWNED would be this file
--    destroying something it never created. Step 2 already revoked exactly what 005 granted;
--    if any other privilege remains, DROP ROLE fails loudly, and that loud failure is the
--    correct outcome — it means the role is not ours to remove.
do $$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'tmpos_app') then
    execute 'drop role tmpos_app';
  end if;

  if exists (select 1 from pg_catalog.pg_roles where rolname = 'tmpos_audit_writer') then
    execute 'drop role tmpos_audit_writer';
  end if;
end
$$;

-- INTENTIONALLY RETAINED (matching the pgcrypto / set_updated_at_timestamp retention pattern of
-- the 001, 002 and 004 rollbacks):
--   * the REVOKE ALL on platform_identity from public, anon, authenticated. Reversing it would
--     re-open a table to the anon and authenticated roles, which is a security regression, not
--     a rollback. 002 and 004 never reverse their equivalent REVOKEs either.
--   * CREATE on schema public stays revoked from public, anon and authenticated, for the same
--     reason.

-- Phase 4.0 M3 S2 — Database Principal Separation + Tenant/Store RLS Foundation
-- Migration: 005_principal_separation_rls_foundation (DOWN / rollback)
--
-- ⚠ DEV ROLLBACK ONLY. This removes the tenant/store isolation layer.
--   - Rolling 005 back returns the database to "owner-only, RLS enabled, no policies" — the
--     001-004 posture. That posture is safe ONLY while no non-owner principal exists. If a LOGIN
--     role has been granted membership in tmpos_app or tmpos_audit_writer, revoke that membership
--     and retire the role BEFORE running this file. PostgreSQL will NOT stop you: a membership is
--     a dependency OF the role, so DROP ROLE removes it silently along with the role and the
--     LOGIN principal simply loses its privileges, with no error raised. What DROP ROLE does
--     refuse (SQLSTATE 2BP01) is a privilege the role still HOLDS on an object, or an object it
--     owns. Retiring dependent LOGIN roles first is therefore an operational precondition this
--     file cannot enforce for you — stated plainly rather than implied by a failure that would
--     not actually occur.
--   - This file reverses ONLY objects that 005 created. It drops no table, disables no RLS,
--     removes no 001-004 constraint, and re-grants nothing to public, anon or authenticated.
--   - It does NOT delete audit_event rows. Audit is append-only compliance evidence; dropping
--     the scope constraint relaxes what may be written from here on, and nothing more.
--   - It RESTORES NO DATABASE-LEVEL PRIVILEGE. The database-level TEMPORARY and CREATE grants
--     that gate G-DBROLE closes are the database owner's posture, not 005's to hold or hand
--     back; re-granting them here would silently re-open temporary-object creation to every
--     role in the database as a side effect of a rollback. Restoring them, if it is ever
--     wanted, is a separate and explicit database-owner action.
--
-- Objects are reversed in DEPENDENCY-SAFE order: policies name the roles, and grants are held
-- by them, so both must be gone before either role can be dropped.

-- =============================================================================
-- 1) Ownership preflight — prove these roles are OURS before touching anything
-- =============================================================================
-- This runs BEFORE the first destructive statement, and it is the only thing standing between
-- this rollback and an operator's role that merely shares a name.
--
-- A name is not ownership. The previous revision of this file inferred ownership from the role
-- NAME alone and removed whatever it found, destroying roles 005 had never created. Every role
-- removed below must instead carry the exact marker migration 005 wrote at CREATE time, still
-- be least-privileged, and not own this database.
--
-- Every failure mode raises BEFORE any policy, grant, comment, constraint or role is touched,
-- so the pre-rollback state survives a refusal completely intact — inside the S1 engine's
-- transaction, and equally when this file is executed directly as one implicit transaction.
--
-- Absence is a refusal too, deliberately. A database with no such roles is not a database this
-- rollback has anything to reverse, and "silently succeed on a database that never had 005" is
-- exactly the shape of promise that let the old name-only removal through.
--
-- HONEST LIMIT OF A MARKER: the marker is a literal in a committed file, so anyone who can read
-- this repository can copy it onto a role of their own. It proves "this role carries the comment
-- migration 005 writes", not "migration 005 created this role" — no comment can prove authorship.
-- What it does close is the realistic failure: an operator who provisioned tmpos_app for their
-- own reasons, under their own comment, no longer has it deleted by a rollback that recognised
-- nothing but the name. Deliberately reproducing 005's marker is a claim of 005 ownership.
--
-- Every catalog function is SCHEMA-QUALIFIED to pg_catalog for the same reason the up migration
-- qualifies its own: an unqualified call resolves through search_path, and a shadowed
-- shobj_description could return the expected marker for any role at all.
--
-- ON THE GAP BETWEEN CHECKING AND DROPPING: this reads the catalog at READ COMMITTED, so in
-- principle a concurrent session could swap the roles after they are verified. Measured on
-- PostgreSQL 16, winning that race requires ADMIN OPTION on the roles: a session holding plain
-- CREATEROLE is refused with 42501 ("permission denied to drop role"), because CREATEROLE
-- confers authority only over roles its holder created. Since migration 005 is the creator, the
-- only principals that could win are this migration's own and a superuser — and a superuser
-- needs no race. Row-locking is not available (pg_authid is a system catalog), so the window is
-- stated rather than papered over with a re-check that would only narrow it.
do $$
declare
  r         record;
  marker    text;
  elevated  boolean;
  owns_db   boolean;
begin
  for r in
    select * from (values
      ('tmpos_app',
       'tmpos:005_principal_separation_rls_foundation:migration-owned-role:tenant-runtime'),
      ('tmpos_audit_writer',
       'tmpos:005_principal_separation_rls_foundation:migration-owned-role:audit-append')
    ) as t(rolname, expected_marker)
  loop
    if not exists (select 1 from pg_catalog.pg_roles p where p.rolname = r.rolname) then
      raise exception
        'migration 005 rollback: role % does not exist, so this database does not hold the state 005 created', r.rolname
        using errcode = 'insufficient_privilege',
              hint = 'nothing is reversed; run this rollback only against a database migration 005 was applied to';
    end if;

    select pg_catalog.shobj_description(p.oid, 'pg_authid'),
           (p.rolcanlogin or p.rolsuper or p.rolcreatedb or p.rolcreaterole
            or p.rolreplication or p.rolbypassrls),
           exists (select 1 from pg_catalog.pg_database d
                   where d.datname = pg_catalog.current_database() and d.datdba = p.oid)
      into marker, elevated, owns_db
      from pg_catalog.pg_roles p
      where p.rolname = r.rolname;

    if marker is distinct from r.expected_marker then
      raise exception
        'migration 005 rollback: role % does not carry the ownership marker migration 005 writes, so it was not created by this migration', r.rolname
        using errcode = 'insufficient_privilege',
              hint = 'nothing is reversed; a role that merely shares this name belongs to whoever created it';
    end if;

    if elevated then
      raise exception
        'migration 005 rollback: role % carries elevated attributes migration 005 never grants, so its current state is not the state 005 created', r.rolname
        using errcode = 'insufficient_privilege',
              hint = 'nothing is reversed; investigate how the role was altered before removing it';
    end if;

    if owns_db then
      raise exception
        'migration 005 rollback: role % owns the current database, which migration 005 never arranges', r.rolname
        using errcode = 'insufficient_privilege',
              hint = 'nothing is reversed; removing a database owner is never this migration''s to do';
    end if;
  end loop;
end
$$;

-- =============================================================================
-- 2) Policies — they reference the privilege roles by name.
-- =============================================================================
drop policy if exists tmpos_app_tenant_scope on public.tenant;
drop policy if exists tmpos_app_store_scope on public.store;
drop policy if exists tmpos_app_membership_scope on public.user_membership;
drop policy if exists tmpos_app_entitlement_scope on public.tenant_feature_entitlement;
drop policy if exists tmpos_audit_writer_append on public.audit_event;

-- =============================================================================
-- 3) Table and schema grants held by the privilege roles.
-- =============================================================================
-- Unguarded, because section 1 has already proved both roles exist: a bare REVOKE naming an
-- absent role raises 42704, and the only state in which that could happen is one this file has
-- already refused to run against.
-- REVOKE ALL also removes column-level privileges, so the column-scoped UPDATE grants that 005
-- issues on tenant and store need no separate statement.
revoke all on table public.tenant from tmpos_app;
revoke all on table public.store from tmpos_app;
revoke all on table public.user_membership from tmpos_app;
revoke all on table public.tenant_feature_entitlement from tmpos_app;
revoke usage on schema public from tmpos_app;

revoke all on table public.audit_event from tmpos_audit_writer;
revoke usage on schema public from tmpos_audit_writer;

-- =============================================================================
-- 4) Default privileges.
-- =============================================================================
-- Exactly ONE of the three up-migration statements changed a PostgreSQL built-in default:
-- EXECUTE on future FUNCTIONS is granted to PUBLIC out of the box, and 005 revoked it.
-- Restoring that built-in default is the faithful reversal of an S2-owned change; it is not a
-- 001-004 protection and it grants nothing on any table.
-- The TABLES and SEQUENCES statements asserted a posture PostgreSQL already holds (no default
-- grant to PUBLIC at all), so there is nothing to restore for them — re-granting would CREATE
-- access that never existed, which is why no such statement appears here.
alter default privileges in schema public grant execute on functions to public;

-- =============================================================================
-- 5) The S2-owned audit scope constraint.
-- =============================================================================
alter table public.audit_event drop constraint if exists audit_event_scope_consistency_chk;

-- =============================================================================
-- 6) The privilege roles, last — and only because section 1 proved they are ours.
-- =============================================================================
-- No IF EXISTS and no existence guard: `drop role if exists` would silently accept whatever it
-- found, which is ownership inferred from a name — the exact defect section 1 exists to close.
--
-- DROP OWNED BY and CASCADE are likewise absent, and deliberately. Both would suppress the
-- dependency error PostgreSQL raises when a role still holds a privilege or a membership this
-- file did not create. Section 3 revoked exactly what 005 granted; if anything else remains,
-- DROP ROLE fails loudly (SQLSTATE 2BP01) and the whole rollback rolls back. That loud failure
-- is the correct outcome — it means something outside 005 still depends on the role, and
-- removing it anyway would be this file destroying state it never created.
drop role tmpos_app;
drop role tmpos_audit_writer;

-- INTENTIONALLY RETAINED (matching the pgcrypto / set_updated_at_timestamp retention pattern of
-- the 001, 002 and 004 rollbacks):
--   * the REVOKE ALL on platform_identity from public, anon, authenticated. Reversing it would
--     re-open a table to the anon and authenticated roles, which is a security regression, not
--     a rollback. 002 and 004 never reverse their equivalent REVOKEs either.
--   * CREATE on schema public stays revoked from public, anon and authenticated, for the same
--     reason.
--   * every database-level privilege closed by G-DBROLE owner provisioning, for the reason
--     given in the header: it is not 005's posture to hand back.

-- Phase 4.0 M3 S2 — Database Principal Separation + Tenant/Store RLS Foundation
-- Migration: 005_principal_separation_rls_foundation (UP)
--
-- SCOPE / TRUTH (binding):
--   - FOUNDATION ONLY. This migration creates two NOLOGIN privilege roles, the tenant/store
--     RLS policies they are bound by, the least-privilege grant matrix, and the audit
--     scope-consistency constraint. It converts NO caller: every existing DEV/admin path keeps
--     running as the table owner exactly as before. Gate G-DBROLE therefore stays OPEN.
--   - MIGRATION FILE ONLY. Nothing here is applied automatically by any runtime. Application to
--     a non-production project is a separate, owner-approved operator step. It has NOT been
--     applied to any managed, persistent, production, or application database.
--   - NO LOGIN ROLE IS PROVISIONED. tmpos_app and tmpos_audit_writer are NOLOGIN *privilege*
--     roles: they carry permissions, they cannot open a connection. Granting a real LOGIN role
--     membership in them is an owner/operator responsibility, performed outside this file so
--     that no credential ever has to live in a migration.
--   - DATABASE-LEVEL PRIVILEGE IS NOT THIS FILE'S TO SET, AND IT DOES NOT PRETEND OTHERWISE.
--     PostgreSQL grants the database-level TEMPORARY privilege to PUBLIC by default, and PUBLIC
--     reaches every role, so a runtime principal inherits it no matter how least-privileged its
--     own attributes are. Closing it requires database ownership or the grant option. A REVOKE
--     issued here by a non-owner migration principal does NOT error: PostgreSQL emits only
--     "WARNING: no privileges could be revoked" and the privilege survives. Shipping that would
--     be a green that means nothing. So this file VERIFIES the posture and refuses to apply
--     without it; ESTABLISHING it is the database-owner provisioning step recorded under gate
--     G-DBROLE (docs/phase-4/08-production-gate-and-risk-register.md).
--   - NO SECRETS: no credential, connection string, key, or provider identifier appears here.
--   - The API layer remains the PRIMARY authorization guard. These policies are DEFENSE IN
--     DEPTH — the layer that still holds when application code forgets a WHERE clause.
--
-- WHY THE OWNER IS STILL UNCONSTRAINED (deliberate, and load-bearing):
--   FORCE ROW LEVEL SECURITY is intentionally NOT set. Setting it would subject the table OWNER
--   to these policies, and every existing owner-backed DEV/admin caller — which has no tenant
--   context to install — would begin failing the moment this migration were applied. S2 is
--   explicitly a foundation that changes no existing caller. The direct consequence is that a
--   test running as the owner would observe NOTHING and prove NOTHING about these policies, so
--   the real-PostgreSQL proof (tests/db/rlsIsolation.integration.test.mjs) runs every isolation
--   assertion through a NON-OWNER role that inherits only these privilege roles.
--
-- ONCE-ONLY BY CONSTRUCTION: the S1 engine applies each version exactly once, under a checksum
--   ledger, inside a transaction ('required' mode). This file therefore carries no re-run
--   guards at all. Roles are CLUSTER-wide rather than database-wide, so one may already exist
--   for reasons this database cannot see — but that is handled by REFUSING (section 1), never
--   by tolerating it, because a role this migration did not create is not a role it may own.
--
-- Reversible via the matching down migration (005_principal_separation_rls_foundation.down.sql).
--
-- This migration assumes the roles `anon` and `authenticated` exist (they do on Supabase
-- Postgres), matching the assumption 002 and 004 already make.

-- =============================================================================
-- 1) Role-ownership preflight — 005 OWNS these two names and ADOPTS NEITHER
-- =============================================================================
-- This is the FIRST executable statement in the file, and the first thing that can fail.
--
-- Migration 005 is the sole owner of tmpos_app and tmpos_audit_writer: it creates them, marks
-- them, and its rollback removes them. A role already present under either name was created by
-- somebody else. This migration will not adopt it, re-attribute it, alter it, mark it, or let
-- its own rollback delete it — the previous revision of this file tolerated a pre-existing role
-- on the way up and then dropped it blindly on the way down, which destroyed operator-owned
-- state it never created.
--
-- Refusing is therefore the correct outcome, not a limitation, and the refusal is ATOMIC: the S1
-- engine applies each version inside a transaction, so nothing below this block has run when it
-- raises, and the pre-existing roles are left EXACTLY as found — not one comment, attribute or
-- membership of theirs is written, and none is even marked as inspected.
--
-- Recovery is an operator decision, never an automatic one: retire the foreign roles, or accept
-- them and re-plan the milestone. Both are choices this file must not make on anyone's behalf.

-- >>> S2-ROLE-LIFECYCLE-BEGIN — the block between these markers is replayed VERBATIM under a
--     NOSUPERUSER CREATEROLE principal by tests/db/rlsIsolation.integration.test.mjs (S2-DB-2b),
--     which is the only way to prove it is portable to the managed deployment it targets.
-- Every catalog function below is SCHEMA-QUALIFIED to pg_catalog on purpose. An unqualified call
-- resolves through search_path, so a shadowing function in a schema that precedes pg_catalog
-- would run instead — and a forged has_database_privilege returning false would turn the gate in
-- section 3 into a silent pass. Qualifying costs nothing and removes the resolution from
-- search_path's reach entirely.
do $$
declare
  taken text[];
begin
  select pg_catalog.array_agg(rolname::text order by rolname) into taken
    from pg_catalog.pg_roles
    where rolname in ('tmpos_app', 'tmpos_audit_writer');

  if taken is not null then
    raise exception
      'migration 005 owns the role name(s) % and they already exist; it will not adopt, alter, mark or remove a role it did not create', taken
      using errcode = 'duplicate_object',
            hint = 'retire the pre-existing role(s) deliberately, or re-plan this milestone; migration 005 makes no such change itself';
  end if;
end
$$;

-- =============================================================================
-- 2) The privilege roles — created here, and MARKED as created here
-- =============================================================================
-- Unguarded on purpose. The preflight above has already proved neither name is taken, so a
-- CREATE-time existence guard could now only hide a defect. Because this migration is the
-- CREATOR it holds ADMIN OPTION on both roles implicitly, so COMMENT ON ROLE succeeds even for
-- the NOSUPERUSER + CREATEROLE principal a managed deployment actually runs migrations as —
-- the case that made commenting an inherited role unsafe no longer exists.
--
-- The comment is not documentation. It is the OWNERSHIP MARKER the rollback must match EXACTLY
-- before it removes anything, so a role that merely shares the name can never be deleted by
-- this migration's down file. Human-readable description stays in these SQL comments, where
-- editing it cannot weaken the marker.
--
-- ATTRIBUTES ARE SET AT CREATE TIME AND NEVER REPAIRED LATER: ALTER ROLE ... NOBYPASSRLS /
-- NOREPLICATION requires superuser even when the value is unchanged, and the managed Postgres
-- this schema targets does not run migrations as a superuser.

create role tmpos_app
  nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls inherit;
comment on role tmpos_app is 'tmpos:005_principal_separation_rls_foundation:migration-owned-role:tenant-runtime';

create role tmpos_audit_writer
  nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls inherit;
comment on role tmpos_audit_writer is 'tmpos:005_principal_separation_rls_foundation:migration-owned-role:audit-append';

-- =============================================================================
-- 3) Effective database-privilege gate — fail closed on unfinished provisioning
-- =============================================================================
-- The roles now exist, so their EFFECTIVE database privileges can finally be asked about. This
-- gate is the whole reason the header refuses to issue a REVOKE: it verifies the outcome the
-- database owner is responsible for, and aborts the migration if that owner step has not run.
--
-- has_database_privilege is used rather than reading datacl because it is the only check that
-- sees ALL grant paths at once — a direct grant, a grant inherited through a role membership,
-- and the PUBLIC grant PostgreSQL applies by default. Inspecting the PUBLIC path alone would
-- pass a database where the privilege had simply been re-granted by another route.
--
-- It is READABLE by any role, including a non-owner migration principal, which is precisely why
-- an assertion is possible here where a revocation is not. Both privileges are checked: CREATE
-- on the database would let the runtime principal create schemas, and TEMPORARY would let it
-- create temporary objects — the approved requirement is that it can create NEITHER.
--
-- This does NOT prove the same for a future LOGIN role: a direct or inherited grant to that
-- role is invisible from here, so caller cutover must repeat the check against the real
-- principal. G-DBROLE records that obligation and stays OPEN until it is met.
do $$
declare
  db name := pg_catalog.current_database();
  r  name;
begin
  foreach r in array array['tmpos_app', 'tmpos_audit_writer']::name[] loop
    if pg_catalog.has_database_privilege(r, db, 'TEMPORARY') then
      raise exception
        'database-owner provisioning is incomplete: % still holds the database-level TEMPORARY privilege on %, so the tenant runtime could create temporary objects', r, db
        using errcode = 'insufficient_privilege',
              hint = 'gate G-DBROLE: the database owner must close the database-level TEMPORARY grant reaching PUBLIC before migration 005 is applied';
    end if;

    if pg_catalog.has_database_privilege(r, db, 'CREATE') then
      raise exception
        'database-owner provisioning is incomplete: % still holds the database-level CREATE privilege on %, so the tenant runtime could create schemas', r, db
        using errcode = 'insufficient_privilege',
              hint = 'gate G-DBROLE: the database owner must close the database-level CREATE grant reaching PUBLIC before migration 005 is applied';
    end if;
  end loop;
end
$$;
-- <<< S2-ROLE-LIFECYCLE-END

-- =============================================================================
-- 4) Schema privileges — usage without creation
-- =============================================================================

revoke create on schema public from public, anon, authenticated;
grant usage on schema public to tmpos_app, tmpos_audit_writer;

-- =============================================================================
-- 5) Default privileges — a table added later is closed until granted on purpose
-- =============================================================================
-- Applies to objects created LATER by the role running this migration. Note what is NOT here:
-- no default privilege is granted to tmpos_app or tmpos_audit_writer, so a future table is
-- unreachable by the runtime principal until a migration grants it deliberately.
-- The FUNCTIONS line is the only one that tightens a PostgreSQL built-in default (EXECUTE to
-- PUBLIC); the TABLES and SEQUENCES lines assert a posture PostgreSQL already has, so that a
-- previously-loosened default in an existing project is corrected on apply.

alter default privileges in schema public revoke all on tables from public, anon, authenticated;
alter default privileges in schema public revoke all on sequences from public, anon, authenticated;
alter default privileges in schema public revoke all on functions from public, anon, authenticated;

-- =============================================================================
-- 6) The REVOKE that 001 omitted
-- =============================================================================
-- 002 and 004 revoke public/anon/authenticated on every table they create; 001 relies on
-- "RLS enabled, no policies" alone. That is a real asymmetry: RLS-without-policies denies the
-- non-owner roles, but the explicit REVOKE is the half of the posture that survives a future
-- migration adding a permissive policy. This closes it. The 005 rollback deliberately RETAINS
-- this revocation — see the down migration.

revoke all on table platform_identity from public, anon, authenticated;

-- =============================================================================
-- 7) audit_event scope consistency
-- =============================================================================
-- 002 constrains scope_type's value domain but never ties it to tenant_id/store_id, so a
-- store-scoped event with no store_id — or a platform-scoped event carrying a tenant — is
-- currently storable. This mirrors user_membership_scope_consistency_chk (002) onto the audit
-- table, for EVERY writer including the owner.
--
-- Deliberately NOT context-dependent: audit INSERT must be able to record a DENIED or
-- cross-scope attempt, whose tenant_id is the tenant that was *targeted*, not the one in the
-- caller's session context. Requiring a context match here would make the most security-relevant
-- events the only ones that cannot be recorded. Well-formedness is enforced; provenance is not.
--
-- FAIL-LOUD ON APPLY: adding this constraint validates existing rows. If a project already
-- holds a malformed audit row, this migration fails rather than silently skipping validation —
-- the same deliberate loud failure 003 uses for unmappable role values.

alter table public.audit_event
  add constraint audit_event_scope_consistency_chk check (
    (scope_type in ('platform', 'none') and tenant_id is null and store_id is null)
    or (scope_type = 'tenant' and tenant_id is not null and store_id is null)
    or (scope_type = 'store' and tenant_id is not null and store_id is not null)
  );

-- =============================================================================
-- 8) The role-to-table privilege matrix
-- =============================================================================
--   tmpos_app            tenant                      select, update (display_name, legal_name)
--                        store                       select, insert, update (store_name)
--                        user_membership             select
--                        tenant_feature_entitlement  select
--   tmpos_audit_writer   audit_event                 insert
--
-- THE UPDATE GRANTS ARE COLUMN-SCOPED, AND THAT IS LOAD-BEARING. Row-Level Security is
-- row-granular: no policy can stop a permitted UPDATE from touching a particular COLUMN. A
-- table-wide `grant update on tenant` would therefore let the tenant runtime rewrite
-- tenant.status, tenant.plan_key and store.status — the very columns the authorization
-- resolver decides on. statusDisposition() denies BEFORE any role is considered when a status
-- is 'suspended' or 'pending_activation', and plan_key gates which capabilities exist at all.
-- A principal that can clear its own suspension or raise its own plan is not least-privileged,
-- and it would be inconsistent with this same matrix refusing every write on
-- tenant_feature_entitlement on the grounds that entitlement assignment is a platform
-- operation. Only a column-list GRANT can express that, so this uses one.
--
-- Everything absent from this list is absent ON PURPOSE:
--   * platform_identity / app_user / identity_link — the tenant runtime has no business
--     reaching the identity store at all, so it gets no privilege rather than a policy.
--   * DELETE anywhere — tenant-scoped rows are retired by status (002 gives every one of these
--     tables a status column), never removed; a cascade from a tenant-runtime DELETE would
--     reach memberships and stores.
--   * INSERT/DELETE on tenant, and any write on user_membership or tenant_feature_entitlement —
--     tenant creation, grant issuance and entitlement assignment are platform operations.
--   * Any SELECT/UPDATE/DELETE for tmpos_audit_writer — append-only means append-only.
-- No sequence grant appears because no sequence exists: every surrogate key in 001-004 is a
-- uuid defaulting to gen_random_uuid(), so there is nothing for a runtime insert to advance.

grant select on table tenant to tmpos_app;
grant update (display_name, legal_name) on table tenant to tmpos_app;
grant select, insert on table store to tmpos_app;
grant update (store_name) on table store to tmpos_app;
grant select on table user_membership to tmpos_app;
grant select on table tenant_feature_entitlement to tmpos_app;
grant insert on table audit_event to tmpos_audit_writer;

-- =============================================================================
-- 9) Tenant/store RLS policies
-- =============================================================================
-- CONTEXT CONTRACT — three transaction-local settings, installed with
-- set_config(name, value, true) inside the transaction that uses them:
--     app.scope_type   'tenant' | 'store'   (the runtime principal never operates at platform scope)
--     app.tenant_id    uuid
--     app.store_id     uuid, store scope only
--
-- Every predicate reads them through
--     nullif(current_setting('<name>', true), '')::uuid
-- which is missing-safe in BOTH directions that matter: the `true` suppresses the error an unset
-- setting would otherwise raise, and the nullif() maps the empty-string sentinel (written when a
-- scope id is absent) to NULL. A NULL on either side makes the comparison NULL, which is not
-- TRUE, so **absent context denies** — the policies open nothing by default.
--
-- FOR ALL is used deliberately even where only SELECT is currently granted: a later milestone
-- that widens a grant then finds the write path already constrained, rather than newly open.
-- USING governs which rows are visible/targetable; WITH CHECK governs which rows may be
-- written — they are stated separately on every policy so an INSERT or UPDATE cannot move a row
-- into another tenant or store.

-- tenant: a tenant-scoped context sees its own tenant row; a store-scoped context sees the
-- tenant its store belongs to (status and plan are needed to serve a store request).
create policy tmpos_app_tenant_scope on public.tenant
  for all
  to tmpos_app
  using (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    and (
      nullif(current_setting('app.scope_type', true), '') = 'tenant'
      or (
        -- A store-scoped context must carry its store even to reach the tenant row. Accepting
        -- scope_type='store' with no store id would let a HALF-INSTALLED context open the
        -- tenant and its entitlements, which is precisely the fail-open this design forbids.
        nullif(current_setting('app.scope_type', true), '') = 'store'
        and nullif(current_setting('app.store_id', true), '') is not null
      )
    )
  )
  with check (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    and (
      nullif(current_setting('app.scope_type', true), '') = 'tenant'
      or (
        -- A store-scoped context must carry its store even to reach the tenant row. Accepting
        -- scope_type='store' with no store id would let a HALF-INSTALLED context open the
        -- tenant and its entitlements, which is precisely the fail-open this design forbids.
        nullif(current_setting('app.scope_type', true), '') = 'store'
        and nullif(current_setting('app.store_id', true), '') is not null
      )
    )
  );

-- store: a tenant-scoped context reaches every store in its tenant; a store-scoped context is
-- restricted to the one selected store.
create policy tmpos_app_store_scope on public.store
  for all
  to tmpos_app
  using (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    and (
      nullif(current_setting('app.scope_type', true), '') = 'tenant'
      or (
        nullif(current_setting('app.scope_type', true), '') = 'store'
        and store_id = nullif(current_setting('app.store_id', true), '')::uuid
      )
    )
  )
  with check (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    and (
      nullif(current_setting('app.scope_type', true), '') = 'tenant'
      or (
        nullif(current_setting('app.scope_type', true), '') = 'store'
        and store_id = nullif(current_setting('app.store_id', true), '')::uuid
      )
    )
  );

-- user_membership: a platform-scope grant carries tenant_id NULL, so the comparison is NULL and
-- the row is invisible to the runtime principal — platform grants are never tenant-readable.
create policy tmpos_app_membership_scope on public.user_membership
  for all
  to tmpos_app
  using (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    and (
      nullif(current_setting('app.scope_type', true), '') = 'tenant'
      or (
        nullif(current_setting('app.scope_type', true), '') = 'store'
        and store_id = nullif(current_setting('app.store_id', true), '')::uuid
      )
    )
  )
  with check (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    and (
      nullif(current_setting('app.scope_type', true), '') = 'tenant'
      or (
        nullif(current_setting('app.scope_type', true), '') = 'store'
        and store_id = nullif(current_setting('app.store_id', true), '')::uuid
      )
    )
  );

-- tenant_feature_entitlement: entitlements are tenant-wide, so a store-scoped context reads the
-- same set as its tenant.
create policy tmpos_app_entitlement_scope on public.tenant_feature_entitlement
  for all
  to tmpos_app
  using (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    and (
      nullif(current_setting('app.scope_type', true), '') = 'tenant'
      or (
        -- A store-scoped context must carry its store even to reach the tenant row. Accepting
        -- scope_type='store' with no store id would let a HALF-INSTALLED context open the
        -- tenant and its entitlements, which is precisely the fail-open this design forbids.
        nullif(current_setting('app.scope_type', true), '') = 'store'
        and nullif(current_setting('app.store_id', true), '') is not null
      )
    )
  )
  with check (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    and (
      nullif(current_setting('app.scope_type', true), '') = 'tenant'
      or (
        -- A store-scoped context must carry its store even to reach the tenant row. Accepting
        -- scope_type='store' with no store id would let a HALF-INSTALLED context open the
        -- tenant and its entitlements, which is precisely the fail-open this design forbids.
        nullif(current_setting('app.scope_type', true), '') = 'store'
        and nullif(current_setting('app.store_id', true), '') is not null
      )
    )
  );

-- audit_event: FOR INSERT only, and context-independent by design (see section 7). The WITH
-- CHECK is not a formality — it refuses a malformed scope tuple a second time, and it refuses
-- an advisory dev-sidecar record, so the durable compliance table can only ever receive rows
-- that claim to be durable compliance evidence.
create policy tmpos_audit_writer_append on public.audit_event
  for insert
  to tmpos_audit_writer
  with check (
    evidence_level = 'durable_compliance_event'
    and (
      (scope_type in ('platform', 'none') and tenant_id is null and store_id is null)
      or (scope_type = 'tenant' and tenant_id is not null and store_id is null)
      or (scope_type = 'store' and tenant_id is not null and store_id is not null)
    )
  );

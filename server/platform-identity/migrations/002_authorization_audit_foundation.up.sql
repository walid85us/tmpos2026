-- Phase 1.5 M10 — Durable Authorization + Append-Only Audit Foundation
-- Migration: 002_authorization_audit_foundation (UP)
--
-- SCOPE / TRUTH (binding):
--   - MIGRATION FILE ONLY. This file is NOT applied automatically by any runtime.
--     Application is a separate, owner-approved step (Supabase SQL Editor paste, or
--     a later runner parameterization). The existing runner scripts/supabase-migrate.ts
--     is hardcoded to 001_platform_identity and is intentionally NOT modified in M10.
--   - The API layer is the PRIMARY authorization guard. Row-Level Security + explicit
--     REVOKEs here are DEFENSE-IN-DEPTH (so PostgREST + anon key can never read/write
--     these tables), mirroring the 001_platform_identity posture.
--   - NO runtime wiring is added in this milestone. No endpoint, resolver, audit
--     writer, AccessContext, or business API consumes these tables yet.
--   - SERVER-AUTHORITATIVE BY DESIGN: every authorization column is computed/owned
--     server-side. Nothing here is ever populated from client-asserted role/tenant/
--     store/permission or from a provider token's user_metadata.
--   - NO secrets: no token, JWT, JWKS, service-role key, DB URL, connection string,
--     password, or PAN is stored. The actor is the app-owned internal_user_id (UUID),
--     never the raw provider uid.
--
-- Apply against the Supabase DEV project only. Reversible via the matching down
-- migration (002_authorization_audit_foundation.down.sql).
--
-- This migration assumes the Supabase roles `anon` and `authenticated` exist (they do
-- on Supabase Postgres); the explicit REVOKEs below target them plus PUBLIC.

-- gen_random_uuid() lives in pgcrypto. 001 already creates it; create it defensively
-- so 002 is independently applicable. The down migration intentionally leaves it.
create extension if not exists "pgcrypto";

-- =============================================================================
-- Shared helper functions
-- =============================================================================

-- Keep updated_at honest on every update for the mutable tables. One shared
-- function (vs. five near-identical ones), attached per-table below. Mirrors the
-- 001 set_platform_identity_updated_at() style.
create or replace function set_updated_at_timestamp()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

-- Defense-in-depth flatness guard for audit_event.metadata: returns true only when
-- every top-level value is a scalar (no nested object/array). IMMUTABLE + operates
-- only on its argument, so it is legal inside a CHECK constraint. Application-level
-- allow-listing + redaction remains the PRIMARY guard (see metadata comments).
create or replace function audit_metadata_is_flat(meta jsonb)
returns boolean as $$
  select coalesce(bool_and(jsonb_typeof(value) not in ('object', 'array')), true)
  from jsonb_each(meta);
$$ language sql immutable;

-- Append-only enforcement for audit_event: reject every UPDATE and DELETE. This
-- fires regardless of role (including the table-owner/server connection that
-- bypasses RLS), so audit rows are immutable once inserted.
create or replace function reject_audit_event_mutation()
returns trigger as $$
begin
  raise exception 'audit_event is append-only: % is not permitted', tg_op
    using errcode = 'restrict_violation';
end;
$$ language plpgsql;

-- =============================================================================
-- app_user — app-owned durable user record (1:1 with platform_identity)
-- =============================================================================
create table if not exists app_user (
  internal_user_id uuid        primary key
                                references platform_identity (internal_user_id) on delete cascade,
  status           text        not null default 'pending_activation'
                                constraint app_user_status_chk check (status in
                                  ('active', 'trialing', 'overdue', 'suspended', 'read_only', 'pending_activation')),
  display_name     text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

comment on table app_user is
  'Phase 1.5 M10: app-owned durable user record, 1:1 with platform_identity. internal_user_id is the stable app identity (PK + FK). Holds NO provider token, NO raw provider uid, NO secret. RLS enabled, no policies (server-only via owner-role direct Postgres).';
comment on column app_user.internal_user_id is
  'App-owned identity. PK and FK to platform_identity.internal_user_id (1:1, on delete cascade).';
comment on column app_user.status is
  'Server-authoritative account status; evaluated with precedence BEFORE role grants.';

drop trigger if exists trg_app_user_updated_at on app_user;
create trigger trg_app_user_updated_at
  before update on app_user
  for each row execute function set_updated_at_timestamp();

create index if not exists idx_app_user_status on app_user (status);

alter table app_user enable row level security;
revoke all on table app_user from public, anon, authenticated;

-- =============================================================================
-- tenant — durable tenant record (plan + status)
-- =============================================================================
create table if not exists tenant (
  tenant_id    uuid        primary key default gen_random_uuid(),
  display_name text,
  legal_name   text,
  plan_key     text        not null default 'starter'
                           constraint tenant_plan_key_chk check (plan_key in ('starter', 'growth', 'advanced')),
  status       text        not null default 'active'
                           constraint tenant_status_chk check (status in
                             ('active', 'trialing', 'overdue', 'suspended', 'read_only', 'pending_activation')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

comment on table tenant is
  'Phase 1.5 M10: durable tenant. plan_key gates which capabilities EXIST (entitlements); status gates availability. The plan/feature CATALOG stays in code (M9 shared-catalog target, declared-not-built). RLS enabled, no policies.';
comment on column tenant.plan_key is
  'Plan assignment (catalog lives in code). One of starter|growth|advanced.';

drop trigger if exists trg_tenant_updated_at on tenant;
create trigger trg_tenant_updated_at
  before update on tenant
  for each row execute function set_updated_at_timestamp();

alter table tenant enable row level security;
revoke all on table tenant from public, anon, authenticated;

-- =============================================================================
-- store — durable store record (child of tenant)
-- =============================================================================
create table if not exists store (
  store_id   uuid        primary key default gen_random_uuid(),
  tenant_id  uuid        not null references tenant (tenant_id) on delete cascade,
  store_name text,
  status     text        not null default 'active'
                         constraint store_status_chk check (status in
                           ('active', 'trialing', 'overdue', 'suspended', 'read_only', 'pending_activation')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table store is
  'Phase 1.5 M10: durable store, child of tenant (on delete cascade). RLS enabled, no policies.';

drop trigger if exists trg_store_updated_at on store;
create trigger trg_store_updated_at
  before update on store
  for each row execute function set_updated_at_timestamp();

create index if not exists idx_store_tenant_id on store (tenant_id);

alter table store enable row level security;
revoke all on table store from public, anon, authenticated;

-- =============================================================================
-- user_membership — (user × tenant? × store?) → role grant
-- =============================================================================
create table if not exists user_membership (
  membership_id    uuid        primary key default gen_random_uuid(),
  internal_user_id uuid        not null references app_user (internal_user_id) on delete cascade,
  tenant_id        uuid        references tenant (tenant_id) on delete cascade,
  store_id         uuid        references store (store_id) on delete cascade,
  scope_type       text        not null
                               constraint user_membership_scope_type_chk check (scope_type in ('platform', 'tenant', 'store')),
  role_id          text        not null,
  status           text        not null default 'active'
                               constraint user_membership_status_chk check (status in
                                 ('active', 'invited', 'suspended', 'pending_setup')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  -- Scope consistency: the scope_type dictates which scope ids are present.
  constraint user_membership_scope_consistency_chk check (
    (scope_type = 'platform' and tenant_id is null     and store_id is null)
    or (scope_type = 'tenant'  and tenant_id is not null and store_id is null)
    or (scope_type = 'store'   and tenant_id is not null and store_id is not null)
  ),
  -- Role/scope consistency: platform roles only at platform scope; tenant roles
  -- only at tenant/store scope. Role id lists mirror the code role catalog.
  constraint user_membership_role_scope_chk check (
    (scope_type = 'platform' and role_id in
      ('platform_owner', 'platform_admin', 'platform_ops', 'platform_support', 'platform_readonly'))
    or (scope_type in ('tenant', 'store') and role_id in
      ('store_owner', 'manager', 'technician', 'sales_staff'))
  ),
  -- Duplicate-grant guard. NULLS NOT DISTINCT (Postgres 15+, available on Supabase)
  -- treats null scope ids as equal so platform/tenant grants can't be duplicated.
  -- This forbids EXACT duplicate grants only; it intentionally does NOT hard-limit
  -- to one active role per scope (that stays an application/resolver rule for now).
  constraint user_membership_unique_grant
    unique nulls not distinct (internal_user_id, scope_type, tenant_id, store_id, role_id)
);

comment on table user_membership is
  'Phase 1.5 M10: durable membership grant — (user × tenant? × store?) → role_id at platform|tenant|store scope. role_id is a TEXT constant mirroring the code role catalog (no durable role table yet). RLS enabled, no policies.';
comment on column user_membership.role_id is
  'Text role id. Platform scope: platform_owner|platform_admin|platform_ops|platform_support|platform_readonly. Tenant/store scope: store_owner|manager|technician|sales_staff.';

drop trigger if exists trg_user_membership_updated_at on user_membership;
create trigger trg_user_membership_updated_at
  before update on user_membership
  for each row execute function set_updated_at_timestamp();

create index if not exists idx_user_membership_internal_user_id on user_membership (internal_user_id);
create index if not exists idx_user_membership_tenant_id on user_membership (tenant_id);
create index if not exists idx_user_membership_store_id on user_membership (store_id);

alter table user_membership enable row level security;
revoke all on table user_membership from public, anon, authenticated;

-- =============================================================================
-- tenant_feature_entitlement — per-tenant feature gate
-- =============================================================================
create table if not exists tenant_feature_entitlement (
  entitlement_id uuid        primary key default gen_random_uuid(),
  tenant_id      uuid        not null references tenant (tenant_id) on delete cascade,
  feature_key    text        not null,
  enabled        boolean     not null default false,
  source         text        not null default 'default'
                             constraint tenant_feature_entitlement_source_chk check (source in ('plan', 'default', 'manual')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint tenant_feature_entitlement_unique unique (tenant_id, feature_key)
);

comment on table tenant_feature_entitlement is
  'Phase 1.5 M10: per-tenant feature gate (feature_key catalog stays in code). Gates whether a capability EXISTS; role decides who may use it. No rows seeded; plan-derived materialization deferred. RLS enabled, no policies.';

drop trigger if exists trg_tenant_feature_entitlement_updated_at on tenant_feature_entitlement;
create trigger trg_tenant_feature_entitlement_updated_at
  before update on tenant_feature_entitlement
  for each row execute function set_updated_at_timestamp();

create index if not exists idx_tenant_feature_entitlement_tenant_id on tenant_feature_entitlement (tenant_id);

alter table tenant_feature_entitlement enable row level security;
revoke all on table tenant_feature_entitlement from public, anon, authenticated;

-- =============================================================================
-- audit_event — durable, append-only audit (mirrors DurableAuditEventV1)
-- =============================================================================
-- DECOUPLED BY DESIGN: audit_event declares NO foreign keys. actor_internal_user_id,
-- tenant_id, and store_id are plain UUID columns. This keeps the table append-only
-- (FK cascade/set-null side effects would attempt to mutate immutable audit rows and
-- collide with the reject trigger) and compliance-independent (audit survives deletion
-- of the referenced operational rows). Referential integrity is an application
-- guarantee, not a DB constraint.
create table if not exists audit_event (
  event_id                   uuid        primary key default gen_random_uuid(),
  audit_version              text        not null default 'audit.v1',
  request_id                 text        not null,
  trace_id                   text,
  occurred_at                timestamptz not null default now(),
  actor_internal_user_id     uuid,
  actor_auth_provider        text        constraint audit_event_actor_provider_chk
                                         check (actor_auth_provider is null or actor_auth_provider in ('supabase', 'firebase')),
  on_behalf_of_internal_user_id uuid,
  scope_type                 text        not null
                                         constraint audit_event_scope_type_chk check (scope_type in ('platform', 'tenant', 'store', 'none')),
  tenant_id                  uuid,
  store_id                   uuid,
  action_id                  text        not null,
  required_permission        text        not null,
  decision                   text        not null
                                         constraint audit_event_decision_chk check (decision in ('allow', 'deny', 'deferred', 'not_applicable')),
  reason_code                text        not null,
  human_readable_reason      text        not null,
  result_status              text        not null
                                         constraint audit_event_result_status_chk check (result_status in ('succeeded', 'failed', 'n_a')),
  source_of_truth            text        not null,
  evaluated_by               text        not null,
  evidence_level             text        not null
                                         constraint audit_event_evidence_level_chk check (evidence_level in ('dev_sidecar_log_advisory', 'durable_compliance_event')),
  metadata                   jsonb       not null default '{}'::jsonb,
  -- metadata must be a flat object with NO forbidden top-level keys. This DB CHECK is
  -- DEFENSE-IN-DEPTH only — it cannot catch a forbidden VALUE under an allowed key or
  -- deep nesting; application allow-listing + redaction remains the PRIMARY guard.
  constraint audit_event_metadata_object_chk check (jsonb_typeof(metadata) = 'object'),
  constraint audit_event_metadata_flat_chk check (audit_metadata_is_flat(metadata)),
  constraint audit_event_metadata_no_forbidden_keys_chk check (
    not (metadata ?| array[
      'accessToken', 'refreshToken', 'rawJwt', 'jwtPayload', 'jwks', 'serviceRoleKey',
      'databaseUrl', 'connectionString', 'password', 'rawDbError', 'pan', 'cardNumber', 'providerSecret'
    ])
  )
);

comment on table audit_event is
  'Phase 1.5 M10: durable, APPEND-ONLY audit (insert + select only; update/delete rejected by trigger). Intentionally decoupled (no FKs) for immutability + compliance independence. Carries NO token/JWT/JWKS/service-role/DB-URL/password/PAN. Actor is the app-owned internal_user_id (UUID), never the raw provider uid. RLS enabled, no policies.';
comment on column audit_event.actor_internal_user_id is
  'App-owned actor id (UUID), never the raw provider uid. Plain column, no FK (audit is decoupled/append-only).';
comment on column audit_event.metadata is
  'Allow-listed, flat, scalar-only JSONB. DB CHECK forbids known secret top-level keys + nesting (defense-in-depth); application allow-list/redaction is the primary guard.';

-- Append-only: reject UPDATE and DELETE (fires for all roles, incl. table owner).
drop trigger if exists trg_audit_event_reject_mutation on audit_event;
create trigger trg_audit_event_reject_mutation
  before update or delete on audit_event
  for each row execute function reject_audit_event_mutation();

create index if not exists idx_audit_event_actor_occurred on audit_event (actor_internal_user_id, occurred_at desc);
create index if not exists idx_audit_event_tenant_occurred on audit_event (tenant_id, occurred_at desc);
create index if not exists idx_audit_event_store_occurred on audit_event (store_id, occurred_at desc);
create index if not exists idx_audit_event_action_id on audit_event (action_id);
create index if not exists idx_audit_event_occurred_at on audit_event (occurred_at desc);
create index if not exists idx_audit_event_request_id on audit_event (request_id);

alter table audit_event enable row level security;
revoke all on table audit_event from public, anon, authenticated;

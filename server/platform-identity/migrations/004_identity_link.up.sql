-- Phase 1.6 M20.4 — Identity Link (Firebase ↔ Supabase) Foundation
-- Migration: 004_identity_link (UP)
--
-- SCOPE / TRUTH (binding):
--   - MIGRATION FILE ONLY. This file is NOT applied automatically by any runtime.
--     Application is a separate, owner-approved step (Supabase SQL Editor paste, or a
--     later runner parameterization). The existing runner scripts/supabase-migrate.ts
--     is hardcoded to 001_platform_identity and is intentionally NOT modified here.
--   - ADDITIVE ONLY: creates a single new table (identity_link) plus the objects that
--     belong solely to it. It does NOT alter platform_identity or any existing table,
--     inserts NO rows, and performs NO data migration.
--   - The API/service layer is the PRIMARY authorization guard. Row-Level Security +
--     explicit REVOKEs here are DEFENSE-IN-DEPTH (so PostgREST + anon key can never
--     read/write this table), mirroring the 001/002 posture.
--   - NO runtime wiring is added. No endpoint, resolver, audit writer, AccessContext,
--     Login, AccessGuard, or session-resolve consumes this table yet. Identity mapping
--     remains inactive until a separately-approved integration milestone.
--   - SERVER-OWNED BY DESIGN: a link is established only from server-verified evidence
--     on BOTH provider sides (or controlled, server-verified admin provisioning).
--     Nothing here is ever populated from client-asserted identity. email is NEVER an
--     identity authority; it is not stored or referenced by this table at all.
--   - NO secrets: no token, JWT, JWKS, service-role key, DB URL, connection string,
--     password, or PAN is stored. Provider references mirror the existing
--     (auth_provider, auth_provider_uid) discipline; the app-owned internal_user_id is
--     the stable anchor.
--
-- Apply against the Supabase DEV project only. Reversible via the matching down
-- migration (004_identity_link.down.sql).
--
-- This migration assumes the Supabase roles `anon` and `authenticated` exist (they do
-- on Supabase Postgres); the explicit REVOKEs below target them plus PUBLIC.

-- gen_random_uuid() lives in pgcrypto. 001/002 already create it; create it defensively
-- so 004 is independently applicable. The down migration intentionally leaves it.
create extension if not exists "pgcrypto";

-- Shared updated_at helper (introduced by 002). Re-asserted defensively with
-- create-or-replace so 004 is independently applicable after 001 alone. It is a SHARED
-- utility: the 004 down migration intentionally does NOT drop it (matches the pgcrypto
-- retention pattern), so rolling back 004 cannot break 002's triggers.
create or replace function set_updated_at_timestamp()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

-- =============================================================================
-- identity_link — server-owned mapping of two verified provider references to one
-- stable app-owned anchor (internal_user_id). Additive; references platform_identity
-- only (no ALTER). RLS enabled, no client policies.
-- =============================================================================
create table if not exists identity_link (
  link_id                       uuid        primary key default gen_random_uuid(),

  -- Stable app-owned canonical anchor for the linked principal.
  internal_user_id              uuid        not null
                                            references platform_identity (internal_user_id) on delete cascade,

  -- Firebase provider reference (mirrors the existing (auth_provider, auth_provider_uid)
  -- discipline). Composite FK guarantees the reference is a real platform_identity row.
  firebase_auth_provider        text        not null default 'firebase'
                                            constraint identity_link_firebase_provider_chk
                                              check (firebase_auth_provider = 'firebase'),
  firebase_auth_provider_uid    text        not null,

  -- Supabase provider reference (same discipline + composite FK).
  supabase_auth_provider        text        not null default 'supabase'
                                            constraint identity_link_supabase_provider_chk
                                              check (supabase_auth_provider = 'supabase'),
  supabase_auth_provider_uid    text        not null,

  -- Lifecycle state. Links are reversible/disable-able (never hard-required to delete).
  status                        text        not null default 'active'
                                            constraint identity_link_status_chk
                                              check (status in ('active', 'disabled', 'revoked')),

  -- Verification provenance (NON-SECRET labels only; never a token/credential).
  verification_method           text        not null default 'unverified'
                                            constraint identity_link_verification_method_chk
                                              check (verification_method in
                                                ('unverified', 'verified_both_sides', 'admin_provisioned')),
  provenance_note               text,

  -- Lifecycle timestamps.
  created_at                    timestamptz not null default now(),
  updated_at                    timestamptz not null default now(),
  disabled_at                   timestamptz,
  revoked_at                    timestamptz,

  -- Optional app-owned actor provenance (plain UUIDs, decoupled like audit_event actors;
  -- never a raw provider uid). No FK so provenance survives operational-row lifecycle.
  created_by_internal_user_id   uuid,
  approved_by_internal_user_id  uuid,
  disabled_by_internal_user_id  uuid,
  revoked_by_internal_user_id   uuid,

  -- Each provider reference must correspond to a real durable identity row.
  constraint identity_link_firebase_ref_fk
    foreign key (firebase_auth_provider, firebase_auth_provider_uid)
    references platform_identity (auth_provider, auth_provider_uid) on delete cascade,
  constraint identity_link_supabase_ref_fk
    foreign key (supabase_auth_provider, supabase_auth_provider_uid)
    references platform_identity (auth_provider, auth_provider_uid) on delete cascade
);

comment on table identity_link is
  'Phase 1.6 M20.4: server-owned Firebase<->Supabase identity link. Maps two VERIFIED provider references to one stable app-owned internal_user_id anchor. Additive (no ALTER to platform_identity). email is NEVER an authority and is not stored here. Server-only via owner-role direct Postgres; RLS enabled, no policies. Not wired into any runtime path yet.';
comment on column identity_link.internal_user_id is
  'Stable app-owned canonical anchor (FK to platform_identity.internal_user_id, on delete cascade). Never a provider uid.';
comment on column identity_link.firebase_auth_provider_uid is
  'External Firebase reference (reference only; composite FK to platform_identity). Never exposed to clients.';
comment on column identity_link.supabase_auth_provider_uid is
  'External Supabase reference (reference only; composite FK to platform_identity). Never exposed to clients.';
comment on column identity_link.status is
  'Lifecycle: active|disabled|revoked. Uniqueness of a provider reference is enforced only among ACTIVE links (partial unique indexes), so history is retained.';
comment on column identity_link.verification_method is
  'NON-SECRET provenance label only: unverified|verified_both_sides|admin_provisioned. A link should reach active only with both sides verified.';

-- Keep updated_at honest on every update (shared helper from 002).
drop trigger if exists trg_identity_link_updated_at on identity_link;
create trigger trg_identity_link_updated_at
  before update on identity_link
  for each row execute function set_updated_at_timestamp();

-- A provider reference may participate in at most ONE active link (per side), and a
-- given active pair cannot be duplicated. Enforced via PARTIAL unique indexes so
-- disabled/revoked history rows are exempt.
create unique index if not exists uq_identity_link_active_firebase
  on identity_link (firebase_auth_provider, firebase_auth_provider_uid)
  where status = 'active';
create unique index if not exists uq_identity_link_active_supabase
  on identity_link (supabase_auth_provider, supabase_auth_provider_uid)
  where status = 'active';
create unique index if not exists uq_identity_link_active_pair
  on identity_link (firebase_auth_provider, firebase_auth_provider_uid,
                    supabase_auth_provider, supabase_auth_provider_uid)
  where status = 'active';

-- Lookup indexes for anchor- and provider-reference-based reads.
create index if not exists idx_identity_link_internal_user_id on identity_link (internal_user_id);
create index if not exists idx_identity_link_firebase_uid on identity_link (firebase_auth_provider_uid);
create index if not exists idx_identity_link_supabase_uid on identity_link (supabase_auth_provider_uid);
create index if not exists idx_identity_link_status on identity_link (status);

-- Defense in depth: RLS enabled with NO policies, plus explicit REVOKEs, so the table
-- can never be read/written via PostgREST + anon/authenticated. The server-side
-- owner-role direct-Postgres connection bypasses RLS and keeps working.
alter table identity_link enable row level security;
revoke all on table identity_link from public, anon, authenticated;

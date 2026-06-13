-- Phase 1.5 M1 — Thin Server/API + Platform Identity Foundation
-- Migration: 001_platform_identity (UP)
--
-- Creates the minimal, app-owned platform identity table. This is the FIRST
-- durable backend domain. It deliberately contains NO tenant/store business
-- data, NO POS/invoice/inventory/repairs/shipping columns, and makes NO
-- production-audit claim.
--
-- IDENTITY PRINCIPLE (binding):
--   internal_user_id is the STABLE, app-owned primary identity.
--   External auth provider UIDs (Firebase today, Supabase Auth later) are
--   REFERENCES ONLY and must never be used as the primary app identity.
--
-- Apply against the Supabase DEV project only. Reversible via the matching
-- down migration (001_platform_identity.down.sql).

-- gen_random_uuid() lives in pgcrypto. On Supabase this is normally available;
-- create it defensively. (The down migration intentionally leaves it in place.)
create extension if not exists "pgcrypto";

create table if not exists platform_identity (
  internal_user_id   uuid        primary key default gen_random_uuid(),
  auth_provider      text        not null,
  auth_provider_uid  text        not null,
  email              text,
  display_name       text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint platform_identity_provider_uid_key unique (auth_provider, auth_provider_uid)
);

-- NOTE on uniqueness: we intentionally do NOT add a unique(email) constraint.
-- email is nullable and may be shared/reused across dev/test accounts; the
-- real identity key is (auth_provider, auth_provider_uid).

comment on table platform_identity is
  'Phase 1.5 M1: app-owned platform identity. internal_user_id is the stable primary app identity; external auth UIDs (Firebase now, Supabase Auth later) are references only and must never be the primary app identity. Contains no tenant business data.';
comment on column platform_identity.internal_user_id is
  'Stable, app-owned identity. Decoupled from any external auth provider UID.';
comment on column platform_identity.auth_provider is
  'External auth provider id, e.g. ''firebase''. Reference only.';
comment on column platform_identity.auth_provider_uid is
  'External provider UID (e.g. Firebase UID). Reference only; NOT the primary app identity.';

-- Keep updated_at honest on every update.
create or replace function set_platform_identity_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_platform_identity_updated_at on platform_identity;
create trigger trg_platform_identity_updated_at
  before update on platform_identity
  for each row
  execute function set_platform_identity_updated_at();

-- Defense in depth: enable Row-Level Security with NO policies. This DENIES all
-- access to the anon/authenticated roles (so the table can never be read via the
-- Supabase auto REST API + anon key), while the server-side direct-Postgres
-- connection (table owner role via SUPABASE_DATABASE_URL) bypasses RLS and keeps
-- working. We deliberately add NO permissive client policies in M1.
alter table platform_identity enable row level security;

-- Phase 1.5 M10 — Durable Authorization + Append-Only Audit Foundation
-- Migration: 002_authorization_audit_foundation (DOWN / rollback)
--
-- ⚠ DEV ROLLBACK ONLY. This drops the durable authorization + audit tables.
--   - NEVER drop a populated audit_event table in production without a SEPARATE,
--     explicit owner approval, a verified backup, and a compliance review: dropping
--     audit_event destroys durable compliance evidence (7-year financial/audit
--     retention direction). Do NOT run this against production audit evidence casually.
--   - In M10 nothing is applied and nothing is seeded, so this is a clean reversal of
--     the 002 schema change in the DEV project.
--   - The "pgcrypto" extension is intentionally NOT dropped (shared utility; matches
--     the 001 rollback).
--
-- Objects are dropped in REVERSE dependency order.

-- 1) Audit append-only enforcement first (trigger before its function).
drop trigger if exists trg_audit_event_reject_mutation on audit_event;

-- 2) updated_at triggers for the mutable tables.
drop trigger if exists trg_tenant_feature_entitlement_updated_at on tenant_feature_entitlement;
drop trigger if exists trg_user_membership_updated_at on user_membership;
drop trigger if exists trg_store_updated_at on store;
drop trigger if exists trg_tenant_updated_at on tenant;
drop trigger if exists trg_app_user_updated_at on app_user;

-- 3) Tables in reverse dependency order.
drop table if exists audit_event;
drop table if exists tenant_feature_entitlement;
drop table if exists user_membership;
drop table if exists store;
drop table if exists tenant;
drop table if exists app_user;

-- 4) Shared helper functions (dropped after the tables/triggers that referenced them).
drop function if exists reject_audit_event_mutation();
drop function if exists audit_metadata_is_flat(jsonb);
drop function if exists set_updated_at_timestamp();

-- pgcrypto intentionally retained (see header).

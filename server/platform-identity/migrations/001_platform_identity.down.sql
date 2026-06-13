-- Phase 1.5 M1 — Thin Server/API + Platform Identity Foundation
-- Migration: 001_platform_identity (DOWN / rollback)
--
-- Drops ONLY the objects created by 001_platform_identity.up.sql. No production
-- data exists in M1 (dev-only slice), so this is a clean, non-destructive
-- rollback of the M1 schema change.
--
-- The "pgcrypto" extension is intentionally NOT dropped: it is a shared utility
-- that may be relied on by other objects, and dropping it is out of M1 scope.

drop trigger if exists trg_platform_identity_updated_at on platform_identity;
drop function if exists set_platform_identity_updated_at();
drop table if exists platform_identity;

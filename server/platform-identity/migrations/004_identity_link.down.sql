-- Phase 1.6 M20.4 — Identity Link (Firebase ↔ Supabase) Foundation
-- Migration: 004_identity_link (DOWN / rollback)
--
-- ⚠ DEV ROLLBACK ONLY. Drops ONLY the objects created solely by 004_identity_link.up.sql.
--   - Because 004 is purely additive (a single new table + its own indexes/trigger),
--     this is a clean, non-destructive reversal of the 004 schema change.
--   - It does NOT alter or drop platform_identity or any other table.
--   - The "pgcrypto" extension is intentionally NOT dropped (shared utility; matches the
--     001/002 rollback posture).
--   - The shared set_updated_at_timestamp() helper is intentionally NOT dropped here: it
--     is owned by 002 and used by 002's tables. 004 only re-asserted it defensively, so
--     dropping it on 004 rollback would break 002's triggers. Leaving it is safe and
--     idempotent (matches the pgcrypto retention pattern).
--
-- Objects are dropped in REVERSE dependency order.

-- 1) updated_at trigger first.
drop trigger if exists trg_identity_link_updated_at on identity_link;

-- 2) The table (its partial unique indexes, lookup indexes, constraints, and FKs are
--    dropped automatically with it).
drop table if exists identity_link;

-- pgcrypto and set_updated_at_timestamp() intentionally retained (see header).

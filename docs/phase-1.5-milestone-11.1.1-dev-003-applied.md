# Phase 1.5 M11.1.1 — DEV 003 Role Vocabulary Migration Applied

**Status:** `APPLIED TO DEV / VERIFIED / PRODUCTION UNTOUCHED`

This is an applied-state documentation record. It records evidence from the
M11.1.1 apply pass. It does **not** itself connect to any database, run SQL,
apply migrations, or seed data.

---

## 1. Git Checkpoint Before Apply

- Branch: `main`
- HEAD: `bd35e4d000b85fb87af5309bbf8d34462d8f8a9e`
- Commit subject: `Phase 1.5 M11.1 add role alignment and bootstrap templates`
- Working tree: clean (no code/files modified by the apply pass)

---

## 2. Migration Applied

`server/platform-identity/migrations/003_platform_role_vocabulary_alignment.up.sql`

---

## 3. Target

Supabase DEV project `tmpos2026-dev`. Production was untouched.

---

## 4. Apply Method

Guarded M10.2 migration runner.

---

## 5. Apply Command Used (without secrets)

```
ALLOW_SUPABASE_MIGRATION_APPLY=true CONFIRM_SUPABASE_TARGET=tmpos2026-dev npx tsx scripts/supabase-migrate.ts --migration 003 --direction up --apply --confirm-dev
```

The runner did not print the DB URL, the full SQL body, or any secrets.

---

## 6. PITR / Snapshot Note

- PITR/snapshot marker was **not** confirmed before apply.
- Owner explicitly proceeded after read-only pre-checks.
- DEV durable tables were row-empty.
- 003 is atomic/idempotent and reversible by 003 down if explicitly approved later.

---

## 7. Pre-Check Evidence

- Branch `main`.
- HEAD `bd35e4d000b85fb87af5309bbf8d34462d8f8a9e`.
- Working tree clean.
- `.replit` clean.
- Target guard `tmpos2026-dev`.
- 002 tables present: 6/6
  - `app_user`
  - `audit_event`
  - `store`
  - `tenant`
  - `tenant_feature_entitlement`
  - `user_membership`
- `user_membership_role_scope_chk` before apply used legacy platform vocabulary:
  - `platform_owner`
  - `platform_admin`
  - `platform_ops`
  - `platform_support`
  - `platform_readonly`
- `user_membership` role rows before apply: 0.
- Unmappable legacy platform rows before apply: 0.
- DEV seed tenant rows before apply: 0.
- DEV seed store rows before apply: 0.
- `audit_event` baseline count before apply: 0.
- Runner dry-run passed.
- Seed/bootstrap not applied before apply.
- Supabase MCP not used.

---

## 8. Apply Result

- Runner result: `SUCCESS: 003_platform_role_vocabulary_alignment UP applied`
- Exit code: 0
- 003 down was not run.
- Bootstrap seed was not applied.
- Bootstrap rollback was not applied.
- Supabase MCP was not used.
- No file changes were made during the apply.
- No commit/push/backup was run during the apply.

---

## 9. Post-Apply Verification Evidence

1. `user_membership_role_scope_chk` now contains canonical roles:
   - `system_owner`
   - `support_admin`
   - `billing_admin`
   - `operations_admin`
   - `security_admin`
   - `store_owner`
   - `manager`
   - `technician`
   - `sales_staff`

2. `user_membership_role_scope_chk` no longer contains legacy platform roles:
   - `platform_owner`
   - `platform_admin`
   - `platform_ops`
   - `platform_support`
   - `platform_readonly`

3. `user_membership.role_id` column comment updated and references:
   - canonical roles
   - status-based read-only behavior

4. No seed/bootstrap rows inserted:
   - `app_user`: 0
   - `tenant`: 0
   - `store`: 0
   - `user_membership`: 0
   - `tenant_feature_entitlement`: 0

5. `audit_event` after apply: 0, matching baseline.

6. RLS enabled on all six tables:
   - `app_user`
   - `tenant`
   - `store`
   - `user_membership`
   - `tenant_feature_entitlement`
   - `audit_event`

7. Grants remain revoked:
   - anon/authenticated/PUBLIC grants: 0 rows

8. `user_membership_scope_consistency_chk` still present.

9. Runtime/frontend isolation:
   - `/auth/session/resolve` unchanged
   - `/auth/session/resolve` still returns `authorization: null`
   - frontend unchanged
   - M11 resolver unchanged
   - working tree clean after apply

---

## 10. Explicit Non-Actions

- No seed/bootstrap applied.
- No rollback seed applied.
- 003 down not run.
- Production untouched.
- Supabase MCP not used.
- No frontend/runtime changes.
- `/auth/session/resolve` unchanged and authorization null.
- No durable audit writer.
- No repository live DB diagnostic.
- No Backend Control Plane.
- No commit/push/backup during apply.

---

## 11. Current Database State After Apply

- 003 applied.
- Canonical role CHECK active.
- Seed/bootstrap still pending.
- Durable tables still row-empty.
- `audit_event` still 0.

---

## 12. Rollback / Failure Note

- 003 down exists but must **not** be run without explicit owner approval.
- 003 down is DEV-only and may fail loudly if `billing_admin` or
  `security_admin` rows exist.
- Rollback must never delete `audit_event`.

---

## 13. Deferred Items

- Bootstrap seed application.
- Applied-state doc commit/backup.
- Read-only repository/query layer.
- Live authorization resolver diagnostic.
- Durable audit writer.
- `/auth/session/resolve` runtime wiring.
- Permission/sub-permission materialization.
- Backend Control Plane.
- Production apply.

---

## 14. Recommended Next Step

1. Commit this applied-state documentation record.
2. Backup to GitHub.
3. Then plan/apply DEV bootstrap seed as a separate step.

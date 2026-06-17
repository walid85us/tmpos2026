# Phase 1.5 M11.3 — Durable Audit Writer + Diagnostics

**Status:** `IMPLEMENTED / REVIEW-GATED / NOT WIRED`
**Owner UI QA:** not required (no visible UI change). The owner runs the DEV-gated live diagnostic in the Replit shell; it requires **no DEV UID** and prints no secret.

Checkpoint before M11.3: `dfbae139ff0c4d15d05e3a3b2cc11868f170fc52` ("Phase 1.5 M11.2 add read-only authz repository diagnostic").

---

## 1. Scope

M11.3 realizes the M9 inert audit contract (`DurableAuditEventV1`) as an actual, **append-only `INSERT`** into the durable `audit_event` table, behind a single sanctioned writer module — plus an **offline static check** and a **DEV-gated live diagnostic** that inserts exactly **one** redacted system/diagnostic row and proves no other durable row changed.

Explicitly, M11.3:

- **No runtime wiring.** `/auth/session/resolve` is untouched and still returns `authorization: null`. The writer is imported by the M11.3 live diagnostic **only**.
- **No frontend / AccessContext / Login / AccessGuard / App-routing change.**
- **No resolver (M11) / repository (M11.2) / migration-runner (M10.2) / contract (M9) change.**
- **No migration / seed / rollback applied.** No schema/RLS change. No SQL migration or seed file edited. No Supabase MCP.
- **No protected business API.** No `package.json` / lockfile change.
- **Append-only.** The writer performs `INSERT` into `audit_event` only — no `UPDATE/DELETE/UPSERT/ON CONFLICT/ALTER/DROP/TRUNCATE`.

---

## 2. Prerequisite state (DEV, as accepted at M11.2)

- Migration `003_platform_role_vocabulary_alignment` applied to Supabase DEV `tmpos2026-dev`.
- DEV durable rows (verified by the M11.2 live diagnostic, 15/15):
  - `app_user`: 1
  - `tenant`: 1
  - `store`: 1
  - `user_membership`: 3
  - `tenant_feature_entitlement`: 2
  - `audit_event`: **0** (before the M11.3 live diagnostic)
- The `audit_event` table, its append-only reject-update/delete trigger, the metadata flatness CHECK, and the metadata forbidden-keys CHECK already exist from migration `002_authorization_audit_foundation` (created/applied in earlier milestones). M11.3 creates no schema.

---

## 3. Files added

1. `server/platform-identity/auditEventWriter.ts` — the sanctioned, server-only, append-only audit writer (`INSERT`-only).
2. `scripts/diagnostics-audit-event-writer-static-check.ts` — offline, DB-free safety + builder shape/enum/allow-list check.
3. `scripts/diagnostics-audit-event-writer-live-check.ts` — DEV-gated live diagnostic that inserts exactly one redacted row and proves the deltas.
4. `docs/phase-1.5-milestone-11.3-durable-audit-writer-strategy.md` — this document.

No existing file was modified.

---

## 4. Writer surface

`auditEventWriter.ts` exports:

- `sanitizeAuditMetadata(input)` — redact arbitrary input to **allow-listed, scalar-only** metadata.
- `validateAuditEventInput(event)` — assert enums, UUID-or-null identifiers, and metadata safety; throws a non-sensitive `AuditEventValidationError`.
- `buildDiagnosticAuditEvent(correlationId)` — the canonical M11.3 live-diagnostic event (system actor, scope `none`).
- `buildAuthorizationDecisionAuditEvent(input)` — build a durable authorization-decision event for a **future** runtime caller (not wired in M11.3).
- `writeAuditEvent(event, options?)` — redact → validate → single parameterized `INSERT` → return `{ eventId, requestId }`. `options.executor` accepts a transaction handle.

It **reuses** the M9 contract: `DurableAuditEventV1`, `AuditMetadata`, `AUDIT_FORBIDDEN_FIELDS`, `AUDIT_METADATA_ALLOWLIST`, `AUDIT_EVENT_EVALUATED_BY`, `AUDIT_WRITE_FAILURE_STRATEGY`, `AUDIT_TABLE_INTENT`, plus the shared enums/version from `authorizationConstants`.

### Diagnostic event values

| Column | Value |
| --- | --- |
| `action_id` | `audit.writer.live_check` |
| `required_permission` | `n_a` |
| `decision` | `not_applicable` |
| `reason_code` | `audit_writer_live_check` |
| `result_status` | `succeeded` |
| `scope_type` | `none` |
| `tenant_id` | `null` |
| `store_id` | `null` |
| `actor_internal_user_id` | `null` |
| `actor_auth_provider` | `null` |
| `source_of_truth` | `system_diagnostic` |
| `evaluated_by` | `audit_writer_live_check@v0-dev` |
| `evidence_level` | `durable_compliance_event` |
| `request_id` | `correlationId` (unique per run) |

---

## 5. Safety flags (live diagnostic)

The live diagnostic refuses unless **all** hold (checked before any DB connection):

- `NODE_ENV !== 'production'`
- `ALLOW_LIVE_AUDIT_WRITER_CHECK === 'true'`
- `CONFIRM_SUPABASE_TARGET === 'tmpos2026-dev'`
- `SUPABASE_DATABASE_URL` present

It requires **no DEV UID**. Optional `EXPECTED_DEV_PROJECT_REF` adds a boolean-only project-ref match (value never printed).

---

## 6. Redaction strategy

- The **actor** is the app-owned `internal_user_id` (UUID) or `null` — **never** the raw provider uid, email, or any raw Supabase/Firebase/request object. `validateAuditEventInput` rejects any non-UUID actor id.
- `metadata` is the **primary** redaction guard: allow-listed + scalar-only (below). The DB metadata CHECK (forbidden top-level keys + flatness) is **defense-in-depth** only.
- The writer **logs nothing** (no `console.*`): it never prints the UID, email, DB URL, project ref, or any secret. DB errors propagate to the diagnostic, which reduces them to an error **name** only.

---

## 7. Metadata allow-list / scalar-only policy

`AUDIT_WRITER_METADATA_ALLOWLIST = AUDIT_METADATA_ALLOWLIST ∪ { 'check', 'phase' }`
( `route`, `httpStatus`, `featureKey`, `planTier`, `entitlementChecked`, `statusChecked`, `errorSummary`, `check`, `phase` ).

`sanitizeAuditMetadata`:

- drops any key not on the allow-list,
- drops any key on `AUDIT_FORBIDDEN_FIELDS` (defense-in-depth — never allow-listed anyway),
- drops any non-scalar value (objects / arrays / functions / `undefined`),
- truncates string values to 256 chars.

The diagnostic event metadata is `{ check: 'audit_writer_live_check', phase: 'phase-1.5-m11.3' }`.

---

## 8. No-mutation strategy

- The writer contains exactly one SQL statement: `INSERT INTO audit_event … RETURNING …`, all values bound via parameterized tagged-template interpolation (`jsonb` via `executor.json()`). No `sql.unsafe`, no dynamic/string-concatenated SQL, no caller-supplied table name.
- The writer exposes **no** `update*/delete*/remove*/upsert*` function.
- The DB independently enforces append-only via the `trg_audit_event_reject_mutation` trigger (rejects every `UPDATE`/`DELETE`, including from the table owner).
- The live diagnostic performs only the single writer `INSERT` plus read-only `SELECT`s of its own row; it deletes nothing.

---

## 9. Live diagnostic — expected result

- Diagnostic runs and inserts **exactly one** `audit_event` row.
- `audit_event` count increments by **exactly 1**.
- `app_user`, `tenant`, `store`, `user_membership`, `tenant_feature_entitlement` counts **unchanged**.
- Inserted row re-queried by `request_id`; row is redacted (system actor, scope `none`, no leaked identity).
- Metadata allow-listed + scalar-only + no forbidden keys.
- No UID/email/token/JWT/DB-URL/project-ref/service-role/anon-key substring in the row.
- No update/delete attempted; the row still exists afterward.

---

## 10. Explicit non-actions

No commit, push, or `npm run backup:github` in this slice. No runtime wiring; `/auth/session/resolve` unchanged (`authorization: null`). No frontend / AccessContext / Login / AccessGuard / App-routing edit. No M9/M10.2/M11/M11.2 edit. No migration/seed/rollback applied; no `003` up/down; no Supabase MCP; no schema/RLS change. No `package.json` / lockfile edit. No secret/UID/email/DB-URL/project-ref printed.

---

## 11. Important audit count impact

- **After** the M11.3 live diagnostic, `audit_event` is expected to be **at least 1** (the inserted diagnostic row, plus any future writes).
- **Future diagnostics MUST NOT assume `audit_event = 0`.** The M11.3 live diagnostic itself asserts only a **delta of +1**, never an absolute baseline.
- The M11.2 live diagnostic check **`M2 audit_event remains 0`** is now stale once M11.3 has run. It **must be relaxed in a separate follow-up** (e.g. assert "unchanged before vs after" instead of "== 0"). That edit is **out of scope** for M11.3 (M11.2 is not modified here).

---

## 12. Rollback

- **File-only rollback.** Delete the four files added in §3. No schema, migration, seed, or runtime change exists to revert.
- **Do NOT delete the inserted `audit_event` diagnostic row.** The table is append-only (the DB trigger would reject a delete anyway). The row is a benign, fully-redacted system/diagnostic event and is expected to remain.

---

## 13. Deferred items

- Relax the M11.2 live diagnostic `audit_event == 0` assertion (separate follow-up).
- Wire `buildAuthorizationDecisionAuditEvent` + `writeAuditEvent` into a real server decision path with the documented **fail-closed** strategy (`AUDIT_WRITE_FAILURE_STRATEGY`) — a separately-approved slice.
- Least-privilege DB grants for an application (non-owner) role that can `INSERT`/`SELECT` `audit_event` but never `UPDATE`/`DELETE`.

---

## 14. Next recommended step after acceptance

After review acceptance and backup of M11.3, the recommended next slice is the **M11.2 follow-up** that relaxes the now-stale `audit_event == 0` assertion, followed by wiring the writer into a single, fail-closed server decision path behind its own review gate.

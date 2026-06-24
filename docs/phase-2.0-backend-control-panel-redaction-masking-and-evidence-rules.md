# Phase 2.0 M4 — Backend Control Panel Redaction, Masking, and Evidence Rules

**Status:** Documentation-only · Redaction / masking / evidence rules (no code, no APIs, no DTOs, no mappers, no read models implemented)
**Accepted checkpoint at authoring:** `3df629ec7e5795dd6731879211f3118914f835c4` (Phase 2.0 M3)
**Authoring milestone:** Phase 2.0 M4

> Redaction-first document. Contains no real tenant/store/customer data, raw IDs,
> row dumps, emails, domains, DB URLs, tokens, secrets, payment identifiers,
> provider credentials, permission/entitlement key lists, or mismatch lists. This
> milestone makes no runtime, route, auth, DB, Supabase, DTO, type, read-model,
> mapper, or Backend Control Panel (BCP) UI change. Nothing is committed, pushed,
> or backed up by this milestone.

---

## 1. Executive Summary

This is a **documentation/design-only** milestone. It defines the redaction, masking, and evidence rules that every future Backend Control Panel (BCP) live read-only API, server-side read model, DTO mapper, automated test, and UI consumer **must** follow before any live data is wired.

No code, APIs, DTOs, mappers, read models, routes, database access, Supabase calls, or live data are implemented here. These rules are normative design constraints only. They do **not** assert that redaction exists in code, that the BCP is live-ready or production-ready, or that Supabase is ready for a Firebase cutover. The BCP remains DEV-gated, read-only, mock-only, frontend-only, and code-split.

The controlling principle is **fail closed and redact by default**: if a value's classification is unknown, it is treated as forbidden until explicitly classified and approved.

## 2. Current State and Boundary

- **Phase 2.0 M1** (Live Read-Only Architecture & Safety Gates Plan) — complete.
- **Phase 2.0 M2** (Read-Only API Contract Map; 9 proposed contracts C-01..C-09; all endpoint names are proposed placeholders only; no endpoints implemented) — complete.
- **Phase 2.0 M2.1** (Pre-M3 Design Reconciliation; two authority planes, corrected Phase 2 ordering, precise M20 / `identity_link` posture, M3 constraints) — complete.
- **Phase 2.0 M3** (Read Model and DTO Design; standard already-redacted DTO envelope, empty-state design, C-01..C-09 DTO sketches, field classification, forbidden payloads, mapper/test principles; no DTO code, types, routes, read models, or mappers implemented) — complete.

Boundary restated:

- The BCP is **not yet live-read-only**; it is still mock-only and DEV-gated at `/dev/backend-control-plane`.
- The BCP remains **frontend-only, read-only, mock-only, and code-split**.
- **Firebase / legacy AccessContext remains the current frontend/app authority.**
- Future BCP live read APIs must authorize from the **server-derived authorization principal** after parity/safety gates pass.
- **Supabase remains dormant / shadow / readiness-only and is not ready for a Firebase cutover.**
- **No endpoints are implemented.** M4 defines redaction / masking / evidence **rules** only.
- Controlled backend actions remain **Phase 3**; production readiness remains **Phase 4**.

## 3. Redaction Principles

- **Redaction by default.** A field reaches the UI only if it has been explicitly classified as safe; everything else is redacted or omitted.
- **Minimization by default.** A response returns only the fields the screen needs, never the full source shape.
- **Server-side redaction only.** Redaction is an authorization-grade boundary and happens entirely on the server, before the payload leaves the server boundary.
- **No UI-side security filtering.** The UI must never receive sensitive data and then hide it; filtering in the client is a presentation concern and is never a security boundary.
- **No raw source passthrough.** Source rows, ORM entities, audit events, and identity-link records are never serialized directly to the client.
- **No accidental existence disclosure.** Redaction must not let a caller infer that a hidden record, tenant, store, or secret exists (including via counts, errors, timing, or differential responses).
- **Evidence must be redacted before leaving the server boundary.** Verification evidence is summarized/redacted server-side; raw evidence never crosses the boundary.
- **Redaction metadata describes categories, not values.** Metadata states *that* and *what category* was redacted, never the redacted value or a sensitive field name.

## 4. Masking Principles

- **Masking only after authorization and redaction classification.** A value is masked only once the caller is authorized and the value has been classified as mask-eligible; masking is never a substitute for authorization.
- **Display-safe labels preferred.** Where a safe label can convey the needed meaning, prefer the label over any masked identifier.
- **Stable internal IDs must not be exposed** unless explicitly approved and masked; an internal ID is never returned in raw form by default.
- **Partial masks must not allow reconstruction.** A mask must not leave enough of the value (length, prefix, suffix, checksum) to reconstruct or correlate the original.
- **Secrets are never masked — they are omitted/blocked entirely.** A masked secret is still a secret leak; secrets must not appear in any form.
- **Payment identifiers are not masked unless explicitly approved; otherwise omitted/blocked entirely.**
- **Tokens, DB URLs, and provider credentials are never masked; they are blocked entirely.**

## 5. Evidence Safety Principles

- Evidence exists **for verification, not raw investigation**; it confirms a posture, it does not reproduce source data.
- Evidence snapshots must be **redacted and summarized**, never literal captures.
- **No row dumps.**
- **No raw audit event dumps.**
- **No raw `identity_link` rows.**
- **No secrets, tokens, DB URLs, or provider credentials.**
- **No actor raw IDs.**
- **No raw emails or domains** unless explicitly approved and masked.
- **No production-sensitive evidence in Phase 2.**
- Evidence references must be **safe, opaque, and non-sensitive** (an opaque reference must not encode tenant, store, actor, or record identity).

## 6. Field Classification Table

| Field class | Allowed? | Masking allowed? | Aggregation allowed? | Evidence allowed? | DTO allowed? | Notes |
|---|---|---|---|---|---|---|
| Safe label | Yes | N/A | Yes | Yes (`safe_summary`) | Yes | Public-safe posture/status text; no raw identity. |
| Count / aggregate | Yes | N/A | Yes | Yes (`aggregate_only`) | Yes | Omit when the count itself is sensitive (see §9). |
| Freshness label | Yes | N/A | Yes | Yes (`safe_summary`) | Yes | Relative/bucketed; not exact when timing is sensitive. |
| Environment label | Yes | N/A | Yes | Yes (`safe_summary`) | Yes | DEV/STAGING scope only; no production exposure in Phase 2. |
| Tenant/store display label | Yes | N/A | Yes | Yes (`safe_summary`) | Yes | Safe display label only; never raw tenant/store IDs. |
| Masked identifier | Conditional | Yes | Yes | `redacted_snapshot` | Conditional | Only if explicitly approved; mask must not allow reconstruction. |
| Sensitive operational metadata | Conditional | Yes | Yes (preferred) | `aggregate_only` | Conditional | Aggregated/masked only; never raw. |
| Audit summary metadata | Yes | N/A | Yes (required) | `aggregate_only` | Yes | Redacted aggregate only (see §11). |
| Auth/security posture | Conditional | N/A | Yes | `safe_summary` | Conditional | Posture labels only; no claims, tokens, or principals. |
| Raw identifier | No | No | N/A | No | No | Blocked unless explicitly approved + masked (then class becomes "Masked identifier"). |
| Secret/token/credential | No | No | No | No | No | Always blocked; never masked, never aggregated. |
| Payment/provider identifier | No | No | No | No | No | Blocked unless explicitly approved (§14). |
| Raw audit event | No | No | No | No | No | Only redacted aggregates leave the boundary. |
| Raw `identity_link` row | No | No | No | No | No | Never exposed; schema posture labels only (§12). |
| Permission/entitlement key | No | No | No | No | No | No key dumps; posture/labels only. |
| Mismatch detail | No | No | Conditional | No | No | No mismatch lists; only an aggregated/safe posture if approved. |
| Production config value | No | No | No | No | No | Blocked in Phase 2; posture labels only (§16). |

"N/A" means masking does not apply because the class is already a non-identifying label or aggregate. "Conditional" means allowed only with explicit, documented approval and the stated safeguards.

## 7. Safe Label Rules

Safe labels are bounded, enumerated, presentation-safe strings. They must **not** reveal raw IDs, emails, secrets, provider identifiers, payment identifiers, or production config values. Patterns:

- **Tenant/store labels** — safe display labels or opaque safe handles; never raw tenant/store/customer IDs, names that encode identity, domains, or emails.
- **Plan labels** — plan-tier posture labels; never pricing internals, entitlement keys, or payment data.
- **Actor labels** — role-class or "Actor Redacted" labels; never raw actor IDs, emails, or provider UIDs.
- **Environment labels** — `DEV` / `STAGING` only; never production identifiers, hostnames, or connection details.
- **Readiness labels** — e.g. `Ready` / `Not Ready` / `Gated`; never the underlying gated values.
- **Blocker labels** — categorical blocker reasons; never raw error text, stack traces, or sensitive cause strings.
- **Phase labels** — e.g. `Phase 2` / `Phase 3` / `Phase 4` posture; never internal scheduling or infra detail.
- **Severity labels** — bounded severity classes; never raw payloads that produced the severity.
- **Stale / freshness labels** — relative or bucketed freshness; never exact sensitive timestamps when timing is itself sensitive.

## 8. DTO Redaction Metadata Rules

Allowed metadata fields on the standard already-redacted DTO envelope (from M3):

- `redactionApplied` — boolean; whether redaction ran for this payload.
- `redactionLevel` — bounded enum describing the strength of redaction applied.
- `omittedFields` — list of **categories**, not actual field names when those names are sensitive.
- `maskedFieldCategories` — list of **categories**, not values.
- `evidenceMode` — one of the evidence modes in §18.
- `reason` — a safe, generic string.

Rules:

- `omittedFields` carries **categories**, not real field names, whenever a field name itself would disclose sensitive structure.
- `maskedFieldCategories` carries **categories**, never the underlying values.
- `reason` must be **safe and generic** (e.g. "blocked_by_phase", "redacted_by_policy").
- **No sensitive reason strings** — `reason` must never embed raw IDs, secrets, SQL, internal paths, or cause detail.

## 9. Empty-State Redaction Rules

- An empty state **must not reveal whether sensitive records exist**. "Empty" and "exists-but-hidden" must be indistinguishable to the caller.
- An empty state may indicate a bounded, safe status: `blocked_by_phase`, `blocked_by_schema`, `redacted`, `no_visible_records`, or `not_authorized`.
- **Avoid raw counts** when the count itself is sensitive; use a safe status instead of a number.
- Empty-state design must support **C-06 / C-07 blocked-on-schema/read-model readiness** (these contracts return blocked/empty states rather than fabricated data).
- Empty states must **avoid unsafe UI fallback assumptions** — the UI must not assume a non-empty mock array, must not infer existence from absence, and must render the safe status as-is.

## 10. Error Response Redaction Rules

- **Generic access denied** — authorization failures return a uniform denial; they must not distinguish "forbidden" from "not found" in a way that leaks existence.
- **Generic not found** — uniform, non-revealing.
- **Safe validation error codes** — bounded, enumerated codes; no free-form internal detail.
- **No SQL errors.**
- **No stack traces.**
- **No raw route internals** (handler names, file paths, internal identifiers).
- **No tenant/store existence leakage** via error shape, status code, or timing.
- A **safe, opaque correlation reference** may be returned only if it is non-sensitive and encodes no tenant, store, actor, or record identity.

## 11. Audit and Evidence Redaction Rules

- **C-04 audit visibility must be a server-composed redacted aggregate** (a net-new read aggregate; the existing audit foundation is append/write-focused and has no read path).
- **No raw audit logs.**
- **No raw actor IDs.**
- **No raw event payloads.**
- **No evidence ingestion** capability is added.
- **No audit-write capability** exists in the BCP; the audit writer is unchanged in Phase 2.0.
- Audit evidence must be **aggregated or summarized**.
- **Actor labels must be safe** — e.g. "Actor Redacted" or role-class only.
- **Audit timing must be label-based or safely bucketed** when exact timing is sensitive.

## 12. Identity Redaction Rules

- **C-09 must not expose raw `identity_link` rows.**
- The `identity_link` schema may be **posture-labeled only** (it exists/applied in DEV as a schema-only, RLS-protected foundation; it is not exposed to the BCP; its write/control exercise remains blocked/paused; service/repository/audit adapters are built/tested but dormant/unwired).
- **`identity_link` row presence must not be exposed** unless explicitly approved and safe.
- **No provider UID dumps.**
- **No email authority** — email is never identity authority and is never returned as an authority signal.
- **No client UID authority** — a client-supplied UID is never authority and is never echoed as one.
- **No raw `platform_identity` IDs.**
- **No raw `internal_user_id`** unless explicitly approved and masked.
- **Firebase frontend authority** and **server-derived principal readiness** must be reported only as **safe posture labels**, never as live claims or principals. Provider-aware identity mapping must be preserved.
- **Supabase cutover readiness must remain `Not Ready`** unless a later accepted gate changes it. C-09 must not imply a Supabase cutover.

## 13. Tenant / Store Redaction Rules

- **C-06 must use safe display labels and aggregated posture only.**
- **No raw tenant IDs.**
- **No raw store IDs.**
- **No raw customer IDs.**
- **No cross-tenant leakage** — tenant/store scope is resolved server-side from the authenticated principal and cannot bleed across tenants or stores.
- **Cross-tenant summaries require explicit platform permission and aggregation** (BCP access alone never implies cross-tenant visibility).
- **Tenant/store empty states must not reveal unauthorized existence** (an unauthorized or non-existent tenant/store yields the same safe empty/denied status).

## 14. Billing / Plan Redaction Rules

- **C-07 must use plan posture, billing readiness labels, and aggregate status only.**
- **No payment identifiers.**
- **No payment provider tokens.**
- **No raw invoice details.**
- **No customer billing data.**
- **No card / payment method data.**
- **No entitlement key dumps.**
- **No unrestricted plan config values.**
- C-07 remains **blocked-on-schema/read-model readiness** (the backing tables do not yet exist); it returns blocked/posture states rather than fabricated billing data.

## 15. Data Governance Redaction Rules

- **C-08 must use data quality, schema readiness, redaction posture, and evidence posture labels.**
- **No row dumps.**
- **No table dumps.**
- **No raw DB identifiers** unless explicitly approved and masked.
- **No unrestricted mismatch lists** (only an aggregated, safe posture if approved).
- **No production schema details** unless explicitly approved and redacted.

## 16. Configuration Redaction Rules

- **C-05 configuration posture must not expose** secrets, tokens, DB URLs, provider credentials, production config values, unrestricted environment variables, or config dumps.
- **Only safe posture labels are allowed.**
- The **config / secrets screen remains blocked/deferred** (Wave 3); it does not advance to live read-only in this phase.

## 17. Logs / Telemetry / Jobs Redaction Rules

These Wave 3 areas remain **deferred** and do not advance to live read-only without separate, dedicated redaction rules, because:

- **Logs / telemetry** may contain secrets, raw IDs, stack traces, and tenant/customer details.
- **Jobs / workers** may expose provider payloads or internal IDs.
- **API traffic** may expose request/response payloads.

Each requires its own redaction rule set, classification, and approval before any live read-only exposure is considered.

## 18. Evidence Mode Levels

| Evidence mode | Allowed payload | Use cases |
|---|---|---|
| `none` | No evidence returned. | Default; any context where evidence is unnecessary or unsafe. |
| `safe_summary` | Safe labels and bounded summary text only. | Posture/readiness screens (e.g. C-01, C-02, C-09 posture). |
| `redacted_snapshot` | A redacted, non-reconstructable snapshot (masked categories, no raw values). | Limited verification where a structured, redacted view is explicitly approved. |
| `aggregate_only` | Counts/aggregates and safe labels only; no row-level detail. | Audit visibility (C-04), governance posture (C-08), sensitive operational metadata. |
| `blocked` | No payload; a safe blocked status with a generic reason. | Blocked-by-phase/schema contracts (e.g. C-05 config/secrets, C-06/C-07 readiness, deferred Wave 3). |

A contract may only use an evidence mode no stronger than what its classification and approval allow; when in doubt, fall back toward `none` / `blocked`.

## 19. Contract-Specific Redaction Matrix

Endpoint/contract names are proposed placeholders only; nothing below is implemented.

| Contract | DTO (M3) | Redaction level | Evidence mode | Masking allowed? | Raw identifiers allowed? | Aggregation required? | Empty-state handling | Special restrictions |
|---|---|---|---|---|---|---|---|---|
| C-01 Readiness/posture | Posture DTO | Standard | `safe_summary` | No | No | Preferred | `no_visible_records` / `blocked_by_phase` | Posture labels only. |
| C-02 System operations summary | Ops summary DTO | Standard | `safe_summary` / `aggregate_only` | No | No | Yes | `no_visible_records` | Aggregated metrics only; no raw IDs. |
| C-03 Support / diagnostic posture | Diagnostic posture DTO | Standard | `safe_summary` | No | No | Preferred | `no_visible_records` | No raw diagnostics, logs, or payloads. |
| C-04 Audit visibility | Audit aggregate DTO | Elevated | `aggregate_only` | No | No | **Required** | `no_visible_records` | Redacted aggregate; safe actor labels; bucketed timing. |
| C-05 Configuration posture | Config posture DTO | Elevated | `blocked` / `safe_summary` | No | No | Yes | `blocked_by_phase` | No secrets/tokens/DB URLs/config dumps; config/secrets deferred. |
| C-06 Tenant / store posture | Tenant/store posture DTO | Elevated | `safe_summary` / `aggregate_only` | Conditional (approved) | No | Yes | `blocked_by_schema` / `not_authorized` | Safe display labels; no cross-tenant leakage. |
| C-07 Billing / plan posture | Billing posture DTO | Elevated | `safe_summary` / `aggregate_only` | No | No | Yes | `blocked_by_schema` | No payment data, tokens, invoices, or entitlement dumps. |
| C-08 Data governance posture | Governance posture DTO | Elevated | `aggregate_only` | Conditional (approved) | No | Yes | `no_visible_records` / `redacted` | No row/table dumps; no mismatch lists. |
| C-09 Identity readiness posture | Identity readiness DTO | Elevated | `safe_summary` | Conditional (approved + masked) | No | Preferred | `blocked_by_phase` / `redacted` | No raw `identity_link` rows; no UID/email authority; Supabase cutover `Not Ready`. |

## 20. Future Mapper Redaction Requirements

Future server-side mappers (not implemented here) must:

- **Apply redaction before returning a DTO** — redaction runs inside the mapper, on the server, before serialization.
- **Never pass raw source objects** — no source row, ORM entity, audit event, or identity-link record is serialized through.
- **Block forbidden fields** — secrets, tokens, DB URLs, provider credentials, payment identifiers, raw IDs, raw audit events, raw identity-link rows, permission/entitlement keys, and mismatch lists are dropped before output.
- **Include redaction metadata** — populate the §8 metadata so consumers know redaction was applied.
- **Produce safe empty states** — emit the §9 safe statuses rather than fabricating data or leaking existence.
- **Have tests for masked/omitted/blocked fields** — coverage that asserts each forbidden class never appears in output.
- **Fail closed** — on any unknown field, classification error, or mapping failure, the mapper omits/blocks rather than passing data through.

## 21. Future Test Requirements

Future automated tests (planned here; none run in this milestone) must cover:

- **Redaction classification tests** — each field maps to its correct class.
- **Masking tests** — masks are non-reconstructable.
- **Forbidden payload tests** — secrets/tokens/DB URLs/credentials/payment identifiers/raw IDs/raw events/raw identity-link rows/key dumps/mismatch lists never appear.
- **Evidence mode tests** — each contract emits only an allowed evidence mode.
- **Audit redaction tests** — C-04 returns only redacted aggregates; no raw actors/payloads.
- **Identity redaction tests** — no raw `identity_link` rows; no UID/email authority; Supabase cutover stays `Not Ready`.
- **Tenant/store leakage negative tests** — cross-tenant/store access and existence inference fail closed.
- **Billing/payment forbidden field tests** — no payment data, tokens, invoices, or entitlement dumps.
- **Configuration secret blocking tests** — no secrets/tokens/DB URLs/config dumps.
- **Empty-state redaction tests** — empty vs hidden are indistinguishable; safe statuses returned.
- **Error response redaction tests** — generic denials/not-found; no SQL/stack traces/route internals/existence leakage.

## 22. Stop Conditions

Halt and reassess before proceeding if any of the following arise:

- Redaction would require **UI-side filtering**.
- Masking would allow **reconstruction**.
- Evidence would require **raw rows**.
- Audit visibility would require **raw logs**.
- Identity readiness would require **raw `identity_link` rows**.
- Tenant/store posture would risk **cross-tenant leakage**.
- Billing posture would require **payment identifiers**.
- Config posture would require **secrets / tokens / DB URLs**.
- Logs / telemetry would require **raw payloads**.
- A DTO would require a **Supabase cutover**.
- A DTO would **assume a live pilot before parity** review.
- **Production exposure** would be required.

## 23. Acceptance Criteria

This milestone is acceptable when:

- The single documentation file exists under `docs/` and is redaction-safe.
- It defines redaction, masking, and evidence-safety principles (§3–§5).
- It provides the field classification table (§6), safe-label rules (§7), DTO redaction metadata rules (§8), empty-state rules (§9), and error-response rules (§10).
- It defines audit/evidence (§11), identity (§12), tenant/store (§13), billing/plan (§14), data governance (§15), configuration (§16), and Wave-3 logs/telemetry/jobs (§17) redaction rules.
- It defines evidence mode levels (§18) and the contract-specific redaction matrix for C-01..C-09 (§19).
- It defines future mapper (§20) and test (§21) requirements and stop conditions (§22).
- It preserves the M2.1 two-authority-plane assumptions and the M3 already-redacted DTO envelope and empty-state assumptions.
- It claims **no** redaction implementation in code, **no** live readiness, **no** production readiness, and **no** Supabase cutover readiness.
- No runtime, route, auth, DB, Supabase, DTO, type, read-model, mapper, or BCP UI change was made; nothing was staged, committed, pushed, or backed up.

## 24. Recommended Next Milestone

**Phase 2.0 M5 — Tenant / Store Isolation and RBAC Visibility Test Plan.**

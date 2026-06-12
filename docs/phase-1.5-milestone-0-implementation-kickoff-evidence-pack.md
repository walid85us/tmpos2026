# Phase 1.5 — Milestone 0: Implementation Kickoff Evidence Pack

> **Status:** **DOCUMENTATION / EVIDENCE PACK ONLY.** This milestone **implements nothing**. It is the final documentation gate before the first behavior-changing backend milestone (**Phase 1.5 M1**). It changes **no runtime, source, UI, schema, config, dependency, or secret**: no Supabase project files, no Supabase SDK, no PostgreSQL, no schema/`.sql`/migration, no ORM, no server/API runtime, no middleware, no repository runtime, no RLS policy, no audit persistence, no payment integration, no Firebase Auth change, no Supabase Auth. It does **not** modify `src/`, `server/`, `firestore.rules`, `firebase.ts`, `AccessContext`, `platformPermissionsConfig`, `accessConfig`, tenant/store permission code, routing, UI, `.replit`, `package.json`, or lockfiles. Every table and checklist below is a documentation artifact.
>
> **Allowed by this milestone:** Markdown under `docs/` (this file), a minimal/factual `replit.md` status update, and a stale-status housekeeping fix inside [`phase-1.4-product-owner-input-collection.md`](phase-1.4-product-owner-input-collection.md).
>
> **Reversible** (delete this doc + revert the `replit.md` status line + revert the POIC status-line fix). **Not committed / not pushed / not backed up; awaiting review.**
>
> **Part of:** Phase 1.5 — First Supabase Backend Implementation Slice. Builds on the accepted Phase 1.4 closeout ([M6](phase-1.4-milestone-6-backend-persistence-readiness-closeout.md)), the ratified provider/auth direction ([Product Owner Input Collection](phase-1.4-product-owner-input-collection.md)), the auth/repository boundary ([M1](phase-1.4-milestone-1-auth-repository-boundary-plan.md)), the durable data model ([M2](phase-1.4-milestone-2-durable-data-shape-domain-model.md) / [index](phase-1.4-domain-model-index.md)), and the enforcement contract ([M3](phase-1.4-milestone-3-request-context-protected-action-contract.md)). It records the conclusions of the **Phase 1.5 Planning Pass** (read-only, accepted).

---

## 1. Purpose and Scope

**Purpose.** Phase 1.4 ratified the backend *direction* (Supabase + Supabase Auth) as documentation only and left a defined set of pre-implementation evidence items open ([POIC §18](phase-1.4-product-owner-input-collection.md)). The Phase 1.5 Planning Pass (read-only) then evaluated candidate first slices and recommended **Platform Identity** as the safest. **M0 (this document) is the final evidence pack**: it selects the first implementation slice, states the behavior-changing risk that must be explicitly accepted, and assembles the remaining evidence (backup/restore plan, secret-manager plan, residency-confirmation trigger, schema/migration strategy, server/API boundary strategy, auth sequencing, feature-flag strategy, allowed/forbidden files, manual QA plan, rollback plan, and the M1 prompt requirements) — **so that M1 can be authorized and executed as a single, well-scoped, reversible behavior-changing milestone.**

**In scope (docs only):** the evidence pack sections below; the housekeeping fix to the POIC stale-status line; a minimal `replit.md` status update.

**Out of scope (unchanged across Phase 1.4 and this milestone):** any implementation — no provider SDK, no PostgreSQL, no schema/DDL/`.sql`, no ORM/migration, no server/API runtime, no middleware/guards/RLS/server enforcement, no Firebase Auth replacement or logic change, no Supabase Auth, no payment integration, no Firestore-rules change, no UI/routing/source change, no dependency install, no `.replit`/`package.json`/lockfile change.

**Honesty rule (binding):** M0 invents no facts. PITR/tier/region are **not** configured; they are stated as targets and gates. The first slice is **selected** here but **not implemented**; M1 must be **explicitly authorized as a separate behavior-changing milestone.**

---

## 2. Current Accepted Checkpoint

| Item | Value |
|---|---|
| Branch | `main` |
| Latest backed-up checkpoint | `ac94358c7e567560e53fea47730a10fa2783c02b` |
| Phase 1.3 — Platform Team Governance | COMPLETE / ACCEPTED / BACKED UP |
| Phase 1.4 — Backend & Persistence Readiness (M0–M6) | COMPLETE / ACCEPTED / BACKED UP (`19e32f8`) |
| Phase 1.4 Product Owner Input Collection / Provider Gate Evaluation | COMPLETE / ACCEPTED / BACKED UP (`ac94358`) |
| Phase 1.5 Planning Pass | Read-only; accepted (no doc file generated) |
| Backend implementation | **NOT STARTED** |
| This document (M0) | Docs/evidence only; **not committed / not pushed / not backed up; awaiting review** |

---

## 3. Phase 1.5 Planning Pass Summary

The Planning Pass (read-only) compared candidate first slices:

| Candidate | Enforcement value | Risk to current behavior | Money/PII/audit-evidence | Verdict |
|---|---|---|---|---|
| **A — Platform Identity / `internal_user_id` mapping** | High (keystone) | Low (additive) | No | **Selected** |
| B — Platform Roles / permission snapshot | High | Medium-High (touches live permissions early) | No | Defer |
| C — Platform Audit append-only | High | Medium (needs trusted server write + actor/context; depends on identity first) | Evidence-sensitive | Defer (after A) |
| D — Platform Settings persistence | Low-Medium | Low | No | Lower leverage than A |
| E — Tenant business data (POS/invoices/inventory/repairs/shipping) | High (eventually) | Very High (financial, `Crit`, `VeryHard`) | Yes | **Blocked / deferred** |

This matches the [domain-model index](phase-1.4-domain-model-index.md): `platform_identity` is **Order = 1**, while POS/invoices/inventory are **Order = D (defer), Sens = Crit (fin)**.

---

## 4. Selected First Implementation Slice

**Phase 1.5 M1 — Thin Server/API + Platform Identity Foundation.**

Future M1 purpose (NOT implemented in M0):

- Establish an **isolated backend/API boundary** (separate from the dev-only shipping sidecar in `server/index.ts`).
- Connect to **Supabase Postgres server-side only** (service-role; never client-exposed).
- Create a minimal **`platform_identity`** durable domain (one narrow table).
- Introduce an app-owned, stable **`internal_user_id`**.
- Map **`auth_provider`** + **`auth_provider_uid`** + **`email`** as external references.
- Keep **Firebase Auth untouched**; keep current login **unchanged by default**.
- Gate the new path behind a **feature flag defaulting OFF**.
- **Avoid all tenant business records.**

> **M0 does NOT implement this.** **M1 is the first behavior-changing milestone and must be explicitly authorized as a separate prompt.**

---

## 5. Why Platform Identity Is First

- **Additive, not substitutive.** It adds one table + an isolated endpoint behind an OFF-by-default flag; the current Firebase login → `getDoc(users/{uid})` → session path in `AccessContext.tsx` can remain unchanged.
- **No money, no PII-heavy data, no audit-evidence claim.** It avoids the `Crit`/`VeryHard`/financial domains and the 7-year-retention surface.
- **Keystone for everything else.** `internal_user_id` decoupled from `auth_provider_uid` is the documented precondition (M1 principle; DB decision-record consequence; M2 domain-model recap) for both future Postgres records and the eventual Firebase→Supabase Auth swap. Building it first makes the audit (C) and roles (B) slices cheaper and safer.
- **Smallest reversible schema.** One narrow table → trivial rollback (drop table, remove flag, retire endpoint).
- **Clean boundaries.** Exercises the M1 `IAuthProvider`/`IUserRepository` interfaces and the new server tier without merging production auth into the shipping sidecar.

---

## 6. Behavior-Changing Risk Statement

M1 **will** change runtime behavior — it is the first milestone in the project to do so for the backend. Specifically, M1 introduces:

- a **new server/API runtime** process/boundary (new attack surface + new operational dependency);
- a **live Supabase Postgres connection** using a **service-role secret** (high-value credential);
- a **new durable table** (`platform_identity`) and a **forward migration** (schema change);
- a **feature-flagged code path** that, when ON, writes/reads durable identity records.

**Residual risks to accept (mitigations in §16–§20):** secret leakage; the new server path inadvertently affecting login/preview; migration that is hard to reverse; the shipping sidecar being entangled with production auth. Mitigations: OFF-by-default flag, isolated boundary, reversible migration with documented rollback, secrets server-side only with log redaction, dev-only Supabase project, GitHub backup before M1.

---

## 7. Explicit Acceptance Required Before M1

M1 may begin **only** after the product owner explicitly accepts **all** of the following (checklist to be confirmed in the M1 authorization prompt):

- [ ] The selected first slice (**Platform Identity**, §4).
- [ ] The behavior-changing risk (§6).
- [ ] The Supabase **dev** project prerequisites are met (§8).
- [ ] The backup/PITR posture as **targets + pre-production gates** (§9–§10), with **no claim** that PITR is configured.
- [ ] The dev secret-manager approach (§11) and that production secret-manager selection is deferred.
- [ ] The residency-confirmation trigger is recorded and does not block dev M1 (§12).
- [ ] The schema/migration strategy (§13), server/API boundary strategy (§14), auth sequencing (§15), and feature-flag strategy (§16).
- [ ] The allowed/forbidden file scope (§17–§18), manual QA plan (§19), and rollback plan (§20).

---

## 8. Supabase Project Prerequisites

| # | Prerequisite | Requirement for M1 |
|---|---|---|
| 1 | Supabase account exists | Required |
| 2 | Supabase **dev** project exists before coding | Required |
| 3 | Project purpose | **Dev-only** for the first slice |
| 4 | Region | **US region, preferably Central/East** if available (inputs I2/I3) |
| 5 | Production project + production tier | **Separate future decisions** (not M1) |
| 6 | Database URL | Available as a **server-side secret** |
| 7 | Service-role key | **Server-side secret only** |
| 8 | Anon key | **Not required for M1** unless explicitly authorized (M1 is server-side) |
| 9 | Keys in client code | **Never** |
| 10 | Secrets in docs/examples/source/browser storage | **Never** |
| 11 | Dev secret store | **Replit Secrets** or equivalent |
| 12 | Production secret manager | Selected **later, before production** |

---

## 9. Supabase Region / Tier / PITR Requirements

- **Region:** US region (Central/East preference); exact region selected at implementation.
- **Tier/PITR:** the exact paid tier + PITR add-on are **selected before production data / production promotion**, not asserted now.
- For the **dev-only M1 identity slice** (no production data), **PITR may be documented as a hard pre-production-data gate** rather than a dev blocker.
- **Do not claim PITR is currently configured.**

---

## 10. Backup / Restore / RPO / RTO Plan

| Target | Value | Status |
|---|---|---|
| RPO | **≤ 15 minutes** | Accepted target (I12) |
| RTO | **≤ 4 hours** | Accepted target (I13) |
| Operational backup retention | **≥ 30 days** | Accepted target (I14) |
| Financial/audit/invoice retention | **7 years** | Accepted target (I24) |
| Managed backups | **Required** | Accepted (I15) |
| PITR | **Required before production data / production promotion** | Gate, not yet configured |

**Before production promotion, all of the following must be confirmed and recorded:** exact Supabase tier, region, backup retention, PITR enablement, a **restore drill** procedure (proving RTO ≤4h), **named backup ownership**, and **monitoring/alerting**. None of these is claimed as done in M0.

---

## 11. Secret Manager Plan

- **Dev secrets:** Replit Secrets / environment secret store.
- **Production secrets:** secret manager selected later, **before production**.
- **Supabase service-role key:** server-side only; **never** in the browser bundle or frontend code.
- **No secrets in Markdown** (including this doc), source, or browser storage.
- **Log redaction required** — reuse the existing `server/safe-log.ts` `sanitizeError` posture; never log connection strings or keys.
- **Rotation plan required before production** (DB credentials + Supabase keys).
- **Future CI/grep guard recommended** to catch accidental key/secret patterns before commit.

> No actual secrets are added, requested, or stored by this document.

---

## 12. Residency Confirmation Trigger

- **Current known answer:** no data-residency restriction known (input I4).
- **Tenant geography:** US-first (I2) supports a US region for dev/pilot.
- **Trigger:** before **production go-live**, a **legal/residency check** is required.
- **Gating:** the residency check **does not block dev-only M1**; it **must block production promotion** if unresolved.

---

## 13. Schema / Migration Strategy

- **SQL-first / Supabase migration style** preferred (input I23). **ORM deferred** until the schema stabilizes.
- First schema = **one minimal, rollbackable `platform_identity` table** with mandatory conventions: app-owned `internal_user_id` (PK), `auth_provider`, `auth_provider_uid`, `email`, `created_at`, `updated_at`.
- **No tenant business data**; **no POS/invoice/inventory/repairs/shipping tables.**
- **No RLS policy in M1** unless separately authorized.
- **Forward + documented-rollback** migration required in M1; **no destructive operations**; **no data backfill** beyond dev test rows.
- **No schema/migration files are created in M0.**

---

## 14. Server/API Boundary Strategy

- M1 creates a **separate, isolated server/API boundary** for production-context concerns.
- **Do NOT** merge Supabase / service-role key / production auth into the existing `server/index.ts` shipping sidecar.
- The **existing shipping sidecar remains isolated and unchanged.**
- M1 may create a **health/readiness endpoint**.
- M1 may create **one identity read/upsert endpoint** only if explicitly authorized.
- **No production server-side enforcement in M1** (no middleware/guards/RLS/authorization).
- The exact server/API runtime (Supabase Edge Functions vs external API/serverless) is a design detail for the M1 prompt (topology record still provisional).

---

## 15. Auth Sequencing Strategy

- **Firebase Auth stays untouched in M1**; current login remains unchanged.
- M1 maps the existing Firebase uid as `auth_provider='firebase'` + `auth_provider_uid=<firebase uid>`.
- **`internal_user_id` is app-owned and stable** (decoupled from the provider uid).
- **Supabase Auth migration is a later, explicit milestone** before real production users.
- **Preview/demo users remain separate** from production identity records (M3 separation rule); demo writes are never compliance evidence.

---

## 16. Feature Flag Strategy

- The M1 backend identity path must be behind a **feature flag, default OFF.**
- **Flag OFF → app behavior identical to today** (Firebase login path is the default).
- **Flag ON (dev only) →** platform identity mapping can be created/read for testing.
- **Rollback = disable the flag immediately** (instant runtime revert).

---

## 17. Allowed Files for M1

Allowed **only if explicitly authorized in the M1 implementation prompt**:

- New **isolated server/API boundary** files (new directory, separate from shipping).
- New **server-side Supabase/Postgres adapter** files.
- New **data/repository boundary** files **only for platform identity** (per M1 §3 concept: `authProvider`, `userRepository`, adapters, composition root — identity scope only).
- **One minimal SQL/Supabase migration** for `platform_identity` **plus rollback**.
- A **feature flag/config** file if needed, **default OFF**.
- `package.json` / lockfile **only** for the required Supabase server client or migration tooling.
- **Documentation updates.**
- *Possibly* a **minimal, flag-gated `AccessContext` touch only if unavoidable** — **prefer zero `AccessContext` changes.**

---

## 18. Forbidden Files / Work for M1

Remain **blocked** in M1:

- Modifying Firebase Auth/login behavior; replacing Firebase Auth; Supabase Auth migration.
- Modifying `src/firebase.ts`.
- Broad `AccessContext` rewrite; permission engine changes; tenant/store RBAC changes.
- POS / invoice / inventory / repairs / shipping persistence.
- Payment integration; Stripe/Square implementation.
- File/storage implementation.
- RLS policy implementation; server-side authorization enforcement.
- Production audit-evidence claim; provider-secret-persistence UI.
- Batch migration of mock data; UI redesign.
- Extending the shipping sidecar with production auth or the Supabase service role.

---

## 19. Manual QA Plan for M1

After the future M1 implementation, verify:

- [ ] App starts successfully.
- [ ] Isolated API boundary starts successfully (if created).
- [ ] Existing Firebase login still works.
- [ ] Google login still works (currently supported).
- [ ] Email/password login still works (currently supported).
- [ ] Preview/demo mode still works.
- [ ] Current tenant/store mock experience still works.
- [ ] Existing UI modules still load.
- [ ] POS / invoices / inventory / repairs / shipping behavior unchanged.
- [ ] Shipping sidecar still works (if tested).
- [ ] Secrets not visible in the client bundle (`dist/` grep) or logs.
- [ ] Feature flag OFF preserves current behavior (identical to today).
- [ ] Feature flag ON (dev) can create/read platform identity mapping **only**.
- [ ] Rollback path tested.

---

## 20. Rollback Plan for M1

- **GitHub backup before** M1 implementation begins.
- **Feature flag default OFF**; disable the flag to revert the runtime path.
- **Reversible SQL / rollback migration**; **no destructive migration.**
- **No production data migration**; **dev-only Supabase project** for the first slice.
- **Backup before schema change.**
- **Commit only after acceptance**; **push/back up only after acceptance.**

---

## 21. M1 Prompt Requirements

The future M1 authorization prompt must include:

1. **Explicit behavior-change acceptance** (§6–§7) and explicit authorization to begin M1.
2. The **exact allowed file list** (§17) and the **forbidden list** (§18).
3. Confirmation that the **Supabase dev project + region + server-side secrets** exist (§8).
4. The **`platform_identity` table shape** to create (from M2 / §13) + the **forward + rollback migration** requirement.
5. The **isolated server/API boundary** instruction and the **shipping-sidecar-untouched** constraint (§14).
6. The **feature-flag-default-OFF** requirement (§16) and the **Firebase-Auth-untouched** constraint (§15).
7. The **manual QA checklist** (§19) and **rollback plan** (§20).
8. The **secret-handling rules** (§11) and **no-secrets-in-docs/source/browser** constraint.
9. A **validation step** (`npx tsc --noEmit` / `npm run lint`) and a **non-regression confirmation**.
10. Instruction to **commit/push/back up only after acceptance.**

---

## 22. Blocked Work Still Blocked

Until M1 is explicitly authorized and accepted, the following remain **BLOCKED** (unchanged from POIC §19 / M5 §26 / M6 §13):

- [ ] Provider SDK installation; schema creation; SQL migrations; ORM setup.
- [ ] Production DB connection; Supabase Auth migration; Firebase Auth replacement.
- [ ] Server enforcement; middleware/guards; RLS policies.
- [ ] Repository runtime; server/API runtime.
- [ ] Real audit persistence; provider-secret persistence.
- [ ] Payment integration (Stripe/Square).
- [ ] Tenant business persistence (POS/invoices/inventory/repairs/shipping).
- [ ] **Any behavior-changing backend/provider/auth implementation.**

---

## 23. Non-Implementation Statement

This document **changes no runtime, source, UI, schema, config, dependency, or secret.** It does **not** implement Supabase, Neon, Railway, Hostinger-VPS Postgres, or PostgreSQL; does **not** create a Supabase project file or add the Supabase SDK; does **not** replace or modify Firebase Auth; does **not** implement Supabase Auth; creates **no** schema, SQL migration, ORM, or RLS policy; installs **no** dependency; implements **no** middleware, server guard, repository runtime, server/API runtime, or payment integration; persists **no** audit or secret; adds **no** environment variable. It does **not** modify `src/`, `server/`, `firestore.rules`, `firebase.ts`, `AccessContext`, `platformPermissionsConfig`, `accessConfig`, tenant/store permission code, routing, UI, `.replit`, `package.json`, or lockfiles. The only files this milestone touches are Markdown under `docs/`, a minimal `replit.md` status update, and a stale-status housekeeping fix in the POIC doc. **Reversible.** **Not committed / not pushed / not backed up; awaiting review.**

---

## 24. Validation / QA Summary

- **Docs only** — no behavioral QA applies; review is the gate.
- This step changes only **Markdown** (`docs/` + `replit.md`); no `.ts`/`.tsx`/`.sql`/schema/runtime/config/`.replit`/`package.json`/lockfile changes; nothing imported or wired.
- **TypeScript/lint:** this step touches no TypeScript; any pre-existing baseline errors are unchanged and none are introduced (validation output recorded in the report).
- **Exit criteria:** first slice selected (§4); behavior-change risk stated + acceptance checklist (§6–§7); Supabase prerequisites, backup/PITR, secret manager, residency trigger, schema/migration, server/API boundary, auth sequencing, feature-flag strategy recorded (§8–§16); allowed/forbidden files (§17–§18); QA + rollback (§19–§20); M1 prompt requirements (§21); blocked work restated (§22); non-implementation statement (§23). **No implementation started.**

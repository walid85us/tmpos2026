# Phase 1.4 — Milestone 5: Provider Finalization Gate + Production Readiness Inputs

> **Status:** **Documentation / architecture only.** This milestone defines the **decision gate** that must be satisfied **before any future backend / provider / auth implementation begins.** It **implements nothing**, finalizes nothing by assumption, and changes no runtime, source, UI, schema, config, or dependency. Every code-like or table fragment below is a **documentation artifact only**; nothing is imported or wired into the app.
>
> **It does NOT** implement Supabase / Neon / Railway / Hostinger-VPS PostgreSQL / PostgreSQL; does **not** replace or modify Firebase Auth; creates **no** schema, `.sql`, migration, or ORM file; installs **no** dependency; implements **no** middleware, server guard, repository runtime, or server/API runtime; does **not** touch `src/`, `server/`, `firestore.rules`, `firebase.ts`, `AccessContext`, `platformPermissionsConfig`, `accessConfig`, tenant/store permission code, routing, UI, `.replit`, `package.json`, or lockfiles.
>
> **Reversible** (delete this doc + revert the minimal decision-record cross-references and the `replit.md` status line). **Accepted / committed / backed up** at GitHub checkpoint `cdd1c03aae19eebb7a857b62ee2ca4adc5c42c59`; Phase 1.4 is consolidated and closed out in [M6](phase-1.4-milestone-6-backend-persistence-readiness-closeout.md).
>
> **Part of:** Phase 1.4 — Backend & Persistence Readiness. M5 is the **finalization gate** that consolidates the open product-owner inputs and provider/auth criteria from M0–M4 into a single go/no-go contract. See:
> - [`phase-1.4-milestone-0-backend-persistence-readiness.md`](phase-1.4-milestone-0-backend-persistence-readiness.md) (enforcement boundary + persistence inventory + truthfulness labels)
> - [`phase-1.4-milestone-1-auth-repository-boundary-plan.md`](phase-1.4-milestone-1-auth-repository-boundary-plan.md) (provider-agnostic auth/repository boundary + adoption order)
> - [`phase-1.4-milestone-2-durable-data-shape-domain-model.md`](phase-1.4-milestone-2-durable-data-shape-domain-model.md) (durable data shapes + identity strategy)
> - [`phase-1.4-milestone-3-request-context-protected-action-contract.md`](phase-1.4-milestone-3-request-context-protected-action-contract.md) (enforcement contract)
> - [`phase-1.4-milestone-4-provider-auth-decision-criteria.md`](phase-1.4-milestone-4-provider-auth-decision-criteria.md) (consolidated criteria + evaluation + recommended working decision)
> - [`phase-1.4-decision-record-production-database.md`](phase-1.4-decision-record-production-database.md) · [`phase-1.4-decision-record-deployment-topology.md`](phase-1.4-decision-record-deployment-topology.md) (canonical status holders)

---

## 1. Purpose and Scope

**Purpose.** M0–M4 established the *direction* (PostgreSQL; a future server/API enforcement tier), evaluated every candidate qualitatively, and recorded a **recommended working decision** (Supabase = preferred default working candidate; Firebase Auth retained for testing). M4 deliberately left the **final** database provider and the **final** auth provider **PROVISIONAL** because the last inputs (budget band, region/residency, RPO/RTO, scale envelope, plus a provider backup/restore plan) are product-owner answers, not engineering guesses.

M5 does **not** answer those inputs and does **not** finalize provider/auth by assumption. Instead, M5 **defines the gate**: the exact inputs that must be collected, the per-dimension go/no-go criteria, the per-candidate go/no-go criteria, the minimum evidence package, and the start conditions — so that when the product owner supplies the inputs, finalization is a **mechanical, auditable step** rather than an improvised one, and so that **no implementation begins before the gate is satisfied.**

**In scope (docs only):**
- The product-owner input checklist required to ratify final provider/auth.
- Per-dimension gates: backup/RPO/RTO, region/residency, cost/budget, scale, payments/PCI, local dev/test, schema tooling, security/secrets, preview/demo, Hostinger/deployment compatibility.
- Per-candidate go/no-go: Supabase, Neon, Railway, Hostinger-VPS PostgreSQL.
- Per-auth go/no-go: Firebase Auth retained, Supabase Auth replacement, custom auth.
- The minimum evidence package and backend-implementation start conditions.
- The list of work that must remain blocked until the gate is satisfied.
- A decision-intake template and instructions for updating the decision records once inputs arrive.

**Out of scope (unchanged from M1–M4):** any implementation — no provider SDKs, no PostgreSQL, no schema/DDL/`.sql`, no ORM (Prisma/Drizzle) files, no migrations, no middleware/guards/server enforcement, no Firebase Auth replacement or logic change, no Firestore-rules change, no UI/routing/source change, no dependency install, no `.replit`/`package.json`/lockfile change. Those remain future, separately-accepted milestones, blocked behind this gate.

**Method note (carried from M4).** No exact pricing or measured value is asserted. The repo/docs contain no negotiated pricing, no confirmed tenant geography, and no ratified RPO/RTO. All such items are recorded here as **inputs the gate requires**, not as answers M5 supplies. Where M4 already evaluated a criterion qualitatively, M5 cross-references it rather than re-deriving it.

---

## 2. Current Ratified Decisions (inherited — not re-opened by M5)

| # | Ratified decision | Source record |
|---|---|---|
| R1 | **PostgreSQL is the working production database direction.** | [DB decision record](phase-1.4-decision-record-production-database.md) |
| R2 | **A future server/API tier (managed API layer, serverless/edge, or VPS) — or equivalent backend enforcement layer — is required for any real server-side enforcement.** | [Topology decision record](phase-1.4-decision-record-deployment-topology.md) |
| R3 | **Continuing Firestore as the primary production database is *not recommended*** (weak fit for joins, ad-hoc aggregation, relational constraints, and this project's 7-level permission model). Firestore/Firebase **remains fine for testing**. | DB record §"Options considered" |
| R4 | **The auth + repository boundary stays provider-agnostic** (M1): vendor names live only in adapters; `internal_user_id` is decoupled from the auth-provider UID. | [M1](phase-1.4-milestone-1-auth-repository-boundary-plan.md) |
| R5 | **No card data in the application database**; payments via an external processor; app stores references/status/amount/currency/timestamps/links/audit only. | [M2](phase-1.4-milestone-2-durable-data-shape-domain-model.md) §payments |
| R6 | **Supabase is confirmed the PREFERRED default *working* provider candidate (design target)** — **not** the locked final provider. | [M4 §19–§20](phase-1.4-milestone-4-provider-auth-decision-criteria.md) |

M5 does **not** re-litigate R1–R6. It builds the gate that converts R6's "preferred working candidate" into a ratified-or-rejected final decision once the inputs exist.

---

## 3. Current Provisional Decisions (what the gate must resolve)

| # | Provisional question | Held by | Resolved when… |
|---|---|---|---|
| P1 | Final PostgreSQL provider — Supabase / Neon / Railway / Hostinger-VPS? | M4 §21 | Inputs §5 answered + a provider backup/restore plan exists + the matching §18–§21 go-criteria are met and no no-go trips. |
| P2 | Final auth provider — keep Firebase Auth / adopt Supabase Auth / custom? | M4 §21 | Tied to P1 + the "before real production users" timing + the §22–§23 go-criteria. |
| P3 | Region / data residency. | M4 §7 | Tenant geography + legal review supplied (§8). |
| P4 | RPO / RTO targets + backup retention. | M4 §8 | Owner ratifies targets; provider plan satisfies them (§7 of this doc). |
| P5 | Cost tier / budget band. | M4 §6 | Owner accepts a monthly band; re-priced against the scale envelope (§9). |
| P6 | Scale envelope (tenants/stores/users/transactions/attachments). | M4 §12 | Owner supplies an order-of-magnitude envelope (§10). |
| P7 | Local dev/test mechanism, schema tooling/ORM, server runtime (VPS vs serverless/edge). | M4 §10–§11; topology record | Chosen *after* provider/auth, *before* schema (§11–§12). |

**Honesty rule (binding for all of M5):** unless an input in §5 already exists in the repo/docs, M5 leaves it **unanswered and provisional**. M5 may **not** invent budgets, regions, RPO/RTO numbers, tenant counts, or a final vendor. Supabase remains the **preferred working candidate** until the gate is satisfied (→ ratify) or rejected (→ pick a fallback).

---

## 4. Why a Finalization Gate Is Required

1. **Irreversibility asymmetry.** Choosing a provider/auth is cheap to *design toward* (the M1 boundary keeps it portable) but expensive to *undo after data and users exist*. Auth migration cost in particular rises with every real production user (M4 §5). A gate forces the irreversible commitment to wait for the inputs that justify it.
2. **The blocking inputs are not engineering decisions.** Budget band, tenant geography, legal residency, acceptable data-loss window, and expected scale are **product-owner / business** answers. Guessing them would produce a confidently-wrong lock-in. The gate names them and stops until they exist.
3. **Financial / POS / audit data has low loss tolerance.** A provider cannot be finalized for invoice/POS/ledger/audit records without a written backup/restore plan that meets a ratified RPO/RTO (M4 §8). The gate makes that plan a hard precondition.
4. **One coherent target, no premature lock.** A gate lets design and the future *first* adapter aim at the preferred candidate (Supabase) **without** treating "preferred" as "final" — preserving the Neon/Railway/VPS + Firebase-Auth fallbacks until the evidence says otherwise.
5. **Auditable start condition.** Implementation milestones (out of Phase 1.4) need an unambiguous "may we begin?" test. The gate is that test: a checklist whose completion is the recorded authorization to start.

---

## 5. Product-Owner Input Checklist

These inputs must be **answered and recorded** (in the decision records, via the §27 intake template) before final provider/auth ratification. Most are one-line business answers, not research tasks. **M5 does not answer them unless they already exist in the repo/docs** — and as of this writing, none do; all are **Open**.

| # | Input | Why it matters | Feeds gate | Status |
|---|---|---|---|---|
| I1 | **Target production launch expectation** (rough timeframe / "no date yet") | Sets urgency of the auth-before-users window and re-pricing cadence. | Auth §22–§23; Cost §9 | Open |
| I2 | **Expected tenant geography** (where tenants/stores are) | Drives region + residency + latency. | Region §8 | Open |
| I3 | **Primary region preference** (if any) | Binds the DB/app region once geography is known. | Region §8 | Open |
| I4 | **Data residency / legal restrictions** (any jurisdiction constraints) | May force a region or exclude a provider. | Region §8 | Open |
| I5 | **Budget band for database / backend / auth** (qualitative band) | Selects managed tier vs self-host trade-off. | Cost §9 | Open |
| I6 | **Acceptable monthly production infrastructure range** | Hard ceiling for provider/tier choice. | Cost §9 | Open |
| I7 | **Expected early tenant count** (order of magnitude) | Sanity-checks the managed-tier choice. | Scale §10 | Open |
| I8 | **Expected early store count** | Per-tenant fan-out for sizing. | Scale §10 | Open |
| I9 | **Expected staff / user count** | Auth + row-volume sizing. | Scale §10; Auth | Open |
| I10 | **Expected transaction volume** (orders/invoices/POS per period) | Write throughput + storage growth. | Scale §10; Backup §7 | Open |
| I11 | **Expected attachment / file volume** | Object-storage need (DB stores metadata only, M2). | Scale §10; Provider §18–§21 | Open |
| I12 | **RPO target** (tolerable data-loss window) | Backup frequency + PITR requirement. | Backup §7 | Open |
| I13 | **RTO target** (tolerable recovery time) | Restore approach + provider maturity. | Backup §7 | Open |
| I14 | **Backup retention target** | Retention config + compliance window. | Backup §7; Compliance | Open |
| I15 | **Whether managed backups are required** | Directly gates the VPS option in/out. | Backup §7; Provider §21 | Open |
| I16 | **Payment processor preference** (if known) | Webhook/audit shape; PCI scope. | Payments §12 | Open |
| I17 | **Confirmation that no card data will be stored** | Keeps PCI scope minimal (R5/M2). | Payments §12 | Open |
| I18 | **Whether Hostinger hosts only the static frontend, or also backend/API** | Decides co-location vs off-host API + DB region. | Deployment §17; topology record | Open |
| I19 | **Whether Replit remains dev-only** | Confirms no production runtime on Replit. | Deployment §17; Security §15 | Open |
| I20 | **Whether Supabase Auth replacement is acceptable before production users** | Unblocks/forbids the auth swap window. | Auth §22–§23 | Open |
| I21 | **Whether Firebase Auth must remain for continuity** | May force the provider-neutral path. | Auth §22–§23 | Open |
| I22 | **Local development preference** (Supabase CLI / Docker Postgres / cloud dev DB / managed dev branch) | Picks the dev path before implementation. | Local dev §11 | Open |
| I23 | **Schema migration tooling preference** (if any) | SQL-first / Supabase migrations / Prisma / Drizzle. | Tooling §12 | Open |
| I24 | **Compliance / audit retention expectation** | Retention + export + truthfulness obligations. | Backup §7; Security §15 | Open |

**Standing statements (binding):**
- **M5 does not answer these inputs unless they already exist** in the repo/docs. None exist today → all remain Open.
- **Any missing input keeps final provider and final auth PROVISIONAL.** A single Open blocking input (I2–I15, I20–I21) is sufficient to keep the gate closed.
- **Supabase remains the PREFERRED working target** until the gate is satisfied (→ ratify Supabase or a chosen fallback) or explicitly rejected.

---

## 6. Provider Finalization Gate (overview)

The gate is satisfied **for a given provider** only when **all** of the following hold:

1. The relevant §5 inputs are answered and recorded (region/residency, budget band, RPO/RTO, scale, managed-backup requirement, Hostinger/deployment mode).
2. The per-dimension gates (§7–§17) each pass for that provider.
3. The provider's specific go/no-go checklist (§18–§21) shows **all go-conditions met and no no-go condition tripped**.
4. A **written provider backup/restore plan** exists and meets the ratified RPO/RTO.
5. The auth finalization gate (§22–§23) resolves consistently with the chosen provider.
6. The minimum evidence package (§24) is complete and the start conditions (§25) are met.

Until all six hold, the provider stays provisional and Supabase remains the preferred working candidate.

---

## 7. Backup / Restore / RPO / RTO Gate

**Minimum expectations (all required before implementation):**

- [ ] **RPO target defined** (tolerable data-loss window) — owner-ratified (I12). Working placeholder from M4 §8 (a *short* RPO, minutes-not-hours, for financial data) is **a placeholder to confirm, not an answer**.
- [ ] **RTO target defined** (tolerable recovery time) — owner-ratified (I13). M4 placeholder: same-day for financial data — **confirm, do not assume**.
- [ ] **Backup retention defined** (I14) and compatible with the compliance/audit retention expectation (I24).
- [ ] **Restore test plan required** — a written drill (how a restore is performed and verified), not just "backups exist."
- [ ] **Backup ownership named** — *who* owns backups/restore (the provider for managed; a named person/role for VPS).
- [ ] **Monitoring / alerting plan** — backup success/failure and restore-readiness are observed and alert on failure.
- [ ] **Production data export path** — a way to extract production data (portability + DR), independent of any single vendor surface.
- [ ] **No reliance on browser / session / local storage for business records** — reaffirms M0 truthfulness labels (`sessionStorage`/`localStorage` mirrors are *advisory*, never durable evidence).

**Binding statements:**
- **No provider may be finalized for financial / POS / audit data without a written backup/restore plan that meets the ratified RPO/RTO.**
- **The Hostinger-VPS option may not proceed without explicit operational ownership** of backups, restore drills, monitoring, patching, and HA (see §21). Managed backups (I15 = required) trips the VPS no-go.

---

## 8. Region / Data Residency / Latency Gate

**Minimum expectations:**

- [ ] **Primary tenant geography identified** (I2).
- [ ] **Acceptable database region(s) identified** (I3) — near tenants and the app host.
- [ ] **Frontend / API / database region alignment** considered jointly (app-tier ↔ DB-tier round-trip; external payment/shipping API regions).
- [ ] **Legal residency rules identified** (I4) — whether any jurisdiction constrains where PII / financial records may live.
- [ ] **External provider/API latency considerations** noted (payments, shipping carriers).
- [ ] **Documented principle:** *correctness and durability outrank small latency optimization* — never trade integrity for round-trip speed (M4 §7).

**Binding statement:** a provider cannot be finally ratified until it offers an **acceptable region** for the (still-open) tenant geography and any residency rule. All four candidates offer region selection; the binding constraint is the unanswered geography (I2) and residency (I4).

---

## 9. Cost / Budget Gate

**Minimum expectations:**

- [ ] **Budget band accepted** (I5) before final provider selection.
- [ ] **Acceptable monthly production infrastructure range accepted** (I6) as a hard ceiling.
- [ ] **Managed cost balanced against operational risk** — managed DB subscription vs the hidden cost of self-hosting (backups, patching, HA, monitoring, security; see §21).
- [ ] **Variable cost watch** — egress, connection/compute autoscaling, storage growth (attachments → object storage, not the DB), edge/function invocations (M4 §6).
- [ ] **Re-price before go-live** against the then-known scale envelope (§10).

**Binding statements:**
- **Production infrastructure may not rely on a free / dev tier** for business records — free tiers are testing-only (M4 §6).
- **Self-hosting can lower subscription cost but increases maintenance, backup, restore, security, and monitoring responsibility** — a real cost, not a line item.
- **No exact prices are invented here.** Cost is expressed as bands and a re-price gate.

---

## 10. Expected Scale Envelope Gate

**Minimum expectations (order-of-magnitude is sufficient):**

- [ ] **Early tenant count** (I7).
- [ ] **Early store count** (I8).
- [ ] **Staff / user count** (I9).
- [ ] **Transaction volume** (I10).
- [ ] **Attachment / file volume** (I11) — drives the object-storage decision (DB stores metadata only, M2).

**Binding statements:**
- **The scale envelope drives the managed-tier choice** (small → entry tier; growth → reserved/compute tiers). Picking a tier before the envelope is premature (M4 §6, §12).
- **The design must not block later growth.** Growth-ready primitives are already mandated by M2 (stable `internal_user_id`; `tenant_id`/`store_id` on every scoped record; append-only/partition-ready audit + ledger; deliberate indexes). M5 adds no schema; it only requires the envelope as a sizing input.

---

## 11. Local Dev / Test Gate

**Minimum expectations:**

- [ ] **Current Firebase / Replit testing continues** unchanged in M5.
- [ ] **Before backend implementation, choose exactly one dev path** (I22):
  - Supabase local CLI (if Supabase is selected — runs Postgres + Auth + Storage locally);
  - Docker / local PostgreSQL (if Neon / Railway / VPS-style provider is selected — auth handled separately);
  - cloud dev database (a separate cheap managed instance);
  - managed dev branch / project (isolated from prod data).

**Binding statement:** **no local database, container, or CLI is implemented or installed in M5.** The dev path is *chosen* at the gate, *implemented* later.

---

## 12. Schema Migration / Tooling Gate

**Minimum expectations:**

- [ ] **Schema migration tooling chosen before the first real schema implementation** (I23).
- [ ] **Options remain open:** SQL-first (hand-written + a runner), Supabase migrations, Prisma, Drizzle, or another accepted tool.
- [ ] **Tooling decision aligns with the provider and deployment choice** (e.g. Supabase migrations only if Supabase is final).
- [ ] **Sequencing rule (from M4 §11):** decide tooling *after* provider/auth is clear and the M2 data model is finalized, and *before* any real schema implementation.

**Binding statement:** **no schema / DDL / `.sql` / migration / ORM file is created in M5.** Tooling is *selected* at the gate, *applied* later.

---

## 13. Security / Secrets Gate

**Minimum expectations:**

- [ ] **Production provider secrets never live in memory / browser / session / localStorage** — reaffirms the M0/topology truth that the current shipping sidecar holds provider keys **in-memory (ephemeral, dev-only)**, which is *not* production-grade secret storage.
- [ ] **Secrets live in a secure env / secret manager** in production.
- [ ] **Rotation plan** for provider API keys, DB credentials, webhook secrets, and payment secrets.
- [ ] **Audit logs redact secrets** (reaffirms `server/safe-log.ts` / `sanitizeError` PII-redaction posture; audit truthfulness labels from M0/M3).
- [ ] **Current shipping/provider config is dev/prototype only** unless and until documented otherwise.

**Binding statement:** no secret-management runtime is implemented in M5; the gate records the requirement.

---

## 14. (reserved — see §15 Preview / Demo Mode Gate)

*(Section numbers below follow the report ordering; §15 = Security covered above as the Security/Secrets gate, §16 = Preview/Demo. To avoid renumbering the inherited cross-references, the gates are presented in the order: Backup §7 · Region §8 · Cost §9 · Scale §10 · Local Dev §11 · Tooling §12 · Security §13 · Preview/Demo §below · Deployment §below.)*

---

## 15. Preview / Demo Mode Gate

**Minimum expectations:**

- [ ] **Preview / demo users must not be production-authenticated users.**
- [ ] **Preview / demo writes must not be treated as compliance evidence** (reaffirms M0/M3 truthfulness labels).
- [ ] **Preview / demo mode routes to mock / demo data or isolated sandbox data**, never production records.
- [ ] **Future backend implementation must keep preview/demo strictly separate from production records** — the M1 auth boundary + M3 request-context already abstract this; implementation must preserve it.

**Binding statement:** no preview/demo runtime is changed in M5; the separation requirement is recorded for the implementation phase.

---

## 16. Hostinger / Deployment Compatibility Gate

**Minimum expectations:**

- [ ] **Clarify whether Hostinger hosts only the static frontend, or also the backend/API** (I18).
- [ ] **Confirm whether Replit remains dev-only** (I19) — today `.replit` is `deploymentTarget = "static"`; the Express shipping sidecar is dev-only (topology record).
- [ ] **Managed Postgres off-host preferred** to keep DB ops off the Hostinger host; a Hostinger-VPS-hosted DB couples DB lifecycle to the VPS (more ops — see §21).
- [ ] **The moment server-side enforcement / a real API is required → VPS or serverless/edge**, not static/shared (R2; topology record).
- [ ] **Keep the auth, repository, request-context, and audit boundaries host/DB-agnostic** before go-live (M1/M3).

**Binding statement:** no `.replit`, build config, deployment target, or `server/index.ts` change is made in M5.

---

## 17. Supabase Go / No-Go Criteria

> M4 status: **PREFERRED** (ratified default working candidate; final provider provisional). The gate below converts that to a final ratify/reject once §5 inputs exist.

**GO if all hold:**
- [ ] Managed Postgres **region** is acceptable for the tenant geography + residency (§8).
- [ ] **Backup/restore plan** (managed backups + PITR + retention) satisfies the ratified **RPO/RTO** (§7).
- [ ] **Cost tier** is within the accepted budget band (§9).
- [ ] **Supabase Auth migration is acceptable** *or* **Firebase Auth bridging is intentionally planned** (§22–§23) — and, if Supabase is final, the auth swap is scheduled **before** real production users.
- [ ] **Storage strategy acceptable** (Supabase Storage for blobs; DB keeps attachment metadata only — M2).
- [ ] **RLS / server-enforcement path acceptable** (RLS + Edge Functions or an external API tier — R2).
- [ ] **Local/dev story acceptable** (Supabase CLI local stack — §11).

**NO-GO if any holds:**
- [ ] Required **region/residency unavailable** or unacceptable.
- [ ] **Backup/restore does not meet** RPO/RTO tolerance.
- [ ] **Cost exceeds** the accepted budget band.
- [ ] **Auth migration is unacceptable AND Firebase bridging is not designed.**
- [ ] **Operational or vendor-lock risk is rejected** (Auth/Storage/Edge/Realtime proprietary surface — mitigated but not eliminated by the M1 boundary).

---

## 18. Neon Go / No-Go Criteria

> M4 status: **ACCEPTABLE FALLBACK** — the provider-neutral path (low lock-in) that **retains Firebase Auth**.

**GO if all hold:**
- [ ] **Managed Postgres is preferred but auth remains independent** (Firebase Auth or custom, not bundled).
- [ ] **Firebase Auth / token-verification mapping is acceptable** (API tier verifies Firebase tokens; `auth_provider_uid` → `internal_user_id` — M4 §17).
- [ ] **Separate storage / file strategy is planned** (external object storage; Neon bundles none).
- [ ] **A separate backend/API tier is selected** (R2 — you own the API + auth verification).
- [ ] **Backup / branching / restore plan satisfies RPO/RTO** (§7).
- [ ] **Region + cost** acceptable (§8, §9).

**NO-GO if any holds:**
- [ ] **Bundled auth / storage is required** (Neon provides neither).
- [ ] **The operational split** (DB here, auth there, storage elsewhere, API tier separate) **is too complex** to own.
- [ ] **Backup / region / cost does not fit.**

---

## 19. Railway Go / No-Go Criteria

> M4 status: **ACCEPTABLE FALLBACK** — like Neon, with the bonus of also hosting the API tier.

**GO if all hold:**
- [ ] **Combined app/API + Postgres hosting is desired** (one platform for the runtime + DB).
- [ ] **Region and backup story are acceptable** — confirm automated backup/PITR posture on the plan (§7, §8).
- [ ] **Operational simplicity is acceptable** (managed Postgres; convenient API/sidecar host).
- [ ] **Cost is acceptable** — usage/compute-based; watch always-on vs sleep + egress (§9).
- [ ] **Auth** handled as Firebase-retained + token verification (no bundled auth — §22).

**NO-GO if any holds:**
- [ ] **Backup/restore maturity is insufficient** for financial data (verify before relying on it).
- [ ] **Region / residency is unsuitable** (fewer regions than the largest providers — confirm against I2).
- [ ] **Platform lock-in / runtime risk is rejected.**

---

## 20. Hostinger VPS PostgreSQL Go / No-Go Criteria

> M4 status: **ACCEPTABLE-WITH-CAVEATS / NOT PREFERRED for financial/POS data** — the weakest point is self-owned backup/restore/HA.

**GO if all hold:**
- [ ] **Cost / control is explicitly prioritized** over operational convenience.
- [ ] **Reliable automated backups, restore testing, monitoring, security patching, and DBA-like ownership are accepted** and a named owner exists (§7, §13).
- [ ] **RPO/RTO can be satisfied** manually or with managed add-ons (§7).
- [ ] **VPS region is acceptable** for tenant geography + residency (§8).

**NO-GO if any holds:**
- [ ] **Managed backup/restore is required** (I15 = required → immediate no-go).
- [ ] **Low operational burden is required.**
- [ ] **No one will own DB operations / security.**
- [ ] **Financial / POS data reliability risk is unacceptable** (the default posture — not preferred for this data).

---

## 21. Auth Finalization Gate (overview)

The auth decision is **tied to the provider decision** (P1↔P2). Resolve the three options below; exactly one becomes final, consistent with the chosen provider and the "before real production users" timing.

**Cross-cutting identity rules (binding, from M1/M2/M4 — reaffirmed, non-negotiable):**
- `internal_user_id` **remains the stable application identity** (primary key on app records).
- `auth_provider` and `auth_provider_uid` **remain external references**, never primary keys.
- **No future record may use a Firebase UID or Supabase UID as the primary app user ID.**
- **For testing, Firebase Auth remains untouched.**

---

## 22. Firebase Auth Retained Go / No-Go Criteria

> Applies to the long-term retain-with-PostgreSQL path (Neon / Railway / VPS).

**GO if all hold:**
- [ ] A **provider-neutral DB is chosen** (Neon/Railway/VPS) *or* **Firebase bridging is intentionally designed** alongside Supabase.
- [ ] The **API tier can verify Firebase tokens** (Firebase Admin SDK — R2).
- [ ] **`internal_user_id` mapping is durable** (`auth_provider_uid` → `internal_user_id`).
- [ ] **Tenant / store memberships are app-owned** (in app tables, keyed by `internal_user_id` — M2).
- [ ] **Auth UID is never the app primary key** (the binding rule above).

**NO-GO if any holds:**
- [ ] **Supabase-native Auth / RLS integration is required** (favoring the Supabase Auth path instead).
- [ ] **Later migration would be costly after production users** exist and the swap was deferred.
- [ ] **Token-verification / mapping complexity is rejected.**

---

## 23. Supabase Auth Replacement Go / No-Go Criteria

> Applies only if Supabase is the **final** provider; do it **before** real production users.

**GO if all hold:**
- [ ] **Supabase is the final provider** (otherwise this is pointless lock-in — M4 §18).
- [ ] **Migration before production users is acceptable** (I20) — the cheapest window.
- [ ] **User mapping to `internal_user_id` is preserved** (Supabase UID becomes `auth_provider_uid`).
- [ ] **Email / password / Google login parity can be planned** (today: Google popup + email/password only; email is the natural re-mapping key — M4 §17).
- [ ] **Preview / demo mode remains separate** (§15).

**NO-GO if any holds:**
- [ ] **Firebase Auth must remain permanently** (I21).
- [ ] **Migration risk is unacceptable.**
- [ ] **Supabase is not the final provider.**

### 23a. Custom / Self-Managed Auth

> **Default status: NOT RECOMMENDED** unless a future hard enterprise requirement (e.g. specific SSO/SCIM/on-prem identity mandate) forces it. Highest build + security-maintenance burden (password storage, reset, MFA, session, breach response). Recorded for completeness; not a working candidate.

---

## 24. Minimum Evidence Required Before Backend Implementation

A backend implementation milestone may begin **only when this package exists and is recorded** (each item is a hard precondition):

- [ ] **Final provider decision record updated** (Supabase or a chosen fallback ratified) — [DB record](phase-1.4-decision-record-production-database.md).
- [ ] **Final auth decision recorded** — updated in, or included alongside, the provider decision (§22 or §23 resolved).
- [ ] **Product-owner input checklist (§5) answered** — no blocking input left Open.
- [ ] **Backup / restore plan documented** (frequency, retention, restore drill, PITR, ownership, monitoring, export path — §7).
- [ ] **RPO / RTO accepted** (I12/I13 ratified — §7).
- [ ] **Region / residency accepted** (I2–I4 — §8).
- [ ] **Budget band accepted** (I5/I6 — §9).
- [ ] **Payment / no-card-data boundary accepted** (I16/I17 — §12 / R5).
- [ ] **Local dev / test approach chosen** (I22 — §11).
- [ ] **Schema migration tooling chosen or explicitly scheduled before schema** (I23 — §12).
- [ ] **Security / secrets approach documented** (§13).
- [ ] **Preview / demo handling documented** (§15).
- [ ] **First implementation slice selected** (the smallest behavior-changing increment — typically the M1 adoption-order step E: server/API + first Postgres adapter).

---

## 25. Backend Implementation Start Conditions

Backend implementation **may not begin** until **all** of the following are true:

1. **Provider / auth gate is satisfied** (§6, §17–§23; minimum evidence §24 complete).
2. **First implementation slice is selected** (single, smallest behavior-changing increment).
3. **Docs identify allowed files and forbidden files** for that slice (explicit scope).
4. **Migration / rollback plan exists** for the slice.
5. **Backup branch / checkpoint is clean** (a known-good rollback point on `main`).
6. **Manual QA plan exists** for the slice (behavior-change is observable and checkable).
7. **Behavior-changing risk is explicitly accepted** by the product owner (the first milestone that *does* change runtime behavior — a deliberate, recorded decision).

Until all seven hold, Phase 1.4 remains docs/architecture-only and no runtime/source behavior changes.

---

## 26. What Must Remain Blocked (until the gate is satisfied)

The following are **blocked** and may **not** be started until the gate (§6/§17–§25) is satisfied and a behavior-changing milestone is explicitly authorized:

- [ ] Provider SDK installation (Supabase/Neon/Railway/Postgres client libs).
- [ ] Schema creation.
- [ ] SQL migrations.
- [ ] ORM setup (Prisma/Drizzle/etc.).
- [ ] Production DB connection.
- [ ] Supabase / Auth migration.
- [ ] Firebase Auth replacement.
- [ ] Server enforcement (middleware, guards, RLS-as-enforcement).
- [ ] Repository runtime implementation.
- [ ] Middleware / guards.
- [ ] RLS policies.
- [ ] Real audit persistence (durable audit writes).
- [ ] Provider secret persistence (durable secret storage).
- [ ] Payment integration.

**Statement:** M5 starts none of these and unblocks none of them. It only defines the conditions under which they become eligible to begin.

---

## 27. Decision Intake Template

> Copy this block into the [DB decision record](phase-1.4-decision-record-production-database.md) (and, where relevant, the [topology record](phase-1.4-decision-record-deployment-topology.md)) when the product owner supplies inputs. Leave any unknown field as `OPEN` — an `OPEN` blocking field keeps the gate closed.

```
PROVIDER / AUTH FINALIZATION INTAKE  (date: ____, decided by: ____)

— Inputs (§5) —
I1  Launch expectation:            ____
I2  Tenant geography:              ____
I3  Primary region preference:     ____
I4  Data residency / legal:        ____ (none / ____)
I5  Budget band (DB/backend/auth): ____
I6  Acceptable monthly range:      ____
I7  Early tenant count:            ____
I8  Early store count:             ____
I9  Staff / user count:            ____
I10 Transaction volume:            ____
I11 Attachment / file volume:      ____
I12 RPO target:                    ____
I13 RTO target:                    ____
I14 Backup retention:              ____
I15 Managed backups required?:     yes / no
I16 Payment processor:             ____ (or OPEN)
I17 No card data stored?:          confirmed / ____
I18 Hostinger hosts API too?:      static-only / static+API
I19 Replit dev-only?:              yes / no
I20 Supabase Auth swap acceptable
    before prod users?:            yes / no
I21 Firebase Auth must remain?:    yes / no
I22 Local dev path:                Supabase CLI / Docker PG / cloud dev / managed branch
I23 Schema tooling:                SQL-first / Supabase / Prisma / Drizzle / OPEN
I24 Compliance/audit retention:    ____

— Gate results —
Provider chosen:                   Supabase / Neon / Railway / Hostinger-VPS
  Go-conditions met?               yes / no   (§17–§20)
  No-go tripped?                   none / ____
Backup/restore plan attached?      yes / no   (§7)
RPO/RTO ratified?                  yes / no
Region/residency accepted?         yes / no
Budget band accepted?              yes / no

Auth chosen:                       Firebase-retained / Supabase-Auth / custom
  Go-conditions met?               yes / no   (§22–§23)
  No-go tripped?                   none / ____
Auth-before-users scheduled?       yes / no / n/a

— Disposition —
Final provider:                    RATIFIED / STILL PROVISIONAL (reason: ____)
Final auth:                        RATIFIED / STILL PROVISIONAL (reason: ____)
First implementation slice:        ____ (or none yet)
```

---

## 28. Future Decision Record Update Instructions

When inputs arrive and the gate is run:

1. **Record the intake (§27)** in the [DB decision record](phase-1.4-decision-record-production-database.md); link the backup/restore plan.
2. **Update the DB record status line** from "Supabase preferred working candidate / final provider provisional" to the ratified provider (or to a chosen fallback) — **only if** the §17–§21 go-criteria are met and no no-go trips.
3. **Update the topology record** if the runtime choice (VPS vs serverless/edge) is decided alongside the provider, and if Hostinger's role (static-only vs static+API) is confirmed (I18).
4. **Record the final auth decision** in, or cross-referenced from, the DB record (§22 or §23 resolution).
5. **Do not escalate any status by assumption** — a ratification requires the recorded inputs + plan, not a guess. If a blocking input is still `OPEN`, keep the status provisional and say so.
6. **Then, and only then,** select the first implementation slice (§24–§25) in a new milestone doc; do not begin implementation inside a decision record.

---

## 29. Risks / Open Questions

- **Premature lock-in.** Treating "preferred default" (Supabase) as "final" would couple design to Supabase specifics and erode the Neon/Railway + Firebase-Auth fallback. *Mitigation:* the M1 boundary; final status held provisional until §24 is complete.
- **Auth-migration drift.** Every real production user added before an auth swap raises migration cost. *Mitigation:* decide P2 (and, if Supabase, schedule the swap) **before** onboarding production users (§23).
- **VPS backup immaturity.** The dominant risk if Hostinger-VPS Postgres is chosen for financial data. *Mitigation:* §20 no-go on `managed-backups-required`; named ownership required.
- **Unanswered blocking inputs.** Region/residency (I2–I4), RPO/RTO (I12–I13), budget band (I5–I6), scale (I7–I11) are all **Open**; the gate stays closed until they exist. *Open — product-owner inputs.*
- **Cost surprises** (egress/compute/edge/storage growth). *Mitigation:* re-price before go-live against the real scale envelope (§9–§10).
- **Open questions (verbatim, still unanswered):** tenant geography? legal residency? budget band? RPO/RTO targets? expected tenant/store/user/transaction/attachment counts? confirmed external payment processor? confirmed Hostinger role (static-only vs static+API) + region? Supabase-Auth-before-users acceptable, or Firebase Auth permanent?

---

## 30. Non-Implementation Statement

M5 **changes no runtime, source, UI, schema, config, or dependency.** It does **not** implement Supabase, Neon, Railway, Hostinger-VPS Postgres, or PostgreSQL; does **not** replace or modify Firebase Auth; creates **no** schema, SQL migration, or ORM file; installs **no** dependency; implements **no** middleware, server guard, repository runtime, or server/API runtime; defines **no** RLS policy and persists **no** audit or secret. It does **not** modify `src/`, `server/`, `firestore.rules`, `firebase.ts`, `AccessContext`, `platformPermissionsConfig`, `accessConfig`, tenant/store permission code, routing, UI, `.replit`, `package.json`, or lockfiles. All code-like and table fragments are documentation artifacts. The milestone is **reversible** (delete this doc + revert the decision-record cross-references and the `replit.md` status line). **Accepted / committed / backed up** at GitHub checkpoint `cdd1c03aae19eebb7a857b62ee2ca4adc5c42c59`.

---

## 31. Validation / QA Summary

- **Docs/architecture only** — no behavioral QA applies; review is the gate.
- **M5 changed only Markdown** under `docs/` (this file + minimal cross-references in the two decision records) and one factual `replit.md` status block. No `.ts`/`.tsx`/`.sql`/schema/runtime/config/`.replit`/`package.json`/lockfile changes; nothing imported or wired.
- **TypeScript / lint:** M5 touches no TypeScript; any pre-existing baseline errors are unchanged and none are introduced by M5 (validation command output recorded in the M5 report).
- **Exit criteria:** finalization gate defined (§6); product-owner input checklist enumerated (§5); per-dimension gates specified (§7–§16); per-provider go/no-go specified (§17–§20); per-auth go/no-go specified (§22–§23); minimum evidence package (§24) + start conditions (§25) + blocked-work list (§26) defined; decision-intake template (§27) + update instructions (§28) provided; final provider/auth kept honestly **PROVISIONAL** (no input invented); Supabase kept as the **preferred working candidate**, not finalized.
</content>
</invoke>

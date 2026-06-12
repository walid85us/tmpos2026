# Phase 1.4 — Product Owner Input Collection & Provider/Auth Gate Evaluation

> **Status:** **Documentation only — Product Owner Input Collection + M5 gate run.** This document records the product owner's answers to the [M5 finalization-gate](phase-1.4-milestone-5-provider-finalization-gate.md) input checklist and runs the gate against them. It **implements nothing**: no Supabase/Neon/Railway/Hostinger-VPS/PostgreSQL, no Firebase Auth replacement, no Supabase Auth, no schema/SQL/migration/ORM, no provider SDK, no middleware/guards/server enforcement, no payment integration, no dependency, no runtime/source/UI change.
>
> **What this document DOES:** with the inputs now answered, it **ratifies the provider and auth *direction*** (escalating Supabase from "preferred working candidate" to the **final working/default production provider direction**, and recording **Supabase Auth as the future production auth direction**) **subject to implementation-time tier/PITR/region selection**. **What it does NOT do:** authorize or begin any backend implementation. Implementation stays blocked until the M5 §24 minimum-evidence package is complete and a behavior-changing milestone is explicitly accepted (M5 §25).
>
> **Reversible** (delete this doc + revert the minimal decision-record cross-references and the `replit.md` status line). **Not committed / not pushed / not backed up; awaiting review.**
>
> **Part of:** Phase 1.4 — Backend & Persistence Readiness (M0–M6 complete/accepted/backed up at `19e32f8`). This is the **Product Owner Input Collection** step named as the recommended next step by [M6 §22](phase-1.4-milestone-6-backend-persistence-readiness-closeout.md). It uses the gate defined in [M5](phase-1.4-milestone-5-provider-finalization-gate.md) and updates the canonical [DB decision record](phase-1.4-decision-record-production-database.md) and [topology decision record](phase-1.4-decision-record-deployment-topology.md).

---

## 1. Purpose and Scope

**Purpose.** Phase 1.4 closed out (M6) with the final provider and final auth held **provisional**, pending product-owner inputs. The product owner has now supplied those inputs. This document (a) records them as the authoritative answers, (b) runs the M5 per-dimension and per-candidate go/no-go gate against them, and (c) records — honestly and evidence-based — which decisions can now be **ratified as a direction** and which must **remain provisional** until implementation kickoff.

**In scope (docs only):** the inputs table; the gate evaluation for Supabase / Neon / Railway / Hostinger-VPS PostgreSQL / Firebase-Auth-retained / Supabase-Auth / Stripe / Square; per-dimension evaluations (backup/RPO-RTO, region/residency, cost, payments/PCI, local dev, schema tooling, security/secrets, preview/demo); a ratification recommendation; the ratifiable-vs-provisional split; the conditions and blocked work that remain before implementation.

**Out of scope (unchanged across Phase 1.4):** any implementation — no provider SDKs, no PostgreSQL, no schema/DDL/`.sql`, no ORM/migrations, no middleware/guards/server enforcement, no Firebase Auth replacement or logic change, no Supabase Auth, no payment integration, no Firestore-rules change, no UI/routing/source change, no dependency install, no `.replit`/`package.json`/lockfile change.

**Honesty rule (binding):** ratifying a *direction* (which managed provider/auth the design and the future first adapter target) is **not** the same as implementing it or as finally locking the exact paid tier, PITR add-on, region, and runtime. Those are selected at implementation kickoff. Where an input leaves a residual unknown (e.g. legal residency "none known — confirm before go-live"), it stays explicitly open.

---

## 2. Source of Inputs

The answers in §3 were supplied directly by the **product owner** (`waleed_d0@hotmail.com`) on **2026-06-12** in response to the M5 §5 input checklist. They are recorded verbatim-in-substance below and treated as authoritative for this gate run. This is the [M5 §27 decision-intake](phase-1.4-milestone-5-provider-finalization-gate.md) realized.

---

## 3. Product Owner Inputs Table

| # | M5 input | Product-owner answer |
|---|---|---|
| I1 | Target launch expectation | **MVP/pilot first;** production only after the backend/provider/auth gate is satisfied. |
| I2 | Tenant geography / countries | **US-first.** |
| I3 | Preferred production region | **US region**, preferably **Central/East US** if available. |
| I4 | Data residency / legal restrictions | **None known yet; must be confirmed before go-live.** |
| I5 | Monthly infrastructure budget band | **Up to ~$200/month** initially, with flexibility if the best reliable setup needs more. |
| I6 | Max acceptable monthly production infra cost | **~$200/month working cap**, exception allowed for strong reliability/security/backup reasons. |
| I7 | Expected early tenant count | **1–5 pilot tenants.** |
| I8 | Expected early store count | **1–3 stores per tenant** initially. |
| I9 | Expected staff / user count | **5–15 users per tenant** initially. |
| I10 | Expected transaction volume | **Low-to-moderate pilot volume**; design for growth (repair/POS/invoice business, not high-scale enterprise). |
| I11 | Expected attachment / file volume | **Moderate** (repair photos, invoices, labels, documents). **Managed storage later; never DB blobs.** |
| I12 | RPO target | **≤ 15 minutes** for POS/invoice/inventory/audit data. |
| I13 | RTO target | **≤ 4 hours** for production restore/downtime. |
| I14 | Backup retention target | **30 days minimum operational** + **long-term financial/audit** retention. |
| I15 | Managed backups required | **Yes.** |
| I16 | Payment processor preference | **Both Stripe and Square** — Stripe for online payments/invoices; Square for physical-store/card-present. |
| I17 | No card data stored in app DB | **Yes (confirmed).** Store only references/status/amount/currency/timestamps/order-invoice links/audit metadata. |
| I18 | Hostinger role | **Static frontend/marketing/demo only;** NOT production database. |
| I19 | Replit role | **Development only.** |
| I20 | Supabase Auth replacement acceptable before real production users | **Yes, if Supabase is selected.** |
| I21 | Firebase Auth must remain long-term | **No.** Firebase Auth for **testing only**. |
| I22 | Preferred local dev/test approach | **Supabase CLI later** if Supabase selected; otherwise cloud dev DB or Docker/local Postgres. **Do not implement now.** |
| I23 | Preferred schema migration/tooling | **SQL-first / Supabase migrations initially** if Supabase selected; **ORM undecided** until schema stabilizes. |
| I24 | Compliance / audit retention expectation | **7 years** for financial/audit/invoice records. |

**Result:** **no M5 §5 input remains Open** except the residual **legal residency confirmation (I4)**, which the owner explicitly defers to a pre-go-live check (it does not block direction ratification because "none known" + US-region is internally consistent).

---

## 4. Gate Impact Summary

| Dimension | Input(s) | Gate effect |
|---|---|---|
| Region/residency | I2, I3, I4 | US region acceptable; residency confirmation deferred to pre-go-live. **Pass (with residual I4).** |
| Backup/RPO/RTO | I12, I13, I14, I15 | Managed backups required + RPO ≤15min + RTO ≤4h + 30-day/7-year retention → **requires a managed provider with PITR.** **Eliminates self-managed VPS;** favors Supabase/Neon. |
| Cost/budget | I5, I6 | ~$200/mo cap (flexible). Pilot scale fits a managed paid tier + PITR. **Pass at pilot scale; re-price before go-live.** |
| Scale envelope | I7–I11 | Small pilot (1–5 tenants); moderate attachments → managed entry/Pro tier + object storage. **Pass.** |
| Payments/PCI | I16, I17 | Stripe + Square; no card data in app DB. **Pass; both retained as deferred options.** |
| Deployment | I18, I19 | Hostinger static/demo only; Replit dev-only → **managed Postgres off-host (not on Hostinger)**; server/API tier elsewhere. **Pass.** |
| Auth | I20, I21 | Firebase not permanent; Supabase Auth acceptable before users → **Supabase Auth is the auth direction if Supabase is the provider.** |
| Local dev / tooling | I22, I23 | Supabase CLI + SQL-first/Supabase migrations (ORM deferred). **Pass (selected, not implemented).** |

**Net:** the inputs jointly point to **a managed PostgreSQL provider with PITR + bundled auth + bundled storage in a US region within a ~$200/mo pilot band** — which is the Supabase profile. The managed-backups-required answer (I15) **eliminates the Hostinger-VPS option** for production financial/POS/audit data.

---

## 5. Provider Gate Evaluation

### 5.1 Supabase — §17

| Go condition | Verdict |
|---|---|
| US region acceptable (§8) | ✅ Supabase offers US regions (incl. US-East); satisfies US-first / Central-East preference (exact region chosen at implementation). |
| Backup/restore meets RPO ≤15min / RTO ≤4h (§7) | ✅ **conditional** — managed backups (I15 ✓); **RPO ≤15min requires PITR**, available on the paid tier/add-on. Ratifiable subject to **selecting a tier with PITR enabled** at implementation. |
| Cost within ~$200/mo (§9) | ✅ at pilot scale (paid tier + PITR add-on + storage well under cap for 1–5 tenants); **re-price before go-live.** |
| Supabase Auth acceptable / Firebase bridging (§22–§23) | ✅ Supabase Auth acceptable before prod users (I20); Firebase for testing only (I21). |
| Storage strategy (§M2) | ✅ Supabase Storage for blobs; DB keeps attachment metadata only (I11). |
| RLS / server-enforcement path (R2) | ✅ RLS + Edge Functions or external API tier. |
| Local/dev story (§11) | ✅ Supabase CLI (I22). |
| **No-go checks** | None trip — region available; backup meets target with PITR; cost within band; auth acceptable; vendor-lock not rejected (mitigated by M1 boundary). |

**Verdict: GO.** Supabase is **ratifiable as the final working/default production provider direction**, subject to selecting the actual **paid tier (with PITR), region, and add-ons at implementation time**.

### 5.2 Neon — §18

| Check | Verdict |
|---|---|
| Managed Postgres, auth independent | Neon = pure managed Postgres; **no bundled auth or storage.** |
| Firebase token-verification mapping acceptable | Tension: owner does **not** want Firebase long-term (I21=No); Neon would need a separately-chosen auth (Firebase-bridged or other) + external object storage + own API tier → **more assembly.** |
| Backup / region / cost | ✅ managed backups + PITR/branching, US regions, fits cost. No hard no-go. |

**Verdict: ACCEPTABLE FALLBACK** (low lock-in, portable Postgres) — **less preferred than Supabase** because it bundles neither auth nor storage, which adds work given the owner's auth/storage answers.

### 5.3 Railway — §19

| Check | Verdict |
|---|---|
| Combined app/API + Postgres | ✅ convenient single platform. |
| Backup/PITR maturity | ⚠️ **verify** automated backup/PITR posture before relying on it for financial data (RPO ≤15min). |
| Region/residency | ⚠️ fewer regions than the largest providers; confirm US fit. |
| Auth | No bundled auth (same tension as Neon). |

**Verdict: ACCEPTABLE FALLBACK** — viable, but backup-maturity + region must be verified, and auth/storage are unbundled. Not preferred.

### 5.4 Hostinger VPS PostgreSQL — §20

| No-go check | Verdict |
|---|---|
| **Managed backup/restore required (I15 = Yes)** | ❌ **Immediate NO-GO** per §20. |
| Financial/POS data reliability risk | ❌ default not-preferred posture confirmed. |

**Verdict: NO-GO / NOT PREFERRED** for production financial/POS/audit data. The owner's "managed backups required" answer directly trips the §20 no-go. Remains documented only as a non-preferred option.

### 5.5 Provider ranking after the gate

1. **Supabase — RATIFIED final working/default production provider direction** (tier/PITR/region at implementation).
2. **Neon — acceptable fallback** (provider-neutral; unbundled auth/storage).
3. **Railway — acceptable fallback** (combined hosting; verify backup maturity + region).
4. **Hostinger-VPS PostgreSQL — not preferred** for production financial/POS/audit data (managed-backups no-go).
5. *(Baseline)* **Firestore-only production — not recommended** (R3, unchanged); Firebase remains for testing.

---

## 6. Auth Gate Evaluation

### 6.1 Firebase Auth retained long-term — §22

NO-GO triggers present: the owner does **not** want Firebase permanently (I21=No) and Supabase-native auth is acceptable/preferred with the Supabase provider choice. **→ Not the selected long-term direction.** Firebase Auth **remains for testing only**, untouched, until a Supabase Auth migration is explicitly authorized.

### 6.2 Supabase Auth replacement before production users — §23

| Go condition | Verdict |
|---|---|
| Supabase is the final provider | ✅ (ratified direction, §5.1). |
| Migration before production users acceptable | ✅ I20 (cheapest window; pilot-first, I1). |
| User mapping to `internal_user_id` preserved | ✅ Supabase UID → `auth_provider_uid`; `internal_user_id` stays primary (M1/M2). |
| Email/password/Google login parity planned | ✅ current surface is Google popup + email/password only; both supported. |
| Preview/demo separate | ✅ (§14 / M3). |
| No-go checks | None — Firebase not permanent; migration acceptable; Supabase is final. |

**Verdict: GO.** **Supabase Auth is ratifiable as the future production auth direction**, to be migrated **before real production users**, while **Firebase Auth remains for testing** until the migration milestone is explicitly authorized.

### 6.3 Custom / self-managed auth — §23a

**NOT RECOMMENDED** (unchanged). No enterprise requirement forces it.

---

## 7. Backup / RPO / RTO Evaluation

| Requirement | Owner answer | Disposition |
|---|---|---|
| Managed backups | **Required (I15)** | Drives provider choice; eliminates VPS; satisfied by Supabase managed backups. |
| RPO | **≤ 15 min (I12)** | Requires **PITR** on the chosen Supabase tier — a hard implementation-time requirement. |
| RTO | **≤ 4 h (I13)** | Achievable with managed restore + PITR; **restore drill must be proven** at kickoff. |
| Operational retention | **≥ 30 days (I14)** | Tier/retention config at implementation. |
| Financial/audit retention | **7 years (I24)** | Long-term/cold retention + export path; design now, configure at implementation. |

**Accepted as targets.** The **detailed backup/restore *plan*** (frequency, PITR config, restore-drill procedure, named ownership, monitoring/alerting, 7-year export path) is **substantially specified by these targets** but its final operational write-up is to be completed at implementation kickoff with the selected tier (this is one of the M5 §24 evidence items still to finalize — see §18).

---

## 8. Region / Residency Evaluation

- **US-first (I2)** + **US Central/East preference (I3)** → a US Supabase region (exact region chosen at implementation). ✅
- **Legal residency: none known, confirm before go-live (I4)** → consistent with US region; **residual confirmation deferred** to a pre-go-live legal check. Does not block direction ratification.
- **Correctness/durability outrank latency** (M5 §8) — reaffirmed.

## 9. Cost / Budget Evaluation

- **~$200/mo cap, flexible (I5/I6).** A Supabase paid tier + PITR add-on + Storage for 1–5 pilot tenants fits within this band. ✅
- **No free/dev tier in production** (M5 §9) — reaffirmed; pilot still uses a paid managed tier for real records.
- **Re-price before go-live** against the then-known scale envelope (no exact prices asserted here).
- Flexibility clause (I5/I6) covers the PITR/backup add-on cost that reliability requires.

## 10. Payments / PCI Evaluation

- **Stripe (I16):** online payments/invoices. **Acceptable option.**
- **Square (I16):** physical-store/card-present. **Acceptable option.**
- **No card data in the app DB (I17):** confirmed (R5/R7/R8). App stores only references/status/amount/currency/timestamps/order-invoice links/audit metadata + `external_provider`/`external_reference`/`idempotency_key` (M2).
- **Both processors remain retained options; payment integration is future/deferred.** PCI scope minimized by keeping card data out of the app DB; final PCI scope confirmed with the chosen processor(s) at integration time.

## 11. Local Dev / Test Evaluation

- **Chosen (I22): Supabase CLI** local stack (Postgres + Auth + Storage) once Supabase implementation is authorized; cloud dev DB / Docker Postgres remain alternatives.
- **Not implemented now** — no local DB/container/CLI installed in this step. Current Firebase/Replit testing continues unchanged.

## 12. Schema Tooling Evaluation

- **Chosen (I23): SQL-first / Supabase migrations initially.** **ORM (Prisma/Drizzle) deferred** until the schema stabilizes.
- **No schema/SQL/migration/ORM file created** in this step (sequencing rule M5 §12).

## 13. Security / Secrets Evaluation

- Production secrets (DB credentials, Supabase keys, Stripe/Square keys, webhook secrets) must live in a **secure env/secret manager** — never in memory/browser/session/localStorage (reaffirms M0/topology truth that the current shipping sidecar's in-memory keys are dev-only).
- **Rotation plan** required for all provider/DB/payment/webhook secrets; **audit logs redact secrets** (`server/safe-log.ts`/`sanitizeError` posture).
- **Concrete secret-manager choice is an implementation-time item** (documented as a requirement here; not configured).

## 14. Preview / Demo Impact

- Preview/demo users must **not** be production-authenticated; preview/demo writes are **not** compliance evidence; preview/demo routes to mock/isolated sandbox data (M3/M5 §14).
- The Hostinger **demo** role (I18) reinforces this: demo/marketing stays separate from production records. Implementation must preserve the separation (M1 boundary + M3 request context).

---

## 15. Ratification Recommendation

Based on the inputs and the gate run, **ratify the following as directions** (not implementations):

1. **Production database provider direction = Supabase** (managed PostgreSQL, US region), escalated from "preferred working candidate" to **final working/default production provider direction** — **subject to selecting the paid tier (with PITR), exact US region, and add-ons at implementation kickoff.**
2. **Future production auth = Supabase Auth**, to be migrated **before real production users**; **Firebase Auth remains for testing** until that migration milestone is explicitly authorized.
3. **Neon and Railway remain acceptable fallback options** (provider-neutral; unbundled auth/storage; Railway backup maturity to verify).
4. **Hostinger-VPS PostgreSQL is not preferred** for production financial/POS/audit data (managed backups required → §20 no-go).
5. **Hostinger = static frontend/marketing/demo only; Replit = dev-only.**
6. **Stripe and Square both remain payment options; no card data in the app DB; payment integration deferred.**
7. **Backup posture:** managed backups + PITR (RPO ≤15min, RTO ≤4h) + 30-day operational / 7-year financial-audit retention — **accepted as targets.**
8. **Local dev = Supabase CLI; schema tooling = SQL-first/Supabase migrations; ORM deferred** — all selected, none implemented.

**Do not overclaim:** nothing above is implemented; the exact tier/PITR/region/runtime, the detailed backup/restore plan, the residency confirmation, the concrete secret manager, and the first implementation slice are **still pending** (§17–§18).

---

## 16. Decisions That Can Now Be Ratified

- ✅ **Supabase = final working/default production provider direction** (managed PostgreSQL, US region; tier/PITR/region at implementation).
- ✅ **Supabase Auth = future production auth direction** (migrate before production users; Firebase Auth for testing meanwhile).
- ✅ **Hostinger-VPS PostgreSQL = not preferred** for production financial/POS/audit data.
- ✅ **Hostinger = static frontend/marketing/demo only; Replit = dev-only.**
- ✅ **Managed backups + PITR; RPO ≤15min; RTO ≤4h; 30-day operational + 7-year financial/audit retention** = accepted targets.
- ✅ **Stripe + Square = retained payment options; no card data in app DB** (payment integration deferred).
- ✅ **Local dev = Supabase CLI; schema tooling = SQL-first/Supabase migrations** (ORM deferred) — selected, not implemented.
- ✅ **Neon / Railway = documented acceptable fallbacks.**

## 17. Decisions That Should Remain Provisional

- ⏳ **Exact Supabase paid tier + PITR add-on + specific US region** (Central vs East) — selected at implementation kickoff.
- ⏳ **Exact monthly cost** — re-price before go-live against the real scale envelope.
- ⏳ **Legal/data-residency confirmation (I4)** — "none known"; confirm before go-live.
- ⏳ **Specific server/API runtime** (Supabase Edge Functions vs an external API/serverless tier) — narrowed by the Supabase choice but **still provisional** (topology record).
- ⏳ **ORM choice** — deferred until the schema stabilizes.
- ⏳ **Per-workflow payment split** (Stripe online vs Square card-present) and actual payment integration — future/deferred.
- ⏳ **Detailed backup/restore operational plan** (restore-drill procedure, named ownership, monitoring, 7-year export path) — to finalize at kickoff with the selected tier.
- ⏳ **Concrete secret-manager choice** — implementation-time.
- ⏳ **First implementation slice** — not yet selected.

## 18. Conditions Before Implementation

Per M5 §24–§25, before any backend implementation milestone may begin, **all** of the following must be complete and recorded:

| M5 §24 evidence item | Status after this collection |
|---|---|
| Final provider decision recorded | ✅ Supabase (direction) — DB record updated by this doc |
| Final auth decision recorded | ✅ Supabase Auth (direction); Firebase for testing |
| Product-owner input checklist answered | ✅ all answered (I4 residual deferred) |
| Backup/restore plan documented | ⏳ targets accepted; **detailed operational plan to finalize at kickoff** |
| RPO/RTO accepted | ✅ ≤15min / ≤4h |
| Region/residency accepted | ✅ US region; ⏳ legal residency confirm before go-live |
| Budget band accepted | ✅ ~$200/mo (flexible) |
| Payment/no-card-data boundary accepted | ✅ Stripe+Square; no card data |
| Local dev/test approach chosen | ✅ Supabase CLI |
| Schema tooling chosen/scheduled | ✅ SQL-first/Supabase migrations; ORM deferred |
| Security/secrets approach documented | ⏳ requirement documented; **concrete secret manager pending** |
| Preview/demo handling documented | ✅ separation rule (§14) |
| **First implementation slice selected** | ❌ **NOT YET** — this is the next step |
| Allowed/forbidden file scope documented | ❌ pending (with the slice) |
| Rollback/migration plan documented | ❌ pending (with the slice) |
| Manual QA plan documented | ❌ pending (with the slice) |
| Behavior-changing risk explicitly accepted | ❌ pending (explicit authorization) |

**Conclusion:** the provider/auth **direction is ratified**, but the **implementation-start evidence package is not yet complete** (no first slice, no detailed backup plan, no concrete secret manager, residency unconfirmed, no explicit behavior-changing authorization). **Therefore no backend implementation starts now.**

## 19. Blocked Work Still Blocked

Until the §18 conditions are complete and a behavior-changing milestone is explicitly authorized, the following remain **BLOCKED** (unchanged from M5 §26 / M6 §13):

- [ ] Provider SDK installation (Supabase/Postgres client libs)
- [ ] Schema creation · SQL migrations · ORM setup
- [ ] Production DB connection
- [ ] Supabase Auth migration · Firebase Auth replacement
- [ ] Server enforcement · middleware/guards · RLS policies
- [ ] Repository runtime implementation · server/API runtime
- [ ] Real audit persistence · provider secret persistence
- [ ] Payment integration (Stripe/Square)
- [ ] **Any behavior-changing backend/provider/auth implementation**

Ratifying the *direction* does **not** unblock any of these.

## 20. Recommended Next Step

**Select the first implementation slice and assemble the remaining §18 evidence** — as a new, separately-accepted, behavior-changing milestone (out of Phase 1.4). Concretely:

1. Finalize the **detailed backup/restore plan** + **concrete secret-manager choice**; trigger the **pre-go-live residency confirmation**.
2. **Select the first implementation slice** (per M1 adoption-order step E: a thin server/API + first Supabase Postgres adapter for one durable domain), with allowed/forbidden file scope, rollback/migration plan, and manual QA plan.
3. **Explicitly accept the behavior-changing risk** (the first milestone that changes runtime behavior).
4. Only then begin implementation. **If Supabase Auth is in the first slice, schedule it before any real production users** (the cheapest window).

## 21. Non-Implementation Statement

This document **changes no runtime, source, UI, schema, config, or dependency.** It does **not** implement Supabase, Neon, Railway, Hostinger-VPS Postgres, or PostgreSQL; does **not** replace or modify Firebase Auth; does **not** implement Supabase Auth; creates **no** schema, SQL migration, ORM, or RLS policy; installs **no** provider SDK or dependency; implements **no** middleware, server guard, repository runtime, server/API runtime, or payment integration; persists **no** audit or secret. It does **not** modify `src/`, `server/`, `firestore.rules`, `firebase.ts`, `AccessContext`, `platformPermissionsConfig`, `accessConfig`, tenant/store permission code, routing, UI, `.replit`, `package.json`, or lockfiles. All tables and checklists are documentation artifacts. **Ratification here is of a *direction*, not an implementation.** The document is **reversible** (delete it + revert the decision-record cross-references and the `replit.md` status line). **Not committed / not pushed / not backed up; awaiting review.**

## 22. Validation / QA Summary

- **Docs/architecture only** — no behavioral QA applies; review is the gate.
- **This step changed only Markdown** under `docs/` (this file + minimal decision-record/index cross-references) and one factual `replit.md` status block. No `.ts`/`.tsx`/`.sql`/schema/runtime/config/`.replit`/`package.json`/lockfile changes; nothing imported or wired.
- **TypeScript/lint:** this step touches no TypeScript; any pre-existing baseline errors are unchanged and none are introduced (validation command output recorded in the report).
- **Exit criteria:** inputs recorded (§3); gate run honestly per candidate (§5–§6) and per payment processor (§10); ratifiable-vs-provisional split explicit (§16–§17); conditions + blocked work before implementation stated (§18–§19); recommended next step = select first implementation slice (§20); provider/auth ratified **as a direction only**, no implementation started, Supabase not overclaimed as implemented.
</content>

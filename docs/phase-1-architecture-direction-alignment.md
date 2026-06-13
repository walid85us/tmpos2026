# Phase 1 — Consolidated Architecture Direction Alignment

> **Status:** **FORWARD-ONLY ALIGNMENT — DOCS ONLY.** This document reconciles the entire Phase 1 roadmap (from the true beginning through Phase 1.5 M2) with the ratified architecture direction. **It reopens no completed milestone, changes no code, changes no schema/RLS, and changes no runtime behavior.** It exists to prevent future confusion about Firebase, Supabase, Hostinger, Replit, deployment portability, and the next (M3) direction.
>
> **Authority:** consolidates the prior *Cross-Phase Architecture Consistency Audit (Supabase Auth + Deployment Portability)* and its *Supplemental Early Phase 1* audit. Built on the accepted checkpoint `ac4a06fb12497faae8ea6bbe4b35bebe5c586f70`. **Not committed / not pushed / not backed up; pending review.**

---

## 1. Executive Summary

- This is a **forward-only alignment document.** It records the agreed direction and the corrected full-Phase-1 history so future sessions do not re-derive or contradict it.
- It **does not reopen** any completed milestone.
- It **does not change code**, schema, RLS, secrets, packages, or runtime behavior. The only changes in this docs-only pass are this new file and one concise `replit.md` line.
- It **aligns all Phase 1 work** — including the early UI/client/advisory phases — with the ratified Supabase Auth + Supabase Postgres direction, with Firebase as testing-only, Replit dev-only, and Hostinger as a possible future deployment layer (not the production database).
- **Net finding:** no completed milestone requires code revision; the early phases predate backend decisions and do not conflict; the next milestone is **Phase 1.5 M3-Revised — Supabase Auth Verified Actor Diagnostic**, which supersedes the (chat-only, never-implemented) Firebase-token-verifier M3 plan.

---

## 2. Corrected Full Phase 1 Milestone Map (true beginning → 1.5 M2)

| Milestone | Nature | Current state | Architecture implication |
|---|---|---|---|
| **Foundational app build** (unnumbered early Phase 1) — POS, store-side RBAC UI, tenant management/provisioning, onboarding/activation lifecycle, customers/invoices/inventory/warranties, hierarchical permissions | UI/client runtime; Firebase Auth login + Firestore `users/{uid}` read; all other state mock/in-browser | Accepted (built) | Predates any backend direction; Firebase used only as current/testing login. No durable DB, no server enforcement, no production-host claim. |
| **Phase 1.1 — Platform Operations Foundation** (IAM/RBAC role stack, 4-level effective access, Global Permissions Matrix as source of truth, Command Center, Support Tools gating) | UI/client; advisory | Accepted | Client-side permission resolution; nothing enforced server-side. Consistent with target. |
| **Phase 1.1.1 — UX Polish** (add-on create/edit modal) | UI | Accepted | Cosmetic; no architecture impact. |
| **Phase 1.1.2 — Competitive Maturity** (benchmark notes, role-stack) | docs/UI | Accepted | No architecture impact. |
| **Phase 1.1.3A — Operating Model + Permission-Aware Escalation** (permission dependency model) | UI/client; advisory | Accepted | Explicitly states server-side RBAC/PIM/PAM deferred to Phase 1.3. Consistent. |
| **Phase 1.1.3B — Advanced Command Center Intelligence** | UI/client | Accepted | Deterministic client intelligence; advisory. |
| **Phase 1.1.3C — Support Queue / SLA / Macro Maturity** (+corrections) | UI/client | Accepted | Advisory; no backend dependency. |
| **Phase 1.1.3D — Audit Investigation Center** | UI/client; advisory audit | Accepted | Audit rows advisory/in-browser; not durable evidence. |
| **Phase 1.2 — Domains + Platform Settings Maturity** (domain lifecycle model + shared `tenant_domains_v1`; settings registry `platform_settings_v1`; nothing enforced at runtime) | UI/client + localStorage | Finalized/accepted | Advisory; deeper backend config/SSO/SCIM/server-policy deferred. See §9. |
| **Phase 1.2E — Domains Control Center UX Maturity** | UI direction | **REJECTED — superseded by 1.2F** | Not pursued. M0 domain object model retained underneath. |
| **Phase 1.2F — Strategic Replacement: "Domains" → Tenant Web Address** (`{tenantSlug}.repairplatform.com`; `WEB_ADDRESS_LIVE_HOSTING=false`) | UI + pure helper (`src/owner/tenantWebAddress.ts`) | Accepted | No real DNS/SSL/registrar/hosting. Forward input for Supabase Auth redirect/CORS — see §8. |
| **Phase 1.3 — Platform Team Governance** (M0–M5; server-side RBAC/PIM/PAM framing) | UI/client-gated; advisory | Accepted/backed up | Enforcement still client/advisory; server-side enforcement deferred. |
| **Phase 1.4 — Backend & Persistence Readiness** (M0–M6) | docs/architecture only | Accepted/backed up | Established PostgreSQL direction + server/API-tier requirement; provider-agnostic contracts. |
| **Phase 1.4 — Product Owner Input Collection (POIC)** | docs (gate run) | Accepted/backed up | Ratified the directions in §3 and §11 (Supabase GO; Firebase Auth not permanent; Hostinger-VPS DB NO-GO; Replit dev-only). |
| **Phase 1.5 M0 — Implementation Kickoff Evidence Pack** | docs | Accepted/backed up | Pre-implementation evidence. |
| **Phase 1.5 M1 — Thin Server/API + `platform_identity`** | runtime (flag-gated, dev) | Accepted/backed up | First durable domain; provider-agnostic identity mapping. Valid — see §5/§6. |
| **Phase 1.5 M1.1 — Dev-session / not-provisioned correction** | runtime | Accepted/backed up | No architecture impact. |
| **Phase 1.5 M2 — Request-Context + Protected Diagnostic Enforcement Spine** | runtime (dev-only, flag-gated) | Accepted/backed up (`ac4a06f`) | Vendor-neutral enforcement spine; dev-asserted actor; Firebase verifier stubbed. Valid — see §6. |
| **Prior M3 — Firebase-token verifier plan** | chat-only planning artifact | **SUPERSEDED — never written to docs or code** | Replaced by M3-Revised (Supabase Auth verified actor). See §4. |

---

## 3. Ratified Target Architecture Direction

- **Supabase** = production **Auth** + **Postgres** + future **RLS** + durable **identity** + future durable **audit**.
- **Firebase Auth** = **current/testing-only**, to be **retired** after a safely planned/implemented Supabase Auth migration.
- **Replit** = **development environment only** (never production hosting).
- **Hostinger** = a **possible future hosting/deployment layer** for the **frontend/static SPA and/or a Node API tier only**.
- **Hostinger is NOT the production POS/audit/financial database source of truth** unless a later **formal architecture review** explicitly changes that.
- **Stripe / Square** = retained **future/deferred** payment processors; integration deferred.
- **No card data is stored in the app database** (external processors only).

---

## 4. Firebase Supersession

- The prior **Firebase-token-verifier M3 plan is SUPERSEDED.**
- It was **chat-only** and was **never implemented** in code or written to `docs/` (nothing to revert or delete).
- **Do not implement Firebase ID-token verification** (Admin SDK or JWKS) unless a **later, explicit, reviewed bridge milestone** specifically requires it as a temporary measure.
- **M3-Revised** should proceed toward **Supabase Auth verified-actor diagnostics** (see §17).
- The existing M2 `StubFirebaseAuthAdapter` remains only as a historical "unimplemented verifier" seam marker; it verifies nothing and must never silently allow.

---

## 5. Supabase Auth Direction

- **Supabase Auth is the future production auth direction.**
- Verified Supabase actors use the existing provider-agnostic mapping:
  - `auth_provider = 'supabase'`
  - `auth_provider_uid = <Supabase Auth user id>`
  - `internal_user_id = <app-owned durable actor id>` (stable; decoupled from any vendor)
- **`platform_identity` is already provider-agnostic and needs NO schema revision now.** Its `auth_provider` / `auth_provider_uid` columns + unique key cleanly support both `firebase` (current/testing/legacy mappings) and `supabase` (future) without change.

---

## 6. Supabase Postgres / Durable Data Direction

- **Supabase Postgres is the durable production database direction.**
- **M1 `platform_identity` is valid and provider-agnostic** (the first durable domain).
- **M2 request-context / protected-action / permission-decision / advisory-audit spine is vendor-neutral and remains valid** — a future `VerifiedSupabaseAuthAdapter` plugs into the same `AuthAdapter` seam.
- **No real tenant business data persistence** (POS/invoice/inventory/repairs/shipping) should be implemented until **verified auth, durable roles/scope, durable audit strategy, and an RLS strategy** are ready (see §16).

---

## 7. Early Phase 1 Alignment

- The **foundational build, Phase 1.1.x, Phase 1.2, and Phase 1.2F** were **UI/client/advisory** work.
- They **predate** backend/provider/auth decisions and used Firebase only as the current/testing login plus in-browser state.
- They **do not conflict** with the Supabase Auth / Supabase Postgres direction.
- **No early milestone needs code revision or reopening.** They are recorded here for a complete, consistent history.

---

## 8. Tenant Web Address Forward Input (Phase 1.2F)

- 1.2F uses the platform-managed address pattern **`{tenantSlug}.repairplatform.com`** via the pure helper `src/owner/tenantWebAddress.ts`.
- **`WEB_ADDRESS_LIVE_HOSTING = false`** — live hosting remains **deferred** (Copy allowed; Open disabled/Future); **no real DNS/SSL/registrar/hosting** today.
- When live hosting / custom domains are eventually implemented, that work **must plan**:
  - **Supabase Auth redirect URLs**;
  - **OAuth callback URLs** (e.g. Google);
  - **CORS allow-listing** (no wildcard with credentials);
  - **`APP_PUBLIC_URL`** and **`API_BASE_URL`**;
  - **custom tenant domains** in addition to the `repairplatform.com` base + per-tenant subdomains.

---

## 9. Platform Settings Forward Input (Phase 1.2)

- Platform Settings are currently a **governance registry persisted to `platform_settings_v1` in localStorage** and are **advisory** — the `enforced` enforcement value exists in the type but is assigned to nothing ("nothing enforced at runtime").
- A future backend config service (Supabase-backed) must make these settings **durable and portable** (server-authoritative).
- **Do not treat the current localStorage settings as production enforcement** or compliance evidence.

---

## 10. GitHub Backup Helper Forward Input

- `scripts/github-safe-backup.sh` is **`main`-only, fast-forward-only, and never force-pushes** (refuses on a dirty tree or a diverged remote).
- **Preserve this branch-protection-friendly workflow** for any future CI/deploy pipeline (deploy from `main`/tags; never force push).
- The backup helper is **dev/tooling only** and **does not imply production hosting**.

---

## 11. POIC-Resolved Fallbacks

- Earlier **Phase 1.4 M4/M5** documents evaluated a **Firebase-Auth-retained** path and a **Hostinger-VPS database** path as candidates/criteria at the time.
- After the **Product Owner Input Collection (POIC)** these are **non-selected fallback / rationale** paths only:
  - **Selected:** Supabase Auth (future production auth) + Supabase Postgres (durable production DB).
  - **Not selected:** Firebase Auth long-term (it is testing-only/to-be-retired); **Hostinger-VPS database for production POS/audit/financial data** (NO-GO — managed backups required).
- The M4/M5 documents remain valid as **decision history**; this section is the authoritative resolution.

---

## 12. Deployment Portability / Hostinger Readiness

**Assumptions to avoid in all future milestones:**
- **Replit-specific assumptions:** no reliance on Replit-injected ports/domains/secret-injection; the app must boot from explicit env vars on any host. Today's dev conveniences (default identity port; `npm run dev` co-launching the shipping sidecar) must be parameterized before any non-Replit deploy.
- **localhost assumptions:** no hardcoded `localhost`/`127.0.0.1` base URLs in app/server runtime; the SPA must call the API via a configured `API_BASE_URL`. *(The only current `127.0.0.1` is inside the M2 dev-only QA smoke script — a test harness, not runtime.)*
- **Browser-visible secrets — forbidden:** only the Firebase web config and the Supabase **anon** URL/key may reach the browser. **`SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DATABASE_URL`, and any Supabase JWT secret must never enter `src/` / the client bundle.**
- **Server-only secrets:** all privileged credentials are read server-side only (M1's isolation discipline preserved).

**Hosting responsibility split (to preserve):**
- **Supabase:** Auth, Postgres, future RLS, durable identity, future durable audit (managed, off-host).
- **Hostinger:** possible **static SPA** and/or **Node API** hosting layer (subject to a later deployment architecture review).
- **Replit:** development only.
- **External processors:** Stripe / Square; **no card data in the app DB**.

---

## 13. Environment Variable Standardization

| Variable | Purpose | Exposure |
|---|---|---|
| `SUPABASE_URL` | Project URL (also JWKS base for Supabase Auth verification) | server; the anon URL is client-safe |
| `SUPABASE_ANON_KEY` | Client SDK key | **client-safe** |
| `SUPABASE_SERVICE_ROLE_KEY` | Privileged server operations | **server-only — never client** |
| `SUPABASE_DATABASE_URL` (or pooler URL) | Direct Postgres connection | **server-only** |
| `SUPABASE_JWT_SECRET` | Only if legacy HS256 verification is later **absolutely** needed | **server-only — prefer JWKS so this is NOT needed** |
| `APP_PUBLIC_URL` | SPA public origin (redirects/links) | non-secret |
| `API_BASE_URL` | SPA → API base | non-secret |
| `CORS_ALLOWED_ORIGINS` | API CORS allow-list | non-secret (server) |
| `NODE_ENV` | prod/dev guard | non-secret |
| `ENABLE_SUPABASE_PLATFORM_IDENTITY` | Platform-identity feature flag (default OFF) | non-secret |
| `PLATFORM_IDENTITY_DEV_DIAGNOSTICS` | Dev-asserted diagnostics flag (default OFF) | non-secret |
| `PLATFORM_IDENTITY_VERIFIED_DIAGNOSTICS` (future) | Verified-actor diagnostics flag (default OFF) | non-secret |
| future auth/deployment flags | gated, default OFF | non-secret |

**Rule:** prefer **asymmetric JWKS** verification (`<SUPABASE_URL>/auth/v1/.well-known/jwks.json`) so `SUPABASE_JWT_SECRET` is not required.

---

## 14. Domain / Redirect / CORS Planning

Future auth/deploy work must account for:
- **Replit dev preview origins** (development only).
- **Future Hostinger production domain(s).**
- **`repairplatform.com` base domain.**
- **Tenant subdomains** (`{tenantSlug}.repairplatform.com`).
- **Custom tenant domains** (future custom-domain work).
- **Supabase Auth redirect allow-list** covering all of the above as applicable.
- **OAuth callback URLs** for each provider/domain.
- **No wildcard CORS with credentials.**

---

## 15. Non-UI QA Ownership Rule

- **Claude / Replit run ALL backend / API / flag / command QA** and report **PASS/FAIL with evidence** (ports, requests, responses, logs, flag matrices, type-checks).
- **The owner is asked ONLY for UI / manual visual QA:**
  - login screens / visible login flow;
  - visible buttons;
  - navigation;
  - module behavior;
  - visual confirmation.

---

## 16. Future Gate Before Real Business APIs

**No real POS / invoice / inventory / repairs / shipping protected APIs** may be implemented until **all** of the following exist:
1. a **Supabase Auth verified actor** (server-verified identity);
2. **durable roles / memberships**;
3. **durable tenant / store scope**;
4. a **durable audit strategy** (append-only, server-written);
5. a **planned RLS strategy**;
6. defined **rollback and QA gates**.

Until then, enforcement stays diagnostic/advisory and default-OFF.

---

## 17. Next Recommended Milestone

- **Next milestone:** **Phase 1.5 M3-Revised — Supabase Auth Verified Actor Diagnostic (Planning → reviewed Implementation).**
- It **supersedes** the Firebase-token M3 direction.
- It should remain **diagnostic-only at first**: verify a Supabase access token (prefer JWKS), derive the actor, resolve `internal_user_id` via M1 (`auth_provider='supabase'`, read-or-create), expose a dev-only, default-OFF verified-actor diagnostic endpoint; keep the M2 dev-asserted path intact; **no durable roles, no business APIs, no RLS, no frontend change, no Supabase Auth enablement in the app** in that first slice.

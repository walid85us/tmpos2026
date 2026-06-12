# Decision Record — Deployment Topology

> **Status:** **RATIFIED — WORKING DIRECTION.** Accepted: real enforcement for this project will require a future **server/API tier (managed API layer, serverless/edge functions, or VPS) or equivalent backend enforcement layer**. The **specific runtime** (VPS vs serverless/edge) remains **PROVISIONAL** pending the criteria below. **This record changes no deployment files, no `.replit`, no build config, and no code.**
>
> **Ratified:** 2026-06-12 (Phase 1.4 Decision Ratification Review). **Supersedes** the earlier "RECOMMENDED / PROVISIONAL" status for the requirement-of-a-server-tier conclusion; the specific runtime stays provisional.
>
> **Part of:** Phase 1.4 — Backend & Persistence Readiness, Milestone 0 (record) / Milestone 1 (this ratification + criteria + wording correction) / **Milestone 4 (provider/auth decision-criteria resolution — see [`phase-1.4-milestone-4-provider-auth-decision-criteria.md`](phase-1.4-milestone-4-provider-auth-decision-criteria.md))**. See also [`phase-1.4-milestone-0-backend-persistence-readiness.md`](phase-1.4-milestone-0-backend-persistence-readiness.md) and [`phase-1.4-milestone-1-auth-repository-boundary-plan.md`](phase-1.4-milestone-1-auth-repository-boundary-plan.md).
>
> **M4 note (2026-06-12, accepted/backed up):** M4 evaluates the database-provider and auth-provider criteria (several shared with this record's criteria table). The **server/API-tier requirement stays ratified and the specific runtime stays provisional** — M4 does not change topology status; it only sharpens the provider/auth direction the runtime will eventually connect to.
>
> **M5 note (2026-06-12, pending review):** [M5 — Provider Finalization Gate](phase-1.4-milestone-5-provider-finalization-gate.md) defines the gate that must be satisfied before backend implementation begins. **The specific runtime (VPS vs serverless/edge) and Hostinger's role (static-only vs static+API, input I18) remain PROVISIONAL until the M5 gate is satisfied.** M5 does not change the ratified server/API-tier requirement; it records that no runtime/topology implementation may begin before the gate inputs are answered (M5 §24–§26). When the runtime is decided alongside the provider, update this record per M5 §28.

---

## Current topology (verified)

- **Production artifact:** a **static SPA**. `.replit` declares `deploymentTarget = "static"`, `publicDir = "dist"`, build `npm run build`. **There is no server runtime in the deployed artifact.**
- **Dev runtime:** `npm run dev` runs `tsx server/index.ts & vite`. The Express server (`server/index.ts`) is a **dev-only shipping sidecar** on port 5001, proxied via `/api/shipping`. Every route is `/api/shipping/*`. It has **no user/tenant/auth context** and **no Firebase**.
- **Backend trust boundary today:** only **Firebase Auth + the `users/{uid}` read** (client-side). Shipping webhooks use HMAC verification; provider API keys live in server memory.

**Implication (corrected/nuanced):** A *custom* server-side enforcement tier (your own middleware, route guards, Postgres RLS behind an API) **cannot run** in the current static-only production topology — there is no server to wire it into. **Nuance:** a static SPA is *not* incapable of all backend enforcement — **Firebase Firestore security rules** can enforce some access models directly from a static SPA without your own server. That path is **rejected for this project** because (a) this project's permission model (7-level hierarchy + dependency auto-sync + plan-envelope checks) is not practically expressible in Firestore rules, (b) it would require moving all data access into client-side Firestore queries (the coupling M0 warns against), and (c) it contradicts the ratified PostgreSQL/API direction. So: the chosen direction requires a server/API tier; "static hosting can enforce nothing" is *not* the claim.

## Decision

When (and only when) behavior-changing server-side enforcement is approved for implementation, **introduce a dedicated server/API runtime tier** (managed API layer, serverless/edge functions, or VPS). The static SPA can remain static; **for this project's chosen PostgreSQL/API direction, the enforcement tier requires a server runtime** (it is not achievable via Firestore-rules-from-static-SPA — see the nuance above). The specific runtime (VPS vs serverless/edge) is provisional. Until then, the topology stays as-is and Phase 1.4 remains docs/architecture/pure-helper only.

## Options for the future server tier

| Option | Fit | Notes |
|---|---|---|
| **VPS (e.g., Hostinger VPS) running the API/enforcement tier** | Strong if self-hosting | You own the runtime; SPA can be served static/shared; DB ideally managed (see DB decision record). |
| **Serverless / edge functions (e.g., Supabase Edge Functions, or a functions host)** | Strong if managed | Pairs naturally with managed Postgres + RLS; less ops burden. |
| **Static-only (no server tier)** | **Insufficient for this project's chosen direction** | Current state. Fine for the SPA. Could in principle enforce *some* models via Firestore security rules, but not this project's permission model / PostgreSQL direction. |

## Hostinger compatibility notes

- **Static SPA + Firebase** works on Hostinger shared/static hosting **today** — *if* the dev-only shipping server is given a real home or kept out of production scope.
- The moment server-side enforcement or a real API is required: **VPS or serverless**, not static/shared.
- **Managed Postgres (Supabase/Neon)** keeps the database off the Hostinger host (least ops burden). A Hostinger-VPS-hosted DB couples DB lifecycle to the VPS (more ops).
- Keep the **auth boundary, repository boundary, request-context contract, and audit boundary database/host-agnostic** before go-live.

## Decision criteria (resolve before the specific runtime is finalized)

The *requirement of a server/API tier* is ratified. The *specific runtime* stays provisional until these are recorded (several overlap the [database decision criteria](phase-1.4-decision-record-production-database.md#decision-criteria-resolve-before-the-provider--auth-choices-are-finalized)):

| # | Criterion | Why it matters | Status |
|---|---|---|---|
| 1 | **Runtime choice: VPS vs serverless/edge** | Ops burden, cold-start, cost, and how the API tier connects to managed Postgres. | Open |
| 2 | **App host confirmation (Hostinger?)** | Whether the SPA + API co-locate, and region/latency to the DB. | Open |
| 3 | **Region / latency** | App-tier ↔ DB-tier round-trip; user proximity. | Open (shared with DB §2) |
| 4 | **Cost model for the API tier** | VPS flat cost vs per-invocation serverless; interacts with DB provider choice. | Open (shared with DB §1) |
| 5 | **Shipping server + provider secret hosting** | Where the dev-only Express shipping logic + secrets run in production. | Open (shared with DB §9) |
| 6 | **Firebase Auth retained vs replaced** | Token-verification mechanism on the API tier (Firebase Admin SDK vs Supabase JWT). | Open (shared with DB §4) |

## Explicit non-actions

- **No changes** to `.replit`, build scripts, deployment target, `server/index.ts`, or any runtime are performed or implied by this record.
- This record only documents reality and the future prerequisite; ratification is a separate, explicit step.

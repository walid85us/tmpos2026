# Decision Record — Deployment Topology

> **Status:** **RECOMMENDED / PROVISIONAL** — pending explicit ratification. **This record changes no deployment files, no `.replit`, no build config, and no code.** It documents the current topology truthfully and the future requirement that server-side enforcement implies a server runtime.
>
> **Part of:** Phase 1.4 — Backend & Persistence Readiness, Milestone 0. See [`phase-1.4-milestone-0-backend-persistence-readiness.md`](phase-1.4-milestone-0-backend-persistence-readiness.md).

---

## Current topology (verified)

- **Production artifact:** a **static SPA**. `.replit` declares `deploymentTarget = "static"`, `publicDir = "dist"`, build `npm run build`. **There is no server runtime in the deployed artifact.**
- **Dev runtime:** `npm run dev` runs `tsx server/index.ts & vite`. The Express server (`server/index.ts`) is a **dev-only shipping sidecar** on port 5001, proxied via `/api/shipping`. Every route is `/api/shipping/*`. It has **no user/tenant/auth context** and **no Firebase**.
- **Backend trust boundary today:** only **Firebase Auth + the `users/{uid}` read** (client-side). Shipping webhooks use HMAC verification; provider API keys live in server memory.

**Implication:** Server-side enforcement, middleware, route guards, and Firestore/RLS rules **cannot run** in the current production topology. They are not "not yet wired" — there is **no server to wire them into.**

## Decision (provisional)

When (and only when) behavior-changing server-side enforcement is approved for implementation, **introduce a dedicated server/API runtime tier**. The static SPA can remain static; the **enforcement tier requires a VPS or serverless/functions runtime**. Until then, the topology stays as-is and Phase 1.4 remains docs/architecture/pure-helper only.

## Options for the future server tier

| Option | Fit | Notes |
|---|---|---|
| **VPS (e.g., Hostinger VPS) running the API/enforcement tier** | Strong if self-hosting | You own the runtime; SPA can be served static/shared; DB ideally managed (see DB decision record). |
| **Serverless / edge functions (e.g., Supabase Edge Functions, or a functions host)** | Strong if managed | Pairs naturally with managed Postgres + RLS; less ops burden. |
| **Static-only (no server tier)** | **Insufficient for enforcement** | Current state. Fine for the SPA; cannot enforce anything server-side. |

## Hostinger compatibility notes

- **Static SPA + Firebase** works on Hostinger shared/static hosting **today** — *if* the dev-only shipping server is given a real home or kept out of production scope.
- The moment server-side enforcement or a real API is required: **VPS or serverless**, not static/shared.
- **Managed Postgres (Supabase/Neon)** keeps the database off the Hostinger host (least ops burden). A Hostinger-VPS-hosted DB couples DB lifecycle to the VPS (more ops).
- Keep the **auth boundary, repository boundary, request-context contract, and audit boundary database/host-agnostic** before go-live.

## Must be clarified before ratifying a topology

1. Is a server/API/enforcement tier actually in scope (yes, if server enforcement is the goal)?
2. VPS vs serverless for that tier?
3. Where do the shipping server + provider secrets run in production?
4. Is Firebase Auth retained or replaced (interacts with the DB decision record)?

## Explicit non-actions

- **No changes** to `.replit`, build scripts, deployment target, `server/index.ts`, or any runtime are performed or implied by this record.
- This record only documents reality and the future prerequisite; ratification is a separate, explicit step.

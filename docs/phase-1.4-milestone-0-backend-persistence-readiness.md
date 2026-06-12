# Phase 1.4 — Milestone 0: Backend & Persistence Readiness (Inventory & Architecture)

> **Status:** **Documentation / inventory / architecture only.** No source, runtime, UI, server, Firebase, Firestore-rules, permission-resolver, schema, middleware, or migration changes were made in this milestone. This artifact establishes the authoritative, verified picture of the current backend/persistence reality **before** any Backend & Persistence Readiness implementation begins.
>
> **Truthful reality (today, verified by read-only inspection at checkpoint `9cb152e`):** The deployed artifact is a **static SPA** (`.replit → deploymentTarget = "static"`). There is **no production server runtime**, **no server-side actor/tenant identity**, **no durable application database**, and **no server-side or Firestore-rule enforcement**. Firebase is used **only** for Auth + a single `users/{uid}` role read. Almost all application data is **mock / in-memory / browser storage**. Every "future" item below is a recommendation, not an existing capability.
>
> **This milestone changes no behavior and is reversible** (delete these docs + revert the `replit.md` doc corrections). It must not be committed or backed up until manual QA acceptance.

---

## 1. Scope & Method

**Phase 1.4 re-scope (accepted):** Phase 1.4 is **Backend & Persistence Readiness** — docs/architecture/pure-helper readiness work only. The originally proposed behavior-changing server-side enforcement direction is **deferred** until after the production-database decision, deployment-topology decision, durable data model, request-context contract, auth boundary, repository boundary, and audit boundary are planned and accepted.

**Method:** Read-only inspection of the repository at HEAD `9cb152e621631e838adabb3a96d55f6b7911e192` (Phase 1.3 closeout, working tree clean). Findings below are grounded in the actual code, not assumptions. Storage mechanisms (localStorage vs sessionStorage) were verified per key.

**M0 deliverables (this document + linked decision records):**
1. Enforcement Boundary + Persistence Inventory (§2)
2. Firebase Coupling Inventory (§3)
3. Data Domain Persistence Map (§4)
4. Database Portability / Migration Readiness Map (§5)
5. Audit-Truthfulness Labels (§6)
6. Request-Context Contract — docs/types only, no runtime wiring (§7)
7. Protected-Action Catalog — docs only (§8)
8. Documentation Corrections Log (§9)
9. Decision records — separate files, cross-referenced (§10):
   - [`phase-1.4-decision-record-production-database.md`](phase-1.4-decision-record-production-database.md)
   - [`phase-1.4-decision-record-deployment-topology.md`](phase-1.4-decision-record-deployment-topology.md)

**Relationship to Phase 1.3 M0:** [`phase-1.3-platform-access-inventory.md`](phase-1.3-platform-access-inventory.md) already classified the **platform (System Owner)** permission surface into a Tier 0–3 server-enforcement model (11 feature groups, 71 sub-permissions, 22 sensitive). This M0 **extends** that work along two axes it did not cover: (a) the **tenant/store business domains**, and (b) a **persistence axis** (durable vs ephemeral vs mock vs static). It does not restate or alter the Phase 1.3 tier classifications.

---

## 2. Enforcement Boundary + Persistence Inventory

Two independent axes describe each capability:

**Enforcement tier (reuses Phase 1.3 model):**
- **Tier 0** — UI-only acceptable (read/nav/non-mutating).
- **Tier 1** — future server validation recommended (low-risk writes).
- **Tier 2** — future server validation required before production (lifecycle / financial / destructive / restricted-data).
- **Tier 3** — future privileged / PIM-controlled server action (RBAC mutation, platform-wide config, provisioning).

**Persistence class (new in M0):**
- **DUR** — durable, server-written (does not exist anywhere today).
- **LS** — browser `localStorage` (per-browser, survives tab close; NOT shared, NOT server-visible).
- **SS** — browser `sessionStorage` (per-tab, cleared on tab close; ephemeral advisory).
- **MEM** — in-memory React state, mock-seeded, **lost on refresh**.
- **STATIC** — code config (compiled into the bundle).

**Current enforcement boundary (verified):** *Everything* in the application is **UI/client-gated**, except the single genuine backend trust boundary: **Firebase Auth + the `users/{uid}` read**. There is **no server-side enforcement and no active Firestore-rule enforcement** anywhere.

| Capability area | Owner | Enforcement today | Persistence today | Future tier (target) |
|---|---|---|---|---|
| Login / role resolution | Platform+Tenant | **Firebase Auth + `users/{uid}` read** (real trust boundary) | Firebase Auth + FS read (DUR-ish, single doc) | Tier 2 (identity) |
| Platform feature/page/action gating | Platform | UI/client-gated | engine STATIC; overrides **SS** | Tier 0–3 (per Phase 1.3 inv.) |
| Global Permissions Matrix writes | Platform | UI/client-gated | **SS** (`platform_permissions_v1`) | **Tier 3** |
| Phase 1.3 governance (PIM / review / reason / investigation) | Platform | UI/client-gated, advisory | **SS** | Tier 2–3 (deferred) |
| Audit log writes | Platform | client-written | **SS** (`audit_logs`) | Tier 2 |
| Platform Settings | Platform | UI/client-gated, nothing enforced at runtime | **LS** (`platform_settings_v1`) | Tier 3 |
| Tenant web address / domains | Platform | UI/client-gated, advisory | **SS** (`tenant_domains_v1`, DNS/registrar/security) | Tier 0–2 |
| Commercial (plans/add-ons/entitlements/overrides/invoices) | Platform | UI/client-gated | **SS** (`plans_data`, `addons_data`, `tenant_overrides_data`, `features_data`, `commercial_invoices_data`) | Tier 1–3 |
| Tenant provisioning / tenant status | Platform | UI/client-gated, mock | MEM | Tier 1–3 |
| Tenant/store RBAC (Store Permissions Matrix) | Tenant | UI/client-gated | STATIC + MEM | Tier 2–3 (deferred; tenant scope not ready) |
| POS / orders | Tenant | UI/client-gated | MEM | Tier 2 (deferred) |
| Invoices | Tenant | UI/client-gated | MEM | Tier 2 (deferred) |
| Repairs lifecycle | Tenant | UI/client-gated | MEM | Tier 2 (deferred) |
| Inventory + movements | Tenant | UI/client-gated | MEM | Tier 2 (deferred) |
| Customers (CRM) | Tenant | UI/client-gated | MEM | Tier 1–2 (deferred) |
| Supply chain (PO/GRN/RMA) | Tenant | UI/client-gated | MEM | Tier 2 (deferred) |
| Returns / warranty / service points | Tenant | UI/client-gated | MEM | Tier 1–2 (deferred) |
| Shipping operations | Tenant | **server-mediated (dev-only), unauthenticated w.r.t. users** | server MEM (`Map`) + `data/webhook-audit-log.json` (file) | Tier 1–2 |
| Support queue / escalation / SLA / macros | Platform | UI/client-gated | MEM + **SS** (`sla_policy`, `sla_policy_audit_log`, snapshots) | Tier 1–2 |

**Key boundary findings:**
- **No tenant/store actions can be safely server-enforced** because tenant scope does not exist server-side (the tenant object is hardcoded in `AccessContext`).
- **No capability persists durably to a backend.** The closest things to durable are: the Firebase `users/{uid}` doc (real), `platform_settings_v1` (localStorage, per-browser only), and `data/webhook-audit-log.json` (a server file, dev-only).
- **The only place real server logic exists is shipping**, and it has no user/tenant authentication.

---

## 3. Firebase Coupling Inventory

**Total Firebase surface: 4 files, 1 logical operation (auth + one read). The server is Firebase-free.**

| File | Firebase API used | Role | Coupling weight |
|---|---|---|---|
| `src/firebase.ts` | `initializeApp`, `getFirestore`, `getAuth` | Single init point | Init only |
| `src/context/AccessContext.tsx` | `onAuthStateChanged`, `doc`, `getDoc` | **Identity core** — derives session/role from Auth + `users/{uid}`; sets a **mocked** tenant | **High** (the one file a migration must handle carefully) |
| `src/components/Login.tsx` | `signInWithPopup`, `signInWithEmailAndPassword`, `GoogleAuthProvider`, `signOut`, `doc`, `getDoc` | Login UI + role read | Medium |
| `src/components/NotProvisioned.tsx` | `signOut` | Sign-out only | Trivial |

**Firestore operations in the entire app:** exactly one read pattern — `getDoc(doc(db, 'users', uid))`. **Zero writes. Zero collection queries. Zero `onSnapshot`. Zero Storage.** (`firebase-blueprint.json` / `firestore.rules` describe `tenants`, `memberships`, `invitations`, `auditEvents` collections, but the app **does not read or write them** — they are scaffold.)

**Orphaned config:** `firestore.rules` exists but there is **no `firebase.json` / `.firebaserc`** wiring it to deployment. The live rule posture is **unverifiable from the repo**. The rules as written are permissive/placeholder (open `tenants` read; any-authenticated `auditEvents` write). **Do not activate or rewrite in Phase 1.4.**

**Coupling verdict:** **Centralized by accident, not by design.** Replacing Firebase is *cheap today* (4 files) and *expensive later* if real persistence is built directly on Firestore. This is the central argument for introducing an auth/repository boundary **before** adding persistence.

---

## 4. Data Domain Persistence Map

Verified storage mechanism per data domain. **MEM = lost on refresh; SS = lost on tab close; LS = per-browser; FS = Firestore; FILE = server JSON file; STATIC = code.**

| Data domain | Mechanism | Durable? | Tenant-scoped today? | Notes |
|---|---|---|---|---|
| User identity / role | FS (`users/{uid}`) + Firebase Auth | Partially (single doc) | n/a | Only real persisted app data |
| Tenant record | MEM (hardcoded `tenant-1`) | No | — | **Does not exist as data** |
| Stores / locations | MEM (mock) | No | implicit/mock | — |
| Tenant team members | MEM (`Employees`) | No | implicit/mock | — |
| Platform roles / tenant roles | STATIC (`accessConfig.ts`) | No (config) | n/a | Portable seed data |
| Platform permission overrides | **SS** `platform_permissions_v1` | No | n/a | Per-tab; engine pure |
| Store permission matrix | STATIC + MEM | No | implicit | — |
| Customers (CRM) | MEM (mock) | No | implicit/mock | — |
| Invoices (tenant) | MEM (mock) | No | implicit/mock | Financial |
| Commercial invoices (platform) | **SS** `commercial_invoices_data` | No | n/a | Platform billing |
| POS / orders | MEM (mock) | No | implicit/mock | Transactional |
| Repairs | MEM (mock, seeded tickets) | No | implicit/mock | Stateful lifecycle |
| Inventory + movements | MEM (mock, seeded movements) | No | implicit/mock | Ledger-style |
| Supply chain (PO/GRN/RMA) | MEM (mock) | No | implicit/mock | Financial/relational |
| Warranty | MEM (mock) | No | implicit/mock | — |
| Shipping shipments | MEM (mock) | No | implicit/mock | Adapter layer exists |
| Shipping provider credentials | server **MEM** (`Map`) | No (lost on restart) | n/a | Secrets; ephemeral |
| Shipping webhook audit | **FILE** `data/webhook-audit-log.json` | Partially (dev file) | n/a | Only file persistence |
| Returns / service points / pickups / carrier analytics | MEM (+ SLA snapshots SS) | No | implicit/mock | — |
| Platform settings | **LS** `platform_settings_v1` | Per-browser | n/a | Only durable-ish UI store |
| Tenant web address / domains | **SS** `tenant_domains_v1` (+ `tenant_dns_records_v1`, registrar, security) | No | per-tenant field | Advisory |
| Audit logs | **SS** `audit_logs` | No | n/a | Client-written mirror |
| Temporary access / PIM | **SS** `platform_temporary_access_v1` | No | n/a | Advisory; no scheduler |
| Access reviews | **SS** `platform_access_review_v1` | No | n/a | Advisory |
| Sensitive-action reason capture | **SS** `platform_sensitive_action_reason_v1` | No | n/a | Advisory |
| Audit investigation overlay | **SS** `audit_investigation_state_v1` | No | n/a | Append-only session overlay |
| Plans / add-ons / entitlements / tenant overrides / features | **SS** `plans_data`, `addons_data`, `tenant_overrides_data`, `features_data` | No | mixed | Commercial |
| Support queue / escalation / SLA / macros | MEM + **SS** `sla_policy`, `sla_policy_audit_log` | No | implicit | — |
| Reports / analytics | Derived (read-only) | n/a | n/a | Recomputed |

**Verified summary:** The application has **one** small piece of real backend persistence (Firebase `users/{uid}`), **one** durable-per-browser store (`platform_settings_v1` in localStorage), **one** server-side file (`webhook-audit-log.json`), and **everything else is sessionStorage-ephemeral or in-memory mock.** No data domain carries an enforced `tenantId`/`storeId` at a persistence boundary because there is no persistence boundary.

---

## 5. Database Portability / Migration Readiness Map

**Favorable factors (keep these true):** string IDs (portable to text/UUID PKs); ISO-string timestamps; string-literal union enums (`AccountStatus`, roles, statuses); **no Firestore-specific query patterns** (`where`/composite indexes) to unwind; Firebase Storage unused; pure, React-free permission engine.

**Risk factors:** no data-access/repository layer; no durable tenant/store records; financial/transactional domains have no integrity model; audit storage ephemeral; no schema versioning / export-import path / portability tests; auth UID risks becoming a hard PK dependency.

| Domain | Migration difficulty | Why |
|---|---|---|
| User / auth identity | **Medium** | Auth-provider swap is the only non-trivial part; data shape tiny |
| Platform roles / permission definitions | **Easy** | Pure config → portable seed |
| Permission overrides / matrices | **Medium** | Ephemeral → durable rows; engine portable |
| Platform settings / domains / commercial config | **Medium** | Registry/object models exist; advisory |
| Reports / analytics | **Easy** | Derived |
| Shipping | **Medium** | Adapters already abstracted; events semi-persisted |
| Warranty / returns / service points | **Medium–Hard** | Moderate relations |
| Customers / repairs / supply chain / team | **Hard** | Rich nested objects, relational, no persistence yet |
| Invoices / POS-orders / inventory movements | **Very Hard** | Transactional + relational + financial; need ACID + FKs |
| Tenants / stores | **Not ready** | Do not exist as durable records — must be **designed**, not migrated |

**Overall:** Portability posture is **currently favorable precisely because so little is built.** This is closer to a **first-time backend build** than a data migration (there is almost no production data to move) — which is *lower* risk, **provided the auth/repository/audit boundaries are introduced before persistence is added.** The danger is forward-looking: direct Firestore writes from components would collapse portability.

---

## 6. Audit-Truthfulness Labels

A required labeling vocabulary for every data/record surface, so no document, UI label, or future claim implies more durability or enforcement than exists. **Four labels:**

| Label | Meaning | Examples today |
|---|---|---|
| **DURABLE / SERVER-WRITTEN** | Persisted by a trusted server to a backend store; tamper-resistant; can be evidence. | **None today.** (Closest: Firebase `users/{uid}` — but client-read, not server-enforced.) |
| **BROWSER / SESSION ADVISORY** | `sessionStorage` (or `localStorage`); client-authored; per-tab/per-browser; **not evidence**. | `audit_logs`, all Phase 1.3 governance keys, `platform_settings_v1` (LS), commercial/SLA/domain keys |
| **MOCK / IN-MEMORY** | Seeded demo data in React state; lost on refresh; **not real**. | POS, invoices, inventory, repairs, customers, supply chain, tenant/team data |
| **STATIC CONFIG** | Compiled into the bundle; not a record. | role definitions, permission definitions, settings registry |

**Mandatory rule for Phase 1.4 and beyond:** Phase 1.3 advisory/`sessionStorage` records **must never be presented as backend enforcement evidence or compliance evidence.** Any future "durable/server-written" claim requires an actual server-written append-only store to exist first. The Phase 1.3 docs already honor this; M0 makes the label vocabulary explicit and reusable.

---

## 7. Request-Context Contract (documentation/types only — NO runtime wiring)

The following TypeScript is **documentation of a proposed contract**. It is intentionally embedded here as a fenced code block and **not** placed in any runtime `.ts` file, so nothing imports it and no behavior changes. It is the shape a future server tier would attach to every authenticated request **before any enforcement is implemented.**

```ts
// PROPOSED — NOT IMPLEMENTED. Documentation only. Do not wire into runtime.
// A future server tier would derive this AFTER verifying a Firebase ID token
// (or the chosen auth provider's token) and looking up durable scope.

type ActorKind = 'platform' | 'tenant' | 'preview' | 'system';

interface RequestActor {
  userId: string;            // stable internal id, decoupled from auth-provider UID
  authProviderUid: string;   // e.g. Firebase Auth uid (today) / Supabase uid (later)
  email: string;
  kind: ActorKind;
  role: string;              // resolved platform OR tenant role id (never mixed)
}

interface RequestScope {
  // Exactly one of platform/tenant is authoritative per request.
  platform: boolean;         // true for platform-owner-scoped requests
  tenantId: string | null;   // REQUIRED for every tenant/store-scoped durable action
  storeId: string | null;    // when store-level granularity applies
}

interface RequestContext {
  actor: RequestActor;
  scope: RequestScope;
  isPreview: boolean;        // preview/demo sessions are an explicitly-allowed sandbox
  requestId: string;         // correlation id for audit
  // Decision/enforcement fields are added ONLY when server enforcement is built:
  // permissionChecked?: string; decision?: 'allow' | 'deny'; reason?: string;
}
```

**Design rules captured (for later, not now):** deny-by-default; platform vs tenant scope never mixed; `tenantId` required on every tenant-scoped durable action; preview/demo is a first-class allowed sandbox (never authenticated against production data); the pure permission engine (`platformPermissionsConfig.ts` / `accessConfig.ts`) is **reused, not forked** — but only once it resolves against a durable, server-authoritative source.

---

## 8. Protected-Action Catalog (documentation only)

A documentation catalog of high-risk actions and the order in which they could *eventually* become server-enforced (after prerequisites exist). **No action is enforced by this catalog; it is a planning reference.** Tiers reference Phase 1.3 inventory.

| # | Action | Scope | Tier | Server-enforce readiness | Notes |
|---|---|---|---|---|---|
| 1 | Global Permissions Matrix write (role/sub-perm change) | Platform | 3 | **First candidate** (after durable store + server identity) | Clear actor/target; System-Owner-protected; reuses engine |
| 2 | Platform role change | Platform | 3 | After #1 prerequisites | Privilege escalation risk |
| 3 | Platform Settings change | Platform | 3 | After durable store | Platform-wide config |
| 4 | Tenant provisioning / tenant status change | Platform | 1–3 | Deferred — no durable tenant records | — |
| 5 | Tenant web address lifecycle | Platform | 0–2 | Deferred | Advisory today |
| 6 | Durable audit-row write | Platform | 2 | Pairs with #1 | Establishes append-only boundary |
| 7 | Commercial overrides / paid add-on grants | Platform | 1–3 | Deferred | Financial |
| 8 | Tenant/store business actions (POS/invoice/inventory/repairs) | Tenant | 2 | **Deferred — dangerous first** (tenant scope is mocked) | — |
| 9 | Temporary access / access review / reason capture | Platform | 2–3 | Deferred — advisory `SS` records | Not evidence-grade |

**First safe server-enforced action (future):** #1 (Global Permissions Matrix write) — **only after** a server runtime, server-side ID-token verification, and a durable permission store exist. **Dangerous first action:** #8 (tenant/store business actions) — enforcing against a mocked tenant scope.

---

## 9. Documentation Corrections Log

The following overclaims in `replit.md` are corrected by M0 (doc edits only; no runtime impact). Recorded here for QA traceability.

| Location | Before (overclaim) | After (truthful) | Why |
|---|---|---|---|
| `replit.md` Firebase Integration | "Leverages Firestore for backend data persistence and Firebase Authentication for user management." | Firebase Auth for sign-in + a single `users/{uid}` role lookup; application data is currently mock/in-memory/browser storage, **not** persisted to a backend database. | Zero Firestore writes; one read only |
| `replit.md` AI Integration | "Integrates with the Gemini API for AI functionalities." | `@google/genai` is present as **scaffold/unused**; no Gemini call sites exist in the codebase. | Verified zero usage |
| `replit.md` Server-Side Shipping API | "...with secure credential storage." | Credentials are held **in-memory (ephemeral, lost on restart), masked in responses, and redacted in logs** — not durable/production-grade secret storage. Server is **dev-only** and not part of the static production deploy. | In-memory `Map`; static deploy |
| `replit.md` External Dependencies (Firebase/Gemini) | "Firebase: Firestore and Authentication." / "Gemini API: Integrated." | Firebase: **Authentication + a single Firestore role read.** Gemini: **scaffold/unused.** | Same as above |
| `replit.md` Active Roadmap Phase 1.4 | "Phase 1.4 — Automation + Alerts" | "Phase 1.4 — Backend & Persistence Readiness (docs/architecture readiness; behavior-changing server enforcement and database migration deferred)." Automation + Alerts re-sequenced to a later phase. | Roadmap reconciliation |

**Optional clarifier (light):** the "Authentication & Access Control" line may add "(enforcement is UI/client-gated)" for consistency with the Locked Rules; kept minimal to avoid scope creep.

---

## 10. Decision Records (cross-reference)

- **Production Database Decision Record** → [`phase-1.4-decision-record-production-database.md`](phase-1.4-decision-record-production-database.md) — records **PostgreSQL (default target: Supabase)** as the *recommended, provisional* production direction, with comparison and the explicit note that **no migration is triggered.**
- **Deployment Topology Decision Record** → [`phase-1.4-decision-record-deployment-topology.md`](phase-1.4-decision-record-deployment-topology.md) — records the current static-SPA + dev-sidecar reality and the future requirement that **any real server-side enforcement requires a VPS/serverless/API runtime.**

---

## 11. What M0 Explicitly Does NOT Do (Deferred / Forbidden)

**M0 does not (and Phase 1.4 implementation prompts must forbid):** editing source/runtime behavior; changing UI; changing `server/index.ts`, `AccessContext.tsx`, `firebase.ts`, `platformPermissionsConfig.ts`, `accessConfig.ts`; changing tenant/store permission behavior; changing `firestore.rules`; implementing middleware, server guards, route guards, or server enforcement; implementing database migration; creating real schema/DDL/`.sql` files; wiring any new helper/type into runtime; committing or backing up before manual QA acceptance.

**Deferred to later phases (post-decision, post-acceptance):** real server-side enforcement; Firestore rules / Postgres RLS; durable data model + schema; request-context middleware (runtime); auth/repository/audit boundary implementation; database migration; PAM/PIM, SSO/SCIM, scheduler-based revocation, compliance-evidence automation; Automation + Alerts.

---

## 12. M0 Exit Criteria & QA Checklist

M0 is complete when, by manual QA:
- [ ] These docs accurately reflect the code (spot-check the Firebase coupling = 4 files; one `getDoc`; no writes).
- [ ] `npm run lint` (`tsc --noEmit`) is clean (no new code introduced; types are doc-embedded only).
- [ ] App boots identically (`npm run dev`); login → role resolution → landing route unchanged; no UI/behavior change.
- [ ] No file outside `docs/` and `replit.md` was modified; no new runtime `.ts`/`.tsx` file exists; nothing imports anything new.
- [ ] `replit.md` corrections read as truthful and do not overclaim or under-claim.
- [ ] Decision records are clearly marked *recommended/provisional* and trigger no migration.

Only after acceptance: commit and `npm run backup:github`.

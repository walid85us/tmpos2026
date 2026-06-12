# Phase 1.4 — Milestone 1: Auth / Repository Boundary Plan (Architecture)

> **Status:** **Documentation / architecture PLAN only.** This milestone **implements nothing**. It defines the *interfaces and adoption order* for a future auth/data-access boundary so that (a) the app's single Firebase coupling is contained, (b) the ratified PostgreSQL direction is reachable without a big-bang rewrite, and (c) Firebase keeps working for testing. **No runtime behavior changes, no source wiring, no new runtime `.ts`/`.tsx` files, no Firebase replacement, no Supabase implementation, no database migration, no schema, no middleware, no server enforcement, no Firestore-rules changes, no UI changes.**
>
> All interfaces below are embedded as fenced code blocks **inside this document** (the same convention as the M0 request-context contract). They are **not** placed in any runtime file and **nothing imports them**.
>
> **This milestone is reversible** (delete this doc + revert the decision-record wording edits). It must not be committed or backed up until the M1 report is reviewed and accepted.
>
> **Part of:** Phase 1.4 — Backend & Persistence Readiness. Builds on [`phase-1.4-milestone-0-backend-persistence-readiness.md`](phase-1.4-milestone-0-backend-persistence-readiness.md). Implements the ratification actions from the Phase 1.4 Decision Ratification Review.

---

## 1. Purpose & Principles

**Purpose:** Specify a thin, provider-agnostic boundary that all auth and durable-data access would pass through in a *future* implementation milestone — so the production-database and auth-provider choices stay swappable, and so the favorable migration posture (today: 4 Firebase files, zero Firestore writes) does not erode as features are added.

**Principles (carried from M0 + ratification):**
- **Interface-first, provider-agnostic.** No interface names a vendor. Firebase today, Supabase/Neon/Railway/VPS-Postgres later — same interfaces.
- **Strangler-fig, not big-bang.** Introduce one boundary at a time; each step is independently shippable and reversible.
- **Keep Firebase working for testing.** The *first* concrete adapter is a Firebase adapter that reproduces today's behavior exactly. Nothing breaks.
- **Internal `userId` decoupled from `authProviderUid`.** Keeps the auth swap cheap (see ratification §5).
- **Every durable record carries `tenantId`** (and `storeId` where applicable) at the boundary — the precondition for future Postgres RLS.
- **UI stops importing `firebase/*` directly** (only 3 files do today — hold the line at the boundary).
- **Reuse the pure permission engine, never fork it** (`platformPermissionsConfig.ts` / `accessConfig.ts` stay the single source of truth).
- **No fake durability.** A repository backed by `sessionStorage` is labeled advisory (M0 §6); it is not "server-written."

---

## 2. Current State the Boundary Must Wrap (verified)

| Call site | What it does today | Future boundary method |
|---|---|---|
| `src/firebase.ts` | `initializeApp` + `getAuth` + `getFirestore` | becomes the **Firebase adapter's** private init; nothing else imports it |
| `src/context/AccessContext.tsx` | `onAuthStateChanged` → `getDoc(users/{uid})` → derive session/role; sets a **mocked** tenant | `authProvider.onAuthStateChanged()` + `userRepository.getProfile(uid)` |
| `src/components/Login.tsx` | `signInWithPopup` (Google), `signInWithEmailAndPassword`, `signOut`, `getDoc(users/{uid})` | `authProvider.signInWithGoogle()` / `signInWithPassword()` / `signOut()` + `userRepository.getProfile()` |
| `src/components/NotProvisioned.tsx` | `signOut` | `authProvider.signOut()` |

Verified auth surface: **Google popup + email/password only** (no phone/anonymous/other OAuth). Verified Firestore surface: **one read pattern, zero writes, no realtime/offline.** This is the entire surface the boundary must cover for parity.

---

## 3. Target Boundary Architecture (where it would live — future)

```
UI / Context (React)
   │  (depends only on interfaces below)
   ▼
src/data/            ← FUTURE location, not created in M1
   authProvider.ts        (IAuthProvider)
   repositories/
     userRepository.ts        (IUserRepository)
     permissionsRepository.ts (IPermissionsRepository)
     auditRepository.ts       (IAuditRepository)
   adapters/
     firebase/   ← first concrete adapter (parity with today)
     postgres/   ← future (Supabase/Neon/Railway/VPS) — NOT in scope
   index.ts            (composition root: picks adapter by config/env)

server/data/         ← FUTURE, only when the server/API tier exists (topology record)
```

The **composition root** (`src/data/index.ts`, future) is the *only* place that names a concrete adapter. Swapping Firebase→Postgres = changing one wiring file + adding an adapter; no UI/context edits.

---

## 4. Proposed Interfaces (documentation only — NOT runtime, NOT imported)

```ts
// PROPOSED — documentation only. Do NOT place in a runtime file; nothing imports this.
// Provider-agnostic. "Firebase" / "Supabase" appear only in ADAPTERS, never here.

// ---- Identity ----------------------------------------------------------------
interface AuthUser {
  authProviderUid: string;   // Firebase uid today / Supabase uid later
  email: string;
}
interface UserProfile {
  userId: string;            // STABLE INTERNAL id, decoupled from authProviderUid
  authProviderUid: string;
  email: string;
  name: string;
  role: string;              // platform OR tenant role id (never mixed)
}

interface IAuthProvider {
  onAuthStateChanged(cb: (user: AuthUser | null) => void): () => void; // returns unsubscribe
  signInWithGoogle(): Promise<AuthUser>;
  signInWithPassword(email: string, password: string): Promise<AuthUser>;
  signOut(): Promise<void>;
  // FUTURE (only when a server/API tier exists): verifyToken(token): Promise<AuthUser>
}

// ---- Repositories ------------------------------------------------------------
// Generic shape every durable repository follows. Reads/writes are async so the
// same interface serves Firestore today and Postgres-over-API later.
interface IUserRepository {
  getProfile(authProviderUid: string): Promise<UserProfile | null>; // today: getDoc(users/{uid})
}

// Permission-matrix overrides. Today backed by sessionStorage (ADVISORY, per M0 §6);
// later by a durable store. The pure engine (platformPermissionsConfig.ts) is unchanged.
interface IPermissionsRepository {
  readOverrides(): Promise<unknown>;            // shape = existing PlatformPermissionsOverrides
  writeOverrides(next: unknown): Promise<void>;
  // durability label travels with the data; see M0 §6
}

// Audit. Today a sessionStorage mirror (ADVISORY). A future server adapter is the
// ONLY thing allowed to claim "durable / server-written".
interface AuditRow { actor: string; action: string; target?: string; severity: string; category: string; at: string; }
interface IAuditRepository {
  append(row: AuditRow): Promise<void>;
  list(): Promise<AuditRow[]>;
}

// ---- Domain repositories (INTERFACES SKETCHED, IMPLEMENTATION DEFERRED) -------
// Defined now ONLY to lock the tenantId-on-every-call contract. NOT implemented in
// any near milestone; StoreLocalState stays as-is until real persistence is chosen.
interface IRepository<T> {
  getById(tenantId: string, id: string): Promise<T | null>;
  list(tenantId: string): Promise<T[]>;
  upsert(tenantId: string, entity: T): Promise<void>;
  remove(tenantId: string, id: string): Promise<void>;
}
// e.g. ITenantRepository, IInvoiceRepository, IInventoryRepository … all extend IRepository<T>.
```

**Design notes captured:** every domain method takes `tenantId` explicitly (RLS precondition); identity returns an internal `userId` separate from `authProviderUid`; advisory vs durable is a property of the *adapter*, not the interface, and must be labeled per M0 §6; the request-context contract (M0 §7) is the *server-side* counterpart this client boundary will eventually feed.

---

## 5. Adoption Order (future implementation — strangler-fig)

Each step is a *future* behavior-preserving milestone, individually reviewed/QA'd/backed up. **None is part of M1.**

| Step | Scope | Behavior change | Notes |
|---|---|---|---|
| **A. Auth boundary** | Wrap the 4 Firebase sites behind `IAuthProvider` + `IUserRepository`, with a **Firebase adapter** reproducing today's behavior | **None** (parity) | Smallest, highest-leverage; stops new `firebase/*` imports |
| **B. Permissions persistence boundary** | Route matrix overrides through `IPermissionsRepository` (sessionStorage adapter first) | None | Pure engine untouched |
| **C. Audit boundary** | Route audit writes through `IAuditRepository` (sessionStorage adapter first) | None | Sets up the later durable/server adapter |
| **D. Domain repositories** | **Interfaces only**, deferred implementation | None | Do **not** rewire `StoreLocalState` until a DB provider is ratified |
| **E. (Post-topology) Server/API + Postgres adapters** | Only after the server tier + provider are ratified | Yes — first real enforcement | Separate phase; out of Phase 1.4 |

**Sequencing rule:** steps A–D are docs/helper milestones that keep Firebase live for testing. Step E is the first behavior-changing work and is gated on the topology + provider ratifications and the durable data model.

---

## 6. Provider-Agnostic & Migration Guarantees

- **DB swap (Firestore→Postgres):** only adapters + composition root change; interfaces and all callers are stable.
- **Auth swap (Firebase Auth→Supabase Auth):** only the `IAuthProvider` adapter changes; `userId` decoupling means existing references don't churn. Email is the natural re-mapping key (verified: Google + password only).
- **Keep-Firebase-Auth-with-Postgres** (the Neon/Railway path) remains valid: a future server adapter verifies Firebase tokens via Admin SDK while data lives in Postgres.
- **Drop-in Postgres hosts** (Supabase/Neon/Railway/VPS): same SQL adapter family; host differences are connection config, not code.

---

## 7. What M1 Does NOT Do (Forbidden / Deferred)

**M1 does not:** change runtime behavior; add source wiring; create runtime `.ts`/`.tsx` files; replace Firebase; implement Supabase; migrate data; create schema/DDL/`.sql`; implement middleware/guards/server enforcement; change Firestore rules; change UI; touch `server/index.ts`, `AccessContext.tsx`, `firebase.ts`, `platformPermissionsConfig.ts`, `accessConfig.ts`, tenant/store permission behavior; commit or back up before review/acceptance.

**Deferred to future (post-acceptance) milestones:** the actual adapters and wiring (steps A–E above); durable data model + schema; server/API tier; Postgres RLS; auth-provider replacement.

---

## 8. Risks (planning)

- **Boundary leakage:** if a future step lets a vendor type cross an interface, agnosticism is lost. Mitigation: vendor names live only in `adapters/`.
- **Premature auth coupling:** designing step A around Supabase Auth specifics would harm the Neon/Firebase-Auth fallback. Mitigation: `IAuthProvider` is generic (above).
- **Advisory/durable confusion:** a sessionStorage-backed repository must never be presented as durable evidence. Mitigation: M0 §6 labels travel with the adapter.
- **Scope creep into implementation:** the temptation to "just wire it" must be resisted until A–D are individually accepted. Mitigation: this plan keeps interfaces in docs only.

---

## 9. M1 Exit Criteria & QA Checklist

M1 is complete when, by review (no behavioral UI QA needed — docs/architecture only):
- [ ] This plan exists and is provider-agnostic (no interface names a vendor).
- [ ] The two decision-record wording corrections are applied (Firestore transactions; static-hosting enforcement nuance).
- [ ] The decision criteria (cost, region, RPO/RTO, Firebase-Auth migration, payments/PCI, local dev/test, schema tooling, scale envelope) are added to the decision records.
- [ ] The DB direction status = RATIFIED (working); provider + auth = PROVISIONAL. Topology server-tier requirement = RATIFIED (working); specific runtime = PROVISIONAL.
- [ ] **Only** `docs/*.md` changed; **no** `src/`, `server/`, config, runtime, or `.ts`/`.tsx` files; nothing imports anything new.
- [ ] `npm run lint` shows no *new* errors vs the pre-existing baseline (M1 introduces no code).

Only after acceptance: commit and (on explicit instruction) back up.

---

## 10. Proposed Next Step After M1

After M1 acceptance, the recommended next milestone is **M2 — Durable Data-Shape & Domain Model Documentation** (docs only): document the concrete shapes/relationships of the high-risk domains (invoices, POS orders, inventory movements, tenants/stores, RBAC) as the input to a future schema — **still no schema files, no migration, no wiring.** Behavior-changing work (adapter implementation, server tier, RLS) remains gated on the provider/topology criteria being resolved.

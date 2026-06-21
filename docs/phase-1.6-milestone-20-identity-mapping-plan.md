# Phase 1.6 — Milestone 20: Identity Mapping Plan (Firebase ↔ Supabase)

## 1. Title

Phase 1.6 Milestone 20 — Firebase ↔ Supabase Identity Mapping Plan (documentation-only; investigation
findings + safe future mapping plan; non-authoritative).

## 2. Purpose

Record, in a repository-durable and redaction-safe form, the M20 finding that the frontend (Firebase)
identity and the server-authorization (Supabase / `platform_identity`) identity are structurally
decoupled and currently unlinked, and define the safe, server-owned future mapping plan, principles,
strategy options, and prerequisite sequence. This is a planning artifact only: it changes no runtime
behavior, adds no table/migration, wires nothing, and moves no authority boundary.

## 3. Accepted Checkpoint

- Accepted checkpoint commit: `f46f1de6a7470693bee291c10edfb69474d39ff6`
- Commit subject at base: "Phase 1.6 M19.1 document active context alignment plan"
- This M20.1 document is additive and documentation-only; it modifies no existing file.

## 4. Scope and Non-Goals

**In scope:** a written record of the Firebase and Supabase/`platform_identity` identity models, the
unlinked-identity gap, mapping risks, safe mapping principles, strategy options, and the prerequisite
milestone ladder.

**Non-goals (explicit):** no runtime change; no `identity_link` table; no migration; no change to
Firebase auth, Supabase auth, `platform_identity`, session-resolve, or AccessContext; no wiring; no
enabling/running of live authorization; no route/harness/feed/token/comparison invocation; no DB
connection or SQL; no Supabase MCP; no production work; no commit/push/backup as part of authoring.
Implementation, migration, and runtime integration are all out of scope and unapproved.

## 5. M20 Investigation Summary

Read-only inspection of the frontend Firebase identity modules, the server Supabase identity path, the
`platform_identity` repository, and the identity schema/migration found that the two identity systems are
**decoupled and unlinked**: there is no `identity_link` table, no `firebase_uid` column, and no bridging
source. Identity mapping is the first prerequisite for active-context alignment and everything downstream.
No code was changed; no route/DB call was made.

## 6. Current Frontend Firebase Identity Model

- Normal frontend authentication is **Firebase-based**; Login uses Firebase auth flows.
- The frontend obtains the Firebase UID from Firebase auth state.
- The frontend loads a Firestore user document keyed by the Firebase UID and derives app session data
  (e.g., role and display fields) from it.
- The frontend session contains **no** Supabase identity reference, **no** durable `internal_user_id`,
  **no** `platform_identity` reference, and **no** stable identity-bridge field.
- Supabase auth is **not** authoritative in the normal frontend app path (it appears only in the dormant
  pilot/shadow path).

## 7. Current Server Supabase Identity Model

- The server verifies Supabase tokens in the server-authorization path and derives a trusted actor whose
  external reference is the Supabase auth-provider UID.
- The server maps that external reference through `platform_identity` to the durable app identity.
- The server currently does **not** know the Firebase UID at runtime and does **not** know Firestore
  user-document IDs at runtime. (`firebase` exists only as a provider *label* in the provider value set
  and as the M1/M2 dev-asserted reference default — not a runtime bridge.)

## 8. Current Platform Identity Model

- `platform_identity` uses `internal_user_id` (app-owned UUID) as the **stable identity anchor**, decoupled
  from any external provider.
- The **uniqueness contract** is `(auth_provider, auth_provider_uid)` (a per-row unique reference).
- Email/display fields are **descriptive only** and are explicitly **not** authority keys (email is
  nullable and intentionally non-unique).
- The schema is **provider-aware** and anticipates multiple auth providers ("Firebase today, Supabase Auth
  later"), with external UIDs documented as references only.
- The identity table uses RLS-enabled-with-no-policies (client roles get nothing; the server owner-role
  bypasses).

## 9. Current Identity Gap

- No `identity_link` table exists; no `firebase_uid` column exists; no source bridges Firebase identity to
  Supabase identity; no email-authority bridge exists.
- Because each `(auth_provider, auth_provider_uid)` pair creates or resolves its **own** `internal_user_id`,
  a Firebase app user and a Supabase pilot user may resolve to **different** `internal_user_id` values.
- The same human **cannot be assumed** to be the same principal across providers without a **verified**
  mapping.
- Identity mapping is therefore the **first prerequisite** before active-context alignment, context hints,
  advisory beyond presence-only, shadow-at-scale, or authoritative use.

## 10. Why Email Must Not Be the Bridge

Email can change, may be unverified, may differ across providers, and may collide across dev/test
accounts; it is nullable and deliberately non-unique in the schema. Using email as the identity bridge
could link the wrong principals or fail to link the right ones. **Email must never be identity authority.**

## 11. Why Client-Asserted Identity Must Not Be Trusted

A client-supplied Firebase UID (or any client-asserted identifier) must **never** be trusted as authority.
Identity evidence must come from **verified provider tokens/credentials** (or controlled, server-verified
admin provisioning), never from stored client state (which is also a replay/session risk).

## 12. Account-Linking Risk

An incorrect mapping could grant one user access to another user's authorization context. Linking must be
**deterministic, server-owned, verified on both sides, and auditable** before a link is honored; a
mis-link is a cross-account access defect.

## 13. Safe Future Identity Mapping Principles

- Mapping must be **server-owned**, not client-owned.
- Mapping must be based on **verified provider credentials** or **controlled admin provisioning**.
- Email must **never** be used as identity authority.
- A client-supplied Firebase UID must **never** be trusted as authority.
- `internal_user_id` should remain the **stable app-owned anchor**.
- Provider identifiers must **not** be exposed to clients.
- Cross-provider links must be **auditable**.
- Link creation/changes must be **reversible** or have a safe rollback strategy.
- Mapping data must be **RLS-protected** and must not expose cross-tenant identity data.
- Mapping must **not** affect AccessContext or route authority until separately approved.

## 14. Identity Mapping Strategy Options

| Strategy | Sketch | Trade-off |
|---|---|---|
| Server-owned `identity_link` table | Link a verified Firebase reference and a verified Supabase reference to one `internal_user_id`. | **Leading candidate**: additive, reversible, least invasive; needs migration planning + DB readiness. |
| Firebase reference on `platform_identity` | Allow one `internal_user_id` to carry multiple provider references. | Overlaps with the link table; likely less clean than a separate mapping structure. |
| Supabase auth migration | Move frontend auth to Supabase, eliminating the dual-provider problem. | **Cleanest strategic end-state**; largest future migration; not this phase. |
| Controlled admin provisioning | An admin verifiably links accounts. | Safe operational bridge for low-volume controlled linking; may complement a link table. |

## 15. Recommended Leading Strategy: Server-Owned Identity Link

A server-owned `identity_link` structure is the leading future candidate for this phase: it is additive,
reversible, least invasive, keeps both providers, anchors on `internal_user_id`, is server-verified on
both sides, and can be RLS-protected and audited. It requires migration planning and DB-readiness
evidence before any implementation. **Not implemented now; not approved.**

## 16. Strategic End-State: Supabase Auth Migration

Migrating the frontend's authoritative auth to Supabase would remove the dual-identity problem entirely
and is the cleanest long-term end-state, but it is the **largest** change (frontend auth, Login, session
mapping, AccessContext) and is **out of scope** for this phase. It is recorded as a strategic direction
only.

## 17. Controlled Admin Provisioning Option

A controlled, server-verified admin provisioning flow could establish links for a small, known set of
accounts and may complement an `identity_link` table. It must still obey all safe mapping principles
(server-owned, verified, audited, RLS-protected, reversible).

## 18. Migration and Rollback Considerations

Any chosen strategy (link table / provider-reference / Supabase migration) requires a **migration with a
matching rollback** (mirroring the existing `00x_*.up.sql` / `.down.sql` pattern), schema review, and a
reconciliation plan for existing rows. None is in scope now.

## 19. RLS / Security Considerations

A future mapping table must follow the established RLS-enabled-no-policy posture so client roles can never
read it; it must **never** expose provider IDs or cross-tenant identity data to clients. The server
owner-role path remains the only reader/writer.

## 20. Audit / Evidence Considerations

Link creation and changes are security-relevant and should produce **durable audit evidence** with
deterministic reconciliation, reusing the existing append-only audit writer pattern and mindful of the
audit-volume strategy noted in earlier milestones.

## 21. Runtime Coupling Considerations

Do **not** wire any mapping into AccessContext or the session-resolve authority path until documented and
approved. The dormant M11→M15 + M17.1 chain remains dormant and unimported by the app runtime.

## 22. DB Readiness Evidence Needed Later

Before choosing/implementing a strategy, an owner-gated read-only DB readiness investigation should gather
**safe counts only** (e.g., identities per provider, any dual-provider overlap) — never row dumps, never
provider UIDs, never emails, never internal identifiers. Not run now.

## 23. Implementation Prerequisites

1. This documentation (M20.1).
2. Owner-gated read-only DB readiness evidence.
3. A chosen strategy with migration + rollback design.
4. RLS / security / audit / reconciliation review.
5. Dormant implementation planning (no runtime wiring).
6. Only later: controlled, separately-approved runtime integration.

## 24. Recommended Identity Mapping Milestone Ladder

1. **M20.1** — Identity mapping plan documentation (this file).
2. **M20.2** — Owner-gated read-only DB readiness investigation (safe counts only).
3. **Identity-link migration planning** (migration + rollback design).
4. **RLS / security / audit review**.
5. **Dormant implementation planning** (additive, default-OFF, authority-path-free).
6. **Controlled runtime integration** — deferred; separate later phase.

No rung may be skipped; each remains documentation/plan-only until its criteria are met and separately
approved.

## 25. Options Deferred or Rejected

- **Read-only DB readiness investigation** — deferred (owner-gated; needs separate read-only DB auth).
- **`identity_link` migration planning** — deferred (leading candidate; after readiness evidence).
- **Firebase-reference-on-identity planning** — deferred (overlaps the link table).
- **Supabase-auth migration planning** — deferred (strategic end-state; larger phase).
- **Dormant identity-link helper planning** — deferred (after a strategy is chosen).
- **Implement mapping now / wire into AccessContext or session-resolve now / production** — rejected.

## 26. Security / Redaction Boundary Confirmation

This document records only safe high-level conclusions, schema/architecture descriptions, source-level
provider labels, and planning language. It contains no raw authorization DTO, raw harness/feed/comparison
output, permission / sub-permission / entitlement key names, key arrays, mismatch lists, permission
levels, real role names/IDs, real tenant IDs, real store IDs, real plan IDs, real user IDs, real Firebase
UID values, real Supabase UID values, real provider UID values, real `internal_user_id` values, email
values, token, Authorization header, request headers, request or response body, DB URL, service-role key,
anon-key value, the owner confirmation phrase value, request IDs, actor UUIDs, audit metadata, or any
audit row dump.

## 27. Explicitly Forbidden Conclusions

This document does **not** claim: that identity mapping is solved; that Firebase and Supabase identities
are mapped; that email is safe as an identity bridge; that a client-supplied Firebase UID is safe as
authority; that the M17 Supabase pilot user equals the Firebase app user; that active-context alignment is
solved; that context hints are safe now; that server authorization is advisory-ready beyond presence-only;
that server authorization is authoritative; that the frontend should consume server authorization now;
that AccessContext should change now; that Firebase session authority is replaced; that production
enablement is ready; that identity-link implementation is approved; that migration is approved; or that
M14/M15/M17.1 should be wired into runtime.

It affirms: Firebase/legacy AccessContext remain authoritative; server-derived authorization remains
observational/comparable only; identity mapping is **not** solved; identity mapping is the first
prerequisite; email must not be identity authority; client-asserted identity must not be authority;
`internal_user_id` should remain the app-owned stable anchor; any future identity link must be
server-owned, verified, auditable, and RLS-protected; the M11→M15 + M17.1 path remains dormant; and
production remains blocked.

## 28. Recommended Next Milestones

- `Phase 1.6 M20.1 — Scoped Commit and Backup Authorization` (commit/back up this plan, owner-gated).
- `Phase 1.6 M20.2 — Identity Mapping DB Readiness Investigation` (owner-gated, read-only, safe counts
  only) — to gather the evidence required before choosing/implementing a mapping strategy. Subsequent
  rungs (migration planning, RLS/audit review, dormant implementation planning) follow in order.

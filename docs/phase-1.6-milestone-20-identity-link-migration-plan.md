# Phase 1.6 — Milestone 20: Identity Link Migration Plan (Design-Only)

## 1. Title

Phase 1.6 Milestone 20 — Additive `identity_link` Migration Plan (design-only; no SQL applied; no
migration file created; non-authoritative).

## 2. Purpose

Plan, in a repository-durable and redaction-safe form, a **future additive** `identity_link` migration
that would allow a verified Firebase provider reference and a verified Supabase provider reference to be
linked to one stable app-owned `internal_user_id`. This is a **design artifact only**: it applies no DDL,
creates no migration file, writes no DB, and wires nothing into runtime. It uses **design language only**
— no executable SQL.

## 3. Accepted Checkpoint

- Accepted checkpoint commit: `96101448a0ebc2d37bd981ddb1332226df8477ce`
- Commit subject at base: "Phase 1.6 M20.1 document identity mapping plan"
- This M20.3 document is additive and documentation-only; it modifies no existing file and creates no
  migration file.

## 4. Scope and Non-Goals

**In scope:** a written design for a future additive `identity_link` table — goals, conceptual shape,
constraint/index/RLS strategy, audit strategy, controlled admin provisioning, reconciliation note,
rollback/failure modes, and a future testing plan.

**Non-goals (explicit):** **this is migration planning only**; no migration is applied; no migration file
is created; no DDL/SQL is executed; no DB connection; no change to `platform_identity`, Firebase auth,
Supabase auth, session-resolve, or AccessContext; no runtime wiring; no enabling/running of live
authorization; no production work; no commit/push/backup as part of authoring.

## 5. M20.2 DB Readiness Carry-Forward

From the M20.2 read-only readiness (aggregates/metadata only):
- `platform_identity` is provider-aware; `internal_user_id` is the stable app-owned anchor; uniqueness on
  `(auth_provider, auth_provider_uid)`; `email`/`display_name` are descriptive only; **RLS enabled with
  zero client-facing policies**.
- No identity-linking table or column exists today.
- Aggregate distribution is tiny and dual-provider: total rows **3**; `supabase` **2**; `firebase` **1**;
  shared descriptive-email groups **1**; max shared-email group size **2**; duplicate
  `(auth_provider, auth_provider_uid)` groups **0**; duplicate `internal_user_id` groups **0**.
- The shared descriptive-email evidence is **corroborating only, never authority**.
- The DB is **migration-planning-ready, not implementation-ready**.

## 6. Migration Planning Objective

Design an additive linking layer that anchors on the existing stable `internal_user_id` and records a
**verified** correspondence between a Firebase provider reference and a Supabase provider reference,
without altering existing tables, without exposing provider identifiers to clients, and without changing
any authority path. Implementation, DDL application, and runtime integration remain out of scope and
unapproved.

## 7. Current Identity Model

- `internal_user_id` is the stable, app-owned anchor (decoupled from any external provider).
- `(auth_provider, auth_provider_uid)` is the unique external reference per row; each provider pair today
  yields its **own** `internal_user_id`.
- Email/display are descriptive only and not authority keys.
- The same human can therefore currently exist under multiple provider rows with distinct anchors and no
  link — the gap this design addresses.

## 8. Proposed `identity_link` Design Goals

11. Additive table only. 12. No ALTER to `platform_identity`. 13. Server-owned. 14. RLS enabled.
15. No client-facing policies by default. 16. Anchored on the stable `internal_user_id`. 17. Links a
**verified** Firebase provider reference to a **verified** Supabase provider reference. 18. Supports
controlled admin provisioning for the small existing set. 19. Supports a future verified-both-sides flow.
20. Supports rollback through a matching down migration. 21. Supports audit evidence for link
creation/change. 22. Does not expose provider IDs to client paths. 23. Does not change AccessContext.
24. Does not change session-resolve authority. 25. Does not make server authz authoritative. 26. Does not
make identity mapping active at runtime.

## 9. Proposed Table Shape — Conceptual Only

A future `identity_link` table is described **conceptually** (no SQL, no DDL):

- a **stable app-owned anchor reference** (pointing at the existing `internal_user_id`);
- a **Firebase provider reference** (provider label + the app's existing external-reference concept —
  never a raw value in this doc);
- a **Supabase provider reference** (provider label + external-reference concept);
- a **link status** (e.g., active / disabled / revoked) as a constrained label set;
- a **verification method / provenance** label (how each side was verified);
- **created / updated** timestamps;
- **linked_by / approved_by** provenance references (conceptual; app-owned actor references, never raw
  IDs here);
- **revoked / disabled** provenance and reason (conceptual);
- **uniqueness** so a single provider reference cannot link to multiple anchors, and so duplicate **active**
  links cannot exist;
- **lookup indexes** for the app-owned anchor and for each provider reference;
- **RLS enabled with no client policies** by default.

This section is descriptive design only. No table is created; no migration SQL is provided.

## 10. Provider Reference Model

Each side references an external provider by its **provider label** (source-level `firebase` / `supabase`)
plus the app's existing external-reference concept. Provider identifier **values** are never stored in
this document and, at implementation time, must never be exposed to client paths. The reference model
mirrors the existing `(auth_provider, auth_provider_uid)` discipline rather than introducing a raw
provider-id column to clients.

## 11. Stable App-Owned Anchor Model

The link anchors on the existing `internal_user_id`. The anchor remains the single source of app identity;
the link records that two verified provider references correspond to the **same** anchor. The anchor is
never replaced by a provider identifier.

## 12. Verified-Both-Sides Linking Requirement

A link may be created only when **both** the Firebase side and the Supabase side are verified from trusted
provider credentials (or via controlled admin provisioning that carries verified evidence for both). A
link must never be created from a single unverified side or from client-asserted data.

## 13. Why Email Is Corroborating Only

The M20.2 aggregates show a shared descriptive-email group (1 group, size 2). Email may be reused, change,
be unverified, or collide; it is nullable and non-unique. Email may be used only as a **corroborating
signal** during a verified linking decision — **never** as the linking authority or key.

## 14. Why Client-Asserted UID Is Not Authority

A client-supplied Firebase or Supabase UID must never be trusted as authority for linking. Identity
evidence must come from verified provider tokens/credentials or controlled, server-verified admin
provisioning — never from stored client state.

## 15. Additive Migration Strategy

The future migration would **add** a new table only. It introduces no change to existing rows or tables
and is safe to apply and to reverse. It would follow the established up/down migration pattern already
present in the repository.

## 16. No-ALTER-to-`platform_identity` Strategy

The design deliberately avoids altering `platform_identity` (no new column, no constraint change). The
link table references the existing anchor concept, keeping `platform_identity` stable and the change fully
additive and reversible.

## 17. Suggested Up Migration Contents — Design Only

Described in design language only (no executable SQL):
- create the additive link table with the conceptual fields in §9;
- apply the uniqueness rules (single-anchor per provider reference; no duplicate active link);
- create the lookup indexes;
- enable RLS with no client policies;
- keep an updated-at maintenance behavior consistent with existing tables.

No SQL is provided and no migration file is created in this milestone.

## 18. Suggested Down Migration Contents — Design Only

Described in design language only:
- safely remove the additive link table and its indexes/policies, leaving `platform_identity` and all
  other tables untouched. Because the change is purely additive, the down path is a clean removal.

## 19. Constraint and Index Strategy

- Uniqueness to prevent one provider reference from linking to multiple anchors.
- Uniqueness to prevent more than one **active** link for the same correspondence.
- Indexes for anchor-based lookup and for provider-reference-based lookup.
- A constrained status label set (active / disabled / revoked).

## 20. RLS / Client Policy Strategy

Mirror `platform_identity`: **RLS enabled, zero client-facing policies** by default. Only the server
owner-role path may read/write the link table. Provider references must never be exposed to client roles
or across tenants.

## 21. Audit Event Strategy

- Identity-link **creation / change / revocation** should be audited via the existing append-only writer.
- A **new audit event kind/category** should be planned for identity-link actions.
- Audit detail must be **redacted** — no raw provider UIDs/emails; record a safe action category and
  aggregate-safe context only.
- Audit volume is expected to be **low** (linking is rare and controlled).

## 22. Controlled Admin Provisioning Strategy

Given the tiny aggregate volume (3 rows; ~1 shared-email correspondence), **controlled admin
provisioning** is feasible as a complement to the link table: an admin establishes a link only with
**verified evidence for both** provider accounts, **never** using email as authority, and every action is
**auditable and reversible**.

## 23. Existing Aggregate Reconciliation Note

The one shared descriptive-email correspondence (group size 2) is the natural first candidate for a
**verified** link, but it must be confirmed by verified evidence on both sides (not by email alone) before
any link is created. Reconciliation of the existing small set should be a controlled, audited, reversible
step — designed here, not performed.

## 24. Rollback / Failure Mode Strategy

36. A wrong link is a cross-account access defect and must be prevented by verified-both-sides creation.
37. Link creation must be **reversible or disable-able** (status-based revoke/disable). 38. The down
migration must safely remove the additive table. 39. Runtime must continue to function without
`identity_link` because mapping is **not wired** yet. 40. Any link failure must **not** affect
Firebase/AccessContext authority.

## 25. Testing and Verification Plan — Future Only

For a future, separately-approved implementation milestone (not now): apply the additive migration in
DEV; verify the table exists with the intended constraints/indexes and RLS-no-policy; verify the down
migration cleanly removes it; verify (with synthetic, non-real references) that uniqueness prevents
multi-anchor and duplicate-active links; verify link actions emit redacted audit events; verify the app
continues to function with the table present but unwired. No tests are run in this milestone.

## 26. Runtime Integration Boundary

This design wires nothing. Even after a future migration, AccessContext and session-resolve authority
must remain unchanged until a separately-approved integration milestone. The dormant M11→M15 + M17.1
chain remains dormant.

## 27. Security / Redaction Boundary Confirmation

This document records only safe high-level conclusions, conceptual schema descriptions, source-level
provider labels, the M20.2 aggregate counts, and planning language. It contains **no** executable SQL, no
applyable migration content, no raw authorization DTO, no harness/feed/comparison output, no permission /
sub-permission / entitlement key names, no key arrays, no mismatch lists, no permission levels, no real
role names/IDs, no real tenant/store/plan/user IDs, no real Firebase/Supabase/provider UID values, no real
`internal_user_id` values, no email values, no token, no Authorization header, no request headers/body, no
raw response body, no DB URL, no service-role key, no anon-key value, no confirmation phrase value, no
request IDs, no actor UUIDs, no audit metadata, and no audit row dump.

## 28. Explicitly Forbidden Conclusions

This document does **not** claim: that identity mapping is implemented; that the migration is approved to
apply; that an `identity_link` table exists; that Firebase and Supabase identities are mapped; that email
is safe as identity authority; that a client-supplied UID is safe as authority; that the M17 Supabase
pilot user equals the Firebase app user; that active-context alignment is solved; that context hints are
safe now; that server authorization is advisory-ready beyond presence-only; that server authorization is
authoritative; that the frontend should consume server authorization now; that AccessContext should change
now; that session-resolve should change now; that Firebase session authority is replaced; that production
enablement is ready; or that M14/M15/M17.1 should be wired into runtime.

It affirms: this is migration planning only; no migration is applied; no migration file is created;
Firebase/legacy AccessContext remain authoritative; server-derived authorization remains
observational/comparable only; identity mapping is not implemented; email must not be identity authority;
client-asserted identity must not be authority; `internal_user_id` remains the app-owned stable anchor;
any future identity link must be server-owned, verified, auditable, reversible/disable-able, and
RLS-protected; the M11→M15 + M17.1 path remains dormant; and production remains blocked.

## 29. Recommended Next Milestones

- `Phase 1.6 M20.3 — Scoped Commit and Backup Authorization` (commit/back up this design, owner-gated).
- `Phase 1.6 M20.4 — Identity Link Migration Implementation (DEV-only, owner-approved)` — a future,
  separately-approved milestone that would create the additive migration file (up/down) and apply it in
  DEV only, with no runtime wiring. Subsequent steps (verified linking flow / controlled admin
  provisioning, then a separately-approved runtime integration) follow in order. None is approved now.

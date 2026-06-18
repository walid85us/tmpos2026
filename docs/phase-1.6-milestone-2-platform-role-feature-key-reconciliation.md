# Phase 1.6 M2 — Platform Role Vocabulary & Feature-Key Reconciliation (Strategy & Closeout)

**Status:** IMPLEMENTED — pending owner review / manual QA. Not committed, not pushed,
not backed up. No DB connection, migration, seed, SQL, audit write, Supabase MCP,
or production change occurred.

**Accepted base checkpoint:** `a4e3041343106bb44ffdd73f2ef89fe6871b268a`
(Phase 1.6 M1 — materialize permissions and capabilities).

---

## 1. Scope

M2 is a **backend-only catalog / documentation / diagnostic reconciliation** slice
(Option B from the accepted M2 planning pass). It closes the two truthfulness +
coverage gaps M1 explicitly deferred, **without** changing frontend behavior,
protected-API behavior, DB schema, runtime wiring, production state, or live
authorization behavior.

It reconciles and documents:

1. **Platform role vocabulary truthfulness** — the canonical durable vocabulary is
   already the contract vocabulary (migration 003, applied to DEV); the resolver
   header/comments were stale and are corrected.
2. **Feature-key normalization** — the `supply_chain ↔ supply-chain` naming split
   is formalized into an explicit, deterministic, idempotent, many-to-one
   normalization; unknown keys stay fail-closed; entitlements remain cap-only.

**Explicitly NOT in scope:** any `src/**` change (incl. `accessConfig.ts`,
`platformPermissionsConfig.ts`, AccessContext, AccessGuard, Login, App routing),
protected business APIs, authorization middleware, Backend Control Plane, Database
Operations Console, direct DB control, migrations, seeds, SQL, DB connections, live
/ DB-backed / audit-writer / session-resolve-live diagnostics, Supabase MCP,
`authz.v1` contract-shape changes, `permissionDecision.ts`, `package.json` /
`package-lock.json`, `.replit`, or production.

The disabled/default path of `/auth/session/resolve` continues to return
`authorization: null`; the DEV-only live authorization path is neither expanded nor
exercised.

---

## 2. Post-003 canonical platform role vocabulary

The single canonical platform-role vocabulary, shared across the durable DB
(migration 003), the M9 constants, the M1 catalog, and the frozen frontend engine:

| Canonical role | Legacy 002 id (superseded) | Status |
| --- | --- | --- |
| `system_owner` | `platform_owner` | first-class; legacy id has a compat fallback |
| `support_admin` | `platform_support` | first-class; legacy id has a compat fallback |
| `operations_admin` | `platform_ops` | first-class; legacy id has a compat fallback |
| `billing_admin` | *(none)* | first-class canonical; **no legacy id, no compat entry** |
| `security_admin` | *(none)* | first-class canonical; **no legacy id, no compat entry** |
| *(removed)* | `platform_admin` | **fail-closed by design** (ambiguous — no honest target) |
| *(removed)* | `platform_readonly` | **fail-closed by design** (read-only is modeled by status, not role) |

### Migration 003 / durable alignment

`server/platform-identity/migrations/003_platform_role_vocabulary_alignment.up.sql`
already drops the legacy 002 placeholder CHECK, forward-maps the three unambiguous
legacy ids to canonical, and re-adds a CHECK that admits exactly the five canonical
roles. Per `docs/phase-1.5-milestone-11.1.1-dev-003-applied.md` it is **APPLIED TO
DEV** (DEV durable tables were row-empty at apply; **production untouched**). The
dev bootstrap then inserts a platform membership with `role_id = 'system_owner'`.
M2 **adds no migration** — `billing_admin` / `security_admin` are already admitted
by the 003 CHECK and already defined in the catalog; `platform_admin` /
`platform_readonly` are already rejected by the 003 CHECK.

### Legacy 002 vocabulary (superseded)

The legacy 002 placeholder vocabulary (`platform_owner | platform_admin |
platform_ops | platform_support | platform_readonly`) is **superseded**. The
resolver header previously described it as the live durable state; that narration
is corrected in M2.

### Legacy compatibility map purpose

`PLATFORM_ROLE_COMPAT_MAP` (in the resolver) maps **only** the three unambiguous
legacy ids (`platform_owner → system_owner`, `platform_support → support_admin`,
`platform_ops → operations_admin`). Post-003, durable `role_id` is already
canonical and resolves **directly** (canonical-first); the compat map is now a
**legacy-compat fallback** for environments not yet confirmed on 003 (e.g.
production, which 003 has not touched). It is slated for removal once every
environment is confirmed on 003. It deliberately contains **no** entry for
`platform_admin`, `platform_readonly`, `billing_admin`, or `security_admin`.

- **`platform_admin` fail-closed rationale:** ambiguous — it has no single honest
  canonical target, so it is left out of the canonical vocabulary and fails closed
  (`denied_unresolvable_role`).
- **`platform_readonly` fail-closed rationale:** read-only is modeled by
  account/tenant/store **status** (`read_only` / `overdue` → resolver `limited`
  flag → catalog capping), not by a platform role; so there is no
  `platform_readonly` role and it fails closed.
- **`billing_admin` / `security_admin` support status:** first-class canonical
  roles — admitted by the 003 CHECK and fully defined in
  `PLATFORM_ROLE_FEATURE_DEFAULTS`. No legacy id exists for them and **none was
  invented**. They resolve directly and now have dedicated diagnostic coverage.

---

## 3. Feature-key normalization

### Canonical form

The canonical feature-key form **follows the frozen frontend `planFeatures` form**
(which the catalog gates already mirror). The sole known synonym today is the
supply-chain naming split: the tenant **domain id** is `supply_chain` (underscore)
while the `planFeatures` / entitlement **gate key** is `supply-chain` (hyphen).

### `supply_chain ↔ supply-chain` normalization

M2 adds an explicit declared alias map and a pure normalizer in the catalog:

- `FEATURE_KEY_ALIASES = { supply_chain: 'supply-chain' }` — `alias → canonical`.
- `normalizeFeatureKey(key)` — deterministic, idempotent
  (`normalize(normalize(k)) === normalize(k)`), and many-to-one **only** for
  declared aliases.

The tenant materializers build a canonical-keyed, OR-merged **view** of the
enabled-entitlement map (`normalizeEntitlements`) before testing gates, so a durable
`tenant_feature_entitlement.feature_key` stored under the underscore alias still
satisfies its canonical `supply-chain` gate. This is the **only** behavior delta in
M2 and it is cap-only.

### Unknown feature-key fail-closed behavior

An **unknown** key normalizes to **itself** and therefore still matches no known
gate — it can never enable a capability. Every alias **target** is itself canonical
(not an alias source key) and is a **known** catalog gate key, so normalization can
only line a key up with an **existing** gate, never invent one.

### Entitlement cap-only rule

Entitlements **reduce only; they never expand** role-derived permissions.
Normalization preserves this: it may only help a key match an existing gate. The
diagnostics prove that unknown keys (incl. a bogus `"supply chain"` with a space)
produce output **identical** to an empty entitlement map, and that adding the alias
enables **only** the supply_chain gate and nothing unrelated.

### Durable / frontend untouched

No durable `tenant_feature_entitlement.feature_key` value is migrated (the column is
free `text`, has no CHECK, and has **zero seeded rows** — there is no durable data
to reconcile), no `feature_key` CHECK constraint is added, and no frontend
`planFeatures` key is changed.

---

## 4. Files added

| File | Purpose |
| --- | --- |
| `scripts/diagnostics-platform-role-vocabulary-reconciliation-check.ts` | Offline static check: canonical vocabulary parity across constants ↔ catalog ↔ migration 003; `billing_admin`/`security_admin` first-class + catalog-defined; `platform_admin`/`platform_readonly` absent + fail-closed; compat map limited to the unambiguous legacy subset; resolver canonical-first / legacy-fallback / fail-closed. (21 checks) |
| `scripts/diagnostics-feature-key-canonicalization-check.ts` | Offline static check: `normalizeFeatureKey` deterministic/idempotent/many-to-one; canonical form = planFeatures form; unknown keys self-normalize + fail closed; gate keys canonical; supply_chain domain gated by `supply-chain` (canonical AND alias); cap-only (no expansion). (21 checks) |
| `docs/phase-1.6-milestone-2-platform-role-feature-key-reconciliation.md` | This document. |

## 5. Files modified

| File | Change |
| --- | --- |
| `server/platform-identity/permissionCatalog.ts` | **Additive + one safe behavior delta.** Added `FEATURE_KEY_ALIASES`, `normalizeFeatureKey`, and a private `normalizeEntitlements`; the two tenant materializers now normalize entitlement keys to canonical before gate testing (cap-only). Two doc-comments updated. Pure/inert preserved (no I/O, no `process.env`, no new imports, no frontend import). |
| `server/platform-identity/authorizationResolver.ts` | **Comments/header only — no logic change.** Vocabulary-drift header rewritten to describe the post-003 canonical durable vocabulary as current (002 = superseded legacy); `PLATFORM_ROLE_COMPAT_MAP` docstring reframed as a legacy-compat fallback. Deny path, fail-closed, status-before-role, materialization, and runtime wiring unchanged. |
| `scripts/diagnostics-authorization-permission-materialization-check.ts` | Added section 14: canonical platform ids (`system_owner`/`support_admin`/`operations_admin`) resolve **directly**; new `billing_admin` + `security_admin` materialization cases; `platform_admin`/`platform_readonly` still fail closed while canonical roles resolve. (37 → 43 checks) |
| `scripts/diagnostics-permission-catalog-static-check.ts` | Added sections 10–11: normalization-export invariants (idempotent/many-to-one/canonical targets/known-key) + platform-role parity (catalog ↔ constants; `billing_admin`/`security_admin` present; `platform_admin`/`platform_readonly` absent). (35 → 48 checks) |
| `docs/phase-1.6-permission-capability-materialization-strategy.md` | Truthfulness update: marks the platform-role + feature-key drift reconciled at the documentation/diagnostic level by M2; points here. |
| `replit.md` | One concise Phase 1.6 M2 pointer line (implemented / pending owner review). |

**Untouched** (confirmed): `src/**` (incl. `accessConfig.ts`,
`platformPermissionsConfig.ts`, AccessContext, AccessGuard, Login, App routing),
`permissionDecision.ts`, `sessionResolve.ts`, `sessionResolveContract.ts`,
`sessionAuthorizationService.ts`, `auditEventWriter.ts`,
`authorizationRepository.ts`, `authorizationContract.ts`,
`authorizationConstants.ts`, migrations, seeds, `package.json`,
`package-lock.json`, `.replit`.

---

## 6. Contract compatibility

No structural contract change. `authorizationVersion` stays `authz.v1`. No new
platform role token is added to the contract and no compatibility alias is promoted
into a contract value. The DTO shape (`ServerDerivedAuthorizationV1`) is unchanged.
Output carries only permission-level strings, sub-permission booleans, and the
existing safe role/scope/status/entitlement fields — no token, JWT, key, DB URL, or
secret. `diagnostics-authorization-contract-check` remains 12/12.

---

## 7. Diagnostics summary (this pass — non-live only)

| Command | Result |
| --- | --- |
| `npx tsc --noEmit` | 12 errors, all pre-existing unrelated files; **0 in any M2 file** |
| `npx tsx scripts/diagnostics-permission-catalog-static-check.ts` | **48/48** |
| `npx tsx scripts/diagnostics-authorization-permission-materialization-check.ts` | **43/43** |
| `npx tsx scripts/diagnostics-authorization-resolver-check.ts` | **27/27** |
| `npx tsx scripts/diagnostics-platform-role-vocabulary-reconciliation-check.ts` | **21/21** (new) |
| `npx tsx scripts/diagnostics-feature-key-canonicalization-check.ts` | **21/21** (new) |
| `npx tsx scripts/diagnostics-authorization-contract-check.ts` | **12/12** |
| `npx tsx scripts/diagnostics-session-resolve-contract-check.ts` | **15/15** |
| `npx tsx scripts/diagnostics-session-authorization-service-static-check.ts` | **30/30** |
| `npx tsx scripts/diagnostics-protected-action-check.ts` | **8/8** |

No live route diagnostic, DB-backed diagnostic, audit-writer live check, session
resolve live authorization route diagnostic, M11.2/M11.3/M11.4/M11.5 live check, or
DEV live materialization diagnostic was run. No DB connection was made; no SQL ran;
no Supabase MCP was used; no `audit_event` row was written.

---

## 8. Deferred items / follow-ups

- Removal of `PLATFORM_ROLE_COMPAT_MAP` — gated on all environments confirmed on 003
  (production migrated).
- Applying migration 003 to production (separate, owner-approved migration apply).
- Any durable `tenant_feature_entitlement.feature_key` CHECK and plan→entitlement
  durable materialization (separate, owner-approved).
- The M9 shared-catalog unification (single source imported by BOTH `src/` and
  `server/`).
- Protected business API enforcement; runtime wiring of authorization into
  `/auth/session/resolve`; Backend Control Plane; Database Operations Console /
  direct DB control. None start here.

---

## 9. Rollback plan

No DB rollback and no audit rollback are required (no migration, seed, SQL,
schema/RLS/Auth change, or DB/audit write occurred; static diagnostics write zero
audit rows). Code rollback:

1. Delete the two new diagnostics
   (`diagnostics-platform-role-vocabulary-reconciliation-check.ts`,
   `diagnostics-feature-key-canonicalization-check.ts`).
2. Delete this doc.
3. Revert the additive `permissionCatalog.ts` normalization helpers
   (`FEATURE_KEY_ALIASES`, `normalizeFeatureKey`, `normalizeEntitlements`) and the
   two materializers' `normalizeEntitlements(...)` calls + the two comment edits.
4. Revert the `authorizationResolver.ts` comment/header edits.
5. Revert the materialization-check (section 14) and catalog static-check
   (sections 10–11) additions.
6. Revert the truthfulness edits in
   `docs/phase-1.6-permission-capability-materialization-strategy.md`.
7. Revert the `replit.md` M2 pointer line.

Equivalently, `git checkout a4e3041 -- <paths>` / remove the untracked new files.

---

## 10. No-forbidden-action confirmation

No migration added/applied; no seed added/run; no rollback run; no SQL; no DB
connection; no Supabase MCP; no production touched; no Supabase schema/RLS/Auth
change; no Firebase/Firestore change; no frontend change; no AccessContext change;
no protected business API; no Backend Control Plane; no Database Operations Console;
no direct DB control; no `package.json` / `package-lock.json` change; no `.replit`
change; no secret printed; no `audit_event` write; no commit; no push; no backup.

# Phase 2.0 M6 — Firebase vs Supabase Auth / Session Parity Review

**Status:** Documentation/review-only · Parity review before any live read-only pilot (no code, auth, live session authorization, Supabase enablement, or cutover)
**Accepted checkpoint at authoring:** `796e9dae6e9471f59b998743da57d1c835d80fe0` (Phase 2.0 M5)
**Authoring milestone:** Phase 2.0 M6

> Redaction-first document. Contains no real tenant/store/customer data, raw UIDs,
> raw emails, domains, tenant/store IDs, row dumps, DB URLs, tokens, secrets,
> provider credentials, permission/entitlement key lists, mismatch lists, raw auth
> claims, or raw `identity_link` rows. This milestone makes no runtime, route,
> auth, DB, Supabase, DTO, type, read-model, mapper, test, fixture, or Backend
> Control Panel (BCP) UI change, and enables no live session authorization or
> Supabase auth. Nothing is staged, committed, pushed, or backed up.

---

## 1. Executive Summary

This is a **documentation/review-only** milestone. It reviews and documents the parity requirements between the **current Firebase / legacy AccessContext frontend authority plane** and the **future, dormant server-derived authorization plane** that a Backend Control Panel (BCP) live read-only pilot would depend on. It defines which attributes must match, which parity checks are required, which gaps remain, which claims must never become authority, and what must stay blocked until parity is proven.

This milestone **does not** enable Supabase auth, enable live session authorization, create BCP live read APIs, or approve any cutover. It grounds its analysis in existing code/docs (read-only) and changes nothing. The current code confirms the prior posture: every server-side identity/authorization flag is **default-OFF and non-production-only**, the dormant `/auth/session/resolve` path derives authority **only** from a verified bearer token (never the request body), and a null server authorization means the legacy frontend engine remains authoritative.

## 2. Current State and Boundary

- **Firebase / legacy AccessContext remains the current frontend/app authority.**
- **Server-derived authorization remains dormant / readiness-gated** (default-off flags, non-production-only).
- The **BCP remains mock-only and is not live-read-only**; it is DEV-gated at `/dev/backend-control-plane`, frontend-only, read-only, and code-split.
- **Supabase is not ready for a Firebase cutover.**
- No BCP live read APIs exist; no BCP live pilot is authorized.
- **M6 determines parity requirements and readiness gaps only.** Controlled actions remain Phase 3; production readiness remains Phase 4.
- Prior milestones complete: M1 (architecture/gates), M2 (contract map; C-01..C-09 placeholders), M2.1 (authority-plane reconciliation), M3 (already-redacted DTO envelope + empty-state design), M4 (redaction/masking/evidence rules), M5 (isolation/RBAC visibility test plan).

## 3. Two Authority Planes

| | Frontend / app authority plane | Server-side BCP read authorization plane |
|---|---|---|
| **Timeframe** | **Current** | **Future / dormant** |
| **Authority source** | Firebase auth + legacy AccessContext (Firestore-backed role/plan/status/tenant) | Server-derived authorization principal anchored on `internal_user_id`, provider-aware |
| **Status** | Live and authoritative for the application UI | Readiness-gated; default-off; non-production-only; shadow/comparable-only |
| **Authority input** | Firebase session (frontend) | Verified bearer token only; request body never read for authority |
| **Used by BCP live read APIs?** | Must **not** be the final server authorization authority | Yes, **after** parity/safety gates pass |

The two planes must **not** be conflated. The frontend plane governs what the application UI shows today; the server plane is what a future BCP read API would authorize against. A Firebase frontend claim is an application-session fact, **not** a server-side authorization decision for BCP reads. Treating one as the other is the central risk this review guards against (see §18 R-1).

## 4. Current Firebase / Legacy AccessContext Authority Review

Grounded in `src/context/AccessContext.tsx` and `src/context/accessConfig.ts` (read-only; characterized, not dumped):

- **Authenticated user posture** — established via Firebase auth state, with a Firestore-backed profile record resolved into an app session.
- **Frontend session continuity** — the app session carries a user posture, a user type (platform vs. tenant), a role, and an account status (active / invited / suspended / pending setup).
- **User/role/access context consumed by UI** — a permission hierarchy, permission domains, sub-permissions, and plan-feature gating drive what the UI renders and allows.
- **Tenant / store hints** — tenant posture (plan, account status, onboarding stage) and store-scoped local state are present in the frontend context.
- **Current app gating behavior** — route/feature gating is performed in the frontend by AccessContext for the normal SaaS application.

This plane is the **current** authority for the application. No raw UIDs, emails, tenant IDs, store IDs, or permission keys are reproduced here; only the posture is characterized.

## 5. Server-Derived Authorization Path Review

Grounded in `server/platform-identity/*` (read-only; characterized, not dumped):

- **`platform_identity` anchoring** — the server model anchors on an app-owned `internal_user_id`, resolved/created fail-closed; a verified token with no resolved internal id is treated as token-verified (not authenticated).
- **Provider-aware mapping** — provider identity is mapped to the internal anchor; provider identity by itself is never authority.
- **Server-side session authorization service** — a single composition seam derives a default session authorization; the route never imports the repository, audit writer, or resolver directly.
- **`/auth/session/resolve` readiness path** — a dev-only, default-off prototype handler. Binding invariant: the **only** authority input is `Authorization: Bearer <token>`; the request body is never read for authority (any role/tenant/store/permission/metadata/internal-id on it is ignored). Live authorization is derived **server-side from the durable identity key only**.
- **Dormant Supabase token bridge / shadow posture** — shadow comparison helpers exist but are pure, synchronous, no-throw, synthetic-input-only, and dormant (imported by nothing active, tree-shaken from production). They compare **key-space coverage only** and are explicitly **comparable, not authoritative**; `authorization: null` means the legacy client engine remains authoritative.
- **Default-off flags** — `ENABLE_SUPABASE_PLATFORM_IDENTITY`, `ENABLE_SESSION_RESOLVE`, `ENABLE_LIVE_SESSION_AUTHORIZATION`, and the verified-diagnostics flag are all default-off and non-production-only; the frontend pilot/shadow flags are DEV-only and default-off. All gates must hold simultaneously for any path to activate.
- **Readiness-only status** — this path is **not live and not accepted as live**. It is reviewed here as a readiness foundation only.

## 6. Parity Dimensions

The dimensions that must be compared between the two planes before any live pilot:

- Identity subject parity
- `internal_user_id` continuity
- Provider identity mapping parity
- Tenant scope parity
- Store scope parity
- Role parity
- Permission / capability parity
- Sensitive-view parity
- Cross-tenant visibility parity
- Plan / entitlement visibility parity
- Audit / evidence visibility parity
- Session freshness parity
- Session expiration / revocation parity
- Disabled / deactivated user parity
- Denied-state parity
- Empty-state parity
- Redaction parity

## 7. Non-Authority Claims

The following must **never** become final authority for BCP read authorization:

- Client-supplied UID
- Email address
- Frontend-only role label
- Frontend-only tenant/store selection
- URL parameter tenant/store value
- `localStorage` / `sessionStorage` value
- Display label
- Mock fixture value
- `identity_link` row presence
- Unverified Supabase claim
- Unverified Firebase claim in a server context

Each of these is an **input or a hint**, never an authority. The server authorization decision derives from the verified token resolved to the durable `internal_user_id` and the server-side authorization model only.

## 8. Parity Review Matrix

Safe labels only. Status reflects this documentation review, not any live test.

| Dimension | Firebase / current frontend source | Future server-derived source | Required equality / compatibility rule | Evidence required | Redaction requirement | Status | Blocker / next action |
|---|---|---|---|---|---|---|---|
| Identity subject | Firebase user posture | Verified token → `internal_user_id` | Must resolve to the same durable subject | `safe_summary` | No raw UID/email | Partial | Prove subject continuity under parity test (M7-gate) |
| `internal_user_id` continuity | App session id posture | Durable app-owned anchor | Same anchor across planes | `safe_summary` | No raw ids | Partial | Continuity test required |
| Provider mapping | Firebase provider posture | Provider-aware mapping to anchor | Provider maps to same anchor; provider ≠ authority | `safe_summary` | No raw provider UID | Partial | Mapping parity test required |
| Tenant scope | Frontend tenant posture | Server-resolved tenant scope | Same tenant scope, server-resolved | `aggregate_only` | No raw tenant id | Partial | Server-side scope resolution test |
| Store scope | Frontend store posture | Server-resolved store scope | Same store scope, server-resolved | `aggregate_only` | No raw store id | Partial | Server-side scope resolution test |
| Role | Frontend role label | Server role materialization | Compatible role semantics | `safe_summary` | No raw role dump | Partial | Role parity test |
| Permission / capability | Frontend permission vocabulary | Server capability materialization | Key-space compatible; fail closed on unknown | `aggregate_only` | No key lists | Partial | Key-space parity (shadow compares keys only) |
| Sensitive-view | Frontend gating | Server sensitive permission | Stronger permission required server-side | `safe_summary` | No raw keys | Blocked | Sensitive-view parity must fail closed |
| Cross-tenant visibility | Not a frontend concern | Explicit platform permission | Aggregate + explicit permission only | `aggregate_only` | No raw ids | Blocked | Requires explicit platform permission design |
| Plan / entitlement visibility | Frontend plan posture | Server plan/entitlement posture | Posture-compatible; no entitlement dumps | `safe_summary` | No entitlement keys | Partial | Blocked-on-schema for billing (C-07) |
| Audit / evidence visibility | None (frontend) | Server redacted aggregate (C-04) | Redacted aggregate only | `aggregate_only` | No raw events/actors | Partial | Net-new audit read aggregate |
| Session freshness | Firebase session freshness | Server token freshness | Compatible freshness semantics | `safe_summary` | No raw timestamps if sensitive | Partial | Freshness parity test |
| Expiration / revocation | Firebase expiry/revoke | Server token expiry/revoke | Revocation honored on both | `safe_summary` | None sensitive | Partial | Revocation parity test |
| Disabled / deactivated user | Frontend status | Server fail-closed deny | Disabled ⇒ deny on both | `safe_summary` | None sensitive | Partial | Disabled-user parity test |
| Denied-state | Frontend gating | Server fail-closed denial | Uniform, non-revealing | `safe_summary` | No existence leak | Partial | Denied-state parity test |
| Empty-state | Mock empty handling | Server safe empty status | Indistinguishable empty vs hidden | `safe_summary` | No existence leak | Partial | Empty-state parity test |
| Redaction | UI-side (not a boundary) | Server-side redaction (M4) | Server-side only; no UI security filtering | `safe_summary` | All M4 rules | Partial | Redaction parity test |

No dimension is marked **Ready**; this is a planning review, not a passed test run. "Partial" means the foundation exists but requires a parity test before pilot; "Blocked" means it must not advance without explicit design/permission.

## 9. Backend CP Contract Impact Matrix

Contract/endpoint names remain proposed placeholders; nothing is implemented.

| Contract | Needs server-derived principal? | Tenant/store scope dependency | Sensitive permission dependency | Parity dependency | Pilot readiness impact | Stop condition if parity fails |
|---|---|---|---|---|---|---|
| C-01 Readiness summary | Yes (read authz) | Low | No | Identity + denied/empty parity | Wave 1 candidate | Block if subject/denied parity unproven |
| C-02 System operations summary | Yes | Low | No | Identity + redaction parity | Wave 1 candidate | Block if redaction parity unproven |
| C-03 Support diagnostics summary | Yes | Conditional | Moderate | Scope + redaction parity | Wave 1 candidate (gated) | Block if scope parity unproven |
| C-04 Audit visibility | Yes | Tenant-scoped | **Yes** | Sensitive-view + audit parity | Sensitive; later wave | Block if sensitive-view parity unproven |
| C-05 Configuration posture | Yes | No | **Yes** | Sensitive-view parity | Deferred/blocked | Block; config/secrets stays blocked |
| C-06 Tenant / store posture | Yes | **Tenant + store** | Yes | Tenant/store scope parity | Blocked-on-schema | Block if scope parity unproven or cross-tenant risk |
| C-07 Billing / plan posture | Yes | Tenant-scoped | **Yes** | Plan/entitlement + sensitive parity | Blocked-on-schema | Block if payment/entitlement exposure risk |
| C-08 Data governance posture | Yes | Conditional | Sensitive | Redaction + evidence parity | Later wave | Block if row/mismatch exposure risk |
| C-09 Identity readiness posture | Yes (posture) | No | **Yes** | Identity + M20 posture parity | Posture-only | Block if raw identity exposure or cutover implied |

**"Wave 1 candidate" is not "cleared for pilot."** A contract listed as a candidate (e.g. C-01 / C-02) is only *eligible* to be considered first; it advances to the pilot **only after** its own scope-denial, isolation, redaction, and denied/empty-state parity tests pass. No candidate is implied to be safe before those tests pass.

## 10. Tenant / Store Scope Parity

Before any live pilot, tenant/store scope parity must be proven with:

- **Server-side scope resolution** from the authenticated principal (never client-asserted).
- **No client-side filtering as a security boundary.**
- **No cross-tenant leakage** — tenant A cannot see tenant B; store A cannot see store B.
- **Safe denied/empty state** — unauthorized or non-existent scope yields an indistinguishable safe status.
- **Redacted evidence only** — aggregate/safe-summary evidence; no raw tenant/store IDs.

## 11. RBAC / Permission Parity

Role/permission/capability parity must be proven with:

- **No raw permission key exposure.**
- **No entitlement key dump.**
- **Sensitive-view fail closed** — sensitive sections deny unless explicitly permitted.
- **Cross-tenant visibility fail closed** — denied unless an explicit platform permission is present.
- **Platform / system-owner read-only posture** — broad read-only visibility still carries no action rights.
- **No Phase 3 action permission implied** by any read visibility.

The existing shadow comparison helper compares **key-space coverage only** (permission / sub-permission / entitlement key names and counts), reports unknown server keys as a mismatch, and never fails open — this is the intended parity primitive for the permission dimension, and it is comparable-only, never authoritative.

**Key-space parity is necessary but not sufficient.** Matching key names does not prove permission-*level* semantics, allow/deny behavior, sensitive-view enforcement, plan/entitlement *meaning*, or stale-role denial. RBAC parity sign-off therefore requires the key-space comparison **plus** behavioral parity tests for permission level, sensitive-view fail-closed, entitlement semantics, and role/scope-change reflection. Any mismatch evidence must report presence/counts only — never raw permission, entitlement, or server key names.

## 12. Session Lifecycle Parity

Parity must be reviewed across the full session lifecycle:

- **Session freshness** — frontend session vs. server token freshness semantics compatible.
- **Expiration** — expiry honored on both planes.
- **Revocation** — a revoked session/token denies on both planes.
- **Disabled users** — a disabled/deactivated user fails closed (deny) on both planes.
- **Changed roles** — a role change is reflected without stale elevation.
- **Changed tenant/store scope** — a scope change is reflected without stale cross-scope access.
- **Stale frontend context** — a stale frontend session must not grant server authority.
- **Stale server context** — a stale server decision must not outlive revocation.

## 13. Identity Readiness and M20 Posture

- `identity_link` schema **exists / applied in DEV as a schema-only foundation**.
- `identity_link` is **RLS-protected**.
- `identity_link` **rows are not exposed** (and are not exposed to the BCP).
- `identity_link` **write/control exercise remains blocked/paused**.
- Service / repository / audit adapters are **built and tested but dormant/unwired**.
- **No identity-link provisioning is authorized.**
- **C-09 must report readiness posture only** (safe labels), never raw identity data.

## 14. Supabase Cutover Boundary

- This milestone **does not approve a Supabase cutover**.
- **Supabase remains not ready for a Firebase cutover.**
- **Cutover readiness is a later milestone (M8).**
- M6 only defines the **parity review and the blockers** for the M7 live read-only pilot.

## 15. Evidence and Redaction Requirements

- **Only redacted evidence** (per M4 evidence modes: `safe_summary`, `aggregate_only`, `redacted_snapshot`, or `blocked`).
- **No raw UIDs.**
- **No raw emails.**
- **No raw tenant/store IDs.**
- **No raw `identity_link` rows.**
- **No raw permission/entitlement keys.**
- **No raw mismatch lists.**
- **Aggregate or `safe_summary` evidence only** for parity sign-off; evidence proves parity/denial without leaking subjects.

## 16. Required Future Parity Tests

Future tests (planned here; none run in this milestone):

- Identity subject parity test
- `internal_user_id` continuity test
- Provider mapping parity test
- Tenant scope parity test
- Store scope parity test
- Role parity test
- Permission / capability parity test
- Sensitive-view parity test
- Cross-tenant visibility parity test
- Session freshness / expiration / revocation tests
- Disabled-user tests
- Denied-state and empty-state tests
- Redaction / evidence tests
- No-mutation tests
- No-production tests

## 17. Manual Review Checklist

A future reviewer must confirm all of the following before approving M7 readiness:

- [ ] No auth authority ambiguity (the two planes are not conflated).
- [ ] No client UID / email authority.
- [ ] No unreviewed Supabase claim treated as authority.
- [ ] No parity mismatch left unresolved.
- [ ] No tenant/store isolation uncertainty.
- [ ] No sensitive-view uncertainty.
- [ ] No redaction/evidence gap.
- [ ] No production exposure.
- [ ] No BCP backend-action exposure.

## 18. Risk Register

Safe labels only. Status reflects this review.

| ID | Risk | Severity | Mitigation | Status |
|---|---|---|---|---|
| R-1 | Authority-plane conflation (Firebase frontend claim treated as server authority) | High | Keep planes distinct; server authz from token→`internal_user_id` only | Mitigated by design; verify in parity tests |
| R-2 | Partial parity accepted as full | High | No dimension marked Ready without a passed test; pilot gated | Open until M7-gate tests |
| R-3 | Stale frontend session grants server authority | Medium | Server revalidates; stale frontend never authoritative | Mitigated by design |
| R-4 | Stale server session outlives revocation | Medium | Honor expiry/revocation server-side | Open until revocation test |
| R-5 | Identity mapping mismatch | High | Provider-aware mapping to durable anchor; fail closed | Open until mapping test |
| R-6 | Tenant/store scope mismatch | High | Server-side scope resolution; negative tests | Open until scope tests |
| R-7 | RBAC mismatch | Medium | Key-space parity; unknown keys = mismatch, fail closed | Open until permission test |
| R-8 | Sensitive-view overexposure | High | Stronger permission; fail closed; redaction | Blocked until sensitive-view parity |
| R-9 | Cutover confusion (parity read as cutover-ready) | Medium | Explicit "no cutover" boundary (§14) | Mitigated by documentation |
| R-10 | Evidence leakage | High | Redacted/aggregate evidence only (M4) | Mitigated by rules; verify in tests |
| R-11 | Premature pilot before parity | High | M6 precedes M7; pilot gated (§19) | Mitigated by ordering |

## 19. M7 Readiness Gate

The M7 live read-only pilot may start later **only** when all of the following hold:

- This parity review is **accepted and backed up**.
- **No unresolved HIGH parity gaps, and no open MEDIUM parity gap for any piloted contract** (revocation, RBAC behavioral parity, session freshness, and cutover-confusion items must each be explicitly closed for the contracts in scope, not deferred).
- A **tenant/store isolation plan exists** (M5 — present) **and its scope-denial tests pass for each piloted contract**.
- **Redaction/evidence rules exist** (M4 — present).
- **The enumerated §16 parity tests pass for the pilot scope** — readiness is established by named passing tests, not by a general sufficiency judgment.
- The pilot **remains DEV-only**.
- **No production exposure.**
- **No backend actions.**
- **No Supabase cutover claim.**

## 20. Stop Conditions

Halt and reassess if any of the following arise:

- Parity cannot be described without raw IDs.
- A client UID or email would be authority.
- The Firebase subject and the server-derived subject cannot be reconciled safely.
- Tenant/store scope parity is unknown.
- RBAC parity is unknown.
- Sensitive-view parity is unknown.
- Evidence would require raw mismatch lists.
- `identity_link` rows would need exposure.
- A Supabase cutover would be required.
- A live pilot before parity would be assumed.
- Production exposure would be required.
- Mutation / backend actions would be required.

## 21. Acceptance Criteria

This milestone is acceptable when:

- The single documentation file exists under `docs/` and is redaction-safe.
- It defines the two authority planes (§3) and reviews both the current Firebase/AccessContext plane (§4) and the dormant server-derived plane (§5), grounded in existing code without exposing raw values.
- It defines parity dimensions (§6), non-authority claims (§7), the parity review matrix (§8), and the contract impact matrix (§9).
- It defines tenant/store scope parity (§10), RBAC/permission parity (§11), session lifecycle parity (§12), identity readiness/M20 posture (§13), the Supabase cutover boundary (§14), evidence/redaction requirements (§15), future parity tests (§16), the manual review checklist (§17), the risk register (§18), the M7 readiness gate (§19), and stop conditions (§20).
- It preserves the M2.1 two-authority-plane assumptions, the M3 already-redacted DTO envelope + empty-state assumptions, and the M4/M5 redaction/isolation assumptions.
- It claims **no** live session authorization, **no** Supabase auth enablement, **no** live readiness, **no** production readiness, and **no** Supabase cutover readiness.
- No runtime, route, auth, DB, Supabase, DTO, type, read-model, mapper, test, or fixture change was made; nothing was staged, committed, pushed, or backed up.

## 22. Recommended Next Milestone

**Phase 2.0 M7 — Backend CP Live Read-Only Pilot Readiness Gate, DEV-only** — *only after* M6 is accepted, committed, and backed up. Do not start M7 here.

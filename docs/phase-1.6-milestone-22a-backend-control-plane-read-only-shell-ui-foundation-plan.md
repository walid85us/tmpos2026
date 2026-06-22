# Phase 1.6 — Milestone 22A: Backend Control Plane Read-Only Shell / UI Foundation Plan (Planning-Only)

## 1. Title

Phase 1.6 Milestone 22A — Backend Control Plane (BCP) Read-Only Shell / UI Foundation Planning: how to scope, constrain, build, test, review, and back up the future M22B read-only/mock-only UI foundation (planning-only; no UI; no routes; no API; no backend/frontend/database runtime change; non-authoritative).

## 2. Purpose

Define, in a single repository-durable and redaction-safe planning document, exactly how the **future** M22B implementation of the Backend Control Plane read-only shell / UI foundation should be scoped, constrained, structured, themed, tested, reviewed, and backed up — derived strictly from the accepted M21 charter/architecture. This milestone (M22A) is **planning only**: it implements no UI, no React components, no routes, no API endpoints; changes no backend or frontend runtime; adds no database code; opens no DB connection; runs no SQL; inserts no rows; changes no authorization behavior; wires no identity-link functionality; and performs no stage/commit/push/backup.

## 3. Repository Checkpoint

- Accepted checkpoint at authoring time: `5554a0007aa786e91d330ad59282f239f3a45d8a`.
- Most recent commit subject at base: "Phase 1.6 M21 document backend control plane architecture plan".
- Accepted status carried forward: M20.10, M20.11, M20.12, and M21 all ACCEPTED/COMPLETE/BACKED UP.
- This M22A plan is additive documentation only; it modifies no existing file and inserts no data.

## 4. Scope and Non-Goals

**In scope:** a written plan that defines the M22B read-only/mock-only shell scope, the separation strategy, route/page placement *options* (planning only), the access-gate and global-shell UI foundation, navigation/IA, mock-data and safe-placeholder rules, the badge/state model, environment/production-lock/mode UI, mock-only RBAC/scoped-access/approval/audit display models, per-module representation decisions, visual direction carry-forward, component/styling *options*, accessibility/responsiveness requirements, enforcement rules (no backend action, no secrets, no raw identifiers), testing/manual-QA/acceptance criteria for M22B, forbidden M22B scope, recommended M22B file *boundaries* (planning only), and risks/mitigations.

**Non-goals (explicit):** no UI built; no React components; no routes; no API endpoints; no backend/frontend runtime change; no database code; no DB connection; no SQL; no rows; no migration applied/modified; no seeds; no package changes; no authorization behavior change; no identity-link wiring; no `audit_event`/`identity_link` write; no Supabase MCP; no production target; no stage/commit/push/backup as part of authoring. M22A does **not** build the shell; it plans M22B.

## 5. M21 Carry-Forward

M21 is the **source of truth**. This plan derives from it and does not expand beyond it. Carried forward from M21:

- The BCP is both a governance/control layer and a trusted operations UI, and must be **separate** from the Owner Platform (separate gate, shell, navigation, RBAC, owner-granted scoped access, approval/SoD, immutable redacted audit, environment guardrails, production blockers, read-only-first, state model).
- The M21 module inventory (22 governance modules) plus the Separate Access Gate as a screen.
- The M21 action-safety model (read-only / request-only / approval-required / SoD-required / DEV-only / staging-limited / production-blocked / future-only / emergency-only / forbidden).
- The M21 state model (Current / Planned / Future / Dormant / Read-Only-First / Production-Blocked).
- The M21 visual direction (premium dark command-center shell; separate secure gate; topology diagrams; high-density cards/tables; neon status; guarded buttons; environment badges; production lock; read-only/elevated mode; approval queue; immutable audit timeline; isolation map; safety footer).
- The M21 first-implementation boundary: "Backend Control Plane — Read-Only Shell / UI Foundation" = UI-only/mock-only; this M22A defines how that becomes M22B.

## 6. Current Project Safety Boundaries

All accepted boundaries remain true and are preserved by this milestone:

- Firebase / legacy AccessContext remains **authoritative** in the current app.
- Server-derived authorization remains **observational / comparable only**.
- Identity mapping remains **inactive and unwired**.
- M11 through M15 and M17.1 remain **dormant**.
- The M20.11 identity-link admin provisioning service remains **server-only, default-OFF, dependency-injected, and imported only by its own test**.
- The M20.12 repository/audit adapter plan remains **planning only**; no adapter is implemented.
- DEV `identity_link` remains **empty, RLS-protected, zero client policies, zero client-role grants**; no rows inserted; no `audit_event` rows from this track.
- Self-service identity linking remains **deferred**.
- Production remains **blocked**.
- Email must **never** be identity authority; client-asserted UID must **never** be authority; `internal_user_id` remains the **app-owned stable anchor**.
- The Backend Control Plane remains **planning-only** until a separately-approved implementation begins.

## 7. M22A Planning Objective

Produce a precise, safe blueprint that lets a future M22B be executed with zero ambiguity and zero risk to the current platform: define what M22B includes, what it must never include, how its mock data and placeholders are constrained, how each module is represented (included / placeholder / deferred / blocked), how it is themed and structured, how it is tested and QA'd, what its acceptance criteria are, and how it is backed up. The objective is a **read-only-first** foundation that is visibly separate, visibly non-authoritative, and visibly honest about capability maturity.

## 8. M22B Proposed Implementation Boundary

M22B (the next implementation milestone, only after separate approval) must be limited to:

- A **separate** Backend Control Plane shell (distinct workspace identity, not merged into Owner Platform nav).
- A **separate access-gate screen** rendered as a mock/read-only visual shell (no real authentication wiring, no session creation, no secret/identifier display).
- **Route/page placement proposal only** — actual placement is decided and approved within M22B itself, not assumed here.
- **Mock data only**; static read-only UI panels; no real DB data.
- **No** real backend actions, real API calls, real identity-link writes, migration execution, service/worker restart, tenant/store DB creation, backup restore, or production unlock.
- **No** change to current Owner Platform behavior or runtime authorization; **no** AccessContext or sessionResolve change; **no** runtime identity mapping.

M22B is read-only/mock-only unless separately approved otherwise.

## 9. Separate Backend Control Plane Shell Strategy

- M22B builds a distinct shell with its own visual identity ("Obsidian / Nexus / Guardian Core" atmosphere), its own layout chrome (top environment banner, left nav rail, main content region, right context drawer, bottom safety footer), and its own state-chip vocabulary.
- The shell must be **self-evidently separate**: a distinct name/branding region, a distinct color/theme treatment, and a persistent safety footer ("Separate Secure Workspace", "RLS Protected", "Masked Connection") so an operator can never confuse it with the Owner Platform.
- The shell is **presentational only** in M22B: it renders mock state and navigates between mock screens; it performs no data fetching from real backends and no mutations.

## 10. Separation From Owner Platform Strategy

- The BCP shell must **not** be merged into the current owner-facing platform navigation, layout, or auth.
- M22B must not modify AccessContext, Login, AccessGuard, App routing behavior, `src/main.tsx`, or `src/pilot/**` in any way that changes current platform behavior. (Placement options in §11 are constrained so they cannot alter current behavior.)
- The BCP must have a **separate secure workspace identity** conceptually; in M22B this is a mock/visual gate only — no real session, no real authority, no coupling to the app's Firebase/AccessContext authority.
- The current app's authority model is unchanged; standing up the mock shell makes nothing authoritative and wires no dormant capability.

## 11. Route / Page Placement Options — Planning Only

These are **options for M22B to choose and get separately approved**, not decisions made here. Each option is described with its separation/safety implications; none is implemented in M22A.

- **Option R1 — Isolated standalone shell (recommended for maximum separation):** the BCP shell lives as its own self-contained surface that does not share the Owner Platform's primary navigation or layout chrome. Strongest separation; clearest "separate workspace" guarantee.
- **Option R2 — Separate gated path within the same app build:** a distinct, clearly-separated path/area with its own shell, explicitly excluded from Owner Platform navigation, reachable only by an explicit, separately-approved entry. Separation must be enforced so it never appears in owner-facing nav and never changes current behavior.
- **Option R3 — Separate build/workspace target (future):** the BCP as its own deployable surface entirely outside the Owner Platform bundle. Highest isolation; larger M22B scope; likely Future.

Constraints common to all options: must not alter current Owner Platform behavior, must not change current authorization, must not appear in owner-facing navigation, and must be selected and approved explicitly within M22B before any file is created.

## 12. Access Gate UI Foundation Plan

- A mock/read-only access-gate screen rendering the secure-workspace atmosphere, a granted-scope **summary placeholder** (opaque), and a read-only vs elevated **mode toggle (visual only)**.
- Role-profile access **cards** (mock) illustrating the conceptual role set (labels only).
- **No** real authentication, **no** session creation, **no** credential entry that does anything, **no** secret/token/identifier display.
- Badges: environment (DEV/STAGING/PRODUCTION), production lock, mode — all visual placeholders.

## 13. Global Shell UI Foundation Plan

- **Top environment banner:** current environment chip (mock), production-lock indicator (mock), read-only/elevated mode indicator (mock).
- **Left navigation rail:** module groups (Overview; Tenancy & Data; Platform Operations; Identity & Security; Governance; Delivery; Operator; Settings) with module entries.
- **Command palette:** navigation/filter only (no actions) — optional in M22B, may be a placeholder.
- **Main content region:** high-density mock cards, tables, panels, and topology placeholders per screen.
- **Right context drawer:** mock selection details and redacted-evidence placeholders.
- **Bottom safety footer:** persistent "Separate Secure Workspace / RLS Protected / Masked Connection".
- Shell invariants in M22B: environment indicator, mode indicator, production lock, and safety footer always visible; no secret/raw-identifier ever rendered.

## 14. Navigation and IA Foundation Plan

- The nav mirrors the M21 IA groups exactly (Overview; Tenancy & Data; Platform Operations; Identity & Security; Governance; Delivery; Operator; Settings).
- Every screen defaults to its **read-only** view; no write/approval affordances are functional in M22B (any such control is a disabled/guarded visual placeholder labeled with its state chip).
- Environment scope is a global selector (mock) applied visually across screens.
- IA honesty: each screen/module shows its accurate state chip (Current / Planned / Future / Dormant / Read-Only-First / Production-Blocked).

## 15. Mock Data Strategy

- M22B uses **only** static, in-memory mock data defined in the UI layer (no fetching, no backend, no DB).
- Mock data is **clearly fictional** and redaction-safe (see §16); it never resembles real identifiers, secrets, or payloads.
- Mock data is **shaped** to demonstrate the UI (e.g., a few tenants, stores, services, queue states, audit timeline entries, approval-queue entries) but conveys only safe categories/booleans/labels.
- No mock value implies a real connection string, token, UID, email, domain, IP, request ID, or actor UUID.

## 16. Safe Placeholder Data Rules

M22B must use only safe mock labels such as: Tenant Alpha; Tenant Beta; Tenant Gamma; Store 001; Store 002; Store 003; DEV; STAGING; PRODUCTION; DB Healthy; Migration Pending; Approval Required; Production Blocked; RLS Protected; Masked Connection; Redacted Evidence; Opaque Reference; Service Healthy; Queue Warning; Role Placeholder; Actor Redacted; Event Redacted.

M22B must **not** use: real emails; real user names; real tenant names; real store names; real customer names; real domains; real IP addresses; real request IDs; real database URLs; real tokens; real secrets; real UUIDs; real provider identifiers; raw payloads; raw audit rows; raw authorization objects.

## 17. Current / Planned / Future / Blocked Badge Model

- Standardize state chips across every screen and control: **Current**, **Planned**, **Future**, **Dormant**, **Read-Only-First**, **Production-Blocked**.
- Every module/screen and every non-functional control in M22B carries its accurate chip so maturity is unmistakable.
- Examples: the Identity Links screen carries **Dormant** + **DEV-Only** + **Production-Blocked**; Database Control carries **Future**; the Audit timeline carries **Read-Only-First**.

## 18. Environment Selector and Production Lock UI Plan

- A global environment selector (mock) with values DEV / STAGING / PRODUCTION.
- A persistent **production lock** indicator; in PRODUCTION (mock) the shell visibly shows blocked/locked states for dangerous controls.
- The selector is presentational in M22B: switching environments changes only mock display state, never any real target.

## 19. Read-Only / Elevated Mode UI Plan

- A mode indicator (read-only vs elevated) is always visible.
- In M22B both modes are **visual only**: elevated mode reveals where guarded/approval controls *would* appear (as disabled placeholders with state chips), but no control performs an action.
- The mode indicator reinforces that the shell is non-authoritative and action-free in M22B.

## 20. RBAC Display Model — Mock Only

- Render the M21 role set as **labels/cards only**: BCP Owner; Platform Administrator; Database Administrator; Security Administrator; Operations Administrator; Support Operator; Read-Only Auditor; Approval Reviewer; Emergency Operator; Scoped Contributor.
- Display a **mock** permission matrix (role × action-category) using safe labels (View / Request / Approve / Execute-after-approval / blocked) — purely illustrative, not an enforcement mechanism.
- No real role assignment, no real permission evaluation, no actor identities (use "Role Placeholder" / "Actor Redacted").

## 21. Owner-Granted Scoped Access Display Model — Mock Only

- Render the scoped-access axes from M21 as a **mock** summary: by environment / tenant / store / module / action type / duration / approval requirement.
- All values are safe placeholders (e.g., "Tenant Alpha", "Store 001", "DEV", "Read-only", "Time-bounded", "Approval Required").
- No real grants, no actor identities, no durations tied to real data.

## 22. Approval Queue Display Model — Mock Only

- A mock approval-queue panel showing illustrative entries with safe categories: request type (label), state (Approval Required / Approved / Rejected — mock), environment chip, and "Actor Redacted" for requester/approver.
- Approve/Reject controls are **disabled placeholders** with state chips; they perform no action in M22B.
- Demonstrates separation-of-duties visually (requester ≠ approver) using redacted placeholders only.

## 23. Audit Timeline Display Model — Mock Only

- A mock **immutable** audit timeline showing illustrative entries with safe categories/booleans only: action category (e.g., "identity_link.create.requested" as a label), outcome (succeeded / rejected / conflict / idempotent / failed — mock), reason-code category, environment chip, and "Event Redacted" / "Actor Redacted" placeholders.
- No real audit rows, no metadata dumps, no identifiers; the timeline is read-only and append-only in appearance.

## 24. Database Registry Read-Only Display Plan

- A mock registry table/cards listing databases by **Opaque Reference** with posture badges: RLS Protected; Masked Connection; Isolated DB; Locked; DEV-Only; Production-Blocked; plus schema-version label (mock), migration-state label (Migration Pending, etc.), and backup-status label (mock).
- **Never** a connection string, never a secret; lock/unlock/register controls are disabled placeholders with state chips.

## 25. Database Control Read-Only Display Plan

- A mock orchestration/pipeline view labeled **Future**: pipeline stages, guardrail-evaluation placeholders (pass/fail booleans, mock), and approval-status placeholders.
- All controls are disabled placeholders; provisioning/lock actions perform nothing; destructive/production orchestration shown as Production-Blocked/Forbidden.

## 26. Tenant / Store Read-Only Display Plan

- **Tenants** and **Stores** screens render mock lists by Opaque Reference (Tenant Alpha/Beta/Gamma; Store 001/002/003) with isolation posture badges and DB-mapping status (mock).
- An isolation **topology map** placeholder (environment → tenant → store → database) using mock nodes.
- Provisioning controls are disabled placeholders labeled Future / DEV-Only / Production-Blocked.

## 27. Identity Links Read-Only Display Plan

- The Identity Links screen is rendered with state chips **Dormant** + **DEV-Only** + **Production-Blocked**.
- It shows a mock, empty-by-default link status surface (the DEV table is empty in reality) and a mock redacted audit timeline using the identity-link taxonomy **labels** only.
- It must visibly state: raw Firebase/Supabase/provider UID and raw `internal_user_id` are never shown; email is never authority; client-supplied UID is never authority; opaque references and redacted evidence only.
- Create/disable/revoke controls are disabled placeholders; no writes; self-service linking shown as deferred/forbidden.

## 28. Policies & Guardrails Read-Only Display Plan

- A mock registry of guardrail policies with evaluation outcomes (pass/fail booleans, mock) and safe labels.
- Policy-edit controls are disabled placeholders labeled approval-required; no weakening of guardrails; no control may (even visually) imply disabling audit/approval/redaction/production-lock.

## 29. Services / Jobs / API / Logs Read-Only Display Plan

- **Services:** mock health panels/cards (Service Healthy, etc.); restart/scale controls are disabled placeholders.
- **Jobs & Workers:** mock queue depths/worker status (Queue Warning, etc.); pause/retry/cancel controls disabled placeholders.
- **API Traffic:** mock aggregate rate/error charts and endpoint-health cards; **no** raw headers/bodies/payloads, ever.
- **Logs & Telemetry:** mock redacted log streams and telemetry aggregates; **no** secrets/raw identifiers, ever.

## 30. Backups / Environments / Support Tools Read-Only Display Plan

- **Backups & Recovery:** mock backup-status/recovery-point/retention posture; restore controls disabled placeholders (approval-required, SoD, DEV-first, Production-Blocked).
- **Environments & Infrastructure:** mock environment-group inventory and infra posture with production lock; infra controls disabled placeholders.
- **Support / Operator Tools:** mock redacted lookups by Opaque Reference and safe diagnostics; **no** raw identifiers/PII/secrets; **no** impersonation; mutating actions disabled placeholders.

## 31. Visual Design Carry-Forward From Stitch / AI Studio References

Preserve the M21-accepted visual direction (all reference output is reference-only; no prototype code copied, no dependency added):

- Premium **dark command-center shell**; separate secure access gate.
- **Infrastructure topology diagrams**; high-density enterprise cards and tables; polished dark panels.
- **Subtle neon status indicators**; **guarded action buttons** (visibly distinct disabled/blocked states).
- **Environment badges**; persistent **production lock**; **read-only / elevated mode** indicator.
- **Approval queue**; **immutable audit timeline**; **tenant/store/database isolation map**.
- Serious **operator-console** style; bottom **safety footer**.
- **Latest Stitch** = visual baseline; **AI Studio** references = module completeness and interaction ideas; combine, copy none.

## 32. Component Architecture Options — Planning Only

These are **options for M22B** (planning only; nothing implemented here):

- **Option C1 — Shell + screen + presentational-component layering (recommended):** a shell layout component, per-module screen components, and small reusable presentational components (cards, tables, badges, panels, drawers). Mock data passed in as props/constants; no data fetching.
- **Option C2 — Single composite per screen:** fewer, larger screen components with inline mock data. Faster to start; less reuse.
- **Option C3 — Design-system-first:** establish a small internal set of primitives (badge, card, table, panel, topology node) before screens. Cleaner long-term; larger initial scope.

All options must: keep components presentational/read-only; contain no data fetching, no mutation, no real backend calls; and isolate from Owner Platform components so current behavior is unchanged. Actual component decisions and any file creation occur in M22B after separate approval.

## 33. Styling / Theme Strategy — Planning Only

- A dark, high-density operator-console theme consistent with the M21 visual direction; subtle neon accents for status; clearly distinct disabled/guarded control styling.
- **Option S1 — Reuse the project's existing styling approach** (whatever the app already uses) for consistency and zero new dependencies (recommended; no dependency additions).
- **Option S2 — Scoped theme tokens for the BCP shell** to reinforce visual separation, layered on the existing approach without new dependencies.
- Constraint: **no new dependencies** are added in M22A; any dependency question is deferred to M22B and must be separately approved. Prefer reusing existing tooling.

## 34. Accessibility / Responsiveness Requirements

- Keyboard navigability for nav, command palette (if present), tables, and drawers.
- Sufficient color contrast for the dark theme, including status indicators (do not rely on color alone — pair with labels/chips).
- Responsive layout for high-density tables/cards (graceful behavior on smaller viewports).
- Clear focus states; descriptive labels for badges and guarded/disabled controls (e.g., state chips are textual, not color-only).
- Screen-reader-friendly semantics for tables, timelines, and status badges.

## 35. No-Backend-Action Enforcement Rules

M22B must enforce, by construction:

- No data fetching from real backends; mock data only.
- No mutation, no API calls, no DB connection, no SQL, no row writes.
- All write/approval/control affordances are **disabled placeholders** with accurate state chips; none performs an action.
- No identity-link writes; no admin-provisioning invocation; no migration execution; no service/worker restart; no provisioning; no restore; no production unlock.
- No wiring of M11/M15/M17.1; no change to AccessContext/sessionResolve; no runtime identity mapping; nothing made authoritative.

## 36. No-Secrets / No-Raw-Identifiers Enforcement Rules

M22B must guarantee:

- No secret values, env values, connection strings, service-role/anon keys, tokens, Authorization/request headers, request/response bodies are ever displayed.
- No raw Firebase/Supabase/provider UID, no raw `internal_user_id`, no real email, no real tenant/store/customer name, no real domain, no real IP, no real request ID, no actor UUID is ever displayed.
- Only opaque references, safe placeholder labels, redacted-evidence categories, and booleans appear in the UI.
- This is a hard acceptance gate for M22B (see §39).

## 37. Testing Strategy for M22B

Aligned with the project's existing approach (standalone tsx assertion scripts using `node:assert/strict`; `lint` = type-check; no new test framework, no new dependency):

- **Redaction tests:** assert the mock data sets and rendered text contain no real-identifier-shaped values, no secrets, no tokens, no DB URLs (pattern-based assertions over the mock data modules).
- **Mock-only/no-network tests:** assert the UI layer performs no data fetching and no mutation (e.g., no network client usage in the BCP UI modules; controls bound to no-op/disabled handlers).
- **State-chip tests:** assert each module/screen and each guarded control carries an accurate state chip (Current/Planned/Future/Dormant/Read-Only-First/Production-Blocked).
- **Separation tests:** assert the BCP shell does not import or modify Owner Platform authority modules (AccessContext/Login/AccessGuard) and does not appear in owner-facing navigation.
- **Type-check/lint:** the build type-checks cleanly.
- Tests must themselves be redaction-safe and use synthetic placeholders only.

## 38. Manual QA Plan for M22B

- Verify the BCP shell is **visibly separate** (distinct branding/theme; safety footer present) and does not appear in Owner Platform navigation.
- Verify environment selector, production lock, and read-only/elevated mode indicators are always visible.
- Verify every screen is read-only with mock data; every write/approval/control affordance is a disabled placeholder with a state chip.
- Verify **no** secret, connection string, token, raw header/body, or raw identifier is rendered anywhere.
- Verify state chips are accurate per module/screen.
- Verify the current Owner Platform behaves exactly as before (no regression) and current authorization is unchanged.
- Verify the dormant chain stays dormant and identity mapping stays unwired.
- Capture redaction-safe evidence only (screenshots must contain only mock placeholders; counts/booleans/categories).

## 39. Acceptance Criteria for M22B

M22B is acceptable only if ALL hold:

1. A **separate** BCP shell exists, visibly distinct, not merged into Owner Platform navigation.
2. The shell is **read-only / mock-only**; no real data, no backend actions, no API calls, no DB connection, no writes.
3. **No** secrets/raw identifiers are displayed anywhere; only opaque references, safe placeholders, redacted categories, booleans.
4. All write/approval/control affordances are **disabled placeholders** with accurate state chips.
5. Environment selector, production lock, read-only/elevated mode, and safety footer are present and accurate.
6. Each required module is represented per §"Module Representation" (included / placeholder / deferred / blocked) with accurate state chips.
7. Current Owner Platform behavior and current authorization are **unchanged**; AccessContext/sessionResolve unchanged; dormant chain dormant; identity mapping unwired.
8. Redaction, no-network, state-chip, and separation tests pass; the build type-checks.
9. No new dependency was added unless separately approved within M22B.
10. No DB connection / SQL / row write / migration / live authorization / Supabase MCP / production action occurred.

## 40. Forbidden M22B Scope

M22B must **not** include: DB connection; SQL; backend mutation; API mutation; live backend calls; real tenant data; real store data; real identity data; real audit data; real logs; real secrets; real environment values; identity-link writes; database provisioning; migration execution; worker/job execution; service restart; backup restore; production unlock; current Owner Platform behavior change; current authorization behavior change; AccessContext change; sessionResolve change; runtime identity mapping. M22B includes **only** safe mock/read-only UI foundation.

## 41. Implementation Risks and Mitigations

- **Risk: accidental coupling to Owner Platform authority.** Mitigation: separation tests; no imports of AccessContext/Login/AccessGuard authority logic; isolated shell.
- **Risk: mock data resembling real values.** Mitigation: strict safe-placeholder rules (§16); redaction tests.
- **Risk: a control appearing actionable.** Mitigation: all controls are disabled placeholders with state chips; no-network/no-mutation tests.
- **Risk: navigation leakage into owner-facing UI.** Mitigation: explicit exclusion from Owner Platform nav; separation tests; manual QA.
- **Risk: state-chip dishonesty (overstating maturity).** Mitigation: state-chip tests; QA checklist.
- **Risk: scope creep into write capability.** Mitigation: §40 forbidden scope; acceptance gate (§39); each write capability is a separate, separately-approved future milestone.
- **Risk: new dependencies.** Mitigation: reuse existing styling/test tooling; no dependency additions without separate approval in M22B.
- **Risk: production confusion.** Mitigation: persistent production lock; Production-Blocked chips; production remains blocked.

## 42. Recommended M22B File Boundaries — Planning Only

These are **recommended boundaries for M22B to confirm and get separately approved** — no files are created here, and exact paths/placement are decided in M22B:

- M22B should create **only** new, isolated BCP UI files (shell, screens, presentational components, mock-data modules, and their tests) within a clearly separated location.
- M22B must **not** modify: AccessContext, Login, AccessGuard, App routing behavior, `src/main.tsx`, `src/pilot/**`, sessionResolve, route handlers, server runtime, the durable audit writer, the identity repository, the M20.11 service/test, the 004 migration files, existing `platform_identity` migrations, `package.json`/`package-lock.json` (unless a dependency is separately approved), or seeds.
- M22B should keep mock data in dedicated mock modules (redaction-safe) separate from any real data layer.
- Any route/page placement file change must be the minimal, separately-approved choice from §11 and must not alter current Owner Platform behavior.

## 43. Module Representation Plan

For each required module/screen, M22B representation decision (included in shell / placeholder / deferred / blocked) and rationale. "Included" = a read-only mock screen is built; "Placeholder" = a nav entry + minimal stub screen with state chips; "Deferred" = listed but not built in M22B; "Blocked" = shown as blocked/forbidden.

1. **Separate Access Gate — Included.** Foundational entry; mock/visual gate establishes the separate-workspace identity (no real auth).
2. **Command Center — Included.** The primary first read-only screen (mock posture tiles + recent-activity summary).
3. **Operations Console — Placeholder.** Nav entry + stub with state chips; full triage is later.
4. **Tenants — Included.** Mock list by Opaque Reference + isolation posture; demonstrates redaction and topology.
5. **Stores — Included.** Mock list by Opaque Reference + isolation unit posture (pairs with Tenants).
6. **Tenant Isolation Debugger — Placeholder.** Stub with isolation-map placeholder + state chips; full checks later.
7. **Database Registry — Included.** Mock registry with posture badges; core to the BCP value story (read-only).
8. **Database Control — Blocked (Future).** Stub labeled Future; controls disabled/blocked; no orchestration.
9. **Schema & Migrations — Placeholder.** Stub migration viewer with mock state chips; apply is later/blocked.
10. **Services — Included.** Mock health panels (read-only); demonstrates operations surface.
11. **Jobs & Workers — Placeholder.** Stub queue/worker view with mock labels; controls disabled.
12. **API Traffic — Placeholder.** Stub aggregate view; no raw payloads ever.
13. **Logs & Telemetry — Placeholder.** Stub redacted stream; no secrets/raw identifiers ever.
14. **Identity & Access — Included.** Mock RBAC/scoped-access display (labels/cards); core governance story (read-only).
15. **Identity Links — Included (Dormant/DEV-Only/Production-Blocked).** Mock empty status surface + redacted timeline labels; strong redaction messaging; controls disabled.
16. **Configuration & Secrets Posture — Placeholder.** Stub posture-only view; never values.
17. **Audit & Approvals — Included.** Mock immutable audit timeline + approval queue (read-only); core governance story.
18. **Policies & Guardrails — Placeholder.** Stub registry with mock outcomes; edits disabled.
19. **Deployments & Releases — Deferred.** Listed in nav; not built in M22B (lower priority for read-only foundation).
20. **Environments & Infrastructure — Placeholder.** Stub environment grid + production lock; controls disabled.
21. **Backups & Recovery — Deferred/Placeholder.** Nav entry + minimal stub; restore blocked.
22. **Support / Operator Tools — Deferred/Placeholder.** Nav entry + minimal stub; redacted-only; mutating actions disabled.
23. **Control Plane Settings — Placeholder.** Stub settings view; safety-relevant changes disabled.

Rationale summary: M22B builds a small set of **Included** read-only screens that best demonstrate the separate shell, redaction, state model, and governance value (Access Gate, Command Center, Tenants, Stores, Database Registry, Services, Identity & Access, Identity Links, Audit & Approvals), with the remaining modules as honest **Placeholders/Deferred/Blocked** carrying accurate state chips — keeping M22B scope safe, read-only, and reviewable.

## 44. Explicitly Forbidden Conclusions

### 44.1 Forbidden content (this document contains none of):
Executable code; executable SQL; shell commands; DB connection strings; env values; secrets; service-role/anon keys; tokens; Authorization/request headers; request/response bodies; raw identity/audit rows; real Firebase/Supabase/provider UIDs; real `internal_user_id`; real emails; real tenant/store/customer names; real domains; real IPs; real request IDs; actor UUIDs; audit metadata dumps; permission/entitlement key lists from the current app; mismatch lists; raw authorization objects; raw harness/feed/comparison output; migration runner commands. Only safe fake labels, conceptual module/role names, lifecycle/reason-code categories, and accepted aggregate facts are used.

### 44.2 Explicitly Forbidden Conclusions (this document does NOT claim):
That the BCP shell is implemented; that a BCP route exists; that a BCP UI exists in the app; that the Owner Platform has been changed; that the read-only shell has been built; that database-per-tenant/-store is implemented; that database control actions are live; that the repository adapter is implemented; that the audit adapter is implemented; that identity links have been created; that identity mapping is active; that server authorization is authoritative; that the frontend should consume server authorization now; that production actions are ready; that a raw SQL console is approved; that secrets can be displayed; that direct DB writes are approved; that M11/M15/M17.1 should be wired; that self-service identity linking is approved; that email is safe as identity authority; that a client-supplied UID is safe as authority.

### 44.3 Affirmations:
This is **M22A planning only**. No UI has been implemented. No route has been implemented. No API endpoint has been implemented. No backend action has been implemented. No database action has been implemented. No DB connection occurred. No rows were inserted. No runtime behavior changed. **M22B must be read-only/mock-only unless separately approved otherwise.** The Backend CP must be **separate** from the Owner Platform. Dangerous actions remain **blocked, dormant, or future-only**. **Production remains blocked** until separately approved.

## 45. Recommended Next Milestones

- **Phase 1.6 M22A — Scoped Commit and Backup Authorization** (commit/back up this plan, owner-gated). Recommended immediately if M22A is accepted.
- After M22A backup: **Phase 1.6 M22B — Backend Control Plane Read-Only Shell / UI Foundation Implementation** (read-only/mock-only, per this plan, separately approved).
- Alternative at any point: **Phase 1.6 M20.13 — Identity Link DEV Repository & Audit Adapter Implementation**.

No commit, push, or backup is performed by this milestone. Stop for owner review.

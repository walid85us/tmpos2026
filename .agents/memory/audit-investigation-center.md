---
name: Audit Investigation Center (Phase 1.1.3D)
description: Where the owner audit-investigation derivations live and why, plus the date-granularity constraint
---

## Investigation derivations live in their own module
Phase 1.1.3D investigation helpers/data-model live in `src/owner/platformOpsInvestigation.ts`, NOT in `platformOpsDerive.ts`.
**Why:** `platformOpsDerive.ts` is already ~3,200 lines and is a locked "single source of truth" for command-center/SLA/escalation derivations; piling audit-investigation logic on top raises regression risk. The new module imports the existing `deriveHighRiskFlag`/`AuditEventLike`/`SignalConfidence` and reuses them rather than re-deriving.
**How to apply:** Add new audit-investigation derivations to `platformOpsInvestigation.ts`. Keep reusing `deriveHighRiskFlag` so high-risk classification never forks.

## Audit rows are date-granular only — correlation windows are in whole days
Audit MirrorRows + the `auditLogs` seed persist a `date` (YYYY-MM-DD) only, no sub-day timestamp, no actor role, no source surface.
**Why:** correlation/"time window" logic must use day indices (`dayIndex()`), not hours. Actor role is unavailable; source surface is *derived* best-effort from category (`deriveSourceSurface`) and must be labeled as derived, not claimed as recorded.
**How to apply:** Any "within N hours" claim is false here — express windows in days. Don't surface actor-role/source-surface as ground truth.

## One predicate drives counts AND list (no drift)
The audit search/filter/lens layer uses a single `matchesAuditSearch(event, query, ctx)` predicate plus per-lens `predicate(event, ctx)`; lens card counts (`countForLens`) and the visible list both run the SAME functions over the same `investigationEvents` (1:1 with raw rows by id). Selecting a lens resets ad-hoc filters so list === card count.
**Why:** the locked Command Center rule "count and list derive from one source and cannot drift" + "no invisible filters" applies here too. Forking count vs list logic is the classic QA failure.
**How to apply:** never add a filter that only affects the list or only the count. Add the field to `AuditSearchQueryState` + `matchesAuditSearch` and surface it as a removable chip in the command bar. Review status is read-only until the review milestone (events default to `needs_review`).

## Drawer selection unit is the raw AuditRow; derivations run on investigation events
`AuditSecurityPage` keeps `selected: AuditRow | null` as the single selection unit (table, drawer tabs, create-case all rely on it). The investigation derivations (actor profile, entity timeline, correlation, risk signals) operate on normalized `AuditInvestigationEvent`s. Bridge with `rowById = Map<id, AuditRow>` and `selectedInvEvent = investigationEvents.find(id) ?? toInvestigationEvent(selected)`. Any clickable derived item must `rowById.get(e.id)` before `setSelected`.
**Why:** migrating the whole page to investigation events would ripple through create-case, CSV, linked-case logic. Keeping AuditRow as the selection unit and mapping by id is the minimal, no-regression bridge.
**How to apply:** never call `setSelected` with an `AuditInvestigationEvent`; always resolve to the row first. Correlated-group cards render count + members both from `group.eventIds` (one source).

## Review status + investigation notes are an overlay; reuse existing note permissions
Per-event review status (`needs_review`/`reviewed`/`dismissed`) and investigation notes persist in a SEPARATE sessionStorage overlay (`AUDIT_INVESTIGATION_STORAGE_KEY`, dispatches `audit_investigation:changed`), NOT in the audit rows and NOT in the global `SecurityNote` system (`platform_security_notes`). Both systems coexist. Original audit rows are never mutated. Marking review + adding an investigation note reuse `add_security_note`; deleting a note reuses `delete_security_note` — NO new permission keys.
**Why:** locked permissions architecture forbids inventing keys; audit immutability is a core truth claim. Overlay keeps derived metadata out of the source-of-truth rows.
**How to apply:** all overlay writes go through pure helpers (`setAuditReviewStatus`/`addAuditInvestigationNote`/`deleteAuditInvestigationNote`) + `writeAuditInvestigationState`. Handlers must read fresh via `readAuditInvestigationState()` before writing (avoids stale closures). `markReview` no-ops if status unchanged (no audit spam). Notes are append-only (prepend, newest-first).

## Evidence summary is internal copy-only, restricted detail redacted by permission
`buildAuditEvidenceSummary`/`formatEvidenceSummaryText` produce a deterministic plain-text summary from on-screen data. It is explicitly NOT a legal-grade vault / containment / external-notify / server-RBAC artifact (Part K "should include" list is the EXCLUSION list). When `view_restricted_audit_details` is denied, flag reasons + free-form note on flagged events are replaced with an explicit `[restricted …]` placeholder, never silently dropped.

## Duplicate create-case guard must read fresh storage + use a submit lock
`createCaseFromEvent` must guard duplicates by reading FRESH persisted cases from sessionStorage (`readPersistedCases`), not React `cases` state, AND use a synchronous `useRef` re-entrancy lock — React-state checks alone are race-prone under double-click before re-render.
**Why:** architect flagged the state-only guard as race-prone; duplicate-prevention is an explicit acceptance criterion.
**How to apply:** any "prevent duplicate from persisted collection" guard in this codebase should read storage fresh + hold a ref lock, then release after persist.

## Milestone discipline for this phase
User wants Phase 1.1.3D built milestone-by-milestone with a STOP for review after each (order: helpers → layout/search/lenses → drawer/actor/timeline/correlation → review-notes/case/evidence → command-center/docs). Do not implement future milestones early; do not mark the full phase complete until all milestones are accepted.

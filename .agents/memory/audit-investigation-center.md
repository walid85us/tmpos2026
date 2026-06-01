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

## Milestone discipline for this phase
User wants Phase 1.1.3D built milestone-by-milestone with a STOP for review after each (order: helpers → layout/search/lenses → drawer/actor/timeline/correlation → review-notes/case/evidence → command-center/docs). Do not implement future milestones early; do not mark the full phase complete until all milestones are accepted.

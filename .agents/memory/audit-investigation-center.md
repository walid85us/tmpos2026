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

## Milestone discipline for this phase
User wants Phase 1.1.3D built milestone-by-milestone with a STOP for review after each (order: helpers → layout/search/lenses → drawer/actor/timeline/correlation → review-notes/case/evidence → command-center/docs). Do not implement future milestones early; do not mark the full phase complete until all milestones are accepted.

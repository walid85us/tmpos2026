---
name: Support queue/SLA count-list no-drift
description: How owner Support Tools guarantees a count and its drilldown list cannot diverge, including the time-snapshot pitfall.
---

# Count/list no-drift in owner Support Tools (Command Center rule)

A locked product rule: every intelligence count must be derived from the SAME
source as the list it opens, so a card count and its drilldown can never drift.

**How to apply:** define ONE predicate (e.g. `matchesSupportQueue(c, queueId, now)`
in `platformOpsDerive.ts`) and use it for both the summary count
(`deriveSupportQueues`) and the visible drilldown filter. Never compute a count
one way and filter the list another way.

**Why the timestamp matters:** time-relative predicates (SLA at_risk/overdue,
queue age) take a `now` argument. If the count memo and the list memo each call
`new Date()` independently, they can use slightly different instants and the
count can disagree with the list. Fix: compute a single render-time `now`
snapshot (a `useMemo` keyed on the same filter deps) and pass it to BOTH the
summary derivation and the list filter. This was a code-review finding on Phase
1.1.3C.

**Truth labels & gating:** every Support intelligence surface needs a visible
truth label, and all SLA indicators (list, detail header, operations panel)
must gate on the `view_support_sla` permission uniformly — not just some of them.

## SLA visibility is derivation-deep, not just render-deep
Gating SLA on `view_support_sla` at the JSX render level is NOT enough. Derivation helpers that emit human-readable SLA text leak it through other panels: `deriveSupportCaseSignal` pushes SLA strings into `attentionFlags`/`recommendedActions`, which the Case Operations panel renders unconditionally. Fix at the source — pass `{ canViewSla }` so SLA flags/actions are never produced when denied.
**Why:** UI tiles were gated but the attention-flag/recommended-action list still printed "Resolution SLA overdue" etc.
**How to apply:** When gating a permission, audit every derivation that produces text/labels for that domain, not only the obvious component. Also: SLA-status saved views (`filters.sla`) and a lingering `slaFilter`/SLA queue mode must be cleared on permission revocation, or stale SLA state leaks through a filter. Central single boolean `canViewSupportSla` is the only source of truth.

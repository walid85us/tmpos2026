---
name: Command Center intelligence reconciliation
description: Invariants for the System Owner Command Center intelligence layer (ribbon/drawer/snapshot derivations)
---

# Command Center intelligence (platformOpsDerive.ts + CommandCenterPage.tsx)

The intelligence layer is deterministic and rule-based (NO AI/ML, no live infra,
no Firestore realtime). All signals derive synchronously from the SAME focus-mode
/ time-range filtered slices that feed the Operational Pulse.

## Count-vs-list reconciliation invariant (most common failure)
Every ribbon card count MUST match its drilldown drawer's row filter EXACTLY, by
signal `kind`:
- escalations card = `kind==='escalation'` only (NOT also `unack_escalation`,
  which is additive for already-counted cases and would inflate the drawer)
- sla = `overdue_sla` + `at_risk_sla`
- audits = `high_risk_audit`
- domains = `failed_domain` + `pending_domain`
- commercial = `commercial_blocker`

**Why:** the whole point of the unified `CommandSignal` stream is one source for
count + list. A mismatch makes a card say "3" while its drawer shows a different
number — the exact QA failure class this surface keeps hitting.

**How to apply:** when adding/changing a ribbon card or drawer, update both the
`countKind(...)` in `deriveIntelligenceRibbon` and the `byDrawer` predicate in
`CommandCenterPage.tsx`'s `drawerSignals` memo together.

## tenant_risk drawer is special
The `tenant_risk` drawer is NOT in the atomic `commandSignals` stream — its rows
are synthesized from `tenantHealth.filter(t => t.tier !== 'healthy')` mapped into
`CommandSignal`-shaped objects. The top-tenant ribbon card is also sourced from
`tenantHealth`, so they stay coherent.

## UI field-binding gotcha
`RibbonCard` exposes `reason` (not `caption`). `CommandSignal` exposes `reason`
and `category` (not `detail`/`source`). Bind UI to these canonical names — these
were the field mismatches that broke ribbon subtitles and drawer detail text.

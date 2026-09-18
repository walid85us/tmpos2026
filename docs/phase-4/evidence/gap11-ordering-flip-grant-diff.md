# GAP-11 — ordering-flip effective-grant diff

> **Generated file. Do not edit by hand.**
> Produced by `scripts/generate-gap11-grant-diff.ts` from the inert permission catalog.
> Regenerate with `tsx scripts/generate-gap11-grant-diff.ts`; `--check` fails when it is stale.

This is **safeguard #2** of the six that [docs/phase-4/04 §3](../04-canonical-iam-and-four-user-migration.md#3-permission-level-reconciliation-required--gap-11)
binds to the GAP-11 ordering unification: a before/after effective-grant diff for every canonical
`(role, scope, action)` tuple, so that no silent change ships.

It decides nothing. Safeguard **#1** (the per-action re-pin) is an open policy choice, tracked as
decision **D2** — 04 §3 names two ways to satisfy it and assigns the choice to no one. Safeguard
**#3** (explicit approval of this diff) is the owner's, tracked as decision **D3**. Both remain open;
GAP-11 is **not** closed.

## What changed, in one line

The unified ordering moves exactly two comparisons, and nothing else:

| comparison | today (tenant ordering) | unified candidate | effect |
| --- | --- | --- | --- |
| holds `manage`, gate `approve` | denied | granted | **widens** |
| holds `approve`, gate `manage` | granted | denied | **narrows** |

Every other pair of levels keeps its truth value, because only `manage` and `approve` swap rank.
That is why the changed set below is small and completely enumerable rather than a sample.

## Orderings compared

| ordering | sequence | role in this diff |
| --- | --- | --- |
| tenant (`TENANT_ORDERING`) | `none < view < create < edit < manage < approve < full` | the BEFORE authority for the tenant plane |
| platform (`PLATFORM_ORDERING`) | `none < view < create < edit < approve < manage < full` | the BEFORE authority for the platform plane |
| unified candidate | `none < view < create < edit < approve < manage < full` | the AFTER-CANDIDATE for both planes |

**BEFORE** is the behaviour that ships today, obtained by calling the production materializers in
`server/platform-identity/permissionCatalog.ts` — it is the authority itself, not a copy of it.
**AFTER-CANDIDATE** is an independent implementation carrying its own rank table, so a single defect
cannot make both agree and report a falsely empty diff. The platform plane already uses the unified
ordering, so every platform tuple must come out identical under both; that is the positive control
proving the candidate is not simply broken.

## Evaluation context

| field | value |
| --- | --- |
| entitlements | every known tenant entitlement enabled (25 keys) |
| limitation | `none` |

This is the **maximal-grant** context, chosen deliberately: plan gating can only force a domain to
`none` and the read-only cap can only force a level to `view`, and neither `none` nor `view`
straddles the `manage`/`approve` boundary. No other context can therefore produce a change this
one does not contain. The authorization-matrix suite checks that argument rather than trusting it,
across the full, empty, every-one-off and every-one-on entitlement sets, each with and without the
read-only cap.

## Universe

| stratum | tuples |
| --- | --- |
| tenant sub-permissions (roles × actions) | 4 × 74 = 296 |
| tenant domain thresholds (roles × domains × levels) | 4 × 21 × 7 = 588 |
| platform sub-permissions (roles × actions) | 5 × 78 = 390 |
| platform feature thresholds (roles × features × levels) | 5 × 11 × 7 = 385 |
| **total** | **1659** |

Both strata are enumerated on purpose. The ordering flip is a statement about **level comparison**,
so a diff listing only named sub-permissions would miss every threshold check and could report "no
grants changed" while the real exposure sat untouched beside it — which is exactly what happens here.

## Summary

| measure | count |
| --- | --- |
| tuples evaluated | 1659 |
| unchanged | 1646 |
| **widened** | **12** |
| **narrowed** | **1** |
| waiting on D2 (approve-gated: the re-pin policy) | 12 |
| waiting on D3 (owner approval of this diff) | 13 |
| changed in the sub-permission stratum | 0 |
| changed on the platform plane | 0 |

**Changed rows by role**

| key | changed rows |
| --- | --- |
| `manager` | 12 |
| `technician` | 1 |

**Changed rows by scope**

| key | changed rows |
| --- | --- |
| `employees` | 1 |
| `integrations` | 1 |
| `inventory` | 1 |
| `marketing` | 1 |
| `refunds` | 1 |
| `repairs` | 1 |
| `returns` | 1 |
| `settings` | 1 |
| `shipping` | 1 |
| `suggestive_sales` | 1 |
| `supply_chain` | 1 |
| `warranties` | 1 |
| `widgets` | 1 |

**Changed rows by action**

| key | changed rows |
| --- | --- |
| `require:approve` | 12 |
| `require:manage` | 1 |


## Every changed row

### Widened — a `manage` holder newly clears an `approve` gate (12)

| role | scope | action | holds | gate | before | after | change | approve-gated | D2 | plane/stratum |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `manager` | `employees` | `require:approve` | `manage` | `approve` | denied | granted | widened | yes | yes | `tenant/domain_threshold` |
| `manager` | `integrations` | `require:approve` | `manage` | `approve` | denied | granted | widened | yes | yes | `tenant/domain_threshold` |
| `manager` | `inventory` | `require:approve` | `manage` | `approve` | denied | granted | widened | yes | yes | `tenant/domain_threshold` |
| `manager` | `marketing` | `require:approve` | `manage` | `approve` | denied | granted | widened | yes | yes | `tenant/domain_threshold` |
| `manager` | `returns` | `require:approve` | `manage` | `approve` | denied | granted | widened | yes | yes | `tenant/domain_threshold` |
| `manager` | `settings` | `require:approve` | `manage` | `approve` | denied | granted | widened | yes | yes | `tenant/domain_threshold` |
| `manager` | `shipping` | `require:approve` | `manage` | `approve` | denied | granted | widened | yes | yes | `tenant/domain_threshold` |
| `manager` | `suggestive_sales` | `require:approve` | `manage` | `approve` | denied | granted | widened | yes | yes | `tenant/domain_threshold` |
| `manager` | `supply_chain` | `require:approve` | `manage` | `approve` | denied | granted | widened | yes | yes | `tenant/domain_threshold` |
| `manager` | `warranties` | `require:approve` | `manage` | `approve` | denied | granted | widened | yes | yes | `tenant/domain_threshold` |
| `manager` | `widgets` | `require:approve` | `manage` | `approve` | denied | granted | widened | yes | yes | `tenant/domain_threshold` |
| `technician` | `repairs` | `require:approve` | `manage` | `approve` | denied | granted | widened | yes | yes | `tenant/domain_threshold` |

### Narrowed — an `approve` holder stops clearing a `manage` gate (1)

| role | scope | action | holds | gate | before | after | change | approve-gated | D2 | plane/stratum |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `manager` | `refunds` | `require:manage` | `approve` | `manage` | granted | denied | narrowed | no | no | `tenant/domain_threshold` |

## What remains to be decided (D2, D3)

All 13 changed rows need the owner's approval of this diff (**D3**). 12 of
them — every row gated at `approve` — also wait on **D2**: whether an `approve`-gated action is
re-pinned to require `≥ manage`, or to an explicit per-role grant. Both options are named by 04 §3
safeguard #1; it picks neither, and neither is picked here. The remaining
1 row(s) are gated at `manage`, so they are not a re-pin question — but
see the refunds row below: which D2 option is chosen, and where it is applied, decides whether that
narrowing ever reaches a real check.

Two findings bear directly on that choice, and both are visible only because the diff was computed
rather than assumed:

1. **The named sub-permissions do not move** (0 changed rows in that stratum). Each
   non-owner tenant role carries an **explicit boolean grant** for every `approve`-gated
   sub-permission — `approve_refunds`, `approve_return`, `approve_inventory`,
   `approve_requests` — and an explicit grant is consulted *before* the default-by-level path the
   ordering flip would move. So for those actions safeguard #1's second option, "an explicit per-role
   grant", is **already in force**, and the widening 04 §3 warns about does not reach them.
   `store_owner` has no explicit map: it short-circuits after plan gating, which the ordering does not
   touch. What each non-owner role still leaves to the default-by-level path, of 74
   sub-permissions, derived from the catalog:
   - `manager`: `select_service_point` (default `edit`), `request_carrier_pickup` (default `edit`), `cancel_carrier_pickup` (default `manage`)
   - `sales_staff`: `select_service_point` (default `edit`), `request_carrier_pickup` (default `edit`), `cancel_carrier_pickup` (default `manage`)
   - `technician`: `select_service_point` (default `edit`), `request_carrier_pickup` (default `edit`), `cancel_carrier_pickup` (default `manage`)

   None of those defaults is `approve`, and none sits on a `manage`/`approve` boundary a role
   straddles, which is why they do not move either.
2. **The exposure is entirely at the domain-threshold layer** — wherever a role's *level* on a
   domain is compared against a required level: the client engine's `checkPermission(domain, level)`
   and its supervisor refund authorization (both in `src/context/AccessContext.tsx`), and the DEV
   control plane's `requireTenantPermission` (`server/platform-identity/permissionDecision.ts`).
   The M5 canonical route catalog (`m5CanonicalPermissions.ts`) is *not* on this layer: it admits
   only named sub-permissions, which is the stratum that does not move. This diff enumerates the
   changed *decisions*; it does not claim that any particular call site consults one of them today.

And one row cuts the other way from the documented risk:

- **`manager` / `refunds` / gate `manage`: granted → denied.** The manager holds `approve` on
  `refunds`, and under the unified ordering `approve` sits *below* `manage`. So if D2's
  "`≥ manage`" option is applied as a **domain-level** gate — the shape of today's supervisor refund
  authorization, which checks the `refunds` level against `approve` — the manager **loses** refund
  approval rather than keeping it, unless the role's `refunds` level is raised at the same time.
  Applied instead as the required level of the `approve_refunds` *sub-permission*, it changes nothing
  for the manager, whose explicit grant is consulted first. 04 §3 describes GAP-11 only as a widening
  hazard; on the money domain it can also narrow, depending on where the re-pin is applied.

One boundary is not an authorization control, and should not be read as one: the client's
per-domain list of selectable levels (`PERMISSION_DOMAINS[].levels` in `src/context/accessConfig.ts`,
which for example offers no `manage` on `refunds` and no `approve` on `shipping`) is a UI
allow-list only. Nothing server-side mirrors or enforces it, so a stored role level outside it lands
directly on the `manage`/`approve` boundary this diff is about. This diff therefore evaluates every
level on every domain, not only the ones the UI offers.

Named-grant-only capabilities tracked for D2 (04 §2), none currently present in the catalog:
`activate_payment_gateway`, `disconnect_payment_gateway`, `manage_payment_gateway_connections`, `manage_payment_terminals`.

## Fingerprints

| input | sha256 |
| --- | --- |
| normalized authorization inputs | `5415d39aca15ea20ce89711efbfa95fc5336e6ed3a4c4f299d17537062a194ad` |
| diff rows (canonical serialization) | `5580eb377e51914aa7004c120d7abdf8e8f94af33a503d048a2aa80fa9d505f0` |
| summary (canonical serialization) | `21e00bd75c5b1b5da588abb11464a7a667d8b9d8e55871a8bf87b57f3cecc1a2` |

The first fingerprint covers every catalog input this diff reads — orderings, roles, domains,
features, actions, thresholds, role defaults, explicit grants, entitlement gates and dependencies —
serialized with sorted keys at every level. If it changes, this artifact is stale and the repository
test fails.

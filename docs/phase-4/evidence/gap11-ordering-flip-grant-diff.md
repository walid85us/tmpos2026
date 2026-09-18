# GAP-11 — ordering-flip effective-grant diff

> **Generated file. Do not edit by hand.**
> Produced by `scripts/generate-gap11-grant-diff.ts` from the inert permission catalog.
> Regenerate with `tsx scripts/generate-gap11-grant-diff.ts`; `--check` fails when it is stale.

This is **safeguard #2** of the six that [docs/phase-4/04 §3](../04-canonical-iam-and-four-user-migration.md#3-permission-level-reconciliation-required--gap-11)
binds to the GAP-11 ordering unification: a before/after effective-grant diff for every canonical
`(role, scope, action)` tuple, so that no silent change ships.

It decides nothing. Safeguard **#1** (the per-action re-pin of `approve`-gated money actions) is an
open policy choice, tracked as decision **D2** — 04 §3 names two ways to satisfy it and assigns the
choice to no one. Safeguard **#3** (explicit approval of this diff) is the owner's, tracked as decision
**D3**. Both remain open; GAP-11 is **not** closed.

## How to read this diff: two classifications, kept apart

Every tuple carries two separate classifications, and no count below mixes them:

| classification | values | what it means |
| --- | --- | --- |
| **approve level** (structural) | yes / no | The tuple's decisive required level is `approve`: a threshold tuple's level, a platform sub-permission's threshold, or a tenant sub-permission's default level. It is the level the flip moves. It says nothing about money. |
| **D2 classification** | `money_action` | The tuple represents an operation an authoritative document identifies as an approve-gated money action (section B, with the source quoted). Only these are D2 rows. |
|  | `unresolved` | The tuple requires the `approve` level, but no authoritative document ties it to a money action (section C). Whether D2 covers it is part of D2's open scope, not a finding. It is not counted as a D2 row. |
|  | `not_money_action` | Neither: the decisive level is not `approve`, so the tuple cannot be an approve-gated action, and no document names it as one. |

A level, a domain name, a widening, or the role that holds it is never taken as evidence of money.

## A. Structural ordering diff

### What changed, in one line

The unified ordering moves exactly two comparisons, and nothing else:

| comparison | today (tenant ordering) | unified candidate | effect |
| --- | --- | --- | --- |
| holds `manage`, gate `approve` | denied | granted | **widens** |
| holds `approve`, gate `manage` | granted | denied | **narrows** |

Every other pair of levels keeps its truth value, because only `manage` and `approve` swap rank.
That is why the changed set below is small and completely enumerable rather than a sample.

### Orderings compared

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
proving the candidate is not simply broken. Both deny any level, role, scope or action outside the
catalog (safeguard #4), so they differ only in the ordering.

### Evaluation context

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

### Universe

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

### Summary

| measure | count |
| --- | --- |
| tuples evaluated | 1659 |
| unchanged | 1646 |
| **widened** | **12** |
| **narrowed** | **1** |
| changed rows whose decisive level is `approve` (structural) | 12 |
| changed in the sub-permission stratum | 0 |
| changed on the platform plane | 0 |

**Changed rows by D2 classification** — a separate count, not a subset of the structural one above:

| D2 classification | changed rows |
| --- | --- |
| `money_action` | 0 |
| `unresolved` | 12 |
| `not_money_action` | 1 |

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


### Every changed row

#### Widened — a `manage` holder newly clears an `approve` gate (12)

| role | scope | action | holds | gate | before | after | change | approve level | D2 classification | plane/stratum |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `manager` | `employees` | `require:approve` | `manage` | `approve` | denied | granted | widened | yes | `unresolved` | `tenant/domain_threshold` |
| `manager` | `integrations` | `require:approve` | `manage` | `approve` | denied | granted | widened | yes | `unresolved` | `tenant/domain_threshold` |
| `manager` | `inventory` | `require:approve` | `manage` | `approve` | denied | granted | widened | yes | `unresolved` | `tenant/domain_threshold` |
| `manager` | `marketing` | `require:approve` | `manage` | `approve` | denied | granted | widened | yes | `unresolved` | `tenant/domain_threshold` |
| `manager` | `returns` | `require:approve` | `manage` | `approve` | denied | granted | widened | yes | `unresolved` | `tenant/domain_threshold` |
| `manager` | `settings` | `require:approve` | `manage` | `approve` | denied | granted | widened | yes | `unresolved` | `tenant/domain_threshold` |
| `manager` | `shipping` | `require:approve` | `manage` | `approve` | denied | granted | widened | yes | `unresolved` | `tenant/domain_threshold` |
| `manager` | `suggestive_sales` | `require:approve` | `manage` | `approve` | denied | granted | widened | yes | `unresolved` | `tenant/domain_threshold` |
| `manager` | `supply_chain` | `require:approve` | `manage` | `approve` | denied | granted | widened | yes | `unresolved` | `tenant/domain_threshold` |
| `manager` | `warranties` | `require:approve` | `manage` | `approve` | denied | granted | widened | yes | `unresolved` | `tenant/domain_threshold` |
| `manager` | `widgets` | `require:approve` | `manage` | `approve` | denied | granted | widened | yes | `unresolved` | `tenant/domain_threshold` |
| `technician` | `repairs` | `require:approve` | `manage` | `approve` | denied | granted | widened | yes | `unresolved` | `tenant/domain_threshold` |

#### Narrowed — an `approve` holder stops clearing a `manage` gate (1)

| role | scope | action | holds | gate | before | after | change | approve level | D2 classification | plane/stratum |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `manager` | `refunds` | `require:manage` | `approve` | `manage` | granted | denied | narrowed | no | `not_money_action` | `tenant/domain_threshold` |

### Structural findings

1. **The named sub-permissions do not move** (0 changed rows in that stratum). Each
   non-owner tenant role carries an **explicit boolean grant** for every sub-permission whose default
   level is `approve` — `approve_refunds`, `approve_return`, `approve_inventory`,
   `approve_requests` — and an explicit grant is consulted *before* the default-by-level path the
   ordering flip would move. `store_owner` has no explicit map: it short-circuits after plan gating,
   which the ordering does not touch. What each non-owner role still leaves to the default-by-level
   path, of 74 sub-permissions, derived from the catalog:
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
3. **The client's per-domain level list is not an authorization control.** `PERMISSION_DOMAINS[].levels`
   in `src/context/accessConfig.ts` (which for example offers no `manage` on `refunds` and no
   `approve` on `shipping`) is a UI allow-list only. Nothing server-side mirrors or enforces it, so a
   stored role level outside it lands directly on the `manage`/`approve` boundary this diff is about.
   This diff therefore evaluates every level on every domain, not only the ones the UI offers.

## B. Authoritatively identified money actions (D2)

These are the only tuples D2 governs. Each operation below is identified as an approve-gated money
action by the quoted source, and listed with every canonical representation the catalog gives it.
17 of the universe's 1659 tuples are such
representations, and **0 of them change** under the unified ordering.

#### `refund_approval`

Authoritative source:

- `docs/phase-4/04-canonical-iam-and-four-user-migration.md` — "including money-sensitive ones (`refunds: approve` / `approve_refunds`, `returns: approve_return`)"

| representation | kind | changes under the flip | re-pin needed to stop a silent change |
| --- | --- | --- | --- |
| `tenant/refunds/require:approve` | domain-threshold decision | no | no — the flip does not move it (D2 may still re-pin it as policy) |
| `tenant/refunds/approve_refunds` | named sub-permission | no | no — the flip does not move it (D2 may still re-pin it as policy) |

| representation | role | holds | BEFORE | AFTER-CANDIDATE | changes |
| --- | --- | --- | --- | --- | --- |
| `refunds/require:approve` | `manager` | `approve` | granted | granted | no |
| `refunds/require:approve` | `sales_staff` | `none` | denied | denied | no |
| `refunds/require:approve` | `store_owner` | `full` | granted | granted | no |
| `refunds/require:approve` | `technician` | `none` | denied | denied | no |
| `refunds/approve_refunds` | `manager` | `approve` | granted | granted | no |
| `refunds/approve_refunds` | `sales_staff` | `none` | denied | denied | no |
| `refunds/approve_refunds` | `store_owner` | `full` | granted | granted | no |
| `refunds/approve_refunds` | `technician` | `none` | denied | denied | no |

What the current data model cannot yet express: The catalog represents refund approval twice, and links the two only through `approve_refunds`' default-by-level path (`refunds` at `approve`), which every canonical role's explicit grant overrides — so for those roles they are separate decisions that can disagree. The client's supervisor refund authorization requires both: the `refunds` level at `approve` and an `approve_refunds` entry that is absent or true. There is no single canonical refund-approval action, so "re-pin refund approval" names more than one change. D2 has to say which representation it re-pins — the refunds narrowing below is where the difference shows.

#### `return_approval`

Authoritative source:

- `docs/phase-4/04-canonical-iam-and-four-user-migration.md` — "including money-sensitive ones (`refunds: approve` / `approve_refunds`, `returns: approve_return`)"

| representation | kind | changes under the flip | re-pin needed to stop a silent change |
| --- | --- | --- | --- |
| `tenant/returns/approve_return` | named sub-permission | no | no — the flip does not move it (D2 may still re-pin it as policy) |

| representation | role | holds | BEFORE | AFTER-CANDIDATE | changes |
| --- | --- | --- | --- | --- | --- |
| `returns/approve_return` | `manager` | `manage` | granted | granted | no |
| `returns/approve_return` | `sales_staff` | `view` | denied | denied | no |
| `returns/approve_return` | `store_owner` | `full` | granted | granted | no |
| `returns/approve_return` | `technician` | `view` | denied | denied | no |

What the current data model cannot yet express: One representation: the `approve_return` sub-permission. Two of its comparisons are on the level the flip moves. Its minimum module level is `manage`, checked BEFORE any explicit grant: a role holding `returns` at `approve` clears it today and would not under the unified ordering — no canonical role holds that level, which is why no row changes. Its default-by-level path compares `returns` against `approve` — the same comparison as the widened `manager` / `returns` row in section C — but every canonical tenant role carries an explicit `approve_return` grant, read after the minimum and before the default, so the path is not reached for them. The server catalog has only its four fixed tenant roles and cannot represent a role without an explicit grant. The client can: a custom role created in the Employees screen stores only the sub-permissions an owner toggled, so for such a role the client's default path, and with it the unified ordering, would decide.

#### `platform_billing_approval`

Authoritative sources:

- `src/owner/platformPermissionsConfig.ts` — "id: 'approve_billing_actions', label: 'Approve Billing Actions', description: 'Approve refunds, credits, or write-offs.', threshold: 'approve'"
- `docs/phase-1.3-platform-access-inventory.md` — "financial approval (refund/credit/write-off)"

| representation | kind | changes under the flip | re-pin needed to stop a silent change |
| --- | --- | --- | --- |
| `platform/billing_subscriptions/approve_billing_actions` | named sub-permission | no | no — the flip does not move it (D2 may still re-pin it as policy) |

| representation | role | holds | BEFORE | AFTER-CANDIDATE | changes |
| --- | --- | --- | --- | --- | --- |
| `billing_subscriptions/approve_billing_actions` | `billing_admin` | `full` | granted | granted | no |
| `billing_subscriptions/approve_billing_actions` | `operations_admin` | `view` | denied | denied | no |
| `billing_subscriptions/approve_billing_actions` | `security_admin` | `view` | denied | denied | no |
| `billing_subscriptions/approve_billing_actions` | `support_admin` | `view` | denied | denied | no |
| `billing_subscriptions/approve_billing_actions` | `system_owner` | `full` | granted | granted | no |

What the current data model cannot yet express: Platform plane. That plane already ranks `approve` below `manage`, so the unified ordering cannot move it (0 platform rows change). Nothing needs re-pinning to prevent a silent change.

**What this means for D2.** On every documented money action, for every canonical role, the unified
ordering changes nothing: the manager already holds `refunds` at `approve`, every non-owner tenant
role holds explicit `approve_refunds` and `approve_return` grants that are read before the
default-by-level path, and no canonical role holds the `approve` level that `approve_return`'s `manage`
minimum would stop admitting.
04 §3's warning that the manager "would silently gain approval capability it did not have" does not
materialize on these operations for the catalog's roles; the structural widening sits on the
`unresolved` rows of section C. What D2 still has to settle is where a re-pin lands — which
representation of refund approval is the canonical one, and whether roles without explicit grants are
in scope — not a change the flip forces on the documented actions.

## C. Unresolved mapping

These rows require the `approve` level but **no authoritative document ties them to a money
action**. They are structural facts, not D2 rows, and D2 is not asked to decide from them. Whether
D2's re-pin should also cover them is part of D2's open scope; nothing here answers it.

### Changed rows (12)

| role | scope | action | holds | gate | before | after | default-by-level path of | why unresolved |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `manager` | `employees` | `require:approve` | `manage` | `approve` | denied | granted | `approve_requests` | a bare domain threshold names no action; no document identifies this domain at `approve` as a money action |
| `manager` | `integrations` | `require:approve` | `manage` | `approve` | denied | granted | — | a bare domain threshold names no action; no document identifies this domain at `approve` as a money action |
| `manager` | `inventory` | `require:approve` | `manage` | `approve` | denied | granted | `approve_inventory` | a bare domain threshold names no action; no document identifies this domain at `approve` as a money action |
| `manager` | `marketing` | `require:approve` | `manage` | `approve` | denied | granted | — | a bare domain threshold names no action; no document identifies this domain at `approve` as a money action |
| `manager` | `returns` | `require:approve` | `manage` | `approve` | denied | granted | `approve_return` | a bare domain threshold names no action; no document identifies this domain at `approve` as a money action |
| `manager` | `settings` | `require:approve` | `manage` | `approve` | denied | granted | — | a bare domain threshold names no action; no document identifies this domain at `approve` as a money action |
| `manager` | `shipping` | `require:approve` | `manage` | `approve` | denied | granted | — | a bare domain threshold names no action; no document identifies this domain at `approve` as a money action |
| `manager` | `suggestive_sales` | `require:approve` | `manage` | `approve` | denied | granted | — | a bare domain threshold names no action; no document identifies this domain at `approve` as a money action |
| `manager` | `supply_chain` | `require:approve` | `manage` | `approve` | denied | granted | — | a bare domain threshold names no action; no document identifies this domain at `approve` as a money action |
| `manager` | `warranties` | `require:approve` | `manage` | `approve` | denied | granted | — | a bare domain threshold names no action; no document identifies this domain at `approve` as a money action |
| `manager` | `widgets` | `require:approve` | `manage` | `approve` | denied | granted | — | a bare domain threshold names no action; no document identifies this domain at `approve` as a money action |
| `technician` | `repairs` | `require:approve` | `manage` | `approve` | denied | granted | — | a bare domain threshold names no action; no document identifies this domain at `approve` as a money action |

The rows with an entry in "default-by-level path of" are the comparisons those sub-permissions would
make for a role without an explicit grant: `approve_requests`, `approve_inventory`, `approve_return`.
Every canonical non-owner role holds an explicit grant for each of them, so none is reached today. The
link is structural, from the catalog; it does not make a threshold row a representation of the
sub-permission, and only `approve_return` among them is a documented money action (section B).

### Every tuple, by classification

| plane/stratum | tuples | approve level | `money_action` | `unresolved` | `not_money_action` |
| --- | --- | --- | --- | --- | --- |
| `tenant/domain_threshold` | 588 | 84 | 4 | 80 | 504 |
| `tenant/sub_permission` | 296 | 16 | 8 | 8 | 280 |
| `platform/domain_threshold` | 385 | 55 | 0 | 55 | 330 |
| `platform/sub_permission` | 390 | 50 | 5 | 45 | 340 |
| **total** | **1659** | **205** | **17** | **188** | **1454** |

Approve-level sub-permissions with no documented money mapping: tenant — `approve_inventory`, `approve_requests`;
platform — `change_escalation_level`, `delete_security_note`, `edit_addon_overrides`, `export_audit_csv`, `grant_paid_override`, `grant_trial`, `resolve_escalation`, `revoke_addon_override`, `view_restricted_audit_details`. None of them changes under the flip.

Named-grant-only capabilities 04 §2 folds into the §3 re-pin safeguard: `activate_payment_gateway`, `disconnect_payment_gateway`, `manage_payment_gateway_connections`, `manage_payment_terminals`.
04 §2.1 classes them as provider configuration, separate from payment operations, and no document calls
them money actions. 04 §2.1 also names payment-operation permissions — `accept_payment`, `approve_high_value_refund`, `process_payment`, `refund_payment`, `view_reconciliation`, `void_payment` —
without a level and without calling them approve-gated. None of either list is in the catalog; should
one be added, its tuples classify `unresolved`.

## The `manager` / `refunds` narrowing

| question | answer |
| --- | --- |
| level held | `manager` holds `approve` on `refunds` (role default) |
| level required | `manage` — the tuple `refunds/require:manage` |
| BEFORE | **granted** — the tenant ordering ranks `approve` (5) above `manage` (4), so an `approve` holder clears a `manage` gate |
| AFTER-CANDIDATE | **denied** — the unified ordering ranks `approve` (4) below `manage` (5), so it no longer does |
| a real refund money action? | **No — a domain-threshold decision only** (D2 classification `not_money_action`). Refund approval is documented as `refunds: approve` / `approve_refunds` (section B); nothing documents `refunds` at `manage`. No catalog sub-permission uses that comparison — `process_refunds` (minimum `view`, default `create`), `approve_refunds` (minimum `view`, default `approve`) — and the client offers no `manage` level on `refunds` at all. |
| can D2 affect it? | **D2 does not decide it, but D2 can make it a live check.** If D2 re-pins refund approval to "`≥ manage`" as a *domain-level* gate — the shape of the `refunds: approve` representation and of the client's supervisor refund authorization — this comparison becomes the manager's refund-approval check, and under the unified ordering the manager would lose refund approval unless the role's `refunds` level is raised in the same change. If D2 re-pins through an explicit per-role grant or on `approve_refunds`, this comparison is not consulted: the manager's explicit grant is read first. |
| what remains for D3 | Approval of this row, as of every changed row: accepting that under the unified ordering an `approve` holder no longer clears a `manage` gate on `refunds`. Whatever D2 decides, the row is D3's to approve; if D2 makes it a live check, D3's approval of it should be read together with that choice. |

## What remains to be decided (D2, D3)

- **D3** — approval of all 13 changed rows: 12 widened, 1 narrowed.
- **D2** — the re-pin of the approve-gated money actions in section B. None of their representations
  changes under the flip, so D2 is not forced by this diff; it still has to choose where a re-pin lands
  (see the refund-approval data-model note and the narrowing above) and, separately, whether its scope
  extends to the 12 `unresolved` rows of section C. Neither choice is made here.

## Fingerprints

| input | sha256 |
| --- | --- |
| normalized authorization inputs | `5789c18f7eb6b784761a0d815f85e70774f98c360025c38ffc35dd680d3806ac` |
| diff rows (canonical serialization) | `c13c2c134c24c6c07351d7d8ab927359c8270ff10476b2ad5f6df01a5bb43071` |
| summary (canonical serialization) | `0861bb6fee9af28aecdbd0131b153a14deebd5e85940041159a8668f2f7688ee` |

The first fingerprint covers every catalog input this diff reads — orderings, roles, domains,
features, actions, thresholds, role defaults, explicit grants, entitlement gates and dependencies —
and the D2 classification's own inputs (the money-action registry with its quoted sources, and the
named-grant-only list), serialized with sorted keys at every level. If it changes, this artifact is
stale and the repository test fails.

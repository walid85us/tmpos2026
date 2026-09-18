# GAP-11 — ordering-flip effective-grant diff

> **Generated file. Do not edit by hand.**
> Produced by `scripts/generate-gap11-grant-diff.ts` from the inert permission catalog.
> Regenerate with `tsx scripts/generate-gap11-grant-diff.ts`; `--check` fails when it is stale.

This is **safeguard #2** of the six that [docs/phase-4/04 §3](../04-canonical-iam-and-four-user-migration.md#3-permission-level-reconciliation-required--gap-11)
binds to the GAP-11 ordering unification: a before/after effective-grant diff for every canonical
`(role, scope, action)` tuple, so that no silent change ships.

It decides nothing. Safeguard **#1** (the per-action re-pin of `approve`-gated money actions) is
owner decision **D2**, now made: an approval-gated money action requires an explicit per-role grant.
The candidate carries that re-pin (section D) — in the candidate only: production is not re-pinned and
nothing is cut over. Safeguard **#3** (explicit approval of this diff) is owner decision **D3**, still
open; section E is the diff it approves. GAP-11 is **not** closed.

## How to read this diff

### Three views of every tuple

| view | what it is |
| --- | --- |
| **authoritative** (BEFORE) | What ships today: the production materializers in `server/platform-identity/permissionCatalog.ts`, called directly. |
| **pre-re-pin** (AFTER-CANDIDATE) | The unified ordering alone — an independent implementation with its own rank table. Section A is the diff against it: the structural ordering changes. |
| **post-re-pin** (AFTER-REPIN) | The unified ordering with D2's explicit money-action grants — the evaluator a cutover would install. Section E is the diff against it: the net effective change D3 approves. |

### Two classifications, kept apart

Every tuple carries two separate classifications, and no count below mixes them:

| classification | values | what it means |
| --- | --- | --- |
| **approve level** (structural) | yes / no | The tuple's decisive required level is `approve`: a threshold tuple's level, a platform sub-permission's threshold, or a tenant sub-permission's default level. It is the level the flip moves. It says nothing about money. |
| **D2 classification** | `money_action` | The tuple represents an operation an authoritative document identifies as an approve-gated money action (section B, with the source quoted). Only these are D2 rows, and only these carry an explicit grant (section D). |
|  | `unresolved` | The tuple requires the `approve` level, but no authoritative document ties it to a money action (section C). It keeps the unified ordering's rules; it is not re-pinned and not counted as a D2 row. |
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
read-only cap, for both candidate views.

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
representations. **0 of them change** under the unified ordering
alone, and **0 change** after the D2 re-pin: all
17 keep their authoritative answer (17 of 17 preserved).

#### `refund_approval`

Authoritative source:

- `docs/phase-4/04-canonical-iam-and-four-user-migration.md` — "including money-sensitive ones (`refunds: approve` / `approve_refunds`, `returns: approve_return`)"

| representation | kind | changes under the flip | decided after the re-pin by |
| --- | --- | --- | --- |
| `tenant/refunds/require:approve` | domain-threshold decision | no | its D2 explicit per-role grant |
| `tenant/refunds/approve_refunds` | named sub-permission | no | its D2 explicit per-role grant |

| representation | role | holds | authoritative | pre-re-pin | explicit grant | post-re-pin | preserved |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `refunds/require:approve` | `manager` | `approve` | granted | granted | `true` | granted | yes |
| `refunds/require:approve` | `sales_staff` | `none` | denied | denied | `false` | denied | yes |
| `refunds/require:approve` | `store_owner` | `full` | granted | granted | `true` | granted | yes |
| `refunds/require:approve` | `technician` | `none` | denied | denied | `false` | denied | yes |
| `refunds/approve_refunds` | `manager` | `approve` | granted | granted | `true` | granted | yes |
| `refunds/approve_refunds` | `sales_staff` | `none` | denied | denied | `false` | denied | yes |
| `refunds/approve_refunds` | `store_owner` | `full` | granted | granted | `true` | granted | yes |
| `refunds/approve_refunds` | `technician` | `none` | denied | denied | `false` | denied | yes |

What the data model leaves open, and how the re-pin meets it: The catalog represents refund approval twice, and links the two only through `approve_refunds`' default-by-level path (`refunds` at `approve`), which every canonical role's explicit catalog grant overrides. The client's supervisor refund authorization requires both: the `refunds` level at `approve` and an `approve_refunds` entry that is absent or true. D2's explicit per-role grant is applied to BOTH representations, and today each role carries the same value on both, so in the candidate neither is decided by a level any more. The two still differ in one step the re-pin keeps: the threshold's comparison IS its grant step, so the explicit grant replaces it outright, while `approve_refunds` keeps its `refunds` minimum (`view`), read before the grant. With today's values both agree for every role in every context (the D2 suite checks it); a later value change should set both together, or a role holding `refunds` at `none` could pass the threshold while the sub-permission still refuses it. The refunds narrowing below is a third comparison on the same domain; it is not a documented money action and is not re-pinned.

#### `return_approval`

Authoritative source:

- `docs/phase-4/04-canonical-iam-and-four-user-migration.md` — "including money-sensitive ones (`refunds: approve` / `approve_refunds`, `returns: approve_return`)"

| representation | kind | changes under the flip | decided after the re-pin by |
| --- | --- | --- | --- |
| `tenant/returns/approve_return` | named sub-permission | no | its D2 explicit per-role grant |

| representation | role | holds | authoritative | pre-re-pin | explicit grant | post-re-pin | preserved |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `returns/approve_return` | `manager` | `manage` | granted | granted | `true` | granted | yes |
| `returns/approve_return` | `sales_staff` | `view` | denied | denied | `false` | denied | yes |
| `returns/approve_return` | `store_owner` | `full` | granted | granted | `true` | granted | yes |
| `returns/approve_return` | `technician` | `view` | denied | denied | `false` | denied | yes |

What the data model leaves open, and how the re-pin meets it: One representation: the `approve_return` sub-permission. Its minimum module level `manage` is a prerequisite, read BEFORE the grant step, and the re-pin keeps it there: it can still deny, never grant. A role holding `returns` at `approve` clears it today and would not under the unified ordering — no canonical role holds that level, which is why no row changes. The explicit grant replaces the per-role catalog grant and the default-by-level path together. The server catalog has only its four fixed tenant roles; a custom role created in the client's Employees screen stores only the sub-permissions an owner toggled, and has no D2 grant — under the re-pin it would be denied, where today the client's default path would decide.

#### `platform_billing_approval`

Authoritative sources:

- `src/owner/platformPermissionsConfig.ts` — "id: 'approve_billing_actions', label: 'Approve Billing Actions', description: 'Approve refunds, credits, or write-offs.', threshold: 'approve'"
- `docs/phase-1.3-platform-access-inventory.md` — "financial approval (refund/credit/write-off)"

| representation | kind | changes under the flip | decided after the re-pin by |
| --- | --- | --- | --- |
| `platform/billing_subscriptions/approve_billing_actions` | named sub-permission | no | its D2 explicit per-role grant |

| representation | role | holds | authoritative | pre-re-pin | explicit grant | post-re-pin | preserved |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `billing_subscriptions/approve_billing_actions` | `billing_admin` | `full` | granted | granted | `true` | granted | yes |
| `billing_subscriptions/approve_billing_actions` | `operations_admin` | `view` | denied | denied | `false` | denied | yes |
| `billing_subscriptions/approve_billing_actions` | `security_admin` | `view` | denied | denied | `false` | denied | yes |
| `billing_subscriptions/approve_billing_actions` | `support_admin` | `view` | denied | denied | `false` | denied | yes |
| `billing_subscriptions/approve_billing_actions` | `system_owner` | `full` | granted | granted | `true` | granted | yes |

What the data model leaves open, and how the re-pin meets it: Platform plane. That plane already ranks `approve` below `manage`, so the unified ordering cannot move it (0 platform rows change). Under the re-pin its threshold is replaced by the explicit grant; it has no platform prerequisite, and the read-only limitation still refuses it.

**What this means.** On every documented money action, for every canonical role, neither candidate
view changes the answer: the manager already holds `refunds` at `approve`, every non-owner tenant
role holds explicit catalog grants for `approve_refunds` and `approve_return` that are read before the
default-by-level path, no canonical role holds the `approve` level that `approve_return`'s `manage`
minimum would stop admitting, and D2's explicit grants carry exactly today's answers. 04 §3's warning
that the manager "would silently gain approval capability it did not have" does not materialize on
these operations for the catalog's roles; the structural widening sits on the `unresolved` rows of
section C, which D2 does not re-pin.

## C. Unresolved mapping

These rows require the `approve` level but **no authoritative document ties them to a money
action**. They are structural facts, not D2 rows: D2's explicit grants do not apply to them, and they
keep the unified ordering's rules in the post-re-pin view. No document is taken to classify them here.

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

### All 188 unresolved mappings

Every unresolved tuple, grouped by what it gates. Each "granted" column lists the roles that view
allows; every other role of the plane is denied. "changes" counts the roles whose post-re-pin answer
differs from the authoritative one.

| plane/stratum | scope | action | roles | granted — authoritative | granted — pre-re-pin | granted — post-re-pin | changes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `platform/domain_threshold` | `addon_governance` | `require:approve` | 5 | `billing_admin`, `system_owner` | `billing_admin`, `system_owner` | `billing_admin`, `system_owner` | 0 |
| `platform/domain_threshold` | `audit_security` | `require:approve` | 5 | `security_admin`, `system_owner` | `security_admin`, `system_owner` | `security_admin`, `system_owner` | 0 |
| `platform/domain_threshold` | `billing_subscriptions` | `require:approve` | 5 | `billing_admin`, `system_owner` | `billing_admin`, `system_owner` | `billing_admin`, `system_owner` | 0 |
| `platform/domain_threshold` | `command_center` | `require:approve` | 5 | `operations_admin`, `security_admin`, `support_admin`, `system_owner` | `operations_admin`, `security_admin`, `support_admin`, `system_owner` | `operations_admin`, `security_admin`, `support_admin`, `system_owner` | 0 |
| `platform/domain_threshold` | `domains` | `require:approve` | 5 | `operations_admin`, `system_owner` | `operations_admin`, `system_owner` | `operations_admin`, `system_owner` | 0 |
| `platform/domain_threshold` | `feature_matrix` | `require:approve` | 5 | `billing_admin`, `operations_admin`, `system_owner` | `billing_admin`, `operations_admin`, `system_owner` | `billing_admin`, `operations_admin`, `system_owner` | 0 |
| `platform/domain_threshold` | `platform_settings` | `require:approve` | 5 | `security_admin`, `system_owner` | `security_admin`, `system_owner` | `security_admin`, `system_owner` | 0 |
| `platform/domain_threshold` | `provisioning` | `require:approve` | 5 | `operations_admin`, `system_owner` | `operations_admin`, `system_owner` | `operations_admin`, `system_owner` | 0 |
| `platform/domain_threshold` | `support_tools` | `require:approve` | 5 | `operations_admin`, `security_admin`, `support_admin`, `system_owner` | `operations_admin`, `security_admin`, `support_admin`, `system_owner` | `operations_admin`, `security_admin`, `support_admin`, `system_owner` | 0 |
| `platform/domain_threshold` | `team_management` | `require:approve` | 5 | `security_admin`, `system_owner` | `security_admin`, `system_owner` | `security_admin`, `system_owner` | 0 |
| `platform/domain_threshold` | `tenant_management` | `require:approve` | 5 | `operations_admin`, `system_owner` | `operations_admin`, `system_owner` | `operations_admin`, `system_owner` | 0 |
| `platform/sub_permission` | `addon_governance` | `edit_addon_overrides` | 5 | `billing_admin`, `system_owner` | `billing_admin`, `system_owner` | `billing_admin`, `system_owner` | 0 |
| `platform/sub_permission` | `addon_governance` | `grant_paid_override` | 5 | `billing_admin`, `system_owner` | `billing_admin`, `system_owner` | `billing_admin`, `system_owner` | 0 |
| `platform/sub_permission` | `addon_governance` | `grant_trial` | 5 | `billing_admin`, `system_owner` | `billing_admin`, `system_owner` | `billing_admin`, `system_owner` | 0 |
| `platform/sub_permission` | `addon_governance` | `revoke_addon_override` | 5 | `billing_admin`, `system_owner` | `billing_admin`, `system_owner` | `billing_admin`, `system_owner` | 0 |
| `platform/sub_permission` | `audit_security` | `delete_security_note` | 5 | `security_admin`, `system_owner` | `security_admin`, `system_owner` | `security_admin`, `system_owner` | 0 |
| `platform/sub_permission` | `audit_security` | `export_audit_csv` | 5 | `security_admin`, `system_owner` | `security_admin`, `system_owner` | `security_admin`, `system_owner` | 0 |
| `platform/sub_permission` | `audit_security` | `view_restricted_audit_details` | 5 | `security_admin`, `system_owner` | `security_admin`, `system_owner` | `security_admin`, `system_owner` | 0 |
| `platform/sub_permission` | `support_tools` | `change_escalation_level` | 5 | `operations_admin`, `security_admin`, `support_admin`, `system_owner` | `operations_admin`, `security_admin`, `support_admin`, `system_owner` | `operations_admin`, `security_admin`, `support_admin`, `system_owner` | 0 |
| `platform/sub_permission` | `support_tools` | `resolve_escalation` | 5 | `operations_admin`, `security_admin`, `support_admin`, `system_owner` | `operations_admin`, `security_admin`, `support_admin`, `system_owner` | `operations_admin`, `security_admin`, `support_admin`, `system_owner` | 0 |
| `tenant/domain_threshold` | `customers` | `require:approve` | 4 | `manager`, `store_owner` | `manager`, `store_owner` | `manager`, `store_owner` | 0 |
| `tenant/domain_threshold` | `dashboard` | `require:approve` | 4 | `manager`, `store_owner` | `manager`, `store_owner` | `manager`, `store_owner` | 0 |
| `tenant/domain_threshold` | `employees` | `require:approve` | 4 | `store_owner` | `manager`, `store_owner` | `manager`, `store_owner` | **1** |
| `tenant/domain_threshold` | `integrations` | `require:approve` | 4 | `store_owner` | `manager`, `store_owner` | `manager`, `store_owner` | **1** |
| `tenant/domain_threshold` | `inventory` | `require:approve` | 4 | `store_owner` | `manager`, `store_owner` | `manager`, `store_owner` | **1** |
| `tenant/domain_threshold` | `invoices` | `require:approve` | 4 | `manager`, `store_owner` | `manager`, `store_owner` | `manager`, `store_owner` | 0 |
| `tenant/domain_threshold` | `marketing` | `require:approve` | 4 | `store_owner` | `manager`, `store_owner` | `manager`, `store_owner` | **1** |
| `tenant/domain_threshold` | `prospects` | `require:approve` | 4 | `manager`, `store_owner` | `manager`, `store_owner` | `manager`, `store_owner` | 0 |
| `tenant/domain_threshold` | `repairs` | `require:approve` | 4 | `manager`, `store_owner` | `manager`, `store_owner`, `technician` | `manager`, `store_owner`, `technician` | **1** |
| `tenant/domain_threshold` | `reports` | `require:approve` | 4 | `manager`, `store_owner` | `manager`, `store_owner` | `manager`, `store_owner` | 0 |
| `tenant/domain_threshold` | `returns` | `require:approve` | 4 | `store_owner` | `manager`, `store_owner` | `manager`, `store_owner` | **1** |
| `tenant/domain_threshold` | `sales` | `require:approve` | 4 | `manager`, `store_owner` | `manager`, `store_owner` | `manager`, `store_owner` | 0 |
| `tenant/domain_threshold` | `services` | `require:approve` | 4 | `manager`, `store_owner` | `manager`, `store_owner` | `manager`, `store_owner` | 0 |
| `tenant/domain_threshold` | `settings` | `require:approve` | 4 | `store_owner` | `manager`, `store_owner` | `manager`, `store_owner` | **1** |
| `tenant/domain_threshold` | `shipping` | `require:approve` | 4 | `store_owner` | `manager`, `store_owner` | `manager`, `store_owner` | **1** |
| `tenant/domain_threshold` | `suggestive_sales` | `require:approve` | 4 | `store_owner` | `manager`, `store_owner` | `manager`, `store_owner` | **1** |
| `tenant/domain_threshold` | `supply_chain` | `require:approve` | 4 | `store_owner` | `manager`, `store_owner` | `manager`, `store_owner` | **1** |
| `tenant/domain_threshold` | `support` | `require:approve` | 4 | `manager`, `store_owner` | `manager`, `store_owner` | `manager`, `store_owner` | 0 |
| `tenant/domain_threshold` | `warranties` | `require:approve` | 4 | `store_owner` | `manager`, `store_owner` | `manager`, `store_owner` | **1** |
| `tenant/domain_threshold` | `widgets` | `require:approve` | 4 | `store_owner` | `manager`, `store_owner` | `manager`, `store_owner` | **1** |
| `tenant/sub_permission` | `employees` | `approve_requests` | 4 | `store_owner` | `store_owner` | `store_owner` | 0 |
| `tenant/sub_permission` | `inventory` | `approve_inventory` | 4 | `store_owner` | `store_owner` | `store_owner` | 0 |

## D. The D2 re-pin — explicit money-action grants (candidate only)

Owner decision D2, as the candidate implements it:

1. Every `money_action` tuple requires an explicit per-role grant, and only `true` can allow it.
2. `false`, a missing entry, a malformed value or an unknown entry denies. The table is closed — one
   entry per money-action tuple, nothing else — and a table that does not audit clean honors no grant.
3. No level (`approve`, `manage`, `full`) and no ordering comparison grants a money action by
   itself: the explicit grant replaces exactly the step that confers the grant — a threshold tuple's
   level comparison; for a tenant sub-permission the owner short-circuit, the per-role catalog grant and
   the default-by-level path; for a platform sub-permission its threshold.
4. The grant is necessary, never sufficient. Every other step keeps its place and can only deny: the
   plan gates, a non-owner's parent-module minimum, platform prerequisites, and the read-only
   limitation. Identity, scope, session and route constraints are enforced outside this model and are
   unchanged.
5. Each value below equals the tuple's authoritative answer today. No new business entitlement is
   created, and changing a value is a new owner policy decision.

The grants live in `D2_EXPLICIT_MONEY_ACTION_GRANTS` (`server/platform-identity/gap11GrantDiff.ts`),
which no production module imports; the post-re-pin view reads them, the authority never does.

| plane/stratum | role | scope | action | explicit grant | authoritative | pre-re-pin | post-re-pin | preserved |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `platform/sub_permission` | `billing_admin` | `billing_subscriptions` | `approve_billing_actions` | `true` | granted | granted | granted | yes |
| `platform/sub_permission` | `operations_admin` | `billing_subscriptions` | `approve_billing_actions` | `false` | denied | denied | denied | yes |
| `platform/sub_permission` | `security_admin` | `billing_subscriptions` | `approve_billing_actions` | `false` | denied | denied | denied | yes |
| `platform/sub_permission` | `support_admin` | `billing_subscriptions` | `approve_billing_actions` | `false` | denied | denied | denied | yes |
| `platform/sub_permission` | `system_owner` | `billing_subscriptions` | `approve_billing_actions` | `true` | granted | granted | granted | yes |
| `tenant/domain_threshold` | `manager` | `refunds` | `require:approve` | `true` | granted | granted | granted | yes |
| `tenant/domain_threshold` | `sales_staff` | `refunds` | `require:approve` | `false` | denied | denied | denied | yes |
| `tenant/domain_threshold` | `store_owner` | `refunds` | `require:approve` | `true` | granted | granted | granted | yes |
| `tenant/domain_threshold` | `technician` | `refunds` | `require:approve` | `false` | denied | denied | denied | yes |
| `tenant/sub_permission` | `manager` | `refunds` | `approve_refunds` | `true` | granted | granted | granted | yes |
| `tenant/sub_permission` | `manager` | `returns` | `approve_return` | `true` | granted | granted | granted | yes |
| `tenant/sub_permission` | `sales_staff` | `refunds` | `approve_refunds` | `false` | denied | denied | denied | yes |
| `tenant/sub_permission` | `sales_staff` | `returns` | `approve_return` | `false` | denied | denied | denied | yes |
| `tenant/sub_permission` | `store_owner` | `refunds` | `approve_refunds` | `true` | granted | granted | granted | yes |
| `tenant/sub_permission` | `store_owner` | `returns` | `approve_return` | `true` | granted | granted | granted | yes |
| `tenant/sub_permission` | `technician` | `refunds` | `approve_refunds` | `false` | denied | denied | denied | yes |
| `tenant/sub_permission` | `technician` | `returns` | `approve_return` | `false` | denied | denied | denied | yes |

**Preserved: 17 of 17** in this context. The D2 suite checks the same in every
entitlement and limitation context the matrix sweeps, and proves the controls: a missing, `false`,
malformed, duplicated or unknown grant denies; an `approve`, `manage` or `full` holder is denied
without its grant; and a grant still cannot pass a disabled plan gate, the read-only limitation, the
`manage` minimum of `approve_return`, or another tuple's scope.

## E. The final diff for D3

### Counts in each view

| compared against the authority | evaluated | unchanged | widened | narrowed |
| --- | --- | --- | --- | --- |
| pre-re-pin candidate (the ordering flip alone) | 1659 | 1646 | 12 | 1 |
| post-re-pin candidate (the flip with D2's grants) | 1659 | 1646 | 12 | 1 |

### Four kinds of change, kept apart

| kind | tuples | what it is |
| --- | --- | --- |
| **structural ordering changes** — authority vs pre-re-pin | 13 (12 widened, 1 narrowed) | the comparisons the unified ordering moves (section A); none is a money action |
| **explicit-grant representation changes** — how a tuple is decided | 17 | the money-action tuples now decided by a D2 explicit grant instead of a level; 0 of them change their answer |
| **re-pin effect** — pre-re-pin vs post-re-pin | 0 | tuples whose answer the re-pin itself moves |
| **net effective authorization changes** — authority vs post-re-pin | 13 (12 widened, 1 narrowed; 0 decided by an explicit grant) | what a cutover would change, and what D3 approves |

| intended or still unapproved | tuples | status |
| --- | --- | --- |
| intended — decided by the owner | 17 | the money-action answers, preserved by D2's explicit grants |
| **still unapproved** | 13 | **the net effective changes below — awaiting D3** |

### Every changed tuple

| scope | role | domain | action | D2 classification | authoritative | pre-re-pin | post-re-pin | explicit grant | classification source | reason |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `tenant` | `manager` | `employees` | `require:approve` | `unresolved` | denied | granted | granted | — | catalog: decisive level `approve`; no document names it a money action | holds `manage`; the unified ordering ranks `manage` above `approve`, so it now clears the `approve` gate; not a money action, so the re-pin leaves it |
| `tenant` | `manager` | `integrations` | `require:approve` | `unresolved` | denied | granted | granted | — | catalog: decisive level `approve`; no document names it a money action | holds `manage`; the unified ordering ranks `manage` above `approve`, so it now clears the `approve` gate; not a money action, so the re-pin leaves it |
| `tenant` | `manager` | `inventory` | `require:approve` | `unresolved` | denied | granted | granted | — | catalog: decisive level `approve`; no document names it a money action | holds `manage`; the unified ordering ranks `manage` above `approve`, so it now clears the `approve` gate; not a money action, so the re-pin leaves it |
| `tenant` | `manager` | `marketing` | `require:approve` | `unresolved` | denied | granted | granted | — | catalog: decisive level `approve`; no document names it a money action | holds `manage`; the unified ordering ranks `manage` above `approve`, so it now clears the `approve` gate; not a money action, so the re-pin leaves it |
| `tenant` | `manager` | `refunds` | `require:manage` | `not_money_action` | granted | denied | denied | — | catalog: decisive level `manage`, not `approve`; no document names it | holds `approve`; the unified ordering ranks `approve` below `manage`, so it no longer clears the `manage` gate; not a money action, so the re-pin leaves it |
| `tenant` | `manager` | `returns` | `require:approve` | `unresolved` | denied | granted | granted | — | catalog: decisive level `approve`; no document names it a money action | holds `manage`; the unified ordering ranks `manage` above `approve`, so it now clears the `approve` gate; not a money action, so the re-pin leaves it |
| `tenant` | `manager` | `settings` | `require:approve` | `unresolved` | denied | granted | granted | — | catalog: decisive level `approve`; no document names it a money action | holds `manage`; the unified ordering ranks `manage` above `approve`, so it now clears the `approve` gate; not a money action, so the re-pin leaves it |
| `tenant` | `manager` | `shipping` | `require:approve` | `unresolved` | denied | granted | granted | — | catalog: decisive level `approve`; no document names it a money action | holds `manage`; the unified ordering ranks `manage` above `approve`, so it now clears the `approve` gate; not a money action, so the re-pin leaves it |
| `tenant` | `manager` | `suggestive_sales` | `require:approve` | `unresolved` | denied | granted | granted | — | catalog: decisive level `approve`; no document names it a money action | holds `manage`; the unified ordering ranks `manage` above `approve`, so it now clears the `approve` gate; not a money action, so the re-pin leaves it |
| `tenant` | `manager` | `supply_chain` | `require:approve` | `unresolved` | denied | granted | granted | — | catalog: decisive level `approve`; no document names it a money action | holds `manage`; the unified ordering ranks `manage` above `approve`, so it now clears the `approve` gate; not a money action, so the re-pin leaves it |
| `tenant` | `manager` | `warranties` | `require:approve` | `unresolved` | denied | granted | granted | — | catalog: decisive level `approve`; no document names it a money action | holds `manage`; the unified ordering ranks `manage` above `approve`, so it now clears the `approve` gate; not a money action, so the re-pin leaves it |
| `tenant` | `manager` | `widgets` | `require:approve` | `unresolved` | denied | granted | granted | — | catalog: decisive level `approve`; no document names it a money action | holds `manage`; the unified ordering ranks `manage` above `approve`, so it now clears the `approve` gate; not a money action, so the re-pin leaves it |
| `tenant` | `technician` | `repairs` | `require:approve` | `unresolved` | denied | granted | granted | — | catalog: decisive level `approve`; no document names it a money action | holds `manage`; the unified ordering ranks `manage` above `approve`, so it now clears the `approve` gate; not a money action, so the re-pin leaves it |

## The `manager` / `refunds` narrowing

| question | answer |
| --- | --- |
| level held | `manager` holds `approve` on `refunds` (role default) |
| level required | `manage` — the tuple `refunds/require:manage` |
| BEFORE | **granted** — the tenant ordering ranks `approve` (5) above `manage` (4), so an `approve` holder clears a `manage` gate |
| AFTER-CANDIDATE | **denied** — the unified ordering ranks `approve` (4) below `manage` (5), so it no longer does |
| AFTER-REPIN | **denied** — the re-pin does not touch it: the tuple is not a money action, so it keeps the unified ordering's rule |
| a real refund money action? | **No — a domain-threshold decision only** (D2 classification `not_money_action`). Refund approval is documented as `refunds: approve` / `approve_refunds` (section B); nothing documents `refunds` at `manage`. No catalog sub-permission uses that comparison — `process_refunds` (minimum `view`, default `create`), `approve_refunds` (minimum `view`, default `approve`) — and the client offers no `manage` level on `refunds` at all. |
| does D2 affect it? | **No.** D2 was decided as an explicit per-role grant, applied to both refund-approval representations (`refunds/require:approve` and `approve_refunds`), not as a "`≥ manage`" domain-level gate. So this comparison is not the manager's refund-approval check: the manager's refund approval is decided by its explicit grants, which are `true` and preserved. |
| what remains for D3 | Approval of this row, as of every changed row: accepting that under the unified ordering an `approve` holder no longer clears a `manage` gate on `refunds`. |

## The D3 decision

D2 is decided and is not asked again. What is open is **D3**: the owner's explicit approval of the net
effective change in section E — 13 rows, identified exactly by the post-re-pin row
fingerprint below. The owner can:

- **Approve** the diff as listed. That accepts, for a future cutover: the manager newly clearing an
  `approve` gate on 11 domains and the technician on `repairs` (the 12 widened
  rows, all `unresolved`); the manager no longer clearing the `manage` gate on `refunds` (the
  1 narrowed row, `not_money_action`); and the 17 money actions decided by the explicit grants in section D,
  each with today's answer. Approval does not cut anything over: the cutover stays a separate step.
- **Reject** some or all rows. Each rejected row then needs its own re-pin — an explicit per-role
  value or a changed role level — before any cutover, and each such re-pin is a new decision.
- **Revise** and approve again. Changing an explicit grant value, re-pinning an `unresolved` row,
  or changing a role's level regenerates this artifact with a new fingerprint; D3 then approves that
  fingerprint instead. An `unresolved` row becomes a money action only if an authoritative document
  says so.

## Fingerprints

| input | sha256 |
| --- | --- |
| normalized authorization inputs | `3e496550eb71b1fb9a916c82568e0685a2467798e288dcafa575e3645480af08` |
| diff rows (canonical serialization) | `e7bee0bdcfc19dc9ab6acc4edd57df8d5fab3a1c1dfb19c8a0233ad5faacf186` |
| summary (canonical serialization) | `0861bb6fee9af28aecdbd0131b153a14deebd5e85940041159a8668f2f7688ee` |
| post-re-pin diff rows — the diff D3 approves | `e7bee0bdcfc19dc9ab6acc4edd57df8d5fab3a1c1dfb19c8a0233ad5faacf186` |
| post-re-pin summary | `0861bb6fee9af28aecdbd0131b153a14deebd5e85940041159a8668f2f7688ee` |
| money-action outcomes, all three views | `8f637dbfae84d8fbdef9381972e0a3276801ac6f83e6ed66f1c961a85e7c9ff1` |
| unresolved mappings, all three views | `0383e6911362bbccd93aed5a279860ead33920522d0a06a1ae4eb3bd7da1efd7` |

The first fingerprint covers every catalog input this diff reads — orderings, roles, domains,
features, actions, thresholds, role defaults, explicit grants, entitlement gates and dependencies —
and the D2 inputs (the money-action registry with its quoted sources, the named-grant-only list, and
the explicit money-action grants), serialized with sorted keys at every level. If it changes, this
artifact is stale and the repository test fails.

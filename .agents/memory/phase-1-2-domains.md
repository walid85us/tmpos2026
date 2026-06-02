---
name: Phase 1.2 Domains + Platform Settings Maturity
description: Where domain lifecycle/readiness helpers live, the raw-vs-normalized model split, and the truth constraints for the Domains surface
---

## Domain readiness helpers live in their own module
Phase 1.2 domain lifecycle/readiness/posture helpers live in `src/owner/platformOpsDomains.ts`, NOT in `platformOpsDerive.ts`.
**Why:** `platformOpsDerive.ts` is the locked Advanced Command Center Intelligence source of truth (~3,200 lines) and already consumes domain data for tenant-risk/attention/distribution signals — those are locked and must stay read-only. Same discipline as the Audit Investigation Center (`platformOpsInvestigation.ts`).
**How to apply:** add new domain governance derivations to `platformOpsDomains.ts`. Do not modify the domain signal logic inside `platformOpsDerive.ts`.

## Raw status stays the source of truth; lifecycle is a derived display layer
The persisted model is `TenantDomainRecord` with `DomainStatus` ('pending'|'verifying'|'verified'|'failed'|'disabled') + `DomainSslStatus` ('none'|'pending'|'active'|'failed') + `DomainKind` ('subdomain'|'custom') in `mockData.ts`. Phase 1.2 adds a NORMALIZED `DomainLifecycleStatus` (draft/pending_dns/pending_verification/verified/ssl_pending/ssl_ready/failed/disabled) derived from the (status, ssl, kind) triple via `deriveDomainLifecycle`.
**Why:** Command Center intelligence + the audit trail consume the raw status/ssl values; replacing them would regress locked surfaces. The lifecycle is display-only.
**How to apply:** never persist lifecycle as the stored value; always derive it. `'draft'` is in the union/labels for vocabulary completeness but is NOT emitted by the deriver yet (no explicit pre-DNS draft persistence exists).

## Domains truth constraints (no fake DNS/SSL)
No real DNS lookup, no real SSL issuance, no real provisioning, no provider API. Verification is MANUAL — the operator flips status/SSL after confirming propagation out-of-band. Required DNS records are copy templates (CNAME→`proxy.repairplatform.com`, TXT `_repairplatform.<host>`=`verify=<id>`), centralized in `platformOpsDomains.ts` so the page and helpers can't drift. Three truth labels: manual-only, rule-based readiness, provider integrations are future Phase 2.
**How to apply:** any "readiness"/"check" wording must stay rule-based-from-session; never imply a live check happened.

## No-drift counts = faceted counts from ONE predicate
For any surface with summary cards/tabs + a filtered list, every count must be computed from the SAME predicate as the list — merge each control's own dimension override onto the currently-active filters (`countWith(overrides) = items.filter(matches({...filters, ...overrides}))`). Do NOT compute card counts from a separate global posture deriver or count tabs by a single dimension only — that drifts the moment any other filter is active.
**Why:** the locked rule is "count cards and filtered lists must use the same predicate." A code review failed M2 because tab counts ignored non-lifecycle filters and cards used `deriveDomainPosture` (global), both of which drift under active search/kind/ssl filters.
**How to apply:** one `matchesX` predicate; the visible list and all counts call it. The number on any control then always equals what the list shows when that control is selected.

## Destructive transitions never go through a silent select
Disable/re-enable (and similar destructive state changes) must be explicit confirmed actions, never an option inside an onChange `<select>`. Exclude the destructive value from the select's options and render a static badge when already in that state; restore via an explicit button.
**Why:** a select `onChange` mutates immediately with no confirmation, bypassing the in-app confirm-modal requirement.

## Page-visibility gate ≠ child view_* sub-permission
An owner page's in-component view gate must use `hasEffectiveFeatureAccess(role, <featureKey>)` (parent level OR any child sub-permission ≥ view), NOT `hasPlatformPermission(role,'view_<feature>')`. Action/edit gating still uses the exact child sub-permission (e.g. `edit_platform_settings`).
**Why:** the locked Global Permissions Matrix rule says sidebar/page visibility = effective access; using the child `view_*` wrongly denies valid configs (parent grants but child view explicit none; or child edit granted but view not). A code review failed M3 on exactly this. The route's `<AccessGuard feature=...>` already uses effective access, so the in-page gate must match it.
**How to apply:** `const canView = hasEffectiveFeatureAccess(role, 'platform_settings');` for the No-access panel; keep `edit_*` for mutation gating. (Note: M2 DomainsPage used `view_domains` for its page gate and was already user-approved — left as-is; new pages should use effective access.)

## Every mutation entrypoint must self-gate on canEdit
A `canEdit`-hidden button is not enough — each handler that mutates state (update/review/save/reset AND discard) must start with `if (!canEdit) return;`. A code review failed M4 because `discardGroup` relied only on the button being hidden. Also enforce confirmation gates (e.g. high-risk acknowledgment) inside the confirm handler, not only via the disabled-button state, to avoid UI-bypass edge cases.

## Save-review modal must derive from the unfiltered change set
When a page has search/group filters AND a per-group "Review & Save" flow, the review modal must list changes from the unfiltered `changedByGroup[group]`, never from the filtered/rendered subset — otherwise an active filter could hide a pending change that is about to be persisted. One predicate (`isChangedFromPersisted`) feeds dirty counts, badges, review list, and the audit note so they cannot drift.

## Milestone discipline for Phase 1.2
Built milestone-by-milestone with a STOP for review after each. Order: M1 Domains foundation (helpers/model, minimal UI) → M2 Domain lifecycle/DNS/SSL readiness UX → M3 Platform Settings governance model → M4 Settings change review/impact/audit UX → M5 cross-surface integration + docs + non-regression. Do not implement future milestones early; the existing domain audit actions (`domain_created`/`domain_status_changed`/`domain_ssl_changed`/`domain_disabled`/`domain_reenabled`/`domain_deleted`) and `view_domains`/`manage_domain_lifecycle` permissions already exist.

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

## Milestone discipline for Phase 1.2
Built milestone-by-milestone with a STOP for review after each. Order: M1 Domains foundation (helpers/model, minimal UI) → M2 Domain lifecycle/DNS/SSL readiness UX → M3 Platform Settings governance model → M4 Settings change review/impact/audit UX → M5 cross-surface integration + docs + non-regression. Do not implement future milestones early; the existing domain audit actions (`domain_created`/`domain_status_changed`/`domain_ssl_changed`/`domain_disabled`/`domain_reenabled`/`domain_deleted`) and `view_domains`/`manage_domain_lifecycle` permissions already exist.

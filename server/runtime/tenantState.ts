// Phase 4.0 M5 — the ONE tenant-state decision (M5-GIAM-D1-P2; GAP-13, G-IAM; docs/phase-4/04 §2).
//
// A tenant or store has a durable lifecycle status, and that status decides what its people may do before
// any role or permission is considered. This module is where that is decided — once, for every tenant and
// store boundary — so no handler ever repeats it and no handler can forget it. It holds the DECISION only:
// no database, no session, no clock, no Express, nothing but the values it is handed.
//
// THE DECISION, over the closed domain migration 002 pins for tenant.status and store.status
// ('active', 'trialing', 'overdue', 'suspended', 'read_only', 'pending_activation'):
//   active, trialing                  -> 'active'    — continue, subject to the normal authorization;
//   read_only, overdue                -> 'read_only' — reads the role allows still answer; nothing that
//                                                      changes state may run;
//   suspended, pending_activation     -> 'denied'    — no protected tenant or store access at all;
//   anything else, including absent, malformed, or a value a later migration adds without teaching this
//   module what it means -> 'denied'. A status this code does not recognise is not a status it may act on.
// A request under a store carries both statuses, and the WIDEST restriction wins: a read-only tenant makes
// its active store read-only, and a suspended tenant denies its active store.
//
// WHY 'denied' AND NOT 'read_only' FOR A SUSPENDED TENANT. Suspension withdraws access; it is not a
// softer form of it. The authorization resolver has always treated it so (authorizationConstants.ts
// STATUS_DENY_BEFORE_ROLE, migration 007's resolver, which filters such memberships out entirely), and this
// module states the same rule in the runtime, where it is enforced whatever a resolver returns.
//
// THE ACCESS VERSION, AND HOW IT IS ENFORCED (M5-GIAM-D1-P2-R1; doc 08 DA-32). Migration 010 keeps
// public.tenant.access_version: it moves by exactly one on every suspension and every reactivation and never
// returns to a value it has held, while a harmless profile edit moves only row_version.
//
// THE COMPARISON IS NOT MADE HERE, and this module says so rather than keeping a second one that could drift
// from the real one. The tenant boundary admits a session at ONE opaque security version and refuses it the
// moment that version moves (sessions.ts), so the per-tenant comparison is folded into that one value: the
// PostgreSQL admission adapter digests the actor's whole standing — every grant, and every grant's tenant
// access version — into the witness the session is bound to (postgresTenantAdmission.ts, migration 011).
// Suspension removes the grant AND moves the version; reactivation moves it again, to a value it has never
// held, so the witness after a suspend-and-reactivate differs from the witness before it and an idle session
// is not revived. A display-name edit moves only row_version, which is not digested, so it ends no session.
//
// WHAT THAT LEAVES THIS MODULE. The lifecycle decision below, which `selectScope` applies to every tenant and
// store request, and which the admission adapter's answer feeds. It holds no version comparison of its own.
//
// PURE AND PORTABLE: part of the emitted runtime artifact, importing nothing outside server/runtime.

/** What a tenant's or store's lifecycle status allows, before any role or permission is considered. */
export type TenantStateDecision = 'active' | 'read_only' | 'denied';

/** Statuses under which a tenant or store operates normally. */
const ACTIVE_STATUSES: ReadonlySet<string> = new Set(['active', 'trialing']);
/** Statuses that keep reads but forbid every state change (authorizationResolver.ts, principals.ts). */
const READ_ONLY_STATUSES: ReadonlySet<string> = new Set(['read_only', 'overdue']);
/** Statuses that deny protected access outright (authorizationConstants.ts STATUS_DENY_BEFORE_ROLE). */
const DENIED_STATUSES: ReadonlySet<string> = new Set(['suspended', 'pending_activation']);

/** The decision for one status. Absent, malformed or unrecognised is 'denied' — never a default to access. */
export function decideStatus(status: unknown): TenantStateDecision {
  if (typeof status !== 'string') return 'denied';
  if (ACTIVE_STATUSES.has(status)) return 'active';
  if (READ_ONLY_STATUSES.has(status)) return 'read_only';
  if (DENIED_STATUSES.has(status)) return 'denied';
  return 'denied'; // a value this module has not been taught: fail closed
}

/**
 * The decision for a request under `tenantStatus`, and `storeStatus` when it is under a store: the widest
 * restriction of the two. null means the scope has none — a platform request has neither, and a
 * tenant-scope request has no store — and contributes nothing; a scope that HAS a status must present one,
 * so an absent value where one belongs is the caller's error and is refused by `decideStatus`.
 */
export function decideTenantState(tenantStatus: string | null, storeStatus: string | null): TenantStateDecision {
  const decisions: TenantStateDecision[] = [];
  if (tenantStatus !== null) decisions.push(decideStatus(tenantStatus));
  if (storeStatus !== null) decisions.push(decideStatus(storeStatus));
  if (decisions.includes('denied')) return 'denied';
  return decisions.includes('read_only') ? 'read_only' : 'active';
}

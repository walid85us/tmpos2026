# Phase 1.6 — Milestone 17: Live Authorization Evidence

## 1. Title

Phase 1.6 Milestone 17 — Server-Derived Live Authorization One-Shot: Redaction-Safe Evidence Record (M17.2 preparation → M17.3 PASS → M17.4 closure).

## 2. Purpose

Preserve, in a repository-durable and redaction-safe form, the evidence of the first DEV-only live
server-derived authorization one-shot. Prior to this document the proof existed only in conversation
history plus one durable `audit_event` row; M17.2/M17.3/M17.4 produced **no source changes**. This file
records only **counts, booleans, safe phase labels, and high-level conclusions** — never raw payloads,
key names, or identity values — so the proof is retained without weakening the redaction boundary that
M17.1 established.

## 3. Accepted Checkpoint

- Accepted checkpoint commit: `dfbefbbffc5dc29d0df342d9f7f52e11b4950c28`
- Commit subject: "Phase 1.6 M17.1 add safe live authz redacted summary"
- M17.2 (execution preparation), M17.3 (execution), and M17.4 (closure) introduced **no source/docs/
  scripts/package/migration/seed changes**; this M18.1 document is the first repository artifact added
  after that checkpoint.

## 4. Scope and Non-Goals

**In scope:** a redaction-safe written record of the M17 evidence and the open readiness questions.

**Non-goals (explicitly):** no runtime change; no wiring of the redacted summary; no enabling or running
of live authorization; no route/harness/feed/token/comparison invocation; no DB connection or SQL; no
change to AccessContext / Login / AccessGuard / App routing / `src/main.tsx` / `src/pilot/**`; no
production work. The M11→M15 + M17.1 path **remains dormant** and is **not** wired anywhere.

## 5. M17 Timeline

| Sub-milestone | Nature | Outcome |
|---|---|---|
| M17 Planning | Planning | Concluded: redact output before any live run; defer execution. |
| M17.1 | Additive, dormant, DEV-only | Added the pure redacted-summary projection (counts + booleans only). Committed at the accepted checkpoint. |
| M17.2 | Planning / execution preparation | Defined the exact server setup, flag plan, browser command sequence, PASS/FAIL criteria. No source change. |
| M17.3 | Owner-approved execution | Live one-shot fired exactly once; PASS. No source change. |
| M17.4 | Closure | Stopped the live-authz identity API; returned to dormant baseline. No source change. |

## 6. M17.2 Execution Preparation Summary

- Defined the four-condition harness arming gate and the exact frontend (Vite) + backend (identity API)
  flags required, including the owner-confirmation environment variable (presence/match only — value
  never recorded).
- Defined the browser **precheck** (arming + redactor load; no route/feed call) and the **execute-once**
  command that projects the feed result through the M17.1 redaction before printing.
- Defined read-only PRE/POST DB baseline capture (counts only) and the full PASS / FAIL criteria.
- Conclusion: ready for a separately-approved single execution (M17.3); no live run performed in M17.2.

## 7. M17.3 Live Authorization PASS Evidence

Browser one-shot, executed **exactly once**:

| Field | Value |
|---|---|
| one-shot executions | exactly 1 |
| harness phase | `completed` |
| harness ok | `true` |
| armed | `true` |
| alreadyRan | `false` |
| confirmationPresent | `true` |
| confirmationMatches | `true` |
| route / feed transport status | `200` |
| redacted.summaryPhase | `summarized` |
| redacted.phase | `compared` |
| redacted.comparisonPhase | `compared` |
| redacted.serverAuthzPresent | `true` |
| safeReasonCode | `server_authz_summarized` |

## 8. M17.4 Return-to-Dormant Closure Evidence

- The `:5002` isolated identity API process (started with the live-authz flag for M17.3) was **stopped**.
- **No active process remains** with `ENABLE_LIVE_SESSION_AUTHORIZATION=true`.
- The live-authorization window is **closed**.
- Final counts unchanged after closure: `audit_event` remains `6`; `platform_identity` remains `3`.
- **No rerun** occurred; **no additional** route/feed/harness/token call occurred; **no additional DB
  write** occurred.

## 9. Redacted Browser Summary Evidence

Per-key-space counts (counts only — **no key names, no arrays, no mismatch lists**):

| Key-space | frontendCount | serverCount | matchedCount | missingCount | unknownCount |
|---|---|---|---|---|---|
| permission | 32 | 11 | 11 | 21 | 0 |
| subPermission | 153 | 78 | 78 | 75 | 0 |
| entitlement | 31 | 0 | 0 | 31 | 0 |

Parity booleans:

| Parity | Value |
|---|---|
| overallParity | `false` |
| permissionParity | `false` |
| subPermissionParity | `false` |
| entitlementParity | `false` |

## 10. Identity API Breadcrumb Evidence

Safe, non-secret breadcrumb summary from the isolated identity API (no request ID, no actor UUID, no raw
identity value recorded here):

- request **received**
- exit **authenticated**
- status: `200`
- reasonCode: `verified_supabase`
- authorizationPresent: `true`

## 11. Durable Audit Evidence

- The route returned a non-null authorization **only because** the server-side authorization service
  durably wrote exactly one append-only `audit_event` row first (the fail-closed "an allow must be
  durably audited before it is returned" invariant).
- The advisory audit envelope emitted on the route is a dev sidecar log (advisory — **not** durable
  compliance evidence) and is distinct from the durable `audit_event` row.
- No audit row content is reproduced here (no metadata, no actor, no request ID, no row dump).

## 12. DB Delta Evidence

| Table | PRE | POST | Delta | Expectation | Result |
|---|---|---|---|---|---|
| `audit_event` | 5 | 6 | +1 | exactly +1 | met |
| `platform_identity` | 3 | 3 | 0 | unchanged | met |

Counts only — no rows, no identity values, no metadata.

## 13. What M17 Proved

- The pipeline runs end-to-end for a real authenticated user: verified token → durable internal user
  identity → server-derived platform-first default authorization context → resolver `allow` → durable
  audit → non-null authorization returned by the route.
- The fail-closed allow-must-be-audited invariant fired correctly (`audit_event +1`).
- The live identity path did not create identity sprawl (`platform_identity` unchanged).
- A non-null authorization can be surfaced to the browser **safely redacted** — counts + booleans only,
  with no key names, no arrays, and no raw DTO leaking (the M17.1 projection is sufficient).

## 14. What M17 Did Not Prove

- It did **not** prove the grants are correct — only that a structurally-valid grant set was produced
  for one default context.
- It did **not** prove alignment between the server's platform-first default context and the client's
  active tenant/store/role/plan context.
- It did **not** prove entitlement resolution (server entitlement count was `0`).
- It did **not** prove deny, forced-deny, multi-user, or multi-context behavior at runtime.
- It did **not** prove stability/idempotency beyond a single one-shot.
- It did **not** prove any RLS / client-path authorization posture.
- It did **not** prove any production posture (the run was DEV-only, non-production, behind multiple
  default-OFF gates).

## 15. Interpretation of Counts and Parity

- **`unknownCount = 0` across all three key-spaces** is a positive vocabulary-alignment signal: every
  server-emitted key is recognized by the frontend vocabulary — no server→frontend vocabulary drift.
- **`missingCount > 0`** means the frontend vocabulary is broader than this user's granted set, which is
  expected and correct: authorization is intentionally a subset per user / role / context.
- **entitlement `serverCount = 0`** indicates the platform-first default context produced no entitlements
  for this actor; this is a readiness gap to investigate before entitlements are surfaced anywhere.
- **`parity = false` is expected and is not a failure.** Parity here is structural key-space coverage and
  is explicitly comparable-only — never authoritative or enforceable. Exact parity is neither expected
  nor desirable, since a scoped actor should not hold the entire vocabulary.

## 16. Current Authority Boundary

- **Firebase and the legacy AccessContext remain the sole authoritative session/authorization engine.**
- **Server-derived authorization remains observational / comparable only.**
- **The M11→M15 + M17.1 path remains dormant** and tree-shaken from production.
- **The redacted summary is not wired anywhere.**
- **Production remains blocked** (live authorization is hard-excluded in production and gated behind
  multiple default-OFF flags).

## 17. Open Questions / Follow-Ups

1. Entitlement `serverCount = 0` requires follow-up (why no entitlements for the default context).
2. The server default context may not match the client's active tenant/store/role/plan context.
3. `parity = false` is expected for a scoped actor and is **not** a failure.
4. `unknownCount = 0` is a positive vocabulary-alignment signal.
5. Server-derived authorization is structurally comparable only, **not** authoritative.
6. Deny, forced-deny, multi-user, multi-context, and production behavior remain unproven.
7. RLS / client-path authorization remains unproven.
8. Advisory adoption requires separate planning.
9. Authoritative adoption is explicitly out of scope.

## 18. Forbidden Conclusions

This document does **not** claim, and the evidence does **not** support, any of the following:

- that server authorization is now authoritative;
- that the frontend should consume server authorization now;
- that the grants are correct;
- that `parity = false` is a failure;
- that entitlement behavior is ready;
- that tenant/store/role/plan alignment is proven;
- that RLS is production-ready;
- that production enablement is ready;
- that AccessContext should change;
- that Firebase session authority is replaced;
- that M14 / M15 / M17.1 should be wired into runtime.

## 19. Recommended Next Milestone

`Phase 1.6 M18.2 — Server Authorization Advisory Adoption Planning` (planning-only): building on this
evidence record, design future advisory-only visibility and the work needed to resolve the open
questions (entitlement resolution, server-vs-client context alignment, deny/multi-context coverage)
before any adoption. A dev-only redacted diagnostic helper is deferred until those semantics are
resolved. Authoritative adoption and production enablement remain out of scope.

## 20. Security / Redaction Boundary Confirmation

This document records only counts, booleans, safe phase labels, and high-level conclusions. It contains
no raw authorization DTO, raw harness/feed output, raw comparison object, permission / sub-permission /
entitlement key names, key arrays, mismatch lists, permission levels, role names or IDs, tenant IDs,
store IDs, plan IDs, user IDs, provider UID, email, token, Authorization header, request headers, request
or response body, DB URL, service-role key, anon-key value, the owner confirmation phrase value, request
IDs, actor UUIDs, audit metadata, or any audit row dump.

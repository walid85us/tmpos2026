# Phase 1.5 M11.5 — Session Resolve Runtime Authorization Wiring

**Status:** IMPLEMENTED / REVIEW-GATED / DEV-FLAGGED

## 1. Scope

`/auth/session/resolve` can now return **live server-derived authorization**, but
ONLY behind a new DEV-only feature flag. The work:

- widens the session contract's `authorization` from `null` to
  `ServerDerivedAuthorizationV1 | null` (null still valid),
- adds the `ENABLE_LIVE_SESSION_AUTHORIZATION` flag (default off, production-hard-blocked),
- wires the route to derive authorization via the proven **M11.4 service**
  (`resolveDefaultSessionAuthorization`, platform-first), returning live authz only
  for an `allow` the service durably **audited** (fail-closed),
- adds a DB-free static diagnostic and a DEV-only live route diagnostic,
- rewords two existing diagnostics whose "always null" invariant is now conditional.

No frontend, AccessContext, protected business API, Backend Control Plane, or
Database Operations Console change. Disabled-flag behavior is byte-for-byte the
prior `authorization: null`.

## 2. Flags

```
ENABLE_SUPABASE_PLATFORM_IDENTITY=true          # existing — route gate 1
ENABLE_SESSION_RESOLVE=true                     # existing — route gate 2 (non-prod)
ENABLE_LIVE_SESSION_AUTHORIZATION=true          # NEW — live-authz gate (non-prod)
ALLOW_LIVE_SESSION_RESOLVE_AUTHZ_ROUTE_CHECK=true  # live route diagnostic gate
CONFIRM_SUPABASE_TARGET=tmpos2026-dev
NODE_ENV=development
```

All default off; production is hard-blocked at every gate; partial config fails closed.

## 3. Contract behavior

`SessionResolveAuthorization = ServerDerivedAuthorizationV1 | null`. The wire
`authorization` is non-null **only** when: platform identity enabled, session
resolve enabled, live session authorization enabled, process non-production, the
server resolver returns `allow`, AND the durable audit write succeeds. In every
other case it is `null`. The field never carries a token/JWT/auth-header/cookie/raw-DB
field/secret — its shape is exactly the inert M9 resolver DTO.

## 4. Authorization context strategy

Server-derived **default, platform-first** (via the M11.4
`resolveDefaultSessionAuthorization`): active platform membership → platform authz,
else tenant, else store, else null. **Client-requested context is deferred**; the
route never reads the request body / `user_metadata` / any client-asserted
role/tenant/store/permission. The verified token is identity proof only.

## 5. Audit strategy

One durable `audit_event` per **enabled** live authorization evaluation (written by
the M11.4 service via the M11.3 writer). **Zero** writes when the flag is disabled.
Diagnostics assert the **delta** (+1 per enabled successful resolution), never an
absolute baseline (DEV `audit_event` is already ≥ 4). No audit rows are deleted or reset.

## 6. Fail-closed behavior

- An `allow` is returned as live authorization only when the service reports
  `audited: true`. An unaudited allow ⇒ `authorization: null`.
- Repository failure / resolver deny / audit failure / any thrown error ⇒
  `authorization: null`.
- Identity resolution and authorization are independent: an authz failure NEVER
  downgrades a successfully authenticated identity's `authState`.

## 7. Files added

- `scripts/diagnostics-session-resolve-live-authorization-static-check.ts`
- `scripts/diagnostics-session-resolve-live-authorization-route-check.ts`
- `docs/phase-1.5-milestone-11.5-session-resolve-runtime-authorization-wiring.md`

## 8. Files modified

- `server/platform-identity/sessionResolveContract.ts` (widen `SessionResolveAuthorization`)
- `server/platform-identity/config.ts` (add `ENABLE_LIVE_SESSION_AUTHORIZATION` + `isLiveSessionAuthorizationEnabled()`)
- `server/platform-identity/sessionResolve.ts` (flag-gated live-authz branch; imports ONLY the M11.4 service)
- `scripts/diagnostics-authorization-repository-static-check.ts` (C19 reworded → flag-disabled null)
- `scripts/diagnostics-audit-event-writer-static-check.ts` (C21 reworded → flag-disabled null)

## 9. Diagnostic evidence (expected)

- New static diagnostic → PASS (contract/flag/isolation greps + DB-free handler mock
  proofs: disabled→null, enabled allow+audited→live authz, deny→null, allow-not-audited→null).
- All existing static diagnostics → PASS (incl. the reworded C19/C21).
- M11.2 live → PASS, `audit_event` stable.
- M11.5 live route → PASS: disabled→null (delta 0), enabled→system_owner (delta +1),
  fail-closed→null, other durable rows unchanged.
- `npx tsc --noEmit` → pre-existing baseline only; 0 in M11.5 files.
- `npm run build` → success; route/diagnostic/doc not bundled into the client.

## 10. Explicit non-actions

- No frontend / AccessContext / Login / AccessGuard / routing change.
- No protected business APIs; no Backend Control Plane; no Database Operations Console.
- No migration / seed / rollback; no Supabase schema/RLS change; no Supabase MCP.
- No production enablement. No commit / push / backup in the implementation pass.
- The route imports ONLY the M11.4 service — never the repository, writer, or resolver directly.

## 11. Deferred items

- Client-requested, durable-validated context.
- Permission / sub-permission materialization (M9 shared-catalog target).
- Frontend / AccessContext adoption of live authorization.
- Backend Control Plane; Database Operations Console / direct database-control UI.
- Production rollout.

## 12. Remaining Phase 1.5 estimate

Optional **M11.6** closeout: documentation consolidation + the permission/sub-permission
materialization go/defer decision. With M11.5 accepted, live DEV authorization is
end-to-end through `/auth/session/resolve`, which effectively reaches the Phase 1.5
finish line (frontend adoption + control plane are Phase 1.6+).

## 13. Rollback plan

Revert the 5 modified files to HEAD and delete the 3 new files. No migration/schema/
dependency change → nothing else to undo. The flag/contract are inert when the flag is
off, so even a partial rollback leaves the route at `authorization: null`.

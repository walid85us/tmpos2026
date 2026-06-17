# Phase 1.5 M11.4 — Session Authorization Service

**Status:** IMPLEMENTED / REVIEW-GATED / NOT WIRED

## 1. Scope

A **server-only** session authorization service that composes the already-proven
durable authorization stack into one path:

- reads durable identity/membership/tenant/store/entitlement rows through the
  **M11.2** read-only repository,
- derives the decision with the **pure M11** resolver,
- writes a durable audit event through the **M11.3** append-only writer,
- returns the resolved authorization **only when an allow is durably audited**
  (fail-closed),

plus a DB-free **static diagnostic**, a DEV-only **live diagnostic**, and this doc.

It adds **no HTTP route**, changes **no runtime path**, and touches **no frontend**.
`/auth/session/resolve` is untouched and still returns `authorization: null`.

## 2. Why Option B (service composition, not route wiring)

`/auth/session/resolve` currently pins authorization to `null` at the **type level**
(`SessionResolveAuthorization = null` in `sessionResolveContract.ts`), and that
invariant is asserted by several currently-passing M6/M7/M9 diagnostics. Returning a
live authorization from the route is therefore a **contract change** with diagnostic
and documentation ripple — deferred to **M11.5**. M11.4 proves the composition path
works end-to-end (read → resolve → durably audit → fail-closed) **first**, in
isolation, so the M11.5 diff is narrowly about the contract/route surgery.

## 3. Files added

1. `server/platform-identity/sessionAuthorizationService.ts` — the service.
2. `scripts/diagnostics-session-authorization-service-static-check.ts` — DB-free static check.
3. `scripts/diagnostics-session-authorization-service-live-check.ts` — DEV-only live check.
4. `docs/phase-1.5-milestone-11.4-session-authorization-service-strategy.md` — this doc.

No existing file is modified. `package.json` is unchanged (no new dependency).

## 4. Public surface

- `resolveSessionAuthorizationForContext(identityKey, requestedContext, options?)`
  — resolve + durably audit one explicit platform/tenant/store context.
- `deriveDefaultRequestedContextFromMemberships(memberships)` — pure, platform-first
  server-derived default-context selection (prefer active platform, else tenant, else store).
- `resolveDefaultSessionAuthorization(identityKey, options?)` — read memberships, pick the
  default context, then delegate.

`options` exposes injectable seams (`buildResolverInput`, `writeAuditEvent`, `executor`,
`requestId`, `traceId`) so diagnostics can prove behavior **without** a live DB. The
identity key is the durable `(authProvider, authProviderUid)` reference only — no token,
no `user_metadata`, no client-asserted role/tenant/store/permission is ever trusted.

## 5. Live diagnostic flags

```
NODE_ENV=development
ALLOW_LIVE_SESSION_AUTHZ_SERVICE_CHECK=true
CONFIRM_SUPABASE_TARGET=tmpos2026-dev
AUTHZ_CHECK_AUTH_PROVIDER=supabase
AUTHZ_CHECK_AUTH_PROVIDER_UID=<DEV_UID_REDACTED>
```

All gates must hold before any DB connection is created; production is hard-blocked.
The DEV UID is read from env and is **never printed or committed**.

## 6. Authorization context strategy

- The **live diagnostic** drives **explicit** platform/tenant/store contexts derived
  server-side from durable membership rows (mirroring the M11.2 live diagnostic).
- A **server-derived default** context (platform-first) is available via
  `deriveDefaultRequestedContextFromMemberships` / `resolveDefaultSessionAuthorization`.
- **Client-requested context** (a caller asking for a specific tenant/store) is
  **deferred** — it belongs with the M11.5 route-wiring slice, where the request-body
  trust boundary is revisited.

## 7. Audit strategy

- **One durable audit event per service invocation**, built with the M11.3
  `buildAuthorizationDecisionAuditEvent` (stamps `server_authorization_resolver`,
  `durable_compliance_event`, redacted allow-listed scalar metadata).
- Action id: `auth.authorization.decision_evaluated`; metadata is limited to
  allow-listed keys (`route='session-authorization-service'`, `phase='phase-1.5-m11.4'`).
- `audit_event` increments by the **expected delta only** (+3 for the live
  platform+tenant+store evaluations); diagnostics assert the **delta**, never an
  absolute baseline. No audit rows are deleted.

## 8. Fail-closed behavior

- The resolver runs first (pure). A **deny** may attempt a best-effort audit; an audit
  failure leaves it **deny** (deny is already safe).
- An **allow** must be durably audited **before** it is returned. If the audit write
  fails, the allow is **downgraded** to a forced deny with `authorization: null` and
  reason `denied_audit_write_failed`. **An unaudited allow is never returned.**
- The live diagnostic proves this by injecting a throwing writer on a real allow path
  (no malformed row is written) and asserting the downgrade.

## 9. Explicit non-actions

- No `/auth/session/resolve` modification; no `sessionResolveContract.ts` modification.
- No frontend / AccessContext / Login / AccessGuard / routing change.
- No protected business APIs; no Backend Control Plane.
- No migration / seed / rollback; no Supabase schema/RLS change; no Supabase MCP.
- No production enablement. No commit / push / backup in the implementation pass.

## 10. QA evidence (expected)

- New static diagnostic → PASS (composition, isolation, no-SQL, fail-closed mock,
  deny-stays-deny, platform-first default, no-secret result shape).
- All existing M9/M10/M11/M11.2/M11.3 static diagnostics → PASS (no regression).
- M11.2 live diagnostic → PASS, `audit_event` count **stable** before/after.
- M11.4 live diagnostic → PASS, `audit_event` delta **+3**, all other durable rows
  unchanged, fail-closed downgrade proven, no secret printed.
- `npx tsc --noEmit` → pre-existing baseline errors only; **0** in M11.4 files.
- `npm run build` → success; service/diagnostic/doc **not** bundled into the client.

## 11. Rollback plan

File-only: delete the four new files. No migration, schema, runtime wiring, or
dependency change was made — nothing else to undo (mirrors the M11/M11.2/M11.3 pattern).

## 12. Deferred items

- **M11.5** `/auth/session/resolve` route wiring + `SessionResolveAuthorization`
  contract update + the M6/M7/M9 diagnostic/doc updates it requires.
- Client-requested context with durable validation.
- Permission / sub-permission materialization (M9 shared-catalog target).
- Frontend / AccessContext adoption; protected business APIs; Backend Control Plane;
  production rollout.

## 13. Remaining Phase 1.5 estimate

- **M11.5** (route wiring behind a DEV-only flag + contract revision) likely next.
- Optional **M11.6** final closeout / permission-materialization decision.

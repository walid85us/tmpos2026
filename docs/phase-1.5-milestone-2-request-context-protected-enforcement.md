# Phase 1.5 — Milestone 2: Server-Side Request Context + Protected Diagnostic Enforcement

> **Status:** **IMPLEMENTED — PENDING REVIEW / MANUAL QA.** First runtime realization of a *subset* of the accepted Phase 1.4 M3 contract. **Default behavior is unchanged:** the new path is **diagnostic-only** and **dev-only**, gated behind TWO default-OFF flags, and is **not** started by `npm run dev`. **Firebase Auth is untouched and no real token is verified.** No tenant/business data. No durable audit. No schema/RLS change. **Not committed / not pushed / not backed up; awaiting review.**
>
> **Built per** the accepted M2 planning report and on top of [`phase-1.5-milestone-1-thin-api-platform-identity.md`](phase-1.5-milestone-1-thin-api-platform-identity.md). **Contract source:** [`phase-1.4-milestone-3-request-context-protected-action-contract.md`](phase-1.4-milestone-3-request-context-protected-action-contract.md) (§3 request context, §9 decision shape, §12 truthfulness labels).

---

## 1. Purpose

Make the smallest real **server-side enforcement spine** and prove it end-to-end against a single harmless endpoint:

> resolve who is acting + in what scope → check the required permission with the existing engine's semantics → emit an explicit allow/deny decision → record a truthfully-labelled audit envelope → return a safe response.

This validates the accepted Phase 1.4 M3 contract in the smallest, fully-reversible way, and establishes the seams (auth verification, durable roles, durable audit) where later milestones plug in — **without changing any current app behavior** and **without persisting any tenant business data**.

## 2. What changed (files)

| File | Type | Purpose |
|---|---|---|
| `server/platform-identity/requestContext.ts` | new | Builds the M2 `RequestContext` subset; resolves `internal_user_id` **read-only** via the M1 repo; deny-by-default |
| `server/platform-identity/authAdapter.ts` | new | `AuthAdapter` boundary + `DevDiagnosticAuthAdapter` (dev assertion) + `StubFirebaseAuthAdapter` (throws `firebase_verification_not_implemented`) |
| `server/platform-identity/permissionDecision.ts` | new | `requirePlatformPermission` / `requireTenantPermission` / `requireSubPermission`; **mirrors** (does not import) the frozen frontend semantics |
| `server/platform-identity/protectedAction.ts` | new | `withProtectedAction` wrapper + the `isDevDiagnosticsEnabled()` guard |
| `server/platform-identity/auditEnvelope.ts` | new | Advisory audit decision envelope builder + **log-only** sink |
| `server/platform-identity/server.ts` | edit | Registers exactly one route: `POST /diagnostics/echo-decision` |
| `scripts/diagnostics-protected-action-check.ts` | new | Dev-only smoke harness (no secrets); ephemeral in-process app exercising every path |
| `docs/phase-1.5-milestone-2-request-context-protected-enforcement.md` | new | This doc |
| `replit.md` | edit | One status line |

**Not touched:** all of `src/` (incl. `firebase.ts`, `AccessContext.tsx`, `accessConfig.ts`, `platformPermissionsConfig.ts`, `AccessGuard.tsx`), `server/index.ts` (shipping sidecar) and adapters, `server/platform-identity/migrations/**`, `platform_identity` schema, `firestore.rules`, `package.json`, `package-lock.json`. **No new npm dependency** (uses `crypto.randomUUID`).

## 3. Feature flags / dev gates

The diagnostic route does anything **only** when ALL THREE hold (deny-by-default otherwise → `404 FEATURE_DISABLED`):

1. `ENABLE_SUPABASE_PLATFORM_IDENTITY === 'true'` (reused M1 flag; default OFF), **and**
2. `PLATFORM_IDENTITY_DEV_DIAGNOSTICS === 'true'` (new, independent opt-in; default OFF), **and**
3. `process.env.NODE_ENV !== 'production'`.

The guard never relies on `NODE_ENV` alone. With any condition false the route returns `404`. Nothing in `src/` imports this boundary, so the main app and login are unaffected in every state.

## 4. Request context (M2 subset)

A server-side object built **after** the (dev) adapter and **before** any permission check. Honest by construction:
- `authState` ∈ {`dev-asserted`, `unauthenticated`} — **never `authenticated`** (no real token verified).
- `actor.internalUserId` resolved **read-only** via the M1 `platform_identity` mapping (`findByProviderUid`). The diagnostic **never creates/mutates** identity rows; if Supabase config is absent or the row doesn't exist, it stays `null` (status surfaced as `identityResolution`).
- `permissionSnapshot.source = 'dev_asserted_snapshot'` — supplied by the caller; **not** durable or server-authoritative.
- Reads no frontend state, no durable roles, no tenant/business data.

## 5. Auth adapter boundary

- **`DevDiagnosticAuthAdapter`** — reads an explicit `devActor` assertion from the request body. **Not authentication**; exists only to exercise the spine in dev. A real verifier would *derive* actor/scope/permissions from a verified token, never accept them from the caller.
- **`StubFirebaseAuthAdapter`** — marks the future Firebase verification seam; `verify()` always throws `FirebaseVerificationNotImplementedError` (`code: firebase_verification_not_implemented`). **No Firebase Admin SDK added.** Selectable in dev via `"verifier": "stub-firebase"` to prove it never silently allows.

## 6. Permission decision contract

`requirePlatformPermission` / `requireTenantPermission` / `requireSubPermission` return an explicit `{ decision, reasonCode, humanReadableReason }`. They **mirror** the frozen frontend semantics **without importing or editing** the client config:
- tenant 7-level hierarchy + `meetsPermissionLevel` ← `src/context/accessConfig.ts` (ordering: …`manage` < `approve`…);
- platform threshold semantics ← `src/owner/platformPermissionsConfig.ts` (ordering: …`approve` < `manage`…);
- sub-permission precedence ← `AccessContext.checkSubPermission` (plan-availability → owner short-circuit → parent min-level → explicit grant → default).

> ⚠ **Drift risk (noted in code):** the level orderings are duplicated server-side so the server can evaluate without the client bundle. They **must stay in sync** with the frontend; a future milestone should unify them into a shared package imported by both `src/` and `server/`. M2 evaluates only against the dev-asserted snapshot (does **not** read durable roles).

The endpoint uses the **platform** check; the tenant/sub functions are implemented and exported as the contract for future tenant endpoints (not wired to an endpoint in M2).

## 7. Protected-action wrapper

`withProtectedAction(actionId, required, handler)` pipeline (deny-by-default at every step):
1. feature-flag gate → `404` if OFF; 2. dev-diagnostics gate → `404` if OFF/prod; 3. generate `requestId`; 4. select adapter (dev, or stub-firebase on request); 5. build context; 6. evaluate permission; 7. **emit advisory audit envelope on every decision path (allow AND deny)**; 8. on `allow` run the handler, else return a safe generic refusal.

HTTP mapping: `allow` → 200; unauthenticated deny → 401; authorized-but-unauthorized deny (incl. scope mismatch) → 403; `deferred` (stub verifier) → 501; gate disabled → 404. Responses carry only safe fields (no secrets, no raw DB errors).

## 8. Audit decision envelope (advisory only)

Built per Phase 1.4 M3 §9/§12 with **honest labels**: `sourceOfTruth: 'dev_asserted_snapshot'`, `evidenceLevel: 'dev_sidecar_log_advisory'`, `evaluatedBy: 'platform_rbac_guard@v0-dev'`, `previewHandling: 'n_a'`. The **only sink is the safe server log** (passed through `safeLog`/redaction). **No durable audit table; no compliance-evidence claim.** `actorId` is the app-owned `internal_user_id` (UUID), never a raw provider uid/email.

## 9. Diagnostic endpoint

`POST /diagnostics/echo-decision`, wrapped as action `platform.diagnostic.echo` requiring platform `team_management:view`. The handler performs **no business effect** — it echoes a safe summary (`internalUserId`, `actorType`, `scopeType`, `identityResolution`). Example dev request:

```json
{
  "devActor": {
    "authProvider": "firebase",
    "authProviderUid": "dev-firebase-uid",
    "email": "dev@example.test",
    "actorType": "platform_user",
    "scope": { "scopeType": "platform", "tenantId": null, "storeId": null },
    "permissionSnapshot": {
      "source": "dev_asserted_snapshot",
      "platformRoleId": "support_admin",
      "tenantRoleId": null,
      "permissions": { "team_management": "view" },
      "subPermissions": {}
    }
  }
}
```
Allow → `{ requestId, actionId, decision:"allow", evaluatedBy, ... }`; deny → `{ requestId, actionId, decision:"deny", reasonCode }`.

## 10. How to run (dev only)

```bash
# Flag OFF (default) — route returns 404:
npm run identity:api

# Flag ON but diagnostics OFF — route returns 404:
ENABLE_SUPABASE_PLATFORM_IDENTITY=true npm run identity:api

# Both ON (dev) — route active on port 5002:
ENABLE_SUPABASE_PLATFORM_IDENTITY=true PLATFORM_IDENTITY_DEV_DIAGNOSTICS=true npm run identity:api

# Self-contained smoke harness (no secrets needed; spins up an ephemeral app):
npx tsx scripts/diagnostics-protected-action-check.ts
```

## 11. Manual QA (required before acceptance)

- Default app (`npm run dev`) unchanged: Firebase/Google/email-password login, preview/demo, tenant/store mock, all modules, shipping + shipping sidecar.
- Flag OFF and (flag ON + diagnostics OFF): `POST /diagnostics/echo-decision` → `404 FEATURE_DISABLED`; `/health` shows presence booleans only.
- Both ON (dev): allow / deny(missing permission) / unauthenticated(no assertion) / scope-isolation(tenant ⊥ platform) / System Owner allow / stub-firebase `501 firebase_verification_not_implemented`.
- **Identity resolution (DB):** with Supabase secrets present, first create the dev identity via M1 `POST /identity/resolve`, then confirm the diagnostic returns the **same** `internalUserId` as M1 `GET /identity/by-uid`.
- Audit envelopes appear in the server log for allow and deny with `sourceOfTruth=dev_asserted_snapshot` and `evidenceLevel=dev_sidecar_log_advisory`; no secrets in logs/responses.
- `NODE_ENV=production` with both flags true → route still `404`.

## 12. Rollback

Unset either flag (instant runtime revert) → route `404`. Revert the M2 commit if needed — all new files are additive and isolated; M1 files (other than the single route line in `server.ts`) and `src/` are untouched. No durable rows are written; nothing to clean up.

## 13. Deferred (still blocked)

Real Firebase ID-token verification (Admin SDK / JWKS); Supabase Auth migration / Firebase replacement; durable server-authoritative roles/permission snapshot; durable append-only audit table; durable tenant/store scope + identity unification; any real protected business action (POS/invoices/inventory/repairs/shipping); RLS client policies / Firestore rules; payments/storage; idempotency framework; broad route protection/middleware; unifying the permission comparison helpers into a shared package.

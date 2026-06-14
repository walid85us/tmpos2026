// Phase 1.5 M5 — Inert provider-agnostic session model (Option B).
//
// PURPOSE: describe the SHAPE of a future, provider-neutral application session
// derived from SERVER-VERIFIED identity. This file is INERT:
//   - It contains TypeScript types ONLY — no runtime values, no side effects.
//   - It is imported by NOTHING at runtime (only by the M5 mapper, the M5
//     diagnostic, and — for reference — the M5 doc). It does NOT touch
//     AccessContext, AccessGuard, Login, routing, the M4 pilot, or any business
//     or server module.
//
// BOUNDARY (binding):
//   - IDENTITY is proven SERVER-SIDE only (a verified token mapped to an
//     app-owned internal_user_id). A frontend provider session NEVER grants app
//     authorization on its own.
//   - AUTHORIZATION (userType / role / scope / plan / permissions) is
//     SERVER-DERIVED. In this inert slice it is ALWAYS represented as `null`:
//     no authorization is produced yet (that is a later, separately-approved
//     milestone). Client-asserted role/tenant/store/permission fields are NEVER
//     trusted, even if present on an input.
//
// SECURITY: this module imports NO Firebase, NO Supabase, reads NO env, handles
// NO tokens, and references NO service-role key, DB URL, or JWT secret.

/** Identity providers the bridge can describe. Firebase stays active/default. */
export type AuthProvider = 'firebase' | 'supabase';

/**
 * Honest auth states, mirroring the backend vocabulary
 * (server/platform-identity/requestContext.ts):
 *   - 'authenticated'   → verified token AND a resolved app-owned internal_user_id.
 *   - 'token-verified'  → token proven, but NO resolved internal_user_id (fail-closed).
 *   - 'unauthenticated' → no proven identity.
 * NOTE: the frontend session model intentionally does NOT include the backend's
 * dev-only 'dev-asserted' state — that is a server diagnostic concept.
 */
export type AppAuthState = 'authenticated' | 'token-verified' | 'unauthenticated';

/** Future authorization scope shape. Server-derived; never client-asserted. */
export interface AppScope {
  scopeType: 'platform' | 'tenant' | 'store' | 'none';
  tenantId: string | null;
  storeId: string | null;
}

/**
 * App-owned, server-verified identity. The `internalUserId` is the BRIDGE KEY
 * (produced by M1/M3). `authProviderUid`/`email`/`displayName` are reference
 * fields derived from verified claims — never trusted for authorization.
 */
export interface AppIdentity {
  /** App-owned bridge key. Present ONLY when identity is server-resolved. */
  internalUserId: string;
  authProvider: AuthProvider;
  /** External provider subject (reference only). */
  authProviderUid: string | null;
  email: string | null;
  displayName: string | null;
}

/**
 * Future, SERVER-DERIVED authorization. Its shape is declared here for forward
 * compatibility, but the M5 mapper ALWAYS emits `null` for it — no authorization
 * is derived in this inert slice.
 */
export interface AppAuthorization {
  userType: 'platform' | 'tenant';
  role: string;
  scope: AppScope;
}

/**
 * Provider-agnostic application session. Derived from a server whoami result by
 * the pure M5 mapper. `authorization` is `null` whenever it has not been
 * server-derived — which, in this inert slice, is ALWAYS.
 */
export interface AppSession {
  /** Server-verified identity, or null when no identity was established. */
  identity: AppIdentity | null;
  /** Server-derived authorization, or null when not (yet) derived. */
  authorization: AppAuthorization | null;
  authState: AppAuthState;
  /** Provenance label (e.g. 'supabase_verified_token'); null when unknown. */
  sourceOfTruth: string | null;
  /** Safe diagnostic aids — never secrets/tokens. */
  requestId: string | null;
  reasonCode: string | null;
}

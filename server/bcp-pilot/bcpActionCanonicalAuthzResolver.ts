// Phase 3.0 M3 Gate 1 — READ-ONLY canonical-authorization wiring for the controlled action.
//
// Reuses the EXISTING read-only assembly + PURE resolver ONLY:
//   buildResolverInputForContext({authProvider:'firebase', authProviderUid}, {scopeType:'platform'})  (SELECT-only)
//   → resolveAuthorization(input)                                                                     (pure, no I/O)
// It deliberately AVOIDS `sessionAuthorizationService` (whose `resolveSessionAuthorizationForContext` writes a
// durable audit row) — so NO durable audit event is written during principal resolution (§11.11/§11.12) and NO
// Supabase-auth activation occurs (the repository verifies no token and reads no secret). Platform scope is
// requested explicitly: a non-platform identity is validated against real memberships and denied by the resolver.
// The result is adapted to an authority-neutral view for the translator. Fail-closed to null on any error.
//
// Server-side only. Never imported by src/.

import type { CanonicalAuthzView } from './bcpActionLivePrincipalResolver';
import { buildResolverInputForContext } from '../platform-identity/authorizationRepository';
import { resolveAuthorization, type AuthorizationResolverResult } from '../platform-identity/authorizationResolver';

/** Pure adapter: canonical `AuthorizationResolverResult` → the authority-neutral view. Fail-closed defaults. */
export function adaptAuthorizationResultToView(result: AuthorizationResolverResult): CanonicalAuthzView {
  const a: any = result.authorization ?? null;
  const status: any = (a && a.status) || {};
  const statusValues = [status.user, status.tenant, status.store].filter((s: unknown): s is string => typeof s === 'string');
  return {
    decision: result.decision,
    reasonCode: result.reasonCode,
    limitation: result.limitation,
    platformRoleId: (a && a.roles && typeof a.roles.platformRoleId === 'string') ? a.roles.platformRoleId : null,
    permissions: (a && a.permissions && typeof a.permissions === 'object') ? a.permissions : {},
    statusValues,
    scopeType: (a && a.scope && typeof a.scope.scopeType === 'string') ? a.scope.scopeType : 'none',
  };
}

/** Injectable seams so the wiring is unit-testable without a real DB / firebase. */
export interface CanonicalAuthzDeps {
  buildInput?: (identityKey: { authProvider: string; authProviderUid: string }, ctx: { scopeType: 'platform' }) => Promise<any | null>;
  resolve?: (input: any) => AuthorizationResolverResult;
}

/**
 * Resolve the PLATFORM-scope canonical authorization for a verified Firebase UID. READ-ONLY, NO audit write.
 * Returns the adapted view, or null when there is no durable identity or any build/resolve error occurs
 * (the caller treats null as a sanitized fail-closed resolver error).
 */
export async function resolveCanonicalPlatformAuthz(firebaseUid: string, deps: CanonicalAuthzDeps = {}): Promise<CanonicalAuthzView | null> {
  const buildInput = deps.buildInput ?? (buildResolverInputForContext as any);
  const resolve = deps.resolve ?? resolveAuthorization;
  let input: any;
  try { input = await buildInput({ authProvider: 'firebase', authProviderUid: firebaseUid }, { scopeType: 'platform' }); }
  catch { return null; }
  if (!input) return null; // no durable identity matched the provider key
  try { return adaptAuthorizationResultToView(resolve(input)); }
  catch { return null; }
}

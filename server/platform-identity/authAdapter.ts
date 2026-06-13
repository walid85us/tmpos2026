// Phase 1.5 M2 — Auth adapter boundary (dev-only).
//
// Defines the SEAM where a future production auth verifier will live, WITHOUT
// verifying any real token in M2.
//   - DevDiagnosticAuthAdapter: reads an EXPLICIT dev-asserted actor from the
//     diagnostic request body. It is NOT authentication — it only exists to
//     exercise the enforcement spine in development. A real verifier would
//     DERIVE the actor / scope / permissions from a verified token, never accept
//     them from the caller.
//   - StubFirebaseAuthAdapter: marks the future Firebase ID-token verification
//     seam. It verifies NOTHING and throws `firebase_verification_not_implemented`
//     — never a silent allow. No Firebase Admin SDK is added in M2.
//
// Server-side only. Never imported by src/ (the client bundle).

import type { Request } from 'express';
import type {
  ActorAssertion,
  ActorType,
  PermissionSnapshot,
  RequestScope,
  ScopeType,
} from './requestContext';

export const FIREBASE_NOT_IMPLEMENTED = 'firebase_verification_not_implemented';

/** Thrown by the stub Firebase adapter. Carries a stable, safe `code`. */
export class FirebaseVerificationNotImplementedError extends Error {
  readonly code = FIREBASE_NOT_IMPLEMENTED;
  constructor() {
    super('Firebase ID-token verification is not implemented in M2 (adapter boundary only).');
    this.name = 'FirebaseVerificationNotImplementedError';
  }
}

export interface AuthAdapter {
  readonly name: string;
  /** Returns a validated ActorAssertion, or null when none was asserted. */
  verify(req: Request): Promise<ActorAssertion | null>;
}

const VALID_SCOPE_TYPES: ScopeType[] = ['platform', 'tenant', 'store', 'none'];
const VALID_ACTOR_TYPES: ActorType[] = ['platform_user', 'tenant_user', 'dev_actor'];

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function parseScope(raw: unknown): RequestScope {
  const r = (raw ?? {}) as Record<string, unknown>;
  const scopeType: ScopeType = (VALID_SCOPE_TYPES as string[]).includes(r.scopeType as string)
    ? (r.scopeType as ScopeType)
    : 'none';
  return {
    scopeType,
    tenantId: asString(r.tenantId),
    storeId: asString(r.storeId),
    platformScope: scopeType === 'platform',
  };
}

function parseSnapshot(raw: unknown): PermissionSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  const permissions: Record<string, string> = {};
  if (r.permissions && typeof r.permissions === 'object') {
    for (const [k, v] of Object.entries(r.permissions as Record<string, unknown>)) {
      if (typeof v === 'string') permissions[k] = v;
    }
  }
  const subPermissions: Record<string, boolean> = {};
  if (r.subPermissions && typeof r.subPermissions === 'object') {
    for (const [k, v] of Object.entries(r.subPermissions as Record<string, unknown>)) {
      if (typeof v === 'boolean') subPermissions[k] = v;
    }
  }
  return {
    source: 'dev_asserted_snapshot',
    platformRoleId: asString(r.platformRoleId),
    tenantRoleId: asString(r.tenantRoleId),
    permissions,
    subPermissions,
  };
}

/**
 * Dev-only adapter. Trusts an EXPLICIT actor assertion from the request body's
 * `devActor` field. Not authentication — exercises the spine in development.
 */
export class DevDiagnosticAuthAdapter implements AuthAdapter {
  readonly name = 'dev-diagnostic@v0';

  async verify(req: Request): Promise<ActorAssertion | null> {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const raw = body.devActor;
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;

    const authProviderUid = asString(r.authProviderUid);
    if (!authProviderUid) return null; // no resolvable actor ⇒ unauthenticated

    const actorType: ActorType = (VALID_ACTOR_TYPES as string[]).includes(r.actorType as string)
      ? (r.actorType as ActorType)
      : 'dev_actor';

    return {
      authProvider: 'firebase', // reference only; NOT verified
      authProviderUid,
      email: asString(r.email),
      actorType,
      scope: parseScope(r.scope),
      permissionSnapshot: parseSnapshot(r.permissionSnapshot),
    };
  }
}

/**
 * Future Firebase token-verification seam. Verifies NOTHING in M2; always throws
 * FirebaseVerificationNotImplementedError so it can never silently allow.
 */
export class StubFirebaseAuthAdapter implements AuthAdapter {
  readonly name = 'firebase@v0(stub)';

  async verify(_req: Request): Promise<ActorAssertion | null> {
    throw new FirebaseVerificationNotImplementedError();
  }
}

export const devDiagnosticAuthAdapter = new DevDiagnosticAuthAdapter();
export const stubFirebaseAuthAdapter = new StubFirebaseAuthAdapter();

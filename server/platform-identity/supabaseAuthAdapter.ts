// Phase 1.5 M3-Revised — Verified Supabase Auth adapter (dev-only diagnostic).
//
// This is the FIRST adapter that performs REAL server-side token verification.
// It verifies a Supabase Auth access token against the project's PUBLIC JWKS
// (asymmetric signing keys) via `jose`, then DERIVES a trusted actor from the
// verified claims. It NEVER trusts client-supplied identity fields.
//
// SECURITY (binding):
//   - Verification uses the SUPABASE_URL JWKS endpoint only. NO SUPABASE_JWT_SECRET,
//     NO service-role key, NO Firebase Admin SDK.
//   - The raw token is NEVER logged or returned.
//   - JWKS key material is NEVER logged or returned.
//   - No Supabase URL / DB URL / service-role / anon key / connection string is
//     ever logged or returned by this module.
//   - Failure NEVER yields a silent allow — every failure throws a typed,
//     stable-coded SupabaseTokenError (or returns null for a missing header,
//     which the handler maps to 'denied_unauthenticated').
//
// Server-side only. Never imported by src/ (the client bundle).

import type { Request } from 'express';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { AuthAdapter } from './authAdapter';
import type { ActorAssertion } from './requestContext';

/** Stable, safe reason codes surfaced to callers (never internal detail). */
export type SupabaseVerifyReason =
  | 'supabase_token_invalid'
  | 'supabase_token_expired'
  | 'supabase_token_wrong_issuer'
  | 'supabase_token_wrong_audience'
  | 'jwks_unavailable';

/** Thrown by the verified adapter. Carries a stable, non-leaking `code`. */
export class SupabaseTokenError extends Error {
  readonly code: SupabaseVerifyReason;
  constructor(code: SupabaseVerifyReason, message: string) {
    super(message);
    this.name = 'SupabaseTokenError';
    this.code = code;
  }
}

export interface SupabaseVerifierOptions {
  /** Defaults to process.env.SUPABASE_URL (read lazily at verify time). */
  supabaseUrl?: string;
  /** Override the JWKS URI (tests). Defaults to `${supabaseUrl}/auth/v1/.well-known/jwks.json`. */
  jwksUri?: string;
  /** Expected issuer. Defaults to `${supabaseUrl}/auth/v1`. */
  issuer?: string;
  /** Expected audience. Supabase access tokens use 'authenticated'. */
  audience?: string;
}

function normalizeBase(url: string): string {
  return url.replace(/\/+$/, '');
}

/** Extract a bearer token from the Authorization header, or null if absent/blank/non-bearer. */
export function extractBearerToken(req: Request): string | null {
  // Express normalizes header names to lower-case.
  const raw = req.headers['authorization'];
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (typeof header !== 'string') return null;
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const token = m[1].trim();
  return token ? token : null;
}

/** Map a thrown verification error to a stable, safe reason code. */
function classifyJoseError(err: unknown): SupabaseVerifyReason {
  const code = (err as { code?: string })?.code;
  if (code === 'ERR_JWT_EXPIRED') return 'supabase_token_expired';
  if (code === 'ERR_JWT_CLAIM_VALIDATION_FAILED') {
    const claim = (err as { claim?: string }).claim;
    if (claim === 'iss') return 'supabase_token_wrong_issuer';
    if (claim === 'aud') return 'supabase_token_wrong_audience';
    return 'supabase_token_invalid';
  }
  if (
    code === 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED' ||
    code === 'ERR_JWS_INVALID' ||
    code === 'ERR_JWT_INVALID' ||
    code === 'ERR_JWKS_NO_MATCHING_KEY'
  ) {
    return 'supabase_token_invalid';
  }
  // Timeout, network failure, or any other inability to retrieve usable keys.
  return 'jwks_unavailable';
}

function extractDisplayName(payload: Record<string, unknown>): string | null {
  const meta = payload['user_metadata'];
  if (meta && typeof meta === 'object') {
    const m = meta as Record<string, unknown>;
    for (const k of ['full_name', 'name', 'display_name']) {
      const v = m[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
  }
  return null;
}

/**
 * Verified Supabase Auth adapter. Implements the M2 AuthAdapter seam, but unlike
 * the dev adapter it DERIVES the actor from a cryptographically verified token
 * and marks the assertion `verified: true` (⇒ authState 'authenticated').
 */
export class VerifiedSupabaseAuthAdapter implements AuthAdapter {
  readonly name = 'supabase-verified@v0';
  private readonly opts: SupabaseVerifierOptions;
  private jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
  private jwksUriMemo: string | null = null;

  constructor(opts: SupabaseVerifierOptions = {}) {
    this.opts = opts;
  }

  private resolveConfig(): { jwksUri: string; issuer: string; audience: string } {
    const base = normalizeBase(this.opts.supabaseUrl ?? process.env.SUPABASE_URL ?? '');
    if (!base && !this.opts.jwksUri) {
      // No way to locate JWKS — treat as unavailable (never a silent allow).
      throw new SupabaseTokenError('jwks_unavailable', 'Supabase JWKS endpoint is not configured.');
    }
    return {
      jwksUri: this.opts.jwksUri ?? `${base}/auth/v1/.well-known/jwks.json`,
      issuer: this.opts.issuer ?? `${base}/auth/v1`,
      audience: this.opts.audience ?? 'authenticated',
    };
  }

  private getJwks(jwksUri: string): ReturnType<typeof createRemoteJWKSet> {
    if (this.jwks && this.jwksUriMemo === jwksUri) return this.jwks;
    this.jwks = createRemoteJWKSet(new URL(jwksUri));
    this.jwksUriMemo = jwksUri;
    return this.jwks;
  }

  async verify(req: Request): Promise<ActorAssertion | null> {
    const token = extractBearerToken(req);
    // No/blank/non-bearer header ⇒ no asserted actor (handler maps to unauthenticated).
    if (!token) return null;

    const { jwksUri, issuer, audience } = this.resolveConfig();
    const jwks = this.getJwks(jwksUri);

    let payload: Record<string, unknown>;
    try {
      const result = await jwtVerify(token, jwks, { issuer, audience });
      payload = result.payload as Record<string, unknown>;
    } catch (err) {
      // Map to a stable, safe code. Never log the token or key material.
      throw new SupabaseTokenError(classifyJoseError(err), 'Supabase token verification failed.');
    }

    const sub = typeof payload.sub === 'string' ? (payload.sub as string).trim() : '';
    if (!sub) {
      throw new SupabaseTokenError('supabase_token_invalid', 'Verified token has no subject.');
    }

    const email =
      typeof payload.email === 'string' && (payload.email as string).trim()
        ? (payload.email as string).trim()
        : null;

    return {
      authProvider: 'supabase',
      authProviderUid: sub,
      email,
      displayName: extractDisplayName(payload),
      actorType: 'platform_user',
      scope: { scopeType: 'none', tenantId: null, storeId: null, platformScope: false },
      permissionSnapshot: null,
      verified: true,
    };
  }
}

/** Default singleton: reads SUPABASE_URL lazily at verify time. */
export const verifiedSupabaseAuthAdapter = new VerifiedSupabaseAuthAdapter();

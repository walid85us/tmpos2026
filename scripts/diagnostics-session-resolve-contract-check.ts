// Phase 1.5 M6 — dev-only unit check for the inert /auth/session/resolve contract.
//
// Pure, offline, secret-free: uses only hand-built dummy objects. No network, no
// env, no real tokens, no Supabase/Firebase/DB calls. Proves the contract DTO is
// representable for every status/reason row, aligns with the existing M5
// AppSession mapper, keeps authorization null, fails closed (token-verified is
// never authenticated), ignores forged client authority, and carries no secret/
// token fields.
//
// Run:  npx tsx scripts/diagnostics-session-resolve-contract-check.ts

import {
  SESSION_RESOLVE_MATRIX,
  SESSION_RESOLVE_REASON_CODES,
  SESSION_RESOLVE_SOURCE_OF_TRUTH,
  type SessionResolveResponseDTO,
  type SessionResolveReasonCode,
  type SessionResolveForbiddenField,
} from '../server/platform-identity/sessionResolveContract';
import { mapWhoamiToAppSession } from '../src/auth/mapWhoamiToAppSession';

interface Result { name: string; pass: boolean; detail: string }
const results: Result[] = [];
function check(name: string, pass: boolean, detail = ''): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const R = SESSION_RESOLVE_REASON_CODES;

/**
 * Build a contract-consistent DTO for a reason code, using the matrix as the
 * single source of truth. `identity` is populated only for an authenticated
 * success; `authorization` is ALWAYS null.
 */
function buildDTO(
  reasonCode: SessionResolveReasonCode,
  opts: { internalUserId?: string | null } = {},
): SessionResolveResponseDTO {
  const row = SESSION_RESOLVE_MATRIX[reasonCode];
  const authenticated = row.authState === 'authenticated' && reasonCode === R.VERIFIED_SUPABASE;
  const internalUserId = opts.internalUserId === undefined
    ? (authenticated ? 'iuid-123' : undefined)
    : (opts.internalUserId ?? undefined);

  const dto: SessionResolveResponseDTO = {
    status: row.status,
    requestId: 'req-m6',
    authState: row.authState,
    decision: row.decision,
    reasonCode,
    authorization: null, // ALWAYS null in this era
    identity:
      authenticated && internalUserId
        ? {
            internalUserId,
            authProvider: 'supabase',
            authProviderUid: 'sub-abc',
            email: 'user@example.com',
            displayName: 'Test User',
          }
        : null,
  };

  if (authenticated && internalUserId) {
    dto.internalUserId = internalUserId;
    dto.authProvider = 'supabase';
    dto.authProviderUid = 'sub-abc';
    dto.email = 'user@example.com';
    dto.displayName = 'Test User';
    dto.sourceOfTruth = SESSION_RESOLVE_SOURCE_OF_TRUTH;
  } else if (row.status >= 400) {
    dto.error = { code: reasonCode, message: 'safe non-leaking message' };
  }
  return dto;
}

// 1) Success response is representable with the right shape.
{
  const dto = buildDTO(R.VERIFIED_SUPABASE);
  const row = SESSION_RESOLVE_MATRIX[R.VERIFIED_SUPABASE];
  check(
    '1 success representable: 200/allow/authenticated, identity populated, authz null',
    dto.status === 200 &&
      row.decision === 'allow' &&
      dto.authState === 'authenticated' &&
      dto.identity !== null &&
      dto.identity.internalUserId === 'iuid-123' &&
      dto.authProvider === 'supabase' &&
      dto.sourceOfTruth === 'supabase_verified_token' &&
      dto.authorization === null,
    `authState=${dto.authState} authz=${dto.authorization}`,
  );
}

// 2) Success maps cleanly through the existing M5 mapper.
{
  const dto = buildDTO(R.VERIFIED_SUPABASE);
  const s = mapWhoamiToAppSession(dto);
  check(
    '2 success maps via mapWhoamiToAppSession: authenticated, identity populated, authz null',
    s.authState === 'authenticated' &&
      s.identity !== null &&
      s.identity.internalUserId === 'iuid-123' &&
      s.identity.authProvider === 'supabase' &&
      s.authorization === null,
    `authState=${s.authState} hasIdentity=${s.identity !== null} authz=${s.authorization}`,
  );
}

// Helper for the deny/error families (401/500 → unauthenticated, authz null).
function checkDenyFamily(num: number, reasonCode: SessionResolveReasonCode, expectStatus: number): void {
  const dto = buildDTO(reasonCode);
  const row = SESSION_RESOLVE_MATRIX[reasonCode];
  const s = mapWhoamiToAppSession(dto);
  check(
    `${num} ${reasonCode} → ${expectStatus}, unauthenticated, no identity, authz null`,
    dto.status === expectStatus &&
      row.authState === 'unauthenticated' &&
      dto.identity === null &&
      dto.authorization === null &&
      s.authState === 'unauthenticated' &&
      s.identity === null &&
      s.authorization === null &&
      s.reasonCode === reasonCode,
    `status=${dto.status} authState=${s.authState} reason=${s.reasonCode}`,
  );
}

// 3) Missing/blank Bearer token.
checkDenyFamily(3, R.DENIED_UNAUTHENTICATED, 401);
// 4) Invalid token.
checkDenyFamily(4, R.SUPABASE_TOKEN_INVALID, 401);
// 5) Expired token.
checkDenyFamily(5, R.SUPABASE_TOKEN_EXPIRED, 401);
// 6) Wrong issuer.
checkDenyFamily(6, R.SUPABASE_TOKEN_WRONG_ISSUER, 401);
// 7) Wrong audience.
checkDenyFamily(7, R.SUPABASE_TOKEN_WRONG_AUDIENCE, 401);

// 8) JWKS unavailable → 503, unauthenticated, authz null.
{
  const dto = buildDTO(R.JWKS_UNAVAILABLE);
  const row = SESSION_RESOLVE_MATRIX[R.JWKS_UNAVAILABLE];
  const s = mapWhoamiToAppSession(dto);
  check(
    '8 jwks_unavailable → 503, deferred, unauthenticated, authz null',
    dto.status === 503 &&
      row.decision === 'deferred' &&
      s.authState === 'unauthenticated' &&
      s.identity === null &&
      s.authorization === null,
    `status=${dto.status} authState=${s.authState} reason=${s.reasonCode}`,
  );
}

// 9) Token verified but internalUserId cannot resolve → token-verified (NOT authenticated).
{
  const dto = buildDTO(R.IDENTITY_RESOLUTION_ERROR, { internalUserId: null });
  const row = SESSION_RESOLVE_MATRIX[R.IDENTITY_RESOLUTION_ERROR];
  const s = mapWhoamiToAppSession(dto);
  check(
    '9 identity_resolution_error (no id) → 503, token-verified, NOT authenticated, authz null',
    dto.status === 503 &&
      row.authState === 'token-verified' &&
      dto.identity === null &&
      dto.authorization === null &&
      s.authState === 'token-verified' &&
      s.authState !== ('authenticated' as string) &&
      s.identity === null &&
      s.authorization === null,
    `status=${dto.status} authState=${s.authState}`,
  );
}

// 10) DB unavailable during resolve → identity_resolution_error / token-verified.
{
  const dto = buildDTO(R.IDENTITY_RESOLUTION_ERROR, { internalUserId: null });
  const s = mapWhoamiToAppSession(dto);
  check(
    '10 DB-unavailable resolve → 503, identity_resolution_error, token-verified, authz null',
    dto.status === 503 &&
      dto.reasonCode === R.IDENTITY_RESOLUTION_ERROR &&
      s.authState === 'token-verified' &&
      s.authorization === null,
    `status=${dto.status} authState=${s.authState} reason=${dto.reasonCode}`,
  );
}

// 11) RESERVED/FUTURE — account disabled.
{
  const dto = buildDTO(R.ACCOUNT_DISABLED);
  const row = SESSION_RESOLVE_MATRIX[R.ACCOUNT_DISABLED];
  check(
    '11 account_disabled (RESERVED/FUTURE) → 403, deny, authz null, marked reserved',
    dto.status === 403 &&
      row.decision === 'deny' &&
      row.reserved === true &&
      dto.authorization === null,
    `status=${dto.status} reserved=${row.reserved} authz=${dto.authorization}`,
  );
}

// 12) RESERVED/FUTURE — account suspended.
{
  const dto = buildDTO(R.ACCOUNT_SUSPENDED);
  const row = SESSION_RESOLVE_MATRIX[R.ACCOUNT_SUSPENDED];
  check(
    '12 account_suspended (RESERVED/FUTURE) → 403, deny, authz null, marked reserved',
    dto.status === 403 &&
      row.decision === 'deny' &&
      row.reserved === true &&
      dto.authorization === null,
    `status=${dto.status} reserved=${row.reserved} authz=${dto.authorization}`,
  );
}

// 13) Unexpected handler error → 500, session_resolve_error, unauthenticated.
{
  const dto = buildDTO(R.SESSION_RESOLVE_ERROR);
  const s = mapWhoamiToAppSession(dto);
  check(
    '13 session_resolve_error → 500, unauthenticated, authz null',
    dto.status === 500 &&
      dto.reasonCode === R.SESSION_RESOLVE_ERROR &&
      s.authState === 'unauthenticated' &&
      s.identity === null &&
      s.authorization === null,
    `status=${dto.status} authState=${s.authState} reason=${dto.reasonCode}`,
  );
}

// 14) Forged client role/tenant/store/permissions are ignored → authz stays null.
{
  // These forged authority fields are NOT part of the DTO; cast through unknown
  // to simulate a hostile payload carrying extra keys.
  const base = buildDTO(R.VERIFIED_SUPABASE);
  const hostile = {
    ...base,
    role: 'system_owner',
    userType: 'platform',
    tenantId: 'tenant-evil',
    storeId: 'store-evil',
    permissions: { all: 'full' },
    user_metadata: { role: 'system_owner' },
  } as unknown as SessionResolveResponseDTO;
  const s = mapWhoamiToAppSession(hostile);
  check(
    '14 forged role/tenant/store/permissions ignored → authorization stays null',
    s.authState === 'authenticated' &&
      s.identity !== null &&
      s.identity.internalUserId === 'iuid-123' &&
      s.authorization === null,
    `authState=${s.authState} authz=${JSON.stringify(s.authorization)}`,
  );
}

// 15) No raw secret/token fields may appear on any representable DTO.
{
  const forbidden: SessionResolveForbiddenField[] = [
    'accessToken',
    'refreshToken',
    'rawJwt',
    'jwtPayload',
    'jwks',
    'serviceRoleKey',
    'databaseUrl',
    'connectionString',
  ];
  // Inspect a representative success + a representative failure DTO.
  const samples = [buildDTO(R.VERIFIED_SUPABASE), buildDTO(R.SUPABASE_TOKEN_INVALID)];
  const leaked: string[] = [];
  for (const dto of samples) {
    const keys = new Set(Object.keys(dto));
    for (const f of forbidden) if (keys.has(f)) leaked.push(f);
  }
  check(
    '15 DTO contains no accessToken/refreshToken/rawJwt/jwtPayload/jwks/serviceRoleKey/databaseUrl/connectionString',
    leaked.length === 0,
    leaked.length ? `LEAKED: ${leaked.join(', ')}` : 'no forbidden fields present',
  );
}

const failed = results.filter((r) => !r.pass);
console.log(`\n[session-resolve-contract-check] ${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length) process.exitCode = 1;

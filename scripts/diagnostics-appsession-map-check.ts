// Phase 1.5 M5 — dev-only unit check for the inert whoami → AppSession mapper.
//
// Pure, offline, secret-free: uses only hand-built dummy objects. No network,
// no env, no real tokens, no Supabase/Firebase calls. Proves the mapper is
// fail-closed, preserves 'token-verified', never derives authorization, and
// ignores client-asserted role/tenant/store/permission fields.
//
// Run:  npx tsx scripts/diagnostics-appsession-map-check.ts

import { mapWhoamiToAppSession, type WhoamiResponseInput } from '../src/auth/mapWhoamiToAppSession';

interface Result { name: string; pass: boolean; detail: string }
const results: Result[] = [];
function check(name: string, pass: boolean, detail = ''): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

// 1) Authenticated Supabase whoami with internalUserId.
{
  const input: WhoamiResponseInput = {
    status: 200,
    requestId: 'req-1',
    authState: 'authenticated',
    internalUserId: 'iuid-123',
    authProvider: 'supabase',
    authProviderUid: 'sub-abc',
    email: 'user@example.com',
    displayName: 'Test User',
    decision: 'allow',
    sourceOfTruth: 'supabase_verified_token',
  };
  const s = mapWhoamiToAppSession(input);
  check(
    '1 authenticated + internalUserId → authenticated, identity populated, authz null',
    s.authState === 'authenticated' &&
      s.identity !== null &&
      s.identity.internalUserId === 'iuid-123' &&
      s.identity.authProvider === 'supabase' &&
      s.authorization === null,
    `authState=${s.authState} hasIdentity=${s.identity !== null} authz=${s.authorization}`,
  );
}

// 2) Authenticated response MISSING internalUserId → fail-closed.
{
  const input: WhoamiResponseInput = {
    status: 200,
    authState: 'authenticated', // server says so, but no bridge key present
    authProvider: 'supabase',
    email: 'user@example.com',
  };
  const s = mapWhoamiToAppSession(input);
  check(
    '2 authenticated WITHOUT internalUserId → fail-closed unauthenticated, no identity',
    s.authState === 'unauthenticated' && s.identity === null && s.authorization === null,
    `authState=${s.authState} identity=${s.identity} reason=${s.reasonCode}`,
  );
}

// 3) Token-verified state preserved, never upgraded.
{
  const input: WhoamiResponseInput = {
    status: 503,
    authState: 'token-verified',
    // Even if an internalUserId leaks in, it must NOT upgrade to authenticated.
    internalUserId: 'iuid-should-be-ignored',
    reasonCode: 'identity_resolution_error',
  };
  const s = mapWhoamiToAppSession(input);
  check(
    '3 token-verified preserved, not upgraded, identity null, authz null',
    s.authState === 'token-verified' && s.identity === null && s.authorization === null,
    `authState=${s.authState} identity=${s.identity}`,
  );
}

// 4) Unauthenticated state.
{
  const input: WhoamiResponseInput = {
    status: 401,
    authState: 'unauthenticated',
    decision: 'deny',
    reasonCode: 'denied_unauthenticated',
  };
  const s = mapWhoamiToAppSession(input);
  check(
    '4 unauthenticated → unauthenticated, no identity, no authz',
    s.authState === 'unauthenticated' &&
      s.identity === null &&
      s.authorization === null &&
      s.reasonCode === 'denied_unauthenticated',
    `authState=${s.authState} reason=${s.reasonCode}`,
  );
}

// 5) Error response (structured error body, no authState).
{
  const input: WhoamiResponseInput = {
    status: 404,
    error: { code: 'FEATURE_DISABLED', message: 'Verified diagnostics are disabled.' },
  };
  const s = mapWhoamiToAppSession(input);
  check(
    '5 error response → unauthenticated, reason from error.code, no authz',
    s.authState === 'unauthenticated' &&
      s.identity === null &&
      s.authorization === null &&
      s.reasonCode === 'FEATURE_DISABLED',
    `authState=${s.authState} reason=${s.reasonCode}`,
  );
}

// 6) Malicious input with fake role/tenant/store/permissions → ignored.
{
  // These forged authorization fields are NOT part of WhoamiResponseInput; cast
  // through unknown to simulate a hostile payload carrying extra keys.
  const hostile = {
    status: 200,
    authState: 'authenticated',
    internalUserId: 'iuid-999',
    authProvider: 'supabase',
    // forged client-asserted authority — must be ignored:
    role: 'system_owner',
    userType: 'platform',
    tenantId: 'tenant-evil',
    storeId: 'store-evil',
    permissions: { all: 'full' },
    user_metadata: { role: 'system_owner' },
  } as unknown as WhoamiResponseInput;
  const s = mapWhoamiToAppSession(hostile);
  check(
    '6 forged role/tenant/store/permissions ignored → authorization stays null',
    s.authState === 'authenticated' &&
      s.identity !== null &&
      s.identity.internalUserId === 'iuid-999' &&
      s.authorization === null,
    `authState=${s.authState} authz=${JSON.stringify(s.authorization)}`,
  );
}

// 7) Null/undefined input → safe unauthenticated (defensive).
{
  const s = mapWhoamiToAppSession(null);
  check(
    '7 null input → unauthenticated, no identity/authz',
    s.authState === 'unauthenticated' && s.identity === null && s.authorization === null,
    `authState=${s.authState}`,
  );
}

const failed = results.filter((r) => !r.pass);
console.log(`\n[appsession-map-check] ${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length) process.exitCode = 1;

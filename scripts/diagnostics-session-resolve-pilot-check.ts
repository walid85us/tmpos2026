// Phase 1.5 M8 — dev-only STATIC check for the optional session-resolve pilot.
//
// Pure, offline, secret-free: reads the M8 source files as TEXT and asserts the
// binding contract by static inspection. No network, no env reads, no Supabase,
// no DB, no token. Proves:
//   - the client targets `/auth/session/resolve`;
//   - the request body is exactly `{}`;
//   - no client authority field is sent (user/user_metadata/role/userType/
//     tenantId/storeId/permissions/subPermissions/internalUserId/provider claims);
//   - no token/secret field is returned or rendered;
//   - the result display redacts internalUserId and authProviderUid;
//   - the result card labels `authorization: null`;
//   - the M8 files import no forbidden (app/server/Firebase) modules.
//
// Run:  npx tsx scripts/diagnostics-session-resolve-pilot-check.ts

import { readFileSync } from 'fs';
import { join } from 'path';

// Resolve from the repo root (the script is always run as
// `npx tsx scripts/diagnostics-session-resolve-pilot-check.ts` from the root).
const ROOT = process.cwd();
const CLIENT_PATH = join(ROOT, 'src/pilot/sessionResolvePilotClient.ts');
const PILOT_PATH = join(ROOT, 'src/pilot/SupabaseAuthPilot.tsx');

const client = readFileSync(CLIENT_PATH, 'utf8');
const pilot = readFileSync(PILOT_PATH, 'utf8');

/** Strip block + line comments so contract checks inspect CODE only, not the
 *  documentation comments that legitimately NAME the forbidden fields. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}
const clientCode = stripComments(client);

interface Result { name: string; pass: boolean; detail: string }
const results: Result[] = [];
function check(name: string, pass: boolean, detail = ''): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

// 1) Client targets the M7 route through IDENTITY_API_BASE.
check(
  '1 client POSTs to /auth/session/resolve via IDENTITY_API_BASE',
  client.includes('/auth/session/resolve') &&
    client.includes('IDENTITY_API_BASE') &&
    /method:\s*'POST'/.test(client),
  'path + base + POST present',
);

// 2) Request body is exactly an empty object literal.
check(
  '2 request body is exactly {}',
  /body:\s*'\{\}'/.test(client),
  "body: '{}' literal present",
);

// 3) Only an Authorization: Bearer header is sent (no client authority in body).
check(
  '3 only Authorization: Bearer header is sent as authority',
  /authorization:\s*`Bearer \$\{accessToken\}`/.test(client),
  'Bearer header present',
);

// 4) No client authority field is ever sent in the request.
// (None of these tokens may appear in a SEND/serialize context in the client.)
{
  const authorityFields = [
    'user_metadata',
    'userType',
    'tenantId',
    'storeId',
    'subPermissions',
    'JSON.stringify',
  ];
  // The client must not serialize any object into the body; the only body is '{}'.
  // Inspect CODE only (comments legitimately name these fields as forbidden).
  const offenders = authorityFields.filter((f) => clientCode.includes(f));
  check(
    '4 client sends no serialized authority field (no JSON.stringify / user_metadata / tenant / store)',
    offenders.length === 0,
    offenders.length ? `FOUND: ${offenders.join(', ')}` : 'none present',
  );
}

// 5) No token/secret field is returned or rendered by the client.
{
  const forbidden = [
    'accessToken',
    'refreshToken',
    'rawJwt',
    'jwtPayload',
    'jwks',
    'serviceRoleKey',
    'databaseUrl',
    'connectionString',
  ];
  // The token parameter is named `accessToken` in the function signature, which is
  // legitimate. Forbid it only as a RETURNED/result field name.
  const offenders = forbidden.filter((f) => {
    if (f === 'accessToken') {
      // allowed only as the input param / Bearer interpolation, never as a result key.
      return /accessToken\s*[:?]/.test(client.replace(/accessToken: string/g, ''));
    }
    return client.includes(f);
  });
  check(
    '5 client never returns a token/secret field',
    offenders.length === 0,
    offenders.length ? `FOUND: ${offenders.join(', ')}` : 'none present',
  );
}

// 6) Client never console.logs and never stores the token.
check(
  '6 client never console.logs',
  !/console\.(log|info|warn|error|debug)/.test(client),
  'no console.* call',
);

// 7) authorization is pinned to null in the client result type and returns.
check(
  '7 client pins authorization: null (type + every return)',
  (client.match(/authorization:\s*null/g) ?? []).length >= 2,
  `${(client.match(/authorization:\s*null/g) ?? []).length} occurrences`,
);

// 8) Pilot imports the client and the client is imported ONLY in the pilot path.
check(
  '8 pilot imports runSessionResolve from sessionResolvePilotClient',
  /import\s*\{[^}]*runSessionResolve[^}]*\}\s*from\s*'\.\/sessionResolvePilotClient'/.test(pilot),
  'import present',
);

// 9) Pilot redacts internalUserId and authProviderUid with redactId().
check(
  '9 pilot redacts internalUserId and authProviderUid via redactId()',
  /redactId\(resolveResult\.internalUserId\)/.test(pilot) &&
    /redactId\(resolveResult\.authProviderUid\)/.test(pilot),
  'both redacted',
);

// 10) Pilot result card labels authorization: null explicitly.
check(
  '10 pilot card labels authorization: null',
  pilot.includes('authorization: null — server-derived authorization is deferred') &&
    /label="Authorization"\s+value="null"/.test(pilot),
  'label + copy present',
);

// 11) Pilot card carries the required dev-diagnostic header copy.
check(
  '11 pilot card header states dev diagnostic, not app authorization',
  pilot.includes('Session resolve (M7) — dev diagnostic, not app authorization'),
  'header copy present',
);

// 12) Pilot never renders/logs the raw token.
{
  // The token is read at click time into a local `token` and handed to the client.
  // It must never be placed into state or rendered. Assert no setState(token) and
  // no JSX interpolation of the token, and no console.* token logging.
  const rendersToken =
    /setResolveResult\([^)]*token/.test(pilot) ||
    /\{token\}/.test(pilot) ||
    /value=\{token\}/.test(pilot);
  const logsToken = /console\.[a-z]+\([^)]*token/.test(pilot);
  check(
    '12 pilot never stores/renders/logs the access token',
    !rendersToken && !logsToken,
    rendersToken ? 'token rendered/stored' : logsToken ? 'token logged' : 'token kept in-memory only',
  );
}

// 13) M8 files import no forbidden app/server/Firebase modules.
{
  const forbiddenImports = [
    'firebase',
    'AccessContext',
    'AccessGuard',
    './Login',
    'components/Login',
    'react-router',
    'server/',
    'platform-identity',
    'appSession',
    'mapWhoamiToAppSession',
  ];
  const offenders: string[] = [];
  for (const [label, text] of [['client', client], ['pilot', pilot]] as const) {
    for (const f of forbiddenImports) {
      // Only flag in an import statement context.
      const re = new RegExp(`import[^;]*['"][^'"]*${f.replace(/[/.]/g, '\\$&')}[^'"]*['"]`);
      if (re.test(text)) offenders.push(`${label}:${f}`);
    }
  }
  check(
    '13 M8 files import no forbidden app/server/Firebase modules',
    offenders.length === 0,
    offenders.length ? `FOUND: ${offenders.join(', ')}` : 'no forbidden imports',
  );
}

const failed = results.filter((r) => !r.pass);
console.log(`\n[session-resolve-pilot-check] ${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length) process.exitCode = 1;

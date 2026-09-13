// Phase 4.0 M4 — production admin-host enforcement: the console runs only on a configured, exact
// https administration origin, which it owns entirely; elsewhere its path is refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isApiPath, isConsolePath, parseAdminOrigins, productionSurface } from './adminSurface';
import { isApiPath as serverIsApiPath } from '../../../server/runtime/adminWeb';

const ADMIN = 'https://admin.tmpos.test';
const TENANT = 'https://tenant.tmpos.test';

test('the administration origin list accepts only exact, distinct https origins', () => {
  assert.deepEqual(parseAdminOrigins(ADMIN), [ADMIN]);
  assert.deepEqual(parseAdminOrigins(`${ADMIN},https://ops.tmpos.test:8443`), [ADMIN, 'https://ops.tmpos.test:8443']);
  const refused: unknown[] = [
    undefined, null, 42, '', 'admin.tmpos.test', 'http://admin.tmpos.test', `${ADMIN}/`, `${ADMIN}/admin`,
    'https://ADMIN.tmpos.test', `${ADMIN}:443`, ` ${ADMIN}`, `${ADMIN},`, `${ADMIN},${ADMIN}`,
    'https://*.tmpos.test', 'https://ops@admin.tmpos.test',
  ];
  for (const raw of refused) assert.equal(parseAdminOrigins(raw), null, `accepted ${JSON.stringify(raw)}`);
});

test('in production the console owns its administration origin and nothing else', () => {
  const origins = [ADMIN];
  for (const path of ['/', '/admin', '/admin/command-center', '/login', '/owner']) {
    assert.equal(productionSurface(ADMIN, path, origins), 'admin', path);
  }
  for (const origin of [TENANT, 'http://127.0.0.1:5000', 'http://admin.tmpos.test']) {
    for (const path of ['/admin', '/admin/', '/admin/sign-in', '/admin/v1/session']) {
      assert.equal(productionSurface(origin, path, origins), 'admin-refused', `${origin}${path}`);
    }
    for (const path of ['/', '/owner', '/administrator', '/admin-tools']) {
      assert.equal(productionSurface(origin, path, origins), 'tenant', `${origin}${path}`);
    }
  }
});

test('without a valid administration origin the console is refused on every host', () => {
  for (const origin of [ADMIN, TENANT, 'http://127.0.0.1:5000']) {
    assert.equal(productionSurface(origin, '/admin', parseAdminOrigins('https://admin.tmpos.test/')), 'admin-refused');
    assert.equal(productionSurface(origin, '/admin', null), 'admin-refused');
    assert.equal(productionSurface(origin, '/', null), 'tenant');
  }
});

test('a console path is the base or below it, never a lookalike', () => {
  for (const path of ['/admin', '/admin/', '/admin/audit-security']) assert.equal(isConsolePath(path), true, path);
  for (const path of ['', '/', '/administrator', '/admin-tools', '/Admin', '/owner/admin']) assert.equal(isConsolePath(path), false, path);
});

// The one canonical rule (ledger item 20), shared with server/runtime/adminWeb.ts isApiPath:
// backslashes are slashes, one decode (a malformed path counts as API), case ignored, empty and
// '.' segments dropped, '..' resolved but never above the root.
test('an API address is either versioned namespace under the canonical path rule', () => {
  const api = [
    '/admin/v1', '/admin/v1/', '/ADMIN/V1/x',
    '/admin%2fv1/x', '/admin%2Fv1/x',
    '//admin/v1/x', '/admin//v1/x',
    '/%61dmin/v1/session',
    '/x/../admin/v1/x', '/x%2f..%2fadmin/v1/x',
    '/admin\\v1\\x',
    '/admin/v1/%E0%A4%A', // malformed: fails closed
    '/api/v1', '/api/v1/x',
    '/admin/v1%2fsession', '/api/v1%2F', '/../admin/v1', '/admin/./v1/x',
    '/admin%5cv1/x', '/admin%5Cv1%5Ccommand-center', // an encoded backslash is a slash too, after the one decode
  ];
  const notApi = [
    '/admin', '/admin/', '/admin/sign-in', '/admin/v10', '/admin/v1x', '/admin/tenant-management',
    '/assets/index-AbC.js', '/',
    '/%2561dmin/v1/x', // decoded once only
    '', '/admin/v1.json', '/api', '/api/v2', '/x/admin/v1', '/admin/v1/../command-center',
  ];
  for (const path of api) assert.equal(isApiPath(path), true, `${path} is an API address`);
  for (const path of notApi) assert.equal(isApiPath(path), false, `${path} is not an API address`);
});

// The console and the server decide "API address" by the same rule, or a path one of them lets
// through would reach the other as a page (ledger item 20).
test('the console and the server classify every probe identically', () => {
  const probes = [
    '/admin/v1', '/admin/v1/', '/ADMIN/V1/x', '/admin%2fv1/x', '/admin%2Fv1/x', '//admin/v1/x', '/admin//v1/x',
    '/%61dmin/v1/session', '/x/../admin/v1/x', '/x%2f..%2fadmin/v1/x', '/admin\\v1\\x', '/admin/v1/%E0%A4%A',
    '/api/v1', '/api/v1/x', '/admin/v1%2fsession', '/api/v1%2F', '/../admin/v1', '/admin/./v1/x', '/admin/%2e/v1',
    '/%2e%2e/admin/v1/x', '/admin/v1/../sign-in', '/admin/v1/../../api/v1', '/admin%5cv1/x', '/API/V1/SESSION',
    '/admin', '/admin/', '/admin/sign-in', '/admin/v10', '/admin/v1x', '/admin/tenant-management', '/assets/index-AbC.js',
    '/', '', '/%2561dmin/v1/x', '/admin/v1.json', '/api', '/api/v2', '/x/admin/v1', '/admin/v1/../command-center',
    '/%', '/%zz', '/admin/%', '/admin/v1%', '\\admin\\v1',
  ];
  for (const path of probes) {
    assert.equal(isApiPath(path), serverIsApiPath(path), `console and server disagree on ${JSON.stringify(path)}`);
  }
});

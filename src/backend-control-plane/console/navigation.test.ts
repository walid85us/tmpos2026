// Phase 4.0 M4 — the console's navigation vocabulary and its return-path rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONSOLE_HOME, CONSOLE_HOME_LABEL, CONSOLE_MODULES, SIGN_IN_PATH, modulePath, safeReturnPath } from './navigation';

const ACCEPTED_VOCABULARY = [
  'Command Center', 'Audit & Security', 'Support Tools', 'Tenant Management', 'Billing & Subscriptions',
  'Platform Settings', 'Domains', 'Team Management', 'Provisioning', 'Feature Matrix', 'Add-on Governance',
];

test('the navigation is exactly the accepted platform feature vocabulary, with the Command Center as the home entry', () => {
  assert.equal(CONSOLE_HOME_LABEL, 'Command Center');
  assert.deepEqual([CONSOLE_HOME_LABEL, ...CONSOLE_MODULES.map((module) => module.label)].sort(), [...ACCEPTED_VOCABULARY].sort());
  assert.equal(new Set(CONSOLE_MODULES.map((module) => module.slug)).size, CONSOLE_MODULES.length);
  // One Command Center: the console home, never a second placeholder module beside it.
  assert.ok(!CONSOLE_MODULES.some((module) => module.slug === 'command-center' || module.label === CONSOLE_HOME_LABEL));
  assert.equal(safeReturnPath('/admin/command-center'), CONSOLE_HOME);
});

test('no console page sits in the /admin/v1 API namespace or on the sign-in page', () => {
  for (const module of CONSOLE_MODULES) {
    const path = modulePath(module);
    assert.match(path, /^\/admin\/[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.notEqual(path, SIGN_IN_PATH);
    assert.ok(!path.startsWith('/admin/v1'), path);
  }
});

test('a return path is honoured only when it is exactly one of the console pages', () => {
  assert.equal(safeReturnPath(CONSOLE_HOME), CONSOLE_HOME);
  for (const module of CONSOLE_MODULES) assert.equal(safeReturnPath(modulePath(module)), modulePath(module));
  const hostile: unknown[] = [
    '//evil.test', '/\\evil.test', 'https://evil.test/admin', 'javascript:alert(1)', '/admin/../owner',
    '/admin/%2e%2e/owner', '/admin/command-center/', '/admin/command-center?next=//evil.test', '/admin/command-center#x',
    '/ADMIN/command-center', ' /admin', '/admin/v1/session', '/admin/v1/session/logout', SIGN_IN_PATH, '/owner', '',
    `/admin/${'x'.repeat(5000)}`, null, undefined, 42, {}, ['/admin'],
  ];
  for (const candidate of hostile) {
    assert.equal(safeReturnPath(candidate), CONSOLE_HOME, `honoured ${String(candidate).slice(0, 40)}`);
  }
});

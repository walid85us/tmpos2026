// Phase 4.0 M3 — central route-policy registration contract.
//
// The route table is the ONLY way a route reaches the runtime, so its validation is
// the registration half of "no handler can opt out": a definition must declare
// exactly one closed access policy, one closed body policy, a literal path and an
// allowed method, or startup fails closed with a bounded code. Phase 4.0 M4 adds the
// session policies: a login policy only at its boundary's exact bodiless POST login
// path, a session policy only under its own boundary prefix, and nothing else under
// the reserved /api and /admin namespaces.
import test from 'node:test';
import assert from 'node:assert/strict';
import { defineRoutes, EnforcementSetupError, MAX_JSON_BODY_BYTES, sessionPaths } from './routes.js';

const handler = (): void => {};
const PUBLIC = { access: 'public' };
const AUTHED = { access: 'authenticated', authorization: { scope: 'platform', permission: 'probe.read' } };
const NONE = { kind: 'none' };
const JSON_BODY = { kind: 'json', maxBytes: 1024, required: true };

const route = (over: Record<string, unknown>): Record<string, unknown> =>
  ({ method: 'GET', path: '/v1/probe', policy: PUBLIC, body: NONE, idempotency: 'none', handler, ...over });

/** The setup-error code a registration throws, or undefined when it registers. */
function setupCode(defs: unknown[]): string | undefined {
  try {
    defineRoutes(defs);
  } catch (err) {
    return err instanceof EnforcementSetupError ? err.code : 'unexpected_error_type';
  }
  return undefined;
}

test('a route registers with one closed policy and is found only by exact method and path', () => {
  const table = defineRoutes([route({}), route({ method: 'POST', policy: AUTHED })]);
  assert.equal(table.lookup('GET', '/v1/probe')?.policy.access, 'public');
  assert.equal(table.lookup('POST', '/v1/probe')?.policy.access, 'authenticated');
  for (const [method, path] of [
    ['HEAD', '/v1/probe'], ['get', '/v1/probe'], ['PUT', '/v1/probe'],
    ['GET', '/v1/probe/'], ['GET', '/V1/probe'], ['GET', '/v1/probes'], ['GET', '/v1/prob'],
    ['GET', '/v1/probe/x'], ['GET', '/v1//probe'], ['GET', '/v1/%70robe'], ['GET', '/v1/probe%2F'],
  ]) {
    assert.equal(table.lookup(method, path), undefined, `${method} ${path} must not match`);
  }
});

test('registration copies and freezes each definition, so neither policy can change after startup', () => {
  const policy = { access: 'authenticated', authorization: { scope: 'platform', permission: 'probe.read' } };
  const body = { kind: 'json', maxBytes: 1024, required: true };
  const table = defineRoutes([route({ method: 'POST', policy, body })]);
  policy.access = 'public';
  body.maxBytes = 1_000_000_000;
  const def = table.lookup('POST', '/v1/probe');
  assert.equal(def?.policy.access, 'authenticated', 'mutating the caller object must not reach the table');
  assert.deepEqual(def?.body, { kind: 'json', maxBytes: 1024, required: true }, 'nor may mutating the caller body policy');
  assert.ok(def && Object.isFrozen(def) && Object.isFrozen(def.policy) && Object.isFrozen(def.body));
  assert.ok(Object.isFrozen((def.policy as { authorization: object }).authorization));
  assert.ok(Object.isFrozen(table.list()));
});

test('a route without policy metadata is rejected at registration', () => {
  for (const def of [{ method: 'GET', path: '/v1/probe', body: NONE, handler }, route({ policy: undefined }), route({ policy: null })]) {
    assert.equal(setupCode([def]), 'route_policy_missing');
  }
});

test('a route without a body policy is rejected at registration', () => {
  for (const def of [{ method: 'GET', path: '/v1/probe', policy: PUBLIC, handler }, route({ body: undefined }), route({ body: null })]) {
    assert.equal(setupCode([def]), 'route_body_policy_missing');
  }
});

test('an unknown, partial or contradictory policy is rejected', () => {
  const authz = (a: Record<string, unknown>): Record<string, unknown> => ({ access: 'authenticated', authorization: a });
  for (const policy of [
    'public', {}, { access: 'open' }, { access: 'PUBLIC' },
    { access: 'public', authorization: { scope: 'platform', permission: 'probe.read' } },
    { access: 'public', bypass: true },
    { access: 'authenticated' },
    authz({ scope: 'platform' }),
    authz({ permission: 'probe.read' }),
    authz({ scope: 'global', permission: 'probe.read' }),
    authz({ scope: 'platform', permission: '' }),
    authz({ scope: 'platform', permission: 'Probe Read' }),
    authz({ scope: 'platform', permission: 'x'.repeat(65) }),
    authz({ scope: 'platform', permission: 'probe.read', role: 'admin' }),
    { ...AUTHED, public: true },
  ]) {
    assert.equal(setupCode([route({ policy })]), 'route_policy_invalid', JSON.stringify(policy));
  }
});

test('an unknown, unbounded, partial or contradictory body policy is rejected', () => {
  const post = (body: unknown): Record<string, unknown> => route({ method: 'POST', policy: AUTHED, body });
  const json = (over: Record<string, unknown>): Record<string, unknown> => ({ ...JSON_BODY, ...over });
  for (const def of [
    post('none'), post('json'), post({}), post([]), post({ kind: 'NONE' }), post({ kind: 'raw' }),
    post({ kind: 'text', maxBytes: 1024, required: true }),
    post({ kind: 'none', maxBytes: 1024 }), post({ kind: 'none', required: false }),
    post({ kind: 'json' }), post(json({ maxBytes: undefined })), post(json({ required: undefined })),
    post(json({ maxBytes: 0 })), post(json({ maxBytes: -1 })), post(json({ maxBytes: 1.5 })),
    post(json({ maxBytes: Number.NaN })), post(json({ maxBytes: Number.POSITIVE_INFINITY })),
    post(json({ maxBytes: '1024' })), post(json({ maxBytes: MAX_JSON_BODY_BYTES + 1 })),
    post(json({ required: 'yes' })), post(json({ required: 1 })),
    post(json({ mediaType: 'text/plain' })), post(json({ unbounded: true })),
    // A body contradicts a method without body semantics (RFC 9110 §9.3.1, §9.3.5).
    route({ body: JSON_BODY }), route({ method: 'DELETE', policy: AUTHED, body: JSON_BODY }),
  ]) {
    assert.equal(setupCode([def]), 'route_body_policy_invalid', JSON.stringify(def.body));
  }
});

test('a bounded JSON body registers on POST, PUT and PATCH, up to the ceiling', () => {
  for (const method of ['POST', 'PUT', 'PATCH']) {
    for (const body of [JSON_BODY, { kind: 'json', maxBytes: 1, required: false }, { kind: 'json', maxBytes: MAX_JSON_BODY_BYTES, required: true }]) {
      assert.equal(setupCode([route({ method, policy: AUTHED, body })]), undefined, `${method} ${JSON.stringify(body)}`);
    }
  }
});

test('only literal, lowercase, parameter-free paths register', () => {
  for (const path of [
    '', '/', 'v1/probe', '/v1/probe/', '/V1/probe', '/v1/:id', '/v1/*', '/v1/probe*', '/v1//probe',
    '/v1/./probe', '/v1/../probe', '/v1/probe?x=1', '/v1/probe#x', '/v1/%70robe', '/v1/pro be',
    '/v1/probe.json', '/v1/-probe', '/v1/probe ', `/${'a'.repeat(300)}`, 42, null, undefined,
  ]) {
    assert.equal(setupCode([route({ path })]), 'route_path_invalid', String(path));
  }
});

test('only GET, POST, PUT, PATCH and DELETE register', () => {
  for (const method of ['HEAD', 'OPTIONS', 'TRACE', 'CONNECT', 'ALL', 'get', 'Post', '', undefined, 1]) {
    assert.equal(setupCode([route({ method })]), 'route_method_invalid', String(method));
  }
  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.equal(setupCode([route({ method, policy: AUTHED })]), undefined, method);
  }
});

test('an unauthenticated state-changing route cannot register', () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.equal(setupCode([route({ method, policy: PUBLIC })]), 'route_public_unsafe', method);
  }
});

test('each policy field is read once, so a getter cannot validate one value and register another', () => {
  let reads = 0;
  const authorization = { scope: 'platform', get permission() { reads++; return reads === 1 ? 'probe.read' : 'Not Valid'; } };
  const table = defineRoutes([route({ policy: { access: 'authenticated', authorization } })]);
  const policy = table.lookup('GET', '/v1/probe')?.policy as { authorization: { permission: string } };
  assert.equal(policy.authorization.permission, 'probe.read');

  let capReads = 0;
  const body = { kind: 'json', required: true, get maxBytes() { capReads++; return capReads === 1 ? 1024 : MAX_JSON_BODY_BYTES * 1024; } };
  const withBody = defineRoutes([route({ method: 'POST', policy: AUTHED, body })]);
  assert.equal((withBody.lookup('POST', '/v1/probe')?.body as { maxBytes: number }).maxBytes, 1024);
});

test('an opt-out flag or any unknown key on a definition is refused, never ignored', () => {
  for (const def of [route({ skipEnforcement: true }), route({ middleware: [] }), route({ public: true }), null, 'GET /v1/probe', []]) {
    assert.equal(setupCode([def]), 'route_definition_invalid', JSON.stringify(def));
  }
});

test('a missing or non-function handler is refused', () => {
  for (const h of [undefined, null, 'handler', {}]) {
    assert.equal(setupCode([route({ handler: h })]), 'route_handler_invalid', String(h));
  }
});

test('a duplicate method and path is refused; one path may carry distinct methods', () => {
  assert.equal(setupCode([route({}), route({})]), 'route_duplicate');
  assert.equal(setupCode([route({}), route({ method: 'DELETE', policy: AUTHED })]), undefined);
});

test('a setup error carries only its bounded code, never the offending input', () => {
  let err: unknown;
  try {
    defineRoutes([route({ path: '/v1/:secret-token-value' })]);
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof EnforcementSetupError);
  assert.equal(err.code, 'route_path_invalid');
  assert.ok(!err.message.includes('secret-token-value'));
});

// --- the two session boundaries (Phase 4.0 M4) ---------------------------------------------

const LOGIN = (audience: string): Record<string, unknown> => ({ access: 'login', audience });
const SESSION = (audience: string, authorization: unknown = { scope: 'tenant', permission: 'probe.read' }): Record<string, unknown> =>
  ({ access: 'session', audience, authorization });

test('each session boundary names one versioned login, current-session and logout path', () => {
  assert.deepEqual(sessionPaths('tenant'), { login: '/api/v1/session/login', current: '/api/v1/session', logout: '/api/v1/session/logout' });
  assert.deepEqual(sessionPaths('admin'), { login: '/admin/v1/session/login', current: '/admin/v1/session', logout: '/admin/v1/session/logout' });
});

test("a login policy registers only as its own boundary's exact bodiless POST login path", () => {
  for (const audience of ['tenant', 'admin'] as const) {
    const path = sessionPaths(audience).login;
    const table = defineRoutes([route({ method: 'POST', path, policy: LOGIN(audience) })]);
    assert.deepEqual(table.lookup('POST', path)?.policy, { access: 'login', audience });
  }
  for (const [label, def] of [
    ['GET', route({ path: '/api/v1/session/login', policy: LOGIN('tenant') })],
    ['PUT', route({ method: 'PUT', path: '/api/v1/session/login', policy: LOGIN('tenant') })],
    ['another path', route({ method: 'POST', path: '/api/v1/session/signin', policy: LOGIN('tenant') })],
    ['with a body', route({ method: 'POST', path: '/api/v1/session/login', policy: LOGIN('tenant'), body: JSON_BODY })],
  ] as const) {
    assert.equal(setupCode([def]), 'route_session_endpoint_invalid', label);
  }
  for (const [path, audience] of [['/admin/v1/session/login', 'tenant'], ['/api/v1/session/login', 'admin'], ['/v1/session/login', 'tenant']]) {
    assert.equal(setupCode([route({ method: 'POST', path, policy: LOGIN(audience) })]), 'route_audience_mismatch', `${audience} login at ${path}`);
  }
});

test('a boundary prefix admits only its own session policies, and a session policy only its own prefix', () => {
  for (const [path, policy] of [
    ['/api/v1/probe', PUBLIC], ['/api/v1/probe', AUTHED], ['/admin/v1/probe', AUTHED], ['/admin/v1/probe', PUBLIC],
    ['/api/v1/probe', SESSION('admin')], ['/admin/v1/probe', SESSION('tenant')], ['/v1/probe', SESSION('tenant')],
    // The unversioned namespaces stay reserved, so nothing registers beside the boundaries.
    ['/admin/session/login', PUBLIC], ['/api/probe', PUBLIC], ['/admin', PUBLIC], ['/api/v2/probe', AUTHED], ['/api/v1', SESSION('tenant')],
  ] as const) {
    assert.equal(setupCode([route({ path, policy })]), 'route_audience_mismatch', `${path} ${JSON.stringify(policy)}`);
  }
  assert.equal(setupCode([route({ path: '/api/v1/probe', policy: SESSION('tenant') })]), undefined);
  assert.equal(setupCode([route({ method: 'POST', path: '/admin/v1/probe', policy: SESSION('admin', { scope: 'platform', permission: 'probe.write' }) })]), undefined);
  assert.equal(setupCode([route({ path: '/apix/probe' }), route({ path: '/administer' })]), undefined, 'a lookalike prefix is no boundary');
});

test("a session route without an authorization requirement registers only as its boundary's current-session or logout endpoint", () => {
  const bare = (audience: string): Record<string, unknown> => ({ access: 'session', audience, authorization: null });
  assert.equal(setupCode([
    route({ path: '/api/v1/session', policy: bare('tenant') }),
    route({ method: 'POST', path: '/api/v1/session/logout', policy: bare('tenant') }),
    route({ path: '/admin/v1/session', policy: bare('admin') }),
    route({ method: 'POST', path: '/admin/v1/session/logout', policy: bare('admin') }),
  ]), undefined);
  for (const [label, def] of [
    ['a business route', route({ path: '/api/v1/probe', policy: bare('tenant') })],
    ['POST current-session', route({ method: 'POST', path: '/api/v1/session', policy: bare('tenant') })],
    ['GET logout', route({ path: '/api/v1/session/logout', policy: bare('tenant') })],
    ['logout with a body', route({ method: 'POST', path: '/api/v1/session/logout', policy: bare('tenant'), body: JSON_BODY })],
    ['a requirement on current-session', route({ path: '/api/v1/session', policy: SESSION('tenant') })],
    ['a session policy at the login path', route({ method: 'POST', path: '/api/v1/session/login', policy: SESSION('tenant') })],
  ] as const) {
    assert.equal(setupCode([def]), 'route_session_endpoint_invalid', label);
  }
});

test('an unknown, partial or contradictory login or session policy is rejected', () => {
  for (const policy of [
    { access: 'login' }, { access: 'login', audience: 'partner' }, { access: 'login', audience: 'Tenant' },
    { access: 'login', audience: 'tenant', authorization: null },
    { access: 'session', audience: 'tenant' }, { access: 'session', authorization: null },
    { access: 'session', audience: 'store', authorization: null },
    { access: 'session', audience: 'tenant', authorization: { scope: 'tenant' } },
    { access: 'session', audience: 'tenant', authorization: 'none' },
    { access: 'session', audience: 'tenant', authorization: null, cookie: 'x' },
  ]) {
    assert.equal(setupCode([route({ method: 'POST', path: '/api/v1/session/login', policy })]), 'route_policy_invalid', JSON.stringify(policy));
  }
});

// --- the idempotency policy (Phase 4.0 M6-IDEMPOT-P2) ------------------------------------------

const outcome = (): { status: number; body: unknown } => ({ status: 200, body: { ok: true } });
const BARE_SESSION = (audience: string): Record<string, unknown> => ({ access: 'session', audience, authorization: null });
/** An idempotency-required definition: a `perform`, and no handler. */
const required = (over: Record<string, unknown>): Record<string, unknown> =>
  ({ method: 'POST', path: '/v1/probe', policy: AUTHED, body: NONE, idempotency: 'required', perform: outcome, ...over });

test('a route without an idempotency policy is rejected at registration', () => {
  const undeclared = route({});
  delete undeclared.idempotency;
  for (const def of [undeclared, route({ idempotency: undefined }), route({ idempotency: null })]) {
    assert.equal(setupCode([def]), 'route_idempotency_policy_missing');
  }
});

test('the idempotency policy is a closed vocabulary of none and required', () => {
  for (const idempotency of ['None', 'REQUIRED', 'optional', '', 'true', true, 1, {}, { kind: 'required' }, ['required']]) {
    assert.equal(setupCode([required({ idempotency })]), 'route_idempotency_policy_invalid', JSON.stringify(idempotency));
  }
  const table = defineRoutes([route({}), required({})]);
  assert.equal(table.lookup('GET', '/v1/probe')?.idempotency, 'none');
  assert.equal(table.lookup('POST', '/v1/probe')?.idempotency, 'required');
});

test('only a state-changing route of a verified principal under a declared authorization may require idempotency', () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.equal(setupCode([required({ method })]), undefined, `authenticated ${method}`);
  }
  assert.equal(setupCode([required({ path: '/api/v1/probe', policy: SESSION('tenant', { scope: 'platform', permission: 'probe.write' }) })]), undefined,
    'a tenant-boundary session route under a platform-scope requirement');
  for (const scope of ['tenant', 'store']) {
    assert.equal(setupCode([required({ policy: { access: 'authenticated', authorization: { scope, permission: 'probe.write' } } })]),
      'route_idempotency_policy_invalid', `a ${scope}-scoped route: no ${scope} context exists to bind before M5`);
  }
  assert.equal(setupCode([required({ path: '/api/v1/probe', policy: SESSION('tenant') })]), 'route_idempotency_policy_invalid', 'a tenant-scoped session route');
  assert.equal(setupCode([required({ method: 'PATCH', path: '/admin/v1/probe', policy: SESSION('admin', { scope: 'platform', permission: 'probe.write' }) })]),
    undefined, 'an admin session route');
  for (const [label, def] of [
    ['an authenticated read', required({ method: 'GET' })],
    ['a public read', required({ method: 'GET', policy: PUBLIC })],
    ['a session read', required({ method: 'GET', path: '/api/v1/probe', policy: SESSION('tenant') })],
    ['a login', required({ path: sessionPaths('tenant').login, policy: LOGIN('tenant') })],
    ['a logout', required({ path: sessionPaths('admin').logout, policy: BARE_SESSION('admin') })],
    ['a current-session read', required({ method: 'GET', path: sessionPaths('tenant').current, policy: BARE_SESSION('tenant') })],
  ] as const) {
    assert.equal(setupCode([def]), 'route_idempotency_policy_invalid', label);
  }
});

test("a route's operation matches its idempotency policy: a handler for none, a perform for required, never both", () => {
  const { handler: _handler, ...noHandler } = route({});
  const { perform: _perform, ...noPerform } = required({});
  for (const [label, def] of [
    ['none with a perform instead of a handler', { ...noHandler, perform: outcome }],
    ['none with both', route({ perform: outcome })],
    ['required with a handler instead of a perform', { ...noPerform, handler }],
    ['required with both', required({ handler })],
    ['required without an operation', noPerform],
    ['required with a non-function perform', required({ perform: 'outcome' })],
  ] as const) {
    assert.equal(setupCode([def]), 'route_handler_invalid', label);
  }
  const registered = defineRoutes([required({})]).lookup('POST', '/v1/probe');
  assert.ok(registered?.idempotency === 'required' && registered.perform === outcome && !('handler' in registered));
});

test('the idempotency policy is read once, so a getter cannot validate one value and register another', () => {
  let reads = 0;
  const def = { ...route({}), get idempotency() { reads++; return reads === 1 ? 'none' : 'required'; } };
  const registered = defineRoutes([def]).lookup('GET', '/v1/probe');
  assert.equal(registered?.idempotency, 'none', 'the value validated is the value registered');
  assert.equal(reads, 1);
  assert.ok(registered !== undefined && Object.isFrozen(registered));
});

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
import { defineRoutes, EnforcementSetupError, MAX_JSON_BODY_BYTES, pathIdBeforeSuffixOf, pathIdOf, sessionPaths, storeTargetOf } from './routes.js';

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
  ({ method: 'POST', path: '/v1/probe', policy: AUTHED, body: NONE, idempotency: 'required', trustedContext: 'required', perform: outcome, ...over });

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
      'route_idempotency_policy_invalid', `a ${scope}-scoped Bearer route: no session for the store to hold`);
  }
  // M7A-CUSTOMERS-P3: a tenant-scoped requirement on a tenant-session COMMAND route, and nowhere else.
  const command = (over: Record<string, unknown>): Record<string, unknown> => {
    const { perform: _perform, ...rest } = required({ path: '/api/v1/probe', policy: SESSION('tenant'), ...over });
    return { ...rest, command: { contract: {}, plan: () => ({}) } };
  };
  assert.equal(setupCode([command({})]), undefined, 'a tenant-scoped tenant-session command');
  assert.equal(defineRoutes([command({})]).lookup('POST', '/api/v1/probe')?.idempotency, 'required');
  assert.equal(setupCode([required({ path: '/api/v1/probe', policy: SESSION('tenant') })]), 'route_idempotency_policy_invalid',
    'a tenant-scoped perform: it runs outside the store transaction that re-proves the tenant');
  assert.equal(setupCode([command({ policy: SESSION('tenant', { scope: 'store', permission: 'probe.write' }) })]),
    'route_idempotency_policy_invalid', 'a store-scoped tenant-session command outside the closed store POST template (M7B-INVOICES-P1)');
  assert.equal(setupCode([command({ method: 'PATCH', path: '/admin/v1/probe', policy: SESSION('admin', { scope: 'tenant', permission: 'probe.write' }) })]),
    'route_idempotency_policy_invalid', 'a tenant-scoped command on the admin boundary');
  assert.equal(setupCode([command({ policy: { access: 'authenticated', authorization: { scope: 'tenant', permission: 'probe.write' } }, path: '/v1/probe' })]),
    'route_idempotency_policy_invalid', 'a tenant-scoped Bearer command');
  assert.equal(setupCode([command({ trustedContext: 'none' })]), 'route_trusted_context_invalid', 'a tenant-scoped command still needs its trusted context');
  assert.equal(setupCode([command({ sessionBinding: 'required' })]), 'route_session_binding_invalid', 'and still binds no session key to a handler');
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

test("a route's operation matches its idempotency policy: a handler for none, a perform or a command for required, never two", () => {
  const { handler: _handler, ...noHandler } = route({});
  const { perform: _perform, ...noPerform } = required({});
  const command = { contract: {}, plan: () => ({}) };
  for (const [label, def] of [
    ['none with a perform instead of a handler', { ...noHandler, perform: outcome }],
    ['none with both', route({ perform: outcome })],
    ['none with a command', route({ command })],
    ['required with a handler instead of a perform', { ...noPerform, handler }],
    ['required with both', required({ handler })],
    ['required without an operation', noPerform],
    ['required with a non-function perform', required({ perform: 'outcome' })],
    ['required with a perform and a command', required({ command })],
    ['required with a command without a planner', { ...noPerform, command: { contract: {} } }],
    ['required with a command whose planner is not a function', { ...noPerform, command: { contract: {}, plan: 'plan' } }],
    ['required with a command without a contract', { ...noPerform, command: { plan: () => ({}) } }],
    ['required with a command carrying more than its contract and planner', { ...noPerform, command: { ...command, sql: 'select 1' } }],
    ['required with a command that is a function', { ...noPerform, command: () => ({}) }],
  ] as const) {
    assert.equal(setupCode([def]), 'route_handler_invalid', label);
  }
  const registered = defineRoutes([required({})]).lookup('POST', '/v1/probe');
  assert.ok(registered?.idempotency === 'required' && 'perform' in registered && registered.perform === outcome && !('handler' in registered));
  const commandRoute = defineRoutes([{ ...noPerform, command }]).lookup('POST', '/v1/probe');
  assert.ok(commandRoute?.idempotency === 'required' && 'command' in commandRoute && (commandRoute.command.plan as unknown) === command.plan
    && Object.isFrozen(commandRoute.command) && !('perform' in commandRoute) && !('handler' in commandRoute),
  'a command registers as its contract and planner only; createApp validates the contract');
});

test('the idempotency policy is read once, so a getter cannot validate one value and register another', () => {
  let reads = 0;
  const def = { ...route({}), get idempotency() { reads++; return reads === 1 ? 'none' : 'required'; } };
  const registered = defineRoutes([def]).lookup('GET', '/v1/probe');
  assert.equal(registered?.idempotency, 'none', 'the value validated is the value registered');
  assert.equal(reads, 1);
  assert.ok(registered !== undefined && Object.isFrozen(registered));
});

// --- the session binding (M7A-CUSTOMERS-P2) ----------------------------------------------------

test('the session binding is optional, and required only on a session route with an authorization, a trusted context and no idempotency', () => {
  const bound = (over: Record<string, unknown>): Record<string, unknown> =>
    route({ path: '/api/v1/probe', policy: SESSION('tenant'), trustedContext: 'required', sessionBinding: 'required', ...over });
  const table = defineRoutes([bound({}), route({}), route({ path: '/v1/declared', sessionBinding: 'none' }), route({ path: '/v1/nulled', sessionBinding: null })]);
  assert.equal(table.lookup('GET', '/api/v1/probe')?.sessionBinding, 'required');
  for (const path of ['/v1/probe', '/v1/declared', '/v1/nulled']) assert.equal(table.lookup('GET', path)?.sessionBinding, 'none', `${path}: undeclared is none`);
  assert.equal(setupCode([bound({ path: '/admin/v1/probe', policy: SESSION('admin', { scope: 'platform', permission: 'probe.read' }) })]), undefined, 'either boundary');
  for (const [label, def] of [
    ['a public route', route({ sessionBinding: 'required' })],
    ['an authenticated route', route({ policy: AUTHED, trustedContext: 'required', sessionBinding: 'required' })],
    ['the current-session endpoint', route({ path: '/api/v1/session', policy: BARE_SESSION('tenant'), sessionBinding: 'required' })],
    ['no trusted context', bound({ trustedContext: 'none' })],
    ['an undeclared trusted context', bound({ trustedContext: undefined })],
    ['an idempotency-required session route', required({ path: '/api/v1/probe', policy: SESSION('tenant', { scope: 'platform', permission: 'probe.write' }), sessionBinding: 'required' })],
    ['an unknown word', bound({ sessionBinding: 'optional' })],
    ['a capitalised word', bound({ sessionBinding: 'Required' })],
    ['a boolean', bound({ sessionBinding: true })],
    ['an object', bound({ sessionBinding: { kind: 'required' } })],
  ] as const) {
    assert.equal(setupCode([def]), 'route_session_binding_invalid', label);
  }
});

// --- the two path templates (M7A-CUSTOMERS-P4, -P6; docs/phase-4 C1/C2.5) ---------------------------

const VIEW = { scope: 'tenant', permission: 'view_customers' };
const detail = (over: Record<string, unknown> = {}): Record<string, unknown> =>
  route({ path: '/api/v1/customers/{id}', policy: SESSION('tenant', VIEW), trustedContext: 'required', sessionBinding: 'required', ...over });
const list = (over: Record<string, unknown> = {}): Record<string, unknown> => detail({ path: '/api/v1/customers', ...over });
const profile = (over: Record<string, unknown> = {}): Record<string, unknown> => detail({ path: '/api/v1/customers/{id}/profile', ...over });
const ID = '0f8e2a4c-9b1d-4e3f-8a2b-6c7d8e9f0a1b';

test('the GET {id} templates register only as GET /api/v1/customers/{id} and GET /api/v1/customers/{id}/profile without idempotency; every other template is refused (the PATCH: below)', () => {
  assert.equal(setupCode([detail()]), undefined);
  assert.equal(setupCode([profile()]), undefined, 'M7A-CUSTOMERS-P6: the profile template');
  assert.equal(setupCode([list(), detail(), profile()]), undefined, 'all three beside each other');
  for (const [label, def] of [
    ['a template elsewhere', route({ path: '/v1/{id}' })],
    ['a middle parameter', route({ path: '/v1/{id}/x' })],
    ['two parameters', route({ path: '/v1/{id}/{id}' })],
    ['a bare parameter', route({ path: '/{id}' })],
    ['an uppercase parameter', detail({ path: '/api/v1/customers/{ID}' })],
    ['a trailing slash', route({ path: '/v1/probe/{id}/' })],
    ['a sibling tenant template', detail({ path: '/api/v1/roles/{id}' })],
    ['a deeper template', detail({ path: '/api/v1/customers/x/{id}' })],
    ['an admin template', detail({ path: '/admin/v1/customers/{id}', policy: SESSION('admin', { scope: 'platform', permission: 'probe.read' }) })],
    ['a colon parameter', detail({ path: '/api/v1/customers/:id' })],
    ['a literal uuid below the template', detail({ path: `/api/v1/customers/${ID}` })],
    ['a literal word below the template', detail({ path: '/api/v1/customers/search' })],
    ['a literal uuid below the template, POST', required({ path: `/api/v1/customers/${ID}`, policy: SESSION('tenant', { scope: 'tenant', permission: 'create_customers' }), trustedContext: 'required' })],
    ...(['POST', 'PUT', 'PATCH', 'DELETE'] as const).map((method) => [`${method} on the template`, detail({ method })] as const),
    ['the template requiring idempotency', required({ path: '/api/v1/customers/{id}', policy: SESSION('tenant', VIEW), trustedContext: 'required' })],
    // M7A-CUSTOMERS-P6: the suffix template admits exactly its one suffix, nothing beside or below it.
    ['another suffix', detail({ path: '/api/v1/customers/{id}/contacts' })],
    ['a suffix below the profile', detail({ path: '/api/v1/customers/{id}/profile/x' })],
    ['the profile with a trailing slash', detail({ path: '/api/v1/customers/{id}/profile/' })],
    ['an uppercase suffix', detail({ path: '/api/v1/customers/{id}/Profile' })],
    ['a parameter after the suffix', detail({ path: '/api/v1/customers/{id}/profile/{id}' })],
    ['the profile suffix elsewhere', detail({ path: '/api/v1/roles/{id}/profile' })],
    ...(['POST', 'PUT', 'PATCH', 'DELETE'] as const).map((method) => [`${method} on the profile template`, profile({ method })] as const),
    ['the profile template requiring idempotency', required({ path: '/api/v1/customers/{id}/profile', policy: SESSION('tenant', VIEW), trustedContext: 'required' })],
    ['a literal profile below the template', detail({ path: `/api/v1/customers/${ID}/profile` })],
    ['a literal word-and-profile below the template', detail({ path: '/api/v1/customers/x/profile' })],
    ['a deeper literal below the template', detail({ path: '/api/v1/customers/x/y/z' })],
  ] as const) {
    assert.equal(setupCode([def]), 'route_path_invalid', label);
  }
  assert.equal(setupCode([profile(), profile()]), 'route_duplicate', 'a duplicate profile template');
  // A template on a non-session policy is refused by the boundary rule, as any /api path would be.
  assert.notEqual(setupCode([route({ path: '/api/v1/customers/{id}' })]), undefined);
  assert.equal(setupCode([detail(), detail()]), 'route_duplicate', 'a duplicate template');
});

const EDIT = { scope: 'tenant', permission: 'edit_customers' };
/**
 * M7A-CUSTOMERS-P7: the customer template's one templated command — PATCH /api/v1/customers/{id}, idempotency required, a
 * command, no handler. (The route table's other templated command, since M7B-INVOICES-P1, is the store template's draft
 * save, POST /api/v1/stores/{storeId}/invoice-drafts.)
 */
const patch = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  method: 'PATCH', path: '/api/v1/customers/{id}', policy: SESSION('tenant', EDIT), body: { kind: 'json', maxBytes: 8_192, required: true },
  idempotency: 'required', trustedContext: 'required', recentAuth: 'none', command: { contract: {}, plan: () => ({}) }, ...over,
});

test('M7A-CUSTOMERS-P7: PATCH /api/v1/customers/{id} registers only as an idempotency-required command; every other templated write or keyed template stays refused', () => {
  assert.equal(setupCode([patch()]), undefined, 'the templated command');
  assert.equal(setupCode([list(), detail(), profile(), patch()]), undefined, 'beside the list, the detail and the profile');
  const table = defineRoutes([list(), detail(), profile(), patch()]);
  const declared = table.lookup('PATCH', `/api/v1/customers/${ID}`);
  assert.equal(declared?.path, '/api/v1/customers/{id}');
  assert.equal(declared?.idempotency, 'required');
  assert.equal(declared?.trustedContext, 'required');
  assert.ok(declared !== undefined && 'command' in declared && !('handler' in declared), 'a command, never a handler');
  const { command: _command, ...noCommand } = patch();
  for (const [label, def] of [
    ['the PATCH template without idempotency, as a handler', { ...noCommand, idempotency: 'none', handler }],
    ['the PATCH template as a perform', { ...noCommand, perform: outcome }],
    ['the PATCH template with a command AND a perform', patch({ perform: outcome })],
    ['the PATCH template on the profile', patch({ path: '/api/v1/customers/{id}/profile' })],
    ['a PATCH template beside customers', patch({ path: '/api/v1/roles/{id}' })],
    ['a deeper PATCH template', patch({ path: '/api/v1/customers/x/{id}' })],
    ...(['POST', 'PUT', 'DELETE'] as const).map((method) => [`${method} as a command on the template`, patch({ method })] as const),
    ['the GET detail template requiring idempotency as a command', patch({ method: 'GET', body: { kind: 'none' } })],
    ['the GET profile template requiring idempotency', required({ path: '/api/v1/customers/{id}/profile', policy: SESSION('tenant', VIEW), trustedContext: 'required' })],
  ] as const) {
    assert.notEqual(setupCode([def]), undefined, label);
  }
  // The closed rule itself answers route_path_invalid wherever the earlier policy checks admit the shape.
  for (const [label, def] of [
    ['a handler on the PATCH template', { ...noCommand, idempotency: 'none', handler }],
    ['PUT as a command on the template', patch({ method: 'PUT' })],
    ['POST as a command on the template', patch({ method: 'POST' })],
    ['PATCH as a command on the profile template', patch({ path: '/api/v1/customers/{id}/profile' })],
  ] as const) {
    assert.equal(setupCode([def]), 'route_path_invalid', label);
  }
  assert.equal(setupCode([patch(), patch()]), 'route_duplicate', 'a duplicate PATCH template');
  // Lookup: the PATCH answers one raw segment, exactly as the GET detail does, and never the profile path.
  for (const segment of [ID, ID.toUpperCase(), 'x', '{id}', 'a'.repeat(128)]) {
    assert.equal(table.lookup('PATCH', `/api/v1/customers/${segment}`)?.method, 'PATCH', segment);
  }
  for (const miss of [`/api/v1/customers/${ID}/profile`, '/api/v1/customers', '/api/v1/customers/', `/api/v1/customers/${ID}/`, `/api/v1/customers/${'a'.repeat(129)}`]) {
    assert.equal(table.lookup('PATCH', miss), undefined, miss);
  }
  for (const method of ['patch', 'PUT', 'POST', 'DELETE']) assert.equal(table.lookup(method, `/api/v1/customers/${ID}`), undefined, method);
  assert.equal(table.lookup('GET', `/api/v1/customers/${ID}`)?.method, 'GET', 'the GET detail is its own entry');
});

test('the template and its literal prefix coexist; list() keeps declaration order; literal session and admin routes still match exactly', () => {
  const admin = route({ path: '/admin/v1/tenants', policy: SESSION('admin', { scope: 'platform', permission: 'probe.read' }), trustedContext: 'required' });
  const defs = [list(), detail(), route({}), admin];
  const table = defineRoutes(defs);
  assert.deepEqual(table.list().map((r) => `${r.method} ${r.path}`), ['GET /api/v1/customers', 'GET /api/v1/customers/{id}', 'GET /v1/probe', 'GET /admin/v1/tenants']);
  assert.equal(table.lookup('GET', '/api/v1/customers')?.path, '/api/v1/customers', 'the literal list');
  assert.equal(table.lookup('GET', '/v1/probe')?.path, '/v1/probe');
  assert.equal(table.lookup('GET', '/admin/v1/tenants')?.path, '/admin/v1/tenants');
  for (const miss of ['/admin/v1/tenants/x', `/admin/v1/tenants/${ID}`, '/v1/probe/x', '/api/v1/customers/x/y']) {
    assert.equal(table.lookup('GET', miss), undefined, miss);
  }
});

test('lookup: /api/v1/customers/ plus ONE raw segment of 1-128 characters without \'/\' reaches the template, and nothing else does', () => {
  const table = defineRoutes([list(), detail()]);
  const hit = (path: string): string | undefined => table.lookup('GET', path)?.path;
  // Canonical ids of every version and variant, and every other raw segment the handler judges after authentication.
  for (const segment of [
    ID, '00000000-0000-0000-0000-000000000000', 'ffffffff-ffff-8fff-bfff-ffffffffffff', 'aaaaaaaa-aaaa-1aaa-caaa-aaaaaaaaaaaa',
    ID.toUpperCase(), ID.replace(/-/g, '%2d'), '{id}', '..', '.', 'x', '%2F', 'a'.repeat(128), ID.slice(1), `${ID}0`,
  ]) {
    assert.equal(hit(`/api/v1/customers/${segment}`), '/api/v1/customers/{id}', segment);
  }
  for (const miss of [
    '/api/v1/customers/', `/api/v1/customers/${'a'.repeat(129)}`, `/api/v1/customers/${ID}/`, `/api/v1/customers//${ID}`,
    `/api/v1/customers/${ID}/x`, `/API/v1/customers/${ID}`, `/api/v1/Customers/${ID}`, `/api/v1/customersx/${ID}`, `/api/v1/${ID}`,
  ]) {
    assert.equal(hit(miss), undefined, miss);
  }
  for (const method of ['HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'get']) {
    assert.equal(table.lookup(method, `/api/v1/customers/${ID}`), undefined, method);
  }
  // A table with no template matches literally only.
  assert.equal(defineRoutes([list()]).lookup('GET', `/api/v1/customers/${ID}`), undefined);
});

test('lookup: /api/v1/customers/ plus ONE raw segment plus exactly /profile reaches the profile template, and nothing else does; the literal and the detail still win their own paths', () => {
  const table = defineRoutes([list(), detail(), profile()]);
  const hit = (path: string, method = 'GET'): string | undefined => table.lookup(method, path)?.path;
  for (const segment of [ID, ID.toUpperCase(), '{id}', 'x', '..', '%2F', 'a'.repeat(128), ID.slice(1), 'profile']) {
    assert.equal(hit(`/api/v1/customers/${segment}/profile`), '/api/v1/customers/{id}/profile', segment);
  }
  // The literal list and the detail template are unchanged by the second template.
  assert.equal(hit('/api/v1/customers'), '/api/v1/customers');
  assert.equal(hit(`/api/v1/customers/${ID}`), '/api/v1/customers/{id}');
  assert.equal(hit('/api/v1/customers/profile'), '/api/v1/customers/{id}', 'a bare "profile" segment is the detail template\'s id');
  for (const miss of [
    `/api/v1/customers/${ID}/profile/extra`, '/api/v1/customers//profile', `/api/v1/customers/${ID}/profile/`, `/api/v1/customers/${ID}/Profile`,
    `/api/v1/customers/${ID}/profiles`, `/api/v1/customers/${ID}/contacts`, `/api/v1/customers/${ID}/x`, `/api/v1/customers/${'a'.repeat(129)}/profile`,
    `/api/v1/customers/${ID}/${ID}/profile`, `/api/v1/customers/x/y/profile`, `/api/v1/customers/${ID}//profile`, `/api/v1/customersx/${ID}/profile`,
    `/api/v1/${ID}/profile`, '/api/v1/customers/profile/', `/API/v1/customers/${ID}/profile`,
  ]) {
    assert.equal(hit(miss), undefined, miss);
  }
  for (const method of ['HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'get']) {
    assert.equal(hit(`/api/v1/customers/${ID}/profile`, method), undefined, method);
  }
  // Without the profile template, its path is no route: the detail template never reaches past its one segment.
  assert.equal(defineRoutes([list(), detail()]).lookup('GET', `/api/v1/customers/${ID}/profile`), undefined);
  // Without the detail template, the profile template does not answer a bare id either.
  assert.equal(defineRoutes([list(), profile()]).lookup('GET', `/api/v1/customers/${ID}`), undefined);
});

test('pathIdBeforeSuffixOf: the segment directly before the exact suffix as a canonical lowercase uuid, or null', () => {
  assert.equal(pathIdBeforeSuffixOf(`/api/v1/customers/${ID}/profile`, '/profile'), ID);
  for (const path of [
    `/api/v1/customers/${ID}`, `/api/v1/customers/${ID}/profile/`, `/api/v1/customers/${ID}/profiles`, `/api/v1/customers/${ID.toUpperCase()}/profile`,
    `/api/v1/customers/x${ID}/profile`, `/api/v1/customers/${ID}x/profile`, '/api/v1/customers/{id}/profile', `/${ID}/profile`, '/profile', '',
    `/api/v1/customers/${ID}/Profile`, 42 as unknown as string,
  ]) {
    assert.equal(pathIdBeforeSuffixOf(path, '/profile'), null, String(path));
  }
});

test('pathIdOf: the final segment as a canonical lowercase uuid, or null', () => {
  assert.equal(pathIdOf(`/api/v1/customers/${ID}`), ID);
  assert.equal(pathIdOf(`/x/${ID}`), ID);
  assert.equal(pathIdOf(`/${ID}`), null, 'a prefix is required');
  for (const path of [
    ID, `/api/v1/customers/${ID.toUpperCase()}`, `/api/v1/customers/${ID.slice(1)}`, `/api/v1/customers/x${ID}`,
    `/api/v1/customers/${ID}/`, `/api/v1/customers/${ID}x`, `/api/v1/customers/${ID.replace(/-/g, '')}`, '/api/v1/customers/{id}',
    `/api/v1/customers/${ID.replace('-', '%2d')}`, '', '/', 42 as unknown as string,
  ]) {
    assert.equal(pathIdOf(path), null, String(path));
  }
});

// --- M7B-INVOICES-P1: the closed store templates and the store directory ------------------------------------------------

const STORE_VIEW = { scope: 'store', permission: 'view_invoice_drafts' };
const STORE_CREATE = { scope: 'store', permission: 'create_invoice_drafts' };
const DRAFTS = '/api/v1/stores/{storeId}/invoice-drafts';
const DRAFT = '/api/v1/stores/{storeId}/invoice-drafts/{id}';
const ELIGIBILITY = '/api/v1/stores/{storeId}/invoice-drafts/eligibility';
const STORE_EDIT = { scope: 'store', permission: 'edit_invoice_drafts' };
const EDIT_ELIGIBILITY = '/api/v1/stores/{storeId}/invoice-drafts/{id}/edit-eligibility';
const STORE_DISCARD = { scope: 'store', permission: 'discard_invoice_drafts' };
const DISCARD = '/api/v1/stores/{storeId}/invoice-drafts/{id}/discard';
const DISCARD_ELIGIBILITY = '/api/v1/stores/{storeId}/invoice-drafts/{id}/discard-eligibility';
const storeRead = (over: Record<string, unknown> = {}): Record<string, unknown> =>
  route({ path: DRAFTS, policy: SESSION('tenant', STORE_VIEW), trustedContext: 'required', sessionBinding: 'required', ...over });
const storeCreate = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  method: 'POST', path: DRAFTS, policy: SESSION('tenant', STORE_CREATE), body: { kind: 'json', maxBytes: 65_536, required: true },
  idempotency: 'required', trustedContext: 'required', recentAuth: 'none', command: { contract: {}, plan: () => ({}) }, ...over,
});
const directory = (over: Record<string, unknown> = {}): Record<string, unknown> =>
  route({ path: '/api/v1/stores', policy: BARE_SESSION('tenant'), sessionBinding: 'required', ...over });
const STORE = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

test('M7B: exactly the eight store templates register — the five GETs without idempotency, the POST, the PATCH and the discard POST as idempotency-required commands, each a tenant-session store-scope route', () => {
  // M7B-INVOICES-P1-R2: the fourth, the drafts' creation eligibility, a GET under the save's own requirement. M7B-INVOICES-P2:
  // the edit, a PATCH command on the draft template, and its eligibility, a GET with {id} before one literal segment.
  // M7B-INVOICES-DISCARD-P1: the discard, a POST command with {id} before one literal segment, and its eligibility, a GET.
  const all = [storeRead(), storeRead({ path: DRAFT }), storeRead({ path: ELIGIBILITY, policy: SESSION('tenant', STORE_CREATE) }), storeCreate(),
    storeCreate({ method: 'PATCH', path: DRAFT, policy: SESSION('tenant', STORE_EDIT) }), storeRead({ path: EDIT_ELIGIBILITY, policy: SESSION('tenant', STORE_EDIT) }),
    storeRead({ path: DISCARD_ELIGIBILITY, policy: SESSION('tenant', STORE_DISCARD) }), storeCreate({ path: DISCARD, policy: SESSION('tenant', STORE_DISCARD) })];
  assert.equal(setupCode(all), undefined);
  assert.equal(setupCode([...all, directory(), list(), detail(), profile(), patch()]), undefined, 'beside the store directory and the customer templates');
  const table = defineRoutes(all);
  assert.deepEqual(table.list().map((r) => `${r.method} ${r.path}`),
    [`GET ${DRAFTS}`, `GET ${DRAFT}`, `GET ${ELIGIBILITY}`, `POST ${DRAFTS}`, `PATCH ${DRAFT}`, `GET ${EDIT_ELIGIBILITY}`, `GET ${DISCARD_ELIGIBILITY}`, `POST ${DISCARD}`]);
  assert.equal(table.lookup('POST', `/api/v1/stores/${STORE}/invoice-drafts`)?.idempotency, 'required');
  assert.equal(table.lookup('PATCH', `/api/v1/stores/${STORE}/invoice-drafts/${ID}`)?.idempotency, 'required');
  assert.equal(table.lookup('POST', `/api/v1/stores/${STORE}/invoice-drafts/${ID}/discard`)?.idempotency, 'required');
  const { command: _command, ...noCommand } = storeCreate();
  for (const [label, def] of [
    ['another store suffix', storeRead({ path: '/api/v1/stores/{storeId}/receipts' })],
    ['a bare store template', storeRead({ path: '/api/v1/stores/{storeId}' })],
    ['a store segment elsewhere', storeRead({ path: '/api/v1/customers/{storeId}/invoice-drafts' })],
    ['a deeper store template', storeRead({ path: `${DRAFT}/lines` })],
    ['a deeper eligibility template', storeRead({ path: `${ELIGIBILITY}/x` })],
    ['another literal word after the drafts', storeRead({ path: `${DRAFTS}/eligible` })],
    ['the eligibility word as a POST', storeCreate({ path: ELIGIBILITY })],
    ['the eligibility under a key', storeCreate({ method: 'GET', path: ELIGIBILITY, body: { kind: 'none' } })],
    ['two store segments', storeRead({ path: '/api/v1/stores/{storeId}/{storeId}' })],
    ['a PATCH on the list template', storeCreate({ method: 'PATCH' })],
    ['a PATCH on the eligibility template', storeCreate({ method: 'PATCH', path: ELIGIBILITY })],
    ['a PATCH on the edit-eligibility template', storeCreate({ method: 'PATCH', path: EDIT_ELIGIBILITY })],
    ['a POST command on the draft template', storeCreate({ path: DRAFT })],
    ['the PATCH without idempotency, as a handler', storeRead({ method: 'PATCH', path: DRAFT, body: { kind: 'json', maxBytes: 65_536, required: true }, sessionBinding: 'none' })],
    ['the edit eligibility under a key', storeCreate({ method: 'GET', path: EDIT_ELIGIBILITY, body: { kind: 'none' } })],
    ['a deeper edit-eligibility template', storeRead({ path: `${EDIT_ELIGIBILITY}/x` })],
    ['another word after the draft id', storeRead({ path: `${DRAFT}/eligibility` })],
    ['the edit-eligibility word without the draft id', storeRead({ path: `${DRAFTS}/edit-eligibility` })],
    // M7B-INVOICES-DISCARD-P1: the discard is a POST command under a key, its eligibility a keyless GET — nothing else.
    ['the discard as a GET read', storeRead({ path: DISCARD, policy: SESSION('tenant', STORE_DISCARD) })],
    ['the discard POST without idempotency, as a handler', storeRead({ method: 'POST', path: DISCARD, policy: SESSION('tenant', STORE_DISCARD), body: { kind: 'json', maxBytes: 1_024, required: true }, sessionBinding: 'none' })],
    ['the discard as a PATCH command', storeCreate({ method: 'PATCH', path: DISCARD, policy: SESSION('tenant', STORE_DISCARD) })],
    ['the discard as a DELETE', storeRead({ method: 'DELETE', path: DISCARD, policy: SESSION('tenant', STORE_DISCARD) })],
    ['the discard eligibility under a key', storeCreate({ method: 'GET', path: DISCARD_ELIGIBILITY, body: { kind: 'none' }, policy: SESSION('tenant', STORE_DISCARD) })],
    ['a POST command on the discard eligibility', storeCreate({ path: DISCARD_ELIGIBILITY, policy: SESSION('tenant', STORE_DISCARD) })],
    ['a deeper discard template', storeCreate({ path: `${DISCARD}/x`, policy: SESSION('tenant', STORE_DISCARD) })],
    ['the discard word without the draft id', storeCreate({ path: `${DRAFTS}/discard`, policy: SESSION('tenant', STORE_DISCARD) })],
    ['another suffix as a command', storeCreate({ path: `${DRAFT}/archive`, policy: SESSION('tenant', STORE_DISCARD) })],
    ['a PUT on the list template', storeCreate({ method: 'PUT' })],
    ['a DELETE on the draft template', storeRead({ method: 'DELETE', path: DRAFT })],
    ['the POST without idempotency, as a handler', { ...noCommand, idempotency: 'none', trustedContext: 'required', handler }],
    ['the GET list as a command', storeCreate({ method: 'GET', body: { kind: 'none' } })],
    ['a literal store below the prefix', storeRead({ path: `/api/v1/stores/${STORE}/invoice-drafts` })],
    ['a literal word below the prefix', route({ path: '/api/v1/stores/mine', policy: SESSION('tenant', STORE_VIEW), trustedContext: 'required' })],
    // The {storeId} selects among store grants only: a tenant-scope or platform requirement on a store template is refused.
    ['a tenant-scope requirement', storeRead({ policy: SESSION('tenant', { scope: 'tenant', permission: 'view_customers' }) })],
    ['a platform-scope requirement', storeRead({ policy: SESSION('tenant', { scope: 'platform', permission: 'probe.read' }) })],
    ['no requirement', storeRead({ policy: BARE_SESSION('tenant'), trustedContext: 'none', sessionBinding: 'none' })],
  ] as const) {
    assert.notEqual(setupCode([def]), undefined, label);
  }
  for (const [label, def] of [
    ['another store suffix', storeRead({ path: '/api/v1/stores/{storeId}/receipts' })],
    ['a literal store below the prefix', storeRead({ path: `/api/v1/stores/${STORE}/invoice-drafts` })],
    ['a tenant-scope requirement', storeRead({ policy: SESSION('tenant', { scope: 'tenant', permission: 'view_customers' }) })],
    ['a PUT command on the list template', storeCreate({ method: 'PUT' })],
    ['a POST handler on the draft template', storeRead({ path: DRAFT, policy: SESSION('tenant', STORE_CREATE), method: 'POST', sessionBinding: 'none' })],
  ] as const) {
    assert.equal(setupCode([def]), 'route_path_invalid', label);
  }
  // A GET can never take a key at all, whatever the template: the idempotency rule answers first.
  assert.equal(setupCode([storeCreate({ method: 'GET', path: DRAFT, body: { kind: 'none' } })]), 'route_idempotency_policy_invalid', 'the GET draft template as a command');
  assert.equal(setupCode([storeCreate(), storeCreate()]), 'route_duplicate');
  // The store POST and PATCH are the only store-scoped routes that may require idempotency.
  assert.equal(setupCode([storeCreate({ path: '/api/v1/probe' })]), 'route_idempotency_policy_invalid', 'a store command on a literal path');
  assert.equal(setupCode([storeCreate({ method: 'PATCH', path: EDIT_ELIGIBILITY })]), 'route_path_invalid', 'a PATCH command on the edit eligibility');
  assert.equal(setupCode([storeCreate({ path: DISCARD_ELIGIBILITY, policy: SESSION('tenant', STORE_DISCARD) })]), 'route_path_invalid',
    'a POST on the discard eligibility is no declared template');
  assert.equal(setupCode([storeCreate({ path: DISCARD, policy: SESSION('tenant', STORE_DISCARD) }), storeCreate({ path: DISCARD, policy: SESSION('tenant', STORE_DISCARD) })]), 'route_duplicate');
});

test('M7B-INVOICES-DISCARD-P1 DSC-23 AC-04: lookup — the discard POST and its eligibility GET each reach their template by the segment before their one literal last segment; another method, suffix or depth reaches nothing; the edit\'s templates are unchanged beside them', () => {
  const table = defineRoutes([storeRead(), storeRead({ path: DRAFT }), storeRead({ path: ELIGIBILITY, policy: SESSION('tenant', STORE_CREATE) }), storeCreate(),
    storeCreate({ method: 'PATCH', path: DRAFT, policy: SESSION('tenant', STORE_EDIT) }), storeRead({ path: EDIT_ELIGIBILITY, policy: SESSION('tenant', STORE_EDIT) }),
    storeRead({ path: DISCARD_ELIGIBILITY, policy: SESSION('tenant', STORE_DISCARD) }), storeCreate({ path: DISCARD, policy: SESSION('tenant', STORE_DISCARD) }),
    list(), detail(), profile(), patch()]);
  const hit = (path: string, method = 'GET'): string | undefined => table.lookup(method, path)?.path;
  // Any one id segment reaches the template: the chain judges it (the 400) after authorization, never the table.
  for (const segment of [ID, ID.toUpperCase(), '{id}', 'x', '..', '%2F', 'a'.repeat(128), 'eligibility', 'discard', 'discard-eligibility', 'edit-eligibility']) {
    assert.equal(hit(`/api/v1/stores/${STORE}/invoice-drafts/${segment}/discard`, 'POST'), DISCARD, `discard ${segment}`);
    assert.equal(hit(`/api/v1/stores/${STORE}/invoice-drafts/${segment}/discard-eligibility`), DISCARD_ELIGIBILITY, `discard eligibility ${segment}`);
  }
  assert.deepEqual(table.lookup('POST', `/api/v1/stores/${STORE}/invoice-drafts/${ID}/discard`)?.policy, SESSION('tenant', STORE_DISCARD));
  assert.deepEqual(table.lookup('GET', `/api/v1/stores/${STORE}/invoice-drafts/${ID}/discard-eligibility`)?.policy, SESSION('tenant', STORE_DISCARD));
  // The edit's templates and the literal creation eligibility are unchanged; a draft named 'discard' is the draft template's.
  assert.equal(hit(`/api/v1/stores/${STORE}/invoice-drafts/${ID}/edit-eligibility`), EDIT_ELIGIBILITY);
  assert.equal(hit(`/api/v1/stores/${STORE}/invoice-drafts/${ID}`, 'PATCH'), DRAFT);
  assert.equal(hit(`/api/v1/stores/${STORE}/invoice-drafts/discard`), DRAFT, 'a GET of a draft named discard');
  assert.equal(hit(`/api/v1/stores/${STORE}/invoice-drafts/discard-eligibility`), DRAFT, 'a GET of a draft named discard-eligibility');
  assert.equal(hit(`/api/v1/stores/${STORE}/invoice-drafts/eligibility`), ELIGIBILITY);
  for (const [method, miss] of [
    ['GET', `/api/v1/stores/${STORE}/invoice-drafts/${ID}/discard`], ['PATCH', `/api/v1/stores/${STORE}/invoice-drafts/${ID}/discard`],
    ['PUT', `/api/v1/stores/${STORE}/invoice-drafts/${ID}/discard`], ['DELETE', `/api/v1/stores/${STORE}/invoice-drafts/${ID}/discard`],
    ['post', `/api/v1/stores/${STORE}/invoice-drafts/${ID}/discard`], ['POST', `/api/v1/stores/${STORE}/invoice-drafts/${ID}/discard-eligibility`],
    ['POST', `/api/v1/stores/${STORE}/invoice-drafts/${ID}/edit-eligibility`], ['POST', `/api/v1/stores/${STORE}/invoice-drafts/${ID}`],
    ['POST', `/api/v1/stores/${STORE}/invoice-drafts/${ID}/discard/`], ['POST', `/api/v1/stores/${STORE}/invoice-drafts/${ID}/discard/x`],
    ['POST', `/api/v1/stores/${STORE}/invoice-drafts/${ID}/Discard`], ['POST', `/api/v1/stores/${STORE}/invoice-drafts/${ID}/discards`],
    ['POST', `/api/v1/stores/${STORE}/invoice-drafts/${ID}/${ID}/discard`], ['POST', `/api/v1/stores/${STORE}/invoice-drafts//discard`],
    ['POST', `/api/v1/stores/${STORE}/invoice-drafts/discard`], ['POST', `/api/v1/stores/${STORE}/discard`], ['POST', `/api/v1/stores/${STORE}/${ID}/discard`],
    ['POST', `/api/v1/stores/${STORE}/invoice-drafts/${'a'.repeat(129)}/discard`],
    ['GET', `/api/v1/stores/${STORE}/invoice-drafts/${ID}/discard-eligibility/`], ['GET', `/api/v1/stores/${STORE}/invoice-drafts/${ID}/discard-eligibility/x`],
    ['GET', `/api/v1/stores/${STORE}/invoice-drafts/${ID}/Discard-eligibility`],
  ] as const) {
    assert.equal(hit(miss, method), undefined, `${method} ${miss}`);
  }
  // Without the discard templates the same paths are no route: the middle {id} matches only a registered template.
  const before = defineRoutes([storeRead({ path: DRAFT }), storeCreate({ method: 'PATCH', path: DRAFT, policy: SESSION('tenant', STORE_EDIT) })]);
  assert.equal(before.lookup('POST', `/api/v1/stores/${STORE}/invoice-drafts/${ID}/discard`), undefined);
  assert.equal(before.lookup('GET', `/api/v1/stores/${STORE}/invoice-drafts/${ID}/discard-eligibility`), undefined);
});

test('M7B-INVOICES-P2: lookup — the PATCH reaches the draft template by its last segment, the edit eligibility by the segment before its one literal last segment; nothing else does', () => {
  const table = defineRoutes([storeRead(), storeRead({ path: DRAFT }), storeRead({ path: ELIGIBILITY, policy: SESSION('tenant', STORE_CREATE) }), storeCreate(),
    storeCreate({ method: 'PATCH', path: DRAFT, policy: SESSION('tenant', STORE_EDIT) }), storeRead({ path: EDIT_ELIGIBILITY, policy: SESSION('tenant', STORE_EDIT) }),
    list(), detail(), profile(), patch()]);
  const hit = (path: string, method = 'GET'): string | undefined => table.lookup(method, path)?.path;
  for (const segment of [ID, ID.toUpperCase(), '{id}', 'x', '..', '%2F', 'a'.repeat(128), 'eligibility', 'edit-eligibility']) {
    assert.equal(hit(`/api/v1/stores/${STORE}/invoice-drafts/${segment}/edit-eligibility`), EDIT_ELIGIBILITY, `edit eligibility ${segment}`);
  }
  for (const segment of [ID, ID.toUpperCase(), '{id}', 'x', '..', 'a'.repeat(128), 'eligibility', 'edit-eligibility']) {
    assert.equal(hit(`/api/v1/stores/${STORE}/invoice-drafts/${segment}`, 'PATCH'), DRAFT, `PATCH ${segment}`);
  }
  // The literal creation eligibility still wins its own path (a GET); a PATCH there is the draft template's, whose malformed id
  // the chain refuses (the 400); a draft named 'edit-eligibility' is the draft template's.
  assert.equal(hit(`/api/v1/stores/${STORE}/invoice-drafts/eligibility`), ELIGIBILITY);
  assert.equal(hit(`/api/v1/stores/${STORE}/invoice-drafts/edit-eligibility`), DRAFT);
  assert.deepEqual(table.lookup('GET', `/api/v1/stores/${STORE}/invoice-drafts/${ID}/edit-eligibility`)?.policy, SESSION('tenant', STORE_EDIT));
  assert.deepEqual(table.lookup('PATCH', `/api/v1/stores/${STORE}/invoice-drafts/${ID}`)?.policy, SESSION('tenant', STORE_EDIT));
  for (const [method, miss] of [
    ['PATCH', `/api/v1/stores/${STORE}/invoice-drafts/${ID}/edit-eligibility`], ['POST', `/api/v1/stores/${STORE}/invoice-drafts/${ID}/edit-eligibility`],
    ['PATCH', `/api/v1/stores/${STORE}/invoice-drafts`], ['PUT', `/api/v1/stores/${STORE}/invoice-drafts/${ID}`],
    ['DELETE', `/api/v1/stores/${STORE}/invoice-drafts/${ID}`], ['patch', `/api/v1/stores/${STORE}/invoice-drafts/${ID}`],
    ['GET', `/api/v1/stores/${STORE}/invoice-drafts/${ID}/edit-eligibility/`], ['GET', `/api/v1/stores/${STORE}/invoice-drafts/${ID}/edit-eligibility/x`],
    ['GET', `/api/v1/stores/${STORE}/invoice-drafts/${ID}/Edit-eligibility`], ['GET', `/api/v1/stores/${STORE}/invoice-drafts/${ID}/eligibility`],
    ['GET', `/api/v1/stores/${STORE}/invoice-drafts/${ID}/x`], ['GET', `/api/v1/stores/${STORE}/invoice-drafts//edit-eligibility`],
    ['GET', `/api/v1/stores/${STORE}/invoice-drafts/${'a'.repeat(129)}/edit-eligibility`], ['GET', `/api/v1/stores/${STORE}/${ID}/edit-eligibility`],
    ['GET', `/api/v1/stores/${STORE}/invoice-drafts/${ID}/${ID}/edit-eligibility`], ['GET', `/api/v1/stores/${STORE}/edit-eligibility`],
    ['PATCH', `/api/v1/stores/${STORE}/invoice-drafts/${ID}/`], ['PATCH', `/api/v1/stores/${STORE}/invoice-drafts//${ID}`],
  ] as const) {
    assert.equal(hit(miss, method), undefined, `${method} ${miss}`);
  }
  // The customer templates are unchanged beside them.
  assert.equal(hit(`/api/v1/customers/${ID}`, 'PATCH'), '/api/v1/customers/{id}');
  assert.equal(hit(`/api/v1/customers/${ID}/profile`), '/api/v1/customers/{id}/profile');
  // Without the edit-eligibility template the same path is no route: the middle {id} matches only a registered template.
  assert.equal(defineRoutes([storeRead({ path: DRAFT })]).lookup('GET', `/api/v1/stores/${STORE}/invoice-drafts/${ID}/edit-eligibility`), undefined);
});

test('M7B: a STORE-scope requirement registers on the four store templates and nowhere else — no store is ever selected without a path naming it', () => {
  const UNDECIDED = { scope: 'store', permission: 'view_shipping_costs' };
  for (const [label, def] of [
    ['a literal tenant-session read', route({ path: '/api/v1/probe', policy: SESSION('tenant', STORE_VIEW), trustedContext: 'required' })],
    ['the same read, session-bound', route({ path: '/api/v1/probe', policy: SESSION('tenant', STORE_VIEW), trustedContext: 'required', sessionBinding: 'required' })],
    ['the create key on a literal read', route({ path: '/api/v1/probe', policy: SESSION('tenant', STORE_CREATE), trustedContext: 'required' })],
    ['an undecidable store key on a literal read (the old harness witness shape)', route({ path: '/api/v1/probe', policy: SESSION('tenant', UNDECIDED), trustedContext: 'required' })],
    ['a literal read without a trusted context', route({ path: '/api/v1/probe', policy: SESSION('tenant', STORE_VIEW) })],
    ['a Bearer read', route({ policy: { access: 'authenticated', authorization: STORE_VIEW } })],
    ['a customer template', detail({ policy: SESSION('tenant', STORE_VIEW) })],
    ['the directory path', route({ path: '/api/v1/stores', policy: SESSION('tenant', STORE_VIEW), trustedContext: 'required', sessionBinding: 'required' })],
    ['the admin boundary', route({ path: '/admin/v1/probe', policy: SESSION('admin', STORE_VIEW), trustedContext: 'required' })],
  ] as const) {
    assert.equal(setupCode([def]), 'route_path_invalid', label);
  }
  // Controls: each shape registers at tenant scope, and the store template at store scope, so the refusals are the scope's.
  for (const [label, def] of [
    ['a literal tenant-session read', route({ path: '/api/v1/probe', policy: SESSION('tenant'), trustedContext: 'required' })],
    ['a Bearer read', route({ policy: { access: 'authenticated', authorization: { scope: 'tenant', permission: 'probe.read' } } })],
    ['a customer template', detail()],
    ['the admin boundary', route({ path: '/admin/v1/probe', policy: SESSION('admin'), trustedContext: 'required' })],
    ['the store template', storeRead()],
    ['the store template under an undecidable store key', storeRead({ policy: SESSION('tenant', UNDECIDED) })],
  ] as const) {
    assert.equal(setupCode([def]), undefined, label);
  }
  // A literal store command is still refused by the idempotency rule first (the closed store POST template alone may take a key).
  assert.equal(setupCode([storeCreate({ path: '/api/v1/probe' })]), 'route_idempotency_policy_invalid');
});

test('M7B: lookup — /api/v1/stores/ plus ONE store segment plus exactly the template rest reaches a store template; nothing else does', () => {
  const table = defineRoutes([directory(), storeRead(), storeRead({ path: DRAFT }), storeRead({ path: ELIGIBILITY, policy: SESSION('tenant', STORE_CREATE) }),
    storeCreate(), list(), detail()]);
  const hit = (path: string, method = 'GET'): string | undefined => table.lookup(method, path)?.path;
  for (const segment of [STORE, STORE.toUpperCase(), '{storeId}', 'x', '..', '%2F', 'a'.repeat(128), 'eligibility']) {
    assert.equal(hit(`/api/v1/stores/${segment}/invoice-drafts`), DRAFTS, segment);
    assert.equal(hit(`/api/v1/stores/${segment}/invoice-drafts`, 'POST'), DRAFTS, `POST ${segment}`);
    assert.equal(hit(`/api/v1/stores/${segment}/invoice-drafts/${ID}`), DRAFT, `${segment} + draft`);
    assert.equal(hit(`/api/v1/stores/${segment}/invoice-drafts/eligibility`), ELIGIBILITY, `${segment} + eligibility`);
  }
  // M7B-INVOICES-P1-R2: the literal 'eligibility' is the eligibility template, never a draft id; every other non-uuid segment
  // (a near spelling included) is still the draft template's, whose handler refuses it as a malformed id (the 400).
  for (const segment of [STORE, STORE.toUpperCase(), '{storeId}', '{id}', 'x', '..', '%2F', 'a'.repeat(128), 'Eligibility', 'eligibility2', 'eligible',
    'eligibility%2F', ' eligibility']) {
    assert.equal(hit(`/api/v1/stores/${STORE}/invoice-drafts/${segment}`), DRAFT, `draft ${segment}`);
  }
  assert.deepEqual(table.lookup('GET', `/api/v1/stores/${STORE}/invoice-drafts/eligibility`)?.policy, SESSION('tenant', STORE_CREATE),
    'the eligibility path resolves to the create requirement\'s route, not the view requirement\'s draft read');
  assert.equal(hit(`/api/v1/stores/${STORE}/invoice-drafts/eligibility`, 'POST'), undefined, 'POST names no eligibility');
  for (const miss of [`/api/v1/stores/${STORE}/invoice-drafts/eligibility/`, `/api/v1/stores/${STORE}/invoice-drafts/eligibility/x`,
    `/api/v1/stores/${STORE}/eligibility`]) {
    assert.equal(hit(miss), undefined, miss);
  }
  // Without the eligibility template (the table before -R2) the same path was the draft template's: the literal wins only
  // because it is registered.
  assert.equal(defineRoutes([storeRead({ path: DRAFT })]).lookup('GET', `/api/v1/stores/${STORE}/invoice-drafts/eligibility`)?.path, DRAFT);
  assert.equal(hit('/api/v1/stores'), '/api/v1/stores', 'the literal directory');
  assert.equal(hit(`/api/v1/customers/${ID}`), '/api/v1/customers/{id}', 'the customer template is unchanged');
  for (const miss of [
    '/api/v1/stores/', `/api/v1/stores/${STORE}`, `/api/v1/stores/${STORE}/`, `/api/v1/stores//invoice-drafts`, `/api/v1/stores/${STORE}/invoice-drafts/`,
    `/api/v1/stores/${STORE}/invoice-drafts/${ID}/`, `/api/v1/stores/${STORE}/invoice-drafts/${ID}/lines`, `/api/v1/stores/${STORE}/invoices`,
    `/api/v1/stores/${STORE}/Invoice-drafts`, `/api/v1/stores/${'a'.repeat(129)}/invoice-drafts`, `/api/v1/stores/${STORE}/invoice-drafts/${'a'.repeat(129)}`,
    `/api/v1/stores/${STORE}/x/invoice-drafts`, `/api/v1/storesx/${STORE}/invoice-drafts`, `/API/v1/stores/${STORE}/invoice-drafts`,
    `/api/v1/stores/${STORE}//invoice-drafts`, `/api/v1/stores/${STORE}/invoice-drafts//${ID}`,
  ]) {
    assert.equal(hit(miss), undefined, miss);
  }
  for (const method of ['HEAD', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'get']) {
    assert.equal(hit(`/api/v1/stores/${STORE}/invoice-drafts`, method), undefined, method);
  }
  assert.equal(hit(`/api/v1/stores/${STORE}/invoice-drafts/${ID}`, 'POST'), undefined, 'POST names no draft');
  // A table without store templates matches none of their paths.
  assert.equal(defineRoutes([directory(), list(), detail()]).lookup('GET', `/api/v1/stores/${STORE}/invoice-drafts`), undefined);
});

test('M7B: storeTargetOf — the store segment as a canonical lowercase uuid, or null', () => {
  assert.equal(storeTargetOf(`/api/v1/stores/${STORE}/invoice-drafts`), STORE);
  assert.equal(storeTargetOf(`/api/v1/stores/${STORE}/invoice-drafts/${ID}`), STORE);
  for (const path of [
    `/api/v1/stores/${STORE.toUpperCase()}/invoice-drafts`, `/api/v1/stores/${STORE.slice(1)}/invoice-drafts`, `/api/v1/stores/x${STORE}/invoice-drafts`,
    `/api/v1/stores/${STORE}x/invoice-drafts`, `/api/v1/stores/${STORE}`, '/api/v1/stores/{storeId}/invoice-drafts', `/api/v1/stores/${STORE.replace(/-/g, '')}/invoice-drafts`,
    `/api/v1/stores/${STORE.replace('-', '%2d')}/invoice-drafts`, `/api/v1/customers/${STORE}/invoice-drafts`, '/api/v1/stores', '', 42 as unknown as string,
  ]) {
    assert.equal(storeTargetOf(path), null, String(path));
  }
});

test('M7B: GET /api/v1/stores is the ONE closed authorization-free business route — session-bound, no trusted context, no body, no idempotency — and no other path may take that shape', () => {
  assert.equal(setupCode([directory()]), undefined);
  const registered = defineRoutes([directory()]).lookup('GET', '/api/v1/stores');
  assert.deepEqual([registered?.policy, registered?.sessionBinding, registered?.trustedContext, registered?.recentAuth, registered?.idempotency],
    [{ access: 'session', audience: 'tenant', authorization: null }, 'required', 'none', 'none', 'none']);
  for (const [label, def, code] of [
    ['the directory without the session binding', directory({ sessionBinding: 'none' }), 'route_session_binding_invalid'],
    ['the directory with the binding undeclared', directory({ sessionBinding: undefined }), 'route_session_binding_invalid'],
    ['the directory with a trusted context', directory({ trustedContext: 'required' }), 'route_trusted_context_invalid'],
    ['the directory requiring a recent sign-in', directory({ recentAuth: 'required' }), 'route_recent_auth_invalid'],
    ['the directory with a body', directory({ body: JSON_BODY }), 'route_body_policy_invalid'],
    ['the directory under a key', required({ method: 'GET', path: '/api/v1/stores', policy: BARE_SESSION('tenant'), trustedContext: 'none', sessionBinding: 'required' }), 'route_idempotency_policy_invalid'],
    ['POST at the directory path', directory({ method: 'POST' }), 'route_session_endpoint_invalid'],
    ['another tenant path', directory({ path: '/api/v1/storefronts' }), 'route_session_endpoint_invalid'],
    ['the admin boundary', directory({ path: '/admin/v1/stores', policy: BARE_SESSION('admin') }), 'route_session_endpoint_invalid'],
    ['the customer list without an authorization', directory({ path: '/api/v1/customers' }), 'route_session_endpoint_invalid'],
    ['the current-session endpoint with the binding', route({ path: '/api/v1/session', policy: BARE_SESSION('tenant'), sessionBinding: 'required' }), 'route_session_binding_invalid'],
    ['the logout endpoint with the binding', route({ method: 'POST', path: '/api/v1/session/logout', policy: BARE_SESSION('tenant'), sessionBinding: 'required' }), 'route_session_binding_invalid'],
  ] as const) {
    assert.equal(setupCode([def]), code, label);
  }
  // The directory path may still carry an ordinary authorized read shape; only the authorization-free shape is its own.
  assert.equal(setupCode([route({ path: '/api/v1/stores', policy: SESSION('tenant'), trustedContext: 'required', sessionBinding: 'required' })]), undefined);
  assert.equal(setupCode([directory(), directory()]), 'route_duplicate');
});

// --- M7B-INVOICES-ISSUE-P1: the issue's store templates, the issued invoices, and the tenant issuing-settings templates ------

const STORE_ISSUE = { scope: 'store', permission: 'issue_invoices' };
const STORE_VIEW_ISSUED = { scope: 'store', permission: 'view_issued_invoices' };
const SETTINGS_KEY = { scope: 'tenant', permission: 'edit_issuing_settings' };
const ISSUE = '/api/v1/stores/{storeId}/invoice-drafts/{id}/issue';
const ISSUE_ELIGIBILITY = '/api/v1/stores/{storeId}/invoice-drafts/{id}/issue-eligibility';
const ISSUE_PREVIEW = '/api/v1/stores/{storeId}/invoice-drafts/{id}/issue-preview';
const INVOICES = '/api/v1/stores/{storeId}/invoices';
const INVOICE = '/api/v1/stores/{storeId}/invoices/{id}';
const SETTINGS = '/api/v1/issuing-settings/{id}';
const issueRoutes = () => [
  storeCreate({ path: ISSUE, policy: SESSION('tenant', STORE_ISSUE), body: { kind: 'json', maxBytes: 1_024, required: true } }),
  storeRead({ path: ISSUE_ELIGIBILITY, policy: SESSION('tenant', STORE_ISSUE) }), storeRead({ path: ISSUE_PREVIEW, policy: SESSION('tenant', STORE_ISSUE) }),
  storeRead({ path: INVOICES, policy: SESSION('tenant', STORE_VIEW_ISSUED) }), storeRead({ path: INVOICE, policy: SESSION('tenant', STORE_VIEW_ISSUED) }),
];
const settingsRead = (over: Record<string, unknown> = {}): Record<string, unknown> => detail({ path: SETTINGS, policy: SESSION('tenant', SETTINGS_KEY), ...over });
const settingsWrite = (over: Record<string, unknown> = {}): Record<string, unknown> =>
  patch({ method: 'PUT', path: SETTINGS, policy: SESSION('tenant', SETTINGS_KEY), recentAuth: 'required', ...over });
const draftRoutes = () => [storeRead(), storeRead({ path: DRAFT }), storeRead({ path: ELIGIBILITY, policy: SESSION('tenant', STORE_CREATE) }), storeCreate(),
  storeCreate({ method: 'PATCH', path: DRAFT, policy: SESSION('tenant', STORE_EDIT) }), storeRead({ path: EDIT_ELIGIBILITY, policy: SESSION('tenant', STORE_EDIT) }),
  storeRead({ path: DISCARD_ELIGIBILITY, policy: SESSION('tenant', STORE_DISCARD) }), storeCreate({ path: DISCARD, policy: SESSION('tenant', STORE_DISCARD) })];

test('M7B-INVOICES-ISSUE-P1: the five new store templates and the two issuing-settings templates register — the issue POST and the settings PUT as idempotency-required commands, every GET without a key; every other shape stays refused', () => {
  const all = [...draftRoutes(), ...issueRoutes(), list(), detail(), profile(), patch(), settingsRead(), settingsWrite(), directory()];
  assert.equal(setupCode(all), undefined, 'thirteen store templates, five tenant templates and the store directory together');
  const table = defineRoutes(all);
  assert.equal(table.lookup('POST', `/api/v1/stores/${STORE}/invoice-drafts/${ID}/issue`)?.idempotency, 'required');
  assert.ok('command' in (table.lookup('POST', `/api/v1/stores/${STORE}/invoice-drafts/${ID}/issue`) as object), 'the issue is a command');
  const put = table.lookup('PUT', `/api/v1/issuing-settings/${ID}`);
  assert.ok(put !== undefined && 'command' in put && put.idempotency === 'required' && put.recentAuth === 'required', 'the settings PUT: a keyed command with a recent sign-in');
  assert.equal(table.lookup('GET', `/api/v1/issuing-settings/${ID}`)?.recentAuth, 'none', 'the settings GET: no recent sign-in');
  const { command: _command, ...noCommand } = settingsWrite();
  for (const [label, def] of [
    ['the issue as a GET read', storeRead({ path: ISSUE, policy: SESSION('tenant', STORE_ISSUE) })],
    ['the issue as a PATCH command', storeCreate({ method: 'PATCH', path: ISSUE, policy: SESSION('tenant', STORE_ISSUE) })],
    ['the issue POST without idempotency, as a handler', storeRead({ method: 'POST', path: ISSUE, policy: SESSION('tenant', STORE_ISSUE), body: { kind: 'json', maxBytes: 1_024, required: true }, sessionBinding: 'none' })],
    ['the issue eligibility under a key', storeCreate({ method: 'GET', path: ISSUE_ELIGIBILITY, body: { kind: 'none' }, policy: SESSION('tenant', STORE_ISSUE) })],
    ['a POST command on the issue eligibility', storeCreate({ path: ISSUE_ELIGIBILITY, policy: SESSION('tenant', STORE_ISSUE) })],
    ['a POST command on the issue preview', storeCreate({ path: ISSUE_PREVIEW, policy: SESSION('tenant', STORE_ISSUE) })],
    ['a POST command on the invoices list', storeCreate({ path: INVOICES, policy: SESSION('tenant', STORE_VIEW_ISSUED) })],
    ['a PATCH command on an issued invoice', storeCreate({ method: 'PATCH', path: INVOICE, policy: SESSION('tenant', STORE_VIEW_ISSUED) })],
    ['a DELETE on an issued invoice', storeRead({ method: 'DELETE', path: INVOICE, policy: SESSION('tenant', STORE_VIEW_ISSUED) })],
    ['a deeper issued invoice template', storeRead({ path: `${INVOICE}/lines`, policy: SESSION('tenant', STORE_VIEW_ISSUED) })],
    ['the issue word without the draft id', storeCreate({ path: `${DRAFTS}/issue`, policy: SESSION('tenant', STORE_ISSUE) })],
    ['a deeper issue template', storeCreate({ path: `${ISSUE}/x`, policy: SESSION('tenant', STORE_ISSUE) })],
    ['the issued invoices under a tenant-scope requirement', storeRead({ path: INVOICES, policy: SESSION('tenant', SETTINGS_KEY) })],
    ['the settings PUT without idempotency, as a handler', { ...noCommand, idempotency: 'none', handler }],
    ['the settings PUT as a perform', { ...noCommand, perform: outcome }],
    ['the settings GET under a key', required({ method: 'GET', path: SETTINGS, policy: SESSION('tenant', SETTINGS_KEY), trustedContext: 'required' })],
    ...(['POST', 'PATCH', 'DELETE'] as const).map((method) => [`${method} as a command on the settings template`, settingsWrite({ method })] as const),
    ['a settings suffix', settingsRead({ path: `${SETTINGS}/history` })],
    ['a literal store below the settings prefix', settingsRead({ path: `/api/v1/issuing-settings/${ID}` })],
    ['a literal word below the settings prefix', settingsRead({ path: '/api/v1/issuing-settings/current' })],
    ['the settings template under a store-scope requirement', settingsRead({ policy: SESSION('tenant', STORE_ISSUE) })],
    ['the settings template on the admin boundary', settingsRead({ path: '/admin/v1/issuing-settings/{id}', policy: SESSION('admin', { scope: 'platform', permission: 'probe.read' }) })],
  ] as const) {
    assert.notEqual(setupCode([def]), undefined, label);
  }
  for (const [label, def] of [
    ['the issue as a PATCH command', storeCreate({ method: 'PATCH', path: ISSUE, policy: SESSION('tenant', STORE_ISSUE) })],
    ['a POST command on the issue preview', storeCreate({ path: ISSUE_PREVIEW, policy: SESSION('tenant', STORE_ISSUE) })],
    ['a PATCH command on an issued invoice', storeCreate({ method: 'PATCH', path: INVOICE, policy: SESSION('tenant', STORE_VIEW_ISSUED) })],
    ['the settings PUT as a handler', { ...noCommand, idempotency: 'none', handler }],
    ['POST as a command on the settings template', settingsWrite({ method: 'POST' })],
    ['a literal store below the settings prefix', settingsRead({ path: `/api/v1/issuing-settings/${ID}` })],
    ['the settings template under a store-scope requirement', settingsRead({ policy: SESSION('tenant', STORE_ISSUE) })],
  ] as const) {
    assert.equal(setupCode([def]), 'route_path_invalid', label);
  }
  assert.equal(setupCode([settingsWrite(), settingsWrite()]), 'route_duplicate');
  assert.equal(setupCode([...issueRoutes(), ...issueRoutes()]), 'route_duplicate');
});

test('M7B-INVOICES-ISSUE-P1: lookup — /invoices and /invoice-drafts resolve unambiguously; the issue, its eligibility and its preview reach their template by the segment before their one literal last segment; the settings GET and PUT by their final segment; nothing else does', () => {
  const table = defineRoutes([...draftRoutes(), ...issueRoutes(), list(), detail(), profile(), patch(), settingsRead(), settingsWrite()]);
  const hit = (path: string, method = 'GET'): string | undefined => table.lookup(method, path)?.path;
  for (const segment of [ID, ID.toUpperCase(), '{id}', 'x', '..', '%2F', 'a'.repeat(128), 'issue', 'issue-preview', 'eligibility']) {
    assert.equal(hit(`/api/v1/stores/${STORE}/invoice-drafts/${segment}/issue`, 'POST'), ISSUE, `issue ${segment}`);
    assert.equal(hit(`/api/v1/stores/${STORE}/invoice-drafts/${segment}/issue-eligibility`), ISSUE_ELIGIBILITY, `issue eligibility ${segment}`);
    assert.equal(hit(`/api/v1/stores/${STORE}/invoice-drafts/${segment}/issue-preview`), ISSUE_PREVIEW, `issue preview ${segment}`);
    assert.equal(hit(`/api/v1/stores/${STORE}/invoices/${segment}`), INVOICE, `issued invoice ${segment}`);
    assert.equal(hit(`/api/v1/issuing-settings/${segment}`), SETTINGS, `settings GET ${segment}`);
    assert.equal(hit(`/api/v1/issuing-settings/${segment}`, 'PUT'), SETTINGS, `settings PUT ${segment}`);
  }
  // /invoices and /invoice-drafts are distinct literal segments: each list, and each {id}, is its own family's.
  assert.equal(hit(`/api/v1/stores/${STORE}/invoices`), INVOICES);
  assert.equal(hit(`/api/v1/stores/${STORE}/invoice-drafts`), DRAFTS);
  assert.equal(hit(`/api/v1/stores/${STORE}/invoice-drafts/${ID}`), DRAFT);
  assert.equal(hit(`/api/v1/stores/${STORE}/invoices/${ID}`), INVOICE);
  assert.deepEqual(table.lookup('GET', `/api/v1/stores/${STORE}/invoices/${ID}`)?.policy, SESSION('tenant', STORE_VIEW_ISSUED));
  assert.deepEqual(table.lookup('POST', `/api/v1/stores/${STORE}/invoice-drafts/${ID}/issue`)?.policy, SESSION('tenant', STORE_ISSUE));
  // A draft named like the new suffixes is still the draft template's; the earlier templates are unchanged beside them.
  assert.equal(hit(`/api/v1/stores/${STORE}/invoice-drafts/issue`), DRAFT, 'a GET of a draft named issue');
  assert.equal(hit(`/api/v1/stores/${STORE}/invoice-drafts/issue-preview`), DRAFT, 'a GET of a draft named issue-preview');
  assert.equal(hit(`/api/v1/stores/${STORE}/invoice-drafts/${ID}/discard`, 'POST'), DISCARD);
  assert.equal(hit(`/api/v1/stores/${STORE}/invoice-drafts/eligibility`), ELIGIBILITY);
  assert.equal(hit(`/api/v1/customers/${ID}`, 'PATCH'), '/api/v1/customers/{id}');
  assert.equal(hit(`/api/v1/customers/${ID}/profile`), '/api/v1/customers/{id}/profile');
  for (const [method, miss] of [
    ['GET', `/api/v1/stores/${STORE}/invoice-drafts/${ID}/issue`], ['PUT', `/api/v1/stores/${STORE}/invoice-drafts/${ID}/issue`],
    ['POST', `/api/v1/stores/${STORE}/invoice-drafts/${ID}/issue-preview`], ['POST', `/api/v1/stores/${STORE}/invoice-drafts/${ID}/issue-eligibility`],
    ['POST', `/api/v1/stores/${STORE}/invoice-drafts/${ID}/issue/`], ['POST', `/api/v1/stores/${STORE}/invoice-drafts/${ID}/issue/x`],
    ['POST', `/api/v1/stores/${STORE}/invoice-drafts/${ID}/Issue`], ['POST', `/api/v1/stores/${STORE}/invoices/${ID}/issue`],
    ['POST', `/api/v1/stores/${STORE}/invoices`], ['PATCH', `/api/v1/stores/${STORE}/invoices/${ID}`], ['DELETE', `/api/v1/stores/${STORE}/invoices/${ID}`],
    ['GET', `/api/v1/stores/${STORE}/invoices/`], ['GET', `/api/v1/stores/${STORE}/invoices/${ID}/`], ['GET', `/api/v1/stores/${STORE}/invoices/${ID}/lines`],
    ['GET', `/api/v1/stores/${STORE}/invoice`], ['GET', `/api/v1/stores/${STORE}/invoicesx`], ['GET', `/api/v1/stores/${STORE}/invoices/${'a'.repeat(129)}`],
    ['GET', `/api/v1/stores/${STORE}/invoice-drafts/${ID}/issue-preview/x`], ['GET', `/api/v1/stores/${STORE}/issue-preview`],
    ['GET', '/api/v1/issuing-settings'], ['GET', '/api/v1/issuing-settings/'], ['GET', `/api/v1/issuing-settings/${ID}/`],
    ['GET', `/api/v1/issuing-settings/${ID}/history`], ['POST', `/api/v1/issuing-settings/${ID}`], ['PATCH', `/api/v1/issuing-settings/${ID}`],
    ['DELETE', `/api/v1/issuing-settings/${ID}`], ['put', `/api/v1/issuing-settings/${ID}`], ['GET', `/api/v1/issuing-settings/${'a'.repeat(129)}`],
    ['GET', `/api/v1/stores/${STORE}/issuing-settings/${ID}`],
  ] as const) {
    assert.equal(hit(miss, method), undefined, `${method} ${miss}`);
  }
});

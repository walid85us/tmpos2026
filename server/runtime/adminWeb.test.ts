// Phase 4.0 M4 — admin web surface response-policy tests (G-WEBHARDEN).
//
// Pins the routing boundary (an API path never reaches the SPA document), the exact admin
// document CSP and its prohibited allowances, the document/asset header maps, and the
// bounded JSON refusal a misrouted API request gets from a frontend server.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  isApiPath, adminDocumentCsp, adminWebHeaders, classifyAdminWebPath, apiPathRefusal, createApiPathGuard,
} from './adminWeb.js';
import { API_PREFIXES } from './routes.js';
import { HSTS_HEADER, SECURITY_HEADERS } from './securityHeaders.js';

const AUTH_DOMAIN = 'ai-studio-applet-webapp-4232a.firebaseapp.com';
const CSP =
  "default-src 'none'; script-src 'self' https://apis.google.com; style-src 'self'; img-src 'self'; " +
  "connect-src 'self' https://identitytoolkit.googleapis.com; frame-src https://ai-studio-applet-webapp-4232a.firebaseapp.com; " +
  "base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const STS = 'Strict-Transport-Security';

test('API_PREFIXES is the frozen pair of versioned boundary prefixes', () => {
  assert.deepEqual([...API_PREFIXES], ['/api/v1', '/admin/v1']);
  assert.ok(Object.isFrozen(API_PREFIXES));
});

// The canonical rule — the console mirrors it and an integration test pins parity: `\` is `/`, one
// percent-decode (malformed -> API), lowercase, empty and `.` segments dropped, `..` resolved at root.
test('isApiPath: the canonical API-path table', () => {
  const api = [
    '/admin/v1', '/admin/v1/', '/ADMIN/V1/x', '/admin%2fv1/x', '/admin%2Fv1/x', '//admin/v1/x', '/admin//v1/x',
    '/%61dmin/v1/session', '/x/../admin/v1/x', '/x%2f..%2fadmin/v1/x', '/admin\\v1\\x', '/admin/v1/%E0%A4%A',
    '/admin%5cv1/x', '/admin%5Cv1%5Ccommand-center', // an encoded backslash is a slash too, after the one decode
    '/api/v1', '/api/v1/x',
    '/api/v1/', '/admin/v1/session/login', '/Admin/v1', '/API/V1', '/admin/v1%2fsession', '/api/v1%2F',
    '/x//..//admin/v1/session', '/x/..%2fadmin/v1/session', '/%2e%2e/admin/v1', '/../../admin/v1', '/./admin/./v1/x',
    '/\\admin/v1/session', '/100%',
  ];
  const notApi = [
    '/admin', '/admin/', '/admin/sign-in', '/admin/v10', '/admin/v1x', '/admin/tenant-management',
    '/assets/index-AbC.js', '/', '/%2561dmin/v1/x',
    '', '/admin/v', '/admin/v1.json', '/api', '/api/v2', '/api/v10', '/adminv1', '/x/admin/v1', '/index.html',
    '/admin/../sign-in', '/assets/../admin', '/admin/v1/../sign-in',
  ];
  for (const p of api) assert.equal(isApiPath(p), true, `${p} is an API path`);
  for (const p of notApi) assert.equal(isApiPath(p), false, `${p} is not an API path`);
});

test('adminDocumentCsp is exactly the documented policy', () => {
  assert.equal(adminDocumentCsp(AUTH_DOMAIN), CSP);
});

test('the admin CSP carries no wildcard, unsafe-eval, unsafe-inline, http:, data: or reCAPTCHA host; every host is exact https', () => {
  const csp = adminDocumentCsp(AUTH_DOMAIN);
  for (const bad of ['*', 'unsafe-eval', 'unsafe-inline', 'unsafe-hashes', 'http:', 'data:', 'blob:', 'www.google.com', 'www.gstatic.com', 'recaptcha']) {
    assert.ok(!csp.includes(bad), `CSP must not contain ${bad}`);
  }
  const directives = csp.split(';').map((d) => d.trim().split(/\s+/));
  assert.equal(new Set(directives.map(([name]) => name)).size, directives.length, 'no directive is repeated');
  for (const [name, ...sources] of directives) {
    assert.ok(sources.length > 0, `${name} has a source list`);
    for (const s of sources) {
      if (s.startsWith("'")) assert.match(s, /^'(?:self|none)'$/, `${name}: keyword ${s}`);
      else assert.match(s, /^https:\/\/[a-z0-9.-]+$/, `${name}: ${s} is an exact https host-source`);
    }
  }
  const byName = Object.fromEntries(directives.map(([name, ...sources]) => [name, sources.join(' ')]));
  assert.equal(byName['default-src'], "'none'");
  assert.equal(byName['frame-ancestors'], "'none'");
  assert.equal(byName['form-action'], "'none'");
  assert.equal(byName['base-uri'], "'none'");
});

test('adminDocumentCsp refuses anything but a bare lowercase DNS hostname', () => {
  const bad: unknown[] = [
    '', 'localhost', 'https://x.firebaseapp.com', 'x.firebaseapp.com:443', 'x.firebaseapp.com/path',
    '*.firebaseapp.com', 'X.firebaseapp.com', ' x.firebaseapp.com', 'x.firebaseapp.com ', 'x .firebaseapp.com',
    'x..firebaseapp.com', '.x.firebaseapp.com', 'x.firebaseapp.com.', '-x.firebaseapp.com', 'x-.firebaseapp.com',
    "x.firebaseapp.com; script-src 'unsafe-inline'", "x.firebaseapp.com'", 'x.firebaseapp.com\n', `${'a'.repeat(64)}.com`,
    '1.2.3.4', 'example.123', undefined, null, 42,
  ];
  for (const d of bad) assert.throws(() => adminDocumentCsp(d as string), /auth_domain_invalid/, `refuses ${JSON.stringify(d)}`);
  assert.doesNotThrow(() => adminDocumentCsp('tmpos-demo.web.app'));
  assert.doesNotThrow(() => adminDocumentCsp('xn--bcher-kva.example'));
});

test('adminWebHeaders: document, asset and file carry the full policy; only the cache rule differs; HSTS only over https', () => {
  const doc = adminWebHeaders('document', { authDomain: AUTH_DOMAIN, https: false });
  assert.deepEqual({ ...doc }, {
    'Content-Security-Policy': CSP,
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': SECURITY_HEADERS['Permissions-Policy'],
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Cache-Control': 'no-store',
  });
  assert.ok(Object.isFrozen(doc));

  const asset = adminWebHeaders('asset', { authDomain: AUTH_DOMAIN, https: false });
  assert.deepEqual({ ...asset }, { ...doc, 'Cache-Control': 'public, max-age=31536000, immutable' });
  assert.ok(Object.isFrozen(asset));
  // Only a content-hashed /assets/ file is immutable; any other file (a favicon) revalidates.
  const file = adminWebHeaders('file', { authDomain: AUTH_DOMAIN, https: false });
  assert.deepEqual({ ...file }, { ...doc, 'Cache-Control': 'no-cache' });
  assert.ok(Object.isFrozen(file));

  for (const kind of ['document', 'asset', 'file'] as const) {
    const h = adminWebHeaders(kind, { authDomain: AUTH_DOMAIN, https: true });
    assert.equal(h[STS], HSTS_HEADER.value, `${kind}: HSTS over https`);
    assert.equal(HSTS_HEADER.value, 'max-age=31536000; includeSubDomains');
    assert.equal(STS in adminWebHeaders(kind, { authDomain: AUTH_DOMAIN, https: false }), false, `${kind}: no HSTS over http`);
  }
  assert.throws(() => adminWebHeaders('document', { authDomain: 'https://evil.example', https: true }), /auth_domain_invalid/);
});

test('classifyAdminWebPath: api first, an /assets/ file is an asset, any other file a file, a missing /assets/ file is missing, else the document', () => {
  // `hasFile` answers for servable files other than the document: the document is the answer for
  // every 'document' path, its own included.
  const files = new Set(['/assets/index-AbC.js', '/assets/index-AbC.css', '/favicon.ico']);
  const hasFile = (p: string) => files.has(p);
  const cases: Array<[string, string]> = [
    ['/admin/v1/session', 'api'],
    ['/api/v1', 'api'],
    ['/x/../admin/v1/session', 'api'],
    ['/assets/index-AbC.js', 'asset'],
    ['/assets/index-AbC.css', 'asset'],
    ['/assets/index-abc.js', 'missing'], // the lookup is the exact, case-sensitive path
    ['/favicon.ico', 'file'],
    ['/assets/gone-123.js', 'missing'],
    ['/', 'document'],
    ['/index.html', 'document'],
    ['/admin', 'document'],
    ['/admin/sign-in', 'document'],
    ['/admin/users', 'document'],
    ['/dashboard', 'document'],
  ];
  for (const [p, want] of cases) assert.equal(classifyAdminWebPath(p, hasFile), want, p);
  // A file that happens to exist under an API path is still never served.
  assert.equal(classifyAdminWebPath('/admin/v1/x.js', () => true), 'api');
});

test('apiPathRefusal is a bounded JSON 404 with the runtime API policy; HSTS only over https', () => {
  for (const https of [false, true]) {
    const r = apiPathRefusal({ https });
    assert.equal(r.status, 404);
    assert.deepEqual(JSON.parse(r.body), { error: 'not_found' });
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) assert.equal(r.headers[name], value, `${name} (https=${https})`);
    assert.equal(r.headers['Content-Type'], 'application/json; charset=utf-8');
    assert.equal(r.headers[STS], https ? HSTS_HEADER.value : undefined);
    assert.ok(Object.isFrozen(r.headers));
  }
});

function fakeExchange(url: unknown) {
  const res = {
    status: 0, headers: {} as Record<string, string>, body: undefined as string | undefined,
    writeHead(status: number, headers: Record<string, string>) { res.status = status; Object.assign(res.headers, headers); return res; },
    end(body?: string) { res.body = body; return res; },
  };
  let nexted = 0;
  const run = (https = false) => createApiPathGuard({ https })(
    { url } as unknown as IncomingMessage, res as unknown as ServerResponse, () => { nexted++; },
  );
  return { res, run, nexted: () => nexted };
}

test('createApiPathGuard refuses an API path with the bounded 404 and never echoes the path', () => {
  const refused = [
    '/admin/v1/session', '/admin/v1/secret-probe?token=abc', '/api/v1', '/ADMIN/V1/overview', '/admin/v1%2fsession',
    '//admin/v1/session', '/x/../admin/v1/session', 'http://host/admin/v1/session', 'http://[', undefined,
    '/x/..%2fadmin/v1/session', '/\\admin/v1/session', '/x//..//admin/v1/session', '/%61dmin/v1/session', '/admin/v1/%E0%A4%A',
  ];
  for (const url of refused) {
    const x = fakeExchange(url);
    x.run();
    assert.equal(x.nexted(), 0, `${String(url)} never reaches the SPA`);
    assert.equal(x.res.status, 404, String(url));
    assert.deepEqual(JSON.parse(x.res.body ?? ''), { error: 'not_found' });
    assert.equal(x.res.headers['Content-Security-Policy'], SECURITY_HEADERS['Content-Security-Policy']);
    assert.ok(!(x.res.body ?? '').includes('secret-probe') && !(x.res.body ?? '').includes('abc'), 'no path echo');
    assert.equal(x.res.headers[STS], undefined);
  }
  const overTls = fakeExchange('/admin/v1/session');
  overTls.run(true);
  assert.equal(overTls.res.headers[STS], HSTS_HEADER.value);
});

test('createApiPathGuard passes console, asset and dev-tooling paths to next untouched', () => {
  for (const url of ['/', '/admin', '/admin/', '/admin/sign-in', '/admin/v10', '/assets/index-abc.js', '/src/main.tsx', '/@vite/client', '/?x=/admin/v1']) {
    const x = fakeExchange(url);
    x.run();
    assert.equal(x.nexted(), 1, url);
    assert.equal(x.res.status, 0, `${url}: nothing written`);
    assert.equal(x.res.body, undefined);
  }
});

test('HSTS is sent only for an exact `https: true`, never for a truthy stand-in', () => {
  for (const https of ['false', '0', 1, {}] as unknown as boolean[]) {
    const document = adminWebHeaders('document', { authDomain: 'ai-studio-applet-webapp-4232a.firebaseapp.com', https });
    assert.equal(document['Strict-Transport-Security'], undefined, `document, https=${JSON.stringify(https)}`);
    assert.equal(apiPathRefusal({ https }).headers['Strict-Transport-Security'], undefined, `refusal, https=${JSON.stringify(https)}`);
  }
});

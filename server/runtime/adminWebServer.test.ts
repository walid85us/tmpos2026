// Phase 4.0 M4 — the admin host's web entry over a real loopback socket (G-WEBHARDEN).
//
// A temp build stands in for dist/: the document and assets carry the admin policy, an API path is
// delegated (or refused) and never answered with the document, a non-GET/HEAD web request is 405,
// and no request-target reaches a byte outside the map preloaded at startup.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createAdminWebListener, loadAdminBuild } from './adminWebServer.js';
import { HSTS_HEADER, SECURITY_HEADERS } from './securityHeaders.js';

const AUTH_DOMAIN = 'ai-studio-applet-webapp-4232a.firebaseapp.com';
const CSP =
  "default-src 'none'; script-src 'self' https://apis.google.com; style-src 'self'; img-src 'self'; " +
  "connect-src 'self' https://identitytoolkit.googleapis.com; frame-src https://ai-studio-applet-webapp-4232a.firebaseapp.com; " +
  "base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const API_CSP = SECURITY_HEADERS['Content-Security-Policy'];
const INDEX = '<!doctype html><div id="root">ADMIN_DOCUMENT_MARK</div>';
const ASSET = 'console.log("asset-mark");';
const SECRET = 'OUTSIDE_SECRET';

/** A temp build (document, hashed assets, an unknown type) beside a secret reachable only by symlink. */
function makeBuild() {
  const root = mkdtempSync(join(tmpdir(), 'tmpos-adminweb-'));
  const dir = join(root, 'dist');
  const outside = join(root, 'outside');
  mkdirSync(join(dir, 'assets'), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(dir, 'index.html'), INDEX);
  writeFileSync(join(dir, 'assets', 'index-AbC.js'), ASSET);
  writeFileSync(join(dir, 'assets', 'index-AbC.css'), 'body{}');
  writeFileSync(join(dir, 'assets', 'data.bin'), 'bin');
  writeFileSync(join(dir, 'favicon.ico'), 'ico');
  writeFileSync(join(outside, 'secret.txt'), SECRET);
  symlinkSync(join(outside, 'secret.txt'), join(dir, 'assets', 'leak.txt'));
  symlinkSync(outside, join(dir, 'linked'));
  return { root, dir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

async function withListener(listener: http.RequestListener, fn: (base: string, port: number) => Promise<void>): Promise<void> {
  const server = http.createServer(listener);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  try { await fn(`http://127.0.0.1:${port}`, port); } finally { await new Promise<void>((r) => server.close(() => r())); }
}

function rawExchange(port: number, payload: string): Promise<string> {
  return new Promise((resolve) => {
    const c = net.connect(port, '127.0.0.1', () => c.write(payload));
    let text = '';
    c.on('data', (d) => { text += d.toString('latin1'); });
    c.on('close', () => resolve(text));
    c.on('error', () => resolve(text));
    setTimeout(() => { c.destroy(); resolve(text); }, 2000);
  });
}
const rawStatus = (text: string): number => Number(/^HTTP\/1\.1 (\d{3})/.exec(text)?.[1] ?? 0);

async function withBuild(fn: (build: ReturnType<typeof loadAdminBuild>) => Promise<void> | void): Promise<void> {
  const b = makeBuild();
  try { await fn(loadAdminBuild(b.dir)); } finally { b.cleanup(); }
}

function assertApiRefusal(res: Response, status: number, label: string): void {
  assert.equal(res.status, status, label);
  assert.equal(res.headers.get('content-security-policy'), API_CSP, `${label}: API CSP`);
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8', label);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff', label);
  assert.equal(res.headers.get('cache-control'), 'no-store', label);
}

test('loadAdminBuild preloads regular files only, never follows a symlink, and refuses a build without index.html', () => {
  const b = makeBuild();
  try {
    const build = loadAdminBuild(b.dir);
    assert.equal(build.document.toString(), INDEX);
    // The document is never an asset: it is served for every document path, its own included.
    assert.deepEqual([...build.assets.keys()].sort(), ['/assets/data.bin', '/assets/index-AbC.css', '/assets/index-AbC.js', '/favicon.ico']);
    assert.equal(build.assets.get('/assets/index-AbC.js')?.type, 'text/javascript; charset=utf-8');
    assert.equal(build.assets.get('/assets/index-AbC.css')?.type, 'text/css; charset=utf-8');
    assert.equal(build.assets.get('/favicon.ico')?.type, 'image/x-icon');
    assert.equal(build.assets.get('/assets/data.bin')?.type, 'application/octet-stream');
    for (const [, f] of build.assets) assert.ok(!f.body.toString().includes(SECRET), 'nothing behind a symlink is loaded');

    const noDocument = mkdtempSync(join(b.root, 'no-document-'));
    writeFileSync(join(noDocument, 'app.js'), ASSET);
    assert.throws(() => loadAdminBuild(noDocument), /admin_build_invalid/);
    // A document that is a symlink is refused too, never followed.
    const linkedDocument = mkdtempSync(join(b.root, 'linked-document-'));
    symlinkSync(join(b.root, 'outside', 'secret.txt'), join(linkedDocument, 'index.html'));
    assert.throws(() => loadAdminBuild(linkedDocument), /admin_build_invalid/);
  } finally {
    b.cleanup();
  }
});

test('a build root reached through a symlink is configuration: it loads, and nothing beneath it is followed', () => {
  const b = makeBuild();
  try {
    const viaLink = join(b.root, 'dist-link');
    symlinkSync(b.dir, viaLink);
    const build = loadAdminBuild(viaLink);
    assert.equal(build.document.toString(), INDEX);
    assert.deepEqual([...build.assets.keys()].sort(), ['/assets/data.bin', '/assets/index-AbC.css', '/assets/index-AbC.js', '/favicon.ico']);
    for (const [, f] of build.assets) assert.ok(!f.body.toString().includes(SECRET), 'a symlink beneath the root is still never followed');
  } finally {
    b.cleanup();
  }
});

test('the listener refuses to start with a bad auth domain', async () => {
  await withBuild((build) => {
    assert.throws(() => createAdminWebListener({ build, authDomain: 'https://evil.example', https: false }), /auth_domain_invalid/);
  });
});

test('console routes and the root get the document with the full admin policy; HSTS only over https', async () => {
  await withBuild(async (build) => {
    for (const https of [false, true]) {
      await withListener(createAdminWebListener({ build, authDomain: AUTH_DOMAIN, https }), async (base) => {
        for (const path of ['/admin', '/admin/sign-in', '/admin/tenant-management', '/', '/index.html', '/admin/?next=1']) {
          const res = await fetch(base + path);
          const label = `${path} (https=${https})`;
          assert.equal(res.status, 200, label);
          assert.equal(await res.text(), INDEX, label);
          assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8', label);
          assert.equal(res.headers.get('content-security-policy'), CSP, label);
          assert.equal(res.headers.get('x-frame-options'), 'DENY', label);
          assert.equal(res.headers.get('x-content-type-options'), 'nosniff', label);
          assert.equal(res.headers.get('referrer-policy'), 'no-referrer', label);
          assert.equal(res.headers.get('permissions-policy'), SECURITY_HEADERS['Permissions-Policy'], label);
          assert.equal(res.headers.get('cross-origin-resource-policy'), 'same-origin', label);
          assert.equal(res.headers.get('cache-control'), 'no-store', label);
          assert.equal(res.headers.get('strict-transport-security'), https ? HSTS_HEADER.value : null, label);
        }
      });
    }
  });
});

test('an /assets/ file is served by its exact path, immutable; any other file revalidates (no-cache); a missing asset is 404', async () => {
  await withBuild(async (build) => {
    await withListener(createAdminWebListener({ build, authDomain: AUTH_DOMAIN, https: false }), async (base) => {
      const res = await fetch(`${base}/assets/index-AbC.js`);
      assert.equal(res.status, 200);
      assert.equal(await res.text(), ASSET);
      assert.equal(res.headers.get('content-type'), 'text/javascript; charset=utf-8');
      assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable');
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(res.headers.get('content-security-policy'), CSP);

      const icon = await fetch(`${base}/favicon.ico`);
      assert.equal(icon.status, 200);
      assert.equal(await icon.text(), 'ico');
      assert.equal(icon.headers.get('content-type'), 'image/x-icon');
      assert.equal(icon.headers.get('cache-control'), 'no-cache', 'an unhashed file is never immutable');
      assert.equal(icon.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(icon.headers.get('content-security-policy'), CSP);

      for (const path of ['/assets/index-abc.js', '/assets/gone-123.js', '/assets/leak.txt']) {
        const miss = await fetch(base + path);
        assertApiRefusal(miss, 404, path);
        const body = await miss.text();
        assert.deepEqual(JSON.parse(body), { error: 'not_found' });
        assert.ok(!body.includes(SECRET), `${path}: nothing behind a symlink`);
      }
    });
  });
});

test('API paths are delegated to `api` whatever the method; without it they get the bounded JSON 404', async () => {
  await withBuild(async (build) => {
    const calls: string[] = [];
    const api: http.RequestListener = (req, res) => { calls.push(`${req.method} ${req.url}`); res.writeHead(204).end(); };
    const table: Array<[string, string]> = [
      ['GET', '/admin/v1/session'], ['POST', '/admin/v1/session/login'], ['GET', '/ADMIN/V1/x'],
      ['GET', '/admin%2fv1/x'], ['DELETE', '/api/v1/x'], ['GET', '/%61dmin/v1/session'],
    ];
    await withListener(createAdminWebListener({ build, authDomain: AUTH_DOMAIN, https: false, api }), async (base) => {
      for (const [method, path] of table) assert.equal((await fetch(base + path, { method })).status, 204, `${method} ${path}`);
    });
    assert.deepEqual(calls, table.map(([method, path]) => `${method} ${path}`));

    for (const https of [false, true]) {
      await withListener(createAdminWebListener({ build, authDomain: AUTH_DOMAIN, https }), async (base) => {
        for (const [method, path] of table) {
          const res = await fetch(base + path, { method });
          assertApiRefusal(res, 404, `${method} ${path}`);
          const body = await res.text();
          assert.deepEqual(JSON.parse(body), { error: 'not_found' });
          assert.ok(!body.includes('ADMIN_DOCUMENT_MARK'), 'never the document');
          assert.equal(res.headers.get('strict-transport-security'), https ? HSTS_HEADER.value : null);
        }
      });
    }
  });
});

test('a web path takes GET and HEAD only: anything else is 405 with Allow; HEAD sends the headers and no body', async () => {
  await withBuild(async (build) => {
    await withListener(createAdminWebListener({ build, authDomain: AUTH_DOMAIN, https: true }), async (base, port) => {
      for (const [method, path] of [['POST', '/admin'], ['PUT', '/assets/index-AbC.js'], ['DELETE', '/']]) {
        const res = await fetch(base + path, { method });
        assertApiRefusal(res, 405, `${method} ${path}`);
        assert.equal(res.headers.get('allow'), 'GET, HEAD');
        assert.deepEqual(await res.json(), { error: 'method_not_allowed' });
        assert.equal(res.headers.get('strict-transport-security'), HSTS_HEADER.value);
      }
      for (const [path, csp] of [['/admin', CSP], ['/assets/index-AbC.js', CSP], ['/assets/gone.js', API_CSP]]) {
        const text = await rawExchange(port, `HEAD ${path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
        const [head, body] = text.split('\r\n\r\n');
        assert.match(head, new RegExp(`\\r\\ncontent-security-policy: ${csp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\r\\n`, 'i'), path);
        assert.equal(body, '', `${path}: HEAD has no body`);
      }
    });
  });
});

test('raw traversal targets never read outside the preloaded map; a non-origin-form target is a bounded 400', async () => {
  await withBuild(async (build) => {
    await withListener(createAdminWebListener({ build, authDomain: AUTH_DOMAIN, https: false }), async (_base, port) => {
      const cases: Array<[string, number]> = [
        ['/assets/../index.html', 404], ['/assets/%2e%2e/%2e%2e/outside/secret.txt', 404], ['/assets/..%2fleak.txt', 404],
        ['/%2e%2e/etc/passwd', 200], ['/../outside/secret.txt', 200], ['/linked/secret.txt', 200],
      ];
      for (const [target, status] of cases) {
        const text = await rawExchange(port, `GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
        assert.equal(rawStatus(text), status, target);
        assert.ok(!text.includes(SECRET) && !/root:.*:0:0:/.test(text), `${target}: nothing outside the map`);
        if (status === 200) assert.ok(text.endsWith(INDEX), `${target}: only ever the document`);
      }
      for (const target of ['http://x/admin', 'http://x/admin/v1/session']) {
        const text = await rawExchange(port, `GET ${target} HTTP/1.1\r\nHost: x\r\n\r\n`);
        assert.equal(rawStatus(text), 400, target);
        assert.match(text, /"error":"invalid_request"/, target);
        assert.ok(text.toLowerCase().includes(`content-security-policy: ${API_CSP.toLowerCase()}`), `${target}: API CSP`);
        assert.ok(!text.includes('ADMIN_DOCUMENT_MARK'), target);
      }
    });
  });
});

test('bad options refuse startup, and the runtime health paths never get the document, in any spelling', async () => {
  await withBuild(async (build) => {
    for (const https of ['false', 1, undefined] as unknown as boolean[]) {
      assert.throws(() => createAdminWebListener({ build, authDomain: AUTH_DOMAIN, https }), /admin_web_options_invalid/, `https=${String(https)}`);
    }
    const notAFunction = 'x' as unknown as http.RequestListener;
    assert.throws(() => createAdminWebListener({ build, authDomain: AUTH_DOMAIN, https: false, api: notAFunction }), /admin_web_options_invalid/);
    // Matched in canonical form: a probe configured as /health/ or /HEALTH must not read a draining runtime as healthy.
    const paths = ['/health', '/readiness', '/health/', '/HEALTH', '//health', '/%68ealth', '/Readiness/'];
    const seen: string[] = [];
    const api: http.RequestListener = (req, res) => {
      seen.push(req.url ?? '');
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end('{"status":"unavailable"}');
    };
    await withListener(createAdminWebListener({ build, authDomain: AUTH_DOMAIN, https: false, api }), async (base) => {
      for (const path of paths) {
        const res = await fetch(`${base}${path}`);
        assert.equal(res.status, 503, `${path}: the runtime's own answer, so a draining runtime is visible`);
        assert.ok(!(await res.text()).includes('ADMIN_DOCUMENT_MARK'), path);
      }
    });
    assert.deepEqual(seen, paths);
    await withListener(createAdminWebListener({ build, authDomain: AUTH_DOMAIN, https: false }), async (base) => {
      for (const path of paths) assertApiRefusal(await fetch(`${base}${path}`), 404, `${path} without a runtime`);
    });
  });
});

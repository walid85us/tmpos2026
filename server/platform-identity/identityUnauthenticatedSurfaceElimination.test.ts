// Phase 4.0 M3 — regression suite proving the two UNAUTHENTICATED identity surfaces
// (POST /identity/resolve — a Postgres write; GET /identity/by-uid — a PII lookup) are
// ELIMINATED from the isolated DEV identity API, and that every unknown path now reaches
// a single bounded-JSON 404 (and any thrown error a bounded-JSON 500) with no route
// reflection, no Express HTML, no stack, and no internal/identifier leakage.
//
// ISOLATED + SIDE-EFFECT-FREE. Mirrors server/runtime/app.test.ts: the factory is booted
// on an ephemeral loopback port (127.0.0.1:0) and torn down in `finally`, so the process
// closes every socket and exits. No real database, no Firebase/Firestore/Supabase/Postgres,
// no provider, no credential, no durable/in-memory application write — only synthetic fixed
// values. The deleted routes have NO handler, so they can never reach getDb()/the repository;
// a bounded 404 (never a 500 db-error and never the old handler's discriminators) is the
// behavioural proof that no route-specific code and no DB call executed. A source-scan guard
// (with positive controls) supplements — but is never the sole evidence for — the HTTP
// behaviour. Runs via `npx tsx`. Server-side only.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { createPlatformIdentityApp } from './server';

const FLAG = 'ENABLE_SUPABASE_PLATFORM_IDENTITY';

// A synthetic, fixed reference — never a real UID/email/token/provider subject/internal id.
const SYNTHETIC_BODY = JSON.stringify({ authProviderUid: 'synthetic-uid-fixture', authProvider: 'firebase' });

/** Boot the identity factory on an ephemeral loopback port for the duration of `fn`. */
async function withServer(fn: (base: string) => Promise<void>): Promise<void> {
  const app = createPlatformIdentityApp();
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** Run `fn` with the legacy feature flag pinned to `value`, then restore prior state. */
async function withFlag(value: 'true' | 'false', fn: () => Promise<void>): Promise<void> {
  const prior = process.env[FLAG];
  process.env[FLAG] = value;
  try {
    await fn();
  } finally {
    if (prior === undefined) delete process.env[FLAG];
    else process.env[FLAG] = prior;
  }
}

/**
 * Assert a response is EXACTLY the bounded-JSON 404 contract and leaks nothing: no route
 * reflection, no Express HTML, no stack/internal detail, and none of the deleted handlers'
 * discriminators (whose presence would prove a route-specific/DB path ran).
 */
function assertBounded404(status: number, ctype: string, raw: string, reflected: string): void {
  assert.equal(status, 404, `expected 404, got ${status}: ${raw.slice(0, 120)}`);
  assert.match(ctype, /application\/json/, `expected JSON content-type, got "${ctype}"`);
  assert.deepEqual(JSON.parse(raw), { error: 'not_found' }, 'body must be the fixed bounded schema');
  assert.ok(!raw.includes(reflected), 'must not reflect the requested path');
  assert.ok(!/Cannot (GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\b/.test(raw), 'must not be Express default "Cannot ..." text');
  for (const marker of [
    '<html', '<!DOCTYPE', '<pre', ' at /', '.ts:', 'server/platform-identity', 'Error:', 'SyntaxError',
    'FEATURE_DISABLED', 'MISSING_UID', 'UPSERT_FAILED', 'LOOKUP_FAILED', 'NOT_FOUND',
    '"identity"', 'success', 'internalUserId', 'authProviderUid',
  ]) {
    assert.ok(!raw.includes(marker), `bounded 404 must not contain "${marker}"`);
  }
}

// ---- Behaviour: the two eliminated surfaces now reach the bounded 404 ---------------------

test('POST /identity/resolve returns the bounded JSON 404 (feature flag OFF)', async () => {
  await withFlag('false', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/identity/resolve`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: SYNTHETIC_BODY,
      });
      assertBounded404(res.status, res.headers.get('content-type') ?? '', await res.text(), '/identity/resolve');
    });
  });
});

test('POST /identity/resolve returns the bounded JSON 404 with the flag ON — no upsert, no DB call', async () => {
  // With the flag ON the OLD handler would have run upsertIdentity()->getDb() (which, with no
  // SUPABASE_DATABASE_URL, throws -> a 500 UPSERT_FAILED). A generic 404 (never 500, never the
  // discriminator) proves the handler is gone and no getDb()/write executed. Result is thus
  // independent of the old flag's enabled/disabled state.
  await withFlag('true', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/identity/resolve`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: SYNTHETIC_BODY,
      });
      assertBounded404(res.status, res.headers.get('content-type') ?? '', await res.text(), '/identity/resolve');
    });
  });
});

test('GET /identity/by-uid returns the bounded JSON 404 (feature flag OFF)', async () => {
  await withFlag('false', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/identity/by-uid?authProviderUid=synthetic-uid-fixture`);
      assertBounded404(res.status, res.headers.get('content-type') ?? '', await res.text(), '/identity/by-uid');
    });
  });
});

test('GET /identity/by-uid returns the bounded JSON 404 with the flag ON — no lookup, no DB call', async () => {
  await withFlag('true', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/identity/by-uid?authProviderUid=synthetic-uid-fixture`);
      assertBounded404(res.status, res.headers.get('content-type') ?? '', await res.text(), '/identity/by-uid');
    });
  });
});

// ---- Behaviour: the generic bounded 404 contract for any unknown route --------------------

test('an unknown GET path returns the bounded JSON 404 (no reflection, no HTML)', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/zzz-unknown-marker-get`);
    assertBounded404(res.status, res.headers.get('content-type') ?? '', await res.text(), 'zzz-unknown-marker-get');
  });
});

test('an unknown POST path returns the bounded JSON 404 (no reflection, no HTML)', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/zzz-unknown-marker-post`, { method: 'POST' });
    assertBounded404(res.status, res.headers.get('content-type') ?? '', await res.text(), 'zzz-unknown-marker-post');
  });
});

// ---- Behaviour: a thrown error reaches the bounded 500 handler (no test-only route) -------

test('a thrown parse error reaches the bounded JSON 500 handler (no stack, no leak)', async () => {
  // A malformed JSON body with an application/json content-type makes the existing global
  // express.json() throw; that error must land on the bounded error middleware (a fixed 500),
  // never Express's default HTML/stack error page. No production test-only route is added.
  await withServer(async (base) => {
    const res = await fetch(`${base}/zzz-unknown-marker-err`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{ this is not valid json',
    });
    const raw = await res.text();
    assert.equal(res.status, 500, `expected bounded 500, got ${res.status}: ${raw.slice(0, 120)}`);
    assert.match(res.headers.get('content-type') ?? '', /application\/json/);
    assert.deepEqual(JSON.parse(raw), { error: 'internal_error' });
    for (const marker of ['<html', '<pre', ' at /', '.ts:', 'SyntaxError', 'Unexpected token', 'server/platform-identity', 'zzz-unknown-marker-err']) {
      assert.ok(!raw.includes(marker), `bounded 500 must not contain "${marker}"`);
    }
  });
});

// ---- Behaviour: the bounded 500 LOG never reflects a malformed-JSON body fragment ---------

test('the bounded 500 log emits only a fixed classification — never a malformed-JSON body fragment', async () => {
  // A bare-token JSON body makes the global express.json() throw a V8 SyntaxError whose
  // `.message` embeds the RAW request body verbatim ("Unexpected token 'L', \"<body>\" is not
  // valid JSON"). The bounded error handler must log ONLY a fixed, code-controlled classification
  // for such errors — never the Error, its message, or any request-body fragment — while STILL
  // emitting one bounded error log event (so the invariant cannot be met by deleting the logging).
  // The response stays the fixed bounded 500. We capture every console.error argument and assert
  // the marker never reaches the log sink, in any representation.
  const LOG_BODY_MARKER = 'LOGLEAKMARKER';                  // synthetic; stands in for a real body
  const BOUNDED_LOG_PREFIX = '[platform-identity] bounded'; // stable across the correction
  const originalConsoleError = console.error;
  const captured: unknown[][] = [];
  console.error = (...args: unknown[]) => { captured.push(args); };
  try {
    await withServer(async (base) => {
      const res = await fetch(`${base}/zzz-unknown-marker-logleak`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: `${LOG_BODY_MARKER} x`, // bare token → V8 reflects the whole body into .message
      });
      const raw = await res.text();
      assert.equal(res.status, 500, `expected bounded 500, got ${res.status}`);
      assert.match(res.headers.get('content-type') ?? '', /application\/json/);
      assert.deepEqual(JSON.parse(raw), { error: 'internal_error' });
      assert.ok(!raw.includes(LOG_BODY_MARKER), 'the response must never reflect the body marker');
    });
  } finally {
    console.error = originalConsoleError;
  }
  // Flatten every captured argument (strings as-is, Errors expanded to name+message+stack,
  // objects JSON-stringified) so a leak in ANY representation is caught.
  const hay = captured
    .map((args) =>
      args
        .map((a) =>
          typeof a === 'string'
            ? a
            : a instanceof Error
              ? `${a.name}: ${a.message}\n${a.stack ?? ''}`
              : JSON.stringify(a))
        .join(' '))
    .join('\n');
  // Positive control: a bounded error log event MUST have occurred (defeats "delete the log").
  assert.ok(hay.includes(BOUNDED_LOG_PREFIX), 'a bounded error log event must be emitted');
  // No raw Error object may reach the sink in any argument position.
  for (const args of captured) {
    for (const a of args) assert.ok(!(a instanceof Error), 'no raw Error object may be logged');
  }
  // The invariant: no request-controlled body fragment and no V8 parse text in the log.
  for (const forbidden of [LOG_BODY_MARKER, 'Unexpected token', 'is not valid JSON', 'SyntaxError', ' at ', '.ts:']) {
    assert.ok(!hay.includes(forbidden), `the bounded error log must not contain "${forbidden}"`);
  }
});

// ---- Behaviour: valid routes remain usable and do NOT fall through to the 404 -------------

test('GET /health remains usable (200, DB-free) and does not hit the 404 handler', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /application\/json/);
    const body = await res.json() as { ok?: boolean; service?: string };
    assert.equal(body.ok, true);
    assert.equal(body.service, 'platform-identity');
  });
});

test('GET /readiness remains registered and usable (503 feature_flag_off when OFF, DB-free)', async () => {
  await withFlag('false', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/readiness`);
      assert.equal(res.status, 503);
      assert.deepEqual(await res.json(), { ready: false, reason: 'feature_flag_off' });
    });
  });
});

// ---- Static registration guard + positive controls (supplements the behaviour above) -----

const SERVER_SRC = readFileSync(fileURLToPath(new URL('./server.ts', import.meta.url)), 'utf8');
const REPO_SRC = readFileSync(fileURLToPath(new URL('./identityRepository.ts', import.meta.url)), 'utf8');

test('server.ts no longer registers POST /identity/resolve (robust to formatting)', () => {
  assert.ok(
    !/app\s*\.\s*(post|all|use|get|put|patch|delete)\s*\(\s*['"`]\/identity\/resolve['"`]/.test(SERVER_SRC),
    'a POST /identity/resolve registration was reintroduced',
  );
  assert.ok(!SERVER_SRC.includes('/identity/resolve'), 'the /identity/resolve path literal must be gone entirely');
});

test('server.ts no longer registers GET /identity/by-uid (robust to formatting)', () => {
  assert.ok(
    !/app\s*\.\s*(get|all|use|post|put|patch|delete)\s*\(\s*['"`]\/identity\/by-uid['"`]/.test(SERVER_SRC),
    'a GET /identity/by-uid registration was reintroduced',
  );
  assert.ok(!SERVER_SRC.includes('/identity/by-uid'), 'the /identity/by-uid path literal must be gone entirely');
});

test('positive controls: the guard read the real, non-empty identity factory source', () => {
  assert.ok(SERVER_SRC.length > 2000, 'server.ts source should be substantial (proves a real file was read)');
  assert.ok(SERVER_SRC.includes('createPlatformIdentityApp'), 'must be the identity factory file');
  assert.ok(SERVER_SRC.includes("app.get('/health'"), 'positive control: /health route still present');
  assert.ok(/app\.all\(\s*BCP_C07_DATA_SOURCE_BOUNDARY_ROUTE_PATH/.test(SERVER_SRC), 'positive control: C-07 route still mounted');
});

test('repository functions remain exported for authenticated internal callers (NOT globally forbidden)', () => {
  // Eliminating the two routes must NOT remove upsertIdentity/findByProviderUid — other flows
  // (requestContext / verifiedWhoami / sessionResolve) still use the repository.
  assert.ok(/export async function upsertIdentity/.test(REPO_SRC), 'upsertIdentity must remain exported');
  assert.ok(/export async function findByProviderUid/.test(REPO_SRC), 'findByProviderUid must remain exported');
});

test('existing authenticated BCP / session / diagnostic routes remain registered (unchanged by this slice)', () => {
  for (const marker of [
    "'/diagnostics/echo-decision'",
    "'/diagnostics/supabase-whoami'",
    "'/auth/session/resolve'",
    'BCP_READINESS_ROUTE_PATH',
    'BCP_C02_REGISTRY_READINESS_ROUTE_PATH',
    'BCP_C07_DATA_SOURCE_BOUNDARY_ROUTE_PATH',
    'BCP_ACTION_ACK_ROUTE_PATH',
    'BCP_ELIGIBILITY_ROUTE_PATH',
  ]) {
    assert.ok(SERVER_SRC.includes(marker), `existing route/handler "${marker}" must remain registered`);
  }
});

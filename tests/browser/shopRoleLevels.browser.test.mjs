// M7A-CUSTOMERS-P3-R2 — THE SHOP'S BUILT-IN CUSTOMERS LEVELS, END TO END IN A REAL BROWSER: a PRODUCTION build of the shop
// SPA in Chromium, signed in through a synthetic Firebase identity provider, talking to the REAL tenant entry
// (server/entry/tenantEntry.ts, startTenantEntry) over loopback HTTP, over a disposable PostgreSQL holding every migration.
//
// WHAT IS SUBSTITUTED, STATED EXACTLY:
//   - The network. Chromium resolves nothing (cdp.mjs HERMETIC_ARGS); CDP Fetch interception answers every request. The
//     page lives on https://shop.tmpos.test, which is also SESSION_TENANT_ORIGINS: its static files come from the build,
//     and its /api/v1/* requests are forwarded to the tenant entry with Host shop.tmpos.test preserved, every header and
//     body as Chromium sent them, and the answer (Set-Cookie included) handed back as the entry gave it — the same-origin
//     front DA-107 records as a pre-deployment dependency. Each forwarded request leaves from its own random 127.x source
//     (the login limit is per source; the trusted proxy 127.0.0.2 is never one).
//   - The identity provider. identitytoolkit/securetoken are answered here with unsigned Firebase-shaped ID tokens; the
//     entry's token verifier accepts exactly the tokens this file issued and answers their uid and auth_time (the only
//     substitution on the server path, as in tests/db/roleLevels.integration.test.mjs).
//   - Firestore (the shop reads users/{uid} for its role). Under `firebase emulators:exec --only firestore` (CI, and any
//     host holding the emulator), requests are forwarded to FIRESTORE_EMULATOR_HOST running the repository's
//     firestore.rules, loaded for the page's own project id. Where the emulator cannot run (it downloads a jar, and a local
//     run may not leave loopback), P3R2_FIRESTORE=stub answers the Listen channel for users/{uid} to that user alone —
//     the rules' single allow — and nothing else. The evidence names the mode.
// The tenant entry's host lock, Origin/CSRF checks, limiter, session boundary, authorizer, step-up rule, idempotency store,
// command transaction, migration 020's routines, audit writer and read-back route are production's own code, unmodified.
//
// WHAT IS PROVEN (CP5 of the stage brief), each case in tenants of its own, with counts the database owner reads:
//   SRL-W  THE ENTRY WITNESS: an owner narrows Sales Associate's Customers level from Create to View in the shop screen; one
//          PUT commits (level view, one audit, one completion) and a sales_staff session issued before the edit is refused
//          on POST /api/v1/customers with nothing written while GET stays 200. The driver uses the server panel when the
//          build has one and otherwise the Permissions grid (the only control the entry commit has), so the same case runs
//          red on the entry SPA (no PUT ever leaves the page) and green on the final one.
//   SRL-01 the owner sees the catalog defaults; narrows to View (saved only after read-back; enforced; GET follows View);
//          the stored level survives a reload and a second browser; None refuses GET and POST; restored to Create, the key
//          refused under None creates afresh (201, not a replay).
//   SRL-02 two tenants stay independent; a tenant-A read held past a same-browser switch to tenant B never replaces B's
//          panel; B's save lands on B alone.
//   SRL-03 a write whose session is missing or ended, whose session CSRF or Origin is stripped/foreign, whose Host is wrong,
//          whose owner lost the grant, or whose tenant server is down never shows "Saved" and writes nothing, each with the
//          status line the panel promises (AM1/AM6); a focus refresh during the outage keeps the rows (AM3); then a save
//          succeeds.
//   SRL-04 a stale sign-in is refused (403 step_up_required), the owner re-authenticates in a labelled prompt that takes
//          focus (AM7), and only then saves.
//   SRL-05 a failed identity verifier leaves the panel unavailable (no levels, no save) until it recovers.
//   SRL-06 a manager sees the panel denied, and the server refuses the manager's direct reads and PUTs — the self-grant and
//          its variants (another domain, Manage, an extra field) included — with nothing written, not even an audit record.
//   SRL-07 the local grid is labelled local-only; a grid change — a built-in role's Customers cell (which points to the
//          server panel) or a custom role's — sends nothing to any server and moves no server level; no global Save.
//   SRL-08 two browsers editing one role: the later writer's value stands, and the tab whose read-back shows another value
//          reports it instead of "Saved" (last writer wins — R1 has no version precondition; recorded, unresolved); a
//          later change made elsewhere turns the winner's "Saved" into "Changed elsewhere" on its next refresh (AM2).
//   SRL-08T the same with two TABS of one browser (one cookie jar, one sign-in).
//   SRL-09 a user switch in one browser (a second tab signs in as another owner) ends the first user's tenant session
//          BEFORE the next user's login leaves the page (AM4: while that login is held, the old cookie reads 401); signing
//          out (the persisted sign-in cleared, as a sign-out in another tab leaves it) ends the next user's session too.
//
// RUN (the SPA build runs Tailwind's scanner over the source root: point P3R2_SPA_SOURCE at a clean export, node_modules
// linked, when the working tree holds large untracked directories — the same variable builds the entry commit's SPA for the
// witness; P3R2_SPA_DIST reuses a finished build; P3R2_EVIDENCE names the evidence folder):
//   firebase emulators:exec --only firestore --project demo-tmpos-shop 'tsx --test tests/browser/shopRoleLevels.browser.test.mjs'
//   P3R2_FIRESTORE=stub tsx --test tests/browser/shopRoleLevels.browser.test.mjs          (no emulator: stub, stated)
// DISPOSABLE ONLY: the database target is tests/db/localPostgres.harness.mjs's (a supplied CI service or a cluster made and
// destroyed here). On a shared service this file removes its customers, role levels, sessions and mint rows, restores the
// limiter fingerprint and issuer key row it found, and drops its login. What it leaves is what every suite leaves: its
// synthetically named identities, tenants and grants, their audit records and idempotency records.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import tls from 'node:tls';
import { tmpdir } from 'node:os';
import { dirname, extname, join, relative, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { installTestIssuerKey, resolveDisposableTarget, testClient, testDriver } from '../db/localPostgres.harness.mjs';
import { assertDisposableTestDsn, createPostgresExecutor, runTrustedApply } from '../../server/platform-identity/migrationExecutor.ts';
import { createNodeFsPort } from '../../server/platform-identity/migrationEngine.ts';
import { runtimeClientOptions } from '../../server/platform-identity/db.ts';
import { createSupervisedPgClient, MAX_POOLS } from '../../server/persistence/supervisedPgClient.ts';
import { rateLimitKeyFingerprint } from '../../server/persistence/postgresRateLimiter.ts';
import { startTenantEntry } from '../../server/entry/tenantEntry.ts';
import { RECENT_AUTH_MAX_AGE_MS, SESSION_CSRF_HEADER } from '../../server/runtime/sessions.ts';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '../../server/runtime/requestSecurity.ts';
import { isApiPath } from '../../server/runtime/adminWeb.ts';
import { findChromium, launch, redact } from './cdp.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOURCE = process.env.P3R2_SPA_SOURCE ?? ROOT;
const PREBUILT = process.env.P3R2_SPA_DIST ?? null;
const EVIDENCE = process.env.P3R2_EVIDENCE ?? join(tmpdir(), 'tmpos-p3r2-evidence');
const CHROMIUM = findChromium();
const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST ?? null;
if (EMULATOR !== null && !/^(127\.0\.0\.1|localhost):\d+$/.test(EMULATOR)) throw new Error('FIRESTORE_EMULATOR_HOST must be a loopback host:port');
const FIRESTORE_MODE = EMULATOR !== null ? 'emulator' : process.env.P3R2_FIRESTORE === 'stub' ? 'stub' : null;

const SHOP_HOST = 'shop.tmpos.test';
const SHOP = `https://${SHOP_HOST}`;
const ADMIN = 'https://admin.tmpos.test';
const IDP_HOST = 'identitytoolkit.googleapis.com';
const STS_HOST = 'securetoken.googleapis.com';
const FS_HOST = 'firestore.googleapis.com';
/** The project and database the page's Firebase SDK names (the build embeds this file). */
const FIREBASE = JSON.parse(readFileSync(join(SOURCE, 'firebase-applet-config.json'), 'utf8'));
const PROJECT = FIREBASE.projectId;
const DATABASE_ID = FIREBASE.firestoreDatabaseId ?? '(default)';

/** Literals, not imports: this file must load against the entry commit's tree as well. */
const ROLE_LEVELS = '/api/v1/roles/levels';
const CUSTOMERS = '/api/v1/customers';
const LOGIN = '/api/v1/session/login';
const CREATE_ACTION = 'tenant.customer.create';
const EDIT_ACTION = 'tenant.role.level.update';
const REASON = 'Owner review of customer access';
const LABELS = Object.freeze({ none: 'None', view: 'View Only', create: 'Create', edit: 'Edit', manage: 'Manage', approve: 'Approve', full: 'Full Access' });
const STALE_S = Math.ceil((RECENT_AUTH_MAX_AGE_MS + 60_000) / 1000);
const SUFFIX = randomUUID().slice(0, 8);
const RUNTIME_LOGIN = 'tmpos_m7srl_probe';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
const HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'host', 'content-length']);

const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const token43 = () => randomBytes(32).toString('base64url');
const nowSec = () => Math.floor(Date.now() / 1000);
const lower = (h) => Object.fromEntries(Object.entries(h ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(join(dir, d.name)) : [join(dir, d.name)]));
const postBody = (request) => request.postData ?? (request.postDataEntries ?? []).map((e) => Buffer.from(e.bytes ?? '', 'base64').toString('utf8')).join('');
/** A random 127.x.y.z loopback source, never the trusted proxy 127.0.0.2: each is its own limiter subject. */
function randomLoopback() {
  const b = randomBytes(3);
  return `127.${1 + (b[0] % 254)}.${b[1]}.${1 + (b[2] % 254)}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// the disposable database: every migration in the directory, a least-privilege runtime login, the three keys
// (mirrors tests/db/roleLevels.integration.test.mjs)
// ---------------------------------------------------------------------------------------------------------------------

const MIG_REL = 'server/platform-identity/migrations';
const MIG_DIR = join(ROOT, MIG_REL);
const TARGET = resolveDisposableTarget('M7SRL');
const TARGET_DSN = TARGET.dsn;
assertDisposableTestDsn(TARGET_DSN);
const DATABASE = new URL(TARGET_DSN).pathname.slice(1);
const owner = testClient(TARGET, { max: 3, onnotice: () => {} });

function driverDsn(raw, user) {
  const url = new URL(raw);
  url.search = '';
  url.username = user;
  url.password = '';
  return url.toString();
}

const DROP_RUNTIME_LOGIN = `do $$ begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = '${RUNTIME_LOGIN}') then
    perform pg_catalog.pg_terminate_backend(pid) from pg_catalog.pg_stat_activity where usename = '${RUNTIME_LOGIN}';
    drop owned by ${RUNTIME_LOGIN};
    drop role ${RUNTIME_LOGIN};
  end if;
end $$;`;

const RATE_KEY = randomBytes(32);
const ISSUER_KEY = randomBytes(32);
const IDEMPOTENCY_KEY = randomBytes(32);
const UIDS = [];
const TENANTS = [];
let fingerprintBefore;
let issuerKeyBefore;

async function setupDatabase() {
  await owner.unsafe(`do $$ begin
    if not exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then create role anon nologin; end if;
    if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  end $$;`);
  await owner.unsafe(`revoke create on database "${DATABASE}" from public`);
  await owner.unsafe(`revoke temporary on database "${DATABASE}" from public`);
  const handle = await createPostgresExecutor(assertDisposableTestDsn(TARGET_DSN));
  try {
    const report = await runTrustedApply({
      fsPort: createNodeFsPort(MIG_DIR, MIG_REL), adapter: handle.adapter, ledger: handle.ledger, connectionMode: 'session',
      credential: { purpose: 'migration', migratorRef: 'm7srl-migrator', runtimeRef: 'm7srl-runtime' },
      lockKey: 528_527, now: () => new Date().toISOString(), deadlineMs: 180_000,
    });
    assert.equal(report.outcome, 'complete', JSON.stringify(report).slice(0, 400));
  } finally {
    await handle.dispose();
  }
  await owner.unsafe(DROP_RUNTIME_LOGIN);
  await owner.unsafe(`create role ${RUNTIME_LOGIN} login nosuperuser nocreatedb nocreaterole noreplication nobypassrls inherit`);
  await owner.unsafe(`grant tmpos_app to ${RUNTIME_LOGIN}`);
  await owner.unsafe(`grant tmpos_audit_writer to ${RUNTIME_LOGIN}`);
  await owner.unsafe(`grant select on public.schema_migrations to ${RUNTIME_LOGIN}`);
  const [fp] = await owner`select singleton, fingerprint, registered_at::text as registered_at from tmpos_rate_limit.key_fingerprint where singleton`;
  fingerprintBefore = fp === undefined ? null : { ...fp, fingerprint: Buffer.from(fp.fingerprint) };
  await owner.begin(async (sql) => {
    await sql`delete from tmpos_rate_limit.key_fingerprint`;
    await sql`insert into tmpos_rate_limit.key_fingerprint (singleton, fingerprint) values (true, ${rateLimitKeyFingerprint(RATE_KEY)})`;
  });
  const [ik] = await owner`select key from tmpos_mint.issuer_key where singleton`;
  issuerKeyBefore = ik === undefined ? null : Buffer.from(ik.key);
  await installTestIssuerKey(owner, ISSUER_KEY);
}

async function teardownDatabase() {
  const failures = [];
  const step = async (fn) => { try { await fn(); } catch (err) { failures.push(err); } };
  try {
    if (TENANTS.length > 0) {
      await step(() => owner`delete from tmpos_role.tenant_role_level where tenant_id = any(${TENANTS}::uuid[])`);
      await step(() => owner`delete from tmpos_customer.customer where tenant_id = any(${TENANTS}::uuid[])`);
    }
    if (UIDS.length > 0) {
      await step(async () => {
        const keys = (await owner`select session_key from tmpos_session.session where auth_provider_uid = any(${UIDS}::text[])`).map((r) => r.session_key);
        if (keys.length > 0) await owner`delete from tmpos_mint.tenant_session where session_key = any(${keys}::text[])`;
        await owner`delete from tmpos_session.session where auth_provider_uid = any(${UIDS}::text[])`;
      });
    }
    await step(() => owner.unsafe(DROP_RUNTIME_LOGIN));
    if (fingerprintBefore !== undefined) {
      await step(() => owner.begin(async (sql) => {
        await sql`delete from tmpos_rate_limit.key_fingerprint where singleton`;
        if (fingerprintBefore !== null) {
          await sql`insert into tmpos_rate_limit.key_fingerprint (singleton, fingerprint, registered_at)
            values (${fingerprintBefore.singleton}, ${fingerprintBefore.fingerprint}, ${fingerprintBefore.registered_at}::text::timestamptz)`;
        }
      }));
    }
    if (issuerKeyBefore !== undefined) {
      await step(() => owner.begin(async (sql) => {
        await sql`delete from tmpos_mint.issuer_key where singleton`;
        if (issuerKeyBefore !== null) await sql`insert into tmpos_mint.issuer_key (singleton, key) values (true, ${issuerKeyBefore})`;
      }));
    }
  } finally {
    await step(() => owner.end({ timeout: 5 }));
    TARGET.cluster?.stop();
  }
  if (failures.length > 0) throw new AggregateError(failures, 'M7SRL teardown: a cleanup step failed');
}

/**
 * C/A/E/K/L/T: customers, create audits, edit audits, sealed completions, every idempotency row, and EVERY audit record
 * (session logins and logouts included, so T is asserted only across steps that make no session) — deltas around a step.
 */
async function counts() {
  const [r] = await owner`select
    (select count(*) from tmpos_customer.customer)::int as c,
    (select count(*) from public.audit_event where action_id = ${CREATE_ACTION})::int as a,
    (select count(*) from public.audit_event where action_id = ${EDIT_ACTION})::int as e,
    (select count(*) from tmpos_internal.idempotency_record where response is not null)::int as k,
    (select count(*) from tmpos_internal.idempotency_record)::int as l,
    (select count(*) from public.audit_event)::int as t`;
  return r;
}
async function deltaSince(before) {
  const now = await counts();
  return { C: now.c - before.c, A: now.a - before.a, E: now.e - before.e, K: now.k - before.k, L: now.l - before.l, T: now.t - before.t };
}
async function assertDelta(before, expected, label) {
  const got = note(label, await deltaSince(before));
  assert.deepEqual(got, { ...got, ...expected }, `${label}: C/A/E/K/L/T ${JSON.stringify(got)}`);
}
const NOTHING = Object.freeze({ C: 0, A: 0, E: 0, K: 0, L: 0 });
/** A refused request on a session made beforehand: nothing at all, not even an audit record of any kind. */
const REFUSED = Object.freeze({ ...NOTHING, T: 0 });
/** One role edit: its audit record, its completion, its one idempotency record, no customer. */
const EDIT = Object.freeze({ C: 0, A: 0, E: 1, K: 1, L: 1 });

/** The stored Customers level of a role: a level, null (020's lock row: the default) or undefined (no row). */
async function levelOf(tenant, roleId) {
  const rows = await owner`select level from tmpos_role.tenant_role_level where tenant_id = ${tenant} and role_id = ${roleId} and domain = 'customers'`;
  return rows.length === 0 ? undefined : rows[0].level;
}

// ---------------------------------------------------------------------------------------------------------------------
// the synthetic identity provider: accounts, unsigned ID tokens, and the entry's verifier over exactly those tokens
// ---------------------------------------------------------------------------------------------------------------------

const ACCOUNTS = new Map(); // email -> { uid, email, password, staleOnce }
const ISSUED = new Map(); // ID token -> { uid, authTime }
const REFRESH = new Map(); // refresh token -> { uid, authTime, email }
const idp = { verifierDown: false };

/** An unsigned Firebase-shaped ID token: the page's SDK parses it; only VERIFIER, over ISSUED, ever accepts it. */
function mintToken(uid, authTime = nowSec(), email = `${uid}@shop.tmpos.test`) {
  const iat = nowSec();
  const payload = {
    iss: `https://securetoken.google.com/${PROJECT}`, aud: PROJECT, auth_time: authTime, user_id: uid, sub: uid, iat, exp: iat + 3600,
    email, email_verified: true, firebase: { identities: { email: [email] }, sign_in_provider: 'password' },
  };
  const token = `${b64u({ alg: 'RS256', kid: 'synthetic', typ: 'JWT' })}.${b64u(payload)}.${randomBytes(64).toString('base64url')}`;
  ISSUED.set(token, { uid, authTime });
  return token;
}

/** The entry's token verifier: a token this file issued answers the uid and auth_time its payload carries; else a verdict. */
const VERIFIER = Object.freeze({
  async verify(token) {
    if (idp.verifierDown) throw new Error('synthetic verifier outage'); // no credential verdict: the runtime answers 503
    if (!ISSUED.has(token)) {
      const err = new Error('unknown_token');
      err.code = 'auth/invalid-id-token';
      throw err;
    }
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return { uid: claims.user_id, authTime: claims.auth_time, secondFactor: claims.firebase?.sign_in_second_factor };
  },
});

function corsFor(request) {
  const h = lower(request.headers);
  return [['access-control-allow-origin', h.origin ?? SHOP], ['access-control-allow-credentials', 'true'], ['vary', 'origin']];
}
function preflight(request) {
  const h = lower(request.headers);
  return {
    status: 204,
    headers: [...corsFor(request), ['access-control-allow-methods', 'GET,POST,OPTIONS'],
      ['access-control-allow-headers', h['access-control-request-headers'] ?? 'content-type'], ['access-control-max-age', '600']],
  };
}

// Shapes as tests/browser/admin-console.browser.test.mjs confirmed them against node_modules/@firebase/auth (firebase 12).
function identityProvider(request, u) {
  if (request.method === 'OPTIONS') return preflight(request);
  st.idp.push(`${request.method} ${u.host}${u.pathname}`);
  const reply = (status, obj) => ({ status, headers: [...corsFor(request), ['content-type', 'application/json; charset=UTF-8']], body: JSON.stringify(obj) });
  const fail = (message) => reply(400, { error: { code: 400, message, errors: [{ message, domain: 'global', reason: 'invalid' }] } });
  const session = (a, authTime) => {
    const idToken = mintToken(a.uid, authTime, a.email);
    const refreshToken = token43();
    REFRESH.set(refreshToken, { uid: a.uid, authTime, email: a.email });
    return { idToken, refreshToken };
  };
  if (u.host === STS_HOST && u.pathname === '/v1/token') {
    const r = REFRESH.get(new URLSearchParams(postBody(request)).get('refresh_token'));
    if (r === undefined) return fail('INVALID_REFRESH_TOKEN');
    const { idToken, refreshToken } = session(r, r.authTime); // a refresh keeps the sign-in's auth_time, as Firebase does
    return reply(200, { access_token: idToken, expires_in: '3600', id_token: idToken, project_id: '0', refresh_token: refreshToken, token_type: 'Bearer', user_id: r.uid });
  }
  let body = {};
  try { body = JSON.parse(postBody(request) || '{}'); } catch { /* treated as empty */ }
  if (u.host === IDP_HOST && u.pathname === '/v1/accounts:signInWithPassword') {
    const a = ACCOUNTS.get(body.email);
    if (a === undefined || a.password !== body.password) return fail('INVALID_LOGIN_CREDENTIALS');
    const authTime = nowSec() - (a.staleOnce ? STALE_S : 0); // a stale account signed in "long ago" once
    a.staleOnce = false;
    const { idToken, refreshToken } = session(a, authTime);
    return reply(200, { kind: 'identitytoolkit#VerifyPasswordResponse', localId: a.uid, email: a.email, displayName: '', registered: true, idToken, refreshToken, expiresIn: '3600' });
  }
  if (u.host === IDP_HOST && u.pathname === '/v1/accounts:lookup') {
    const rec = ISSUED.get(body.idToken);
    const a = rec && [...ACCOUNTS.values()].find((x) => x.uid === rec.uid);
    if (!a) return fail('INVALID_ID_TOKEN');
    return reply(200, {
      kind: 'identitytoolkit#GetAccountInfoResponse',
      users: [{
        localId: a.uid, email: a.email, emailVerified: true, passwordHash: 'UkVEQUNURUQ=', passwordUpdatedAt: 1767225600000, validSince: '1767225600',
        providerUserInfo: [{ providerId: 'password', federatedId: a.email, email: a.email, rawId: a.email }],
        createdAt: '1767225600000', lastLoginAt: String(Date.now()), lastRefreshAt: new Date().toISOString(),
      }],
    });
  }
  st.blocked.push(`${request.method} https://${u.host}${u.pathname}`);
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Firestore: the emulator (forwarded, the repository's rules) or, stated, the Listen-only stand-in
// ---------------------------------------------------------------------------------------------------------------------

const USER_DOCS = new Map(); // uid -> { role, name }
const emulatorUrl = (path) => `http://${EMULATOR}${path}`;

async function seedUserDoc(uid, role, name) {
  USER_DOCS.set(uid, { role, name });
  if (FIRESTORE_MODE !== 'emulator') return;
  const res = await fetch(emulatorUrl(`/v1/projects/${PROJECT}/databases/${DATABASE_ID}/documents/users/${uid}`), {
    method: 'PATCH', headers: { authorization: 'Bearer owner', 'content-type': 'application/json' },
    body: JSON.stringify({ fields: { role: { stringValue: role }, name: { stringValue: name } } }),
  });
  assert.equal(res.status, 200, `seed users/${uid} in the emulator: ${res.status} ${await res.text()}`);
}

async function loadEmulatorRules() {
  // The page's project id, not the exec's demo- id: the rules must govern the requests the page makes.
  const res = await fetch(emulatorUrl(`/emulator/v1/projects/${PROJECT}:securityRules`), {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rules: { files: [{ content: readFileSync(join(ROOT, 'firestore.rules'), 'utf8') }] } }),
  });
  assert.equal(res.status, 200, `load firestore.rules into the emulator: ${res.status} ${await res.text()}`);
}

function forwardFirestore(request, u) {
  const payload = request.hasPostData || request.postData || request.postDataEntries ? Buffer.from(postBody(request)) : null;
  const headers = Object.fromEntries(Object.entries(lower(request.headers)).filter(([k]) => !HOP.has(k)));
  const [host, port] = EMULATOR.split(':');
  return new Promise((resolve) => {
    const req = http.request({
      host, port: Number(port), method: request.method, path: `${u.pathname}${u.search}`, agent: false,
      headers: { ...headers, host: EMULATOR, ...(payload ? { 'content-length': String(payload.length) } : {}) },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('error', () => resolve(null));
      res.on('end', () => {
        const pairs = [];
        for (let i = 0; i < res.rawHeaders.length; i += 2) {
          const name = res.rawHeaders[i].toLowerCase();
          if (!HOP.has(name) && !name.startsWith('access-control-')) pairs.push([res.rawHeaders[i], res.rawHeaders[i + 1]]);
        }
        resolve({ status: res.statusCode, headers: [...pairs, ...corsFor(request)], body: Buffer.concat(chunks) });
      });
    });
    req.on('error', () => resolve(null));
    // A streaming backchannel hangs until the SDK notices the buffering and switches to long polling.
    req.setTimeout(70_000, () => req.destroy());
    req.end(payload ?? undefined);
  });
}

// ponytail: a Listen-only WebChannel stand-in for a host without the emulator jar. It serves users/{uid} to that user
// alone (the rules' one allow) and refuses every other target; the emulator is the gate's real Firestore.
const CHANNELS = new Map(); // SID -> { uid, next, queue, wake }
const chunk = (value) => { const text = JSON.stringify(value); return `${text.length}\n${text}`; };
function listen(channel, message) {
  if (message.addTarget === undefined) return;
  const { targetId } = message.addTarget;
  const names = message.addTarget.documents?.documents ?? [];
  const push = (m) => channel.queue.push([m]);
  push({ targetChange: { targetChangeType: 'ADD', targetIds: [targetId] } });
  const own = names.length === 1 ? /\/documents\/users\/([^/]+)$/.exec(names[0]) : null;
  if (own === null || own[1] !== channel.uid) {
    push({ targetChange: { targetChangeType: 'REMOVE', targetIds: [targetId], cause: { code: 7, message: 'Missing or insufficient permissions.' } } });
    return;
  }
  const doc = USER_DOCS.get(own[1]);
  const at = new Date().toISOString();
  if (doc) {
    push({ documentChange: { document: { name: names[0], fields: { role: { stringValue: doc.role }, name: { stringValue: doc.name } }, createTime: at, updateTime: at }, targetIds: [targetId] } });
  }
  push({ targetChange: { targetChangeType: 'CURRENT', targetIds: [targetId], resumeToken: 'AQ==', readTime: at } });
  push({ targetChange: { resumeToken: 'AQ==', readTime: at } });
}
async function firestoreStub(request, u) {
  if (request.method === 'OPTIONS') return preflight(request);
  const reply = (text, status = 200) => ({ status, headers: [...corsFor(request), ['content-type', 'application/javascript; charset=utf-8'], ['cache-control', 'no-store']], body: text });
  if (!u.pathname.endsWith('/google.firestore.v1.Firestore/Listen/channel')) return null;
  const sid = u.searchParams.get('SID');
  if (request.method === 'POST') {
    const form = new URLSearchParams(postBody(request));
    const messages = [];
    for (let i = 0; i < Number(form.get('count') ?? 0); i++) messages.push(JSON.parse(form.get(`req${i}___data__`) ?? '{}'));
    let channel = CHANNELS.get(sid);
    if (sid === null) {
      const bearer = /authorization:\s*bearer\s+([^\r\n]+)/i.exec(form.get('headers') ?? '');
      channel = { id: token43(), uid: bearer ? ISSUED.get(bearer[1].trim())?.uid ?? null : null, next: 1, queue: [], wake: null };
      CHANNELS.set(channel.id, channel);
    }
    if (channel === undefined) return reply('Unknown SID', 400);
    for (const m of messages) listen(channel, m);
    channel.wake?.();
    return reply(sid === null ? chunk([[0, ['c', channel.id, '', 8, 14, 30000]]]) : chunk([1, channel.next - 1, 0]));
  }
  const channel = CHANNELS.get(sid);
  if (channel === undefined) return reply('Unknown SID', 400);
  if (u.searchParams.get('TYPE') === 'terminate') { CHANNELS.delete(sid); return reply(chunk([1, channel.next - 1, 0])); }
  if (channel.queue.length === 0) await Promise.race([new Promise((r) => { channel.wake = r; }), delay(20_000)]);
  channel.wake = null;
  if (channel.queue.length === 0) channel.queue.push(['noop']);
  return reply(chunk(channel.queue.splice(0).map((m) => [channel.next++, m])));
}

// ---------------------------------------------------------------------------------------------------------------------
// the tenant entry (one at a time; SRL-03 stops and restarts it) and direct HTTP to it
// ---------------------------------------------------------------------------------------------------------------------

const { privateKey: FIREBASE_PRIVATE_KEY } = generateKeyPairSync('rsa', {
  modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const ENV = Object.freeze({
  NODE_ENV: 'production',
  PORT: '8443',
  APP_DATABASE_URL: 'postgres://tmpos_runtime:synthetic-pw@db.abcdefghijklmnop.supabase.co:5432/postgres',
  DATABASE_CA_CERT: tls.rootCertificates[0],
  RATE_LIMIT_KEY: RATE_KEY.toString('base64url'),
  TRUSTED_PROXY_CIDRS: '127.0.0.2/32',
  SESSION_ADMIN_ORIGINS: ADMIN,
  SESSION_TENANT_ORIGINS: SHOP,
  TENANT_SESSION_ISSUER_KEY: ISSUER_KEY.toString('base64url'),
  IDEMPOTENCY_KEY: IDEMPOTENCY_KEY.toString('base64url'),
  FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON: JSON.stringify({
    type: 'service_account', project_id: 'm7srl-test-project', client_email: 'm7srl@m7srl-test-project.iam.gserviceaccount.com', private_key: FIREBASE_PRIVATE_KEY,
  }),
});

let entry = null; // { port, cap } while the tenant entry listens

async function startEntry() {
  const cap = { codes: [], lines: [], proc: new EventEmitter() };
  const construction = {
    databaseClient: () => createSupervisedPgClient(testDriver(TARGET), driverDsn(TARGET_DSN, RUNTIME_LOGIN), {
      ...runtimeClientOptions(TARGET_DSN), ssl: false, max: MAX_POOLS, idle_timeout: 0, user: RUNTIME_LOGIN,
    }),
    tokenVerifier: VERIFIER,
    listen: () => ({ port: 0, host: '127.0.0.1' }),
  };
  const result = await startTenantEntry({
    env: ENV, construction, proc: cap.proc, exit: (code) => { cap.codes.push(code); }, log: { log: (line) => { cap.lines.push(line); } },
  });
  assert.equal(result.outcome, 'listening', JSON.stringify(result));
  entry = { port: result.address.port, cap };
}

async function stopEntry() {
  if (entry === null) return;
  const { cap } = entry;
  entry = null;
  cap.proc.emit('SIGTERM');
  for (const until = Date.now() + 10_000; cap.codes.length === 0 && Date.now() < until;) await delay(20);
  assert.ok(cap.codes.length > 0, 'the tenant entry stopped: an outage case is a real one');
}

function send(port, method, path, headers, body) {
  const payload = body === undefined ? null : Buffer.from(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method, path, agent: false, localAddress: randomLoopback(),
      headers: payload ? { ...headers, 'content-length': String(payload.length) } : headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('error', reject);
      res.on('end', () => {
        const pairs = [];
        for (let i = 0; i < res.rawHeaders.length; i += 2) if (!HOP.has(res.rawHeaders[i].toLowerCase())) pairs.push([res.rawHeaders[i], res.rawHeaders[i + 1]]);
        resolve({ status: res.statusCode, headers: res.headers, pairs, body: Buffer.concat(chunks) });
      });
    });
    req.on('error', reject);
    req.setTimeout(30_000, () => req.destroy(new Error(`no reply within 30 s: ${method} ${path}`)));
    req.end(payload ?? undefined);
  });
}

/** A request from outside the browser (a pre-issued employee session, a manager's direct attempt), as a same-origin client. */
async function call(method, path, { session = null, body, key } = {}) {
  const unsafe = method !== 'GET';
  const headers = {
    host: SHOP_HOST,
    ...(session ? { cookie: session.cookie } : {}),
    ...(unsafe ? { origin: SHOP, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE, ...(session ? { [SESSION_CSRF_HEADER]: session.csrf } : {}) } : {}),
    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    ...(key ? { 'idempotency-key': key } : {}),
  };
  const res = await send(entry.port, method, path, headers, body === undefined ? (unsafe ? '' : undefined) : JSON.stringify(body));
  return { status: res.status, headers: res.headers, text: res.body.toString('utf8') };
}

/** A tenant session established outside the browser with a token this file issued: { cookie, csrf }. */
async function directLogin(who) {
  const res = await send(entry.port, 'POST', LOGIN, {
    host: SHOP_HOST, origin: SHOP, 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: CSRF_HEADER_VALUE, authorization: `Bearer ${mintToken(who.uid)}`,
  }, '');
  assert.equal(res.status, 200, `direct login ${who.label}: ${res.body}`);
  return { cookie: res.headers['set-cookie'][0].split('; ')[0], csrf: JSON.parse(res.body.toString('utf8')).csrfToken };
}

// ---------------------------------------------------------------------------------------------------------------------
// fixtures: principals, tenants, grants, accounts and users docs
// ---------------------------------------------------------------------------------------------------------------------

async function actor(label, memberships, { role = null } = {}) {
  const uid = `m7srl-${label}-${SUFFIX}`;
  const [{ internal_user_id: id }] = await owner`
    insert into platform_identity (auth_provider, auth_provider_uid) values ('firebase', ${uid}) returning internal_user_id`;
  await owner`insert into app_user (internal_user_id, status) values (${id}, 'active')`;
  for (const m of memberships) {
    await owner`insert into user_membership (internal_user_id, tenant_id, store_id, scope_type, role_id, status)
      values (${id}, ${m.tenant}, null, 'tenant', ${m.role}, 'active')`;
  }
  UIDS.push(uid);
  const who = { id, uid, label, email: `${label}-${SUFFIX}@shop.tmpos.test`, password: `synthetic-${label}-password` };
  if (role !== null) {
    ACCOUNTS.set(who.email, { uid, email: who.email, password: who.password, staleOnce: false });
    await seedUserDoc(uid, role, `Synthetic ${label}`);
  }
  return who;
}
const grant = (tenant, role) => ({ tenant, role });

/** A tenant of its own with its store owner, who can sign in to the shop. */
async function shop(label) {
  const [{ tenant_id: tenant }] = await owner`insert into tenant (display_name, status) values (${`m7srl-${label}-${SUFFIX}`}, 'active') returning tenant_id`;
  TENANTS.push(tenant);
  const boss = await actor(`${label}-owner`, [grant(tenant, 'store_owner')], { role: 'store_owner' });
  return { tenant, boss };
}

// ---------------------------------------------------------------------------------------------------------------------
// interception: the shop host (build + forwarded API), the identity provider, Firestore; everything else is refused
// ---------------------------------------------------------------------------------------------------------------------

const files = new Map();
let browser = null;
let st = null; // the running scenario's recordings, gates and tamper hook
const evidence = { firestore: FIRESTORE_MODE, source: SOURCE === ROOT ? 'repository root' : 'P3R2_SPA_SOURCE', scenarios: {} };

function note(key, value) { if (st) st.notes[key] = value; return value; }

async function route(ev) {
  let u;
  try { u = new URL(ev.request.url); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (st === null) return null;
  if (u.protocol === 'https:' && u.host === SHOP_HOST) return isApiPath(u.pathname) ? shopApi(ev, u) : shopStatic(ev, u);
  if (u.protocol === 'https:' && (u.host === IDP_HOST || u.host === STS_HOST)) return identityProvider(ev.request, u);
  // The shop's stylesheet @imports Google Fonts; a failed @import fails Vite's CSS preload and with it the app chunk.
  if (u.protocol === 'https:' && u.host === 'fonts.googleapis.com') return { status: 200, headers: [['content-type', 'text/css; charset=utf-8'], ...corsFor(ev.request)], body: '' };
  if (u.protocol === 'https:' && u.host === FS_HOST) {
    if (ev.request.method === 'OPTIONS') return preflight(ev.request);
    st.firestore.push(`${ev.request.method} ${u.pathname}`);
    return FIRESTORE_MODE === 'emulator' ? forwardFirestore(ev.request, u) : firestoreStub(ev.request, u);
  }
  st.blocked.push(`${ev.request.method} ${u.protocol}//${u.host}${u.pathname}`);
  return null;
}

function shopStatic(ev, u) {
  if (ev.request.method !== 'GET') { st.blocked.push(`${ev.request.method} ${SHOP}${u.pathname}`); return null; }
  const file = files.get(u.pathname) ?? files.get('/index.html'); // the SPA fallback a static host gives
  return { status: 200, headers: [['content-type', TYPES[extname(file)] ?? 'application/octet-stream'], ['cache-control', 'no-store']], body: readFileSync(file) };
}

/** The same-origin front: /api/v1/* to the tenant entry, Host preserved, every header and the body as sent. */
async function shopApi(ev, u) {
  const s = st;
  const { request } = ev;
  const headers = lower(request.headers);
  // at: when the page sent it; doneAt: when the entry had answered it; cookie: the session cookie it set, name=value.
  const rec = { method: request.method, path: u.pathname, query: u.search, frameId: ev.frameId, headers, body: postBody(request), status: null, at: performance.now(), doneAt: null, cookie: null };
  s.api.push(rec);
  await passGates(s, rec, 'request');
  const out = { ...Object.fromEntries(Object.entries(headers).filter(([k]) => !HOP.has(k))), host: SHOP_HOST };
  if (s.tamper) await s.tamper(rec, out);
  let res = null;
  if (entry !== null) res = await send(entry.port, rec.method, `${u.pathname}${u.search}`, out, rec.body === '' && rec.method === 'GET' ? undefined : rec.body).catch(() => null);
  if (res === null) res = { status: 502, pairs: [['content-type', 'text/plain'], ['cache-control', 'no-store']], body: Buffer.from('Bad Gateway') };
  rec.doneAt = performance.now();
  rec.status = res.status;
  try {
    const answer = JSON.parse(res.body.toString('utf8'));
    rec.error = answer.error;
    if (typeof answer.csrfToken === 'string') s.secrets.add(answer.csrfToken);
  } catch { /* not JSON */ }
  const cookie = res.pairs.find(([k]) => k.toLowerCase() === 'set-cookie');
  if (cookie) {
    rec.cookie = cookie[1].split(';')[0];
    const value = rec.cookie.split('=').slice(1).join('=');
    if (value !== '') s.secrets.add(value); // a logout's clearing cookie carries no value
  }
  await passGates(s, rec, 'response');
  return { status: res.status, headers: res.pairs, body: res.body };
}

async function passGates(s, rec, phase) {
  for (const g of [...s.gates]) {
    if (g.phase !== phase || !g.match(rec)) continue;
    s.gates.delete(g);
    g.hit(rec);
    await g.released;
  }
}

/** Hold the next API request (or its answer) that `match`es until release() — bounded, and released at scenario end. */
function gate(match, phase) {
  let hit;
  let release;
  const reached = new Promise((r) => { hit = r; });
  const released = new Promise((r) => { release = r; });
  st.gates.add({ match, phase, hit, released: Promise.race([released, delay(60_000)]) }); // a bound, never a result
  st.releases.push(release);
  return { reached, release };
}

const apiLine = (r) => `${r.method} ${r.path}${r.query} -> ${r.status ?? 'held'}${r.error ? ` ${r.error}` : ''}`;
const isPut = (r) => r.method === 'PUT' && r.path === ROLE_LEVELS;
const isRead = (r) => r.method === 'GET' && r.path === ROLE_LEVELS;
const isLogout = (r) => r.method === 'POST' && r.path === '/api/v1/session/logout';
/** The UID whose ID token a login carried (a token this file issued), or null. */
const bearerUid = (r) => ISSUED.get(/^Bearer (\S+)$/i.exec(r.headers.authorization ?? '')?.[1] ?? '')?.uid ?? null;
/** A login for `who` that the entry accepted: its session cookie (name=value) is the one that user held. */
const acceptedLogin = (who) => (r) => r.method === 'POST' && r.path === LOGIN && r.status === 200 && r.cookie !== null && bearerUid(r) === who.uid;
/** What a GET /api/v1/roles/levels on exactly this cookie answers now, from outside the browser. */
const readWith = (cookie) => call('GET', ROLE_LEVELS, { session: { cookie } });

// ---------------------------------------------------------------------------------------------------------------------
// the page: sign in, open the editor, drive the server panel (or, on the entry build, the grid)
// ---------------------------------------------------------------------------------------------------------------------

async function openPage() {
  const page = await browser.newPage({ width: 1440, height: 1000 });
  page.frameId = (await page.send('Page.getFrameTree')).frameTree.frame.id;
  st.pages.push(page);
  return page;
}

/** A second tab in the SAME browser context (shared cookies and Firebase persistence), built on the page's own class. */
async function sameContextTab(page) {
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank', browserContextId: page.contextId });
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  const tab = Object.assign(Object.create(Object.getPrototypeOf(page)), { browser, sessionId, contextId: page.contextId, logs: [] });
  await tab.init(1440, 1000, false);
  tab.frameId = targetId;
  st.tabs.push(targetId);
  return tab;
}

async function signIn(page, who) {
  await page.goto(`${SHOP}/login`, 30_000);
  await page.waitFor(`!!document.querySelector('input[type="email"]')`, 30_000, 'the sign-in form');
  await page.fill('input[type="email"]', who.email);
  await page.fill('input[type="password"]', who.password);
  await page.click('button[type="submit"]');
  await page.waitFor(`location.pathname === '/'`, 30_000, `${who.label} signed in and left /login`);
}

async function openPermissions(page) {
  await page.evaluate(`history.pushState({}, '', '/employees'); dispatchEvent(new PopStateEvent('popstate'))`);
  const tab = `[...document.querySelectorAll('button')].find((b) => b.textContent.trim().endsWith('Permissions'))`;
  await page.waitFor(`!!${tab}`, 30_000, 'the Permissions tab');
  await page.evaluate(`${tab}.setAttribute('data-p3r2', 'permissions-tab')`);
  await page.click('[data-p3r2="permissions-tab"]');
  await page.waitFor(`!!document.querySelector('[data-testid="server-customer-levels"]') || [...document.querySelectorAll('th')].some((th) => th.textContent.includes('Module / Action'))`, 30_000, 'the Permissions tab content');
}

const hasPanel = (page) => page.evaluate(`!!document.querySelector('[data-testid="server-customer-levels"]')`);
const panelState = (page) => page.evaluate(`document.querySelector('[data-testid="server-levels-state"]')?.textContent.trim() ?? null`);
const waitState = (page, state, timeout = 30_000) =>
  page.waitFor(`document.querySelector('[data-testid="server-levels-state"]')?.textContent.trim() === ${JSON.stringify(state)}`, timeout, `the server panel is ${state}`);

/** A role's row as the panel shows it: { level (label), badge }, or null. */
async function rowOf(page, roleId) {
  const text = await page.evaluate(`document.querySelector('[data-testid="server-level-row-${roleId}"]')?.textContent ?? null`);
  if (text === null) return null;
  const m = /Server level:\s*(None|View Only|Create|Edit|Manage|Approve|Full Access)\s*(Custom|Default)/.exec(text);
  return m ? { level: m[1], badge: m[2] } : { text };
}
async function waitRow(page, roleId, level, badge) {
  await page.waitFor(async () => {
    const row = await rowOf(page, roleId);
    return row?.level === LABELS[level] && row?.badge === badge;
  }, 20_000, `${roleId} shows ${LABELS[level]} (${badge})`);
}

/** Choose a level and a reason for a role in the server panel (a React-visible value change on each control). */
async function draft(page, roleId, level, reason = REASON) {
  const set = function (proto, event, value) {
    Object.getOwnPropertyDescriptor(window[proto].prototype, 'value').set.call(this, value);
    this.dispatchEvent(new Event(event, { bubbles: true }));
  };
  await page.call(`[data-testid="server-level-select-${roleId}"]`, set, 'HTMLSelectElement', 'change', level);
  await page.call(`[data-testid="server-level-reason-${roleId}"]`, set, 'HTMLInputElement', 'input', reason);
}

const statusOf = (page, roleId) => page.evaluate(`document.querySelector('[data-testid="server-level-status-${roleId}"]')?.textContent.trim() ?? null`);

/** Press "Save to server"; answers the API record count at the click, for settle(). */
async function clickSave(page, roleId) {
  const button = `[data-testid="server-level-save-${roleId}"]`;
  await page.waitFor(`document.querySelector(${JSON.stringify(button)})?.disabled === false`, 10_000, `Save enabled for ${roleId}`);
  const from = st.api.length;
  await page.click(button);
  return from;
}

/**
 * The row's status once this save has settled: every save sends at least one request (the session check), so it has settled
 * when a request went out after the click, every one of those has been answered, the row is no longer busy, and its status
 * line is not a transitional one. (A previous attempt's identical text can therefore never be mistaken for this one's.)
 */
function settle(page, roleId, from) {
  const mine = (r) => r.frameId === page.frameId;
  return page.waitFor(async () => {
    const sent = st.api.slice(from).filter(mine);
    if (sent.length === 0 || sent.some((r) => r.status === null)) return null;
    const text = await statusOf(page, roleId);
    const busy = await page.evaluate(`document.querySelector('[data-testid="server-level-select-${roleId}"]')?.disabled ?? false`);
    return !busy && text && text !== 'Not saved yet.' && !text.startsWith('Saving') ? text : null;
  }, 45_000, `the save of ${roleId} settled`);
}

/** Press "Save to server" and wait for the row's settled status line; answers that text. */
async function save(page, roleId) {
  return settle(page, roleId, await clickSave(page, roleId));
}
/** AM1: exactly "Saved" is the one success line; every other line is not a save. */
const saved = (text) => text === 'Saved';

/** The status lines the panel promises (src/tenant/ServerCustomerLevels.tsx, AM1-AM6), by outcome. */
const SAY = Object.freeze({
  signedOut: 'Not saved: your server session ended. Reconnect, then save again.',
  refused: 'Not saved: the server refused this change. Only the store owner can change these levels.',
  unreachable: 'Not saved: the store server could not be reached. Try again.',
  stepUp: 'Not saved: sign in again to save this change.',
  signedInAgain: 'Signed in again. Press "Save to server" to save this change.',
  notThisAttempt: (level) => `Not saved by this attempt. The server has ${LABELS[level]}.`,
  lostRace: (level) => `Changed elsewhere — the server now has ${LABELS[level]}. Your change is not saved.`,
  changedElsewhere: (level) => `Changed elsewhere — the server now has ${LABELS[level]}.`,
});
const REFRESH_FAILED = 'Could not refresh from the server; values may be out of date.';

/** The entry build's only control: the Permissions grid's cell for (role column, domain row). */
async function setGridLevel(page, roleName, domainLabel, level) {
  return page.evaluate(`(() => {
    const table = [...document.querySelectorAll('table')].find((t) => t.querySelector('th')?.textContent.includes('Module / Action'));
    const col = [...table.querySelectorAll('thead th')].findIndex((th) => th.textContent.trim().startsWith(${JSON.stringify(roleName)}));
    const row = [...table.querySelectorAll('tbody tr')].find((tr) => tr.querySelector('td')?.textContent.trim().startsWith(${JSON.stringify(domainLabel)}));
    const select = row.querySelectorAll('td')[col].querySelector('select');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, ${JSON.stringify(level)});
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return select.value;
  })()`);
}

/** A button whose text ends with `suffix` (a tab or a toolbar action: its icon's ligature comes first), clicked. */
async function clickButton(page, suffix, tag) {
  const find = `[...document.querySelectorAll('button')].find((b) => !b.disabled && b.textContent.trim().endsWith(${JSON.stringify(suffix)}))`;
  await page.waitFor(`!!${find}`, 30_000, `a "${suffix}" button`);
  await page.evaluate(`${find}.setAttribute('data-p3r2', ${JSON.stringify(tag)})`);
  await page.click(`[data-p3r2="${tag}"]`);
}

/** A custom role made in the Roles tab: it lives in this tab's state only (addTenantRole), like the grid. */
async function createCustomRole(page, name) {
  // The Roles tab sits in the Employees tab bar beside the Permissions tab.
  const tab = `[...document.querySelector('[data-p3r2="permissions-tab"]').parentElement.querySelectorAll('button')].find((b) => b.textContent.trim().endsWith('Roles'))`;
  await page.evaluate(`${tab}.setAttribute('data-p3r2', 'roles-tab')`);
  await page.click('[data-p3r2="roles-tab"]');
  await clickButton(page, 'Create Role', 'create-role-open');
  const input = 'input[placeholder="e.g. Senior Technician"]';
  await page.waitFor(`!!document.querySelector(${JSON.stringify(input)})`, 10_000, 'the Create Role form');
  await page.fill(input, name);
  const submit = `[...document.querySelectorAll('button')].find((b) => !b.disabled && b.textContent.trim() === 'Create Role')`;
  await page.waitFor(`!!${submit}`, 10_000, 'the Create Role submit');
  await page.evaluate(`${submit}.setAttribute('data-p3r2', 'create-role-submit')`);
  await page.click('[data-p3r2="create-role-submit"]');
  await page.waitFor(`!document.querySelector(${JSON.stringify(input)})`, 10_000, 'the Create Role form closed');
}

/** Owner signs in, opens Employees → Permissions, and (when the build has it) waits for the server panel. */
async function ownerPanel(who, page = null) {
  const p = page ?? await openPage();
  await signIn(p, who);
  await openPermissions(p);
  if (await hasPanel(p)) await waitState(p, 'Ready');
  return p;
}

/** Session material never lands where script can read it. */
async function assertNoLeak(page) {
  const seen = await page.evaluate(`JSON.stringify({ cookie: document.cookie, local: Object.values(localStorage).join('\\n'), session: Object.values(sessionStorage).join('\\n'), html: document.documentElement.outerHTML })`);
  const surfaces = JSON.parse(seen);
  assert.ok(!surfaces.cookie.includes('__Host-tmpos_tenant_session'), 'document.cookie does not expose the tenant session cookie');
  for (const secret of st.secrets) {
    for (const [where, text] of Object.entries(surfaces)) assert.ok(!text.includes(secret), `a session secret appears in ${where}`);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// the suite
// ---------------------------------------------------------------------------------------------------------------------

function scenario(id, title, fn) {
  test(`${id}: ${title}`, { timeout: 180_000 }, async () => {
    st = { id, api: [], idp: [], firestore: [], blocked: [], gates: new Set(), releases: [], tamper: null, pages: [], tabs: [], secrets: new Set(), notes: {} };
    const s = st;
    const errorsBefore = browser.interceptErrors.length;
    let outcome = 'fail';
    try {
      await fn();
      assert.deepEqual(browser.interceptErrors.slice(errorsBefore), [], 'interception handler errors');
      // Every request to a host this file stands in for was answered; other third-party loads (placeholder avatars) are
      // refused and only recorded.
      const ours = [SHOP_HOST, IDP_HOST, STS_HOST, FS_HOST].map((h) => `//${h}/`);
      assert.deepEqual(s.blocked.filter((b) => ours.some((h) => b.includes(h))).map(redact), [], 'requests the stand-ins did not answer');
      outcome = 'pass';
    } finally {
      s.tamper = null;
      for (const release of s.releases) release();
      evidence.scenarios[id] = {
        title, outcome, notes: s.notes, api: s.api.map(apiLine), idp: s.idp, firestore: s.firestore.length, blocked: s.blocked.map(redact),
        pageLogs: s.pages.flatMap((p) => p.logs).filter((l) => /error|exception|fail/i.test(l)).slice(0, 20).map(redact),
      };
      for (const targetId of s.tabs) await browser.send('Target.closeTarget', { targetId }).catch(() => {});
      for (const page of s.pages) await page.close();
      if (entry === null) await startEntry();
      st = null;
    }
  });
}

before(async () => {
  assert.ok(CHROMIUM, 'Chromium not found: set CHROMIUM_PATH, or provide /repl/tools/bin/chromium or `chromium` on PATH');
  assert.ok(FIRESTORE_MODE, 'INFRASTRUCTURE BLOCKER: no Firestore — run under `firebase emulators:exec --only firestore` (FIRESTORE_EMULATOR_HOST), or set P3R2_FIRESTORE=stub to use the stated stand-in');
  mkdirSync(EVIDENCE, { recursive: true });
  let outDir = PREBUILT;
  if (outDir === null) {
    outDir = mkdtempSync(join(tmpdir(), 'tmpos-shop-build-'));
    const built = spawnSync(join(ROOT, 'node_modules', '.bin', 'vite'), ['build', '--outDir', outDir, '--emptyOutDir', '--logLevel', 'error'], {
      cwd: SOURCE,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', VITE_ADMIN_CONSOLE_ORIGINS: ADMIN }, // never inherit process.env
      encoding: 'utf8', timeout: 600_000, maxBuffer: 32 * 1024 * 1024,
    });
    assert.equal(built.status, 0, redact(`production build failed (${built.error?.message ?? `exit ${built.status}, signal ${built.signal}`}):\n${`${built.stdout ?? ''}${built.stderr ?? ''}`.slice(-3000)}`));
    process.once('exit', () => rmSync(outDir, { recursive: true, force: true }));
  }
  for (const f of walk(outDir)) files.set(`/${relative(outDir, f).split(sep).join('/')}`, f);
  assert.ok(files.has('/index.html'), 'the build holds index.html');
  await setupDatabase();
  if (FIRESTORE_MODE === 'emulator') await loadEmulatorRules();
  await startEntry();
  browser = await launch({ executable: CHROMIUM });
  await browser.intercept(route);
}, { timeout: 900_000 });

after(async () => {
  try { writeFileSync(join(EVIDENCE, 'shop-role-levels.json'), `${JSON.stringify(evidence, null, 2)}\n`); } catch { /* evidence is best effort */ }
  await browser?.close().catch((e) => console.warn(redact(`browser teardown: ${e.message}`)));
  await stopEntry();
  await teardownDatabase();
});

// ---------------------------------------------------------------------------------------------------------------------

scenario('SRL-W', 'ENTRY WITNESS — an owner narrows Sales Associate Create→View in the shop screen: one PUT commits, and the sales_staff session issued before it cannot POST a customer (nothing written) while GET stays 200', async () => {
  const { tenant, boss } = await shop('w');
  const staff = await actor('w-staff', [grant(tenant, 'sales_staff')]);
  const staffSession = await directLogin(staff);
  const page = await ownerPanel(boss);
  const panel = await hasPanel(page);
  note('ui', panel ? 'server panel' : 'entry grid only');
  const before = await counts();
  if (panel) {
    await waitRow(page, 'sales_staff', 'create', 'Default');
    await draft(page, 'sales_staff', 'view');
    note('status', await save(page, 'sales_staff'));
  } else {
    note('grid', await setGridLevel(page, 'Sales Associate', 'Customers', 'view'));
    await delay(2_000); // whatever the page would send, it has sent
  }
  // Everything is observed first, so the entry run records the whole "before" picture, then judged.
  const puts = note('PUT statuses', st.api.filter(isPut).map((r) => r.status));
  const stored = note('stored level', (await levelOf(tenant, 'sales_staff')) ?? 'no row (the default, create)');
  const edit = note('edit delta', await deltaSince(before));
  const mid = await counts();
  const post = await call('POST', CUSTOMERS, { session: staffSession, body: { name: `M7SRL w ${SUFFIX}` }, key: randomUUID() });
  note('staff POST', post.status);
  const postDelta = note('staff POST delta', await deltaSince(mid));
  const list = await call('GET', `${CUSTOMERS}?limit=10`, { session: staffSession });
  note('staff GET', list.status);

  assert.deepEqual(puts, [200], `the shop edit reached the tenant server as one committed PUT (API seen: ${st.api.map(apiLine).join('; ') || 'none'})`);
  assert.equal(stored, 'view', 'the stored Customers level of sales_staff');
  assert.deepEqual(edit, { ...edit, ...EDIT }, `the edit: one audit record and one completion ${JSON.stringify(edit)}`);
  assert.ok(saved(st.notes.status), `the panel says Saved only now: ${st.notes.status}`);
  assert.equal(post.status, 403, `the pre-issued sales_staff session is refused: ${post.text}`);
  assert.deepEqual(postDelta, { ...postDelta, ...REFUSED }, `the refused POST wrote nothing, not even an audit record ${JSON.stringify(postDelta)}`);
  assert.equal(list.status, 200, 'View still reads');
  await assertNoLeak(page);
});

scenario('SRL-01', 'the owner sees the defaults, narrows to View (saved after read-back, enforced, surviving reload and a second browser), None refuses GET and POST, and Create restored lets the refused key create afresh', async () => {
  const { tenant, boss } = await shop('s1');
  const staff = await actor('s1-staff', [grant(tenant, 'sales_staff')]);
  const staffSession = await directLogin(staff);
  const page = await ownerPanel(boss);
  assert.equal((await rowOf(page, 'store_owner'))?.text?.includes('Full — fixed'), true, 'the store owner row is fixed');
  await waitRow(page, 'manager', 'full', 'Default');
  await waitRow(page, 'technician', 'view', 'Default');
  await waitRow(page, 'sales_staff', 'create', 'Default');
  // AM7: an unready Save is disabled and described by a visible hint saying what it is missing.
  assert.equal(await page.evaluate(`(() => {
    const button = document.querySelector('[data-testid="server-level-save-sales_staff"]');
    return button.disabled && document.getElementById(button.getAttribute('aria-describedby'))?.textContent.trim();
  })()`), 'To save, choose a new level and enter a reason of 10–500 characters.', 'Save is disabled and says why');
  const created = await call('POST', CUSTOMERS, { session: staffSession, body: { name: `M7SRL s1 a ${SUFFIX}` }, key: randomUUID() });
  assert.equal(created.status, 201, `the default Create level creates: ${created.text}`);

  let before = await counts();
  await draft(page, 'sales_staff', 'view');
  // The read-back after the PUT is held: while it is, the PUT has committed and the row still does not say "Saved".
  const readBack = gate((r) => isRead(r) && r.frameId === page.frameId && st.api.some(isPut), 'request');
  const from = await clickSave(page, 'sales_staff');
  assert.ok(await Promise.race([readBack.reached, delay(15_000).then(() => null)]), 'a read-back follows the PUT');
  assert.deepEqual(st.api.filter(isPut).map((r) => r.status), [200], 'the PUT committed first');
  await delay(500);
  const whileHeld = note('status while the read-back is held', await statusOf(page, 'sales_staff'));
  assert.ok(!saved(whileHeld), `not "Saved" before the read-back: ${whileHeld}`);
  readBack.release();
  const viewStatus = await settle(page, 'sales_staff', from);
  assert.ok(saved(viewStatus), viewStatus);
  await waitRow(page, 'sales_staff', 'view', 'Custom');
  await assertDelta(before, EDIT, 'narrowed to View');
  before = await counts();
  assert.equal((await call('POST', CUSTOMERS, { session: staffSession, body: { name: `M7SRL s1 b ${SUFFIX}` }, key: randomUUID() })).status, 403, 'View refuses a create');
  assert.equal((await call('GET', `${CUSTOMERS}?limit=10`, { session: staffSession })).status, 200, 'View reads');
  await assertDelta(before, REFUSED, 'View refused the create');

  await page.goto(`${SHOP}/employees`, 30_000); // a reload: the page keeps nothing but the browser's own cookie and sign-in
  await openPermissions(page);
  await waitState(page, 'Ready');
  await waitRow(page, 'sales_staff', 'view', 'Custom');
  const second = await ownerPanel(boss); // a second browser: its own cookie jar and sign-in
  await waitRow(second, 'sales_staff', 'view', 'Custom');

  before = await counts();
  await draft(second, 'sales_staff', 'none');
  assert.ok(saved(await save(second, 'sales_staff')), 'None saved from the second browser');
  await assertDelta(before, EDIT, 'narrowed to None');
  before = await counts();
  const refusedKey = randomUUID();
  assert.equal((await call('GET', `${CUSTOMERS}?limit=10`, { session: staffSession })).status, 403, 'None refuses the read');
  assert.equal((await call('POST', CUSTOMERS, { session: staffSession, body: { name: `M7SRL s1 c ${SUFFIX}` }, key: refusedKey })).status, 403, 'None refuses the create');
  await assertDelta(before, REFUSED, 'None refused both, holding no lease');

  await draft(second, 'sales_staff', 'create');
  assert.ok(saved(await save(second, 'sales_staff')), 'Create restored');
  before = await counts();
  const again = await call('POST', CUSTOMERS, { session: staffSession, body: { name: `M7SRL s1 c ${SUFFIX}` }, key: refusedKey });
  assert.equal(again.status, 201, `the refused key creates afresh: ${again.text}`);
  assert.equal(again.headers['idempotent-replayed'], undefined, 'a new command, not a replay');
  await assertDelta(before, { C: 1, A: 1, E: 0, K: 1 }, 'the restored create');
  assert.equal(await levelOf(tenant, 'sales_staff'), 'create');
});

scenario('SRL-02', 'two tenants stay independent; a tenant-A read held past a same-browser switch to tenant B never replaces B\'s panel; B\'s save lands on B alone', async () => {
  const a = await shop('s2a');
  const b = await shop('s2b');
  const direct = await directLogin(a.boss);
  const put = await call('PUT', ROLE_LEVELS, { session: direct, body: { roleId: 'sales_staff', domain: 'customers', level: 'view', reason: REASON }, key: randomUUID() });
  assert.equal(put.status, 200, put.text);
  const page = await ownerPanel(a.boss);
  await waitRow(page, 'sales_staff', 'view', 'Custom');
  // What this proves is the ABORT path: the switch starts a new generation, which aborts the tenant-A fetch, so Chromium
  // drops the held answer when it is released. The generation check that drops an answer which did arrive late (and the
  // tenant check on reads) is proved at the network boundary in src/tenant/ServerCustomerLevels.test.tsx.
  const held = gate((r) => isRead(r) && r.frameId === page.frameId, 'response');
  await page.evaluate(`dispatchEvent(new Event('focus'))`); // the panel refreshes on focus
  const heldRead = await Promise.race([held.reached, delay(10_000).then(() => null)]);
  assert.ok(heldRead, 'a tenant-A read is in flight and held');
  const tab = await sameContextTab(page);
  await signIn(tab, b.boss); // the same browser signs in as tenant B's owner; the first tab follows the shared sign-in
  await waitRow(page, 'sales_staff', 'create', 'Default');
  held.release();
  await delay(1_500);
  await waitRow(page, 'sales_staff', 'create', 'Default');
  note('held A read', heldRead.status);
  await draft(page, 'sales_staff', 'edit');
  assert.ok(saved(await save(page, 'sales_staff')), 'B saved');
  assert.equal(await levelOf(b.tenant, 'sales_staff'), 'edit', 'B holds its own edit');
  assert.equal(await levelOf(a.tenant, 'sales_staff'), 'view', 'A is untouched');
});

scenario('SRL-03', 'a write with no session, an ended session, a stripped session CSRF, a foreign Origin, a wrong Host, a revoked owner grant, or the tenant server down never shows "Saved" and writes nothing; then the save succeeds', async () => {
  const { tenant, boss } = await shop('s3');
  const page = await ownerPanel(boss);
  await draft(page, 'sales_staff', 'view');
  // [label, tamper, the PUT's status, the row's status line (AM1: a 404 is an answer that decides nothing: the key is
  // settled and the server's level read back; AM6: any 403 other than step_up_required is the owner-only refusal)]
  const cases = [
    ['no session on the write', async (rec, out) => { if (isPut(rec)) delete out.cookie; }, 401, SAY.signedOut],
    ['the session ended in the store', async (rec) => {
      if (!isPut(rec)) return;
      const keys = (await owner`select session_key from tmpos_session.session where auth_provider_uid = ${boss.uid}`).map((r) => r.session_key);
      if (keys.length > 0) await owner`delete from tmpos_mint.tenant_session where session_key = any(${keys}::text[])`;
      await owner`delete from tmpos_session.session where auth_provider_uid = ${boss.uid}`;
    }, 401, SAY.signedOut],
    ['the session CSRF stripped', async (rec, out) => { if (isPut(rec)) delete out[SESSION_CSRF_HEADER]; }, 403, SAY.refused],
    ['a foreign Origin', async (rec, out) => { if (isPut(rec)) out.origin = ADMIN; }, 403, SAY.refused],
    ['a wrong Host', async (rec, out) => { if (isPut(rec)) out.host = 'admin.tmpos.test'; }, 404, SAY.notThisAttempt('create')],
  ];
  for (const [label, tamper, expected, says] of cases) {
    const before = await counts();
    const from = st.api.length;
    st.tamper = tamper;
    const status = await save(page, 'sales_staff');
    st.tamper = null;
    note(label, status);
    assert.equal(status, says, label);
    assert.deepEqual(st.api.slice(from).filter(isPut).map((r) => r.status), [expected], `${label}: ${st.api.slice(from).map(apiLine).join('; ')}`);
    await assertDelta(before, NOTHING, label);
    assert.equal(await levelOf(tenant, 'sales_staff'), undefined, `${label}: nothing stored`);
  }
  {
    const before = await counts();
    await owner`update user_membership set role_id = 'technician' where internal_user_id = ${boss.id}`;
    const from = st.api.length;
    const status = await save(page, 'sales_staff');
    await owner`update user_membership set role_id = 'store_owner' where internal_user_id = ${boss.id}`;
    note('the owner grant revoked', status);
    assert.equal(status, SAY.refused);
    assert.deepEqual(st.api.slice(from).filter(isPut).map((r) => r.status), [403], 'the server refused the former owner\'s PUT');
    await assertDelta(before, NOTHING, 'the owner grant revoked');
  }
  {
    const before = await counts();
    await stopEntry();
    // AM3: a focus refresh that cannot reach the server keeps the panel ready, its rows in place, and says so.
    await page.evaluate(`dispatchEvent(new Event('focus'))`);
    await page.waitFor(`document.querySelector('[data-testid="server-customer-levels"] [role="status"]')?.textContent.trim() === ${JSON.stringify(REFRESH_FAILED)}`, 20_000, 'the refresh-failed note');
    assert.equal(await panelState(page), 'Ready', 'a failed refresh keeps the panel ready');
    assert.equal((await rowOf(page, 'sales_staff'))?.level, LABELS.create, 'and its rows');
    const from = st.api.length;
    const status = await save(page, 'sales_staff');
    await startEntry();
    note('the tenant server down', status);
    assert.equal(status, SAY.unreachable);
    assert.deepEqual(st.api.slice(from).map((r) => r.status), [502], 'the one request made was answered by the front alone');
    await assertDelta(before, NOTHING, 'the tenant server down');
  }
  const before = await counts();
  const status = await save(page, 'sales_staff');
  note('recovered', status);
  assert.ok(saved(status), status);
  await assertDelta(before, EDIT, 'the save after every failure');
  assert.equal(await levelOf(tenant, 'sales_staff'), 'view');
});

scenario('SRL-04', 'a stale sign-in is refused with step_up_required and nothing written; the owner re-authenticates in the page, and only the next save lands', async () => {
  const { tenant, boss } = await shop('s4');
  ACCOUNTS.get(boss.email).staleOnce = true;
  const page = await ownerPanel(boss);
  const before = await counts();
  await draft(page, 'sales_staff', 'view');
  const first = await save(page, 'sales_staff');
  note('stale', first);
  assert.equal(first, SAY.stepUp);
  assert.deepEqual(st.api.filter(isPut).map((r) => `${r.status} ${r.error}`), ['403 step_up_required']);
  await assertDelta(before, NOTHING, 'the stale sign-in');
  await page.waitFor(`!!document.querySelector('[data-testid="server-level-reauth-password"]')`, 10_000, 'the password prompt');
  // AM7: the prompt is a group named by its title, its password field takes focus, and Confirm says what it is missing.
  assert.equal((await page.axNodes({ role: 'group', name: 'Confirm your sign-in to save this change' })).length, 1, 'the prompt is a labelled group');
  await page.waitFor(`document.activeElement?.dataset.testid === 'server-level-reauth-password'`, 5_000, 'the password field has focus');
  assert.equal(await page.evaluate(`(() => {
    const confirm = document.querySelector('[data-testid="server-level-reauth-confirm"]');
    return confirm.disabled && document.getElementById(confirm.getAttribute('aria-describedby'))?.textContent.trim();
  })()`), 'Enter your password to confirm your sign-in.', 'Confirm is disabled and described by what it needs');
  await page.fill('[data-testid="server-level-reauth-password"]', boss.password);
  await page.click('[data-testid="server-level-reauth-confirm"]');
  await page.waitFor(async () => (await statusOf(page, 'sales_staff')) === SAY.signedInAgain, 20_000, 'the re-authentication');
  assert.ok(st.api.some((r) => r.method === 'POST' && r.path === LOGIN && r.headers['x-tmpos-reauthenticate'] === '1' && r.status === 200), 'the session was renewed with the fresh sign-in');
  const second = await save(page, 'sales_staff');
  note('after re-authentication', second);
  assert.ok(saved(second), second);
  await assertDelta(before, EDIT, 'the one save');
  assert.equal(await levelOf(tenant, 'sales_staff'), 'view');
});

scenario('SRL-05', 'a failed identity verifier leaves the panel unavailable with no levels and no save until it recovers', async () => {
  const { boss } = await shop('s5');
  idp.verifierDown = true;
  const page = await openPage();
  try {
    await signIn(page, boss);
    await openPermissions(page);
    await waitState(page, 'Unavailable');
  } finally {
    idp.verifierDown = false;
  }
  assert.equal(await page.evaluate(`document.querySelectorAll('[data-testid^="server-level-save-"]').length`), 0, 'no save control while unavailable');
  assert.deepEqual(st.api.filter((r) => r.path === LOGIN).map((r) => r.status), [503], 'the login was an outage, not a verdict');
  assert.equal(st.api.filter(isPut).length, 0);
  await page.click('[data-testid="server-levels-retry"]');
  await waitState(page, 'Ready');
});

scenario('SRL-06', 'a manager sees the panel denied, and the server refuses the manager\'s direct reads and PUTs, the self-grant included', async () => {
  const { tenant } = await shop('s6');
  const manager = await actor('s6-manager', [grant(tenant, 'manager')], { role: 'manager' });
  const page = await openPage();
  await signIn(page, manager);
  await openPermissions(page);
  await waitState(page, 'Denied');
  assert.equal(await page.evaluate(`document.querySelectorAll('[data-testid^="server-level-save-"]').length`), 0, 'no save control for a manager');
  assert.match(await page.evaluate(`document.querySelector('[data-testid="server-customer-levels"]').textContent`), /only be viewed and changed by the store owner/);
  const direct = await directLogin(manager);
  const before = await counts();
  const read = await call('GET', ROLE_LEVELS, { session: direct });
  const put = (body) => call('PUT', ROLE_LEVELS, { session: direct, body, key: randomUUID() });
  const narrow = await put({ roleId: 'sales_staff', domain: 'customers', level: 'view', reason: REASON });
  const self = await put({ roleId: 'manager', domain: 'customers', level: 'full', reason: REASON });
  // The self-grant in other shapes: another domain (where manage_role_permissions would live), Manage, and an extra
  // field naming the grant. Whether the body rule (400) or the owner rule (403) answers first, none may write.
  const variants = {
    'another domain': await put({ roleId: 'manager', domain: 'employees', level: 'full', reason: REASON }),
    'Manage for manager': await put({ roleId: 'manager', domain: 'customers', level: 'manage', reason: REASON }),
    'an extra field': await put({ roleId: 'manager', domain: 'customers', level: 'full', reason: REASON, permission: 'manage_role_permissions' }),
  };
  note('manager direct', { read: read.status, narrow: narrow.status, self: self.status, ...Object.fromEntries(Object.entries(variants).map(([k, v]) => [k, v.status])) });
  assert.deepEqual([read.status, narrow.status, self.status], [403, 403, 403]);
  for (const [label, res] of Object.entries(variants)) assert.ok([400, 403].includes(res.status), `${label}: ${res.status} ${res.text}`);
  await assertDelta(before, REFUSED, 'the manager wrote nothing, not even an audit record');
  assert.equal(await levelOf(tenant, 'sales_staff'), undefined);
  assert.equal(await levelOf(tenant, 'manager'), undefined);
  assert.equal((await owner`select count(*)::int as n from tmpos_role.tenant_role_level where tenant_id = ${tenant}`)[0].n, 0, 'no row of any role or domain');
});

scenario('SRL-07', 'the local grid is labelled local-only; a grid change — a built-in role\'s Customers cell or a custom role\'s — sends nothing to any server and moves no server level; there is no global Save', async () => {
  const { tenant, boss } = await shop('s7');
  const page = await ownerPanel(boss);
  const banner = await page.evaluate(`document.querySelector('[data-testid="local-only-banner"]')?.textContent ?? null`);
  note('banner', banner);
  assert.match(banner ?? '', /not saved to the server/i, 'the grid says it is local-only');
  const customersCell = await page.evaluate(`[...document.querySelectorAll('tbody tr')].find((tr) => tr.querySelector('td')?.textContent.trim().startsWith('Customers'))?.querySelector('td')?.textContent ?? null`);
  note('Customers row', customersCell);
  assert.match(customersCell ?? '', /Built-in roles: set in Server-enforced Customers access above/, 'the grid\'s Customers row points to the server panel');
  const from = st.api.length;
  const fsFrom = st.firestore.length;
  const before = await counts();
  // A custom role exists in this tab only; its Customers control is the grid's, and stays there.
  const custom = `M7SRL Local ${SUFFIX}`;
  await createCustomRole(page, custom);
  await openPermissions(page);
  await waitState(page, 'Ready');
  assert.equal(await setGridLevel(page, 'Technician', 'Inventory', 'none'), 'none');
  assert.equal(await setGridLevel(page, 'Sales Associate', 'Customers', 'view'), 'view', 'a built-in role\'s Customers cell in the grid');
  assert.equal(await setGridLevel(page, custom, 'Customers', 'view'), 'view', 'the custom role\'s Customers cell');
  await delay(1_500);
  // A panel refresh (GET) may happen on focus; a write never may — not to the tenant server, not to Firestore.
  assert.deepEqual(st.api.slice(from).filter((r) => r.method !== 'GET').map(apiLine), [], 'a grid change sends nothing');
  assert.deepEqual(st.firestore.slice(fsFrom).filter((f) => f.includes('/Write/')), [], 'nor writes to Firestore');
  await assertDelta(before, REFUSED, 'the grid changes');
  assert.equal(await levelOf(tenant, 'sales_staff'), undefined, 'the server level of sales_staff did not move');
  assert.deepEqual(await rowOf(page, 'sales_staff'), { level: LABELS.create, badge: 'Default' }, 'the server panel still shows the server\'s level');
  const rows = await page.evaluate(`[...document.querySelectorAll('[data-testid^="server-level-row-"]')].map((r) => r.dataset.testid.slice('server-level-row-'.length))`);
  assert.deepEqual(rows, ['store_owner', 'manager', 'technician', 'sales_staff'], 'the server panel lists the built-in roles only, never the custom role');
  const saves = await page.evaluate(`[...document.querySelectorAll('button')].map((b) => b.textContent.trim()).filter((t) => /save/i.test(t))`);
  note('save buttons', saves);
  assert.ok(saves.every((t) => t === 'Save to server'), `the only save controls are the per-role server saves: ${saves.join(', ')}`);
});

/**
 * Two editors of one role: `two` writes None and its read-back is held; `one` then writes Edit and reads it back; `two`'s
 * read-back, released, shows Edit. The later writer stands, and the earlier one says it lost instead of "Saved".
 */
async function lastWriterWins(tenant, one, two, where) {
  const held = gate((r) => isRead(r) && r.frameId === two.frameId, 'request');
  await draft(two, 'sales_staff', 'none');
  const twoSaving = save(two, 'sales_staff');
  const heldRead = await Promise.race([held.reached, delay(15_000).then(() => null)]);
  assert.ok(heldRead, `the second ${where}'s read-back is held after its PUT`);
  assert.equal(await levelOf(tenant, 'sales_staff'), 'none', `the second ${where}'s write committed`);
  await draft(one, 'sales_staff', 'edit');
  const oneStatus = await save(one, 'sales_staff');
  held.release();
  const twoStatus = await twoSaving;
  note(`first ${where}`, oneStatus);
  note(`second ${where}`, twoStatus);
  assert.ok(saved(oneStatus), oneStatus);
  assert.equal(twoStatus, SAY.lostRace('edit'), `the stale ${where} does not say Saved and shows the server's value`);
  assert.equal(await levelOf(tenant, 'sales_staff'), 'edit', 'the later writer stands');
  assert.deepEqual(st.api.filter(isPut).map((r) => r.status), [200, 200], 'both writes committed: last writer wins (R1 has no version precondition)');
}

scenario('SRL-08', 'two browsers edit one role: the later writer\'s value stands, and the tab whose read-back shows another value says so instead of "Saved" (last writer wins, recorded); a later change elsewhere turns "Saved" into "Changed elsewhere"', async () => {
  const { tenant, boss } = await shop('s8');
  const one = await ownerPanel(boss);
  const two = await ownerPanel(boss);
  await lastWriterWins(tenant, one, two, 'browser');
  // AM2: a change made elsewhere afterwards — seen by the first browser's next refresh — ends its "Saved".
  const direct = await directLogin(boss);
  const put = await call('PUT', ROLE_LEVELS, { session: direct, body: { roleId: 'sales_staff', domain: 'customers', level: 'view', reason: REASON }, key: randomUUID() });
  assert.equal(put.status, 200, put.text);
  await one.evaluate(`dispatchEvent(new Event('focus'))`);
  await one.waitFor(async () => (await statusOf(one, 'sales_staff')) === SAY.changedElsewhere('view'), 20_000, 'the former "Saved" says the level changed elsewhere');
  await waitRow(one, 'sales_staff', 'view', 'Custom');
});

scenario('SRL-08T', 'two TABS of one browser (one cookie jar, one sign-in) edit one role: the later writer\'s value stands, and the tab whose read-back shows another value says so instead of "Saved"', async () => {
  const { tenant, boss } = await shop('s8t');
  const one = await ownerPanel(boss);
  const two = await sameContextTab(one);
  await two.goto(`${SHOP}/employees`, 30_000); // signed in already: the tabs share the browser's persisted sign-in
  await openPermissions(two);
  await waitState(two, 'Ready');
  await waitRow(two, 'sales_staff', 'create', 'Default');
  await lastWriterWins(tenant, one, two, 'tab');
});

scenario('SRL-09', 'a user switch in one browser ends the previous user\'s tenant session before the next user\'s login leaves the page, and signing out ends the next one\'s (AM4)', async () => {
  const a = await shop('s9a');
  const b = await shop('s9b');
  // The two stores' panels differ: A's sales_staff is stored View, B's is the default Create.
  const direct = await directLogin(a.boss);
  const put = await call('PUT', ROLE_LEVELS, { session: direct, body: { roleId: 'sales_staff', domain: 'customers', level: 'view', reason: REASON }, key: randomUUID() });
  assert.equal(put.status, 200, put.text);
  const page = await ownerPanel(a.boss);
  await waitRow(page, 'sales_staff', 'view', 'Custom');
  const aLogin = st.api.filter(acceptedLogin(a.boss)).at(-1);
  assert.ok(aLogin, 'the page established A\'s tenant session');
  assert.equal((await readWith(aLogin.cookie)).status, 200, 'A\'s cookie reads while A is signed in');

  // The switch: a second tab of the same browser signs in as B, and the first tab follows the shared sign-in. B's login is
  // held at the front while A's old cookie is tried from outside: it must already be dead.
  const from = st.api.length;
  const held = gate((r) => r.method === 'POST' && r.path === LOGIN && bearerUid(r) === b.boss.uid, 'request');
  const tab = await sameContextTab(page);
  await signIn(tab, b.boss);
  const heldLogin = await Promise.race([held.reached, delay(30_000).then(() => null)]);
  assert.ok(heldLogin, 'the page logs in as B');
  const probe = await readWith(aLogin.cookie);
  note('A\'s cookie while B\'s login is held', probe.status);
  held.release();
  assert.equal(probe.status, 401, `A's session was over before B's login left the page: ${probe.text}`);
  const endedA = st.api.slice(from).filter((r) => isLogout(r) && r.status === 204 && (r.headers.cookie ?? '').includes(aLogin.cookie));
  assert.ok(endedA.length >= 1, `a logout carrying A's cookie ended it: ${st.api.slice(from).map(apiLine).join('; ')}`);
  note('A\'s logout answered before B\'s login was sent (ms)', Math.round(heldLogin.at - endedA[0].doneAt));
  await waitRow(page, 'sales_staff', 'create', 'Default'); // the first tab now shows B's store
  await waitState(page, 'Ready');
  note('switch', st.api.slice(from).map(apiLine));
  const bLogin = st.api.filter(acceptedLogin(b.boss)).at(-1);
  assert.ok(bLogin, 'B\'s login was accepted');
  const bRead = await readWith(bLogin.cookie);
  assert.equal(bRead.status, 200, `B's session stands: no late logout ended it: ${bRead.text}`);
  assert.equal(JSON.parse(bRead.text).tenant, b.tenant, 'and it is B\'s store');

  // Sign-out: the persisted sign-in cleared, exactly what a sign-out in another tab leaves behind (every tab's Firebase
  // SDK notices on its next poll). Every tab is now signed out, and B's tenant session must end with it.
  const out = st.api.length;
  await page.evaluate(`new Promise((resolve, reject) => {
    const open = indexedDB.open('firebaseLocalStorageDb');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('firebaseLocalStorage', 'readwrite');
      tx.objectStore('firebaseLocalStorage').clear();
      tx.oncomplete = () => { db.close(); resolve(true); };
      tx.onerror = () => reject(tx.error);
    };
  })`);
  await page.waitFor(async () => (await readWith(bLogin.cookie)).status === 401, 20_000, 'B\'s session ended by the sign-out');
  note('sign-out', st.api.slice(out).map(apiLine));
  assert.ok(st.api.slice(out).some((r) => isLogout(r) && r.status === 204 && (r.headers.cookie ?? '').includes(bLogin.cookie)), 'a logout carrying B\'s cookie ended it');
  assert.equal(await page.evaluate(`fetch('/api/v1/session', { credentials: 'include', cache: 'no-store' }).then((r) => r.status)`), 401, 'the browser holds no tenant session');
  assert.deepEqual(st.api.slice(out).filter((r) => r.path === LOGIN).map(apiLine), [], 'nobody signed back in');
});
